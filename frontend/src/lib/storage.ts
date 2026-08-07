// Persistent storage layer for AUMS_UI.
// Uses localStorage with a versioned namespace. All cached app data is tied to
// a session id and timestamped so stale data can be invalidated safely.

const NS = 'aums';

const SCHEMA_VERSION = 1;

// Data cache TTL: keep cached profile/GPA/attendance for at most this long
// before forcing a background refresh. 15 minutes is long enough to make
// reloads instant while avoiding stale numbers.
export const CACHE_TTL_MS = 15 * 60 * 1000;

interface SessionRecord {
  sessionId: string;
  savedAt: number;
}

export interface UiState {
  active?: string;
  sidebarCollapsed?: boolean;
  gpaSemester?: number;
  calendarView?: 'month' | 'week' | 'agenda';
  calendarYear?: number;
  calendarMonth?: number; // 0-based
  calendarDate?: string | null;
  searchHistory?: string[];
  attendanceSemesterId?: string;
}

interface CacheRecord<T> {
  data: T;
  savedAt: number;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / disabled - non-fatal
  }
}



function now(): number {
  return Date.now();
}

export function saveSession(sessionId: string) {
  const record: SessionRecord = { sessionId, savedAt: now() };
  write(`${NS}:session:${SCHEMA_VERSION}`, record);
}

export function loadSession(): string | null {
  const record = read<SessionRecord>(`${NS}:session:${SCHEMA_VERSION}`);
  return record?.sessionId || null;
}

export function saveUiState(state: UiState) {
  write(`${NS}:ui:${SCHEMA_VERSION}`, state);
}

export function loadUiState(): UiState | null {
  return read<UiState>(`${NS}:ui:${SCHEMA_VERSION}`);
}

export function saveCache<T>(key: string, data: T) {
  const record: CacheRecord<T> = { data, savedAt: now() };
  write(`${NS}:cache:${SCHEMA_VERSION}:${key}`, record);
}

export function loadCache<T>(key: string): { data: T; fresh: boolean } | null {
  const record = read<CacheRecord<T>>(`${NS}:cache:${SCHEMA_VERSION}:${key}`);
  if (!record) return null;
  return {
    data: record.data,
    fresh: now() - record.savedAt < CACHE_TTL_MS,
  };
}

export function clearCache() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${NS}:`)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

// Cache keys scoped per session id.
export const cacheKey = {
  profile: (sessionId: string) => `profile:${sessionId}`,
  gpa: (sessionId: string) => `gpa:${sessionId}`,
  semesters: (sessionId: string) => `semesters:${sessionId}`,
  attendance: (sessionId: string, semesterId: string) => `attendance:${sessionId}:${semesterId}`,
  course: (sessionId: string, semesterId: string, courseId: string) => `course:${sessionId}:${semesterId}:${courseId}`,
  calendar: (sessionId: string, semesterId: string) => `calendar:${sessionId}:${semesterId}`,
};
