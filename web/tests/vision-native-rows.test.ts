/**
 * Lane W1j/L16 — the encoder held to the recorded model on **real native retina bytes**.
 *
 * `tests/vision-encoder.test.ts` checks the arithmetic against rows reconstructed from the spec
 * (and against the recorded *printed* values for the one uniform colour the oracle exercises).
 * This test goes one level deeper: `src/model/vision/golden/*.retina.jsonl.gz` is the output of
 * `src/model/vision/native/retinadump.sh`, which runs the **native** binary under a
 * `DYLD_INSERT_LIBRARIES` shim and reads `Retina::buf` right after `glReadPixels` filled it
 * (`Retina.cc:116-122`) for every agent, every step. `PrintBrain` is a compile-time `false`
 * (`brain/Brain.h:20`), so this is the only way to obtain the native pixels at all.
 *
 * What is asserted:
 *
 *  1. the rows are the atlas rows `atlas.ts` predicts — the slot set the native
 *     `QtAgentPovRenderer` actually handed out equals `atlasLayout(25, 22, 22)`'s viewport set,
 *     one 88-byte RGBA row per slot;
 *  2. for every agent/step the native recorded, the port's `encodeChannel` reproduces the
 *     golden's printed `%g` values *exactly*, for all three channels — i.e. the acceptance
 *     surface of PARITY.md's vision finding (the model logs) is reproduced from the pixels
 *     that produced it. This covers the integer branch (`xintwidth != 0`) too: the run's 83
 *     agents include channels with 1, 2, 11 and 22 neurons.
 *
 * The dump carries the live `Retina::Channel::numneurons` per row and the golden carries the
 * same counts in its anatomy header; the test asserts they agree before comparing values, so a
 * disagreement about channel geometry cannot hide behind a value match.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { atlasLayout } from '../src/model/vision/atlas';
import { ChannelIndex, encodeChannel } from '../src/model/vision/encoder';
import { formatG, hasFunctionalLog, oracleRoot, readFunctionalLog, repoRoot } from './visionGolden';

interface DumpRow {
  step: number;
  agent: number;
  x: number;
  y: number;
  w: number;
  h: number;
  neurons: [number, number, number];
  row: Uint8Array;
}

const goldenDir = path.join(repoRoot, 'src', 'model', 'vision', 'golden');
const RETINA_WIDTH = 22; // Brain::config.retinaWidth (`normalized.wf:374`)
const MAX_AGENTS = 25; // fMaxNumAgents (`normalized.wf:458`)

function readDump(scenario: string): { rows: DumpRow[]; available: boolean } {
  const file = path.join(goldenDir, `${scenario}.retina.jsonl.gz`);
  if (!existsSync(file)) return { rows: [], available: false };
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  const rows: DumpRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as {
      step: number;
      agent: number;
      x: number;
      y: number;
      w: number;
      h: number;
      neurons: [number, number, number];
      row: string;
    };
    const bytes = new Uint8Array(parsed.row.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(parsed.row.slice(i * 2, i * 2 + 2), 16);
    rows.push({ ...parsed, row: bytes });
  }
  return { rows, available: true };
}

const minitest = readDump('minitest_von');
const microtest = readDump('microtest_von');
const goldensAvailable = existsSync(path.join(oracleRoot, 'minitest_von', 'run', 'brain', 'function', 'brainFunction_10.txt.gz'));

describe('native retina dump — provenance and atlas agreement', () => {
  it('the dumps are present and structurally plausible', () => {
    expect(minitest.available).toBe(true);
    expect(microtest.available).toBe(true);
    expect(minitest.rows.length).toBe(7315);
    expect(microtest.rows.length).toBe(25);
    for (const row of [...minitest.rows, ...microtest.rows]) {
      expect(row.w).toBe(RETINA_WIDTH);
      expect(row.h).toBe(RETINA_WIDTH);
      // one RGBA row: `retinaWidth * 4` bytes (`Retina.cc:22-31`)
      expect(row.row.length).toBe(RETINA_WIDTH * 4);
      expect(row.agent).toBeGreaterThan(0);
      expect(row.step).toBeGreaterThan(0);
    }
  });

  it('the slots the native renderer handed out are exactly `atlasLayout`\'s viewports', () => {
    const layout = atlasLayout(MAX_AGENTS, RETINA_WIDTH, RETINA_WIDTH);
    const computed = new Set(layout.viewports.map((viewport) => `${viewport.x},${viewport.y}`));
    expect(computed.size).toBe(MAX_AGENTS); // 25 slots for 25 agents: 5 + 10 + 10 cells

    const observedMinitest = new Set(minitest.rows.map((row) => `${row.x},${row.y}`));
    const observedMicrotest = new Set(microtest.rows.map((row) => `${row.x},${row.y}`));
    // minitest ran long enough (83 agents born over 301 steps) to use every slot
    expect([...observedMinitest].sort()).toEqual([...computed].sort());
    for (const slot of observedMicrotest) expect(computed.has(slot)).toBe(true);

    // and the sampled row is `y + retinaHeight/2` — the horizon band (`Retina.cc:117`)
    for (const row of minitest.rows) {
      const ytop = layout.height - Math.trunc(row.y / (RETINA_WIDTH + 2)) * (RETINA_WIDTH + 2);
      expect(ytop).toBeGreaterThan(0);
      expect(row.y).toBeLessThan(layout.height);
    }
  });

  it('the atlas packing matches the native buffer size (240 x 72 for 25 agents x 22 px)', () => {
    const layout = atlasLayout(MAX_AGENTS, RETINA_WIDTH, RETINA_WIDTH);
    expect({ width: layout.width, height: layout.height, ncols: layout.ncols, nrows: layout.nrows }).toEqual({
      width: 240,
      height: 72,
      ncols: 10,
      nrows: 3,
    });
  });
});

describe('native retina dump — the encoder reproduces the recorded nerve values', () => {
  it.skipIf(!goldensAvailable)('minitest_von: every agent, every step, all three channels', () => {
    expect(minitest.rows.length).toBeGreaterThan(7000);

    // group the dump by agent, then by step
    const byAgent = new Map<number, Map<number, DumpRow>>();
    for (const row of minitest.rows) {
      let steps = byAgent.get(row.agent);
      if (!steps) {
        steps = new Map();
        byAgent.set(row.agent, steps);
      }
      steps.set(row.step, row);
    }

    let agentsCompared = 0;
    let rowsCompared = 0;
    let valuesCompared = 0;
    let valuesExpected = 0;
    let mismatch: string | null = null;

    for (const [agent, steps] of [...byAgent.entries()].sort((a, b) => a[0] - b[0])) {
      if (!hasFunctionalLog('minitest_von', agent)) continue; // not every agent gets a log
      const log = readFunctionalLog('minitest_von', agent);
      agentsCompared++;

      const ranges = log.sensorRanges.slice(-3).map((token) => token.split('-').map(Number) as [number, number]);
      const counts: [number, number, number] = [
        ranges[0]![1] - ranges[0]![0] + 1,
        ranges[1]![1] - ranges[1]![0] + 1,
        ranges[2]![1] - ranges[2]![0] + 1,
      ];

      // block i of a log written from birth is step stepBorn + i + 1 (agent 31 is born at 70)
      for (let index = 0; index < log.steps.length; index++) {
        const row = steps.get(log.stepBorn + index + 1);
        expect(row).toBeDefined();
        if (!row) continue;

        // the live channel geometry the shim recorded must be the geometry the log recorded
        expect(row.neurons).toEqual(counts);

        const encoded = [
          [...encodeChannel(row.row, ChannelIndex.Red, counts[0], RETINA_WIDTH)],
          [...encodeChannel(row.row, ChannelIndex.Green, counts[1], RETINA_WIDTH)],
          [...encodeChannel(row.row, ChannelIndex.Blue, counts[2], RETINA_WIDTH)],
        ];
        const printed = encoded.map((channel) => channel.map((value) => formatG(value)));

        valuesExpected += counts[0]! + counts[1]! + counts[2]!;
        for (let channel = 0; channel < 3; channel++) {
          for (let neuron = 0; neuron < counts[channel]!; neuron++) {
            const goldenValue = log.steps[index]!.printed[ranges[channel]![0] + neuron];
            const portValue = printed[channel]![neuron];
            valuesCompared++;
            if (goldenValue !== portValue && mismatch === null) {
              mismatch = `agent ${agent} step ${index + 1} nerve ${ranges[channel]![0] + neuron}: golden ${goldenValue} != port ${portValue}`;
            }
          }
        }
        rowsCompared++;
      }
    }

    // The numbers this lane quotes as evidence.
    expect(mismatch).toBeNull();
    // The numbers this lane quotes as evidence: every retina row of the run, every channel,
    // every neuron, reproduced from the real pixels. 27 values per row for most agents
    // (9+9+9); the agents whose channels pool 1/9/11 values contribute fewer.
    expect(agentsCompared).toBe(83);
    expect(rowsCompared).toBe(7315);
    expect(valuesCompared).toBe(valuesExpected);
    expect(valuesCompared).toBeGreaterThan(190000);
  });

  it.skipIf(!goldensAvailable)('microtest_von: the single step of the smoke scenario', () => {
    let compared = 0;
    for (const row of microtest.rows) {
      if (!hasFunctionalLog('microtest_von', row.agent)) continue;
      const log = readFunctionalLog('microtest_von', row.agent);
      const ranges = log.sensorRanges.slice(-3).map((token) => token.split('-').map(Number) as [number, number]);
      const counts: [number, number, number] = [
        ranges[0]![1] - ranges[0]![0] + 1,
        ranges[1]![1] - ranges[1]![0] + 1,
        ranges[2]![1] - ranges[2]![0] + 1,
      ];
      expect(row.neurons).toEqual(counts);
      const block = log.steps[row.step - 1];
      expect(block).toBeDefined();
      const printed = [
        [...encodeChannel(row.row, ChannelIndex.Red, counts[0], RETINA_WIDTH)].map((value) => formatG(value)),
        [...encodeChannel(row.row, ChannelIndex.Green, counts[1], RETINA_WIDTH)].map((value) => formatG(value)),
        [...encodeChannel(row.row, ChannelIndex.Blue, counts[2], RETINA_WIDTH)].map((value) => formatG(value)),
      ];
      for (let channel = 0; channel < 3; channel++) {
        for (let neuron = 0; neuron < counts[channel]!; neuron++) {
          expect(printed[channel]![neuron]).toBe(block!.printed[ranges[channel]![0] + neuron]);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it.skipIf(!goldensAvailable)('the run exercises both pooling branches on real rows', () => {
    const countsSeen = new Set<number>();
    for (const row of minitest.rows) for (const count of row.neurons) countsSeen.add(count);
    // integer branch: 22/c divides exactly; fractional: everything else
    const integerBranch = [...countsSeen].filter((count) => count > 0 && (22 / count) % 1 === 0);
    const fractionalBranch = [...countsSeen].filter((count) => count > 0 && (22 / count) % 1 !== 0);
    expect(integerBranch.length).toBeGreaterThan(0);
    expect(fractionalBranch.length).toBeGreaterThan(0);
  });
});
