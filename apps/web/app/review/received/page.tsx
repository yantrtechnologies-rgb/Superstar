export const metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function ReviewReceived({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  return (
    <main className="identity-shell">
      <p className="wordmark">CadenceDesk AI</p>
      <h1>{status === 'invalid' ? 'Review response unavailable' : 'Changes requested'}</h1>
      <p>{status === 'invalid' ? 'Open the review link again to submit feedback.' : 'Your feedback is available to the workspace team.'}</p>
    </main>
  );
}
