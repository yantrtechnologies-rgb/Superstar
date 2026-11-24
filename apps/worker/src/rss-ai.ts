import { AssetStorageError, aiProvider, aiQuote, getProvider, prisma, ProviderConfigurationError, uploadImage, validateProviderPost } from '@cadencedesk/data';
import { geminiImage, geminiWrite } from './gemini';
import { AiProviderError } from './openai';

/**
 * RSS rules with an AI topic: each new feed item is judged against the topic. Relevant items are rewritten as a
 * ready-to-review post (optionally with a generated image) plus suggestions for the reviewer. Nothing is published
 * until someone approves the post.
 */

/** How many new items per feed check go through AI (keeps credit use predictable). */
export function aiItemsPerCheck() {
  const value = Number(process.env.RSS_AI_ITEMS_PER_CHECK ?? 3);
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : 3;
}

type Rule = {
  id: string; workspaceId: string; channelIds: string[]; publishAfterApproval: boolean;
  aiTopic: string | null; aiInstructions: string | null; aiImage: boolean;
};
type Item = { ruleId: string; sourceKey: string; sourceText: string | null; title: string | null };

type Answer = { relevant: boolean; reason: string; post: string; suggestions: string[]; imagePrompt: string };

const str = (value: unknown, limit: number) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

/** Reads the model's JSON answer (tolerating code fences or text around it). */
function parseAnswer(text: string): Answer | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof value.relevant !== 'boolean') return null;
    return {
      relevant: value.relevant, reason: str(value.reason, 600), post: str(value.post, 5000), imagePrompt: str(value.imagePrompt, 1500),
      suggestions: Array.isArray(value.suggestions) ? value.suggestions.map((tip) => str(tip, 400)).filter(Boolean).slice(0, 8) : [],
    };
  } catch {
    return null;
  }
}

async function reserve(workspaceId: string, reference: string, credits: number) {
  if (!credits) return true;
  return prisma.$transaction(async (tx) => {
    if (!await tx.creditAccount.findUnique({ where: { workspaceId }, select: { workspaceId: true } })) return false;
    const created = await tx.creditEntry.createMany({
      data: [{ workspaceId, kind: 'RESERVE', delta: -credits, reference }], skipDuplicates: true,
    });
    if (created.count === 0) return true; // already reserved by an earlier attempt
    const taken = await tx.creditAccount.updateMany({
      where: { workspaceId, available: { gte: credits } }, data: { available: { decrement: credits } },
    });
    if (!taken.count) throw new NotEnoughCredits();
    return true;
  }).catch((error: unknown) => {
    if (error instanceof NotEnoughCredits) return false;
    throw error;
  });
}
class NotEnoughCredits extends Error {}

async function refund(workspaceId: string, reference: string, credits: number) {
  if (!credits) return;
  await prisma.$transaction(async (tx) => {
    const created = await tx.creditEntry.createMany({
      data: [{ workspaceId, kind: 'REFUND', delta: credits, reference }], skipDuplicates: true,
    });
    if (created.count) await tx.creditAccount.update({ where: { workspaceId }, data: { available: { increment: credits } } });
  });
}

function setItem(item: Item, data: { aiState: string; aiNote?: string | null; postId?: string; scheduleState?: 'WAITING_REVIEW' | 'OFF' }) {
  return prisma.feedImport.update({
    where: { ruleId_sourceKey: { ruleId: item.ruleId, sourceKey: item.sourceKey } },
    data: { ...data, sourceText: data.aiState === 'PENDING' || data.aiState === 'WRITING' ? undefined : null },
  });
}

export async function writeRssAiPosts(runId: string) {
  const run = await prisma.rssRun.findUnique({ where: { id: runId }, include: { rule: { include: { workspace: { select: { name: true } } } } } });
  if (!run?.rule.enabled || !run.rule.aiTopic) return;
  const items = await prisma.feedImport.findMany({
    // WRITING items are ones an interrupted attempt started; they are picked up again (credits are never charged twice).
    where: { ruleId: run.ruleId, aiState: { in: ['PENDING', 'WRITING'] } }, orderBy: { importedAt: 'asc' }, take: aiItemsPerCheck(),
    select: { ruleId: true, sourceKey: true, sourceText: true, title: true },
  });
  for (const item of items) await writeOne(run.rule, run.rule.workspace.name, item);
}

async function writeOne(rule: Rule, brand: string, item: Item) {
  const text = item.sourceText?.trim();
  if (!text) return setItem(item, { aiState: 'FAILED', aiNote: 'The feed item had no text to work from.' });
  const textQuote = aiQuote('TEXT');
  const imageQuote = rule.aiImage ? aiQuote('IMAGE') : null;
  if (aiProvider() !== 'gemini' || !textQuote) {
    return setItem(item, { aiState: 'FAILED', aiNote: 'The AI writer needs Gemini to be configured by the operator.' });
  }
  const reference = `rss-ai:${rule.id}:${item.sourceKey}`;
  const cost = textQuote.credits + (imageQuote?.credits ?? 0);
  // Claim the item so only one run ever works on it (a scheduled check and "Run now" can overlap). A claim older
  // than 10 minutes belongs to a run that died and may be taken over. Shown as "Writing" on the Automations page.
  const claimed = await prisma.feedImport.updateMany({
    where: {
      ruleId: item.ruleId, sourceKey: item.sourceKey,
      OR: [
        { aiState: 'PENDING' },
        { aiState: 'WRITING', OR: [{ aiClaimedAt: null }, { aiClaimedAt: { lt: new Date(Date.now() - 10 * 60_000) } }] },
      ],
    },
    data: { aiState: 'WRITING', aiClaimedAt: new Date(), aiNote: null },
  });
  if (!claimed.count) return;
  if (!await reserve(rule.workspaceId, reference, cost)) {
    // Back to pending: the next check (or Run now) retries once credits are added.
    return prisma.feedImport.update({
      where: { ruleId_sourceKey: { ruleId: item.ruleId, sourceKey: item.sourceKey } },
      data: { aiState: 'PENDING', aiClaimedAt: null, aiNote: `Waiting for AI credits (${cost} needed). Buy credits on the Billing page.` },
    });
  }

  const channels = await prisma.channel.findMany({
    where: { workspaceId: rule.workspaceId, id: { in: rule.channelIds } }, select: { id: true, provider: true, name: true },
  });
  const networks = [...new Set(channels.map(({ provider }) => getProvider(provider)?.name ?? provider))].join(', ') || 'Facebook Page';
  const system = [
    `You are the social media strategist for "${brand}". Their focus topic is: ${rule.aiTopic}.`,
    rule.aiInstructions ? `Brand and tone guidance from the client: ${rule.aiInstructions}` : '',
    'You receive one item from a news or blog feed. Decide whether it is genuinely useful for this brand\'s audience and clearly about the focus topic.',
    `If it is, write an original post for: ${networks}. Rules for the post: a strong first line, 2 to 4 short paragraphs, plain text (no markdown, no asterisks),`,
    'a clear takeaway or question for the audience, 3 to 5 relevant hashtags at the end, and the source link on its own line before the hashtags.',
    'Stay under 1,200 characters. Do not invent facts beyond the item; do not copy its sentences.',
    'Reply with JSON only, no other text: {"relevant": true|false, "reason": "one sentence", "post": "...", ',
    '"suggestions": ["3 to 5 short tips for the reviewer: why this matters to the audience, best day/time to post, an alternative angle or hook, a call-to-action idea"], ',
    '"imagePrompt": "a description of an eye-catching square image for the post, no words or logos in the image"}.',
    'If it is not relevant, set relevant to false, give the reason, and leave the other fields empty.',
  ].filter(Boolean).join('\n');

  let result: Answer | null = null;
  try {
    const input = `Feed item:\n${text.slice(0, 6000)}`;
    result = parseAnswer((await geminiWrite(textQuote.model, system, input, 3000)).text);
    // Occasionally the model wraps or cuts off its JSON; one stricter retry fixes nearly all of these.
    if (!result) result = parseAnswer((await geminiWrite(textQuote.model, `${system}\nIMPORTANT: output one valid JSON object only, nothing else.`, input, 3000)).text);
  } catch (error) {
    if (!(error instanceof AiProviderError)) throw error;
    await refund(rule.workspaceId, `${reference}:refund`, cost);
    return setItem(item, { aiState: 'FAILED', aiNote: error.message });
  }
  if (!result) {
    await refund(rule.workspaceId, `${reference}:refund`, cost);
    return setItem(item, { aiState: 'FAILED', aiNote: 'The AI answer could not be read. Use Run now to try again later.' });
  }
  if (!result.relevant || !result.post.trim()) {
    await refund(rule.workspaceId, `${reference}:refund`, imageQuote?.credits ?? 0);
    return setItem(item, { aiState: 'SKIPPED', aiNote: `Not on topic: ${result.reason || 'the AI judged it unrelated.'}`.slice(0, 600) });
  }

  // Optional image. If it fails, the post is still created without one and the image credits are returned.
  let assetId: string | null = null;
  let imageNote = '';
  if (imageQuote) {
    try {
      const image = await geminiImage(imageQuote.model, result.imagePrompt || `Illustration for a social post about: ${item.title ?? rule.aiTopic}`);
      const stored = await uploadImage(rule.workspaceId, image.image);
      const asset = await prisma.asset.create({ data: { workspaceId: rule.workspaceId, ...stored, label: (item.title ?? 'AI image').slice(0, 80) } });
      assetId = asset.id;
    } catch (error) {
      if (!(error instanceof AiProviderError || error instanceof AssetStorageError)) throw error;
      await refund(rule.workspaceId, `${reference}:image-refund`, imageQuote.credits);
      imageNote = 'The image could not be generated (credits returned); add one before posting to Instagram.';
    }
  }

  const content = result.post.trim();
  // ready = the rule's channels can take this post as written. Either way the post waits for approval; without
  // channels the reviewer picks them when scheduling.
  let ready = channels.length > 0 && channels.length === rule.channelIds.length;
  for (const channel of channels) {
    try {
      validateProviderPost(channel.provider, content, assetId ? 'image/jpeg' : undefined);
    } catch (error) {
      if (!(error instanceof ProviderConfigurationError)) throw error;
      ready = false;
      imageNote ||= `${channel.name}: ${error.message}`;
    }
  }
  const note = [
    item.title ? `Source: ${item.title}` : '',
    result.reason ? `Why it fits: ${result.reason}` : '',
    ...result.suggestions.map((tip) => `• ${tip}`),
    imageNote,
  ].filter(Boolean).join('\n');

  await prisma.$transaction(async (tx) => {
    const current = await tx.feedImport.findUnique({ where: { ruleId_sourceKey: { ruleId: item.ruleId, sourceKey: item.sourceKey } } });
    if (current?.aiState !== 'WRITING') return; // another attempt already finished it
    const post = await tx.post.create({
      data: {
        workspaceId: rule.workspaceId, state: 'IN_REVIEW', aiNote: note.slice(0, 4000),
        revisions: { create: { number: 1, content, channelIds: ready ? rule.channelIds : [], mediaIds: assetId ? [assetId] : [] } },
      },
    });
    await tx.feedImport.update({
      where: { ruleId_sourceKey: { ruleId: item.ruleId, sourceKey: item.sourceKey } },
      data: {
        aiState: 'DONE', aiNote: null, sourceText: null, postId: post.id,
        scheduleState: rule.publishAfterApproval && ready ? 'WAITING_REVIEW' : 'OFF',
      },
    });
    await tx.creditEntry.createMany({
      data: [{ workspaceId: rule.workspaceId, kind: 'CAPTURE', delta: 0, reference: `${reference}:capture` }], skipDuplicates: true,
    });
  });
}
