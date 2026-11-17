import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  cancelPost, connectChannel, createWorkspace, listChannels, prisma, savePost, schedulePost, transitionPost,
} from '@cadencedesk/data';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { dispatchOutbox, publishDestination, reconcileInterrupted } from '../dist/publish.js';

const ids = { guild: '123456789012345670', good: '123456789012345671', bad: '123456789012345672', chat: '-1001723456789', post: '123456789012345673' };

async function createFixture() {
  const owner = await prisma.user.create({ data: { email: 'publishing-' + crypto.randomUUID() + '@example.invalid' } });
  const workspace = await createWorkspace(owner.id, 'Publishing Fixture', 'UTC');
  process.env.DISCORD_WORKSPACE_CHANNELS = JSON.stringify({ [workspace.slug]: [ids.good, ids.bad] });
  process.env.DISCORD_BOT_TOKEN = 'fixture-token';
  process.env.TELEGRAM_BOT_TOKEN = '12345:fixture-token';
  process.env.TELEGRAM_WORKSPACE_CHATS = JSON.stringify({ [workspace.slug]: [ids.chat] });
  return { owner, workspace };
}

async function startObjectStorage() {
  const objects = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'PUT' && url.searchParams.has('X-Amz-Signature')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(url.pathname, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"fixture"' }).end();
    } else if (req.method === 'GET' && objects.has(url.pathname)) {
      const bytes = objects.get(url.pathname);
      res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  Object.assign(process.env, {
    OBJECT_STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
    OBJECT_STORAGE_BUCKET: 'cadencedesk',
    OBJECT_STORAGE_ACCESS_KEY: 'fixture',
    OBJECT_STORAGE_SECRET_KEY: 'fixture',
  });
  return server;
}

async function waitForResults(ids) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await prisma.destination.findMany({ where: { id: { in: ids } }, include: { attempts: true } });
    if (rows.every(({ state }) => ['FAILED', 'PUBLISHED'].includes(state))) return rows;
    await setTimeout(100);
  }
  throw new Error('Timed out waiting for destination results');
}

test('approved publishing survives duplicate dispatch, rate limiting and partial provider failure', { timeout: 180_000 }, async () => {
  const { owner, workspace } = await createFixture();
  const storage = await startObjectStorage();
  const providerCalls = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === 'https://api.telegram.org') {
      assert.equal(init.method, 'POST');
      const chat = { id: Number(ids.chat), type: 'channel', title: 'Telegram announcements' };
      if (url.pathname.endsWith('/getChat')) {
        assert.equal(JSON.parse(init.body).chat_id, Number(ids.chat));
        return Response.json({ ok: true, result: chat });
      }
      assert.ok(url.pathname.endsWith('/sendPhoto'));
      assert.equal(init.body.get('chat_id'), ids.chat);
      assert.equal(init.body.get('caption'), 'Updated campaign');
      assert.ok(init.body.get('photo') instanceof Blob);
      providerCalls.set(ids.chat, (providerCalls.get(ids.chat) ?? 0) + 1);
      return Response.json({ ok: true, result: { message_id: 85, chat } });
    }
    if (url.origin !== 'https://discord.com') return originalFetch(input, init);
    const channelId = url.pathname.split('/')[4];
    assert.equal(init.headers.Authorization, 'Bot fixture-token');
    if (init.method !== 'POST') {
      return Response.json({ guild_id: ids.guild, name: channelId === ids.good ? 'announcements' : 'restricted', type: 0 });
    }
    const count = (providerCalls.get(channelId) ?? 0) + 1;
    providerCalls.set(channelId, count);
    assert.ok(init.body instanceof FormData);
    const body = JSON.parse(init.body.get('payload_json'));
    assert.equal(body.enforce_nonce, true);
    assert.equal(body.content, 'Updated campaign');
    assert.ok(init.body.get('files[0]') instanceof Blob);
    if (channelId === ids.bad) return Response.json({}, { status: 403 });
    if (count === 1) return Response.json({ retry_after: 1 }, { status: 429 });
    return Response.json({ id: ids.post });
  };

  let env;
  try {
    await connectChannel(owner.id, workspace.slug, 'discord', ids.good);
    await connectChannel(owner.id, workspace.slug, 'discord', ids.bad);
    await connectChannel(owner.id, workspace.slug, 'telegram', ids.chat);
    const channels = await listChannels(owner.id, workspace.slug);
    const channelIds = channels.map((channel) => channel.id);
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64'));
    const draft = await savePost(owner.id, workspace.slug, 'Original campaign', undefined, undefined, png);
    await transitionPost(owner.id, workspace.slug, draft.id, 1, 'IN_REVIEW', channelIds);
    await transitionPost(owner.id, workspace.slug, draft.id, 1, 'APPROVED');
    const edited = await savePost(owner.id, workspace.slug, 'Updated campaign', draft.id, 1);
    await assert.rejects(schedulePost(owner.id, workspace.slug, edited.id, 1, channelIds, new Date()));
    await transitionPost(owner.id, workspace.slug, edited.id, 2, 'IN_REVIEW', channelIds);
    await transitionPost(owner.id, workspace.slug, edited.id, 2, 'APPROVED');
    await assert.rejects(schedulePost(owner.id, workspace.slug, edited.id, 2, channelIds.slice(0, 1), new Date()));

    env = await TestWorkflowEnvironment.createLocal();
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: 'cadencedesk',
      workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
      activities: { publishDestination },
    });
    await worker.runUntil(async () => {
      const due = new Date(Date.now() + 1200);
      await schedulePost(owner.id, workspace.slug, edited.id, 2, channelIds, due);
      await Promise.all([dispatchOutbox(env.client), dispatchOutbox(env.client)]);
      assert.equal(providerCalls.size, 0);
      const destinations = await prisma.destination.findMany({ where: { postId: edited.id } });
      const rows = await waitForResults(destinations.map(({ id }) => id));
      const published = rows.find(({ externalId }) => externalId === ids.post);
      assert.equal(published?.externalId, ids.post);
      assert.equal(published?.permalink, `https://discord.com/channels/${ids.guild}/${ids.good}/${ids.post}`);
      assert.equal(published?.attempts.length, 2);
      assert.equal(rows.find(({ externalId }) => externalId === '85')?.permalink, 'https://t.me/c/1723456789/85');
      assert.equal(rows.find(({ state }) => state === 'FAILED')?.attempts.length, 1);
      await Promise.all(rows.map(({ id }) => publishDestination(id)));
      assert.deepEqual([providerCalls.get(ids.good), providerCalls.get(ids.bad), providerCalls.get(ids.chat)], [2, 1, 1]);

      const canceled = await savePost(owner.id, workspace.slug, 'Canceled draft');
      await transitionPost(owner.id, workspace.slug, canceled.id, 1, 'IN_REVIEW', channelIds);
      await transitionPost(owner.id, workspace.slug, canceled.id, 1, 'APPROVED');
      await schedulePost(owner.id, workspace.slug, canceled.id, 1, channelIds, new Date());
      await cancelPost(owner.id, workspace.slug, canceled.id);
      const canceledRows = await prisma.destination.findMany({ where: { postId: canceled.id } });
      await Promise.all(canceledRows.map(({ id }) => publishDestination(id)));
      assert.deepEqual([providerCalls.get(ids.good), providerCalls.get(ids.bad), providerCalls.get(ids.chat)], [2, 1, 1]);

      const canceledId = canceledRows[0].id;
      await prisma.destination.update({
        where: { id: canceledId }, data: {
          state: 'PUBLISHING', startedAt: new Date(Date.now() - 360_000),
          attempts: { create: { number: 1, state: 'PUBLISHING' } },
        },
      });
      await reconcileInterrupted();
      const recovered = await prisma.destination.findUniqueOrThrow({ where: { id: canceledId }, include: { attempts: true } });
      assert.equal(recovered.state, 'UNCERTAIN');
      assert.equal(recovered.attempts[0].state, 'UNCERTAIN');
    });
  } finally {
    globalThis.fetch = originalFetch;
    try {
      await env?.teardown();
    } finally {
      await new Promise((resolve) => storage.close(resolve));
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.$disconnect();
    }
  }
});

test('Slack validates capabilities and retains a confirmed write when link lookup fails', async () => {
  const { providers, validateProviderPost, ProviderConfigurationError } = await import('@cadencedesk/data');
  const channelId = 'C000000001';
  const workspace = 'slack-test-fixture';
  process.env.SLACK_BOT_TOKEN = 'fixture-slack';
  process.env.SLACK_WORKSPACE_CHANNELS = JSON.stringify({ [workspace]: [channelId] });
  const originalFetch = globalThis.fetch;
  let linkFails = false;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://slack.com');
    assert.equal(init.headers.Authorization, 'Bearer fixture-slack');
    if (url.pathname.endsWith('conversations.info')) {
      assert.equal(url.searchParams.get('channel'), channelId);
      return Response.json({ ok: true, channel: { id: channelId, name: 'updates', is_member: true } });
    }
    if (url.pathname.endsWith('chat.postMessage')) {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.equal(body.channel, channelId);
      assert.equal(body.text, 'A &amp; B &lt; C');
      assert.equal(body.mrkdwn, false);
      writes++;
      return Response.json({ ok: true, channel: channelId, ts: '1234567890.123456' });
    }
    assert.ok(url.pathname.endsWith('chat.getPermalink'));
    assert.equal(url.searchParams.get('channel'), channelId);
    assert.equal(url.searchParams.get('message_ts'), '1234567890.123456');
    if (linkFails) return new Response(null, { status: 503 });
    return Response.json({ ok: true, permalink: 'https://example.slack.com/archives/C000000001/p1234567890123456' });
  };
  try {
    assert.throws(() => validateProviderPost('slack', 'Attachment', true), ProviderConfigurationError);
    assert.throws(() => validateProviderPost('telegram', 'a'.repeat(1025), true), ProviderConfigurationError);
    await assert.rejects(providers.slack.discover('another-tenant', channelId), ProviderConfigurationError);
    assert.deepEqual(await providers.slack.discover(workspace, channelId), { name: 'updates' });
    const channel = { externalId: channelId, guildId: null };
    const result = await providers.slack.publish(workspace, channel, 'nonce', 'A & B < C');
    assert.deepEqual(result, {
      kind: 'published', externalId: '1234567890.123456',
      permalink: 'https://example.slack.com/archives/C000000001/p1234567890123456',
    });
    linkFails = true;
    assert.deepEqual(await providers.slack.publish(workspace, channel, 'new-nonce', 'A & B < C'), {
      kind: 'published', externalId: '1234567890.123456', permalink: null,
    });
    assert.equal(writes, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
