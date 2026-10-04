/**
 * Lane L18 (browser wiring) — the boot's parity test.
 *
 * The browser lane owns no frozen artifact (PORT_SPEC: "Not frozen — windowing, widgets,
 * camera feel, Three.js visuals, tool UIs"), but the *boot* it runs before the first step is
 * the native's own pre-step path, and four of the artifacts that path produces **are**
 * frozen: `run/original.wf`, `run/original.wfs`, `run/converted.wf`, `run/normalized.wf`.
 * This test is the evidence:
 *
 *   - boot each recorded scenario from the recorded sources (`oracle/<scenario>/run/original.*`),
 *   - compare every artifact with the golden byte-for-byte,
 *   - write the same artifacts into a candidate run tree, which is exactly what
 *     `./oracle/run_parity.sh <scenario> --candidate <dir>` reads,
 *   - and assert the read plan (no required key blocked, `InitAgents` reported as
 *     provisional rather than substituted).
 *
 * Goldens are only ever read. When they are absent (a fresh worktree: `oracle/<scenario>/run`
 * is untracked) the parity half is skipped, and the bundled-worldfile half runs against the
 * copies under `src/browser/worldfiles/`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createConfig, type PropertyNode } from '../../model/types';
import { DEMO_SCENARIOS, SCENARIOS, type ScenarioName } from './scenarios';
import type { Rgb } from './worldParams';
import { bootWorld, ARTIFACT_KEYS, WorldBootError } from './worldBoot';
import { bundledSources } from './bundledWorlds';
import {
  MONITOR_DOCUMENT_PATH,
  MONITOR_SCHEMA_PATH,
  MONITOR_SOURCE_TEXT,
  bundledMonitorDocument,
} from './bundledMonitors';
import {
  REPO_ROOT,
  bundledSourceTexts,
  candidateRoot,
  oracleRoot,
  oracleSources,
  writeCandidateTree,
} from './nodeSources';

const goldenAvailable = SCENARIOS.every((scenario) =>
  existsSync(path.join(oracleRoot(), scenario.name, 'run', 'normalized.wf')),
);

function golden(scenario: string, file: string): string {
  return readFileSync(path.join(oracleRoot(), scenario, 'run', file), 'utf8');
}

// ======================================================================================== //
// bundled worldfiles == the native inputs
// ======================================================================================== //

describe.skipIf(!goldenAvailable)('L18 bundled worldfiles', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: the copies under src/browser/worldfiles are the recorded inputs`, () => {
      const bundled = bundledSourceTexts(scenario);
      expect(bundled.worldfile).toBe(golden(scenario.name, 'original.wf'));
      expect(bundled.schema).toBe(golden(scenario.name, 'original.wfs'));
    });
  }
});

// ======================================================================================== //
// bundled monitor documents == the native inputs
// ======================================================================================== //

/** The native tree the monitor documents come from (`POLYWORLD_NATIVE` overrides, as L14's test). */
const NATIVE_ROOT = path.resolve(process.env.POLYWORLD_NATIVE ?? path.join(REPO_ROOT, '..', 'polyworld'));
const haveNative = existsSync(path.join(NATIVE_ROOT, 'etc', 'monitors.mfs'));
const MONITOR_VECTORS = path.join(REPO_ROOT, 'src', 'model', 'monitor', 'native', 'vectors');

/** One recorded leaf of `native/vectors/monitorConfig.<ui>.json`. */
interface MonitorVectorLeaf {
  readonly path: string;
  readonly kind: 'bool' | 'int' | 'float' | 'string';
  readonly value?: string | number;
  readonly bits?: number;
}

interface MonitorVectorDocument {
  readonly document: string;
  readonly leaves: readonly MonitorVectorLeaf[];
}

/** Native `float` bits, the way the monitor lane's own vector test compares them. */
function floatBits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return view.getUint32(0);
}

/**
 * Walk a dotted path with `[i]` element indexes (`CameraControllerSettings[1].Rotate.Fixation.Z`),
 * resolving arrays through `elements()` — native `std::map` order, which is the decimal order the
 * probe used. Same walk as lane L14's `tests/monitor.test.ts`; kept local because the lane's own
 * test file must not depend on another lane's.
 */
function resolveLeaf(doc: PropertyNode, dotted: string): { parent: PropertyNode; name: string } {
  const segments = dotted.split('.');
  let node = doc;

  for (let i = 0; i < segments.length - 1; i++) {
    const match = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(segments[i]!);
    if (match === null) throw new Error(`cannot parse vector path segment '${segments[i]}' in '${dotted}'`);

    const child = createConfig(node).node(match[1]!);
    if (match[2] === undefined) {
      node = child;
    } else {
      const element = child.elements()[Number(match[2])];
      if (element === undefined) throw new Error(`no element ${match[2]} in '${dotted}'`);
      node = element;
    }
  }

  const last = /^([A-Za-z0-9_]+)$/.exec(segments[segments.length - 1]!);
  if (last === null) throw new Error(`cannot parse vector path leaf '${dotted}'`);
  return { parent: node, name: last[1]! };
}

describe('L18 bundled monitor documents', () => {
  it('carries the two native documents the monitor mount reads', () => {
    expect(Object.keys(MONITOR_SOURCE_TEXT).sort()).toEqual([MONITOR_DOCUMENT_PATH, MONITOR_SCHEMA_PATH].sort());
    expect(MONITOR_SOURCE_TEXT[MONITOR_DOCUMENT_PATH]).toBe('@defaults term');
    expect(MONITOR_SOURCE_TEXT[MONITOR_SCHEMA_PATH] ?? '').toContain('FrequencyStore');
  });

  it.skipIf(!haveNative)('are byte-copies of the native inputs (`../polyworld/etc/**`)', () => {
    // The bundle's copies are the *only* monitor documents a page can read: `etc/monitors.mfs` and
    // `etc/term.mf` live in the native tree, outside this repo (PORT-NOTE
    // (L18/bundled-monitor-documents)). Byte-comparing them here is what keeps the duplication from
    // drifting silently — the same guarantee `bundledSourceTexts` gives the worldfiles.
    for (const [nativePath, bundled] of [
      ['etc/monitors.mfs', MONITOR_SOURCE_TEXT[MONITOR_SCHEMA_PATH]],
      ['etc/term.mf', MONITOR_SOURCE_TEXT[MONITOR_DOCUMENT_PATH]],
    ] as const) {
      expect(bundled, nativePath).toBe(readFileSync(path.join(NATIVE_ROOT, nativePath), 'latin1'));
    }
  });

  it('resolve to the values the native probe recorded (no native tree needed)', () => {
    // The always-available half of the drift check: the recorded probe output is in git, so a fresh
    // worktree with no native tree still proves the bundled bytes *mean* what native's document did.
    const vectors = JSON.parse(
      readFileSync(path.join(MONITOR_VECTORS, 'monitorConfig.term.json'), 'utf8'),
    ) as MonitorVectorDocument;
    expect(vectors.document).toBe(MONITOR_DOCUMENT_PATH);

    const doc = bundledMonitorDocument();
    expect(vectors.leaves.length).toBe(89);

    for (const leaf of vectors.leaves) {
      const label = `term:${leaf.path}`;

      if (leaf.kind === 'int' && leaf.path.endsWith('.count')) {
        const count = createConfig(doc).getArray(leaf.path.split('.')[0]!).length;
        expect(count, label).toBe(leaf.value);
        continue;
      }

      const { parent, name } = resolveLeaf(doc, leaf.path);
      const cfg = createConfig(parent);

      switch (leaf.kind) {
        case 'bool':
          expect(cfg.getBool(name), label).toBe(leaf.value !== 0);
          break;
        case 'int':
          expect(cfg.getInt(name), label).toBe(leaf.value);
          break;
        case 'float':
          expect(floatBits(cfg.getFloat(name)), label).toBe(leaf.bits);
          break;
        case 'string':
          expect(cfg.getString(name), label).toBe(leaf.value);
          break;
      }
    }

    // The three values the monitor's frozen artifact depends on, named so a reader of this file
    // does not have to go looking for them in the vector: `--ui term` stores every 100th step plus
    // the first, and filters the performance lines out.
    const statusText = createConfig(doc).at('StatusText');
    expect(statusText.getBool('Enabled')).toBe(true);
    expect(statusText.getInt('FrequencyStore')).toBe(100);
    expect(statusText.getBool('StorePerformance')).toBe(false);
  });
});

// ======================================================================================== //
// demo worlds (browser-only; no golden) — the copy is the native input, and the reads resolve
// ======================================================================================== //

describe('L18 demo worlds', () => {
  for (const scenario of DEMO_SCENARIOS) {
    it.skipIf(!haveNative)(
      `${scenario.name}: the copy under src/browser/worldfiles is the native input`,
      () => {
        // A demo world has no recorded golden, so this is where its bundled bytes are pinned —
        // against the native tree itself (`PORT-NOTE (L18/demo-scenarios)` in `scenarios.ts`), the
        // same rule the monitor documents follow. Nothing about the demo world is our invention.
        const nativePath = path.join(NATIVE_ROOT, scenario.worldfilePath);
        expect(bundledSourceTexts(scenario).worldfile).toBe(readFileSync(nativePath, 'utf8'));
      },
    );
  }

  it('bricks_voff reads its barriers and brick patch from the native worldfile', () => {
    // L18c's visual-fidelity world: the one bundled world that declares BrickPatches, so it is the
    // page's only way to *draw* bricks. The numbers are the file's (`Measured on this machine`
    // through `bootWorld`): a brick patch of 100 bricks at the world's far edge, and two barriers
    // that boot degenerate (their `Z2` equals `Z1` until the `dyn` grows them past step 10 000).
    const booted = bootWorld(bundledSources('bricks_voff'));
    expect(booted.report.blocked).toEqual([]);
    expect(booted.params.worldSize).toBe(100);
    expect(booted.params.brickHeight).toBe(3);
    expect(booted.params.barrierHeight).toBe(5);

    expect(booted.params.declaredBarriers).toBe(2);
    expect(booted.params.barriers).toHaveLength(2);
    // The worldfile writes ratios; `RatioBarrierPositions True` scales them by `WorldSize` in
    // `barrier::updateVertices`, exactly as `worldParams.ts`'s note records.
    expect(booted.params.barriers[0]?.xa).toBeCloseTo(0.3333 * 100, 4);
    expect(booted.params.barriers[0]?.za).toBeCloseTo(-100, 4);

    expect(booted.params.declaredBrickPatches).toBe(1);
    const patch = booted.params.brickPatches[0]!;
    expect(patch.on).toBe(true);
    expect(patch.brickCount).toBe(100);
    expect(patch.shape).toBe('R');
    expect(patch.color.r).toBeCloseTo(0.4, 6);
    expect(patch.startX).toBe(0);
    expect(patch.endX).toBe(100);
    // The recorded worlds declare none — the panel's `no BrickPatches` reading (L18c).
    expect(bootWorld(bundledSources('minitest_voff')).params.declaredBrickPatches).toBe(0);
  });
});

// ======================================================================================== //
// the boot: artifact parity + the read plan
// ======================================================================================== //

/**
 * What each recorded scenario's document says about the world it describes — the numbers the
 * shell reads out of it, per scenario, so a new scenario cannot inherit another's expectations.
 *
 * `microtest`/`minitest` state their own extent and agent counts; `hello` (lane L20's demo world)
 * states **one** key (`MaxSteps 500`) and takes everything else from the schema's defaults at
 * `WorldSize 100` — see PORT-NOTE (L18/hello-is-a-literal-world) in `scenarios.ts`. Measured
 * through `bootWorld` on the recorded sources (`oracle/<scenario>/run/original.*`), never assumed:
 * a wrong expectation here is what this test exists to catch.
 */
interface WorldShape {
  readonly worldSize: number;
  readonly minAgents: number;
  readonly maxAgents: number;
  /** What `InitAgents` itself reads as (the low-spec-pc worldfiles state `InitAgents MaxAgents`;
   *  `hello` takes the schema's own `180`). The shell's display count is `MaxAgents` either way. */
  readonly initAgents: number;
  readonly maxSteps: number;
  readonly vision: boolean;
}

const WORLD_SHAPE: Record<ScenarioName, WorldShape> = {
  microtest_voff: { worldSize: 25, minAgents: 20, maxAgents: 25, initAgents: 25, maxSteps: 1, vision: false },
  microtest_von: { worldSize: 25, minAgents: 20, maxAgents: 25, initAgents: 25, maxSteps: 1, vision: true },
  minitest_voff: { worldSize: 25, minAgents: 20, maxAgents: 25, initAgents: 25, maxSteps: 301, vision: false },
  minitest_von: { worldSize: 25, minAgents: 20, maxAgents: 25, initAgents: 25, maxSteps: 301, vision: true },
  hello: { worldSize: 100, minAgents: 90, maxAgents: 300, initAgents: 180, maxSteps: 500, vision: false },
  // Not a recorded scenario, so the parity loop above never visits it (`SCENARIOS` is the recorded
  // set): the entry exists so the record type stays total. Measured through `bootWorld` on the
  // native `growingBarriers_grayBricks.wf` (L18c), not assumed — every value comes from that file
  // or the schema's defaults at the file's own `WorldSize 100`.
  bricks_voff: { worldSize: 100, minAgents: 90, maxAgents: 300, initAgents: 180, maxSteps: 200_000, vision: false },
};

describe.skipIf(!goldenAvailable)('L18 browser boot — oracle parity', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const booted = bootWorld(oracleSources(scenario));

      it('reproduces run/original.wf and run/original.wfs byte-for-byte', () => {
        expect(booted.artifacts.get(ARTIFACT_KEYS.originalWorldfile)).toBe(golden(scenario.name, 'original.wf'));
        expect(booted.artifacts.get(ARTIFACT_KEYS.originalSchema)).toBe(golden(scenario.name, 'original.wfs'));
      });

      it('reproduces run/converted.wf byte-for-byte', () => {
        expect(booted.converted).toBe(golden(scenario.name, 'converted.wf'));
      });

      it('reproduces run/normalized.wf byte-for-byte', () => {
        expect(booted.normalized).toBe(golden(scenario.name, 'normalized.wf'));
      });

      it('writes the candidate run tree the parity harness reads', () => {
        const dir = writeCandidateTree(candidateRoot(), scenario.name, booted.artifacts);
        for (const [relative, text] of booted.artifacts) {
          expect(readFileSync(path.join(dir, relative), 'utf8'), relative).toBe(text);
        }
      });

      it('reads every required key, and reports the provisional one instead of substituting it', () => {
        // Lane L4 landed: every expression key evaluates, so nothing is blocked any more --
        // this assertion is the visible end of the lane-L4 gap (`InitAgents MaxAgents`, the
        // barrier/duration arithmetic, the schema defaults) it used to report.
        expect(booted.report.blocked).toEqual([]);
        expect(booted.report.provisional.map((entry) => entry.key)).toEqual(['InitAgents']);
        // The key itself now reads; it stays *provisional* because the shell's display count is
        // still `MaxAgents` until lane L11 creates the real population. The *reason* states what
        // the document's own `InitAgents` read as — an expression in the low-spec-pc worldfiles,
        // the schema's literal in `hello` — so it is per-scenario, not a constant.
        expect(booted.report.provisional[0]?.reason).toBe(`read as ${WORLD_SHAPE[scenario.name].initAgents}`);
        expect(booted.report.provisional[0]?.used).toContain(String(booted.params.maxAgents));
        expect(booted.report.ok.map((entry) => entry.key)).toContain('InitAgents');
        expect(booted.report.ok.length).toBeGreaterThan(15);
        // Every entry in `ok` names where its value is consumed — that is what makes the read
        // plan reviewable rather than a pile of `doc.get` calls.
        for (const entry of booted.report.ok) expect(entry.consumer.length).toBeGreaterThan(0);
      });

      it('derives the shell parameters from the document', () => {
        const shape = WORLD_SHAPE[scenario.name];
        const params = booted.params;
        expect(params.worldSize).toBe(shape.worldSize);
        expect(params.minAgents).toBe(shape.minAgents);
        expect(params.maxAgents).toBe(shape.maxAgents);
        expect(params.maxSteps).toBe(shape.maxSteps);
        expect(params.vision).toBe(shape.vision);
        expect(params.brainArchitecture).toBe('Groups');
        expect(params.agent.height).toBeCloseTo(0.2, 6);
        expect(params.agent.size).toEqual({ min: 0.5, max: 2 });
        expect(params.agent.speed).toEqual({ min: 0.5, max: 1.5 });
        expect(params.agent.maxVelocity).toBe(1);
        expect(params.agent.motionRate).toBe(1);
        expect(params.displayAgents).toBe(params.maxAgents);
        expect(params.positionSeed).toBe(42);
        // The native world spans x ∈ [0, W] and z ∈ [-W, 0]; the domain covers it exactly
        // (Simulation.cc:4164-4182 cleanups included).
        expect(params.domain.startX).toBe(0);
        expect(params.domain.endX).toBe(shape.worldSize);
        expect(params.domain.startZ).toBe(-shape.worldSize);
        expect(params.domain.endZ).toBe(0);
      });

      it('reads the worldfile colours as RGB blocks', () => {
        // `getFloat` rounds to f32 exactly as native `(float)doc.get(...)` does, hence the
        // tolerance rather than equality with the decimal literals in the worldfile.
        const expectColor = (actual: Rgb, r: number, g: number, b: number): void => {
          expect(actual.r).toBeCloseTo(r, 7);
          expect(actual.g).toBeCloseTo(g, 7);
          expect(actual.b).toBeCloseTo(b, 7);
        };
        expectColor(booted.params.colors.ground, 0.1, 0.15, 0.05);
        expectColor(booted.params.colors.food, 0.2, 0.6, 0.2);
        expectColor(booted.params.colors.brick, 0.6, 0.2, 0.2);
        expectColor(booted.params.colors.barrier, 0.35, 0.25, 0.15);
      });

      it('reads the domain’s food patches as absolute rectangles', () => {
        // Both recorded shapes carry the schema's two default patches, whose z-extents are
        // fractions of the *world's* own size (`WorldSize 25` for microtest/minitest, the schema
        // default `100` for `hello`) and whose z is measured from the domain's startZ, not from
        // the world's origin — so the expectations are derived from the document's own W.
        const worldSize = booted.params.worldSize;
        const startZ = booted.params.domain.startZ;
        const patches = booted.params.patches;
        expect(patches).toHaveLength(2);
        // Patch::initBase: the patches sit in the domain's absolute space.
        for (const patch of patches) {
          expect(patch.on).toBe(true);
          expect(patch.shape).toBe('R');
          expect(patch.startX).toBe(0);
          expect(patch.endX).toBe(worldSize);
          expect(patch.endZ - patch.startZ).toBeCloseTo(worldSize * (patch.index === 0 ? 0.1 : 0.4), 5);
        }
        const [first, second] = patches;
        expect(first?.foodFraction).toBeCloseTo(0.2, 6);
        expect(second?.foodFraction).toBeCloseTo(0.8, 6);
        // Patch::initBase: CenterZ is a fraction of W from the domain's startZ (0.05 / 0.8 of it)
        // → `-25 + 0.05 * 25 = -23.75` at `WorldSize 25`, `-100 + 0.05 * 100 = -95` at `100`.
        // Precision 5 because the hello document's chain runs through f32 (`-19.999998807…`).
        expect(first?.centerZ).toBeCloseTo(startZ + worldSize * 0.05, 5);
        expect(second?.centerZ).toBeCloseTo(startZ + worldSize * 0.8, 5);
      });
    });
  }
});

// ======================================================================================== //
// no silent substitution
// ======================================================================================== //

describe('L18 browser boot — refuses a worldfile it cannot read', () => {
  // The bundled sources need no oracle at all, so this test always runs.
  const source = bundledSources('microtest_voff');

  it('fails loudly when a required key is an expression it cannot evaluate', () => {
    // Lane L4 evaluates worldfile expressions, so the refusal is no longer "the language is
    // missing" — it is a value the interpreter itself cannot produce (native: a Python
    // `NameError`, reported as `[Python] name 'UndefinedSize' is not defined`).
    const worldfileText = source.worldfileText.replace('WorldSize 25', 'WorldSize UndefinedSize');
    expect(worldfileText).not.toBe(source.worldfileText);

    let thrown: unknown;
    try {
      bootWorld({ ...source, worldfileText });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorldBootError);
    const failure = thrown as WorldBootError;
    expect(failure.blockedKeys.map((entry) => entry.key)).toContain('WorldSize');
    expect(failure.message).toContain('WorldSize');
    expect(failure.message).toContain('No value was substituted');
  });
});
