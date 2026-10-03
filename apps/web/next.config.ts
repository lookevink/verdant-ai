import type { NextConfig } from "next";
const apiOrigin = process.env.API_ORIGIN ?? "http://127.0.0.1:3001";
const config: NextConfig = {
  transpilePackages: ["@verdant/contracts"],
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};
export default config;
