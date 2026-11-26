export const metadata = { title: 'Connection · Superstar', robots: { index: false, follow: false }, referrer: 'no-referrer' };

// Results of a connection a client made through an agency's connect link. Shows no workspace data.
const results: Record<string, [string, string]> = {
  saved: ['You\'re connected', 'Your account is now connected. You can close this page; whoever sent you the link can start scheduling posts.'],
  'oauth-canceled': ['Nothing was connected', 'You canceled the sign-in. Open the link again whenever you are ready.'],
  'meta-canceled': ['Nothing was connected', 'You canceled the Facebook sign-in. Open the link again whenever you are ready.'],
  'meta-permissions': ['Some access was not granted', 'Open the link again and allow every permission Facebook asks for, otherwise posts cannot be published.'],
  'meta-empty': ['No Pages found', 'Facebook shared no Page you can publish to. Open the link again, choose "Edit access" on Facebook and tick your Pages. Personal profiles can\'t be connected. Instagram needs a professional account linked to a Facebook Page.'],
  'meta-unavailable': ['The connection did not complete', 'Facebook did not finish the connection. Open the link again and try once more.'],
  'linkedin-pages-not-approved': ['LinkedIn Pages are not available yet', 'LinkedIn is still reviewing company-page access for Superstar. Ask whoever sent the link for a LinkedIn profile link instead.'],
  'linkedin-no-pages': ['No LinkedIn Pages found', 'LinkedIn found no company page where you are an administrator.'],
  'linkedin-unavailable': ['The connection did not complete', 'LinkedIn did not finish the connection. Open the link again and try once more.'],
  'youtube-unavailable': ['The connection did not complete', 'Google did not finish the connection. Open the link again and try once more.'],
  'youtube-no-channel': ['No YouTube channel', 'That Google account has no YouTube channel. Create one at youtube.com, then open the link again.'],
  'x-unavailable': ['The connection did not complete', 'X did not finish the connection. On X, tick "I trust this app" before authorizing, then open the link again.'],
  'plan-limit': ['Nothing was connected', 'The workspace you are connecting to has reached its channel limit. Let whoever sent you the link know.'],
  invalid: ['This link is no longer valid', 'The link expired, was revoked, or this attempt timed out. Ask whoever sent it to you for a new one, or open it again.'],
};

export default async function ConnectLinkDone({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status = 'invalid' } = await searchParams;
  const [title, text] = results[Object.hasOwn(results, status) ? status : 'invalid']!;
  return (
    <main className="identity-shell">
      <p className="wordmark">Superstar</p>
      <h1>{title}</h1>
      <p role="status">{text}</p>
    </main>
  );
}
