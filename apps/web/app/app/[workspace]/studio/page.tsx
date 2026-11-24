import { aiKinds, aiQuote, canWritePosts, studioHistory } from '@cadencedesk/data';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { cancelGenerationAction, generateAction } from './actions';
import { VideoStudio } from './video-studio';

const messages: Record<string, string> = {
  saved: 'Studio updated.',
  asset: 'Choose a valid MP4 no larger than 20 MiB, or ask your operator to check object storage.',
  balance: 'This workspace has insufficient credits for that generation.',
  quote: 'The credit quote changed. Review the displayed price before submitting again.',
  config: 'Ask your operator to configure the AI provider and credit quote.',
  invalid: 'Check the prompt, job status and your workspace access.',
};

const jobLabels = { TEXT: 'Social copy', IMAGE: 'Image', CLIP: 'Clip', TRANSCRIBE: 'Transcript', VIDEO: 'Video' };
const cards = {
  TEXT: { title: 'Generate social copy', field: 'Copy brief or text to revise', hint: 'Ready in a few seconds.' },
  IMAGE: { title: 'Generate image', field: 'Describe the image', hint: 'Square image, ready in under a minute.' },
  VIDEO: { title: 'Generate video', field: 'Describe the video: subject, setting, action, style', hint: 'Short vertical video (about 8 seconds, 9:16) with sound. Takes 2 to 5 minutes.' },
} as const;

export default async function Studio({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const [membership, history] = await Promise.all([getMembership(user.id, workspace), studioHistory(user.id, workspace)]);
  if (!membership || !history) notFound();
  const canWrite = canWritePosts(membership.role);
  return (
    <>
      <h1>AI Studio</h1>
      <p>{new Intl.NumberFormat('en').format(history.available)} credits available · <Link href={`/app/${workspace}/billing`}>Buy credits</Link></p>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {canWrite && <ul className="post-list">{aiKinds.map((kind) => {
        const quote = aiQuote(kind);
        const label = cards[kind].title;
        return <li key={kind}>
          <article>
            <h2>{label}</h2>
            {quote ? (
              <form action={generateAction} className="identity-form">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="kind" value={kind} />
                <input type="hidden" name="credits" value={quote.credits} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <label htmlFor={'prompt-' + kind}>{cards[kind].field}</label>
                <textarea id={'prompt-' + kind} name="prompt" rows={4} maxLength={4000} required />
                <p className="muted-line">{cards[kind].hint}</p>
                <button type="submit" disabled={history.available < quote.credits}>{label} · {quote.credits} credits</button>
                {history.available < quote.credits && <p className="muted-line">Not enough credits. <Link href={`/app/${workspace}/billing`}>Buy credits</Link></p>}
              </form>
            ) : <p>Operator configuration is required for this generation type.</p>}
          </article>
        </li>;
      })}</ul>}
      <VideoStudio workspace={workspace} videos={history.videos} canWrite={canWrite} />
      <h2>Job history</h2>
      {history.jobs.some(({ state }) => state === 'QUEUED' || state === 'RUNNING') &&
        <Link href={`/app/${workspace}/studio?status=refresh`}>Check job status</Link>}
      {history.jobs.length ? <ul className="post-list">{history.jobs.map((job) => (
        <li key={job.id}>
          <article>
            <h2>{jobLabels[job.kind]} · {job.state.toLowerCase()}</h2>
            <p className="post-content">{job.prompt}</p>
            {job.kind === 'CLIP' && <p>{job.startSecond}s start · {job.durationSeconds}s duration</p>}
            {job.credits > 0 && <p>{job.credits} credits</p>}
            {job.outputText && <div className="identity-form">
              <label htmlFor={'output-' + job.id}>{job.kind === 'TRANSCRIBE' ? 'Transcript' : 'Generated copy'}</label>
              <textarea id={'output-' + job.id} rows={5} readOnly value={job.outputText} />
            </div>}
            {job.assetId && <a href={`/app/${workspace}/studio/assets/${job.assetId}`}>{job.kind === 'CLIP' ? 'Download clip' : job.kind === 'VIDEO' ? 'Download generated video' : 'Download generated image'}</a>}
            {job.error && <p>{job.error}</p>}
            {job.state === 'QUEUED' && canWrite && <form action={cancelGenerationAction}>
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="id" value={job.id} />
              <button type="submit">{job.kind === 'CLIP' || job.kind === 'TRANSCRIBE' ? 'Cancel queued job' : 'Cancel queued generation'}</button>
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
