import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Sidebar, type NavKey, type SidebarProfile } from './Sidebar';
import { Topbar } from './Topbar';

interface AppShellProps {
  active: NavKey;
  title: string;
  profile?: SidebarProfile;
  onNavigate: (key: NavKey) => void;
  onLogout: () => void;
  onSearchOpen: () => void;
  children: React.ReactNode;
}

const titles: Record<NavKey, string> = {
  dashboard: 'Dashboard',
  attendance: 'Attendance',
  gpa: 'GPA',
  calendar: 'Calendar',
  settings: 'Settings',
};

export function AppShell({ active, title, profile, onNavigate, onLogout, onSearchOpen, children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleNavigate = (key: NavKey) => {
    setSidebarOpen(false);
    onNavigate(key);
  };

  return (
    <div className="min-h-screen bg-aurora">
      <div className="pointer-events-none fixed inset-0 bg-grid" aria-hidden />
      <Sidebar
        active={active}
        onNavigate={handleNavigate}
        onLogout={onLogout}
        profile={profile}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="lg:pl-64">
        <Topbar onMenuClick={() => setSidebarOpen(true)} title={title || titles[active]} onSearchOpen={onSearchOpen} />
        <main className="relative mx-auto max-w-7xl px-3 sm:px-4 lg:px-6 py-4 sm:py-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
