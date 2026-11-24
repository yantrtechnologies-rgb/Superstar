import { botToken, ProviderConfigurationError, retryAfter, type BotProviderAdapter, type PublishingImage, type PublishResult } from './provider-contract';

type TelegramChat = { id?: number; type?: string; title?: string };
type TelegramResponse<T> = { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
type TelegramMessage = { message_id?: number; chat?: TelegramChat };

function endpoint(workspace: string, destinationId: string, method: 'getChat' | 'getChatMemberCount' | 'sendMessage' | 'sendPhoto') {
  const token = botToken(telegram, workspace, destinationId);
  if (!Number.isSafeInteger(Number(destinationId))) throw new ProviderConfigurationError('The Telegram destination ID is invalid.');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new ProviderConfigurationError('The Telegram bot token is invalid.');
  return `https://api.telegram.org/bot${token}/${method}`;
}

export const telegram: BotProviderAdapter = {
  kind: 'bot',
  name: 'Telegram',
  tokenEnv: 'TELEGRAM_BOT_TOKEN',
  grantsEnv: 'TELEGRAM_WORKSPACE_CHATS',
  destinationLabel: 'Channel or supergroup ID',
  destinationPattern: /^-100\d{7,13}$/,
  textLimit: 4096,
  imageCaptionLimit: 1024,
  connectionHelp: 'Add the bot to the channel or supergroup. Grant posting rights and ask your operator to enable its numeric ID.',
  async discover(workspace, destinationId) {
    const url = endpoint(workspace, destinationId, 'getChat');
    try {
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: Number(destinationId) }),
      });
      const data = await response.json() as TelegramResponse<TelegramChat>;
      const chat = data.result;
      if (response.ok && data.ok && chat?.title && String(chat.id) === destinationId
        && (chat.type === 'channel' || chat.type === 'supergroup')) return { name: chat.title };
    } catch {
      // The Bot API URL includes credentials. Keep transport errors out of user responses and logs.
    }
    throw new ProviderConfigurationError('The bot could not read that Telegram channel or supergroup.');
  },
  publish: (workspace, channel, _nonce, content, image) => sendTelegram(workspace, channel, content, image),
  reply: (workspace, channel, _nonce, content, parentId) => sendTelegram(workspace, channel, content, undefined, parentId),
};

async function sendTelegram(
  workspace: string, channel: { externalId: string }, content: string, image?: PublishingImage, replyTo?: string,
): Promise<PublishResult> {
    const reply = replyTo && /^\d+$/.test(replyTo) ? { message_id: Number(replyTo), allow_sending_without_reply: false } : undefined;
    let url;
    try {
      url = endpoint(workspace, channel.externalId, image ? 'sendPhoto' : 'sendMessage');
    } catch (error) {
      if (error instanceof ProviderConfigurationError) return { kind: 'failed', error: error.message };
      throw error;
    }
    let headers: HeadersInit | undefined;
    let body: FormData | string;
    if (image) {
      body = new FormData();
      body.set('chat_id', channel.externalId);
      body.set('caption', content);
      if (reply) body.set('reply_parameters', JSON.stringify(reply));
      body.set('photo', new Blob([image.bytes], { type: image.type }), image.type === 'image/png' ? 'photo.png' : 'photo.jpg');
    } else {
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({
        chat_id: Number(channel.externalId), text: content, link_preview_options: { is_disabled: true },
        ...(reply ? { reply_parameters: reply } : {}),
      });
    }
    try {
      const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const data = await response.json().catch(() => null) as TelegramResponse<TelegramMessage> | null;
      if (response.status === 429 || data?.error_code === 429) return retryAfter(data?.parameters?.retry_after);
      if (response.status >= 500 || !data) return { kind: 'uncertain', error: 'The Telegram result is unclear. Check the chat before sending again.' };
      if (!response.ok || !data.ok) return { kind: 'failed', error: 'Telegram rejected the message. Check bot posting rights and attachment rules.' };
      const id = data.result?.message_id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || String(data.result?.chat?.id) !== channel.externalId) {
        return { kind: 'uncertain', error: 'Telegram returned no usable message ID. Check the chat before sending again.' };
      }
      return { kind: 'published', externalId: String(id), permalink: `https://t.me/c/${channel.externalId.slice(4)}/${id}` };
    } catch {
      return { kind: 'uncertain', error: 'The Telegram result is unclear. Check the chat before sending again.' };
    }
}

export async function telegramMemberCount(workspace: string, destinationId: string) {
  try {
    const url = endpoint(workspace, destinationId, 'getChatMemberCount');
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: Number(destinationId) }),
    });
    const data = await response.json() as TelegramResponse<number>;
    const count = data.result;
    return response.ok && data.ok && typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 2147483647
      ? count : null;
  } catch {
    // Bot API URLs include the token. Reporting a generic unavailable state keeps it private.
    return null;
  }
}
