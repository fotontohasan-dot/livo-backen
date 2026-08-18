'use client';

import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme, type ThemeMode } from '@/lib/theme';

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Moon }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

export const ThemeToggle = () => {
  const { mode, setMode } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-1 bg-background-secondary border border-border rounded-full p-1"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setMode(value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wide transition-colors ${
              active
                ? 'bg-accent text-on-accent shadow-sm'
                : 'text-text-muted hover:text-text-primary hover:bg-accent-soft'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
};
