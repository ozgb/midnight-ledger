/**
 * Demo hack: multiply the gas budget the SDK declares for the fallible half of every contract
 * call.
 *
 * `partitionTranscripts` bakes each call's execution budget into its transcript **client-side**,
 * at a flat 1.2x over the cost it measured for that call in isolation (the report beside this repro).
 * When several calls share a transaction -- a batch of calls to one contract, or any
 * cross-contract call, which is two calls by construction and cannot be split -- at least one
 * of them executes above its own measurement and the node aborts it
 * `Transcript(Execution(OutOfGas))`. The node only ever checks real cost <= declared cost, so
 * declaring more is safe: the transaction pays a larger fee for headroom it may not use.
 *
 * Neither the multiplier nor the cost model is reachable through any SDK or chain setting (see
 * the bug entry), so this rewrites the one line of `@midnight-ntwrk/compact-js` where the budget
 * is set. Idempotent (reverts any previous patch first, so the factor can be re-tuned);
 * `MIDNIGHT_GAS_FACTOR` is read at transaction-build time for server-side processes, and the
 * browser gets the compiled-in default.
 *
 * **Only the fallible transcript is inflated.** The guaranteed one is what the node budgets
 * against transaction size at mempool admission, and inflating it is rejected outright --
 * measured, 4x on a two-call cross-contract transaction: `Transaction malformed: exceeded the maximum time to dismiss
 * for transaction size; this transaction would take 29.325ms to dismiss, but given its size of
 * 11919 bytes, it may take at most 23.838ms` -> `Malformed(FeeCalculation(OutsideTimeToDismiss))`.
 * That is also the half that has never failed: every observed `OutOfGas` is a fallible segment
 * ("Non guaranteed part of the transaction failed").
 *
 * Patches node_modules, so re-run it after any `npm install`/`npm ci`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TARGETS = [
  'node_modules/@midnight-ntwrk/compact-js/dist/esm/effect/ContractExecutable.js',
  'node_modules/@midnight-ntwrk/compact-js/dist/cjs/effect/ContractExecutable.js',
];
const DEFAULT_FACTOR = 4;

// `const partitioned = <call to partitionTranscripts(...)>;` in `partitionAllTranscripts` -- the
// esm and cjs builds differ only in how the ledger import is spelled.
const SITE = /^(\s*)const partitioned = (.*partitionTranscripts\)?\(.*\));$/m;
// This script's own previous output, so re-running re-applies rather than skips.
const APPLIED_HELPERS =
  /^[^\n]*PATCHED by patch-gas-factor\.mjs[^\n]*\n[^\n]*__gasFactor = [^\n]*\n[^\n]*__gasInflate = [^\n]*\n/m;
const APPLIED_SITE = /^(\s*)const partitioned = \((.*)\)\.map\(\(\[g, f\][^\n]*\);$/m;

const helpers = (indent) =>
  [
    `${indent}// PATCHED by patch-gas-factor.mjs -- see the report beside this repro.`,
    `${indent}const __gasFactor = (() => { try { return BigInt(process.env.MIDNIGHT_GAS_FACTOR ?? ${DEFAULT_FACTOR}); } catch { return ${DEFAULT_FACTOR}n; } })();`,
    `${indent}const __gasInflate = (t) => t === undefined ? t : ({ ...t, gas: { readTime: t.gas.readTime * __gasFactor, computeTime: t.gas.computeTime * __gasFactor, bytesWritten: t.gas.bytesWritten * __gasFactor, bytesDeleted: t.gas.bytesDeleted * __gasFactor } });`,
  ].join('\n');

for (const target of TARGETS) {
  const original = readFileSync(target, 'utf8')
    .replace(APPLIED_HELPERS, '')
    .replace(APPLIED_SITE, (_line, indent, call) => `${indent}const partitioned = ${call};`);
  const match = SITE.exec(original);
  if (match === null) throw new Error(`gas factor: no partitionTranscripts call site in ${target}`);
  const [line, indent, call] = match;
  writeFileSync(
    target,
    original.replace(
      line,
      `${helpers(indent)}\n${indent}const partitioned = (${call}).map(([g, f]) => [g, __gasInflate(f)]);`,
    ),
  );
  console.log(`gas factor: patched ${target} (fallible budget x${DEFAULT_FACTOR} by default)`);
}
