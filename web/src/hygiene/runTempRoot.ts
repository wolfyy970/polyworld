/**
 * The test run's own temp root, and its lifecycle (task t_841decd7).
 *
 * **The leak.** `$TMPDIR` = `/private/var/folders/…/T` had grown to **19,013 entries / ~67 GB**, and
 * `/System/Volumes/Data` (926 GB, the boot volume) was at **1.6 GB free**. Measured 2026-09-29
 * 03:49, this checkout: **14,386 directories / 60.1 GB**, in three families, all of them this
 * project's own temp trees:
 *
 * | shape | what writes it | measured |
 * |---|---|---|
 * | `<nanoid>/ssr/<sha1>` — 1.5–6 MB each | **Class 1**: vitest 5's per-project transform cache. `VitestProject.tmpDir = join(tmpdir(), nanoid())` (vitest/dist, `ModuleFetcher`), and the `forks` pool always sets `cacheFs = true`, so the *main* process writes every transformed module there (`join(tmpDir, environment.name)`, `hash('sha1', id, 'hex')`) — one directory per run, never removed. | 1,738 dirs, 8.2 GB |
 * | `adami-*`, `cppprops-sim-*`, `cppprops-rngseed-*`, `l13-seam-*`, `t2a625bd5-ctor-*`, `t_1d2cd75d-foodradius-*`, `complexityprobe-*` | **Class 2**: the tests' own `mkdtempSync(join(tmpdir(), …))` run trees — whole candidate runs (`run/original.wf`, `run/genome/**`, `run/motion/**`), ~10–90 MB each | 3,290 dirs, 41.6 GB |
 * | `polyworld-browser-candidates/pid-*`, `polyworld-genome-candidates/pid-*` | **Class 3**: the per-process candidate roots of t_1ce9957f / t_37bf7212. Their reap only collects a **dead** pid's tree, so a live process's tree — the one the run it belongs to just made — survives until some *later* run happens to sweep. | included above |
 *
 * **Why it matters beyond disk.** The box is the boot volume and also runs the Studio's services; out
 * of space, a build or a native probe fails for reasons that look like a parity failure and are not
 * (the false-vitest-red class of t_84885d07, arriving through a second door).
 *
 * **The rule.** A run's temp trees do not outlive the run. `os.tmpdir()` is the single seam every
 * one of the three families passes through — vitest's `join(tmpdir(), nanoid())`, the tests'
 * `mkdtempSync(join(tmpdir(), …))` and the candidate roots' `join(os.tmpdir(), …)` — so
 * {@link installRunTempRoot} moves **the whole run** into one directory keyed by the process that
 * owns it:
 *
 * ```
 * <real $TMPDIR>/polyworld-run-tmp/pid-<pid>/        <- $TMPDIR for everything in the run
 * ```
 *
 * and removes that directory when the process ends (a normal exit, `process.exit()`, or the
 * `SIGTERM`/`SIGINT` a harness or a supervisor sends). `process.env.TMPDIR` is set *before* vitest
 * constructs its project (`vitest.config.ts` is evaluated first — measured: 2 test files, 2 fork
 * workers, exactly **one** cache dir per run, made by the main process) and `node:os` does not cache
 * `tmpdir()` (measured on node 22.22.2: re-reads the env var on every call), so every family lands
 * under the key without touching a single call site. `node-compile-cache` — which Node creates
 * under `$TMPDIR` at process start, i.e. in the *real* tmpdir before this module runs — is pinned
 * to its shared location by `NODE_COMPILE_CACHE`, so the redirect does not cost a cold V8 cache per
 * worker.
 *
 * **Why keyed, not "swept by whoever runs next".** The point of the key is that ownership is
 * *provable*: a directory named `pid-<n>` under `polyworld-run-tmp` belongs to pid `n` and can be
 * removed only when `n` is gone, which is what makes this root safe to reap from another process.
 * A shape-matched sweep ("something that looks like our ssr cache") cannot tell a *concurrent* run's
 * live cache from a dead one, and deleting a live run's transformed modules is exactly the
 * load-sensitive false red this fleet has already been bitten by.
 *
 * The same key is what `tools/tmp_prune.ts` reaps — the unattended supervisor cannot run `rm -rf`
 * (the cron approval block), so a prune the fleet can run on its own is the durable answer.
 *
 * Pins, mirroring `POLYWORLD_BROWSER_CANDIDATE_ROOT` / `POLYWORLD_KEEP_BROWSER_CANDIDATES`:
 * `POLYWORLD_RUN_TMP_ROOT` pins the root **verbatim** (no key appended; the caller owns it and it is
 * never swept) and `POLYWORLD_KEEP_RUN_TMP=1` keeps this run's root for inspection after a red.
 */

import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertUsableStagingRoot, resolveExisting } from '../oracle/guard';
// The pid-liveness probe t_2821ab7f introduced for the logs staging root, then t_1ce9957f reused —
// reused again rather than re-derived, so the reapers cannot disagree about what "gone" means.
import { isProcessAlive } from '../oracle/logsStaging';

/** The basename of the run temp base under `$TMPDIR` (`…/polyworld-run-tmp`). */
export const RUN_TEMP_BASE_BASENAME = 'polyworld-run-tmp';

/** `pid-<pid>` — the only name this module creates, removes, or reaps. */
export const RUN_ROOT_NAME = /^pid-(\d+)$/;

/** Pin the run root (used verbatim, never swept): `POLYWORLD_RUN_TMP_ROOT`. */
export const RUN_ROOT_ENV = 'POLYWORLD_RUN_TMP_ROOT';

/** Keep this run's root for inspection: `POLYWORLD_KEEP_RUN_TMP=1`. */
export const KEEP_RUN_TMP_ENV = 'POLYWORLD_KEEP_RUN_TMP';

/** The base the keyed run roots live in: `<tmpdir>/polyworld-run-tmp`. */
export function runTempBase(tmpdir: string = os.tmpdir()): string {
  return path.join(tmpdir, RUN_TEMP_BASE_BASENAME);
}

/** The keyed run root for `pid`: `<tmpdir>/polyworld-run-tmp/pid-<pid>`. */
export function defaultRunTempRoot(tmpdir: string, pid: number, thread = 0): string {
  const leaf = thread === 0 ? `pid-${pid}` : `pid-${pid}-t${thread}`;
  return path.join(tmpdir, RUN_TEMP_BASE_BASENAME, leaf);
}

/** The pid a run root name belongs to, or `null` when the name is not one. */
export function runRootPidOf(dirName: string): number | null {
  const match = RUN_ROOT_NAME.exec(dirName);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
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

/** Is `root` this checkout's keyed run root for *some* pid — i.e. not a caller-pinned root? */
export function isKeyedRunRoot(root: string): boolean {
  const resolved = resolveExisting(root);
  return (
    path.basename(path.dirname(resolved)) === RUN_TEMP_BASE_BASENAME && runRootPidOf(path.basename(resolved)) !== null
  );
}

/**
 * Throw unless `dir` may be removed: the frozen-golden guard first (so the oracle root, a scenario
 * dir, a golden `run/` tree and anything resolving into one are refused with the guard's own
 * message), then containment in a directory literally named `polyworld-run-tmp`, then the
 * `pid-<pid>` key that names the owner. Same shape and same refusal order as
 * `assertReapableBrowserCandidateDir` (src/browser/sim/candidateRoots.ts).
 */
export function assertReapableRunRoot(dir: string, base: string, what: string): string {
  assertUsableStagingRoot(dir, what);

  const resolvedBase = resolveExisting(base);
  if (path.basename(resolvedBase) !== RUN_TEMP_BASE_BASENAME) {
    throw new Error(
      `${what}: refusing ${dir} — ${base} is not the run temp base (\`${RUN_TEMP_BASE_BASENAME}\`); ` +
        'only its `pid-*` children are ever removed (src/oracle/guard.ts, src/hygiene/runTempRoot.ts).',
    );
  }

  const resolvedDir = resolveExisting(dir);
  const rel = path.relative(resolvedBase, resolvedDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || runRootPidOf(rel) === null) {
    throw new Error(
      `${what}: refusing ${dir} — it is not a \`pid-<pid>\` direct child of ${resolvedBase}` +
        `${resolvedDir !== path.resolve(dir) ? ` (it resolves to ${resolvedDir})` : ''}.`,
    );
  }
  return dir;
}

/** Remove one run root: `assertReapableRunRoot` first, then `rmSync(recursive)`. */
export function removeRunRoot(dir: string, base: string, what: string): boolean {
  assertReapableRunRoot(dir, base, what);
  if (!entryExists(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface RunRootReapReport {
  /** The roots removed (each held a dead run's temp trees). */
  readonly reaped: string[];
  /** Entries left alone, with the reason — a live owner, a foreign name, a refusal. */
  readonly kept: { dir: string; why: string }[];
}

/**
 * Remove the `pid-*` run roots under `base` whose owning process is gone. A live owner is skipped (a
 * concurrent run's temp trees must not vanish under it), a name that is not `pid-*` is skipped
 * (nothing owns it), and a root the guard refuses is skipped with the refusal as the reason. A
 * missing base — or an empty one — is a no-op.
 */
export function reapDeadRunRoots(base: string, options: { skipPids?: readonly number[] } = {}): RunRootReapReport {
  const reaped: string[] = [];
  const kept: { dir: string; why: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return { reaped, kept };
  }
  const skip = options.skipPids ?? [];

  for (const name of entries.sort()) {
    const dir = path.join(base, name);
    const pid = runRootPidOf(name);
    if (pid === null) {
      kept.push({ dir, why: 'not a pid-* run root' });
      continue;
    }
    if (skip.includes(pid)) {
      kept.push({ dir, why: `pid ${pid} is this process (its trees are in use)` });
      continue;
    }
    if (isProcessAlive(pid)) {
      kept.push({ dir, why: `owner pid ${pid} is alive` });
      continue;
    }
    try {
      if (removeRunRoot(dir, base, 'reapDeadRunRoots')) reaped.push(dir);
      else kept.push({ dir, why: 'already gone' });
    } catch (error) {
      kept.push({ dir, why: `refused: ${(error as Error).message}` });
    }
  }
  return { reaped, kept };
}

export interface RunTempSweepReport {
  /** False when the sweep was skipped — a pinned root, `POLYWORLD_KEEP_RUN_TMP=1`, or already swept. */
  readonly ran: boolean;
  readonly skippedBecause?: string;
  /** This process's own root, removed (the run is over; its trees are no longer needed). */
  readonly removedOwn: string[];
  /** Dead *other* runs' roots, collected on the same path. */
  readonly reaped: string[];
  readonly kept: { dir: string; why: string }[];
  /** What went wrong. An exit handler must not throw, so a failure lands here (and on stderr). */
  readonly errors: string[];
}

export interface RunTempInstallOptions {
  /** The **real** tmpdir to key under (defaults to `os.tmpdir()`, read before any redirect). */
  readonly tmpdir?: string;
  /** A caller-chosen root, used verbatim (defaults to `POLYWORLD_RUN_TMP_ROOT`). */
  readonly pinned?: string;
  /** Keep this run's root (defaults to `POLYWORLD_KEEP_RUN_TMP === '1'`). */
  readonly keep?: boolean;
  /** The pid to key by (defaults to `process.pid`). */
  readonly pid?: number;
}

export interface RunTempReport {
  readonly installed: boolean;
  /** False when the root is a caller pin — used verbatim, never swept. */
  readonly keyed: boolean;
  /** True when this process found itself already inside a run root (a nested run) and adopted it. */
  readonly adopted: boolean;
  readonly keep: boolean;
  /** The root that became `$TMPDIR` for this process and its children. */
  readonly root: string;
  readonly base: string;
  readonly pid: number;
  /** The sweep the exit path runs — callable directly (the probes do) and idempotent. */
  sweep(): RunTempSweepReport;
}

let installed: RunTempReport | null = null;

/**
 * The signals a harness or a supervisor uses to end a process. **Load-bearing, measured** (t_2821ab7f):
 * a process that dies from a signal runs no `exit` listener at all, so an `exit`-only hook cleans
 * nothing when vitest's fork pool kills a worker or a supervisor kills a run.
 */
const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Move this process (and every child it spawns afterwards) into a run root keyed by its pid, and
 * remove that root when the process ends. **At most once per process**; a second call returns the
 * same report.
 *
 * Called from `vitest.config.ts` — the config module is evaluated before vitest constructs its
 * project, so the `join(os.tmpdir(), nanoid())` that decides vitest's own transform cache already
 * sees the keyed root. Outside a vitest run nothing calls it, which is why the module is safe to
 * import from anywhere (a tool, a probe).
 */
export function installRunTempRoot(options: RunTempInstallOptions = {}): RunTempReport {
  if (installed !== null) return installed;

  const tmpdir = options.tmpdir ?? os.tmpdir();
  const pinned = options.pinned ?? process.env[RUN_ROOT_ENV];
  const pinnedRoot = pinned !== undefined && pinned.length > 0 ? pinned : undefined;
  const keep = options.keep ?? process.env[KEEP_RUN_TMP_ENV] === '1';
  const pid = options.pid ?? process.pid;
  const base = runTempBase(tmpdir);

  // A nested run (a config evaluated inside a tree that is already a run root) adopts the root it
  // was handed: it belongs to the outermost process, which is the one that will clean it up.
  const current = os.tmpdir();
  const adopted = pinnedRoot === undefined && isKeyedRunRoot(current);

  let root: string;
  if (pinnedRoot !== undefined) {
    root = path.resolve(pinnedRoot);
  } else if (adopted) {
    root = resolveExisting(current);
  } else {
    root = defaultRunTempRoot(tmpdir, pid);
    // Refuse before anything exists: this is the same guard the reaper uses, so a root that could
    // later be reaped is a root that could be created now, and vice versa.
    assertReapableRunRoot(root, base, `run temp root (pid ${pid})`);
  }

  let swept = false;
  const report: RunTempReport = {
    installed: true,
    keyed: pinnedRoot === undefined && !adopted,
    adopted,
    keep,
    root,
    base: adopted ? path.dirname(root) : base,
    pid,
    sweep(): RunTempSweepReport {
      if (swept) {
        return { ran: false, skippedBecause: 'already swept (once per process)', removedOwn: [], reaped: [], kept: [], errors: [] };
      }
      swept = true;
      if (pinnedRoot !== undefined) {
        return {
          ran: false,
          skippedBecause: `${RUN_ROOT_ENV} pinned the root (the caller manages it)`,
          removedOwn: [],
          reaped: [],
          kept: [],
          errors: [],
        };
      }
      if (keep) {
        return { ran: false, skippedBecause: `${KEEP_RUN_TMP_ENV}=1`, removedOwn: [], reaped: [], kept: [], errors: [] };
      }
      const errors: string[] = [];
      const removedOwn: string[] = [];
      if (!adopted) {
        try {
          if (removeRunRoot(root, report.base, 'run temp root (own pid)')) removedOwn.push(root);
        } catch (error) {
          errors.push(`remove(${root}): ${(error as Error).message}`);
        }
      }
      const reap = reapDeadRunRoots(report.base, { skipPids: [pid] });
      return { ran: true, removedOwn, reaped: reap.reaped, kept: reap.kept, errors };
    },
  };
  installed = report;

  if (!adopted) {
    mkdirSync(root, { recursive: true });
  }

  // The seam itself. Every `join(os.tmpdir(), …)` from here on — vitest's transform cache, the
  // tests' run trees, the candidate roots — lands under the key instead of beside 19,000 others.
  // `os.tmpdir()` does not cache (node 22.22.2, measured), and children inherit the env, so one
  // assignment covers the whole run. A pin is used verbatim, which is how a caller keeps a path it
  // can name (the same contract POLYWORLD_BROWSER_CANDIDATE_ROOT has).
  process.env.TMPDIR = root;

  // Node creates `$TMPDIR/node-compile-cache` at process start — i.e. in the *real* tmpdir, before
  // this module runs. Without this line the fork workers would inherit the keyed TMPDIR, find no
  // cache there, and rebuild a cold V8 compile cache per worker per run. Pin it to where it already
  // is, so the redirect costs nothing.
  if (process.env.NODE_COMPILE_CACHE === undefined && !adopted) {
    process.env.NODE_COMPILE_CACHE = path.join(tmpdir, 'node-compile-cache');
  }

  const sweepQuietly = (): void => {
    try {
      const sweptReport = report.sweep();
      // An exit handler cannot throw (it would mask the real exit status), so a failure is *said*
      // rather than swallowed — a silently-not-cleaning hook is the leak this module exists for.
      if (sweptReport.errors.length > 0) {
        process.stderr.write(`run temp root cleanup (pid ${process.pid}): ${sweptReport.errors.join('; ')}\n`);
      }
    } catch (error) {
      try {
        process.stderr.write(`run temp root cleanup (pid ${process.pid}) failed: ${(error as Error).message}\n`);
      } catch {
        /* stderr itself is gone: there is nothing left to report to */
      }
    }
  };

  if (!adopted && !keep && pinnedRoot === undefined) {
    // A normal exit and `process.exit()`: the handler is synchronous, as an exit handler must be.
    process.once('exit', sweepQuietly);

    // A signal-terminated teardown (a supervisor's `kill`, Ctrl-C): sweep, then die by the signal
    // exactly as the process would have without this module — the listener goes first, so the
    // re-raised signal takes the default action and the observed exit status is unchanged.
    for (const signal of TERMINATION_SIGNALS) {
      const handler = (): void => {
        sweepQuietly();
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      };
      process.on(signal, handler);
    }
  }

  return report;
}

/** The report `installRunTempRoot` returned in this process, or `null`. */
export function runTempRoot(): RunTempReport | null {
  return installed;
}
