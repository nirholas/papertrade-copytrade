import { instrumentByName, parseUnits, type InstrumentName } from 'papertrade-sdk';
import type { Address } from 'viem';

/** Smallest margin the protocol accepts, in USD. The authoritative value comes from /state/trading at run time. */
export const PROTOCOL_MIN_MARGIN_USD = 10;
/** Smallest notional (margin x leverage) the protocol accepts, in USD. */
export const PROTOCOL_MIN_NOTIONAL_USD = 10_000;

export type SizingInput =
  | { mode: 'fixed'; marginUsd: number }
  | { mode: 'proportional'; multiplier: number }
  | { mode: 'percent'; percent: number };

export type LeverageInput = { mode: 'copy' } | { mode: 'cap'; max: number } | { mode: 'fixed'; value: number };

export interface LeaderInput {
  address: string;
  sizing?: SizingInput;
  leverage?: LeverageInput;
}

export interface GuardrailsInput {
  maxMarginPerTradeUsd: number;
  maxTotalOpenMarginUsd: number;
  maxLeverage: number;
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  markets: string[];
  cooldownSeconds: number;
  killSwitchFile: string;
  maxSlippagePct: number;
  /** Skip a leader open that is older than this when it reaches the planner. Default 60. */
  maxLeaderAgeSeconds?: number;
}

/** The JSON config file. Every guardrail is required: there is no default that allows unlimited risk. */
export interface CopyConfigInput {
  account: string;
  leaders: Array<string | LeaderInput>;
  sizing: SizingInput;
  leverage: LeverageInput;
  guardrails: GuardrailsInput;
  /** Also copy positions the leader already held when following started. Default false. */
  copyExisting?: boolean;
  /** When the kill switch file appears, close every mirrored position instead of only stopping new opens. Default false. */
  flattenOnKill?: boolean;
}

export type ResolvedSizing =
  | { mode: 'fixed'; marginUsd: number; marginRaw: bigint }
  | { mode: 'proportional'; multiplier: number; multiplierPpm: bigint }
  | { mode: 'percent'; percent: number; percentPpm: bigint };

export type ResolvedLeverage = LeverageInput;

export interface ResolvedLeader {
  address: Address;
  sizing: ResolvedSizing;
  leverage: ResolvedLeverage;
}

export interface ResolvedGuardrails {
  maxMarginPerTradeUsd: number;
  maxMarginPerTradeRaw: bigint;
  maxTotalOpenMarginUsd: number;
  maxTotalOpenMarginRaw: bigint;
  maxLeverage: number;
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  dailyLossLimitRaw: bigint;
  markets: InstrumentName[];
  instrumentIds: number[];
  cooldownSeconds: number;
  cooldownMs: number;
  killSwitchFile: string;
  maxSlippagePct: number;
  /** Maximum allowed move of mark from the leader's entry, in parts per million of the entry price. */
  maxSlippagePpm: bigint;
  maxLeaderAgeSeconds: number;
  maxLeaderAgeMs: number;
}

export interface ResolvedConfig {
  account: Address;
  leaders: ResolvedLeader[];
  guardrails: ResolvedGuardrails;
  copyExisting: boolean;
  flattenOnKill: boolean;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid copy-trading config:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_LEADERS = 10;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function usd(raw: number): bigint {
  return parseUnits(String(raw), 18);
}

function num(
  issues: string[],
  path: string,
  value: unknown,
  rule: { min?: number; max?: number; integer?: boolean; exclusiveMin?: number },
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path} is required and must be a number.`);
    return null;
  }
  if (rule.integer && !Number.isInteger(value)) issues.push(`${path} must be a whole number.`);
  if (rule.min !== undefined && value < rule.min) issues.push(`${path} must be at least ${rule.min}.`);
  if (rule.exclusiveMin !== undefined && value <= rule.exclusiveMin) issues.push(`${path} must be greater than ${rule.exclusiveMin}.`);
  if (rule.max !== undefined && value > rule.max) issues.push(`${path} must be at most ${rule.max}.`);
  return value;
}

function parseSizing(issues: string[], path: string, input: unknown): ResolvedSizing | null {
  if (!isRecord(input)) {
    issues.push(`${path} is required: { "mode": "fixed" | "proportional" | "percent", ... }.`);
    return null;
  }
  switch (input.mode) {
    case 'fixed': {
      const marginUsd = num(issues, `${path}.marginUsd`, input.marginUsd, { min: PROTOCOL_MIN_MARGIN_USD });
      return marginUsd === null ? null : { mode: 'fixed', marginUsd, marginRaw: usd(marginUsd) };
    }
    case 'proportional': {
      const multiplier = num(issues, `${path}.multiplier`, input.multiplier, { exclusiveMin: 0, max: 1000 });
      return multiplier === null ? null : { mode: 'proportional', multiplier, multiplierPpm: BigInt(Math.round(multiplier * 1_000_000)) };
    }
    case 'percent': {
      const percent = num(issues, `${path}.percent`, input.percent, { exclusiveMin: 0, max: 100 });
      return percent === null ? null : { mode: 'percent', percent, percentPpm: BigInt(Math.round(percent * 10_000)) };
    }
    default:
      issues.push(`${path}.mode must be "fixed", "proportional" or "percent".`);
      return null;
  }
}

function parseLeverage(issues: string[], path: string, input: unknown): ResolvedLeverage | null {
  if (!isRecord(input)) {
    issues.push(`${path} is required: { "mode": "copy" | "cap" | "fixed", ... }.`);
    return null;
  }
  switch (input.mode) {
    case 'copy':
      return { mode: 'copy' };
    case 'cap': {
      const max = num(issues, `${path}.max`, input.max, { min: 1, max: 1000, integer: true });
      return max === null ? null : { mode: 'cap', max };
    }
    case 'fixed': {
      const value = num(issues, `${path}.value`, input.value, { min: 1, max: 1000, integer: true });
      return value === null ? null : { mode: 'fixed', value };
    }
    default:
      issues.push(`${path}.mode must be "copy", "cap" or "fixed".`);
      return null;
  }
}

function parseGuardrails(issues: string[], input: unknown): ResolvedGuardrails | null {
  if (!isRecord(input)) {
    issues.push('guardrails is required. Every guardrail must be set explicitly: there are no unlimited-risk defaults.');
    return null;
  }
  const p = 'guardrails';
  const perTrade = num(issues, `${p}.maxMarginPerTradeUsd`, input.maxMarginPerTradeUsd, { min: PROTOCOL_MIN_MARGIN_USD });
  const total = num(issues, `${p}.maxTotalOpenMarginUsd`, input.maxTotalOpenMarginUsd, { min: PROTOCOL_MIN_MARGIN_USD });
  const maxLeverage = num(issues, `${p}.maxLeverage`, input.maxLeverage, { min: 1, max: 1000, integer: true });
  const maxPositions = num(issues, `${p}.maxOpenPositions`, input.maxOpenPositions, { min: 1, max: 1000, integer: true });
  const dailyLoss = num(issues, `${p}.dailyLossLimitUsd`, input.dailyLossLimitUsd, { exclusiveMin: 0 });
  const cooldown = num(issues, `${p}.cooldownSeconds`, input.cooldownSeconds, { min: 0, max: 86_400 });
  const slippage = num(issues, `${p}.maxSlippagePct`, input.maxSlippagePct, { exclusiveMin: 0, max: 50 });
  const age =
    input.maxLeaderAgeSeconds === undefined ? 60 : num(issues, `${p}.maxLeaderAgeSeconds`, input.maxLeaderAgeSeconds, { min: 1, max: 86_400 });

  if (perTrade !== null && total !== null && total < perTrade) {
    issues.push(`${p}.maxTotalOpenMarginUsd (${total}) must be at least maxMarginPerTradeUsd (${perTrade}).`);
  }

  const markets: InstrumentName[] = [];
  if (!Array.isArray(input.markets) || input.markets.length === 0) {
    issues.push(`${p}.markets is required: a non-empty allowlist such as ["BTC","ETH"].`);
  } else {
    for (const m of input.markets) {
      try {
        const name = instrumentByName(String(m)).name;
        if (!markets.includes(name)) markets.push(name);
      } catch {
        issues.push(`${p}.markets contains "${String(m)}", which is not a Papertrade market (BTC, ETH).`);
      }
    }
  }

  let killSwitchFile = '';
  if (typeof input.killSwitchFile !== 'string' || input.killSwitchFile.trim() === '') {
    issues.push(`${p}.killSwitchFile is required: a path that stops new copies the moment the file exists.`);
  } else {
    killSwitchFile = input.killSwitchFile.trim();
  }

  if (
    perTrade === null || total === null || maxLeverage === null || maxPositions === null || dailyLoss === null ||
    cooldown === null || slippage === null || age === null || !killSwitchFile || markets.length === 0
  ) {
    return null;
  }
  return {
    maxMarginPerTradeUsd: perTrade,
    maxMarginPerTradeRaw: usd(perTrade),
    maxTotalOpenMarginUsd: total,
    maxTotalOpenMarginRaw: usd(total),
    maxLeverage,
    maxOpenPositions: maxPositions,
    dailyLossLimitUsd: dailyLoss,
    dailyLossLimitRaw: usd(dailyLoss),
    markets,
    instrumentIds: markets.map((m) => instrumentByName(m).id),
    cooldownSeconds: cooldown,
    cooldownMs: Math.round(cooldown * 1000),
    killSwitchFile,
    maxSlippagePct: slippage,
    maxSlippagePpm: BigInt(Math.round(slippage * 10_000)),
    maxLeaderAgeSeconds: age,
    maxLeaderAgeMs: Math.round(age * 1000),
  };
}

/**
 * Validate a config and convert it to the exact-integer form the planner uses.
 * Throws ConfigError listing every problem at once.
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  const issues: string[] = [];
  if (!isRecord(input)) throw new ConfigError(['The config must be a JSON object.']);

  let account: Address | null = null;
  if (typeof input.account !== 'string' || !ADDRESS_RE.test(input.account)) {
    issues.push('account is required: the 0x address of the wallet whose Papertrade account will mirror the leaders.');
  } else {
    account = input.account.toLowerCase() as Address;
  }

  const sizing = parseSizing(issues, 'sizing', input.sizing);
  const leverage = parseLeverage(issues, 'leverage', input.leverage);
  const guardrails = parseGuardrails(issues, input.guardrails);

  if (leverage && guardrails) {
    if (leverage.mode === 'cap' && leverage.max > guardrails.maxLeverage) {
      issues.push(`leverage.max (${leverage.max}) exceeds guardrails.maxLeverage (${guardrails.maxLeverage}).`);
    }
    if (leverage.mode === 'fixed' && leverage.value > guardrails.maxLeverage) {
      issues.push(`leverage.value (${leverage.value}) exceeds guardrails.maxLeverage (${guardrails.maxLeverage}).`);
    }
  }

  const leaders: ResolvedLeader[] = [];
  if (!Array.isArray(input.leaders) || input.leaders.length === 0) {
    issues.push('leaders is required: at least one leader wallet address.');
  } else if (input.leaders.length > MAX_LEADERS) {
    issues.push(`leaders lists ${input.leaders.length} wallets; the maximum is ${MAX_LEADERS}.`);
  } else {
    input.leaders.forEach((entry, i) => {
      const path = `leaders[${i}]`;
      const obj = typeof entry === 'string' ? { address: entry } : isRecord(entry) ? entry : null;
      if (!obj || typeof obj.address !== 'string' || !ADDRESS_RE.test(obj.address)) {
        issues.push(`${path} must be a 0x wallet address or { "address": "0x..." }.`);
        return;
      }
      const address = obj.address.toLowerCase() as Address;
      if (account && address === account) issues.push(`${path} is the follower account itself. A wallet cannot copy itself.`);
      if (leaders.some((l) => l.address === address)) {
        issues.push(`${path} repeats ${address}.`);
        return;
      }
      const leaderSizing = obj.sizing === undefined ? sizing : parseSizing(issues, `${path}.sizing`, obj.sizing);
      const leaderLeverage = obj.leverage === undefined ? leverage : parseLeverage(issues, `${path}.leverage`, obj.leverage);
      if (leaderSizing && leaderLeverage) {
        if (guardrails && leaderLeverage.mode === 'cap' && leaderLeverage.max > guardrails.maxLeverage) {
          issues.push(`${path}.leverage.max exceeds guardrails.maxLeverage.`);
        }
        if (guardrails && leaderLeverage.mode === 'fixed' && leaderLeverage.value > guardrails.maxLeverage) {
          issues.push(`${path}.leverage.value exceeds guardrails.maxLeverage.`);
        }
        leaders.push({ address, sizing: leaderSizing, leverage: leaderLeverage });
      }
    });
  }

  for (const key of ['copyExisting', 'flattenOnKill'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') issues.push(`${key} must be true or false.`);
  }

  if (issues.length || !account || !guardrails) throw new ConfigError(issues);
  return {
    account,
    leaders,
    guardrails,
    copyExisting: input.copyExisting === true,
    flattenOnKill: input.flattenOnKill === true,
  };
}

/** Non-throwing variant for UIs. */
export function validateConfig(input: unknown): { ok: true; config: ResolvedConfig } | { ok: false; issues: string[] } {
  try {
    return { ok: true, config: resolveConfig(input) };
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, issues: err.issues };
    throw err;
  }
}

/** Smallest margin that still clears the protocol's minimum notional at a leverage. */
export function minMarginForNotional(leverage: number, minNotionalUsd = PROTOCOL_MIN_NOTIONAL_USD, minMarginUsd = PROTOCOL_MIN_MARGIN_USD): number {
  return Math.max(minMarginUsd, Math.ceil((minNotionalUsd / leverage) * 100) / 100);
}
