/**
 * The logs staging root's lifecycle (task t_2821ab7f).
 *
 * **The leak.** `oracle/_t_logs_candidates/pid-<pid>[-t<thread>]` — the per-process candidate root
 * `t_37bf7212` introduced in `tests/logsCorpus.ts` — was never removed by anything. The corpus wiped
 * and rebuilt the scenario trees it was about to write (`freshDir`), but no exit hook, age sweep or
 * `afterAll` ever touched the root itself. Measured 2026-09-29 02:27: **57 pid dirs / 274 MB, all
 * born in a ~17-minute window** of parallel lane acceptance testing — ~16 MB/min while the fleet is
 * busy (an hour of fleet testing ≈ 1 GB), on the system SSD the owner keeps models off. All of it is
 * gitignored and under the reserved `oracle/_t_*` prefix, so it never showed up in parity, in the
 * goldens, or in `git status`; the harm is unbounded disk growth.
 *
 * **The rule.** A candidate dir does not outlive the process that made it.
 *  1. When the process ends — a normal exit, `process.exit()`, or the `SIGTERM`/`SIGINT` a harness
 *     kills a worker with — it removes the dirs **it owns**: `pid-<our pid>` and `pid-<our pid>-t<n>`
 *     (the `threads` pool stages one per worker thread inside one pid, so all of them are ours).
 *     The signals are load-bearing, not decoration: a process that dies by a signal runs **no**
 *     `exit` listener, so an `exit`-only hook cleaned nothing under vitest's fork pool — measured,
 *     the suite left one `pid-<worker>` dir per file that imports the corpus.
 *  2. From that same path, and **at most once per process**, it reaps the `pid-*` dirs whose
 *     owning pid is **no longer alive**. A dir whose pid *is* alive is never touched: a concurrent
 *     lane's tree must not be deleted from underneath it. Dir entries that are not `pid-*` (the
 *     pre-`t_37bf7212` shared-root leftovers, another consumer's staging) are never touched either.
 *
 * A **pinned** root (`POLYWORLD_LOGS_CANDIDATE_ROOT`) is the caller's to manage and is not swept at
 * all — the caller chose a path outside this module's namespace. `POLYWORLD_KEEP_LOGS_CANDIDATES=1`
 * (inspecting a failed replay) disables the whole path for the process that sets it, so the tree it
 * wants to read back is still there when the process is gone.
 *
 * **The guard.** Nothing is ever removed before `assertReapableCandidateDir` passes. The target must
 * be a `pid-<n>[-t<n>]` **child** of a directory literally named `_t_logs_candidates`; its
 * *resolved* path (symlinks followed, `resolveExisting`) must be inside that root, so a link that
 * points out of it is refused; and `assertUsableStagingRoot` — the frozen-golden guard in
 * `src/oracle/guard.ts`, not a fresh path check — must accept it, which is what refuses the oracle
 * root, a scenario dir and a golden `run/` tree with the guard's own message.
 */

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { GoldenWriteRefused, assertUsableStagingRoot, isStagedPath, oracleRoot, resolveExisting } from './guard';

/** The logs staging root's basename under the oracle root: `<oracle>/_t_logs_candidates`. */
export const LOGS_CANDIDATE_ROOT_BASENAME = '_t_logs_candidates';

/** `pid-<pid>` (main/`forks`) or `pid-<pid>-t<thread>` (`threads` pool) — the only names removable. */
export const CANDIDATE_DIR_NAME = /^pid-(\d+)(?:-t(\d+))?$/;

/** The pid a candidate dir name belongs to, or `null` when the name is not a candidate dir name. */
export function ownerPidOf(dirName: string): number | null {
  const match = CANDIDATE_DIR_NAME.exec(dirName);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Is `pid` a live process? `process.kill(pid, 0)` is the existence probe: `EPERM` means the pid
 * exists but belongs to another user (still alive — never reap it), `ESRCH` means it does not.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Throw `GoldenWriteRefused` unless `dir` may be removed by this module: the guard's acceptance,
 * containment in the logs staging root, and the `pid-*` name.
 */
export function assertReapableCandidateDir(dir: string, root: string, what: string): string {
  // The guard first: the oracle root, a scenario dir, a golden `run/` tree and anything inside one
  // are refused with the guard's own message — the diagnostics a probe quotes come from here.
  assertUsableStagingRoot(dir, what);

  const resolvedRoot = resolveExisting(root);
  if (path.basename(resolvedRoot) !== LOGS_CANDIDATE_ROOT_BASENAME) {
    throw new GoldenWriteRefused(
      `${what}: refusing ${dir} — ${resolvedRoot} is not the logs staging root ` +
        `(\`${LOGS_CANDIDATE_ROOT_BASENAME}\`); only its \`pid-*\` children are ever removed ` +
        '(src/oracle/guard.ts, src/oracle/logsStaging.ts).',
    );
  }

  const resolvedDir = resolveExisting(dir);
  const rel = path.relative(resolvedRoot, resolvedDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new GoldenWriteRefused(
      `${what}: refusing ${dir} — it is not a direct child of ${resolvedRoot}` +
        `${resolvedDir !== path.resolve(dir) ? ` (it resolves to ${resolvedDir})` : ''}. ` +
        'Only `pid-*` children of the logs staging root are ever removed ' +
        '(src/oracle/guard.ts, src/oracle/logsStaging.ts).',
    );
  }

  const basename = path.basename(resolvedDir);
  if (ownerPidOf(basename) === null) {
    throw new GoldenWriteRefused(
      `${what}: refusing ${dir} — \`${basename}\` is not a \`pid-<pid>[-t<thread>]\` candidate dir, ` +
        'so nothing owns it and nothing may remove it (src/oracle/guard.ts, src/oracle/logsStaging.ts).',
    );
  }

  // Belt, within the configured oracle root only: `isStagedPath` cannot place a *worktree* lane's
  // candidate root when `POLYWORLD_ORACLE_ROOT` points at the canonical tree (the root then sits
  // outside the configured oracle root), so it is a refusal reason here, never a requirement.
  if (isInside(resolvedDir, resolveExisting(oracleRoot())) && !isStagedPath(dir)) {
    throw new GoldenWriteRefused(
      `${what}: refusing ${dir} — it is inside the oracle root but is not a staged (\`_t_*\`) path, ` +
        'so removing it could reach a golden (src/oracle/guard.ts, src/oracle/logsStaging.ts).',
    );
  }

  return dir;
}

/** Remove one candidate dir: `assertReapableCandidateDir` first, then `rmSync(recursive)`. */
export function removeCandidateDir(dir: string, root: string, what: string): boolean {
  assertReapableCandidateDir(dir, root, what);
  if (!entryExists(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface ReapReport {
  /** The dirs removed (they held artifacts; the point of the exercise). */
  readonly reaped: string[];
  /** Entries left alone, with the reason — a live owner, a foreign name, a refusal. */
  readonly kept: { dir: string; why: string }[];
}

/**
 * Remove the `pid-*` dirs under `root` whose owning process is gone. A live owner is skipped (a
 * concurrent lane's tree), a name that is not `pid-*` is skipped (nothing owns it), and a dir the
 * guard refuses is skipped with the refusal as the reason. A missing root — or a root with nothing
 * in it — is a no-op.
 */
export function reapDeadCandidateDirs(root: string, options: { skipPids?: readonly number[] } = {}): ReapReport {
  const reaped: string[] = [];
  const kept: { dir: string; why: string }[] = [];
  if (!entryExists(root)) return { reaped, kept };

  const skipPids = options.skipPids ?? [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { reaped, kept };
  }

  for (const name of entries.sort()) {
    const dir = path.join(root, name);
    const pid = ownerPidOf(name);
    if (pid === null) {
      kept.push({ dir, why: 'not a pid-* candidate dir' });
      continue;
    }
    if (skipPids.includes(pid)) {
      kept.push({ dir, why: `pid ${pid} is this process (handled by the owner path)` });
      continue;
    }
    if (isProcessAlive(pid)) {
      kept.push({ dir, why: `owner pid ${pid} is alive` });
      continue;
    }
    try {
      if (removeCandidateDir(dir, root, 'reapDeadCandidateDirs')) reaped.push(dir);
      else kept.push({ dir, why: 'already gone' });
    } catch (error) {
      kept.push({ dir, why: `refused: ${(error as Error).message}` });
    }
  }
  return { reaped, kept };
}

export interface SweepReport {
  /** False when the sweep was skipped — pinned root, `KEEP_LOGS_CANDIDATES`, or already swept. */
  readonly ran: boolean;
  readonly skippedBecause?: string;
  /** The dirs this process owned and removed. */
  readonly removedOwn: string[];
  readonly reaped: string[];
  readonly kept: { dir: string; why: string }[];
  /** What went wrong. An exit handler must not throw, so a failure lands here (and on stderr). */
  readonly errors: string[];
}

export interface LogsStagingCleanupOptions {
  /** This process's own candidate dir (`<root>/pid-<pid>[-t<thread>]`). */
  readonly dir: string;
  /** The root the per-process dirs live in (`<oracle>/_t_logs_candidates`). */
  readonly root: string;
  /** True when `POLYWORLD_LOGS_CANDIDATE_ROOT` pinned a caller-chosen root. */
  readonly pinned: boolean;
  /** True when `POLYWORLD_KEEP_LOGS_CANDIDATES=1`. */
  readonly keep: boolean;
}

export interface LogsStagingCleanupReport {
  readonly installed: boolean;
  readonly dir: string;
  readonly root: string;
  readonly pinned: boolean;
  readonly keep: boolean;
  /** The sweep the exit path runs — callable directly (the probes do) and idempotent. */
  sweep(): SweepReport;
}

let installed: LogsStagingCleanupReport | null = null;

/**
 * The signals a harness uses to end a worker. **Load-bearing, measured:** vitest's fork pool
 * finishes a test file by sending its worker `SIGTERM` (`worker.kill()`), and a process that dies
 * from a signal runs no `exit` listener at all — so an `exit`-only hook cleaned up nothing in the
 * suite (measured: `npx vitest run` left one `pid-<worker>` dir per file that imports the corpus).
 * `SIGINT` is the same path from a terminal.
 */
const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Remove this process's own candidate dirs (`pid-<our pid>`, `pid-<our pid>-t<n>`), whether or not
 * this particular worker thread's `dir` is one of them: with the `threads` pool every worker thread
 * stages into one process, and the exit event fires once, so the process's own pid is the owner.
 */
function removeOwnCandidateDirs(dir: string, root: string): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  const own: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      if (ownerPidOf(name) === process.pid) own.push(path.join(root, name));
    }
  } catch (error) {
    errors.push(`readdir(${root}): ${(error as Error).message}`);
  }
  if (!own.includes(path.resolve(dir))) own.push(dir);

  for (const target of own) {
    try {
      if (removeCandidateDir(target, root, 'logs staging cleanup (own pid)')) removed.push(target);
    } catch (error) {
      errors.push(`remove(${target}): ${(error as Error).message}`);
    }
  }
  return { removed, errors };
}

/**
 * Install the exit-path cleanup (**at most once per process**; a second call returns the same
 * report). A pinned root or `POLYWORLD_KEEP_LOGS_CANDIDATES=1` installs a sweep that does nothing,
 * which is how the caller's root and a failed replay's tree are kept.
 */
export function installLogsStagingCleanup(options: LogsStagingCleanupOptions): LogsStagingCleanupReport {
  if (installed !== null) return installed;

  let swept = false;
  const report: LogsStagingCleanupReport = {
    installed: true,
    dir: options.dir,
    root: options.root,
    pinned: options.pinned,
    keep: options.keep,
    sweep(): SweepReport {
      if (swept) {
        return { ran: false, skippedBecause: 'already swept (once per process)', removedOwn: [], reaped: [], kept: [], errors: [] };
      }
      swept = true;
      if (options.pinned) {
        return {
          ran: false,
          skippedBecause: 'POLYWORLD_LOGS_CANDIDATE_ROOT pinned the root (the caller manages it)',
          removedOwn: [],
          reaped: [],
          kept: [],
          errors: [],
        };
      }
      if (options.keep) {
        return { ran: false, skippedBecause: 'POLYWORLD_KEEP_LOGS_CANDIDATES=1', removedOwn: [], reaped: [], kept: [], errors: [] };
      }
      const ownDirs = removeOwnCandidateDirs(options.dir, options.root);
      const reap = reapDeadCandidateDirs(options.root, { skipPids: [process.pid] });
      return { ran: true, removedOwn: ownDirs.removed, reaped: reap.reaped, kept: reap.kept, errors: ownDirs.errors };
    },
  };

  installed = report;

  const sweepQuietly = (): void => {
    try {
      const sweptReport = report.sweep();
      // An exit handler cannot throw (it would mask the real exit status), so a failure is *said*
      // rather than swallowed — a silently-not-cleaning hook is the leak this module exists for.
      if (sweptReport.errors.length > 0) {
        process.stderr.write(`logs staging cleanup (pid ${process.pid}): ${sweptReport.errors.join('; ')}\n`);
      }
    } catch (error) {
      try {
        process.stderr.write(`logs staging cleanup (pid ${process.pid}) failed: ${(error as Error).message}\n`);
      } catch {
        /* stderr itself is gone: there is nothing left to report to */
      }
    }
  };

  // A normal exit and `process.exit()`: the handler is synchronous, as an exit handler must be.
  process.once('exit', sweepQuietly);

  // A signal-terminated teardown (vitest's fork pool, a supervisor's `kill`): sweep, then die by the
  // signal exactly as the process would have without this module — the listener goes first, so the
  // re-raised signal takes the default action and the observed exit status is unchanged.
  for (const signal of TERMINATION_SIGNALS) {
    const handler = (): void => {
      sweepQuietly();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }

  return report;
}

/** The report `installLogsStagingCleanup` returned in this process, or `null`. */
export function logsStagingCleanup(): LogsStagingCleanupReport | null {
  return installed;
}
