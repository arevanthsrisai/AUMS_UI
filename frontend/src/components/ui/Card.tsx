import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive, onClick, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'glass-card p-5',
        interactive && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2',
        className
      )}
      onClick={onClick}
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (!onClick) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick((e as unknown) as React.MouseEvent<HTMLDivElement>);
              }
            },
          }
        : null)}
      {...props}
    />
  )
);
Card.displayName = 'Card';
