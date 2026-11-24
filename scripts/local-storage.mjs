// Minimal S3-compatible object store for local development only (no MinIO/Docker needed).
// Supports what Superstar uses: create/head bucket, presigned PUT object, GET/HEAD object.
// Binds to 127.0.0.1, checks that requests carry the configured access key, and stores files under .local-storage/.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../.local-storage', import.meta.url)));
const accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY ?? '';
const port = Number(process.env.LOCAL_STORAGE_PORT ?? 9000);
const maxBytes = 64 * 1024 * 1024;

function authorized(req, url) {
  const credential = url.searchParams.get('X-Amz-Credential') ?? req.headers.authorization ?? '';
  return accessKey !== '' && credential.includes(accessKey);
}
function target(pathname) {
  const parts = decodeURIComponent(pathname).split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.')) return null;
  const file = resolve(root, ...parts);
  return file.startsWith(root + sep) ? { bucket: parts[0], key: parts.slice(1).join('/'), file } : null;
}
function send(res, status, headers = {}, body) { res.writeHead(status, headers); res.end(body); }

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!authorized(req, url)) return send(res, 403, { 'Content-Type': 'application/xml' }, '<Error><Code>AccessDenied</Code></Error>');
    const t = target(url.pathname);
    if (!t) return send(res, 400);
    if (!t.key) {
      if (req.method === 'PUT') { await mkdir(t.file, { recursive: true }); return send(res, 200); }
      if (req.method === 'HEAD') { try { await stat(t.file); return send(res, 200); } catch { return send(res, 404); } }
      return send(res, 405);
    }
    if (req.method === 'PUT') {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) return send(res, 413); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      await mkdir(dirname(t.file), { recursive: true });
      await writeFile(t.file, body);
      await writeFile(t.file + '.meta.json', JSON.stringify({ type: req.headers['content-type'] ?? 'application/octet-stream' }));
      return send(res, 200, { ETag: `"${createHash('md5').update(body).digest('hex')}"` });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      let body, meta;
      try { body = await readFile(t.file); meta = JSON.parse(await readFile(t.file + '.meta.json', 'utf8')); }
      catch { return send(res, 404, { 'Content-Type': 'application/xml' }, '<Error><Code>NoSuchKey</Code></Error>'); }
      return send(res, 200, { 'Content-Type': meta.type, 'Content-Length': body.length,
        ETag: `"${createHash('md5').update(body).digest('hex')}"` }, req.method === 'GET' ? body : undefined);
    }
    return send(res, 405);
  } catch { return send(res, 500); }
}).listen(port, '127.0.0.1', () => console.log(`local storage on http://127.0.0.1:${port} -> ${root}`));
