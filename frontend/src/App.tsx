import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentSemester } from './hooks/useCurrentSemester';
import { AnimatePresence } from 'framer-motion';
import Login from './Login';
import { AppShell } from './components/layout/AppShell';
import { ToastProvider } from './components/ui/Toast';
import { DashboardPage } from './pages/DashboardPage';
import { AttendancePage } from './pages/AttendancePage';
import { GpaPage } from './pages/GpaPage';
import { CalendarPage } from './pages/CalendarPage';
import { SettingsPage } from './pages/SettingsPage';
import { CourseDetailsModal } from './components/CourseDetailsModal';
import { SpotlightSearch } from './components/SpotlightSearch';
import type { NavKey } from './components/layout/Sidebar';
import type { AttendanceSubject } from './hooks/useAttendanceData';
import {
  loadSession,
  saveSession,
  clearCache,
  loadUiState,
  saveUiState,
  loadCache,
  saveCache,
  cacheKey,
} from './lib/storage';
import { API_BASE, fetchWithTimeout, isTimeout, isAuthError } from './lib/api';



interface LoginResponse {
  success: boolean;
  sessionId?: string;
  code?: string;
  error?: string;
}

export interface StudentProfile {
  name?: string;
  rollNumber?: string;
  registrationNumber?: string;
  programme?: string;
  branch?: string;
  semester?: string;
  batch?: string;
  section?: string;
  campus?: string;
  email?: string;
  phone?: string;
  mentor?: string;
  photo?: string;
}

interface ProfileData extends StudentProfile {
  success: boolean;
}

export type ProfileStatus = 'loading' | 'success' | 'error';

export interface GpaSummaryData {
  cgpa?: string;
  sgpa?: string;
  semester?: string;
  grades?: { semester: string; courseCode: string; courseName: string; academicTermPeriod: string; type: string; grade: string }[];
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(() => loadSession());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<boolean>(() => !!loadSession());
  const [active, setActive] = useState<NavKey>(() => {
    const ui = loadUiState();
    const v = ui?.active;
    const valid = v === 'dashboard' || v === 'attendance' || v === 'gpa' || v === 'calendar' || v === 'settings' ? v : 'dashboard';
    return valid as NavKey;
  });
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('loading');
  const profileRetryRef = useRef(0);
  const [gpaSummary, setGpaSummary] = useState<GpaSummaryData | null>(null);
  const { semester: currentSemester } = useCurrentSemester(profile?.batch);
  const [openSubject, setOpenSubject] = useState<{ subject: AttendanceSubject; semesterId: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const handleLogin = async (username: string, password: string) => {
    setError(null);
    setLoading(true);
    try {
      const response = await fetchWithTimeout(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }, 120_000);
      const data: LoginResponse = await response.json();
      if (data.success && data.sessionId) {
        saveSession(data.sessionId);
        setSessionId(data.sessionId);
        setActive('dashboard');
        setRestoring(false);
      } else {
        // Use code for deterministic error display
        if (isTimeout(data.code)) {
          setError('AUMS is taking too long to respond. Please try again.');
        } else if (isAuthError(data.code)) {
          setError(data.error || 'Invalid username or password.');
        } else {
          setError(data.error || 'Login failed');
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setError('AUMS is taking too long to respond. Please try again.');
      } else {
        setError('Unable to connect to server');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    if (sessionId) {
      try {
        await fetchWithTimeout(`${API_BASE}/logout`, {
          method: 'POST',
          headers: { 'x-session-id': sessionId },
        }, 15_000);
      } catch (err: any) {
        // ignore
      }
    }
    clearCache();
    setSessionId(null);
    setProfile(null);
    setProfileStatus('loading');
    profileRetryRef.current = 0;
    setGpaSummary(null);
    setOpenSubject(null);
    setError(null);
    setRestoring(false);
    setRestoreError(null);
  };

  const handleSessionExpired = useCallback(() => {
    clearCache();
    setSessionId(null);
    setProfile(null);
    setProfileStatus('loading');
    profileRetryRef.current = 0;
    setGpaSummary(null);
    setOpenSubject(null);
    setError('Your session expired. Please sign in again.');
    setRestoring(false);
  }, []);

  // Returns true when the profile was fetched and validated successfully.
  const loadProfile = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      const res = await fetchWithTimeout(`${API_BASE}/profile`, { headers: { 'x-session-id': sessionId } }, 60_000);
      const data: ProfileData = await res.json();
      if (data.success && data.name && data.rollNumber) {
        saveCache(cacheKey.profile(sessionId), {
          name: data.name,
          rollNumber: data.rollNumber,
          registrationNumber: data.registrationNumber,
          programme: data.programme,
          branch: data.branch,
          semester: data.semester,
          batch: data.batch,
          section: data.section,
          campus: data.campus,
          email: data.email,
          phone: data.phone,
          mentor: data.mentor,
          photo: data.photo,
        } as StudentProfile);
        setProfile({
          name: data.name,
          rollNumber: data.rollNumber,
          registrationNumber: data.registrationNumber,
          programme: data.programme,
          branch: data.branch,
          semester: data.semester,
          batch: data.batch,
          section: data.section,
          campus: data.campus,
          email: data.email,
          phone: data.phone,
          mentor: data.mentor,
          photo: data.photo,
        });
        setProfileStatus('success');
        profileRetryRef.current = 0;
        return true;
      }
      setProfileStatus('error');
      return false;
    } catch (err: any) {
      setProfileStatus('error');
      return false;
    }
  }, [sessionId]);

  const loadGpaSummary = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetchWithTimeout(`${API_BASE}/gpa?semester=1`, { headers: { 'x-session-id': sessionId } }, 60_000);
      const data = await res.json();
      if (data.success) {
        const summary: GpaSummaryData = {
          cgpa: data.currentCgpa,
          sgpa: data.semesterSgpa,
          semester: data.semester,
          grades: data.grades,
        };
        saveCache(cacheKey.gpa(sessionId), summary);
        setGpaSummary(summary);
      }
    } catch (err: any) {
      // non-fatal
    }
  }, [sessionId]);

  // Restore cached data instantly, then validate the session and refresh.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cachedProfile = loadCache<StudentProfile>(cacheKey.profile(sessionId));
    if (cachedProfile) {
      setProfile(cachedProfile.data);
      setProfileStatus('success');
    }
    const cachedGpa = loadCache<GpaSummaryData>(cacheKey.gpa(sessionId));
    if (cachedGpa) setGpaSummary(cachedGpa.data);

    const attempt = async () => {
      const ok = await loadProfile();
      if (cancelled) return;
      if (!ok && profileRetryRef.current < 3) {
        profileRetryRef.current += 1;
        timer = setTimeout(attempt, 1000 * profileRetryRef.current);
      } else if (!ok) {
        clearCache();
        setSessionId(null);
        setProfile(null);
        setProfileStatus('loading');
        profileRetryRef.current = 0;
        setGpaSummary(null);
        setRestoring(false);
        setError('Unable to load profile. Please sign in again.');
      }
    };

    attempt();
    loadGpaSummary();
    setRestoring(false);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, loadProfile, loadGpaSummary]);

  // Persist UI state (route etc.) whenever it changes.
  useEffect(() => {
    if (!sessionId) return;
    const ui = loadUiState() || {};
    saveUiState({ ...ui, active });
  }, [active, sessionId]);

  // Manual retry (used by the profile error banner).
  const retryProfile = useCallback(() => {
    setProfileStatus('loading');
    loadProfile();
  }, [loadProfile]);

  const handleNavigate = (key: NavKey) => {
    setActive(key);
  };

  const handleOpenSubject = (subject: AttendanceSubject, semesterId?: string) => {
    setOpenSubject({ subject, semesterId: semesterId || '' });
  };

  // Global Ctrl/Cmd+K opens Spotlight search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (restoring || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-aurora">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-brand-500 border-r-transparent" />
          <p className="text-sm font-medium text-ink-soft">
            {restoring ? 'Restoring your session?' : 'Connecting to AUMS?'}
          </p>
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <Login
        onLogin={handleLogin}
        error={error || restoreError || null}
        disabled={loading}
      />
    );
  }

  return (
    <ToastProvider>
      <AppShell
        active={active}
        title=""
        profile={profile ?? undefined}
        onNavigate={handleNavigate}
        onLogout={handleLogout}
        onSearchOpen={() => setSearchOpen(true)}
      >
        {active === 'dashboard' && (
          <DashboardPage
            sessionId={sessionId}
            profile={profile}
            profileStatus={profileStatus}
            onRetryProfile={retryProfile}
            gpaSummary={gpaSummary}
            onNavigate={setActive}
          />
        )}
        {active === 'attendance' && (
          <AttendancePage
            sessionId={sessionId}
            onOpenSubject={(s, sem) => handleOpenSubject(s, sem)}
            preferredSemester={currentSemester ?? undefined}
          />
        )}
        {active === 'gpa' && <GpaPage sessionId={sessionId} />}
        {active === 'calendar' && <CalendarPage sessionId={sessionId} />}
        {active === 'settings' && <SettingsPage onLogout={handleLogout} profile={profile} />}
      </AppShell>

      <AnimatePresence>
        {openSubject && (
          <CourseDetailsModal
            sessionId={sessionId}
            semesterId={openSubject.semesterId}
            subject={openSubject.subject}
            onClose={() => setOpenSubject(null)}
            onSessionExpired={handleSessionExpired}
          />
        )}
      </AnimatePresence>

      <SpotlightSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        sessionId={sessionId}
        profile={profile}
        gpaSummary={gpaSummary}
        onNavigate={setActive}
      />
    </ToastProvider>
  );
}




