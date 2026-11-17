const send = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.href === 'https://www.linkedin.com/oauth/v2/accessToken') {
    if (init?.body?.get('code') !== 'playwright-linkedin-code') return Response.json({}, { status: 400 });
    return Response.json({ access_token: 'playwright-linkedin-access', expires_in: 3600, scope: 'openid profile w_member_social' });
  }
  if (url.href === 'https://api.linkedin.com/v2/userinfo') {
    if (init?.headers?.Authorization !== 'Bearer playwright-linkedin-access') return Response.json({}, { status: 401 });
    return Response.json({ sub: 'browser-fixture-member', name: 'Browser Fixture Member' });
  }
  return send(input, init);
};
