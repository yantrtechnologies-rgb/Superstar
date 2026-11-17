import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const imageLimit = 2 * 1024 * 1024;
export class AssetStorageError extends Error {}

function storage() {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_KEY;
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new AssetStorageError('Image storage requires operator configuration.');
  }
  return {
    bucket,
    client: new S3Client({
      endpoint,
      region: process.env.OBJECT_STORAGE_REGION ?? 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      maxAttempts: 1,
    }),
  };
}

function imageType(bytes: Uint8Array<ArrayBuffer>) {
  if (bytes.length === 0 || bytes.length > imageLimit) throw new AssetStorageError('Images must be under 2 MiB.');
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  throw new AssetStorageError('Choose a PNG or JPEG image.');
}

export async function uploadImage(workspaceId: string, bytes: Uint8Array<ArrayBuffer>) {
  const type = imageType(bytes);
  const key = `workspaces/${workspaceId}/assets/${randomUUID()}.${type === 'image/png' ? 'png' : 'jpg'}`;
  const { client, bucket } = storage();
  try {
    const url = await getSignedUrl(client, new PutObjectCommand({
      Bucket: bucket, Key: key, ContentType: type, ContentLength: bytes.byteLength,
    }), { expiresIn: 60 });
    const response = await fetch(url, {
      method: 'PUT', body: bytes, headers: { 'Content-Type': type },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new AssetStorageError('The image upload was rejected by object storage.');
    return { key, type, size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    throw new AssetStorageError('Image storage is unavailable. Check storage settings and bucket access.');
  } finally {
    client.destroy();
  }
}

export async function readImage(asset: { key: string; type: string; size: number; checksum: string }, workspaceId: string) {
  if (!asset.key.startsWith(`workspaces/${workspaceId}/assets/`) || asset.size > imageLimit || asset.size < 1) {
    throw new AssetStorageError('The attachment is unavailable.');
  }
  const { client, bucket } = storage();
  try {
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: asset.key }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
    if (!result.Body || result.ContentLength !== asset.size) {
      result.Body?.transformToWebStream().cancel().catch(() => undefined);
      throw new AssetStorageError('The stored attachment size changed.');
    }
    const bytes = new Uint8Array(await result.Body.transformToByteArray());
    if (bytes.length !== asset.size || imageType(bytes) !== asset.type
      || createHash('sha256').update(bytes).digest('hex') !== asset.checksum) {
      throw new AssetStorageError('The stored attachment failed validation.');
    }
    return bytes;
  } catch {
    throw new AssetStorageError('The stored attachment is unavailable or failed validation.');
  } finally {
    client.destroy();
  }
}
