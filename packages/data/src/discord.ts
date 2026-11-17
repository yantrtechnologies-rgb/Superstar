import { botToken, ProviderConfigurationError, retryAfter, type ProviderAdapter, type PublishingImage, type PublishResult } from './provider-contract';

const api = 'https://discord.com/api/v10';

function configuration(workspace: string, channelId: string) {
  return { Authorization: `Bot ${botToken(discord, workspace, channelId)}` };
}

export const discord: ProviderAdapter = {
  name: 'Discord',
  tokenEnv: 'DISCORD_BOT_TOKEN',
  grantsEnv: 'DISCORD_WORKSPACE_CHANNELS',
  destinationLabel: 'Server text channel ID',
  destinationPattern: /^\d{17,20}$/,
  textLimit: 2000,
  imageCaptionLimit: 2000,
  connectionHelp: 'Install the bot with View Channel and Send Messages. Grant Attach Files for image posts.',
  discover: discoverDiscordChannel,
  publish: sendDiscord,
};

async function discoverDiscordChannel(workspace: string, channelId: string) {
  const headers = configuration(workspace, channelId);
  const response = await fetch(`${api}/channels/${channelId}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ProviderConfigurationError('The bot cannot read that Discord channel.');
  const channel = await response.json() as { guild_id?: string; name?: string; type?: number };
  if (!channel.guild_id || !channel.name || channel.type !== 0 || !/^\d{17,20}$/.test(channel.guild_id)) {
    throw new ProviderConfigurationError('Choose a server text channel.');
  }
  return { name: channel.name, guildId: channel.guild_id };
}

async function sendDiscord(
  workspace: string,
  channel: { externalId: string; guildId: string | null },
  nonce: string,
  content: string,
  image?: PublishingImage,
): Promise<PublishResult> {
  if (!channel.guildId) return { kind: 'failed', error: 'Reconnect the Discord channel.' };
  let headers;
  try {
    headers = configuration(workspace, channel.externalId);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) return { kind: 'failed', error: error.message };
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
      return retryAfter(retry_after);
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
