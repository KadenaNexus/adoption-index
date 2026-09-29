import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { backendFetch } from './backend';
import { clientIpFrom } from './request-guard';
import { SESSION_COOKIE, TOKEN_PATTERN } from './session-cookie';

export { SESSION_COOKIE, sessionCookieOptions } from './session-cookie';

export type Subscription = { plan: string; startedAt: string; expiresAt: string; active: boolean };
export type AccountPayment = {
  id: number; rail: 'evm'; network: string; chain: string; txHash: string; token: string; amount: string; required: string; decimals: number;
  overpaid: boolean; plan: string; status: 'pending' | 'confirmed' | 'underpaid' | 'failed'; failureReason: string | null; from: string; to: string;
  source: 'checkout' | 'manual' | 'reconciler'; createdAt: string; confirmedAt: string | null; periodStart: string | null; periodEnd: string | null; explorerUrl: string | null;
};
export type Account = {
  email: string; isAdmin: boolean; subscription: Subscription | null;
  wallets: { address: string; linkedAt: string }[];
  alerts: { id: number; direction: 'above' | 'below'; threshold: number }[];
  payments: AccountPayment[];
  testPlanAvailable: boolean;
  billing: { enabled: boolean; testnet: boolean };
  supportEmail: string | null;
  signinOpen: boolean;
};

/** The session token from the httpOnly cookie, if it has the right shape. */
export async function getSessionToken(): Promise<string | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return value && TOKEN_PATTERN.test(value) ? value : null;
}

export async function requestClientIp(): Promise<string> { return clientIpFrom(await headers()); }

export type AccountState = { state: 'signed-out' } | { state: 'unavailable' } | { state: 'signed-in'; account: Account };
/**
 * The visitor's account, one backend call per request. 'unavailable' (backend down or slow) is not the same as
 * signed out: pages say "try again" instead of sending a subscriber back to sign-in.
 */
export const getAccountState = cache(async (): Promise<AccountState> => {
  const session = await getSessionToken();
  if (!session) return { state: 'signed-out' };
  const { status, data } = await backendFetch<Account>('/account', { session, clientIp: await requestClientIp() });
  if (status === 200 && data) return { state: 'signed-in', account: data };
  return status === 401 ? { state: 'signed-out' } : { state: 'unavailable' };
});
