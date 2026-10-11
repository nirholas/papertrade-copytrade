import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AccountTrade } from 'papertrade-sdk';
import { describe, expect, it } from 'vitest';
import { computeTradeStats, rankLeaders, toMs, tradeNetPnlUsd, usdOf, type LeaderRow } from '../src/stats.js';

const raw = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/account-trades-rvw.json', import.meta.url)), 'utf8')) as { fetchedAtMs: number; items: AccountTrade[] };
const trades = raw.items;
const now = raw.fetchedAtMs;

describe('computeTradeStats on 75 recorded closed trades', () => {
  const stats = computeTradeStats(trades, '24h', now);

  it('counts only trades inside the window', () => {
    expect(stats.trades).toBeGreaterThan(0);
    expect(stats.trades).toBeLessThanOrEqual(trades.length);
    expect(computeTradeStats(trades, 'all', now).trades).toBe(trades.length);
  });

  it('wins plus losses is the trade count and rates are fractions', () => {
    expect(stats.wins + stats.losses).toBe(stats.trades);
    expect(stats.winRate).toBeGreaterThanOrEqual(0);
    expect(stats.winRate).toBeLessThanOrEqual(1);
    expect(stats.longShare).toBeGreaterThanOrEqual(0);
  });

  it('net PnL equals the sum of per-trade net PnL', () => {
    const cutoff = now - 86_400_000;
    const expected = trades.filter((t) => t.timestampMs >= cutoff).reduce((s, t) => s + tradeNetPnlUsd(t), 0);
    expect(stats.netPnlUsd).toBeCloseTo(expected, 6);
  });

  it('average leverage stays inside the protocol range', () => {
    expect(stats.avgLeverage).toBeGreaterThan(0);
    expect(stats.avgLeverage).toBeLessThanOrEqual(1000);
  });

  it('is empty-safe', () => {
    const empty = computeTradeStats([], '7d', now);
    expect(empty).toMatchObject({ trades: 0, winRate: null, avgLeverage: null, netPnlUsd: 0, lastTradeMs: null });
  });
});

describe('helpers', () => {
  it('converts wad strings to dollars', () => {
    expect(usdOf('1500000000000000000000')).toBe(1500);
  });
  it('normalizes seconds and milliseconds timestamps', () => {
    expect(toMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(toMs(1_790_000_000_000)).toBe(1_790_000_000_000);
  });
});

describe('rankLeaders', () => {
  const stat = (over: Record<string, unknown>) => ({ trades: 10, winRate: 0.5, liquidationRate: 0, avgLeverage: 100, ...over }) as LeaderRow['stats'];
  const row = (address: string, pnlUsd: number, lastActiveSec: number, s: Record<string, unknown> = {}): LeaderRow =>
    ({ address, name: null, rank: null, window: '24h', pnlUsd, realizedPnlUsd: 0, volumeUsd: 0, balanceUsd: 0, openPositions: 0, openNotionalUsd: 0, unrealizedPnlUsd: 0, lastActiveSec, stats: stat(s) });
  const rows = [row('a', 10, 5, { avgLeverage: 900, trades: 2 }), row('b', 30, 1, { avgLeverage: 20 }), row('c', 20, 9, { avgLeverage: 300 })];

  it('sorts by pnl, recency and low leverage', () => {
    expect(rankLeaders(rows, 'pnl').map((r) => r.address)).toEqual(['b', 'c', 'a']);
    expect(rankLeaders(rows, 'recent').map((r) => r.address)).toEqual(['c', 'a', 'b']);
    expect(rankLeaders(rows, 'low-leverage').map((r) => r.address)).toEqual(['b', 'c', 'a']);
  });

  it('filters by minimum trades without mutating the input', () => {
    expect(rankLeaders(rows, 'pnl', 5).map((r) => r.address)).toEqual(['b', 'c']);
    expect(rows.map((r) => r.address)).toEqual(['a', 'b', 'c']);
  });
});
