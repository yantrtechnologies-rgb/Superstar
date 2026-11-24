import { workspaceSlug } from '@cadencedesk/contracts';
import { requireUser } from '../../../../../lib/require-user';
import { razorpayBilling, settleCreditPaymentLink, verifyPaymentLinkReturn } from '../../../../../lib/razorpay-billing';

/** Razorpay sends the customer here after paying for a credit pack. Credits are granted once the payment is confirmed. */
export async function GET(request: Request, { params }: { params: Promise<{ workspace: string }> }) {
  await requireUser();
  const slug = workspaceSlug.safeParse((await params).workspace);
  const base = slug.success ? `/app/${slug.data}/billing` : '/app';
  const billing = razorpayBilling();
  let status = 'credits-pending';
  if (billing) {
    const verified = verifyPaymentLinkReturn(billing, new URL(request.url).searchParams);
    if (!verified) status = 'unavailable';
    else if (verified.status === 'paid') {
      try {
        status = (await settleCreditPaymentLink(billing, verified.linkId)) ? 'credits-added' : 'credits-pending';
      } catch {
        status = 'credits-pending';
      }
    } else status = 'credits-canceled';
  }
  return new Response(null, { status: 303, headers: { Location: `${base}?status=${status}`, 'Cache-Control': 'no-store' } });
}
