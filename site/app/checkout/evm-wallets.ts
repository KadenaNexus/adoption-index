// Wallets for the BNB Smart Chain checkout: EIP-6963 discovery (window.ethereum as the fallback), WalletConnect with
// its QR modal, and the request sequence the checkout runs. Only functions touch `window`, so tests can drive
// everything here with fake EIP-1193 providers.
import {
  chainIdHex, classifyWalletError, encodeTransfer, isAddress, isTxHash, sameChain, utf8ToHex, walletConnectAddress, walletConnectFailure, walletConnectInit,
  type AddChainParams, type WalletConnectSettings,
} from '../../lib/wallet.ts';

export type Eip1193Provider = { request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> };
export type InjectedWallet = { id: string; name: string; icon: string | null; provider: Eip1193Provider };

/** A checkout failure with a code the page maps to a message. */
export class CheckoutError extends Error {
  code: string;
  extra: Record<string, unknown>;
  constructor(code: string, extra: Record<string, unknown> = {}) { super(code); this.name = 'CheckoutError'; this.code = code; this.extra = extra; }
}
export const errorCodeOf = (error: unknown): string => error instanceof CheckoutError ? error.code : classifyWalletError(error);

/**
 * Numbers the checkout's wallet connections, so an answer that arrives after the visitor moved to another connection
 * is ignored. The provider object can't tell them apart: WalletConnect returns the same one on every connect.
 */
export function connectionCounter() {
  let current = 0;
  return { start: () => ++current, end: () => { current++; }, current: () => current };
}

/** One wallet request; wallet errors become CheckoutErrors with the EIP-1193 classification as the code. */
export async function walletRequest<T = unknown>(provider: Eip1193Provider, method: string, params?: unknown[]): Promise<T> {
  try { return await provider.request(params === undefined ? { method } : { method, params }) as T; }
  catch (error) { throw new CheckoutError(classifyWalletError(error)); }
}

// EIP-6963 icons must be data: URIs; anything else is dropped so a wallet can't make the page load a remote image.
const safeIcon = (icon: unknown) => typeof icon === 'string' && /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/.test(icon) && icon.length < 200_000 ? icon : null;
// Wallets that announce an EVM provider but can't use BNB Smart Chain: offering one would only fail at the network
// switch, so they are left out. Phantom lists BNB Smart Chain as unsupported (help.phantom.com, supported networks).
const NO_BSC_RDNS = new Set(['app.phantom']);
const withoutBsc = (info: Record<string, unknown>, provider: object) =>
  (typeof info.rdns === 'string' && NO_BSC_RDNS.has(info.rdns)) || (provider as Record<string, unknown>).isPhantom === true;
function fallbackName(p: Record<string, unknown>): string {
  if (p.isTrust || p.isTrustWallet) return 'Trust Wallet';
  if (p.isBinance || p.isBinanceChain) return 'Binance Wallet';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}
/**
 * Lists injected wallets as they announce themselves, leaving out the ones that can't use BNB Smart Chain. If none
 * answers within `fallbackMs`, window.ethereum (if any) is offered as one "browser wallet". Returns a cleanup function.
 */
export function discoverWallets(onChange: (wallets: InjectedWallet[]) => void, fallbackMs = 500): () => void {
  if (typeof window === 'undefined') return () => {};
  const found = new Map<string, InjectedWallet>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent).detail as { info?: Record<string, unknown>; provider?: Eip1193Provider } | undefined;
    const info = detail?.info, provider = detail?.provider;
    if (!info || !provider || typeof provider.request !== 'function' || withoutBsc(info, provider)) return;
    const id = typeof info.uuid === 'string' ? info.uuid : typeof info.rdns === 'string' ? info.rdns : '';
    const name = typeof info.name === 'string' ? info.name.slice(0, 40) : '';
    if (!id || !name || [...found.values()].some(w => w.provider === provider)) return;
    found.set(id, { id, name, icon: safeIcon(info.icon), provider });
    onChange([...found.values()]);
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const timer = window.setTimeout(() => {
    const injected = (window as unknown as { ethereum?: Eip1193Provider & Record<string, unknown> }).ethereum;
    if (!found.size && injected && typeof injected.request === 'function' && !withoutBsc({}, injected)) onChange([{ id: 'injected', name: fallbackName(injected), icon: null, provider: injected }]);
  }, fallbackMs);
  return () => { window.removeEventListener('eip6963:announceProvider', announce); window.clearTimeout(timer); };
}

export async function connectInjected(provider: Eip1193Provider): Promise<string> {
  const accounts = await walletRequest<unknown>(provider, 'eth_requestAccounts');
  const address = Array.isArray(accounts) ? accounts.find(isAddress) : undefined;
  if (!address) throw new CheckoutError('no_accounts');
  return address;
}

type Listener = () => void;
/** The parts of WalletConnect's EthereumProvider the checkout uses; `modal` is its AppKit QR modal. */
export type WalletConnectProvider = Eip1193Provider & {
  session?: unknown; modal?: { close(): Promise<void>; ready?(): Promise<void>; subscribeState?(listener: (state: { open: boolean }) => void): () => void };
  signer?: { client?: { core?: { relayer?: { on(event: 'relayer_error', listener: Listener): unknown; off(event: 'relayer_error', listener: Listener): unknown } } } };
  enable(): Promise<unknown>; disconnect(): Promise<void>;
  on(event: 'disconnect', listener: Listener): unknown; removeListener(event: 'disconnect', listener: Listener): unknown;
};
let walletConnectModule: Promise<typeof import('@walletconnect/ethereum-provider')> | null = null;
/** Downloads the WalletConnect bundle without starting it, so the first click doesn't wait for it. */
export function preloadWalletConnect() {
  walletConnectModule ??= import('@walletconnect/ethereum-provider').catch(error => { walletConnectModule = null; throw error; });
  return walletConnectModule;
}
let walletConnect: Promise<WalletConnectProvider> | null = null;
// One provider per page (WalletConnect's core is a singleton). A failed start is forgotten, so the next click retries.
function walletConnectProvider(settings: WalletConnectSettings): Promise<WalletConnectProvider> {
  walletConnect ??= preloadWalletConnect().then(async ({ EthereumProvider }) => {
    const provider = await EthereumProvider.init(walletConnectInit(settings, window.location.origin)) as unknown as WalletConnectProvider;
    // AppKit finishes setting up after init; the provider reads any modal state change during that as a closed modal.
    await Promise.race([provider.modal?.ready?.().catch(() => {}), new Promise(resolve => window.setTimeout(resolve, 3000))]);
    return provider;
  }).catch(error => { walletConnect = null; throw error; });
  return walletConnect;
}
/** Starts `start()` unless `signal` has already aborted, and rejects as a closed WalletConnect window once it aborts. */
function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
  if (signal?.aborted) return Promise.reject(new CheckoutError('walletconnect_closed'));
  const promise = start();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { onAbort?.(); reject(new CheckoutError('walletconnect_closed')); };
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    signal.addEventListener('abort', abort, { once: true });
  });
}
// AppKit shows its modal only after fetching its wallet list, and a close() sent before that does nothing. So an
// attempt that ends early also closes the modal when it does appear, until the next attempt starts or 30 s pass.
let stopClosingLate: (() => void) | null = null;
function closeModal(provider: WalletConnectProvider) {
  const modal = provider.modal;
  modal?.close().catch(() => {});
  stopClosingLate?.();
  if (!modal?.subscribeState) return;
  const stop = () => { unsubscribe(); clearTimeout(timer); if (stopClosingLate === stop) stopClosingLate = null; };
  const timer = setTimeout(stop, 30000);
  const unsubscribe = modal.subscribeState(state => { if (state.open) { stop(); modal.close().catch(() => {}); } });
  stopClosingLate = stop;
}
/**
 * enable(): the restored session at once, or the QR modal until a wallet approves. The relay refuses an unknown project
 * id by closing its socket with code 3000, which the core reports as `relayer_error`; that ends the wait at once
 * instead of after about a minute of retries.
 */
async function openSession(provider: WalletConnectProvider, signal: AbortSignal | undefined): Promise<unknown> {
  stopClosingLate?.();
  const relayer = provider.signer?.client?.core?.relayer;
  let refused: Listener = () => {};
  const refusal = new Promise<never>((_, reject) => { refused = () => { closeModal(provider); reject(new CheckoutError('walletconnect_failed')); }; });
  relayer?.on('relayer_error', refused);
  try { return await untilAborted(() => Promise.race([provider.enable(), refusal]), signal, () => closeModal(provider)); }
  finally { relayer?.off('relayer_error', refused); }
}
type WalletConnectRun = { load?: (settings: WalletConnectSettings) => Promise<WalletConnectProvider>; fresh?: boolean; signal?: AbortSignal; onReady?: () => void };
/**
 * Opens the WalletConnect QR modal, or reuses the session restored from an earlier visit unless `fresh` asks for a new
 * pairing. The approved session must hold a BSC account; a wallet that left BSC out gets disconnected with a clear
 * message. Aborting `signal` closes the modal and stops waiting, even if the modal never appeared.
 */
export async function connectWalletConnect(settings: WalletConnectSettings, { load = walletConnectProvider, fresh = false, signal, onReady }: WalletConnectRun = {}): Promise<{ provider: WalletConnectProvider; address: string }> {
  let provider: WalletConnectProvider;
  try { provider = await untilAborted(() => load(settings), signal); } catch (error) { throw error instanceof CheckoutError ? error : new CheckoutError('walletconnect_failed'); }
  if (fresh && provider.session) {
    await provider.disconnect().catch(() => {});
    if (provider.session) throw new CheckoutError('walletconnect_failed');
  }
  // Cancelled while the old session was ending: no new pairing.
  if (signal?.aborted) throw new CheckoutError('walletconnect_closed');
  onReady?.();
  let accounts: unknown;
  try { accounts = await openSession(provider, signal); } catch (error) { throw error instanceof CheckoutError ? error : new CheckoutError(walletConnectFailure(error)); }
  const address = walletConnectAddress(provider.session, settings.chainId, accounts);
  if (!address) {
    await provider.disconnect().catch(() => {});
    throw new CheckoutError('wc_chain_missing');
  }
  return { provider, address };
}

// Codes that say more than "the switch failed" and keep their own message.
const PASS_THROUGH = new Set(['user_rejected', 'request_pending', 'disconnected', 'unauthorized']);
/** Switch to the payment chain, adding it first when the wallet doesn't know it (4902, or MetaMask Mobile's -32603). */
export async function ensureChain(provider: Eip1193Provider, chainId: number, addChainParams: AddChainParams): Promise<void> {
  if (sameChain(await walletRequest(provider, 'eth_chainId'), chainId)) return;
  const target = [{ chainId: chainIdHex(chainId) }];
  try { await walletRequest(provider, 'wallet_switchEthereumChain', target); }
  catch (error) {
    const code = errorCodeOf(error);
    if (code !== 'chain_not_added') throw new CheckoutError(PASS_THROUGH.has(code) ? code : 'switch_failed');
    try { await walletRequest(provider, 'wallet_addEthereumChain', [addChainParams]); }
    catch (addError) { const c = errorCodeOf(addError); throw new CheckoutError(PASS_THROUGH.has(c) ? c : 'chain_not_added'); }
    // Some wallets switch as part of adding; switching again is harmless and covers the ones that don't.
    if (!sameChain(await walletRequest(provider, 'eth_chainId'), chainId)) {
      try { await walletRequest(provider, 'wallet_switchEthereumChain', target); }
      catch (switchError) { const c = errorCodeOf(switchError); throw new CheckoutError(PASS_THROUGH.has(c) ? c : 'switch_failed'); }
    }
  }
  if (!sameChain(await walletRequest(provider, 'eth_chainId'), chainId)) throw new CheckoutError('wrong_chain');
}

type Post = (url: string, body: unknown) => Promise<{ status: number; data: unknown }>;
/**
 * Links the wallet with a free EIP-191 signature: challenge → personal_sign → link. The message names the account's
 * email, so the signer can see which account the wallet joins.
 */
export async function linkWallet(provider: Eip1193Provider, address: string, post: Post): Promise<void> {
  const challenge = await post('/api/wallets/challenge', { address });
  const data = challenge.data as { nonce?: unknown; message?: unknown; error?: unknown } | null;
  if (challenge.status !== 200 || typeof data?.nonce !== 'string' || typeof data?.message !== 'string') throw new CheckoutError(typeof data?.error === 'string' ? data.error : 'backend_unavailable');
  const signature = await walletRequest<unknown>(provider, 'personal_sign', [utf8ToHex(data.message), address]);
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new CheckoutError('invalid_signature');
  const link = await post('/api/wallets/link', { nonce: data.nonce, signature });
  const linked = link.data as { error?: unknown } | null;
  if (link.status < 200 || link.status >= 300) throw new CheckoutError(typeof linked?.error === 'string' ? linked.error : 'backend_unavailable');
}

export type Transfer = { from: string; chainId: number; tokenAddress: string; payTo: string; amount: string };
/**
 * Sends the token transfer. The chain is read again right before sending, because the user can switch networks in
 * the wallet at any time; the chainId is also in the params, so MetaMask itself refuses a mismatch.
 */
export async function sendTransfer(provider: Eip1193Provider, { from, chainId, tokenAddress, payTo, amount }: Transfer): Promise<string> {
  if (!sameChain(await walletRequest(provider, 'eth_chainId'), chainId)) throw new CheckoutError('wrong_chain');
  const accounts = await walletRequest<unknown>(provider, 'eth_accounts');
  if (!Array.isArray(accounts) || !accounts.some(a => typeof a === 'string' && a.toLowerCase() === from.toLowerCase())) throw new CheckoutError('account_changed');
  const hash = await walletRequest<unknown>(provider, 'eth_sendTransaction', [{ from, to: tokenAddress, data: encodeTransfer(payTo, amount), value: '0x0', chainId: chainIdHex(chainId) }]);
  if (!isTxHash(hash)) throw new CheckoutError('invalid_tx_response');
  return hash.toLowerCase();
}
