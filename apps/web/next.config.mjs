const config = {
  experimental: { serverActions: { bodySizeLimit: '22mb' } },
  outputFileTracingIncludes: {
    '/*': ['../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**'],
  },
  async headers() {
    return [{
      // Brand images (app icons) may be fetched by other sites, e.g. developer consoles that take the app icon.
      source: '/brand/:path*',
      headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }, { key: 'Cache-Control', value: 'public, max-age=86400' }],
    }, {
      source: '/app/:workspace/channels/meta',
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'Cache-Control', value: 'private, no-store' }],
    }, {
      source: '/review/:path*',
      headers: [
        { key: 'Cache-Control', value: 'private, no-store' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ],
    }];
  },
};

export default config;
