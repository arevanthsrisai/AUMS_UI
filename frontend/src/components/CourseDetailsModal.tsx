import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, ChevronLeft, ChevronRight, Search, Filter, RotateCcw, CalendarDays } from 'lucide-react';
import { fetchCourseAttendance, type AttendanceSubject, type CourseEvent } from '../hooks/useAttendanceData';
import { formatDateLong, monthLabel } from '../lib/utils';

interface CourseDetailsModalProps {
  sessionId: string;
  semesterId: string;
  subject: AttendanceSubject;
  onClose: () => void;
  onSessionExpired?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  Present: 'bg-emerald-500',
  Absent: 'bg-rose-500',
  OD: 'bg-emerald-500',
  ML: 'bg-violet-500',
  Holiday: 'bg-slate-300',
  Cancelled: 'bg-slate-400',
};

const STATUS_TEXT: Record<string, string> = {
  Present: 'text-emerald-600 dark:text-emerald-400',
  Absent: 'text-rose-600 dark:text-rose-400',
  OD: 'text-emerald-600 dark:text-emerald-400',
  ML: 'text-violet-600 dark:text-violet-400',
  Holiday: 'text-slate-500',
  Cancelled: 'text-slate-500',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CourseDetailsModal({ sessionId, semesterId, subject, onClose, onSessionExpired }: CourseDetailsModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<CourseEvent[]>([]);
  const [stats, setStats] = useState<{ total: number; present: number; absent: number; od: number; percentage: number } | null>(null);
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  const loadedRef = useRef(false);

  const load = async () => {
    // Guard: React 18 StrictMode double-invokes effects in dev, which would
    // otherwise fire the course report request twice against AUMS.
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    setError(null);
    if (!semesterId) {
      setError('No semester selected. Load attendance for a semester first.');
      setLoading(false);
      return;
    }
    try {
      const res = await fetchCourseAttendance(sessionId, semesterId, subject.courseId || subject.courseCode);
      if (res.sessionExpired) {
        onSessionExpired?.();
        return;
      }
      if (res.success) {
        setEvents(res.events || []);
        setStats(res.stats || null);
        if (res.events?.length) {
          const [y, m] = res.events[0].date.split('-').map(Number);
          setViewDate(new Date(y, m - 1, 1));
        }
      } else {
        setError(res.error || 'Failed to load course attendance');
      }
    } catch {
      setError('Unable to connect to server');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, semesterId, subject.courseId, subject.courseCode]);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = original; window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const eventsByDate = useMemo(() => {
    const map: Record<string, CourseEvent[]> = {};
    events.forEach(e => { (map[e.date] ||= []).push(e); });
    return map;
  }, [events]);

  const calendarCells = useMemo(() => {
    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1).getDay();
    const days = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewDate]);

  const monthPrefix = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}-`;
  const monthEvents = events.filter(e => e.date.startsWith(monthPrefix));
  const monthStats = useMemo(() => {
    const hoursOf = (e: CourseEvent) => e.hours || ((e.periodTo ?? e.period) - e.period + 1);
    const present = monthEvents.filter(e => e.status === 'Present' || e.status === 'OD').reduce((s, e) => s + hoursOf(e), 0);
    const absent = monthEvents.filter(e => e.status === 'Absent').reduce((s, e) => s + hoursOf(e), 0);
    const od = monthEvents.filter(e => e.status === 'OD').reduce((s, e) => s + hoursOf(e), 0);
    const total = present + absent;
    return { present, absent, od, total, percentage: total ? Math.round((present / total) * 1000) / 10 : 0 };
  }, [monthEvents]);

  const filteredEvents = useMemo(() => {
    let list = events;
    if (statusFilter !== 'all') list = list.filter(e => e.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(e => e.date.includes(q) || formatDateLong(e.date).toLowerCase().includes(q));
    }
    return list;
  }, [events, statusFilter, search]);

  const statuses = useMemo(() => Array.from(new Set(events.map(e => e.status))), [events]);
  const selectedEvents = selectedDate ? eventsByDate[selectedDate] || [] : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${subject.courseCode} daily attendance`}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[92vw] sm:max-w-3xl flex-col overflow-hidden rounded-3xl border border-border bg-surface-raised shadow-2xl"
      >
        {/* Header */}
        <div className="border-b border-border bg-gradient-to-r from-brand-500/10 to-accent/10 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-brand-500">{subject.courseCode}</p>
              <h2 className="mt-0.5 font-display text-xl font-bold text-ink">{subject.name}</h2>
              <p className="mt-1 text-sm text-ink-faint">
                {stats ? `${stats.percentage}% · ${stats.present} present · ${stats.absent} absent` : 'Loading…'}
              </p>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-ink-faint transition hover:bg-ink/5 hover:text-ink dark:hover:bg-white/10" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="skeleton h-20 rounded-2xl" />
                ))}
              </div>
              <div className="skeleton h-72 rounded-2xl" />
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500">
                <CalendarDays className="h-7 w-7" />
              </div>
              <div>
                <h3 className="font-semibold text-ink">Could not load course attendance</h3>
                <p className="mt-1 text-sm text-ink-faint">{error}</p>
              </div>
              <div className="flex gap-3">
                <button onClick={load} className="btn-primary"><RotateCcw className="h-4 w-4" /> Retry</button>
                <button onClick={onClose} className="btn-secondary">Close</button>
              </div>
            </div>
          )}

          {!loading && !error && (
            <div className="space-y-6">
              {/* Stats */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Total Classes', value: stats?.total ?? 0, tone: 'text-ink' },
                  { label: 'Present', value: stats?.present ?? 0, tone: 'text-emerald-500' },
                  { label: 'Absent', value: stats?.absent ?? 0, tone: 'text-rose-500' },
                  { label: 'Attendance', value: `${stats?.percentage ?? 0}%`, tone: 'text-brand-500' },
                ].map((s) => (
                  <div key={s.label} className="rounded-2xl border border-border bg-surface/50 p-4 text-center">
                    <p className={`text-2xl font-bold ${s.tone}`}>{s.value}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Month nav + summary */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-display text-lg font-bold text-ink">{monthLabel(viewDate)}</h3>
                  <p className="text-xs text-ink-faint">
                    {monthStats.total} classes · {monthStats.present} present · {monthStats.absent} absent · {monthStats.percentage}%
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))} className="btn-secondary p-2" aria-label="Previous month">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))} className="btn-secondary p-2" aria-label="Next month">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Calendar */}
              <div className="overflow-hidden rounded-2xl border border-border">
                <div className="grid grid-cols-7 border-b border-border bg-surface/60 overflow-x-auto">
                  {WEEKDAYS.map(d => (
                    <div key={d} className="py-2 text-center text-xs font-semibold text-ink-faint">{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7">
                  {calendarCells.map((day, i) => {
                    if (day === null) return <div key={`e${i}`} className="h-12 border-b border-r border-border/60 sm:h-14" />;
                    const iso = `${monthPrefix}${String(day).padStart(2, '0')}`;
                    const dayEvents = eventsByDate[iso] || [];
                    const isToday = new Date().toDateString() === new Date(viewDate.getFullYear(), viewDate.getMonth(), day).toDateString();
                    const isSelected = selectedDate === iso;
                    return (
                      <button
                        key={iso}
                        onClick={() => setSelectedDate(isSelected ? null : iso)}
                        className={`flex h-12 flex-col items-center justify-center gap-1 border-b border-r border-border/60 transition sm:h-14 ${isSelected ? 'bg-brand-500/10 ring-2 ring-inset ring-brand-400' : 'hover:bg-ink/5 dark:hover:bg-white/5'}`}
                        aria-label={formatDateLong(iso)}
                      >
                        <span className={`text-sm ${isToday ? 'font-bold text-brand-500' : 'text-ink-soft'}`}>{day}</span>
                        <span className="flex gap-0.5">
                          {dayEvents.slice(0, 3).map((e, idx) => (
                            <span key={idx} className={`h-1.5 w-1.5 rounded-full ${STATUS_COLORS[e.status] || 'bg-slate-400'}`} />
                          ))}
                          {dayEvents.length === 0 && <span className="h-1.5 w-1.5 rounded-full bg-transparent" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Legend */}
              <div className="flex flex-wrap gap-3 text-xs text-ink-soft">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Present</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" /> Absent</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> OD (as Present)</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-300" /> No class</span>
              </div>

              {/* Selected day */}
              <AnimatePresence>
                {selectedDate && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-2xl border border-brand-300/40 bg-brand-500/5 p-4">
                      <p className="font-semibold text-ink">{formatDateLong(selectedDate)}</p>
                      {selectedEvents.length === 0 ? (
                        <p className="mt-1 text-sm text-ink-faint">No classes recorded.</p>
                      ) : (
                        <ul className="mt-2 space-y-1.5">
                          {selectedEvents.map((e, i) => (
                            <li key={i} className="flex items-center justify-between text-sm">
                              <span className="text-ink-soft">
                                Period {e.period}{e.periodTo && e.periodTo !== e.period ? `–${e.periodTo}` : ''}
                                {e.hours ? ` · ${e.hours}h` : ''}
                              </span>
                              <span className={`font-semibold ${STATUS_TEXT[e.status] || 'text-ink-soft'}`}>{e.status === 'OD' ? 'Present' : e.status}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Search + filter */}
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by date…"
                    className="input pl-9"
                    aria-label="Search by date"
                  />
                </div>
                <div className="relative">
                  <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="input pl-9 sm:w-44"
                    aria-label="Filter by status"
                  >
                    <option value="all">All statuses</option>
                    {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              {/* Filtered list */}
              <div className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-2xl border border-border">
                {filteredEvents.length === 0 ? (
                  <p className="p-6 text-center text-sm text-ink-faint">No matching records.</p>
                ) : (
                  filteredEvents.map((e, i) => (
                    <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <span className="text-ink-soft">{formatDateLong(e.date)}</span>
                      <span className="text-ink-faint">Period {e.period}{e.periodTo && e.periodTo !== e.period ? `–${e.periodTo}` : ''}</span>
                      <span className={`font-semibold ${STATUS_TEXT[e.status] || 'text-ink-soft'}`}>{e.status === 'OD' ? 'Present' : e.status}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
