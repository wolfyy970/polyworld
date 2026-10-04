/**
 * Lane L16/L11 — the gate `t_83dc2e2c` proved was missing: **a vision-on run must feed the
 * retina**.
 *
 * The defect this pins: the sim bound a do-nothing `AgentPovRenderer`, so `agent::UpdateVision`'s
 * render/readback never happened, the retina's buffer kept its prebirth noise for the whole run,
 * and a vision-on run came out **byte-identical to the vision-off run of the same world** — the
 * whole `*_von` surface diverged from its golden in silence. Nothing in the suite noticed, because
 * every artifact a vision-off run writes is exactly what a silently-vision-off run writes.
 *
 * The assertion is deliberately the *cheapest* thing that cannot hold unless pixels reach the
 * nerves: the vision input group (neurons 2-29) of a vision-on run must differ from the
 * vision-off run's on the same worldfile, for at least one agent. It is not a parity check —
 * `./oracle/run_parity.sh microtest_von` is that, and it needs the golden; this test only needs
 * the two worlds to disagree where vision enters.
 *
 * PORT-NOTE(L16/vision-gate-is-its-own-process): the model's tables are process-global statics
 * (`agentConfig`, the environment's `rand`/`drand48` streams, the barrier list), so one process
 * can run **one** scenario. The vision-on side therefore runs the real runner in a child process
 * (`npx tsx src/model/sim/runner.ts microtest_von <dir>`) and the vision-off side is read from the
 * recorded golden, which is the same worldfile with `--Vision False`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const vonGolden = join(repoRoot, 'oracle', 'microtest_von');
const voffGolden = join(repoRoot, 'oracle', 'microtest_voff');
const scenario = 'microtest_von';

/**
 * The tree the vision-on side runs into, keyed per worker process (`pid-<pid>[-t<thread>]`, the
 * shape t_37bf7212/t_1ce9957f gave the other lane candidate roots).
 *
 * t_84885d07: this used to be ONE directory (`.candidate/vision-gate-von`) shared by every
 * concurrent `npx vitest run` on the checkout. The runner writes `<dir>/run/**` file by file and
 * this test reads each agent's `incomplete_brainFunction_*.txt.gz` straight back, so two processes
 * had one gunzipping a container the other had just truncated — `Error: unexpected end of file`
 * (`Z_BUF_ERROR`), 1 red round in 4 at four-way concurrency (measured 2026-09-29; zero in 12
 * rounds with the key). Nothing outside this test reads the path, so keying the default is
 * invisible to callers; the directory stays under `.candidate/`, which `.gitignore` reserves.
 */
const outDir = join(
  repoRoot,
  '.candidate',
  'vision-gate-von',
  threadId === 0 ? `pid-${process.pid}` : `pid-${process.pid}-t${threadId}`,
);

/**
 * The vision input group, from the functional log's own header — `brainFunction 1 37 29 8 74 0
 * 2-10 11-19 20-28` is `Retina::Channel::start_functional`'s output (`redinput`/`greeninput`/
 * `blueinput`), i.e. neurons 2..28. Each agent's per-channel neuron count is its own (1..16, §7.2
 * of `docs/specs/vision-spec.md`); these are the bounds the group lives in, and the comparison
 * below only runs on agents that carry the same set on both sides.
 */
const VISION_FIRST_NEURON = 2;
const VISION_LAST_NEURON = 28;

/**
 * Vitest's default is 5 s, which this test cannot honour: its vision-on side pays `npx tsx`
 * startup + one world boot in a child process, so its wall time is dominated by process launch
 * and stretches under lane load (isolated here it is ~1.2 s; with three lanes live the same call
 * has been measured past the 5 s default and reported as `Test timed out in 5000ms`). The
 * explicit budget keeps a *real* regression from hiding inside "the usual flake" — it must be
 * generous enough that only a genuine break of the gate turns this red.
 */
const TEST_TIMEOUT_MS = 60_000;

/** Read `<i> <value>` neuron rows out of a `run/brain/function/incomplete_brainFunction_*.txt.gz`. */
function visionNeurons(tree: string, agent: number): Map<number, string> {
  const path = join(tree, 'run', 'brain', 'function', `incomplete_brainFunction_${agent}.txt.gz`);
  if (!existsSync(path)) return new Map();
  const text = gunzipSync(readFileSync(path)).toString('utf8');
  const values = new Map<number, string>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const index = Number(parts[0]);
    if (!Number.isInteger(index) || index < VISION_FIRST_NEURON || index > VISION_LAST_NEURON) continue;
    values.set(index, parts[1]!);
  }
  return values;
}

/** The agents a tree has a functional log for. */
function agentNumbers(tree: string): number[] {
  const dir = join(tree, 'run', 'brain', 'function');
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^incomplete_brainFunction_(\d+)\.txt\.gz$/.exec(name);
    if (match) out.push(Number(match[1]));
  }
  return out.sort((a, b) => a - b);
}

describe('vision-on is not a no-op', () => {
  const ready = existsSync(join(vonGolden, 'run', 'original.wf')) &&
    existsSync(join(voffGolden, 'run', 'original.wf'));

  it.skipIf(!ready)('a vision-on run feeds the retina: its vision neurons differ from vision-off', () => {
    mkdirSync(outDir, { recursive: true });

    // One `runScenario` per process (see PORT-NOTE above): the vision-on tree is written by the
    // runner as a child process, exactly the way the parity harness produces a candidate.
    execFileSync('npx', ['tsx', 'src/model/sim/runner.ts', scenario, outDir], {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 300_000,
    });

    const vonAgents = agentNumbers(outDir);
    const voffAgents = agentNumbers(voffGolden);
    expect(vonAgents.length).toBeGreaterThan(0);
    expect(voffAgents.length).toBe(vonAgents.length);

    let agentsThatDiffer = 0;
    const compared: string[] = [];
    for (const agent of vonAgents) {
      const on = visionNeurons(outDir, agent);
      const off = visionNeurons(voffGolden, agent);
      // Only agents both runs logged, and only when both sides carry the full vision group.
      if (on.size === 0 || off.size !== on.size) continue;
      compared.push(`${agent}:${on.size}`);
      const same = [...on.entries()].every(([index, value]) => off.get(index) === value);
      if (!same) agentsThatDiffer++;
    }

    process.stdout.write(
      `\n[vision-gate] agents compared ${compared.length} (${compared.slice(0, 6).join(' ')}…), ` +
        `${agentsThatDiffer} whose vision neurons differ from the vision-off run\n`,
    );

    expect(compared.length).toBeGreaterThan(0);
    // The whole point: a silently-vision-off run would make this zero.
    expect(agentsThatDiffer).toBeGreaterThan(0);
    // And it is not one unlucky agent: on `microtest` every agent's retina is fed.
    expect(agentsThatDiffer).toBe(compared.length);
  }, TEST_TIMEOUT_MS);
});
