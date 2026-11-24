export const providerIds = ['discord', 'telegram', 'linkedin', 'facebook', 'instagram', 'youtube', 'x'] as const;
export type ProviderId = (typeof providerIds)[number];

export class ProviderConfigurationError extends Error {}

export type PublishResult =
  | { kind: 'published'; externalId: string; permalink: string | null }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'failed' | 'uncertain'; error: string };

export type PublishingImage = { bytes: Uint8Array<ArrayBuffer>; type: string; url?: string };
type PublishChannel = { id: string; workspaceId: string; externalId: string; guildId: string | null };

type PublishingProvider = {
  name: string;
  textLimit: number;
  imageCaptionLimit: number | null;
  requiresImage?: boolean;
  requiresVideo?: boolean;
  acceptsVideo?: boolean;
  /** Most images one post can carry; providers without it publish only the first image. */
  maxImages?: number;
  /** Text over the limit is published as a numbered thread instead of being rejected. */
  splitsLongText?: boolean;
  connectionHelp: string;
  publish(
    workspace: string, channel: PublishChannel,
    nonce: string, content: string, image?: PublishingImage, images?: PublishingImage[],
  ): Promise<PublishResult>;
  /** Publishes a follow-up as a reply/comment/thread item under parentId. Absent = no thread support. */
  reply?(workspace: string, channel: PublishChannel, nonce: string, content: string, parentId: string): Promise<PublishResult>;
};

export type BotProviderAdapter = PublishingProvider & {
  kind: 'bot';
  tokenEnv: string;
  grantsEnv: string;
  destinationLabel: string;
  destinationPattern: RegExp;
  discover(workspace: string, destinationId: string): Promise<{ name: string; guildId?: string }>;
};

export type OAuthProviderAdapter = PublishingProvider & {
  kind: 'oauth';
  configured(): boolean;
};

export type ProviderAdapter = BotProviderAdapter | OAuthProviderAdapter;

export function botToken(adapter: BotProviderAdapter, workspace: string, destinationId: string) {
  const token = process.env[adapter.tokenEnv];
  const encoded = process.env[adapter.grantsEnv];
  if (!token || !encoded) throw new ProviderConfigurationError(`${adapter.name} requires operator configuration.`);
  let grants: unknown;
  try {
    grants = JSON.parse(encoded);
  } catch {
    throw new ProviderConfigurationError(`${adapter.name} destination grants are invalid.`);
  }
  if (typeof grants !== 'object' || grants === null || !Object.hasOwn(grants, workspace)) {
    throw new ProviderConfigurationError('This destination is not enabled for the workspace.');
  }
  const destinations = (grants as Record<string, unknown>)[workspace];
  if (!adapter.destinationPattern.test(destinationId) || !Array.isArray(destinations) || !destinations.includes(destinationId)) {
    throw new ProviderConfigurationError('This destination is not enabled for the workspace.');
  }
  return token;
}

export function retryAfter(seconds: unknown): PublishResult {
  const delay = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
  return { kind: 'retry', delayMs: Math.max(1000, Math.ceil(delay * 1000)) };
}
