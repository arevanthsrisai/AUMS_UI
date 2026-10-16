import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ClipboardList, RefreshCw, BookOpen, CheckCircle2, Clock, FileSpreadsheet } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { API_BASE, fetchWithTimeout, isSessionExpired } from '../lib/api';

interface MarksPageProps {
  sessionId: string;
  onSessionExpired?: () => void;
  /** Current semester (computed from batch) — the page opens on it so the
   *  most recent assessments show first. */
  preferredSemester?: number;
}

interface ExamRow {
  name: string;
  period: string;
  type: string;
  marks: Record<string, number | 'NP' | null>;
}

interface MarksData {
  success: boolean;
  semester: string;
  semesters?: { id: string; name: string }[];
  courses: string[];
  exams: ExamRow[];
  error?: string;
  code?: string;
}

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.06, duration: 0.4, ease: [0.16, 1, 0.3, 1] as const } }),
};

function cellTone(value: number | 'NP' | null): 'success' | 'info' | 'violet' | 'danger' | 'neutral' {
  if (value === null || value === undefined) return 'neutral';
  if (value === 'NP') return 'danger';
  return 'violet';
}

export function MarksPage({ sessionId, onSessionExpired, preferredSemester }: MarksPageProps) {
  const [data, setData] = useState<MarksData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [semester, setSemester] = useState(preferredSemester ?? 1);
  const { error: toastError } = useToast();
  // Track a manual semester choice so the late-arriving profile's current
  // semester doesn't yank the page away from what the user picked.
  const userPickedRef = useRef(false);
  // Monotonic run id: only the latest request may write state, so a slow
  // response for a previously selected semester can't overwrite the current
  // selection (and the spinner flag is only cleared by its own run).
  const fetchSeqRef = useRef(0);

  const fetchMarks = async (sem = semester) => {
    const runId = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/marks?semester=${sem}`, { headers: { 'x-session-id': sessionId } });
      const json: MarksData = await res.json();
      if (runId !== fetchSeqRef.current) return;
      if (json.success) {
        setData(json);
      } else if (isSessionExpired(json.code)) {
        toastError('Your session expired. Please sign in again.');
        onSessionExpired?.();
      } else {
        setError(json.error || 'Failed to fetch marks');
        toastError(json.error || 'Failed to fetch marks');
      }
    } catch {
      if (runId !== fetchSeqRef.current) return;
      setError('Unable to connect to server');
      toastError('Unable to connect to server');
    } finally {
      if (runId === fetchSeqRef.current) setLoading(false);
    }
  };

  // Initial load (session only — mount fetch with the opening semester).
  useEffect(() => { fetchMarks(semester); /* eslint-disable-next-line */ }, [sessionId]);

  // Profile resolves after mount; open on the student's current semester once.
  useEffect(() => {
    if (!preferredSemester || userPickedRef.current) return;
    if (preferredSemester !== semester) {
      setSemester(preferredSemester);
      fetchMarks(preferredSemester);
    }
    /* eslint-disable-next-line */ }, [preferredSemester]);

  const courses = data?.courses ?? [];
  const exams = data?.exams ?? [];

  const stats = useMemo(() => {
    let published = 0;
    let pending = 0;
    exams.forEach((e) => courses.forEach((c) => {
      const v = e.marks?.[c];
      if (v === null || v === undefined) return;
      if (v === 'NP') pending += 1;
      else published += 1;
    }));
    return { published, pending };
  }, [exams, courses]);

  return (
    <div className="space-y-6" data-testid="marks-page">
      {/* Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold text-ink">Published Marks</h2>
          <p className="mt-0.5 text-sm text-ink-soft">Assessment marks released by the institution</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={semester}
            onChange={(e) => {
              const s = Number(e.target.value);
              userPickedRef.current = true;
              setSemester(s);
              fetchMarks(s);
            }}
            className="input sm:w-40"
            aria-label="Select semester"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => <option key={s} value={s}>Semester {s}</option>)}
          </select>
          <button onClick={() => fetchMarks()} className="btn-secondary" disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </header>

      {/* A semester the student doesn't have (or one without published data)
          falls back server-side — say so instead of silently mislabeling.
          Only after the load settles, so a mid-flight selection switch never
          shows a misleading fallback banner. */}
      {!loading && data && Number(data.semester) !== semester && (
        <Card className="border-amber-300/50 bg-amber-500/5">
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Semester {semester} has no published marks — showing Semester {data.semester} instead.
          </p>
        </Card>
      )}

      {error && (
        <Card className="border-rose-300/50 bg-rose-500/5">
          <p className="font-medium text-rose-600 dark:text-rose-400">{error}</p>
          <button onClick={() => fetchMarks()} className="btn-secondary mt-3 text-xs">Retry</button>
        </Card>
      )}

      {/* Keep the matrix on screen while refreshing — a skeleton should only
          appear when there is nothing at all to show yet. */}
      {loading && !data && <Skeleton className="h-40" />}

      {!loading && !data && !error && (
        <EmptyState
          icon={FileSpreadsheet}
          title="No marks data"
          description="Load your published assessment marks for this semester."
          actionLabel="Load marks"
          onAction={() => fetchMarks()}
        />
      )}

      {data && (
        <div className="space-y-6">
          {/* Metric cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Assessments', value: exams.length, icon: ClipboardList, color: 'text-brand-500 bg-brand-500/10' },
              { label: 'Courses', value: courses.length, icon: BookOpen, color: 'text-emerald-500 bg-emerald-500/10' },
              { label: 'Marks Published', value: stats.published, icon: CheckCircle2, color: 'text-violet-500 bg-violet-500/10' },
              { label: 'Awaiting Result', value: stats.pending, icon: Clock, color: 'text-amber-500 bg-amber-500/10' },
            ].map((m, i) => (
              <motion.div key={m.label} variants={fadeUp} custom={i} initial="hidden" animate="show">
                <Card className="flex items-center gap-4">
                  <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${m.color}`}>
                    <m.icon className="h-6 w-6" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-2xl font-bold text-ink">{m.value}</p>
                    <p className="truncate text-sm text-ink-faint">{m.label}</p>
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>

          {/* Marks matrix */}
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="font-display text-lg font-bold text-ink">Assessment Matrix</h3>
                <p className="text-xs text-ink-faint">
                  Semester {data.semester} · {exams.length} assessment{exams.length === 1 ? '' : 's'} × {courses.length} course{courses.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="hidden items-center gap-2 sm:flex">
                <Badge tone="violet">Mark</Badge>
                <Badge tone="danger">NP — not published</Badge>
                <Badge tone="info">— n/a</Badge>
              </div>
            </div>

            {exams.length && courses.length ? (
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="marks-table">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="py-2.5 pr-3 font-semibold text-ink-soft" scope="col">Assessment</th>
                      <th className="py-2.5 pr-3 font-semibold text-ink-soft" scope="col">Period</th>
                      <th className="py-2.5 pr-3 font-semibold text-ink-soft" scope="col">Type</th>
                      {courses.map((c) => (
                        <th key={c} className="py-2.5 pl-3 text-center font-mono text-[11px] font-bold text-ink-faint" scope="col">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {exams.map((exam, ei) => (
                      <motion.tr
                        key={`${exam.name}-${ei}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: Math.min(ei * 0.04, 0.4) }}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="py-2.5 pr-3 font-medium text-ink">{exam.name}</td>
                        <td className="py-2.5 pr-3 text-xs text-ink-soft">{exam.period || '—'}</td>
                        <td className="py-2.5 pr-3 text-xs text-ink-soft">{exam.type || '—'}</td>
                        {courses.map((c) => {
                          const v = exam.marks?.[c] ?? null;
                          return (
                            <td key={c} className="py-2.5 pl-3 text-center">
                              {v === null ? (
                                <span className="text-ink-faint">—</span>
                              ) : v === 'NP' ? (
                                <span className="inline-flex items-center rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[11px] font-bold text-rose-500">NP</span>
                              ) : (
                                <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-xs font-bold ${
                                  cellTone(v) === 'violet' ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'bg-ink/5 dark:bg-white/10 text-ink'
                                }`}>
                                  {v}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-ink-faint">No marks published for this semester yet.</p>
            )}

            <p className="mt-4 text-[11px] text-ink-faint">
              Values appear exactly as published by AUMS. NP means the result has not been released yet.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
