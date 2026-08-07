import { useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff, Sparkles, LogIn, User, Lock, AlertCircle } from 'lucide-react';

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

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-aurora px-4">
      {/* Decorative blobs */}
      <div className="pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-brand-400/20 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -right-20 bottom-0 h-80 w-80 rounded-full bg-accent/20 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-md"
      >
        <div className="glass rounded-3xl p-8 shadow-2xl sm:p-10">
          {/* Brand */}
          <div className="mb-8 flex flex-col items-center text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.15 }}
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-accent text-white shadow-lg shadow-brand-500/30"
            >
              <Sparkles className="h-8 w-8" />
            </motion.div>
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
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-2 rounded-xl border border-rose-300/50 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </motion.div>
            )}

            <motion.button
              type="submit"
              disabled={isSubmitting || !username || !password}
              whileTap={{ scale: 0.98 }}
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
            </motion.button>
          </form>

          <p className="mt-6 text-center text-xs text-ink-faint">
            Use your AUMS credentials to continue
          </p>
        </div>
      </motion.div>
    </div>
  );
}
