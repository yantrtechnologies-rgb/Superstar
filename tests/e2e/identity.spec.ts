import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

type CapturedEmail = { to: string | string[]; subject: string; text: string };

async function capturedMail(email: string, subject: string) {
  const mailFile = process.env.CADENCEDESK_E2E_MAIL_FILE;
  if (!mailFile) throw new Error('Missing email capture file');
  const contents = await readFile(mailFile, 'utf8');
  return contents.trim().split('\n').map((line) => JSON.parse(line) as CapturedEmail)
    .findLast((message) => [message.to].flat().includes(email) && message.subject === subject);
}

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  const message = await capturedMail(email, 'Your Superstar sign-in link');
  const link = message?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error('Sign-in email has no callback URL');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
}

async function createWorkspace(page: Page, name: string) {
  await page.goto('/app');
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}

test('magic link, invitations, workspace switching, and tenant isolation', async ({ browser, page }) => {
  const run = randomUUID();
  const owner = `owner-${run}@example.invalid`;
  const reviewer = `reviewer-${run}@example.invalid`;
  await signIn(page, owner);
  const studio = await createWorkspace(page, 'Northlight Studio');
  const secret = await createWorkspace(page, 'Private Editorial');
  await page.getByRole('navigation', { name: 'Switch workspace' })
    .getByRole('link', { name: 'Northlight Studio' }).click();
  await expect(page).toHaveURL(studio);
  await page.getByRole('link', { name: 'Team settings', exact: true }).click();
  await page.getByLabel('Email address').fill(reviewer);
  await page.getByLabel('Workspace role').selectOption('REVIEWER');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toHaveText('Invitation sent.');
  expect(await capturedMail(reviewer, 'Superstar workspace invitation')).toBeDefined();

  const client = await browser.newPage();
  try {
    await signIn(client, reviewer);
    await client.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(client).toHaveURL(studio);
    await expect(client.getByText('reviewer', { exact: true })).toBeVisible();
    await client.goto(studio + '/settings');
    await expect(client.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);

    const denied = await client.goto(secret + '/settings');
    expect(denied?.status()).toBe(404);
    await expect(client.getByText('Private Editorial')).toHaveCount(0);

    await client.goto(studio);
    await client.getByRole('button', { name: 'Sign out' }).click();
    await expect(client).toHaveURL('/');
    await client.goto(studio);
    await expect(client).toHaveURL('/login');
  } finally {
    await client.close();
  }
});

test('workspace commands reject unauthorized invitations and claims', async () => {
  const { prisma, createWorkspace, inviteMember, acceptInvitation, WorkspaceAccessError } =
    await import('../../packages/data/dist/index.js');
  const run = randomUUID();
  const [owner, outsider, recipient] = await Promise.all(
    ['owner', 'outsider', 'recipient'].map((name) => prisma.user.create({
      data: { email: `${name}-${run}@example.invalid`, emailVerified: new Date() },
    })),
  );
  const workspace = await createWorkspace(owner.id, 'Isolation Fixture', 'UTC');
  try {
    await expect(inviteMember(outsider.id, workspace.slug, recipient.email, 'VIEWER'))
      .rejects.toBeInstanceOf(WorkspaceAccessError);
    await inviteMember(owner.id, workspace.slug, recipient.email, 'REVIEWER');
    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { workspaceId_email: { workspaceId: workspace.id, email: recipient.email } },
    });
    await expect(acceptInvitation(outsider.id, invitation.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await acceptInvitation(recipient.id, invitation.id);
    await expect(acceptInvitation(recipient.id, invitation.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(inviteMember(recipient.id, workspace.slug, outsider.email, 'VIEWER'))
      .rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(await prisma.membership.count({ where: { workspaceId: workspace.id } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { workspaceId: workspace.id } })).toBe(3);
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, outsider.id, recipient.id] } } });
    await prisma.$disconnect();
  }
});

test('compose, approve and schedule a post from the workspace on mobile', async ({ page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  await page.setViewportSize({ width: 390, height: 844 });
  const email = `publisher-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Daybreak Studio');
  const slug = path.split('/').at(-1);
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug } });
  try {
    await prisma.channel.create({
      data: {
        workspaceId: workspace.id, provider: 'discord', name: 'studio-news',
        externalId: '123456789012345671', guildId: '123456789012345670',
      },
    });
    await page.getByRole('link', { name: 'Posts', exact: true }).click();
    await page.getByLabel('Post text', { exact: true }).fill('Tomorrow’s studio update');
    await page.getByRole('button', { name: 'Create draft' }).click();
    const draft = page.getByRole('article');
    await draft.getByLabel('#studio-news').check();
    await draft.getByRole('button', { name: 'Request approval' }).click();
    await draft.getByRole('button', { name: 'Approve revision' }).click();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 16);
    await draft.getByLabel('Schedule time (UTC)').fill(tomorrow);
    await draft.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(draft.getByText('#studio-news · scheduled')).toBeVisible();
    await page.getByRole('link', { name: 'Agenda', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Publishing agenda' })).toBeVisible();
    await expect(page.getByText('Tomorrow’s studio update')).toBeVisible();
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('connect and disconnect a LinkedIn profile through the OAuth callback', async ({ page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `oauth-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'LinkedIn Test Workspace');
  const slug = path.split('/').at(-1);
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug } });
  try {
    await page.route(/^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?/, async (route) => {
      const authorization = new URL(route.request().url());
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      expect(callback.pathname).toBe('/api/connect/linkedin');
      callback.searchParams.set('state', authorization.searchParams.get('state')!);
      callback.searchParams.set('code', 'playwright-linkedin-code');
      await route.fulfill({ status: 303, headers: { Location: callback.href }, body: '' });
    });
    await page.getByRole('link', { name: 'Channels', exact: true }).click();
    await page.getByRole('button', { name: 'Authorize or reconnect LinkedIn' }).click();
    await expect(page.getByRole('status')).toHaveText('Channel connected.');
    await expect(page.getByText('Authorized', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect Browser Fixture Member' }).click();
    await expect(page.getByText('Reconnect required', { exact: true })).toBeVisible();
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('client review stays bound to the draft revision and client group slots populate the agenda', async ({ browser, page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `review-owner-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Juniper Studio');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  const client = await browser.newPage();
  try {
    await prisma.channel.create({
      data: { workspaceId: workspace.id, provider: 'discord', name: 'juniper-news',
        externalId: '123456789012345671', guildId: '123456789012345670' },
    });
    await page.goto(path + '/channels/organization');
    await page.getByLabel('Client group name').fill('Juniper campaign');
    await page.getByRole('button', { name: 'Create group' }).click();
    await page.getByLabel('Client group', { exact: true }).selectOption({ label: 'Juniper campaign' });
    await page.getByRole('button', { name: 'Save group' }).click();
    await expect(page.getByRole('status')).toHaveText('Channel group saved.');
    await page.getByLabel('Local time').fill('09:30');
    await page.getByRole('button', { name: 'Add posting slot' }).click();
    await expect(page.getByText('Monday 09:30')).toBeVisible();

    await page.goto(path + '/posts');
    await page.getByLabel('Post text', { exact: true }).fill('Original Juniper announcement');
    await page.getByRole('button', { name: 'Create draft' }).click();
    const post = page.getByRole('article');
    const requestClientReview = async () => {
      await post.getByLabel('#juniper-news').check();
      await post.getByRole('button', { name: 'Request approval' }).click();
      await post.getByRole('button', { name: 'Create client review link' }).click();
      const input = post.getByLabel('Shareable review link');
      await expect(input).toBeVisible();
      return input.inputValue();
    };
    const first = await requestClientReview();
    await client.goto(first);
    await expect(client.getByText('Original Juniper announcement')).toBeVisible();
    await client.getByLabel('Feedback').fill('Please mention the launch date.');
    await client.getByRole('button', { name: 'Add comment' }).click();
    await expect(client.getByText('Please mention the launch date.')).toBeVisible();
    await client.getByRole('button', { name: 'Approve revision' }).click();
    await expect(client.getByText('This revision is closed for review.')).toBeVisible();

    await page.reload();
    await expect(post.getByText('Revision 1 · Client approved')).toBeVisible();
    await post.getByLabel('Post text').fill('Juniper launches next week.');
    await post.getByRole('button', { name: 'Save new revision' }).click();
    await expect(post.getByRole('heading', { name: 'draft · Revision 2' })).toBeVisible();
    expect((await client.goto(first))?.status()).toBe(404);

    const revised = await requestClientReview();
    await client.goto(revised);
    await client.getByLabel('Feedback').fill('The revised date looks right.');
    await client.getByRole('button', { name: 'Approve revision' }).click();
    await page.reload();
    await post.getByRole('button', { name: 'Use next shared slot' }).click();
    await expect(post.getByText('#juniper-news · scheduled')).toBeVisible();
    await page.goto(path + '/calendar');
    await page.getByLabel('Client group').selectOption({ label: 'Juniper campaign' });
    await page.getByRole('button', { name: 'Filter agenda' }).click();
    await expect(page.getByText('Juniper launches next week.')).toBeVisible();
  } finally {
    await client.close();
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('analytics distinguishes a recorded zero from unavailable metrics', async ({ page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `analytics-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Analytics Studio');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  try {
    await prisma.channel.create({
      data: {
        workspaceId: workspace.id, provider: 'telegram', externalId: '-1001723456789', name: 'Studio followers',
        metricJobs: { create: {
          bucket: new Date(), state: 'COLLECTED', snapshot: { create: { count: 0 } },
        } },
      },
    });
    await prisma.channel.create({
      data: { workspaceId: workspace.id, provider: 'slack', externalId: 'C000000001', name: 'Team chat' },
    });
    await page.getByRole('link', { name: 'Analytics', exact: true }).click();
    await expect(page.getByText('Members · 0', { exact: true })).toBeVisible();
    await expect(page.getByText('Metrics are unavailable for this provider.')).toBeVisible();
    await page.getByLabel('Date range').selectOption('7');
    await page.getByRole('button', { name: 'Apply date range' }).click();
    await expect(page).toHaveURL(/days=7/);
    await expect(page.getByText('Members · 0', { exact: true })).toBeVisible();
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('the Studio reserves and returns credits and Automations queues an approved feed', async ({ page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `studio-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Field Notes Studio');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  try {
    await page.getByRole('link', { name: 'AI Studio' }).click();
    await expect(page.getByText('4 credits available', { exact: true })).toBeVisible();
    await page.getByLabel('Copy brief or text to revise').fill('Write copy for a seasonal product release.');
    await page.getByRole('button', { name: 'Generate social copy · 4 credits' }).click();
    await expect(page.getByRole('heading', { name: 'Social copy · queued' })).toBeVisible();
    await expect(page.getByText('0 credits available', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel queued generation' }).click();
    await expect(page.getByRole('heading', { name: 'Social copy · canceled' })).toBeVisible();
    await expect(page.getByText('4 credits available', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Automations', exact: true }).click();
    await page.getByLabel('Rule name').fill('Community headlines');
    await page.getByLabel('Approved HTTPS feed URL').fill('https://news.example.invalid/feed.xml');
    await page.getByRole('button', { name: 'Add RSS rule' }).click();
    await expect(page.getByRole('heading', { name: 'Community headlines' })).toBeVisible();
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByRole('list', { name: 'Recent runs' }).getByText('queued', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Pause rule' }).click();
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('workspace admins can create, rotate, and pause outbound webhooks', async ({ page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `webhooks-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Webhook Studio');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  try {
    await page.getByRole('link', { name: 'Automations', exact: true }).click();
    await page.getByRole('link', { name: 'Manage outbound webhooks' }).click();
    await page.getByLabel('Subscription name').fill('Editorial tracker');
    await page.getByLabel('Approved HTTPS endpoint').fill('https://hooks.example.invalid/published');
    await page.getByRole('button', { name: 'Create webhook' }).click();
    const initialSecret = page.getByLabel('Signing secret', { exact: true });
    await expect(initialSecret).toBeVisible();
    const original = await initialSecret.inputValue();
    expect(original).toMatch(/^whsec_/);
    const subscription = page.getByRole('article').filter({ hasText: 'Editorial tracker' });
    await subscription.getByRole('button', { name: 'Rotate signing secret' }).click();
    const rotatedSecret = subscription.getByLabel('Signing secret', { exact: true });
    await expect(rotatedSecret).toBeVisible();
    expect(await rotatedSecret.inputValue()).not.toBe(original);
    await subscription.getByRole('button', { name: 'Pause webhook' }).click();
    await expect(page.getByText('Webhook paused. Queued deliveries were skipped.')).toBeVisible();
    await expect(subscription.getByRole('button', { name: 'Enable webhook' })).toBeVisible();
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('Studio uploads an MP4 and queues clipping and transcription', async ({ page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `video-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Video Studio Fixture');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  try {
    await page.getByRole('link', { name: 'AI Studio', exact: true }).click();
    await page.getByLabel('MP4 video up to 20 MiB').setInputFiles({
      name: 'Studio source.mp4', mimeType: 'video/mp4',
      buffer: Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex'),
    });
    await page.getByRole('button', { name: 'Upload video' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Studio source.mp4' })
      .getByRole('link', { name: 'Download video' })).toBeVisible();
    const clip = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Clip video' }) });
    await clip.getByLabel('Source video').selectOption({ label: 'Studio source.mp4' });
    await clip.getByLabel('Duration in seconds').fill('2');
    await clip.getByRole('button', { name: 'Create clip' }).click();
    await expect(page.getByRole('heading', { name: 'Clip · queued' })).toBeVisible();
    await expect(page.getByText('4 credits available', { exact: true })).toBeVisible();
    const transcript = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Transcribe audio' }) });
    await transcript.getByLabel('Source video').selectOption({ label: 'Studio source.mp4' });
    await transcript.getByRole('button', { name: 'Start transcription · 4 credits' }).click();
    await expect(page.getByRole('heading', { name: 'Transcript · queued' })).toBeVisible();
    await expect(page.getByText('0 credits available', { exact: true })).toBeVisible();
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('an admin can configure reviewed RSS publishing and share the approved follow-up preview', async ({ browser, page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `publishing-rules-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Riverside Studio');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  const client = await browser.newPage();
  try {
    await prisma.channel.create({ data: {
      workspaceId: workspace.id, provider: 'discord', name: 'riverside-news',
      externalId: '123456789012345671', guildId: '123456789012345670',
    } });
    await page.getByRole('link', { name: 'Automations', exact: true }).click();
    await page.getByLabel('Rule name').fill('Reviewed studio news');
    await page.getByLabel('Approved HTTPS feed URL').fill('https://news.example.invalid/feed.xml');
    await page.getByLabel('Schedule approved imports in the next shared slot').check();
    await page.getByLabel('#riverside-news').check();
    await page.getByRole('button', { name: 'Add RSS rule' }).click();
    await expect(page.getByText('Schedule after approval', { exact: true })).toBeVisible();

    await page.goto(path + '/posts');
    await page.getByLabel('Post text', { exact: true }).fill('Riverside workshop registration is open.');
    await page.getByText('Discord follow-up', { exact: true }).click();
    await page.getByLabel('Follow-up text').fill('Bring a notebook to the first session.');
    await page.getByLabel('Delay in minutes').fill('10');
    await page.getByRole('button', { name: 'Create draft' }).click();
    const draft = page.getByRole('article');
    await expect(draft.getByText('Discord follow-up · 10 minutes after publication')).toBeVisible();
    await draft.getByLabel('#riverside-news').check();
    await draft.getByRole('button', { name: 'Request approval' }).click();
    await draft.getByRole('button', { name: 'Create client review link' }).click();
    const reviewLink = draft.getByLabel('Shareable review link');
    await expect(reviewLink).toBeVisible();
    await client.goto(await reviewLink.inputValue());
    await expect(client.getByText('Bring a notebook to the first session.')).toBeVisible();
    await expect(client.getByText('Discord follow-up · 10 minutes after publication')).toBeVisible();
  } finally {
    await client.close();
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('workspace admins can issue a scoped API key and revoke it', async ({ page }) => {
  const { prisma } = await import('../../packages/data/dist/index.js');
  const email = `api-key-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Key Management Studio');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  try {
    await page.getByRole('link', { name: 'Team settings', exact: true }).click();
    await page.getByRole('link', { name: 'Manage API keys' }).click();
    await page.getByLabel('Key name').fill('Reporting integration');
    await page.getByLabel('Read posts and destination results').check();
    await page.getByRole('button', { name: 'Create API key' }).click();
    const token = page.getByLabel('New API key', { exact: true });
    await expect(token).toBeVisible();
    expect(await token.inputValue()).toMatch(/^cdk_[A-Za-z0-9_-]{43}$/);
    await page.reload();
    await expect(token).toHaveCount(0);
    const key = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Reporting integration' }) });
    await expect(key.getByText(/posts:read/)).toBeVisible();
    await key.getByRole('button', { name: 'Revoke Reporting integration' }).click();
    await expect(key.getByText(/Revoked · Expires/)).toBeVisible();
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { email } });
    await prisma.$disconnect();
  }
});

test('pricing and billing show configured limits only to the appropriate audience', async ({ browser, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('link', { name: 'View plans' }).click();
  await expect(page.getByRole('heading', { name: 'Plans and pricing' })).toBeVisible();
  for (const plan of ['Free', 'Creator', 'Team', 'Agency']) {
    await expect(page.getByRole('heading', { name: plan, exact: true })).toBeVisible();
  }

  const run = randomUUID();
  const viewer = `billing-viewer-${run}@example.invalid`;
  await signIn(page, `billing-owner-${run}@example.invalid`);
  const workspace = await createWorkspace(page, 'Billing Studio');
  await page.getByRole('link', { name: 'Usage and billing' }).click();
  await expect(page.getByRole('heading', { name: 'Usage and billing' })).toBeVisible();
  await expect(page.getByText('0 credits available')).toBeVisible();
  await expect(page.getByText('1 · 3 planned limit')).toBeVisible();

  await page.getByRole('link', { name: 'Team settings' }).click();
  await page.getByLabel('Email address').fill(viewer);
  await page.getByLabel('Workspace role').selectOption('VIEWER');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toHaveText('Invitation sent.');

  const invited = await browser.newPage();
  try {
    await signIn(invited, viewer);
    await invited.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(invited).toHaveURL(workspace);
    await expect(invited.getByRole('link', { name: 'Usage and billing' })).toHaveCount(0);
    const denied = await invited.goto(workspace + '/billing');
    expect(denied?.status()).toBe(404);
  } finally {
    await invited.close();
  }
});

test('the public landing and workspace navigation fit desktop and mobile', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'A workspace for social campaigns' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Sample campaign agenda' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }

  await signIn(page, `navigation-${randomUUID()}@example.invalid`);
  await createWorkspace(page, 'Fieldwork Studio');
  const menu = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(menu.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  await menu.getByRole('link', { name: 'Agenda' }).click();
  await expect(menu.getByRole('link', { name: 'Agenda' })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('landing channel setup survives sign-in and opens Channels in a new workspace', async ({ page }) => {
  const email = `connect-${randomUUID()}@example.invalid`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Connect your channels' }).click();
  await expect(page).toHaveURL('/login?intent=channels');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  const message = await capturedMail(email, 'Your Superstar sign-in link');
  const link = message?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error('Sign-in email has no callback URL');
  await page.goto(link);
  await expect(page).toHaveURL('/app?intent=channels');
  await page.getByLabel('Workspace name').fill('Channel Setup Studio');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/[^/]+\/channels$/);
});

test('Facebook and Instagram connections select accounts, reject replay and isolate workspaces', async ({ page }) => {
  const { prisma, metaAccountChoices, saveMetaAccounts, WorkspaceAccessError } =
    await import('../../packages/data/dist/index.js');
  const email = `meta-${randomUUID()}@example.invalid`;
  await signIn(page, email);
  const path = await createWorkspace(page, 'Meta Connections');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: path.split('/').at(-1) } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  const outsider = await prisma.user.create({ data: { email: `outside-meta-${randomUUID()}@example.invalid` } });
  let callbackUrl = '';
  await page.route(/^https:\/\/www\.facebook\.com\/v[0-9]+\.0\/dialog\/oauth\?/, async (route) => {
    const url = new URL(route.request().url());
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-meta-code');
    callbackUrl = callback.href;
    await route.fulfill({ status: 303, headers: { Location: callback.href }, body: '' });
  });
  try {
    for (const [kind, name] of [['Pages', 'Fieldwork Page'], ['Instagram', 'fieldwork.studio']]) {
      await page.goto(path + '/channels');
      await page.getByRole('button', { name: 'Continue with Facebook for ' + kind, exact: true }).click();
      await expect(page.getByRole('button', { name: 'Connect selected accounts' })).toBeVisible();
      const selection = new URL(page.url()).searchParams.get('selection')!;
      await expect(metaAccountChoices(outsider.id, workspace.slug, selection)).rejects.toBeInstanceOf(WorkspaceAccessError);
      await expect(metaAccountChoices(owner.id, 'wrong-workspace', selection)).rejects.toBeInstanceOf(WorkspaceAccessError);
      expect(await page.content()).not.toContain('fixture-page-token');
      await page.getByLabel(name, { exact: true }).check();
      await page.getByRole('button', { name: 'Connect selected accounts' }).click();
      await expect(page.getByRole('status')).toHaveText('Channel connected.');
      const provider = kind === 'Pages' ? 'facebook' : 'instagram';
      const channel = await prisma.channel.findFirstOrThrow({ where: { workspaceId: workspace.id, provider }, include: { credential: true } });
      expect(channel.credential!.accessToken).toMatch(/^v1\./);
      expect(channel.credential!.accessToken).not.toContain('fixture-page-token');
      await expect(saveMetaAccounts(owner.id, workspace.slug, selection, [channel.externalId])).rejects.toBeInstanceOf(WorkspaceAccessError);
      await page.goto(callbackUrl);
      await expect(page).toHaveURL('/app?status=oauth-invalid');
      await page.goto(path + '/channels');
      await page.getByRole('button', { name: 'Disconnect ' + name, exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('Account disconnected from this workspace.');
      expect(await prisma.providerCredential.count({ where: { channelId: channel.id } })).toBe(0);
    }
    expect(await prisma.channel.count({ where: { workspaceId: workspace.id } })).toBe(2);
  } finally {
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
    await prisma.$disconnect();
  }
});
