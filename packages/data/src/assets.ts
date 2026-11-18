import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const imageLimit = 2 * 1024 * 1024;
export const videoLimit = 20 * 1024 * 1024;
export class AssetStorageError extends Error {}

function deliverySecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new AssetStorageError('Asset delivery signing is unavailable.');
  return secret;
}

function storage() {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_KEY;
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new AssetStorageError('Object storage requires operator configuration.');
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

function videoType(bytes: Uint8Array<ArrayBuffer>) {
  if (bytes.length < 16 || bytes.length > videoLimit) throw new AssetStorageError('Choose an MP4 video up to 20 MiB.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxSize = header.getUint32(0);
  if (header.getUint32(4) !== 0x66747970 || boxSize < 16 || boxSize > Math.min(4096, bytes.length)) {
    throw new AssetStorageError('Choose a valid MP4 video.');
  }
  return 'video/mp4';
}

export function assetStorageConfigured() {
  return [
    process.env.OBJECT_STORAGE_ENDPOINT,
    process.env.OBJECT_STORAGE_BUCKET,
    process.env.OBJECT_STORAGE_ACCESS_KEY,
    process.env.OBJECT_STORAGE_SECRET_KEY,
  ].every(Boolean);
}

export function uploadImage(workspaceId: string, bytes: Uint8Array<ArrayBuffer>) {
  const type = imageType(bytes);
  return uploadAsset(workspaceId, bytes, type, type === 'image/png' ? 'png' : 'jpg');
}

export function uploadVideo(workspaceId: string, bytes: Uint8Array<ArrayBuffer>) {
  return uploadAsset(workspaceId, bytes, videoType(bytes), 'mp4');
}

export function uploadPostAsset(workspaceId: string, bytes: Uint8Array<ArrayBuffer>, declaredType: string) {
  return declaredType === 'video/mp4' ? uploadVideo(workspaceId, bytes) : uploadImage(workspaceId, bytes);
}

async function uploadAsset(workspaceId: string, bytes: Uint8Array<ArrayBuffer>, type: string, extension: string) {
  const key = `workspaces/${workspaceId}/assets/${randomUUID()}.${extension}`;
  const { client, bucket } = storage();
  try {
    const url = await getSignedUrl(client, new PutObjectCommand({
      Bucket: bucket, Key: key, ContentType: type, ContentLength: bytes.byteLength,
    }), { expiresIn: 60 });
    const response = await fetch(url, {
      method: 'PUT', body: bytes, headers: { 'Content-Type': type },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new AssetStorageError('The upload was rejected by object storage.');
    return { key, type, size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    throw new AssetStorageError('Object storage is unavailable. Check storage settings and bucket access.');
  } finally {
    client.destroy();
  }
}

type StoredAsset = { key: string; type: string; size: number; checksum: string };

export function readImage(asset: StoredAsset, workspaceId: string) {
  return readAsset(asset, workspaceId, imageLimit, imageType);
}

export function createMetaAssetUrl(assetId: string, workspaceId: string) {
  const origin = process.env.APP_URL;
  if (!origin) throw new AssetStorageError('Public application URL is unavailable.');
  const expires = Date.now() + 10 * 60_000;
  const payload = Buffer.from(JSON.stringify({ assetId, workspaceId, expires })).toString('base64url');
  const signature = createHmac('sha256', deliverySecret()).update(payload).digest('base64url');
  return new URL(`/api/media/meta/${payload}.${signature}`, origin).href;
}

export function verifyMetaAssetToken(token: string) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new AssetStorageError('Invalid media delivery token.');
  const expected = createHmac('sha256', deliverySecret()).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { throw new AssetStorageError('Invalid media delivery token.'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AssetStorageError('Invalid media delivery token.');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new AssetStorageError('Invalid media delivery token.'); }
  if (!value || typeof value !== 'object') throw new AssetStorageError('Invalid media delivery token.');
  const { assetId, workspaceId, expires } = value as Record<string, unknown>;
  if (typeof assetId !== 'string' || typeof workspaceId !== 'string' || typeof expires !== 'number'
    || !/^[0-9a-f-]{36}$/i.test(assetId) || !/^[0-9a-f-]{36}$/i.test(workspaceId) || expires < Date.now()) {
    throw new AssetStorageError('Media delivery token expired or is invalid.');
  }
  return { assetId, workspaceId };
}

export function readVideo(asset: StoredAsset, workspaceId: string) {
  return readAsset(asset, workspaceId, videoLimit, videoType);
}

async function readAsset(
  asset: StoredAsset, workspaceId: string, limit: number, format: (bytes: Uint8Array<ArrayBuffer>) => string,
) {
  if (!asset.key.startsWith(`workspaces/${workspaceId}/assets/`) || asset.size > limit || asset.size < 1) {
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
    if (bytes.length !== asset.size || format(bytes) !== asset.type
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
