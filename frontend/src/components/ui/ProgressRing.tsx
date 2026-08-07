import { useEffect, useState } from 'react';

interface ProgressRingProps {
  value: number; // 0-100
  size?: number;
  stroke?: number;
  color?: string;
  label?: string;
  sublabel?: string;
}

export function ProgressRing({ value, size = 72, stroke = 6, color = 'var(--brand-500)', label, sublabel }: ProgressRingProps) {
  const [animated, setAnimated] = useState(0);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circumference - (animated / 100) * circumference;

  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimated(clamped));
    return () => cancelAnimationFrame(raf);
  }, [clamped]);

  return (
    <div className="relative inline-flex items-center justify-center" role="img" aria-label={label ? `${label}: ${Math.round(value)}%` : `${Math.round(value)}%`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.16, 1, 0.3, 1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sm font-bold text-ink">{Math.round(animated)}%</span>
        {sublabel && <span className="text-[10px] text-ink-faint">{sublabel}</span>}
      </div>
    </div>
  );
}
