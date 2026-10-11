#!/usr/bin/env node
// Records the raw /state/user/live SSE events of a wallet to a JSONL file so tests can replay real data.
// Usage: node scripts/record-stream.mjs <wallet> <seconds> <out.jsonl>
import { createWriteStream } from 'node:fs';

const [wallet, secondsArg, out] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet ?? '') || !out) {
  console.error('usage: record-stream.mjs <wallet> <seconds> <out.jsonl>');
  process.exit(2);
}
const base = process.env.PAPERTRADE_API_URL ?? 'https://exchange.papertrade.xyz';
const stop = new AbortController();
const timer = setTimeout(() => stop.abort(), Number(secondsArg) * 1000);
const file = createWriteStream(out);

const res = await fetch(`${base}/state/user/live?wallet=${wallet.toLowerCase()}`, { headers: { Accept: 'text/event-stream' }, signal: stop.signal });
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
let buffer = '';
let event = '';
let data = [];
try {
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line === '') {
        if (data.length) file.write(`${JSON.stringify({ t: Date.now(), event: event || 'message', data: data.join('\n') })}\n`);
        event = '';
        data = [];
      } else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
} catch (err) {
  if (!stop.signal.aborted) throw err;
} finally {
  clearTimeout(timer);
  file.end();
}
