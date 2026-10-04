/**
 * Lane L14 (monitor) — the lane's acceptance tests.
 *
 * Three bands, weakest to strongest evidence:
 *
 *  1. **Native vectors** (`src/model/monitor/native/vectors/*.json`, produced by
 *     `native/monitorprobe.sh` linking `libpolyworld.dylib` — the code the goldens came from).
 *     Floats are compared as IEEE-754 bit patterns, so a 1-ulp drift fails. This band covers the
 *     camera controllers (all three modes), the movie sample rule (including its `timestep 0`
 *     edge), the enum vocabularies and the *resolution of the real monitor documents*
 *     (`etc/monitors.mfs` + `etc/term.mf`, `etc/gui.mf`).
 *  2. **Monitor behaviour** — the parts no vector can reach: tracker selection/re-selection and
 *     its death listener, the status-text display/store gating and `"Rate"` filter, the byte
 *     layout of the file body, the farm command string.
 *  3. **Golden parity** — the frozen artifact this lane writes (`run/stats/stat.<timestep>`):
 *     which files exist for the recorded scenarios (predicted from `endStep.txt` + the term
 *     defaults and compared with the golden directory), their **bytes** (regenerated through the
 *     ported monitor and compared with the oracle), the movie frame *schedule* (from the golden
 *     `movie.pmv` header), and finally `oracle/run_parity.sh` over a candidate tree whose
 *     `run/stats/**` was produced by this lane's code.
 *
 * The native tree and the goldens are needed for bands 1 and 3; both are located through the
 * same environment variables the harness uses (`POLYWORLD_NATIVE`, `POLYWORLD_ORACLE_ROOT`), and
 * the tests skip *visibly* when they are absent (`oracle/<scenario>/run/**` is gitignored).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  AgentTracker,
  BirthRateMonitor,
  BrainMonitor,
  CameraController,
  CameraControllerMode,
  DEFAULT_CAMERA_PROPERTIES,
  FarmMonitor,
  FitnessMonitor,
  FoodEnergyMonitor,
  MonitorManager,
  MonitorType,
  Perspective,
  PovMonitor,
  PopulationMonitor,
  SceneMonitor,
  Signal,
  StatusTextMonitor,
  TrackerMode,
  cameraProperties,
  createFitnessParms,
  createNumberParms,
  loadMonitorDocument,
  movieSettings,
  rotationParms,
  shouldRecord,
  shouldRecordAt,
  statFilePath,
  statusFileBody,
  type ControllerCamera,
  type CppPropertyMetadata,
  type FarmRunner,
  type MonitorSim,
  type SceneRendererSurface,
  type StatusTextStore,
  type TrackedAgent,
  type TrackedAgentCamera,
} from '../src/model/monitor';
import { createConfig, documentFromJs, globals, resetGlobals, type PropertyNode } from '../src/model/types';
import { assertUsableStagingRoot, stageGoldenCopy } from '../src/oracle/guard';

// --------------------------------------------------------------------------------------
// environment
// --------------------------------------------------------------------------------------

const WEB_ROOT = resolve(__dirname, '..');
const NATIVE_ROOT = resolve(process.env.POLYWORLD_NATIVE ?? join(WEB_ROOT, '..', 'polyworld'));
const ORACLE_ROOT = resolve(process.env.POLYWORLD_ORACLE_ROOT ?? join(WEB_ROOT, 'oracle'));
const VECTORS = join(WEB_ROOT, 'src', 'model', 'monitor', 'native', 'vectors');

const haveNative = existsSync(join(NATIVE_ROOT, 'etc', 'monitors.mfs'));
const haveMicrotestGolden = existsSync(join(ORACLE_ROOT, 'microtest_voff', 'run', 'manifest.sha256'));

const f = Math.fround;

function readLatin1(path: string): string {
  return readFileSync(path, 'latin1');
}

function readVector<T>(name: string): T {
  return JSON.parse(readFileSync(join(VECTORS, name), 'utf8')) as T;
}

function bits(v: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, v);
  return buf.getUint32(0);
}

function fromBits(u: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setUint32(0, u);
  return buf.getFloat32(0);
}

const work = mkdtempSync(join(tmpdir(), 'pw-l14-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// --------------------------------------------------------------------------------------
// band 1: native vectors
// --------------------------------------------------------------------------------------

interface CameraSnapshotVector {
  readonly position: readonly number[];
  readonly rotation: readonly number[];
}

interface RotateCase {
  readonly index: number;
  readonly radius: number;
  readonly height: number;
  readonly rate: number;
  readonly angleStart: number;
  readonly fixation: readonly number[];
  readonly worldsize: number;
  readonly frames: readonly CameraSnapshotVector[];
}

interface StaticCase {
  readonly index: number;
  readonly height: number;
  readonly worldsize: number;
  readonly frames: readonly CameraSnapshotVector[];
}

interface TrackingCase {
  readonly index: number;
  readonly perspective: number;
  readonly worldsize: number;
  readonly frames: readonly CameraSnapshotVector[];
}

interface CameraVectors {
  readonly rotate: readonly RotateCase[];
  readonly static: readonly StaticCase[];
  readonly agentTracking: readonly TrackingCase[];
}

/**
 * A `gcamera` stand-in that keeps what it was told, unrounded: the comparison below narrows
 * with `Math.fround` (which is what native's `float` members do), so a missing narrowing in the
 * controller shows up as a mismatch instead of being masked by the double.
 */
function mockCamera(): ControllerCamera & { snapshot(): number[] } {
  let pos: [number, number, number] = [0, 0, 0];
  let rot: [number, number, number] = [0, 0, 0];
  let attached: unknown = null;

  return {
    SetFixationPoint: () => {},
    SetRotation: (yaw, pitch, roll) => {
      rot = [yaw, pitch, roll];
    },
    settranslation: (x, y, z) => {
      pos = [x, y, z];
    },
    AttachTo: (obj) => {
      attached = obj;
    },
    x: () => pos[0],
    y: () => pos[1],
    z: () => pos[2],
    getyaw: () => rot[0],
    getpitch: () => rot[1],
    getroll: () => rot[2],
    snapshot: () => [pos[0], pos[1], pos[2], rot[0], rot[1], rot[2]],
    getAttached: () => attached,
  } as ControllerCamera & { snapshot(): number[]; getAttached(): unknown };
}

function expectSnapshot(mine: number[], expected: CameraSnapshotVector, label: string): void {
  for (let i = 0; i < 3; i++) {
    expect(bits(f(mine[i]!)), `${label} position[${i}]`).toBe(expected.position[i]);
  }
  for (let i = 0; i < 3; i++) {
    expect(bits(f(mine[3 + i]!)), `${label} rotation[${i}]`).toBe(expected.rotation[i]);
  }
}

describe('L14 band 1 — native vectors (libpolyworld.dylib)', () => {
  it('CameraController: Rotate / Static / AgentTracking(no target), bit for bit', () => {
    const vectors = readVector<CameraVectors>('camera.json');
    expect(vectors.rotate.length).toBeGreaterThan(20);
    expect(vectors.static.length).toBeGreaterThan(20);

    for (const c of vectors.rotate) {
      const camera = mockCamera();
      globals.worldsize = fromBits(c.worldsize);
      const controller = new CameraController(camera);
      controller.initRotation(
        rotationParms(
          fromBits(c.radius),
          fromBits(c.height),
          fromBits(c.rate),
          fromBits(c.angleStart),
          fromBits(c.fixation[0]!),
          fromBits(c.fixation[1]!),
          fromBits(c.fixation[2]!),
        ),
      );

      expect(controller.getMode()).toBe(CameraControllerMode.ROTATE);
      expectSnapshot(camera.snapshot(), c.frames[0]!, `rotate[${c.index}] frame 0`);
      for (let i = 1; i < c.frames.length; i++) {
        controller.step();
        expectSnapshot(camera.snapshot(), c.frames[i]!, `rotate[${c.index}] frame ${i}`);
      }
    }

    for (const c of vectors.static) {
      const camera = mockCamera();
      globals.worldsize = fromBits(c.worldsize);
      const controller = new CameraController(camera);
      controller.initStatic({ height: fromBits(c.height) });

      expect(controller.getMode()).toBe(CameraControllerMode.STATIC);
      expectSnapshot(camera.snapshot(), c.frames[0]!, `static[${c.index}] frame 0`);
      controller.step();
      expectSnapshot(camera.snapshot(), c.frames[1]!, `static[${c.index}] frame 1`);
    }

    for (const c of vectors.agentTracking) {
      const camera = mockCamera();
      globals.worldsize = fromBits(c.worldsize);
      const tracker = new AgentTracker('Fittest', createFitnessParms(1));
      const controller = new CameraController(camera);
      controller.initAgentTracking({
        tracker,
        perspective: c.perspective === 0 ? Perspective.OVERHEAD : Perspective.POV,
      });

      expect(controller.getAgentTracker()).toBe(tracker);
      expectSnapshot(camera.snapshot(), c.frames[0]!, `tracking[${c.index}] frame 0`);
      for (let i = 1; i < c.frames.length; i++) {
        controller.step();
        expectSnapshot(camera.snapshot(), c.frames[i]!, `tracking[${c.index}] frame ${i}`);
      }
    }
  });

  it('MovieSettings::shouldRecord( timestep ) grid matches the native, including timestep 0', () => {
    const vectors = readVector<{
      cases: readonly {
        record: number;
        sampleFrequency: number;
        sampleDuration: number;
        shouldRecord: number;
        timesteps: readonly number[];
      }[];
    }>('moviesettings.json');

    expect(vectors.cases.length).toBeGreaterThan(30);
    for (const c of vectors.cases) {
      const settings = movieSettings(
        c.record !== 0,
        'run/movie.pmv',
        c.sampleFrequency,
        c.sampleDuration,
      );
      expect(shouldRecord(settings)).toBe(c.shouldRecord !== 0);
      for (let t = 0; t < c.timesteps.length; t++) {
        expect(
          shouldRecordAt(settings, t) ? 1 : 0,
          `record=${c.record} sf=${c.sampleFrequency} sd=${c.sampleDuration} t=${t}`,
        ).toBe(c.timesteps[t]);
      }
    }
  });

  it('enum vocabularies, Parms factory defaults and the no-target state title', () => {
    const vectors = readVector<{
      monitorType: Record<string, number>;
      trackerMode: Record<string, number>;
      perspective: Record<string, number>;
      parms: {
        fitness: { mode: number; trackTilDeath: number; rank: number };
        fitnessNoTilDeath: { mode: number; trackTilDeath: number; rank: number };
        number: { mode: number; trackTilDeath: number; number: number };
      };
      stateTitle: { noTarget: string; noTargetNumberMode: string };
      names: { fittest: string };
    }>('enums.json');

    expect(MonitorType.CHART).toBe(vectors.monitorType.CHART);
    expect(MonitorType.BRAIN).toBe(vectors.monitorType.BRAIN);
    expect(MonitorType.POV).toBe(vectors.monitorType.POV);
    expect(MonitorType.STATUS_TEXT).toBe(vectors.monitorType.STATUS_TEXT);
    expect(MonitorType.FARM).toBe(vectors.monitorType.FARM);
    expect(MonitorType.SCENE).toBe(vectors.monitorType.SCENE);
    expect(TrackerMode.FITNESS).toBe(vectors.trackerMode.FITNESS);
    expect(TrackerMode.NUMBER).toBe(vectors.trackerMode.NUMBER);
    expect(Perspective.OVERHEAD).toBe(vectors.perspective.OVERHEAD);
    expect(Perspective.POV).toBe(vectors.perspective.POV);

    const fitness = createFitnessParms(vectors.parms.fitness.rank);
    expect(fitness.mode).toBe(vectors.parms.fitness.mode);
    expect(fitness.trackTilDeath).toBe(vectors.parms.fitness.trackTilDeath !== 0);

    const noTilDeath = createFitnessParms(1, false);
    expect(noTilDeath.trackTilDeath).toBe(vectors.parms.fitnessNoTilDeath.trackTilDeath !== 0);

    const number = createNumberParms(vectors.parms.number.number);
    expect(number.mode).toBe(vectors.parms.number.mode);
    expect(number.trackTilDeath).toBe(vectors.parms.number.trackTilDeath !== 0);

    expect(new AgentTracker('Fittest', fitness).getStateTitle()).toBe(
      vectors.stateTitle.noTarget,
    );
    expect(new AgentTracker('First', number).getStateTitle()).toBe(
      vectors.stateTitle.noTargetNumberMode,
    );
    expect(new AgentTracker('Fittest', fitness).getName()).toBe(vectors.names.fittest);
  });

  it.skipIf(!haveNative)(
    'the real monitor documents resolve to the native values (etc/monitors.mfs + term/gui)',
    () => {
      const cases = ['term', 'gui'] as const;

      for (const ui of cases) {
        const vectors = readVector<{
          document: string;
          leaves: readonly { path: string; kind: string; value?: string | number; bits?: number }[];
        }>(`monitorConfig.${ui}.json`);

        const documentPath = `./etc/${ui}.mf`;
        expect(vectors.document).toBe(documentPath);

        const doc = loadMonitorDocument(
          (path) => readFileSync(join(NATIVE_ROOT, path), 'latin1'),
          documentPath,
        );

        for (const leaf of vectors.leaves) {
          const label = `${ui}:${leaf.path}`;

          if (leaf.kind === 'int' && leaf.path.endsWith('.count')) {
            const name = leaf.path.split('.')[0];
            const count = createConfig(doc).getArray(name!).length;
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
              expect(bits(cfg.getFloat(name)), label).toBe(leaf.bits);
              break;
            case 'string':
              expect(cfg.getString(name), label).toBe(leaf.value);
              break;
            default:
              throw new Error(`unknown vector leaf kind ${leaf.kind}`);
          }
        }
      }
    },
  );
});

/**
 * Walk a dotted path with `[i]` element indexes (the shape the probe emits), e.g.
 * `CameraControllerSettings[1].Rotate.Fixation.Z` or `AgentTrackers[0].Fitness.Rank`.
 *
 * Element indexes are resolved through `elements()`, which is native `std::map` order; the
 * monitor documents name their array elements `"0"`, `"1"`, … and none of them has 11+ entries,
 * so that order *is* the numeric order the probe used (`get( i )` = the decimal-string lookup).
 */
function resolveLeaf(doc: PropertyNode, path: string): { parent: PropertyNode; name: string } {
  const segments = path.split('.');
  let node = doc;

  for (let i = 0; i < segments.length - 1; i++) {
    const match = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(segments[i]!);
    if (match === null) throw new Error(`cannot parse vector path segment '${segments[i]}' in '${path}'`);

    const child = createConfig(node).node(match[1]!);
    if (match[2] === undefined) {
      node = child;
    } else {
      // `elements()` is native `std::map` order (see the doc comment above).
      const element = child.elements()[Number(match[2])];
      if (element === undefined) throw new Error(`no element ${match[2]} in '${path}'`);
      node = element;
    }
  }

  const last = /^([A-Za-z0-9_]+)$/.exec(segments[segments.length - 1]!);
  if (last === null) throw new Error(`cannot parse vector path leaf '${path}'`);
  return { parent: node, name: last[1]! };
}

// --------------------------------------------------------------------------------------
// band 2: monitor behaviour
// --------------------------------------------------------------------------------------

/** A `TrackedAgent` with a number and a trivial camera (the parts the lane reads). */
function mockAgent(number: number, x = 0, z = 0): TrackedAgent & {
  listeners: Set<{ died(a: TrackedAgent): void }>;
  die(): void;
} {
  const listeners = new Set<{ died(a: TrackedAgent): void }>();
  const camera: TrackedAgentCamera = {
    x: () => x,
    y: () => 0,
    z: () => z,
    getyaw: () => 0,
    getpitch: () => 0,
    getroll: () => 0,
  };
  const agent = {
    Number: () => number,
    x: () => x,
    z: () => z,
    getCamera: () => camera,
    addListener: (listener: { died(a: TrackedAgent): void }) => {
      listeners.add(listener);
    },
    removeListener: (listener: { died(a: TrackedAgent): void }) => {
      listeners.delete(listener);
    },
    listeners,
    die: () => {
      for (const listener of [...listeners]) listener.died(agent);
    },
  };
  return agent;
}

/** The `MonitorSim` surface, with only what a test needs wired up. */
function mockSim(overrides: Partial<MonitorSim> = {}): MonitorSim {
  return {
    getStep: () => 1,
    isLockstep: () => false,
    getFitnessWeight: () => 0,
    GetMaxAgents: () => 25,
    GetNumDomains: () => 1,
    getNumAgents: () => 25,
    getNumBorn: () => 0,
    getFitnessStat: () => 0,
    getFoodEnergyStat: () => 0,
    getCurrentFittest: () => null,
    getAgentByNumber: () => null,
    getStatusText: () => {},
    GetAgentPovRenderer: () => null,
    getStage: () => ({}),
    ...overrides,
  };
}

describe('L14 band 2 — tracker selection, status text, farm command', () => {
  it('AgentTracker: title forms, listener registration and death clearing', () => {
    const agent = mockAgent(42);
    const tracker = new AgentTracker('Fittest', createFitnessParms(3));

    expect(tracker.getStateTitle()).toBe('No Agent');

    const changes: number[] = [];
    tracker.targetChanged.connect(() => changes.push(1));

    tracker.setTarget(agent);
    expect(tracker.getStateTitle()).toBe('T3:42');
    expect(changes.length).toBe(1);
    expect(agent.listeners.size).toBe(1);

    // Setting the same target changes nothing (native's `if( a != target )` guard).
    tracker.setTarget(agent);
    expect(changes.length).toBe(1);

    // trackTilDeath false drops the "T" marker.
    const loose = new AgentTracker('Fittest', createFitnessParms(3, false));
    loose.setTarget(agent);
    expect(loose.getStateTitle()).toBe('3:42');

    // Number mode: "<T>:<number>".
    const byNumber = new AgentTracker('First', createNumberParms(7));
    byNumber.setTarget(agent);
    expect(byNumber.getStateTitle()).toBe('T:42');

    // Death clears the target through the nested listener.
    agent.die();
    expect(tracker.getTarget()).toBeNull();
    expect(changes.length).toBe(2);
    expect(tracker.getStateTitle()).toBe('No Agent');
  });

  it('MonitorManager::step re-selects the target every step unless it tracks until death', () => {
    const fittest = mockAgent(11);
    const first = mockAgent(1);
    const sim = mockSim({
      getCurrentFittest: () => fittest,
      getAgentByNumber: () => first,
    });

    const manager = new ManagerHarness(sim);

    // trackTilDeath (TrackMode Agent): the first selection is kept.
    const holding = manager.addTracker(new AgentTracker('Holding', createFitnessParms(1)));
    manager.stepTrackers();
    expect(holding.getTarget()).toBe(fittest);
    manager.stepTrackers();
    expect(holding.getTarget()).toBe(fittest);

    // not trackTilDeath: re-selected every step (same object here, but the call is made).
    let selections = 0;
    const reselecting = manager.addTracker(
      new AgentTracker('Reselecting', createFitnessParms(1, false)),
    );
    const sim2 = mockSim({
      getCurrentFittest: () => {
        selections++;
        return fittest;
      },
    });
    const manager2 = new ManagerHarness(sim2);
    manager2.addTracker(reselecting);
    manager2.stepTrackers();
    manager2.stepTrackers();
    expect(selections).toBe(2);
    expect(reselecting.getTarget()).toBe(fittest);
  });

  it('MonitorManager: the Number arm drops TrackMode, the Fitness arm forwards it', () => {
    // PORT-NOTE(monitor/number-tracker-ignores-trackmode): native computes
    // `bool trackTilDeath = trackMode == "Agent"` in *both* tracker arms but only calls
    // `createFitness( rank, trackTilDeath )` with it; the Number arm calls
    // `Params::createNumber( number )` (MonitorManager.cc:76-78) and takes the factory
    // default (AgentTracker.h:24 → true). `TrackMode Slot` is schema-legal
    // (etc/monitors.mfs: Agent | Slot), so this is the one input where the dead local bites:
    // native holds a Number tracker until death, it does not re-select every step.
    // Driven from the in-memory document double, so it needs no native tree or golden.
    const doc = documentFromJs({
      BirthRate: { Enabled: 'False' },
      Fitness: { Enabled: 'False' },
      FoodEnergy: { Enabled: 'False' },
      Population: { Enabled: 'False' },
      AgentTrackers: [
        { Name: 'First', TrackMode: 'Slot', SelectionMode: 'Number', Number: '3' },
        { Name: 'Fittest', TrackMode: 'Slot', SelectionMode: 'Fitness', Fitness: { Rank: '2' } },
        { Name: 'Held', TrackMode: 'Agent', SelectionMode: 'Number', Number: '4' },
      ],
      Brain: { Enabled: 'False' },
      POV: { Enabled: 'False' },
      StatusText: { Enabled: 'False' },
      Farm: { Enabled: 'False' },
      MainScene: { Enabled: 'False' },
      OverheadScene: { Enabled: 'False' },
      SinglePOVScene: { Enabled: 'False' },
    });

    const manager = new MonitorManager(mockSim(), doc, {
      createSceneRenderer: () => mockRenderer(),
      createMovieWriter: () => ({ writeFrame: () => {}, close: () => {} }),
      statusTextStore: { writeTextFile: () => {} },
      cppProperties: { getMetadata: () => [] },
      farmRunner: { run: () => 0 },
      farmEnvironment: { isSet: () => false },
    });

    const parms = manager.getAgentTrackers().map((tracker) => tracker.getParms());

    // Number + TrackMode Slot: the dead local is *not* forwarded -> true (native's default).
    expect(parms[0]).toEqual({ mode: TrackerMode.NUMBER, trackTilDeath: true, number: 3 });
    // Fitness + TrackMode Slot: this arm *does* forward it -> false.
    expect(parms[1]).toEqual({ mode: TrackerMode.FITNESS, trackTilDeath: false, rank: 2 });
    // Number + TrackMode Agent: true either way, so the pair above is the discriminator.
    expect(parms[2]).toEqual({ mode: TrackerMode.NUMBER, trackTilDeath: true, number: 4 });
  });

  it('StatusTextMonitor: display needs a receiver, store does not; "Rate" filter; byte layout', () => {
    const stored: { path: string; text: string }[] = [];
    const store: StatusTextStore = {
      writeTextFile: (path, text) => stored.push({ path, text }),
    };

    let currentStep = 0;
    const sim = mockSim({
      getStep: () => currentStep,
      getStatusText: (out) => {
        out.push(`step = ${currentStep}`);
        out.push('Rate = 30.0');
        out.push('EatRate = 85.5');
      },
    });

    const monitor = new StatusTextMonitor(sim, 100, 100, false, store);

    // Step 1: no receiver yet -> no display, but the store branch runs.
    currentStep = 1;
    monitor.step(1);
    expect(stored.length).toBe(1);
    expect(stored[0]!.path).toBe('run/stats/stat.1');
    expect(stored[0]!.text).toBe('step = 1\nEatRate = 85.5\n');

    // Step 2: neither frequency divides it, and it is not step 1.
    currentStep = 2;
    monitor.step(2);
    expect(stored.length).toBe(1);
    expect(monitor.getStatusText()).toEqual(['step = 1', 'Rate = 30.0', 'EatRate = 85.5']);

    // With a receiver, step 100 displays and stores.
    let updates = 0;
    monitor.update.connect(() => updates++);
    currentStep = 100;
    monitor.step(100);
    expect(stored.map((s) => s.path)).toEqual(['run/stats/stat.1', 'run/stats/stat.100']);
    expect(updates).toBe(1);

    // The display frequency (100) and the store frequency (100) are independent; step 1 is
    // always stored. With StorePerformance true the performance lines survive.
    const storing: { text: string }[] = [];
    const verbose = new StatusTextMonitor(
      mockSim({ getStatusText: (out) => out.push('Rate = 30.0') }),
      100,
      100,
      true,
      { writeTextFile: (_path, text) => storing.push({ text }) },
    );
    verbose.step(1);
    expect(storing[0]!.text).toBe('Rate = 30.0\n');

    // The store frequency is what gets passed to the simulation (native passes frequencyStore).
    let seenFrequency = -1;
    const recorder = new StatusTextMonitor(
      mockSim({
        getStatusText: (_out, frequency) => {
          seenFrequency = frequency;
        },
      }),
      1,
      7,
      false,
      { writeTextFile: () => {} },
    );
    recorder.step(1);
    expect(seenFrequency).toBe(7);

    expect(statFilePath(1234567)).toBe('run/stats/stat.1234567');
    expect(statusFileBody(['a', 'Rate b', 'c'], false)).toBe('a\nc\n');
    expect(statusFileBody(['a', 'Rate b', 'c'], true)).toBe('a\nRate b\nc\n');
  });

  it('Chart monitors emit native-shaped curve values on the right steps', () => {
    const curves: [number, number][] = [];
    // Distinct counters per birth type, so the test also pins *which* counter is read:
    // ABT__CREATED 0 -> 7, ABT__BORN 1 -> 3, ABT__BORN_VIRTUAL 2 -> 1.
    const sim = mockSim({
      getNumBorn: (type) => [7, 3, 1][type]!,
      getFitnessStat: (type) => [0.25, 0.5, 0.75][type]!,
      getFoodEnergyStat: (type, scope) => (scope === 0 ? 30 : scope === 1 ? 10 : 20) + type,
      GetNumDomains: () => 1,
      getNumAgents: () => 25,
    });

    const birth = new BirthRateMonitor(sim);
    birth.curveUpdated.connect((curve, value) => curves.push([curve, value]));
    expect(birth.getId()).toBe('birthrate');
    expect(birth.getName()).toBe('Birth Rate');
    expect(birth.getCurveDefs()).toEqual([{ id: 0, range: [0, 1], color: [-1, -1, -1] }]);

    birth.step(1);
    // Not lockstep and both weights zero -> ABT__BORN: float(3) / float(3 + 7).
    expect(curves).toEqual([[0, f(3 / 10)]]);

    // Lockstep (or a non-zero fitness weight) switches the numerator to ABT__BORN_VIRTUAL.
    const lockstepCurves: [number, number][] = [];
    const lockstep = new BirthRateMonitor(mockSim({ getNumBorn: (type) => [7, 3, 1][type]!, isLockstep: () => true }));
    lockstep.curveUpdated.connect((curve, value) => lockstepCurves.push([curve, value]));
    lockstep.step(1);
    expect(lockstepCurves).toEqual([[0, f(1 / 8)]]);

    const weighted = new BirthRateMonitor(
      mockSim({ getNumBorn: (type) => [7, 3, 1][type]!, getFitnessWeight: () => 0.5 }),
    );
    const weightedCurves: [number, number][] = [];
    weighted.curveUpdated.connect((curve, value) => weightedCurves.push([curve, value]));
    weighted.step(1);
    expect(weightedCurves).toEqual([[0, f(1 / 8)]]);

    // Unchanged counters emit nothing (the chart is left alone).
    curves.length = 0;
    birth.step(2);
    expect(curves).toEqual([]);

    curves.length = 0;
    const fitness = new FitnessMonitor(sim);
    fitness.curveUpdated.connect((curve, value) => curves.push([curve, value]));
    expect(fitness.getCurveDefs().map((c) => c.color)).toEqual([
      [1, 1, 1],
      [1, f(0.3), 0],
      [0, 1, 1],
    ]);
    fitness.step(1);
    expect(curves).toEqual([
      [0, 0.25],
      [1, 0.5],
      [2, 0.75],
    ]);

    curves.length = 0;
    const food = new FoodEnergyMonitor(sim);
    food.curveUpdated.connect((curve, value) => curves.push([curve, value]));
    food.step(1);
    // native `(in - out) / (in + out)` in float arithmetic, per scope; the mock gives
    // in = base + 0, out = base + 1 for base = 30 (STEP), 10 (TOTAL), 20 (AVERAGE).
    const ratio = (inValue: number, outValue: number) => f(f(inValue - outValue) / f(inValue + outValue));
    expect(curves).toEqual([
      [0, ratio(30, 31)],
      [1, ratio(10, 11)],
      [2, ratio(20, 21)],
    ]);

    curves.length = 0;
    const population = new PopulationMonitor(sim);
    population.curveUpdated.connect((curve, value) => curves.push([curve, value]));
    expect(population.getCurveDefs().length).toBe(1);
    population.step(1);
    expect(curves).toEqual([[0, 25]]);
  });

  it('PopulationMonitor: one curve per domain plus the total, and the palette check', () => {
    const sim = mockSim({ GetNumDomains: () => 3, GetMaxAgents: () => 25 });
    const population = new PopulationMonitor(sim);

    expect(population.getCurveDefs().length).toBe(4);
    expect(population.getCurveDefs()[0]!.range).toEqual([0, 25]);

    const curves: [number, number][] = [];
    population.curveUpdated.connect((curve, value) => curves.push([curve, value]));
    population.step(1);
    expect(curves.map((c) => c[0])).toEqual([0, 1, 2, 3]);

    // Native `assert( ncolors >= npops )` — aborts with assertions on; the port throws.
    expect(() => new PopulationMonitor(mockSim({ GetNumDomains: () => 7 }))).toThrow(/colours/);
  });

  it('BrainMonitor and PovMonitor: id/frequency/type, and the POV renderer passthrough', () => {
    const renderer = { marker: true };
    const sim = mockSim({ GetAgentPovRenderer: () => renderer });
    const tracker = new AgentTracker('Fittest', createFitnessParms(1));

    const brain = new BrainMonitor(sim, 10, tracker);
    expect(brain.getType()).toBe(MonitorType.BRAIN);
    expect(brain.getId()).toBe('brainmonitor');
    expect(brain.getTracker()).toBe(tracker);
    expect(brain.getTitle()).toBe('Brain Monitor');

    let updates = 0;
    brain.update.connect(() => updates++);
    brain.step(9);
    expect(updates).toBe(0);
    brain.step(10);
    expect(updates).toBe(1);

    const pov = new PovMonitor(sim);
    expect(pov.getType()).toBe(MonitorType.POV);
    expect(pov.getId()).toBe('pov');
    expect(pov.getRenderer()).toBe(renderer);
    pov.step(1); // noop
  });

  it('FarmMonitor: env presence (not truthiness), metadata matching, command string', () => {
    const commands: string[] = [];
    const runner: FarmRunner = { run: (command) => (commands.push(command), 0) };

    expect(FarmMonitor.isFarmEnv({ isSet: () => false })).toBe(false);
    expect(FarmMonitor.isFarmEnv({ isSet: (name) => name === 'PWFARM_STATUS' })).toBe(true);

    const metadata: CppPropertyMetadata[] = [
      { name: 'Step', toString: () => '42' },
      { name: 'AgentCount', toString: () => '25' },
    ];
    const monitor = new FarmMonitor(
      mockSim(),
      100,
      [
        { name: 'Step', title: 'step', metadata: null },
        { name: 'Missing', title: 'missing', metadata: null },
        { name: 'AgentCount', title: 'agents', metadata: null },
      ],
      { getMetadata: () => metadata },
      runner,
    );

    expect(monitor.getProperties().map((p) => p.metadata?.name)).toEqual([
      'Step',
      undefined,
      'AgentCount',
    ]);

    monitor.step(1);
    expect(commands).toEqual([`bash -c 'PWFARM_STATUS Polyworld "[step=42 agents=25]"'`]);

    monitor.step(50);
    expect(commands.length).toBe(1);
    monitor.step(100);
    expect(commands.length).toBe(2);

    const failing = new FarmMonitor(
      mockSim(),
      100,
      [],
      { getMetadata: () => [] },
      { run: () => 1 },
    );
    expect(() => failing.step(1)).not.toThrow();
  });
});

/** Minimal harness: the two private halves of `MonitorManager::step()` without a document. */
class ManagerHarness {
  private readonly trackers: AgentTracker[] = [];
  private readonly sim: MonitorSim;

  constructor(sim: MonitorSim) {
    this.sim = sim;
  }

  addTracker(tracker: AgentTracker): AgentTracker {
    this.trackers.push(tracker);
    return tracker;
  }

  stepTrackers(): void {
    for (const tracker of this.trackers) {
      const parms = tracker.getParms();
      const target = tracker.getTarget();

      if (target === null || !parms.trackTilDeath) {
        switch (parms.mode) {
          case TrackerMode.FITNESS:
            tracker.setTarget(this.sim.getCurrentFittest(parms.rank));
            break;
          case TrackerMode.NUMBER:
            tracker.setTarget(this.sim.getAgentByNumber(parms.number));
            break;
        }
      }
    }
  }
}

// --------------------------------------------------------------------------------------
// band 3: golden parity
// --------------------------------------------------------------------------------------

/** Do the two documents the recorded term runs used: `etc/monitors.mfs` + `etc/term.mf`. */
function termMonitorDocument(): PropertyNode {
  return loadMonitorDocument(
    (path) => readFileSync(join(NATIVE_ROOT, path), 'latin1'),
    './etc/term.mf',
  );
}

/** The `StatusTextStore` used everywhere in this band: real files, latin-1, parent dirs. */
function nodeStore(root: string): StatusTextStore {
  return {
    writeTextFile: (path, text) => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'latin1');
    },
  };
}

/** The steps a run of `maxSteps` steps writes: native `(t == 1) || (t % frequencyStore == 0)`. */
function expectedStatSteps(maxSteps: number, frequencyStore: number): number[] {
  const steps: number[] = [];
  for (let t = 1; t <= maxSteps; t++) {
    if (t === 1 || t % frequencyStore === 0) steps.push(t);
  }
  return steps;
}

/** Drive the ported monitor over 1..maxSteps with the golden's own status lines as the sim. */
function regenerateStatTree(
  scenario: string,
  root: string,
  monitorLines: (step: number) => string[],
): { written: string[]; steps: number[] } {
  // t_37bf7212: this writes `run/stats/stat.<t>` under `root`; the root is never a golden path.
  assertUsableStagingRoot(root, `regenerateStatTree(${scenario})`);
  const doc = termMonitorDocument();
  const cfg = createConfig(doc);
  const used: number[] = [];
  const written: string[] = [];
  const store = nodeStore(root);

  let currentStep = 0;
  const sim = mockSim({
    getStep: () => currentStep,
    getStatusText: (out) => {
      for (const line of monitorLines(currentStep)) out.push(line);
    },
  });

  const monitor = new StatusTextMonitor(
    sim,
    cfg.at('StatusText').getInt('FrequencyDisplay'),
    cfg.at('StatusText').getInt('FrequencyStore'),
    cfg.at('StatusText').getBool('StorePerformance'),
    {
      writeTextFile: (path, text) => {
        written.push(path);
        used.push(currentStep);
        store.writeTextFile(path, text);
      },
    },
  );

  // The terminal UI connects a receiver; do the same so both gating branches are exercised.
  monitor.update.connect(() => {});

  const maxSteps = Number(readFileSync(join(ORACLE_ROOT, scenario, 'run', 'endStep.txt'), 'utf8').trim());
  for (let t = 1; t <= maxSteps; t++) {
    currentStep = t;
    monitor.step(t);
  }

  expect(used).toEqual(stepsForScenario(scenario, maxSteps));
  expect(written.length).toBeGreaterThan(0);

  return { written, steps: used };
}

function stepsForScenario(scenario: string, maxSteps: number): number[] {
  const store = createConfig(termMonitorDocument()).at('StatusText').getInt('FrequencyStore');
  return expectedStatSteps(maxSteps, store);
}

/** Golden `run/stats/stat.N` lines, as byte-preserving strings. */
function goldenStatLines(scenario: string, step: number): string[] {
  const path = join(ORACLE_ROOT, scenario, 'run', 'stats', `stat.${step}`);
  if (!existsSync(path)) return [];
  const text = readLatin1(path);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** `movie.pmv` header + meta entries, read the way the native `PwMovieReader` does. */
function readMovieHeader(path: string): {
  hostVersion: number;
  frameCount: number;
  metaEntries: { type: number; frame: number; value: number[] }[];
} {
  const buf = readFileSync(path);
  const hostVersion = buf.readUInt32BE(0);
  const frameCount = buf.readUInt32LE(8);
  const metaEntryCount = buf.readUInt32LE(12);
  const offsetMetaEntries = Number(buf.readBigUInt64LE(16));

  const entries: { type: number; frame: number; value: number[] }[] = [];
  let at = offsetMetaEntries;
  for (let i = 0; i < metaEntryCount; i++) {
    const type = buf.readUInt8(at);
    const frame = buf.readUInt32LE(at + 1);
    const sizeBody = buf.readUInt32LE(at + 5);
    const body = buf.subarray(at + 9, at + 9 + sizeBody);
    const value: number[] =
      type === 0
        ? [body.readUInt32LE(0), body.readUInt32LE(4)]
        : type === 1
          ? [body.readUInt32LE(0)]
          : [Number(body.readBigUInt64LE(0))];
    entries.push({ type, frame, value });
    at += 9 + sizeBody;
  }

  return { hostVersion, frameCount, metaEntries: entries };
}

describe('L14 band 3 — golden parity for run/stats/** and the movie schedule', () => {
  it.skipIf(!haveMicrotestGolden)(
    'the recorded scenarios have exactly the stat files the ported gating predicts',
    () => {
      for (const scenario of ['microtest_voff', 'minitest_voff']) {
        const runDir = join(ORACLE_ROOT, scenario, 'run');
        if (!existsSync(runDir)) continue;

        const maxSteps = Number(readLatin1(join(runDir, 'endStep.txt')).trim());
        const expected = expectedStatSteps(maxSteps, 100).map((t) => `stat.${t}`);
        const actual = readdirSync(join(runDir, 'stats')).sort();

        expect(actual, scenario).toEqual(expected.sort());
      }
    },
  );

  it.skipIf(!haveMicrotestGolden)(
    'the ported monitor rewrites every golden stat file byte for byte',
    () => {
      for (const scenario of ['microtest_voff', 'minitest_voff']) {
        if (!existsSync(join(ORACLE_ROOT, scenario, 'run'))) continue;

        const root = join(work, `stats-${scenario}`);
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });

        const { written } = regenerateStatTree(scenario, root, (step) =>
          goldenStatLines(scenario, step),
        );

        const goldenDir = join(ORACLE_ROOT, scenario, 'run', 'stats');
        const goldenFiles = readdirSync(goldenDir).sort();
        expect(written.map((p) => p.replace('run/stats/', '')).sort(), scenario).toEqual(
          goldenFiles,
        );

        for (const file of goldenFiles) {
          const mine = readFileSync(join(root, 'run', 'stats', file));
          const golden = readFileSync(join(goldenDir, file));
          expect(mine.equals(golden), `${scenario}/${file} bytes`).toBe(true);
        }
      }
    },
  );

  it.skipIf(!haveMicrotestGolden)(
    'the golden movie frame schedule equals MovieSettings::shouldRecord over 1..MaxSteps',
    () => {
      for (const scenario of ['microtest_voff', 'minitest_voff']) {
        const moviePath = join(ORACLE_ROOT, scenario, 'run', 'movie.pmv');
        const normalizedPath = join(ORACLE_ROOT, scenario, 'run', 'normalized.wf');
        if (!existsSync(moviePath) || !existsSync(normalizedPath)) continue;

        const header = readMovieHeader(moviePath);
        const maxSteps = Number(
          /^\s*MaxSteps\s+(\d+)/m.exec(readLatin1(normalizedPath))?.[1] ?? '0',
        );
        expect(maxSteps, scenario).toBeGreaterThan(0);

        // etc/term.mf resolves MainScene -> RecordMovie true, SampleFrequency/SampleDuration 1.
        const scene = createConfig(termMonitorDocument()).at('MainScene');
        const settings = movieSettings(
          scene.at('Movie').getBool('Record'),
          `run/${scene.at('Movie').getString('Path')}`,
          scene.at('Movie').getInt('SampleFrequency'),
          scene.at('Movie').getInt('SampleDuration'),
        );
        expect(settings.moviePath, scenario).toBe('run/movie.pmv');

        let predictedFrames = 0;
        let previousTimestep = 0;
        const predictedTimestepEntries: number[] = [];
        for (let t = 1; t <= maxSteps; t++) {
          if (!shouldRecordAt(settings, t)) continue;

          predictedFrames++;
          if (t !== previousTimestep + 1 || predictedFrames === 1) {
            predictedTimestepEntries.push(t);
          }
          previousTimestep = t;
        }

        expect(header.frameCount, `${scenario} frameCount`).toBe(predictedFrames);

        // The writer emits a TIMESTEP meta entry whenever the timestep is not the previous
        // frame's plus one (and always for frame 1); the recorded schedule must need exactly
        // the entries the golden carries.
        expect(
          header.metaEntries.filter((e) => e.type === 1).map((e) => e.value[0]),
          `${scenario} TIMESTEP entries`,
        ).toEqual(predictedTimestepEntries);

        // The DIMENSIONS entry is the scene's buffer size, resolved from the real monitor docs.
        const dimensions = header.metaEntries.find((e) => e.type === 0);
        expect(dimensions?.value, `${scenario} dimensions`).toEqual([
          scene.at('Buffer').getInt('Width'),
          scene.at('Buffer').getInt('Height'),
        ]);
      }
    },
  );

  it.skipIf(!haveMicrotestGolden)(
    'oracle/run_parity.sh passes over a candidate tree whose run/stats/** this lane wrote',
    () => {
      for (const scenario of ['microtest_voff', 'minitest_voff']) {
        if (!existsSync(join(ORACLE_ROOT, scenario, 'run', 'manifest.sha256'))) continue;

        const candidate = join(work, 'candidate', scenario);
        rmSync(candidate, { recursive: true, force: true });
        mkdirSync(candidate, { recursive: true });

        // A copy of the golden with the stats removed: everything else stays byte-identical, so
        // any parity difference must come from what this lane writes.
        //
        // t_37bf7212: a *real* copy. `cpSync(GOLDEN/run, candidate/run)` preserves symlinks, and
        // in a lane's worktree the golden's `run/` is one — the "copy" would then be a link farm
        // into the canonical oracle and the `rmSync(candidate/run/stats)` below would delete the
        // golden's stats. `stageGoldenCopy` dereferences and proves the result holds no symlinks.
        stageGoldenCopy(
          join(ORACLE_ROOT, scenario, 'run'),
          candidate,
          'run',
          `monitor.test/candidate-${scenario}`,
        );
        rmSync(join(candidate, 'run', 'stats'), { recursive: true, force: true });

        regenerateStatTree(scenario, candidate, (step) => goldenStatLines(scenario, step));

        const res = spawnSync(
          'bash',
          [join(WEB_ROOT, 'oracle', 'run_parity.sh'), scenario, '--candidate', candidate],
          { cwd: WEB_ROOT, encoding: 'utf8', timeout: 240_000 },
        );

        const tail = res.stdout.trim().split('\n').slice(-3).join('\n');
        console.log(tail);
        expect(res.stderr, scenario).not.toMatch(/error/i);
        expect(res.stdout, scenario).toMatch(/match \d+\/\d+ {2}differing=0 {2}missing=0 {2}extra=0/);
        expect(res.stdout, scenario).toMatch(/parity: PASS/);
        expect(res.status, scenario).toBe(0);
      }
    },
    300_000,
  );

  it.skipIf(!haveNative)(
    'MonitorManager selects exactly the native monitor set for the recorded term run',
    () => {
      resetGlobals();
      globals.worldsize = f(100.0);

      const created: {
        cameraProperties: typeof DEFAULT_CAMERA_PROPERTIES;
        width: number;
        height: number;
      }[] = [];
      const movieFiles: string[] = [];
      const storedPaths: string[] = [];
      const renderers: ReturnType<typeof mockRenderer>[] = [];

      const manager = new MonitorManager(mockSim(), termMonitorDocument(), {
        createSceneRenderer: (_stage, props, width, height) => {
          created.push({ cameraProperties: props, width, height });
          const renderer = mockRenderer();
          renderers.push(renderer);
          return renderer;
        },
        createMovieWriter: (path) => {
          movieFiles.push(path);
          return { writeFrame: () => {}, close: () => {} };
        },
        statusTextStore: { writeTextFile: (path) => storedPaths.push(path) },
        cppProperties: { getMetadata: () => [] },
        farmRunner: { run: () => 0 },
        farmEnvironment: { isSet: () => false },
      });

      // etc/term.mf: charts/brain/POV off (term defaults), Farm on but not a farm environment,
      // StatusText on, and only MainScene enabled -> exactly two monitors, in native's order.
      expect(manager.getMonitors().map((m) => m.getType())).toEqual([
        MonitorType.STATUS_TEXT,
        MonitorType.SCENE,
      ]);
      expect(manager.getMonitors().map((m) => m.getId())).toEqual(['textstatus', 'Main']);
      expect(manager.getMonitors().map((m) => m.getName())).toEqual(['Text Status', 'Main']);
      // Native `Monitor( SCENE, sim, id, name, name )` — the scene monitor's title is its name.
      expect(manager.getMonitors().map((m) => m.getTitle())).toEqual(['Text Status', 'Main']);

      // The two agent trackers from the document's defaults, with the default TrackMode Agent.
      expect(manager.getAgentTrackers().map((t) => t.getName())).toEqual(['Fittest', 'First']);
      expect(manager.getAgentTrackers()[0]!.getParms()).toEqual({
        mode: TrackerMode.FITNESS,
        trackTilDeath: true,
        rank: 1,
      });
      expect(manager.getAgentTrackers()[1]!.getParms()).toEqual({
        mode: TrackerMode.NUMBER,
        trackTilDeath: true,
        number: 1,
      });

      expect(created).toEqual([
        {
          cameraProperties: { color: { r: f(0.3), g: f(0.3), b: f(0.3), a: 1 }, fov: 90 },
          width: 640,
          height: 480,
        },
      ]);
      expect(movieFiles).toEqual(['run/movie.pmv']);

      // The scene's camera controller is the "Main" Rotate entry, scaled by worldsize.
      const scene = manager.getMonitors()[1] as SceneMonitor;
      expect(scene.getCameraController().getMode()).toBe(CameraControllerMode.ROTATE);
      expect(scene.getMovieController()).not.toBeNull();

      const statusText = manager.getMonitors()[0] as StatusTextMonitor;
      manager.step(); // simulation.getStep() is 1 in the mock
      expect(statusText.getStatusText()).toEqual([]);

      // The status monitor stored through the injected store, at the frozen path.
      expect(storedPaths).toEqual(['run/stats/stat.1']);

      // ... and the scene monitor drove the camera and the renderer.
      expect(renderers[0]!.renderedCount()).toBe(1);
    },
  );

  it.skipIf(!haveNative)(
    'MonitorManager with the gui defaults builds every monitor the native gui run builds',
    () => {
      resetGlobals();
      globals.worldsize = f(100.0);

      const doc = loadMonitorDocument(
        (path) => readFileSync(join(NATIVE_ROOT, path), 'latin1'),
        './etc/gui.mf',
      );

      const movieFiles: string[] = [];
      const manager = new MonitorManager(mockSim(), doc, {
        createSceneRenderer: () => mockRenderer(),
        createMovieWriter: (path) => {
          movieFiles.push(path);
          return { writeFrame: () => {}, close: () => {} };
        },
        statusTextStore: { writeTextFile: () => {} },
        cppProperties: { getMetadata: () => [] },
        farmRunner: { run: () => 0 },
        farmEnvironment: { isSet: () => false },
      });

      expect(manager.getMonitors().map((m) => m.getType())).toEqual([
        MonitorType.CHART,
        MonitorType.CHART,
        MonitorType.CHART,
        MonitorType.CHART,
        MonitorType.BRAIN,
        MonitorType.POV,
        MonitorType.STATUS_TEXT,
        MonitorType.SCENE,
        MonitorType.SCENE,
        MonitorType.SCENE,
      ]);
      expect(manager.getMonitors().map((m) => m.getId())).toEqual([
        'birthrate',
        'fitness',
        'foodenergy',
        'population',
        'brainmonitor',
        'pov',
        'textstatus',
        'Main',
        'Overhead',
        'SinglePOV',
      ]);

      // Only MainScene records (the other two default to Record False).
      expect(movieFiles).toEqual(['run/movie.pmv']);

      const overhead = manager.getMonitors()[8] as SceneMonitor;
      expect(overhead.getCameraController().getMode()).toBe(CameraControllerMode.AGENT_TRACKING);
      expect(overhead.getCameraController().getAgentTracker()?.getName()).toBe('Fittest');

      const brain = manager.getMonitors()[4] as BrainMonitor;
      expect(brain.getTracker()?.getName()).toBe('Fittest');
    },
  );

  it.skipIf(!haveNative)(
    'the camera properties/colour helper matches the native Color( Property ) conversion',
    () => {
      // native graphics.cc:17-20 -- R/G/B read, alpha 1.0.
      expect(cameraProperties({ r: 0.1, g: 0.2, b: 0.3 }, 75)).toEqual({
        color: { r: f(0.1), g: f(0.2), b: f(0.3), a: 1 },
        fov: 75,
      });
      expect(DEFAULT_CAMERA_PROPERTIES).toEqual({
        color: { r: f(0.3), g: f(0.3), b: f(0.3), a: 1 },
        fov: 90,
      });
    },
  );
});

/** A `SceneRendererSurface` stand-in that counts renders and fires `renderComplete`. */
function mockRenderer(): SceneRendererSurface & { renderedCount(): number } {
  const camera = mockCamera();
  let renders = 0;
  const signal = new Signal<[]>();

  const renderer = {
    getCamera: () => camera,
    getBufferWidth: () => 640,
    getBufferHeight: () => 480,
    renderComplete: signal,
    createMovieRecorder: () => ({ recordFrame: () => {} }),
    render: () => {
      renders++;
      signal.emit();
    },
    renderedCount: () => renders,
  };

  return renderer;
}
