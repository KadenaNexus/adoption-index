import { getPublicIndex, publicSummary } from '../../../lib/public-index';
import { collectionPeriod, INITIAL_HISTORY_DAYS } from '../../../lib/preview-state';
export const dynamic = 'force-dynamic';
export async function GET() { return Response.json({ ...publicSummary(await getPublicIndex()), collectionStart: collectionPeriod().start, initialHistoryDays: INITIAL_HISTORY_DAYS, summaryRetention: 'permanent' }, { headers: { 'Cache-Control': 'no-store' } }); }
