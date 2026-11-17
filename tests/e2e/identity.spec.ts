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
  const message = await capturedMail(email, 'Your CadenceDesk AI sign-in link');
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
  expect(await capturedMail(reviewer, 'CadenceDesk AI workspace invitation')).toBeDefined();

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
