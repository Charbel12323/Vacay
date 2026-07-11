import type { NextConfig } from "next";

/**
 * Security headers (Stage 9 task 8). The CSP is tuned for exactly two
 * external dependencies: Plaid Link (script + iframe + API) and nothing
 * else. 'unsafe-inline' for scripts is Next.js App Router's hydration
 * bootstrap; revisit with nonces if the framework's story improves.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.plaid.com https://*.plaid.com",
  "font-src 'self' data:",
  "connect-src 'self' https://cdn.plaid.com https://sandbox.plaid.com https://production.plaid.com",
  "frame-src https://cdn.plaid.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
