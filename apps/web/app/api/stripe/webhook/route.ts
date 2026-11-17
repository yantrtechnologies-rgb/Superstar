import { stripeBilling, syncStripeEvent } from '../../../../lib/stripe-billing';

export async function POST(request: Request) {
  const billing = stripeBilling();
  if (!billing) return new Response(null, { status: 404 });
  const signature = request.headers.get('stripe-signature');
  if (!signature) return new Response(null, { status: 400 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      return new Response(null, { status: 413 });
    }
    chunks.push(value);
  }
  let event;
  try {
    event = billing.stripe.webhooks.constructEvent(Buffer.concat(chunks), signature, billing.secret);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (event.livemode) return new Response(null, { status: 400 });
  await syncStripeEvent(billing, event);
  return new Response(null, { status: 204 });
}
