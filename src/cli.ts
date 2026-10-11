import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  fetchWalletState,
  formatUnits,
  PapertradeClient,
  type LeaderboardWindow,
} from 'papertrade-sdk';
import type { Address } from 'viem';
import { ConfigError, resolveConfig, type CopyConfigInput, type LeverageInput, type ResolvedConfig, type SizingInput } from './config.js';
import { CopyEngine } from './engine.js';
import { fetchLeaderRows, fetchRecentTrades } from './leaders.js';
import { createLogger, type LogLevel } from './log.js';
import { dryRunTrader, liveTrader, walletAddress, WALLET_KEY_ENV } from './session-flow.js';
import { computeOpenStats, computeTradeStats, LEADER_SORTS, rankLeaders, type LeaderRow, type LeaderSortKey } from './stats.js';
import { acquireLock, emptyPersistedState, StateFileError, StateStore } from './state-store.js';

const VERSION = '0.1.0';
const WINDOWS = ['24h', '7d', '30d', 'all'] as const;
export const LIVE_PHRASE = 'start live copying';

const HELP = `papertrade-copytrade ${VERSION}
Unofficial copy-trading CLI for Papertrade (1000x synthetic perps on HyperEVM).
High leverage can lose your whole margin. Past performance of a leader says nothing about the future.

Usage
  papertrade-copytrade leaders [--window 24h|7d|30d|all] [--sort ${Object.keys(LEADER_SORTS).join('|')}] [--limit 25] [--min-trades 3] [--json]
  papertrade-copytrade inspect <address> [--window 7d] [--json]
  papertrade-copytrade follow <address> [<address>...] [options]
  papertrade-copytrade check --config <file>        validate a config and print the resolved guardrails

follow: DRY RUN by default. Prints what it would sign and signs nothing for submission.
  --live                      Submit real trades. Needs ${WALLET_KEY_ENV} and a typed confirmation at startup.
  --config <file>             JSON config (see README). Flags below override it.
  --account <address>         Follower account (dry run). In live mode it is derived from ${WALLET_KEY_ENV}.
  --sizing <spec>             fixed:<usd> | proportional:<multiplier> | percent:<pct of your balance>
  --leverage <spec>           copy | cap:<n> | fixed:<n>
  --max-margin-per-trade <usd>   REQUIRED guardrail
  --max-total-margin <usd>       REQUIRED guardrail
  --max-leverage <n>             REQUIRED guardrail
  --max-positions <n>            REQUIRED guardrail
  --daily-loss-limit <usd>       REQUIRED guardrail (UTC day)
  --markets <BTC,ETH>            REQUIRED guardrail (allowlist)
  --cooldown <seconds>           REQUIRED guardrail (between opens on the same market)
  --kill-switch <file>           REQUIRED guardrail (create this file to stop new copies)
  --max-slippage <pct>           REQUIRED guardrail (mark vs leader entry)
  --max-leader-age <seconds>     Skip stale leader opens (default 60)
  --copy-existing                Also copy positions the leader already holds at start
  --flatten-on-kill              Kill switch also closes every mirrored position
  --state <file>                 State file, mode 0600 (default ./copytrade-state.json)
  --assume-balance <usd>         Dry run only: pretend the account holds this much
  --json                         Structured JSON log lines
  --level debug|info|warn|error  Log level (default info)
  --api <url>                    API origin (default https://exchange.papertrade.xyz)
`;

class UsageError extends Error {}

const out = (text: string) => process.stdout.write(`${text}\n`);
const err = (text: string) => process.stderr.write(`${text}\n`);

function fmtUsd(n: number, digits = 0): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? '-' : ''}$${abs}`;
}
const pct = (n: number | null) => (n === null ? '-' : `${(n * 100).toFixed(0)}%`);
const ago = (sec: number, nowMs: number) => {
  const s = Math.max(0, Math.floor(nowMs / 1000 - sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function table(headers: string[], rows: string[][], align: Array<'l' | 'r'>): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function num(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${raw}".`);
  return n;
}

export function parseSizingSpec(spec: string): SizingInput {
  const [mode, value] = spec.split(':');
  if (value === undefined) throw new UsageError(`Sizing "${spec}" must look like fixed:50, proportional:0.5 or percent:5.`);
  const n = num('sizing', value);
  if (mode === 'fixed') return { mode, marginUsd: n };
  if (mode === 'proportional') return { mode, multiplier: n };
  if (mode === 'percent') return { mode, percent: n };
  throw new UsageError(`Unknown sizing mode "${mode}". Use fixed, proportional or percent.`);
}

export function parseLeverageSpec(spec: string): LeverageInput {
  if (spec === 'copy') return { mode: 'copy' };
  const [mode, value] = spec.split(':');
  if (value === undefined) throw new UsageError(`Leverage "${spec}" must be copy, cap:20 or fixed:10.`);
  const n = num('leverage', value);
  if (mode === 'cap') return { mode, max: n };
  if (mode === 'fixed') return { mode, value: n };
  throw new UsageError(`Unknown leverage mode "${mode}". Use copy, cap or fixed.`);
}

const FOLLOW_OPTIONS = {
  live: { type: 'boolean' },
  config: { type: 'string' },
  account: { type: 'string' },
  sizing: { type: 'string' },
  leverage: { type: 'string' },
  'max-margin-per-trade': { type: 'string' },
  'max-total-margin': { type: 'string' },
  'max-leverage': { type: 'string' },
  'max-positions': { type: 'string' },
  'daily-loss-limit': { type: 'string' },
  markets: { type: 'string' },
  cooldown: { type: 'string' },
  'kill-switch': { type: 'string' },
  'max-slippage': { type: 'string' },
  'max-leader-age': { type: 'string' },
  'copy-existing': { type: 'boolean' },
  'flatten-on-kill': { type: 'boolean' },
  state: { type: 'string' },
  'assume-balance': { type: 'string' },
  json: { type: 'boolean' },
  level: { type: 'string' },
  api: { type: 'string' },
  duration: { type: 'string' },
} as const;

type FollowValues = ReturnType<typeof parseArgs<{ options: typeof FOLLOW_OPTIONS; allowPositionals: true }>>['values'];

/** Merge the config file (if any), positional leaders and flags into the raw input for resolveConfig. */
export function buildConfigInput(values: FollowValues, positionals: string[], file: Partial<CopyConfigInput> | null, env: NodeJS.ProcessEnv): Partial<CopyConfigInput> {
  const base: Partial<CopyConfigInput> = { ...(file ?? {}) };
  const g: Record<string, unknown> = { ...(base.guardrails ?? {}) };
  const set = (key: string, raw: string | undefined) => {
    if (raw !== undefined) g[key] = num(key, raw);
  };
  set('maxMarginPerTradeUsd', values['max-margin-per-trade']);
  set('maxTotalOpenMarginUsd', values['max-total-margin']);
  set('maxLeverage', values['max-leverage']);
  set('maxOpenPositions', values['max-positions']);
  set('dailyLossLimitUsd', values['daily-loss-limit']);
  set('cooldownSeconds', values.cooldown);
  set('maxSlippagePct', values['max-slippage']);
  set('maxLeaderAgeSeconds', values['max-leader-age']);
  if (values.markets !== undefined) g.markets = values.markets.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
  if (values['kill-switch'] !== undefined) g.killSwitchFile = values['kill-switch'];
  base.guardrails = g as unknown as CopyConfigInput['guardrails'];
  if (values.sizing) base.sizing = parseSizingSpec(values.sizing);
  if (values.leverage) base.leverage = parseLeverageSpec(values.leverage);
  if (positionals.length) base.leaders = positionals;
  if (values['copy-existing']) base.copyExisting = true;
  if (values['flatten-on-kill']) base.flattenOnKill = true;
  if (values.live) {
    const raw = env[WALLET_KEY_ENV];
    if (raw && !values.account) base.account = walletAddress(raw);
  }
  if (values.account) base.account = values.account.toLowerCase();
  return base;
}

function loadConfigFile(path: string): Partial<CopyConfigInput> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`Cannot read config ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as Partial<CopyConfigInput>;
  } catch (e) {
    throw new UsageError(`Config ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

export function describeConfig(config: ResolvedConfig, mode: 'dry-run' | 'live'): string[] {
  const g = config.guardrails;
  const sz = (s: ResolvedConfig['leaders'][number]['sizing']) =>
    s.mode === 'fixed' ? `fixed margin ${fmtUsd(s.marginUsd, 2)}` : s.mode === 'proportional' ? `${s.multiplier}x the leader's margin` : `${s.percent}% of your balance`;
  const lv = (l: LeverageInput) => (l.mode === 'copy' ? "copy the leader's leverage" : l.mode === 'cap' ? `leader's leverage capped at ${l.max}x` : `fixed ${l.value}x`);
  return [
    `Mode              ${mode === 'live' ? 'LIVE (real trades)' : 'DRY RUN (nothing is submitted)'}`,
    `Account           ${config.account}`,
    ...config.leaders.map((l, i) => `Leader ${i + 1}          ${l.address}  sizing: ${sz(l.sizing)}; leverage: ${lv(l.leverage)}`),
    `Markets           ${g.markets.join(', ')}`,
    `Max per trade     ${fmtUsd(g.maxMarginPerTradeUsd, 2)} margin`,
    `Max total open    ${fmtUsd(g.maxTotalOpenMarginUsd, 2)} margin`,
    `Max leverage      ${g.maxLeverage}x`,
    `Max positions     ${g.maxOpenPositions}`,
    `Daily loss stop   ${fmtUsd(g.dailyLossLimitUsd, 2)} realized (UTC day)`,
    `Cooldown          ${g.cooldownSeconds}s between opens on a market`,
    `Slippage guard    skip when mark moved more than ${g.maxSlippagePct}% from the leader's entry`,
    `Kill switch file  ${g.killSwitchFile}${config.flattenOnKill ? ' (also closes everything)' : ''}`,
    `Existing leader positions  ${config.copyExisting ? 'copied' : 'ignored'}`,
  ];
}

async function confirmLive(config: ResolvedConfig, stateFile: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError('--live needs an interactive terminal for the typed confirmation. It cannot run from a pipe, cron or CI.');
  }
  out('');
  out('LIVE MODE. Real positions will be opened and closed on your Papertrade account.');
  out('Leverage up to 1000x can lose the whole margin of a trade within seconds. A leader\'s past results do not predict their next trade.');
  out('The session key can trade but can never withdraw.');
  out('');
  for (const line of describeConfig(config, 'live')) out(`  ${line}`);
  out(`  State file        ${stateFile}`);
  out('');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question(`Type "${LIVE_PHRASE}" to continue, anything else aborts: `, resolve));
  rl.close();
  if (answer.trim() !== LIVE_PHRASE) throw new UsageError('Confirmation did not match. Nothing was started.');
}

function makeClient(api: string | undefined) {
  return new PapertradeClient(api ? { baseUrl: api } : {});
}

async function cmdLeaders(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { window: { type: 'string' }, sort: { type: 'string' }, limit: { type: 'string' }, 'min-trades': { type: 'string' }, json: { type: 'boolean' }, api: { type: 'string' } },
  });
  const window = (values.window ?? '24h') as LeaderboardWindow;
  if (!WINDOWS.includes(window as (typeof WINDOWS)[number])) throw new UsageError(`--window must be one of ${WINDOWS.join(', ')}.`);
  const sort = (values.sort ?? 'pnl') as LeaderSortKey;
  if (!(sort in LEADER_SORTS)) throw new UsageError(`--sort must be one of ${Object.keys(LEADER_SORTS).join(', ')}.`);
  const limit = values.limit ? Math.min(100, Math.max(1, Math.floor(num('limit', values.limit)))) : 25;
  const now = Date.now();
  const tty = process.stderr.isTTY;
  const rows = await fetchLeaderRows(makeClient(values.api), {
    window,
    limit,
    nowMs: now,
    sortKey: sort === 'recent' ? 'lastActiveTs' : 'totalWindowedPnl',
    onProgress: (done, total) => {
      if (tty) process.stderr.write(`\rReading trade history ${done}/${total}`);
    },
  });
  if (tty) process.stderr.write('\r\u001b[K');
  const ranked = rankLeaders(rows, sort, values['min-trades'] ? num('min-trades', values['min-trades']) : 0);
  if (values.json) {
    out(JSON.stringify(ranked, null, 2));
    return;
  }
  if (!ranked.length) {
    out('No leaderboard wallets matched. Lower --min-trades or widen --window.');
    return;
  }
  out(
    table(
      ['#', 'wallet', 'name', `pnl ${window}`, 'volume', 'trades', 'win', 'avg lev', 'open', 'liq', 'active'],
      ranked.map((r, i) => [
        String(i + 1),
        r.address,
        (r.name ?? '').slice(0, 16),
        fmtUsd(r.pnlUsd),
        fmtUsd(r.volumeUsd),
        String(r.stats.trades),
        pct(r.stats.winRate),
        r.stats.avgLeverage === null ? '-' : `${r.stats.avgLeverage.toFixed(0)}x`,
        String(r.openPositions),
        String(r.stats.liquidations),
        ago(r.lastActiveSec, now),
      ]),
      ['r', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
  );
  out('');
  out('Stats come from each wallet\'s most recent closed trades in the window. Past performance does not predict future results.');
  out('Mirror one with: papertrade-copytrade follow <wallet> --help');
}

async function cmdInspect(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, options: { window: { type: 'string' }, json: { type: 'boolean' }, api: { type: 'string' } }, allowPositionals: true });
  const address = positionals[0]?.toLowerCase();
  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) throw new UsageError('inspect needs a 0x wallet address.');
  const window = (values.window ?? '7d') as LeaderboardWindow;
  const client = makeClient(values.api);
  const now = Date.now();
  const [wallet, trades] = await Promise.all([
    fetchWalletState(address as Address, { baseUrl: client.http.baseUrl }),
    fetchRecentTrades(client, address as Address, window, { nowMs: now }),
  ]);
  const stats = computeTradeStats(trades, window, now);
  const open = computeOpenStats(wallet.positions);
  if (values.json) {
    out(JSON.stringify({ address, window, stats, open, positions: wallet.positions.map((p) => ({ ...p, positionId: p.positionId.toString() })), balanceUsd: formatUnits(wallet.balance, 18) }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }
  out(`${address}`);
  out(`Balance ${formatUnits(wallet.balance, 18)} USD, ${open.count} open position(s), margin ${fmtUsd(open.marginUsd, 2)}, notional ${fmtUsd(open.notionalUsd)}, avg leverage ${open.avgLeverage === null ? '-' : `${open.avgLeverage.toFixed(0)}x`}`);
  out(`${window}: ${stats.trades} closed trades, net PnL ${fmtUsd(stats.netPnlUsd, 2)}, win rate ${pct(stats.winRate)}, avg leverage ${stats.avgLeverage === null ? '-' : `${stats.avgLeverage.toFixed(0)}x`}, liquidations ${stats.liquidations}`);
  if (wallet.positions.length) {
    out('');
    out(
      table(
        ['id', 'market', 'side', 'margin', 'lev', 'opened'],
        wallet.positions.map((p) => [p.positionId.toString(), p.instrumentId === 0 ? 'BTC' : p.instrumentId === 1 ? 'ETH' : String(p.instrumentId), p.isLong ? 'long' : 'short', fmtUsd(Number(formatUnits(p.marginRaw, 18)), 2), `${p.leverage}x`, ago(p.openedAtMs / 1000, now)]),
        ['r', 'l', 'l', 'r', 'r', 'r'],
      ),
    );
  }
}

async function cmdCheck(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, options: FOLLOW_OPTIONS, allowPositionals: true });
  const input = buildConfigInput(values, positionals, values.config ? loadConfigFile(values.config) : null, process.env);
  const config = resolveConfig(input);
  for (const line of describeConfig(config, 'dry-run')) out(line);
  out('\nConfig is valid.');
}

async function cmdFollow(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, options: FOLLOW_OPTIONS, allowPositionals: true });
  const mode = values.live ? 'live' : 'dry-run';
  const input = buildConfigInput(values, positionals, values.config ? loadConfigFile(values.config) : null, process.env);
  const config = resolveConfig(input);
  if (values.live && values['assume-balance']) throw new UsageError('--assume-balance is for dry runs only.');
  const level = (values.level ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new UsageError('--level must be debug, info, warn or error.');
  const stateFile = values.state ?? './copytrade-state.json';

  const unlock = acquireLock(stateFile);
  let engine: CopyEngine | undefined;
  try {
    const store = new StateStore(stateFile);
    const now = Date.now();
    let state = store.load();
    if (state && state.account !== config.account) throw new StateFileError(`${stateFile} belongs to ${state.account}, not ${config.account}. Use a different --state file.`);
    if (state && state.mode !== mode) {
      throw new StateFileError(`${stateFile} was written by a ${state.mode} run. Use a separate --state file per mode so simulated and real positions never mix.`);
    }
    state ??= emptyPersistedState(mode, config.account, now);

    if (mode === 'live') {
      for (const line of describeConfig(config, 'live')) out(line);
      await confirmLive(config, stateFile);
    } else {
      for (const line of describeConfig(config, 'dry-run')) out(line);
      out('');
    }

    const client = makeClient(values.api);
    const save = () => store.save(state as NonNullable<typeof state>);
    const preLog = createLogger({ json: !!values.json, level, color: !values.json && !!process.stdout.isTTY });
    const setup =
      mode === 'live'
        ? await liveTrader({ client, account: config.account, state, walletKeyRaw: process.env[WALLET_KEY_ENV], save, log: preLog })
        : dryRunTrader(client, config.account, state, save);
    const walletKey = process.env[WALLET_KEY_ENV];
    const log = createLogger({ json: !!values.json, level, color: !values.json && !!process.stdout.isTTY, secrets: [...setup.secrets, ...(walletKey ? [walletKey.replace(/^0x/, ''), walletKey] : [])] });
    engine = new CopyEngine({
      config,
      mode,
      client,
      trader: setup.trader,
      store,
      state,
      log,
      assumeBalanceRaw: values['assume-balance'] ? BigInt(Math.round(num('assume-balance', values['assume-balance']) * 1e6)) * 10n ** 12n : undefined,
    });
    const running = engine;
    await running.start();

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (why: string) => {
        if (stopping) return;
        stopping = true;
        log.info('stopping', { why });
        resolve();
      };
      process.once('SIGINT', () => stop('SIGINT'));
      process.once('SIGTERM', () => stop('SIGTERM'));
      if (values.duration) setTimeout(() => stop(`--duration ${values.duration}s elapsed`), num('duration', values.duration) * 1000).unref();
    });
    await running.stop();
  } finally {
    unlock();
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      out(HELP);
      return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      out(VERSION);
      return 0;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      out(HELP);
      return 0;
    }
    if (command === 'leaders') await cmdLeaders(rest);
    else if (command === 'inspect') await cmdInspect(rest);
    else if (command === 'follow') await cmdFollow(rest);
    else if (command === 'check') await cmdCheck(rest);
    else throw new UsageError(`Unknown command "${command}". Run papertrade-copytrade --help.`);
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      err('Invalid configuration:');
      for (const issue of e.issues) err(`  - ${issue}`);
      err('\nEvery guardrail is required. Run papertrade-copytrade --help for the flags.');
      return 2;
    }
    if (e instanceof UsageError || e instanceof StateFileError) {
      err(e.message);
      return 2;
    }
    if (e instanceof Error && String((e as NodeJS.ErrnoException).code ?? '').startsWith('ERR_PARSE_ARGS')) {
      err(e.message);
      return 2;
    }
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
