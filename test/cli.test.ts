import { parseArgs } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildConfigInput, LIVE_PHRASE, main, parseLeverageSpec, parseSizingSpec } from '../src/cli.js';
import { resolveConfig } from '../src/config.js';
import { ACCOUNT, LEADER } from './helpers.js';

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      live: { type: 'boolean' }, config: { type: 'string' }, account: { type: 'string' }, sizing: { type: 'string' }, leverage: { type: 'string' },
      'max-margin-per-trade': { type: 'string' }, 'max-total-margin': { type: 'string' }, 'max-leverage': { type: 'string' }, 'max-positions': { type: 'string' },
      'daily-loss-limit': { type: 'string' }, markets: { type: 'string' }, cooldown: { type: 'string' }, 'kill-switch': { type: 'string' }, 'max-slippage': { type: 'string' },
      'max-leader-age': { type: 'string' }, 'copy-existing': { type: 'boolean' }, 'flatten-on-kill': { type: 'boolean' }, state: { type: 'string' }, 'assume-balance': { type: 'string' },
      json: { type: 'boolean' }, level: { type: 'string' }, api: { type: 'string' }, duration: { type: 'string' },
    },
  });

describe('flag parsing', () => {
  it('parses sizing and leverage specs', () => {
    expect(parseSizingSpec('fixed:50')).toEqual({ mode: 'fixed', marginUsd: 50 });
    expect(parseSizingSpec('proportional:0.5')).toEqual({ mode: 'proportional', multiplier: 0.5 });
    expect(parseSizingSpec('percent:5')).toEqual({ mode: 'percent', percent: 5 });
    expect(parseLeverageSpec('copy')).toEqual({ mode: 'copy' });
    expect(parseLeverageSpec('cap:20')).toEqual({ mode: 'cap', max: 20 });
    expect(parseLeverageSpec('fixed:10')).toEqual({ mode: 'fixed', value: 10 });
    expect(() => parseSizingSpec('wat')).toThrow();
    expect(() => parseLeverageSpec('cap:x')).toThrow();
  });

  it('builds a valid config from flags alone and lets flags override a file', () => {
    const { values, positionals } = parse([LEADER, '--account', ACCOUNT, '--sizing', 'fixed:250', '--leverage', 'cap:50', '--max-margin-per-trade', '300', '--max-total-margin', '1000', '--max-leverage', '50', '--max-positions', '3', '--daily-loss-limit', '500', '--markets', 'btc,eth', '--cooldown', '5', '--kill-switch', '/tmp/k', '--max-slippage', '0.5']);
    const config = resolveConfig(buildConfigInput(values, positionals, null, {}));
    expect(config.guardrails.markets).toEqual(['BTC', 'ETH']);
    const override = parse([LEADER, '--max-positions', '1']);
    const merged = resolveConfig(buildConfigInput(override.values, override.positionals, { account: ACCOUNT, leaders: [], sizing: { mode: 'fixed', marginUsd: 250 }, leverage: { mode: 'cap', max: 50 }, guardrails: { maxMarginPerTradeUsd: 300, maxTotalOpenMarginUsd: 1000, maxLeverage: 50, maxOpenPositions: 3, dailyLossLimitUsd: 500, markets: ['BTC'], cooldownSeconds: 5, killSwitchFile: '/tmp/k', maxSlippagePct: 0.5 } }, {}));
    expect(merged.guardrails.maxOpenPositions).toBe(1);
    expect(merged.leaders[0].address).toBe(LEADER);
  });
});

describe('main', () => {
  it('refuses to follow without the required guardrails (exit 2)', async () => {
    expect(await main(['follow', LEADER, '--account', ACCOUNT, '--sizing', 'fixed:250', '--leverage', 'copy'])).toBe(2);
  });

  it('refuses --live without an interactive terminal (exit 2)', async () => {
    const code = await main(['follow', LEADER, '--live', '--account', ACCOUNT, '--sizing', 'fixed:250', '--leverage', 'cap:50', '--max-margin-per-trade', '300', '--max-total-margin', '1000', '--max-leverage', '50', '--max-positions', '3', '--daily-loss-limit', '500', '--markets', 'BTC', '--cooldown', '5', '--kill-switch', '/tmp/k', '--max-slippage', '0.5', '--state', '/tmp/copytrade-cli-test-state.json']);
    expect(code).toBe(2);
  });

  it('prints help and the version', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(await main(['--version'])).toBe(0);
    expect(await main(['bogus'])).toBe(2);
    expect(LIVE_PHRASE.length).toBeGreaterThan(10);
  });
});
