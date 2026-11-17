const config = {
  experimental: { serverActions: { bodySizeLimit: '3mb' } },
  async headers() {
    return [{
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
