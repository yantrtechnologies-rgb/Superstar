import { AiProviderError } from './openai';

/**
 * Google Gemini through the Interactions API (one endpoint for text, image and video output).
 * https://generativelanguage.googleapis.com/v1beta/interactions, authenticated with GEMINI_API_KEY.
 */
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const apiRevision = process.env.GEMINI_API_REVISION || '2026-05-20';

type Content = { type?: string; text?: string; data?: string; mime_type?: string; uri?: string };
type Interaction = { id?: string; steps?: { type?: string; content?: Content[] }[]; output_text?: string; error?: { message?: string } };

function key() {
  const value = process.env.GEMINI_API_KEY;
  if (!value) throw new AiProviderError('The AI provider requires configuration.');
  return value;
}

async function interact(body: Record<string, unknown>, timeoutMs: number) {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json', 'Api-Revision': apiRevision },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiProviderError('The AI provider did not respond in time.');
  }
  const raw = await response.json().catch(() => ({})) as Interaction | Interaction[];
  // Errors can arrive wrapped in a one-element array.
  const data = (Array.isArray(raw) ? raw[0] ?? {} : raw) as Interaction;
  const providerRef = typeof data.id === 'string' ? data.id.slice(0, 255) : null;
  if (!response.ok) {
    const reason = data.error?.message?.replace(/\s+/g, ' ').slice(0, 300);
    console.error(JSON.stringify({ event: 'gemini.request_failed', status: response.status, reason }));
    // Billing, quota and server problems are the operator's to fix; customers see a neutral message (credits are refunded).
    if (response.status === 402 || response.status === 429 || response.status >= 500) {
      throw new AiProviderError('AI generation is temporarily unavailable. Your credits were refunded; please try again later.', providerRef);
    }
    throw new AiProviderError(response.status === 400 && reason
      ? `The AI provider could not create this: ${reason}`
      : `The AI provider rejected the generation (HTTP ${response.status}).`, providerRef);
  }
  return { data, providerRef };
}

function outputs(data: Interaction, type: string) {
  return (data.steps ?? []).filter((step) => step.type === undefined || step.type === 'model_output')
    .flatMap((step) => step.content ?? []).filter((item) => item.type === type);
}

function decode(item: Content | undefined, limit: number, what: string, providerRef: string | null) {
  if (!item?.data || typeof item.data !== 'string') throw new AiProviderError(`The AI provider returned no ${what}.`, providerRef);
  if (item.data.length > Math.ceil(limit / 3) * 4) throw new AiProviderError(`The generated ${what} exceeds storage limits.`, providerRef);
  return Uint8Array.from(Buffer.from(item.data, 'base64'));
}

const copywriter = 'You write publication-ready social media copy for brands. Reply with only the requested copy, no commentary or preamble.';

export async function geminiText(model: string, prompt: string) {
  const { data, providerRef } = await interact({
    model, system_instruction: copywriter, input: prompt, generation_config: { max_output_tokens: 1000 },
  }, 90_000);
  const text = (data.output_text ?? outputs(data, 'text').map((item) => item.text ?? '').join('\n')).trim();
  if (!text) throw new AiProviderError('The AI provider returned no text.', providerRef);
  return { text: text.slice(0, 12_000), providerRef };
}

export async function geminiImage(model: string, prompt: string) {
  const { data, providerRef } = await interact({
    model, input: prompt,
    response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: process.env.GEMINI_IMAGE_ASPECT || '1:1', image_size: '1K' },
  }, 120_000);
  return { image: decode(outputs(data, 'image')[0], 2 * 1024 * 1024, 'image', providerRef), providerRef };
}

/** Short social video. Generation can take several minutes, so the caller runs it with a long timeout. */
export async function geminiVideo(model: string, prompt: string) {
  const { data, providerRef } = await interact({
    model, input: prompt,
    response_format: {
      type: 'video',
      aspect_ratio: process.env.GEMINI_VIDEO_ASPECT || '9:16',
      resolution: process.env.GEMINI_VIDEO_RESOLUTION || '720p',
      duration: process.env.GEMINI_VIDEO_DURATION || '8s',
    },
  }, 12 * 60_000);
  return { video: decode(outputs(data, 'video')[0], 20 * 1024 * 1024, 'video', providerRef), providerRef };
}

export async function geminiTranscribe(model: string, video: Uint8Array<ArrayBuffer>) {
  const { data, providerRef } = await interact({
    model,
    input: [
      { type: 'video', data: Buffer.from(video).toString('base64'), mime_type: 'video/mp4' },
      { type: 'text', text: 'Transcribe all speech in this video word for word. Reply with only the transcript.' },
    ],
    generation_config: { max_output_tokens: 8000 },
  }, 180_000);
  const text = (data.output_text ?? outputs(data, 'text').map((item) => item.text ?? '').join('\n')).trim();
  if (!text) throw new AiProviderError('The provider returned no usable transcript.', providerRef);
  return { text: text.slice(0, 100_000), providerRef };
}
