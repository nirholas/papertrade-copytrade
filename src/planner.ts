import { notionalToQuantityRaw, type Instrument, type OpenPosition, type TradingState } from 'papertrade-sdk';
import type { Address, Hex } from 'viem';
import type { ResolvedConfig, ResolvedLeader } from './config.js';

/** Why the planner declined to act. Stable codes so logs, tests and UIs can match on them. */
export type SkipCode =
  | 'already_mirrored'
  | 'preexisting_position'
  | 'stale_leader_position'
  | 'kill_switch'
  | 'daily_loss_limit'
  | 'market_not_allowed'
  | 'market_unavailable'
  | 'cooldown'
  | 'max_open_positions'
  | 'leverage_above_guardrail'
  | 'no_mark_price'
  | 'slippage'
  | 'margin_below_minimum'
  | 'notional_below_minimum'
  | 'notional_above_maximum'
  | 'open_interest_cap'
  | 'insufficient_balance'
  | 'no_margin_headroom'
  | 'no_mirrored_position'
  | 'already_closing';

export type MappingStatus = 'pending' | 'open' | 'closing' | 'closed' | 'failed';

/** Links one leader position to the follower position that mirrors it. */
export interface Mapping {
  key: string;
  leader: Address;
  leaderPositionId: string;
  status: MappingStatus;
  instrumentId: number;
  isLong: boolean;
  marginRaw: bigint;
  leverage: number;
  /** Intent id of the open we submitted. The follower's position carries the same id once it lands. */
  intentId: Hex | null;
  /** Set once the follower's own position exists. Simulated positions in dry-run use `sim-N`. */
  followerPositionId: string | null;
  closeIntentId: Hex | null;
  /** The leader has already closed; close ours as soon as it exists. */
  leaderClosed: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  note: string | null;
}

export interface PositionRef {
  positionId: string;
  instrumentId: number;
  marginRaw: bigint;
}

/** Everything the planner needs to know about the follower. No secrets, no I/O handles. */
export interface FollowerState {
  /** Free collateral (funds.availableBalance), 18-decimal USD. */
  availableRaw: bigint;
  /** Positions currently open on the follower account (real or simulated). */
  positions: PositionRef[];
  mappings: Record<string, Mapping>;
  /** UTC day (YYYY-MM-DD) that `realizedTodayRaw` belongs to. */
  dayKey: string;
  /** Realized PnL (net of fees) for the UTC day. Negative is a loss. */
  realizedTodayRaw: bigint;
  /** Last time a copied open was submitted, per instrument id. */
  lastOpenAtMs: Record<string, number>;
}

/** Live market data the planner reads. All prices are raw integers in each instrument's price scale. */
export interface MarketContext {
  nowMs: number;
  trading: TradingState;
  marksRaw: Record<number, bigint>;
  /** True when the kill switch file exists. */
  killSwitch: boolean;
}

export type LeaderEvent =
  | {
      type: 'open';
      leader: Address;
      position: OpenPosition;
      /** True when the position already existed the first time the leader was observed. */
      baseline: boolean;
    }
  | { type: 'close'; leader: Address; positionId: string };

export interface OpenAction {
  kind: 'open';
  leader: Address;
  leaderPositionId: string;
  key: string;
  instrumentId: number;
  market: string;
  isLong: boolean;
  marginRaw: bigint;
  leverage: number;
  notionalRaw: bigint;
  leaderMarginRaw: bigint;
  leaderLeverage: number;
  leaderEntryPriceRaw: bigint;
  markPriceRaw: bigint;
  /** Slippage of mark from the leader's entry, in parts per million of the entry price. */
  slippagePpm: bigint;
  /** Human-readable notes on every adjustment applied to the requested size. */
  adjustments: string[];
}

export interface CloseAction {
  kind: 'close';
  leader: Address;
  leaderPositionId: string;
  key: string;
  followerPositionIds: string[];
  reason: 'leader_closed' | 'kill_switch_flatten';
}

export interface SkipAction {
  kind: 'skip';
  on: 'open' | 'close';
  code: SkipCode;
  message: string;
  leader: Address;
  leaderPositionId: string;
  key: string;
}

/** The leader closed while our open is still in flight. Remember it and close once the open lands. */
export interface DeferAction {
  kind: 'defer_close';
  leader: Address;
  leaderPositionId: string;
  key: string;
  message: string;
}

export type Action = OpenAction | CloseAction | SkipAction | DeferAction;

export const mappingKey = (leader: Address | string, leaderPositionId: string | bigint) => `${leader.toLowerCase()}:${leaderPositionId}`;

const PPM = 1_000_000n;

const usd = (raw: bigint) => (Number(raw) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 });

function skip(on: 'open' | 'close', code: SkipCode, message: string, leader: Address, leaderPositionId: string): SkipAction {
  return { kind: 'skip', on, code, message, leader, leaderPositionId, key: mappingKey(leader, leaderPositionId) };
}

const isActive = (m: Mapping) => m.status === 'pending' || m.status === 'open' || m.status === 'closing';

/** Margin the follower account has committed: open positions plus opens still in flight. */
export function committedMargin(state: FollowerState): { marginRaw: bigint; positions: number } {
  let marginRaw = 0n;
  for (const p of state.positions) marginRaw += p.marginRaw;
  let positions = state.positions.length;
  for (const m of Object.values(state.mappings)) {
    if (m.status === 'pending') {
      marginRaw += m.marginRaw;
      positions += 1;
    }
  }
  return { marginRaw, positions };
}

function pendingReserved(state: FollowerState): bigint {
  let sum = 0n;
  for (const m of Object.values(state.mappings)) if (m.status === 'pending') sum += m.marginRaw;
  return sum;
}

function chooseLeverage(leader: ResolvedLeader, leaderLeverage: number, maxLeverage: number, inst: Instrument): { leverage: number; note?: string } | { reject: string } {
  let leverage: number;
  switch (leader.leverage.mode) {
    case 'copy':
      if (leaderLeverage > maxLeverage) return { reject: `leader uses ${leaderLeverage}x, above the ${maxLeverage}x guardrail (leverage mode "copy" never lowers it; use "cap" to allow these)` };
      leverage = leaderLeverage;
      break;
    case 'cap':
      leverage = Math.min(leaderLeverage, leader.leverage.max);
      break;
    case 'fixed':
      leverage = leader.leverage.value;
      break;
  }
  leverage = Math.min(leverage, maxLeverage);
  let note: string | undefined;
  if (leverage > inst.maxLeverage) {
    leverage = inst.maxLeverage;
    note = `leverage lowered to the ${inst.symbol} maximum of ${inst.maxLeverage}x`;
  }
  return { leverage, note };
}

function rawMargin(leader: ResolvedLeader, leaderMarginRaw: bigint, availableRaw: bigint): bigint {
  switch (leader.sizing.mode) {
    case 'fixed':
      return leader.sizing.marginRaw;
    case 'proportional':
      return (leaderMarginRaw * leader.sizing.multiplierPpm) / PPM;
    case 'percent':
      return (availableRaw * leader.sizing.percentPpm) / PPM;
  }
}

/**
 * Decide what to do about one leader event. Pure: the same inputs always give the same actions,
 * and nothing is read from the network, the clock or the disk.
 */
export function planEvent(event: LeaderEvent, follower: FollowerState, config: ResolvedConfig, market: MarketContext): Action[] {
  const leader = config.leaders.find((l) => l.address === event.leader.toLowerCase());
  if (!leader) return [];
  return event.type === 'open' ? planOpen(event, leader, follower, config, market) : planClose(event, follower);
}

function planOpen(event: Extract<LeaderEvent, { type: 'open' }>, leader: ResolvedLeader, follower: FollowerState, config: ResolvedConfig, market: MarketContext): Action[] {
  const { position } = event;
  const g = config.guardrails;
  const id = position.positionId.toString();
  const fail = (code: SkipCode, message: string) => [skip('open', code, message, leader.address, id)];

  const existing = follower.mappings[mappingKey(leader.address, id)];
  if (existing && existing.status !== 'failed') return fail('already_mirrored', `leader position ${id} is already ${existing.status} on the follower account`);

  if (event.baseline && !config.copyExisting) {
    return fail('preexisting_position', `leader position ${id} was already open when following started (set copyExisting to mirror those)`);
  }
  const ageMs = market.nowMs - position.openedAtMs;
  if (!event.baseline && ageMs > g.maxLeaderAgeMs) {
    return fail('stale_leader_position', `leader opened ${Math.round(ageMs / 1000)}s ago, older than the ${g.maxLeaderAgeSeconds}s limit`);
  }
  if (market.killSwitch) return fail('kill_switch', `kill switch file ${g.killSwitchFile} exists`);
  if (follower.realizedTodayRaw <= -g.dailyLossLimitRaw) {
    return fail('daily_loss_limit', `realized loss today ($${usd(-follower.realizedTodayRaw)}) reached the $${g.dailyLossLimitUsd} daily limit`);
  }

  const inst = market.trading.instruments.find((i) => i.id === position.instrumentId);
  if (!inst) return fail('market_unavailable', `instrument ${position.instrumentId} is not listed`);
  if (!g.instrumentIds.includes(inst.id)) return fail('market_not_allowed', `${inst.symbol} is not in the markets allowlist (${g.markets.join(', ')})`);
  if (market.trading.tradingPaused) return fail('market_unavailable', 'trading is paused protocol-wide');
  if (!inst.openable || inst.closeOnly) return fail('market_unavailable', `${inst.symbol} is not accepting new positions`);
  if (!market.trading.intake.actions.openPosition) return fail('market_unavailable', 'the relayer is not accepting new positions right now');

  const lastOpen = follower.lastOpenAtMs[String(inst.id)];
  if (lastOpen !== undefined && market.nowMs - lastOpen < g.cooldownMs) {
    return fail('cooldown', `${Math.ceil((g.cooldownMs - (market.nowMs - lastOpen)) / 1000)}s left of the ${g.cooldownSeconds}s ${inst.symbol} cooldown`);
  }

  const committed = committedMargin(follower);
  if (committed.positions >= g.maxOpenPositions) {
    return fail('max_open_positions', `${committed.positions} positions open or pending, limit is ${g.maxOpenPositions}`);
  }

  const lev = chooseLeverage(leader, position.leverage, g.maxLeverage, inst);
  if ('reject' in lev) return fail('leverage_above_guardrail', lev.reject);

  const mark = market.marksRaw[inst.id];
  if (mark === undefined || mark <= 0n) return fail('no_mark_price', `no current ${inst.symbol} mark price to check slippage against`);
  const entry = position.entryPriceRaw;
  const diff = mark > entry ? mark - entry : entry - mark;
  const slippagePpm = (diff * PPM) / entry;
  if (slippagePpm > g.maxSlippagePpm) {
    return fail(
      'slippage',
      `${inst.symbol} mark ${priceText(mark, inst)} is ${(Number(slippagePpm) / 10_000).toFixed(3)}% from the leader's entry ${priceText(entry, inst)}, above the ${g.maxSlippagePct}% limit`,
    );
  }

  const adjustments: string[] = [];
  if (lev.note) adjustments.push(lev.note);
  const spendable = follower.availableRaw - pendingReserved(follower);
  const minMargin = market.trading.minimumTradeSizeRaw;

  let margin = rawMargin(leader, position.marginRaw, spendable < 0n ? 0n : spendable);
  const requested = margin;
  let binding: SkipCode = 'margin_below_minimum';
  if (margin > g.maxMarginPerTradeRaw) {
    margin = g.maxMarginPerTradeRaw;
    adjustments.push(`margin reduced from $${usd(requested)} to the $${g.maxMarginPerTradeUsd} per-trade limit`);
  }
  const headroom = g.maxTotalOpenMarginRaw - committed.marginRaw;
  if (margin > headroom) {
    adjustments.push(`margin reduced to $${usd(headroom > 0n ? headroom : 0n)} of remaining total-margin headroom`);
    margin = headroom > 0n ? headroom : 0n;
    binding = 'no_margin_headroom';
  }
  if (margin > spendable) {
    adjustments.push(`margin reduced to the $${usd(spendable > 0n ? spendable : 0n)} of free balance`);
    margin = spendable > 0n ? spendable : 0n;
    binding = 'insufficient_balance';
  }
  if (margin < minMargin) {
    const why =
      binding === 'no_margin_headroom'
        ? `only $${usd(margin)} of total-margin headroom is left (the guardrail is $${g.maxTotalOpenMarginUsd}), below the $${usd(minMargin)} minimum margin`
        : binding === 'insufficient_balance'
          ? `only $${usd(margin)} is free to trade, below the $${usd(minMargin)} minimum margin`
          : `sized margin $${usd(requested)} is below the $${usd(minMargin)} minimum margin`;
    return fail(binding, why);
  }

  const notional = margin * BigInt(lev.leverage);
  if (notional < market.trading.minimumOpenNotionalRaw) {
    const needed = (market.trading.minimumOpenNotionalRaw + BigInt(lev.leverage) - 1n) / BigInt(lev.leverage);
    return fail(
      'notional_below_minimum',
      `$${usd(margin)} at ${lev.leverage}x is $${usd(notional)} notional, below the $${usd(market.trading.minimumOpenNotionalRaw)} minimum (needs at least $${usd(needed)} margin at ${lev.leverage}x)`,
    );
  }
  if (notional > inst.maxPositionNotionalRaw) {
    return fail('notional_above_maximum', `$${usd(notional)} notional is above the $${usd(inst.maxPositionNotionalRaw)} per-position maximum`);
  }
  const sideOi = position.isLong ? inst.longOiRaw : inst.shortOiRaw;
  const sideCap = position.isLong ? inst.longCapRaw : inst.shortCapRaw;
  // OI and caps are base-asset quantities, so the notional is converted at the mark.
  if (sideOi + notionalToQuantityRaw(notional, mark, inst.priceScale) > sideCap) {
    return fail('open_interest_cap', `${inst.symbol} ${position.isLong ? 'long' : 'short'} open interest cap would be exceeded`);
  }

  return [
    {
      kind: 'open',
      leader: leader.address,
      leaderPositionId: id,
      key: mappingKey(leader.address, id),
      instrumentId: inst.id,
      market: inst.symbol,
      isLong: position.isLong,
      marginRaw: margin,
      leverage: lev.leverage,
      notionalRaw: notional,
      leaderMarginRaw: position.marginRaw,
      leaderLeverage: position.leverage,
      leaderEntryPriceRaw: entry,
      markPriceRaw: mark,
      slippagePpm,
      adjustments,
    },
  ];
}

function priceText(raw: bigint, inst: Pick<Instrument, 'priceScale'>): string {
  return `$${(Number(raw) / Number(inst.priceScale)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function planClose(event: Extract<LeaderEvent, { type: 'close' }>, follower: FollowerState): Action[] {
  const key = mappingKey(event.leader, event.positionId);
  const mapping = follower.mappings[key];
  const fail = (code: SkipCode, message: string) => [skip('close', code, message, event.leader, event.positionId)];
  if (!mapping || mapping.status === 'failed' || mapping.status === 'closed') {
    return fail('no_mirrored_position', `leader closed ${event.positionId}, which was never mirrored`);
  }
  if (mapping.status === 'closing') return fail('already_closing', `follower position ${mapping.followerPositionId} is already closing`);
  if (mapping.status === 'pending' || mapping.followerPositionId === null) {
    return [
      {
        kind: 'defer_close',
        leader: event.leader,
        leaderPositionId: event.positionId,
        key,
        message: `leader closed ${event.positionId} while our open is still in flight; closing as soon as it lands`,
      },
    ];
  }
  return [
    { kind: 'close', leader: event.leader, leaderPositionId: event.positionId, key, followerPositionIds: [mapping.followerPositionId], reason: 'leader_closed' },
  ];
}

/**
 * Closes that are due without a new leader event: mirrored opens that landed after their leader already
 * closed, and every mirrored position when the kill switch is up with flattenOnKill.
 */
export function planDue(follower: FollowerState, config: ResolvedConfig, market: MarketContext): Action[] {
  const out: Action[] = [];
  for (const m of Object.values(follower.mappings)) {
    if (m.status !== 'open' || m.followerPositionId === null) continue;
    if (m.leaderClosed) {
      out.push({ kind: 'close', leader: m.leader, leaderPositionId: m.leaderPositionId, key: m.key, followerPositionIds: [m.followerPositionId], reason: 'leader_closed' });
    } else if (market.killSwitch && config.flattenOnKill) {
      out.push({ kind: 'close', leader: m.leader, leaderPositionId: m.leaderPositionId, key: m.key, followerPositionIds: [m.followerPositionId], reason: 'kill_switch_flatten' });
    }
  }
  return out;
}

/**
 * Compare a leader's current positions with the ids seen last time and produce open and close events.
 * `known` is null the first time a leader is ever observed: everything is then a baseline position.
 */
export function diffLeader(
  leader: Address,
  known: readonly string[] | null,
  positions: readonly OpenPosition[],
): { events: LeaderEvent[]; known: string[] } {
  const current = new Set(positions.map((p) => p.positionId.toString()));
  const events: LeaderEvent[] = [];
  const previous = new Set(known ?? []);
  const ordered = [...positions].sort((a, b) => (a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0));
  for (const p of ordered) {
    if (!previous.has(p.positionId.toString())) events.push({ type: 'open', leader, position: p, baseline: known === null });
  }
  for (const id of previous) if (!current.has(id)) events.push({ type: 'close', leader, positionId: id });
  return { events, known: [...current] };
}

/** The slice of a follower wallet update the reconciler reads. */
export interface FollowerUpdate {
  positions: Array<{ positionId: bigint; intentId: Hex | null; marginRaw: bigint; instrumentId: number }>;
  operations: Array<{ intentId: Hex }>;
  intentOutcomes: Array<{ intentId: Hex; outcome: string }>;
  /** Positions the account closed in this patch only (never a repeated list), for the realized-loss tally. */
  closed: Array<{ positionId: bigint; netPnlRaw: bigint }>;
}

export const PENDING_TIMEOUT_MS = 90_000;

export interface ReconcileNote {
  key: string;
  event: 'landed' | 'open_failed' | 'closed' | 'close_failed';
  detail: string;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Start a new realized-loss day when the UTC date changed. */
export function rollDay(state: FollowerState, nowMs: number): FollowerState {
  const day = utcDay(nowMs);
  return day === state.dayKey ? state : { ...state, dayKey: day, realizedTodayRaw: 0n };
}

/**
 * Fold a follower wallet update into the mappings: pending opens become open when their position
 * appears (matched by intent id), failed intents are marked failed, vanished positions are closed,
 * and realized PnL is added to today's tally.
 */
export function reconcile(state: FollowerState, update: FollowerUpdate, nowMs: number): { state: FollowerState; notes: ReconcileNote[] } {
  const notes: ReconcileNote[] = [];
  let next = rollDay(state, nowMs);
  const byIntent = new Map<string, FollowerUpdate['positions'][number]>();
  const live = new Set<string>();
  for (const p of update.positions) {
    live.add(p.positionId.toString());
    if (p.intentId) byIntent.set(p.intentId.toLowerCase(), p);
  }
  const outcomes = new Map(update.intentOutcomes.map((o) => [o.intentId.toLowerCase(), o.outcome]));
  const queued = new Set(update.operations.map((o) => o.intentId.toLowerCase()));

  const mappings: Record<string, Mapping> = {};
  for (const [key, m] of Object.entries(next.mappings)) {
    let cur = m;
    if (cur.status === 'pending' && cur.intentId) {
      const intent = cur.intentId.toLowerCase();
      const landed = byIntent.get(intent);
      const outcome = outcomes.get(intent);
      if (landed) {
        cur = { ...cur, status: 'open', followerPositionId: landed.positionId.toString(), marginRaw: landed.marginRaw, updatedAtMs: nowMs };
        notes.push({ key, event: 'landed', detail: `follower position ${cur.followerPositionId} opened` });
      } else if (outcome && outcome !== 'succeeded') {
        cur = { ...cur, status: 'failed', updatedAtMs: nowMs, note: `intent ${outcome}` };
        notes.push({ key, event: 'open_failed', detail: `intent ${outcome}` });
      } else if (nowMs - cur.updatedAtMs > PENDING_TIMEOUT_MS && !queued.has(intent)) {
        cur = { ...cur, status: 'failed', updatedAtMs: nowMs, note: 'the intent never appeared on the account' };
        notes.push({ key, event: 'open_failed', detail: 'the intent never appeared on the account' });
      }
    } else if ((cur.status === 'open' || cur.status === 'closing') && cur.followerPositionId && !cur.followerPositionId.startsWith('sim-')) {
      if (!live.has(cur.followerPositionId)) {
        cur = { ...cur, status: 'closed', updatedAtMs: nowMs };
        notes.push({ key, event: 'closed', detail: `follower position ${cur.followerPositionId} is gone` });
      } else if (cur.status === 'closing') {
        const closeOutcome = cur.closeIntentId ? outcomes.get(cur.closeIntentId.toLowerCase()) : undefined;
        const stuck = nowMs - cur.updatedAtMs > PENDING_TIMEOUT_MS && !(cur.closeIntentId && queued.has(cur.closeIntentId.toLowerCase()));
        if ((closeOutcome && closeOutcome !== 'succeeded') || stuck) {
          cur = { ...cur, status: 'open', updatedAtMs: nowMs, note: 'the close did not land; it will be retried' };
          notes.push({ key, event: 'close_failed', detail: 'the close did not land; retrying' });
        }
      }
    }
    mappings[key] = cur;
  }
  next = { ...next, mappings };
  for (const c of update.closed) next = { ...next, realizedTodayRaw: next.realizedTodayRaw + c.netPnlRaw };
  return { state: next, notes };
}

export function emptyFollowerState(nowMs: number): FollowerState {
  return { availableRaw: 0n, positions: [], mappings: {}, dayKey: utcDay(nowMs), realizedTodayRaw: 0n, lastOpenAtMs: {} };
}

/** Record that an open was signed and sent (or simulated). */
export function applyOpen(state: FollowerState, action: OpenAction, intentId: Hex | null, nowMs: number, followerPositionId: string | null = null): FollowerState {
  const mapping: Mapping = {
    key: action.key,
    leader: action.leader,
    leaderPositionId: action.leaderPositionId,
    status: followerPositionId ? 'open' : 'pending',
    instrumentId: action.instrumentId,
    isLong: action.isLong,
    marginRaw: action.marginRaw,
    leverage: action.leverage,
    intentId,
    followerPositionId,
    closeIntentId: null,
    leaderClosed: false,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    note: null,
  };
  return {
    ...state,
    mappings: { ...state.mappings, [action.key]: mapping },
    lastOpenAtMs: { ...state.lastOpenAtMs, [String(action.instrumentId)]: nowMs },
  };
}

export function applyOpenFailed(state: FollowerState, key: string, note: string, nowMs: number): FollowerState {
  const m = state.mappings[key];
  if (!m) return state;
  return { ...state, mappings: { ...state.mappings, [key]: { ...m, status: 'failed', note, updatedAtMs: nowMs } } };
}

export function applyLeaderClosed(state: FollowerState, key: string, nowMs: number): FollowerState {
  const m = state.mappings[key];
  if (!m) return state;
  return { ...state, mappings: { ...state.mappings, [key]: { ...m, leaderClosed: true, updatedAtMs: nowMs } } };
}

export function applyCloseSubmitted(state: FollowerState, key: string, closeIntentId: Hex | null, nowMs: number): FollowerState {
  const m = state.mappings[key];
  if (!m) return state;
  return { ...state, mappings: { ...state.mappings, [key]: { ...m, status: 'closing', closeIntentId, updatedAtMs: nowMs } } };
}

export function applyCloseFailed(state: FollowerState, key: string, note: string, nowMs: number): FollowerState {
  const m = state.mappings[key];
  if (!m) return state;
  return { ...state, mappings: { ...state.mappings, [key]: { ...m, status: 'open', note, updatedAtMs: nowMs } } };
}

/** A simulated position closed in dry-run: remove it and book its estimated PnL. */
export function applySimulatedClose(state: FollowerState, key: string, netPnlRaw: bigint, nowMs: number): FollowerState {
  const m = state.mappings[key];
  if (!m) return state;
  return {
    ...state,
    mappings: { ...state.mappings, [key]: { ...m, status: 'closed', updatedAtMs: nowMs } },
    realizedTodayRaw: state.realizedTodayRaw + netPnlRaw,
  };
}
