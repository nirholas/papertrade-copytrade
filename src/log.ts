export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Replace every occurrence of the given secret values. Intent ids are also 32-byte hex, so redaction is by value, not by shape. */
export function makeRedactor(secrets: readonly string[]) {
  const known = secrets.filter((s) => s.length >= 8);
  return (text: string): string => {
    let out = text;
    for (const s of known) out = out.split(s).join('[redacted]');
    return out;
  };
}

const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

export interface LoggerOptions {
  json: boolean;
  level: LogLevel;
  write?: (line: string) => void;
  /** Exact secret strings that must never appear in output. */
  secrets?: readonly string[];
  color?: boolean;
  now?: () => number;
}

const COLORS: Record<LogLevel, string> = { debug: '\u001b[90m', info: '\u001b[36m', warn: '\u001b[33m', error: '\u001b[31m' };
const RESET = '\u001b[0m';

/**
 * Structured logger. In JSON mode every line is one JSON object `{ts, level, event, ...fields}`;
 * otherwise a readable line with key=value fields. Secrets are redacted in both.
 */
export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const redact = makeRedactor(options.secrets ?? []);
  const now = options.now ?? Date.now;
  const min = ORDER[options.level];

  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return;
    const ts = new Date(now()).toISOString();
    let line: string;
    if (options.json) {
      line = JSON.stringify({ ts, level, event, ...fields }, replacer);
    } else {
      const { message, ...rest } = fields;
      const kv = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v, replacer)}`)
        .join(' ');
      const tag = options.color ? `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET}` : level.toUpperCase().padEnd(5);
      line = `${ts} ${tag} ${event}${message ? `  ${String(message)}` : ''}${kv ? `  ${kv}` : ''}`;
    }
    write(redact(line));
  };

  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

