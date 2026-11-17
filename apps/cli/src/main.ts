#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CadenceDeskApiError, clientFromEnvironment, type DraftInput, type ScheduleInput } from '@cadencedesk/sdk';

const help = `CadenceDesk CLI

Usage:
  cadencedesk channels [--limit N] [--offset N]
  cadencedesk posts [--limit N] [--offset N]
  cadencedesk post --id POST_ID
  cadencedesk draft (--content TEXT | --file PATH) [--idempotency-key UUID]
  cadencedesk review --id POST_ID --revision N --channel CHANNEL_ID [...]
  cadencedesk schedule --id POST_ID --revision N --channel CHANNEL_ID [...] (--now | --next | --at UTC)
  cadencedesk cancel --id POST_ID

Drafts also accept --follow-up TEXT --delay-minutes N.
Set CADENCEDESK_WORKSPACE and CADENCEDESK_API_KEY in your environment.
CADENCEDESK_API_URL defaults to http://localhost:3001.`;

const identity = { id: { type: 'string' } } as const;
const revision = { ...identity, revision: { type: 'string' }, channel: { type: 'string', multiple: true } } as const;
const paging = { limit: { type: 'string' }, offset: { type: 'string' } } as const;

class UsageError extends Error {}

function required(value: string | undefined, flag: string) {
  if (!value?.trim()) throw new UsageError(`Pass --${flag}.`);
  return value;
}

function maybeNumber(value: string | undefined) {
  return value === undefined ? undefined : Number(value);
}

async function draftText(content: string | undefined, file: string | undefined) {
  if (Boolean(content) === Boolean(file)) throw new UsageError('Pass either --content or --file.');
  if (content) return content;
  const path = required(file, 'file');
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 16_384) throw new Error('Invalid draft file');
    return await readFile(path, 'utf8');
  } catch {
    throw new UsageError('Choose a readable text file up to 16 KiB.');
  }
}

function parseRevision(values: { revision?: string; channel?: string[] }) {
  if (!values.channel?.length) throw new UsageError('Pass --channel for each destination.');
  return { revision: Number(required(values.revision, 'revision')), channelIds: values.channel };
}

async function run(args: string[]) {
  const [command, ...options] = args;
  if (!command || command === '--help' || command === 'help' || options.includes('--help')) {
    process.stdout.write(help + '\n');
    return;
  }

  const client = clientFromEnvironment();
  let output: unknown;
  switch (command) {
    case 'channels':
    case 'posts': {
      const { values } = parseArgs({ args: options, options: paging });
      const query = { limit: maybeNumber(values.limit), offset: maybeNumber(values.offset) };
      output = command === 'channels' ? await client.listChannels(query) : await client.listPosts(query);
      break;
    }
    case 'post':
    case 'cancel': {
      const { values } = parseArgs({ args: options, options: identity });
      const id = required(values.id, 'id');
      output = command === 'post' ? await client.getPost(id) : await client.cancelPost(id);
      break;
    }
    case 'draft': {
      const { values } = parseArgs({ args: options, options: {
        content: { type: 'string' }, file: { type: 'string' },
        'idempotency-key': { type: 'string' }, 'follow-up': { type: 'string' }, 'delay-minutes': { type: 'string' },
      } });
      const draft: DraftInput = { content: await draftText(values.content, values.file) };
      if (values['follow-up']) {
        draft.followUp = { text: values['follow-up'], delayMinutes: Number(required(values['delay-minutes'], 'delay-minutes')) };
      } else if (values['delay-minutes'] !== undefined) {
        throw new UsageError('A delay requires --follow-up.');
      }
      output = await client.createDraft(draft, { idempotencyKey: values['idempotency-key'] });
      break;
    }
    case 'review': {
      const { values } = parseArgs({ args: options, options: revision });
      output = await client.requestReview(required(values.id, 'id'), parseRevision(values));
      break;
    }
    case 'schedule': {
      const { values } = parseArgs({ args: options, options: {
        ...revision, now: { type: 'boolean' }, next: { type: 'boolean' }, at: { type: 'string' },
      } });
      if ([values.now, values.next, values.at !== undefined].filter(Boolean).length !== 1) {
        throw new UsageError('Choose one of --now, --next, or --at UTC.');
      }
      const targets = parseRevision(values);
      const request: ScheduleInput = values.at !== undefined
        ? { ...targets, mode: 'at', scheduledAt: values.at }
        : { ...targets, mode: values.now ? 'now' : 'next' };
      output = await client.schedulePost(required(values.id, 'id'), request);
      break;
    }
    default:
      throw new UsageError('Unknown command. Run cadencedesk --help.');
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

void run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof CadenceDeskApiError || error instanceof UsageError
    ? error.message : 'Check the command and its required arguments. Run cadencedesk --help.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
