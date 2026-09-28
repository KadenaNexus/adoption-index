import { getPublicIndex } from '../../../lib/public-index';
import { COLLECTION_START } from '../../../lib/preview-state';

export const dynamic = 'force-dynamic';
export async function GET() {
  const index = await getPublicIndex();
  return Response.json({ checks: [], updatedAt: index.updatedAt, state: index.state,
    throughDay: index.day, collectionStart: COLLECTION_START, initialHistoryDays: 90,
    summaryRetention: 'permanent' }, { headers: { 'Cache-Control': 'no-store' } });
}
