import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight, TrendingUp, BookOpen, Award, BarChart3,
  AlertTriangle, ShieldCheck, Clock, User, RefreshCw, Plane,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { AnimatedNumber } from '../components/ui/AnimatedNumber';
import { Badge } from '../components/ui/Badge';
import { Skeleton } from '../components/ui/Skeleton';
import type { NavKey } from '../components/layout/Sidebar';
import type { StudentProfile, GpaSummaryData, ProfileStatus } from '../App';
import {
  useAttendanceData,
  hydrateCalendarCache,
  type CourseEvent,
  type CourseAttendanceResponse,
} from '../hooks/useAttendanceData';
import { useCurrentSemester } from '../hooks/useCurrentSemester';
import { decodeRollNumber } from '../lib/rollNumber';
import { loadAttendanceTarget } from '../lib/storage';
import {
  riskLevel, riskTone, riskLabel, attendancePercent, byRisk,
  computeInsight,
  type SubjectRisk,
} from '../lib/attendanceMath';
import { localIsoDate } from '../lib/utils';

interface DashboardPageProps {
  sessionId: string;
  profile?: StudentProfile | null;
  profileStatus?: ProfileStatus;
  onRetryProfile?: () => void;
  gpaSummary?: GpaSummaryData | null;
  onNavigate: (key: NavKey) => void;
}

const stagger = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.4, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

const GRADE_POINTS: Record<string, number> = {
  O: 10, 'A+': 9, A: 8, 'B+': 7, B: 6, C: 5, P: 4, F: 0, W: 0, I: 0,
};

function gradePoint(grade: string): number {
  const g = grade.trim().toUpperCase();
  if (GRADE_POINTS[g] !== undefined) return GRADE_POINTS[g];
  const num = parseFloat(g);
  return Number.isNaN(num) ? 0 : num;
}

function gradeTone(points: number): 'success' | 'info' | 'danger' {
  if (points >= 8) return 'success';
  if (points >= 5) return 'info';
  return 'danger';
}

// Turn cached per-course calendar responses into a flat event list tagged
// with subject meta. Reuses the exact same localStorage cache CalendarPage
// hydrates from — no new AUMS traffic.
function cachedEventsFlat(
  sessionIds: { sessionId: string; semesterId: string },
  subjects: { courseId?: string; courseCode: string; name: string }[]
): CourseEvent[] {
  const ids = subjects.map((s) => s.courseId).filter((v): v is string => !!v);
  const cached = hydrateCalendarCache(sessionIds.sessionId, sessionIds.semesterId, ids);
  if (!cached) return [];
  const byId = new Map(subjects.map((s) => [s.courseId, s] as const));
  const out: CourseEvent[] = [];
  for (const c of cached as Array<CourseAttendanceResponse & { courseId: string }>) {
    const subject = byId.get(c.courseId);
    if (!subject) continue;
    for (const e of c.events || []) {
      if (e.status === 'Holiday' || e.status === 'Cancelled') continue;
      out.push({
        ...e,
        subjectCode: subject.courseCode,
        subjectName: subject.name,
        courseId: e.courseId ?? c.courseId,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period);
}

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

export function DashboardPage({ sessionId, profile, profileStatus, onRetryProfile, gpaSummary, onNavigate }: DashboardPageProps) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const grades = gpaSummary?.grades || [];
  const { semester: currentSemester } = useCurrentSemester(profile?.batch);
  const rollInfo = decodeRollNumber(profile?.rollNumber);

  // Attendance (stale-while-revalidate from cache) for the CURRENT semester —
  // same hook the AttendancePage uses; dashboard just reads it.
  const {
    selectedSemester,
    attendance,
    attendanceFresh,
    loadAttendance,
  } = useAttendanceData(sessionId, currentSemester ?? undefined);

  // The dashboard OWNS the fetch for its semester. Without this the attention
  // cards sat on skeletons forever (nothing called loadAttendance).
  const dashLoadRef = useRef('');
  useEffect(() => {
    if (!selectedSemester) return;
    const key = `${sessionId}:${selectedSemester}`;
    if (dashLoadRef.current === key) return;
    dashLoadRef.current = key;
    loadAttendance(selectedSemester);
  }, [sessionId, selectedSemester, loadAttendance]);

  const subjRisks = useMemo<SubjectRisk[]>(() => {
    const list = attendance?.subjects || [];
    if (!list.length) return [];
    const target = loadAttendanceTarget();
    return list
      .filter((s) => s.totalClasses > 0)
      .map((s) => {
        const stats = { attended: s.attendedClasses, total: s.totalClasses };
        const percent = attendancePercent(stats);
        const insight = computeInsight(stats, target);
        return {
          subject: { courseCode: s.courseCode, name: s.name, attendedClasses: s.attendedClasses, totalClasses: s.totalClasses },
          percent,
          level: riskLevel(percent),
          reach: insight.reach,
          bunkable: insight.bunkable,
        };
      })
      .sort(byRisk);
  }, [attendance]);

  const overall = useMemo(() => {
    const list = attendance?.subjects || [];
    const attended = list.reduce((s, x) => s + (x.attendedClasses || 0), 0);
    const total = list.reduce((s, x) => s + (x.totalClasses || 0), 0);
    return total ? Math.round((attended / total) * 1000) / 10 : 0;
  }, [attendance]);

  const attn = subjRisks[0]; // most at-risk subject
  const dangerCount = subjRisks.filter((s) => s.level === 'AT_RISK' || s.level === 'CRITICAL').length;

  // Bunk budget — the actionable inverse of "overall attendance": how many
  // classes can still be skipped across every subject while staying >= target.
  // Collapses to 0 the moment any single subject dips below target, which is
  // exactly the case the old aggregate percentage hid behind a green ring.
  const bunkBudget = useMemo(() => {
    if (!subjRisks.length) return null;
    const slack = subjRisks.reduce((s, x) => s + (x.bunkable ?? 0), 0);
    const target = loadAttendanceTarget();
    const failing = subjRisks.filter((s) => s.level === 'AT_RISK' || s.level === 'CRITICAL');
    return { slack, target, failing: failing.length };
  }, [subjRisks]);

  const sgpa = useMemo(() => {
    if (gpaSummary?.sgpa == null || gpaSummary.sgpa === '') return null;
    const n = parseFloat(String(gpaSummary.sgpa));
    return Number.isNaN(n) ? null : n;
  }, [gpaSummary?.sgpa]);

  const gradeBars = useMemo(() => {
    const counts: Record<string, number> = {};
    grades.forEach((g) => {
      const gp = gradePoint(g.grade);
      const bucket = gp >= 8 ? 'O / A+' : gp >= 6 ? 'A / B+' : gp >= 4 ? 'B / C' : 'Below C';
      counts[bucket] = (counts[bucket] || 0) + 1;
    });
    return Object.entries(counts).map(([label, value]) => ({ label, value }));
  }, [grades]);

  const schedule = useMemo(
    () => (selectedSemester
      ? cachedEventsFlat({ sessionId, semesterId: selectedSemester }, attendance?.subjects || [])
          .filter((e) => e.date === localIsoDate())
      : []),
    [sessionId, selectedSemester, attendance]
  );

  // Momentum — streak of consecutive class days without an absence + a 14-day
  // mini strip. Computed from cached events only (zero AUMS calls).
  const momentum = useMemo(() => {
    if (!selectedSemester) return null;
    const events = cachedEventsFlat({ sessionId, semesterId: selectedSemester }, attendance?.subjects || []);
    if (!events.length) return null;

    const byDay = new Map<string, { present: number; absent: number }>();
    for (const e of events) {
      const d = byDay.get(e.date) || { present: 0, absent: 0 };
      if (e.status === 'Absent') d.absent += 1;
      else if (e.status === 'Present' || e.status === 'OD' || e.status === 'ML') d.present += 1;
      byDay.set(e.date, d);
    }

    const today = localIsoDate();
    const days: { iso: string; present: number; absent: number; isToday: boolean }[] = [];
    for (let i = 13; i >= 0; i--) {
      const iso = isoAddDays(today, -i);
      const d = byDay.get(iso);
      days.push({ iso, present: d?.present || 0, absent: d?.absent || 0, isToday: i === 0 });
    }

    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const iso = isoAddDays(today, -i);
      const d = byDay.get(iso);
      if (!d) continue; // no classes that day — streak survives
      if (d.absent > 0) break;
      streak += 1;
    }

    const clean = days.reduce((s, d) => s + d.present, 0);
    const missed = days.reduce((s, d) => s + d.absent, 0);
    return { days, streak, clean, missed };
  }, [sessionId, selectedSemester, attendance]);

  // One-line status with a bit of personality.
  const statusLine = useMemo(() => {
    if (!attendance) return null;
    const target = loadAttendanceTarget();
    if (dangerCount >= 3) return `${dangerCount} subjects need real attention — start with the worst one today.`;
    if (dangerCount > 0) return `${dangerCount} subject${dangerCount === 1 ? '' : 's'} below target. Attend the next couple — easy to recover.`;
    if (overall >= 90) return `You're cruising — ${Math.max(0, subjRisks.reduce((s, x) => s + (x.bunkable ?? 0), 0))} classes of total slack at ${target}%.`;
    if (overall >= target) return 'Above target across the board. Steady hands.';
    return 'Above target. Keep the streak going.';
  }, [attendance, dangerCount, overall, subjRisks]);

  const latestSemester = currentSemester ? String(currentSemester) : '—';
  const latestGrades = grades.slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Greeting header — quiet, informational */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-ink-faint">{greeting}</p>
          {profileStatus === 'loading' && !profile ? (
            <div className="mt-1 space-y-2" aria-label="Loading profile">
              <div className="h-7 w-56 animate-pulse rounded bg-ink/10" />
            </div>
          ) : (
            <h2 className="mt-0.5 truncate font-display text-2xl font-bold text-ink">{profile?.name || 'Student'}</h2>
          )}
          <p className="mt-0.5 truncate text-sm text-ink-soft">
            {profile?.rollNumber ? `${profile.rollNumber} · ` : ''}
            {rollInfo?.branch || profile?.branch || 'Amrita University'}
            {currentSemester ? ` · Semester ${currentSemester}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center divide-x divide-border rounded-lg border border-border bg-surface-raised shadow-card">
          <div className="px-4 py-2.5 text-center">
            <p className="text-lg font-bold text-ink">{gpaSummary?.cgpa || '—'}</p>
            <p className="text-[11px] text-ink-faint">CGPA</p>
          </div>
          <div className="px-4 py-2.5 text-center">
            <p className="text-lg font-bold text-ink">{gpaSummary?.sgpa || '—'}</p>
            <p className="text-[11px] text-ink-faint">SGPA{gpaSummary?.semester ? ` · S${gpaSummary.semester}` : ''}</p>
          </div>
        </div>
      </header>

      {profileStatus === 'error' && (
        <motion.div variants={stagger} custom={1} initial="hidden" animate="show">
          <Card className="flex flex-col gap-3 border-amber-300/50 bg-amber-500/5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                <User className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Profile could not be loaded</p>
                <p className="text-xs text-ink-faint">AUMS did not return a valid profile. Your other data is unaffected.</p>
              </div>
            </div>
            <button
              onClick={onRetryProfile}
              className="shrink-0 rounded-xl bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-600 transition hover:bg-amber-500/25 dark:text-amber-400"
            >
              Retry
            </button>
          </Card>
        </motion.div>
      )}

      {/* === "How am I doing?" row === */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Bunk budget — replaces the old overall-attendance ring. A single
            aggregate % reads fine while a subject is quietly failing; the
            number of classes you can still skip does not. */}
        <motion.div variants={stagger} custom={1} initial="hidden" animate="show">
          <Card interactive onClick={() => onNavigate('attendance')} className="flex items-center gap-4">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${bunkBudget && bunkBudget.failing > 0 ? 'bg-amber-500/10 text-amber-500' : 'bg-emerald-500/10 text-emerald-500'}`}>
              <Plane className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold text-ink">{bunkBudget ? bunkBudget.slack : '—'}</span>
                <span className="text-sm text-ink-faint">
                  {bunkBudget && bunkBudget.slack === 1 ? 'class' : 'classes'}
                </span>
                {!attendanceFresh && (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-ink-faint" aria-label="Refreshing" />
                )}
              </p>
              <p className="truncate text-xs text-ink-faint">
                {!bunkBudget
                  ? 'Semester ' + latestSemester
                  : bunkBudget.failing > 0
                    ? `of slack in safe subjects · ${bunkBudget.failing} below ${bunkBudget.target}%`
                    : `to bunk and stay ≥${bunkBudget.target}% everywhere`}
              </p>
              <p className="mt-1 text-xs font-medium text-brand-500">Planner →</p>
            </div>
          </Card>
        </motion.div>

        {/* Most at-risk subject */}
        <motion.div variants={stagger} custom={2} initial="hidden" animate="show">
          <Card interactive onClick={() => onNavigate('attendance')} className="flex items-center gap-4">
            {attn ? (
              attn.level === 'SAFE' ? (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
                  <ShieldCheck className="h-6 w-6" />
                </div>
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
                  <AlertTriangle className="h-6 w-6" />
                </div>
              )
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-ink/5 text-ink-faint">
                <BookOpen className="h-6 w-6" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">
                {attn ? riskLabel(attn.level) : 'No data yet'}
              </p>
              <p className="truncate text-xs text-ink-faint">
                {attn
                  ? `${attn.subject.name || attn.subject.courseCode} · ${attn.percent}%`
                  : 'Load attendance below'}
              </p>
            </div>
          </Card>
        </motion.div>

        {/* SGPA (current semester) */}
        <motion.div variants={stagger} custom={3} initial="hidden" animate="show">
          <Card interactive onClick={() => onNavigate('gpa')} className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-500">
              <TrendingUp className="h-6 w-6" />
            </div>
            <div>
              <p className="text-2xl font-bold text-ink">
                {sgpa !== null ? <AnimatedNumber value={sgpa} decimals={2} /> : '—'}
              </p>
              <p className="text-sm text-ink-faint">SGPA · Sem {gpaSummary?.semester || '1'}</p>
            </div>
          </Card>
        </motion.div>

        {/* CGPA */}
        <motion.div variants={stagger} custom={4} initial="hidden" animate="show">
          <Card interactive onClick={() => onNavigate('gpa')} className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-500">
              <Award className="h-6 w-6" />
            </div>
            <div>
              <p className="text-2xl font-bold text-ink">{gpaSummary?.cgpa || '—'}</p>
              <p className="text-sm text-ink-faint">Current CGPA</p>
            </div>
          </Card>
        </motion.div>
      </div>

      {/* Subject attention + today's classes */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Subjects needing attention */}
        <motion.div variants={stagger} custom={5} initial="hidden" animate="show" className="lg:col-span-2">
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-display text-lg font-bold text-ink">Subjects needing attention</h3>
                <p className="text-sm text-ink-faint">Semester {latestSemester} attendance, most urgent first</p>
              </div>
              <button onClick={() => onNavigate('attendance')} className="btn-secondary px-3 py-1.5 text-xs">
                All subjects <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {!attendance ? (
              <div className="space-y-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
                <Skeleton className="h-14 w-2/3" />
              </div>
            ) : subjRisks.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <BookOpen className="h-10 w-10 text-ink-faint" />
                <p className="text-sm text-ink-soft">No attendance data for this semester yet.</p>
                <button onClick={() => onNavigate('attendance')} className="btn-primary text-xs">Open Attendance</button>
              </div>
            ) : (
              <div className="space-y-2">
                {subjRisks.slice(0, 4).map((s) => (
                  <div
                    key={s.subject.courseCode}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/60 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{s.subject.name || s.subject.courseCode}</p>
                      <p className="font-mono text-xs text-ink-faint">{s.subject.courseCode} · {s.subject.attendedClasses}/{s.subject.totalClasses} classes</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm font-bold text-ink">{s.percent}%</span>
                      <Badge tone={riskTone(s.level)}>{riskLabel(s.level)}</Badge>
                    </div>
                  </div>
                ))}
                {subjRisks.length > 4 && (
                  <button onClick={() => onNavigate('attendance')} className="w-full rounded-xl bg-ink/5 py-2 text-xs font-semibold text-ink-soft transition hover:bg-ink/10 dark:bg-white/5 dark:hover:bg-white/10">
                    +{subjRisks.length - 4} more subjects
                  </button>
                )}
              </div>
            )}
          </Card>
        </motion.div>

        {/* Right column: today + momentum + grades */}
        <motion.div variants={stagger} custom={6} initial="hidden" animate="show" className="space-y-6">
          {/* Momentum — streak + last 14 days */}
          {momentum && (
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-display text-lg font-bold text-ink">Momentum</h3>
                {momentum.streak > 0 && (
                  <span className="chip bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    {momentum.streak}-day clean streak
                  </span>
                )}
              </div>
              <div className="flex items-end justify-between gap-1" aria-hidden>
                {momentum.days.map((d) => {
                  const total = d.present + d.absent;
                  const h = total === 0 ? 3 : Math.max(6, Math.min(40, total * 6));
                  return (
                    <div key={d.iso} className="flex flex-1 flex-col items-center gap-1" title={`${d.iso}: ${d.present} present, ${d.absent} absent`}>
                      <div
                        className={`flex w-full max-w-6 flex-col-reverse overflow-hidden rounded-sm ${d.isToday ? 'ring-1 ring-brand-400' : ''}`}
                        style={{ height: h }}
                      >
                        {d.absent > 0 && (
                          <div className="bg-rose-500" style={{ flexGrow: d.absent }} />
                        )}
                        {d.present > 0 && (
                          <div className="bg-emerald-500" style={{ flexGrow: d.present }} />
                        )}
                        {total === 0 && <div className="bg-ink/10 dark:bg-white/10" style={{ flexGrow: 1 }} />}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                Last 14 days · {momentum.clean} present · {momentum.missed} absent{momentum.streak > 0 ? ` · on a ${momentum.streak}-day roll` : ''}
              </p>
              {statusLine && (
                <p className="mt-2 border-t border-border pt-2 text-sm font-medium text-ink-soft">{statusLine}</p>
              )}
            </Card>
          )}

          {/* Today's classes */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-ink">Today</h3>
              <button onClick={() => onNavigate('calendar')} className="text-xs font-semibold text-brand-500 hover:underline">
                Calendar →
              </button>
            </div>
            {schedule.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-surface/40 px-4 py-6 text-center text-sm text-ink-faint">
                No classes recorded for today. Open the Calendar to sync your schedule.
              </p>
            ) : (
              <div className="space-y-2">
                {schedule.slice(0, 4).map((e, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 px-3.5 py-2.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 font-mono text-xs font-bold text-brand-500">
                      P{e.period}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{e.subjectName || e.subjectCode}</p>
                      <p className="flex items-center gap-1 text-[11px] text-ink-faint">
                        <Clock className="h-3 w-3" />
                        {e.hours ? `${e.hours}h` : `Period ${e.period}`}{e.periodTo && e.periodTo !== e.period ? `–${e.periodTo}` : ''}
                      </p>
                    </div>
                    <Badge tone={e.status === 'Absent' ? 'danger' : e.status === 'Present' ? 'success' : 'info'}>{e.status}</Badge>
                  </div>
                ))}
                {schedule.length > 4 && <p className="text-center text-xs text-ink-faint">+{schedule.length - 4} more today</p>}
              </div>
            )}
          </Card>

          {/* Recent grades */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-ink">Latest Grades</h3>
              <button onClick={() => onNavigate('gpa')} className="text-xs font-semibold text-brand-500 hover:underline">
                GPA →
              </button>
            </div>
            {latestGrades.length ? (
              <div className="space-y-2">
                {latestGrades.map((g) => (
                  <div key={g.courseCode} className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm text-ink-soft">{g.courseCode}</p>
                    <Badge tone={gradeTone(gradePoint(g.grade))}>{g.grade}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-faint">No grades loaded yet.</p>
            )}

            {gradeBars.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  <BarChart3 className="h-3.5 w-3.5" /> Grade mix
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {gradeBars.map((b) => (
                    <span key={b.label} className="chip border border-border bg-surface/60 text-ink-soft">
                      {b.label} <span className="font-bold text-ink">{b.value}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </motion.div>
      </div>

      {/* Full profile summary (collapsible section replaced the old big card) */}
      <motion.div variants={stagger} custom={7} initial="hidden" animate="show">
        <details className="group glass-card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand-500 font-bold text-white">
                {profile?.photo ? (
                  <img src={profile.photo} alt="" className="h-full w-full object-cover" />
                ) : (
                  (profile?.name || 'S').trim().charAt(0).toUpperCase()
                )}
              </div>
              <div>
                <p className="font-display text-base font-bold text-ink">Profile details</p>
                <p className="text-xs text-ink-faint">{profile?.rollNumber || '—'}</p>
              </div>
            </div>
            <span className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-ink-soft transition group-open:bg-brand-500/10 group-open:text-brand-500">
              Show
            </span>
          </summary>
          <div className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[
              { label: 'Name', value: profile?.name },
              { label: 'Roll No', value: profile?.rollNumber },
              { label: 'Registration No', value: profile?.registrationNumber },
              { label: 'Programme', value: profile?.programme },
              { label: 'Branch', value: rollInfo?.branch || profile?.branch },
              { label: 'Semester', value: currentSemester ? String(currentSemester) : undefined },
              { label: 'Batch', value: rollInfo?.batch || profile?.batch },
              { label: 'Section', value: rollInfo?.section || profile?.section },
              { label: 'Campus', value: rollInfo?.campus || profile?.campus },
              { label: 'Email', value: profile?.email },
              { label: 'Phone', value: profile?.phone },
              { label: 'Mentor / Advisor', value: profile?.mentor },
            ].map((f) => (
              <div key={f.label} className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{f.label}</p>
                <p className="truncate text-sm font-medium text-ink" title={f.value || 'N/A'}>
                  {f.value || 'N/A'}
                </p>
              </div>
            ))}
          </div>
        </details>
      </motion.div>
    </div>
  );
}
