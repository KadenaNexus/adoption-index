import type { NextConfig } from "next";

// Sent on every route. HSTS only in production, where Nginx serves HTTPS; locally the site runs on plain http.
// The sign-in link page adds no-referrer (a later matching rule overrides the same header key).
export function securityHeaders(production = process.env.NODE_ENV === "production") {
  return [
    {
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
      ],
    },
    { source: "/signin/verify", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
  ];
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Production builds start fresh. On the server, a build that reused this cache (on by default in Next 16) shipped
  // the new pages with the previous stylesheet.
  experimental: { turbopackFileSystemCacheForBuild: false },
  async headers() {
    return securityHeaders();
  },
};

export default nextConfig;
