import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './publish';
import type * as analytics from './analytics';
import type * as ai from './ai';
import type * as rss from './rss';

const { publishDestination } = proxyActivities<typeof activities>({
  startToCloseTimeout: '45 seconds',
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

export async function generateAiContent(jobId: string) {
  await runAiJob(jobId);
}

export async function importRssFeed(runId: string) {
  await importRssRun(runId);
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
