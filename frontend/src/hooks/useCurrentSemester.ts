import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'aums-semester-override';

interface SemesterOverride {
  batch: string;
  semester: number;
}

/**
 * Compute the current semester from the joining (batch) year.
 * Academic year convention: odd semester runs Jul-Dec, even semester Jan-Jun.
 * Result is clamped to 1..8.
 */
export function computeSemesterFromBatch(batch: string | undefined | null, now: Date = new Date()): number | null {
  if (!batch) return null;
  const m = String(batch).match(/(\d{4})/);
  if (!m) return null;
  const batchYear = Number(m[1]);
  if (!Number.isFinite(batchYear)) return null;
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const yearsElapsed = year - batchYear;
  if (yearsElapsed < 0) return null;
  const sem = yearsElapsed * 2 + (month >= 7 ? 1 : 0);
  return Math.min(8, Math.max(1, sem));
}

function readOverride(batch: string | undefined | null): number | null {
  if (!batch) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SemesterOverride;
    if (parsed && parsed.batch === batch && Number.isInteger(parsed.semester)) {
      return parsed.semester;
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

function writeOverride(batch: string | undefined | null, semester: number | null) {
  try {
    if (!batch || semester === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ batch, semester } as SemesterOverride));
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Single source of truth for the displayed semester.
 * Auto-computes from the batch year; a manual override persisted in
 * localStorage takes precedence and can be cleared to re-enable auto.
 */
export function useCurrentSemester(batch: string | undefined | null) {
  const [manual, setManual] = useState<number | null>(() => readOverride(batch));

  useEffect(() => {
    setManual(readOverride(batch));
  }, [batch]);

  const semester = manual ?? computeSemesterFromBatch(batch);

  const setSemester = useCallback(
    (sem: number) => {
      setManual(sem);
      writeOverride(batch, sem);
    },
    [batch]
  );

  const resetSemester = useCallback(() => {
    setManual(null);
    writeOverride(batch, null);
  }, [batch]);

  return { semester, isManual: manual !== null, setSemester, resetSemester };
}
