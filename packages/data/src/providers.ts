import { discord } from './discord';
import { linkedin } from './linkedin';
import { ProviderConfigurationError, type ProviderAdapter, type ProviderId } from './provider-contract';
import { slack } from './slack';
import { telegram } from './telegram';

export const providers: Record<ProviderId, ProviderAdapter> = { discord, telegram, slack, linkedin };

export function getProvider(id: string): ProviderAdapter | undefined {
  return Object.hasOwn(providers, id) ? providers[id as ProviderId] : undefined;
}

export function validateProviderPost(providerId: string, text: string, hasImage: boolean) {
  const provider = getProvider(providerId);
  if (!provider) throw new ProviderConfigurationError('This provider is unavailable.');
  const limit = hasImage ? provider.imageCaptionLimit : provider.textLimit;
  if (limit === null) throw new ProviderConfigurationError(`${provider.name} currently supports text only.`);
  if (!text.trim() || text.length > limit) {
    throw new ProviderConfigurationError(`${provider.name} allows up to ${limit} characters for this post.`);
  }
}
