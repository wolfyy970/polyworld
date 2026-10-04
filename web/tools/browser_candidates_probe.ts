/**
 * Probe for the browser lane's candidate root (task t_1ce9957f) — the evidence this card asks for,
 * re-runnable from the repo root:
 *
 *   npx tsx tools/browser_candidates_probe.ts key                      # the per-process key, the pin, the provenance
 *   npx tsx tools/browser_candidates_probe.ts reap                     # dead reaped, live kept, foreign untouched
 *   npx tsx tools/browser_candidates_probe.ts report                   # the real default base, after a sweep
 *   npx tsx tools/browser_candidates_probe.ts refusals                 # every removal path the guard refuses
 *   POLYWORLD_KEEP_BROWSER_CANDIDATES=1 npx tsx tools/browser_candidates_probe.ts key     # sweep off
 *   POLYWORLD_BROWSER_CANDIDATE_ROOT=<dir> npx tsx tools/browser_candidates_probe.ts key  # pin, verbatim
 *
 * It imports `src/browser/sim/candidateRoots.ts` — the lifecycle module — and not `nodeSources.ts`,
 * which pulls the boot chain and with it a `?raw` asset only vitest can resolve. Everything works in
 * `$TMPDIR` fixtures and, for `report`/`key`, the real default base
 * (`$TMPDIR/polyworld-browser-candidates`). Nothing under `oracle/` is written or removed; the
 * `refusals` mode is what proves the guard's answer for those paths, message by message. That
 * `writeCandidateTree` itself writes the keyed tree's manifest is shown by a real run (see the
 * card's logs: a `runTree.*` test's tree carries `PROVENANCE.txt`, and `run_parity.sh` passes on it).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  BROWSER_CANDIDATE_SWEEP,
  assertReapableBrowserCandidateDir,
  candidateRoot,
  defaultBrowserCandidateRoot,
  isKeyedDefaultRoot,
  ownerPidOf,
  reapDeadBrowserCandidateRoots,
  writeCandidateProvenance,
} from '../src/browser/sim/candidateRoots';
import { isProcessAlive } from '../src/oracle/logsStaging';

const REPO = process.cwd();
const GOLDEN = path.join(REPO, 'oracle', 'microtest_voff', 'run');
const FIXTURE_PARENT = path.join(os.tmpdir(), 't1ce9957f-probe');
const FIXTURE_BASE = path.join(FIXTURE_PARENT, 'polyworld-browser-candidates');
const REAL_BASE = path.join(os.tmpdir(), 'polyworld-browser-candidates');

const mode = process.argv[2] ?? '';

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failures += 1;
  console.log(`[probe] ${ok ? 'ok  ' : 'FAIL'} ${what}`);
}
function seed(dir: string): void {
  mkdirSync(path.join(dir, 'run'), { recursive: true });
  writeFileSync(path.join(dir, 'run', 'marker.txt'), `${path.basename(dir)}\n`);
}
function listing(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).sort();
}

/** A pid that is certainly gone: a synchronously spawned child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (typeof pid !== 'number' || isProcessAlive(pid)) throw new Error('probe: could not obtain a dead pid');
  return pid;
}

/** A pid that is certainly alive: a detached child that outlives this probe (exits after 20 s). */
function livePid(): { pid: number; kill(): void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', detached: true });
  child.unref();
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('probe: could not obtain a live pid');
  return { pid, kill: () => child.kill('SIGKILL') };
}

function key(): void {
  const pinned = process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT;
  const keep = process.env.POLYWORLD_KEEP_BROWSER_CANDIDATES === '1';
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });

  console.log(`[probe] mode=key pid=${process.pid} tmpdir=${os.tmpdir()}`);
  console.log(`[probe] env POLYWORLD_BROWSER_CANDIDATE_ROOT=${pinned ?? '(unset)'} POLYWORLD_KEEP_BROWSER_CANDIDATES=${process.env.POLYWORLD_KEEP_BROWSER_CANDIDATES ?? '(unset)'}`);

  check(defaultBrowserCandidateRoot('/tmp', 123, 0) === '/tmp/polyworld-browser-candidates/pid-123', 'the key is pid-<pid> for a forks worker');
  check(defaultBrowserCandidateRoot('/tmp', 123, 2) === '/tmp/polyworld-browser-candidates/pid-123-t2', 'the key is pid-<pid>-t<thread> for a threads worker');
  check(defaultBrowserCandidateRoot(os.tmpdir(), process.pid, 0) === path.join(REAL_BASE, `pid-${process.pid}`), 'the default base is $TMPDIR/polyworld-browser-candidates');

  console.log(`[probe] import-time sweep ran=${BROWSER_CANDIDATE_SWEEP.ran} skippedBecause=${BROWSER_CANDIDATE_SWEEP.skippedBecause ?? '-'} reaped=${JSON.stringify(BROWSER_CANDIDATE_SWEEP.reaped.map((d) => path.basename(d)))} errors=${JSON.stringify(BROWSER_CANDIDATE_SWEEP.errors)}`);
  check(BROWSER_CANDIDATE_SWEEP.errors.length === 0, 'the import-time sweep reported no errors');
  check(BROWSER_CANDIDATE_SWEEP.ran === !(pinned !== undefined || keep), `the sweep ran exactly when no override is set (pinned=${pinned !== undefined} keep=${keep})`);

  const root = candidateRoot();
  console.log(`[probe] candidateRoot()=${root}`);
  if (pinned === undefined) {
    check(root === defaultBrowserCandidateRoot(os.tmpdir(), process.pid, 0) || /[\\/]pid-\d+(-t\d+)?$/.test(root), 'an unpinned candidateRoot() is keyed by this process');
    check(isKeyedDefaultRoot(root), 'candidateRoot() is recognised as the keyed default');
  } else {
    check(root === pinned, 'a pinned root is returned verbatim (no key is appended)');
    check(!isKeyedDefaultRoot(root), 'a pinned root is not the keyed default');
  }

  // The manifest `writeCandidateTree` writes for a keyed tree, in the shape it writes it.
  const treeDir = path.join(root, 'hello');
  seed(treeDir);
  writeCandidateProvenance(treeDir, 'hello', root);
  const provenance = path.join(treeDir, 'PROVENANCE.txt');
  console.log(`[probe] tree=${treeDir} files=${JSON.stringify(listing(treeDir))}`);
  if (pinned === undefined) {
    check(existsSync(provenance), `the keyed tree names its own root (${provenance})`);
    const text = existsSync(provenance) ? readFileSync(provenance, 'utf8') : '';
    check(text.includes(treeDir) && text.includes('scenario: hello'), 'the manifest names the tree and the scenario');
    check(text.includes(`--candidate ${treeDir}`), 'the manifest carries the runnable harness line');
    check(!existsSync(path.join(treeDir, 'run', 'PROVENANCE.txt')), 'the manifest sits beside run/, never inside it');
  } else {
    check(!existsSync(provenance), 'a pinned root gets no manifest beside run/');
    check(JSON.stringify(listing(treeDir)) === JSON.stringify(['run']), `a pinned tree is exactly <dir>/<scenario>/run/** (got ${JSON.stringify(listing(treeDir))})`);
  }

  // One more shape, independent of the env the process started with: a root passed explicitly.
  const pinDir = path.join(FIXTURE_PARENT, 'pinned');
  mkdirSync(pinDir, { recursive: true });
  const previous = process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT;
  process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT = pinDir;
  try {
    const explicit = path.join(pinDir, 'hello');
    seed(explicit);
    writeCandidateProvenance(explicit, 'hello', pinDir);
    check(!existsSync(path.join(explicit, 'PROVENANCE.txt')), 'an explicitly named root gets no manifest beside run/');
    check(JSON.stringify(listing(explicit)) === JSON.stringify(['run']), 'an explicitly named tree is exactly <dir>/<scenario>/run/**');
    console.log(`[probe] explicit tree: ${explicit} files=${JSON.stringify(listing(explicit))}`);
  } finally {
    if (previous === undefined) delete process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT;
    else process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT = previous;
    rmSync(pinDir, { recursive: true, force: true });
  }
}

function reap(): void {
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const dead = deadPid();
  const live = livePid();
  const deadDir = path.join(FIXTURE_BASE, `pid-${dead}`);
  const liveDir = path.join(FIXTURE_BASE, `pid-${live.pid}-t3`);
  const ownDir = path.join(FIXTURE_BASE, `pid-${process.pid}`);
  const foreign = path.join(FIXTURE_BASE, 'microtest_voff'); // the pre-t_1ce9957f shared-root shape: no pid owns it
  for (const dir of [deadDir, liveDir, ownDir, foreign]) seed(dir);

  console.log(`[probe] mode=reap base=${FIXTURE_BASE}`);
  console.log(`[probe] seeded dead=${path.basename(deadDir)} live=${path.basename(liveDir)} own=${path.basename(ownDir)} foreign=microtest_voff`);
  const report = reapDeadBrowserCandidateRoots(FIXTURE_BASE, { skipPids: [process.pid] });
  console.log(`[probe] reaped=${JSON.stringify(report.reaped.map((d) => path.basename(d)))}`);
  console.log(`[probe] kept=${JSON.stringify(report.kept.map((k) => `${path.basename(k.dir)} (${k.why})`))}`);
  check(!existsSync(deadDir), `the dead pid's dir is gone (${path.basename(deadDir)})`);
  check(existsSync(liveDir) && existsSync(path.join(liveDir, 'run', 'marker.txt')), "the live pid's dir survives untouched");
  check(existsSync(ownDir), "this process's own dir is skipped (its tree is in use)");
  check(existsSync(foreign) && existsSync(path.join(foreign, 'run', 'marker.txt')), 'the non-pid entry is left alone');
  check(report.reaped.length === 1 && report.kept.length === 3, 'exactly one dir reaped, three kept');
  const second = reapDeadBrowserCandidateRoots(FIXTURE_BASE, { skipPids: [process.pid] });
  check(second.reaped.length === 0, 'a second reap reaps nothing (nothing left to reap)');
  live.kill();
}

function refusals(): void {
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  mkdirSync(FIXTURE_BASE, { recursive: true });
  // A link that resolves into a golden: the shape the guard is symlink-aware for.
  const link = path.join(FIXTURE_BASE, `pid-${deadPid()}`);
  symlinkSync(GOLDEN, link, 'dir');

  const targets: { dir: string; base: string; what: string; keep: string }[] = [
    { dir: REAL_BASE, base: REAL_BASE, what: 'the candidate base itself', keep: 'the base is not a pid-* child' },
    { dir: path.join(REPO, 'oracle'), base: path.join(REPO, 'oracle'), what: 'the oracle root', keep: "the guard's namespace refusal" },
    { dir: path.join(REPO, 'oracle', 'microtest_voff'), base: REAL_BASE, what: 'a scenario dir', keep: 'a golden scenario is not a staging path' },
    { dir: GOLDEN, base: REAL_BASE, what: 'a golden run/ tree', keep: 'the frozen golden' },
    { dir: path.join(REAL_BASE, 'microtest_voff'), base: REAL_BASE, what: 'a non-pid entry under the base', keep: 'nothing owns it' },
    { dir: link, base: FIXTURE_BASE, what: 'a pid-* symlink into a golden', keep: 'it resolves into the golden' },
    { dir: path.join(FIXTURE_PARENT, 'other', 'pid-1'), base: FIXTURE_BASE, what: 'a pid-* dir outside the base', keep: 'it is not a child of the base' },
    { dir: path.join(FIXTURE_BASE, 'pid-1'), base: FIXTURE_PARENT, what: 'a base that is not named polyworld-browser-candidates', keep: 'that base is not the browser candidate base' },
  ];

  console.log(`[probe] mode=refusals realBase=${REAL_BASE}`);
  for (const target of targets) {
    let message: string;
    try {
      assertReapableBrowserCandidateDir(target.dir, target.base, `probe (${target.what})`);
      message = '!!! NO REFUSAL — the removal path was reached';
    } catch (error) {
      message = (error as Error).message;
    }
    const refused = !message.startsWith('!!!');
    check(refused, `${target.what} refused (${target.keep})`);
    console.log(`[probe] REFUSED ${target.dir}\n[probe]   ${message}`);
  }
  check(existsSync(GOLDEN), 'the golden run dir is still there');
  check(existsSync(path.join(GOLDEN, 'manifest.sha256')), 'the golden manifest is still there');
  check(existsSync(link), 'the refused symlink was not even unlinked');
}

function report(): void {
  console.log(`[probe] mode=report base=${REAL_BASE}`);
  console.log(`[probe] import-time sweep ran=${BROWSER_CANDIDATE_SWEEP.ran} skippedBecause=${BROWSER_CANDIDATE_SWEEP.skippedBecause ?? '-'} reaped=${JSON.stringify(BROWSER_CANDIDATE_SWEEP.reaped.map((d) => path.basename(d)))} errors=${JSON.stringify(BROWSER_CANDIDATE_SWEEP.errors)}`);
  const pidDirs = (): string[] => listing(REAL_BASE).filter((n) => /^pid-\d+(-t\d+)?$/.test(n));
  const before = pidDirs();
  const foreignBefore = listing(REAL_BASE).filter((n) => !/^pid-/.test(n));
  const sweep = reapDeadBrowserCandidateRoots(REAL_BASE, { skipPids: [process.pid] });
  console.log(`[probe] pid dirs before=${JSON.stringify(before)}`);
  console.log(`[probe] non-pid entries before=${JSON.stringify(foreignBefore)}`);
  console.log(`[probe] reaped=${JSON.stringify(sweep.reaped.map((d) => path.basename(d)))}`);
  console.log(`[probe] kept=${JSON.stringify(sweep.kept.map((k) => `${path.basename(k.dir)} (${k.why})`))}`);
  const after = pidDirs();
  console.log(`[probe] pid dirs after=${JSON.stringify(after)}`);
  check(
    after.every((name) => {
      const pid = ownerPidOf(name);
      return pid !== null && (pid === process.pid || isProcessAlive(pid));
    }),
    'every remaining pid dir belongs to a live process (or this probe)',
  );
  check(
    JSON.stringify(listing(REAL_BASE).filter((n) => !/^pid-/.test(n))) === JSON.stringify(foreignBefore),
    `no non-pid entry was touched (${JSON.stringify(foreignBefore)})`,
  );
}

function main(): void {
  switch (mode) {
    case 'key':
      key();
      break;
    case 'reap':
      reap();
      break;
    case 'refusals':
      refusals();
      break;
    case 'report':
      report();
      break;
    default:
      console.log('usage: npx tsx tools/browser_candidates_probe.ts key | reap | report | refusals');
      process.exitCode = 2;
      return;
  }
  console.log(`[probe] RESULT ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  if (failures !== 0) process.exitCode = 1;
}

main();
