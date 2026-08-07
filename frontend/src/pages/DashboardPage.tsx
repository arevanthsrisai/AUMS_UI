import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, CalendarDays, GraduationCap, TrendingUp, BookOpen, Sparkles, Award, BarChart3 } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { AnimatedNumber } from '../components/ui/AnimatedNumber';
import { Badge } from '../components/ui/Badge';
import type { NavKey } from '../components/layout/Sidebar';
import type { StudentProfile, GpaSummaryData, ProfileStatus } from '../App';
import { useCurrentSemester } from '../hooks/useCurrentSemester';
import { decodeRollNumber } from '../lib/rollNumber';

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

export function DashboardPage({ profile, profileStatus, onRetryProfile, gpaSummary, onNavigate }: DashboardPageProps) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const grades = gpaSummary?.grades || [];
  const courseCount = grades.length;
  // SGPA of the semester currently shown in this section. gpaSummary.sgpa is
  // populated from the existing /gpa response (no extra requests); it tracks
  // whichever semester the app fetched, so the card updates automatically.
  const semesterSgpa = useMemo(() => {
    if (gpaSummary?.sgpa === undefined || gpaSummary.sgpa === null || gpaSummary.sgpa === '') return null;
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

  const { semester: currentSemester, isManual: semesterIsManual, setSemester: setCurrentSemester, resetSemester: resetCurrentSemester } = useCurrentSemester(profile?.batch);
  const rollInfo = decodeRollNumber(profile?.rollNumber);
  const [semesterEditorOpen, setSemesterEditorOpen] = useState(false);
  const latestSemester = currentSemester ? String(currentSemester) : '—';
  const latestGrades = grades.slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Welcome card */}
      <motion.div variants={stagger} custom={0} initial="hidden" animate="show">
        <Card className="relative overflow-hidden border-none bg-gradient-to-br from-brand-500 via-brand-600 to-accent p-6 text-white sm:p-8">
          <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" aria-hidden />
          <div className="pointer-events-none absolute -bottom-24 right-32 h-48 w-48 rounded-full bg-white/5 blur-xl" aria-hidden />
          <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-white/80">
                <Sparkles className="h-4 w-4" /> {greeting}
              </p>
              {profileStatus === 'loading' && !profile ? (
  <div className="mt-2 space-y-2" aria-label="Loading profile">
    <div className="h-7 w-56 animate-pulse rounded-lg bg-white/20" />
    <div className="h-4 w-72 animate-pulse rounded bg-white/15" />
  </div>
) : (
  <>
    <h2 className="mt-1 font-display text-2xl font-bold sm:text-3xl">{profile?.name || 'Student'}</h2>
    <p className="mt-1 text-sm text-white/80">
      {profile?.rollNumber ? `${profile.rollNumber} • ` : ''}
      {rollInfo?.branch || profile?.branch || 'Amrita University'}
    </p>
  </>
)}
            </div>
            <div className="flex items-center gap-5 rounded-2xl bg-white/10 px-6 py-4 backdrop-blur-sm">
              <div className="text-center">
                <p className="text-3xl font-bold">{gpaSummary?.cgpa || '—'}</p>
                <p className="text-xs text-white/80">CGPA</p>
              </div>
              <div className="h-10 w-px bg-white/20" />
              <div className="text-center">
                <p className="text-3xl font-bold">{gpaSummary?.sgpa || '—'}</p>
                <p className="text-xs text-white/80">Latest SGPA</p>
              </div>
              <div className="h-10 w-px bg-white/20" />
              <div className="text-center">
                {semesterEditorOpen ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={String(currentSemester ?? 1)}
                      onChange={(e) => setCurrentSemester(Number(e.target.value))}
                      className="rounded-lg border border-white/30 bg-white/15 px-2 py-1 text-sm font-bold text-white focus:outline-none [&>option]:text-ink"
                      aria-label="Current semester"
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                        <option key={s} value={s}>Sem {s}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => { resetCurrentSemester(); setSemesterEditorOpen(false); }}
                      className="rounded-lg bg-white/15 px-2 py-1 text-xs font-semibold text-white transition hover:bg-white/25"
                      title="Auto-compute from joining year"
                    >
                      Auto
                    </button>
                    <button
                      onClick={() => setSemesterEditorOpen(false)}
                      className="rounded-lg bg-white/15 px-2 py-1 text-xs font-semibold text-white transition hover:bg-white/25"
                      aria-label="Close semester editor"
                    >
                      ✓
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setSemesterEditorOpen(true)}
                    className="group cursor-pointer"
                    title={semesterIsManual ? 'Manual semester — click to change' : 'Auto-computed from joining year — click to change'}
                  >
                    <p className="text-3xl font-bold transition group-hover:opacity-80">{latestSemester}</p>
                    <p className="text-xs text-white/80">Semester{semesterIsManual ? ' (manual)' : ' (auto)'}</p>
                  </button>
                )}
              </div>
            </div>
          </div>
        </Card>
      </motion.div>

      {profileStatus === 'error' && (
        <motion.div variants={stagger} custom={1} initial="hidden" animate="show">
          <Card className="flex flex-col gap-3 border-amber-300/50 bg-amber-500/5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Profile could not be loaded</p>
                <p className="text-xs text-ink-faint">AUMS did not return a valid profile. You can retry — your other data is unaffected.</p>
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

      {/* Student profile card */}
      <motion.div variants={stagger} custom={1} initial="hidden" animate="show">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:gap-6 sm:p-6">
            <div className="flex items-center gap-4 sm:flex-col sm:items-start">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-brand-500 to-accent font-display text-2xl font-bold text-white shadow-lg shadow-brand-500/30">
                {profile?.photo ? (
                  <img src={profile.photo} alt={profile.name || 'Student'} className="h-full w-full object-cover" />
                ) : (
                  (profile?.name || 'S').trim().charAt(0).toUpperCase()
                )}
              </div>
              <div>
                <p className="font-display text-xl font-bold text-ink">{profile?.name || 'N/A'}</p>
                <p className="text-sm text-ink-faint">
                  {profile?.rollNumber || 'N/A'}{rollInfo?.branch ? ' • ' + rollInfo.branch : profile?.branch ? ' • ' + profile.branch : ''}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {[
                { label: 'Roll No', value: profile?.rollNumber },
                { label: 'Registration No', value: profile?.registrationNumber },
                { label: 'Programme', value: profile?.programme },
                { label: 'Branch', value: rollInfo?.branch || profile?.branch },
                { label: 'Semester', value: currentSemester ? String(currentSemester) : 'N/A' },
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

            <div className="flex shrink-0 items-center gap-4 rounded-2xl border border-border bg-surface/60 px-4 py-3">
              <div className="text-center">
                <p className="text-xl font-bold text-ink">{gpaSummary?.cgpa || '—'}</p>
                <p className="text-[11px] text-ink-faint">CGPA</p>
              </div>
              <div className="h-8 w-px bg-border" />
              <div className="text-center">
                <p className="text-xl font-bold text-ink">{gpaSummary?.sgpa || '—'}</p>
                <p className="text-[11px] text-ink-faint">SGPA</p>
              </div>
            </div>
          </div>
        </Card>
      </motion.div>

      {/* Quick stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: 'Current CGPA',
            value: gpaSummary?.cgpa || '—',
            icon: Award,
            color: 'text-brand-500 bg-brand-500/10',
            onClick: () => onNavigate('gpa'),
          },
          {
            label: 'Latest SGPA',
            value: gpaSummary?.sgpa || '—',
            icon: TrendingUp,
            color: 'text-emerald-500 bg-emerald-500/10',
            onClick: () => onNavigate('gpa'),
          },
          {
            label: 'Courses',
            value: courseCount,
            icon: BookOpen,
            color: 'text-amber-500 bg-amber-500/10',
            onClick: () => onNavigate('attendance'),
          },
          {
            label: 'Current Semester',
            value: latestSemester,
            icon: GraduationCap,
            color: 'text-violet-500 bg-violet-500/10',
          },
        ].map((stat, i) => (
          <motion.div key={stat.label} variants={stagger} custom={i + 1} initial="hidden" animate="show">
            <Card interactive={!!stat.onClick} onClick={stat.onClick} className="flex items-center gap-4">
              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${stat.color}`}>
                <stat.icon className="h-6 w-6" />
              </div>
              <div>
                <p className="text-2xl font-bold text-ink">
                  {typeof stat.value === 'number' ? <AnimatedNumber value={stat.value} /> : stat.value}
                </p>
                <p className="text-sm text-ink-faint">{stat.label}</p>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* GPA overview + quick actions */}
      <div className="grid gap-6 lg:grid-cols-3">
        <motion.div variants={stagger} custom={5} initial="hidden" animate="show" className="lg:col-span-2">
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-display text-lg font-bold text-ink">Academic Performance</h3>
                <p className="text-sm text-ink-faint">CGPA {gpaSummary?.cgpa || '—'} • Semester {gpaSummary?.semester || latestSemester}</p>
              </div>
              <button onClick={() => onNavigate('gpa')} className="btn-secondary px-3 py-1.5 text-xs">
                View all <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {!grades.length ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <BarChart3 className="h-10 w-10 text-ink-faint" />
                <p className="text-sm text-ink-soft">No GPA data yet.</p>
                <button onClick={() => onNavigate('gpa')} className="btn-primary text-xs">Open GPA</button>
              </div>
            ) : (
              <>
                {/* Grade distribution bars */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">Grade Distribution</p>
                    <div className="space-y-2">
                      {gradeBars.map((b) => (
                        <div key={b.label} className="flex items-center gap-3">
                          <span className="w-14 shrink-0 text-xs text-ink-soft">{b.label}</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/5 dark:bg-white/10">
                            <motion.div
                              className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent"
                              initial={{ width: 0 }}
                              animate={{ width: `${(b.value / Math.max(1, grades.length)) * 100}%` }}
                              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                            />
                          </div>
                          <span className="w-5 text-right text-xs font-semibold text-ink-soft">{b.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                      Semester {gpaSummary?.semester || latestSemester} SGPA
                    </p>
                    <div className="flex min-h-[90px] items-center gap-4 rounded-2xl border border-border bg-surface/60 p-4">
                      <div className="text-3xl font-bold text-ink">
                        {semesterSgpa !== null ? <AnimatedNumber value={semesterSgpa} decimals={2} /> : '—'}
                      </div>
                      <p className="text-sm text-ink-soft">across {courseCount} course{courseCount === 1 ? '' : 's'}</p>
                    </div>
                  </div>
                </div>

                {/* Latest grades */}
                <div className="space-y-2">
                  {latestGrades.map((g) => (
                    <div
                      key={g.courseCode}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/60 px-3.5 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-semibold text-ink">{g.courseCode}</p>
                        <p className="truncate text-xs text-ink-soft">{g.courseName}</p>
                      </div>
                      <Badge tone={gradeTone(gradePoint(g.grade))}>{g.grade}</Badge>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </motion.div>

        {/* Quick actions */}
        <motion.div variants={stagger} custom={6} initial="hidden" animate="show" className="space-y-4">
          <Card>
            <h3 className="mb-3 font-display text-lg font-bold text-ink">Quick Actions</h3>
            <div className="space-y-2">
              <button onClick={() => onNavigate('attendance')} className="btn-secondary w-full justify-start">
                <CalendarDays className="h-4 w-4 text-brand-500" /> View Attendance
              </button>
              <button onClick={() => onNavigate('gpa')} className="btn-secondary w-full justify-start">
                <GraduationCap className="h-4 w-4 text-violet-500" /> Check GPA
              </button>
              <button onClick={() => onNavigate('calendar')} className="btn-secondary w-full justify-start">
                <TrendingUp className="h-4 w-4 text-emerald-500" /> Open Calendar
              </button>
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-display text-lg font-bold text-ink">Recent Activity</h3>
            <div className="space-y-3">
              {latestGrades.length ? (
                latestGrades.slice(0, 3).map((g) => (
                  <div key={g.courseCode} className="flex items-center gap-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${gradePoint(g.grade) >= 6 ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    <p className="min-w-0 flex-1 truncate text-sm text-ink-soft">{g.courseCode}</p>
                    <span className="text-xs font-medium text-ink-faint">{g.grade}</span>
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink-faint">No activity yet.</p>
              )}
            </div>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
