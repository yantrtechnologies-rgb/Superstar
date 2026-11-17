import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  addWebhook, cancelPost, connectChannel, createWorkspace, CreditBalanceError, finalizeAiJob, listChannels, queueAiJob, nextAvailableSlot, prisma, queueChannelMetric, savePost, schedulePost, transitionPost, workspaceMetrics,
} from '@cadencedesk/data';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { dispatchOutbox, publishDestination, reconcileInterrupted } from '../dist/publish.js';
import { collectChannelMetric, dispatchAnalytics } from '../dist/analytics.js';
import { dispatchAiJobs, reconcileAiJobs, runAiJob } from '../dist/ai.js';
import { importRssRun, recordFeedItems, queueDueRssRules } from '../dist/rss.js';
import { deliverWebhook, dispatchWebhooks } from '../dist/webhooks.js';

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
  let telegramMetricAvailable = true;
  let aiRequests = 0;
  const httpAttempts = new Map();
  const webhookBodies = new Map();
  process.env.WEBHOOK_ALLOWED_ENDPOINTS = 'https://hooks.example.invalid/published';
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 0x38).toString('base64');
  Object.assign(process.env, {
    OPENAI_API_KEY: 'fixture-key', OPENAI_TEXT_MODEL: 'fixture-text', OPENAI_IMAGE_MODEL: 'fixture-image',
    AI_STARTER_CREDITS: '4', AI_TEXT_BASE_CREDITS: '2', AI_IMAGE_BASE_CREDITS: '2', AI_CREDIT_MARKUP: '2',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === 'https://api.openai.com') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-key');
      const payload = JSON.parse(init.body);
      aiRequests++;
      if (url.pathname.endsWith('/responses')) {
        assert.equal(payload.store, false);
        assert.equal(payload.model, 'fixture-text');
        return Response.json({ error: { code: 'fixture' } }, { status: 400, headers: { 'x-request-id': 'text-fixture' } });
      }
      assert.equal(payload.model, 'fixture-image');
      return Response.json({
        data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=' }],
      }, { headers: { 'x-request-id': 'image-fixture' } });
    }
    if (url.origin === 'https://api.telegram.org') {
      assert.equal(init.method, 'POST');
      const chat = { id: Number(ids.chat), type: 'channel', title: 'Telegram announcements' };
      if (url.pathname.endsWith('/getChat')) {
        assert.equal(JSON.parse(init.body).chat_id, Number(ids.chat));
        return Response.json({ ok: true, result: chat });
      }
      if (url.pathname.endsWith('/getChatMemberCount')) {
        assert.equal(JSON.parse(init.body).chat_id, Number(ids.chat));
        return telegramMetricAvailable ? Response.json({ ok: true, result: 0 }) : Response.json({ ok: false }, { status: 403 });
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

    const webhook = await addWebhook(owner.id, workspace.slug, 'Publication webhook', process.env.WEBHOOK_ALLOWED_ENDPOINTS);
    env = await TestWorkflowEnvironment.createLocal();
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: 'cadencedesk',
      workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
      activities: {
        publishDestination, collectChannelMetric, runAiJob, importRssRun,
        deliverWebhook: (id) => deliverWebhook(id, async (endpoint, headers, body) => {
          assert.equal(endpoint.href, process.env.WEBHOOK_ALLOWED_ENDPOINTS);
          assert.equal(headers['X-Superstar-Event'], 'post.published');
          assert.equal(headers['X-Superstar-Delivery'], id);
          const signature = createHmac('sha256', webhook.secret)
            .update(headers['X-Superstar-Timestamp'] + '.' + id + '.' + body).digest('hex');
          assert.equal(headers['X-Superstar-Signature'], 'v1=' + signature);
          if (webhookBodies.has(id)) assert.equal(webhookBodies.get(id), body);
          webhookBodies.set(id, body);
          const count = (httpAttempts.get(id) ?? 0) + 1;
          httpAttempts.set(id, count);
          if (JSON.parse(body).data.provider === 'telegram') return { statusCode: 400 };
          return count === 1 ? { statusCode: 429, retryAfter: '1' } : { statusCode: 204 };
        }),
      },
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

      const webhookRows = await prisma.webhookDelivery.findMany({ where: { subscriptionId: webhook.id } });
      assert.equal(webhookRows.length, 2);
      const publishedIds = rows.filter(({ state }) => state === 'PUBLISHED').map(({ id }) => id).sort();
      assert.deepEqual(webhookRows.map(({ eventId }) => eventId).sort(), publishedIds);
      await Promise.all([dispatchWebhooks(env.client), dispatchWebhooks(env.client)]);
      await Promise.all(webhookRows.map(({ id }) => env.client.workflow.getHandle('webhook-' + id).result()));
      const finished = await prisma.webhookDelivery.findMany({ where: { subscriptionId: webhook.id }, include: { attempts: true } });
      const succeeded = finished.find(({ state }) => state === 'DELIVERED');
      assert.equal(succeeded.attemptsCount, 2);
      assert.equal(succeeded.statusCode, 204);
      assert.equal(succeeded.attempts.find(({ number }) => number === 1).statusCode, 429);
      const failure = finished.find(({ state }) => state === 'FAILED');
      assert.equal(failure.attemptsCount, 1);
      assert.equal(failure.statusCode, 400);
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

      const telegram = channels.find(({ provider }) => provider === 'telegram');
      const jobs = await Promise.all([
        queueChannelMetric(owner.id, workspace.slug, telegram.id),
        queueChannelMetric(owner.id, workspace.slug, telegram.id),
      ]);
      assert.equal(jobs[0].id, jobs[1].id);
      await Promise.all([dispatchAnalytics(env.client), dispatchAnalytics(env.client)]);
      await env.client.workflow.getHandle('metric-' + jobs[0].id).result();
      await prisma.metricJob.update({ where: { id: jobs[0].id }, data: { bucket: new Date(Date.now() - 10 * 60_000) } });
      telegramMetricAvailable = false;
      const failed = await queueChannelMetric(owner.id, workspace.slug, telegram.id);
      await dispatchAnalytics(env.client);
      await env.client.workflow.getHandle('metric-' + failed.id).result();
      const metrics = await workspaceMetrics(owner.id, workspace.slug, new Date(0));
      const memberCount = metrics.find(({ id }) => id === telegram.id);
      assert.equal(memberCount.metricJobs[0].state, 'UNAVAILABLE');
      assert.deepEqual(memberCount.snapshots.map(({ count }) => count), [0]);

      const charges = await Promise.allSettled([
        queueAiJob(owner.id, workspace.slug, 'TEXT', 'First text request', 4),
        queueAiJob(owner.id, workspace.slug, 'TEXT', 'Second text request', 4),
      ]);
      const successful = charges.filter(({ status }) => status === 'fulfilled');
      assert.equal(successful.length, 1);
      assert.ok(charges.find(({ status }) => status === 'rejected').reason instanceof CreditBalanceError);
      const job = successful[0].value;
      assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).available, 0);
      const duplicate = await queueAiJob(owner.id, workspace.slug, 'TEXT', job.prompt, 4, job.requestId);
      assert.equal(duplicate.id, job.id);
      await Promise.all([dispatchAiJobs(env.client), dispatchAiJobs(env.client)]);
      await env.client.workflow.getHandle('ai-' + job.id).result();
      await finalizeAiJob(job.id, { type: 'failed', error: 'repeated finalization' });
      const failedJob = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(failedJob.state, 'FAILED');
      assert.equal(failedJob.providerRef, 'text-fixture');
      assert.equal(await prisma.creditEntry.count({ where: { reference: 'refund:' + job.id } }), 1);
      assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).available, 4);

      const image = await queueAiJob(owner.id, workspace.slug, 'IMAGE', 'A small logo mark', 4);
      await dispatchAiJobs(env.client);
      await env.client.workflow.getHandle('ai-' + image.id).result();
      const imageResult = await prisma.aiJob.findUniqueOrThrow({ where: { id: image.id }, include: { asset: true } });
      assert.equal(imageResult.state, 'SUCCEEDED');
      assert.equal(imageResult.providerRef, 'image-fixture');
      assert.ok(imageResult.asset.key.startsWith('workspaces/' + workspace.id + '/assets/'));
      assert.equal(await prisma.creditEntry.count({ where: { reference: 'capture:' + image.id } }), 1);
      assert.equal(aiRequests, 2);
      await reconcileAiJobs();
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

test('LinkedIn OAuth binds one-time state to its actor and refreshes encrypted credentials once', async () => {
  const {
    beginLinkedInConnection, completeLinkedInConnection, disconnectLinkedIn, linkedInAccess,
    providers, ProviderConfigurationError, WorkspaceAccessError,
  } = await import('@cadencedesk/data');
  const owner = await prisma.user.create({ data: { email: 'linkedin-owner-' + crypto.randomUUID() + '@example.invalid' } });
  const wrongUser = await prisma.user.create({ data: { email: 'linkedin-outsider-' + crypto.randomUUID() + '@example.invalid' } });
  const workspace = await createWorkspace(owner.id, 'LinkedIn Fixture', 'UTC');
  const otherWorkspace = await createWorkspace(wrongUser.id, 'Other Tenant', 'UTC');
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    LINKEDIN_CLIENT_ID: 'fixture-client',
    LINKEDIN_CLIENT_SECRET: 'fixture-secret',
    APP_URL: 'http://127.0.0.1:3930',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 0x19).toString('base64'),
  });

  let exchanges = 0;
  let refreshes = 0;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.href === 'https://www.linkedin.com/oauth/v2/accessToken') {
      const grant = init.body.get('grant_type');
      assert.equal(init.body.get('client_id'), 'fixture-client');
      assert.equal(init.body.get('client_secret'), 'fixture-secret');
      if (grant === 'authorization_code') {
        exchanges++;
        assert.equal(init.body.get('redirect_uri'), 'http://127.0.0.1:3930/api/connect/linkedin');
        assert.equal(init.body.get('code'), 'fixture-linkedin-code');
        return Response.json({
          access_token: 'fixture-initial-access', expires_in: 3600, refresh_token: 'fixture-refresh',
          refresh_token_expires_in: 7200, scope: 'openid profile w_member_social',
        });
      }
      assert.equal(grant, 'refresh_token');
      assert.equal(init.body.get('refresh_token'), 'fixture-refresh');
      refreshes++;
      await setTimeout(50);
      return Response.json({ access_token: 'fixture-refreshed-' + refreshes, expires_in: 3600 });
    }
    if (url.href === 'https://api.linkedin.com/v2/userinfo') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-initial-access');
      return Response.json({ sub: 'fixture-member-01', name: 'LinkedIn Fixture Member' });
    }
    assert.equal(url.href, 'https://api.linkedin.com/v2/ugcPosts');
    writes++;
    assert.equal(JSON.parse(init.body).author, 'urn:li:person:fixture-member-01');
    if (init.headers.Authorization === 'Bearer fixture-refreshed-1') return new Response(null, { status: 401 });
    assert.equal(init.headers.Authorization, 'Bearer fixture-refreshed-2');
    return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:ugcPost:1234567890123456789' } });
  };
  try {
    await assert.rejects(beginLinkedInConnection(wrongUser.id, workspace.slug), WorkspaceAccessError);
    const authUrl = new URL(await beginLinkedInConnection(owner.id, workspace.slug));
    assert.equal(authUrl.origin, 'https://www.linkedin.com');
    assert.equal(authUrl.searchParams.get('scope'), 'openid profile w_member_social');
    const state = authUrl.searchParams.get('state');
    assert.ok(state);
    assert.equal(await prisma.oAuthState.findUnique({ where: { hash: state } }), null);
    await assert.rejects(completeLinkedInConnection(wrongUser.id, state, 'fixture-linkedin-code'), ProviderConfigurationError);
    assert.equal(exchanges, 0);
    assert.deepEqual(await completeLinkedInConnection(owner.id, state, 'fixture-linkedin-code'), { slug: workspace.slug, connected: true });
    await assert.rejects(completeLinkedInConnection(owner.id, state, 'fixture-linkedin-code'), ProviderConfigurationError);
    assert.equal(exchanges, 1);

    const channel = await prisma.channel.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    const encrypted = await prisma.providerCredential.findUniqueOrThrow({ where: { channelId: channel.id } });
    assert.ok(encrypted.accessToken.startsWith('v1.'));
    assert.ok(!encrypted.accessToken.includes('fixture-initial-access'));
    assert.ok(!encrypted.refreshToken.includes('fixture-refresh'));
    assert.equal(await linkedInAccess(channel.id, otherWorkspace.id), null);

    await prisma.providerCredential.update({
      where: { channelId: channel.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) },
    });
    const concurrent = await Promise.all([linkedInAccess(channel.id, workspace.id), linkedInAccess(channel.id, workspace.id)]);
    assert.deepEqual(concurrent.map(({ access }) => access), ['fixture-refreshed-1', 'fixture-refreshed-1']);
    assert.equal(refreshes, 1);
    const published = await providers.linkedin.publish(workspace.slug, channel, 'nonce', 'Hello from Superstar');
    assert.equal(published.kind, 'published');
    assert.equal(published.externalId, 'urn:li:ugcPost:1234567890123456789');
    assert.equal(writes, 2);
    assert.equal(refreshes, 2);

    await assert.rejects(disconnectLinkedIn(wrongUser.id, workspace.slug, channel.id), WorkspaceAccessError);
    await disconnectLinkedIn(owner.id, workspace.slug, channel.id);
    assert.equal(await linkedInAccess(channel.id, workspace.id), null);
    assert.equal(await prisma.channel.count({ where: { id: channel.id } }), 1);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, wrongUser.id] } } });
    await prisma.$disconnect();
  }
});

test('shared posting slots handle DST gaps, repeated hours and occupied minutes', () => {
  const tz = 'America/New_York';
  const gap = [{ weekday: 7, minute: 150 }];
  const nextReal = nextAvailableSlot([gap, gap], tz, new Date('2026-03-08T05:00:00Z'), new Set());
  assert.equal(nextReal.toISOString(), '2026-03-15T06:30:00.000Z');
  const repeated = [{ weekday: 7, minute: 90 }];
  const first = nextAvailableSlot([repeated], tz, new Date('2026-11-01T04:00:00Z'), new Set());
  assert.equal(first.toISOString(), '2026-11-01T05:30:00.000Z');
  const occupied = new Set([Math.floor(first.getTime() / 60_000)]);
  const next = nextAvailableSlot([repeated], tz, new Date('2026-11-01T04:00:00Z'), occupied);
  assert.equal(next.toISOString(), '2026-11-08T06:30:00.000Z');
});

test('review link access expires, revokes, and closes after a change request', async () => {
  const {
    createReviewLink, revokeReviewLink, reviewPreview, respondToReview, WorkspaceAccessError,
    createClientGroup, assignChannelGroup, savePostingSlot,
  } = await import('@cadencedesk/data');
  const owner = await prisma.user.create({ data: { email: 'review-link-' + crypto.randomUUID() + '@example.invalid' } });
  const workspace = await createWorkspace(owner.id, 'Review gates', 'UTC');
  const other = await createWorkspace(owner.id, 'Other client', 'UTC');
  try {
    const channel = await prisma.channel.create({ data: {
      workspaceId: workspace.id, provider: 'discord', name: 'review-gate',
      externalId: ids.good, guildId: ids.guild,
    } });
    await createClientGroup(owner.id, other.slug, 'Other group');
    const otherGroup = await prisma.clientGroup.findFirstOrThrow({ where: { workspaceId: other.id } });
    await assert.rejects(assignChannelGroup(owner.id, workspace.slug, channel.id, otherGroup.id), WorkspaceAccessError);
    await assert.rejects(savePostingSlot(owner.id, other.slug, channel.id, 1, 540), WorkspaceAccessError);
    const draft = await savePost(owner.id, workspace.slug, 'Review access fixture');
    await transitionPost(owner.id, workspace.slug, draft.id, 1, 'IN_REVIEW', [channel.id]);

    const expired = await createReviewLink(owner.id, workspace.slug, draft.id, 1, 1);
    await prisma.reviewLink.updateMany({ where: { postId: draft.id }, data: { expiresAt: new Date(0) } });
    assert.equal(await reviewPreview(expired), null);

    const revoked = await createReviewLink(owner.id, workspace.slug, draft.id, 1, 7);
    const link = await prisma.reviewLink.findFirstOrThrow({ where: { postId: draft.id, expiresAt: { gt: new Date() } } });
    await assert.rejects(revokeReviewLink(owner.id, other.slug, link.id), WorkspaceAccessError);
    await revokeReviewLink(owner.id, workspace.slug, link.id);
    assert.equal(await reviewPreview(revoked), null);

    const active = await createReviewLink(owner.id, workspace.slug, draft.id, 1, 7);
    const sibling = await createReviewLink(owner.id, workspace.slug, draft.id, 1, 7);
    await respondToReview(active, 'CHANGES', 'Update the launch date.');
    assert.equal(await reviewPreview(active), null);
    assert.equal(await reviewPreview(sibling), null);
    const updated = await prisma.post.findUniqueOrThrow({ where: { id: draft.id }, include: { editorialComments: true } });
    assert.equal(updated.state, 'DRAFT');
    assert.equal(updated.editorialComments[0].body, 'Update the launch date.');
  } finally {
    await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
    await prisma.user.delete({ where: { id: owner.id } });
    await prisma.$disconnect();
  }
});

test('RSS rules queue durably, deduplicate feed items, and reject unsupported network targets', async () => {
  const { addRssRule, allowedFeedUrl, parseFeed, publicFeedAddress, queueRssRun, setRssEnabled, RssConfigurationError } =
    await import('@cadencedesk/data');
  const owner = await prisma.user.create({ data: { email: 'rss-' + crypto.randomUUID() + '@example.invalid' } });
  const workspace = await createWorkspace(owner.id, 'RSS Fixture', 'UTC');
  const feed = 'https://updates.example.invalid/feed.xml';
  process.env.RSS_ALLOWED_FEEDS = feed;
  try {
    assert.throws(() => allowedFeedUrl('https://updates.example.invalid/other.xml'), RssConfigurationError);
    assert.throws(() => allowedFeedUrl('http://127.0.0.1/feed'), RssConfigurationError);
    for (const value of ['127.0.0.1', '169.254.169.254', '100.64.1.1', '192.168.0.1', '0.0.0.0', '::ffff:127.0.0.1']) {
      assert.equal(publicFeedAddress(value), false);
    }
    assert.equal(publicFeedAddress('8.8.8.8'), true);
    assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY test "entity">]><rss/>'), RssConfigurationError);
    const entries = parseFeed(`<rss version="2.0"><channel>
      <item><guid isPermaLink="false">id-1</guid><title>Studio launch</title><description><![CDATA[<p>Details</p>]]></description><link>https://example.invalid/studio</link></item>
      <item><guid>id-2</guid><title>Studio hours</title></item>
    </channel></rss>`);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].content, 'Studio launch\n\nDetails\n\nhttps://example.invalid/studio');

    await addRssRule(owner.id, workspace.slug, 'Industry feed', feed);
    const rule = await prisma.rssRule.findUniqueOrThrow({ where: { workspaceId_sourceUrl: { workspaceId: workspace.id, sourceUrl: feed } } });
    await queueDueRssRules();
    const first = await prisma.rssRun.findFirstOrThrow({ where: { ruleId: rule.id } });
    assert.equal(await recordFeedItems(first.id, entries), 2);
    // Move the prior run out of the current window before requesting another run.
    await prisma.rssRun.update({ where: { id: first.id }, data: { bucket: new Date(Date.now() - 20 * 60_000) } });
    await Promise.all([queueRssRun(owner.id, workspace.slug, rule.id), queueRssRun(owner.id, workspace.slug, rule.id)]);
    const retry = await prisma.rssRun.findFirstOrThrow({ where: { ruleId: rule.id, state: 'QUEUED' } });
    assert.equal(await recordFeedItems(retry.id, entries), 0);
    assert.equal(await prisma.post.count({ where: { workspaceId: workspace.id, state: 'DRAFT' } }), 2);
    assert.equal(await prisma.feedImport.count({ where: { ruleId: rule.id } }), 2);

    const pending = await prisma.rssRun.create({ data: { ruleId: rule.id, bucket: new Date(0) } });
    await setRssEnabled(owner.id, workspace.slug, rule.id, false);
    await importRssRun(pending.id);
    assert.equal((await prisma.rssRun.findUniqueOrThrow({ where: { id: pending.id } })).state, 'SKIPPED');
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { id: owner.id } });
    await prisma.$disconnect();
  }
});

test('webhook pause and secret rotation protect queued deliveries and preserve history', async () => {
  const {
    addWebhook, enqueuePublishedWebhooks, listWebhooks, rotateWebhookSecret, setWebhookEnabled,
    WebhookConfigurationError, webhookEndpoint, webhookSignature, WorkspaceAccessError,
  } = await import('@cadencedesk/data');
  const owner = await prisma.user.create({ data: { email: 'webhook-' + crypto.randomUUID() + '@example.invalid' } });
  const workspace = await createWorkspace(owner.id, 'Webhook Gates', 'UTC');
  const other = await createWorkspace(owner.id, 'Other Webhooks', 'UTC');
  process.env.WEBHOOK_ALLOWED_ENDPOINTS = 'https://capture.example.invalid/receiver';
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 0x48).toString('base64');
  try {
    assert.throws(() => webhookEndpoint('https://capture.example.invalid/other'), WebhookConfigurationError);
    const { id, secret } = await addWebhook(owner.id, workspace.slug, 'Capture fixture', process.env.WEBHOOK_ALLOWED_ENDPOINTS);
    const rotated = await rotateWebhookSecret(owner.id, workspace.slug, id);
    assert.notEqual(rotated, secret);
    const saved = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id } });
    assert.ok(!saved.signingSecret.includes(rotated));
    const event = {
      workspaceId: workspace.id, postId: crypto.randomUUID(), destinationId: crypto.randomUUID(),
      channelId: crypto.randomUUID(), provider: 'telegram', externalId: '75', permalink: null,
    };
    await Promise.all([
      prisma.$transaction((tx) => enqueuePublishedWebhooks(tx, event)),
      prisma.$transaction((tx) => enqueuePublishedWebhooks(tx, event)),
    ]);
    assert.equal(await prisma.webhookDelivery.count({ where: { subscriptionId: id } }), 1);

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { subscriptionId: id } });
    const timestamp = '1000';
    const expected = createHmac('sha256', rotated).update(timestamp + '.' + delivery.id + '.' + delivery.body).digest('hex');
    const input = { workspaceId: workspace.id, subscriptionId: id, signingSecret: saved.signingSecret,
      deliveryId: delivery.id, timestamp, body: delivery.body };
    assert.equal(webhookSignature(input), expected);
    assert.throws(() => webhookSignature({ ...input, workspaceId: other.id }), WebhookConfigurationError);
    await assert.rejects(setWebhookEnabled(owner.id, other.slug, id, false), WorkspaceAccessError);
    await setWebhookEnabled(owner.id, workspace.slug, id, false);
    const [subscription] = await listWebhooks(owner.id, workspace.slug);
    assert.equal(subscription.deliveries[0].state, 'SKIPPED');
    assert.equal(subscription.deliveries[0].attemptsCount, 0);
    assert.ok(!Object.hasOwn(subscription, 'signingSecret'));
    const outcome = await deliverWebhook(delivery.id, async () => {
      throw new Error('Paused delivery must not send');
    });
    assert.equal(outcome, null);
    await setWebhookEnabled(owner.id, workspace.slug, id, true);
    assert.equal((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).state, 'SKIPPED');

    const interrupted = { ...event, destinationId: crypto.randomUUID() };
    await prisma.$transaction((tx) => enqueuePublishedWebhooks(tx, interrupted));
    const running = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: interrupted.destinationId } });
    await prisma.webhookDelivery.update({
      where: { id: running.id },
      data: {
        state: 'SENDING', attemptsCount: 1, leasedUntil: new Date(0),
        attempts: { create: { number: 1, state: 'SENDING' } },
      },
    });
    await deliverWebhook(running.id, async (_endpoint, headers) => {
      assert.equal(headers['X-Superstar-Delivery'], running.id);
      return { statusCode: 204 };
    });
    const recovered = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: running.id }, include: { attempts: { orderBy: { number: 'asc' } } },
    });
    assert.equal(recovered.state, 'DELIVERED');
    assert.deepEqual(recovered.attempts.map(({ state }) => state), ['FAILED', 'DELIVERED']);
  } finally {
    await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
    await prisma.user.delete({ where: { id: owner.id } });
    await prisma.$disconnect();
  }
});

test('the media queue clips a real MP4 and the transcription job captures its credit reservation', { timeout: 180_000 }, async () => {
  const {
    CreditBalanceError, queueClip, queueTranscription, readVideo, saveStudioVideo, studioHistory, WorkspaceAccessError,
  } = await import('@cadencedesk/data');
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, readFile, rm, rmdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { processMediaClip } = await import('../dist/clip.js');
  const directory = await mkdtemp(join(tmpdir(), 'cadencedesk-studio-test-'));
  const sample = join(directory, 'sample.mp4');
  const { owner, workspace } = await createFixture();
  const other = await createWorkspace(owner.id, 'Other Video Workspace', 'UTC');
  const storage = await startObjectStorage();
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    MEDIA_CLIPPING_ENABLED: 'true', OPENAI_API_KEY: 'fixture-transcription-key',
    OPENAI_TRANSCRIBE_MODEL: 'fixture-transcribe', AI_TRANSCRIBE_BASE_CREDITS: '2', AI_CREDIT_MARKUP: '2',
    AI_STARTER_CREDITS: '4',
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href !== 'https://api.openai.com/v1/audio/transcriptions') return originalFetch(input, init);
    assert.equal(init.headers.Authorization, 'Bearer fixture-transcription-key');
    assert.equal(init.body.get('model'), 'fixture-transcribe');
    assert.equal(init.body.get('response_format'), 'json');
    const file = init.body.get('file');
    assert.equal(file.type, 'video/mp4');
    assert.equal(file.name, 'workspace-video.mp4');
    assert.ok(file.size > 16);
    return Response.json({ text: 'The studio opens on Tuesday.' }, { headers: { 'x-request-id': 'transcript-fixture' } });
  };

  let env;
  let mediaWorker;
  let mediaRun;
  try {
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=lime:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '4', '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', '-movflags', '+faststart', sample,
    ], { timeout: 30_000, windowsHide: true });
    const bytes = Uint8Array.from(await readFile(sample));
    const asset = await saveStudioVideo(owner.id, workspace.slug, 'studio-source.mp4', bytes);
    assert.equal(asset.type, 'video/mp4');
    await assert.rejects(queueClip(owner.id, other.slug, asset.id, 0, 1), WorkspaceAccessError);
    await assert.rejects(queueClip(owner.id, workspace.slug, asset.id, 0, 61), WorkspaceAccessError);
    const clip = await queueClip(owner.id, workspace.slug, asset.id, 1, 2);
    const outOfRange = await queueClip(owner.id, workspace.slug, asset.id, 4, 2);
    const transcription = await queueTranscription(owner.id, workspace.slug, asset.id, 4);
    await assert.rejects(queueTranscription(owner.id, workspace.slug, asset.id, 4), CreditBalanceError);

    env = await TestWorkflowEnvironment.createLocal();
    mediaWorker = await Worker.create({
      connection: env.nativeConnection, taskQueue: 'cadencedesk-media', activities: { processMediaClip },
      maxConcurrentActivityTaskExecutions: 1,
    });
    mediaRun = mediaWorker.run();
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: 'cadencedesk',
      workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
      activities: { runAiJob },
    });
    await worker.runUntil(async () => {
      await dispatchAiJobs(env.client);
      await Promise.all([clip, outOfRange, transcription].map(({ id }) => env.client.workflow.getHandle('ai-' + id).result()));
    });

    const output = await prisma.aiJob.findUniqueOrThrow({ where: { id: clip.id }, include: { asset: true } });
    assert.equal(output.state, 'SUCCEEDED');
    assert.equal(output.credits, 0);
    assert.equal(output.asset.type, 'video/mp4');
    const clipBytes = await readVideo(output.asset, workspace.id);
    assert.equal(Buffer.from(clipBytes.subarray(4, 8)).toString(), 'ftyp');
    const rejected = await prisma.aiJob.findUniqueOrThrow({ where: { id: outOfRange.id } });
    assert.equal(rejected.state, 'FAILED');
    assert.match(rejected.error, /exceeds the duration/);
    const transcript = await prisma.aiJob.findUniqueOrThrow({ where: { id: transcription.id } });
    assert.equal(transcript.state, 'SUCCEEDED');
    assert.equal(transcript.outputText, 'The studio opens on Tuesday.');
    assert.equal(transcript.providerRef, 'transcript-fixture');
    assert.equal(await prisma.creditEntry.count({ where: { workspaceId: workspace.id } }), 3);
    const studio = await studioHistory(owner.id, workspace.slug);
    assert.equal(studio.available, 0);
    assert.equal(studio.videos.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    try {
      if (mediaWorker?.getState() === 'RUNNING') mediaWorker.shutdown();
      await mediaRun;
      await env?.teardown();
    } finally {
      await new Promise((resolve) => storage.close(resolve));
      await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.$disconnect();
      await rm(sample, { force: true });
      await rmdir(directory);
    }
  }
});

test('an approved Discord follow-up waits for a confirmed parent and sends once', async () => {
  const { ProviderConfigurationError } = await import('@cadencedesk/data');
  const { owner, workspace } = await createFixture();
  const originalFetch = globalThis.fetch;
  const replies = [];
  const parentMessage = '123456789012345679';
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, 'https://discord.com');
    const body = JSON.parse(init.body);
    if (body.message_reference) {
      replies.push(body);
      return Response.json({ id: '123456789012345680' });
    }
    if (url.pathname.includes(ids.bad)) return Response.json({}, { status: 403 });
    return Response.json({ id: parentMessage });
  };
  try {
    const [good, bad, slack] = await Promise.all([
      prisma.channel.create({ data: {
        workspaceId: workspace.id, provider: 'discord', externalId: ids.good, guildId: ids.guild, name: 'primary',
      } }),
      prisma.channel.create({ data: {
        workspaceId: workspace.id, provider: 'discord', externalId: ids.bad, guildId: ids.guild, name: 'denied',
      } }),
      prisma.channel.create({ data: {
        workspaceId: workspace.id, provider: 'slack', externalId: 'C000000001', name: 'slack',
      } }),
    ]);
    const draft = await savePost(owner.id, workspace.slug, 'Original announcement', undefined, undefined, undefined, {
      text: 'First follow-up draft', delayMinutes: 1,
    });
    await assert.rejects(transitionPost(owner.id, workspace.slug, draft.id, 1, 'IN_REVIEW', [slack.id]), ProviderConfigurationError);
    const targets = [good.id, bad.id];
    await transitionPost(owner.id, workspace.slug, draft.id, 1, 'IN_REVIEW', targets);
    await transitionPost(owner.id, workspace.slug, draft.id, 1, 'APPROVED');
    await savePost(owner.id, workspace.slug, 'Original announcement', draft.id, 1, undefined, {
      text: 'Approved follow-up', delayMinutes: 1,
    });
    await assert.rejects(schedulePost(owner.id, workspace.slug, draft.id, 1, targets, new Date()));
    await transitionPost(owner.id, workspace.slug, draft.id, 2, 'IN_REVIEW', targets);
    await transitionPost(owner.id, workspace.slug, draft.id, 2, 'APPROVED');
    await schedulePost(owner.id, workspace.slug, draft.id, 2, targets, new Date());
    const root = await prisma.destination.findMany({ where: { postId: draft.id, parentId: null } });
    await Promise.all(root.map(({ id }) => publishDestination(id)));
    const followUps = await prisma.destination.findMany({
      where: { postId: draft.id, parentId: { not: null } },
      include: { parent: true, outbox: true },
    });
    assert.equal(followUps.length, 1);
    const [followUp] = followUps;
    assert.equal(followUp.parent.channelId, good.id);
    assert.equal(followUp.parent.externalId, parentMessage);
    assert.ok(followUp.outbox.dueAt.getTime() - Date.now() > 50_000);
    assert.ok(await publishDestination(followUp.id) > 0);
    assert.equal(replies.length, 0);

    // Move the fixture clock forward without a real-time minute wait.
    await prisma.destination.update({
      where: { id: followUp.id }, data: { notBefore: new Date(0), outbox: { update: { dueAt: new Date(0) } } },
    });
    await Promise.all([publishDestination(followUp.id), publishDestination(followUp.id)]);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, 'Approved follow-up');
    assert.equal(replies[0].message_reference.message_id, parentMessage);
    assert.equal(replies[0].message_reference.fail_if_not_exists, true);
    assert.equal(replies[0].allowed_mentions.replied_user, false);
    assert.equal((await prisma.destination.findUniqueOrThrow({ where: { id: followUp.id } })).state, 'PUBLISHED');
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { id: owner.id } });
    await prisma.$disconnect();
  }
});

test('review-gated RSS schedules once after approval and waits when no shared slot exists', async () => {
  const { addRssRule, savePostingSlot, scheduleReviewedRssImports, WorkspaceAccessError } = await import('@cadencedesk/data');
  const { owner, workspace } = await createFixture();
  const reviewer = await prisma.user.create({ data: { email: 'rss-review-' + crypto.randomUUID() + '@example.invalid' } });
  const feed = 'https://studio.example.invalid/feed.xml';
  process.env.RSS_ALLOWED_FEEDS = feed;
  try {
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: reviewer.id, role: 'REVIEWER' } });
    const channel = await prisma.channel.create({ data: {
      workspaceId: workspace.id, provider: 'discord', externalId: ids.good, guildId: ids.guild, name: 'announcements',
    } });
    await assert.rejects(addRssRule(reviewer.id, workspace.slug, 'News', feed, [channel.id]), WorkspaceAccessError);
    await addRssRule(owner.id, workspace.slug, 'Reviewed news', feed, [channel.id]);
    const rule = await prisma.rssRule.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    const run = await prisma.rssRun.create({ data: { ruleId: rule.id, bucket: new Date() } });
    await recordFeedItems(run.id, [{ sourceKey: 'fixture-rss-item', content: 'The spring catalogue is ready.' }]);
    const imported = await prisma.post.findFirstOrThrow({ where: { workspaceId: workspace.id }, include: { revisions: true } });
    assert.equal(imported.state, 'IN_REVIEW');
    assert.deepEqual(imported.revisions[0].channelIds, [channel.id]);
    await scheduleReviewedRssImports();
    assert.equal(await prisma.destination.count({ where: { postId: imported.id } }), 0);

    await transitionPost(reviewer.id, workspace.slug, imported.id, 1, 'APPROVED');
    await scheduleReviewedRssImports();
    const blocked = await prisma.feedImport.findFirstOrThrow({ where: { postId: imported.id } });
    assert.equal(blocked.scheduleState, 'BLOCKED');
    assert.match(blocked.scheduleError, /No shared posting slot/);
    await savePostingSlot(owner.id, workspace.slug, channel.id, 1, 9 * 60);
    await prisma.feedImport.updateMany({ where: { postId: imported.id }, data: { nextScheduleAt: new Date(0) } });
    await scheduleReviewedRssImports();
    await scheduleReviewedRssImports();
    const result = await prisma.post.findUniqueOrThrow({
      where: { id: imported.id },
      include: { destinations: { include: { outbox: true } }, feedImports: true },
    });
    assert.equal(result.state, 'SCHEDULED');
    assert.equal(result.destinations.length, 1);
    assert.equal(result.destinations[0].outbox.dueAt.getTime(), result.scheduledAt.getTime());
    assert.equal(result.feedImports[0].scheduleState, 'SCHEDULED');
    assert.equal((await prisma.approval.findFirstOrThrow({ where: { postId: imported.id } })).reviewerId, reviewer.id);
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, reviewer.id] } } });
    await prisma.$disconnect();
  }
});
