import { botToken, ProviderConfigurationError, retryAfter, type BotProviderAdapter } from './provider-contract';

function auth(workspace: string, destinationId: string) {
  return { Authorization: `Bearer ${botToken(slack, workspace, destinationId)}` };
}

type SlackConversation = { id?: string; name?: string; is_archived?: boolean; is_member?: boolean };
type SlackResponse = { ok?: boolean; channel?: SlackConversation | string; ts?: string; permalink?: string; error?: string };

async function request(method: string, headers: HeadersInit, query?: Record<string, string>, body?: Record<string, unknown>) {
  const url = new URL(`https://slack.com/api/${method}`);
  if (query) url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => null) as SlackResponse | null;
  return { response, data };
}

function slackPermalink(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.endsWith('.slack.com')
      ? url.href : null;
  } catch {
    return null;
  }
}

export const slack: BotProviderAdapter = {
  kind: 'bot',
  name: 'Slack',
  tokenEnv: 'SLACK_BOT_TOKEN',
  grantsEnv: 'SLACK_WORKSPACE_CHANNELS',
  destinationLabel: 'Channel ID',
  destinationPattern: /^[CG][A-Z0-9]{8,34}$/,
  textLimit: 4000,
  imageCaptionLimit: null,
  connectionHelp: 'Install the Slack bot, invite it to the channel and ask your operator to enable the channel ID. Text posts are supported.',
  async discover(workspace, destinationId) {
    const headers = auth(workspace, destinationId);
    try {
      const { response, data } = await request('conversations.info', headers, { channel: destinationId });
      const channel = data?.channel;
      if (response.ok && data?.ok && typeof channel === 'object' && channel.name && channel.is_member
        && channel.id === destinationId && !channel.is_archived) return { name: channel.name };
    } catch {
      // A transport failure must not leak authorization details.
    }
    throw new ProviderConfigurationError('The Slack bot could not read that channel. Check installation, membership and scopes.');
  },
  async publish(workspace, channel, _nonce, content) {
    let headers;
    try {
      headers = auth(workspace, channel.externalId);
    } catch (error) {
      if (error instanceof ProviderConfigurationError) return { kind: 'failed', error: error.message };
      throw error;
    }
    try {
      const { response, data } = await request('chat.postMessage', headers, undefined, {
        channel: channel.externalId, text: content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        mrkdwn: false, unfurl_links: false, unfurl_media: false,
      });
      if (response.status === 429 || data?.error === 'ratelimited') return retryAfter(Number(response.headers.get('Retry-After')));
      if (response.status >= 500 || !data || ['internal_error', 'fatal_error', 'request_timeout'].includes(data.error ?? '')) {
        return { kind: 'uncertain', error: 'The Slack result is unclear. Check the channel before sending again.' };
      }
      if (!response.ok || !data.ok) return { kind: 'failed', error: 'Slack rejected the message. Check bot channel access and chat:write scope.' };
      if (!data.ts || !/^\d+\.\d+$/.test(data.ts) || data.channel !== channel.externalId) {
        return { kind: 'uncertain', error: 'Slack returned no usable message timestamp. Check the channel before sending again.' };
      }
      const externalId = data.ts;
      let permalink = null;
      try {
        const link = await request('chat.getPermalink', headers, { channel: channel.externalId, message_ts: externalId });
        if (link.response.ok && link.data?.ok) permalink = slackPermalink(link.data.permalink);
      } catch {
        // The write succeeded. A failed link lookup must never cause a second publication.
      }
      return { kind: 'published', externalId, permalink };
    } catch {
      return { kind: 'uncertain', error: 'The Slack result is unclear. Check the channel before sending again.' };
    }
  },
};
