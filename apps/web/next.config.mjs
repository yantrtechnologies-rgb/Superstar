const config = {
  experimental: { serverActions: { bodySizeLimit: '22mb' } },
  outputFileTracingIncludes: {
    '/*': ['../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**'],
  },
  async headers() {
    return [{
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
