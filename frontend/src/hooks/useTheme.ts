import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'aums-theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? getSystemTheme() : mode;
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  });
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(mode));

  useEffect(() => {
    const html = document.documentElement;
    const apply = () => {
      const next = resolveTheme(mode);
      setResolved(next);
      html.classList.toggle('dark', next === 'dark');
    };
    apply();

    if (mode === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => apply();
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
  }, [mode]);

  const setTheme = useCallback((next: ThemeMode) => {
    setMode(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setTheme]);

  return { mode, resolved, setTheme, toggle };
}
