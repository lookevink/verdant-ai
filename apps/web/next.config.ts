import type { NextConfig } from "next";
import path from "node:path";
const apiOrigin = process.env.API_ORIGIN || "http://127.0.0.1:3001";
if (process.env.VERCEL && !process.env.API_ORIGIN) {
  throw new Error("API_ORIGIN must point to the matching API deployment before building on Vercel.");
}
const config: NextConfig = {
  transpilePackages: ["@verdant/contracts"],
  poweredByHeader: false,
  turbopack: { root: path.resolve(__dirname, "../..") },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};
export default config;
