// Creates the configured object-storage bucket if it does not exist yet.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(fileURLToPath(new URL('../packages/data/package.json', import.meta.url)));
const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_BUCKET: bucket, OBJECT_STORAGE_ACCESS_KEY: accessKeyId,
  OBJECT_STORAGE_SECRET_KEY: secretAccessKey, OBJECT_STORAGE_REGION: region = 'us-east-1' } = process.env;
const client = new S3Client({ endpoint, region: region === 'auto' ? 'us-east-1' : region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`Bucket ${bucket} exists`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Bucket ${bucket} created`);
}
