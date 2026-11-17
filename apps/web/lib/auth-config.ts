export function emailConfig() {
  const { APP_URL, EMAIL_FROM, RESEND_API_KEY } = process.env;
  if (!APP_URL || !EMAIL_FROM || !RESEND_API_KEY) return null;
  try {
    const url = new URL(APP_URL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      return null;
    }
    return { url, from: EMAIL_FROM, apiKey: RESEND_API_KEY };
  } catch {
    return null;
  }
}

export function signInConfigured() {
  const config = emailConfig();
  const { AUTH_URL, AUTH_SECRET, DATABASE_URL } = process.env;
  if (!config || !AUTH_URL || !AUTH_SECRET || !DATABASE_URL) return false;
  try {
    return new URL(AUTH_URL).origin === config.url.origin;
  } catch {
    return false;
  }
}
