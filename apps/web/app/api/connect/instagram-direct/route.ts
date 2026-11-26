import { completeInstagramDirectConnection, PlanLimitError, ProviderConfigurationError, WorkspaceAccessError } from '@cadencedesk/data';
import { linkResult, oauthActor } from '../../../../lib/oauth-actor';

function sendBack(path: string) {
  return new Response(null, { status: 303, headers: { Location: path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const actor = await oauthActor(params.get('state'));
  try {
    const result = await completeInstagramDirectConnection(actor.id, params.get('state') ?? '',
      params.has('error') ? undefined : params.get('code')?.slice(0, 4096));
    const status = params.has('error') && result.reason !== 'saved' ? 'oauth-canceled' : result.reason;
    return sendBack(actor.viaLink ? linkResult(status) : `/app/${result.slug}/channels?status=${status}`);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return sendBack(actor.viaLink ? linkResult('plan-limit') : `/app/${error.slug}/channels?status=plan-limit`);
    }
    if (!(error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError)) throw error;
    return sendBack(actor.viaLink ? linkResult('invalid') : '/app?status=oauth-invalid');
  }
}
