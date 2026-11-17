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
