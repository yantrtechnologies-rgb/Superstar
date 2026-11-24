import { ProviderConfigurationError, retryAfter, type PublishResult } from './provider-contract';
import { vaultConfigured } from './token-vault';

const tokenEndpoint = 'https://www.linkedin.com/oauth/v2/accessToken';

function organizationEnabled() {
  return process.env.LINKEDIN_ORGANIZATION_ENABLED === 'true';
}

function scopes() {
  return ['openid', 'profile', 'w_member_social', ...(organizationEnabled()
    ? ['r_organization_admin', 'w_organization_social'] : [])];
}

function marketingHeaders(access: string) {
  return {
    Authorization: `Bearer ${access}`,
    'LinkedIn-Version': process.env.LINKEDIN_VERSION || '202609',
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

/**
 * 'member' connects the person's profile with the main LinkedIn app. 'pages' connects company pages the person
 * administers, through a separate app approved for LinkedIn's Community Management API
 * (LINKEDIN_PAGES_CLIENT_ID / LINKEDIN_PAGES_CLIENT_SECRET).
 */
export type LinkedInMode = 'member' | 'pages';
const pageScopes = ['r_organization_admin', 'w_organization_social'];

function settings(mode: LinkedInMode = 'member') {
  const { APP_URL } = process.env;
  const clientId = mode === 'pages' ? process.env.LINKEDIN_PAGES_CLIENT_ID : process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = mode === 'pages' ? process.env.LINKEDIN_PAGES_CLIENT_SECRET : process.env.LINKEDIN_CLIENT_SECRET;
  if (!APP_URL || !clientId || !clientSecret || !vaultConfigured()) return null;
  try {
    const origin = new URL(APP_URL);
    const loopback = ['localhost', '127.0.0.1'].includes(origin.hostname);
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) return null;
    return { clientId, clientSecret, callback: new URL('/api/connect/linkedin', origin).href };
  } catch {
    return null;
  }
}

export function linkedInConfigured() {
  return Boolean(settings());
}

export function linkedInPagesConfigured() {
  return Boolean(settings('pages'));
}

export function linkedInAuthorization(state: string, mode: LinkedInMode = 'member') {
  const config = settings(mode);
  if (!config) throw new ProviderConfigurationError('LinkedIn OAuth requires operator configuration.');
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.callback,
    state, scope: (mode === 'pages' ? pageScopes : scopes()).join(' '),
  }).toString();
  return url.href;
}

export class LinkedInAuthorizationError extends ProviderConfigurationError {}
export class LinkedInTokenServiceError extends ProviderConfigurationError {}

export type LinkedInTokens = {
  access: string;
  expiresAt: Date;
  refresh?: string;
  refreshExpiresAt?: Date;
};

export async function linkedInTokens(grant: { code: string } | { refresh: string }, mode: LinkedInMode = 'member'): Promise<LinkedInTokens> {
  const config = settings(mode);
  if (!config) throw new ProviderConfigurationError('LinkedIn OAuth requires operator configuration.');
  const body = new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret,
    ...('code' in grant ? { grant_type: 'authorization_code', code: grant.code, redirect_uri: config.callback }
      : { grant_type: 'refresh_token', refresh_token: grant.refresh }),
  });
  try {
    const response = await fetch(tokenEndpoint, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (response.status >= 500 || response.status === 429) {
      throw new LinkedInTokenServiceError('LinkedIn authorization is temporarily unavailable.');
    }
    const value = await response.json() as {
      access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string;
    };
    const accessSeconds = value.expires_in;
    if (!response.ok || typeof value.access_token !== 'string' || !value.access_token
      || typeof accessSeconds !== 'number' || !Number.isFinite(accessSeconds) || accessSeconds <= 0) {
      throw new LinkedInAuthorizationError('LinkedIn did not authorize this connection. Reconnect the account.');
    }
    if (value.scope) {
      const granted = value.scope.split(/[ ,]+/);
      if (!granted.includes(mode === 'pages' ? 'w_organization_social' : 'w_member_social')) {
        throw new LinkedInAuthorizationError('Grant LinkedIn publishing permission when you reconnect.');
      }
    }
    const now = Date.now();
    return {
      access: value.access_token,
      expiresAt: new Date(now + accessSeconds * 1000),
      refresh: value.refresh_token,
      refreshExpiresAt: typeof value.refresh_token_expires_in === 'number' && value.refresh_token_expires_in > 0
        ? new Date(now + value.refresh_token_expires_in * 1000) : undefined,
    };
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    throw new LinkedInTokenServiceError('LinkedIn authorization is temporarily unavailable.');
  }
}

export async function linkedInMember(access: string) {
  try {
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${access}` },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const user = await response.json() as { sub?: string; name?: string };
      if (typeof user.sub === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(user.sub)) {
        const name = typeof user.name === 'string' ? user.name.slice(0, 200).trim() : '';
        return { externalId: user.sub, name: name || 'LinkedIn member' };
      }
    }
  } catch {
    // The authorization header and provider response stay server-side.
  }
  throw new LinkedInAuthorizationError('LinkedIn member identity was unavailable. Reconnect with the profile permission.');
}

type LinkedInDestination = { externalId: string; name: string };

/** Company pages the authorized member administers (needs r_organization_admin). */
export async function linkedInOrganizations(access: string): Promise<LinkedInDestination[]> {
  const destinations: LinkedInDestination[] = [];
  const url = new URL('https://api.linkedin.com/rest/organizationAcls');
  url.search = new URLSearchParams({ q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED', count: '100' }).toString();
  const response = await fetch(url, { headers: marketingHeaders(access), redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new LinkedInAuthorizationError('LinkedIn did not share your company pages. Reconnect and allow page access.');
  const value = await response.json() as { elements?: Array<{ organization?: string }> };
  const ids = [...new Set((value.elements ?? []).map((item) =>
    /^urn:li:organization:(\d+)$/.exec(item.organization ?? '')?.[1]).filter((id): id is string => Boolean(id)))];
  for (const id of ids) {
    let name = `LinkedIn Page ${id}`;
    const organization = await fetch(`https://api.linkedin.com/rest/organizations/${id}`, {
      headers: marketingHeaders(access), redirect: 'error', signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (organization?.ok) {
      const details = await organization.json() as { localizedName?: string };
      if (typeof details.localizedName === 'string' && details.localizedName.trim()) name = details.localizedName.trim().slice(0, 200);
    }
    destinations.push({ externalId: `organization:${id}`, name });
  }
  return destinations;
}

export async function linkedInDestinations(access: string, mode: LinkedInMode = 'member'): Promise<LinkedInDestination[]> {
  if (mode === 'pages') return linkedInOrganizations(access);
  const member = await linkedInMember(access);
  const destinations: LinkedInDestination[] = [{ externalId: `person:${member.externalId}`, name: member.name }];
  if (!organizationEnabled()) return destinations;
  try {
    const url = new URL('https://api.linkedin.com/rest/organizationAcls');
    url.search = new URLSearchParams({ q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED', count: '100' }).toString();
    const response = await fetch(url, { headers: marketingHeaders(access), redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) return destinations;
    const value = await response.json() as { elements?: Array<{ organization?: string }> };
    const ids = [...new Set((value.elements ?? []).map((item) =>
      /^urn:li:organization:(\d+)$/.exec(item.organization ?? '')?.[1]).filter((id): id is string => Boolean(id)))];
    for (const id of ids) {
      let name = `LinkedIn Page ${id}`;
      const organization = await fetch(`https://api.linkedin.com/rest/organizations/${id}`, {
        headers: marketingHeaders(access), redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (organization.ok) {
        const details = await organization.json() as { localizedName?: string };
        if (typeof details.localizedName === 'string' && details.localizedName.trim()) name = details.localizedName.trim().slice(0, 200);
      }
      destinations.push({ externalId: `organization:${id}`, name });
    }
  } catch {
    // A member profile remains usable when organization discovery is unavailable or not approved.
  }
  // LINKEDIN_PAGES_ONLY=true: connect only the company pages the member administers, not their personal profile
  // (the profile is kept only when no page was found, so the connection never ends up empty).
  if (process.env.LINKEDIN_PAGES_ONLY === 'true' && destinations.some((d) => d.externalId.startsWith('organization:'))) {
    return destinations.filter((d) => d.externalId.startsWith('organization:'));
  }
  return destinations;
}

export async function publishLinkedInDestination(destinationId: string, access: string, content: string): Promise<PublishResult | { kind: 'unauthorized' }> {
  const match = /^(person|organization):([A-Za-z0-9_-]{1,128})$/.exec(destinationId);
  const legacyMember = /^[A-Za-z0-9_-]{1,128}$/.test(destinationId) ? destinationId : null;
  if (!match && !legacyMember) return { kind: 'failed', error: 'Reconnect the LinkedIn destination.' };
  const author = legacyMember ? `urn:li:person:${legacyMember}` : `urn:li:${match![1]}:${match![2]}`;
  try {
    const response = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { ...marketingHeaders(access), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author,
        commentary: content,
        lifecycleState: 'PUBLISHED',
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        isReshareDisabledByAuthor: false,
      }),
    });
    if (response.status === 401) return { kind: 'unauthorized' };
    if (response.status === 429) return retryAfter(Number(response.headers.get('Retry-After')));
    if (response.status >= 500) return { kind: 'uncertain', error: 'Check LinkedIn before sending the post again.' };
    if (!response.ok) return { kind: 'failed', error: 'LinkedIn rejected the post. Check Page role and publishing permissions, then reconnect.' };
    const id = response.headers.get('x-restli-id');
    if (response.status !== 201 || !id || !/^urn:li:(?:share|ugcPost):\d+$/.test(id)) {
      return { kind: 'uncertain', error: 'LinkedIn did not return a post ID. Check the profile before sending again.' };
    }
    return { kind: 'published', externalId: id, permalink: `https://www.linkedin.com/feed/update/${id}/` };
  } catch {
    return { kind: 'uncertain', error: 'The LinkedIn result is unclear. Check the profile before sending again.' };
  }
}
