import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './publish';

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
