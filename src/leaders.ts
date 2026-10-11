import type { AccountTrade, LeaderboardSortKey, LeaderboardWindow, PapertradeClient } from 'papertrade-sdk';
import type { Address } from 'viem';
import { computeTradeStats, toLeaderRow, WINDOW_MS, type LeaderRow, type TradeStats } from './stats.js';

/** Pages of 75 closed trades read per wallet when deriving stats. */
export const DEFAULT_TRADE_PAGES = 2;

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Newest-first closed trades for a wallet, stopping once a page reaches back past the window. */
export async function fetchRecentTrades(
  client: PapertradeClient,
  address: Address,
  window: LeaderboardWindow,
  options: { pages?: number; nowMs?: number; signal?: AbortSignal } = {},
): Promise<AccountTrade[]> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = nowMs - WINDOW_MS[window];
  const out: AccountTrade[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (options.pages ?? DEFAULT_TRADE_PAGES); page++) {
    const res = await client.accountTrades(address, { cursor }, options.signal);
    out.push(...res.items);
    const oldest = res.items[res.items.length - 1];
    if (!res.nextCursor || !oldest || oldest.timestampMs < cutoff) break;
    cursor = res.nextCursor;
  }
  return out;
}

export interface FetchLeadersOptions {
  window?: LeaderboardWindow;
  /** Leaderboard column the candidate list is taken from. */
  sortKey?: LeaderboardSortKey | 'lastActiveTs';
  /** How many wallets to enrich with trade stats. */
  limit?: number;
  tradePages?: number;
  concurrency?: number;
  signal?: AbortSignal;
  nowMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Leaderboard wallets joined with stats derived from their recent closed trades.
 * The leaderboard's `page` parameter is 0-based, so page 0 is requested explicitly.
 */
export async function fetchLeaderRows(client: PapertradeClient, options: FetchLeadersOptions = {}): Promise<LeaderRow[]> {
  const window = options.window ?? '24h';
  const limit = options.limit ?? 25;
  const nowMs = options.nowMs ?? Date.now();
  const pageSize = 25;
  const accounts = [];
  for (let page = 0; accounts.length < limit; page++) {
    const res = await client.leaderboard(
      { window, sortKey: (options.sortKey ?? 'totalWindowedPnl') as LeaderboardSortKey, sortDir: 'desc', page, pageSize },
      options.signal,
    );
    accounts.push(...res.accounts);
    if (res.accounts.length < pageSize) break;
  }
  const top = accounts.slice(0, limit);
  let done = 0;
  return mapLimit(top, options.concurrency ?? 5, async (account) => {
    let stats: TradeStats;
    try {
      const trades = await fetchRecentTrades(client, account.address, window, { pages: options.tradePages, nowMs, signal: options.signal });
      stats = computeTradeStats(trades, window, nowMs);
    } finally {
      options.onProgress?.(++done, top.length);
    }
    return toLeaderRow(account, window, stats);
  });
}
