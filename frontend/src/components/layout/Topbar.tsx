import { Search, Menu, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemeMode } from '../../hooks/useTheme';

interface TopbarProps {
  onMenuClick: () => void;
  title: string;
  onSearchOpen: () => void;
}

export function Topbar({ onMenuClick, title, onSearchOpen }: TopbarProps) {
  const { mode, resolved, setTheme } = useTheme();

  const cycleTheme = () => {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(mode) + 1) % order.length];
    setTheme(next);
  };

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface-overlay px-4 py-3 backdrop-blur-2xl sm:px-6">
      <button
        onClick={onMenuClick}
        className="rounded-lg p-2 text-ink-soft transition hover:bg-ink/5 dark:hover:bg-white/5 lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      <h1 className="font-display text-lg font-bold text-ink sm:text-xl truncate">{title}</h1>

      <div className="ml-auto flex items-center gap-2">
        {/* Search */}
        <button
          onClick={onSearchOpen}
          className="group hidden items-center gap-2 rounded-xl border border-border bg-surface-raised py-2 pl-3 pr-2 text-sm text-ink-faint transition hover:border-brand-300 hover:text-ink-soft md:flex"
          aria-label="Search (Ctrl+K)"
          title="Search (Ctrl+K)"
        >
          <Search className="h-4 w-4" />
          <span className="w-32 text-left">Search…</span>
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-ink-faint transition group-hover:border-brand-300">⌘K</kbd>
        </button>

        {/* Theme switch */}
        <button
          onClick={cycleTheme}
          className="rounded-lg p-2 text-ink-soft transition hover:bg-ink/5 dark:hover:bg-white/5"
          aria-label={`Theme: ${mode}. Click to change.`}
          title={`Theme: ${mode} (${resolved})`}
        >
          {resolved === 'dark' ? <Moon className="h-5 w-5" /> : resolved === 'light' ? <Sun className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
        </button>

      </div>
    </header>
  );
}
