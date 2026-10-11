import {
  createSessionKey,
  fetchWalletState,
  isSessionKeyActive,
  PapertradeTrader,
  restoreSessionKey,
  type PapertradeClient,
  type SessionKey,
} from 'papertrade-sdk';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from './log.js';
import { StateNonceStorage, type PersistedState } from './state-store.js';

export const WALLET_KEY_ENV = 'PAPERTRADE_WALLET_KEY';

export function parseWalletKey(raw: string | undefined): Hex {
  const value = (raw ?? '').trim();
  const hex = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${WALLET_KEY_ENV} must be a 32-byte hex private key (64 hex characters). It is only used to register a trading-only session key.`);
  }
  return hex as Hex;
}

/** Address of the wallet key without exposing the key anywhere else. */
export function walletAddress(raw: string | undefined): Address {
  return privateKeyToAccount(parseWalletKey(raw)).address.toLowerCase() as Address;
}

export interface TraderSetup {
  trader: PapertradeTrader;
  /** Secrets that must be redacted from every log line. */
  secrets: string[];
}

/** Dry run: a throwaway in-memory session key. It signs locally and is never registered or persisted. */
export function dryRunTrader(client: PapertradeClient, account: Address, state: PersistedState, onNonce: () => void): TraderSetup {
  const session = createSessionKey();
  const trader = new PapertradeTrader({ user: account, client, session, nonceStorage: new StateNonceStorage(state.nonces, onNonce) });
  return { trader, secrets: [session.privateKey] };
}

/**
 * Live: reuse the persisted session key when the relayer still lists it as active, otherwise register a new one.
 * The wallet key signs exactly one RegisterSessionKey intent and is then dropped. Every trade is signed by the session key.
 */
export async function liveTrader(args: {
  client: PapertradeClient;
  account: Address;
  state: PersistedState;
  walletKeyRaw: string | undefined;
  save: () => void;
  log: Logger;
  signal?: AbortSignal;
}): Promise<TraderSetup> {
  const { client, account, state, log } = args;
  const nonceStorage = new StateNonceStorage(state.nonces, args.save);
  const secrets: string[] = [];
  const baseUrl = client.http.baseUrl;

  const wallet = await fetchWalletState(account, { baseUrl, signal: args.signal });
  let session: SessionKey | null = null;
  if (state.session) {
    const stored = restoreSessionKey(state.session.privateKey, BigInt(state.session.expiry));
    secrets.push(stored.privateKey);
    if (isSessionKeyActive(wallet.sessionKeys, stored.account.address)) {
      session = stored;
      log.info('session', { message: 'reusing the registered session key', sessionKey: stored.account.address, expiresAt: new Date(Number(stored.expiry) * 1000).toISOString() });
    } else {
      log.warn('session', { message: 'the saved session key is not active on the relayer any more; registering a new one' });
    }
  }

  if (!session) {
    const key = parseWalletKey(args.walletKeyRaw);
    secrets.push(key);
    const owner = privateKeyToAccount(key);
    if (owner.address.toLowerCase() !== account) throw new Error(`${WALLET_KEY_ENV} belongs to ${owner.address.toLowerCase()}, not the configured account ${account}.`);
    const registrar = new PapertradeTrader({ user: account, wallet: owner, client, nonceStorage });
    const fresh = createSessionKey();
    secrets.push(fresh.privateKey);
    state.session = { privateKey: fresh.privateKey, address: fresh.account.address.toLowerCase() as Address, expiry: fresh.expiry.toString() };
    args.save();
    log.info('session', { message: 'registering a trading-only session key (it can open and close positions, it cannot withdraw)', sessionKey: fresh.account.address });
    await registrar.registerSession(fresh, args.signal);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const now = await fetchWalletState(account, { baseUrl, signal: args.signal });
      if (isSessionKeyActive(now.sessionKeys, fresh.account.address)) break;
      if (Date.now() > deadline) throw new Error('The session key was submitted but is not active after 60 seconds. Re-run to retry.');
      await new Promise((r) => setTimeout(r, 1500));
    }
    session = fresh;
    log.info('session', { message: 'session key active', sessionKey: fresh.account.address, expiresAt: new Date(Number(fresh.expiry) * 1000).toISOString() });
  }
  const trader = new PapertradeTrader({ user: account, client, session, nonceStorage });
  return { trader, secrets };
}
