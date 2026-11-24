import { razorpayBilling, syncRazorpayEvent, verifyRazorpaySignature } from '../../../../lib/razorpay-billing';

export async function POST(request: Request) {
  const billing = razorpayBilling();
  if (!billing) return new Response(null, { status: 404 });
  const signature = request.headers.get('x-razorpay-signature');
  const eventId = request.headers.get('x-razorpay-event-id');
  if (!signature || !eventId || eventId.length > 200) return new Response(null, { status: 400 });
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
  const body = Buffer.concat(chunks);
  if (!verifyRazorpaySignature(billing, body, signature)) return new Response(null, { status: 400 });
  let json: unknown;
  try { json = JSON.parse(body.toString('utf8')); } catch { return new Response(null, { status: 400 }); }
  try {
    await syncRazorpayEvent(billing, eventId, json);
  } catch {
    // A 5xx makes Razorpay retry the delivery later.
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 200 });
}
