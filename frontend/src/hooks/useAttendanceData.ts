import { useCallback, useEffect, useState } from 'react';
import { API_BASE, fetchWithTimeout, isSessionExpired } from '../lib/api';
import { loadCache, saveCache, cacheKey } from '../lib/storage';

export interface Semester {
  id: string;
  name: string;
}

export interface AttendanceSubject {
  courseId?: string;
  courseCode: string;
  name: string;
  totalClasses: number;
  attendedClasses: number;
  attendance: number;
}

export interface AttendanceData {
  semester?: string;
  subjects?: AttendanceSubject[];
}

export interface CourseEvent {
  date: string;
  period: number;
  periodTo?: number;
  hours?: number;
  status: 'Present' | 'Absent' | 'OD' | 'ML' | 'Holiday' | 'Cancelled' | string;
  subjectCode?: string;
  subjectName?: string;
  courseId?: string;
}

export interface CourseAttendanceResponse {
  success: boolean;
  error?: string;
  code?: string;
  sessionExpired?: boolean;
  subject?: { code: string; name: string; percentage: number };
  stats?: { total: number; present: number; absent: number; od: number; percentage: number };
  events?: CourseEvent[];
}



// Semester list is stable for a session; fetch once per session and reuse.
const semesterCache = new Map<string, Semester[]>();

// Stale-while-revalidate for course events: CalendarPage hydrates its grid
// from the localStorage cache below so the UI is interactive instantly while
// fresh data is fetched; results are reconciled afterwards.
export function hydrateCalendarCache(sessionId: string, semesterId: string, subjectIds: string[]): Array<CourseAttendanceResponse & { courseId: string }> | null {
  const out: Array<CourseAttendanceResponse & { courseId: string }> = [];
  for (const courseId of subjectIds) {
    const cached = loadCache<CourseAttendanceResponse & { courseId?: string }>(cacheKey.course(sessionId, semesterId, courseId));
    if (cached && (cached.fresh || !cached.data?.success)) {
      out.push({ ...cached.data, courseId });
    }
  }
  return out.length ? out : null;
}

function saveCourseCache(sessionId: string, semesterId: string, courseId: string, data: CourseAttendanceResponse) {
  if (data && data.success) {
    saveCache(cacheKey.course(sessionId, semesterId, courseId), { ...data, courseId });
  }
}
// Prefer the semester matching the dashboard's current semester (by name,
// e.g. "3", then by AUMS id offset 716+N). Falls back to the first semester.
function pickSemester(semesters: Semester[], preferredSemester?: number): string {
  if (!preferredSemester || !semesters.length) return semesters[0]?.id || '';
  const byName = semesters.find((s) => parseInt(s.name, 10) === preferredSemester);
  if (byName) return byName.id;
  const byId = semesters.find((s) => parseInt(s.id, 10) === 716 + preferredSemester);
  return (byId || semesters[0])?.id || '';
}


export function useAttendanceData(sessionId: string, preferredSemester?: number) {
  const [semesters, setSemesters] = useState<Semester[]>(() => semesterCache.get(sessionId) || []);
  const [selectedSemester, setSelectedSemester] = useState<string>('');
  const [attendance, setAttendance] = useState<AttendanceData | null>(null);
  const [loadingSemesters, setLoadingSemesters] = useState(true);
  const [loadingAttendance, setLoadingAttendance] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // False when the shown attendance came from cache and the network refresh
  // hasn't confirmed/updated it yet.
  const [attendanceFresh, setAttendanceFresh] = useState(true);

  const loadSemesters = useCallback(async (force = false) => {
    const cached = semesterCache.get(sessionId);
    if (!force && cached?.length) {
      setSemesters(cached);
      setSelectedSemester((prev) => prev || pickSemester(cached, preferredSemester));
      setLoadingSemesters(false);
      setError(null);
      setSessionExpired(false);
      return;
    }
    setLoadingSemesters(true);
    setError(null);
    setSessionExpired(false);
    try {
      const cachedRes = loadCache<Semester[]>(cacheKey.semesters(sessionId));
      if (cachedRes && cachedRes.data?.length && cachedRes.fresh) {
        semesterCache.set(sessionId, cachedRes.data);
      }
      const res = await fetchWithTimeout(`${API_BASE}/attendance`, { headers: { 'x-session-id': sessionId } });
      const data = await res.json();
      if (isSessionError(data.error, (data as any).code)) {
        setError(data.error || 'Session expired');
        setSessionExpired(true);
      } else if (data.success && data.semesters?.length) {
        saveCache(cacheKey.semesters(sessionId), data.semesters);
        semesterCache.set(sessionId, data.semesters);
        setSemesters(data.semesters);
        setSelectedSemester((prev) => prev || pickSemester(data.semesters, preferredSemester));
      } else {
        setError(data.error || 'Failed to load semesters');
      }
    } catch {
      setError('Unable to connect to server');
    } finally {
      setLoadingSemesters(false);
    }
  }, [sessionId, preferredSemester]);

  // Load attendance for a semester. Stale-while-revalidate: hydrate instantly
  // from the localStorage cache (fresh or stale — UI marks which), then
  // refresh from the network and reconcile. The backend already coalesces
  // duplicate /attendance/report calls per session, so the refresh is cheap.
  const loadAttendance = useCallback(async (semesterId?: string) => {
    const semId = semesterId || selectedSemester;
    if (!semId) return;
    setError(null);
    setSessionExpired(false);

    const cached = loadCache<AttendanceData & { semesterId?: string }>(cacheKey.attendance(sessionId, semId));
    if (cached?.data?.subjects?.length) {
      setAttendance({ semester: cached.data.semester, subjects: cached.data.subjects });
      setAttendanceFresh(cached.fresh);
    }

    setLoadingAttendance(cached?.data?.subjects?.length ? false : true);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/attendance/report`, {
        method: 'POST',
        headers: { 'x-session-id': sessionId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ semesterId: semId }),
      });
      const data = await res.json();
      if (isSessionError(data.error, (data as any).code)) {
        setError(data.error || 'Session expired');
        setSessionExpired(true);
        return;
      }
      if (data.success) {
        const next: AttendanceData & { semesterId?: string } = {
          semester: data.semester,
          subjects: data.subjects,
          semesterId: semId,
        };
        saveCache(cacheKey.attendance(sessionId, semId), next);
        setAttendance({ semester: data.semester, subjects: data.subjects });
        setAttendanceFresh(true);
      } else if (!cached?.data?.subjects?.length) {
        // Only surface the failure when there is no cached data to show.
        setError(data.error || 'Failed to load attendance');
      }
    } catch {
      if (!cached?.data?.subjects?.length) setError('Unable to connect to server');
    } finally {
      setLoadingAttendance(false);
    }
  }, [sessionId, selectedSemester]);

  useEffect(() => {
    loadSemesters();
  }, [loadSemesters]);

  return {
    semesters,
    selectedSemester,
    setSelectedSemester,
    attendance,
    loadingSemesters,
    loadingAttendance,
    error,
    setError,
    sessionExpired,
    setSessionExpired,
    attendanceFresh,
    loadSemesters,
    loadAttendance,
  };
}

export function isSessionError(_error?: string, code?: string): boolean {
  return isSessionExpired(code);
}

export async function fetchCourseAttendance(
  sessionId: string,
  semesterId: string,
  courseId: string
): Promise<CourseAttendanceResponse> {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/attendance/course`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ semesterId, courseId }),
    });
    const data = (await res.json()) as CourseAttendanceResponse;
    if (data?.success) {
      saveCourseCache(sessionId, semesterId, courseId, data);
    }
    if (!res.ok && isSessionExpired(data.code)) {
      return { ...data, sessionExpired: true };
    }
    return data;
  } catch {
    return { success: false, error: 'Unable to connect to server' };
  }
}

