import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16 sm:px-12">
      <p className="mb-6 text-sm font-semibold tracking-wide text-emerald-900">CadenceDesk AI</p>
      <h1 className="max-w-3xl text-5xl font-semibold tracking-tight sm:text-7xl">
        A workspace for social campaigns
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-relaxed">
        Plan content, review drafts with clients, and schedule posts for each channel.
      </p>
      <Link href="/login" className="primary mt-10 self-start">Sign in to CadenceDesk</Link>
    </main>
  );
}
