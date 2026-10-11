import { describe, expect, it } from 'vitest';
import { createLogger, makeRedactor } from '../src/log.js';

describe('logger', () => {
  const lines = () => {
    const out: string[] = [];
    return { out, write: (l: string) => out.push(l) };
  };

  it('emits one JSON object per line with bigint-safe fields', () => {
    const { out, write } = lines();
    createLogger({ json: true, level: 'info', write, now: () => 0 }).info('thing', { amount: 5n, nested: { id: 7n } });
    expect(JSON.parse(out[0])).toEqual({ ts: '1970-01-01T00:00:00.000Z', level: 'info', event: 'thing', amount: '5', nested: { id: '7' } });
  });

  it('filters below the level', () => {
    const { out, write } = lines();
    const log = createLogger({ json: true, level: 'warn', write });
    log.info('a');
    log.debug('b');
    log.warn('c');
    expect(out).toHaveLength(1);
  });

  it('never prints a registered secret in JSON or text mode', () => {
    const secret = `0x${'ab'.repeat(32)}`;
    for (const json of [true, false]) {
      const { out, write } = lines();
      createLogger({ json, level: 'info', write, secrets: [secret] }).info('boom', { message: `key ${secret} leaked`, nested: { k: secret } });
      expect(out.join('\n')).not.toContain(secret);
      expect(out.join('\n')).toContain('[redacted]');
    }
  });

  it('redacts by value so 32-byte intent ids stay readable', () => {
    const redact = makeRedactor([`0x${'cd'.repeat(32)}`]);
    expect(redact(`intent 0x${'ef'.repeat(32)}`)).toContain('ef');
  });
});
