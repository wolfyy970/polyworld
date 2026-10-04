/**
 * Lane L18 (browser wiring) — the model world: lane L11's `Simulation` behind `SimulationLike`.
 *
 * This is the module `app.ts::bootedSimulation()` calls, and the only place in the shell that
 * knows the simulation is a real one. It does three things and nothing else:
 *
 *   1. it builds lane L11's `TSimulation` from the boot the page already ran — the applied
 *      document, the worldfile/schema paths and the four worldfile texts `worldBoot.ts`
 *      reproduced (`original.wf`, `original.wfs`, `converted.wf`, `normalized.wf`);
 *   2. it gives the run a `RecordFileSystem` that is *not* `node:fs` — the page's in-memory
 *      implementation (`browserFiles.ts`), which is why the same `Simulation` class runs in a
 *      browser tab and in the parity harness with no environment switch inside the model;
 *   3. it projects the live roster into `SimulationAgent`s, in native iteration order, reading
 *      each number through the agent's own accessor (`x()`, `z()`, `yaw()`, `radius()`,
 *      `color()` — `agent.cc:1712-1910`).
 *
 * PORT-NOTE (L18/roster): the roster is the native `gXSortedObjects` list
 * (`environment/objectXSortedList.ts`), walked with native's own cursor discipline
 * (`reset()` + `next()`, the same walk `agents.ts` and the recorders use) and with the cursor
 * saved and restored around the walk, because the native scene renderer reads the very same list
 * between steps. Agents are identified with `instanceof Agent` — never by a duck-typed field.
 * The projection is memoised on `fStep`, so a paused page allocates nothing per frame and a
 * running one allocates one array per step.
 *
 * PORT-NOTE (L18/agent-colour): the body colour on screen is the model's own
 * (`agent::color()`, written per step by `agent::UpdateColor()` from the body-channel nerves —
 * `agent.cc:1294-1335`). The lane's preview stand-in carried a palette *slot* instead because
 * there were no nerves to read; the seam now carries the three native floats and
 * `scene/agents.ts` writes them into the instance colour buffer.
 *
 * PORT-NOTE (L18/reset-is-a-reload): native has neither a rewind nor a re-spawn: a run's state is a
 * function of the worldfile and `InitSeed` (`Simulation.cc:3899` → `srand48` at step 18 of the
 * constructor; `PositionSeed` is read and unused, PORT-NOTE(sim/position-seed-unused)), and the
 * model's own tables are process-wide, so a *second* simulation cannot be constructed in the same
 * process (measured: `sim: duplicate FoodType name 'Standard' (native errs)`). The shell therefore
 * treats "a new run" as what native treats it as — a new process: it reloads the page with native's
 * `--InitSeed` set to the next seed (`app.ts::resetRun`), and this factory is only ever asked for
 * the world of the boot it is handed. No rewind is faked.
 *
 * PORT-NOTE (L18/monitors-in-the-page): native's app constructs a `MonitorManager` and hangs it off
 * the simulation's `stepEnding` signal (`main.cc:160` + `SimulationController.cc:26`), and that is
 * what writes `run/stats/stat.<timestep>` (native `Monitor.cc:299-320`) — the only golden artifact
 * the page used to be missing. The page now does the same from the monitor documents it carries in
 * its own bundle (`sim/bundledMonitors.ts`: verbatim copies of native's `etc/monitors.mfs` +
 * `etc/term.mf`, the `--ui` the recorded scenarios ran with) through lane L12's own file seam
 * (`sim/browserFiles.ts::recordFileStatusTextStore` — native's `makeParentDir` + `fopen( …, "w" )` +
 * one `fprintf( "%s\n" )` per line). The renderer and the movie writer are still the graphics lanes'
 * and arrive as the same null factories lane L11's node runner mounts
 * (PORT-NOTE(sim/null-scene-renderer)): the scene *selection*, the camera controllers and the status
 * text are real, no pixel is drawn, and `run/movie.pmv` — free at every tier since t_588c28e1 — is
 * the one artifact a page run does not produce. Reported, never hidden: `runTreeSuite.ts` pins the
 * absent set, so a lost artifact cannot hide in a count.
 *
 * The mount is otherwise exactly native's: one manager, built once from a document built once, and
 * `stepEnding` firing `monitor.step()` at step 21 of every `Step()` (`simulation.ts`), so
 * `run/stats/**` lands in the same sink as every other artifact the run writes.
 */

import { Agent, agentConfig, NoseColor } from '../../model/agent';
import { Barrier, Brick, Food, gXSortedObjects } from '../../model/environment';
import { MonitorManager, processEnvironment } from '../../model/monitor';
import { Simulation } from '../../model/sim/simulation';
import {
  emptyCppProperties,
  monitorSimView,
  nullMovieWriter,
  nullSceneRenderer,
  unavailableFarmRunner,
} from '../../model/sim/bindings';
import { ConcreteFileType } from '../../model/types/datalib';
import type { RecordFileSystem } from '../../model/logs/seams';
import { MemoryRecordFileSystem, recordFileStatusTextStore } from './browserFiles';
import { bundledMonitorDocument } from './bundledMonitors';
import { bootWorld, ARTIFACT_KEYS, type BootedWorld } from './worldBoot';
import type {
  SimulationAgent,
  SimulationBarrier,
  SimulationBox,
  SimulationLike,
  SimulationOptions,
} from './simSeam';

/** Native `MaxAgents` as the renderer needs it: the run's own population ceiling. */
interface SimulationInternals {
  readonly fEnded: boolean;
  readonly fMaxSteps: number;
}

export interface RunFileReport {
  /** How many files the run wrote into the shell's sink. */
  readonly count: number;
  /** Their total size in bytes. */
  readonly bytes: number;
}

export interface ModelWorld extends SimulationLike {
  /** The worldfile the run booted. */
  readonly boot: BootedWorld;
  /** The sink the run writes into — the page's in-memory file system (`browserFiles.ts`). */
  readonly runFileSystem: MemoryRecordFileSystem | null;
  /** What the sink holds, for the panel; `null` when the host supplied its own sink. */
  runFiles(): RunFileReport | null;
}

/** The shell's factory (`SimulationFactory`). */
export function createModelWorld(options: SimulationOptions): ModelWorld {
  return new ModelWorldImpl(options);
}

class ModelWorldImpl implements ModelWorld {
  private readonly booted: BootedWorld;
  private readonly injectedFs: RecordFileSystem | undefined;
  private readonly stepSeconds: number;
  private readonly sim: Simulation;
  private agentCache: SimulationAgent[] = [];
  private foodCache: SimulationBox[] = [];
  private brickCache: SimulationBox[] = [];
  private barrierCache: SimulationBarrier[] = [];
  private cacheStep = -1;

  constructor(options: SimulationOptions) {
    this.booted = options.boot;
    this.stepSeconds = options.stepSeconds;
    this.injectedFs = options.fs;
    this.constructed = {
      fs: options.fs ?? new MemoryRecordFileSystem(recordFileTypeOf(options.boot)),
    };
    this.sim = this.construct(this.booted);
  }

  // ----------------------------------------------------------------------- //
  // SimulationLike
  // ----------------------------------------------------------------------- //

  get agents(): readonly SimulationAgent[] {
    this.refresh();
    return this.agentCache;
  }

  /** Native `food` objects (`gXSortedObjects` walk), same memo as the roster. */
  get food(): readonly SimulationBox[] {
    this.refresh();
    return this.foodCache;
  }

  /** Native `brick` objects (`gXSortedObjects` walk), same memo as the roster. */
  get bricks(): readonly SimulationBox[] {
    this.refresh();
    return this.brickCache;
  }

  /** Native `barrier::gBarriers` (`absolutePosition()` + `gBarrierHeight`), same memo. */
  get barriers(): readonly SimulationBarrier[] {
    this.refresh();
    return this.barrierCache;
  }

  /**
   * One projection per step, shared by every getter: the four arrays describe the *same* model
   * step (`fStep`), so a renderer that reads `agents`, `food`, `bricks` and `barriers` within one
   * frame cannot see a mixed state. A paused page allocates nothing; a running one allocates the
   * arrays for that step — the same contract the roster has had since L18b.
   */
  private refresh(): void {
    const step = this.sim.getStepNumber();
    if (step === this.cacheStep) return;
    this.agentCache = projectRoster();
    const boxes = projectBoxes();
    this.foodCache = boxes.food;
    this.brickCache = boxes.bricks;
    this.barrierCache = projectBarriers();
    this.cacheStep = step;
  }

  /** Native `MaxAgents` (the run's own population ceiling, `Simulation.fMaxNumAgents`). */
  get agentCapacity(): number {
    return Math.max(1, this.sim.maxAgents());
  }

  get stepIndex(): number {
    return this.sim.getStepNumber();
  }

  /** Simulated seconds at the shell's fixed rate. The model's clock is the step counter. */
  get simSeconds(): number {
    return this.sim.getStepNumber() * this.stepSeconds;
  }

  /** Native `InitSeed` — the run's own seed (`Simulation.cc:3899`). */
  get seed(): number {
    return this.booted.config.getInt('InitSeed');
  }

  /** Native `MaxSteps`; `0` means "no budget" (`endStep.txt`/`endReason.txt` say how it ended). */
  get maxSteps(): number {
    return (this.sim as unknown as SimulationInternals).fMaxSteps;
  }

  readonly flavour = 'model' as const;

  get ended(): boolean {
    return (this.sim as unknown as SimulationInternals).fEnded;
  }

  /**
   * What the shell wants the viewer to know. The model has no "preview world" caveat any more —
   * the only thing left to say is that the run is over, which native also stops at.
   */
  get notice(): string | null {
    if (!this.ended) return null;
    const reason = this.readEndReason();
    const at = `step ${this.sim.getStepNumber()}`;
    return reason === null
      ? `run ended at ${at} — the native end phase has run; New run starts a fresh one.`
      : `run ended at ${at} (${reason}) — the native end phase has run; New run starts a fresh one.`;
  }

  step(): void {
    this.sim.step();
  }

  dispose(): void {
    this.sim.dispose();
    this.cacheStep = -1;
    this.agentCache = [];
  }

  /** Order-sensitive, millimetre-quantised digest (presentation only — never a golden). */
  stateDigest(): number {
    let hash = 0x811c9dc5;
    const feed = (value: number, quantise: number): void => {
      const scaled = Math.round(value * quantise);
      hash ^= scaled & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (scaled >> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (scaled >> 16) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    };
    for (const agent of this.agents) {
      feed(agent.x, 1000);
      feed(agent.z, 1000);
      feed(agent.yaw, 100);
      feed(agent.size, 1000);
      hash ^= agent.alive ? 0x2c : 0x0d;
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  // ----------------------------------------------------------------------- //
  // the lane's own surface
  // ----------------------------------------------------------------------- //

  get boot(): BootedWorld {
    return this.booted;
  }

  get runFileSystem(): MemoryRecordFileSystem | null {
    return this.injectedFs === undefined
      ? (this.constructed?.fs as MemoryRecordFileSystem | undefined) ?? null
      : null;
  }

  runFiles(): RunFileReport | null {
    const fs = this.runFileSystem;
    return fs === null ? null : { count: fs.count(), bytes: fs.size() };
  }

  // ----------------------------------------------------------------------- //

  /** The sink this world writes through: the page's in-memory run tree, built exactly once. */
  private readonly constructed: { fs: RecordFileSystem };

  private fs(): RecordFileSystem {
    return this.constructed.fs;
  }

  private construct(boot: BootedWorld): Simulation {
    const fs = this.constructed.fs;

    const originalWorldfileText = boot.artifacts.get(ARTIFACT_KEYS.originalWorldfile);
    const originalSchemaText = boot.artifacts.get(ARTIFACT_KEYS.originalSchema);
    if (originalWorldfileText === undefined || originalSchemaText === undefined) {
      throw new Error('modelWorld: the boot did not carry run/original.wf + run/original.wfs');
    }

    const sim = new Simulation({
      doc: boot.config,
      worldfilePath: boot.sources.worldfilePath,
      schemaPath: boot.sources.schemaPath,
      convertedWorldfileText: boot.converted,
      normalizedWorldfileText: boot.normalized,
      originalWorldfileText,
      originalSchemaText,
      fs,
      // Native renames an existing `run/` aside; the shell's sink is per-world and already empty,
      // so the rename dance would only produce `run.1` noise in the report.
      keepRunDirectory: true,
    });

    this.mountMonitors(sim, fs);
    return sim;
  }

  /**
   * Native `main.cc:160` + `SimulationController.cc:26`:
   *
   * ```
   *   MonitorManager *monitorManager = new MonitorManager( simulation, monitorPath );
   *   simulation->stepEnding += [=]{ monitorManager->step(); };
   * ```
   *
   * The manager is built **once per world**, from the document built once (the document build runs
   * lane L4's expression interpreter, so it is not a per-step cost), and driven off the same
   * `stepEnding` hook the simulation fires at step 21 of every `Step()` — which is what writes
   * `run/stats/stat.<timestep>` into the run's own sink. See PORT-NOTE (L18/monitors-in-the-page).
   *
   * The two factories are the same nulls lane L11's node runner mounts
   * (PORT-NOTE(sim/null-scene-renderer)): the scene selection, the camera controllers and the status
   * text are the real port; nothing is drawn and no `.pmv` is produced.
   */
  private mountMonitors(sim: Simulation, fs: RecordFileSystem): void {
    const monitor = new MonitorManager(monitorSimView(sim), bundledMonitorDocument(), {
      createSceneRenderer: () => nullSceneRenderer(),
      createMovieWriter: () => nullMovieWriter(),
      statusTextStore: recordFileStatusTextStore(fs),
      cppProperties: emptyCppProperties,
      farmRunner: unavailableFarmRunner,
      farmEnvironment: processEnvironment,
    });
    sim.stepEnding = () => monitor.step();
  }

  private readEndReason(): string | null {
    const fs = this.runFileSystem;
    if (fs === null) return null;
    const text = fs.text('run/endReason.txt');
    return text === null || text === undefined ? null : text.trim();
  }
}

/** `globals::recordFileType` from the document (`CompressFiles`), as native resolves it. */
function recordFileTypeOf(boot: BootedWorld): ConcreteFileType {
  return boot.config.getBool('CompressFiles')
    ? ConcreteFileType.TYPE_GZIP_FILE
    : ConcreteFileType.TYPE_FILE;
}

/** The same boot, with native's `--InitSeed` parameter applied (a different run of the world). */

/**
 * The live roster, in native iteration order.
 *
 * `gXSortedObjects` is a native `gdlist` with a cursor that the simulation itself uses between
 * passes, so the walk resets it, walks it, and puts the cursor back where it found it.
 */
function projectRoster(): SimulationAgent[] {
  const list = gXSortedObjects;
  const saved = list.getcurr();
  const agents: SimulationAgent[] = [];
  list.reset();
  for (;;) {
    const object = list.next();
    if (object === null) break;
    if (!(object instanceof Agent)) continue;
    const agent = object as Agent;
    agents.push({
      x: agent.x(),
      z: agent.z(),
      yaw: agent.yaw(),
      size: agent.radius(),
      // Native `agent::draw()` reads the mesh lengths and the two colours; the renderer draws the
      // real mesh, so it needs them (`agent.cc:1819-1831`).
      lengthX: agent.lengthX(),
      lengthZ: agent.lengthZ(),
      color: agent.color(),
      noseColor: agent.noseColor(),
      noseIsBody: agentConfig.noseColor === NoseColor.NC_BODY,
      alive: agent.alive(),
    });
  }
  list.setcurr(saved);
  return agents;
}

/**
 * The world's food and brick objects, in the same `gXSortedObjects` walk the roster uses (native
 * iterates that one list too), split by class:
 *
 *   - `food` — `environment/food.ts`'s `Food` (`fLength[3]`, `fPosition[3]`, `fColor[3]`)
 *   - `brick` — `environment/brick.ts`'s `Brick` (same fields, cube of `gBrickHeight`)
 *
 * `instanceof` is the discriminator, never a duck-typed field — the same rule the roster uses for
 * `Agent`. The cursor is saved and restored: the model's own passes use it between steps.
 */
function projectBoxes(): { food: SimulationBox[]; bricks: SimulationBox[] } {
  const list = gXSortedObjects;
  const saved = list.getcurr();
  const food: SimulationBox[] = [];
  const bricks: SimulationBox[] = [];
  list.reset();
  for (;;) {
    const object = list.next();
    if (object === null) break;
    if (object instanceof Food) food.push(boxOf(object));
    else if (object instanceof Brick) bricks.push(boxOf(object));
  }
  list.setcurr(saved);
  return { food, bricks };
}

/** One `gboxf` as the renderer needs it: centre, `fLength`, and its own colour. */
function boxOf(box: Food | Brick): SimulationBox {
  return {
    x: box.x(),
    y: box.y(),
    z: box.z(),
    sizeX: box.length[0]!,
    sizeY: box.length[1]!,
    sizeZ: box.length[2]!,
    color: [box.color[0]!, box.color[1]!, box.color[2]!],
  };
}

/**
 * The barrier walls, in native creation order (`barrier::gBarriers`). Read per step, not once at
 * boot, because a `dyn` barrier's `Z2` moves with the population
 * (`growingBarriers_grayBricks.wf` is the recorded example) — the same reason native's renderer
 * walks the live list. `absolutePosition()` is native's ratio-scaled copy.
 */
function projectBarriers(): SimulationBarrier[] {
  const height = Barrier.gBarrierHeight;
  return Barrier.gBarriers.map((barrier) => {
    const position = barrier.absolutePosition();
    return { xa: position.xa, za: position.za, xb: position.xb, zb: position.zb, height };
  });
}
