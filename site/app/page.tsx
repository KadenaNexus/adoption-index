import IndexView from './index-view';
import { isSubscriber } from '../lib/account-view';
import { getProData, rangeFrom } from '../lib/pro-data';
import { getPublicIndex } from '../lib/public-index';
import { getAccountState, getSessionToken, requestClientIp } from '../lib/session';
export const dynamic = 'force-dynamic';

// View B for active subscribers only. Everyone else gets view A: no Pro request is made and no Pro data is rendered.
export default async function Home({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const [index, state] = await Promise.all([getPublicIndex(), getAccountState()]);
  if (!isSubscriber(state)) {
    const notice = state.state === 'unavailable' ? <p className="site-notice" role="status">We couldn’t load your account just now, so this is the free view. Please reload in a minute.</p> : undefined;
    return <IndexView index={index} notice={notice}/>;
  }
  const requested = rangeFrom((await searchParams).range);
  const data = await getProData(requested, await getSessionToken(), await requestClientIp());
  return <IndexView index={index} subscriber={{ data, range: data?.history.range ?? requested, basePath: '/' }}/>;
}
