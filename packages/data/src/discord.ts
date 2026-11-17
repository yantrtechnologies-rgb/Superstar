const api = 'https://discord.com/api/v10';

export class DiscordConfigurationError extends Error {}

function configuration(workspace: string, channelId: string) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const encoded = process.env.DISCORD_WORKSPACE_CHANNELS;
  if (!token || !encoded) throw new DiscordConfigurationError('The Discord bot requires operator configuration.');
  let grants: unknown;
  try {
    grants = JSON.parse(encoded);
  } catch {
    throw new DiscordConfigurationError('Discord channel grants are invalid.');
  }
  if (typeof grants !== 'object' || grants === null || !Object.hasOwn(grants, workspace)) {
    throw new DiscordConfigurationError('This channel is not enabled for the workspace.');
  }
  const channels = (grants as Record<string, unknown>)[workspace];
  if (!/^\d{17,20}$/.test(channelId) || !Array.isArray(channels) || !channels.includes(channelId)) {
    throw new DiscordConfigurationError('This channel is not enabled for the workspace.');
  }
  return { Authorization: `Bot ${token}` };
}

export async function discoverDiscordChannel(workspace: string, channelId: string) {
  const headers = configuration(workspace, channelId);
  const response = await fetch(`${api}/channels/${channelId}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new DiscordConfigurationError('The bot cannot read that Discord channel.');
  const channel = await response.json() as { guild_id?: string; name?: string; type?: number };
  if (!channel.guild_id || !channel.name || channel.type !== 0 || !/^\d{17,20}$/.test(channel.guild_id)) {
    throw new DiscordConfigurationError('Choose a server text channel.');
  }
  return { name: channel.name, guildId: channel.guild_id };
}

export type DiscordResult =
  | { kind: 'published'; externalId: string; permalink: string }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'failed' | 'uncertain'; error: string };

export async function sendDiscord(
  workspace: string,
  channel: { externalId: string; guildId: string },
  nonce: string,
  content: string,
  image?: { bytes: Uint8Array<ArrayBuffer>; type: string },
): Promise<DiscordResult> {
  let headers;
  try {
    headers = configuration(workspace, channel.externalId);
  } catch (error) {
    if (error instanceof DiscordConfigurationError) return { kind: 'failed', error: error.message };
    throw error;
  }

  try {
    const payload = JSON.stringify({ content, nonce, enforce_nonce: true, allowed_mentions: { parse: [] } });
    let body: string | FormData = payload;
    if (image) {
      const form = new FormData();
      form.set('payload_json', payload);
      form.set('files[0]', new Blob([image.bytes], { type: image.type }), image.type === 'image/png' ? 'image.png' : 'image.jpg');
      body = form;
    }
    const response = await fetch(`${api}/channels/${channel.externalId}/messages`, {
      method: 'POST',
      redirect: 'error',
      headers: image ? headers : { ...headers, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const { retry_after } = await response.json() as { retry_after?: number };
      const seconds = typeof retry_after === 'number' && Number.isFinite(retry_after) ? retry_after : 60;
      return { kind: 'retry', delayMs: Math.max(1000, Math.ceil(seconds * 1000)) };
    }
    if (response.status >= 500) {
      return { kind: 'uncertain', error: 'Discord returned a server error. Check the channel before retrying.' };
    }
    if (!response.ok) {
      return { kind: 'failed', error: `Discord rejected the message (HTTP ${response.status}). Check bot permissions.` };
    }
    const { id } = await response.json() as { id?: string };
    if (!id || !/^\d{17,20}$/.test(id)) {
      return { kind: 'uncertain', error: 'Discord returned no usable message ID. Check the channel before retrying.' };
    }
    return { kind: 'published', externalId: id, permalink: `https://discord.com/channels/${channel.guildId}/${channel.externalId}/${id}` };
  } catch {
    return { kind: 'uncertain', error: 'The Discord result could not be confirmed. Check the channel before retrying.' };
  }
}
