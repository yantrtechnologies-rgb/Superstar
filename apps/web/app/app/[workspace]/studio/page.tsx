import { aiKinds, aiQuote, canWritePosts, findMembership, studioHistory } from '@cadencedesk/data';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/require-user';
import { cancelGenerationAction, generateAction } from './actions';

const messages: Record<string, string> = {
  saved: 'Studio updated.',
  balance: 'This workspace has insufficient credits for that generation.',
  quote: 'The credit quote changed. Review the displayed price before submitting again.',
  config: 'Ask your operator to configure the AI provider and credit quote.',
  invalid: 'Check the prompt, job status and your workspace access.',
};

export default async function Studio({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const [membership, history] = await Promise.all([findMembership(user.id, workspace), studioHistory(user.id, workspace)]);
  if (!membership || !history) notFound();
  const canWrite = canWritePosts(membership.role);
  return (
    <>
      <h1>AI Studio</h1>
      <p>{new Intl.NumberFormat('en').format(history.available)} credits available</p>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {canWrite && <ul className="post-list">{aiKinds.map((kind) => {
        const quote = aiQuote(kind);
        const label = kind === 'TEXT' ? 'Generate social copy' : 'Generate image';
        return <li key={kind}>
          <article>
            <h2>{label}</h2>
            {quote ? (
              <form action={generateAction} className="identity-form">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="kind" value={kind} />
                <input type="hidden" name="credits" value={quote.credits} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <label htmlFor={'prompt-' + kind}>{kind === 'TEXT' ? 'Copy brief or text to revise' : 'Image brief'}</label>
                <textarea id={'prompt-' + kind} name="prompt" rows={4} maxLength={4000} required />
                <button type="submit">{label} · {quote.credits} credits</button>
              </form>
            ) : <p>Operator configuration is required for this generation type.</p>}
          </article>
        </li>;
      })}</ul>}
      <h2>Generation history</h2>
      {history.jobs.some(({ state }) => state === 'QUEUED' || state === 'RUNNING') &&
        <Link href={`/app/${workspace}/studio?status=refresh`}>Check job status</Link>}
      {history.jobs.length ? <ul className="post-list">{history.jobs.map((job) => (
        <li key={job.id}>
          <article>
            <h2>{job.kind === 'TEXT' ? 'Social copy' : 'Image'} · {job.state.toLowerCase()}</h2>
            <p className="post-content">{job.prompt}</p>
            <p>{job.credits} credits</p>
            {job.outputText && <div className="identity-form">
              <label htmlFor={'output-' + job.id}>Generated copy</label>
              <textarea id={'output-' + job.id} rows={5} readOnly value={job.outputText} />
            </div>}
            {job.assetId && <a href={`/app/${workspace}/studio/assets/${job.assetId}`}>Download generated image</a>}
            {job.error && <p>{job.error}</p>}
            {job.state === 'QUEUED' && canWrite && <form action={cancelGenerationAction}>
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="id" value={job.id} />
              <button type="submit">Cancel queued generation</button>
            </form>}
          </article>
        </li>
      ))}</ul> : <p>No generations yet.</p>}
      <h2>Credit activity</h2>
      {history.entries.length ? <ul className="workspaces-list">{history.entries.map((entry) => (
        <li key={entry.id}><span>{entry.kind.toLowerCase()}</span><span>{entry.delta > 0 ? '+' : ''}{entry.delta}</span></li>
      ))}</ul> : <p>No credit activity yet.</p>}
    </>
  );
}
