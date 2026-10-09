// Client-side attendance intelligence.
//
// All functions are pure and run in the browser — NO backend/AUMS calls for
// any of these calculations. Attendance semantics match the backend parser:
// attendedClasses counts Present + OD (OD counts as present in course stats),
// totalClasses is the eligible class count, and
//   attendance % = attendedClasses / totalClasses * 100.

export type RiskLevel = 'SAFE' | 'WATCH' | 'AT_RISK' | 'CRITICAL';

/** Risk thresholds (percent). Edit these constants to retune the app. */
export const RISK_THRESHOLDS = {
  SAFE: 85,
  WATCH: 75,
  AT_RISK: 65,
  AT_RISK_IS_LOWER_BOUND: true,
} as const;

/** Default attendance target used across the UI (percent). */
export const DEFAULT_TARGET = 75;

/** Risk label + color tone mapping, shared by dashboard and attendance pages. */
export function riskLevel(attendance: number): RiskLevel {
  if (attendance >= RISK_THRESHOLDS.SAFE) return 'SAFE';
  if (attendance >= RISK_THRESHOLDS.WATCH) return 'WATCH';
  if (attendance >= RISK_THRESHOLDS.AT_RISK) return 'AT_RISK';
  return 'CRITICAL';
}

export function riskTone(level: RiskLevel): 'success' | 'warning' | 'danger' {
  switch (level) {
    case 'SAFE': return 'success';
    case 'WATCH': return 'warning';
    case 'AT_RISK': return 'warning';
    case 'CRITICAL': return 'danger';
  }
}

export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'SAFE': return 'Safe';
    case 'WATCH': return 'Watch';
    case 'AT_RISK': return 'At risk';
    case 'CRITICAL': return 'Critical';
  }
}

export interface AttendanceStats {
  attended: number; // may be fractional (OD hours are fractional on AUMS)
  total: number;
}

/** Percentage rounded to one decimal, like the backend parser. */
export function attendancePercent({ attended, total }: AttendanceStats): number {
  if (!(total > 0)) return 0;
  return Math.round((attended / total) * 1000) / 10;
}

function clampTarget(target: number): number {
  return Math.min(100, Math.max(0, target));
}

// After attending k of the next classes: (attended + k) / (total + k) >= t
//   attended + k >= t*total + t*k  →  k(1 - t) >= t*total - attended  →
//   k >= (t*total - attended) / (1 - t)         [when t < 1]
// If already >= target, zero classes are needed.
export function classesToReachTarget(
  { attended, total }: AttendanceStats,
  target = DEFAULT_TARGET
): number | null {
  const t = clampTarget(target) / 100;
  if (!(total > 0)) return null;           // no classes yet — undefined
  if (t >= 1) {                             // 100% target already impossible
    return attendancePercent({ attended, total }) >= 100 ? 0 : null;
  }
  if (t <= 0) return 0;
  if (attended / total >= t) return 0;
  const need = Math.ceil((t * total - attended) / (1 - t) - 1e-9);
  return Math.max(0, need);
}

// Bunk k of the next classes: (attended) / (total + k) >= t  →
//   (no new attendance) attended / (total + k) >= t → total + k <= attended / t
//   k <= attended/t - total → floor(attended/t - total), when currently above target.
// If already at or below target, zero classes can be skipped.
export function bunkableToStayAbove(
  { attended, total }: AttendanceStats,
  target = DEFAULT_TARGET
): number {
  const t = clampTarget(target) / 100;
  if (!(total > 0) || t <= 0 || t >= 1) return 0;
  if (attended / total < t) return 0;          // already below target
  const k = Math.floor(attended / t - total + 1e-9);
  return Math.max(0, Math.min(k, 365)); // sanity cap; semesters are finite
}

/** Attendance % after attending `k` more classes. */
export function projectAfterAttending(
  s: AttendanceStats,
  k: number
): number | null {
  if (!(s.total > 0) || k < 0) return null;
  return attendancePercent({ attended: s.attended + k, total: s.total + k });
}

/** Attendance % after bunking `k` upcoming classes. */
export function projectAfterBunking(
  s: AttendanceStats,
  k: number
): number | null {
  if (!(s.total > 0) || k < 0) return null;
  return attendancePercent({ attended: s.attended, total: s.total + k });
}

export interface Insight {
  reach: number | null;      // classes needed to hit the target (null = impossible)
  bunkable: number;          // classes that can be skipped while staying >= target
}

export function computeInsight(s: AttendanceStats, target = DEFAULT_TARGET): Insight {
  return {
    reach: classesToReachTarget(s, target),
    bunkable: bunkableToStayAbove(s, target),
  };
}

export interface SubjectRisk {
  subject: { courseCode: string; name: string; attendedClasses: number; totalClasses: number };
  percent: number;
  level: RiskLevel;
  reach: number | null;
  bunkable: number;
}

/** Sort comparator: most dangerous subjects first. */
export function byRisk(a: SubjectRisk, b: SubjectRisk): number {
  const order: Record<RiskLevel, number> = { CRITICAL: 0, AT_RISK: 1, WATCH: 2, SAFE: 3 };
  if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
  return a.percent - b.percent;
}
