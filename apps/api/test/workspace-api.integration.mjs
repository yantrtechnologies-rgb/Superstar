import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createApiKey, createWorkspace, listApiKeys, prisma, revokeApiKey, savePost, transitionPost,
} from '@cadencedesk/data';
import { apiChannelPage, apiPostPage, apiPostResource } from '@cadencedesk/contracts';

async function startApi() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), API_LISTEN_HOST: '127.0.0.1', API_REQUESTS_PER_MINUTE: '20' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let logs = '';
  const capture = (chunk) => { logs = (logs + String(chunk)).slice(-4000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const ready = await fetch(new URL('/health/ready', baseUrl));
      if (ready.ok) return { baseUrl, close };
    } catch {
      // Wait for local API startup.
    }
    await setTimeout(100);
  }
  await close();
  throw new Error('The API did not become ready. ' + logs);
}

test('workspace REST API scopes requests, enforces approval and rate limits, and revokes keys', { timeout: 45_000 }, async () => {
  const run = randomUUID();
  const owner = await prisma.user.create({ data: { email: `api-owner-${run}@example.invalid` } });
  const outside = await prisma.user.create({ data: { email: `api-outside-${run}@example.invalid` } });
  const workspace = await createWorkspace(owner.id, 'API Studio', 'UTC');
  const other = await createWorkspace(outside.id, 'Other Studio', 'UTC');
  let service;
  async function request(path, { token, data, key, scope = workspace.slug } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(new URL(`/v1/workspaces/${scope}/${path}`, service.baseUrl), {
      method: data === undefined ? 'GET' : 'POST',
      headers, body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { response, json: await response.json() };
  }

  try {
    const [discord] = await Promise.all([
      prisma.channel.create({ data: {
        workspaceId: workspace.id, name: 'announcements', provider: 'discord',
        externalId: '123456789012345671', guildId: '123456789012345670',
      } }),
      prisma.channel.create({ data: {
        workspaceId: workspace.id, name: 'community', provider: 'telegram', externalId: '-1001723456789',
      } }),
    ]);
    const hiddenPost = await savePost(outside.id, other.slug, 'Private second workspace post');
    const token = await createApiKey(owner.id, workspace.slug, 'Publishing API', 30, ['channels:read', 'posts:read', 'posts:write', 'posts:schedule']);
    const readOnly = await createApiKey(owner.id, workspace.slug, 'Read API', 1, ['posts:read']);
    const stored = await prisma.apiKey.findFirstOrThrow({ where: { workspaceId: workspace.id, name: 'Publishing API' } });
    assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
    assert.ok(!stored.tokenHash.includes(token));
    assert.equal(Object.hasOwn((await listApiKeys(owner.id, workspace.slug))[0], 'tokenHash'), false);
    service = await startApi();

    const docs = await fetch(new URL('/docs-json', service.baseUrl)).then((response) => response.json());
    const route = '/v1/workspaces/{workspace}/posts';
    assert.equal(docs.components.securitySchemes.WorkspaceKey.scheme, 'bearer');
    assert.ok(docs.paths[route].post.parameters.some(({ name }) => name === 'Idempotency-Key'));
    assert.ok(docs.paths[route].post.requestBody.content['application/json'].schema.properties.content);
    assert.ok(docs.paths[route].get.responses['200'].content['application/json'].schema.properties.items);
    assert.equal((await request('posts')).response.status, 401);
    assert.equal((await request('posts', { token, scope: other.slug })).response.status, 401);
    assert.equal((await request('posts/' + hiddenPost.id, { token })).response.status, 404);
    assert.equal((await request('posts', { token: readOnly, data: { content: 'No permission' } })).response.status, 403);

    const channels = await request('channels?limit=1', { token });
    assert.equal(channels.response.status, 200);
    assert.equal(channels.response.headers.get('cache-control'), 'no-store');
    assert.equal(apiChannelPage.parse(channels.json).nextOffset, 1);
    const rest = await request('channels?limit=1&offset=1', { token });
    assert.equal(apiChannelPage.parse(rest.json).nextOffset, null);
    assert.notEqual(channels.json.items[0].id, rest.json.items[0].id);
    assert.equal((await request('posts', { token, data: { content: '' } })).response.status, 400);

    const key = randomUUID();
    const content = 'A developer-created draft.';
    const [created, replayed] = await Promise.all([
      request('posts', { token, key, data: { content } }),
      request('posts', { token, key, data: { content } }),
    ]);
    assert.equal(created.response.status, 201);
    assert.equal(replayed.response.status, 201);
    const draft = apiPostResource.parse(created.json);
    assert.equal(replayed.json.id, draft.id);
    assert.equal((await request('posts', { token, key, data: { content: 'A different draft' } })).response.status, 409);
    const pinned = 'posts/' + draft.id;
    const options = { revision: 1, channelIds: [discord.id] };
    assert.equal((await request(pinned + '/schedule', { token, data: { ...options, mode: 'now' } })).response.status, 409);
    assert.equal((await request(pinned + '/review', { token, data: options })).json.state, 'IN_REVIEW');
    await transitionPost(owner.id, workspace.slug, draft.id, 1, 'APPROVED');
    const scheduled = await request(pinned + '/schedule', { token, data: { ...options, mode: 'now' } });
    assert.equal(scheduled.response.status, 202);
    assert.equal(scheduled.json.state, 'SCHEDULED');
    assert.equal(await prisma.outboxEvent.count({ where: { destination: { postId: draft.id } } }), 1);
    const canceled = await request(pinned + '/cancel', { token, data: {} });
    assert.equal(canceled.json.state, 'CANCELED');
    const page = await request('posts', { token: readOnly });
    assert.equal(apiPostPage.parse(page.json).items.length, 1);

    const rateKey = await createApiKey(owner.id, workspace.slug, 'Rate limit test', 1, ['channels:read']);
    let throttled;
    for (let index = 0; index < 40; index++) {
      const result = await request('channels', { token: rateKey });
      if (result.response.status === 429) {
        throttled = result.response;
        break;
      }
      assert.equal(result.response.status, 200);
    }
    assert.ok(throttled, 'the key should hit its Redis quota');
    assert.equal(throttled.headers.get('x-ratelimit-remaining'), '0');
    assert.ok(Number(throttled.headers.get('retry-after')) > 0);
    const expired = await createApiKey(owner.id, workspace.slug, 'Expiry test', 1, ['posts:read']);
    await prisma.apiKey.updateMany({ where: { workspaceId: workspace.id, name: 'Expiry test' }, data: { expiresAt: new Date(0) } });
    assert.equal((await request('posts', { token: expired })).response.status, 401);
    await revokeApiKey(owner.id, workspace.slug, stored.id);
    assert.equal((await request('posts', { token })).response.status, 401);

    await prisma.membership.update({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: owner.id } }, data: { role: 'EDITOR' },
    });
    assert.equal((await request('posts', { token: readOnly })).response.status, 401);
  } finally {
    try {
      await service?.close();
    } finally {
      await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, outside.id] } } });
      await prisma.$disconnect();
    }
  }
});
