import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { GraduationCap, TrendingUp, RefreshCw, Award, Sparkles, ChevronDown, BookOpen } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card } from '../components/ui/Card';
import { AnimatedNumber } from '../components/ui/AnimatedNumber';
import { Badge } from '../components/ui/Badge';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { API_BASE, fetchWithTimeout } from '../lib/api';

interface GpaPageProps {
  sessionId: string;
}

interface Grade {
  semester: string;
  courseCode: string;
  courseName: string;
  academicTermPeriod: string;
  type: string;
  grade: string;
}

interface GPAData {
  success: boolean;
  currentCgpa: string;
  semesterSgpa: string | null;
  semester: string;
  grades: Grade[];
  error?: string;
}



const GRADE_POINTS: Record<string, number> = {
  'O': 10, 'A+': 9, 'A': 8, 'B+': 7, 'B': 6, 'C': 5, 'P': 4, 'F': 0, 'W': 0, 'I': 0,
};

function gradePoint(grade: string): number {
  const g = grade.trim().toUpperCase();
  if (GRADE_POINTS[g] !== undefined) return GRADE_POINTS[g];
  const num = parseFloat(g);
  return isNaN(num) ? 0 : num;
}

function gradeTone(points: number): 'success' | 'info' | 'danger' | 'violet' {
  if (points >= 8) return 'success';
  if (points >= 6) return 'violet';
  if (points >= 5) return 'info';
  return 'danger';
}

function performanceBadge(points: number): { label: string; tone: 'success' | 'info' | 'danger' } {
  if (points >= 9) return { label: 'Outstanding', tone: 'success' };
  if (points >= 8) return { label: 'Excellent', tone: 'success' };
  if (points >= 6) return { label: 'Good', tone: 'info' };
  if (points >= 5) return { label: 'Average', tone: 'info' };
  return { label: 'Needs Improvement', tone: 'danger' };
}

// Grade order for distribution bars (best first).
const GRADE_ORDER = ['O', 'A+', 'A', 'B+', 'B', 'C', 'P', 'F', 'W', 'I'];
const GRADE_BAR_COLORS: Record<string, string> = {
  O: 'from-emerald-500 to-teal-400',
  'A+': 'from-emerald-500 to-green-400',
  A: 'from-brand-500 to-accent',
  'B+': 'from-sky-500 to-cyan-400',
  B: 'from-violet-500 to-purple-400',
  C: 'from-amber-500 to-orange-400',
  P: 'from-rose-500 to-pink-400',
  F: 'from-rose-600 to-red-500',
  W: 'from-slate-400 to-slate-300',
  I: 'from-slate-400 to-slate-300',
};

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.06, duration: 0.4, ease: [0.16, 1, 0.3, 1] as const } }),
};

export function GpaPage({ sessionId }: GpaPageProps) {
  const [data, setData] = useState<GPAData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [semester, setSemester] = useState(1);
  const { error: toastError } = useToast();

  const fetchGpa = async (sem = semester) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/gpa?semester=${sem}`, { headers: { 'x-session-id': sessionId } });
      const json: GPAData = await res.json();
      if (json.success) {
        setData(json);
      } else {
        setError(json.error || 'Failed to fetch GPA data');
        toastError(json.error || 'Failed to fetch GPA data');
      }
    } catch {
      setError('Unable to connect to server');
      toastError('Unable to connect to server');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchGpa(semester); /* eslint-disable-next-line */ }, [sessionId]);

  const grades = data?.grades || [];

  const avgPoints = useMemo(() => {
    if (!grades.length) return 0;
    return grades.reduce((s, g) => s + gradePoint(g.grade), 0) / grades.length;
  }, [grades]);

  // Grade distribution (best first, only grades present).
  const distribution = useMemo(() => {
    const counts: Record<string, number> = {};
    grades.forEach((g) => { counts[g.grade] = (counts[g.grade] || 0) + 1; });
    const max = Math.max(1, ...Object.values(counts));
    return GRADE_ORDER
      .filter((g) => counts[g])
      .map((g) => ({ grade: g, count: counts[g], pct: Math.round((counts[g] / max) * 100) }));
  }, [grades]);

  const chartData = useMemo(() => {
    return grades.map((g, i) => ({ name: g.courseCode, points: gradePoint(g.grade), grade: g.grade, index: i }));
  }, [grades]);

  const insights = useMemo(() => {
    if (!grades.length) return null;
    const points = grades.map((g) => ({ ...g, points: gradePoint(g.grade) }));
    const best = points.reduce((a, b) => (b.points > a.points ? b : a));
    const worst = points.reduce((a, b) => (b.points < a.points ? b : a));
    const bestSemester = points.reduce((acc, g) => {
      acc[g.semester] = (acc[g.semester] || 0) + g.points;
      return acc;
    }, {} as Record<string, number>);
    const bestSem = Object.entries(bestSemester).sort((a, b) => b[1] - a[1])[0];
    // Trend: first half vs second half of the semester grade list.
    const mid = Math.ceil(points.length / 2);
    const firstAvg = points.slice(0, mid).reduce((s, g) => s + g.points, 0) / Math.max(1, points.slice(0, mid).length);
    const secondAvg = points.slice(mid).reduce((s, g) => s + g.points, 0) / Math.max(1, points.slice(mid).length);
    const trend = secondAvg > firstAvg ? 'up' : secondAvg < firstAvg ? 'down' : 'flat';
    return { best, worst, bestSemester: bestSem ? bestSem[0] : null, trend };
  }, [grades]);


  return (
    <div className="space-y-6">
      {/* Hero */}
      <Card className="relative overflow-hidden border-none bg-gradient-to-br from-brand-500 via-brand-600 to-accent p-6 text-white sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-24 right-32 h-48 w-48 rounded-full bg-white/5 blur-xl" aria-hidden />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-white/80">
              <Sparkles className="h-4 w-4" /> Academic Performance
            </p>
            <h2 className="mt-1 font-display text-2xl font-bold sm:text-3xl">Grade Point Average</h2>
            <p className="mt-1 text-sm text-white/80">Track your grades and semester progression</p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={semester}
              onChange={(e) => { const s = Number(e.target.value); setSemester(s); fetchGpa(s); }}
              className="w-full sm:w-auto rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold text-white backdrop-blur-sm focus:outline-none [&>option]:text-ink"
              aria-label="Select semester"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => <option key={s} value={s}>Semester {s}</option>)}
            </select>
            <button
              onClick={() => fetchGpa()}
              className="flex items-center gap-2 rounded-xl bg-white/15 px-3.5 py-2 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-white/25 touch-manipulation"
              disabled={loading}
            >
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </button>
          </div>
        </div>

        {data && (
          <div className="relative mt-6 flex flex-wrap items-center gap-6">
            <div>
              <p className="text-4xl font-bold">{data.semesterSgpa || '\u2014'}</p>
              <p className="text-xs text-white/80">Semester {data.semester} SGPA</p>
            </div>
            <div className="h-10 w-px bg-white/20" />
            <div>
              <p className="text-4xl font-bold">{data.currentCgpa || '\u2014'}</p>
              <p className="text-xs text-white/80">Current CGPA</p>
            </div>
          </div>
        )}
      </Card>

      {error && (
        <Card className="border-rose-300/50 bg-rose-500/5">
          <p className="font-medium text-rose-600 dark:text-rose-400">{error}</p>
          <button onClick={() => fetchGpa()} className="btn-secondary mt-3 text-xs">Retry</button>
        </Card>
      )}

      {loading && <Skeleton className="h-40" />}

      {!loading && !data && !error && (
        <EmptyState icon={GraduationCap} title="No GPA data" description="Select a semester and load your GPA." actionLabel="Load GPA" onAction={() => fetchGpa()} />
      )}

      {!loading && data && (
        <div className="space-y-6">
          {/* Metric cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Current CGPA', value: data.currentCgpa || '\u2014', icon: Award, color: 'text-brand-500 bg-brand-500/10' },
              { label: 'Semester SGPA', value: data.semesterSgpa || '\u2014', icon: TrendingUp, color: 'text-emerald-500 bg-emerald-500/10' },
              { label: 'Average Grade Point', value: avgPoints.toFixed(2), icon: GraduationCap, color: 'text-violet-500 bg-violet-500/10' },
              { label: 'Courses', value: grades.length, icon: BookOpen, color: 'text-amber-500 bg-amber-500/10' },
            ].map((m, i) => (
              <motion.div key={m.label} variants={fadeUp} custom={i} initial="hidden" animate="show">
                <Card className="flex items-center gap-4">
                  <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${m.color}`}>
                    <m.icon className="h-6 w-6" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-2xl font-bold text-ink">
                      {typeof m.value === 'number' ? <AnimatedNumber value={m.value} /> : m.value}
                    </p>
                    <p className="truncate text-sm text-ink-faint">{m.label}</p>
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>

          {/* Grade distribution + insights */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <h3 className="mb-1 font-display text-lg font-bold text-ink">Grade Distribution</h3>
              <p className="mb-4 text-xs text-ink-faint">Semester {data.semester} course grades</p>
              {distribution.length ? (
                <div className="space-y-3">
                  {distribution.map((d, i) => (
                    <motion.div
                      key={d.grade}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className="flex items-center gap-3"
                    >
                      <span className="w-10 shrink-0 font-mono text-sm font-bold text-ink">{d.grade}</span>
                      <div className="h-6 flex-1 overflow-hidden rounded-lg bg-ink/5 dark:bg-white/10">
                        <motion.div
                          className={`flex h-full items-center rounded-lg bg-gradient-to-r px-2 ${GRADE_BAR_COLORS[d.grade] || 'from-brand-500 to-accent'}`}
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.max(d.pct, 8)}%` }}
                          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <span className="text-[11px] font-bold text-white drop-shadow">{d.count}</span>
                        </motion.div>
                      </div>
                      <span className="w-6 shrink-0 text-right text-xs font-semibold text-ink-soft">{d.pct}%</span>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-faint">No grade data.</p>
              )}

              {/* Grade chips */}
              <div className="mt-5 flex flex-wrap gap-2">
                {grades.map((g, i) => (
                  <Badge key={`${g.courseCode}-${i}`} tone={gradeTone(gradePoint(g.grade))} className="font-mono">
                    {g.grade}
                  </Badge>
                ))}
              </div>
            </Card>

            {/* Performance insights */}
            <Card>
              <h3 className="mb-4 font-display text-lg font-bold text-ink">Performance Insights</h3>
              {insights ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border bg-surface/50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Highest Grade</p>
                    <div className="mt-1 flex items-center justify-between">
                      <p className="truncate text-sm font-semibold text-ink">{insights.best.courseName || insights.best.courseCode}</p>
                      <Badge tone="success">{insights.best.grade} ({gradePoint(insights.best.grade)})</Badge>
                    </div>
                  </div>
                  <div className="rounded-xl border border-border bg-surface/50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Lowest Grade</p>
                    <div className="mt-1 flex items-center justify-between">
                      <p className="truncate text-sm font-semibold text-ink">{insights.worst.courseName || insights.worst.courseCode}</p>
                      <Badge tone={gradeTone(gradePoint(insights.worst.grade))}>{insights.worst.grade} ({gradePoint(insights.worst.grade)})</Badge>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-border bg-surface/50 p-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Average Grade Point</p>
                      <p className="mt-0.5 text-lg font-bold text-ink">{avgPoints.toFixed(2)}</p>
                    </div>
                    <Badge tone={performanceBadge(avgPoints).tone}>{performanceBadge(avgPoints).label}</Badge>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-border bg-surface/50 p-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Courses Passed</p>
                      <p className="mt-0.5 text-lg font-bold text-ink">{grades.filter((x) => gradePoint(x.grade) > 0).length}<span className="text-sm font-medium text-ink-faint"> / {grades.length}</span></p>
                    </div>
                    <BookOpen className="h-5 w-5 text-ink-faint" />
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-border bg-surface/50 p-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Academic Trend</p>
                      <p className="mt-0.5 text-sm font-semibold text-ink">
                        {insights.trend === 'up' ? 'Improving' : insights.trend === 'down' ? 'Declining' : 'Steady'}
                      </p>
                    </div>
                    <TrendingUp className={`h-5 w-5 ${insights.trend === 'up' ? 'text-emerald-500' : insights.trend === 'down' ? 'text-rose-500' : 'text-ink-faint'}`} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-ink-faint">No data to analyze.</p>
              )}
            </Card>
          </div>

          {/* Subject grade point trend */}
          {chartData.length > 1 && (
            <Card>
              <h3 className="mb-4 font-display text-lg font-bold text-ink">Subject Grade Points</h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gpGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--ink-faint)' }} interval="preserveStartEnd" />
                    <YAxis domain={[0, 10]} tick={{ fontSize: 11, fill: 'var(--ink-faint)' }} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 12, fontSize: 12 }}
                      formatter={(v: any, _n: any, item: any) => [`${v ?? 0} points`, item?.payload?.grade || '']}
                    />
                    <Area type="monotone" dataKey="points" stroke="#6366f1" strokeWidth={2} fill="url(#gpGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          {/* Course cards */}
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="font-display text-lg font-bold text-ink">Courses</h3>
                <p className="text-xs text-ink-faint">{grades.length} course{grades.length === 1 ? '' : 's'} in semester {data.semester}</p>
              </div>
              <ChevronDown className="h-5 w-5 text-ink-faint" />
            </div>
            {grades.length ? (
              <div className="grid gap-3 sm:grid-cols-1 lg:grid-cols-2">
                {grades.map((g, i) => {
                  const points = gradePoint(g.grade);
                  return (
                    <motion.div
                      key={`${g.courseCode}-${i}`}
                      variants={fadeUp}
                      custom={i}
                      initial="hidden"
                      animate="show"
                      whileHover={{ y: -3 }}
                      transition={{ type: 'spring', stiffness: 350, damping: 26 }}
                      className="group flex items-center gap-4 rounded-2xl border border-border bg-surface/50 p-4 transition hover:border-brand-300 hover:shadow-lg hover:shadow-brand-500/5"
                    >
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/10 to-accent/10 font-mono text-sm font-bold text-brand-500">
                        {g.courseCode.slice(-2)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs font-semibold text-ink-faint">{g.courseCode}</p>
                        <p className="truncate text-sm font-semibold text-ink">{g.courseName || 'Course'}</p>
                        <p className="mt-0.5 text-[11px] text-ink-faint">{g.type || 'Regular'}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge tone={gradeTone(points)}>{g.grade}</Badge>
                        <p className="mt-1 text-xs font-semibold text-ink-soft">{points}.0</p>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-ink-faint">No grades available for this semester.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

