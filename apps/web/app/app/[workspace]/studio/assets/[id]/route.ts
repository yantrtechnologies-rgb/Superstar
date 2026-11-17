import { AssetStorageError, readImage, studioAsset } from '@cadencedesk/data';
import { z } from 'zod';
import { requireUser } from '../../../../../../lib/require-user';

export async function GET(_request: Request, { params }: { params: Promise<{ workspace: string; id: string }> }) {
  const user = await requireUser();
  const { workspace, id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const asset = await studioAsset(user.id, workspace, id);
  if (!asset) return new Response(null, { status: 404 });
  try {
    const image = await readImage(asset, asset.workspaceId);
    const extension = asset.type === 'image/png' ? 'png' : 'jpg';
    return new Response(image, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': asset.type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="cadencedesk-image.${extension}"`,
      },
    });
  } catch (error) {
    if (!(error instanceof AssetStorageError)) throw error;
    return new Response(null, { status: 404 });
  }
}
