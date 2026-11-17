const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://graph.facebook.com') return originalFetch(input, init);
  const path = url.pathname.replace(/^\/v[0-9]+\.0\//, '');
  if (path === 'oauth/access_token') {
    if (url.searchParams.get('code') !== 'fixture-meta-code' &&
        url.searchParams.get('fb_exchange_token') !== 'fixture-meta-user') {
      return Response.json({}, { status: 400 });
    }
    return Response.json({ access_token: 'fixture-meta-user', expires_in: 3600 });
  }
  if (init?.headers?.Authorization !== 'Bearer fixture-meta-user') return Response.json({}, { status: 401 });
  if (path === 'me/permissions') return Response.json({ data: [
    'pages_show_list', 'pages_read_engagement', 'instagram_basic',
  ].map((permission) => ({ permission, status: 'granted' })) });
  if (path === 'me/accounts') return Response.json({ data: [
    { id: '1234567890', name: 'Fieldwork Page', access_token: 'fixture-page-token',
      instagram_business_account: { id: '17899999999999', username: 'fieldwork.studio' } },
    { id: '1234567891', name: 'Unselected Page', access_token: 'fixture-other-page-token' },
  ] });
  throw new Error('Unexpected Meta fixture request');
};
