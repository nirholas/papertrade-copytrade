---
name: copytrade-papertrade
description: Rank Papertrade leaders, inspect a wallet and run the papertrade-copytrade CLI in dry-run mode with required guardrails. Use when asked to evaluate or simulate copy trading on Papertrade.
---

# papertrade-copytrade CLI

Papertrade is a 1000x synthetic perps exchange on HyperEVM (chain 999). This repo is an unofficial community tool. The CLI ranks leaders, streams a leader's wallet and mirrors opens and closes with a trading-only session key behind required guardrails. Dry run is the default. It is not published to npm, so run it from a clone (Node 20+).

## Install

```bash
git clone https://github.com/nirholas/papertrade-copytrade
cd papertrade-copytrade
npm install && npm run build
node dist/bin.js leaders --window 7d --sort low-leverage
```

## Commands

- `leaders [--window 24h|7d|30d|all] [--sort ...] [--limit 25] [--min-trades 3] [--json]`: leaderboard with win rate, liquidation rate and leverage stats.
- `inspect <address> [--window 7d] [--json]`: one wallet's stats and open positions.
- `follow <address...> [options]`: mirror up to 10 leaders.
- `check --config <file>`: validate a config and print the resolved guardrails.

## Required guardrails for `follow`

`--max-margin-per-trade`, `--max-total-margin`, `--max-leverage`, `--max-positions`, `--daily-loss-limit`, `--markets` (for example `BTC,ETH`), `--cooldown` (seconds), `--kill-switch <file>`, `--max-slippage` (percent). Missing any one makes `follow` refuse to start. Also: `--account 0x...`, `--sizing fixed:<usd>|proportional:<x>|percent:<pct>`, `--leverage copy|cap:<n>|fixed:<n>`, `--max-leader-age`, `--copy-existing`, `--state <file>`, `--assume-balance <usd>` (dry run only), `--json`, `--duration <seconds>`, `--flatten-on-kill`.

Protocol minimums are $10 margin and $10,000 notional. Copies that cannot reach them are skipped with a logged reason.

## Rules

- Without `--live`, `follow` only logs `would_sign`, `simulated_open` and `simulated_close`. Run that way. Never add `--live` or set `PAPERTRADE_WALLET_KEY` yourself. Live mode signs real trades, needs the user to type `start live copying` in an interactive terminal, and is the user's call.
- 1000x leverage can lose a whole margin in seconds and a leader's past results predict nothing. Say so when summarising rankings.

## Worked example

```bash
node dist/bin.js leaders --window 7d --sort low-leverage --limit 10 --json
node dist/bin.js follow 0xLEADER --account 0xYOU --sizing fixed:250 --leverage cap:50 \
  --max-margin-per-trade 300 --max-total-margin 1000 --max-leverage 50 --max-positions 3 \
  --daily-loss-limit 200 --markets BTC,ETH --cooldown 30 --kill-switch ./STOP --max-slippage 0.5 --duration 600
```
