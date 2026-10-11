# Security

papertrade-copytrade can submit real trades on a leveraged exchange, so security reports matter.

## Reporting

Use GitHub private vulnerability reporting: https://github.com/nirholas/papertrade-copytrade/security/advisories/new. Do not open a public issue for a vulnerability.

## Key handling

- `PAPERTRADE_WALLET_KEY` is read only in `--live` mode, only to sign one session-key registration, and is never written to disk or logged. Every log line passes through a redactor that removes known secrets.
- The session key it registers can open and close positions and cannot withdraw. It is stored in the state file (mode 0600) so a restart can reuse it. Treat that file as a secret.
- Dry run signs with a throwaway in-memory key and never submits.
- The website never asks for a key. It only builds a command.

## Scope

In scope: key leakage, guardrail bypass, state-file corruption that causes unintended trades, injection through API strings. Out of scope: Papertrade protocol or relayer issues (report those to Papertrade), losses from leverage or from a leader's trades.
