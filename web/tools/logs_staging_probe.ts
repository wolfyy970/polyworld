/**
 * Probe for the logs staging root's lifecycle (task t_2821ab7f) — the evidence the card asks for,
 * re-runnable from the repo root:
 *
 *   npx tsx tools/logs_staging_probe.ts exit-hook            # the exit hook, seen from outside
 *   npx tsx tools/logs_staging_probe.ts exit-hook --no-hook  # the control: no hook in the process
 *   POLYWORLD_KEEP_LOGS_CANDIDATES=1 npx tsx tools/logs_staging_probe.ts exit-hook   # keep = no sweep
 *   npx tsx tools/logs_staging_probe.ts reap                 # dead reaped, live kept, foreign untouched
 *   npx tsx tools/logs_staging_probe.ts refusals             # every removal path the guard refuses
 *
 * `exit-hook` seeds three dirs in the *real* default root — `pid-<a dead child>`, `pid-<a live
 * child>`, `pid-<this process>` — prints the listing, and exits. With the hook installed (it is
 * installed by importing `tests/logsCorpus.ts`, i.e. the exact wiring the suite uses) only the live
 * child's dir survives; with `--no-hook` (or `KEEP_LOGS_CANDIDATES=1`) all three do. The caller
 * prints the listing after the process is gone — the observation has to come from another process,
 * because the exit handler is the last thing that runs.
 *
 * `reap` and `refusals` work in a `$TMPDIR` fixture whose root carries the real
 * `_t_logs_candidates` name, so they never touch a lane's tree.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { LOGS_CANDIDATE_ROOT_BASENAME, isProcessAlive, ownerPidOf, removeCandidateDir, reapDeadCandidateDirs } from '../src/oracle/logsStaging';

const REPO = process.cwd();
const DEFAULT_ROOT = path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME);
const FIXTURE_PARENT = path.join(os.tmpdir(), 't2821ab7f-probe');
const FIXTURE_ROOT = path.join(FIXTURE_PARENT, LOGS_CANDIDATE_ROOT_BASENAME);

const mode = process.argv[2] ?? '';
const flags = new Set(process.argv.slice(3));

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

/**
 * A pid that is certainly alive: a child in its own process group that keeps running past this
 * probe's life (its dir must survive the sweep; it exits on its own after 20 s). Detached and
 * unref'd, so it neither holds this process's event loop open nor blocks the caller's wait.
 */
function livePid(): { pid: number; kill(): void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', detached: true });
  child.unref();
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('probe: could not obtain a live pid');
  return { pid, kill: () => child.kill('SIGKILL') };
}

async function exitHook(): Promise<void> {
  const noHook = flags.has('--no-hook');
  const root = DEFAULT_ROOT;
  const own = path.join(root, `pid-${process.pid}`);
  const dead = deadPid();
  const live = livePid();
  const deadDir = path.join(root, `pid-${dead}`);
  const liveDir = path.join(root, `pid-${live.pid}`);

  mkdirSync(root, { recursive: true });
  seed(own);
  seed(deadDir);
  seed(liveDir);
  console.log(`[probe] mode=exit-hook pid=${process.pid} root=${root}`);
  console.log(`[probe] live child pid=${live.pid} (the caller must kill it; its dir must survive)`);
  console.log(`[probe] seeded dead=${deadDir} own=${own} live=${liveDir}`);

  if (!noHook) {
    // The suite's own wiring: importing the corpus installs the exit cleanup at module scope.
    const corpus = (await import('../tests/logsCorpus')) as {
      CANDIDATE_ROOT: string;
      LOGS_CANDIDATE_ROOT_BASE: string;
      LOGS_STAGING_CLEANUP: { dir: string; root: string; pinned: boolean; keep: boolean };
    };
    const cleanup = corpus.LOGS_STAGING_CLEANUP;
    console.log(
      `[probe] hook installed by tests/logsCorpus: dir=${cleanup.dir} root=${cleanup.root} ` +
        `pinned=${cleanup.pinned} keep=${cleanup.keep}`,
    );
    check(cleanup.dir === own, `the corpus stages into this process's own dir (${own})`);
    check(corpus.LOGS_CANDIDATE_ROOT_BASE === root, `the corpus sweeps the default root (${root})`);
    check(cleanup.keep === (process.env.POLYWORLD_KEEP_LOGS_CANDIDATES === '1'), 'keep mirrors POLYWORLD_KEEP_LOGS_CANDIDATES');
    console.log(`[probe] env POLYWORLD_KEEP_LOGS_CANDIDATES=${process.env.POLYWORLD_KEEP_LOGS_CANDIDATES ?? '(unset)'}`);
  } else {
    console.log('[probe] hook NOT installed (--no-hook): the process exits with no cleanup at all');
  }
  console.log(`[probe] before exit: ${listing(root).join(' ')}`);
  console.log('[probe] exiting; the caller lists the root now and only then kills the live child');
}

function reap(): void {
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const dead = deadPid();
  const live = livePid();
  const deadDir = path.join(FIXTURE_ROOT, `pid-${dead}`);
  const liveDir = path.join(FIXTURE_ROOT, `pid-${live.pid}`);
  const ownDir = path.join(FIXTURE_ROOT, `pid-${process.pid}`);
  const foreign = path.join(FIXTURE_ROOT, 'microtest_voff'); // a pre-t_37bf7212 leftover shape: no pid owns it
  for (const dir of [deadDir, liveDir, ownDir, foreign]) seed(dir);

  console.log(`[probe] mode=reap root=${FIXTURE_ROOT}`);
  console.log(`[probe] seeded dead=${path.basename(deadDir)} live=${path.basename(liveDir)} own=${path.basename(ownDir)} foreign=microtest_voff`);
  const report = reapDeadCandidateDirs(FIXTURE_ROOT, { skipPids: [process.pid] });
  console.log(`[probe] reaped=${JSON.stringify(report.reaped.map((d) => path.basename(d)))}`);
  console.log(`[probe] kept=${JSON.stringify(report.kept.map((k) => `${path.basename(k.dir)} (${k.why})`))}`);
  check(!existsSync(deadDir), `the dead pid's dir is gone (${path.basename(deadDir)})`);
  check(existsSync(liveDir) && existsSync(path.join(liveDir, 'run', 'marker.txt')), 'the live pid\'s dir survives untouched');
  check(existsSync(ownDir), 'this process\'s own dir is skipped by the reap (the owner path removes it)');
  check(existsSync(foreign) && existsSync(path.join(foreign, 'run', 'marker.txt')), 'the non-pid entry is left alone');
  check(report.reaped.length === 1 && report.kept.length === 3, 'exactly one dir reaped, three kept');
  const second = reapDeadCandidateDirs(FIXTURE_ROOT, { skipPids: [process.pid] });
  check(second.reaped.length === 0, 'a second reap reaps nothing (nothing left to reap)');
  live.kill();
}

function refusals(): void {
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const golden = path.join(REPO, 'oracle', 'microtest_voff', 'run');
  // A link that resolves into a golden: the shape the guard is symlink-aware for.
  const link = path.join(FIXTURE_ROOT, `pid-${deadPid()}`);
  symlinkSync(golden, link, 'dir');

  const targets: { dir: string; root: string; what: string; keep: string }[] = [
    { dir: path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME), root: path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME), what: 'the logs staging root itself', keep: 'the root is not a pid-* child' },
    { dir: path.join(REPO, 'oracle'), root: path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME), what: 'the oracle root', keep: "the guard's namespace refusal" },
    { dir: path.join(REPO, 'oracle', 'microtest_voff'), root: path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME), what: 'a scenario dir', keep: 'a golden scenario is not a staging path' },
    { dir: golden, root: path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME), what: 'a golden run/ tree', keep: 'the frozen golden' },
    { dir: path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME, 'minitest_voff-brain'), root: path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME), what: 'a non-pid entry under the root', keep: 'nothing owns it' },
    { dir: link, root: FIXTURE_ROOT, what: 'a pid-* symlink into a golden', keep: 'it resolves into the golden' },
    { dir: path.join(FIXTURE_PARENT, 'other', 'pid-1'), root: FIXTURE_ROOT, what: 'a pid-* dir outside the root', keep: 'it is not a child of the root' },
    { dir: path.join(FIXTURE_ROOT, 'pid-1'), root: FIXTURE_PARENT, what: 'a root that is not named _t_logs_candidates', keep: 'that root is not the logs staging root' },
  ];

  console.log(`[probe] mode=refusals root=${path.join(REPO, 'oracle', LOGS_CANDIDATE_ROOT_BASENAME)}`);
  for (const target of targets) {
    let message: string;
    try {
      removeCandidateDir(target.dir, target.root, `probe (${target.what})`);
      message = '!!! NO REFUSAL — the removal path was reached';
    } catch (error) {
      message = (error as Error).message;
    }
    const refused = !message.startsWith('!!!');
    check(refused, `${target.what} refused (${target.keep})`);
    console.log(`[probe] REFUSED ${target.dir}\n[probe]   ${message}`);
  }
  check(existsSync(golden), 'the golden run dir is still there');
  check(existsSync(path.join(golden, 'manifest.sha256')), 'the golden manifest is still there');
  check(existsSync(link), 'the refused symlink was not even unlinked');
}

function report(): void {
  console.log(`[probe] mode=report root=${DEFAULT_ROOT}`);
  const before = listing(DEFAULT_ROOT).filter((n) => /^pid-\d+(-t\d+)?$/.test(n));
  const sweep = reapDeadCandidateDirs(DEFAULT_ROOT, { skipPids: [process.pid] });
  console.log(`[probe] pid dirs before=${before.length}`);
  console.log(`[probe] reaped=${JSON.stringify(sweep.reaped.map((d) => path.basename(d)))}`);
  console.log(
    `[probe] kept=${JSON.stringify(sweep.kept.filter((k) => k.why !== 'not a pid-* candidate dir').map((k) => `${path.basename(k.dir)} (${k.why})`))}`,
  );
  console.log(
    `[probe] never touched (no owner, not \`pid-*\`)${JSON.stringify(
      sweep.kept.filter((k) => k.why === 'not a pid-* candidate dir').map((k) => path.basename(k.dir)),
    )}`,
  );
  const after = listing(DEFAULT_ROOT).filter((n) => /^pid-\d+(-t\d+)?$/.test(n));
  console.log(`[probe] pid dirs after=${after.length}`);
  check(
    after.every((name) => {
      const pid = ownerPidOf(name);
      return pid !== null && (pid === process.pid || isProcessAlive(pid));
    }),
    'every remaining pid dir belongs to a live process (or this probe)',
  );
}

/**
 * `sigterm` — the shape vitest's fork pool ends a worker with. The hook must have cleaned up before
 * the process dies *by the signal* (no `exit` event is delivered to a signal-terminated process,
 * which is why the probe exists at all).
 */
async function sigterm(): Promise<void> {
  const root = DEFAULT_ROOT;
  const own = path.join(root, `pid-${process.pid}`);
  mkdirSync(root, { recursive: true });
  seed(own);
  const corpus = (await import('../tests/logsCorpus')) as { CANDIDATE_ROOT: string };
  console.log(`[probe] mode=sigterm pid=${process.pid} installed-dir=${corpus.CANDIDATE_ROOT}`);
  check(corpus.CANDIDATE_ROOT === own, 'the corpus stages into this process\'s own dir');
  check(existsSync(own), 'the own dir is on disk before the signal');
  console.log(`[probe] sending SIGTERM to ${process.pid}; the caller checks the root and the exit status`);
  process.kill(process.pid, 'SIGTERM');
  // The signal is delivered on a later event-loop turn (Node signal handling is asynchronous), so
  // this function does not return: the handler sweeps, re-raises and the process dies by SIGTERM.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log('[probe] !!! still alive 5 s after SIGTERM: the hook did not re-raise the signal');
}

async function main(): Promise<void> {
  switch (mode) {
    case 'exit-hook':
      await exitHook();
      break;
    case 'sigterm':
      await sigterm();
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
      console.log('usage: npx tsx tools/logs_staging_probe.ts exit-hook [--no-hook] | sigterm | reap | refusals | report');
      process.exitCode = 2;
      return;
  }
  console.log(`[probe] RESULT ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  if (failures !== 0) process.exitCode = 1;
}

void main();
