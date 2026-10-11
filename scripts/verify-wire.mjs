// Proves the intent wire format against the live relayer without moving funds.
// A freshly generated throwaway session key signs an open for a random user. The relayer must answer
// 403 unauthorized_intent: the signature parsed and the canonical body was accepted, the signer is just not authorized.
import { createSessionKey, PapertradeClient, PapertradeTrader, PapertradeApiError } from 'papertrade-sdk';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

const client = new PapertradeClient({ clientBuild: 'papertrade-copytrade-verify-wire' });
const user = privateKeyToAddress(generatePrivateKey());
const session = createSessionKey();
const trader = new PapertradeTrader({ user, client, session });
const trading = await client.tradingState();
const market = trading.instruments.find((i) => i.openable);
const prepared = await trader.prepareOpen({ market: market.id, side: 'long', marginUsd: '10', leverage: 1000 }, trading);
console.log(`signed ${prepared.action} ${prepared.intentId} for random user ${user} with throwaway key ${session.account.address}`);
try {
  await trader.submit(prepared);
  console.log('UNEXPECTED: the relayer accepted a throwaway key');
  process.exitCode = 1;
} catch (err) {
  if (err instanceof PapertradeApiError && err.status === 403 && err.code === 'unauthorized_intent') {
    console.log(`PASS: relayer answered ${err.status} ${err.code} (wire format accepted, signer not authorized)`);
  } else {
    console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
