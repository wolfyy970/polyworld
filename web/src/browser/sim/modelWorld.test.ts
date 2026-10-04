/**
 * Lane L18 (browser wiring) — the seam contract, exercised against the real model.
 *
 * This is the test that says "the shell's world is lane L11's `Simulation` now": every assertion
 * here reads the same object `app.ts` renders (`createModelWorld`), built the way the page builds it
 * — the bundled worldfile sources, the page's in-memory run tree, native coordinates.
 *
 * It deliberately uses the **bundled** sources (`bundledWorlds.ts`) instead of `oracle/**`, so it
 * runs in a fresh worktree with no recorded goldens; the byte-for-byte comparison with the native
 * run lives in `runTree.*.test.ts` (which needs the goldens) and in `worldBoot.test.ts`.
 *
 * PORT-NOTE (L18/one-world-per-process): the model's tables are process-wide (`FoodType`, the RNG
 * surfaces, `gXSortedObjects`), so a second `TSimulation` cannot be constructed in one process
 * (`sim: duplicate FoodType name 'Standard' (native errs)`) — native runs one simulation per
 * process too. This file therefore builds exactly **one** world, and the two run-tree tests are two
 * files so vitest's per-file worker isolation gives each of them one process each.
 */

import { describe, expect, it } from 'vitest';

import { createModelWorld, type ModelWorld } from './modelWorld';
import { bootWorld } from './worldBoot';
import { bundledSources } from './bundledWorlds';

/** Built once: see PORT-NOTE (L18/one-world-per-process) above. */
const boot = bootWorld(bundledSources('microtest_voff'));
const world: ModelWorld = createModelWorld({ boot, stepSeconds: 1 / 30 });

describe('L18 model world — the seam contract', () => {
  it('names itself the model and starts unended', () => {
    expect(world.flavour).toBe('model');
    expect(world.ended).toBe(false);
    expect(world.notice).toBeNull();
  });

  it('reports the run’s own clock, budget and seed', () => {
    expect(world.stepIndex).toBe(0);
    expect(world.simSeconds).toBe(0);
    expect(world.maxSteps).toBe(1); // microtest.wf: MaxSteps 1
    expect(world.seed).toBe(42); // the worldfile's InitSeed, untouched
    expect(world.agentCapacity).toBe(25); // native MaxAgents
  });

  it('hands over the live roster in native coordinates', () => {
    const agents = world.agents;
    expect(agents.length).toBe(25);
    for (const agent of agents) {
      // Native space: x ∈ [0, worldSize], z ∈ [-worldSize, 0] (simSeam.ts's PORT-NOTE).
      expect(agent.x).toBeGreaterThanOrEqual(0);
      expect(agent.x).toBeLessThanOrEqual(25);
      expect(agent.z).toBeGreaterThanOrEqual(-25);
      expect(agent.z).toBeLessThanOrEqual(0);
      expect(agent.yaw).toBeGreaterThanOrEqual(0);
      expect(agent.yaw).toBeLessThan(360);
      expect(agent.size).toBeGreaterThan(0);
      expect(agent.alive).toBe(true);
      // The model's own body colour (`agent::color()`), not a palette slot.
      for (const channel of agent.color) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    // The roster is the model's own list, so its order is the list's (PORT_SPEC rule 4): the
    // projection must be stable across reads that do not step the world.
    expect(world.agents.map((a) => a.x)).toEqual(agents.map((a) => a.x));
  });

  it('projects the model’s barrier walls', () => {
    // The recorded worldfiles declare two barriers from the schema default, ratio-scaled by
    // `WorldSize 25` (`barrier::updateVertices`; the boot report's notes say so).
    const barriers = world.barriers;
    expect(barriers).toHaveLength(2);
    for (const barrier of barriers) {
      expect(barrier.height).toBe(5); // BarrierHeight
      expect(barrier.xa).toBeGreaterThanOrEqual(0);
      expect(barrier.xa).toBeLessThanOrEqual(25);
      expect(barrier.za).toBeGreaterThanOrEqual(-25);
      expect(barrier.za).toBeLessThanOrEqual(0);
    }
    expect(barriers[0]?.xa).toBeCloseTo(0.3333 * 25, 3);
  });

  it('projects the model’s food boxes and its (empty) brick list', () => {
    // Food is the model's own (`food::initFoodAt`): centre position, `fLength[3]`, `gFoodColor`.
    const food = world.food;
    expect(food.length).toBeGreaterThan(0);
    for (const box of food) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x).toBeLessThanOrEqual(25);
      expect(box.z).toBeGreaterThanOrEqual(-25);
      expect(box.z).toBeLessThanOrEqual(0);
      expect(box.sizeX).toBeGreaterThan(0);
      expect(box.sizeY).toBeGreaterThan(0); // `gFoodHeight`
      for (const channel of box.color) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    // microtest declares no `BrickPatches` (the schema default is `[ ]`), so the model holds no
    // bricks and the scene draws none — the honest zero the panel reports (L18c).
    expect(world.bricks).toEqual([]);
  });

  it('writes the run tree the page keeps in memory, not just the boot artifacts', () => {
    const files = world.runFileSystem;
    expect(files).not.toBeNull();
    const paths = files!.paths();
    for (const relative of [
      'run/original.wf',
      'run/original.wfs',
      'run/converted.wf',
      'run/normalized.wf',
      'run/BirthsDeaths.log',
      'run/lifespans.txt',
      'run/population.txt',
      'run/genome/genestats.txt',
      'run/motion/position/agents/position_1.txt',
      'run/brain/anatomy/brainAnatomy_1_incept.txt.gz',
      'run/brain/synapses/synapses_1_incept.txt.gz',
    ]) {
      expect(paths, relative).toContain(relative);
    }
    // The report the panel shows is the sink's own count/size.
    const report = world.runFiles();
    expect(report).not.toBeNull();
    expect(report!.count).toBe(files!.count());
    expect(report!.count).toBeGreaterThan(150); // the boot alone writes ~196 files for microtest
    expect(report!.bytes).toBeGreaterThan(100_000);
  });

  it('steps the real step loop, and the digest follows the state', () => {
    const before = world.stateDigest();
    expect(world.stateDigest()).toBe(before); // pure: same state, same digest

    world.step();
    expect(world.stepIndex).toBe(1);
    expect(world.simSeconds).toBeCloseTo(1 / 30, 10);
    expect(world.stateDigest()).not.toBe(before);

    // The monitor hangs off `stepEnding` (native `main.cc:160`), and `FrequencyStore 100` in
    // `etc/term.mf` makes step 1 the first stored one: the page's run tree now carries lane L14's
    // frozen artifact too, through the page's own sink (PORT-NOTE (L18/monitors-in-the-page)).
    expect(world.runFileSystem!.paths()).toContain('run/stats/stat.1');
    expect(world.runFileSystem!.text('run/stats/stat.1') ?? '').not.toBe('');

    // `MaxSteps 1`: the next call is native's `End( "MaxSteps" )`, which writes `endReason.txt`
    // and leaves the run finished (native's `Step()` is inert from there on).
    world.step();
    expect(world.ended).toBe(true);
    expect(world.notice).toContain('MaxSteps');
    expect(world.runFileSystem!.text('run/endReason.txt')?.trim()).toBe('MaxSteps');
  });

  it('is a run, not a rewind: the end phase is the destructor’s, and it is complete', () => {
    // `dispose()` is native's `~TSimulation`: its `DR_SIMEND` kills are the last rows of
    // `lifespans.txt`, and it writes `run/endStep.txt`. (The page never needs to call it — its run
    // tree dies with the tab — but the parity tree must be a finished run, so the test does.)
    world.dispose();
    expect(world.runFileSystem!.text('run/endStep.txt')).toBe('1\n');
    expect(world.runFileSystem!.text('run/lifespans.txt') ?? '').toContain('SIMEND');
  });
});
