import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { CalendarDays, ChevronRight, RefreshCw } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { ProgressRing } from '../components/ui/ProgressRing';
import { Badge } from '../components/ui/Badge';
import { CardSkeleton, Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useAttendanceData, type AttendanceSubject } from '../hooks/useAttendanceData';

interface AttendancePageProps {
  sessionId: string;
  onOpenSubject: (subject: AttendanceSubject, semesterId?: string) => void;
  preferredSemester?: number;
}

export function AttendancePage({ sessionId, onOpenSubject, preferredSemester }: AttendancePageProps) {
  const {
    semesters, selectedSemester, setSelectedSemester,
    attendance, loadingSemesters, loadingAttendance, error, setError, loadAttendance,
  } = useAttendanceData(sessionId, preferredSemester);
  const [search, setSearch] = useState('');

  const subjects = useMemo(() => {
    const list = attendance?.subjects || [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(s => s.courseCode.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [attendance, search]);

  const overall = useMemo(() => {
    const list = attendance?.subjects || [];
    if (!list.length) return 0;
    const attended = list.reduce((s, x) => s + (x.attendedClasses || 0), 0);
    const total = list.reduce((s, x) => s + (x.totalClasses || 0), 0);
    return total ? Math.round((attended / total) * 1000) / 10 : 0;
  }, [attendance]);

  if (loadingSemesters) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24" />
        <CardSkeleton count={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header card */}
      <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl font-bold text-ink">Attendance Summary</h2>
          <p className="text-sm text-ink-faint">Select a semester and view subject-wise attendance</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedSemester}
            onChange={(e) => setSelectedSemester(e.target.value)}
            className="input w-44"
            aria-label="Select semester"
            disabled={loadingAttendance}
          >
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>Semester {s.name}</option>
            ))}
          </select>
          <button onClick={() => loadAttendance()} className="btn-primary" disabled={loadingAttendance || !selectedSemester}>
            {loadingAttendance ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
            {loadingAttendance ? 'Loading…' : 'Load Attendance'}
          </button>
        </div>
      </Card>

      {error && (
        <Card className="border-rose-300/50 bg-rose-500/5">
          <p className="font-medium text-rose-600 dark:text-rose-400">{error}</p>
          <button onClick={() => { setError(null); loadAttendance(); }} className="btn-secondary mt-3 text-xs">Retry</button>
        </Card>
      )}

      {loadingAttendance ? (
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
          {/* Overall bar */}
          <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <ProgressRing value={overall} size={80} stroke={8} label="Overall" />
            <div className="flex-1">
              <h3 className="font-display text-lg font-bold text-ink">Overall Attendance</h3>
              <p className="text-sm text-ink-faint">
                {attendance.subjects.reduce((s, x) => s + (x.attendedClasses || 0), 0)} / {attendance.subjects.reduce((s, x) => s + (x.totalClasses || 0), 0)} classes attended
              </p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink/5 dark:bg-white/10">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, overall)}%` }}
                  transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
            </div>
          </Card>

          {/* Search */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subjects…"
            className="input"
            aria-label="Search subjects"
          />

          {/* Subject cards */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {subjects.map((subject, i) => (
              <motion.div
                key={subject.courseCode}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              >
                <Card
                  interactive
                  onClick={() => onOpenSubject(subject, selectedSemester)}
                  className="group h-full touch-manipulation"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-brand-500">{subject.courseCode}</p>
                      <h3 className="mt-1 truncate font-semibold text-ink">{subject.name}</h3>
                    </div>
                    <ProgressRing value={subject.attendance} size={56} stroke={5} label={subject.courseCode} />
                  </div>

                  <div className="mt-4 flex items-center justify-between">
                    <div className="flex gap-2">
                      <Badge tone={subject.attendance >= 75 ? 'success' : subject.attendance >= 65 ? 'warning' : 'danger'}>
                        {subject.attendance >= 75 ? 'Good' : subject.attendance >= 65 ? 'At Risk' : 'Low'}
                      </Badge>
                      <Badge tone="neutral">{subject.attendedClasses}/{subject.totalClasses}</Badge>
                    </div>
                    <ChevronRight className="h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500" />
                  </div>

                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/5 dark:bg-white/10">
                    <div
                      className={`h-full rounded-full ${subject.attendance >= 75 ? 'bg-emerald-500' : subject.attendance >= 65 ? 'bg-amber-500' : 'bg-rose-500'}`}
                      style={{ width: `${Math.min(100, subject.attendance)}%` }}
                    />
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>

          {subjects.length === 0 && (
            <EmptyState icon={CalendarDays} title="No matching subjects" description="Try a different search term." />
          )}
        </>
      )}
    </div>
  );
}
