import { AssetStorageError, readImage, reviewPreview } from '@cadencedesk/data';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const review = await reviewPreview(token);
  if (!review?.asset) return new Response(null, { status: 404 });
  try {
    const body = await readImage(review.asset, review.workspaceId);
    return new Response(body, {
      headers: {
        'Content-Type': review.asset.type,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    if (!(error instanceof AssetStorageError)) throw error;
    return new Response(null, { status: 404 });
  }
}
