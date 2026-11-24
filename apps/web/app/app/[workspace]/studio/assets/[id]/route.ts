import { AssetStorageError, readImage, readVideo, studioAsset } from '@cadencedesk/data';
import { z } from 'zod';
import { requireUser } from '../../../../../../lib/require-user';

export async function GET(_request: Request, { params }: { params: Promise<{ workspace: string; id: string }> }) {
  const user = await requireUser();
  const { workspace, id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const asset = await studioAsset(user.id, workspace, id);
  if (!asset) return new Response(null, { status: 404 });
  try {
    const video = asset.type === 'video/mp4';
    const media = await (video ? readVideo : readImage)(asset, asset.workspaceId);
    const extension = video ? 'mp4' : asset.type === 'image/png' ? 'png' : 'jpg';
    return new Response(media, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': asset.type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="superstar-${video ? 'video' : 'image'}.${extension}"`,
      },
    });
  } catch (error) {
    if (!(error instanceof AssetStorageError)) throw error;
    return new Response(null, { status: 404 });
  }
}
