'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Check, Copy, ExternalLink } from 'lucide-react';
import {
  checkoutMessage, explorerTxUrl, formatExpiry, noWalletMessage, normalizeTxHash, pickError, pickIntent, pollUntilSettled, shortAddress, stageStatus, unsupportedWalletsMessage,
  type CheckoutPlan, type CheckoutStage, type EvmConfig, type Intent, type MessageContext, type PollResult,
} from '../../lib/wallet';
import {
  CheckoutError, connectInjected, connectionCounter, connectWalletConnect, discoverWallets, ensureChain, errorCodeOf, linkWallet, preloadWalletConnect, sendTransfer,
  type Eip1193Provider, type InjectedWallet, type WalletConnectProvider,
} from './evm-wallets';

type CheckoutFlowProps = {
  plan: CheckoutPlan; evm: EvmConfig; walletConnectProjectId: string | null; linkedWallets: string[]; supportEmail: string | null; signInHref: string;
};
type Reply = { status: number; data: unknown };
type Problem = { code: string } & MessageContext;
type PaymentCheck = { txHash: string; intentId?: string | number };

// The browser talks only to the site's own routes; they add the session and forward to the backend.
async function post(url: string, body: unknown): Promise<Reply> {
  try {
    // AbortSignal.timeout is missing on older Safari (iOS 15); there the site's own 25 s route timeouts still apply.
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30000) : undefined;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', signal });
    let data: unknown = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data };
  } catch {
    return { status: 503, data: { error: 'backend_unavailable' } };
  }
}
const replyCode = ({ status, data }: Reply) => pickError(data, status).error as string;

/** Keeps async work from updating a checkout that has been closed. */
function useAlive() {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

function Message({ problem, supportEmail, signInHref }: { problem: Problem; supportEmail: string | null; signInHref: string }) {
  const { text, support, calm } = checkoutMessage(problem.code, problem);
  return <p className={calm ? 'pay-message' : 'pay-message pay-error'} role={calm ? 'status' : 'alert'}>
    {text}
    {support && supportEmail && <> Questions? Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</>}
    {problem.code === 'session_required' && <> <Link className="text-link" href={signInHref}>Sign in again</Link></>}
  </p>;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  return <button type="button" className="pay-copy" onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`}>
    {copied ? <Check size={14} aria-hidden="true"/> : <Copy size={14} aria-hidden="true"/>}<span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
  </button>;
}

function Steps({ steps, current }: { steps: string[]; current: number }) {
  return <ol className="pay-steps">
    {steps.map((label, i) => {
      const state = i < current ? 'done' : i === current ? 'current' : 'todo';
      return <li key={label} className={`pay-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
        <span className="pay-step-mark" aria-hidden="true">{state === 'done' ? <Check size={12}/> : i + 1}</span>
        <span>{label}<span className="sr-only">{state === 'done' ? ' (done)' : ''}</span></span>
      </li>;
    })}
  </ol>;
}

type Confirmed = { expiresAt: string | null; receipt: boolean };
// `receipt` only for a transfer this page sent: a pasted hash may have been credited, and its receipt sent, long ago.
function Success({ expiresAt, receipt }: Confirmed) {
  const until = formatExpiry(expiresAt);
  const heading = useRef<HTMLHeadingElement>(null);
  // This replaces the whole checkout, so focus moves here and screen readers announce the result.
  useEffect(() => { heading.current?.focus(); }, []);
  return <div className="pay-success" role="status">
    <h3 ref={heading} tabIndex={-1}>{until ? `Pro is active until ${until}.` : 'Pro is active.'}</h3>
    {receipt && <p>A receipt is on its way to your email.</p>}
    <div className="pay-actions"><Link className="button" href="/">Open the index</Link><Link className="text-link" href="/account">Your account</Link></div>
  </div>;
}

// ── WalletConnect or a browser wallet, paying USDT or USDC on BNB Smart Chain ─────────────────────────────────────
const STEP: Record<CheckoutStage, number> = { choose: 1, opening: 1, connecting: 1, switching: 2, linking: 3, preparing: 4, connected: 2, review: 4, sending: 4, confirming: 5, timeout: 5, done: 6, final: 5 };
const BUSY = new Set<CheckoutStage>(['opening', 'connecting', 'switching', 'linking', 'preparing', 'sending', 'confirming']);
// From here on the payment is followed by its transaction hash, whatever happens to the wallet.
const SENT = new Set<CheckoutStage>(['confirming', 'timeout', 'done', 'final']);
// Final answers after which a new payment is the way on; each gets a fresh intent.
const PAY_AGAIN: Record<string, string> = { tx_failed: 'Try the payment again', already_credited_expired: 'Send a new payment' };
type Wallet = { name: string; address: string; walletConnect: boolean };

export default function CheckoutFlow({ plan, evm, walletConnectProjectId, linkedWallets, supportEmail, signInHref }: CheckoutFlowProps) {
  const alive = useAlive();
  const [connection] = useState(connectionCounter);
  const provider = useRef<Eip1193Provider | null>(null);
  const stageNow = useRef<CheckoutStage>('choose');
  const cancelConnect = useRef<AbortController | null>(null);
  const stopWatching = useRef<(() => void) | null>(null);
  // Once a WalletConnect session is left behind (or a connect fails), the next connect pairs afresh instead of reusing it.
  const freshWalletConnect = useRef(false);
  const [token, setToken] = useState(evm.tokens[0].symbol);
  const [wallets, setWallets] = useState<InjectedWallet[]>([]);
  const [unsupportedWallets, setUnsupportedWallets] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [stage, setStageState] = useState<CheckoutStage>('choose');
  const [viaWalletConnect, setViaWalletConnect] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [linked, setLinked] = useState(() => linkedWallets.map(a => a.toLowerCase()));
  const [intent, setIntent] = useState<Intent | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const sentHash = useRef<string | null>(null);
  // A pasted hash that came from an unlinked wallet: once that wallet is linked, it is checked again instead of paid again.
  const recheck = useRef<string | null>(null);
  const [lastBody, setLastBody] = useState<PaymentCheck | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmed>({ expiresAt: null, receipt: false });
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const context: MessageContext = { chainName: evm.chainName, supportEmail };

  useEffect(() => {
    const stop = discoverWallets(setWallets, undefined, setUnsupportedWallets);
    const timer = window.setTimeout(() => setSearched(true), 600);
    return () => { stop(); window.clearTimeout(timer); };
  }, []);
  // The WalletConnect bundle is large, so it downloads while the page is read; nothing connects until it is chosen.
  useEffect(() => { if (walletConnectProjectId) preloadWalletConnect().catch(() => {}); }, [walletConnectProjectId]);
  useEffect(() => () => { cancelConnect.current?.abort(); stopWatching.current?.(); }, []);

  function setStage(next: CheckoutStage) { stageNow.current = next; setStageState(next); }
  // Async steps check this before touching the page: the visitor may have closed it or moved to another connection.
  const stillCurrent = (id: number) => alive.current && connection.current() === id;
  function fail(error: unknown) {
    if (!alive.current) return;
    const code = errorCodeOf(error), from = error instanceof CheckoutError && typeof error.extra.from === 'string' ? error.extra.from : undefined;
    setProblem({ code, ...context, ...(from ? { from } : {}) });
  }
  function forgetWallet() {
    stopWatching.current?.(); stopWatching.current = null;
    connection.end(); freshWalletConnect.current = true; provider.current = null; setWallet(null);
  }
  function backToWalletChoice(next: Problem | null) { forgetWallet(); setIntent(null); setProblem(next); setStage('choose'); }
  /**
   * A wallet step failed: a wallet that has gone means choosing one again; anything else stays on `stay` with its
   * message. Once a payment is sent, a late wallet error changes nothing: the payment is followed by its hash.
   */
  function stepFailed(id: number, error: unknown, stay: CheckoutStage) {
    if (!stillCurrent(id) || SENT.has(stageNow.current)) return;
    if (errorCodeOf(error) === 'disconnected') { backToWalletChoice({ ...context, code: 'disconnected' }); return; }
    fail(error);
    setStage(stay);
  }
  // The wallet can end a WalletConnect session at any time. Before the transfer is sent that means choosing a wallet again.
  function watchWalletConnect(id: number, p: WalletConnectProvider) {
    stopWatching.current?.();
    const ended = () => {
      if (!stillCurrent(id)) return;
      if (SENT.has(stageNow.current)) forgetWallet(); else backToWalletChoice({ ...context, code: 'disconnected' });
    };
    p.on('disconnect', ended);
    stopWatching.current = () => { p.removeListener('disconnect', ended); };
  }

  async function createIntent(symbol: string): Promise<Intent> {
    const reply = await post('/api/billing/intents', { plan: plan.id, token: symbol });
    if (reply.status < 200 || reply.status >= 300) throw new CheckoutError(replyCode(reply));
    const created = pickIntent(reply.data), chosen = evm.tokens.find(t => t.symbol === symbol);
    if (!created) throw new CheckoutError('invalid_response');
    // The transfer is built from the intent, so it must match the configuration this page showed.
    if (!chosen || created.chainId !== evm.chainId || created.payTo.toLowerCase() !== evm.payTo.toLowerCase() || created.tokenAddress.toLowerCase() !== chosen.address.toLowerCase()) throw new CheckoutError('intent_mismatch');
    return created;
  }
  async function prepare(id: number, p: Eip1193Provider, address: string, symbol: string) {
    setStage('switching');
    await ensureChain(p, evm.chainId, evm.addChainParams);
    if (!stillCurrent(id)) return;
    if (!linked.includes(address.toLowerCase())) {
      setStage('linking');
      await linkWallet(p, address, post);
      if (!alive.current) return;
      setLinked(list => [...list, address.toLowerCase()]);
      if (!stillCurrent(id)) return;
    }
    const pending = recheck.current;
    if (pending) { setTxHash(pending); await confirm({ txHash: pending }); return; }
    setStage('preparing');
    const created = await createIntent(symbol);
    if (!stillCurrent(id)) return;
    setIntent(created);
    setStage('review');
  }
  async function connect(choice: InjectedWallet | 'walletconnect') {
    const id = connection.start(), viaWc = choice === 'walletconnect', cancel = new AbortController();
    cancelConnect.current = cancel;
    setProblem(null); setIntent(null); setViaWalletConnect(viaWc); setStage(viaWc ? 'opening' : 'connecting');
    let connected: { provider: Eip1193Provider; address: string };
    try {
      connected = viaWc
        ? await connectWalletConnect({ projectId: walletConnectProjectId ?? '', chainId: evm.chainId, rpcUrl: evm.addChainParams.rpcUrls[0], description: `Index Pro payment on ${evm.chainName}` },
          { fresh: freshWalletConnect.current, signal: cancel.signal, onReady: () => { if (alive.current && !cancel.signal.aborted) setStage('connecting'); } })
        : { provider: choice.provider, address: await connectInjected(choice.provider) };
    } catch (error) {
      if (viaWc) freshWalletConnect.current = true;
      if (alive.current && !cancel.signal.aborted) { fail(error); setStage('choose'); }
      return;
    }
    if (!alive.current || cancel.signal.aborted) return;
    const p = connected.provider;
    provider.current = p;
    setWallet({ name: viaWc ? 'WalletConnect' : choice.name, address: connected.address, walletConnect: viaWc });
    if (viaWc) { freshWalletConnect.current = false; watchWalletConnect(id, p as WalletConnectProvider); }
    try { await prepare(id, p, connected.address, token); } catch (error) { stepFailed(id, error, 'connected'); }
  }
  function cancelConnecting() {
    cancelConnect.current?.abort();
    setStage('choose');
  }
  async function retry() {
    const p = provider.current, id = connection.current();
    if (!p || !wallet) return;
    setProblem(null);
    try { await prepare(id, p, wallet.address, token); } catch (error) { stepFailed(id, error, 'connected'); }
  }
  function disconnect() {
    // Ending the WalletConnect session makes the next connect show a new QR code instead of reusing this wallet.
    if (wallet?.walletConnect && provider.current) (provider.current as WalletConnectProvider).disconnect().catch(() => {});
    backToWalletChoice(null);
  }
  async function newIntent(id: number, symbol: string) {
    setProblem(null); setIntent(null); setStage('preparing');
    try { const created = await createIntent(symbol); if (stillCurrent(id)) { setIntent(created); setStage('review'); } }
    catch (error) { stepFailed(id, error, 'connected'); }
  }
  function changeToken(symbol: string) {
    setToken(symbol);
    if (stage === 'review' && provider.current) newIntent(connection.current(), symbol);
  }

  async function confirm(body: PaymentCheck) {
    const own = body.txHash === sentHash.current;
    recheck.current = null;
    setProblem(null); setWaiting(null); setLastBody(body); setStage('confirming');
    const result: PollResult = await pollUntilSettled({
      request: () => post('/api/billing/payments', body), intervalMs: 3000, timeoutMs: 180000,
      cancelled: () => !alive.current, onWaiting: code => { if (alive.current) setWaiting(code); },
    });
    if (result.kind === 'cancelled' || !alive.current) return;
    if (result.kind === 'confirmed') { setConfirmed({ expiresAt: result.expiresAt, receipt: own }); setStage('done'); }
    else if (result.kind === 'timeout') { setWaiting(result.code); setStage('timeout'); }
    else if (result.kind === 'final') {
      if (result.code === 'unlinked_wallet') recheck.current = body.txHash;
      setProblem({ ...context, code: result.code, from: result.from }); setStage('final');
    }
  }
  async function send() {
    const p = provider.current, id = connection.current();
    if (!p || !intent || !wallet || stage !== 'review') return;
    setProblem(null); setStage('sending');
    let hash: string;
    try { hash = await sendTransfer(p, { from: wallet.address, chainId: evm.chainId, tokenAddress: intent.tokenAddress, payTo: intent.payTo, amount: intent.amount }); }
    catch (error) { stepFailed(id, error, 'review'); return; }
    if (!alive.current) return;
    // A hash means the transfer may be on its way, so it is followed even if the wallet has disconnected since.
    setTxHash(hash); sentHash.current = hash;
    await confirm({ txHash: hash, intentId: intent.intentId });
  }
  // Paying again gets a fresh intent: after a reverted transfer (no tokens moved), or when a pasted hash's period is over.
  function payAgain() {
    if (!provider.current) return;
    setTxHash(null);
    newIntent(connection.current(), token);
  }
  async function submitPasted(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const hash = normalizeTxHash(pasted);
    // Shown under the field: the shared message can be far above it on a phone.
    if (!hash) { setPasteError(checkoutMessage('invalid_tx_hash').text); return; }
    setPasteError(null); setTxHash(hash);
    // Only the transaction this page just sent belongs to its intent. Any other hash is matched by the backend from the
    // amount paid (and the account's open intents), never from the plan this page happens to show.
    await confirm({ txHash: hash, ...(intent && sentHash.current === hash ? { intentId: intent.intentId } : {}) });
  }

  const busy = BUSY.has(stage);
  const locked = busy || stage === 'done' || stage === 'timeout';
  const chosen = evm.tokens.find(t => t.symbol === token) ?? evm.tokens[0];
  const txUrl = txHash ? explorerTxUrl(evm.explorerUrl, txHash) : null;
  const steps = ['Choose token', 'Connect wallet', `Switch to ${evm.chainName}`, 'Link wallet (free signature)', 'Send payment', 'Confirmation'];
  const status = stageStatus(stage, { walletConnect: viaWalletConnect, chainName: evm.chainName, waiting });
  const payAgainLabel = stage === 'final' && problem && Object.hasOwn(PAY_AGAIN, problem.code) ? PAY_AGAIN[problem.code] : null;
  const txLink = txHash && <p className="pay-tx">Transaction <code>{shortAddress(txHash, 10, 8)}</code>{txUrl && <> · <a className="text-link" href={txUrl} target="_blank" rel="noopener noreferrer">View on explorer <ExternalLink size={13} aria-hidden="true"/></a></>}</p>;

  if (stage === 'done') return <Success {...confirmed}/>;
  return <div className="pay">
    {evm.testnet && <p className="pay-testnet" role="note"><b>TESTNET</b> — test tokens only</p>}
    <Steps steps={steps} current={STEP[stage]}/>

    <fieldset className="pay-tokens" disabled={locked}>
      <legend>1. Choose the token</legend>
      {evm.tokens.map(t => <label key={t.symbol} className="pay-token">
        <input type="radio" name="pay-token" value={t.symbol} checked={token === t.symbol} onChange={() => changeToken(t.symbol)}/>
        <span><b>{t.symbol}</b><small>BEP-20 on {evm.chainName}</small></span>
      </label>)}
    </fieldset>

    <ul className="pay-warnings" aria-label="Before you pay">
      <li>Send only on <b>{evm.chainName}</b>. A payment on any other network can’t be matched.</li>
      <li>You need a little BNB for the network fee.</li>
      <li>Send from a wallet you control. Exchange withdrawals can’t be matched automatically.</li>
      <li className="pay-address-row"><span>Payment address</span><code className="pay-address">{evm.payTo}</code><CopyButton value={evm.payTo} label="payment address"/></li>
    </ul>

    {!wallet && <section className="pay-connect" aria-labelledby="pay-connect-title">
      <h3 id="pay-connect-title">2. Connect a wallet</h3>
      <div className="pay-wallets">
        {walletConnectProjectId && <button type="button" className="pay-wallet primary" onClick={() => connect('walletconnect')} disabled={busy}>
          <span className="pay-wallet-icon wc" aria-hidden="true">WC</span>
          <span><b>WalletConnect</b><small>Scan the QR code or open your wallet app</small></span>
        </button>}
        {wallets.map(w => <button type="button" key={w.id} className="pay-wallet" onClick={() => connect(w)} disabled={busy}>
          {/* eslint-disable-next-line @next/next/no-img-element -- EIP-6963 icons are data: URIs from the wallet itself */}
          {w.icon ? <img className="pay-wallet-icon" src={w.icon} alt="" width={28} height={28}/> : <span className="pay-wallet-icon" aria-hidden="true">{w.name.slice(0, 1)}</span>}
          <span><b>{w.name}</b><small>Browser wallet</small></span>
        </button>)}
      </div>
      {/* For a wallet that never answers, and over WalletConnect also when its QR modal (which has its own close) never appears. */}
      {(stage === 'opening' || stage === 'connecting') && <button type="button" className="pay-link-button pay-cancel" onClick={cancelConnecting}>Cancel</button>}
      {unsupportedWallets.length > 0 && <p className="pay-hint">{unsupportedWalletsMessage(unsupportedWallets, evm.chainName)}</p>}
      {searched && !wallets.length && <p className="pay-hint">{noWalletMessage(!!walletConnectProjectId)}</p>}
    </section>}

    {wallet && <div className="pay-connected">
      <p>Connected: <b>{wallet.name}</b> <code>{shortAddress(wallet.address)}</code>{linked.includes(wallet.address.toLowerCase()) && <span className="pay-badge">Linked</span>}</p>
      {/* Switching networks and linking only wait on the wallet, so the visitor may switch wallets meanwhile. */}
      {(!locked || stage === 'switching' || stage === 'linking') && <button type="button" className="pay-link-button" onClick={disconnect}>Use another wallet</button>}
    </div>}

    <div className="pay-status" role="status" aria-live="polite">{status}</div>
    {problem && <Message problem={problem} supportEmail={supportEmail} signInHref={signInHref}/>}
    {stage === 'connected' && wallet && <div className="pay-actions"><button type="button" className="button" onClick={retry}>Try again</button></div>}

    {intent && (stage === 'review' || stage === 'sending') && <section className="pay-review" aria-labelledby="pay-review-title">
      <h3 id="pay-review-title">Send the payment</h3>
      <dl className="pay-facts">
        <div><dt>Amount</dt><dd><b>{intent.amountDisplay} {intent.token}</b></dd></div>
        <div><dt>Network</dt><dd>{evm.chainName}</dd></div>
        <div><dt>To</dt><dd><code className="pay-address">{intent.payTo}</code></dd></div>
        <div><dt>Plan</dt><dd>Index Pro · {plan.name} · {plan.days} {plan.days === 1 ? 'day' : 'days'}</dd></div>
      </dl>
      <button type="button" className="button pay-send" onClick={send} disabled={stage === 'sending'}>Send {intent.amountDisplay} {chosen.symbol}</button>
    </section>}

    {(stage === 'confirming' || stage === 'timeout' || stage === 'final') && txLink}
    {payAgainLabel && wallet && <div className="pay-actions"><button type="button" className="button" onClick={payAgain}>{payAgainLabel}</button></div>}
    {stage === 'timeout' && <div className="pay-message" role="status">
      <p>{checkoutMessage(waiting === 'tx_not_found' ? 'tx_not_found' : 'still_confirming', context).text}
        {waiting === 'tx_not_found' && supportEmail && <> Questions? Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</>}</p>
      {lastBody && <button type="button" className="pay-link-button" onClick={() => confirm(lastBody)}>Check again</button>}
    </div>}

    <details className="pay-fallback">
      <summary>Already sent the payment? Paste the transaction hash</summary>
      <form onSubmit={submitPasted}>
        <label htmlFor="pay-hash">Transaction hash</label>
        <div className="pay-hash-row">
          <input id="pay-hash" name="txHash" value={pasted} onChange={e => { setPasted(e.target.value); setPasteError(null); }} placeholder="0x…" autoComplete="off" autoCapitalize="off" spellCheck={false} required
            aria-invalid={!!pasteError} aria-describedby={pasteError ? 'pay-hash-error pay-hash-help' : 'pay-hash-help'}/>
          <button className="button" type="submit" disabled={busy}>Check payment</button>
        </div>
        {pasteError && <p id="pay-hash-error" className="pay-field-error" role="alert">{pasteError}</p>}
        <p id="pay-hash-help" className="pay-hint">We match payments to wallets linked to your account. If it came from a wallet that isn’t linked yet, we’ll ask you to connect and link it, then check it again.</p>
      </form>
    </details>
  </div>;
}
