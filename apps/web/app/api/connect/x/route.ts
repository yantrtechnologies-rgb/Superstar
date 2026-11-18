import { completeXConnection, ProviderConfigurationError, WorkspaceAccessError } from '@cadencedesk/data';
import { requireUser } from '../../../../lib/require-user';

export async function GET(request: Request) {
  const { id } = await requireUser();
  const params = new URL(request.url).searchParams;
  try {
    const result = await completeXConnection(id, params.get('state') ?? '',
      params.has('error') ? undefined : params.get('code')?.slice(0, 4096));
    return new Response(null, { status: 303, headers: {
      Location: `/app/${result.slug}/channels?status=${result.connected ? 'saved' : 'x-unavailable'}`,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    } });
  } catch (error) {
    if (!(error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError)) throw error;
    return new Response(null, { status: 303, headers: { Location: '/app?status=oauth-invalid', 'Cache-Control': 'no-store' } });
  }
}
