import { prisma } from '@cadencedesk/data';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createServer } from 'node:http';
import { checkMediaTools, processMediaClip } from './clip';

async function main() {
  await checkMediaTools();
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  try {
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: 'cadencedesk-media',
      activities: { processMediaClip },
      maxConcurrentActivityTaskExecutions: 1,
    });
    const server = createServer((_request, response) => {
      const ready = worker.getState() === 'RUNNING';
      response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
    });
    try {
      server.listen(3003, '0.0.0.0');
      await worker.run();
    } finally {
      server.close();
    }
  } finally {
    await connection.close();
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  // The shortened message only, so the container log says why the worker stopped.
  console.error(JSON.stringify({ event: 'media.worker_stopped', error: error instanceof Error ? error.message.slice(0, 500) : 'unknown' }));
  process.exitCode = 1;
});
