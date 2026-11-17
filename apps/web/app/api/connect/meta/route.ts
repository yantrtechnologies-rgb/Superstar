import { completeMetaConnection, ProviderConfigurationError, WorkspaceAccessError } from '@cadencedesk/data';
import { requireUser } from '../../../../lib/require-user';

export async function GET(request: Request) {
  const user = await requireUser();
  const query = new URL(request.url).searchParams;
  let location = '/app?status=oauth-invalid';
  try {
    const code = query.has('error') ? undefined : query.get('code') ?? undefined;
    location = await completeMetaConnection(user.id, query.get('state') ?? '', code && code.length <= 4096 ? code : undefined);
  } catch (error) {
    if (!(error instanceof ProviderConfigurationError || error instanceof WorkspaceAccessError)) throw error;
  }
  return new Response(null, { status: 303, headers: {
    Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}
