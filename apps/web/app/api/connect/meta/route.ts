import { completeMetaConnection, PlanLimitError, ProviderConfigurationError, WorkspaceAccessError } from '@cadencedesk/data';
import { linkResult, oauthActor } from '../../../../lib/oauth-actor';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const actor = await oauthActor(query.get('state'));
  let location = actor.viaLink ? linkResult('invalid') : '/app?status=oauth-invalid';
  try {
    if (query.has('error')) {
      console.error(JSON.stringify({ event: 'meta.authorize_error', error: query.get('error')?.slice(0, 100),
        reason: query.get('error_reason')?.slice(0, 100), description: query.get('error_description')?.slice(0, 300) }));
    }
    const code = query.has('error') ? undefined : query.get('code') ?? undefined;
    location = await completeMetaConnection(actor.id, query.get('state') ?? '', code && code.length <= 4096 ? code : undefined);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      location = actor.viaLink ? linkResult('plan-limit') : `/app/${error.slug}/channels?status=plan-limit`;
    } else if (!(error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError)) throw error;
  }
  return new Response(null, { status: 303, headers: {
    Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}
