import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type Status = 'pass' | 'fail' | 'not_evaluated' | 'incomplete' | 'not_tested' | 'open' | 'in_progress' | 'ready_for_review' | 'closed' | string;

const CHIP_CLASS: Record<string, string> = {
  pass: 'chip-pass',
  fail: 'chip-fail',
  open: 'chip-open',
  in_progress: 'chip-open',
  ready_for_review: 'chip-open',
  incomplete: 'chip-open',
  not_evaluated: 'chip-open',
  closed: 'chip-closed',
  not_tested: 'chip-closed',
  signed: 'chip-pass',
  submitted: 'chip-open',
  superseded: 'chip-closed',
};

const LABEL: Record<string, string> = {
  not_evaluated: 'Not evaluated',
  not_tested: 'Not tested',
  in_progress: 'In progress',
  ready_for_review: 'Ready for review',
};

/** Status chip: colour plus a text label, never colour alone. */
export function StatusChip({ status }: { status: Status }) {
  const label = LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`chip ${CHIP_CLASS[status] ?? 'chip-closed'}`}>{label}</span>;
}

/** Distinct high-contrast flag for life safety items; readable in grayscale. */
export function LifeSafetyFlag() {
  return (
    <span className="ls-flag" role="img" aria-label="Life safety">
      <span aria-hidden="true">⚑</span> Life safety
    </span>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="progress" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}

export function useApi<T>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    api<T>(path).then(
      (d) => live && setData(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function Loading({ error, children }: { error: string | null; children: ReactNode }) {
  if (error) return <p className="error" role="alert">{error}</p>;
  return <>{children}</>;
}

export const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
