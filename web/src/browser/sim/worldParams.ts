/**
 * Lane L18 (browser wiring) — the shell's view of the normalized worldfile.
 *
 * The native simulation reads its configuration through `proplib`'s `Config` accessors
 * (`doc.get( "Key" )`), one lane at a time: `agent::processWorldfile`
 * (`src/model/agent/agentConfig.ts`), `GenomeSchema::processWorldfile` (lane L5),
 * `TSimulation` (lane L11), … This file is the *shell's* read list: the subset the browser
 * needs to draw and label a world, read through the same `Config` accessors and nothing
 * else.
 *
 * PORT-NOTE (L18/read-plan): every read is recorded. A key whose value the expression evaluator
 * cannot produce (lane L4's language is what turns `InitAgents MaxAgents` or a barrier's
 * `if/else` arithmetic into a value; a name the interpreter does not know raises, native's
 * `[Python] name '...' is not defined`) is reported as `blocked` with the reason the evaluator
 * gave, and this module **never substitutes a value for one**: the shell surfaces it (fatal
 * panel for a required key, a note in the status panel for a provisional one). That is what
 * keeps a partially-ported worldfile from silently becoming a *different* world.
 *
 * PORT-NOTE (L18/barrier-and-brick-reads): the barrier segments and the brick patches *are* read
 * here, expressions and all. A barrier's `X1 ( 0.3333 if RatioBarrierPositions else … )` is an
 * expression lane L4 evaluates at build time, so `Config.getFloat` returns the number (measured:
 * both recorded worldfiles' two barriers resolve to `(0.3333, -1) … (0.3333, -0.1)` /
 * `(0.6667, -1) … (0.6667, -0.1)` in worldfile ratios), and the ratio scaling
 * (`barrier::updateVertices`) is applied here exactly as `barrier.ts` applies it. A brick
 * worldfile's `BrickPatches` array is read the same way (`BrickPatch::init` geometry +
 * `BrickCount` + the optional `BrickColor` override). Neither read is *required*: a worldfile with
 * no patch declares no bricks (a `note`, not a `blocked` entry), and a segment that cannot be
 * evaluated is reported as a note and not drawn — the scene's own `PORT-NOTE (L18/draw)` says what
 * is on screen. The geometry the shell draws is therefore the worldfile's own, never invented:
 * colours, rectangles and counts here; live positions of the food/brick *objects* come from lane
 * L11's model, exactly as the agent roster does.
 *
 * PORT-NOTE (L18/required-vs-provisional): a `required` key that cannot be read fails the
 * boot loudly (`WorldBootError`). A `provisional` key is one the shell only needs for
 * presentation *today* — `InitAgents` is the one that matters: native's initial population is
 * `InitAgents` (`InitAgents MaxAgents` in both recorded worldfiles), the shell shows
 * `MaxAgents` creatures until lane L11 creates the real population (the key itself reads now: lane
 * L4 landed, and `worldParams.ts` reports it as `read as <MaxAgents>` rather than "not readable").
 *
 * Geometry note: the coordinates below are the *native* absolute coordinates, not scene
 * coordinates — x in [0, worldSize], z in [-worldSize, 0] (`agent.cc:1354-1402`,
 * `food.cc:151-152`), which is what lane L11 will produce. `simSeam.ts` owns the mapping to
 * the renderer's origin-centred space.
 */

import { Config, type PropertyNode } from '../../model/types';
import { f32 } from '../../model/geometry';

/** A colour as the worldfile writes it: `{ R G B }`, each 0..1. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A rectangular patch in native absolute coordinates (`Patch.cc::initBase`). */
export interface PatchRect {
  /** Index in the native `elements()` order (the `std::map` strcmp order, lane W1a). */
  readonly index: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly startX: number;
  readonly startZ: number;
  readonly endX: number;
  readonly endZ: number;
  /** Native `Shape R|E` — `RECTANGULAR` (0) or `ELLIPTICAL` (1), `Patch.h`. */
  readonly shape: 'R' | 'E';
  /** Native `On` — an off patch holds no food and is not drawn. */
  readonly on: boolean;
  /** Native `FoodFraction` — the patch's share of the world's food. */
  readonly foodFraction: number;
}

/**
 * A barrier wall in native absolute coordinates (`barrier::updateVertices`): the worldfile's two
 * endpoints after the `RatioBarrierPositions` scaling. The drawn height is `WorldParams.barrierHeight`.
 */
export interface BarrierSegment {
  /** Index in the native `gBarriers` order (the worldfile's `Barriers` array order). */
  readonly index: number;
  readonly xa: number;
  readonly za: number;
  readonly xb: number;
  readonly zb: number;
}

/**
 * A brick patch's absolute rectangle (`BrickPatch::initBase`) plus the number of bricks a rising
 * `On` edge adds (`BrickPatch::addBricks`) and the colour those bricks take (the patch's own
 * optional `BrickColor`, else the worldfile's global `BrickColor`).
 */
export interface BrickPatchRect {
  readonly index: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly startX: number;
  readonly endX: number;
  readonly startZ: number;
  readonly endZ: number;
  /** Native `Shape R|E` (`BrickPatch`'s RECTANGULAR/ELLIPTICAL). */
  readonly shape: 'R' | 'E';
  /** Native `On` — a patch whose `On` edge rises creates the bricks (drawn here only if on). */
  readonly on: boolean;
  /** Native `BrickCount` — how many bricks a rising edge creates. */
  readonly brickCount: number;
  readonly color: Rgb;
}

export interface WorldParams {
  readonly worldSize: number;
  readonly minAgents: number;
  readonly maxAgents: number;
  readonly maxSteps: number;
  readonly stepsPerSecond: number;
  readonly recordAll: boolean;
  readonly simulationSeed: number;
  readonly positionSeed: number;
  readonly brainArchitecture: string;
  readonly edges: string;
  readonly vision: boolean;
  readonly agent: {
    readonly height: number;
    readonly size: { readonly min: number; readonly max: number };
    readonly speed: { readonly min: number; readonly max: number };
    readonly lifeSpan: { readonly min: number; readonly max: number };
    /** Native `MaxVelocity` — the clamp on per-step motion (`agent.cc:1148`). */
    readonly maxVelocity: number;
    /** Native `MotionRate` — `agent::config.speed2DPosition` (`agent.cc:1147`). */
    readonly motionRate: number;
  };
  readonly colors: {
    readonly ground: Rgb;
    readonly food: Rgb;
    readonly brick: Rgb;
    readonly barrier: Rgb;
  };
  /** The single domain's absolute rectangle (native `Domain` init, `Simulation.cc:4164-4171`). */
  readonly domain: Omit<PatchRect, 'index' | 'shape' | 'on' | 'foodFraction'>;
  readonly patches: readonly PatchRect[];
  /** Native `barrier::gBarrierHeight` — every wall's height (`BarrierHeight`). */
  readonly barrierHeight: number;
  /**
   * Native `GroundClearance` — the ground plane sits at `y = -GroundClearance`
   * (`TSimulation::InitGround`, `Simulation.cc:824`).
   */
  readonly groundClearance: number;
  /** Native `brick::gBrickHeight` — every brick's side (`BrickHeight`). */
  readonly brickHeight: number;
  /** The worldfile's barrier walls, in `Barriers` order (`barrier::updateVertices`). */
  readonly barriers: readonly BarrierSegment[];
  /** How many `Barriers` elements the worldfile declared; `> barriers.length` means some could not
   *  be resolved (the boot report's notes name them) and are therefore not drawn. */
  readonly declaredBarriers: number;
  /** The domain's brick patches, in `BrickPatches` order (`BrickPatch::init`). */
  readonly brickPatches: readonly BrickPatchRect[];
  /** How many `BrickPatches` elements the worldfile declared (0 → the world has no bricks). */
  readonly declaredBrickPatches: number;
  /**
   * How many creatures the shell draws — `MaxAgents`, *provisional*: see the PORT-NOTE above.
   * Lane L11 replaces this with the real initial population; `InitAgents` itself reads now that
   * lane L4 landed.
   */
  readonly displayAgents: number;
}

export interface ReadOk {
  readonly key: string;
  readonly kind: 'int' | 'float' | 'bool' | 'string' | 'block';
  /** Where the value is consumed (native call site or lane), for reviewers. */
  readonly consumer: string;
}

export interface ReadBlocked {
  readonly key: string;
  readonly reason: string;
}

export interface ReadProvisional {
  readonly key: string;
  readonly reason: string;
  readonly used: string;
}

/** Informational entries (blocked sub-reads inside a container, patch geometry, …). */
export interface ReadNote {
  readonly label: string;
  readonly detail: string;
}

export interface ReadReport {
  readonly ok: readonly ReadOk[];
  readonly blocked: readonly ReadBlocked[];
  readonly provisional: readonly ReadProvisional[];
  readonly notes: readonly ReadNote[];
}

export interface WorldParamsRead {
  readonly params: WorldParams;
  readonly report: ReadReport;
}

/** Thrown when a worldfile cannot support a browser boot at all (see the PORT-NOTEs). */
export class WorldBootError extends Error {
  readonly blockedKeys: readonly ReadBlocked[];

  constructor(message: string, blockedKeys: readonly ReadBlocked[]) {
    super(message);
    this.name = 'WorldBootError';
    this.blockedKeys = blockedKeys;
  }
}

// --------------------------------------------------------------------------------------- //
// reads
// --------------------------------------------------------------------------------------- //

interface ReadOptions {
  /**
   * `required` — the shell cannot draw the world without it; a failure fails the boot.
   * `optional`  — reported when blocked, the caller decides.
   */
  readonly level?: 'required' | 'optional';
  readonly consumer: string;
}

interface ReadState {
  readonly ok: ReadOk[];
  readonly blocked: ReadBlocked[];
  readonly provisional: ReadProvisional[];
  readonly notes: ReadNote[];
  readonly fatal: string[];
}

class Reads {
  private readonly state: ReadState;

  constructor(private readonly cfg: Config, state?: ReadState) {
    this.state = state ?? { ok: [], blocked: [], provisional: [], notes: [], fatal: [] };
  }

  /** A reader over a nested node (an array element, a block) sharing this report. */
  for(node: PropertyNode): Reads {
    return new Reads(new Config(node), this.state);
  }

  private attempt(key: string, kind: ReadOk['kind'], options: ReadOptions, read: () => unknown): unknown {
    try {
      const value = read();
      this.state.ok.push({ key, kind, consumer: options.consumer });
      return value;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.blocked.push({ key, reason });
      if (options.level === 'required') this.state.fatal.push(key);
      return undefined;
    }
  }

  float(key: string, options: ReadOptions): number {
    const value = this.attempt(key, 'float', options, () => this.cfg.getFloat(key));
    return typeof value === 'number' ? value : 0;
  }

  int(key: string, options: ReadOptions): number {
    const value = this.attempt(key, 'int', options, () => this.cfg.getInt(key));
    return typeof value === 'number' ? value : 0;
  }

  /**
   * A read the shell does not depend on: the value when it can be read, otherwise `undefined`
   * with the failure recorded under `blocked` (never a fallback value).
   */
  intOptional(key: string, consumer: string): number | undefined {
    const value = this.attempt(key, 'int', { level: 'optional', consumer }, () => this.cfg.getInt(key));
    return typeof value === 'number' ? value : undefined;
  }

  /** Why a key is in the `blocked` list (used to report provisional reads honestly). */
  reasonFor(key: string): string | undefined {
    return this.state.blocked.find((entry) => entry.key === key)?.reason;
  }

  bool(key: string, options: ReadOptions): boolean {
    const value = this.attempt(key, 'bool', options, () => this.cfg.getBool(key));
    return value === true;
  }

  string(key: string, fallback: string, options: ReadOptions): string {
    const value = this.attempt(key, 'string', options, () => this.cfg.getString(key));
    return typeof value === 'string' ? value : fallback;
  }

  /** A `{ R G B }` block (native `Color` properties) — one report entry for the block. */
  rgb(key: string, options: ReadOptions): Rgb {
    const value = this.attempt(key, 'block', options, () => {
      const r = this.cfg.getObject(key);
      const color = this.for(r);
      return { r: color.rawFloat('R'), g: color.rawFloat('G'), b: color.rawFloat('B') };
    });
    return isRgb(value) ? value : { r: 0, g: 0, b: 0 };
  }

  /** A float read that is part of another entry's report; failures propagate to the caller. */
  rawFloat(key: string): number {
    return this.cfg.getFloat(key);
  }

  /** An array's elements, in native order; `undefined` (reported) when it cannot be read. */
  array(key: string, options: ReadOptions): readonly PropertyNode[] | undefined {
    const value = this.attempt(key, 'block', options, () => this.cfg.getArray(key));
    return Array.isArray(value) ? value : undefined;
  }

  provisionalRead(entry: ReadProvisional): void {
    this.state.provisional.push(entry);
  }

  /** Native `doc.getp( name ) != NULL` — for an *optional* sub-read inside a container. */
  has(key: string): boolean {
    return this.cfg.has(key);
  }

  note(label: string, detail: string): void {
    this.state.notes.push({ label, detail });
  }

  finish(): ReadReport {
    if (this.state.fatal.length > 0) {
      const blocked = this.state.blocked.filter((entry) => this.state.fatal.includes(entry.key));
      throw new WorldBootError(
        `the browser cannot boot this worldfile: ${this.state.fatal.join(', ')} ` +
          `${this.state.fatal.length === 1 ? 'is' : 'are'} not readable ` +
          `(the expression evaluator reported: ${blocked[0]?.reason ?? 'unknown reason'}). ` +
          'No value was substituted.',
        blocked,
      );
    }
    return {
      ok: this.state.ok,
      blocked: this.state.blocked,
      provisional: this.state.provisional,
      notes: this.state.notes,
    };
  }
}

function isRgb(value: unknown): value is Rgb {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Rgb).r === 'number' &&
    typeof (value as Rgb).g === 'number' &&
    typeof (value as Rgb).b === 'number'
  );
}

// --------------------------------------------------------------------------------------- //
// the read list
// --------------------------------------------------------------------------------------- //

export function readWorldParams(cfg: Config): WorldParamsRead {
  const reads = new Reads(cfg);

  // --- run shape (native `TSimulation` reads these; the shell only displays them) ------- //
  const worldSize = reads.float('WorldSize', {
    level: 'required',
    consumer: 'globals::worldsize (Simulation.cc:4012) — the scene extent',
  });
  const minAgents = reads.int('MinAgents', { consumer: 'population control (TSimulation)' });
  const maxAgents = reads.int('MaxAgents', { consumer: 'population control (TSimulation)' });
  const maxSteps = reads.int('MaxSteps', { consumer: 'the run budget (TSimulation)' });
  const stepsPerSecond = reads.int('StepsPerSecond', { consumer: 'the step rate (0 = unthrottled)' });
  const recordAll = reads.bool('RecordAll', { consumer: 'the recorder switches (lane L12)' });
  const simulationSeed = reads.int('SimulationSeed', { consumer: 'the run seed (lane L11)' });
  const positionSeed = reads.int('PositionSeed', { consumer: 'the spawn positions (lane L11)' });
  const brainArchitecture = reads.string('BrainArchitecture', 'unknown', {
    consumer: 'GenomeUtil::createSchema (lane L5)',
  });
  const edges = reads.string('Edges', '?', {
    consumer: 'globals.wraparound / edge handling (lane L11; deliberately not mapped here)',
  });
  const vision = reads.bool('Vision', { level: 'required', consumer: 'agent::config.vision (lane L8)' });

  // --- the agent body (lane L8's `processWorldfile` reads all of these) ------------------ //
  const agentHeight = reads.float('AgentHeight', {
    level: 'required',
    consumer: 'agent::config.agentHeight (agentConfig.ts)',
  });
  const minSize = reads.float('MinAgentSize', { level: 'required', consumer: 'agent::config.minAgentSize' });
  const maxSize = reads.float('MaxAgentSize', { level: 'required', consumer: 'agent::config.maxAgentSize' });
  const minSpeed = reads.float('MinAgentMaxSpeed', {
    level: 'required',
    consumer: 'agent::config.minmaxspeed',
  });
  const maxSpeed = reads.float('MaxAgentMaxSpeed', {
    level: 'required',
    consumer: 'agent::config.maxmaxspeed',
  });
  const minLifeSpan = reads.int('MinLifeSpan', { consumer: 'agent::config.minLifeSpan' });
  const maxLifeSpan = reads.int('MaxLifeSpan', { consumer: 'agent::config.maxLifeSpan' });
  const maxVelocity = reads.float('MaxVelocity', { level: 'required', consumer: 'agent::config.maxVelocity' });
  const motionRate = reads.float('MotionRate', { level: 'required', consumer: 'agent::config.speed2DPosition' });

  // --- colours and the world's geometry ------------------------------------------------- //
  const groundColor = reads.rgb('GroundColor', { level: 'required', consumer: 'gstage ground (lane L15)' });
  const foodColor = reads.rgb('FoodColor', { level: 'required', consumer: 'food::color (lane L10)' });
  const brickColor = reads.rgb('BrickColor', { level: 'required', consumer: 'brick::color (lane L10)' });
  const barrierColor = reads.rgb('BarrierColor', {
    level: 'required',
    consumer: 'barrier::color (lane L10)',
  });
  const barrierHeight = reads.float('BarrierHeight', {
    level: 'required',
    consumer: 'barrier::gBarrierHeight (lane L10) — the drawn wall height',
  });
  const groundClearance = reads.float('GroundClearance', {
    level: 'required',
    consumer: 'TSimulation::InitGround (Simulation.cc:824) — the ground plane’s y is -GroundClearance',
  });
  const brickHeight = reads.float('BrickHeight', {
    level: 'required',
    consumer: 'brick::gBrickHeight (lane L10) — the drawn brick size',
  });
  const ratioBarrierPositions = reads.bool('RatioBarrierPositions', {
    consumer: 'barrier::gRatioPositions (lane L10) — scales the raw endpoints by WorldSize',
  });

  const domain = readDomain(cfg, worldSize, reads);
  const patches = domain.node === undefined ? [] : readFoodPatches(domain.node, domain.rect, reads);
  const barrierRead = readBarriers(worldSize, ratioBarrierPositions, reads);
  const barriers = barrierRead.segments;
  const brickRead =
    domain.node === undefined
      ? { patches: [] as BrickPatchRect[], declared: 0 }
      : readBrickPatches(domain.node, domain.rect, brickColor, reads);
  const brickPatches = brickRead.patches;

  // --- provisional ---------------------------------------------------------------------- //
  const initAgents = reads.intOptional('InitAgents', 'the initial population (lane L11 creates it)');
  reads.provisionalRead({
    key: 'InitAgents',
    reason:
      initAgents === undefined
        ? `not readable yet: ${reads.reasonFor('InitAgents') ?? 'unknown reason'}`
        : `read as ${initAgents}`,
    used:
      `MaxAgents (${maxAgents}) as the shell's *display* count — the worldfile says ` +
      '`InitAgents MaxAgents`, and the real initial population arrives with lane L11',
  });

  return {
    params: {
      worldSize,
      minAgents,
      maxAgents,
      maxSteps,
      stepsPerSecond,
      recordAll,
      simulationSeed,
      positionSeed,
      brainArchitecture,
      edges,
      vision,
      agent: {
        height: agentHeight,
        size: { min: minSize, max: maxSize },
        speed: { min: minSpeed, max: maxSpeed },
        lifeSpan: { min: minLifeSpan, max: maxLifeSpan },
        maxVelocity,
        motionRate,
      },
      colors: { ground: groundColor, food: foodColor, brick: brickColor, barrier: barrierColor },
      domain: domain.rect,
      patches,
      barrierHeight,
      groundClearance,
      brickHeight,
      barriers,
      declaredBarriers: barrierRead.declared,
      brickPatches,
      declaredBrickPatches: brickRead.declared,
      displayAgents: maxAgents,
    },
    report: reads.finish(),
  };
}

type Rect = WorldParams['domain'];

/**
 * Native `TSimulation`'s domain geometry (`Simulation.cc:4164-4171`), including the
 * float-precision cleanups at 4174-4182. Computed in f64 (scene geometry only — no artifact
 * depends on it).
 */
function readDomain(cfg: Config, worldSize: number, reads: Reads): { rect: Rect; node: PropertyNode | undefined } {
  const domainNode = reads.array('Domains', {
    level: 'required',
    consumer: 'the domain list (TSimulation::processWorldfile)',
  })?.[0];

  if (domainNode === undefined) {
    // Unreachable when the required read above succeeded and returned a non-empty array; the
    // `array` read reports the failure otherwise.
    return {
      rect: {
        centerX: worldSize / 2,
        centerZ: -worldSize / 2,
        startX: 0,
        endX: worldSize,
        startZ: -worldSize,
        endZ: 0,
      },
      node: undefined,
    };
  }

  const domain = reads.for(domainNode);
  const centerX = domain.float('CenterX', {
    level: 'required',
    consumer: 'Domain::centerX (Simulation.cc:4160)',
  });
  const centerZ = domain.float('CenterZ', {
    level: 'required',
    consumer: 'Domain::centerZ (Simulation.cc:4161)',
  });
  const sizeX = domain.float('SizeX', {
    level: 'required',
    consumer: 'Domain::sizeX (Simulation.cc:4162)',
  });
  const sizeZ = domain.float('SizeZ', {
    level: 'required',
    consumer: 'Domain::sizeZ (Simulation.cc:4163)',
  });

  const absoluteSizeX = worldSize * sizeX;
  const absoluteSizeZ = worldSize * sizeZ;
  let startX = centerX * worldSize - absoluteSizeX / 2;
  let startZ = -centerZ * worldSize - absoluteSizeZ / 2;
  let endX = centerX * worldSize + absoluteSizeX / 2;
  let endZ = -centerZ * worldSize + absoluteSizeZ / 2;

  if (startX < 0.0006) startX = 0;
  if (startZ > -0.0006) startZ = 0;
  if (endX > worldSize * 0.9994) endX = worldSize;
  if (endZ < -worldSize * 0.9994) endZ = -worldSize;

  const centerOf = (start: number, end: number): number => (start + end) / 2;
  const rect = {
    centerX: centerOf(startX, endX),
    centerZ: centerOf(startZ, endZ),
    startX,
    startZ,
    endX,
    endZ,
  };
  reads.note(
    'Domains[0]',
    `absolute rect x ${rect.startX}…${rect.endX}, z ${rect.startZ}…${rect.endZ} (Simulation.cc:4164-4182)`,
  );
  return { rect, node: domainNode };
}

/**
 * The domain's food patches, in native `elements()` order, converted to absolute coordinates
 * by `Patch::initBase` (`Patch.cc:32-40`). `Shape R|E` is `Patch.h`'s RECTANGULAR/ELLIPTICAL.
 */
function readFoodPatches(domainNode: PropertyNode, domain: Rect, reads: Reads): readonly PatchRect[] {
  const domainSizeX = domain.endX - domain.startX;
  const domainSizeZ = domain.endZ - domain.startZ;
  const patches: PatchRect[] = [];

  const nodes = reads
    .for(domainNode)
    .array('FoodPatches', { consumer: 'the ground patches drawn on the map (Patch::initBase)' });

  if (nodes === undefined) return patches;

  nodes.forEach((node, index) => {
    const patch = reads.for(node);
    try {
      const x = patch.rawFloat('CenterX');
      const z = patch.rawFloat('CenterZ');
      const sx = patch.rawFloat('SizeX');
      const sz = patch.rawFloat('SizeZ');
      const centerX = domain.startX + x * domainSizeX;
      const centerZ = domain.startZ + z * domainSizeZ;
      const sizeX = sx * domainSizeX;
      const sizeZ = sz * domainSizeZ;
      const shape = patch.string('Shape', 'R', { consumer: 'Patch::areaShape (RECTANGULAR/ELLIPTICAL)' });
      patches.push({
        index,
        centerX,
        centerZ,
        startX: centerX - sizeX * 0.5,
        endX: centerX + sizeX * 0.5,
        startZ: centerZ - sizeZ * 0.5,
        endZ: centerZ + sizeZ * 0.5,
        shape: shape === 'E' ? 'E' : 'R',
        on: patch.bool('On', { consumer: 'Patch on/off (an off patch holds no food)' }),
        foodFraction: patch.rawFloat('FoodFraction'),
      });
      const spelling = shape === 'E' ? 'ELLIPTICAL' : 'RECTANGULAR';
      reads.note(
        `Domains[0].FoodPatches[${index}]`,
        `read (Patch::initBase): ${spelling}, x ${patches[index]!.startX}…${patches[index]!.endX}, ` +
          `z ${patches[index]!.startZ}…${patches[index]!.endZ}`,
      );
    } catch (error) {
      reads.note(
        `Domains[0].FoodPatches[${index}]`,
        `NOT read — not drawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  if (patches.length === 0) reads.note('Domains[0].FoodPatches', 'empty — no patch rectangles drawn');
  return patches;
}

/**
 * The worldfile's barrier walls, in `Barriers` order, with the ratio scaling native applies in
 * `barrier::updateVertices` (`gRatioPositions` → `f32( value * WorldSize )`, the store narrowing
 * twice: once into the `LineSegment` float, once out of the multiply). A segment whose endpoints
 * cannot be evaluated is reported as a note and left out — never guessed.
 */
function readBarriers(
  worldSize: number,
  ratioPositions: boolean,
  reads: Reads,
): { segments: readonly BarrierSegment[]; declared: number } {
  const barriers: BarrierSegment[] = [];
  const nodes = reads.array('Barriers', {
    consumer: 'the barrier walls drawn on the map (barrier::updateVertices)',
  });
  if (nodes === undefined) return { segments: barriers, declared: 0 };

  const scaled = (value: number): number => (ratioPositions ? f32(value * worldSize) : value);

  nodes.forEach((node, index) => {
    const barrier = reads.for(node);
    try {
      const xa = scaled(barrier.rawFloat('X1'));
      const za = scaled(barrier.rawFloat('Z1'));
      const xb = scaled(barrier.rawFloat('X2'));
      const zb = scaled(barrier.rawFloat('Z2'));
      barriers.push({ index, xa, za, xb, zb });
      reads.note(
        `Barriers[${index}]`,
        `read (barrier::updateVertices): (${xa}, ${za}) → (${xb}, ${zb})` +
          (ratioPositions ? ' — worldfile ratios × WorldSize' : ''),
      );
    } catch (error) {
      reads.note(
        `Barriers[${index}]`,
        `NOT read — not drawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  if (barriers.length === 0) reads.note('Barriers', 'empty — no barrier walls drawn');
  return { segments: barriers, declared: nodes.length };
}

/**
 * The domain's brick patches, in `BrickPatches` order, converted to absolute coordinates the same
 * way `ReadFoodPatches` converts a food patch (`Patch::initBase`, shared by `BrickPatch::init`),
 * plus `BrickCount` and the patch's colour (its own optional `BrickColor`, else the worldfile's
 * global one — `worldfile.ts`'s `Simulation` read). An empty array is a *note*, not a failure: a
 * worldfile that declares no brick patches simply has no bricks.
 */
function readBrickPatches(
  domainNode: PropertyNode,
  domain: Rect,
  globalBrickColor: Rgb,
  reads: Reads,
): { patches: readonly BrickPatchRect[]; declared: number } {
  const domainSizeX = domain.endX - domain.startX;
  const domainSizeZ = domain.endZ - domain.startZ;
  const patches: BrickPatchRect[] = [];

  const nodes = reads
    .for(domainNode)
    .array('BrickPatches', { consumer: 'the brick patches drawn on the map (BrickPatch::init)' });
  if (nodes === undefined) return { patches, declared: 0 };

  nodes.forEach((node, index) => {
    const patch = reads.for(node);
    try {
      const x = patch.rawFloat('CenterX');
      const z = patch.rawFloat('CenterZ');
      const sx = patch.rawFloat('SizeX');
      const sz = patch.rawFloat('SizeZ');
      const centerX = domain.startX + x * domainSizeX;
      const centerZ = domain.startZ + z * domainSizeZ;
      const sizeX = sx * domainSizeX;
      const sizeZ = sz * domainSizeZ;
      const shape = patch.string('Shape', 'R', {
        consumer: 'BrickPatch::areaShape (RECTANGULAR/ELLIPTICAL)',
      });
      const color = patch.has('BrickColor')
        ? patch.rgb('BrickColor', { consumer: 'the patch’s BrickColor override (BrickPatch::init)' })
        : globalBrickColor;
      const brickCount = patch.int('BrickCount', { consumer: 'BrickPatch::addBricks' });
      patches.push({
        index,
        centerX,
        centerZ,
        startX: centerX - sizeX * 0.5,
        endX: centerX + sizeX * 0.5,
        startZ: centerZ - sizeZ * 0.5,
        endZ: centerZ + sizeZ * 0.5,
        shape: shape === 'E' ? 'E' : 'R',
        on: patch.bool('On', { consumer: 'BrickPatch on/off (a rising edge creates the bricks)' }),
        brickCount,
        color,
      });
      reads.note(
        `Domains[0].BrickPatches[${index}]`,
        `read (BrickPatch::init): ${brickCount} brick(s), ` +
          `x ${patches[index]!.startX}…${patches[index]!.endX}, ` +
          `z ${patches[index]!.startZ}…${patches[index]!.endZ}`,
      );
    } catch (error) {
      reads.note(
        `Domains[0].BrickPatches[${index}]`,
        `NOT read — not drawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  if (patches.length === 0) {
    reads.note(
      'Domains[0].BrickPatches',
      'empty — this worldfile declares no brick patches, so no bricks are drawn',
    );
  }
  return { patches, declared: nodes.length };
}
