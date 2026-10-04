import type { MetadataRoute } from "next";
import { siteUrl } from "./seo";

export default function sitemap(): MetadataRoute.Sitemap {
  // Only public pages, without question/session query parameters or invented modification dates.
  return [{ url: `${siteUrl}/` }, { url: `${siteUrl}/playground` }];
}
