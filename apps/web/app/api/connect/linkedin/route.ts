import { completeLinkedInConnection, PlanLimitError, ProviderConfigurationError, WorkspaceAccessError } from '@cadencedesk/data';
import { requireUser } from '../../../../lib/require-user';

function sendBack(path: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export async function GET(request: Request) {
  const { id } = await requireUser();
  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  if (!state) return sendBack('/app?status=oauth-invalid');
  const code = params.has('error') ? undefined : params.get('code') ?? undefined;
  try {
    const result = await completeLinkedInConnection(id, state, code && code.length <= 2048 ? code : undefined, params.get('error')?.slice(0, 64));
    const status = result.connected ? 'saved'
      : result.reason ? `linkedin-${result.reason}`
      : params.has('error') ? 'oauth-canceled' : 'linkedin-unavailable';
    return sendBack(`/app/${result.slug}/channels?status=${status}`);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return new Response(null, { status: 303, headers: { Location: `/app/${error.slug}/channels?status=plan-limit`, 'Cache-Control': 'no-store' } });
    }
    if (error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError) {
      return sendBack('/app?status=oauth-invalid');
    }
    throw error;
  }
}
