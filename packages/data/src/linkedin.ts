import { linkedInConfigured, LinkedInTokenServiceError, publishLinkedInMember } from './linkedin-api';
import { invalidateLinkedInAccess, linkedInAccess } from './linkedin-connection';
import { ProviderConfigurationError, type OAuthProviderAdapter } from './provider-contract';

export const linkedin: OAuthProviderAdapter = {
  kind: 'oauth',
  name: 'LinkedIn profile',
  textLimit: 3000,
  imageCaptionLimit: null,
  connectionHelp: 'Connect a LinkedIn member profile to publish public text posts.',
  configured: linkedInConfigured,
  async publish(_workspace, channel, _nonce, content) {
    try {
      const credentials = await linkedInAccess(channel.id, channel.workspaceId);
      if (!credentials) return { kind: 'failed', error: 'The LinkedIn authorization expired or was disconnected. Reconnect the profile.' };
      const result = await publishLinkedInMember(channel.externalId, credentials.access, content);
      if (result.kind !== 'unauthorized') return result;

      const replacement = await linkedInAccess(channel.id, channel.workspaceId, credentials.snapshot);
      if (replacement) {
        const retry = await publishLinkedInMember(channel.externalId, replacement.access, content);
        if (retry.kind !== 'unauthorized') return retry;
      }
      await invalidateLinkedInAccess(channel.id, replacement?.snapshot ?? credentials.snapshot);
      return { kind: 'failed', error: 'LinkedIn denied the authorization. Reconnect the profile.' };
    } catch (error) {
      if (error instanceof LinkedInTokenServiceError) return { kind: 'retry', delayMs: 60_000 };
      if (error instanceof ProviderConfigurationError) return { kind: 'failed', error: error.message };
      throw error;
    }
  },
};
