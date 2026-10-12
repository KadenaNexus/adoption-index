import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/admin', '/account', '/checkout', '/signin', '/report'] },
    sitemap: 'https://adoption.kadena.ws/sitemap.xml',
  };
}
