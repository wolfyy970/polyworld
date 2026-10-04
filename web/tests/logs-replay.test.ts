/**
 * Lane L12 (logs) — the byte-exact golden replay.
 *
 * `microtest_voff` (1 step, 225 artifacts) and `minitest_voff` (301 steps, 1,370 artifacts) are
 * replayed through the ported recorders with every value taken from the goldens, and every
 * artifact whose *content* this lane decides is compared byte-for-byte.
 *
 * The candidate tree is left on disk at `<CANDIDATE_ROOT>/<scenario>/run`, which is what
 * `./oracle/run_parity.sh <scenario> --candidate <CANDIDATE_ROOT>/<scenario>` reads.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DeathReason } from '../src/model/types';
import {
  CANDIDATE_ROOT,
  candidateBytes,
  firstDifference,
  goldenRunRoot,
  l12Artifacts,
  replayCorpus,
} from './logsCorpus';
import { agentEnergyRows, agentPositionRows, deriveFlags, readLifespans } from './logsReplay';

const SCENARIOS = ['microtest_voff', 'minitest_voff'] as const;

describe.each(SCENARIOS)('L12 golden replay — %s', (scenario) => {
  const result = replayCorpus(scenario);
  const golden = result.golden;
  const expected = l12Artifacts(golden);

  it('reconstructs the recorded per-agent row ranges', () => {
    // The reconstruction rules in tests/logsReplay.ts are only sound if the goldens satisfy
    // them: every agent's energy rows are the contiguous steps from its birth step to its
    // death step, and its position rows the contiguous steps from birth+1 to death.
    const agents = readLifespans(golden);
    const energy = agentEnergyRows(golden);
    const positions = agentPositionRows(golden);

    const problems: string[] = [];
    for (const [number, life] of agents) {
      // Energy rows: one `StepEnd` row per step the agent is alive for, plus its death row
      // (which a `SIMEND` death does not write). Position rows: one per body update, from the
      // step *after* birth (a newborn is created after that step's body update) through the
      // death step (the body update happens before the death).
      const rows = energy.get(number) ?? [];
      const steps = rows.map((row) => row.step);
      const firstAlive = Math.max(life.birthStep, 1);
      const wanted = range(firstAlive, life.deathStep);
      if (steps.join(',') !== wanted.join(',')) {
        problems.push(`agent ${number}: energy steps ${steps.join(',')} != ${wanted.join(',')}`);
      }

      const positionSteps = (positions.get(number) ?? []).map((row) => row.step);
      const wantedPositions = range(life.birthStep + 1, life.deathStep);
      if (positionSteps.join(',') !== wantedPositions.join(',')) {
        problems.push(`agent ${number}: position steps ${positionSteps.join(',')} != ${wantedPositions.join(',')}`);
      }

      // A `SIMEND` death leaves the last step-end row in place and writes no death row.
      if (life.deathReason === DeathReason.SIMEND && steps.length !== wanted.length) {
        problems.push(`agent ${number}: SIMEND death should not add a row`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('writes every artifact this lane owns, byte-for-byte', () => {
    const missing: string[] = [];
    const differing: string[] = [];

    for (const rel of expected) {
      const candidate = candidateBytes(result.runDir, rel);
      if (!candidate) {
        missing.push(rel);
        continue;
      }
      const goldenBytes = golden.bytes(rel)!;
      const difference = firstDifference(goldenBytes, candidate);
      if (difference) differing.push(`${rel}: ${difference}`);
    }

    expect({ missing, differing }).toEqual({ missing: [], differing: [] });
  });

  it('writes no artifact the golden does not have', () => {
    const extra = result.produced.filter((rel) => !golden.exists(rel) && !golden.exists(rel.replace(/\.gz$/, '')));
    expect(extra).toEqual([]);
  });

  it('produces the recorded artifact count', () => {
    expect(result.produced.length).toBe(expected.length);
  });

  it('derived its worldfile flags from artifacts the golden actually has', () => {
    const wf = golden.text('normalized.wf');
    // The flags are read off the artifacts; these lines prove the reading matches the
    // recorded worldfile (the expression-valued keys are asserted as *text*, because
    // evaluating them is lane L4's job).
    expect(wf).toContain('RecordAll True');
    expect(wf).toContain('RecordPosition Approximate if RecordAll else False');
    expect(wf).toContain('RecordSeparations All if RecordAll else False');
    expect(wf).toContain('RecordGitRevision False');
    expect(wf).toContain('RecordComplexity False');
    expect(wf).toContain('RecordAdamiComplexity False');
    expect(wf).toContain('CompressFiles True');
    expect(wf).toContain('NumEnergyTypes 1');

    const flags = deriveFlags(golden);
    expect(flags.RecordPosition).toBe('Approximate');
    expect(flags.RecordSeparations).toBe('All');
    expect(flags.RecordAdamiComplexity).toBe(false);
    expect(flags.RecordGitRevision).toBe(false);
    expect(flags.RecordComplexity).toBe(false);
    expect(flags.InitAgents).toBeGreaterThan(0);
  });

  it('leaves the candidate tree where the parity harness reads it', () => {
    expect(result.runDir).toBe(path.join(CANDIDATE_ROOT, scenario, 'run'));
    expect(candidateBytes(result.runDir, 'population.txt')).toBeDefined();
  });
});

/** `[from, to]` inclusive. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

describe('golden tree', () => {
  it('is the repo’s recorded scenario', () => {
    expect(goldenRunRoot('microtest_voff').endsWith(path.join('oracle', 'microtest_voff', 'run'))).toBe(true);
  });
});
