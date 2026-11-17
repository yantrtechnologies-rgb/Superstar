import type { AiKind } from '@cadencedesk/data';

export class AiProviderError extends Error {
  constructor(message: string, readonly providerRef: string | null = null) {
    super(message);
  }
}

type Generation = { text: string; providerRef: string | null } | { image: Uint8Array<ArrayBuffer>; providerRef: string | null };

export async function generateContent(job: { kind: AiKind; model: string; prompt: string }): Promise<Generation> {
  const token = process.env.OPENAI_API_KEY;
  if (!token) throw new AiProviderError('The AI provider requires configuration.');
  const text = job.kind === 'TEXT';
  let providerRef = null;
  try {
    const response = await fetch(`https://api.openai.com/v1/${text ? 'responses' : 'images/generations'}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(text ? {
        model: job.model,
        instructions: 'Help the user draft publication-ready social media copy. Provide the requested copy without process commentary.',
        input: job.prompt,
        max_output_tokens: 1000,
        store: false,
      } : {
        model: job.model, prompt: job.prompt, n: 1, size: '1024x1024',
        quality: 'low', output_format: 'jpeg', output_compression: 75,
      }),
    });
    providerRef = response.headers.get('x-request-id')?.slice(0, 255) ?? null;
    if (!response.ok) {
      throw new AiProviderError(`The AI provider rejected the generation (HTTP ${response.status}).`, providerRef);
    }
    if (text) {
      const data = await response.json() as {
        status?: string;
        output?: { type?: string; content?: { type?: string; text?: string }[] }[];
      };
      const output = data.output?.filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '').join('\n').trim();
      if (data.status !== 'completed' || !output) throw new AiProviderError('The AI provider returned no completed text.', providerRef);
      return { text: output.slice(0, 12_000), providerRef };
    }
    const data = await response.json() as { data?: { b64_json?: string }[] };
    const encoded = data.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded || encoded.length > 2_800_000) {
      throw new AiProviderError('The generated image exceeds storage limits or is unavailable.', providerRef);
    }
    return { image: Uint8Array.from(Buffer.from(encoded, 'base64')), providerRef };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError('The AI provider result could not be confirmed.', providerRef);
  }
}
