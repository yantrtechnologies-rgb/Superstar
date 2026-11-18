import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './client';
import { metaConfiguration } from './meta-connection';
import { type OAuthProviderAdapter, ProviderConfigurationError, type PublishResult } from './provider-contract';
import { openToken } from './token-vault';

const graphError = z.object({ error: z.object({
  message: z.string().optional(), code: z.number().optional(), is_transient: z.boolean().optional(),
}).optional() });

async function credentials(provider: 'facebook' | 'instagram', channelId: string, workspaceId: string) {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, workspaceId, provider }, include: { credential: true },
  });
  const stored = channel?.credential;
  if (!channel || !stored || stored.revokedAt || (stored.accessExpiresAt && stored.accessExpiresAt <= new Date())) {
    throw new ProviderConfigurationError(`The ${provider === 'facebook' ? 'Facebook Page' : 'Instagram'} authorization expired. Reconnect it.`);
  }
  return openToken(stored.accessToken, `${provider}/${workspaceId}/${channelId}/access`);
}

async function request(path: string, token: string, body?: URLSearchParams | FormData) {
  const config = metaConfiguration();
  if (!config) throw new ProviderConfigurationError('Meta publishing is not configured.');
  const url = new URL(`https://graph.facebook.com/${config.version}/${path}`);
  url.searchParams.set('appsecret_proof', createHmac('sha256', config.secret).update(token).digest('hex'));
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET', body, headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { kind: 'uncertain', error: 'Meta did not confirm whether the publishing request completed. Check the account before retrying.' } as const;
  }
  const json: unknown = await response.json().catch(() => ({}));
  if (response.ok) return { kind: 'ok', json } as const;
  const parsed = graphError.safeParse(json);
  const error = parsed.success ? parsed.data.error : undefined;
  if (error?.code === 190 || error?.code === 200) {
    return { kind: 'failed', error: 'Meta denied publishing access. Reconnect the account and grant publishing permission.' } as const;
  }
  if (error?.is_transient || [1, 2, 4, 17, 32, 613, 80001].includes(error?.code ?? 0)) {
    return { kind: 'retry', delayMs: 60_000 } as const;
  }
  return { kind: 'failed', error: error?.message ? `Meta rejected the post: ${error.message}` : 'Meta rejected the post.' } as const;
}

function published(json: unknown, permalink: (id: string) => string | null): PublishResult {
  const parsed = z.object({ id: z.string().min(1), post_id: z.string().min(1).optional() }).safeParse(json);
  if (!parsed.success) return { kind: 'uncertain', error: 'Meta accepted the request without returning a publication identifier.' };
  const id = parsed.data.post_id ?? parsed.data.id;
  return { kind: 'published', externalId: id, permalink: permalink(id) };
}

export const facebook: OAuthProviderAdapter = {
  kind: 'oauth', name: 'Facebook Page', textLimit: 63_206, imageCaptionLimit: 63_206,
  connectionHelp: 'Connect a Facebook Page and grant pages_manage_posts.', configured: () => Boolean(metaConfiguration()),
  async publish(_workspace, channel, _nonce, content, image) {
    const token = await credentials('facebook', channel.id, channel.workspaceId);
    if (image) {
      const form = new FormData();
      form.set('caption', content); form.set('published', 'true');
      form.set('source', new Blob([image.bytes], { type: image.type }), image.type === 'image/png' ? 'image.png' : 'image.jpg');
      const result = await request(`${channel.externalId}/photos`, token, form);
      return result.kind === 'ok' ? published(result.json, (id) => `https://www.facebook.com/${id}`) : result;
    }
    const result = await request(`${channel.externalId}/feed`, token, new URLSearchParams({ message: content, published: 'true' }));
    return result.kind === 'ok' ? published(result.json, (id) => `https://www.facebook.com/${id}`) : result;
  },
};

export const instagram: OAuthProviderAdapter = {
  kind: 'oauth', name: 'Instagram professional account', textLimit: 2_200, imageCaptionLimit: 2_200, requiresImage: true,
  connectionHelp: 'Connect a professional Instagram account linked to a Facebook Page.', configured: () => Boolean(metaConfiguration()),
  async publish(_workspace, channel, _nonce, content, image) {
    if (!image?.url) return { kind: 'failed', error: 'Instagram requires a publicly deliverable image.' };
    const token = await credentials('instagram', channel.id, channel.workspaceId);
    const created = await request(`${channel.externalId}/media`, token, new URLSearchParams({ image_url: image.url, caption: content }));
    if (created.kind !== 'ok') return created;
    const container = z.object({ id: z.string().min(1) }).safeParse(created.json);
    if (!container.success) return { kind: 'uncertain', error: 'Instagram created media without returning a container identifier.' };
    for (let attempt = 0; attempt < 10; attempt++) {
      const status = await request(`${container.data.id}?fields=status_code`, token);
      if (status.kind !== 'ok') return status.kind === 'failed' ? status : {
        kind: 'uncertain', error: 'Instagram created the media container but its readiness could not be confirmed.',
      };
      const value = z.object({ status_code: z.string() }).safeParse(status.json);
      if (value.success && value.data.status_code === 'FINISHED') break;
      if (value.success && value.data.status_code === 'ERROR') return { kind: 'failed', error: 'Instagram could not process the image.' };
      if (attempt === 9) return { kind: 'uncertain', error: 'Instagram is still processing the image. Check the account before retrying.' };
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const result = await request(`${channel.externalId}/media_publish`, token, new URLSearchParams({ creation_id: container.data.id }));
    if (result.kind !== 'ok') return result;
    const parsed = z.object({ id: z.string().min(1) }).safeParse(result.json);
    if (!parsed.success) return { kind: 'uncertain', error: 'Instagram published without returning a media identifier.' };
    const details = await request(`${parsed.data.id}?fields=permalink`, token);
    const permalink = details.kind === 'ok'
      ? z.object({ permalink: z.url() }).safeParse(details.json).data?.permalink ?? null : null;
    return { kind: 'published', externalId: parsed.data.id, permalink };
  },
};
