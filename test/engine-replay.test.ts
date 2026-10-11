import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionKey, PapertradeTrader, type PapertradeClient, type WalletState } from 'papertrade-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CopyEngine } from '../src/engine.js';
import { createLogger } from '../src/log.js';
import { emptyPersistedState, StateNonceStorage, StateStore, type PersistedState } from '../src/state-store.js';
import { ACCOUNT, config, LEADER, loadRecording, loadTrading, usd, type ConfigOverrides } from './helpers.js';

const trading = loadTrading();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copytrade-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Harness {
  engine: CopyEngine;
  state: PersistedState;
  logs: Array<Record<string, unknown>>;
  feed(state: WalletState, kind: 'snapshot' | 'update', t: number): Promise<void>;
}

function harness(opts: { state?: PersistedState; overrides?: ConfigOverrides; leader?: string }): Harness {
  const logs: Array<Record<string, unknown>> = [];
  const log = createLogger({ json: true, level: 'debug', write: (line) => logs.push(JSON.parse(line)) });
  const state = opts.state ?? emptyPersistedState('dry-run', ACCOUNT, 0);
  const store = new StateStore(join(dir, 'state.json'));
  const client = { http: { baseUrl: 'https://exchange.papertrade.xyz' }, tradingState: async () => trading } as unknown as PapertradeClient;
  const trader = new PapertradeTrader({ user: ACCOUNT, client, session: createSessionKey(), nonceStorage: new StateNonceStorage(state.nonces, () => undefined) });
  let clock = 0;
  let handler: ((ws: WalletState, kind: 'snapshot' | 'update') => void) | undefined;
  const leader = (opts.leader ?? LEADER) as typeof LEADER;
  const engine = new CopyEngine({
    config: config({ leaders: [leader], sizing: { mode: 'fixed', marginUsd: 250 }, guardrails: { maxOpenPositions: 100, maxTotalOpenMarginUsd: 20_000, maxMarginPerTradeUsd: 300, maxSlippagePct: 5 }, ...opts.overrides }),
    mode: 'dry-run',
    client,
    trader,
    store,
    state,
    log,
    assumeBalanceRaw: usd(50_000),
    now: () => clock,
    fetchMark: async (id) => (id === 0 ? 830_000n : 1_000_000n),
    killSwitchExists: () => false,
    tickSeconds: 3600,
    stream: (o) => {
      handler = o.onState;
      return () => undefined;
    },
  });
  return {
    engine,
    state,
    logs,
    async feed(ws, kind, t) {
      clock = t;
      handler?.(ws, kind);
      await engine.idle();
    },
  };
}

const count = (logs: Array<Record<string, unknown>>, event: string) => logs.filter((l) => l.event === event).length;

describe('engine replay of a recorded live leader stream', () => {
  const recording = loadRecording('leader-44fb-btc-pairs.jsonl');

  it('mirrors every leader open and closes exactly the matching position', async () => {
    const h = harness({ overrides: { copyExisting: true } });
    await h.engine.start();
    const markOf = (ws: WalletState) => ws.positions[0]?.entryPriceRaw;
    expect(markOf(recording[0].state)).toBeGreaterThan(0n);
    for (const r of recording) await h.feed(r.state, r.kind, r.state.positions[0]?.openedAtMs ?? r.t);
    await h.engine.stop();

    const leaderOpens = new Set(recording.flatMap((r) => r.state.positions.map((p) => p.positionId.toString())));
    const simulatedOpens = h.logs.filter((l) => l.event === 'simulated_open');
    const simulatedCloses = h.logs.filter((l) => l.event === 'simulated_close');
    expect(simulatedOpens.length).toBeGreaterThan(0);
    expect(simulatedOpens.length).toBeLessThanOrEqual(leaderOpens.size);
    expect(count(h.logs, 'would_sign')).toBe(simulatedOpens.length + simulatedCloses.length);

    // Every simulated close names a follower position that an earlier simulated open created.
    const created = new Map(simulatedOpens.map((o) => [String(o.leaderPositionId), String(o.followerPositionId)]));
    for (const c of simulatedCloses) {
      expect(created.get(String(c.leaderPositionId))).toBe((c.followerPositionIds as string[])[0]);
    }
    // Positions still open on the leader at the end are exactly those still open on the follower.
    const last = recording[recording.length - 1].state;
    const stillOpenOnLeader = new Set(last.positions.map((p) => p.positionId.toString()));
    const stillOpenOnFollower = new Set(h.state.sim.map((s) => [...created.entries()].find(([, f]) => f === s.positionId)![0]));
    expect([...stillOpenOnFollower].every((id) => stillOpenOnLeader.has(id))).toBe(true);
    expect(h.state.sim.length + simulatedCloses.length).toBe(simulatedOpens.length);
  });

  it('never submits anything in dry run and the signed intents use the throwaway session key', async () => {
    const h = harness({ overrides: { copyExisting: true } });
    await h.engine.start();
    await h.feed(recording[0].state, 'snapshot', recording[0].state.positions[0].openedAtMs);
    await h.engine.stop();
    const signed = h.logs.filter((l) => l.event === 'would_sign');
    expect(signed.length).toBeGreaterThan(0);
    for (const s of signed) {
      const intent = s.intent as { signedBy: string; message: Record<string, unknown> };
      expect(intent.signedBy).not.toBe(ACCOUNT);
      expect(intent.message.user).toBe(ACCOUNT);
    }
    expect(h.logs.some((l) => l.event === 'submitted_open' || l.event === 'sign_open')).toBe(false);
  });

  it('ignores positions that already existed when following started', async () => {
    const h = harness({});
    await h.engine.start();
    await h.feed(recording[0].state, 'snapshot', recording[0].state.positions[0].openedAtMs);
    expect(count(h.logs, 'simulated_open')).toBe(0);
    await h.engine.stop();
  });

  it('survives a restart: no duplicate opens, and a close that happened while down is still mirrored', async () => {
    const first = harness({ overrides: { copyExisting: true } });
    await first.engine.start();
    const mid = Math.floor(recording.length / 2);
    for (const r of recording.slice(0, mid)) await first.feed(r.state, r.kind, r.state.positions[0]?.openedAtMs ?? r.t);
    await first.engine.stop();
    const store = new StateStore(join(dir, 'state.json'));
    const persisted = store.load()!;
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(persisted.sim.length).toBe(first.state.sim.length);

    const second = harness({ state: persisted, overrides: { copyExisting: true } });
    await second.engine.start();
    // The recorder stream restarts with a fresh snapshot of whatever the leader holds now.
    const rest = recording.slice(mid);
    const snapshotNow = { ...rest[rest.length - 1].state };
    await second.feed(snapshotNow, 'snapshot', snapshotNow.positions[0]?.openedAtMs ?? 0);
    await second.engine.stop();

    const reopened = second.logs.filter((l) => l.event === 'simulated_open').map((l) => String(l.leaderPositionId));
    const already = new Set(Object.values(persisted.follower.mappings).map((m) => m.leaderPositionId));
    expect(reopened.filter((id) => already.has(id))).toEqual([]);
    const leaderNow = new Set(snapshotNow.positions.map((p) => p.positionId.toString()));
    for (const m of Object.values(persisted.follower.mappings)) {
      if (m.status === 'open' && !leaderNow.has(m.leaderPositionId)) {
        expect(second.state.follower.mappings[m.key].status).toBe('closed');
      }
    }
  });
});

describe('engine replay of a busy 18-position leader', () => {
  const recording = loadRecording('leader-4e76-active.jsonl');

  it('respects max open positions and total margin while following a flood of opens', async () => {
    const h = harness({
      leader: '0x4e76d59aa67230b12315251c9f453d4f7450142e',
      overrides: { guardrails: { maxOpenPositions: 4, maxTotalOpenMarginUsd: 800, maxMarginPerTradeUsd: 300 }, copyExisting: true },
    });
    await h.engine.start();
    let peakPositions = 0;
    let peakMargin = 0n;
    for (const r of recording) {
      await h.feed(r.state, r.kind, r.state.positions[0]?.openedAtMs ?? r.t);
      peakPositions = Math.max(peakPositions, h.state.sim.length);
      peakMargin = peakMargin > h.state.sim.reduce((s, p) => s + p.marginRaw, 0n) ? peakMargin : h.state.sim.reduce((s, p) => s + p.marginRaw, 0n);
    }
    await h.engine.stop();
    expect(peakPositions).toBeGreaterThan(0);
    expect(peakPositions).toBeLessThanOrEqual(4);
    expect(peakMargin).toBeLessThanOrEqual(usd(800));
    const limited = ['max_open_positions', 'no_margin_headroom', 'margin_below_minimum', 'notional_below_minimum'];
    expect(h.logs.filter((l) => l.event === 'skip' && limited.includes(String(l.code))).length).toBeGreaterThan(0);
  });
});
