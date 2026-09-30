// Pure checkout helpers: BNB Smart Chain transfers, WalletConnect sessions, plans, messages and payment polling.
// No DOM and no Next.js imports, so tests import this file directly.
import { plans } from './billing-terms.ts';
import { record, type Payload } from './payload.ts';

export const TRANSFER_SELECTOR = '0xa9059cbb';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
// BigInt() rather than literals: the site compiles for ES2017.
const ZERO = BigInt(0), TEN = BigInt(10), MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

const str = (value: unknown, max = 256): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

export const isAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value);
export const isTxHash = (value: unknown): value is string => typeof value === 'string' && TX_HASH.test(value);
/** A pasted transaction hash, trimmed and lowercased, or null when it is not one. */
export function normalizeTxHash(value: unknown): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return isTxHash(v) ? v.toLowerCase() : null;
}

/** ERC-20 `transfer(to, amount)` call data. Amounts are integers in the token's base units. */
export function encodeTransfer(to: string, amount: bigint | string): string {
  if (!isAddress(to)) throw new Error('Invalid recipient address');
  if (typeof amount === 'string' && !/^\d{1,78}$/.test(amount)) throw new Error('Invalid amount');
  const value = BigInt(amount);
  if (value <= ZERO || value > MAX_UINT256) throw new Error('Invalid amount');
  return TRANSFER_SELECTOR + to.slice(2).toLowerCase().padStart(64, '0') + value.toString(16).padStart(64, '0');
}

/** The UTF-8 bytes of a message as 0x-hex, for personal_sign. TextEncoder, so non-ASCII emails sign correctly. */
export function utf8ToHex(text: string): string {
  let hex = '0x';
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function chainIdHex(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid chain id');
  return '0x' + chainId.toString(16);
}
/** Wallets report eth_chainId as hex (the standard), and a few as a number or decimal string. */
export function parseChainId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const n = /^0x[0-9a-f]{1,13}$/i.test(v) ? parseInt(v.slice(2), 16) : /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export const sameChain = (value: unknown, chainId: number) => parseChainId(value) === chainId;

/** Base units → a decimal string without trailing zeros ("9", "9.5"). */
export function formatTokenAmount(value: bigint | string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid decimals');
  if (typeof value === 'string' && !/^-?\d{1,80}$/.test(value)) throw new Error('Invalid amount');
  const v = BigInt(value), base = TEN ** BigInt(decimals), sign = v < ZERO ? '-' : '', abs = v < ZERO ? -v : v;
  const fraction = decimals ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${sign}${abs / base}${fraction ? '.' + fraction : ''}`;
}

/** "0x4274…2e98": enough to recognise an address or hash; the full one is shown where it matters. */
export function shortAddress(value: string, head = 6, tail = 4): string {
  if (typeof value !== 'string') return '';
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
export function explorerTxUrl(explorerUrl: string | null | undefined, hash: string): string | null {
  if (!explorerUrl || !/^https:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/i.test(explorerUrl) || !isTxHash(hash)) return null;
  return `${explorerUrl.replace(/\/$/, '')}/tx/${hash.toLowerCase()}`;
}

// EIP-1193 errors. MetaMask Mobile reports an unknown chain as -32603 with data.originalError.code 4902. Over
// WalletConnect a refusal is 5000-5003 (or only the message, "User rejected."), 6000 is the wallet disconnecting, and a
// request the wallet never answered expires.
export type WalletErrorKind = 'user_rejected' | 'chain_not_added' | 'request_pending' | 'unsupported_method' | 'unauthorized' | 'disconnected' | 'request_expired' | 'wallet_error';
function errorCodes(error: unknown): unknown[] {
  const e = record(error);
  if (!e) return [];
  const data = record(e.data);
  return [e.code, record(data?.originalError)?.code, data?.code, record(e.cause)?.code, record(e.error)?.code];
}
const messageOf = (error: unknown) => String(record(error)?.message ?? (typeof error === 'string' ? error : ''));
const KIND_BY_CODE: Record<string, WalletErrorKind> = {
  '4001': 'user_rejected', ACTION_REJECTED: 'user_rejected', '5000': 'user_rejected', '5001': 'user_rejected', '5002': 'user_rejected', '5003': 'user_rejected',
  '4902': 'chain_not_added', '-32002': 'request_pending', '4200': 'unsupported_method', '-32601': 'unsupported_method',
  '4100': 'unauthorized', '4900': 'disconnected', '4901': 'disconnected', '6000': 'disconnected',
};
export function classifyWalletError(error: unknown): WalletErrorKind {
  for (const code of errorCodes(error)) {
    const kind = (typeof code === 'number' || typeof code === 'string') ? KIND_BY_CODE[String(code)] : undefined;
    if (kind) return kind;
  }
  const message = messageOf(error);
  if (/user (rejected|denied|declined|disapproved|cancel)|(rejected|denied|declined|cancell?ed) by (the )?user/i.test(message)) return 'user_rejected';
  if (/unrecognized chain|try adding the chain|chain .{0,20}not (been )?(added|configured)/i.test(message)) return 'chain_not_added';
  // The WalletConnect session is gone (deleted by the wallet, or expired) while the page still held it.
  if (/recently deleted|no matching key|session topic doesn'?t exist|please call connect/i.test(message)) return 'disconnected';
  if (/request expired/i.test(message)) return 'request_expired';
  return 'wallet_error';
}

// WalletConnect. BSC is requested as an optional chain: required namespaces are deprecated (the provider sends them as
// optional anyway) and some wallets refuse a session that requires one. Whether BSC was approved is checked afterwards.
export type WalletConnectSettings = { projectId: string; chainId: number; rpcUrl: string; description: string };
export function walletConnectInit({ projectId, chainId, rpcUrl, description }: WalletConnectSettings, origin: string) {
  return {
    projectId, optionalChains: [chainId] as [number], rpcMap: { [chainId]: rpcUrl }, showQrModal: true,
    // The url must be the page's origin, or WalletConnect's Verify API flags the request as a domain mismatch.
    metadata: { name: 'Kadena Community Edition Adoption Index', description, url: origin, icons: [`${origin}/icon-192.png`] },
  };
}
/**
 * Why a WalletConnect connection didn't open. The provider rejects a closed QR modal with "Connection request reset"
 * and passes on only the message of a wallet's refusal, so both are recognised by their text.
 */
export function walletConnectFailure(error: unknown): string {
  const message = messageOf(error);
  if (/connection request reset/i.test(message)) return 'walletconnect_closed';
  if (/unsupported chains|rejected chains/i.test(message) || errorCodes(error).some(code => String(code) === '5100')) return 'wc_chain_missing';
  if (/proposal expired/i.test(message)) return 'walletconnect_expired';
  return classifyWalletError(error) === 'user_rejected' ? 'user_rejected' : 'walletconnect_failed';
}
function walletConnectAccounts(session: unknown, chainId: number): string[] {
  const accounts = record(record(record(session)?.namespaces)?.eip155)?.accounts;
  if (!Array.isArray(accounts)) return [];
  const prefix = `eip155:${chainId}:`;
  return accounts.filter((a): a is string => typeof a === 'string' && a.startsWith(prefix)).map(a => a.slice(prefix.length)).filter(isAddress);
}
/**
 * The address to pay from: an approved `eip155:<chainId>:<address>` account of the session, preferring the one the
 * wallet reported first. Null when the wallet did not approve this chain.
 */
export function walletConnectAddress(session: unknown, chainId: number, reported: unknown): string | null {
  const approved = walletConnectAccounts(session, chainId);
  const first = Array.isArray(reported) ? reported.find(a => isAddress(a) && approved.some(b => b.toLowerCase() === a.toLowerCase())) : undefined;
  return first ?? approved[0] ?? null;
}

export function noWalletMessage(walletConnect: boolean): string {
  const inApp = 'you can also open this page in the browser inside MetaMask, Trust Wallet or Binance Wallet; you’ll need to sign in there with the 6-digit code from your email.';
  return walletConnect
    ? `No browser wallet found. Connect with WalletConnect — scan the QR code or open your wallet app. Or ${inApp}`
    : `No browser wallet found. To pay from a phone, ${inApp}`;
}

// Plans. The admin-only test plan is reachable only when the account says so; anything else falls back to monthly.
export type CheckoutPlanId = 'monthly' | 'annual' | 'test';
export type CheckoutPlan = { id: CheckoutPlanId; name: string; price: number; days: number };
export const checkoutPlans: Record<CheckoutPlanId, CheckoutPlan> = {
  monthly: { id: 'monthly', name: plans.monthly.name, price: plans.monthly.price, days: plans.monthly.days },
  annual: { id: 'annual', name: plans.annual.name, price: plans.annual.price, days: plans.annual.days },
  test: { id: 'test', name: 'Test', price: 1, days: 1 },
};
export function checkoutPlan(value: unknown, testPlanAvailable: boolean): CheckoutPlan {
  if (value === 'annual') return checkoutPlans.annual;
  if (value === 'test' && testPlanAvailable === true) return checkoutPlans.test;
  return checkoutPlans.monthly;
}
export const planTerm = (plan: CheckoutPlan) => `One payment · ${plan.days} ${plan.days === 1 ? 'day' : 'days'}`;

/** "12 Oct 2026", in UTC so the server and the browser agree. */
export function formatExpiry(value: unknown): string | null {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
}

// /billing/config as the checkout uses it. Anything malformed keeps payments closed.
export type EvmToken = { symbol: string; address: string; decimals: number };
export type AddChainParams = { chainId: string; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] };
export type EvmConfig = { network: string; chainId: number; chainName: string; explorerUrl: string | null; addChainParams: AddChainParams; payTo: string; tokens: EvmToken[]; testnet: boolean };
export type CheckoutConfig = { evm: EvmConfig | null; walletConnectProjectId: string | null; signinOpen: boolean; supportEmail: string | null };

function parseAddChain(value: unknown, chainId: number): AddChainParams | null {
  const p = record(value), native = record(p?.nativeCurrency);
  const rpcUrls = Array.isArray(p?.rpcUrls) ? p.rpcUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u)) : [];
  const explorers = Array.isArray(p?.blockExplorerUrls) ? p.blockExplorerUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u)) : [];
  const chainName = str(p?.chainName, 80), name = str(native?.name, 40), symbol = str(native?.symbol, 12);
  if (!p || !sameChain(p.chainId, chainId) || !chainName || !name || !symbol || native?.decimals !== 18 || !rpcUrls.length) return null;
  return { chainId: chainIdHex(chainId), chainName, nativeCurrency: { name, symbol, decimals: 18 }, rpcUrls, blockExplorerUrls: explorers };
}
function parseEvm(data: Payload): EvmConfig | null {
  if (data.enabled !== true) return null;
  const chainId = typeof data.chainId === 'number' ? data.chainId : NaN;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(data.payTo)) return null;
  const addChainParams = parseAddChain(data.addChainParams, chainId);
  const tokens = (Array.isArray(data.tokens) ? data.tokens : []).map(record).flatMap(t => {
    const symbol = str(t?.symbol, 12), decimals = t?.decimals;
    return symbol && /^[A-Z0-9]{2,12}$/.test(symbol) && isAddress(t?.address) && typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36
      ? [{ symbol, address: t.address as string, decimals }] : [];
  });
  if (!addChainParams || !tokens.length) return null;
  const explorer = str(data.explorerUrl, 200);
  return { network: str(data.network, 40) ?? '', chainId, chainName: str(data.chainName, 80) ?? addChainParams.chainName, explorerUrl: explorer && /^https:\/\//.test(explorer) ? explorer : null,
    addChainParams, payTo: data.payTo as string, tokens, testnet: data.testnet === true || data.network === 'bsc-testnet' };
}
export function parseCheckoutConfig(billing: unknown): CheckoutConfig {
  const data = record(billing) ?? {};
  const evm = parseEvm(data);
  const projectId = typeof data.walletConnectProjectId === 'string' && /^[0-9a-f]{32}$/.test(data.walletConnectProjectId) ? data.walletConnectProjectId : null;
  const support = str(data.supportEmail, 254);
  return { evm, walletConnectProjectId: evm ? projectId : null, signinOpen: data.signinOpen !== false, supportEmail: support && /^[^\s@<>]+@[^\s@<>]+$/.test(support) ? support : null };
}

// Backend replies, reduced to the fields the checkout uses. The site's route handlers relay only these.
export type Intent = { intentId: string | number; payTo: string; tokenAddress: string; token: string; decimals: number; amount: string; amountDisplay: string; chainId: number; expiresAt: string | null };
/** An intent id as the backend sends it: a positive integer, or its digits as a string. */
export const parseIntentId = (value: unknown): string | number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : typeof value === 'string' && /^\d{1,19}$/.test(value) ? value : null;
export function pickIntent(value: unknown): Intent | null {
  const d = record(value);
  const intentId = parseIntentId(d?.intentId), amount = typeof d?.amount === 'string' && /^\d{1,78}$/.test(d.amount) ? d.amount : null, decimals = d?.decimals;
  if (!d || intentId === null || !isAddress(d.payTo) || !isAddress(d.tokenAddress) || !amount || BigInt(amount) <= ZERO || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const chainId = parseChainId(d.chainId), token = str(d.token, 12);
  if (!chainId || !token) return null;
  return { intentId, payTo: d.payTo as string, tokenAddress: d.tokenAddress as string, token, decimals, amount,
    amountDisplay: str(d.amountDisplay, 40) ?? formatTokenAmount(amount, decimals), chainId, expiresAt: str(d.expiresAt, 40) };
}
export type Challenge = { nonce: string; message: string; expiresAt: string | null };
export function pickChallenge(value: unknown): Challenge | null {
  const d = record(value), nonce = str(d?.nonce, 128), message = str(d?.message, 2000);
  return nonce && message ? { nonce, message, expiresAt: str(d?.expiresAt, 40) } : null;
}
export function pickLink(value: unknown): { ok: true; address: string | null } {
  const address = record(value)?.address;
  return { ok: true, address: isAddress(address) ? address : null };
}
export type PaymentStatus = 'pending' | 'confirmed' | 'underpaid' | 'failed';
export type PaymentResult = {
  status: PaymentStatus;
  payment: { status: PaymentStatus | null; txHash: string | null; failureReason: string | null; periodEnd: string | null; explorerUrl: string | null } | null;
  subscription: { plan: string | null; expiresAt: string | null; active: boolean } | null;
};
const STATUSES: PaymentStatus[] = ['pending', 'confirmed', 'underpaid', 'failed'];
const asStatus = (value: unknown): PaymentStatus | null => STATUSES.includes(value as PaymentStatus) ? value as PaymentStatus : null;
/** `{status, payment, subscription}` from /billing/payments; the payment is in the same shape as on GET /account. */
export function pickPaymentResult(value: unknown): PaymentResult | null {
  const d = record(value), p = record(d?.payment), s = record(d?.subscription);
  const status = asStatus(d?.status);
  if (!status) return null;
  const url = str(p?.explorerUrl, 300);
  return {
    status,
    payment: p ? { status: asStatus(p.status), txHash: str(p.txHash, 100), failureReason: str(p.failureReason, 300), periodEnd: str(p.periodEnd, 40),
      explorerUrl: url && /^https:\/\//.test(url) ? url : null } : null,
    subscription: s ? { plan: str(s.plan, 20), expiresAt: str(s.expiresAt, 40), active: s.active === true } : null,
  };
}
/** Only the error fields the pages show: the code, the retry hint, and the sending wallet for unlinked_wallet. */
export function pickError(value: unknown, status: number): Payload {
  const d = record(value);
  const code = typeof d?.error === 'string' && /^[a-z0-9_]{1,64}$/.test(d.error) ? d.error : status >= 500 ? 'backend_unavailable' : 'invalid_response';
  const out: Payload = { error: code };
  if (d?.retry === true) out.retry = true;
  if (isAddress(d?.from)) out.from = d.from;
  return out;
}

// Polling. Transient answers keep the checkout waiting; only a definite answer ends it.
export type PollOutcome =
  | { kind: 'confirmed'; expiresAt: string | null }
  | { kind: 'waiting'; code: string }
  | { kind: 'final'; code: string; from?: string };
const KEEP_WAITING = new Set(['tx_not_found', 'providers_unavailable', 'backend_unavailable', 'rate_limit']);
// Why a payment failed, as a checkout message code. Reasons without a message of their own read as payment_failed.
const FAILURES: Record<string, string> = { reverted: 'tx_failed', receipt_missing: 'receipt_missing', wrong_token: 'wrong_token', wrong_recipient: 'wrong_recipient', ambiguous: 'ambiguous_payment' };
export function paymentOutcome(status: number, data: unknown): PollOutcome {
  if (status >= 200 && status < 300) {
    const result = pickPaymentResult(data);
    if (!result || result.status === 'pending') return { kind: 'waiting', code: 'pending' };
    if (result.status === 'confirmed') {
      // Credited earlier (a pasted old hash), and the access it bought has since ended.
      if (result.subscription && !result.subscription.active) return { kind: 'final', code: 'already_credited_expired' };
      return { kind: 'confirmed', expiresAt: result.subscription?.expiresAt ?? result.payment?.periodEnd ?? null };
    }
    if (result.status === 'underpaid') return { kind: 'final', code: 'underpaid' };
    const reason = result.payment?.failureReason;
    return { kind: 'final', code: reason && Object.hasOwn(FAILURES, reason) ? FAILURES[reason] : 'payment_failed' };
  }
  const error = pickError(data, status), code = error.error as string;
  if (status >= 500 || KEEP_WAITING.has(code)) return { kind: 'waiting', code };
  return { kind: 'final', code, ...(typeof error.from === 'string' ? { from: error.from } : {}) };
}
export type PollResult = Exclude<PollOutcome, { kind: 'waiting' }> | { kind: 'timeout'; code: string } | { kind: 'cancelled' };
type PollOptions = {
  request: () => Promise<{ status: number; data: unknown }>; intervalMs: number; timeoutMs: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>; cancelled?: () => boolean; onWaiting?: (code: string) => void;
};
/** Asks at once, then every intervalMs until a definite answer or timeoutMs has passed since the first ask. */
export async function pollUntilSettled({ request, intervalMs, timeoutMs, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), cancelled = () => false, onWaiting }: PollOptions): Promise<PollResult> {
  const deadline = now() + timeoutMs;
  let last = 'pending';
  for (;;) {
    if (cancelled()) return { kind: 'cancelled' };
    let outcome: PollOutcome;
    try { const { status, data } = await request(); outcome = paymentOutcome(status, data); }
    catch { outcome = { kind: 'waiting', code: 'backend_unavailable' }; }
    if (cancelled()) return { kind: 'cancelled' };
    if (outcome.kind !== 'waiting') return outcome;
    last = outcome.code;
    onWaiting?.(last);
    if (now() + intervalMs > deadline) return { kind: 'timeout', code: last };
    await sleep(intervalMs);
  }
}

// Messages for every code the checkout can meet: backend errors, payment states, and wallet-side failures.
export type MessageContext = { supportEmail?: string | null; chainName?: string; from?: string };
// `calm`: the visitor stopped it themselves, so it is shown as a note rather than an error.
export type CheckoutMessage = { text: string; support: boolean; calm: boolean };
const RELOAD = 'Reload the page and try again.';
const SERVICE = 'The payment service is not responding right now. Please try again in a minute.';
function messages(c: MessageContext): Record<string, string> {
  const chain = c.chainName ?? 'BNB Smart Chain';
  const from = c.from ? ` (${shortAddress(c.from)})` : '';
  return {
    // Service and session
    forbidden: `This request was blocked because it did not come from this page. ${RELOAD}`,
    session_required: 'Your session has ended. Sign in again to continue.',
    site_key_required: 'Payments are not available right now. Please try again later.',
    accounts_disabled: 'Payments are not available right now. Please try again later.',
    backend_unavailable: SERVICE, internal_error: SERVICE, temporarily_unavailable: SERVICE,
    rate_limit: 'Too many attempts. Wait a minute and try again.',
    invalid_json: `The request could not be read. ${RELOAD}`, json_required: `The request could not be read. ${RELOAD}`,
    bad_request: `The request could not be read. ${RELOAD}`, invalid_request: `The request could not be read. ${RELOAD}`,
    payload_too_large: `The request was too large. ${RELOAD}`, method_not_allowed: `The request could not be read. ${RELOAD}`,
    payments_disabled: 'Payments are not open yet.',
    payments_not_open: 'Checkout is limited to admins while payments are in test mode.',
    invalid_plan: 'That plan isn’t available. Choose Monthly or Annual.',
    invalid_token: 'That token isn’t accepted here. Choose USDT or USDC.', unknown_token: 'That token isn’t accepted here. Choose USDT or USDC.',
    invalid_address: 'That wallet address isn’t valid. Connect the wallet again.',
    // Wallet linking
    invalid_signature: 'The signature didn’t match this wallet. Try linking it again.',
    challenge_expired: 'The link request expired. Try linking the wallet again.',
    challenge_used: 'That link request was already used. Try linking the wallet again.',
    wallet_linked_elsewhere: 'This wallet is linked to a different account. Use another wallet, or sign in with the account it belongs to.',
    // BSC payment
    invalid_tx_hash: 'That isn’t a transaction hash. It starts with 0x followed by 64 letters and numbers.',
    tx_not_found: `We couldn’t find this transaction on ${chain} yet. If it was sent from your linked wallet, it will be picked up automatically and we’ll email you when it’s confirmed.`,
    tx_failed: 'This transaction failed on-chain, so no tokens were sent. You can try again.',
    wrong_token: `This transaction didn’t send USDT or USDC on ${chain} to the payment address.`,
    wrong_recipient: 'This transaction didn’t send tokens to the payment address.',
    unlinked_wallet: `This payment came from a wallet${from} that isn’t linked to your account. Connect that wallet to link it (choose “Use another wallet” first if a different one is connected); we’ll then check this transaction again automatically.`,
    tx_already_used: 'This transaction has already been used for another account.',
    transfer_resolved: 'Support has already handled this transfer (credited or refunded), so it can’t be applied again.',
    ambiguous_payment: 'This transaction contains more than one payment, so it can’t be matched automatically.',
    providers_unavailable: `${chain} nodes aren’t answering right now. Your payment is safe; we’ll keep checking.`,
    underpaid: 'The amount received was less than the plan price, so Pro was not activated.',
    receipt_missing: 'This transaction dropped out of the chain before it was final. If it is included again, paste its hash below to check it again.',
    payment_failed: 'This payment failed and Pro was not activated.',
    already_credited_expired: 'This payment was already credited and that period has ended. Send a new payment to renew.',
    still_confirming: 'Still confirming — we’ll email you when it’s done.',
    intent_mismatch: `The payment details changed. ${RELOAD}`,
    invalid_response: SERVICE,
    // Wallet side
    user_rejected: 'You cancelled the request in your wallet. Nothing was sent.',
    request_pending: 'Your wallet already has a request waiting. Open the wallet to approve or reject it, then try again.',
    chain_not_added: `Your wallet couldn’t add ${chain}. Add it in the wallet, then try again.`,
    switch_failed: `Your wallet couldn’t switch to ${chain}. Switch networks in the wallet, then try again.`,
    wrong_chain: `Your wallet isn’t on ${chain}. Switch to ${chain} in the wallet, then try again. Nothing was sent.`,
    wc_chain_missing: `Enable ${chain} in your wallet, then connect again.`,
    no_accounts: 'The wallet didn’t share an account. Unlock it and try again.',
    account_changed: 'Your wallet switched accounts. Connect again to continue.',
    unsupported_method: 'This wallet can’t do that request. Try another wallet.',
    unauthorized: 'The wallet hasn’t authorised this site. Connect again.',
    disconnected: 'The wallet disconnected. Connect again.',
    request_expired: 'Your wallet didn’t answer in time. Check the wallet, then try again.',
    walletconnect_closed: 'The WalletConnect window was closed before a wallet connected. Choose a wallet to try again.',
    walletconnect_expired: 'The QR code expired before a wallet connected. Choose WalletConnect to get a new one.',
    walletconnect_failed: 'WalletConnect couldn’t start. Try again, or use a browser wallet.',
    invalid_tx_response: 'The wallet didn’t return a transaction hash. Check the wallet’s activity before trying again.',
    wallet_error: 'The wallet returned an error. Try again, or use another wallet.',
  };
}
const NEEDS_SUPPORT = new Set(['tx_not_found', 'unlinked_wallet', 'underpaid', 'wrong_token', 'wrong_recipient', 'ambiguous_payment', 'receipt_missing', 'tx_already_used', 'transfer_resolved', 'payment_failed']);
export function checkoutMessage(code: unknown, context: MessageContext = {}): CheckoutMessage {
  const key = typeof code === 'string' ? code : '';
  const all = messages(context);
  const text = Object.hasOwn(all, key) ? all[key] : /^[a-z0-9_]{1,64}$/.test(key) ? `Something went wrong (${key}). Please try again.` : 'Something went wrong. Please try again.';
  return { text, support: NEEDS_SUPPORT.has(key), calm: key === 'user_rejected' || key === 'walletconnect_closed' };
}

// What the page says while it waits. Over WalletConnect the request waits in the wallet app, so the text says to open it.
export type CheckoutStage = 'choose' | 'opening' | 'connecting' | 'switching' | 'linking' | 'preparing' | 'connected' | 'review' | 'sending' | 'confirming' | 'timeout' | 'done' | 'final';
export function stageStatus(stage: CheckoutStage, { walletConnect = false, chainName = 'BNB Smart Chain', waiting = null }: { walletConnect?: boolean; chainName?: string; waiting?: string | null } = {}): string {
  switch (stage) {
    case 'opening': return 'Opening WalletConnect…';
    case 'connecting': return 'Waiting for the wallet to connect…';
    case 'switching': return 'Checking the network in your wallet…';
    case 'linking': return `${walletConnect ? 'Open your wallet app to approve the signature' : 'Sign the message in your wallet to link it'}. Signing is free and sends nothing.`;
    case 'preparing': return 'Preparing your payment…';
    case 'sending': return walletConnect ? 'Open your wallet app to approve the transfer…' : 'Confirm the transfer in your wallet…';
    case 'confirming': return waiting === 'tx_not_found' ? `Waiting for the transaction to appear on ${chainName}…` : `Waiting for ${chainName} to finalise your payment. This usually takes under a minute.`;
    default: return '';
  }
}
