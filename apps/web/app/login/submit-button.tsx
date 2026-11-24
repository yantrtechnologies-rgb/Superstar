'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/** A submit button that shows progress and blocks repeat clicks while its form's server action runs. */
export function SubmitButton({ children, pending, className }: { children: ReactNode; pending: string; className?: string }) {
  const status = useFormStatus();
  return (
    <button type="submit" className={className} disabled={status.pending} aria-busy={status.pending}>
      {status.pending ? <><span className="spinner" aria-hidden="true" />{pending}</> : children}
    </button>
  );
}
