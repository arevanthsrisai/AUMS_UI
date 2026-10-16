import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, CalendarDays, X, Clock } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { CardSkeleton, Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useAttendanceData, fetchCourseAttendance, hydrateCalendarCache, type CourseEvent, type CourseAttendanceResponse } from '../hooks/useAttendanceData';
import { formatDateLong, monthLabel, localIsoDate } from '../lib/utils';

interface CalendarPageProps {
  sessionId: string;
  preferredSemester?: number;
}

const STATUS_DOT: Record<string, string> = {
  Present: 'bg-emerald-500',
  Absent: 'bg-rose-500',
  OD: 'bg-emerald-500',
  ML: 'bg-violet-500',
  Holiday: 'bg-slate-300',
  Cancelled: 'bg-slate-400',
};

// OD counts as Present for display purposes (attended with official duty).
function displayStatus(status: string): string {
  return status === 'OD' ? 'Present' : status;
}

function subjectLabel(e: CourseEvent): string {
  return e.subjectName || e.subjectCode || '';
}

// TEMPORARY (product decision): ML and Holiday events are hidden from the
// calendar everywhere — month grid, week view, agenda, and day detail. Set
// this to an empty array to re-enable them; no other change is needed.
const HIDDEN_EVENT_STATUSES = ['ML', 'Holiday'];
const isHiddenStatus = (status: string) => HIDDEN_EVENT_STATUSES.includes(status);


const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarPage({ sessionId, preferredSemester }: CalendarPageProps) {
  const { semesters, selectedSemester, setSelectedSemester, attendance, loadingSemesters, loadingAttendance, error, loadAttendance } = useAttendanceData(sessionId, preferredSemester);
  const [viewDate, setViewDate] = useState(() => new Date());
  const [allEvents, setAllEvents] = useState<Record<string, CourseEvent[]>>({});
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // True when every course fetch of the latest run failed with nothing to show.
  const [eventsError, setEventsError] = useState(false);
  // Monotonic run id: only the latest load may write events / clear the flag.
  // Previously a stale slow run could finish after a newer one and clobber
  // both the grid and loadingEvents (the "stuck loading" bug).
  const loadSeqRef = useRef(0);

  // Turn cached per-course responses into the day-keyed event map, tagging
  // events with the subject info from the freshly loaded attendance list.
  function cachedEventsToMap(
    cached: Array<CourseAttendanceResponse & { courseId: string }>,
    subjects: { courseId?: string; courseCode: string; name: string }[]
  ): Record<string, CourseEvent[]> {
    const byId = new Map(subjects.map((s) => [s.courseId, s] as const));
    const map: Record<string, CourseEvent[]> = {};
    for (const c of cached) {
      const subject = byId.get(c.courseId);
      if (!subject) continue;
      c.events?.forEach((e: CourseEvent) => {
        (map[e.date] ||= []).push({
          date: e.date,
          period: e.period,
          periodTo: e.periodTo,
          hours: e.hours,
          status: e.status,
          subjectCode: subject.courseCode,
          subjectName: subject.name,
          courseId: e.courseId ?? c.courseId,
        });
      });
    }
    return map;
  }

  const loadAllEvents = async () => {
    const subjects = attendance?.subjects || [];
    const semId = selectedSemester;
    if (!subjects.length || !semId) return;
    const runId = ++loadSeqRef.current;
    setEventsError(false);
    try {
      // Stale-while-revalidate: hydrate the grid instantly from the
      // localStorage cache, then fetch fresh data and reconcile.
      const subjectIds = subjects.map((s) => s.courseId).filter((v): v is string => !!v);
      const cached = hydrateCalendarCache(sessionId, semId, subjectIds);
      if (cached) {
        // Instant interactive grid from cache; fresh data reconciles below.
        setAllEvents(cachedEventsToMap(cached, subjects));
      }
      // Only block the grid when there is nothing cached to show — a
      // background refresh must never replace a rendered calendar with a
      // skeleton (that was the "loading loop" the user had to poke away).
      if (!cached) setLoadingEvents(true);

      // Fetch all courses concurrently (bounded) instead of sequentially:
      // N slow AUMS round-trips used to serialize into a multi-second blank.
      const courseIds = subjects
        .map((s) => ({ subject: s, courseId: s.courseId }))
        .filter((x): x is { subject: (typeof subjects)[number]; courseId: string } => !!x.courseId);
      const CONCURRENCY = 4;
      const results: Array<{ subject: (typeof subjects)[number]; res: CourseAttendanceResponse; courseId: string } | null> =
        new Array(courseIds.length).fill(null);
      let next = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, courseIds.length) }, async () => {
        while (next < courseIds.length) {
          const idx = next++;
          const { subject, courseId } = courseIds[idx];
          const res = await fetchCourseAttendance(sessionId, semId, courseId);
          results[idx] = { subject, res, courseId };
        }
      });
      await Promise.all(workers);
      // A newer run superseded this one — drop our results entirely.
      if (runId !== loadSeqRef.current) return;

      const map: Record<string, CourseEvent[]> = {};
      let fetched = 0;
      for (const item of results) {
        if (!item) continue;
        const { subject, res, courseId } = item;
        if (res.success && res.events) {
          fetched += 1;
          res.events.forEach((e) => {
            (map[e.date] ||= []).push({
              date: e.date,
              period: e.period,
              periodTo: e.periodTo,
              hours: e.hours,
              status: e.status,
              subjectCode: subject.courseCode,
              subjectName: subject.name,
              courseId: e.courseId ?? courseId,
            });
          });
        }
      }
      // Adopt the fresh snapshot only if at least one course fetch succeeded;
      // a transient AUMS failure must not blank a grid the cache just drew.
      if (fetched > 0) setAllEvents(map);
      else if (!cached && subjects.length > 0) setEventsError(true);
    } catch {
      if (runId === loadSeqRef.current && !Object.keys(allEvents).length) setEventsError(true);
    } finally {
      // Only the latest run may clear the flag; a stale run clearing it
      // early (or never) is what left the skeleton stuck on screen.
      if (runId === loadSeqRef.current) setLoadingEvents(false);
    }
  };

  // Switching semesters must not leave the previous semester's events on
  // the grid (or a selected day that belongs to it) while the new one loads.
  // Bump the run id first so any in-flight load for the OLD semester is
  // invalidated and can't write its results after this reset.
  useEffect(() => {
    loadSeqRef.current += 1;
    setAllEvents({});
    setSelectedDate(null);
    setEventsError(false);
    setLoadingEvents(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSemester]);

  // Auto-load attendance once the semester resolves. Previously this ran once
  // on mount when selectedSemester was still '' (no-op) and never re-ran —
  // the calendar stayed empty until the user clicked "Load Attendance".
  // Deduped per session+semester so StrictMode double-effects and profile
  // late-resolution don't fire duplicate report requests.
  const autoLoadRef = useRef('');
  useEffect(() => {
    if (!selectedSemester) return;
    const key = `${sessionId}:${selectedSemester}`;
    if (autoLoadRef.current === key) return;
    autoLoadRef.current = key;
    loadAttendance(selectedSemester);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, selectedSemester]);

  // Load the grid whenever the semester's attendance is ready. Deduped so a
  // background refresh (new attendance object, same subject set) doesn't
  // restart the whole fetch fan-out, and guarded so another semester's
  // attendance never renders under the current selection.
  const eventsKeyRef = useRef('');
  useEffect(() => {
    if (!attendance?.subjects?.length || !selectedSemester) return;
    if (attendance.semesterId && attendance.semesterId !== selectedSemester) return;
    const key = `${selectedSemester}:${attendance.subjects.map((s) => s.courseId || s.courseCode).join(',')}`;
    if (eventsKeyRef.current === key) return;
    eventsKeyRef.current = key;
    loadAllEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendance, selectedSemester]);

  // Single choke point for the temporary ML/Holiday hide: every consumer
  // below (grid counts, chips, agenda, day detail) reads visibleEvents.
  const visibleEvents = useMemo(() => {
    if (!HIDDEN_EVENT_STATUSES.length) return allEvents;
    const filtered: Record<string, CourseEvent[]> = {};
    for (const [date, events] of Object.entries(allEvents)) {
      const kept = events.filter((e) => !isHiddenStatus(e.status));
      if (kept.length) filtered[date] = kept;
    }
    return filtered;
  }, [allEvents]);

  const monthCells = useMemo(() => {
    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1).getDay();
    const days = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewDate]);

  const monthPrefix = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}-`;

  // Events for the selected day, sorted chronologically by period.
  const selectedEvents = useMemo(() => {
    if (!selectedDate) return [];
    return (visibleEvents[selectedDate] || []).slice().sort((a, b) => a.period - b.period);
  }, [allEvents, selectedDate]);

  const navigate = (delta: number) => {
    setViewDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  if (loadingSemesters || (loadingAttendance && !attendance)) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24" />
        <CardSkeleton count={2} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold text-ink">
            <CalendarDays className="h-6 w-6 text-brand-500" /> Attendance Calendar
          </h2>
          <p className="text-sm text-ink-faint">All subjects, one timeline</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <select value={selectedSemester} onChange={(e) => setSelectedSemester(e.target.value)} className="input w-full sm:w-36 py-2 text-sm" aria-label="Select semester">
            {semesters.map(s => <option key={s.id} value={s.id}>Sem {s.name}</option>)}
          </select>
        </div>
      </Card>

      {error && (
        <Card className="border-rose-300/50 bg-rose-500/5">
          <p className="font-medium text-rose-600 dark:text-rose-400">{error}</p>
          <button onClick={() => { autoLoadRef.current = ''; loadAttendance(selectedSemester); }} className="btn-secondary mt-3 text-xs">Retry</button>
        </Card>
      )}

      {!attendance?.subjects?.length && !loadingAttendance ? (
        <EmptyState icon={CalendarDays} title="No attendance data" description="Load attendance first to populate the calendar." actionLabel="Load Attendance" onAction={() => loadAttendance()} />
      ) : (
        <Card>
          {eventsError && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-rose-300/40 bg-rose-500/5 px-4 py-3">
              <p className="text-sm text-rose-600 dark:text-rose-400">Couldn\u2019t load course events from AUMS.</p>
              <button onClick={() => { eventsKeyRef.current = ''; loadAllEvents(); }} className="btn-secondary text-xs">Retry</button>
            </div>
          )}
          {/* Month header */}
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-display text-lg font-bold text-ink">{monthLabel(viewDate)}</h3>
            <div className="flex gap-2">
              <button onClick={() => navigate(-1)} className="btn-secondary p-2" aria-label="Previous"><ChevronLeft className="h-4 w-4" /></button>
              <button onClick={() => setViewDate(new Date())} className="btn-secondary text-xs">Today</button>
              <button onClick={() => navigate(1)} className="btn-secondary p-2" aria-label="Next"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>

          {/* Legend + Today jump */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-3 text-[11px] text-ink-soft">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Present/OD</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-500" /> Absent</span>
              {/* ML + Holiday legend entries hidden temporarily (HIDDEN_EVENT_STATUSES) */}
            </div>
            <button
              onClick={() => { setViewDate(new Date()); setSelectedDate(localIsoDate()); }}
              className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-ink-soft transition hover:border-brand-300 hover:text-ink"
            >
              Jump to today
            </button>
          </div>

          {loadingEvents ? (
            <Skeleton className="h-72" />
          ) : (
            <>
              <div className="grid grid-cols-7 border-b border-border bg-surface/60">
                {WEEKDAYS.map(d => <div key={d} className="py-2 text-center text-xs font-semibold text-ink-faint">{d}</div>)}
              </div>
              <div className="grid grid-cols-7">
                {monthCells.map((day, i) => {
                  if (day === null) return <div key={`e${i}`} className="min-h-20 border-b border-r border-border/60 sm:min-h-24" />;
                  const iso = `${monthPrefix}${String(day).padStart(2, '0')}`;
                  const evs = visibleEvents[iso] || [];
                  const isToday = new Date().toDateString() === new Date(viewDate.getFullYear(), viewDate.getMonth(), day).toDateString();
                  const isSelected = selectedDate === iso;
                  return (
                    <motion.button
                      key={iso}
                      type="button"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: day * 0.004 }}
                      onClick={() => setSelectedDate(isSelected ? null : iso)}
                      aria-label={formatDateLong(iso)}
                      aria-pressed={isSelected}
                      className={`min-h-[100px] border-b border-r border-border/60 p-1.5 text-left transition touch-manipulation ${isSelected ? 'bg-brand-500/10 ring-2 ring-inset ring-brand-400' : 'hover:bg-ink/5 dark:hover:bg-white/5'}`}
                    >
                      <span className={`text-xs font-semibold ${isToday ? 'text-brand-500' : 'text-ink-soft'}`}>{day}</span>
                      {evs.length > 0 && (
                        <span className="ml-auto flex items-center gap-1 text-[9px] font-bold">
                          {(() => {
                            const p = evs.filter(e => e.status === 'Present' || e.status === 'OD').length;
                            const a = evs.filter(e => e.status === 'Absent').length;
                            return (
                              <>
                                {p > 0 && <span className="text-emerald-600 dark:text-emerald-400">{p}P</span>}
                                {a > 0 && <span className="text-rose-600 dark:text-rose-400">{a}A</span>}
                              </>
                            );
                          })()}
                        </span>
                      )}
                      <div className="mt-1 space-y-0.5">
                        {evs.slice(0, 3).map((e, idx) => (
                          <div key={idx} className="flex items-center gap-1 rounded bg-ink/5 px-1 py-0.5 dark:bg-white/5">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[displayStatus(e.status)] || 'bg-slate-400'}`} />
                            <span className="truncate text-[10px] text-ink-soft" title={e.subjectCode ? `${e.subjectCode}` : undefined}>{subjectLabel(e)}</span>
                          </div>
                        ))}
                        {evs.length > 3 && <p className="px-1 text-[10px] text-ink-faint">+{evs.length - 3} more</p>}
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </>
          )}

          {/* Selected day details */}
          <AnimatePresence>
            {selectedDate && (
              <motion.section
                key={selectedDate}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                aria-label={`Classes on ${formatDateLong(selectedDate)}`}
              >
                <div className="mt-4 rounded-2xl border border-border bg-surface/50">
                  <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                    <div>
                      <p className="font-display text-base font-bold text-ink">{formatDateLong(selectedDate)}</p>
                      <p className="text-xs text-ink-faint">
                        {selectedEvents.length ? `${selectedEvents.length} class${selectedEvents.length === 1 ? '' : 'es'}` : 'No classes scheduled'}
                      </p>
                    </div>
                    <button
                      onClick={() => setSelectedDate(null)}
                      className="rounded-lg p-2 text-ink-faint transition hover:bg-ink/5 hover:text-ink dark:hover:bg-white/10"
                      aria-label="Close day details"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {selectedEvents.length === 0 ? (
                    <p className="px-4 py-10 text-center text-sm text-ink-faint">No classes on this day.</p>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {selectedEvents.map((e, i) => {
                        const periodRange = e.periodTo && e.periodTo !== e.period ? `${e.period}–${e.periodTo}` : String(e.period);
                        const hours = e.hours || (e.periodTo && e.periodTo !== e.period ? e.periodTo - e.period + 1 : 1);
                        return (
                          <li key={i} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="truncate font-semibold text-ink">{subjectLabel(e)}</p>
                                <span className="font-mono text-[11px] text-ink-faint">{e.subjectCode}</span>
                              </div>
                              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" /> Period {periodRange}
                                </span>
                                <span>{hours} {hours === 1 ? 'hour' : 'hours'}</span>
                              </p>
                            </div>
                            <span className={`chip shrink-0 font-semibold ${displayStatus(e.status) === 'Present' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : displayStatus(e.status) === 'Absent' ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-ink/5 text-ink-soft'}`}>
                              {displayStatus(e.status)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </Card>
      )}
    </div>
  );
}
