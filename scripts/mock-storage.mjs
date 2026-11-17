const send = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'http://127.0.0.1:3931') {
    if (init?.method !== 'PUT' || !url.searchParams.has('X-Amz-Signature')
      || init?.headers?.['Content-Type'] !== 'video/mp4'
      || Buffer.from(init.body).subarray(4, 8).toString() !== 'ftyp') {
      return new Response(null, { status: 400 });
    }
    return new Response(null, { status: 200 });
  }
  return send(input, init);
};
