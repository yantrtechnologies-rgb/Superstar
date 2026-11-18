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
    command: 'node --import ./scripts/capture-resend.mjs --import ./scripts/mock-linkedin.mjs --import ./scripts/mock-meta.mjs --import ./scripts/mock-youtube-x.mjs --import ./scripts/mock-storage.mjs apps/web/node_modules/next/dist/bin/next start apps/web -H 127.0.0.1 -p 3930',
    url: baseURL + '/health',
    env: {
      APP_URL: baseURL,
      BILLING_PLAN_LIMITS: '{"free":{"limits":{"seats":3}}}',
      AUTH_URL: baseURL,
      AUTH_SECRET: 'playwright-only-secret-for-cadencedesk-identity',
      EMAIL_FROM: 'Superstar Test <test@example.invalid>',
      RESEND_API_KEY: 'playwright-only-test-key',
      CADENCEDESK_E2E_MAIL_FILE: mailFile,
      OPENAI_API_KEY: 'playwright-ai-test-key',
      OPENAI_TEXT_MODEL: 'playwright-fixture',
      OPENAI_TRANSCRIBE_MODEL: 'playwright-transcribe-fixture',
      AI_TRANSCRIBE_BASE_CREDITS: '2',
      MEDIA_CLIPPING_ENABLED: 'true',
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:3931',
      OBJECT_STORAGE_BUCKET: 'playwright-fixture',
      OBJECT_STORAGE_ACCESS_KEY: 'playwright-access',
      OBJECT_STORAGE_SECRET_KEY: 'playwright-storage-secret',
      AI_TEXT_BASE_CREDITS: '2',
      AI_CREDIT_MARKUP: '2',
      AI_STARTER_CREDITS: '4',
      RSS_ALLOWED_FEEDS: 'https://news.example.invalid/feed.xml',
      WEBHOOK_ALLOWED_ENDPOINTS: 'https://hooks.example.invalid/published',
      META_APP_ID: '123456789',
      META_APP_SECRET: 'fixture-meta-app-secret',
      META_GRAPH_VERSION: 'v27.0',
      LINKEDIN_CLIENT_ID: 'playwright-linkedin-id',
      LINKEDIN_CLIENT_SECRET: 'playwright-linkedin-secret',
      YOUTUBE_CLIENT_ID: 'playwright-youtube-id',
      YOUTUBE_CLIENT_SECRET: 'playwright-youtube-secret',
      X_CLIENT_ID: 'playwright-x-id',
      X_CLIENT_SECRET: 'playwright-x-secret',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 0x23).toString('base64'),
    },
  },
});
