/*
 * Ledger-8 twin of ../setup.mjs: fetches compactc 0.31.1 (the ledger-8 lane's compiler, language
 * version 0.23.0) and compiles the SAME `../commitlog.compact` this repro's ledger-9 side uses.
 * One contract source, two compilers, two ledger lines -- which is what makes the comparison
 * mean anything. Kept as its own file rather than parameterising the parent: each half has to
 * stand alone when this directory is copied out of the repo.
 *
 * Idempotent: an already-installed compiler is reused, and recompiling is harmless.
 *
 *   node setup.mjs        # or: npm run setup
 */
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const VERSION = process.env.COMPACTC_VERSION ?? 'v0.31.1';
const DEST = path.resolve(import.meta.dirname, '.compactc');
const OUT = path.resolve(import.meta.dirname, 'managed', 'commitlog');
const SRC = path.resolve(import.meta.dirname, '..', 'commitlog.compact');

const platform = process.platform === 'darwin' ? 'darwin' : 'unknown-linux-musl';
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const asset = `compactc_${VERSION}_${arch}-${platform}.zip`;
const url = `https://github.com/midnightntwrk/compact/releases/download/compactc-${VERSION}/${asset}`;

const exists = async (p) =>
  access(p)
    .then(() => true)
    .catch(() => false);

if (await exists(path.join(DEST, 'compactc'))) {
  console.log(`compactc ${VERSION} already present in ${DEST}`);
} else {
  // `unzip` rather than a dependency: this repro's package.json is the SDK pairing under test
  // and nothing else, and every platform the compiler ships for has it.
  await run('unzip', ['-v']).catch(() => {
    throw new Error('`unzip` is required (apt install unzip / brew install unzip).');
  });
  await mkdir(DEST, { recursive: true });
  const zip = path.join(DEST, asset);
  console.log(`downloading ${asset} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  await run('unzip', ['-oq', zip, '-d', DEST]);
  await rm(zip);
  for (const bin of ['compactc', 'compactc.bin', 'zkir', 'zkir-v3']) {
    // Not every build ships every binary.
    await chmod(path.join(DEST, bin), 0o755).catch(() => {});
  }
  console.log(`compactc ${VERSION} installed to ${DEST}`);
}

console.log('compiling commitlog.compact ...');
const { stdout, stderr } = await run(path.join(DEST, 'compactc'), [SRC, OUT]);
process.stdout.write(stdout);
process.stderr.write(stderr);
console.log(`compiled to ${OUT}`);
