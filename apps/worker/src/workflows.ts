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
