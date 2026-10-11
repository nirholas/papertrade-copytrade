# Changelog

## 0.1.0 (2026-10-10)

- `leaders`, `inspect`, `follow` and `check` commands.
- Live mirroring of leader opens and closes from the wallet SSE stream.
- Sizing modes: fixed, proportional, percent. Leverage modes: copy, cap, fixed.
- Required guardrails: max margin per trade, max total open margin, max leverage, max open positions, daily realized-loss stop, markets allowlist, cooldown, kill switch file, slippage guard.
- Protocol minimums ($10 margin, $10,000 notional, openable flags) enforced with a logged skip reason.
- Leader-to-follower position mapping persisted to a 0600 state file with restart recovery and a per-file process lock.
- Dry run by default; `--live` needs a typed confirmation and uses a trading-only session key.
- Pure planner exported as a library.
- Cloudflare Pages site with a leader explorer and a config builder.
