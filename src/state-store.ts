import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NonceStorage } from 'papertrade-sdk';
import type { Address, Hex } from 'viem';
import { emptyFollowerState, utcDay, type FollowerState, type Mapping } from './planner.js';

export type RunMode = 'dry-run' | 'live';

/** A simulated follower position in dry-run. Never exists on chain. */
export interface SimPosition {
  positionId: string;
  instrumentId: number;
  isLong: boolean;
  marginRaw: bigint;
  leverage: number;
  entryPriceRaw: bigint;
}

/** Everything that survives a restart. The file holds a hot session key, so it is written with mode 0600. */
export interface PersistedState {
  version: 1;
  mode: RunMode;
  account: Address;
  /** The trading-only session key (cannot withdraw). Present in live mode once registered. */
  session: { privateKey: Hex; address: Address; expiry: string } | null;
  nonces: Record<string, string>;
  /** Leader position ids seen at the last observation. Null until the leader is first observed. */
  leaders: Record<string, { known: string[] | null; lastSeenAtMs: number }>;
  follower: FollowerState;
  sim: SimPosition[];
  simSeq: number;
  updatedAtMs: number;
}

interface WireMapping extends Omit<Mapping, 'marginRaw'> {
  marginRaw: string;
}
interface WireSim extends Omit<SimPosition, 'marginRaw' | 'entryPriceRaw'> {
  marginRaw: string;
  entryPriceRaw: string;
}
interface WireState extends Omit<PersistedState, 'follower' | 'sim'> {
  follower: {
    dayKey: string;
    realizedTodayRaw: string;
    lastOpenAtMs: Record<string, number>;
    mappings: Record<string, WireMapping>;
  };
  sim: WireSim[];
}

export function emptyPersistedState(mode: RunMode, account: Address, nowMs: number): PersistedState {
  return { version: 1, mode, account, session: null, nonces: {}, leaders: {}, follower: emptyFollowerState(nowMs), sim: [], simSeq: 0, updatedAtMs: nowMs };
}

export function serializeState(state: PersistedState): string {
  const { follower, sim, ...rest } = state;
  const wire: WireState = {
    ...rest,
    follower: {
      dayKey: follower.dayKey,
      realizedTodayRaw: follower.realizedTodayRaw.toString(),
      lastOpenAtMs: follower.lastOpenAtMs,
      mappings: Object.fromEntries(Object.entries(follower.mappings).map(([k, m]) => [k, { ...m, marginRaw: m.marginRaw.toString() }])),
    },
    sim: sim.map((s) => ({ ...s, marginRaw: s.marginRaw.toString(), entryPriceRaw: s.entryPriceRaw.toString() })),
  };
  return `${JSON.stringify(wire, null, 2)}\n`;
}

export class StateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateFileError';
  }
}

export function parseState(text: string): PersistedState {
  let wire: WireState;
  try {
    wire = JSON.parse(text) as WireState;
  } catch {
    throw new StateFileError('The state file is not valid JSON.');
  }
  if (wire.version !== 1) throw new StateFileError(`Unsupported state file version ${String(wire.version)}.`);
  return {
    ...wire,
    follower: {
      availableRaw: 0n,
      positions: [],
      dayKey: wire.follower.dayKey ?? utcDay(Date.now()),
      realizedTodayRaw: BigInt(wire.follower.realizedTodayRaw),
      lastOpenAtMs: wire.follower.lastOpenAtMs ?? {},
      mappings: Object.fromEntries(Object.entries(wire.follower.mappings ?? {}).map(([k, m]) => [k, { ...m, marginRaw: BigInt(m.marginRaw) }])),
    },
    sim: (wire.sim ?? []).map((s) => ({ ...s, marginRaw: BigInt(s.marginRaw), entryPriceRaw: BigInt(s.entryPriceRaw) })),
  };
}

/** Atomic, owner-only JSON state file. */
export class StateStore {
  constructor(readonly path: string) {}

  load(): PersistedState | null {
    if (!existsSync(this.path)) return null;
    return parseState(readFileSync(this.path, 'utf8'));
  }

  save(state: PersistedState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, serializeState(state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

/** Nonce storage backed by the persisted state, so a restart never reuses a nonce. */
export class StateNonceStorage implements NonceStorage {
  constructor(
    private readonly nonces: Record<string, string>,
    private readonly onChange: () => void,
  ) {}
  getItem(key: string) {
    return this.nonces[key] ?? null;
  }
  setItem(key: string, value: string) {
    this.nonces[key] = value;
    this.onChange();
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One follower process per state file. A lock left by a dead process is taken over. */
export function acquireLock(stateFile: string): () => void {
  const lock = `${stateFile}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          return;
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(lock, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new StateFileError(`Another papertrade-copytrade process (pid ${pid}) is already using ${stateFile}.`);
      }
      unlinkSync(lock);
    }
  }
  throw new StateFileError(`Could not lock ${stateFile}.`);
}
