import type { MetadataRoute } from 'next';

// Public pages only. Sign-in, account, checkout, report and admin pages are noindex.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://adoption.kadena.ws';
  return [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/methodology`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/access`, changeFrequency: 'monthly', priority: 0.4 },
  ];
}
