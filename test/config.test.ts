import { describe, expect, it } from 'vitest';
import { ConfigError, minMarginForNotional, resolveConfig, validateConfig } from '../src/config.js';
import { baseInput, LEADER } from './helpers.js';

describe('resolveConfig', () => {
  it('accepts a complete config and converts it to exact integers', () => {
    const c = resolveConfig(baseInput());
    expect(c.guardrails.maxMarginPerTradeRaw).toBe(300n * 10n ** 18n);
    expect(c.guardrails.maxSlippagePpm).toBe(5_000n);
    expect(c.guardrails.instrumentIds).toEqual([0, 1]);
    expect(c.leaders[0].address).toBe(LEADER);
    expect(c.guardrails.maxLeaderAgeSeconds).toBe(60);
  });

  it('requires every guardrail: there is no default that allows unlimited risk', () => {
    const required = ['maxMarginPerTradeUsd', 'maxTotalOpenMarginUsd', 'maxLeverage', 'maxOpenPositions', 'dailyLossLimitUsd', 'markets', 'cooldownSeconds', 'killSwitchFile', 'maxSlippagePct'];
    for (const key of required) {
      const input = baseInput();
      delete (input.guardrails as unknown as Record<string, unknown>)[key];
      const result = validateConfig(input);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.issues.join(' ')).toContain(key);
    }
  });

  it('reports every problem at once', () => {
    const result = validateConfig({ account: 'nope', leaders: [], sizing: { mode: 'fixed', marginUsd: -1 }, leverage: { mode: 'copy' }, guardrails: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(5);
  });

  it('rejects non-positive, non-finite and absurd guardrails', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateConfig(baseInput({ guardrails: { maxMarginPerTradeUsd: bad } })).ok).toBe(false);
    }
    expect(validateConfig(baseInput({ guardrails: { maxLeverage: 5000 } })).ok).toBe(false);
    expect(validateConfig(baseInput({ guardrails: { markets: ['DOGE'] } })).ok).toBe(false);
    expect(validateConfig(baseInput({ guardrails: { markets: [] } })).ok).toBe(false);
  });

  it('refuses a follower copying itself, duplicate leaders and more than ten leaders', () => {
    expect(validateConfig(baseInput({ leaders: [baseInput().account] })).ok).toBe(false);
    expect(validateConfig(baseInput({ leaders: [LEADER, LEADER.toUpperCase().replace('0X', '0x')] })).ok).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => `0x${(i + 2).toString(16).padStart(40, '0')}`);
    expect(validateConfig(baseInput({ leaders: many })).ok).toBe(false);
  });

  it('refuses a leverage mode above the leverage guardrail', () => {
    expect(validateConfig(baseInput({ leverage: { mode: 'cap', max: 100 } })).ok).toBe(false);
    expect(validateConfig(baseInput({ leverage: { mode: 'fixed', value: 100 } })).ok).toBe(false);
  });

  it('rejects margins under the protocol minimum', () => {
    expect(validateConfig(baseInput({ sizing: { mode: 'fixed', marginUsd: 9 } })).ok).toBe(false);
  });

  it('throws a ConfigError with the issues', () => {
    try {
      resolveConfig({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('minMarginForNotional', () => {
  it('is the margin that clears the $10,000 notional minimum', () => {
    expect(minMarginForNotional(50)).toBe(200);
    expect(minMarginForNotional(1000)).toBe(10);
    expect(minMarginForNotional(3)).toBe(3333.34);
  });
});
