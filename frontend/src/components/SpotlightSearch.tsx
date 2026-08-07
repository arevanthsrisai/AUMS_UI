import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Search, CornerDownLeft, LayoutDashboard, CalendarDays, GraduationCap, CalendarRange, Settings, BookOpen, User, TrendingUp } from 'lucide-react';
import type { NavKey } from './layout/Sidebar';
import type { StudentProfile, GpaSummaryData } from '../App';
import { useAttendanceData, type AttendanceSubject } from '../hooks/useAttendanceData';

interface SpotlightProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  profile?: StudentProfile | null;
  gpaSummary?: GpaSummaryData | null;
  onNavigate: (key: NavKey) => void;
}

interface SearchItem {
  id: string;
  category: string;
  title: string;
  subtitle?: string;
  icon: React.ElementType;
  action: () => void;
}

interface FuzzyResult {
  score: number;
  indices: number[];
}

// Subsequence fuzzy match with bonus for consecutive characters.
function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return null;
  let ti = 0;
  let score = 0;
  let consecutive = 0;
  const indices: number[] = [];
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    if (found === ti) {
      consecutive++;
      score += 2 + consecutive;
    } else {
      consecutive = 0;
      score += 1;
    }
    indices.push(found);
    ti = found + 1;
  }
  if (indices[0] === 0) score += 4;
  return { score, indices };
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  const set = new Set(indices);
  return (
    <>
      {text.split('').map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="rounded-sm bg-brand-500/20 text-brand-600 dark:text-brand-300">{ch}</span>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </>
  );
}

// Module-level cache so repeated openings are instant.
const subjectsCache = new Map<string, AttendanceSubject[]>();

const CATEGORY_ORDER = ['Navigation', 'Academic', 'Attendance', 'GPA', 'Calendar', 'Settings', 'Profile'];

function categoryTone(category: string): string {
  switch (category) {
    case 'Navigation': return 'bg-brand-500/10 text-brand-500';
    case 'Academic': return 'bg-violet-500/10 text-violet-500';
    case 'Attendance': return 'bg-emerald-500/10 text-emerald-500';
    case 'GPA': return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'Calendar': return 'bg-sky-500/10 text-sky-500';
    case 'Settings': return 'bg-ink/5 text-ink-soft';
    case 'Profile': return 'bg-rose-500/10 text-rose-500';
    default: return 'bg-ink/5 text-ink-soft';
  }
}

function findIndices(query: string, text: string): number[] {
  if (!query.trim()) return [];
  const res = fuzzyMatch(query, text);
  return res ? res.indices : [];
}

export function SpotlightSearch({ open, onClose, sessionId, profile, gpaSummary, onNavigate }: SpotlightProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [subjects, setSubjects] = useState<AttendanceSubject[]>(() => subjectsCache.get(sessionId) || []);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { attendance, loadAttendance } = useAttendanceData(sessionId);

  // Load attendance subjects once per session for the search index.
  useEffect(() => {
    if (!open) return;
    if (subjectsCache.has(sessionId) || subjects.length) return;
    loadAttendance().catch(() => {});
  }, [open, sessionId, subjects.length, loadAttendance]);

  useEffect(() => {
    if (attendance?.subjects?.length) {
      subjectsCache.set(sessionId, attendance.subjects);
      setSubjects(attendance.subjects);
    }
  }, [attendance, sessionId]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  const navItems: SearchItem[] = useMemo(() => {
    const go = (key: NavKey, label: string, subtitle?: string) => ({
      id: 'nav-' + key,
      category: 'Navigation',
      title: label,
      subtitle,
      icon: key === 'dashboard' ? LayoutDashboard : key === 'attendance' ? CalendarDays : key === 'gpa' ? GraduationCap : key === 'calendar' ? CalendarRange : Settings,
      action: () => onNavigate(key),
    });
    return [
      go('dashboard', 'Dashboard', 'Overview and quick stats'),
      go('attendance', 'Attendance', 'Subject-wise attendance'),
      go('gpa', 'GPA', 'Grades and performance'),
      go('calendar', 'Calendar', 'Attendance calendar'),
      go('settings', 'Settings', 'Theme and account'),
    ];
  }, [onNavigate]);

  const gpaItems: SearchItem[] = useMemo(() => {
    const items: SearchItem[] = [];
    if (gpaSummary?.grades?.length) {
      items.push({
        id: 'gpa-sem',
        category: 'GPA',
        title: 'Semester ' + (gpaSummary.semester || '1'),
        subtitle: 'SGPA ' + (gpaSummary.sgpa || '-') + ' | CGPA ' + (gpaSummary.cgpa || '-'),
        icon: TrendingUp,
        action: () => onNavigate('gpa'),
      });
      gpaSummary.grades.forEach((g, i) => {
        items.push({
          id: 'gpa-' + i,
          category: 'GPA',
          title: g.courseName || g.courseCode,
          subtitle: (g.courseCode || '') + ' | ' + (g.grade || '') + ' | Semester ' + (g.semester || '1'),
          icon: GraduationCap,
          action: () => onNavigate('gpa'),
        });
      });
    }
    return items;
  }, [gpaSummary, onNavigate]);

  const subjectItems: SearchItem[] = useMemo(() => {
    if (!subjects.length) return [];
    const items: SearchItem[] = [];
    subjects.forEach((s) => {
      items.push({
        id: 'acad-' + s.courseCode,
        category: 'Academic',
        title: s.name || s.courseCode,
        subtitle: (s.courseCode || '') + ' | ' + (s.attendance ?? 0) + '%',
        icon: BookOpen,
        action: () => onNavigate('attendance'),
      });
      items.push({
        id: 'att-' + s.courseCode,
        category: 'Attendance',
        title: s.courseCode || s.name,
        subtitle: (s.name || '') + ' | ' + (s.attendedClasses ?? 0) + ' of ' + (s.totalClasses ?? 0) + ' classes',
        icon: CalendarDays,
        action: () => onNavigate('attendance'),
      });
      items.push({
        id: 'cal-' + s.courseCode,
        category: 'Calendar',
        title: s.name || s.courseCode,
        subtitle: (s.courseCode || '') + ' | Open attendance calendar',
        icon: CalendarRange,
        action: () => onNavigate('calendar'),
      });
    });
    return items;
  }, [subjects, onNavigate]);

  const settingsItems: SearchItem[] = useMemo(() => [
    { id: 'set-theme', category: 'Settings', title: 'Change theme', subtitle: 'Light, dark or system', icon: Settings, action: () => onNavigate('settings') },
    { id: 'set-sem', category: 'Settings', title: 'Edit current semester', subtitle: 'Override auto-computed semester', icon: Settings, action: () => onNavigate('settings') },
    { id: 'set-logout', category: 'Settings', title: 'Logout', subtitle: 'End the current session', icon: Settings, action: () => onNavigate('settings') },
  ], [onNavigate]);

  const profileItems: SearchItem[] = useMemo(() => {
    if (!profile?.name) return [];
    return [{
      id: 'profile',
      category: 'Profile',
      title: profile.name,
      subtitle: profile.rollNumber || 'Student profile',
      icon: User,
      action: () => onNavigate('dashboard'),
    }];
  }, [profile, onNavigate]);

  const allItems = useMemo(
    () => [...navItems, ...gpaItems, ...subjectItems, ...settingsItems, ...profileItems],
    [navItems, gpaItems, subjectItems, settingsItems, profileItems]
  );

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return allItems;
    const scored = allItems
      .map((item) => {
        const titleRes = fuzzyMatch(q, item.title);
        const subRes = item.subtitle ? fuzzyMatch(q, item.subtitle) : null;
        const combined = titleRes || subRes;
        if (!combined) return null;
        return { item, score: combined.score, indices: titleRes ? titleRes.indices : (subRes ? subRes.indices : []) };
      })
      .filter((x): x is { item: SearchItem; score: number; indices: number[] } => x !== null)
      .sort((a, b) => b.score - a.score);
    return scored.map((x) => x.item);
  }, [query, allItems]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const grouped = useMemo(() => {
    const map: Record<string, SearchItem[]> = {};
    results.forEach((item) => {
      (map[item.category] ||= []).push(item);
    });
    return CATEGORY_ORDER.filter((c) => map[c]).map((c) => ({ category: c, items: map[c] }));
  }, [results]);

  // Keyboard handling: arrow navigation, Enter, Escape.
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[selected];
      if (item) {
        item.action();
        onClose();
      }
    }
  }, [open, onClose, results, selected]);

  useEffect(() => {
    const onGlobal = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onGlobal);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onGlobal);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-5 w-5 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search subjects, courses, grades, pages..."
            className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            aria-label="Search"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
          {grouped.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Search className="h-8 w-8 text-ink-faint" />
              <p className="text-sm font-medium text-ink">No results for "{query}"</p>
              <p className="text-xs text-ink-faint">Try a course code, subject name or page name.</p>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.category} className="mb-2">
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{group.category}</p>
                {group.items.map((item) => {
                  const active = item.id === results[selected]?.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      data-active={active}
                      onMouseEnter={() => setSelected(results.findIndex((r) => r.id === item.id))}
                      onClick={() => { item.action(); onClose(); }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${active ? 'bg-brand-500/10 ring-1 ring-inset ring-brand-400/40' : 'hover:bg-ink/5 dark:hover:bg-white/5'}`}
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${categoryTone(item.category)}`}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">
                          <Highlighted text={item.title} indices={findIndices(query, item.title)} />
                        </span>
                        {item.subtitle && (
                          <span className="block truncate text-xs text-ink-faint">
                            <Highlighted text={item.subtitle} indices={findIndices(query, item.subtitle)} />
                          </span>
                        )}
                      </span>
                      {active && <CornerDownLeft className="h-4 w-4 shrink-0 text-brand-500" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-[11px] text-ink-faint">
          <span className="flex items-center gap-1"><CornerDownLeft className="h-3 w-3" /> to open</span>
          <span className="flex items-center gap-1"><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
          <span className="ml-auto">Search across your academic data</span>
        </div>
      </motion.div>
    </div>
  );
}
