import { Settings as SettingsIcon, Sun, Moon, Monitor, LogOut } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { useCurrentSemester } from '../hooks/useCurrentSemester';
import { decodeRollNumber } from '../lib/rollNumber';

interface SettingsPageProps {
  onLogout: () => void;
  profile?: { name?: string; rollNumber?: string; registrationNumber?: string; programme?: string; branch?: string; semester?: string; batch?: string; section?: string; campus?: string; email?: string; phone?: string; mentor?: string; photo?: string } | null;
}

export function SettingsPage({ onLogout, profile }: SettingsPageProps) {
  const { mode, setTheme } = useTheme();
  const { semester: currentSemester, isManual: semesterIsManual, setSemester: setCurrentSemester, resetSemester: resetCurrentSemester } = useCurrentSemester(profile?.batch);
  const rollInfo = decodeRollNumber(profile?.rollNumber);

  const options: { key: ThemeMode; label: string; icon: React.ElementType; desc: string }[] = [
    { key: 'light', label: 'Light', icon: Sun, desc: 'Bright and clean' },
    { key: 'dark', label: 'Dark', icon: Moon, desc: 'Easy on the eyes' },
    { key: 'system', label: 'System', icon: Monitor, desc: 'Follow your device' },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Card>
        <h2 className="flex items-center gap-2 font-display text-xl font-bold text-ink">
          <SettingsIcon className="h-6 w-6 text-brand-500" /> Settings
        </h2>
        <p className="mt-1 text-sm text-ink-faint">Appearance and account</p>
      </Card>

      <Card>
        <h3 className="mb-4 font-display text-lg font-bold text-ink">Theme</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {options.map(opt => {
            const Icon = opt.icon;
            const isActive = mode === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => setTheme(opt.key)}
                className={`rounded-2xl border p-4 text-left transition ${isActive ? 'border-brand-400 bg-brand-500/10 ring-2 ring-brand-400/30' : 'border-border hover:border-brand-300'}`}
                aria-pressed={isActive}
              >
                <Icon className={`h-5 w-5 ${isActive ? 'text-brand-500' : 'text-ink-soft'}`} />
                <p className="mt-2 font-semibold text-ink">{opt.label}</p>
                <p className="text-xs text-ink-faint">{opt.desc}</p>
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 font-display text-lg font-bold text-ink">Semester</h3>
        <p className="text-sm text-ink-faint">
          {semesterIsManual
            ? 'Manual semester set. Auto mode computes it from your joining year.'
            : 'Auto-computed from your joining year and the current date.'}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor="settings-semester" className="sr-only">Current semester</label>
          <select
            id="settings-semester"
            value={String(currentSemester ?? 1)}
            onChange={(e) => setCurrentSemester(Number(e.target.value))}
            className="input w-40"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
              <option key={s} value={s}>Semester {s}</option>
            ))}
          </select>
          <Button variant="secondary" onClick={resetCurrentSemester}>
            {semesterIsManual ? 'Switch to Auto' : 'Auto'}
          </Button>
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 font-display text-lg font-bold text-ink">Account</h3>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p className="text-ink-soft"><span className="font-semibold text-ink">Name:</span> {profile?.name || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Roll No:</span> {profile?.rollNumber || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Registration No:</span> {profile?.registrationNumber || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Programme:</span> {profile?.programme || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Branch:</span> {rollInfo?.branch || profile?.branch || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Semester:</span> {currentSemester ?? '—'}{semesterIsManual ? ' (manual)' : ' (auto)'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Batch:</span> {rollInfo?.batch || profile?.batch || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Section:</span> {rollInfo?.section || profile?.section || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Campus:</span> {rollInfo?.campus || profile?.campus || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Email:</span> {profile?.email || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Phone:</span> {profile?.phone || 'N/A'}</p>
            <p className="text-ink-soft"><span className="font-semibold text-ink">Mentor / Advisor:</span> {profile?.mentor || 'N/A'}</p>
          </div>
        <div className="mt-5 border-t border-border pt-5">
          <Button variant="danger" onClick={onLogout}><LogOut className="h-4 w-4" /> Logout</Button>
        </div>
      </Card>
    </div>
  );
}
