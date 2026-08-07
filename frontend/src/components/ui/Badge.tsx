import { cn } from '../../lib/utils';

type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'violet';

const tones: Record<BadgeTone, string> = {
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  info: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  neutral: 'bg-ink/5 text-ink-soft',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: BadgeTone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn('chip', tones[tone], className)}>{children}</span>
  );
}
