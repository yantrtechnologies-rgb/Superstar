import { appendFile } from 'node:fs/promises';

const capturePath = process.env.CADENCEDESK_E2E_MAIL_FILE;
if (!capturePath) throw new Error('Set CADENCEDESK_E2E_MAIL_FILE before loading the test transport');

const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://api.resend.com') return fetchOriginal(input, init);
  if (url.pathname !== '/emails' || init?.method !== 'POST' || typeof init.body !== 'string') {
    throw new Error('Unexpected Resend request');
  }
  await appendFile(capturePath, init.body + '\n', 'utf8');
  return Response.json({ id: 'captured-test-email' });
};
