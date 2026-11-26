import { connectLinkActor } from '@cadencedesk/data';
import { requireUser } from './require-user';

/**
 * Who a network callback runs as. A connection a client started from an agency's connect link runs as the link's
 * creator and needs no Superstar session; any other connection needs the signed-in user.
 */
export async function oauthActor(state: string | null) {
  const linked = state ? await connectLinkActor(state) : null;
  if (linked) return { id: linked, viaLink: true };
  const { id } = await requireUser();
  return { id, viaLink: false };
}

/** Where a client who connected through a link ends up: a public page, never the agency's workspace. */
export function linkResult(status: string) {
  return '/connect/done?status=' + encodeURIComponent(status);
}
