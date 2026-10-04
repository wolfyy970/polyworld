/**
 * The browser lane's candidate root and its lifecycle (task t_1ce9957f) — where a run tree goes,
 * what a keyed tree says about itself, and which `pid-*` directories may be removed.
 *
 * Split out of `nodeSources.ts` for one concrete reason: this module imports nothing but `node:*`
 * and `src/oracle/*`, so it can be loaded by a plain TS runtime (`npx tsx
 * tools/browser_candidates_probe.ts`), while `nodeSources.ts` pulls the boot chain (and with it the
 * vitest-only `?raw` monitor bundle, which no other runner can resolve). `nodeSources.ts` re-exports
 * everything here, so callers keep importing `candidateRoot` from where they always did.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';

import {
  assertNotGoldenWrite,
  assertUsableCandidateRoot,
  assertUsableStagingRoot,
  resolveExisting,
} from '../../oracle/guard';
// t_1ce9957f: the pid-liveness probe t_2821ab7f introduced for the logs staging root's reap —
// reused rather than re-derived, so the two reapers cannot disagree about what "gone" means.
import { isProcessAlive } from '../../oracle/logsStaging';
import type { ScenarioName } from './scenarios';

/** The basename of the default root's base under `$TMPDIR` (`…/polyworld-browser-candidates`). */
export const BROWSER_CANDIDATE_BASE = 'polyworld-browser-candidates';

/** `pid-<pid>` (a `forks` worker) or `pid-<pid>-t<thread>` (a `threads` worker) — the removable names. */
export const BROWSER_CANDIDATE_DIR_NAME = /^pid-(\d+)(?:-t(\d+))?$/;

/** The manifest a keyed tree carries: it names its own root, so a keyed default is never a lost path. */
export const PROVENANCE_NAME = 'PROVENANCE.txt';

/**
 * Where the lane's candidate run trees go: `POLYWORLD_BROWSER_CANDIDATE_ROOT` or a tmp dir.
 *
 * t_37bf7212: the root is refused when it resolves into the frozen oracle. `writeCandidateTree`
 * builds `<root>/<scenario>/run/**` in place, so `POLYWORLD_BROWSER_CANDIDATE_ROOT=<repo>/oracle`
 * would rebuild the golden itself. Allowed: `$TMPDIR` and `oracle/_t_*`.
 *
 * t_1ce9957f: the **default** is keyed per worker process — `<tmpdir>/polyworld-browser-candidates/`
 * `pid-<pid>[-t<thread>]`. It used to be ONE fixed directory shared by every process on the
 * checkout, while `writeCandidateTree` writes `<root>/<scenario>/run/**` file by file
 * (`writeFileSync` = truncate-then-write) and `worldBoot.test.ts` reads each artifact straight back:
 * two concurrent `npx vitest run` had one process reading a file the other had just truncated —
 * `AssertionError: run/normalized.wf: expected '' to be '@version 2…'` at `worldBoot.test.ts:250`.
 * Measured pre-fix, this checkout: 2 red runs of 32 at 4-way concurrency on that one file, and 1 red
 * pair in 12 at full-suite concurrency. This is the same per-process key t_37bf7212 gave
 * `tests/logsCorpus.ts` and t_d5ed17d8 gave the native probe; the pid covers the `forks` pool (one
 * process per test file), the thread covers `pool: 'threads'` (all workers in one pid).
 *
 * This root is **documented**, which is what makes it different from the probe's private cache: a
 * keyed default would silently move a path a human is told to look in (`PARITY.md`,
 * `src/browser/README.md`, the `runTree.*.test.ts` headers all say
 * `./oracle/run_parity.sh <scenario> --candidate <POLYWORLD_BROWSER_CANDIDATE_ROOT>/<scenario>`).
 * So the key stays discoverable: the keyed tree writes a {@link PROVENANCE_NAME} **beside** `run/`
 * (never inside it — the harness compares `run/**` byte-for-byte) and says its own path on stderr,
 * and `writeCandidateTree`/`runModelIntoTree` return the dir they wrote either way. The env pin is
 * honoured **verbatim**: no key is appended to a caller's root, and nothing is written beside its
 * `run/` — a pinned root is the caller's, and the caller chose a path it can already name.
 */
export function defaultBrowserCandidateRoot(tmpdir: string, pid: number, thread: number): string {
  const leaf = thread === 0 ? `pid-${pid}` : `pid-${pid}-t${thread}`;
  return path.join(tmpdir, BROWSER_CANDIDATE_BASE, leaf);
}

export function candidateRoot(): string {
  const pinned = process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT;
  const root = pinned ?? defaultBrowserCandidateRoot(os.tmpdir(), process.pid, threadId);
  return assertUsableCandidateRoot(root, 'POLYWORLD_BROWSER_CANDIDATE_ROOT (the browser lane candidate root)');
}

/** Is `root` this process's own keyed default — i.e. is no caller-pinned root in play? */
export function isKeyedDefaultRoot(root: string): boolean {
  if (process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT !== undefined) return false;
  return path.resolve(root) === path.resolve(defaultBrowserCandidateRoot(os.tmpdir(), process.pid, threadId));
}

/** What a keyed tree says about itself (see {@link writeCandidateProvenance}). */
export function candidateProvenanceText(dir: string, scenario: ScenarioName): string {
  return [
    `browser lane candidate run tree — src/browser/sim/candidateRoots.ts (t_1ce9957f)`,
    `scenario: ${scenario}`,
    `root:     ${path.dirname(dir)}`,
    `tree:     ${dir}`,
    `process:  pid ${process.pid}, worker thread ${threadId}`,
    ``,
    `The default candidate root is keyed per worker process: concurrent \`npx vitest run\` write the`,
    `same \`<root>/<scenario>/run/**\` paths file by file, so each process gets a \`pid-<pid>[-t<thread>]\``,
    `directory of its own. This file is what keeps that key discoverable — the path is not stable, so`,
    `nothing else may hard-code it.`,
    ``,
    `Grade this tree with the parity harness:`,
    `  ./oracle/run_parity.sh ${scenario} --candidate ${dir}`,
    `Write to a path of your own instead (the recipe PARITY.md and src/browser/README.md document):`,
    `  POLYWORLD_BROWSER_CANDIDATE_ROOT=<root> npx vitest run src/browser/sim/runTree.${scenario}.test.ts`,
    `  ./oracle/run_parity.sh ${scenario} --candidate <root>/${scenario}`,
    `A pinned root is used verbatim and is yours to keep or remove; a keyed \`pid-*\` directory whose`,
    `process is gone is reaped by the next unpinned run (POLYWORLD_KEEP_BROWSER_CANDIDATES=1 disables it).`,
    ``,
  ].join('\n');
}

/**
 * Name the tree's own root in the tree (t_1ce9957f). Only for the keyed default: a caller-pinned root
 * is written verbatim, with nothing beside its `run/`.
 */
export function writeCandidateProvenance(dir: string, scenario: ScenarioName, root: string): void {
  if (!isKeyedDefaultRoot(root)) return;
  const target = path.join(dir, PROVENANCE_NAME);
  assertNotGoldenWrite(target, `writeCandidateTree(${scenario}) provenance`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, candidateProvenanceText(dir, scenario));
  process.stderr.write(`browser lane candidate tree (${scenario}): ${dir} — per-process key (${PROVENANCE_NAME})\n`);
}

/** The pid a candidate dir name belongs to, or `null` when the name is not one. */
export function ownerPidOf(dirName: string): number | null {
  const match = BROWSER_CANDIDATE_DIR_NAME.exec(dirName);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export interface BrowserCandidateReapReport {
  /** The directories removed. */
  readonly reaped: string[];
  /** Entries left alone, with the reason — a live owner, a foreign name, a refusal. */
  readonly kept: { dir: string; why: string }[];
}

/**
 * Throw unless `dir` may be removed by the sweep: the frozen-golden guard first (so the oracle root,
 * a scenario dir, a golden `run/` tree and anything inside one are refused with the guard's own
 * message), then the shape — a `pid-*` direct child of a directory literally named
 * `polyworld-browser-candidates`.
 */
export function assertReapableBrowserCandidateDir(dir: string, base: string, what: string): string {
  assertUsableStagingRoot(dir, what);
  if (path.basename(resolveExisting(base)) !== BROWSER_CANDIDATE_BASE) {
    throw new Error(
      `${what}: refusing ${dir} — ${base} is not the browser lane's candidate base (\`${BROWSER_CANDIDATE_BASE}\`); ` +
        'only its `pid-*` children are ever removed (src/oracle/guard.ts, src/browser/sim/candidateRoots.ts).',
    );
  }
  const resolvedBase = resolveExisting(base);
  const resolvedDir = resolveExisting(dir);
  const rel = path.relative(resolvedBase, resolvedDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || ownerPidOf(rel) === null) {
    throw new Error(
      `${what}: refusing ${dir} — it is not a \`pid-<pid>[-t<thread>]\` direct child of ${resolvedBase}` +
        `${resolvedDir !== path.resolve(dir) ? ` (it resolves to ${resolvedDir})` : ''}.`,
    );
  }
  return dir;
}

/**
 * Remove the `pid-*` dirs under the browser candidate base whose owning process is gone (t_1ce9957f).
 *
 * The key that isolates concurrent runs leaves one tree behind per process, so this root is given the
 * lifecycle t_2821ab7f gave the logs staging root — with one deliberate difference: this tree is a
 * **candidate a human grades**, not a private build cache, so the sweep never removes a live pid's
 * directory (a concurrent lane's tree must not vanish under it) and never this process's own. The
 * tree therefore survives its writer; the next unpinned run is what collects it. Non-`pid-*` entries
 * (the pre-t_1ce9957f scenario-named dirs of the old shared root, another consumer's staging) are
 * never touched either.
 */
export function reapDeadBrowserCandidateRoots(
  base: string,
  options: { skipPids?: readonly number[] } = {},
): BrowserCandidateReapReport {
  const reaped: string[] = [];
  const kept: { dir: string; why: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return { reaped, kept }; // a missing base is a no-op, not a failure
  }
  const skip = options.skipPids ?? [];

  for (const name of entries.sort()) {
    const dir = path.join(base, name);
    const pid = ownerPidOf(name);
    if (pid === null) {
      kept.push({ dir, why: 'not a pid-* candidate dir' });
      continue;
    }
    if (skip.includes(pid)) {
      kept.push({ dir, why: `pid ${pid} is this process (its tree is in use)` });
      continue;
    }
    if (isProcessAlive(pid)) {
      kept.push({ dir, why: `owner pid ${pid} is alive` });
      continue;
    }
    try {
      assertReapableBrowserCandidateDir(dir, base, 'reapDeadBrowserCandidateRoots');
      rmSync(dir, { recursive: true, force: true });
      reaped.push(dir);
    } catch (error) {
      kept.push({ dir, why: `refused: ${(error as Error).message}` });
    }
  }
  return { reaped, kept };
}

export interface BrowserCandidateSweepReport {
  /** False when the sweep was skipped (a pinned root, a keep override, or a failure). */
  readonly ran: boolean;
  readonly skippedBecause?: string;
  readonly reaped: string[];
  readonly kept: { dir: string; why: string }[];
  readonly errors: string[];
}

/**
 * The sweep, run once per process when this module is imported.
 *
 * A pinned root turns it off entirely: a caller that named its own root owns its namespace, and the
 * run leaves no `pid-*` directory of its own to collect. `POLYWORLD_KEEP_BROWSER_CANDIDATES=1` turns
 * it off for a process that wants the previous runs' trees to still be there (inspecting a red).
 * Nothing here can red a test: an import-time cleanup reports into `errors` instead of throwing, and
 * `rmSync` is `force` on a directory the guard has already accepted.
 */
export function sweepBrowserCandidateRoots(): BrowserCandidateSweepReport {
  const errors: string[] = [];
  try {
    if (process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT !== undefined) {
      return { ran: false, skippedBecause: 'POLYWORLD_BROWSER_CANDIDATE_ROOT pinned the root (the caller manages it)', reaped: [], kept: [], errors };
    }
    if (process.env.POLYWORLD_KEEP_BROWSER_CANDIDATES === '1') {
      return { ran: false, skippedBecause: 'POLYWORLD_KEEP_BROWSER_CANDIDATES=1', reaped: [], kept: [], errors };
    }
    const base = path.join(os.tmpdir(), BROWSER_CANDIDATE_BASE);
    const report = reapDeadBrowserCandidateRoots(base, { skipPids: [process.pid] });
    return { ran: true, reaped: report.reaped, kept: report.kept, errors };
  } catch (error) {
    errors.push((error as Error).message);
    return { ran: false, skippedBecause: 'threw', reaped: [], kept: [], errors };
  }
}

/** The sweep this process ran at import (see {@link sweepBrowserCandidateRoots}). */
export const BROWSER_CANDIDATE_SWEEP: BrowserCandidateSweepReport = sweepBrowserCandidateRoots();
