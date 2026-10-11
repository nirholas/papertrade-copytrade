import { PapertradeClient, type LeaderboardWindow, type TradingState } from 'papertrade-sdk';
import { validateConfig, type CopyConfigInput, type LeverageInput, type SizingInput } from '../src/config.js';
import { fetchLeaderRows } from '../src/leaders.js';
import { LEADER_SORTS, rankLeaders, toMs, type LeaderRow, type LeaderSortKey } from '../src/stats.js';

const client = new PapertradeClient({ baseUrl: '/api/papertrade', clientBuild: 'papertrade-copytrade-site' });
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 })}`;
const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const ago = (sec: number) => {
  const d = Math.max(0, Date.now() - toMs(sec));
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
};

function setStatus(text: string, kind: 'ok' | 'err' | 'wait') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

/* ---------- leader explorer ---------- */

let rows: LeaderRow[] = [];
let loadedWindow: LeaderboardWindow = '24h';
let loadToken = 0;

function skeletonTable() {
  const line = '<tr>' + '<td><span class="skeleton"></span></td>'.repeat(9) + '</tr>';
  $('leaders-body').innerHTML = `<table aria-label="Loading leaders"><tbody>${line.repeat(6)}</tbody></table>`;
  $('leaders-body').setAttribute('aria-busy', 'true');
}

function renderState(title: string, detail: string, retry: boolean) {
  $('leaders-body').innerHTML = `<div class="state"><strong>${esc(title)}</strong>${esc(detail)}${retry ? '<br><button class="btn" type="button" id="retry">Retry</button>' : ''}</div>`;
  $('leaders-body').setAttribute('aria-busy', 'false');
  document.getElementById('retry')?.addEventListener('click', () => void loadLeaders());
}

function renderLeaders() {
  const sort = $<HTMLSelectElement>('sort').value as LeaderSortKey;
  const minTrades = Math.max(0, Number($<HTMLInputElement>('min-trades').value) || 0);
  const list = rankLeaders(rows, sort, minTrades);
  if (!rows.length) return renderState('No active wallets in this window', 'Try a longer window.', true);
  if (!list.length) return renderState('No leader has that many trades', `Lower "Min trades" (now ${minTrades}) to see the ${rows.length} wallets loaded.`, false);
  const body = list
    .map((r, i) => {
      const s = r.stats;
      const name = r.name ? `<div>${esc(r.name)}</div>` : '';
      return `<tr>
        <td>${i + 1}</td>
        <td class="addr" title="${esc(r.address)}">${name}${esc(short(r.address))}</td>
        <td class="${r.pnlUsd >= 0 ? 'pos' : 'neg'}">${usd(r.pnlUsd)}</td>
        <td>${s.trades}</td>
        <td>${pct(s.winRate)}</td>
        <td class="${(s.liquidationRate ?? 0) > 0.1 ? 'hot' : ''}">${pct(s.liquidationRate)}</td>
        <td class="${(s.avgLeverage ?? 0) > 300 ? 'hot' : ''}">${s.avgLeverage === null ? 'n/a' : `${s.avgLeverage.toFixed(0)}x`}</td>
        <td>${r.openPositions}</td>
        <td>${esc(ago(r.lastActiveSec))}</td>
        <td><button class="btn small ghost" type="button" data-follow="${esc(r.address)}">Follow</button></td>
      </tr>`;
    })
    .join('');
  $('leaders-body').innerHTML = `<table><caption class="visually-hidden">Papertrade leaders sorted by ${esc(LEADER_SORTS[sort].label)}</caption>
    <thead><tr><th scope="col">#</th><th scope="col">Wallet</th><th scope="col">PnL (${esc(loadedWindow)})</th><th scope="col">Trades</th><th scope="col">Win rate</th><th scope="col">Liquidated</th><th scope="col">Avg leverage</th><th scope="col">Open</th><th scope="col">Last active</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
    <tbody>${body}</tbody></table>`;
  $('leaders-body').setAttribute('aria-busy', 'false');
  syncFollowButtons();
}

async function loadLeaders() {
  const token = ++loadToken;
  const window = $<HTMLSelectElement>('window').value as LeaderboardWindow;
  skeletonTable();
  setStatus('Loading live leaderboard', 'wait');
  $<HTMLButtonElement>('refresh').disabled = true;
  try {
    const next = await fetchLeaderRows(client, {
      window,
      limit: 25,
      concurrency: 4,
      onProgress: (done, total) => {
        if (token === loadToken) setStatus(`Reading trade history ${done}/${total}`, 'wait');
      },
    });
    if (token !== loadToken) return;
    rows = next;
    loadedWindow = window;
    renderLeaders();
    setStatus(`Live from exchange.papertrade.xyz, ${rows.length} wallets, updated ${new Date().toLocaleTimeString()}`, 'ok');
  } catch (err) {
    if (token !== loadToken) return;
    rows = [];
    setStatus('Could not load leaders', 'err');
    renderState('Could not reach the Papertrade API', `${err instanceof Error ? err.message : String(err)} This is usually a rate limit. Wait a few seconds and retry.`, true);
  } finally {
    if (token === loadToken) $<HTMLButtonElement>('refresh').disabled = false;
  }
}

function selectedLeaders(): string[] {
  return $<HTMLTextAreaElement>('f-leaders')
    .value.split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function syncFollowButtons() {
  const chosen = new Set(selectedLeaders().map((a) => a.toLowerCase()));
  document.querySelectorAll<HTMLButtonElement>('[data-follow]').forEach((b) => {
    const on = chosen.has((b.dataset.follow ?? '').toLowerCase());
    b.textContent = on ? 'Added' : 'Follow';
    b.setAttribute('aria-pressed', String(on));
  });
}

$('leaders-body').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-follow]');
  if (!btn?.dataset.follow) return;
  const addr = btn.dataset.follow;
  const list = selectedLeaders();
  const idx = list.findIndex((a) => a.toLowerCase() === addr.toLowerCase());
  if (idx >= 0) list.splice(idx, 1);
  else list.push(addr);
  $<HTMLTextAreaElement>('f-leaders').value = list.join('\n');
  syncFollowButtons();
  build();
});

/* ---------- config builder ---------- */

let trading: TradingState | null = null;

const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const numVal = (id: string) => {
  const v = $<HTMLInputElement>(id).value.trim();
  return v === '' ? Number.NaN : Number(v);
};

function sizingFromForm(): { input: SizingInput; spec: string } {
  const mode = $<HTMLSelectElement>('f-sizing').value;
  const v = numVal('f-sizing-value');
  if (mode === 'proportional') return { input: { mode, multiplier: v }, spec: `proportional:${v}` };
  if (mode === 'percent') return { input: { mode, percent: v }, spec: `percent:${v}` };
  return { input: { mode: 'fixed', marginUsd: v }, spec: `fixed:${v}` };
}

function leverageFromForm(): { input: LeverageInput; spec: string } {
  const mode = $<HTMLSelectElement>('f-leverage').value;
  const v = numVal('f-leverage-value');
  if (mode === 'cap') return { input: { mode, max: v }, spec: `cap:${v}` };
  if (mode === 'fixed') return { input: { mode, value: v }, spec: `fixed:${v}` };
  return { input: { mode: 'copy' }, spec: 'copy' };
}

function selectedMarkets(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('#g-markets input:checked')].map((i) => i.value);
}

function build() {
  const sizing = sizingFromForm();
  const leverage = leverageFromForm();
  $<HTMLInputElement>('f-leverage-value').disabled = leverage.spec === 'copy';
  $('f-sizing-label').textContent = { fixed: 'USD margin', proportional: 'Multiplier (1 = same margin)', percent: 'Percent of balance' }[$<HTMLSelectElement>('f-sizing').value] ?? '';
  const account = $<HTMLInputElement>('f-account').value.trim();
  const leaders = selectedLeaders();
  const config: CopyConfigInput = {
    account,
    leaders,
    sizing: sizing.input,
    leverage: leverage.input,
    guardrails: {
      maxMarginPerTradeUsd: numVal('g-trade'),
      maxTotalOpenMarginUsd: numVal('g-total'),
      maxLeverage: numVal('g-lev'),
      maxOpenPositions: numVal('g-positions'),
      dailyLossLimitUsd: numVal('g-loss'),
      markets: selectedMarkets(),
      cooldownSeconds: numVal('g-cooldown'),
      killSwitchFile: $<HTMLInputElement>('g-kill').value.trim(),
      maxSlippagePct: numVal('g-slip'),
      maxLeaderAgeSeconds: numVal('g-age'),
    },
    copyExisting: $<HTMLInputElement>('o-existing').checked,
    flattenOnKill: $<HTMLInputElement>('o-flatten').checked,
  };
  const result = validateConfig(config);
  const box = $('validation');
  const outs = ['out-cmd', 'out-json', 'out-live'].map((id) => $(id));
  $<HTMLInputElement>('f-account').setAttribute('aria-invalid', String(account !== '' && !/^0x[0-9a-fA-F]{40}$/.test(account)));
  if (!result.ok) {
    box.className = 'validation bad';
    box.innerHTML = `<strong>Fix these before you copy the command:</strong><ul>${result.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    for (const o of outs) o.textContent = 'Complete the form to generate this.';
    return;
  }
  box.className = 'validation ok';
  box.textContent = 'Config is valid. Every guardrail is set. This is a dry run: nothing is signed for submission.';
  const g = config.guardrails;
  const flags = [
    `--account ${shq(account)}`,
    `--sizing ${sizing.spec}`,
    `--leverage ${leverage.spec}`,
    `--max-margin-per-trade ${g.maxMarginPerTradeUsd}`,
    `--max-total-margin ${g.maxTotalOpenMarginUsd}`,
    `--max-leverage ${g.maxLeverage}`,
    `--max-positions ${g.maxOpenPositions}`,
    `--daily-loss-limit ${g.dailyLossLimitUsd}`,
    `--markets ${g.markets.join(',')}`,
    `--cooldown ${g.cooldownSeconds}`,
    `--kill-switch ${shq(g.killSwitchFile)}`,
    `--max-slippage ${g.maxSlippagePct}`,
    `--max-leader-age ${g.maxLeaderAgeSeconds}`,
    ...(config.copyExisting ? ['--copy-existing'] : []),
    ...(config.flattenOnKill ? ['--flatten-on-kill'] : []),
  ];
  const base = `npx papertrade-copytrade follow ${leaders.join(' ')} \\\n  ${flags.join(' \\\n  ')}`;
  $('out-cmd').textContent = base;
  $('out-json').textContent = JSON.stringify(config, null, 2);
  $('out-live').textContent = `export PAPERTRADE_WALLET_KEY=<your wallet private key, set in your own terminal>\n${base} \\\n  --live`;
}

async function loadMarkets() {
  const box = $('g-markets');
  try {
    trading = await client.tradingState();
    const open = trading.instruments.filter((i) => i.openable && ['BTC', 'ETH'].includes(i.symbol));
    box.innerHTML = open.length
      ? open.map((i) => `<label class="check"><input type="checkbox" value="${esc(i.symbol)}" checked> ${esc(i.symbol)}</label>`).join('')
      : '<span class="help">No market is open for trading right now.</span>';
  } catch {
    box.innerHTML = ['BTC', 'ETH'].map((s) => `<label class="check"><input type="checkbox" value="${s}" checked> ${s}</label>`).join('');
  }
  build();
}

async function copyFrom(id: string, btn: HTMLButtonElement) {
  const text = $(id).textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($(id));
    sel?.removeAllRanges();
    sel?.addRange(range);
    btn.textContent = 'Press Ctrl+C';
  }
  window.setTimeout(() => (btn.textContent = 'Copy'), 1800);
}

/* ---------- wire up ---------- */

$<HTMLSelectElement>('sort').innerHTML = Object.entries(LEADER_SORTS)
  .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
  .join('');
$('window').addEventListener('change', () => void loadLeaders());
$('refresh').addEventListener('click', () => void loadLeaders());
$('sort').addEventListener('change', renderLeaders);
$('min-trades').addEventListener('input', renderLeaders);
$('builder-form').addEventListener('input', () => {
  syncFollowButtons();
  build();
});
$('builder-form').addEventListener('submit', (e) => e.preventDefault());
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => b.addEventListener('click', () => void copyFrom(b.dataset.copy ?? '', b)));

build();
void loadMarkets();
void loadLeaders();
