import { discord } from './discord';
import { instagramDirect } from './instagram-direct';
import { linkedin } from './linkedin';
import { facebook, instagram } from './meta';
import { ProviderConfigurationError, type ProviderAdapter, type ProviderId } from './provider-contract';
import { reminder } from './reminders';
import { telegram } from './telegram';
import { youtube } from './youtube';
import { x } from './x';

export const providers: Record<ProviderId, ProviderAdapter> = {
  discord, telegram, linkedin, facebook, instagram, youtube, x, 'instagram-direct': instagramDirect, reminder,
};

export function getProvider(id: string): ProviderAdapter | undefined {
  return Object.hasOwn(providers, id) ? providers[id as ProviderId] : undefined;
}

export function validateProviderPost(providerId: string, text: string, assetType?: string) {
  const provider = getProvider(providerId);
  if (!provider) throw new ProviderConfigurationError('This provider is unavailable.');
  const hasImage = assetType?.startsWith('image/') ?? false;
  const hasVideo = assetType?.startsWith('video/') ?? false;
  // requiresImage on a network that also takes video means "an image or a video" (Instagram posts and Reels).
  if (provider.requiresImage && !hasImage && !(provider.acceptsVideo && hasVideo)) {
    throw new ProviderConfigurationError(`${provider.name} requires an image${provider.acceptsVideo ? ' or MP4 video' : ''}.`);
  }
  if (provider.requiresVideo && !hasVideo) throw new ProviderConfigurationError(`${provider.name} requires an MP4 video.`);
  if (hasVideo && !provider.acceptsVideo) throw new ProviderConfigurationError(`${provider.name} does not support video in this connector.`);
  const limit = hasImage || hasVideo ? provider.imageCaptionLimit : provider.textLimit;
  if (limit === null) throw new ProviderConfigurationError(`${provider.name} currently supports text only.`);
  if (!text.trim() || (text.length > limit && !provider.splitsLongText)) {
    throw new ProviderConfigurationError(`${provider.name} allows up to ${limit} characters for this post.`);
  }
}
