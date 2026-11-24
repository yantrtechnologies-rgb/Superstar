import { cookies } from 'next/headers';
import { chosenPlanCookie } from '../../../lib/chosen-plan';

/** "Choose plan" on the pricing page: remember the plan for an hour, then sign in / pick a workspace and pay. */
export async function GET(request: Request) {
  const plan = new URL(request.url).searchParams.get('plan');
  if (plan === 'creator' || plan === 'team' || plan === 'agency') {
    (await cookies()).set(chosenPlanCookie, plan, {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60, secure: process.env.APP_URL?.startsWith('https:') ?? false,
    });
  }
  return new Response(null, { status: 303, headers: { Location: '/app', 'Cache-Control': 'no-store' } });
}
