import { cn } from '../../lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  lines?: number;
}

export function Skeleton({ className, lines, ...props }: SkeletonProps) {
  if (lines) {
    return (
      <div className="space-y-3" {...props}>
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className={cn('skeleton h-4', i === lines - 1 && 'w-2/3', className)} />
        ))}
      </div>
    );
  }
  return <div className={cn('skeleton', className)} {...props} />;
}

export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass-card p-5 space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}
