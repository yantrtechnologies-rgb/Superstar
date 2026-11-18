import { AssetStorageError, prisma, readImage, verifyMetaAssetToken } from '@cadencedesk/data';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const { assetId, workspaceId } = verifyMetaAssetToken(token);
    const asset = await prisma.asset.findFirst({ where: { id: assetId, workspaceId } });
    if (!asset) return new Response('Not found', { status: 404 });
    const bytes = await readImage(asset, workspaceId);
    return new Response(bytes, { headers: {
      'Content-Type': asset.type, 'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    if (!(error instanceof AssetStorageError)) throw error;
    return new Response('Unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
}
