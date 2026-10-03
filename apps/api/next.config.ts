import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  transpilePackages: ["@verdant/contracts", "@verdant/queue"], poweredByHeader: false,
  turbopack: { root: path.resolve(__dirname, "../..") },
};
export default config;
