import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = 'http://127.0.0.1:3930';
const mailFile = process.env.CADENCEDESK_E2E_MAIL_FILE ?? join(tmpdir(), `cadencedesk-mail-${randomUUID()}.jsonl`);
process.env.CADENCEDESK_E2E_MAIL_FILE = mailFile;

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: 'node --import ./scripts/capture-resend.mjs apps/web/node_modules/next/dist/bin/next start apps/web -H 127.0.0.1 -p 3930',
    url: baseURL + '/health',
    env: {
      APP_URL: baseURL,
      AUTH_URL: baseURL,
      AUTH_SECRET: 'playwright-only-secret-for-cadencedesk-identity',
      EMAIL_FROM: 'CadenceDesk Test <test@example.invalid>',
      RESEND_API_KEY: 'playwright-only-test-key',
      CADENCEDESK_E2E_MAIL_FILE: mailFile,
    },
  },
});
