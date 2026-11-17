#!/usr/bin/env node
import { apiChannelPage, apiPostPage, apiPostResource, createDraftInput, scheduleRevisionInput, submitRevisionInput } from '@cadencedesk/contracts';
import { CadenceDeskApiError, clientFromEnvironment, type CadenceDeskClient } from '@cadencedesk/sdk';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const page = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
});
const identity = z.strictObject({ postId: z.uuid() });
const readOnly = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

async function report<T extends Record<string, unknown>>(execute: () => Promise<T>) {
  try {
    const result = await execute();
    return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (error) {
    const message = error instanceof CadenceDeskApiError ? error.message : 'Check the tool arguments and try again.';
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}

function workspaceServer(client: CadenceDeskClient) {
  const server = new McpServer({ name: 'cadencedesk', version: '0.1.0' }, {
    instructions: 'Tools use one configured workspace. Post scheduling requires a current human approval.',
    maxToolInputElements: 1000,
  });

  server.registerTool('list_channels', {
    description: 'List channels in the configured Superstar workspace. Requires channels:read.',
    inputSchema: page, outputSchema: apiChannelPage, annotations: readOnly,
  }, (input) => report(() => client.listChannels(input)));

  server.registerTool('list_posts', {
    description: 'List posts and destination status in the configured workspace. Requires posts:read.',
    inputSchema: page, outputSchema: apiPostPage, annotations: readOnly,
  }, (input) => report(() => client.listPosts(input)));

  server.registerTool('get_post', {
    description: 'Read a post in the configured workspace by its ID. Requires posts:read.',
    inputSchema: identity, outputSchema: apiPostResource, annotations: readOnly,
  }, ({ postId }) => report(() => client.getPost(postId)));

  server.registerTool('create_draft', {
    description: 'Save a text draft for review. Reuse an idempotency key for a retry. Requires posts:write.',
    inputSchema: createDraftInput.extend({ idempotencyKey: z.uuid().optional() }),
    outputSchema: apiPostResource, annotations: write,
  }, ({ idempotencyKey, ...input }) => report(() => client.createDraft(input, { idempotencyKey })));

  server.registerTool('request_review', {
    description: 'Submit a draft revision and its selected channel IDs for human approval. Requires posts:write.',
    inputSchema: submitRevisionInput.extend({ postId: z.uuid() }),
    outputSchema: apiPostResource, annotations: write,
  }, ({ postId, ...input }) => report(() => client.requestReview(postId, input)));

  server.registerTool('schedule_post', {
    description: 'Schedule a human-approved revision for now, the next shared slot, or an explicit future UTC time. Requires posts:schedule.',
    inputSchema: submitRevisionInput.extend({
      postId: z.uuid(), mode: z.enum(['now', 'next', 'at']), scheduledAt: z.iso.datetime().optional(),
    }),
    outputSchema: apiPostResource, annotations: { ...write, openWorldHint: true },
  }, ({ postId, ...input }) => report(() => client.schedulePost(postId, scheduleRevisionInput.parse(input))));

  server.registerTool('cancel_post', {
    description: 'Cancel pending destinations and retain completed ones. Requires posts:schedule.',
    inputSchema: identity, outputSchema: apiPostResource, annotations: { ...write, destructiveHint: true },
  }, ({ postId }) => report(() => client.cancelPost(postId)));

  return server;
}

try {
  const client = clientFromEnvironment();
  const running = serveStdio(() => workspaceServer(client));
  process.once('SIGINT', () => { void running.close(); });
  process.once('SIGTERM', () => { void running.close(); });
} catch (error) {
  process.stderr.write((error instanceof CadenceDeskApiError ? error.message : 'Superstar MCP startup failed.') + '\n');
  process.exitCode = 1;
}
