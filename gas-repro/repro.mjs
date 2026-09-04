// Standalone repro: `partition_transcripts` under-budgets `Transcript.gas` when several calls
// ride in one transaction, so at least one contract segment aborts with
// `Transcript(Execution(OutOfGas))` -- intermittently, and more often the more calls the
// transaction carries.
//
// Self-contained: wallet-sdk + midnight-js + the `commitlog.compact` contract beside this file,
// against the stock local devnet in this directory's docker-compose.yml. No project imports.
// See ../ledger-partition-transcripts-multicall-gas-public.md for the analysis this replicates.
//
//   docker compose up -d --wait
//   npm install
//   node repro.mjs        # exit 0 = reproduced (>=1 segment out of gas at some N > 1)
//   docker compose down -v
//
// What it does: deploys the commit log, then for each N in `BATCH_SIZES` submits `ROUNDS`
// transactions, each carrying N calls to `appendEntry` merged by
// `withContractScopedTransaction`. Ground truth for how many calls actually landed is the
// contract's own `entryCount`, read back from the indexer after each transaction: N calls
// submitted, fewer than N leaves appended = segments aborted. The node's log for the same
// transaction names the reason (`Non guaranteed part of the transaction failed ... segments =
// {... Err(Transcript(Execution(OutOfGas)))}`); `docker compose logs node` shows it.
//
// Knobs (env): BATCH_SIZES (default `1,2,3,4,10`), ROUNDS (default 5).
//
// To bound the shortfall, run `node patch-gas-factor.mjs` beside this file and re-run: it
// multiplies the *fallible* transcript budget the SDK declares (default 4x) and the failures
// stop. That is the workaround, not the fix -- see the report.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import {
  WalletFacade,
  DustWallet,
  HDWallet,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  createKeystore,
  NoOpTransactionHistoryStorage,
  PublicKey,
} from '@midnight-ntwrk/wallet-sdk';
import { ZswapSecretKeys, DustSecretKey, LedgerParameters } from '@midnightntwrk/ledger-v9';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  deployContract,
  withContractScopedTransaction,
  CallTxFailedError,
} from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import * as CommitLog from './managed/commitlog/contract/index.js';

// The SDK's indexer subscriptions expect a global WebSocket.
globalThis.WebSocket = WebSocket;

const INDEXER = process.env.INDEXER ?? 'http://127.0.0.1:28088/api/v4/graphql';
const INDEXER_WS = process.env.INDEXER_WS ?? 'ws://127.0.0.1:28088/api/v4/graphql/ws';
const NODE_URL = process.env.NODE_URL ?? 'ws://127.0.0.1:29944';
const PROOF_SERVER = process.env.PROOF_SERVER ?? 'http://127.0.0.1:26300';
const NETWORK_ID = 'undeployed';

// First wallet the devnet's `dev` preset funds at genesis (250,000,000 NIGHT, 6 decimals).
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const PRIVATE_STATE_ID = 'commitLogPrivateState';

const BATCH_SIZES = (process.env.BATCH_SIZES ?? '1,2,3,4,10')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const ROUNDS = Number(process.env.ROUNDS ?? 5);

// See buildProviders: throwaway, for a store that holds nothing.
// `Aa!` because the provider insists on three character classes; the entropy is the hex.
const STORE_PASSWORD = `Aa!${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')}`;

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);
const describeChain = (err) => {
  const parts = [];
  for (let e = err; e; e = e.cause) parts.push(e?.message ?? String(e));
  return parts.join('  <-  ');
};

// ---- wallet ----------------------------------------------------------------------------

function deriveKeys(seed) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();
  return derived.keys;
}

// The facade's own isSynced also waits on the shielded child, whose sync never completes on
// this SDK/indexer pairing; unshielded + dust is what fee payment needs.
const usable = (s) =>
  s.dust.state.progress.isStrictlyComplete() && s.unshielded.state.progress.isStrictlyComplete();

async function buildWallet(seed) {
  const keys = deriveKeys(seed);
  const shieldedSecretKeys = ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    NETWORK_ID,
  );
  const wallet = await WalletFacade.init({
    configuration: {
      networkId: NETWORK_ID,
      indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
      provingServerUrl: new URL(PROOF_SERVER),
      relayURL: new URL(NODE_URL),
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
      costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    },
    shielded: async (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (config) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: async (config) =>
      DustWallet(config).startWithSecretKey(
        dustSecretKey,
        LedgerParameters.initialParameters().dust,
      ),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    usableSync: () => Rx.firstValueFrom(wallet.state().pipe(Rx.filter(usable))),
  };
}

// Every transaction here pays a DUST fee, so the genesis NIGHT has to be generating DUST.
// The signer callback already returns a fully-signed recipe; do not signRecipe again.
async function ensureDustRegistered(ctx) {
  const state = await ctx.usableSync();
  const unregistered = state.unshielded.availableCoins.filter(
    (c) => !c.meta?.registeredForDustGeneration,
  );
  if (unregistered.length > 0) {
    log(`registering ${unregistered.length} NIGHT UTXOs for DUST generation...`);
    const register = () =>
      ctx.wallet.registerNightUtxosForDustGeneration(
        unregistered,
        ctx.unshieldedKeystore.getPublicKey(),
        ctx.unshieldedKeystore.signDataAsync,
      );
    let recipe;
    try {
      recipe = await register();
    } catch (err) {
      // A first registration pays its fee from the DUST its NIGHT has generated; freshly
      // landed NIGHT may not have generated enough yet. The SDK's error names the shortfall.
      const need = /need (\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
      if (need === undefined) throw err;
      log(`waiting for the NIGHT to generate the ${need} DUST registration costs...`);
      await ctx.wallet.waitForGeneratedDust(unregistered, BigInt(need));
      recipe = await register();
    }
    await ctx.wallet.submitTransaction(await ctx.wallet.finalizeRecipe(recipe));
  }
  if ((await ctx.usableSync()).dust.balance(new Date()) === 0n) {
    log('waiting for DUST to accrue...');
    await Rx.firstValueFrom(
      ctx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter(usable),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
      ),
    );
  }
  log('DUST ready');
}

// ---- providers -------------------------------------------------------------------------

function buildProviders(ctx) {
  const walletProvider = {
    getCoinPublicKey: () => ctx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx, ttl) {
      // Sync first: this is where the transaction's DUST fee proof is built, and one built
      // against a stale dust root is rejected outright.
      await ctx.usableSync();
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await ctx.wallet.signRecipe(recipe, ctx.unshieldedKeystore.signDataAsync);
      return ctx.wallet.finalizeRecipe(signed);
    },
    submitTx: (tx) => ctx.wallet.submitTransaction(tx),
  };
  const managed = path.resolve(import.meta.dirname, 'managed', 'commitlog');
  const zkConfigProvider = new NodeZkConfigProvider(managed);
  return {
    publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: mkdtempSync(path.join(tmpdir(), 'gas-repro-')),
      // The contract has no witnesses, so the store only ever holds `{}` -- but the provider
      // insists on a password. Random per run, in a temp dir wiped with it.
      privateStoragePasswordProvider: () => STORE_PASSWORD,
      accountId: String(ctx.unshieldedKeystore.getBech32Address()),
    }),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

const CompiledCommitLog = CompiledContract.make('CommitLog', CommitLog.Contract).pipe(
  CompiledContract.withWitnesses({}),
  CompiledContract.withCompiledFileAssets('./managed/commitlog'),
);

// ---- the measurement -------------------------------------------------------------------

const randomEntry = () => crypto.getRandomValues(new Uint8Array(32));

async function entryCount(providers, address) {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (state === null) throw new Error('contract state unavailable');
  return CommitLog.ledger(state.data).entryCount;
}

/**
 * One transaction carrying `n` calls. Returns how many of them actually appended a leaf --
 * `n` on success, fewer when segments aborted.
 */
async function submitBatch(deployed, providers, address, n) {
  const before = await entryCount(providers, address);
  let txPublic;
  try {
    const txData = await withContractScopedTransaction(
      providers,
      async (txCtx) => {
        for (let i = 0; i < n; i += 1) {
          await deployed.callTx.appendEntry(txCtx, randomEntry());
        }
      },
      { scopeName: 'appendBatch' },
    );
    txPublic = txData.public;
  } catch (err) {
    // A transaction that lands with failed call segments surfaces as a THROWN
    // CallTxFailedError carrying the finalized data, not a resolved result. instanceof with a
    // duck-type fallback, in case a second physical copy of the SDK is in the tree.
    const failed =
      err instanceof CallTxFailedError ? err.finalizedTxData : (err?.finalizedTxData ?? undefined);
    if (failed === undefined) throw err;
    txPublic = failed;
  }
  // Poll the indexer rather than trusting the status alone: `entryCount` is the chain's own
  // answer to "how many of those N calls executed".
  let after = before;
  for (let i = 0; i < 30 && after === before; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await entryCount(providers, address);
  }
  const landed = Number(after - before);
  // Dump whatever the finalized data carries rather than reaching for one field: the SDK's
  // own per-segment map is opaque here, and the node's log is where the *reason* appears.
  const detail = JSON.stringify(txPublic, (_k, v) =>
    typeof v === 'bigint' ? String(v) : v instanceof Map ? Object.fromEntries(v) : v,
  );
  return { landed, status: txPublic.status, txHash: txPublic.txHash, detail };
}

// ---- run -------------------------------------------------------------------------------

setNetworkId(NETWORK_ID);

log('syncing the genesis wallet...');
const ctx = await buildWallet(GENESIS_SEED);
await ensureDustRegistered(ctx);

const providers = buildProviders(ctx);
log('deploying the commit log...');
let deployed;
for (let attempt = 1; ; attempt += 1) {
  try {
    deployed = await deployContract(providers, {
      compiledContract: CompiledCommitLog,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
    break;
  } catch (err) {
    // The wallet's DUST balance is a projection of what its registered NIGHT will generate,
    // and the tx-builder only spends what the next block's timestamp accounts for -- which
    // lags wall-clock right after registration.
    const msg = describeChain(err);
    if (attempt >= 20 || !/Not enough Dust|Insufficient Funds|could not balance dust/.test(msg)) {
      throw err;
    }
    log(`deploy attempt ${attempt} short of DUST; retrying in 5s...`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
const address = deployed.deployTxData.public.contractAddress;
log(`deployed at ${address}`);

const results = [];
for (const n of BATCH_SIZES) {
  let failures = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const { landed, status, txHash, detail } = await submitBatch(deployed, providers, address, n);
    const ok = landed === n;
    if (!ok) failures += 1;
    log(
      `N=${n} round ${round}/${ROUNDS}: ${landed}/${n} calls landed  status=${status}  ` +
        `tx=${txHash}${ok ? '' : `\n            finalized: ${detail}`}`,
    );
  }
  results.push({ n, failures });
}

console.log('\n  calls per transaction | transactions with a failed segment');
console.log('  --------------------- | ----------------------------------');
for (const { n, failures } of results) {
  console.log(`  ${String(n).padStart(21)} | ${failures} of ${ROUNDS}`);
}

const multiCallFailures = results.filter((r) => r.n > 1).reduce((a, r) => a + r.failures, 0);
const singleCallFailures = results.filter((r) => r.n === 1).reduce((a, r) => a + r.failures, 0);
console.log(
  `\n  ${singleCallFailures} single-call failures, ${multiCallFailures} multi-call failures.` +
    '\n  `docker compose logs node | grep -i "not guaranteed"` names the reason for each.\n',
);

// The failure is intermittent, so a clean run at small N proves nothing -- only a multi-call
// failure is a positive result. Exit 0 = reproduced.
await ctx.wallet.close?.();
process.exit(multiCallFailures > 0 ? 0 : 1);
