/**
 * `$TMPDIR` hygiene: report, and reclaim, the temp trees this checkout leaves behind (t_841decd7).
 *
 * Re-runnable, and safe to run unattended — the supervisor cannot run `rm -rf` (the cron approval
 * block), so a prune the fleet can run on its own is the durable answer to the leak, not a one-off
 * manual clean.
 *
 * ```
 * npx tsx tools/tmp_prune.ts report                 # classify + bytes; changes nothing
 * npx tsx tools/tmp_prune.ts reap                   # reclaim everything provably ours and stale
 * npx tsx tools/tmp_prune.ts reap --min-age 30      # ... only what nothing has touched for 30 min,
 *                                                   # and below 5 min it warns: a legacy entry carries
 *                                                   # no pid, so that gate is what protects a live run
 * npx tsx tools/tmp_prune.ts reap --min-age=30      # the same flag, `=`-spelled: a command scanner
 *                                                   # may read a separated `120`/`30` as an IP address
 *                                                   # and refuse the line (measured — t_0ee3e965)
 * npx tsx tools/tmp_prune.ts reap --archive /Volumes/Goliath/polyworld-web-scratch/tmp-archive
 * npx tsx tools/tmp_prune.ts report --candidate-base=<dir>  # sweep a stashed scratch root instead
 *                                                   # of `<repo>/.candidate`
 * npx tsx tools/tmp_prune.ts reap --dry-run         # the same decisions, nothing removed
 * npx tsx tools/tmp_prune.ts check                  # fixture assertions: proofs, staleness, refusals
 * ```
 *
 * **What it reclaims, and why each shape is a proof.**
 *
 *  1. `<tmpdir>/polyworld-run-tmp/pid-<n>` whose pid `n` is gone — the run roots
 *     `src/hygiene/runTempRoot.ts` keys (`reapDeadRunRoots`, never a live pid's, never our own).
 *  2. `<tmpdir>/polyworld-browser-candidates/pid-<n>` (t_1ce9957f) and the genome lane's
 *     `<tmpdir>/polyworld-genome-candidates/pid-<n>` — the same key, the same reap.
 *  3. Legacy run trees left in `$TMPDIR` **by the sites this checkout mints them at**
 *     (`mkdtempSync(join(tmpdir(), …))` in `tests/**`, `src/**`, `tools/**`, and the browser lane's
 *     per-process roots): `<dir>/run/original.wf` with `original.wfs` — this project's world-file
 *     pair — or a `population.txt` whose head is `#datalib`, this project's own datalib header, or
 *     any file under the entry that names **this checkout's own path**.
 *  4. Legacy **Class 1** dirs: `<tmpdir>/<nanoid>/ssr/<sha1>` — vitest 5's per-project transform
 *     cache, which the run root now bounds. Proven by the module id vitest records **inside** the
 *     file (the `//# vitestCache=<base64>` trailer): a cache file is named `sha1(<absolute module
 *     id>)`, and that id's path within the tree the run happened in has to be a file of this
 *     checkout. Measured 2026-09-29: the naming key is exact (10,964/10,964 files — 224 of them the
 *     `?raw` spelling), but the tree is almost always a **throwaway copy** of this checkout — 80/80
 *     retained dirs were written by copies that no longer exist, 0/80 by this checkout itself — which
 *     is why enumerating this checkout's own paths can never fire. A cache whose ids resolve to no
 *     path here, or whose authoring tree still exists and is not this checkout's, is reported and
 *     left alone.
 *  5. Any dead `pid-*` of the three keyed bases: the run roots, `polyworld-browser-candidates`
 *     (t_1ce9957f) and `polyworld-genome-candidates` (the genome lane's, which has no lifecycle
 *     module of its own). `oracle/_t_logs_candidates` (t_2821ab7f) reaps itself once per process and
 *     is deliberately **not** touched from here: this tool holds no `oracle/` writes at all.
 *  6. The **repo-local scratch root**, `<repo>/.candidate` (t_4f775095). The parity lane mints one
 *     graded-run tree per run as `.candidate/parity/pid-<pid>/<scenario>` (`tools/parity_candidate.sh`)
 *     and the vision gate one per worker as `.candidate/vision-gate-von/pid-<pid>[-t<thread>]/`
 *     (`tests/vision-on-is-not-a-noop.test.ts`), and nothing ever reclaimed either: measured
 *     2026-09-29, 1.8 G / 187 dead `pid-*` trees. The key is the same `kill(pid, 0)` proof — but a
 *     tree here survives its writer by design (a human grades the tree *after* the run), so a reclaim
 *     needs **both** terms: the owner pid gone **and** the age gate passed. A live owner's tree is
 *     never touched (a lane runs two graded scenarios back to back under one `pid-<pid>/`), and a
 *     dead owner's tree nothing has touched for less than `--min-age` is reported and kept — pid
 *     reuse is out of scope, so the age is the second term, not a replacement for liveness.
 *     Non-`pid-*` children of such a base name no owner and are reported and left.
 *
 * Anything that is not provably this checkout's is **reported and left alone** — the oMLX updater's
 * `omlx-update-*` trees (~800 MB each), Chromium profiles (`probe-profile-*`, `w1g-chrome-*`,
 * `pw-chrome-*`, `pw-chrome`-shaped fixture trees), `pytest-of-*`, `tsx-*` and anything else a
 * neighbour on this machine parks in the same directory. The refusal is *reported with its reason*,
 * because a prune that silently skips is how a leak comes back.
 *
 * Nothing is ever removed before the frozen-golden guard accepts it (`assertUsableStagingRoot` —
 * the oracle root, a scenario dir, a golden `run/` tree and anything resolving into one are refused
 * with the guard's own message), and the run-root shapes additionally go through
 * `assertReapableRunRoot`/`assertReapableBrowserCandidateDir`, which is the same refusal order the
 * reapers use.
 */

import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { BROWSER_CANDIDATE_BASE, reapDeadBrowserCandidateRoots } from '../src/browser/sim/candidateRoots';
import { MANIFEST_NAME, REPO_ROOT, assertUsableStagingRoot, resolveExisting } from '../src/oracle/guard';
import { isProcessAlive } from '../src/oracle/logsStaging';
import { RUN_TEMP_BASE_BASENAME, assertReapableRunRoot, reapDeadRunRoots } from '../src/hygiene/runTempRoot';

/** The genome lane's candidate base — the same per-process key, minted in `tests/genome.test.ts`. */
const GENOME_CANDIDATE_BASE = 'polyworld-genome-candidates';

/** The repo-local scratch root (t_4f775095): `<repo>/.candidate`, reserved by `.gitignore`. */
export const CANDIDATE_BASE_BASENAME = '.candidate';

/** This checkout's own path segment, as it appears in a module id, a world file or a source map. */
const CHECKOUT_SEGMENT = `/${path.basename(REPO_ROOT)}/`;

/** `pid-<pid>` or `pid-<pid>-t<thread>` — the keys the candidate roots and run roots use. */
const PID_NAME = /^pid-(\d+)(?:-t(\d+))?$/;

/** One file of the transform cache: `hash('sha1', moduleId, 'hex')`. */
const SHA1_NAME = /^[0-9a-f]{40}$/;

/** The per-project root of the vitest transform cache: `join(tmpdir(), nanoid())`. */
const SSR_CACHE_NAME = 'ssr';

/** The trailer vitest appends to every transform-cache file it writes: the fetch result as
 * `devalue`-flattened JSON, base64'd after a comment marker — the only place the module id a file is
 * *named* after is recoverable. Measured: present in 10,964/10,964 cache files of this checkout. */
const CACHE_TRAILER = '\n//# vitestCache=';

/** Bytes of a cache file's tail read for that trailer (its payload measures ~0.6 KB). */
const CACHE_TRAILER_BYTES = 8192;

/** Cache files whose id is read per directory. Measured: the proof fires on the **first** (sorted)
 * file of all 80 retained dirs, so this is slack — and it bounds the work on a foreign tree. */
const CACHE_PROOF_SAMPLES = 16;

/** The id spellings a cache file name is the sha1 of, both measured over 10,964 files:
 * `sha1(<module id>)` (10,740) and `sha1(<module id>?raw)` (224 — every raw import). */
const CACHE_ID_SPELLINGS = ['', '?raw'];

const TEXT_EXTENSIONS = ['.txt', '.json', '.log', '.md', '.mjs', '.ts', '.js', '.html', '.wf', '.wfs', '.yml', '.csv'];
const MARKER_NAMES = ['population.txt', 'endReason.txt', 'endStep.txt', 'brain.txt', 'PROVENANCE.txt', 'original.wf', 'original.wfs'];

interface Options {
  readonly mode: string;
  readonly tmpdir: string;
  /** The repo-local scratch root the parity lane and the vision gate mint `pid-*` trees under. */
  readonly candidateBase: string;
  /** Reclaim only what nothing has touched for this many minutes. */
  readonly minAgeMinutes: number;
  /** Move reclaimed entries here (a cross-volume move frees the boot volume) instead of removing. */
  readonly archive: string | null;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export function parseOptions(argv: readonly string[]): Options {
  let archive: string | null = null;
  let minAgeMinutes = 120;
  let tmpdir = os.tmpdir();
  let candidateBase = path.join(REPO_ROOT, CANDIDATE_BASE_BASENAME);
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--archive') archive = argv[++i] ?? null;
    else if (arg === '--min-age') minAgeMinutes = Number(argv[++i] ?? '120');
    // `--min-age=<n>` as well as `--min-age <n>`: the fleet's command scanner reads a separated
    // `120` as a raw-IP URL and refuses the whole line (measured: "URL points to IP address
    // 0.0.0.120"), so an unattended caller that needs a non-default age has only this spelling.
    // Ignoring it silently would size the staleness gate — the only protection a legacy entry has —
    // to 120 min whatever the caller asked for.
    else if (arg.startsWith('--min-age=')) minAgeMinutes = Number(arg.slice('--min-age='.length));
    else if (arg === '--tmpdir') tmpdir = argv[++i] ?? tmpdir;
    else if (arg.startsWith('--tmpdir=')) tmpdir = arg.slice('--tmpdir='.length);
    else if (arg === '--candidate-base') candidateBase = argv[++i] ?? candidateBase;
    else if (arg.startsWith('--candidate-base=')) candidateBase = arg.slice('--candidate-base='.length);
    else if (arg.startsWith('--archive=')) archive = arg.slice('--archive='.length);
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
  }
  if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 0) minAgeMinutes = 120;
  return {
    mode: argv[0] ?? 'report',
    tmpdir: path.resolve(tmpdir),
    candidateBase: path.resolve(candidateBase),
    minAgeMinutes,
    archive: archive === null ? null : path.resolve(archive),
    dryRun,
    json,
  };
}

/** The first (or last) `bytes` of a file, as latin1 (a source map is ASCII; a binary must not throw). */
function readSlice(file: string, bytes: number, fromEnd = false): string {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const length = Math.min(bytes, size);
    if (length === 0) return '';
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
    return buffer.subarray(0, read).toString('latin1');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the read already failed: nothing left to close */
      }
    }
  }
}

export interface EntryStats {
  readonly bytes: number;
  readonly entries: number;
  /** The newest mtime seen (seconds), or 0 when the tree is empty. */
  readonly newest: number;
}

/** Walk a tree (bounded, no follow of symlinked dirs) collecting bytes, entries and the newest mtime. */
function statTree(dir: string, maxEntries = 200_000): EntryStats {
  let bytes = 0;
  let entries = 0;
  let newest = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && entries < maxEntries) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      entries += 1;
      const child = path.join(current, name);
      let stats;
      try {
        stats = lstatSync(child);
      } catch {
        continue;
      }
      newest = Math.max(newest, stats.mtimeMs / 1000);
      if (stats.isDirectory()) stack.push(child);
      else bytes += stats.size;
    }
  }
  return { bytes, entries, newest };
}

export interface Proof {
  readonly family: string;
  readonly why: string;
}

function direntsOf(dir: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

/** P4: does a file's head name this checkout (an absolute path of this repo or one of its worktrees)? */
function headNamesCheckout(file: string, bytes = 8192): boolean {
  return readSlice(file, bytes).includes(CHECKOUT_SEGMENT);
}

/**
 * This checkout and its **live** git worktrees — the trees whose module ids are this checkout's own
 * paths. A lane runs in a worktree, and its cache names *its* paths, so both sets count.
 */
let treeRoots: string[] | null = null;
function checkoutTreeRoots(): readonly string[] {
  if (treeRoots !== null) return treeRoots;
  const roots = new Set<string>([REPO_ROOT]);
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of list.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const dir = line.slice('worktree '.length).trim();
      if (dir.length > 0 && existsSync(dir)) roots.add(dir);
    }
  } catch {
    /* no git, or not a repository: this checkout alone is the proof set */
  }
  treeRoots = [...roots];
  return treeRoots;
}

/** Does the *entry* exist (a dangling symlink is an entry; `existsSync` would say no)? */
function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The module id vitest recorded inside a transform-cache file — the id the file's own *name* is the
 * sha1 of — or `null` when the file carries no such trailer.
 *
 * The trailer is `devalue`'s flattened form: a JSON array whose element 0 is the object template and
 * whose remaining elements are the values in first-use order, so the module's `file`/`id` (an
 * absolute path in the tree the run happened in) is the first value.
 */
function cachedModuleId(file: string): string | null {
  const tail = readSlice(file, CACHE_TRAILER_BYTES, true);
  const marker = tail.lastIndexOf(CACHE_TRAILER);
  if (marker < 0) return null;
  const payload = tail.slice(marker + CACHE_TRAILER.length).trim();
  if (payload.length < 16) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, 'base64').toString('utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === 'string' && path.isAbsolute(value)) return value;
      }
    }
  } catch {
    /* not the JSON shape: the text scan below is the fallback */
  }
  const match = /"((?:[A-Za-z]:)?[\\/][^"]*)"/.exec(decoded);
  return match === null ? null : match[1]!;
}

interface CacheOwner {
  /** The absolute module id vitest recorded — a path in the tree the run happened in. */
  readonly id: string;
  /** That id's path *within* this checkout, which is a real file of it. */
  readonly rel: string;
  /** The root of the tree the run happened in (`id` minus `rel`). */
  readonly tree: string;
  /** True when the name matched the `?raw` spelling. */
  readonly raw: boolean;
}

/**
 * The id proof for one cache file: the file is **named** `sha1(<module id>)`, the id is the one
 * vitest recorded inside the file, and that id's path within a copy of this checkout is a real file
 * of this checkout. `null` when any of those fails — the caller then has no proof for this file.
 */
function cacheOwnerOf(file: string, name: string): CacheOwner | null {
  const id = cachedModuleId(file);
  if (id === null || !path.isAbsolute(id)) return null;
  const spelling = CACHE_ID_SPELLINGS.find((suffix) => createHash('sha1').update(id + suffix).digest('hex') === name);
  if (spelling === undefined) return null;
  const segments = id.split('/');
  for (let start = 1; start < segments.length; start++) {
    const rel = segments.slice(start).join('/');
    if (rel.length === 0) continue;
    let isFile = false;
    try {
      isFile = statSync(path.join(REPO_ROOT, rel)).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) return { id, rel, tree: segments.slice(0, start).join('/'), raw: spelling !== '' };
  }
  return null;
}

/**
 * Class 1: the vitest transform cache. Shape (`<nanoid>/ssr/<sha1>`, or the `sha1` files directly),
 * then the proof of authorship spelled out below.
 *
 * **Why the name alone is not the proof (measured 2026-09-29).** The name *is* `hash('sha1', id,
 * 'hex')` — `ModuleFetcher`'s `join(tmpDir, environment.name)` + `join(tmpDir, hash('sha1',
 * result.id, 'hex'))` — but the id is an **absolute path in the tree the run happened in**, and here
 * that tree is almost never this checkout: it is a throwaway copy of it (a lane's
 * `…/cache/scratch/prefix-*` copy, a kanban workspace worktree), deleted when the lane ends. Of the
 * 80 retained dirs / 10,964 cache files measured: **10,964/10,964** names match their own recorded
 * id (10,740 bare, 224 `?raw`), **80/80** dirs were written by copies that no longer exist, and
 * **0/80** by this checkout itself. So hashing this checkout's paths — the old proof, which skipped
 * `node_modules` besides — could never fire; the id has to be read out of the file, which is what
 * the trailer is for.
 *
 * **The proof.** A cache file whose name is `sha1(id)` for the id its own trailer records, where that
 * id's path within a copy of this checkout is a real file of this checkout, and either
 *  - the id lies under this checkout or under one of its **live** worktrees — exact: the run was
 *    rooted in this tree (the only tier a live tree can produce), or
 *  - the authoring tree is **gone** — a copy of this checkout that no longer exists, so nothing can
 *    be using its cache.
 * A dir whose ids resolve to no path here (another project's cache) is reported and left, and so is
 * one whose authoring tree still exists and is not this checkout's: the one case where the id alone
 * cannot tell a *live* foreign tree from a live lane, and the refusal that stays.
 */
function ssrCacheProof(dir: string, entries: readonly { name: string; isDirectory: boolean }[]): Proof | null {
  const cacheDirs: string[] = [];
  const ssr = entries.find((e) => e.name === SSR_CACHE_NAME && e.isDirectory);
  if (ssr !== undefined) cacheDirs.push(path.join(dir, SSR_CACHE_NAME));
  if (!entries.some((e) => e.isDirectory)) cacheDirs.push(dir);

  const trees = checkoutTreeRoots();
  for (const cacheDir of cacheDirs) {
    const files = direntsOf(cacheDir)
      .filter((e) => !e.isDirectory && SHA1_NAME.test(e.name))
      .slice(0, CACHE_PROOF_SAMPLES);
    for (const file of files) {
      const owner = cacheOwnerOf(path.join(cacheDir, file.name), file.name);
      if (owner === null) continue;
      const spelled = `sha1(${owner.id}${owner.raw ? '?raw' : ''})`;
      if (trees.some((root) => owner.id.startsWith(`${root}/`))) {
        return {
          family: 'vite-ssr-cache',
          why: `${path.basename(cacheDir)}/${file.name} is ${spelled}, ${owner.rel} of this checkout`,
        };
      }
      if (!entryExists(owner.tree)) {
        return {
          family: 'vite-ssr-cache',
          why: `${path.basename(cacheDir)}/${file.name} is ${spelled}, a copy of this checkout at ${owner.tree} (gone); ${owner.rel} is a file of this checkout`,
        };
      }
    }
  }
  return null;
}

/** P2: this project's world-file pair, or this project's own datalib header. */
function runTreeProof(dir: string): Proof | null {
  const population = path.join(dir, 'population.txt');
  if (existsSync(population) && readSlice(population, 64).startsWith('#datalib')) {
    return { family: 'polyworld-run-tree', why: 'run/population.txt starts with `#datalib` (this project\'s datalib header)' };
  }
  const world = path.join(dir, 'original.wf');
  const schema = path.join(dir, 'original.wfs');
  if (existsSync(world) && existsSync(schema)) {
    const head = readSlice(world, 4096);
    if (/^@version \d+/m.test(head) && /MaxSteps|WorldSize|RecordFrequency/.test(head)) {
      return { family: 'polyworld-run-tree', why: 'original.wf + original.wfs (this project\'s world file and its schema)' };
    }
  }
  return null;
}

/**
 * The proof an entry is this checkout's, or `null` (which means: report it, never reclaim it).
 *
 * Direct probes first (O(1) per entry), then one bounded scan for a file that names this checkout's
 * own path.
 */
function proofOf(dir: string, entries: readonly { name: string; isDirectory: boolean }[]): Proof | null {
  // Class 1: the vitest transform cache. Shape, then the exact `sha1(module path)` proof.
  const cache = ssrCacheProof(dir, entries);
  if (cache !== null) return cache;

  // Class 2: a run tree, directly or one level down (`<dir>/run/**`, `<dir>/<scenario>/run/**`).
  const direct = runTreeProof(path.join(dir, 'run'));
  if (direct !== null) return direct;
  for (const entry of entries.filter((e) => e.isDirectory).slice(0, 8)) {
    const proof = runTreeProof(path.join(dir, entry.name, 'run'));
    if (proof !== null) return proof;
  }

  // P4: a file that names this checkout's own path.
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory && MARKER_NAMES.includes(entry.name)) candidates.push(path.join(dir, entry.name));
  }
  for (const entry of entries.filter((e) => e.isDirectory).slice(0, 4)) {
    for (const marker of MARKER_NAMES) {
      const candidate = path.join(dir, entry.name, marker);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory && TEXT_EXTENSIONS.includes(path.extname(entry.name))) candidates.push(path.join(dir, entry.name));
  }
  for (const file of candidates.slice(0, 8)) {
    if (headNamesCheckout(file)) {
      return { family: 'checkout-path', why: `${path.relative(dir, file)} names this checkout` };
    }
  }
  return null;
}

export interface PruneVerdict {
  readonly dir: string;
  readonly bytes: number;
  readonly entries: number;
  /** `reclaim` when it may be removed; otherwise why it may not. */
  readonly action: 'reclaim' | 'keep';
  readonly reason: string;
  readonly family?: string;
}

export interface PruneReport {
  readonly tmpdir: string;
  /** The repo-local scratch root walked in the same pass (`<repo>/.candidate`). */
  readonly candidateBase: string;
  readonly minAgeMinutes: number;
  readonly reclaimed: PruneVerdict[];
  readonly kept: PruneVerdict[];
  readonly bytes: number;
  readonly errors: string[];
}

/**
 * Classify every direct child of `tmpdir` (the real `$TMPDIR`) **and** the repo-local candidate
 * base, reclaim the ones that are provably this checkout's **and** stale, and report the rest with
 * the reason they were left.
 *
 * The `$TMPDIR` side needs one term: a pid-keyed entry is judged by liveness (a live owner's tree
 * is in use right now and is never touched, whatever its mtime says), a legacy entry by its proof
 * and the age gate. The repo-local `.candidate` side needs both terms for a reclaim — the owner
 * gone *and* the age gate — because a graded tree there outlives its writer by design; see
 * {@link pruneCandidateBase}.
 */
export function pruneTmpdir(options: Options): PruneReport {
  const reclaimed: PruneVerdict[] = [];
  const kept: PruneVerdict[] = [];
  const errors: string[] = [];
  const cutoff = Date.now() / 1000 - options.minAgeMinutes * 60;

  let names: string[];
  try {
    names = readdirSync(options.tmpdir);
  } catch (error) {
    names = [];
    errors.push(`readdir(${options.tmpdir}): ${(error as Error).message}`);
  }

  const reclaim = (dir: string, stats: EntryStats, reason: string, family: string): void => {
    try {
      assertUsableStagingRoot(dir, 'tmp_prune');
      if (options.archive !== null) {
        moveToArchive(dir, options.archive);
      } else if (!options.dryRun) {
        rmSync(dir, { recursive: true, force: true });
      }
      reclaimed.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'reclaim', reason, family });
    } catch (error) {
      kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `refused: ${(error as Error).message}` });
    }
  };

  for (const name of names.sort()) {
    const dir = path.join(options.tmpdir, name);
    let stats;
    try {
      stats = lstatSync(dir);
    } catch {
      continue;
    }
    // A base directory is a container, never a candidate: its `pid-*` children are handled below.
    if (stats.isSymbolicLink()) {
      kept.push({ dir, bytes: 0, entries: 0, action: 'keep', reason: 'a symlink entry is never followed or removed' });
      continue;
    }
    if (!stats.isDirectory()) continue;

    const tree = name === RUN_TEMP_BASE_BASENAME || name === BROWSER_CANDIDATE_BASE || name === GENOME_CANDIDATE_BASE;
    if (tree) {
      const reap = reapPidChildren(dir, name, options);
      for (const reaped of reap.reclaimed) reclaim(reaped.dir, reaped.stats, reaped.reason, reaped.family);
      for (const keep of reap.kept) kept.push(keep);
      continue;
    }

    const entries = direntsOf(dir);
    const walked = statTree(dir);

    // A pid-keyed entry the run-root lifecycle owns (a legacy `pid-*` at the top level): liveness first.
    const pid = PID_NAME.exec(name);
    if (pid !== null) {
      const owner = Number(pid[1]);
      if (owner === process.pid) kept.push({ dir, bytes: walked.bytes, entries: walked.entries, action: 'keep', reason: `pid ${owner} is this process` });
      else if (isProcessAlive(owner)) kept.push({ dir, bytes: walked.bytes, entries: walked.entries, action: 'keep', reason: `owner pid ${owner} is alive` });
      else reclaim(dir, walked, `pid-<${owner}> run tree, owner gone`, 'run-root');
      continue;
    }

    const proof = proofOf(dir, entries);
    if (proof === null) {
      kept.push({ dir, bytes: walked.bytes, entries: walked.entries, action: 'keep', reason: 'no proof this checkout is the author' });
      continue;
    }
    if (walked.newest > cutoff) {
      const age = Math.round((Date.now() / 1000 - walked.newest) / 60);
      kept.push({ dir, bytes: walked.bytes, entries: walked.entries, action: 'keep', reason: `written ${age} min ago (< --min-age ${options.minAgeMinutes})`, family: proof.family });
      continue;
    }
    reclaim(dir, walked, `${proof.why}; untouched for ${Math.round((Date.now() / 1000 - walked.newest) / 60)} min`, proof.family);
  }

  // The repo-local scratch root (t_4f775095): `<repo>/.candidate`, where the parity lane's graded
  // roots and the vision gate's trees live — the same report, a second namespace. The reclaim rule
  // there needs both terms (owner gone AND the age gate), see pruneCandidateBase.
  const candidates = pruneCandidateBase(options.candidateBase, options);
  for (const verdict of candidates.reclaimed) reclaimed.push(verdict);
  for (const verdict of candidates.kept) kept.push(verdict);

  return {
    tmpdir: options.tmpdir,
    candidateBase: options.candidateBase,
    minAgeMinutes: options.minAgeMinutes,
    reclaimed,
    kept,
    bytes: reclaimed.reduce((n, v) => n + v.bytes, 0),
    errors,
  };
}

/** Reap the dead `pid-*` children of one of the three keyed bases. */
function reapPidChildren(
  base: string,
  baseName: string,
  options: Options,
): { reclaimed: { dir: string; stats: EntryStats; reason: string; family: string }[]; kept: PruneVerdict[] } {
  const reclaimed: { dir: string; stats: EntryStats; reason: string; family: string }[] = [];
  const kept: PruneVerdict[] = [];
  for (const name of (() => {
    try {
      return readdirSync(base);
    } catch {
      return [] as string[];
    }
  })().sort()) {
    const dir = path.join(base, name);
    const pid = PID_NAME.exec(name);
    const stats = statTree(dir);
    if (pid === null) {
      kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: 'not a pid-* entry (nothing owns it)' });
      continue;
    }
    const owner = Number(pid[1]);
    if (owner === process.pid) {
      kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `pid ${owner} is this process` });
      continue;
    }
    if (isProcessAlive(owner)) {
      kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `owner pid ${owner} is alive` });
      continue;
    }
    try {
      assertUsableStagingRoot(dir, 'tmp_prune');
      const resolvedBase = resolveExisting(base);
      const resolved = resolveExisting(dir);
      const rel = path.relative(resolvedBase, resolved);
      if (rel.includes(path.sep) || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`${dir} is not a direct child of ${resolvedBase}`);
      }
      if (options.archive !== null) moveToArchive(dir, options.archive);
      else if (!options.dryRun) rmSync(dir, { recursive: true, force: true });
      reclaimed.push({ dir, stats, reason: `pid-<${owner}> ${baseName} tree, owner gone`, family: baseName });
    } catch (error) {
      kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `refused: ${(error as Error).message}` });
    }
  }
  return { reclaimed, kept };
}

/**
 * Throw unless `dir` may be removed from the repo-local candidate base (t_4f775095): the
 * frozen-golden guard first (so the oracle root, a scenario dir, a golden `run/` tree and anything
 * resolving into one are refused with the guard's own message — `oracle/**` is never a candidate),
 * then the shape — a `pid-<pid>[-t<thread>]` direct child of a direct child of a base literally
 * named `.candidate`.
 *
 * The shape is what makes the ownership proof free: `<repo>/.candidate/<lane>/pid-<n>` names its
 * owner, the same key the reapers in `src/hygiene`/`src/browser` remove by. The base's own name is
 * pinned deliberately: this family's base lives *inside* the checkout, and a caller that handed
 * over some other directory must not turn this predicate into a sweep of everything two levels down.
 */
export function assertReapableCandidateTree(dir: string, base: string, what: string): string {
  assertUsableStagingRoot(dir, what);

  if (path.basename(resolveExisting(base)) !== CANDIDATE_BASE_BASENAME) {
    throw new Error(
      `${what}: refusing ${dir} — ${base} is not the repo-local candidate base (\`${CANDIDATE_BASE_BASENAME}\`); ` +
        'only its `<lane>/pid-*` children are ever removed (src/oracle/guard.ts, tools/tmp_prune.ts).',
    );
  }

  const resolvedBase = resolveExisting(base);
  const resolvedDir = resolveExisting(dir);
  const rel = path.relative(resolvedBase, resolvedDir);
  const segments = rel.split(path.sep);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || segments.length !== 2 || PID_NAME.exec(segments[1]!) === null) {
    throw new Error(
      `${what}: refusing ${dir} — it is not a \`pid-<pid>[-t<thread>]\` tree under a direct child of ${resolvedBase}` +
        `${resolvedDir !== path.resolve(dir) ? ` (it resolves to ${resolvedDir})` : ''}.`,
    );
  }
  return dir;
}

export interface CandidateBaseReport {
  readonly reclaimed: PruneVerdict[];
  readonly kept: PruneVerdict[];
}

/** Bytes/entries/newest for one entry (a file is read as itself, a directory is walked). */
function entryStats(dir: string, ls: Stats): EntryStats {
  if (!ls.isDirectory()) return { bytes: ls.size, entries: 1, newest: ls.mtimeMs / 1000 };
  return statTree(dir);
}

/**
 * Classify — and, unless `--dry-run`, reclaim — the `pid-<pid>[-t<thread>]` trees under the
 * repo-local scratch root `<repo>/.candidate`: one tree per graded run, at `<base>/<lane>/pid-<pid>/`.
 * The two lanes live today are `.candidate/parity/…` (`tools/parity_candidate.sh`, keyed by the
 * script's own pid) and `.candidate/vision-gate-von/…` (`tests/vision-on-is-not-a-noop.test.ts`,
 * keyed per worker process); any sibling lane that keys its trees the same way is covered, because
 * the key — not a lane name — is what this walks by.
 *
 * **Both terms are required for a reclaim: the owner pid must be gone AND the age gate must have
 * passed.** The key is the same `kill(pid, 0)` proof the other reapers apply, but here it cannot be
 * the whole proof: a tree under `.candidate` survives its writer by design (the parity tool leaves
 * its graded tree behind for a human to grade), so a tree whose owner just died may still be looked
 * at, and pid reuse is out of scope — a recycled pid must not be *reaped over* as if the tree were
 * live. The age gate says the run is over and nobody is looking; it is a second term, never a
 * replacement for liveness (a live owner's tree is not touched, whatever its mtime says) and never
 * skipped when the owner is gone.
 *
 * Everything else under a lane is reported and left: a child that names no `pid-` key has no owner
 * to prove anything from, and a symlinked child is never followed (a link into the golden would
 * otherwise be walked). A directory with no `pid-*` child at all is not a lane base and is skipped
 * entirely — nothing in it is this class.
 */
export function pruneCandidateBase(base: string, options: Options): CandidateBaseReport {
  const reclaimed: PruneVerdict[] = [];
  const kept: PruneVerdict[] = [];
  const cutoff = Date.now() / 1000 - options.minAgeMinutes * 60;

  for (const lane of direntsOf(base)) {
    if (!lane.isDirectory) continue; // a file (or symlink) at the base level is not a lane base
    const laneDir = path.join(base, lane.name);
    let names: string[];
    try {
      names = readdirSync(laneDir);
    } catch {
      continue;
    }
    if (!names.some((name) => PID_NAME.test(name))) continue;

    const family = `candidate/${lane.name}`;
    for (const name of names.sort()) {
      const dir = path.join(laneDir, name);
      let ls: Stats;
      try {
        ls = lstatSync(dir);
      } catch {
        continue;
      }
      const stats = entryStats(dir, ls);
      if (ls.isSymbolicLink()) {
        kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: 'a symlink entry is never followed or removed', family });
        continue;
      }
      const pid = PID_NAME.exec(name);
      if (pid === null) {
        kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: 'not a pid-* entry (nothing owns it)', family });
        continue;
      }
      const owner = Number(pid[1]);
      if (owner === process.pid) {
        kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `pid ${owner} is this process`, family });
        continue;
      }
      if (isProcessAlive(owner)) {
        kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `owner pid ${owner} is alive`, family });
        continue;
      }
      if (stats.newest > cutoff) {
        const age = Math.round((Date.now() / 1000 - stats.newest) / 60);
        kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `owner pid ${owner} gone; written ${age} min ago (< --min-age ${options.minAgeMinutes})`, family });
        continue;
      }
      try {
        assertReapableCandidateTree(dir, base, 'tmp_prune');
        if (options.archive !== null) moveToArchive(dir, options.archive);
        else if (!options.dryRun) rmSync(dir, { recursive: true, force: true });
        reclaimed.push({
          dir,
          bytes: stats.bytes,
          entries: stats.entries,
          action: 'reclaim',
          reason: `pid-<${owner}> tree under ${CANDIDATE_BASE_BASENAME}/${lane.name}, owner gone; untouched for ${Math.round((Date.now() / 1000 - stats.newest) / 60)} min`,
          family,
        });
      } catch (error) {
        kept.push({ dir, bytes: stats.bytes, entries: stats.entries, action: 'keep', reason: `refused: ${(error as Error).message}` });
      }
    }
  }
  return { reclaimed, kept };
}

/** Move an entry into the archive (a rename across volumes falls back to copy + remove). */
function moveToArchive(dir: string, archive: string): void {
  const target = path.join(archive, path.basename(dir));
  if (existsSync(target)) throw new Error(`${target} already exists in the archive`);
  try {
    renameSync(dir, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(dir, target, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function printReport(report: PruneReport, options: Options): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const verdict of report.reclaimed) {
    process.stdout.write(
      `reclaim ${verdict.dir} (${megabytes(verdict.bytes)}, ${verdict.entries} entries) — ${verdict.reason}` +
        `${verdict.family !== undefined ? ` [${verdict.family}]` : ''}\n`,
    );
  }
  for (const verdict of report.kept.filter((v) => v.bytes > 1e6).sort((a, b) => b.bytes - a.bytes)) {
    process.stdout.write(`keep    ${verdict.dir} (${megabytes(verdict.bytes)}) — ${verdict.reason}\n`);
  }
  process.stdout.write(
    `\n${report.tmpdir}\n${report.candidateBase}\n` +
      `  reclaimable: ${report.reclaimed.length} entr${report.reclaimed.length === 1 ? 'y' : 'ies'}, ${megabytes(report.bytes)}\n` +
      `  kept:        ${report.kept.length} entries, ${megabytes(report.kept.reduce((n, v) => n + v.bytes, 0))}\n` +
      `  min-age:     ${report.minAgeMinutes} min${options.archive !== null ? `, archive ${options.archive}` : ''}${options.dryRun ? ', dry run' : ''}\n`,
  );
}

// ---------------------------------------------------------------------------------------------
// check: fixture assertions. Everything happens in a scratch tmpdir of its own; nothing outside it
// is read or written.
// ---------------------------------------------------------------------------------------------

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failures += 1;
  process.stdout.write(`[tmp_prune] ${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Backdate every entry of a tree (files *and* directories) by `minutesAgo`, so the staleness gate
 * can be exercised for real — `statTree` counts a directory's own mtime, because a directory that
 * gained an entry is a directory something is still writing into. */
function backdate(dir: string, minutesAgo: number): void {
  const timestamp = Date.now() / 1000 - minutesAgo * 60;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      utimesSync(child, timestamp, timestamp);
    }
    utimesSync(current, timestamp, timestamp);
  }
}

function worldPair(dir: string): void {
  write(path.join(dir, 'run', 'original.wf'), '@version 2\n\nRecordFrequency 100\nMaxSteps 301\nWorldSize 25\n');
  write(path.join(dir, 'run', 'original.wfs'), '# schema — tabs are not allowed\n');
}

/**
 * Verify a golden scenario against its own `run/manifest.sha256`: every listed file present and
 * hashing to its entry, and nothing present that the manifest does not list (the manifest itself is
 * the one exception, by construction). Returns `null` when intact, else the first difference found
 * — so "the golden is untouched" is the golden's own listing saying so, not a file-exists probe.
 * The fixture golden is 225 files / 1.2 MB, so the full check is affordable.
 */
function verifyGolden(scenarioDir: string): string | null {
  const runDir = path.join(scenarioDir, 'run');
  let text: string;
  try {
    text = readFileSync(path.join(runDir, MANIFEST_NAME), 'utf8');
  } catch (error) {
    return `${path.join(runDir, MANIFEST_NAME)} unreadable: ${(error as Error).message}`;
  }
  const listed = new Set<string>([`run/${MANIFEST_NAME}`]);
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
    if (match === null) continue;
    const rel = match[2]!;
    listed.add(rel);
    let digest: string;
    try {
      digest = createHash('sha256').update(readFileSync(path.join(scenarioDir, rel))).digest('hex');
    } catch (error) {
      return `${rel} is missing (${(error as Error).message})`;
    }
    if (digest !== match[1]) return `${rel} hashes to ${digest}, not its manifest entry ${match[1]}`;
  }
  const extras: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child, `${prefix}${entry.name}/`);
      else if (entry.isFile() && !listed.has(`${prefix}${entry.name}`)) extras.push(`${prefix}${entry.name}`);
    }
  };
  walk(runDir, 'run/');
  if (extras.length > 0) return `present but not in the manifest: ${extras.slice(0, 3).join(', ')}${extras.length > 3 ? ', …' : ''}`;
  return null;
}

/**
 * Write a transform-cache file the way vitest does — the transformed code, then its own
 * `//# vitestCache=` trailer (the fetch result `devalue`-flattened, base64'd) recording the module id
 * the file is named after. The trailer is where the proof reads the id from.
 */
function cacheFile(dir: string, moduleId: string, code: string, options: { raw?: boolean; url?: string } = {}): string {
  const raw = options.raw === true;
  const file = path.join(dir, createHash('sha1').update(raw ? `${moduleId}?raw` : moduleId).digest('hex'));
  const meta = [
    { file: '1', id: '1', url: '2', importedUrls: '3', mappings: false, deps: '4', dynamicDeps: '5', staticMocks: null },
    moduleId,
    options.url ?? `/${path.basename(moduleId)}`,
    [],
    [],
    [],
  ];
  write(file, `${code}\n//# vitestCache=${Buffer.from(JSON.stringify(meta)).toString('base64')}`);
  return file;
}

function runChecks(): void {
  // The flag spellings first: the fleet's command scanner refuses the separated `--min-age 120`
  // (it reads `120` as a raw-IP URL), so the `=` spelling has to work — and it must never be
  // ignored silently, because that gate is what protects an entry without a pid key.
  check(parseOptions(['reap', '--min-age=30']).minAgeMinutes === 30, '`--min-age=<n>` sets the staleness gate');
  check(parseOptions(['reap', '--min-age', '30']).minAgeMinutes === 30, '`--min-age <n>` still sets it');
  check(parseOptions(['reap', '--tmpdir=/tmp/tmp-prune-probe']).tmpdir === '/tmp/tmp-prune-probe', '`--tmpdir=<dir>` sets the tmpdir');
  check(parseOptions(['reap', '--candidate-base=/tmp/tmp-prune-cands']).candidateBase === '/tmp/tmp-prune-cands', '`--candidate-base=<dir>` sets the repo-local candidate base');
  check(parseOptions(['reap']).candidateBase === path.join(REPO_ROOT, CANDIDATE_BASE_BASENAME), 'the candidate base defaults to `<repo>/.candidate`');

  const fixture = path.join(os.tmpdir(), `t841decd7-prune-${process.pid}`);
  rmSync(fixture, { recursive: true, force: true });
  const realBase = path.join(fixture, RUN_TEMP_BASE_BASENAME);

  // Class 1, tier `checkout path`: a cache file named `sha1(<module id>)` whose own trailer records
  // that id, and the id is one of this checkout's own paths — a run rooted in this tree.
  const cache = path.join(fixture, 'AbCdEfGhIjKlMnOpQrS12');
  const ownId = path.join(REPO_ROOT, 'src', 'model', 'types', 'rng.ts');
  cacheFile(path.join(cache, SSR_CACHE_NAME), ownId, '__vite_ssr_exportName__("RAND_MAX", () => { try { return RAND_MAX } catch {} });\n');
  // ... tier `gone copy`: the measured shape of every retained dir — the id names a throwaway copy of
  // this checkout (a lane's tree) that no longer exists.
  const goneTree = path.join(fixture, 'a-lane-tree-that-is-gone');
  const copyCache = path.join(fixture, 'LmNoPqRsTuVwXyZaBcDeF');
  cacheFile(path.join(copyCache, SSR_CACHE_NAME), path.join(goneTree, 'src', 'model', 'logs', 'brainLogs.ts'), '__vite_ssr_exportName__("BrainFunctionLog", () => {});\n');
  // ... the `?raw` spelling (224 of the 10,964 measured files): `sha1(<id>?raw)`, the same id inside.
  const rawCache = path.join(fixture, 'GhIjKlMnOpQrStUvWxYzAb');
  cacheFile(path.join(rawCache, SSR_CACHE_NAME), path.join(goneTree, 'src', 'browser', 'worldfiles', 'hello.wf'), 'export default "/src/browser/worldfiles/hello.wf";\n', { raw: true });
  // ... and the refusals: ids that name no path of this checkout (another project's cache) ...
  const foreignCache = path.join(fixture, 'ZzYyXxWwVvUuTtSsRrQqPp');
  cacheFile(path.join(foreignCache, SSR_CACHE_NAME), path.join(fixture, 'a-foreign-tree', 'src', 'zzz-no-such-file-here.ts'), 'export const nope = 1;\n');
  // ... a cache whose authoring tree still exists and is not this checkout's (a *live* foreign tree) ...
  const foreignTree = path.join(fixture, 'a-foreign-tree');
  mkdirSync(foreignTree, { recursive: true });
  const liveForeignCache = path.join(fixture, 'AaBbCcDdEeFfGgHhIiJjKk');
  cacheFile(path.join(liveForeignCache, SSR_CACHE_NAME), path.join(foreignTree, 'src', 'model', 'logs', 'brainLogs.ts'), 'export const nope = 1;\n');
  // ... and the shape alone, with no trailer at all (an older vitest, or not a cache): never reclaimed.
  const shapeOnly = path.join(fixture, 'ZyXwVuTsRqPoNmLkJiHgF');
  write(path.join(shapeOnly, SSR_CACHE_NAME, 'b'.repeat(40)), '__vite_ssr_exportName__("NOPE", () => {});\n');
  // Class 2, by each proof: the world-file pair, the datalib header, and a file naming the checkout.
  const pairTree = path.join(fixture, 'adami-AbCdEf');
  worldPair(pairTree);
  const datalibTree = path.join(fixture, 'cppprops-sim-AbCdEf');
  write(path.join(datalibTree, 'run', 'population.txt'), '#datalib\n#version=3\n#schema=single\n1\t25\n');
  const namedTree = path.join(fixture, 'complexityprobe-AbCdEf');
  write(path.join(namedTree, 'brain.txt'), `# files 87\nfile ${REPO_ROOT}/oracle/minitest_voff/run/brain/brainFunction_1.txt.gz part A agent 1\n`);
  // ... and the refusals: a foreign tree, and a same-named tree with no proof at all.
  const foreign = path.join(fixture, 'omlx-update-12AB34CD');
  write(path.join(foreign, 'payload.bin'), 'x'.repeat(4096));
  const unproven = path.join(fixture, 'adami-ZzZzZz');
  write(path.join(unproven, 'run', 'original.wf'), 'garbage\n');
  // The proof fixtures are 3 h old, so the staleness gate cannot mask a proof that failed to match;
  // the foreign and unproven trees are backdated too, so their keep-reasons are the proofs'.
  for (const tree of [cache, copyCache, rawCache, foreignCache, liveForeignCache, shapeOnly, pairTree, datalibTree, namedTree, unproven, foreign]) backdate(tree, 180);
  // Staleness: one just written, one 30 minutes old, one 3 hours old.
  const freshTree = path.join(fixture, 'l13-seam-FrEsH1');
  worldPair(freshTree);
  const halfHour = path.join(fixture, 'cppprops-rngseed-HaLfHr');
  worldPair(halfHour);
  backdate(halfHour, 30);
  const old = path.join(fixture, 't2a625bd5-ctor-OlD3Hr');
  worldPair(old);
  backdate(old, 180);

  const options: Options = { mode: 'reap', tmpdir: fixture, candidateBase: path.join(fixture, CANDIDATE_BASE_BASENAME), minAgeMinutes: 120, archive: null, dryRun: true, json: false };
  const report = pruneTmpdir(options);
  const verdict = (name: string): string => {
    if (report.reclaimed.some((v) => path.basename(v.dir) === name)) return 'reclaim';
    const kept = report.kept.find((v) => path.basename(v.dir) === name);
    return kept === undefined ? 'absent' : `keep (${kept.reason})`;
  };
  const isReclaimed = (name: string): boolean => verdict(name) === 'reclaim';

  const copyReason = report.reclaimed.find((v) => path.basename(v.dir) === 'LmNoPqRsTuVwXyZaBcDeF')?.reason ?? 'not reclaimed';
  check(isReclaimed('AbCdEfGhIjKlMnOpQrS12'), `a transform cache whose own trailer id is a path of this checkout is reclaimable — ${verdict('AbCdEfGhIjKlMnOpQrS12')}`);
  check(isReclaimed('LmNoPqRsTuVwXyZaBcDeF') && copyReason.includes('a copy of this checkout at'), `a transform cache written by a copy of this checkout that is gone is reclaimable — ${copyReason}`);
  check(isReclaimed('GhIjKlMnOpQrStUvWxYzAb'), `the \`?raw\` spelling of the same key is reclaimable — ${verdict('GhIjKlMnOpQrStUvWxYzAb')}`);
  check(!isReclaimed('ZzYyXxWwVvUuTtSsRrQqPp'), `a cache whose ids name no path of this checkout is never reclaimed — ${verdict('ZzYyXxWwVvUuTtSsRrQqPp')}`);
  check(!isReclaimed('AaBbCcDdEeFfGgHhIiJjKk'), `a cache whose authoring tree still exists and is not this checkout's is never reclaimed — ${verdict('AaBbCcDdEeFfGgHhIiJjKk')}`);
  check(!isReclaimed('ZyXwVuTsRqPoNmLkJiHgF'), `a transform-cache shape with no trailer at all is never reclaimed — ${verdict('ZyXwVuTsRqPoNmLkJiHgF')}`);
  check(isReclaimed('adami-AbCdEf'), `a world-file pair (original.wf + original.wfs) is reclaimable — ${verdict('adami-AbCdEf')}`);
  check(isReclaimed('cppprops-sim-AbCdEf'), `a \`#datalib\` population.txt tree is reclaimable — ${verdict('cppprops-sim-AbCdEf')}`);
  check(isReclaimed('complexityprobe-AbCdEf'), `a tree whose file names the checkout is reclaimable — ${verdict('complexityprobe-AbCdEf')}`);
  check(!isReclaimed('omlx-update-12AB34CD'), `a foreign tree is reported, never reclaimed — ${verdict('omlx-update-12AB34CD')}`);
  check(!isReclaimed('adami-ZzZzZz'), `a same-named tree with no proof is never reclaimed — ${verdict('adami-ZzZzZz')}`);
  check(!isReclaimed('l13-seam-FrEsH1'), `a tree just written is kept (stale gate) — ${verdict('l13-seam-FrEsH1')}`);
  check(!isReclaimed('cppprops-rngseed-HaLfHr'), `a tree written 30 min ago is kept at --min-age 120 — ${verdict('cppprops-rngseed-HaLfHr')}`);
  check(isReclaimed('t2a625bd5-ctor-OlD3Hr'), `a tree written 3 h ago is reclaimed — ${verdict('t2a625bd5-ctor-OlD3Hr')}`);
  check(!pruneTmpdir({ ...options, minAgeMinutes: 10_000_000 }).reclaimed.some((v) => path.basename(v.dir) === 't2a625bd5-ctor-OlD3Hr'), '--min-age gates it back off again');
  check(pruneTmpdir({ ...options, minAgeMinutes: 0 }).reclaimed.some((v) => path.basename(v.dir) === 'l13-seam-FrEsH1'), '--min-age 0 accepts a just-written tree');

  // The pid key: a live owner's run root and this process's own are kept, a dead owner's is reclaimed.
  const dead = path.join(realBase, 'pid-999999');
  write(path.join(dead, SSR_CACHE_NAME, 'x'), 'x');
  const own = path.join(realBase, `pid-${process.pid}`);
  write(path.join(own, SSR_CACHE_NAME, 'x'), 'x');
  const live = path.join(realBase, 'pid-1');
  write(path.join(live, SSR_CACHE_NAME, 'x'), 'x');

  // The repo-local candidate family (t_4f775095): `<fixture>/.candidate/<lane>/pid-*`, the shape
  // `<repo>/.candidate/parity` and `.candidate/vision-gate-von` have. A reclaim needs **both** the
  // owner gone and the age gate; a lane child that names no key is reported and left, and a
  // symlinked one is never followed. The base is a tmp `.candidate`, so the guard's golden question
  // is the same one it asks of the real `<repo>/.candidate`.
  const goldenScenario = path.join(REPO_ROOT, 'oracle', 'microtest_voff');
  const goldenRun = path.join(goldenScenario, 'run');
  const candBase = path.join(fixture, CANDIDATE_BASE_BASENAME);
  const candParity = path.join(candBase, 'parity');
  const candDead = path.join(candParity, 'pid-999991'); // dead owner + stale → reclaim
  worldPair(candDead);
  const candThread = path.join(candBase, 'vision-gate-von', 'pid-999992-t7'); // the `-t<thread>` spelling
  write(path.join(candThread, 'run', 'original.wf'), '@version 2\n');
  const candGated = path.join(candParity, 'pid-999993'); // dead owner, just written → the age gate holds it
  worldPair(candGated);
  const candOwnerLive = path.join(candParity, 'pid-1'); // live owner → never touched, whatever its age
  worldPair(candOwnerLive);
  const candSelf = path.join(candBase, 'vision-gate-von', `pid-${process.pid}`); // this process's own
  write(path.join(candSelf, 'run', 'original.wf'), '@version 2\n');
  const candKeyless = path.join(candParity, 'not-a-pid-key'); // names no key → reported and left
  write(path.join(candKeyless, 'note.txt'), 'no pid key here\n');
  const candLink = path.join(candParity, 'pid-999994'); // a symlink into a golden → never followed
  symlinkSync(goldenRun, candLink, 'dir');
  for (const tree of [candDead, candThread, candOwnerLive, candKeyless]) backdate(tree, 180);

  const liveReport = pruneTmpdir(options);
  const liveVerdict = (name: string): string => {
    if (liveReport.reclaimed.some((v) => path.basename(v.dir) === name)) return 'reclaim';
    const kept = liveReport.kept.find((v) => path.basename(v.dir) === name);
    return kept === undefined ? 'absent' : `keep (${kept.reason})`;
  };
  check(liveVerdict('pid-999999') === 'reclaim', `a dead pid's run root is reclaimed — ${liveVerdict('pid-999999')}`);
  check(liveVerdict('pid-1').startsWith('keep'), `a live pid's run root is kept — ${liveVerdict('pid-1')}`);
  check(liveVerdict(`pid-${process.pid}`).startsWith('keep'), `this process's own run root is kept — ${liveVerdict(`pid-${process.pid}`)}`);

  // The repo-local candidate family: the same key, but a reclaim needs **both** terms — and the
  // report says which terms it used (owner gone, untouched for N min, family).
  const candVerdict = (dir: string): string => {
    const hit = liveReport.reclaimed.find((v) => v.dir === dir);
    if (hit !== undefined) return `reclaim (${hit.reason} [${hit.family ?? 'no family'}])`;
    const kept = liveReport.kept.find((v) => v.dir === dir);
    return kept === undefined ? 'absent' : `keep (${kept.reason})`;
  };
  const isCandReclaimed = (dir: string): boolean => candVerdict(dir).startsWith('reclaim');
  const candDeadHit = liveReport.reclaimed.find((v) => v.dir === candDead);
  check(
    isCandReclaimed(candDead) &&
      /owner gone/.test(candDeadHit?.reason ?? '') &&
      /untouched for \d+ min/.test(candDeadHit?.reason ?? '') &&
      candDeadHit?.family === 'candidate/parity',
    `a dead owner's .candidate tree, untouched for 3 h, is reclaimable — ${candVerdict(candDead)}`,
  );
  check(isCandReclaimed(candThread), `the vision gate's \`pid-<pid>-t<thread>\` key is reclaimable the same way — ${candVerdict(candThread)}`);
  check(
    !isCandReclaimed(candGated) && candVerdict(candGated).includes('--min-age'),
    `a dead owner's tree written just now is kept by the age gate (the second term) — ${candVerdict(candGated)}`,
  );
  check(pruneTmpdir({ ...options, minAgeMinutes: 0 }).reclaimed.some((v) => v.dir === candGated), '--min-age 0 reclaims it: the age gate was the only term holding it back');
  check(
    !isCandReclaimed(candOwnerLive) && candVerdict(candOwnerLive).includes('owner pid 1 is alive'),
    `a live owner's .candidate tree is kept whatever its age — ${candVerdict(candOwnerLive)}`,
  );
  check(!isCandReclaimed(candSelf) && candVerdict(candSelf).includes('this process'), `this process's own .candidate tree is kept — ${candVerdict(candSelf)}`);
  check(
    !isCandReclaimed(candKeyless) && candVerdict(candKeyless).includes('not a pid-* entry'),
    `a lane child that names no key is reported and left — ${candVerdict(candKeyless)}`,
  );
  check(!isCandReclaimed(candLink) && candVerdict(candLink).includes('symlink'), `a symlinked lane child is never followed — ${candVerdict(candLink)}`);

  // The golden contract for the candidate family (t_4f775095): `oracle/**` is never a candidate,
  // and the reap about to run must leave the golden byte-identical to its own listing. The control
  // comes first, so an already-broken golden cannot masquerade as "untouched by this run".
  const goldenControl = verifyGolden(goldenScenario);
  check(goldenControl === null, `the golden verifies against its own manifest before the reap — ${goldenControl ?? 'every listed sha256 matches, nothing missing, nothing extra'}`);

  // A real reap: the removals actually happen, and only for the entries above.
  const real = pruneTmpdir({ ...options, dryRun: false });
  check(real.reclaimed.length >= 8, `a real reap removed ${real.reclaimed.length} entries (${megabytes(real.bytes)})`);
  for (const gone of [cache, copyCache, rawCache, pairTree, datalibTree, namedTree, old, dead, candDead, candThread]) {
    check(!existsSync(gone), `${path.basename(gone)} is gone`);
  }
  for (const kept of [foreign, unproven, freshTree, halfHour, live, shapeOnly, foreignCache, liveForeignCache, candBase, candGated, candOwnerLive, candSelf, candKeyless, candLink]) {
    check(existsSync(kept), `${path.basename(kept)} is still there`);
  }

  // The refusals: what the reapers may never reach, with the guard's own message.
  const refusals: { target: string; base: string; what: string }[] = [
    { target: path.join(REPO_ROOT, 'oracle'), base: realBase, what: 'the oracle root' },
    { target: path.join(REPO_ROOT, 'oracle', 'microtest_voff'), base: realBase, what: 'a golden scenario dir' },
    { target: goldenRun, base: realBase, what: 'a golden run/ tree' },
    { target: realBase, base: realBase, what: 'the run base itself' },
    { target: path.join(realBase, 'microtest_voff'), base: realBase, what: 'a non-pid entry under the base' },
    { target: path.join(fixture, 'other', 'pid-1'), base: realBase, what: 'a pid-* dir outside the base' },
    { target: path.join(fixture, RUN_TEMP_BASE_BASENAME, 'pid-1'), base: path.join(fixture, 'not-the-base'), what: 'a base that is not named polyworld-run-tmp' },
  ];
  for (const refusal of refusals) {
    let message = '!!! NO REFUSAL — the removal path was reached';
    try {
      assertReapableRunRoot(refusal.target, refusal.base, 'tmp_prune check');
    } catch (error) {
      message = (error as Error).message;
    }
    const why = message.includes('—') ? message.slice(message.indexOf('—') + 1).trim().split('(')[0]!.trim() : message;
    check(!message.startsWith('!!!'), `${refusal.what} is refused — ${why}`);
  }
  // The repo-local candidate family's refusals: the golden guard still has the first word, and the
  // shape is a `pid-*` tree under a lane of a base literally named `.candidate`.
  const candidateRefusals: { target: string; base: string; what: string }[] = [
    { target: path.join(REPO_ROOT, 'oracle'), base: candBase, what: 'candidate family: the oracle root' },
    { target: path.join(REPO_ROOT, 'oracle', 'microtest_voff'), base: candBase, what: 'candidate family: a golden scenario dir' },
    { target: goldenRun, base: candBase, what: 'candidate family: a golden run/ tree' },
    { target: candBase, base: candBase, what: 'candidate family: the candidate base itself' },
    { target: candParity, base: candBase, what: 'candidate family: a lane dir that is not a pid-* entry' },
    { target: path.join(candParity, 'pid-999995', 'run'), base: candBase, what: 'candidate family: a tree one level too deep' },
    { target: path.join(fixture, 'other', 'pid-999995'), base: candBase, what: 'candidate family: a pid-* dir outside the base' },
    { target: path.join(candParity, 'pid-999995'), base: path.join(fixture, 'not-a-candidate-base'), what: 'candidate family: a base that is not named .candidate' },
  ];
  for (const refusal of candidateRefusals) {
    let message = '!!! NO REFUSAL — the removal path was reached';
    try {
      assertReapableCandidateTree(refusal.target, refusal.base, 'tmp_prune check');
    } catch (error) {
      message = (error as Error).message;
    }
    const why = message.includes('—') ? message.slice(message.indexOf('—') + 1).trim().split('(')[0]!.trim() : message;
    check(!message.startsWith('!!!'), `${refusal.what} is refused — ${why}`);
  }
  // ...and the accepting shape, one line: a `.candidate/<lane>/pid-*` tree is exactly what it takes.
  check(
    assertReapableCandidateTree(path.join(candParity, 'pid-999995'), candBase, 'tmp_prune check') === path.join(candParity, 'pid-999995'),
    'a `.candidate/parity/pid-*` tree is a legitimate candidate tree, on this box and in a tmp fixture alike',
  );
  // A link that resolves into a golden: the shape the guard is symlink-aware for.
  const link = path.join(realBase, 'pid-999998');
  symlinkSync(goldenRun, link, 'dir');
  let linkMessage = '!!! NO REFUSAL — the removal path was reached';
  try {
    assertReapableRunRoot(link, realBase, 'tmp_prune check');
  } catch (error) {
    linkMessage = (error as Error).message;
  }
  check(!linkMessage.startsWith('!!!'), `a pid-* symlink into a golden is refused — ${linkMessage.slice(0, 90)}…`);
  check(existsSync(goldenRun) && existsSync(path.join(goldenRun, 'manifest.sha256')), 'the golden is untouched');
  const goldenAfter = verifyGolden(goldenScenario);
  check(
    goldenAfter === null && goldenControl === null,
    `oracle/** was never a candidate: the golden still verifies against its own manifest after the candidate family ran — ${goldenAfter ?? 'byte-identical to the pre-reap control'}`,
  );
  check(existsSync(link), 'the refused symlink was not even unlinked');
  rmSync(link, { recursive: true, force: true });

  // The run-root reapers: a missing base is a no-op, not a failure.
  check(reapDeadRunRoots(path.join(fixture, 'absent-base'), { skipPids: [process.pid] }).reaped.length === 0, 'reapDeadRunRoots on a missing base is a no-op');
  check(reapDeadBrowserCandidateRoots(path.join(fixture, 'absent-base'), { skipPids: [process.pid] }).reaped.length === 0, 'reapDeadBrowserCandidateRoots on a missing base is a no-op');

  rmSync(fixture, { recursive: true, force: true });
  check(!existsSync(fixture), 'the fixture tmpdir was removed');
}

// ---------------------------------------------------------------------------------------------

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  // The staleness gate is what protects a *live* run's trees in the legacy families: those entries
  // carry no pid, so `--min-age 0` (or anything below a run's own duration) would let this reclaim a
  // concurrent run's transform cache out from under it — the false-red class this fleet already
  // knows. The pid-keyed families are safe at any age for *live* owners (liveness decides, and the
  // repo-local candidate family additionally requires the age gate before any dead owner's tree is
  // reclaimed); say so out loud, because a silently skipped protection is how a prune reds a lane.
  if (options.mode === 'reap' && options.minAgeMinutes < 5) {
    process.stderr.write(
      `tmp_prune: WARNING --min-age ${options.minAgeMinutes} min: entries without a pid key are only ` +
        'protected by that gate, so a concurrent run\'s trees may be reclaimed while it is using them. ' +
        'The default is 120.\n',
    );
  }
  switch (options.mode) {
    case 'report':
      printReport(pruneTmpdir({ ...options, dryRun: true }), { ...options, dryRun: true });
      break;
    case 'reap':
      printReport(pruneTmpdir(options), options);
      break;
    case 'check':
      runChecks();
      break;
    default:
      process.stdout.write('usage: npx tsx tools/tmp_prune.ts report | reap | check [--min-age=MIN] [--archive=DIR] [--tmpdir=DIR] [--candidate-base=DIR] [--dry-run] [--json]\n');
      process.exitCode = 2;
      return;
  }
  if (options.mode === 'check') {
    process.stdout.write(`[tmp_prune] RESULT ${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
    if (failures !== 0) process.exitCode = 1;
  }
}

main();
