const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.href === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'fixture-youtube-access', expires_in: 3600, refresh_token: 'fixture-youtube-refresh' });
  }
  if (url.origin === 'https://www.googleapis.com' && url.pathname === '/youtube/v3/channels') {
    return Response.json({ items: [{ id: 'UC_fixture_channel', snippet: { title: 'Fixture YouTube' } }] });
  }
  if (url.origin === 'https://api.x.com' && url.pathname === '/2/oauth2/token') {
    return Response.json({ access_token: 'fixture-x-access', refresh_token: 'fixture-x-refresh', expires_in: 7200 });
  }
  if (url.origin === 'https://api.x.com' && url.pathname === '/2/users/me') {
    return Response.json({ data: { id: '123456789012345678', name: 'Fixture X', username: 'fixture_x' } });
  }
  return originalFetch(input, init);
};
