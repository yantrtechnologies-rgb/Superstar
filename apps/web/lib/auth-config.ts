/** SMTP (for example Gmail with an app password) when SMTP_HOST, SMTP_USER and SMTP_PASSWORD are set. */
export function smtpConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;
  const port = Number(SMTP_PORT || 465);
  return { host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass: SMTP_PASSWORD.replace(/\s+/g, '') } };
}

export function emailConfig() {
  const { APP_URL, RESEND_API_KEY } = process.env;
  const smtp = smtpConfig();
  const EMAIL_FROM = process.env.EMAIL_FROM || (smtp ? `Superstar <${smtp.auth.user}>` : undefined);
  if (!APP_URL || !EMAIL_FROM || (!RESEND_API_KEY && !smtp)) return null;
  try {
    const url = new URL(APP_URL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      return null;
    }
    // The Resend provider type needs an API key string; with SMTP it is never used.
    return { url, from: EMAIL_FROM, apiKey: RESEND_API_KEY || 'smtp', smtp };
  } catch {
    return null;
  }
}

/** Sign in with Google. Uses GOOGLE_SIGNIN_CLIENT_ID/SECRET, or the YouTube OAuth client from the same Google project. */
export function googleSignInConfig() {
  const clientId = process.env.GOOGLE_SIGNIN_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SIGNIN_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret || process.env.GOOGLE_SIGNIN_DISABLED === 'true' || !emailConfig()) return null;
  return { clientId, clientSecret };
}

/** Password sign-in needs no email provider, only the app URL, auth secret and database. */
export function passwordSignInConfigured() {
  const { APP_URL, AUTH_SECRET, DATABASE_URL } = process.env;
  if (!APP_URL || !AUTH_SECRET || !DATABASE_URL) return false;
  try { return ['http:', 'https:'].includes(new URL(APP_URL).protocol); } catch { return false; }
}

/** The Auth.js session cookie, named and flagged exactly as auth.ts configures it. */
export function sessionCookie() {
  const secure = process.env.APP_URL?.startsWith('https:') ?? false;
  return { name: (secure ? '__Secure-' : '') + 'authjs.session-token', secure };
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
