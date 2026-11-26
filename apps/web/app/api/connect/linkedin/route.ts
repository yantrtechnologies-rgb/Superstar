import { completeLinkedInConnection, PlanLimitError, ProviderConfigurationError, WorkspaceAccessError } from '@cadencedesk/data';
import { linkResult, oauthActor } from '../../../../lib/oauth-actor';

function sendBack(path: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  const actor = await oauthActor(state);
  const invalid = actor.viaLink ? linkResult('invalid') : '/app?status=oauth-invalid';
  if (!state) return sendBack(invalid);
  const code = params.has('error') ? undefined : params.get('code') ?? undefined;
  try {
    const result = await completeLinkedInConnection(actor.id, state, code && code.length <= 2048 ? code : undefined, params.get('error')?.slice(0, 64));
    const status = result.connected ? 'saved'
      : result.reason ? `linkedin-${result.reason}`
      : params.has('error') ? 'oauth-canceled' : 'linkedin-unavailable';
    return sendBack(actor.viaLink ? linkResult(status) : `/app/${result.slug}/channels?status=${status}`);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return sendBack(actor.viaLink ? linkResult('plan-limit') : `/app/${error.slug}/channels?status=plan-limit`);
    }
    if (error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError) {
      return sendBack(invalid);
    }
    throw error;
  }
}
