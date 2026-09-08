/**
 * Next.js configuration for the CORPUS admin dashboard.
 *
 * The dashboard is a *client* of the Worker API and holds no secrets
 * (CLAUDE.md §34): the only build-time value it receives is the public API
 * base URL. All data access goes through the API, which re-checks every
 * permission.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Cloudflare Pages serves the app; images are not optimised server-side.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
        ],
      },
    ]
  },
}

export default nextConfig
