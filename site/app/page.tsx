import IndexView from './index-view';
import { getPublicIndex } from '../lib/public-index';
export const dynamic = 'force-dynamic';
export default async function Home() { return <IndexView index={await getPublicIndex()}/>; }
