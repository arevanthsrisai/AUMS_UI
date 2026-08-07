import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, CalendarDays, X, Clock } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { CardSkeleton, Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useAttendanceData, fetchCourseAttendance, type CourseEvent } from '../hooks/useAttendanceData';
import { formatDateLong, monthLabel } from '../lib/utils';

type ViewMode = 'month' | 'week' | 'agenda';

interface CalendarPageProps {
  sessionId: string;
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


const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarPage({ sessionId }: CalendarPageProps) {
  const { semesters, selectedSemester, setSelectedSemester, attendance, loadingSemesters, loadingAttendance, loadAttendance } = useAttendanceData(sessionId);
  const [view, setView] = useState<ViewMode>('month');
  const [viewDate, setViewDate] = useState(() => new Date());
  const [allEvents, setAllEvents] = useState<Record<string, CourseEvent[]>>({});
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const loadAllEvents = async () => {
    const subjects = attendance?.subjects || [];
    if (!subjects.length || !selectedSemester) return;
    setLoadingEvents(true);
    try {
      const map: Record<string, CourseEvent[]> = {};
      for (const subject of subjects) {
        if (!subject.courseId) continue;
        const res = await fetchCourseAttendance(sessionId, selectedSemester, subject.courseId);
        if (res.success && res.events) {
          res.events.forEach(e => {
            (map[e.date] ||= []).push({ ...e, subjectCode: subject.courseCode, subjectName: subject.name });
          });
        }
      }
      setAllEvents(map);
    } finally {
      setLoadingEvents(false);
    }
  };

  useEffect(() => {
    loadAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (attendance?.subjects?.length) loadAllEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendance, selectedSemester]);

  const monthCells = useMemo(() => {
    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1).getDay();
    const days = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewDate]);

  const weekDays = useMemo(() => {
    const day = new Date(viewDate.getFullYear(), viewDate.getMonth(), viewDate.getDate());
    const start = new Date(day);
    start.setDate(day.getDate() - day.getDay());
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [viewDate]);

  const monthPrefix = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}-`;

  const agendaDates = useMemo(() => {
    const list = Object.keys(allEvents).sort();
    const prefix = view === 'month' ? monthPrefix : '';
    const start = view === 'week' ? weekDays[0] : null;
    const end = view === 'week' ? weekDays[6] : null;
    return list.filter(d => {
      if (prefix && !d.startsWith(prefix)) return false;
      if (start && end) {
        const t = new Date(d + 'T00:00:00');
        const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        if (t < s || t > e) return false;
      }
      return true;
    });
  }, [allEvents, view, monthPrefix, weekDays]);

  // Events for the selected day, sorted chronologically by period.
  const selectedEvents = useMemo(() => {
    if (!selectedDate) return [];
    return (allEvents[selectedDate] || []).slice().sort((a, b) => a.period - b.period);
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
          <div className="flex w-full sm:w-auto rounded-xl border border-border p-1">
            {(['month', 'week', 'agenda'] as ViewMode[]).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition ${view === v ? 'bg-brand-500 text-white shadow' : 'text-ink-soft hover:text-ink'}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {!attendance?.subjects?.length && !loadingAttendance ? (
        <EmptyState icon={CalendarDays} title="No attendance data" description="Load attendance first to populate the calendar." actionLabel="Load Attendance" onAction={() => loadAttendance()} />
      ) : (
        <Card>
          {/* Month/Week header */}
          {(view === 'month' || view === 'week') && (
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-ink">{view === 'month' ? monthLabel(viewDate) : `${formatDateLong(weekDays[0].toISOString().slice(0, 10))} – ${formatDateLong(weekDays[6].toISOString().slice(0, 10))}`}</h3>
              <div className="flex gap-2">
                <button onClick={() => navigate(-1)} className="btn-secondary p-2" aria-label="Previous"><ChevronLeft className="h-4 w-4" /></button>
                <button onClick={() => setViewDate(new Date())} className="btn-secondary text-xs">Today</button>
                <button onClick={() => navigate(1)} className="btn-secondary p-2" aria-label="Next"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}

          {loadingEvents ? (
            <Skeleton className="h-72" />
          ) : view === 'month' ? (
            <>
              <div className="grid grid-cols-7 border-b border-border bg-surface/60">
                {WEEKDAYS.map(d => <div key={d} className="py-2 text-center text-xs font-semibold text-ink-faint">{d}</div>)}
              </div>
              <div className="grid grid-cols-7">
                {monthCells.map((day, i) => {
                  if (day === null) return <div key={`e${i}`} className="min-h-20 border-b border-r border-border/60 sm:min-h-24" />;
                  const iso = `${monthPrefix}${String(day).padStart(2, '0')}`;
                  const evs = allEvents[iso] || [];
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
          ) : view === 'week' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
              {weekDays.map(d => {
                const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                const evs = allEvents[iso] || [];
                const isToday = d.toDateString() === new Date().toDateString();
                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => setSelectedDate(selectedDate === iso ? null : iso)}
                    aria-label={formatDateLong(iso)}
                    aria-pressed={selectedDate === iso}
                    className={`rounded-xl border p-3 text-left transition touch-manipulation ${isToday ? 'border-brand-400 bg-brand-500/5' : 'border-border'} ${selectedDate === iso ? 'ring-2 ring-inset ring-brand-400 bg-brand-500/10' : 'hover:bg-ink/5 dark:hover:bg-white/5'}`}
                  >
                    <p className={`text-xs font-bold ${isToday ? 'text-brand-500' : 'text-ink-soft'}`}>{d.toLocaleDateString('en-IN', { weekday: 'short' })}</p>
                    <p className="text-lg font-bold text-ink">{d.getDate()}</p>
                    <div className="mt-2 space-y-1">
                      {evs.length === 0 && <p className="text-[10px] text-ink-faint">—</p>}
                      {evs.map((e, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px] text-ink-soft">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[displayStatus(e.status)] || 'bg-slate-400'}`} />
                          <span className="truncate" title={e.subjectCode ? `${e.subjectCode}` : undefined}>{subjectLabel(e)}</span>
                        </div>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {agendaDates.length === 0 && <p className="py-10 text-center text-sm text-ink-faint">No records for this period.</p>}
              {agendaDates.map(iso => (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setSelectedDate(selectedDate === iso ? null : iso)}
                  aria-pressed={selectedDate === iso}
                  className={`flex w-full flex-col gap-1 py-3 text-left transition sm:flex-row sm:items-center sm:gap-4 touch-manipulation ${selectedDate === iso ? 'rounded-xl bg-brand-500/10 px-3 ring-1 ring-inset ring-brand-400' : 'hover:bg-ink/5 dark:hover:bg-white/5'}`}
                >
                  <p className="w-40 shrink-0 text-sm font-semibold text-ink">{formatDateLong(iso)}</p>
                  <div className="flex flex-wrap gap-2">
                    {allEvents[iso].map((e, i) => (
                      <span key={i} className="chip border border-border bg-surface/60">
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[displayStatus(e.status)] || 'bg-slate-400'}`} />
                        {subjectLabel(e)} · P{e.period} · <span className="font-semibold">{displayStatus(e.status)}</span>
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
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
