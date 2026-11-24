import type { DatabaseState } from '../../lib/db-wake';

/** Shown instead of the sign-in forms while the database starts; the page reloads itself. */
export function DatabaseWaking({ state }: { state: Exclude<DatabaseState, { ready: true }> }) {
  const seconds = state.status === 'firewall' ? 8 : 30;
  return (
    <>
      <meta httpEquiv="refresh" content={String(seconds)} />
      <p role="status" className="status-info">{state.message}</p>
    </>
  );
}
