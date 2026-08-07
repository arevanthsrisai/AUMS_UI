import { useCallback, useEffect, useState } from 'react';
import { API_BASE, fetchWithTimeout, isSessionExpired } from '../lib/api';

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
      const res = await fetchWithTimeout(`${API_BASE}/attendance`, { headers: { 'x-session-id': sessionId } });
      const data = await res.json();
      if (isSessionError(data.error, (data as any).code)) {
        setError(data.error || 'Session expired');
        setSessionExpired(true);
      } else if (data.success && data.semesters?.length) {
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

  const loadAttendance = useCallback(async (semesterId?: string) => {
    const semId = semesterId || selectedSemester;
    if (!semId) return;
    setLoadingAttendance(true);
    setError(null);
    setSessionExpired(false);
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
      } else if (data.success) {
        setAttendance({ semester: data.semester, subjects: data.subjects });
      } else {
        setError(data.error || 'Failed to load attendance');
      }
    } catch {
      setError('Unable to connect to server');
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
    if (!res.ok && isSessionExpired(data.code)) {
      return { ...data, sessionExpired: true };
    }
    return data;
  } catch {
    return { success: false, error: 'Unable to connect to server' };
  }
}

