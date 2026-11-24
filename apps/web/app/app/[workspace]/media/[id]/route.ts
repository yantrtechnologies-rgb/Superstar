import { AssetStorageError, mediaFile, readImage, readVideo } from '@cadencedesk/data';
import { z } from 'zod';
import { requireUser } from '../../../../../lib/require-user';

/** Serves a workspace media file inline for thumbnails, previews and the media library. */
export async function GET(_request: Request, { params }: { params: Promise<{ workspace: string; id: string }> }) {
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
      },
    });
  } catch (error) {
    if (!(error instanceof AssetStorageError)) throw error;
    return new Response(null, { status: 404 });
  }
}
