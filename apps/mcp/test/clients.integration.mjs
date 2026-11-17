import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CadenceDeskApiError, CadenceDeskClient } from '@cadencedesk/sdk';
import { createApiKey, createWorkspace, prisma, savePost, transitionPost } from '@cadencedesk/data';
import { startApi } from '../../api/test/api-fixture.mjs';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../../cli/dist/main.js', import.meta.url));
const mcpEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url));

async function openMcp(env) {
  const client = new Client({ name: 'cadencedesk-integration-test', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpEntry], env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

test('SDK, CLI and MCP share workspace access and the human approval gate', { timeout: 45_000 }, async () => {
  const run = randomUUID();
  const owner = await prisma.user.create({ data: { email: `clients-owner-${run}@example.invalid` } });
  const outside = await prisma.user.create({ data: { email: `clients-other-${run}@example.invalid` } });
  const workspace = await createWorkspace(owner.id, 'Developer Studio', 'UTC');
  const other = await createWorkspace(outside.id, 'Private Studio', 'UTC');
  let service;
  let agent;
  let readAgent;
  try {
    service = await startApi(100);
    const channel = await prisma.channel.create({ data: {
      workspaceId: workspace.id, provider: 'discord', name: 'studio-news',
      externalId: '123456789012345671', guildId: '123456789012345670',
    } });
    const otherPost = await savePost(outside.id, other.slug, 'Private second workspace content.');
    const token = await createApiKey(owner.id, workspace.slug, 'Developer clients', 30,
      ['channels:read', 'posts:read', 'posts:write', 'posts:schedule']);
    const readOnly = await createApiKey(owner.id, workspace.slug, 'Read-only agent', 30, ['posts:read']);
    const env = {
      CADENCEDESK_API_URL: service.baseUrl.href,
      CADENCEDESK_WORKSPACE: workspace.slug,
      CADENCEDESK_API_KEY: token,
    };
    const sdk = new CadenceDeskClient({ apiUrl: service.baseUrl.href, workspace: workspace.slug, apiKey: token });
    const wrongWorkspace = new CadenceDeskClient({ apiUrl: service.baseUrl.href, workspace: other.slug, apiKey: token });
    const cli = (args) => exec(process.execPath, [cliEntry, ...args], { env: { ...process.env, ...env }, windowsHide: true });

    assert.equal((await sdk.listChannels()).items[0].id, channel.id);
    await assert.rejects(wrongWorkspace.listPosts(), (error) => error instanceof CadenceDeskApiError && error.status === 401);
    const idempotencyKey = randomUUID();
    const draft = await sdk.createDraft({ content: 'Draft created through the typed SDK.' }, { idempotencyKey });
    assert.equal((await sdk.createDraft({ content: 'Draft created through the typed SDK.' }, { idempotencyKey })).id, draft.id);

    const fromCli = await cli(['post', '--id', draft.id]);
    assert.equal(JSON.parse(fromCli.stdout).id, draft.id);
    assert.equal(fromCli.stderr, '');
    await assert.rejects(cli(['post', '--id', otherPost.id]), (error) => {
      assert.match(error.stderr, /HTTP 404/);
      assert.ok(!error.stderr.includes(token));
      return true;
    });

    agent = await openMcp(env);
    const { tools } = await agent.listTools();
    assert.ok(tools.some(({ name }) => name === 'schedule_post'));
    assert.ok(tools.some(({ name, annotations }) => name === 'get_post' && annotations.readOnlyHint));
    const leaked = await agent.callTool({ name: 'get_post', arguments: { postId: otherPost.id } });
    assert.equal(leaked.isError, true);
    assert.match(leaked.content[0].text, /HTTP 404/);

    const revision = { postId: draft.id, revision: 1, channelIds: [channel.id] };
    const review = await agent.callTool({ name: 'request_review', arguments: revision });
    assert.equal(review.structuredContent.state, 'IN_REVIEW');
    const denied = await agent.callTool({ name: 'schedule_post', arguments: { ...revision, mode: 'now' } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /HTTP 409/);
    await transitionPost(owner.id, workspace.slug, draft.id, 1, 'APPROVED');
    const queued = await cli(['schedule', '--id', draft.id, '--revision', '1', '--channel', channel.id, '--now']);
    assert.equal(JSON.parse(queued.stdout).state, 'SCHEDULED');
    assert.equal(await prisma.outboxEvent.count({ where: { destination: { postId: draft.id } } }), 1);

    readAgent = await openMcp({ ...env, CADENCEDESK_API_KEY: readOnly });
    const deniedWrite = await readAgent.callTool({ name: 'create_draft', arguments: { content: 'Outside the granted scope.' } });
    assert.equal(deniedWrite.isError, true);
    assert.match(deniedWrite.content[0].text, /HTTP 403/);
    const read = await readAgent.callTool({ name: 'get_post', arguments: { postId: draft.id } });
    assert.equal(read.structuredContent.id, draft.id);

    assert.equal((await sdk.cancelPost(draft.id)).state, 'CANCELED');
    assert.equal((await sdk.listPosts()).items.length, 1);
  } finally {
    try {
      await Promise.allSettled([agent?.close(), readAgent?.close()]);
      await service?.close();
    } finally {
      await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, outside.id] } } });
      await prisma.$disconnect();
    }
  }
});
