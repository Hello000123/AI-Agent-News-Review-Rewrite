import { hostname, networkInterfaces } from "node:os";

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

function localDevelopmentOrigins() {
  const origins = new Set<string>();
  const machineHostname = hostname().trim();

  if (machineHostname) origins.add(machineHostname);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) origins.add(address.address.split("%")[0]);
    }
  }

  return [...origins];
}

const nextConfig: NextConfig = {
  // Next.js protects development assets (including webpack HMR) with an
  // origin allowlist. Include this machine's active LAN/VPN addresses so a
  // page opened from another device hydrates instead of falling back to a
  // plain HTML form submission.
  allowedDevOrigins: localDevelopmentOrigins(),
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      {
        source: "/employee/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
