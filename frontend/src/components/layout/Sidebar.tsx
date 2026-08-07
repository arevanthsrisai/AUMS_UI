import { motion } from 'framer-motion';
import { LayoutDashboard, CalendarDays, GraduationCap, CalendarRange, Settings, LogOut, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';

export type NavKey = 'dashboard' | 'attendance' | 'gpa' | 'calendar' | 'settings';

export interface SidebarProfile {
  name?: string;
  rollNumber?: string;
  photo?: string;
}

interface SidebarProps {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  onLogout: () => void;
  profile?: SidebarProfile;
  open: boolean;
  onClose: () => void;
}

const navItems: { key: NavKey; label: string; icon: React.ElementType }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'attendance', label: 'Attendance', icon: CalendarDays },
  { key: 'gpa', label: 'GPA', icon: GraduationCap },
  { key: 'calendar', label: 'Calendar', icon: CalendarRange },
  { key: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ active, onNavigate, onLogout, profile, open, onClose }: SidebarProps) {
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden" onClick={onClose} aria-hidden />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-surface-overlay backdrop-blur-2xl transition-transform duration-300 ease-out',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 px-6 py-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent text-white shadow-lg shadow-brand-500/30">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <p className="font-display text-lg font-bold text-ink leading-none">AUMS</p>
            <p className="text-xs text-ink-faint mt-0.5">Academic Suite</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 px-3 py-2" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.key;
            return (
              <button
                key={item.key}
                onClick={() => onNavigate(item.key)}
                className={cn(
                  'group relative flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-medium transition-colors touch-manipulation',
                  isActive ? 'text-ink' : 'text-ink-soft hover:text-ink hover:bg-ink/5 dark:hover:bg-white/5'
                )}
                aria-current={isActive ? 'page' : undefined}
              >
                {isActive && (
                  <motion.span
                    layoutId="sidebar-active"
                    className="absolute inset-0 rounded-xl bg-brand-500/10 dark:bg-brand-400/15 ring-1 ring-brand-500/20"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <Icon className={cn('relative h-5 w-5', isActive && 'text-brand-500')} />
                <span className="relative">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* User */}
        <div className="border-t border-border p-4">
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <div className="relative shrink-0">
              <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-brand-400 to-accent text-sm font-bold text-white ring-2 ring-brand-500/20">
                {profile?.photo ? (
                  <img src={profile.photo} alt={profile.name || 'Student'} className="h-full w-full object-cover" />
                ) : (
                  (profile?.name || 'S').charAt(0).toUpperCase()
                )}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-emerald-500" title="Online" aria-label="Online" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{profile?.name || 'Student'}</p>
              {profile?.rollNumber ? (
                <p className="truncate font-mono text-[11px] text-ink-faint">{profile.rollNumber}</p>
              ) : (
                <p className="text-xs text-ink-faint">Signed in</p>
              )}
            </div>
          </div>
          <button
            onClick={onLogout}
            className="mt-2 flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-ink-soft transition hover:bg-rose-500/10 hover:text-rose-500"
          >
            <LogOut className="h-5 w-5" />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
