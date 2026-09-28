import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import IndexView from '../../index-view';
import { getPublicIndex } from '../../../lib/public-index';
import { getProPreview, proPreviewEnabled, rangeFrom } from '../../../lib/pro-data';
export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
// Local development only (see lib/pro-data.ts). A production server always returns 404 here.
export default async function SubscriberPreview({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  if (process.env.NODE_ENV === 'production' || !proPreviewEnabled()) notFound();
  const range = rangeFrom((await searchParams).range);
  const [index, data] = await Promise.all([getPublicIndex(), getProPreview(range)]);
  return <IndexView index={index} subscriber={{ data, range, basePath: '/preview/subscriber' }}/>;
}
