import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { prisma } from '@cadencedesk/data';
import { createServer } from 'node:http';
import { collectChannelMetric, dispatchAnalytics } from './analytics';
import { dispatchAiJobs, reconcileAiJobs, runAiJob } from './ai';
import { dispatchRssRuns, importRssRun, queueDueRssRules } from './rss';
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
        activities: { publishDestination, collectChannelMetric, runAiJob, importRssRun },
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
