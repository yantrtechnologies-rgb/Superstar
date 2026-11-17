import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function startApi(rateLimit = 20) {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), API_LISTEN_HOST: '127.0.0.1', API_REQUESTS_PER_MINUTE: String(rateLimit) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let logs = '';
  const capture = (chunk) => { logs = (logs + String(chunk)).slice(-4000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const ready = await fetch(new URL('/health/ready', baseUrl));
      if (ready.ok) return { baseUrl, close };
    } catch {
      // Wait for local API startup.
    }
    await setTimeout(100);
  }
  await close();
  throw new Error('The API did not become ready. ' + logs);
}
