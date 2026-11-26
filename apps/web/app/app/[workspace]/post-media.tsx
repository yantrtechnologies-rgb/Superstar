import { aiQuote, prisma } from '@cadencedesk/data';
import { AutoRefresh } from './auto-refresh';
import { createPostMediaAction } from './post-media-actions';

export const postMediaMessages: Record<string, string> = {
  'media-started': 'AI is creating it now. An image takes about a minute and a video 2 to 5 minutes; refresh to see it on the post.',
  'media-balance': 'Not enough AI credits for that. Buy credits on the Billing page.',
  'media-quote': 'The credit price changed. Check the new price on the button and try again.',
  'media-config': 'AI images or videos are not set up on this server yet.',
  'media-invalid': 'AI media can be added only to drafts and posts awaiting approval.',
};

type Job = { kind: string; state: string; error: string | null };

/**
 * "Create AI image" / "Create AI video" for one post. The AI uses the post's first line as the hook and the rest as
 * the script; the result is attached to the post automatically while it is still a draft or awaiting approval.
 */
export function PostMediaButtons({ workspace, postId, state, jobs, back }: {
  workspace: string; postId: string; state: string; jobs: Job[]; back: 'posts' | 'automations';
}) {
  if (!['DRAFT', 'IN_REVIEW'].includes(state)) return null;
  const image = aiQuote('IMAGE');
  const video = aiQuote('VIDEO');
  if (!image && !video) return null;
  const busy = (kind: string) => jobs.some((job) => job.kind === kind && (job.state === 'QUEUED' || job.state === 'RUNNING'));
  const failed = jobs.filter((job) => job.state === 'FAILED');
  return (
    <div className="post-media">
      <div className="row-actions">
        {([['IMAGE', image, '🖼 Create AI image'], ['VIDEO', video, '🎬 Create AI video']] as const).map(([kind, quote, label]) => quote && (
          busy(kind)
            ? <span key={kind} className="badge badge-warn">{kind === 'IMAGE' ? 'AI image being created…' : 'AI video being created (2–5 min)…'}</span>
            : (
              <form key={kind} action={createPostMediaAction}>
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="postId" value={postId} />
                <input type="hidden" name="kind" value={kind} />
                <input type="hidden" name="credits" value={quote.credits} />
                <input type="hidden" name="back" value={back} />
                <button type="submit" className="btn">{label} · {quote.credits} credits</button>
              </form>
            )
        ))}
        {(busy('IMAGE') || busy('VIDEO')) && <>
          <AutoRefresh />
          <span className="muted-line">This page updates by itself when it is ready.</span>
        </>}
      </div>
      <p className="muted-line">Made from this post&apos;s hook (first line) and script. A video replaces the post&apos;s photos; an image is added to them.</p>
      {failed.map((job, index) => <p key={index} className="muted-line">⚠ AI {job.kind.toLowerCase()} failed: {job.error ?? 'unknown error'} (credits returned).</p>)}
    </div>
  );
}

/** File types for media ids, so thumbnails can show a video player for videos. */
export async function mediaTypes(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const assets = await prisma.asset.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, type: true } });
  return new Map(assets.map(({ id, type }) => [id, type]));
}

export function MediaThumb({ src, type, className }: { src: string; type?: string; className?: string }) {
  return type === 'video/mp4' ? <video className={className} src={src} controls preload="metadata" playsInline /> : <img className={className} src={src} alt="" loading="lazy" />;
}
