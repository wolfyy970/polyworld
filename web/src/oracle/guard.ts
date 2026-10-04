/**
 * The frozen-golden write guard (task t_37bf7212).
 *
 * **The rule.** `oracle/<scenario>/run/**` is frozen: it is the contract the whole port is graded
 * against, and its `run/manifest.sha256` is the only listing of it that means anything. Nothing
 * except the recorder (`tools/record_oracle.py`, i.e. `run_parity.sh <scenario> --record`) may
 * ever write a byte there. Everything a lane produces is a **candidate**: it stages under
 * `oracle/_t_*` (the prefix `.gitignore` reserves) or `$TMPDIR`, and it is installed — if it is
 * installed at all — by a stage → verify → move, never by building over the golden in place.
 *
 * **Why this module exists (measured, 2026-09-29 00:51–01:03 and reproduced at 01:15:46).**
 * A lane's acceptance pass ran `npx vitest run` in a git worktree whose `oracle/<scenario>/run`
 * was a **symlink into the canonical golden** (that is how a worktree gets the gitignored
 * goldens). `tests/parity-runner.test.ts` copies the golden and then perturbs the copy —
 * `cpSync(GOLDEN, dest, { recursive: true })`, then `rmSync(<copy>/run/events/carry.log)`,
 * `writeFileSync(<copy>/run/population.txt)`, `writeFileSync(<copy>/run/movie.pmv)` and
 * `reGzip()`, which walks `<copy>/run/**` and rewrites every `.gz` with node's zlib. `cpSync`
 * does **not** dereference by default, so the "copy" contained a symlink to the golden and every
 * one of those perturbations landed in the frozen tree: 97/225 files verified afterwards, and
 * `run/events/carry.log` (deleted) and `run/brain/anatomy/brainAnatomy_10_birth.txt.gz`
 * (deleted, then reported MISSING) were gone. Six test files went red for every lane that read
 * the golden in that window — through no fault of their own.
 *
 * So the guard is deliberately **symlink-aware**: a path is judged by the real path it resolves
 * to (`realpath` of its longest existing prefix), not by its spelling. A worktree's symlinked
 * `oracle/<s>/run` is the golden, and is refused as a write target, as a candidate, and as a
 * staging root.
 *
 * **Judged by the manifest, not only by the oracle root (round 2).** A lane's worktree reaches the
 * canonical goldens by symlinking the per-scenario `run` dirs (`ln -sfn <canonical>/oracle/<s>/run
 * <worktree>/oracle/<s>/run`, measured in t_4bb10112's log) — a path that resolves *outside* the
 * oracle root the worktree hands the guard, so an oracle-relative test cannot see it and the
 * incident's shape would go unguarded exactly where it happened. `run/manifest.sha256` is the
 * harness's own listing of a golden, so a resolved `run/` dir that holds one is treated as a golden
 * wherever it lives (outside `$TMPDIR` and any `_t_*` staging path, which are candidates a lane may
 * perturb freely).
 */

import fs, { existsSync, lstatSync, realpathSync } from 'fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The staging prefix `oracle/_t_*` that `.gitignore` reserves for candidates. */
export const STAGING_PREFIX = '_t_';

/** The harness's own listing of a golden — its presence makes a `run/` tree a golden. */
export const MANIFEST_NAME = 'manifest.sha256';

/** Raised for every refused golden write/candidate. Nothing is written when this is thrown. */
export class GoldenWriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenWriteRefused';
  }
}

/**
 * Where the goldens live: `POLYWORLD_ORACLE_ROOT` (a git worktree lane points this at the
 * canonical tree) or `<repo>/oracle`. Read per call — a test may point it at a fixture.
 */
export function oracleRoot(): string {
  const override = process.env.POLYWORLD_ORACLE_ROOT;
  return override !== undefined && override.length > 0 ? path.resolve(override) : path.join(REPO_ROOT, 'oracle');
}

/**
 * The real path of `target`, resolving symlinks as far as it exists and keeping the rest as
 * written. `realpath` alone cannot be used: a write target usually does not exist yet, and the
 * interesting case is exactly the *directory* that does (a `run` symlinked into the golden).
 */
export function resolveExisting(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      let real = current;
      try {
        real = realpathSync(current);
      } catch {
        /* a dangling symlink has no real path: its own spelling is the best we have */
      }
      return path.join(real, ...[...tail].reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...tail.reverse());
    tail.push(path.basename(current));
    current = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The oracle-relative segments of `target` (`[]` when it is outside the oracle root). */
function oracleRelative(target: string): string[] {
  const real = resolveExisting(target);
  const oracle = resolveExisting(oracleRoot());
  if (!isInside(real, oracle)) return [];
  const rel = path.relative(oracle, real);
  return rel === '' ? [] : rel.split(path.sep);
}

/** Is `target` under an `oracle/_t_*` staging dir, or under `$TMPDIR`? */
export function isStagedPath(target: string): boolean {
  const segments = oracleRelative(target);
  if (segments.length > 0) return segments[0]!.startsWith(STAGING_PREFIX);
  return isInside(resolveExisting(target), tmpdirRealPath());
}

/**
 * `$TMPDIR`'s real path. Memoized: the tripwire consults it for every write target.
 */
let tmpdirReal: string | null = null;
function tmpdirRealPath(): string {
  if (tmpdirReal === null) tmpdirReal = resolveExisting(os.tmpdir());
  return tmpdirReal;
}

/**
 * Does `dir` hold the harness's own listing of a golden? **Positive results only are memoized** (a
 * golden's manifest is static once it is on disk), so the tripwire's per-write cost is one `stat`
 * for the golden case and a directory that is still being built is never mistaken for a finished
 * one — a probe that ran before a test wrote its own manifest must not be remembered as a miss.
 */
const manifestProbe = new Set<string>();
function holdsManifest(dir: string): boolean {
  if (manifestProbe.has(dir)) return true;
  let yes = false;
  try {
    yes = existsSync(path.join(dir, MANIFEST_NAME));
  } catch {
    yes = false;
  }
  if (yes) manifestProbe.add(dir);
  return yes;
}

/**
 * The golden `run/` dir a **resolved** path lives in, found by the manifest marker rather than by
 * the oracle root. `run/manifest.sha256` is the only listing of a golden that means anything, and
 * a lane's worktree reaches the canonical golden through a symlink that resolves *outside* the
 * configured oracle root — `<worktree>/oracle/<scenario>/run -> <canonical>/oracle/<scenario>/run`
 * (`POLYWORLD_ORACLE_ROOT` unset), which is the shape the incident ran in and which no
 * oracle-relative test can see. Bounded walk that only stats when a path segment is literally
 * `run`, so the tripwire's per-write cost stays negligible.
 */
function resolvedGoldenRunDir(resolved: string): string | null {
  if (path.basename(resolved) === 'run' && holdsManifest(resolved)) return resolved;
  let dir = path.dirname(resolved);
  for (let hops = 0; hops < 8; hops++) {
    if (path.basename(dir) === 'run' && holdsManifest(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The golden scenario `target` resolves into, or `null` when it is not inside one. */
export function goldenScenarioOf(target: string): string | null {
  const segments = oracleRelative(target);
  if (segments.length === 0) return null;
  const scenario = segments[0]!;
  if (scenario.startsWith(STAGING_PREFIX)) return null;
  return scenario;
}

/**
 * The golden this target would write to — its scenario and the `run/…` path inside it — or
 * `null` when the write is allowed. This is the single predicate the guard, the harness and the
 * test tripwire all consult.
 */
export function goldenWriteTarget(target: string): { scenario: string; rel: string; scenarioDir: string; runDir: string } | null {
  const segments = oracleRelative(target);
  if (segments.length > 0) {
    const [scenario, ...rest] = segments;
    if (scenario === undefined || scenario.startsWith(STAGING_PREFIX)) return null;
    const scenarioDir = path.join(oracleRoot(), scenario);
    const runDir = path.join(scenarioDir, 'run');
    // `<oracle>/<scenario>` itself (mkdir/rm of the golden's own dir) is a golden write; so is
    // anything under its `run/`.
    if (rest.length === 0 || rest[0] !== 'run') return null;
    return { scenario, rel: rest.slice(1).join('/'), scenarioDir, runDir };
  }

  // Not inside the configured oracle root — but it may still be a golden: a `run/` dir holding a
  // manifest *is* one wherever it lives (t_37bf7212 round 2 — a lane's worktree symlinks
  // `oracle/<scenario>/run` at the canonical golden, which resolves outside the root it hands the
  // guard, and the oracle-relative test above cannot see it). Deliberately staged trees — any
  // `_t_*` path segment, or anything under `$TMPDIR` — are candidates a lane may perturb freely.
  const resolved = resolveExisting(target);
  if (isInside(resolved, tmpdirRealPath())) return null;
  if (resolved.split(path.sep).some((segment) => segment.startsWith(STAGING_PREFIX))) return null;
  const runDir = resolvedGoldenRunDir(resolved);
  if (runDir === null) return null;
  const scenarioDir = path.dirname(runDir);
  return {
    scenario: path.basename(scenarioDir),
    rel: path.relative(runDir, resolved).split(path.sep).join('/'),
    scenarioDir,
    runDir,
  };
}

/** Throw unless `target` may be written: i.e. unless it is not a golden path. */
export function assertNotGoldenWrite(target: string, what: string): string {
  const hit = goldenWriteTarget(target);
  if (hit !== null) {
    throw new GoldenWriteRefused(
      `${what}: refusing to write the frozen golden ${path.join(hit.runDir, hit.rel)} — ` +
        `oracle/${hit.scenario}/run/** is the contract and only \`--record\` may write it. ` +
        'Stage the tree under oracle/_t_*/ or $TMPDIR instead (src/oracle/guard.ts).',
    );
  }
  return target;
}

/** Is `target` a path under a golden `run/` tree (or its scenario dir) — i.e. a write target? */
export function isGoldenPath(target: string): boolean {
  return goldenWriteTarget(target) !== null;
}

/** The golden a call would touch, and how it touches it. Built by `goldenWriteHit`. */
export interface GoldenWriteHit {
  /** The `node:fs` entry point that was called. */
  readonly name: string;
  /** The path the call names. */
  readonly target: string;
  /** The golden the call would write (`write`), or the namespace it would delete (`tree`). */
  readonly runDir: string;
  readonly scenario: string;
  readonly rel: string;
  /** `true` for a recursive removal that would delete the goldens under `target`. */
  readonly tree: boolean;
}

/**
 * Is this call a **recursive removal of a tree**? `rm`/`rmdir` with `{ recursive: true }` — the one
 * shape where the call's *argument* is not a write target at all, but its *tree* is.
 */
function isRecursiveRemoval(name: string, args: readonly unknown[]): boolean {
  const base = name.replace(/^promises\./, '').replace(/Sync$/, '');
  if (base !== 'rm' && base !== 'rmdir') return false;
  const options = args[1];
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { recursive?: unknown }).recursive === true
  );
}

/**
 * Would removing `target`'s tree delete a golden? Only the *namespace* rule is needed here, and it
 * is deliberately cheap (no second walk of a tree the removal is about to walk itself): a recursive
 * removal of anything **inside the configured oracle root** is refused unless it is a `_t_*`
 * staging dir — `oracle/<scenario>` (whose `run/` holds the golden), the oracle root itself, a
 * superset of them. Everything outside the namespace (a lane's `$TMPDIR` or `oracle/_t_*` candidate
 * tree) is the caller's to delete.
 *
 * Why the removal entry points need this at all: node ≥ 24 implements `rm(recursive)` through
 * internal bindings, so no path inside the walk re-enters the net (`unlinkSync`/`rmdirSync` are
 * wrapped, and never called) — measured, node 22.22.2 refused the wipe, node 24.21.0 and 26.7.0
 * deleted the tree. An *ancestor* of the oracle root (a whole checkout) is out of scope for this
 * cheap rule: the project's own creators refuse a golden as a staging root before they start, and
 * the net's job here is the accidental `rm -r` of the namespace the caller is standing in.
 */
function removalReachesGolden(target: string): boolean {
  const resolved = resolveExisting(target);
  const oracle = resolveExisting(oracleRoot());
  if (!isInside(resolved, oracle)) return false;
  const rel = path.relative(oracle, resolved);
  if (rel === '') return true;
  return !rel.split(path.sep)[0]!.startsWith(STAGING_PREFIX);
}

/**
 * The golden a `node:fs` call would write, or `null` when the call may proceed. **The one predicate
 * both halves of the net call** — `installGoldenWriteTripwire` below and the `node:fs`/`fs` alias
 * (`tests/setup/fsGuard.ts`) — so the two cannot drift; they had (t_06238505: `rmSync`/`rm` were in
 * neither list, and the removal's coverage depended on which engine's `rm` re-entered the public
 * `unlinkSync`/`rmdirSync` the net does wrap).
 */
export function goldenWriteHit(name: string, args: readonly unknown[]): GoldenWriteHit | null {
  const removal = isRecursiveRemoval(name, args);
  for (const target of writeTargetsOf(name, args)) {
    if (removesLinkOnly(name, target)) continue;
    const hit = goldenWriteTarget(target);
    if (hit !== null) return { name, target, tree: false, ...hit };
    if (removal && removalReachesGolden(target)) {
      const resolved = resolveExisting(target);
      return {
        name,
        target,
        tree: true,
        scenario: path.basename(resolved),
        rel: '',
        runDir: path.join(resolved, 'run'),
      };
    }
  }
  return null;
}

/** The refusal message for a hit — worded once, for both halves of the net. */
export function goldenWriteMessage(what: string, hit: GoldenWriteHit): string {
  const staging =
    'Only `run_parity.sh <scenario> --record` may write a golden; stage the tree under oracle/_t_* ' +
    'or $TMPDIR instead (src/oracle/guard.ts, PARITY.md "The golden contract").';
  if (hit.tree) {
    return (
      `${what}: ${hit.name}() refused — removing ${hit.target} recursively would delete the frozen ` +
      `goldens under it (oracle/${hit.scenario}/run/**, e.g. ${path.join(hit.runDir, hit.rel)}). ` +
      'Node >= 24 walks `rm` through internal bindings, so nothing inside the walk re-enters this ' +
      `net. ${staging}`
    );
  }
  return (
    `${what}: ${hit.name}() refused on the frozen golden ${path.join(hit.runDir, hit.rel)} ` +
    `(oracle/${hit.scenario}/run/**). ${staging}`
  );
}

/**
 * Throw unless `root` may be used as a **staging / candidate / export root** — the directory a
 * tool is about to build a run tree under, or wipe.
 *
 * Refused: the oracle root itself, any `oracle/<scenario>` dir that holds a golden, a golden
 * `run/` dir, and anything *inside* one (which is what a symlinked worktree resolves to). Allowed
 * and expected: `oracle/_t_*` and `$TMPDIR`.
 */
export function assertUsableStagingRoot(root: string, what: string): string {
  const resolved = resolveExisting(root);
  const oracle = resolveExisting(oracleRoot());
  const segments = oracleRelative(root);

  const isGoldenDir = segments.length > 0 && !segments[0]!.startsWith(STAGING_PREFIX);
  const isOracleRoot = resolved === oracle;
  const hit = goldenWriteTarget(root);
  // A root whose `run/` child resolves into a golden is the worktree shape the incident came
  // from (`<worktree>/oracle/<scenario>/run` -> the canonical golden): even though the root itself
  // is an ordinary directory, everything written "under the copy" lands in the frozen tree.
  const runChild = path.join(resolveExisting(root), 'run');
  const childSegments = oracleRelative(runChild);
  const childIsGolden =
    goldenWriteTarget(runChild) !== null ||
    (childSegments.length > 0 && !childSegments[0]!.startsWith(STAGING_PREFIX));
  if (isGoldenDir || isOracleRoot || hit !== null || childIsGolden) {
    const why = hit !== null ? `oracle/${hit.scenario}/run is a frozen golden` : `${resolved} is the oracle's own namespace`;
    throw new GoldenWriteRefused(
      `${what}: refusing ${root} as a staging root — ${childIsGolden && hit === null && !isGoldenDir && !isOracleRoot ? `${runChild} resolves into a frozen golden` : why}. ` +
        'A candidate tree must stage under oracle/_t_* or $TMPDIR and (if it is installed at all) ' +
        'be installed by a stage -> verify -> move, never built over the golden in place ' +
        '(.gitignore reserves oracle/_t_*; src/oracle/guard.ts).',
    );
  }
  return root;
}

/** Refuse a browser/node candidate root (`POLYWORLD_BROWSER_CANDIDATE_ROOT` & friends). */
export function assertUsableCandidateRoot(root: string, what: string): string {
  return assertUsableStagingRoot(root, what);
}

/**
 * The `node:fs` entry points the tripwire wraps: the sync write/removal calls
 * (`SYNC_WRAPPERS`) and the async ones, promise-and-callback shaped (`ASYNC_WRAPPERS`).
 *
 * **One list for both halves of the net** — `installGoldenWriteTripwire` below and
 * `tests/setup/fsGuard.ts` (which covers the `node:fs`/`fs` import specs) both read these, so the
 * two halves cannot drift. They had (t_06238505): `rmSync`/`rm` were wrapped by neither, and the
 * tripwire only *looked* like it covered them because node ≤ 22 implemented `rmSync(recursive)`
 * by re-entering the public per-entry functions (`unlinkSync`/`rmdirSync`) the net does wrap.
 * Measured with `tests/oracle-guard.test.ts` (both halves of the test identical, one engine per
 * run): node 22.22.2 refuses the removal, node 24.21.0 and node 26.7.0 **delete the tree** —
 * node ≥ 24 does the walk through internal bindings and never re-enters the public entry points,
 * so the incident's own wipe (`rmSync` of a path that resolves into the golden) was unguarded on
 * every engine a login shell resolves to. The removal entry points are therefore wrapped at the
 * call, where no engine's internal walk can bypass them; `removesLinkOnly` still exempts the
 * removal of a link (that is how a lane cleans its worktree's `oracle/<s>/run` symlink).
 *
 * The list is the union of what the two halves guarded before they were merged: `linkSync`/
 * `symlinkSync` were the alias's (its `writeTargetsOf` already reads a link call's *link* argument,
 * so `symlinkSync(golden, elsewhere)` stays legitimate while creating a link inside a golden does
 * not), `rmSync`/`rm` were nobody's.
 */

export const SYNC_WRAPPERS = [
  'writeFileSync',
  'appendFileSync',
  'writeSync',
  'truncateSync',
  'unlinkSync',
  'rmdirSync',
  'rmSync',
  'linkSync',
  'symlinkSync',
  'mkdirSync',
  'renameSync',
  'copyFileSync',
  'cpSync',
  'createWriteStream',
  'openSync',
  'openAsBlobSync',
] as const;

/** The async (promise/callback) entry points, wrapped on `fs` and on `fs.promises`. */
export const ASYNC_WRAPPERS = [
  'writeFile',
  'appendFile',
  'truncate',
  'unlink',
  'rmdir',
  'rm',
  'mkdir',
  'rename',
  'copyFile',
  'cp',
  'link',
  'symlink',
  'open',
] as const;

/**
 * The arguments of a `node:fs` entry point that name a **write target** (as opposed to a source
 * being read). Shared by the tripwire and by `tests/setup/fsGuard.ts` so the two halves of the net
 * cannot drift: `symlinkSync(golden, elsewhere)` is legitimate (that is how a worktree gets the
 * goldens), while `renameSync(goldenFile, …)` and every `…Sync(target, …)` write are not.
 */
export function writeTargetsOf(name: string, args: readonly unknown[]): string[] {
  const pathArg = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (value instanceof URL) return fileURLToPath(value);
    if (Buffer.isBuffer(value)) return value.toString();
    return null;
  };
  const only = (...values: (string | null)[]): string[] => values.filter((v): v is string => v !== null);
  const base = name.replace(/Sync$/, '');
  switch (base) {
    case 'link':
    case 'symlink':
      return only(pathArg(args[1]));
    case 'rename':
      return only(pathArg(args[0]), pathArg(args[1]));
    case 'copyFile':
    case 'cp':
      return only(pathArg(args[1]));
    case 'open':
      return opensForWrite(args[1]) ? only(pathArg(args[0])) : [];
    default:
      return only(pathArg(args[0]));
  }
}

/** Is an `open`/`openSync` flag a write mode? (The one entry point that can also read.) */
export function opensForWrite(flags: unknown): boolean {
  if (flags === undefined) return true;
  if (typeof flags === 'number') {
    const bits = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
    return (flags & bits) !== 0;
  }
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return true;
}

/**
 * The `node:fs` entry points whose *target* is dropped rather than written, when that target is
 * itself a link.
 */
const LINK_REMOVALS = new Set(['unlink', 'rmdir', 'rm', 'remove', 'rename']);

/**
 * Is this call only **removing a link**? `unlinkSync`/`rmdirSync`/`rm` on a symlink (and a `rename`
 * of one) drops the link, not what it points at: `symlinkSync(golden, elsewhere)` is the legitimate
 * way a lane's worktree gets the goldens, and Node's own `rmSync(dir, { recursive: true })` walks a
 * tree by calling exactly those primitives per entry — so without this exemption a lane could not
 * clean its worktree's `oracle/<s>/run` links, and not even a test's own `$TMPDIR` work dir, once
 * one of them pointed at a golden. Writes *through* a link still resolve to the golden and are still
 * refused; only the link's own entry is exempt.
 */
export function removesLinkOnly(name: string, target: string): boolean {
  const base = name.replace(/^promises\./, '').replace(/Sync$/, '');
  if (!LINK_REMOVALS.has(base)) return false;
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface TripwireReport {
  /** The `node:fs` functions that were wrapped. */
  readonly patched: readonly string[];
  /** How many writes the tripwire has refused since it was installed. */
  refusals(): number;
  /** The last refused target, with the reason. */
  lastRefusal(): { target: string; message: string } | null;
}

let tripwire: TripwireReport | null = null;

/**
 * Install the filesystem tripwire: every write into a golden `run/` tree throws
 * `GoldenWriteRefused` instead of landing — and so does a **recursive removal** of the namespace
 * that holds it (`rmSync`/`rm` with `{recursive: true}`, judged at the call: since node ≥ 24 the
 * removal's tree walk never re-enters these wrappers, t_06238505).
 *
 * This is the runtime half of the guard — the half that catches a *new* writer nobody has
 * thought of (a probe script, a new test, a lane's harness), including one that only reaches the
 * golden through a symlink. It is installed by `tests/setup/oracleTripwire.ts` for the whole
 * vitest run, and a test asserts that it is installed and that it fires.
 *
 * Idempotent: a second call returns the same report.
 */
export function installGoldenWriteTripwire(): TripwireReport {
  if (tripwire !== null) return tripwire;

  const patched: string[] = [];
  let refusals = 0;
  let last: { target: string; message: string } | null = null;

  const check = (name: string, args: readonly unknown[]): void => {
    const hit = goldenWriteHit(name, args);
    if (hit === null) return;
    refusals += 1;
    const message = goldenWriteMessage('golden tripwire', hit);
    last = { target: hit.target, message };
    throw new GoldenWriteRefused(message);
  };

  /**
   * Replace `name` **on the builtin's own object**, capturing the original first (the in-place
   * shape both lists use). Reached by every caller that holds the module object itself —
   * `import fs from 'fs'` / `import fs from 'node:fs'` and `fs.<name>` at the call site — which is
   * the spelling this repo's guard internals and `tests/oracle-guard.test.ts` already use.
   */
  const wrapBuiltin = (name: string): void => {
    const original = (fs as unknown as Record<string, unknown>)[name];
    if (typeof original !== 'function') return;
    patched.push(name);
    (fs as unknown as Record<string, unknown>)[name] = function wrapped(this: unknown, ...args: unknown[]) {
      check(name, args);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  };

  for (const name of SYNC_WRAPPERS) wrapBuiltin(name);

  // …and the builtin's **own** top-level async/callback members (t_833bee5f). They were wrapped on
  // `fs.promises` only, so with the tripwire armed and no alias the callback form went straight
  // through: measured, node 22.22.2, fixture oracle — `fs.rm(<golden run dir>, {recursive:true}, cb)`
  // deleted the tree, `fs.unlink(<golden file>, cb)` deleted the file and
  // `fs.writeFile(<golden file>, …, cb)` overwrote it, while `fs.rmSync`/`fs.promises.rm` were
  // refused. The refusal stays a **synchronous** `GoldenWriteRefused` (the callback never runs) —
  // the same shape the alias half (`tests/setup/fsGuard.ts`) gives these names, and the shape
  // `tests/oracle-guard.test.ts` asserts by behaviour.
  for (const name of ASYNC_WRAPPERS) wrapBuiltin(name);

  // `fs.promises` is a separate object; wrap the write-shaped members it exposes.
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const name of ASYNC_WRAPPERS) {
    const original = promises[name];
    if (typeof original !== 'function') continue;
    patched.push(`promises.${name}`);
    promises[name] = function wrapped(this: unknown, ...args: unknown[]) {
      check(name, args);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }

  tripwire = {
    patched,
    refusals: () => refusals,
    lastRefusal: () => last,
  };
  return tripwire;
}

/** Is the tripwire installed in this process (the suite-level net)? */
export function goldenTripwireInstalled(): boolean {
  return tripwire !== null;
}

/**
 * Copy a recorded scenario **out of the oracle** into a staging dir, and prove the copy is a
 * copy: `cpSync` preserves symlinks by default, so copying a worktree's symlinked
 * `oracle/<s>/run` produces a directory full of links straight back into the golden — and every
 * "perturb the copy" step in a test then writes the golden (that is the incident this module
 * documents). Dereferences, asserts the destination is not a golden, and walks the result.
 */
export function stageGoldenCopy(
  scenarioDir: string,
  destParent: string,
  name: string,
  what = 'stageGoldenCopy',
): string {
  const src = path.resolve(scenarioDir);
  if (!existsSync(src)) {
    throw new Error(`${what}: ${src} does not exist — there is nothing to stage`);
  }
  const dest = path.join(destParent, name);
  assertNotGoldenWrite(dest, what);
  fs.mkdirSync(destParent, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });

  // `cpSync(..., { dereference: true })` is not enough: Node keeps a symlinked *directory* a
  // symlink (measured — the staged copy still held `run` pointing at the golden). Walk the source
  // and copy what the links resolve to, so the result is files all the way down.
  const copy = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      const stats = fs.statSync(source); // follows symlinks: what the copy must contain
      if (stats.isDirectory()) copy(source, target);
      else if (stats.isFile()) fs.copyFileSync(source, target);
    }
  };
  copy(src, dest);

  const links: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push(`${prefix}${entry.name}`);
        continue;
      }
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
    }
  };
  walk(dest, '');
  if (links.length > 0) {
    throw new GoldenWriteRefused(
      `${what}: the staged copy at ${dest} still holds ${links.length} symlink(s) ` +
        `(${links.slice(0, 3).join(', ')}${links.length > 3 ? ', …' : ''}) — a perturbation of this ` +
        'copy would land wherever they point (typically the frozen golden). Refusing to hand out a ' +
        'tree that is not a copy.',
    );
  }
  assertNotGoldenWrite(dest, what);
  return dest;
}
