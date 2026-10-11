import type { AccountTrade, LeaderboardAccount, LeaderboardWindow, OpenPosition } from 'papertrade-sdk';

const WAD_NUM = 1e18;
/** USD value of an 18-decimal integer string. Display-grade precision only. */
export const usdOf = (raw: string | bigint): number => Number(BigInt(raw)) / WAD_NUM;

export const WINDOW_MS: Record<LeaderboardWindow, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  all: Number.POSITIVE_INFINITY,
};

/** Statistics derived from a sample of a wallet's closed trades. */
export interface TradeStats {
  /** Closed trades (including liquidations) inside the window that were sampled. */
  trades: number;
  wins: number;
  losses: number;
  liquidations: number;
  /** wins / trades, 0 to 1. Null with no trades. */
  winRate: number | null;
  /** liquidations / trades, 0 to 1. Null with no trades. */
  liquidationRate: number | null;
  /** Simple mean of leverage across sampled trades. */
  avgLeverage: number | null;
  /** Margin-weighted mean of leverage across sampled trades. */
  weightedLeverage: number | null;
  avgMarginUsd: number | null;
  /** Mean time between open and close in seconds. */
  avgHoldSeconds: number | null;
  /** Sum of realized PnL net of fees across the sample, in USD. */
  netPnlUsd: number;
  tradesLast24h: number;
  /** Share of sampled trades that were long, 0 to 1. */
  longShare: number | null;
  lastTradeMs: number | null;
}

/** Realized PnL of one closed trade after the win fee. Liquidations lose the margin. */
export function tradeNetPnlUsd(t: AccountTrade): number {
  return usdOf(t.adjustedPnlRaw) - usdOf(t.userPaidFeeRaw);
}

/**
 * Summarize closed trades. `trades` is newest first as the API returns it. Trades older than the window
 * are ignored, so the stats always describe the window asked for (up to the sampled page depth).
 */
export function computeTradeStats(trades: readonly AccountTrade[], window: LeaderboardWindow, nowMs: number): TradeStats {
  const cutoff = nowMs - WINDOW_MS[window];
  const inWindow = trades.filter((t) => t.timestampMs >= cutoff);
  let wins = 0;
  let liquidations = 0;
  let lev = 0;
  let marginSum = 0;
  let levWeighted = 0;
  let hold = 0;
  let net = 0;
  let long = 0;
  let last24 = 0;
  let lastTradeMs: number | null = null;
  for (const t of inWindow) {
    const pnl = tradeNetPnlUsd(t);
    if (t.kind === 'Liquidated') liquidations += 1;
    else if (pnl > 0) wins += 1;
    const margin = usdOf(t.marginRaw);
    lev += t.leverage;
    marginSum += margin;
    levWeighted += t.leverage * margin;
    hold += Math.max(0, t.timestampMs - t.openedAtMs);
    net += pnl;
    if (t.isLong) long += 1;
    if (t.timestampMs >= nowMs - 86_400_000) last24 += 1;
    if (lastTradeMs === null || t.timestampMs > lastTradeMs) lastTradeMs = t.timestampMs;
  }
  const n = inWindow.length;
  return {
    trades: n,
    wins,
    losses: n - wins,
    liquidations,
    winRate: n ? wins / n : null,
    liquidationRate: n ? liquidations / n : null,
    avgLeverage: n ? lev / n : null,
    weightedLeverage: marginSum > 0 ? levWeighted / marginSum : null,
    avgMarginUsd: n ? marginSum / n : null,
    avgHoldSeconds: n ? hold / n / 1000 : null,
    netPnlUsd: net,
    tradesLast24h: last24,
    longShare: n ? long / n : null,
    lastTradeMs,
  };
}

export interface OpenStats {
  count: number;
  marginUsd: number;
  notionalUsd: number;
  avgLeverage: number | null;
}

/** Summary of a leader's currently open positions. */
export function computeOpenStats(positions: readonly OpenPosition[]): OpenStats {
  let margin = 0;
  let notional = 0;
  let lev = 0;
  for (const p of positions) {
    const m = usdOf(p.marginRaw);
    margin += m;
    notional += m * p.leverage;
    lev += p.leverage;
  }
  return { count: positions.length, marginUsd: margin, notionalUsd: notional, avgLeverage: positions.length ? lev / positions.length : null };
}

/** A leaderboard row joined with stats derived from its trade history. */
export interface LeaderRow {
  address: string;
  name: string | null;
  rank: number | null;
  window: LeaderboardWindow;
  pnlUsd: number;
  realizedPnlUsd: number;
  volumeUsd: number;
  balanceUsd: number;
  openPositions: number;
  openNotionalUsd: number;
  unrealizedPnlUsd: number;
  /** Unix seconds of the wallet's last activity. */
  lastActiveSec: number;
  stats: TradeStats;
}

export function toLeaderRow(account: LeaderboardAccount, window: LeaderboardWindow, stats: TradeStats): LeaderRow {
  return {
    address: account.address.toLowerCase(),
    name: account.leaderboardName,
    rank: account._leaderboardRank ?? null,
    window,
    pnlUsd: usdOf(account.totalWindowedPnl),
    realizedPnlUsd: usdOf(account.realizedPnl),
    volumeUsd: usdOf(account.totalVolume),
    balanceUsd: usdOf(account.currentBalance),
    openPositions: account.currentOpenPositionCount,
    openNotionalUsd: usdOf(account.currentOpenNotional),
    unrealizedPnlUsd: usdOf(account.currentUnrealizedPnl),
    lastActiveSec: account.lastActiveTs,
    stats,
  };
}

export type LeaderSortKey = 'pnl' | 'volume' | 'win-rate' | 'recent' | 'low-leverage' | 'low-liquidations';

export const LEADER_SORTS: Record<LeaderSortKey, { label: string; compare: (a: LeaderRow, b: LeaderRow) => number }> = {
  pnl: { label: 'Windowed PnL', compare: (a, b) => b.pnlUsd - a.pnlUsd },
  volume: { label: 'Volume', compare: (a, b) => b.volumeUsd - a.volumeUsd },
  'win-rate': { label: 'Win rate', compare: (a, b) => (b.stats.winRate ?? -1) - (a.stats.winRate ?? -1) },
  recent: { label: 'Most recently active', compare: (a, b) => b.lastActiveSec - a.lastActiveSec },
  'low-leverage': { label: 'Lowest average leverage', compare: (a, b) => (a.stats.avgLeverage ?? Infinity) - (b.stats.avgLeverage ?? Infinity) },
  'low-liquidations': { label: 'Fewest liquidations', compare: (a, b) => (a.stats.liquidationRate ?? Infinity) - (b.stats.liquidationRate ?? Infinity) },
};

export function rankLeaders(rows: readonly LeaderRow[], sort: LeaderSortKey = 'pnl', minTrades = 0): LeaderRow[] {
  return rows.filter((r) => r.stats.trades >= minTrades).sort(LEADER_SORTS[sort].compare);
}

/** Server timestamps can be seconds or milliseconds; normalize to milliseconds. */
export const toMs = (ts: number) => (ts < 1e11 ? ts * 1000 : ts);
