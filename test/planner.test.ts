import type { OpenPosition } from 'papertrade-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyLeaderClosed,
  applyOpen,
  diffLeader,
  mappingKey,
  planDue,
  planEvent,
  reconcile,
  type Action,
  type FollowerState,
  type LeaderEvent,
  type OpenAction,
} from '../src/planner.js';
import { ACCOUNT, config, follower, LEADER, loadRecording, loadTrading, market, usd } from './helpers.js';

const trading = loadTrading();
const BTC = trading.instruments.find((i) => i.id === 0)!;
let realPosition: OpenPosition;
let now: number;

beforeAll(() => {
  const recording = loadRecording('leader-44fb-btc-pairs.jsonl');
  realPosition = recording[0].state.positions[0];
  now = realPosition.openedAtMs + 5_000;
});

const openEvent = (overrides: Partial<OpenPosition> = {}, baseline = false): LeaderEvent => ({
  type: 'open',
  leader: LEADER,
  position: { ...realPosition, ...overrides },
  baseline,
});
const mark = () => ({ 0: realPosition.entryPriceRaw });
const plan = (event: LeaderEvent, state: FollowerState, cfg = config(), marks: Record<number, bigint> = mark(), t = now) => planEvent(event, state, cfg, market(trading, marks, t));
const only = (actions: Action[]) => {
  expect(actions).toHaveLength(1);
  return actions[0];
};
const expectSkip = (actions: Action[], code: string) => {
  const a = only(actions);
  expect(a.kind).toBe('skip');
  expect(a.kind === 'skip' && a.code).toBe(code);
};
const expectOpen = (actions: Action[]): OpenAction => {
  const a = only(actions);
  expect(a.kind).toBe('open');
  return a as OpenAction;
};

describe('the recorded leader position', () => {
  it('is a real 750x BTC position', () => {
    expect(realPosition.instrumentId).toBe(0);
    expect(realPosition.leverage).toBeGreaterThan(1);
    expect(realPosition.marginRaw).toBeGreaterThan(0n);
  });
});

describe('sizing modes', () => {
  it('fixed margin ignores the leader size', () => {
    const open = expectOpen(plan(openEvent(), follower(5000, now), config({ sizing: { mode: 'fixed', marginUsd: 200 } })));
    expect(open.marginRaw).toBe(usd(200));
    expect(open.leverage).toBe(50);
    expect(open.notionalRaw).toBe(usd(10_000));
  });

  it('proportional scales the leader margin by the multiplier', () => {
    const cfg = config({ sizing: { mode: 'proportional', multiplier: 4 }, guardrails: { maxMarginPerTradeUsd: 1000, maxTotalOpenMarginUsd: 2000 } });
    const open = expectOpen(plan(openEvent({ marginRaw: usd(50) }), follower(5000, now), cfg));
    expect(open.marginRaw).toBe(usd(200));
  });

  it('proportional rounds nothing away on fractional multipliers', () => {
    const cfg = config({ sizing: { mode: 'proportional', multiplier: 0.5 }, guardrails: { maxMarginPerTradeUsd: 1000, maxTotalOpenMarginUsd: 2000 } });
    const open = expectOpen(plan(openEvent({ marginRaw: usd(500) }), follower(5000, now), cfg));
    expect(open.marginRaw).toBe(usd(250));
  });

  it('percent uses a share of the free balance', () => {
    const cfg = config({ sizing: { mode: 'percent', percent: 5 } });
    const open = expectOpen(plan(openEvent(), follower(4000, now), cfg));
    expect(open.marginRaw).toBe(usd(200));
  });

  it('percent follows the balance as it shrinks', () => {
    const cfg = config({ sizing: { mode: 'percent', percent: 5 } });
    const open = expectOpen(plan(openEvent(), follower(6000, now), cfg));
    expect(open.marginRaw).toBe(usd(300));
  });

  it('applies a per-leader sizing override', () => {
    const cfg = config({ leaders: [{ address: LEADER, sizing: { mode: 'fixed', marginUsd: 220 } }] });
    expect(expectOpen(plan(openEvent(), follower(5000, now), cfg)).marginRaw).toBe(usd(220));
  });
});

describe('leverage', () => {
  it('copy mirrors the leader leverage when it is within the guardrail', () => {
    const cfg = config({ leverage: { mode: 'copy' }, guardrails: { maxLeverage: 100 }, sizing: { mode: 'fixed', marginUsd: 200 } });
    expect(expectOpen(plan(openEvent({ leverage: 80 }), follower(5000, now), cfg)).leverage).toBe(80);
  });

  it('copy refuses a leader above the guardrail instead of silently lowering it', () => {
    const cfg = config({ leverage: { mode: 'copy' } });
    expectSkip(plan(openEvent({ leverage: 750 }), follower(5000, now), cfg), 'leverage_above_guardrail');
  });

  it('cap lowers the leader leverage', () => {
    expect(expectOpen(plan(openEvent({ leverage: 750 }), follower(5000, now))).leverage).toBe(50);
  });

  it('cap keeps a lower leader leverage', () => {
    const cfg = config({ sizing: { mode: 'fixed', marginUsd: 300 } });
    expect(expectOpen(plan(openEvent({ leverage: 40 }), follower(5000, now), cfg)).leverage).toBe(40);
  });

  it('fixed ignores the leader leverage', () => {
    const cfg = config({ leverage: { mode: 'fixed', value: 25 }, sizing: { mode: 'fixed', marginUsd: 400 }, guardrails: { maxMarginPerTradeUsd: 500, maxTotalOpenMarginUsd: 1000 } });
    expect(expectOpen(plan(openEvent({ leverage: 750 }), follower(5000, now), cfg)).leverage).toBe(25);
  });
});

describe('protocol minimums', () => {
  it('skips when sized margin is below the protocol minimum margin', () => {
    const cfg = config({ sizing: { mode: 'proportional', multiplier: 0.01 } });
    expectSkip(plan(openEvent({ marginRaw: usd(50) }), follower(5000, now), cfg), 'margin_below_minimum');
  });

  it('skips when margin x leverage is below the minimum notional', () => {
    const cfg = config({ sizing: { mode: 'fixed', marginUsd: 100 } });
    const a = only(plan(openEvent(), follower(5000, now), cfg));
    expect(a.kind === 'skip' && a.code).toBe('notional_below_minimum');
    expect(a.kind === 'skip' && a.message).toContain('needs at least $200');
  });

  it('opens exactly at the minimum notional', () => {
    const cfg = config({ sizing: { mode: 'fixed', marginUsd: 200 } });
    expect(expectOpen(plan(openEvent(), follower(5000, now), cfg)).notionalRaw).toBe(trading.minimumOpenNotionalRaw);
  });

  it('skips above the instrument maximum position notional', () => {
    const huge = { ...trading, instruments: trading.instruments.map((i) => (i.id === 0 ? { ...i, maxPositionNotionalRaw: usd(5_000) } : i)) };
    expectSkip(planEvent(openEvent(), follower(5000, now), config(), market(huge, mark(), now)), 'notional_above_maximum');
  });

  it('skips a market that is not openable', () => {
    const closed = { ...trading, instruments: trading.instruments.map((i) => (i.id === 0 ? { ...i, openable: false } : i)) };
    expectSkip(planEvent(openEvent(), follower(5000, now), config(), market(closed, mark(), now)), 'market_unavailable');
  });

  it('skips while trading is paused', () => {
    expectSkip(planEvent(openEvent(), follower(5000, now), config(), market({ ...trading, tradingPaused: true }, mark(), now)), 'market_unavailable');
  });

  it('skips when the open interest cap would be exceeded', () => {
    const capped = { ...trading, instruments: trading.instruments.map((i) => (i.id === 0 ? { ...i, longCapRaw: i.longOiRaw } : i)) };
    const event = openEvent({ isLong: true });
    expectSkip(planEvent(event, follower(5000, now), config(), market(capped, mark(), now)), 'open_interest_cap');
  });
});

describe('guardrails', () => {
  it('clamps margin to the per-trade limit and says so', () => {
    const cfg = config({ sizing: { mode: 'fixed', marginUsd: 900 }, guardrails: { maxMarginPerTradeUsd: 300, maxTotalOpenMarginUsd: 5000 } });
    const open = expectOpen(plan(openEvent(), follower(5000, now), cfg));
    expect(open.marginRaw).toBe(usd(300));
    expect(open.adjustments.join(' ')).toContain('per-trade limit');
  });

  it('clamps margin to the total open margin headroom', () => {
    const state = follower(5000, now);
    state.positions = [{ positionId: '1', instrumentId: 0, marginRaw: usd(750) }];
    const open = expectOpen(plan(openEvent(), state, config({ guardrails: { maxTotalOpenMarginUsd: 1000 } })));
    expect(open.marginRaw).toBe(usd(250));
  });

  it('skips when the headroom is below the minimum margin', () => {
    const state = follower(5000, now);
    state.positions = [{ positionId: '1', instrumentId: 0, marginRaw: usd(995) }];
    expectSkip(plan(openEvent(), state, config({ guardrails: { maxTotalOpenMarginUsd: 1000 } })), 'no_margin_headroom');
  });

  it('clamps to free balance and skips when the balance is below the minimum', () => {
    expect(expectOpen(plan(openEvent(), follower(220, now))).marginRaw).toBe(usd(220));
    expectSkip(plan(openEvent(), follower(8, now)), 'insufficient_balance');
  });

  it('counts opens still in flight against positions, margin and balance', () => {
    let state = follower(5000, now);
    const first = expectOpen(plan(openEvent({ positionId: 1n }), state));
    state = applyOpen(state, first, null, now);
    const second = expectOpen(plan(openEvent({ positionId: 2n }), state));
    state = applyOpen(state, second, null, now);
    const wide = config({ guardrails: { maxTotalOpenMarginUsd: 1000, maxOpenPositions: 5 } });
    const third = expectOpen(plan(openEvent({ positionId: 3n }), state, wide));
    state = applyOpen(state, third, null, now);
    const fourth = expectOpen(plan(openEvent({ positionId: 4n }), state, wide));
    expect(fourth.marginRaw).toBe(usd(250));
    state = applyOpen(state, fourth, null, now);
    expectSkip(plan(openEvent({ positionId: 5n }), state, wide), 'no_margin_headroom');
    expectSkip(plan(openEvent({ positionId: 6n }), state, config()), 'max_open_positions');
  });

  it('stops at the max open positions', () => {
    const state = follower(5000, now);
    state.positions = [1, 2, 3].map((i) => ({ positionId: String(i), instrumentId: 0, marginRaw: usd(10) }));
    expectSkip(plan(openEvent(), state), 'max_open_positions');
  });

  it('allows only allowlisted markets', () => {
    expectSkip(plan(openEvent(), follower(5000, now), config({ guardrails: { markets: ['ETH'] } })), 'market_not_allowed');
  });

  it('enforces the cooldown per market', () => {
    const state = follower(5000, now);
    state.lastOpenAtMs = { '0': now - 2_000 };
    const cfg = config({ guardrails: { cooldownSeconds: 10 } });
    expectSkip(plan(openEvent(), state, cfg), 'cooldown');
    expectOpen(plan(openEvent(), state, cfg, mark(), now + 9_000));
    state.lastOpenAtMs = { '1': now - 2_000 };
    expectOpen(plan(openEvent(), state, cfg));
  });

  it('stops opening once the daily realized loss limit is reached', () => {
    const state = follower(5000, now);
    state.realizedTodayRaw = -usd(500);
    expectSkip(plan(openEvent(), state), 'daily_loss_limit');
    state.realizedTodayRaw = -usd(499);
    expectOpen(plan(openEvent(), state));
  });

  it('honors the kill switch', () => {
    expectSkip(planEvent(openEvent(), follower(5000, now), config(), market(trading, mark(), now, true)), 'kill_switch');
  });

  it('flattens mirrored positions on the kill switch only when asked to', () => {
    let state = follower(5000, now);
    const open = expectOpen(plan(openEvent(), state));
    state = applyOpen(state, open, null, now, '777');
    const killed = market(trading, mark(), now, true);
    expect(planDue(state, config(), killed)).toEqual([]);
    const due = planDue(state, config({ flattenOnKill: true }), killed);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: 'close', followerPositionIds: ['777'], reason: 'kill_switch_flatten' });
  });

  it('skips a copy when the mark moved more than the slippage limit', () => {
    const away = { 0: (realPosition.entryPriceRaw * 1_010n) / 1_000n };
    const a = only(plan(openEvent(), follower(5000, now), config(), away));
    expect(a.kind === 'skip' && a.code).toBe('slippage');
    expect(a.kind === 'skip' && a.message).toContain('above the 0.5% limit');
  });

  it('accepts slippage inside the limit and reports it', () => {
    const near = { 0: (realPosition.entryPriceRaw * 1_002n) / 1_000n };
    const open = expectOpen(plan(openEvent(), follower(5000, now), config(), near));
    expect(open.slippagePpm).toBeGreaterThan(1_000n);
    expect(open.slippagePpm).toBeLessThan(5_000n);
  });

  it('skips without a mark price instead of guessing', () => {
    expectSkip(plan(openEvent(), follower(5000, now), config(), {}), 'no_mark_price');
  });

  it('skips a leader open that is already stale', () => {
    expectSkip(plan(openEvent(), follower(5000, now), config(), mark(), realPosition.openedAtMs + 120_000), 'stale_leader_position');
  });

  it('skips positions that pre-date following unless copyExisting is on', () => {
    expectSkip(plan(openEvent({}, true), follower(5000, now)), 'preexisting_position');
    expectOpen(plan(openEvent({}, true), follower(5000, now), config({ copyExisting: true })));
  });

  it('never copies the same leader position twice', () => {
    let state = follower(5000, now);
    state = applyOpen(state, expectOpen(plan(openEvent(), state)), null, now);
    expectSkip(plan(openEvent(), state), 'already_mirrored');
  });
});

describe('close mapping', () => {
  const setup = () => {
    let state = follower(5000, now);
    const a = expectOpen(plan(openEvent({ positionId: 111n }), state));
    state = applyOpen(state, a, '0xaa' as `0x${string}`, now, '9001');
    const b = expectOpen(plan(openEvent({ positionId: 222n }), state));
    state = applyOpen(state, b, '0xbb' as `0x${string}`, now, '9002');
    return state;
  };

  it('closes exactly the follower position that mirrors the leader position', () => {
    const state = setup();
    const a = only(planEvent({ type: 'close', leader: LEADER, positionId: '222' }, state, config(), market(trading, mark(), now)));
    expect(a).toMatchObject({ kind: 'close', followerPositionIds: ['9002'], reason: 'leader_closed' });
  });

  it('ignores a close for a position that was never mirrored', () => {
    expectSkip(planEvent({ type: 'close', leader: LEADER, positionId: '5' }, setup(), config(), market(trading, mark(), now)), 'no_mirrored_position');
  });

  it('does not close twice', () => {
    let state = setup();
    state = { ...state, mappings: { ...state.mappings, [mappingKey(LEADER, '111')]: { ...state.mappings[mappingKey(LEADER, '111')], status: 'closing' } } };
    expectSkip(planEvent({ type: 'close', leader: LEADER, positionId: '111' }, state, config(), market(trading, mark(), now)), 'already_closing');
  });

  it('defers a close that arrives while the open is still in flight, then closes when it lands', () => {
    let state = follower(5000, now);
    const open = expectOpen(plan(openEvent({ positionId: 333n }), state));
    state = applyOpen(state, open, '0xcc' as `0x${string}`, now);
    const deferred = only(planEvent({ type: 'close', leader: LEADER, positionId: '333' }, state, config(), market(trading, mark(), now)));
    expect(deferred.kind).toBe('defer_close');
    state = applyLeaderClosed(state, deferred.key, now);
    expect(planDue(state, config(), market(trading, mark(), now))).toEqual([]);
    const landed = reconcile(
      state,
      { positions: [{ positionId: 4242n, intentId: '0xcc', marginRaw: usd(250), instrumentId: 0 }], operations: [], intentOutcomes: [], closed: [] },
      now + 3_000,
    );
    expect(landed.state.mappings[deferred.key].followerPositionId).toBe('4242');
    const due = planDue(landed.state, config(), market(trading, mark(), now + 3_000));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: 'close', followerPositionIds: ['4242'] });
  });
});

describe('reconcile', () => {
  it('links the follower position through the intent id and counts realized loss from closes', () => {
    let state = follower(5000, now);
    const open = expectOpen(plan(openEvent({ positionId: 5n }), state));
    state = applyOpen(state, open, '0xdd' as `0x${string}`, now);
    const landed = reconcile(state, { positions: [{ positionId: 88n, intentId: '0xdd', marginRaw: open.marginRaw, instrumentId: 0 }], operations: [], intentOutcomes: [], closed: [] }, now + 1000);
    expect(landed.state.mappings[open.key]).toMatchObject({ status: 'open', followerPositionId: '88' });
    const closed = reconcile(landed.state, { positions: [], operations: [], intentOutcomes: [], closed: [{ positionId: 88n, netPnlRaw: -usd(37.5) }] }, now + 2000);
    expect(closed.state.mappings[open.key].status).toBe('closed');
    expect(closed.state.realizedTodayRaw).toBe(-usd(37.5));
  });

  it('marks a rejected open as failed so the leader position can be retried', () => {
    let state = follower(5000, now);
    const open = expectOpen(plan(openEvent({ positionId: 6n }), state));
    state = applyOpen(state, open, '0xee' as `0x${string}`, now);
    const rejected = reconcile(state, { positions: [], operations: [], intentOutcomes: [{ intentId: '0xee', outcome: 'rejected' }], closed: [] }, now + 1000);
    expect(rejected.state.mappings[open.key].status).toBe('failed');
    expect(rejected.notes.map((n) => n.event)).toContain('open_failed');
  });

  it('gives up on an open that never lands', () => {
    let state = follower(5000, now);
    const open = expectOpen(plan(openEvent({ positionId: 7n }), state));
    state = applyOpen(state, open, '0xff' as `0x${string}`, now);
    const late = reconcile(state, { positions: [], operations: [], intentOutcomes: [], closed: [] }, now + 120_000);
    expect(late.state.mappings[open.key].status).toBe('failed');
  });

  it('rolls the realized loss over at the UTC day boundary', () => {
    const state = follower(5000, Date.UTC(2026, 9, 10, 23, 59));
    state.realizedTodayRaw = -usd(400);
    state.dayKey = '2026-10-10';
    const next = reconcile(state, { positions: [], operations: [], intentOutcomes: [], closed: [] }, Date.UTC(2026, 9, 11, 0, 1));
    expect(next.state.dayKey).toBe('2026-10-11');
    expect(next.state.realizedTodayRaw).toBe(0n);
  });
});

describe('restart recovery (diffLeader)', () => {
  const p = (id: bigint): OpenPosition => ({ ...realPosition, positionId: id });

  it('treats everything as baseline the first time a leader is seen', () => {
    const { events, known } = diffLeader(LEADER, null, [p(1n), p(2n)]);
    expect(events.every((e) => e.type === 'open' && e.baseline)).toBe(true);
    expect(known.sort()).toEqual(['1', '2']);
  });

  it('after a restart only opens made while the process was down are new, and closes are noticed', () => {
    const { events } = diffLeader(LEADER, ['1', '2'], [p(2n), p(3n)]);
    expect(events).toEqual([
      { type: 'open', leader: LEADER, position: p(3n), baseline: false },
      { type: 'close', leader: LEADER, positionId: '1' },
    ]);
  });

  it('emits nothing when nothing changed', () => {
    expect(diffLeader(LEADER, ['1'], [p(1n)]).events).toEqual([]);
  });
});

describe('account', () => {
  it('uses a lowercase follower account', () => {
    expect(config().account).toBe(ACCOUNT);
  });
});
