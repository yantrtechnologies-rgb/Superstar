import { NativeConnection, Worker } from '@temporalio/worker';
import { createServer } from 'node:http';

async function main() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: 'cadencedesk',
      activities: { probe: async () => 'ok' },
    });
    const server = createServer((_request, response) => {
      const running = worker.getState() === 'RUNNING';
      response.writeHead(running ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: running ? 'ready' : 'unavailable' }));
    });
    try {
      server.listen(3002, '0.0.0.0');
      await worker.run();
    } finally {
      server.close();
    }
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error('Worker startup failed', error);
  process.exitCode = 1;
});
