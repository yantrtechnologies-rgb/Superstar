'use server';

import { addRssRule, feedPresets, queueRssRun, setAllRssEnabled, RssConfigurationError, setRssEnabled, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '../../../../lib/require-user';

async function perform(form: FormData, success: string, command: (actor: string, workspace: string) => Promise<unknown>) {
  const user = await requireUser();
  const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  let status = success;
  try {
    await command(user.id, workspace.data);
  } catch (error) {
    if (error instanceof RssConfigurationError) status = 'allowlist';
    else if (error instanceof z.ZodError || error instanceof WorkspaceAccessError) status = 'invalid';
    else throw error;
  }
  redirect(`/app/${workspace.data}/automations?status=${status}`);
}

/** Thrown to show a specific message on the Automations page. */
class FeedChoiceError extends Error {}

export async function addFeedAction(form: FormData) {
  const user = await requireUser();
  const workspace = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(form.get('workspace'));
  if (!workspace.success) redirect('/app');
  let status = 'saved';
  try {
    const topic = z.string().trim().min(2).max(300).parse(form.get('aiTopic'));
    const chosen = feedPresets.filter(({ id }) => form.getAll('preset').includes(id));
    const custom = form.get('useCustom') === 'yes' ? z.string().trim().max(2048).parse(form.get('url') ?? '') : '';
    if (form.get('useCustom') === 'yes' && !custom) throw new FeedChoiceError('no-custom');
    if (!chosen.length && !custom) throw new FeedChoiceError('no-feed');
    const channels = z.array(z.uuid()).max(20).parse(form.getAll('channel'));
    const ai = {
      topic,
      instructions: z.string().trim().max(1500).parse(form.get('aiInstructions') ?? ''),
      image: form.get('aiImage') === 'yes',
      autoSchedule: form.get('publishAfterApproval') === 'yes',
    };
    // Google/Bing searches use a short form of the topic; the full topic still guides the AI filter.
    const query = topic.slice(0, 120);
    const short = topic.length > 40 ? topic.slice(0, 40) + '…' : topic;
    const feeds = [
      ...chosen.map((preset) => ({ name: `${preset.name}: ${short}`, url: preset.url(query) })),
      ...(custom ? [{ name: `My feed: ${short}`, url: custom }] : []),
    ];
    for (const feed of feeds) await addRssRule(user.id, workspace.data, feed.name.slice(0, 80), feed.url, channels, ai);
  } catch (error) {
    if (error instanceof FeedChoiceError) status = error.message;
    else if (error instanceof RssConfigurationError) status = 'allowlist';
    else if (error instanceof z.ZodError || error instanceof WorkspaceAccessError) status = 'invalid';
    else throw error;
  }
  redirect(`/app/${workspace.data}/automations?status=${status}`);
}

export async function toggleFeedAction(form: FormData) {
  await perform(form, 'saved', (actor, workspace) => setRssEnabled(
    actor, workspace, z.uuid().parse(form.get('id')), z.enum(['yes', 'no']).parse(form.get('enabled')) === 'yes',
  ));
}

export async function runFeedAction(form: FormData) {
  await perform(form, 'queued', (actor, workspace) => queueRssRun(actor, workspace, z.uuid().parse(form.get('id'))));
}

export async function stopAllFeedsAction(form: FormData) {
  await perform(form, 'stopped', (actor, workspace) => setAllRssEnabled(actor, workspace, false));
}

export async function resumeAllFeedsAction(form: FormData) {
  await perform(form, 'resumed', (actor, workspace) => setAllRssEnabled(actor, workspace, true));
}
