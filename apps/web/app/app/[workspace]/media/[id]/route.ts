import { AssetStorageError, mediaFile, readImage, readVideo } from '@cadencedesk/data';
import { z } from 'zod';
import { requireUser } from '../../../../../lib/require-user';

/** Serves a workspace media file inline for thumbnails, previews and the media library. */
export async function GET(request: Request, { params }: { params: Promise<{ workspace: string; id: string }> }) {
  // ?download=1 saves the file instead of showing it (the Reminders page, for posting by hand).
  const download = new URL(request.url).searchParams.get('download') === '1';
  const user = await requireUser();
  const { workspace, id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const asset = await mediaFile(user.id, workspace, id);
  if (!asset) return new Response(null, { status: 404 });
  try {
    const media = await (asset.type === 'video/mp4' ? readVideo : readImage)(asset, asset.workspaceId);
    return new Response(media, {
      headers: {
        // Content is immutable per id; cache privately in the browser for an hour.
        'Cache-Control': 'private, max-age=3600, immutable',
        'Content-Type': asset.type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ...(download ? { 'Content-Disposition': `attachment; filename="superstar-${id.slice(0, 8)}.${asset.type === 'video/mp4' ? 'mp4' : asset.type === 'image/png' ? 'png' : asset.type === 'image/webp' ? 'webp' : asset.type === 'image/gif' ? 'gif' : 'jpg'}"` } : {}),
      },
    });
  } catch (error) {
    if (!(error instanceof AssetStorageError)) throw error;
    return new Response(null, { status: 404 });
  }
}
