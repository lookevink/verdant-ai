import type { Metadata } from "next";

// The apex domain redirects to www in production. Keep every discovery URL consistent.
export const siteUrl = "https://www.verdant-ai.com";
export const siteName = "Verdant AI";
export const siteDescription = "Query climate and agricultural data through an API or MCP. Get normalized NOAA and SILO data in JSON or CSV, with source provenance and versioned datasets.";
export const isPreview = process.env.VERCEL_ENV === "preview";

const socialImage = {
  url: "/brand/verdant-og.jpg",
  width: 1200,
  height: 630,
  alt: "Verdant AI — Climate data for AI agents. Ready to query. Evidence intact. A green meadow beneath a pale sky.",
};

export function pageMetadata(title: string, description: string, pathname: string): Metadata {
  return {
    title: { absolute: `${title} | ${siteName}` },
    description,
    alternates: { canonical: pathname },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName,
      url: pathname,
      title: `${title} | ${siteName}`,
      description,
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${siteName}`,
      description,
      images: [socialImage],
    },
  };
}

export const siteStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${siteUrl}/#organization`,
      name: siteName,
      url: `${siteUrl}/`,
      logo: `${siteUrl}/brand/verdant-icon-512.png`,
    },
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/#website`,
      name: siteName,
      url: `${siteUrl}/`,
      description: siteDescription,
      inLanguage: "en",
      publisher: { "@id": `${siteUrl}/#organization` },
    },
  ],
};
