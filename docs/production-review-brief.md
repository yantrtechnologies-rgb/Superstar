# Superstar - production review brief

Superstar is a social media scheduling SaaS (like Buffer/Postiz) for Indian businesses, live at https://superstar.xolnet.in.

## Architecture
- Monorepo (pnpm): apps/web (Next.js 16, React 19, server actions, Auth.js), apps/api (NestJS public REST API, Redis rate limit),
  apps/worker (Temporal worker: publishing, AI jobs, RSS imports, webhooks), packages/data (Prisma 6 + business logic), apps/cli, apps/mcp.
- Hosting (AWS ap-southeast-2, single region): ONE EC2 t4g.small (2 vCPU ARM, 2 GB RAM + swap) runs everything under systemd:
  Caddy (HTTPS, Let's Encrypt) -> Next.js :3000, API :3001 (routes /api/v1/*, /api/docs), worker, Temporal CLI dev server (SQLite), Redis 6 (localhost).
- Database: Amazon RDS PostgreSQL db.t4g.micro, single-AZ, always on. Media: S3 bucket. Settings: one SSM SecureString parameter, written to an env file (chmod 600).
- Deploys: build a tarball on the developer PC -> S3 -> SSM Run Command runs deploy.sh on the server, which runs `pnpm install` + `pnpm -r build`
  ON the production server, runs `prisma migrate deploy`, swaps directories and restarts services (brief downtime each deploy).
- Integrations: Meta Graph API (Facebook Pages, Instagram), LinkedIn, X, YouTube, Telegram, Discord; Gemini (text/image/video) billed via prepaid AI credits;
  Razorpay subscriptions + payment links; Gmail SMTP for email.
- Traffic today: a handful of test users. Goal: open to paying customers soon.

## Setting names in production (values omitted)
APP_MODE, APP_URL, AUTH_SECRET, AUTH_URL, AWS_PROFILE, BILLING_EXEMPT_USERS, BILLING_EXEMPT_WORKSPACES, DATABASE_URL, EMAIL_FROM, GEMINI_API_KEY, LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_PAGES_CLIENT_ID, LINKEDIN_PAGES_CLIENT_SECRET, META_APP_ID, META_APP_SECRET, META_GRAPH_VERSION, NGROK_DOMAIN, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_PROVIDER, OBJECT_STORAGE_REGION, RAZORPAY_ALLOW_LIVE, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_PLAN_AGENCY_MONTHLY, RAZORPAY_PLAN_CREATOR_MONTHLY, RAZORPAY_PLAN_TEAM_MONTHLY, RAZORPAY_WEBHOOK_SECRET, RDS_INSTANCE_ID, RDS_REGION, RSS_ALLOWED_FEEDS, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USER, TELEGRAM_BOT_TOKEN, TELEGRAM_WORKSPACE_CHATS, TOKEN_ENCRYPTION_KEY, X_CLIENT_ID, X_CLIENT_SECRET, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_DEFAULT_PRIVACY_STATUS

## infra/aws-server/deploy.sh
```bash
#!/bin/bash
# Deploys the latest release on the Superstar server. Runs as root through Session Manager.
set -euo pipefail
REGION=ap-southeast-2
BUCKET=superstar-media-<aws-account-id>
APP=/opt/superstar/app
ENVFILE=/opt/superstar/superstar.env
export HOME=/root PATH=/usr/local/bin:$PATH

# Settings from the encrypted parameter (readable only by the superstar user).
aws ssm get-parameter --region $REGION --name /superstar/env --with-decryption --query Parameter.Value --output text > $ENVFILE.new
install -m 600 -o superstar -g superstar $ENVFILE.new $ENVFILE && rm -f $ENVFILE.new
# Server-side defaults the stored settings may not carry (a stored value always wins).
for setting in 'REDIS_URL=redis://127.0.0.1:6379' 'API_PUBLIC_URL=https://superstar.xolnet.in/api' 'RSS_ALLOWED_FEEDS=*'; do
  key=${setting%%=*}
  if ! grep -q "^$key=." $ENVFILE; then sed -i "/^$key=/d" $ENVFILE; printf '\n%s\n' "$setting" >> $ENVFILE; fi
done

# Redis for the public API's per-key rate limit. Listens on this machine only.
if ! systemctl is-active --quiet redis6 && ! systemctl is-active --quiet valkey; then
  if dnf install -y -q redis6; then systemctl enable --now redis6; else dnf install -y -q valkey && systemctl enable --now valkey; fi
fi

# Fresh copy of the code (keeps the previous build until the new one succeeds).
aws s3 cp --region $REGION s3://$BUCKET/deploy/superstar-release.tgz /tmp/superstar-release.tgz --only-show-errors
rm -rf $APP.next && mkdir -p $APP.next && tar -xzf /tmp/superstar-release.tgz -C $APP.next
chown -R superstar:superstar $APP.next
cd $APP.next
sudo -u superstar -H bash -lc "cd $APP.next && export PATH=/usr/local/bin:\$PATH && pnpm install --frozen-lockfile --config.confirmModulesPurge=false"
# Only DATABASE_URL is needed to build and migrate; the full settings file is not shell-safe (it contains <, >, spaces).
DBURL=$(grep '^DATABASE_URL=' $ENVFILE | cut -d= -f2- | sed 's/^"//; s/"$//')
sudo -u superstar -H env DATABASE_URL="$DBURL" bash -lc "cd $APP.next && export PATH=/usr/local/bin:\$PATH NODE_OPTIONS=--max-old-space-size=1536 && pnpm db:generate && pnpm -r build"
sudo -u superstar -H env DATABASE_URL="$DBURL" bash -lc "cd $APP.next/packages/data && export PATH=/usr/local/bin:\$PATH && npx prisma migrate deploy"

# Swap in the new build.
systemctl stop superstar-web superstar-api superstar-worker 2>/dev/null || true
rm -rf $APP.old; [ -d $APP ] && mv $APP $APP.old; mv $APP.next $APP

# Services.
cat > /etc/systemd/system/superstar-temporal.service <<'UNIT'
[Unit]
Description=Superstar scheduler (Temporal dev server)
After=network-online.target
[Service]
User=superstar
ExecStart=/usr/local/bin/temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-port 8233 --db-filename /opt/superstar/data/temporal.db --log-level warn
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
for svc in worker api web; do
  case $svc in
    worker) DIR=$APP/apps/worker; CMD="/usr/local/bin/node dist/main.js"; AFTER=superstar-temporal.service;;
    api)    DIR=$APP/apps/api;    CMD="/usr/local/bin/node dist/main.js"; AFTER=network-online.target;;
    web)    DIR=$APP/apps/web;    CMD="/usr/local/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000"; AFTER=network-online.target;;
  esac
  cat > /etc/systemd/system/superstar-$svc.service <<UNIT
[Unit]
Description=Superstar $svc
After=$AFTER
Wants=$AFTER
[Service]
User=superstar
WorkingDirectory=$DIR
EnvironmentFile=$ENVFILE
Environment=NODE_ENV=production API_LISTEN_HOST=127.0.0.1 PORT=$( [ $svc = api ] && echo 3001 || ([ $svc = web ] && echo 3000) || echo 3002 )
ExecStart=$CMD
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
done

# HTTPS front door. Caddy gets and renews the certificate once DNS points here.
cat > /etc/caddy/Caddyfile <<'CADDY'
superstar.xolnet.in {
  encode zstd gzip
  # Public workspace API (base URL https://superstar.xolnet.in/api). Its routes are /v1/... on the API server.
  handle /api/docs* {
    reverse_proxy 127.0.0.1:3001
  }
  handle /api/v1/* {
    uri strip_prefix /api
    reverse_proxy 127.0.0.1:3001
  }
  handle {
    reverse_proxy 127.0.0.1:3000
  }
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
  }
}
CADDY
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy HTTPS
After=network-online.target
[Service]
User=superstar
Environment=XDG_DATA_HOME=/opt/superstar/data XDG_CONFIG_HOME=/opt/superstar/data
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
Restart=always
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now superstar-temporal superstar-worker superstar-api superstar-web caddy
systemctl restart superstar-worker superstar-api superstar-web
systemctl reload caddy || systemctl restart caddy
sleep 8
for s in superstar-temporal superstar-worker superstar-api superstar-web caddy; do echo "$s: $(systemctl is-active $s)"; done
curl -s -o /dev/null -w 'web local: %{http_code}\n' http://127.0.0.1:3000/login || true
```

## apps/worker/src/workflows.ts
```ts
import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './publish';
import type * as analytics from './analytics';
import type * as ai from './ai';
import type * as rss from './rss';
import type * as rssAi from './rss-ai';

// 3 minutes: an Instagram carousel uploads and waits on up to 10 photos. Stays below the 5-minute stale-publish check.
const { publishDestination } = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 5 },
});

export async function publishAt(destinationId: string, dueAt: number) {
  await sleep(Math.max(1, dueAt - Date.now()));
  let retryDelay = await publishDestination(destinationId);
  while (retryDelay !== null) {
    await sleep(retryDelay);
    retryDelay = await publishDestination(destinationId);
  }
}

const { collectChannelMetric } = proxyActivities<typeof analytics>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 5 },
});

export async function refreshChannelMetric(jobId: string) {
  await collectChannelMetric(jobId);
}

const { runAiJob } = proxyActivities<typeof ai>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 3 } });
const { importRssRun } = proxyActivities<typeof rss>({ startToCloseTimeout: '50 seconds', retry: { maximumAttempts: 3 } });

// Video generation can take several minutes; one attempt only, so a customer is never charged twice by the provider.
const { runAiJob: runAiVideoJob } = proxyActivities<typeof ai>({ startToCloseTimeout: '15 minutes', retry: { maximumAttempts: 1 } });

export async function generateAiContent(jobId: string) {
  await runAiJob(jobId);
}

export async function generateAiVideo(jobId: string) {
  await runAiVideoJob(jobId);
}

// The AI writer handles a few items per check (text plus an optional image each); retries never double-charge.
const { writeRssAiPosts } = proxyActivities<typeof rssAi>({ startToCloseTimeout: '10 minutes', retry: { maximumAttempts: 2 } });

export async function importRssFeed(runId: string) {
  await importRssRun(runId);
  await writeRssAiPosts(runId);
}

const { deliverWebhook } = proxyActivities<{ deliverWebhook(id: string): Promise<number | null> }>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumInterval: '30 seconds' },
});

export async function deliverPublishedWebhook(id: string) {
  let delay = await deliverWebhook(id);
  while (delay !== null) {
    await sleep(delay);
    delay = await deliverWebhook(id);
  }
}

const { processMediaClip } = proxyActivities<{ processMediaClip(id: string): Promise<void> }>({
  taskQueue: 'cadencedesk-media', startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 3 },
});

export async function generateMediaClip(jobId: string) {
  await processMediaClip(jobId);
}
```

## apps/worker/src/main.ts
```ts
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { prisma, scheduleReviewedRssImports } from '@cadencedesk/data';
import { createServer } from 'node:http';
import { collectChannelMetric, dispatchAnalytics } from './analytics';
import { dispatchAiJobs, reconcileAiJobs, runAiJob } from './ai';
import { dispatchRssRuns, importRssRun, queueDueRssRules } from './rss';
import { writeRssAiPosts } from './rss-ai';
import { deliverWebhook, dispatchWebhooks } from './webhooks';
import { setTimeout } from 'node:timers/promises';
import { dispatchOutbox, publishDestination, reconcileInterrupted } from './publish';

async function dispatch(client: Client, stop: AbortSignal) {
  while (!stop.aborted) {
    try {
      await reconcileInterrupted();
      await dispatchOutbox(client);
      await dispatchAnalytics(client);
      await reconcileAiJobs();
      await dispatchAiJobs(client);
      await queueDueRssRules();
      await dispatchRssRuns(client);
      await scheduleReviewedRssImports();
      await dispatchWebhooks(client);
    } catch {
      console.error(JSON.stringify({ event: 'publishing.outbox_poll_failed' }));
    }
    try {
      await setTimeout(2000, undefined, { signal: stop });
    } catch {
      if (!stop.aborted) throw new Error('Outbox polling was interrupted');
    }
  }
}

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const connection = await NativeConnection.connect({ address });
  try {
    const clientConnection = await Connection.connect({ address });
    try {
      const client = new Client({ connection: clientConnection, namespace });
      const worker = await Worker.create({
        connection,
        namespace,
        taskQueue: 'cadencedesk',
        workflowsPath: require.resolve('./workflows'),
        activities: { publishDestination, collectChannelMetric, runAiJob, importRssRun, writeRssAiPosts, deliverWebhook },
      });
      const server = createServer((_request, response) => {
        const running = worker.getState() === 'RUNNING';
        response.writeHead(running ? 200 : 503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: running ? 'ready' : 'unavailable' }));
      });
      const stop = new AbortController();
      const polling = dispatch(client, stop.signal);
      try {
        server.listen(3002, '0.0.0.0');
        await worker.run();
      } finally {
        server.close();
        stop.abort();
        await polling;
      }
    } finally {
      await clientConnection.close();
    }
  } finally {
    await connection.close();
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ event: 'publishing.worker_stopped' }));
  process.exitCode = 1;
});
```

## apps/worker/src/rss-ai.ts
```ts
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
    where: { ruleId: run.ruleId, aiState: { in: ['PENDING', 'WRITING'] } }, orderBy: { importedAt: 'desc' }, take: aiItemsPerCheck(),
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
  if (!await reserve(rule.workspaceId, reference, cost)) {
    // Left pending: the next check (or Run now) retries once credits are added.
    return prisma.feedImport.update({
      where: { ruleId_sourceKey: { ruleId: item.ruleId, sourceKey: item.sourceKey } },
      data: { aiState: 'PENDING', aiNote: `Waiting for AI credits (${cost} needed). Buy credits on the Billing page.` },
    });
  }
  // Shown as "Writing" on the Automations page while the AI works on it.
  await setItem(item, { aiState: 'WRITING', aiNote: null });

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
    if (current?.aiState !== 'WRITING' && current?.aiState !== 'PENDING') return; // another attempt already finished it
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
```

## apps/worker/src/publish.ts
```ts
import { createHash } from 'node:crypto';
import {
  createMetaAssetUrl, enqueuePublishedWebhooks, getProvider, prisma, readImage, readVideo, revisionMediaIds, revisionOverrides,
  revisionThread, validateProviderPost, AssetStorageError, ProviderConfigurationError, type PublishingImage, type PublishResult,
} from '@cadencedesk/data';
import type { Prisma } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export async function publishDestination(id: string): Promise<number | null> {
  const now = new Date();
  const claim = await prisma.$transaction(async (tx) => {
    const changed = await tx.destination.updateMany({
      where: {
        id, state: 'SCHEDULED',
        OR: [{ notBefore: null }, { notBefore: { lte: now } }],
        post: { state: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      },
      data: { state: 'PUBLISHING', startedAt: new Date() },
    });
    if (!changed.count) return null;
    const destination = await tx.destination.findUniqueOrThrow({
      where: { id },
      include: { channel: true, parent: true, post: { include: { workspace: true } }, _count: { select: { attempts: true } } },
    });
    const [revision, approval] = await Promise.all([
      tx.postRevision.findUnique({ where: { postId_number: { postId: destination.postId, number: destination.revision } }, include: { asset: true } }),
      tx.approval.findUnique({ where: { postId_revision: { postId: destination.postId, revision: destination.revision } } }),
    ]);
    const attempt = await tx.publishAttempt.create({
      data: { destinationId: id, number: destination._count.attempts + 1, state: 'PUBLISHING' },
    });
    return { destination, revision, approval, attempt };
  });
  if (!claim) {
    const pending = await prisma.destination.findFirst({
      where: { id, state: 'SCHEDULED' },
      select: { notBefore: true, post: { select: { scheduledAt: true } } },
    });
    if (!pending) return null;
    const due = Math.max(pending.notBefore?.getTime() ?? 0, pending.post.scheduledAt?.getTime() ?? 0);
    return due > now.getTime() ? due - now.getTime() : null;
  }
  const { destination, revision, approval, attempt } = claim;
  const valid = revision?.channelIds.includes(destination.channelId) && approval && destination.revision === destination.post.revision
    && destination.channel.workspaceId === destination.post.workspaceId;
  const nonce = createHash('sha256').update(id).digest('base64url').slice(0, 25);
  const provider = getProvider(destination.channel.provider);
  let result: PublishResult = { kind: 'failed', error: 'The approved revision or destination is unavailable.' };
  const thread = revision ? revisionThread(revision) : [];
  if (valid && revision && provider) {
    const parent = destination.parent;
    const workspaceId = destination.post.workspaceId;
    try {
      if (!destination.parentId) {
        const text = revisionOverrides(revision.overrides)[destination.channelId] ?? revision.content;
        const ids = revisionMediaIds(revision).slice(0, provider.maxImages ?? 1);
        const assets = ids.length ? await prisma.asset.findMany({ where: { id: { in: ids }, workspaceId } }) : [];
        const ordered = ids.map((assetId) => assets.find(({ id: found }) => found === assetId)).filter((item) => item !== undefined);
        if (ordered.length !== ids.length) throw new AssetStorageError('An attached media file is no longer available.');
        validateProviderPost(destination.channel.provider, text, ordered[0]?.type);
        const images: PublishingImage[] = [];
        for (const asset of ordered) {
          images.push({
            bytes: asset.type === 'video/mp4' ? await readVideo(asset, workspaceId) : await readImage(asset, workspaceId),
            type: asset.type,
            url: destination.channel.provider === 'instagram' ? createMetaAssetUrl(asset.id, workspaceId) : undefined,
          });
        }
        result = await provider.publish(destination.post.workspace.slug, destination.channel, nonce, text, images[0], images);
      } else {
        const index = Math.max(1, destination.threadIndex);
        const item = thread[index - 1];
        if (parent?.state === 'PUBLISHED' && parent.externalId && parent.postId === destination.postId
          && parent.channelId === destination.channelId && parent.revision === destination.revision && item && provider.reply) {
          if (item.content.length > provider.textLimit) throw new ProviderConfigurationError(`${provider.name} allows up to ${provider.textLimit} characters per thread item.`);
          result = await provider.reply(destination.post.workspace.slug, destination.channel, nonce, item.content, parent.externalId);
        } else {
          result = { kind: 'failed', error: 'The approved thread item or its parent publication is unavailable.' };
        }
      }
    } catch (error) {
      if (!(error instanceof AssetStorageError || error instanceof ProviderConfigurationError)) throw error;
      result = { kind: 'failed', error: error.message };
    }
  }
  const retryDelay = result.kind === 'retry' && attempt.number < 5 ? result.delayMs : null;
  const outcome = result.kind === 'published'
    ? { state: 'PUBLISHED' as const, externalId: result.externalId, permalink: result.permalink, error: null }
    : result.kind === 'uncertain'
      ? { state: 'UNCERTAIN' as const, error: result.error }
      : retryDelay !== null
        ? { state: 'SCHEDULED' as const, error: null, notBefore: new Date(Date.now() + retryDelay) }
        : { state: 'FAILED' as const, error: result.kind === 'retry' ? 'Provider rate limit retries exhausted.' : result.error };
  await prisma.$transaction(async (tx) => {
    const saved = await tx.destination.updateMany({
      where: { id, state: 'PUBLISHING', startedAt: destination.startedAt },
      data: outcome,
    });
    if (!saved.count) return;
    if (outcome.state === 'PUBLISHED') {
      // Thread items publish one after another, each as a reply to the previous item after its own delay.
      const nextIndex = destination.parentId ? Math.max(1, destination.threadIndex) + 1 : 1;
      const next = thread[nextIndex - 1];
      if (next && provider?.reply) {
        const dueAt = new Date(Date.now() + Math.max(next.delayMinutes, 0) * 60_000);
        await tx.destination.create({
          data: {
            postId: destination.postId, channelId: destination.channelId, revision: destination.revision,
            parentId: id, threadIndex: nextIndex, notBefore: dueAt, outbox: { create: { dueAt } },
          },
        });
      }
    }
    if (outcome.state === 'PUBLISHED' && !destination.parentId) {
      await scheduleRepeat(tx, destination.postId);
      await enqueuePublishedWebhooks(tx, {
        workspaceId: destination.post.workspaceId, postId: destination.postId, destinationId: id,
        channelId: destination.channelId, provider: destination.channel.provider,
        externalId: outcome.externalId, permalink: outcome.permalink,
      });
    }
    await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { state: retryDelay !== null ? 'FAILED' : outcome.state, error: retryDelay !== null ? 'Provider rate limit.' : outcome.error, finishedAt: new Date() },
    });
  });
  return retryDelay;
}

export async function dispatchOutbox(client: Client) {
  const events = await prisma.outboxEvent.findMany({
    where: { dispatchedAt: null },
    orderBy: { dueAt: 'asc' },
    take: 50,
  });
  for (const event of events) {
    try {
      await client.workflow.start('publishAt', {
        taskQueue: 'cadencedesk',
        workflowId: `publish-${event.destinationId}-${event.dueAt.getTime()}`,
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        args: [event.destinationId, event.dueAt.getTime()],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    await prisma.outboxEvent.updateMany({
      where: { destinationId: event.destinationId, dispatchedAt: null },
      data: { dispatchedAt: new Date() },
    });
  }
}

export async function reconcileInterrupted() {
  const error = 'Publishing stopped before the result was saved. Check the destination before sending again.';
  await prisma.$transaction(async (tx) => {
    const abandoned = await tx.destination.updateManyAndReturn({
      where: { state: 'PUBLISHING', startedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      data: { state: 'UNCERTAIN', error },
      select: { id: true },
    });
    if (!abandoned.length) return;
    await tx.publishAttempt.updateMany({
      where: { destinationId: { in: abandoned.map(({ id }) => id) }, state: 'PUBLISHING' },
      data: { state: 'UNCERTAIN', error, finishedAt: new Date() },
    });
  });
}

/**
 * Creates the next occurrence of a repeating post once it publishes. The copy keeps the approved
 * revision (content was already approved), its channels and tags, and is due repeatEveryDays later.
 * repeatSourceId is unique, so each post spawns at most one successor.
 */
async function scheduleRepeat(tx: Prisma.TransactionClient, postId: string) {
  const post = await tx.post.findUnique({
    where: { id: postId },
    include: { revisions: { orderBy: { number: 'desc' }, take: 1 }, tags: true },
  });
  const latest = post?.revisions[0];
  if (!post?.repeatEveryDays || !post.scheduledAt || !latest || latest.number !== post.revision) return;
  if (await tx.post.findUnique({ where: { repeatSourceId: post.id }, select: { id: true } })) return;
  const step = post.repeatEveryDays * 86_400_000;
  let due = post.scheduledAt.getTime() + step;
  while (due < Date.now() + 60_000) due += step;
  const dueAt = new Date(due);
  const copy = await tx.post.create({ data: {
    workspaceId: post.workspaceId, state: 'SCHEDULED', scheduledAt: dueAt, repeatEveryDays: post.repeatEveryDays, repeatSourceId: post.id,
    revisions: { create: {
      number: 1, content: latest.content, overrides: latest.overrides ?? {}, thread: latest.thread ?? [], mediaIds: latest.mediaIds,
      assetId: latest.assetId, channelIds: latest.channelIds, followUpText: latest.followUpText, followUpDelayMinutes: latest.followUpDelayMinutes,
    } },
    tags: { create: post.tags.map(({ tagId }) => ({ tagId })) },
  } });
  await tx.approval.create({ data: { postId: copy.id, revision: 1 } });
  for (const channelId of latest.channelIds) {
    await tx.destination.create({ data: { postId: copy.id, channelId, revision: 1, outbox: { create: { dueAt } } } });
  }
  await tx.auditEvent.create({ data: { workspaceId: post.workspaceId, subjectId: copy.id, action: 'post.repeat_scheduled' } });
}
```

## packages/data/src/client.ts
```ts
import { PrismaClient } from '@prisma/client';

const globalDb = globalThis as typeof globalThis & { cadencedeskPrisma?: PrismaClient };
// Interactive transactions run several queries in a row; against a remote database (~0.3–0.5 s per
// round trip to RDS) Prisma's 5 s default is too short, so allow 20 s to run and 10 s to start.
export const prisma = globalDb.cadencedeskPrisma ?? new PrismaClient({ transactionOptions: { timeout: 20_000, maxWait: 10_000 } });

if (process.env.NODE_ENV !== 'production') {
  globalDb.cadencedeskPrisma = prisma;
}
```

## packages/data/src/feed.ts
```ts
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { pinPublicIpv4, publicOutboundIpv4 } from './outbound';
import { allowedFeedUrl, RssConfigurationError } from './rss';

// Big publishers' feeds (full article text) often run past 1 MiB.
const feedLimit = 3 * 1024 * 1024;

export const publicFeedAddress = publicOutboundIpv4;

export async function fetchFeed(source: string) {
  const url = allowedFeedUrl(source);
  const signal = AbortSignal.timeout(12_000);
  const address = await pinPublicIpv4(url.hostname, signal);
  return new Promise<string>((resolve, reject) => {
    const req = request(url, {
      family: 4, signal, agent: false,
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'Accept-Encoding': 'identity',
        // Many sites refuse requests that do not say who is asking.
        'User-Agent': 'Mozilla/5.0 (compatible; SuperstarFeedReader/1.0; +https://superstar.xolnet.in)',
      },
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    }, (res) => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy();
        reject(new RssConfigurationError(res.statusCode && res.statusCode >= 300 && res.statusCode < 400
          ? `The feed moved to ${String(res.headers.location ?? 'another address')}. Use that address instead.`
          : `The feed site answered with status ${res.statusCode ?? 'unknown'} instead of the feed.`));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > feedLimit) {
          res.destroy(new RssConfigurationError('The feed is larger than 3 MiB.'));
          return;
        }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.once('error', reject);
    req.end();
  });
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[name.toLowerCase()] ?? match;
  });
}

/** Text only: feeds often send summaries as escaped HTML, so decode entities, then drop tags and squeeze spaces. */
function plain(value: unknown, limit: number) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = decode(String(value)).replace(/<[^>]*>/g, ' ');
  return decode(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function link(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function elements(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value])
    .filter((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

export function parseFeed(xml: string) {
  if (Buffer.byteLength(xml) > feedLimit || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new RssConfigurationError('This feed is too large or contains unsupported XML.');
  }
  const parser = new XMLParser({
    processEntities: false, ignoreAttributes: false, parseTagValue: false, maxNestedTags: 32,
  });
  const result = parser.parse(xml);
  const rss = result?.rss?.channel;
  const atom = result?.feed;
  if (!rss && !atom) throw new RssConfigurationError('Only RSS and Atom feeds are supported.');
  return elements(rss ? rss.item : atom.entry).slice(0, 40).flatMap((item) => {
    const title = plain(item.title, 300);
    const summary = plain(item.description ?? item.summary, 1300);
    const atomPath = elements(item.link).find((value) => !value['@_rel'] || value['@_rel'] === 'alternate');
    const source = link(rss ? item.link : atomPath?.['@_href']);
    const guid = item.guid && typeof item.guid === 'object' ? (item.guid as Record<string, unknown>)['#text'] : item.guid;
    const stable = plain(guid ?? item.id, 1000) || source || title;
    const content = [title, summary, source].filter(Boolean).join('\n\n').slice(0, 4096);
    return stable && content ? [{ sourceKey: createHash('sha256').update(stable).digest('hex'), content }] : [];
  });
}
```

## packages/data/src/outbound.ts
```ts
import { Resolver } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function outboundHttpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search
    || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) {
    throw new Error('Use an approved public HTTPS URL.');
  }
  return url;
}

export function allowedOutboundUrl(value: string, allowlist: string | undefined) {
  const url = outboundHttpsUrl(value);
  const allowed = (allowlist ?? '').split(',').some((entry) => {
    try { return outboundHttpsUrl(entry.trim()).href === url.href; } catch { return false; }
  });
  if (!allowed) throw new Error('This HTTPS URL is outside the operator allowlist.');
  return url;
}

export function publicOutboundIpv4(ip: string) {
  try {
    const address = ipaddr.parse(ip);
    return address.kind() === 'ipv4' && address.range() === 'unicast' && ip !== '168.63.129.16';
  } catch {
    return false;
  }
}

export async function pinPublicIpv4(hostname: string, signal: AbortSignal) {
  const addresses = await new Resolver({ timeout: 3000, tries: 2 }).resolve4(hostname);
  signal.throwIfAborted();
  const address = addresses[0];
  if (!address || addresses.some((candidate) => !publicOutboundIpv4(candidate))) {
    throw new Error('The endpoint must resolve to public IPv4 addresses.');
  }
  return address;
}
```

## apps/api/src/api-rate-limit.ts
```ts
import { Injectable, type OnModuleDestroy, type OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';

const increment = `
  local count = redis.call("INCR", KEYS[1])
  if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
  return count
`;

@Injectable()
export class ApiRateLimit implements OnModuleInit, OnModuleDestroy {
  private readonly redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, {
    lazyConnect: true, enableOfflineQueue: false,
    connectTimeout: 1000, commandTimeout: 1500, maxRetriesPerRequest: 0,
  }) : null;

  async onModuleInit() {
    this.redis?.on('error', () => undefined);
    await this.redis?.connect().catch(() => undefined);
  }

  async onModuleDestroy() {
    this.redis?.disconnect();
  }

  ready() {
    return this.redis?.status === 'ready';
  }

  async consume(keyId: string) {
    const requested = Number(process.env.API_REQUESTS_PER_MINUTE ?? 120);
    const limit = Number.isInteger(requested) && requested > 0 && requested <= 100_000 ? requested : 120;
    const now = Date.now();
    const window = Math.floor(now / 60_000);
    const resetsIn = Math.ceil(((window + 1) * 60_000 - now) / 1000);
    if (!this.redis || !this.ready()) throw new ServiceUnavailableException('API rate limiting is unavailable.');
    try {
      const key = `cadencedesk:api:key:${keyId}:${window}`;
      const count = Number(await this.redis.eval(increment, 1, key, 65_000));
      if (!Number.isInteger(count) || count < 1) throw new Error('Invalid Redis counter');
      return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetsIn };
    } catch {
      throw new ServiceUnavailableException('API rate limiting is unavailable.');
    }
  }
}
```

## apps/web/next.config.mjs
```js
const config = {
  experimental: { serverActions: { bodySizeLimit: '22mb' } },
  outputFileTracingIncludes: {
    '/*': ['../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**'],
  },
  async headers() {
    return [{
      source: '/app/:workspace/channels/meta',
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'Cache-Control', value: 'private, no-store' }],
    }, {
      source: '/review/:path*',
      headers: [
        { key: 'Cache-Control', value: 'private, no-store' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ],
    }];
  },
};

export default config;
```

## What I need from you
Review this for production readiness. Reply as a numbered list of at most 15 findings, most important first. For each:
severity (critical/high/medium/low), the problem, the file/area, and the concrete fix. Focus on: reliability and single points of failure,
security, performance bottlenecks on a 2 GB server, deploy safety, Temporal setup, database, cost, and anything that will break with 100-1,000 users.
Be specific to this code; skip generic advice.
