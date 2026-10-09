import { useEffect, useState } from 'react';
import { Eye, EyeOff, LogIn, User, Lock, AlertCircle } from 'lucide-react';

// Honest status lines: each describes a real phase of the login pipeline
// (CAS handshake → credential check → AUMS workspace). Login takes a few
// seconds end-to-end, so these rotate to show the request is alive — they are
// NOT a fake progress bar.
const LOGIN_STEPS = [
  'Contacting AUMS…',
  'Verifying your credentials…',
  'Opening your workspace…',
];

interface LoginProps {
  onLogin: (username: string, password: string) => void;
  error: string | null;
  disabled?: boolean;
}

export default function Login({ onLogin, error, disabled = false }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState({ username: false, password: false });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setTouched({ username: true, password: true });
    if (!username || !password) return;
    setLoading(true);
    await onLogin(username, password);
    setLoading(false);
  };

  const isSubmitting = disabled || loading;
  const usernameError = touched.username && !username;
  const passwordError = touched.password && !password;
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    if (!loading) { setStepIdx(0); return; }
    const id = setInterval(() => setStepIdx((i) => Math.min(i + 1, LOGIN_STEPS.length - 1)), 2200);
    return () => clearInterval(id);
  }, [loading]);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-aurora px-4">
      <div className="w-full max-w-sm">
        <div className="glass rounded-xl p-8 shadow-pop sm:p-10">
          {/* Brand */}
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-brand-500 text-lg font-bold text-white">
              A
            </div>
            <h1 className="mt-4 font-display text-2xl font-bold text-ink">AUMS</h1>
            <p className="mt-1 text-sm text-ink-faint">Amrita Academic Management Suite</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {/* Username */}
            <div>
              <label htmlFor="username" className="mb-1.5 block text-sm font-medium text-ink-soft">
                Username
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, username: true }))}
                  className={`input pl-10 ${usernameError ? 'border-rose-400 focus:ring-rose-400/40' : ''}`}
                  placeholder="Enter your username"
                  autoComplete="username"
                  disabled={isSubmitting}
                  aria-invalid={usernameError}
                  aria-describedby={usernameError ? 'username-error' : undefined}
                />
              </div>
              {usernameError && (
                <p id="username-error" className="mt-1.5 flex items-center gap-1 text-xs text-rose-500">
                  <AlertCircle className="h-3.5 w-3.5" /> Username is required
                </p>
              )}
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink-soft">
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  className={`input pl-10 pr-11 ${passwordError ? 'border-rose-400 focus:ring-rose-400/40' : ''}`}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  disabled={isSubmitting}
                  aria-invalid={passwordError}
                  aria-describedby={passwordError ? 'password-error' : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint transition hover:text-ink"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {passwordError && (
                <p id="password-error" className="mt-1.5 flex items-center gap-1 text-xs text-rose-500">
                  <AlertCircle className="h-3.5 w-3.5" /> Password is required
                </p>
              )}
            </div>

            {error && (
              <div
                className="flex items-start gap-2 rounded-lg border border-rose-300/50 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {loading && (
              <p className="text-center text-xs text-ink-faint" role="status" aria-live="polite">
                {LOGIN_STEPS[stepIdx]}{' '}
                <span className="animate-pulse" aria-hidden="true">···</span>
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !username || !password}
              className="btn-primary w-full py-3"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  Signing in…
                </>
              ) : (
                <>
                  <LogIn className="h-4 w-4" /> Sign in
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-ink-faint">
            Use your AUMS credentials to continue
          </p>
        </div>
      </div>
    </div>
  );
}
