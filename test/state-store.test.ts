import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOpen, emptyFollowerState } from '../src/planner.js';
import { acquireLock, emptyPersistedState, parseState, serializeState, StateFileError, StateNonceStorage, StateStore } from '../src/state-store.js';
import { ACCOUNT, usd } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copytrade-state-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('state file', () => {
  it('round-trips bigints, mappings and simulated positions exactly', () => {
    const state = emptyPersistedState('dry-run', ACCOUNT, 1000);
    state.follower = {
      ...emptyFollowerState(1000),
      realizedTodayRaw: -usd(12.345678),
      mappings: { 'k:1': { key: 'k:1', leader: ACCOUNT, leaderPositionId: '1', status: 'open', instrumentId: 0, isLong: true, marginRaw: usd(250), leverage: 50, intentId: '0xab', followerPositionId: 'sim-1', closeIntentId: null, leaderClosed: false, createdAtMs: 1, updatedAtMs: 2, note: null } },
    };
    state.sim = [{ positionId: 'sim-1', instrumentId: 0, isLong: true, marginRaw: usd(250), leverage: 50, entryPriceRaw: 830_035n }];
    state.leaders = { [ACCOUNT]: { known: ['1', '2'], lastSeenAtMs: 5 } };
    const back = parseState(serializeState(state));
    expect(back.follower.realizedTodayRaw).toBe(-usd(12.345678));
    expect(back.follower.mappings['k:1'].marginRaw).toBe(usd(250));
    expect(back.sim[0].entryPriceRaw).toBe(830_035n);
    expect(back.leaders[ACCOUNT].known).toEqual(['1', '2']);
  });

  it('writes mode 0600 atomically and loads it back', () => {
    const store = new StateStore(join(dir, 'nested', 's.json'));
    expect(store.load()).toBeNull();
    store.save(emptyPersistedState('live', ACCOUNT, 1));
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${store.path}.tmp`)).toBe(false);
    expect(store.load()?.mode).toBe('live');
  });

  it('refuses a corrupt or foreign file with a clear message instead of starting from nothing', () => {
    const path = join(dir, 's.json');
    writeFileSync(path, '{not json');
    expect(() => new StateStore(path).load()).toThrow(StateFileError);
    writeFileSync(path, JSON.stringify({ version: 99 }));
    expect(() => new StateStore(path).load()).toThrow(StateFileError);
  });

  it('persists nonces so a restart never reuses one', () => {
    const state = emptyPersistedState('live', ACCOUNT, 1);
    const storage = new StateNonceStorage(state.nonces, () => undefined);
    storage.setItem('k', '42');
    expect(parseState(serializeState(state)).nonces.k).toBe('42');
  });
});

describe('process lock', () => {
  it('blocks a second process on the same state file and releases cleanly', () => {
    const file = join(dir, 's.json');
    const release = acquireLock(file);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid));
    expect(() => acquireLock(file)).toThrow(/already using/);
    release();
    acquireLock(file)();
  });

  it('takes over a lock left by a dead process', () => {
    const file = join(dir, 's.json');
    writeFileSync(`${file}.lock`, '2147483646');
    acquireLock(file)();
  });
});

describe('applyOpen persists pending state', () => {
  it('keeps the in-flight open across a save and load', () => {
    const state = emptyFollowerState(0);
    const next = applyOpen(
      state,
      { kind: 'open', leader: ACCOUNT, leaderPositionId: '9', key: 'k:9', instrumentId: 0, market: 'BTC', isLong: false, marginRaw: usd(300), leverage: 40, notionalRaw: usd(12000), leaderMarginRaw: usd(1), leaderLeverage: 1, leaderEntryPriceRaw: 1n, markPriceRaw: 1n, slippagePpm: 0n, adjustments: [] },
      '0xcd',
      10,
    );
    const p = emptyPersistedState('live', ACCOUNT, 0);
    p.follower = next;
    expect(parseState(serializeState(p)).follower.mappings['k:9']).toMatchObject({ status: 'pending', intentId: '0xcd', marginRaw: usd(300) });
  });
});
