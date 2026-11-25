import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Basic CSP: same-origin only, no external hosts. Next injects inline bootstrap scripts, so
 * 'unsafe-inline' is needed for scripts until a nonce-based policy is added (known gap); dev adds
 * 'unsafe-eval' for React refresh.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  // Production only: bundle migrations and fixtures with the serverless functions.
  ...(process.env.NODE_ENV === 'production'
    ? { outputFileTracingIncludes: { '/**': ['./drizzle/**/*', './fixtures/**/*'] } }
    : {}),
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};
export default nextConfig;
