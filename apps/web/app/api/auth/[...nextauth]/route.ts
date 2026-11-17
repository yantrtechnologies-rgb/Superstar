import { handlers } from '../../../../auth';
import { signInConfigured } from '../../../../lib/auth-config';

export const dynamic = 'force-dynamic';
export const GET: typeof handlers.GET = async (request) => signInConfigured()
  ? handlers.GET(request)
  : Response.json({ error: 'Sign-in is unavailable' }, { status: 503 });

export const POST: typeof handlers.POST = async (request) => signInConfigured()
  ? handlers.POST(request)
  : Response.json({ error: 'Sign-in is unavailable' }, { status: 503 });
