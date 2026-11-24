import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="not-found">
      <div style={{ display: 'grid', justifyItems: 'center', gap: '1rem' }}>
        <strong className="gradient-text">404</strong>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800 }}>This page could not be found</h1>
        <p>It may have moved, or you may not have access to it.</p>
        <Link href="/app" className="btn btn-light btn-pill">Back to your workspaces</Link>
      </div>
    </main>
  );
}
