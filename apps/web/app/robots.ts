import type { MetadataRoute } from "next";
import { isPreview, siteUrl } from "./seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: isPreview
      ? { userAgent: "*", disallow: "/" }
      : { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
