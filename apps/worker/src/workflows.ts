import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './publish';
import type * as analytics from './analytics';

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
