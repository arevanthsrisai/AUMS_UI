import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CalendarDays, ChevronRight, RefreshCw, Search, Target } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { ProgressRing } from '../components/ui/ProgressRing';
import { Badge } from '../components/ui/Badge';
import { CardSkeleton, Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useAttendanceData, type AttendanceSubject } from '../hooks/useAttendanceData';
import { loadAttendanceTarget, saveAttendanceTarget } from '../lib/storage';
import {
  attendancePercent, computeInsight, riskLevel, riskTone, riskLabel,
} from '../lib/attendanceMath';

interface AttendancePageProps {
  sessionId: string;
  onOpenSubject: (subject: AttendanceSubject, semesterId?: string) => void;
  preferredSemester?: number;
}

const fade = {
  hidden: { opacity: 0, y: 14 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.04, duration: 0.35, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

export function AttendancePage({ sessionId, onOpenSubject, preferredSemester }: AttendancePageProps) {
  const {
    semesters, selectedSemester, setSelectedSemester,
    attendance, loadingSemesters, loadingAttendance, error, setError,
    attendanceFresh, loadAttendance,
  } = useAttendanceData(sessionId, preferredSemester);
  const [search, setSearch] = useState('');
  // One shared target for the page; the slider recomputes all intelligence
  // instantly in the browser. AUMS is never called for these numbers.
  // Persisted so the student's own goal survives reloads and applies
  // across the whole app.
  const [target, setTarget] = useState(() => loadAttendanceTarget());
  useEffect(() => { saveAttendanceTarget(target); }, [target]);

  // Auto-load attendance whenever the semester resolves or the user changes
  // it — previously the page sat on the empty state until "Load Attendance"
  // was clicked manually.
  const autoLoadRef = useRef('');
  useEffect(() => {
    if (!selectedSemester) return;
    const key = `${sessionId}:${selectedSemester}`;
    if (autoLoadRef.current === key) return;
    autoLoadRef.current = key;
    loadAttendance(selectedSemester);
  }, [sessionId, selectedSemester, loadAttendance]);

  const subjects = useMemo(() => {
    const list = attendance?.subjects || [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(s => s.courseCode.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [attendance, search]);

  const enriched = useMemo(() => {
    return subjects
      .filter(s => s.totalClasses > 0)
      .map((s) => {
        const stats = { attended: s.attendedClasses, total: s.totalClasses };
        const percent = attendancePercent(stats);
        const insight = computeInsight(stats, target);
        return { subject: s, percent, ...insight, level: riskLevel(percent) };
      })
      .sort((a, b) => {
        const order: Record<string, number> = { CRITICAL: 0, AT_RISK: 1, WATCH: 2, SAFE: 3 };
        if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
        return a.percent - b.percent;
      });
  }, [subjects, target]);

  const overall = useMemo(() => {
    const attended = enriched.reduce((s, x) => s + x.subject.attendedClasses, 0);
    const total = enriched.reduce((s, x) => s + x.subject.totalClasses, 0);
    return total ? Math.round((attended / total) * 1000) / 10 : 0;
  }, [enriched]);

  const planner = useMemo(() => {
    if (!enriched.length) return null;
    const withSlack = enriched
      .map((e) => ({ ...e, slack: e.bunkable }))
      .filter((e) => e.slack > 0)
      .sort((a, b) => b.slack - a.slack);
    const needList = enriched.filter((e) => e.reach !== null && e.reach > 0);
    const impossible = enriched.filter((e) => e.reach === null);
    return { withSlack, needList, impossible };
  }, [enriched]);

  return (
    <div className="space-y-6">
      {/* Header — controls */}
      <Card className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-xl font-bold text-ink">Attendance</h2>
            <p className="text-sm text-ink-faint">
              {attendance && !attendanceFresh
                ? 'Showing cached data — refreshing in background…'
                : 'Subject-wise attendance, planner and risk levels'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedSemester}
              onChange={(e) => setSelectedSemester(e.target.value)}
              className="input w-full sm:w-44"
              aria-label="Select semester"
              disabled={loadingAttendance}
            >
              {semesters.map((s) => (
                <option key={s.id} value={s.id}>Semester {s.name}</option>
              ))}
            </select>
            <button onClick={() => loadAttendance()} className="btn-primary" disabled={loadingAttendance || !selectedSemester}>
              {loadingAttendance ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
              {loadingAttendance ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        {/* Target slider — pure client-side recomputation */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <label htmlFor="target-slider" className="flex shrink-0 items-center gap-2 text-sm font-medium text-ink-soft">
            <Target className="h-4 w-4 text-brand-500" />
            Target <span className="font-bold text-ink">{target}%</span>
          </label>
          <input
            id="target-slider"
            type="range"
            min={50}
            max={95}
            step={5}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="h-11 w-full sm:max-w-xs accent-[var(--brand-500)]"
            aria-valuemin={50}
            aria-valuemax={95}
            aria-valuenow={target}
          />
          <span className="text-xs text-ink-faint">Recomputes everything instantly — no AUMS calls.</span>
        </div>
      </Card>

      {error && (
        <Card className="border-rose-300/50 bg-rose-500/5">
          <p className="font-medium text-rose-600 dark:text-rose-400">{error}</p>
          <button onClick={() => { setError(null); loadAttendance(); }} className="btn-secondary mt-3 text-xs">Retry</button>
        </Card>
      )}

      {loadingSemesters ? (
        <div className="space-y-6">
          <Skeleton className="h-24" />
          <CardSkeleton count={3} />
        </div>
      ) : loadingAttendance && !attendance ? (
        <CardSkeleton count={6} />
      ) : !attendance?.subjects?.length ? (
        <EmptyState
          icon={CalendarDays}
          title="No attendance loaded"
          description="Load attendance for a semester to see subject cards."
          actionLabel="Load Attendance"
          onAction={() => loadAttendance()}
        />
      ) : (
        <>
          {/* Intelligence strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <IntStat label="Overall" value={`${overall}%`} hint="across all subjects" />
            <IntStat label="Can bunk" value={enriched.reduce((s, x) => s + x.bunkable, 0)} hint={`while staying ≥ ${target}%`} />
            <IntStat label="Must attend" value={enriched.reduce((s, x) => s + (x.reach ?? 0), 0)} hint={`to reach ${target}%`} />
            <IntStat
              label="At risk"
              value={enriched.filter((x) => x.level === 'AT_RISK' || x.level === 'CRITICAL').length}
              hint={`below ${target}%`}
            />
          </div>

          {/* Planner */}
          {planner && planner.needList.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <Target className="h-5 w-5 text-brand-500" />
                <h3 className="font-display text-lg font-bold text-ink">Planner</h3>
                <span className="chip bg-brand-500/10 text-brand-500">target {target}%</span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-emerald-300/40 bg-emerald-500/5 p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">You can skip</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {planner.withSlack.length
                      ? planner.withSlack.slice(0, 3).map((e) => `${e.subject.name || e.subject.courseCode} (${e.slack})`).join(' · ')
                      : 'No slack at this target'}
                    {planner.withSlack.length > 3 ? ` · +${planner.withSlack.length - 3} more` : ''}
                  </p>
                </div>
                <div className="rounded-2xl border border-amber-300/40 bg-amber-500/5 p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">You must attend</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {planner.needList
                      .slice()
                      .sort((a, b) => (a.reach ?? 0) - (b.reach ?? 0))
                      .slice(0, 3)
                      .map((e) => `${e.subject.name || e.subject.courseCode} (+${e.reach})`)
                      .join(' · ') || `All subjects already ≥ ${target}%`}
                    {planner.impossible.length > 0 ? ' · some targets impossible' : ''}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search subjects…"
              className="input pl-10"
              aria-label="Search subjects"
            />
          </div>

          {/* Subject cards */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {enriched.map((e, i) => {
              const s = e.subject;
              return (
                <motion.div key={s.courseCode} variants={fade} custom={i} initial="hidden" animate="show">
                  <Card
                    interactive
                    onClick={() => onOpenSubject(s, selectedSemester)}
                    className="group h-full touch-manipulation"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-semibold text-brand-500">{s.courseCode}</p>
                        <h3 className="mt-1 font-semibold text-ink" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {s.name}
                        </h3>
                      </div>
                      <ProgressRing value={e.percent} size={56} stroke={5} label={s.courseCode} />
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Badge tone={riskTone(e.level)}>{riskLabel(e.level)}</Badge>
                      <Badge tone="neutral">{s.attendedClasses}/{s.totalClasses}</Badge>
                      {e.reach !== null && e.reach > 0 && <Badge tone="warning">attend {e.reach} → {target}%</Badge>}
                      {e.bunkable > 0 && <Badge tone="success">can skip {e.bunkable}</Badge>}
                    </div>

                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/5 dark:bg-white/10">
                      <div
                        className={`h-full rounded-full ${e.percent >= 85 ? 'bg-emerald-500' : e.percent >= 75 ? 'bg-lime-500' : e.percent >= 65 ? 'bg-amber-500' : 'bg-rose-500'}`}
                        style={{ width: `${Math.min(100, e.percent)}%` }}
                      />
                    </div>
                    <p className="mt-2 flex items-center gap-1 text-[11px] text-ink-faint">
                      <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                      Tap for daily report & simulator
                    </p>
                  </Card>
                </motion.div>
              );
            })}
          </div>

          {enriched.length === 0 && subjects.length > 0 && (
            <EmptyState icon={Search} title="No measurable subjects" description="Subjects without any recorded classes yet are hidden here." />
          )}
          {enriched.length === 0 && subjects.length === 0 && search.trim() && (
            <EmptyState icon={Search} title="No matching subjects" description={`Nothing matches \u201c${search.trim()}\u201d — try a course code or name.`} />
          )}
        </>
      )}
    </div>
  );
}

function IntStat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="glass-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-ink-faint">{hint}</p>}
    </div>
  );
}
