import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyWalletPatch, decodeTradingState, decodeWalletSnapshot, type OpenPosition, type TradingState, type WalletState } from 'papertrade-sdk';
import type { Address } from 'viem';
import { resolveConfig, type CopyConfigInput, type GuardrailsInput, type ResolvedConfig } from '../src/config.js';
import { emptyFollowerState, type FollowerState, type MarketContext } from '../src/planner.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** The real /state/trading response recorded from the live API. */
export function loadTrading(): TradingState {
  return decodeTradingState(JSON.parse(fixture('trading-state.json')));
}

export interface RecordedState {
  t: number;
  kind: 'snapshot' | 'update';
  state: WalletState;
}

/** Decode a recorded SSE capture the same way the SDK's streamWallet does. */
export function loadRecording(name: string): RecordedState[] {
  const out: RecordedState[] = [];
  let current: WalletState | null = null;
  for (const line of fixture(name).split('\n').filter(Boolean)) {
    const msg = JSON.parse(line) as { t: number; event: string; data: string };
    if (msg.event !== 'wallet') continue;
    const payload = JSON.parse(msg.data);
    if (payload.baseAccountRevision !== undefined && current) {
      current = applyWalletPatch(current, payload);
      out.push({ t: msg.t, kind: 'update', state: current });
    } else {
      current = decodeWalletSnapshot(payload);
      out.push({ t: msg.t, kind: 'snapshot', state: current });
    }
  }
  return out;
}

export const LEADER = '0x44fbf0bbf38c59fcc97e63084b31c18d5f2bb4ca' as Address;
export const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
export const KILL_FILE = '/nonexistent/papertrade-copytrade-kill';

export type ConfigOverrides = Omit<Partial<CopyConfigInput>, 'guardrails'> & { guardrails?: Partial<GuardrailsInput> };

export function baseInput(overrides: ConfigOverrides = {}): CopyConfigInput {
  const { guardrails, ...rest } = overrides;
  return {
    account: ACCOUNT,
    leaders: [LEADER],
    sizing: { mode: 'fixed', marginUsd: 250 },
    leverage: { mode: 'cap', max: 50 },
    guardrails: {
      maxMarginPerTradeUsd: 300,
      maxTotalOpenMarginUsd: 1000,
      maxLeverage: 50,
      maxOpenPositions: 3,
      dailyLossLimitUsd: 500,
      markets: ['BTC', 'ETH'],
      cooldownSeconds: 0,
      killSwitchFile: KILL_FILE,
      maxSlippagePct: 0.5,
      ...guardrails,
    },
    ...rest,
  };
}

export const config = (overrides?: ConfigOverrides): ResolvedConfig => resolveConfig(baseInput(overrides));

export function market(trading: TradingState, marksRaw: Record<number, bigint>, nowMs: number, killSwitch = false): MarketContext {
  return { nowMs, trading, marksRaw, killSwitch };
}

export function follower(availableUsd: number, nowMs: number): FollowerState {
  return { ...emptyFollowerState(nowMs), availableRaw: BigInt(availableUsd) * 10n ** 18n };
}

/** A real leader position from the first recording's snapshot with a field or two overridden. */
export function withPosition(base: OpenPosition, overrides: Partial<OpenPosition> = {}): OpenPosition {
  return { ...base, ...overrides };
}

export const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
