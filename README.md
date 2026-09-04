### Context & versions

`partition_transcripts` sizes `Transcript.gas` per call as if that call ran alone.
When several calls ride in one transaction, at least one of them is under-budgeted
and fails `Transcript(Execution(OutOfGas))` on chain — intermittently, and more
often the more calls the transaction carries.

- `@midnightntwrk/ledger-v9` 1.0.0-rc.3 (source read at tag `ledger-9.1.0.0-rc.3`)
- `@midnight-ntwrk/compact-js` 2.5.5-rc.8
- `@midnight-ntwrk/midnight-js-*` 5.0.0-beta.7
- `@midnight-ntwrk/wallet-sdk` 2.0.0-beta.2
- `@midnight-ntwrk/compact-runtime` 0.19.0-rc.0, compactc 0.34.0
- `midnightntwrk/midnight-node:2.0.0-rc.4` (`system_version` `2.0.0-d9729c13`,
  `specVersion` 2000000)
- `midnightntwrk/proof-server:9.0.0-rc.5_experimental`
- `midnightntwrk/indexer-standalone:4.4.0-pre-alpha.16-l91r3-n2r3-…-16c656df`

Local devnet (midnight-node local-env), single authority, otherwise idle chain.

**This is a ledger-9 regression: the ledger-8 pairing does not reproduce it.** The attached
repro ships that control (`gas-repro/ledger8/`) — the same harness against the same contract
source, compiled by that lane's own compactc 0.31.1, on midnight-node 1.0.0 /
indexer-standalone 4.3.3 / proof-server 8.1.0 / midnight-js 4.1.1 / wallet-sdk 1.2.0. Five
transactions at each of N ∈ {1, 2, 3, 4, 10}: **0 failures at every call count**, and no
`OutOfGas` anywhere in the node's log — where the ledger-9 pairing loses 4 of 5 at N = 4 and
5 of 5 at N = 10. `withContractScopedTransaction` exists in 4.1.1 and merges the calls into
one transaction there too, so the multi-call shape is genuinely exercised on both sides.

### Steps to reproduce

A self-contained repro is attached (`gas-repro/`): `docker compose up -d --wait`,
`npm install`, `npm run setup` (fetches compactc 0.34.0 and compiles the contract),
`node repro.mjs`. It stands up a stock local devnet, deploys the contract below,
and submits N calls per transaction for
N ∈ {1, 2, 3, 4, 10}, five transactions each. It reports how many of each
transaction's calls actually landed, reading the contract's own counter back from
the indexer; the node's log names the reason.

The contract is one circuit inserting a single leaf into a Merkle tree held in
contract state, and nothing else:

```compact
pragma language_version >= 0.23;
import CompactStandardLibrary;

export ledger entries: HistoricMerkleTree<32, Bytes<32>>;
export ledger entryCount: Counter;

export circuit appendEntry(entry: Bytes<32>): [] {
  entries.insert(disclose(entry));
  entryCount.increment(1);
}
```

**No witnesses, no private state, no unshielded or shielded token I/O** — so this
is not a recurrence of midnightntwrk/midnight-js#667, whose NIGHT-token path was
fixed in `c0271bad` / `cead64b0`; those fixes are present in the ledger-v9
1.0.0-rc.3 we run. It is, however, the same function and the same field, which is
why we reference it.

Manually, without the harness:

1. Deploy the contract above.
2. Call `appendEntry` N times inside a single `withContractScopedTransaction`
   scope (N = 2, 3, 4 …), producing one transaction with N fallible segments.
3. Submit, and repeat — the failure is intermittent, so one success proves nothing.

N = 1 never fails. The failure rate rises steeply with N. Client-side state
threading is not the issue: `TransactionContextImpl`'s
`[MergeUnsubmittedCallTxData]` advances the scope's cached contract state after
each call, and we confirmed each proof is built against the tree its predecessors
left behind. Proof validity is not the failure here; the declared gas budget is.

### Actual behavior

The transaction is accepted, guaranteed segments succeed, and **at least one
fallible segment fails `OutOfGas`** — a _different_ segment each time, never
consistently the first or the last, and more of them as N grows.

The node's log is the only place the reason appears (`docker compose logs node | grep 'Non
guaranteed part'`). Two transactions from the attached repro, at N = 2 and N = 4:

```
Non guaranteed part of the transaction failed ... segments =
  {0: Ok(()), 1: Ok(()),
   17162: Err(Transcript(Execution(OutOfGas))),
   64929: Ok(())}
```

```
Non guaranteed part of the transaction failed ... segments =
  {0: Ok(()), 1: Ok(()),
   23141: Err(Transcript(Execution(OutOfGas))),
   35773: Ok(()), 38982: Ok(()), 41680: Ok(())}
```

Client-side, all midnight-js surfaces is `SegmentFail` in the finalized transaction's
`segmentStatusMap`, with the fee paid exactly as estimated:

```json
{
  "segments": {
    "0": "SegmentSuccess",
    "1": "SegmentSuccess",
    "23141": "SegmentFail",
    "35773": "SegmentSuccess",
    "38982": "SegmentSuccess",
    "41680": "SegmentSuccess"
  },
  "paidFees": "349738627638519",
  "estimatedFees": "349738627638519"
}
```

One clean run of the attached repro on each line — five transactions at each call count, one
freshly deployed contract, distinct random leaves throughout, same contract source both sides:

| calls per transaction | ledger-9: transactions with a failed segment | ledger-8 |
| --------------------- | -------------------------------------------- | -------- |
| 1                     | 0 of 5                                       | 0 of 5   |
| 2                     | 0 of 5                                       | 0 of 5   |
| 3                     | 2 of 5                                       | 0 of 5   |
| 4                     | 4 of 5                                       | 0 of 5   |
| 10                    | 5 of 5                                       | 0 of 5   |

At N = 10 it is routinely _several_ segments, not one — the worst in that run lost 8 of the
10 calls in a single transaction (`Ok` and `Err(Transcript(Execution(OutOfGas)))` abbreviated):

```
segments = {0: Ok, 1: Ok, 2659: Err, 15786: Err, 20402: Ok, 23789: Err, 36416: Err,
            40783: Err, 42252: Ok, 50088: Err, 57538: Err, 63352: Err}
```

N = 2 came up 0 of 5 in that particular run and is **not** safe: an earlier run of the same
script hit it 1 time in 2, and the N = 2 log line quoted above is from that run. The same shape
was measured on a larger contract (2 of 13 at N = 2, 6 of 10 at N = 3), so this is neither
specific to the trivial circuit above nor reliable enough to bound by a call count.

`paidFees` always equals `estimatedFees` — the fee is paid exactly as estimated,
so the fee _estimate_ is not what is wrong; what the fee buys is.

**Raising chain limits does not help, and cannot.** We raised every block limit 5×
on the running chain via the toolkit's `update-ledger-parameters` (`read_time` and
`compute_time` 2s → 10s; `block_usage`, `bytes_written`, `bytes_churned` 2e12 →
1e13), confirmed applied in the node's `OverwriteParameters` log. The next batch,
one minute later, failed identically. Block limits gate what fits in a block and
never enter the per-transcript budget — `Transcript.gas` is _"the execution budget
for this transcript, which `program` must not exceed"_, fixed client-side at build
time by `partitionTranscripts(preTranscripts, ledgerParameters)` and merely
enforced by the node.

No _configuration_ buys headroom either: `TransactionCostModel`'s
`guaranteed_factor` / `fallible_factor` are both `FixedPoint(1)`, no
`update-ledger-parameters` flag touches the cost model (every flag is a block
limit, fee price, bridge setting or TTL), and the JS binding's
`TransactionCostModel` exposes only `runtimeCostModel` / `baselineCost` / fee
overheads, all read-only.

**Overriding the declared budget by hand does fix it, which bounds the shortfall.**
Patching the one line of `@midnight-ntwrk/compact-js` that consumes
`partitionTranscripts`' output, so that each call's **fallible** `Transcript.gas` is
multiplied by 4 before the call prototype is built, makes multi-call transactions
land reliably on this same pairing. The repro ships that patch as
`patch-gas-factor.mjs`: N = 10, which fails 5 of 5 unpatched, is 3 of 3 clean with it
(`node patch-gas-factor.mjs && BATCH_SIZES=10 node repro.mjs`). The same override also
cleans up a two-call cross-contract transaction (one contract's circuit invoking
another's, which is multi-call by construction and cannot be split into one call per
transaction). So the gap between what
`partition_transcripts` measures and what execution actually costs is real but bounded
well under 4x, and it is the _fallible_ budget that is short.

**The guaranteed budget cannot absorb it.** Inflating both halves 4x is rejected at
mempool admission rather than failing in execution:

```
Transaction malformed: exceeded the maximum time to dismiss for transaction size;
this transaction would take 29.325ms to dismiss, but given its size of 11919 bytes,
it may take at most 23.838ms
-> Malformed(FeeCalculation(OutsideTimeToDismiss))
```

presumably the same `min_time_to_dismiss` interaction noted at the end of this
report. Whatever the fix, the headroom has to come from the fallible side.

### Expected behavior

A transaction carrying N calls either succeeds or fails for a reason other than
"the budget the client itself declared was too small". `Transcript.gas` should
cover the program it is attached to regardless of how many other calls share the
transaction.

---

### What we checked in the source (`ledger-9.1.0.0-rc.3`)

Reading the tag we run, to narrow where the gap can be — we could **not** pin down
the mechanism, and would rather report that honestly than guess:

- `construct.rs`, `split_at` sets `gas: res.gas_heuristic(params, false, 0)`, and
  with `include_external = false` `gas_heuristic` returns exactly
  `self.gas_cost * 1.2`. So a transcript's declared budget is a **flat 1.2× over
  that call's own measured run**, with no term for how many other calls share the
  transaction or where in the sequence this one sits.
- `structure.rs` is explicit that this is enforced strictly: _"During execution,
  the declared cost (A `RunningCost`) is checked against the real cost at each
  operation, and aborted if it exceeds it"_.
- `semantics.rs`'s `apply_actions` threads state across calls in an intent — each
  call gets `QueryContext::new(cstate.data.clone(), …)` from `res`, which carries
  the previous call's result. So on-chain, call _k_ does execute against the state
  calls `0..k` left, which is also what the client threads client-side. We could
  not find an obvious state divergence to blame.
- `spec/cost-model.md` describes read time as _modelled_ per operation (batched vs
  synchronous 4k reads chosen by the operation), not measured from live cache
  state, so warm-vs-cold caches should not move the number either.

So on paper the client's measurement and the node's execution should agree, and
1.2× should be slack rather than the whole margin. Empirically they disagree, for
one call out of N, only when N > 1. Something in the multi-call path costs more on
execution than `partition_transcripts` measured for it, and we don't have the
instrumentation to say what.

The most useful next datum is presumably the actual `RunningCost` at the aborting
operation versus the `Transcript.gas` declared for that call — if that can be
surfaced (or if there's an existing way to dump it we've missed), we're happy to
run it on the attached repro and report back.

### Suggested direction

If the delta turns out to be inherent to multi-call transactions rather than a
plain bug, the flat 1.2× in `gas_heuristic` is the natural place to carry it — a
term that grows with the call's index in the transaction, or a `fallible_factor`
default above 1, would both restore headroom, and our 4× override suggests the
margin needed is small. It has to land on the fallible transcripts: the same
override applied to the guaranteed ones is refused at admission
(`OutsideTimeToDismiss`, above), since those are budgeted against transaction size.
Note also that `spare_min_time_to_dismiss` in `partition_transcripts` goes negative
once several calls' `guaranteed_budget`s plus `tx_reserve` exceed
`min_time_to_dismiss`, which is consistent with our calls all landing in the
fallible section; we mention it in case the two interact.

Our workaround is the client-side override described above (fallible `Transcript.gas`
x4). Before we found it, it was one transaction per call — a block wait per call, and
not available at all for a cross-contract call, where the several calls are one
transaction by construction.
