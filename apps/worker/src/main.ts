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
import { dispatchOutbox, publishDestination, reconcileInterrupted, recoverLostWorkflows } from './publish';

async function dispatch(client: Client, stop: AbortSignal) {
  // Each step has its own error handling, so one failing job (RSS, AI, analytics...) never stops publishing.
  const steps: [string, () => Promise<unknown>][] = [
    ['reconcile_interrupted', () => reconcileInterrupted()],
    ['dispatch_outbox', () => dispatchOutbox(client)],
    ['dispatch_analytics', () => dispatchAnalytics(client)],
    ['reconcile_ai', () => reconcileAiJobs()],
    ['dispatch_ai', () => dispatchAiJobs(client)],
    ['queue_rss', () => queueDueRssRules()],
    ['dispatch_rss', () => dispatchRssRuns(client)],
    ['schedule_rss_reviewed', () => scheduleReviewedRssImports()],
    ['dispatch_webhooks', () => dispatchWebhooks(client)],
  ];
  let lastRecovery = 0;
  while (!stop.aborted) {
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        console.error(JSON.stringify({ event: 'worker.step_failed', step: name, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }));
      }
    }
    // Every 10 minutes: re-schedule posts whose scheduler workflow was lost (for example after a scheduler restore).
    if (Date.now() - lastRecovery > 10 * 60_000) {
      lastRecovery = Date.now();
      try {
        const recovered = await recoverLostWorkflows(client);
        if (recovered) console.error(JSON.stringify({ event: 'worker.recovered_lost_workflows', count: recovered }));
      } catch (error) {
        console.error(JSON.stringify({ event: 'worker.step_failed', step: 'recover_lost_workflows', error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }));
      }
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
        server.listen(3002, '127.0.0.1'); // health check: this machine only
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

void main().catch((error: unknown) => {
  // The shortened message only, so the container log says why the worker stopped.
  console.error(JSON.stringify({ event: 'publishing.worker_stopped', error: error instanceof Error ? error.message.slice(0, 500) : 'unknown' }));
  process.exitCode = 1;
});
