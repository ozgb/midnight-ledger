# Standalone repro: `partition_transcripts` under-budgets `Transcript.gas` for multi-call transactions

Self-contained replication case for
[ledger-partition-transcripts-multicall-gas-public.md](../ledger-partition-transcripts-multicall-gas-public.md).
wallet-sdk + midnight-js against a stock local devnet, with a throwaway contract
([`commitlog.compact`](commitlog.compact)) — no workspace imports, no project contract.

```sh
docker compose up -d --wait   # fresh chain on ports 29944 / 28088 / 26300
npm install
npm run setup                 # fetch compactc 0.34.0 and compile the contract (~3s)
node repro.mjs                # exit 0 = reproduced
docker compose down -v        # tear down (wipes the chain)
```

`setup.mjs` pulls compactc 0.34.0 from its prerelease asset on
[LFDT-Minokawa/compact](https://github.com/LFDT-Minokawa/compact/releases/tag/compactc-v0.34.0)
into `.compactc/` and compiles `commitlog.compact` into `managed/`. No auth; needs `unzip` and
network. Neither directory is committed — the compiler is 30MB and the prover keys 2.8MB.

Expected: transactions carrying one call always land; transactions carrying several land with
at least one call's segment aborted, at a rate that climbs steeply with the call count. One
clean run, five transactions per call count:

| calls per transaction | transactions with a failed segment |
| --------------------- | ---------------------------------- |
| 1                     | 0 of 5                             |
| 2                     | 0 of 5                             |
| 3                     | 2 of 5                             |
| 4                     | 4 of 5                             |
| 10                    | 5 of 5                             |

N = 2 landing 5 of 5 there is luck, not a floor — a separate run hit it 1 time in 2. The
script's own ground truth is the contract's `entryCount` — N calls submitted, fewer than N
leaves appended means segments aborted. The reason only appears in the node's log:

```sh
docker compose logs node | grep 'Non guaranteed part'
# ... segments = {0: Ok(()), 1: Ok(()), 17162: Err(Transcript(Execution(OutOfGas))), 64929: Ok(())}
```

Knobs: `BATCH_SIZES` (default `1,2,3,4,10`), `ROUNDS` (default 5). The failure is
intermittent, so a clean run at a small call count proves nothing — only a multi-call failure
is a positive result, which is what the exit code reports.

## Bounding the shortfall

```sh
node patch-gas-factor.mjs     # fallible transcript budget x4 (MIDNIGHT_GAS_FACTOR to re-tune)
node repro.mjs                # now exits 1: nothing fails
```

That rewrites the one line of `@midnight-ntwrk/compact-js` that consumes `partitionTranscripts`'
output. It is the workaround, not the fix, and it must inflate only the **fallible** half —
inflating the guaranteed half is refused at mempool admission with
`Malformed(FeeCalculation(OutsideTimeToDismiss))`, since that half is budgeted against
transaction size. Re-run it after any `npm install`.

## The contract

One circuit, `appendEntry`, inserting a single leaf into a `HistoricMerkleTree<32, Bytes<32>>`
in contract state. No witnesses, no private state, no unshielded or shielded token I/O — so a
transaction carrying N calls exercises per-call gas budgeting and essentially nothing else.
`npm run setup` compiles it; `COMPACTC_VERSION` overrides the pinned compiler.
`checkRoot` is unused by the script. It is there because a caller contract invoking it makes a
two-call transaction _by construction_ — the shape that has no batch-size workaround at all.

## The ledger-8 control

`ledger8/` runs the **same harness against the same `commitlog.compact`** on the ledger-8
pairing — midnight-node 1.0.0, indexer-standalone 4.3.3, proof-server 8.1.0, midnight-js 4.1.1,
wallet-sdk 1.2.0, compactc 0.31.1 — on its own ports (39944/38088/36300), so it can run
alongside the ledger-9 side:

```sh
cd ledger8
docker compose up -d --wait
npm install
npm run setup                 # compactc 0.31.1, compiles ../commitlog.compact
node repro.mjs                # exit 1 = did NOT reproduce, the expected result here
docker compose down -v
```

Exit codes match the ledger-9 script, so the two are directly comparable: 0 = reproduced,
1 = not. One contract source, two compilers, two ledger lines — that is what makes the
comparison a version boundary rather than a property of the contract or the harness.
`withContractScopedTransaction` exists in midnight-js 4.1.1 and merges calls into one
transaction there too, so the multi-call shape really is exercised, not skipped.

`ledger8/package.json` pins `@midnight-ntwrk/onchain-runtime-v3` to 3.0.0 through `overrides`.
Without it `compact-runtime`'s `^3.0.0` hoists 3.1.1 while `midnight-js-protocol@4.1.1` keeps a
nested 3.0.0, so the two halves of a merge hold `StateValue`s from different wasm instances and
the second call in a transaction dies with `expected instance of StateValue` — a packaging
artefact, nothing to do with gas.

## Versions

Pinned in `docker-compose.yml` and `package.json`; the report's version table is the same
pairing.
