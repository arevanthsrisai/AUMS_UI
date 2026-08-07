import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('glass-card p-5', interactive && 'cursor-pointer hover:-translate-y-0.5', className)}
      {...props}
    />
  )
);
Card.displayName = 'Card';
