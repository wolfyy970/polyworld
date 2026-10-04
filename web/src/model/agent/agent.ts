/**
 * Lane L8 — `class Agent` (native `agent/agent.cc`, `agent/agent.h`).
 *
 * Every method below is a transcription of the native method of the same name; the native
 * line is named where a reader would otherwise have to guess (e.g. "native `UpdateBody` line
 * 1179"). Behaviour is frozen: where the C++ looks wrong, the port is wrong the same way and
 * the oddity is recorded in PARITY.md.
 *
 * PORT-NOTE(L8/float-narrowing-order): the arithmetic that decides energy and motion is all
 * `float`, and C++ rounds at every store and *every* float-typed operand, so `f32` wraps
 * each product and each sum in the order the C++ evaluates them (left to right, no
 * reassociation). Where the native expression mixes in a `double` (a `double` local, a
 * `M_PI`-derived constant, or a `double` field of `TSimulation`), the port keeps the double
 * and narrows only at the native assignment — see `updateBody` and `damage`.
 *
 * PORT-NOTE(L8/out-params-returned): native uses reference out-parameters for three values
 * in `eat()` (`return_lost`, `return_rawEat`, `return_actuallyEat`) and two floats in
 * `getCollisionFixedCoordinates`/`avoidCollisionDirectional`'s result. The port returns them
 * as records: callers cannot forget to read an out-param that no longer exists, and the
 * values are identical.
 *
 * PORT-NOTE(L8/agent-attached-data): native's `AgentAttachedData` is a per-agent slot pool
 * (monitor lane L14 stores per-agent analysis state in it). The port exposes
 * `attachedData: unknown[]` allocated with the same zero-fill and `AgentAttachedData`
 * createSlot/alloc/dispose semantics; the slot *users* are L14's.
 *
 * Not ported here, deliberately, with the lane that closes each (PARITY.md → Gaps):
 * `draw()`/`print()`/`SetGraphics()` (L15/L16/L18), `Retina` (L9), the GL polygon resource
 * load in `agentinit()` (L15), file I/O in `ReadSeedSynapseFilePaths`/`SeedSynapsesFromFile`
 * (L17/the browser lane), and `Index()` (declared but not defined in the native tree).
 */

import { globals, type SimEvent } from '../types';
import { DeathReason, type BirthReason } from '../types';

import { agentConfig, AgentStatics } from './agentConfig';
import type {
  AgentDeps,
  AgentListenerLike,
  BarrierLike,
  BodyGeometryLike,
  CarryableLike,
  EventSinkLike,
  FoodLike,
  GenomeLike,
  NerveLike,
  SimulationLike,
  SortedObjectListLike,
} from './contracts';
import { GObject, ObjectTypeCode } from './contracts';
// `agent::SetGeometry` clones `agent::agentobj` into the agent's own `fPolygon`; lane L15 owns the
// mesh class (`src/model/geometry/body.ts`).
import { AgentBodyGeometry, createAgentBodyGeometry } from '../geometry/body';
import { contractedSquareSumXZ, scaledRadius } from '../geometry/primitives';
import type { PolyObj } from '../geometry';
import {
  Energy,
  EnergyMultiplier,
  EnergyPolarity,
  type Energy as EnergyType,
  energyMulMultiplier,
  energyMulPolarity,
  energyAdd,
  energySub,
} from '../environment/energy';
import { LifeSpan } from './lifeSpan';
import { Metabolism, MetabolismSelectionMode } from './metabolism';
import type { AgentOutputNerves, NervousSystemLike } from './nervousSystem';
import { OUTPUT_NERVE_FIELDS } from './nervousSystem';
import { AgentSensorLike, BeingCarriedSensor, CarryingSensor, EnergySensor, MateWaitSensor, RandomSensor, SpeedSensor, type SensorHost } from './sensors';
import { DEGTORAD, INT_MAX, clamp, f32, f32Fma, nint, trand } from './numeric';
// `fma` is the lane W1d correctly-rounded binary64 `a*b + c` (`libm.ts`). The energy chain below
// is a `double` chain in the shipped binary, so its three fused steps need this one, not `f32Fma`.
//
// `libmSin`/`libmCos` are the same lane's transcribed libm `sin()`/`cos()`, for the motion call
// site in `UpdateBody` (see the PORT-NOTE there).
import { cos as libmCos, fma, sin as libmSin } from '../rng/libm';

/** Native `graphics/gobject.h` — the object type an agent reports (`AGENTTYPE`). */
/** Native `AgentAttachedData::SlotHandle`. */
export type SlotHandle = number;

/** The per-agent attached-data pool (native `AgentAttachedData`). */
export const AgentAttachedData = {
  allocatedAgent: false,
  nslots: 0,

  /** Native `AgentAttachedData::createSlot()` — asserts no agent has been allocated yet. */
  createSlot(): SlotHandle {
    if (AgentAttachedData.allocatedAgent) {
      throw new Error('AgentAttachedData::createSlot(): an agent has already been allocated');
    }
    return AgentAttachedData.nslots++;
  },

  /** Native `AgentAttachedData::alloc( agent* )` — a zero-filled slot array. */
  alloc(): unknown[] {
    AgentAttachedData.allocatedAgent = true;
    const slots = new Array<unknown>(AgentAttachedData.nslots).fill(0);
    return slots;
  },
};

/** Native `agent::GeneCache`. */
interface GeneCache {
  maxSpeed: number;
  strength: number;
  size: number;
  lifespan: number;
}

/** The values `agent::eat()` writes through its reference parameters. */
export interface EatResult {
  lost: Energy;
  rawEat: Energy;
  actuallyEat: Energy;
}

/**
 * Native `FF` (agent.cc:1111, `const float FF = 1.01;`) — `UpdateBody`'s barrier fudge
 * factor. The native literal is a *float*, so the port narrows it: keeping the JS double
 * `1.01` would make every `FF * CarryRadius()` a different float than the native one.
 */
const FF = f32(1.01);

/** Native `CollisionRadiusReductionFactor` (`avoidCollisionDirectional`). */
const COLLISION_RADIUS_REDUCTION_FACTOR = 0.9;

/**
 * Native `class agent : public gpolyobj`.
 *
 * The port keeps the native member names (minus the `f` prefix where a getter of the same
 * name exists, as the native code has both) and exposes the native getters, so the agent
 * code and its reviewers can be read side by side.
 */
export class Agent implements SensorHost, CarryableLike {
  readonly deps: AgentDeps;

  // --- identity / lifecycle -------------------------------------------------
  private fAlive = false;
  private fIsSeed = false;
  private fAge = 0;
  private fLastMate = 0;
  private fLastEat = 0;
  private fLastEatPosition: [number, number, number] = [0, 0, 0];
  private fLastEatEnergy = new Energy(0);
  private fLastEatEnergyRaw = new Energy(0);
  private readonly fLifeSpan = new LifeSpan();
  private fDeathByPatch = false;
  private fComplexity = -1.0;
  private fHeuristicFitness = 0.0;
  private fMass = 0.0;

  // --- energy ---------------------------------------------------------------
  private fEnergy = new Energy(0);
  private fFoodEnergy = new Energy(0);
  private fMaxEnergy = new Energy(0);
  private fStarvationFoodEnergy = new Energy(0);
  private fMetabolism: Metabolism | null = null;
  private fSpeed2Energy = 0.0;
  private fYaw2Energy = 0.0;
  private fSizeAdvantage = 0.0;

  // --- body (native `gobject`/`gpolygon`/`gpolyobj`) ------------------------
  private fPosition: [number, number, number] = [0, 0, 0];
  private fAngle: [number, number, number] = [0, 0, 0];
  private fVelocity: [number, number, number] = [0, 0, 0];
  private fLastPosition: [number, number, number] = [0, 0, 0];
  private fNoseColor: [number, number, number] = [0, 0, 0];
  private fColor: [number, number, number] = [0, 0, 0];
  private fLength: [number, number, number] = [0, 0, 0];
  private fLengthX = 0.0;
  private fLengthZ = 0.0;
  private fSpeed = 0.0;
  private fMaxSpeed = 0.0;
  private objType: number = GObject.AGENTTYPE;
  private typeNumber = 0;
  private radiusValue = 0.0;
  private radiusFixed = false;
  private scaleValue = 0.0;
  /**
   * Native `agent::fPolygon` — **this** agent's body mesh, cloned from `deps.bodyTemplate`
   * (`agent::agentobj`) by the first `setGeometry()` and scaled in place by it.
   *
   * PORT-NOTE(L8/agent-owns-its-mesh): `AgentDeps.geometry` is bound **once per run** (lane L11's
   * `TSimulation::deps()` caches a single `createAgentDeps(...)` bundle), and
   * `AgentBodyGeometry.cloneGeometry()` replaces the polygon array *of that object*. Cloning the
   * template into the shared instance therefore means the last agent to grow rescales every other
   * agent's body — native keeps one mesh **per agent** and only `agent::draw` ever reads it, so the
   * defect is invisible in every artifact except the retina. Measured (`t_717e215e`): at
   * `minitest_von` step 71 the newly born worker 31 (`fLengthZ 1.389957` against the seeds'
   * `1.254169`) left the shared mesh 0.694979 deep, every agent's own nose plane moved from the
   * eye plane (`-0.5*fLengthZ`) to 0.0679 px in front of it, and the first retina divergence of the
   * whole run landed on that step. One instance per agent is what keeps `agent::draw` correct.
   *
   * A lane test that injects its own stand-in through `AgentDeps.geometry` keeps it: the stand-in
   * *is* that test's mesh (`tests/agent.test.ts` pins `setRadius` through its `lengths`), and such
   * a test has one agent whose mesh nobody else can clobber.
   */
  private fBodyMesh: BodyGeometryLike | null = null;

  // --- brain ----------------------------------------------------------------
  private fGenome: GenomeLike;
  private fCns: NervousSystemLike;
  private fRetina: unknown = null;
  private fRandomSensor: AgentSensorLike | null = null;
  private fEnergySensor: AgentSensorLike | null = null;
  private fMateWaitSensor: AgentSensorLike | null = null;
  private fSpeedSensor: AgentSensorLike | null = null;
  private fCarryingSensor: AgentSensorLike | null = null;
  private fBeingCarriedSensor: AgentSensorLike | null = null;
  private readonly outputNerves = {
    eat: null,
    mate: null,
    fight: null,
    speed: null,
    yaw: null,
    yawOppose: null,
    light: null,
    focus: null,
    visionPitch: null,
    visionYaw: null,
    give: null,
    pickup: null,
    drop: null,
  } as unknown as AgentOutputNerves;

  // --- world ----------------------------------------------------------------
  private fDomain = 0;
  private fCarryRadius = 0.0;
  private readonly fCarries: CarryableLike[] = [];
  private fCarriedBy: CarryableLike | null = null;
  private fCarryOffset: [number, number, number] = [0, 0, 0];
  private readonly listeners: AgentListenerLike[] = [];
  private attachedData: unknown[] = [];
  private geneCache: GeneCache = { maxSpeed: 0, strength: 0, size: 0, lifespan: 0 };

  /**
   * Native `agent::agent( TSimulation *sim, gstage *stage )`. Native's `gobject` base
   * constructor zero-initializes position/angle/radius/scale (the fields marked
   * PORT-NOTE(L8/gobject-zero-init) above are zero here for that reason; the ones the native
   * constructor body sets explicitly are set explicitly).
   */
  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.fGenome = deps.genomeFactory.createGenome();
    this.fCns = deps.nervousSystemFactory.create();
    this.attachedData = AgentAttachedData.alloc();
    this.objType = GObject.AGENTTYPE;

    if (!AgentStatics.classInited) agentInit();
  }

  // ---------------------------------------------------------------------------
  // statics (native `agent::agentinit` / `getfreeagent` / `agentdump` / `agentload`)
  // ---------------------------------------------------------------------------

  /**
   * Native `agent::getfreeagent( simulation, stage )`: allocate, bump `agentsliving`, stamp a
   * 1-based type number from `agentsEver`, seed the nervous system's LOCAL RNG with it, and
   * register with the POV renderer.
   */
  static getFreeAgent(deps: AgentDeps): Agent {
    const agent = new Agent(deps);
    AgentStatics.agentsLiving++;
    agent.setTypeNumber(++AgentStatics.agentsEver);
    agent.fCns.getRNG().seedIfLocal(AgentStatics.agentsEver);
    deps.simulation.agentPovRenderer().add(agent);
    return agent;
  }

  /** Native `agent::agentdump( ostream& )`. */
  static agentDump(): string {
    return `${AgentStatics.agentsEver}\n${AgentStatics.agentsLiving}\n`;
  }

  /**
   * Native `agent::agentload( istream& )` — `WARN_ONCE( "agent::agentload called. Not
   * supported." )`, followed by an `#if 0` block. The port keeps the warning and refuses, so
   * a caller cannot believe a load happened.
   */
  static agentLoad(): never {
    throw new Error('agent::agentload called. Not supported.');
  }

  // ---------------------------------------------------------------------------
  // grow / genome
  // ---------------------------------------------------------------------------

  /** Native `agent::InitGeneCache()`. */
  private initGeneCache(): void {
    this.geneCache.maxSpeed = this.fGenome.get('MaxSpeed');
    this.geneCache.strength = this.fGenome.get('Strength');
    this.geneCache.size = this.fGenome.get('Size');
    this.geneCache.lifespan = agentConfig.dieAtMaxAge ? this.fGenome.getLong('LifeSpan') : INT_MAX;
  }

  /**
   * Native `agent::setGenomeReady()` — bind a metabolism, either the genome's or, in
   * `Metabolism::Random` mode, one drawn from the agent's own LOCAL RNG:
   * `nint( ( getNumberOfDefinitions() - 1 ) * fCns->getRNG()->drand() )`.
   */
  setGenomeReady(): void {
    switch (Metabolism.selectionMode) {
      case MetabolismSelectionMode.Gene:
        // Native `fMetabolism = GenomeUtil::getMetabolism( fGenome )` (lane L5).
        this.fMetabolism = this.deps.genomeFactory.getMetabolism(this.fGenome);
        break;
      case MetabolismSelectionMode.Random: {
        const index = nint((Metabolism.getNumberOfDefinitions() - 1) * this.fCns.getRNG().drand());
        this.fMetabolism = Metabolism.require(index);
        break;
      }
      default:
        throw new Error('agent::setGenomeReady(): unknown metabolism selection mode');
    }
  }

  /**
   * Native `agent::grow( long mateWait, bool seeding )`.
   *
   * Nerve and sensor creation is delegated to the seams at exactly the native call sites and
   * in the native order (`nervousSystem.ts` holds the ordered name tables); everything after
   * it — the gene cache, the geometry, the colours, the lifespan, the energy budget, the
   * speed/yaw costs — is the agent lane's and is transcribed here.
   */
  grow(mateWait: number, seeding = false): void {
    this.initGeneCache();

    // --- input nerves (native order) ---------------------------------------
    const inputNerves: readonly [string, boolean][] = [
      ['Random', true],
      ['Energy', true],
      ['MateWaitFeedback', agentConfig.enableMateWaitFeedback],
      ['SpeedFeedback', agentConfig.enableSpeedFeedback],
      ['Carrying', agentConfig.enableCarry],
      ['BeingCarried', agentConfig.enableCarry],
      ['Red', true],
      ['Green', true],
      ['Blue', true],
    ];
    for (const [name, enabled] of inputNerves) {
      if (enabled) this.fCns.createNerve(0 /* Nerve::INPUT */, name);
    }

    // --- output nerves (native order, same conditionals) --------------------
    for (const [field, name] of OUTPUT_NERVE_FIELDS) {
      let enabled = true;
      if (field === 'yawOppose') enabled = agentConfig.yawEncoding === 1 /* YE_OPPOSE */;
      else if (field === 'light') enabled = agentConfig.hasLightBehavior;
      else if (field === 'visionPitch') enabled = agentConfig.enableVisionPitch;
      else if (field === 'visionYaw') enabled = agentConfig.enableVisionYaw;
      else if (field === 'give') enabled = agentConfig.enableGive;
      else if (field === 'pickup' || field === 'drop') enabled = agentConfig.enableCarry;
      if (enabled) {
        (this.outputNerves as unknown as Record<string, NerveLike | null>)[field] =
          this.fCns.createNerve(1 /* Nerve::OUTPUT */, name);
      }
    }

    // --- sensors (native order; note the native duplicate SpeedSensor add) --
    this.fRetina = this.deps.retinaFactory.create(this.deps.retinaWidth);
    this.fCns.addSensor(this.fRetina as never);
    this.fEnergySensor = new EnergySensor(this);
    this.fCns.addSensor(this.fEnergySensor);
    this.fRandomSensor = new RandomSensor(this.fCns.getRNG());
    this.fCns.addSensor(this.fRandomSensor);
    if (agentConfig.enableMateWaitFeedback) {
      this.fMateWaitSensor = new MateWaitSensor(this, mateWait);
      this.fCns.addSensor(this.fMateWaitSensor);
    }
    if (agentConfig.enableSpeedFeedback) {
      // Native adds the speed sensor twice (agent.cc lines 575-578) — a duplicated sensor
      // receives its input nerve twice and overwrites the value, so the visible behaviour is
      // one sensor, but the *registration count* is two and a nervous system that counts
      // sensors sees two. Ported as-is.
      this.fSpeedSensor = new SpeedSensor(this);
      this.fCns.addSensor(this.fSpeedSensor);
      this.fSpeedSensor = new SpeedSensor(this);
      this.fCns.addSensor(this.fSpeedSensor);
    }
    if (agentConfig.enableCarry) {
      this.fCarryingSensor = new CarryingSensor(this);
      this.fCns.addSensor(this.fCarryingSensor);
      this.fBeingCarriedSensor = new BeingCarriedSensor(this);
      this.fCns.addSensor(this.fBeingCarriedSensor);
    }

    // --- brain --------------------------------------------------------------
    this.fCns.grow(this.fGenome);
    if (seeding && AgentStatics.seedSynapsesFromFile) {
      this.seedSynapsesFromFile();
      if (AgentStatics.freezeSeededSynapses) this.fCns.getBrain().freeze();
    }
    this.deps.events.postEvent({ type: 4, a: this } as SimEvent<unknown, unknown, Energy>);

    this.fCns.prebirth();
    if (this.deps.preBirthLearning) this.fCns.getBrain().freeze();

    this.setGeometry();

    // initially red & blue are 0
    this.fColor[0] = 0.0;
    this.fColor[2] = 0.0;

    switch (agentConfig.bodyRedChannel) {
      case 0: // BRC_FIGHT
      case 2: // BRC_GIVE
        break;
      case 1: // BRC_CONST
        this.fColor[0] = agentConfig.bodyRedChannelConstValue;
        break;
      default:
        throw new Error('agent::grow(): unknown body red channel');
    }

    switch (agentConfig.bodyGreenChannel) {
      case 0: // BGC_ID
        this.fColor[1] = this.fGenome.get('ID');
        break;
      case 4: // BGC_CONST
        this.fColor[1] = agentConfig.bodyGreenChannelConstValue;
        break;
      case 1: // BGC_LIGHT
      case 2: // BGC_EAT
      case 3: // BGC_FOOD
        break;
      default:
        throw new Error('agent::grow(): unknown body green channel');
    }

    switch (agentConfig.bodyBlueChannel) {
      case 1: // BBC_CONST
        this.fColor[2] = agentConfig.bodyBlueChannelConstValue;
        break;
      case 0: // BBC_MATE
      case 2: // BBC_ENERGY
        break;
      default:
        throw new Error('agent::grow(): unknown body blue channel');
    }

    let noseColor: number;
    switch (agentConfig.noseColor) {
      case 2: // NC_CONST
        noseColor = agentConfig.noseColorConstValue;
        break;
      case 0: // NC_LIGHT
      case 1: // NC_BODY
        noseColor = 0.5; // start neutral gray
        break;
      default:
        throw new Error('agent::grow(): unknown nose colour');
    }
    this.fNoseColor[0] = this.fNoseColor[1] = this.fNoseColor[2] = noseColor;

    this.fIsSeed = seeding;
    this.fAge = 0;
    if (seeding) {
      this.fLastMate = agentConfig.randomSeedMateWait
        ? // Native `agent.cc:680` is `fLastMate = (long)(randpw() * -mateWait);` — a C cast,
          // i.e. truncation toward zero of the *double* product, NOT the `nint` rounding
          // macro used for `Metabolism` indices (`agent.cc:500`). For `x = -17.6` native
          // stores -17 where `nint` would give -18.
          Math.trunc(this.deps.rng.drand48() * -mateWait)
        : -mateWait;
    } else {
      this.fLastMate = agentConfig.initMateWait;
    }

    const sizeRel = f32(this.geneCache.size - agentConfig.minAgentSize);

    let maxEnergy: number;
    if (agentConfig.minAgentSize === agentConfig.maxAgentSize) {
      // Native `agent.cc:697`: `0.5 * ( minMaxEnergy + maxMaxEnergy )` — the sum is float,
      // `0.5` is a double, the product is narrowed by the assignment to `float maxEnergy`.
      maxEnergy = f32(0.5 * f32(agentConfig.minMaxEnergy + agentConfig.maxMaxEnergy));
    } else {
      // Native: `minMaxEnergy + ( size_rel * ( maxMaxEnergy - minMaxEnergy ) / ( maxAgentSize
      // - minAgentSize ) )` — all float.
      maxEnergy = f32(
        agentConfig.minMaxEnergy +
          f32(
            f32(sizeRel * f32(agentConfig.maxMaxEnergy - agentConfig.minMaxEnergy)) /
              f32(agentConfig.maxAgentSize - agentConfig.minAgentSize),
          ),
      );
    }
    this.fMaxEnergy = new Energy(maxEnergy);
    this.fStarvationFoodEnergy = new Energy(
      f32(agentConfig.starvationEnergyFraction * maxEnergy),
    );

    this.fEnergy = new Energy(maxEnergy);
    this.fFoodEnergy = new Energy(maxEnergy);

    this.updateColor();

    if (seeding) {
      const energy = agentConfig.randomSeedEnergy
        ? f32(
            trand(
              this.deps.rng.drand48(),
              agentConfig.starvationEnergyFraction,
              agentConfig.maxSeedEnergy,
            ) * maxEnergy,
          )
        : f32(agentConfig.maxSeedEnergy * maxEnergy);
      this.fEnergy = new Energy(energy);
      this.fFoodEnergy = new Energy(energy);
    }

    if (agentConfig.minAgentSize === agentConfig.maxAgentSize) {
      this.fSpeed2Energy = f32(agentConfig.speed2Energy * this.geneCache.maxSpeed);
      this.fYaw2Energy = f32(agentConfig.yaw2Energy * this.geneCache.maxSpeed);
      this.fSizeAdvantage = 1.0;
    } else {
      const sizePenaltyNumerator = f32(agentConfig.minSizePenalty + sizeRel);
      // Native `agent.cc:741/747` spells the denominator
      // `( minSizePenalty + maxAgentSize - minAgentSize )`, i.e. left-to-right
      // `(( minSizePenalty + maxAgentSize ) - minAgentSize)` — *not*
      // `minSizePenalty + ( maxAgentSize - minAgentSize )`. Identical while
      // `MinSizeEnergyPenalty == 0`, 1 ulp apart once it is larger.
      const sizePenaltyDenominator = f32(
        f32(agentConfig.minSizePenalty + agentConfig.maxAgentSize) - agentConfig.minAgentSize,
      );
      this.fSpeed2Energy = f32(
        f32(
          f32(
            f32(agentConfig.speed2Energy * this.geneCache.maxSpeed) * sizePenaltyNumerator,
          ) * agentConfig.maxSizePenalty,
        ) / sizePenaltyDenominator,
      );
      this.fYaw2Energy = f32(
        f32(
          f32(f32(agentConfig.yaw2Energy * this.geneCache.maxSpeed) * sizePenaltyNumerator) *
            agentConfig.maxSizePenalty,
        ) / sizePenaltyDenominator,
      );
      // PORT-NOTE(L11/L8-sizeadvantage-double-promotion): native `agent.cc:749-750` is
      //   `fSizeAdvantage = 1.0 + ( size_rel * ( config.maxSizeAdvantage - 1.0 )
      //                            / ( config.maxAgentSize - config.minAgentSize ) );`
      // The `1.0` (and the `- 1.0`) are **double** literals, so the whole parenthesised
      // expression is promoted to double and only the outer assignment narrows to `float`.
      // The divisor `maxAgentSize - minAgentSize` is still a *float* subtraction, performed
      // first and then promoted. Proof from the shipped dylib, `__ZN5agent4growElb`
      // @0x24fac-0x24fd8: `fcvt d4,s9 / fcvt d5,s5 / fadd d5,d5,d6 / fmul d4,d5,d4 /
      // fcvt d1,s1 / fdiv d1,d4,d1 / fadd d1,d1,d2 / fcvt s1,d1` — one narrowing, at the end.
      // Rounding every intermediate to f32 instead is 1 ulp away for ~11% of `size_rel`
      // (the step-39 fight-damage divergence: golden 6.036985 vs 6.036986).
      const sizeAdvantageDenominator = f32(agentConfig.maxAgentSize - agentConfig.minAgentSize);
      this.fSizeAdvantage = f32(
        1.0 + (sizeRel * (agentConfig.maxSizeAdvantage - 1.0)) / sizeAdvantageDenominator,
      );
    }

    this.fAlive = true;

    this.deps.events.postEvent({ type: 8, a: this } as SimEvent<unknown, unknown, Energy>);
  }

  /**
   * Native `agent::SeedSynapsesFromFile()` — chooses the seed file by agent number and asks
   * the brain to load it. The *choice* is agent-lane logic
   * (`(fTypeNumber - 1) % fSeedSynapseFilePaths.size()`); reading the file is not, so the
   * port stops at the path (see the header's Gaps note).
   */
  seedSynapsePath(): string {
    const paths = AgentStatics.seedSynapseFilePaths;
    return paths[(this.typeNumber - 1) % paths.length]!;
  }

  private seedSynapsesFromFile(): void {
    this.seedSynapsePath();
    throw new Error(
      'agent::SeedSynapsesFromFile(): loading a synapse seed file needs the file lane (L17)',
    );
  }

  // ---------------------------------------------------------------------------
  // geometry
  // ---------------------------------------------------------------------------
  /** Native `agent::SetGeometry()`. */
  setGeometry(): void {
    const mesh = this.bodyMesh();
    mesh.cloneGeometry(this.deps.bodyTemplate);

    // PORT-NOTE(L8/sqrt-of-a-float-is-single-precision): `sqrt( geneCache.maxSpeed )` is a
    // `float` argument, so the oracle's build inlines the **single-precision** `fsqrt` (the
    // C++ `float` overload Apple's libc++ declares — measured, not assumed): with the root
    // left as `Math.sqrt`'s double, `/` and `*` below would be *double* operations rounded
    // once at the store, which is 1 ulp off the native `fdiv`/`fmul` on **7** (resp. **13**)
    // of the 112 recorded agents' `fLengthX` (resp. `fLengthZ`) — `fLengthX`/`fLengthZ` then
    // scale every body vertex, so the whole collision radius moves with them. Pinned by
    // `tests/geometry.test.ts` against `src/model/geometry/golden/nativeBodyMesh.ts`
    // (`native/sqrt_discipline.py` prints the count). The two roots in `UpdateBody`
    // (`agent.cc:1435`) and `GetCollisionFixedCoordinates` are already narrowed by their outer
    // `f32(...)`, which is why only this site was affected — see PARITY.md.
    const rootMaxSpeed = f32(Math.sqrt(this.geneCache.maxSpeed));
    this.fLengthX = f32(this.size() / rootMaxSpeed);
    this.fLengthZ = f32(this.size() * rootMaxSpeed);
    this.bodyMesh().scaleVertices(this.fLengthX, agentConfig.agentHeight, this.fLengthZ);
    this.setLen();
    this.fCarryRadius = this.radiusValue;
  }

  /**
   * Native `agent::fPolygon` as everything that reads the *mesh* sees it: the agent's own body
   * geometry, scaled by its own `fLengthX`/`agentHeight`/`fLengthZ` (see
   * `PORT-NOTE(L8/agent-owns-its-mesh)` on `fBodyMesh`). `agent::draw` draws this one, and so does
   * the POV renderer (`vision/povScan.ts`).
   */
  bodyGeometry(): BodyGeometryLike {
    return this.bodyMesh();
  }

  /** This agent's mesh, created on first use (lane L15's class, or the injected test stand-in). */
  private bodyMesh(): BodyGeometryLike {
    if (this.fBodyMesh === null) {
      this.fBodyMesh =
        this.deps.geometry instanceof AgentBodyGeometry
          ? createAgentBodyGeometry(this.deps.bodyTemplate as PolyObj)
          : this.deps.geometry;
    }
    return this.fBodyMesh;
  }

  /** Native `gpolyobj::setlen()` — the bounding box of the scaled mesh, then `setradius()`. */
  setLen(): void {
    const [lx, ly, lz] = this.bodyMesh().lengths();
    this.fLength[0] = lx;
    this.fLength[1] = ly;
    this.fLength[2] = lz;
    this.setRadius();
  }

  /**
   * Native `agent::setradius()` — `sqrt( lx^2 + lz^2 ) * fRadiusScale * fScale * 0.5`, and a
   * no-op when the radius was pinned (`fRadiusFixed`).
   */
  setRadius(): void {
    if (!this.deps.geometry.radiusFixed()) {
      // Native `agent.cc:790` is `sqrt( fLength[0]*fLength[0] + fLength[2]*fLength[2] ) *
      // fRadiusScale * fScale * 0.5`, and the *shipped* `__ZN5agent9setradiusEv` contracts
      // the square sum — it is ONE rounding, not the two the source text spells:
      //
      //   21f3c:  ldr    s0, [x0, #0x98]      ; fLength[0]
      //   21f40:  ldp    s1, s2, [x0, #0xa0]  ; s1 = fLength[2], s2 = fRadiusScale
      //   21f44:  fmul   s1, s1, s1           ; f32( fLength[2]^2 ) — the ONLY rounded square
      //   21f48:  fmadd  s0, s0, s0, s1       ; fLength[0]^2 + that, ONE rounding
      //   21f4c:  fsqrt  s0, s0
      //   21f50:  fmul   s0, s2, s0           ; * fRadiusScale
      //   21f54:  ldr    s1, [x0, #0x44]      ; fScale
      //   21f58:  fmul   s0, s1, s0           ; * fScale
      //   21f5c:  fmov   s1, #0.50000000      ; the source's `* 0.5`, materialised as a float
      //   21f60:  fmul   s0, s0, s1           ; * 0.5f
      //
      // The pre-sweep port rounded **both** squares (the unfused source semantics): the sum
      // differs on 33 081 of 200 000 `(lx, lz)` pairs in the recorded size range `[0.05, 2]`
      // (16.5 %) and the derived `fRadius` on 16 597 of them (8.3 %; over `[0.01, 100]`:
      // 16.7 % / 8.5 %) — `fRadius`/`fCarryRadius` decide the carry and contact tests, so this
      // is the `food::setradius` defect one lane over. The three multiplies are `float × float`
      // (exact in a double, one narrowing each, exactly the `fmul`s) and `* 0.5` is exact, so
      // only the sum needs `f32Fma`. Pinned with exact-rational constants in
      // `tests/fma-contraction-sweep.test.ts` (same addresses) and, on the live `Agent`
      // path, in `tests/agent.test.ts` (`agent::setradius() — the shipped contraction`;
      // latent on the recorded agents — all 16 distinct `(fLength[0], fLength[2])` pairs
      // reproduce the golden `fRadius` either way, so no golden moves).
      const lx = this.fLength[0];
      const lz = this.fLength[2];
      const mesh = this.bodyMesh();
      // The x/z square sum and the tail are lane L15's one definition (`primitives.ts`:
      // `contractedSquareSumXZ`/`scaledRadius` — the same pair `gpoly`/`gpolyobj`/`gbox` and
      // `food`'s override use); this override only chooses the x/z pair, as native's does.
      this.radiusValue = scaledRadius(
        contractedSquareSumXZ(lx, lz),
        mesh.radiusScale(),
        mesh.scale(),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // eat / energy exchange
  // ---------------------------------------------------------------------------

  /**
   * Native `agent::eat( food*, eatFitnessParameter, eat2consume, eatthreshold, step,
   *                     Energy &lost, Energy &rawEat, Energy &actuallyEat )`.
   */
  eat(
    food: FoodLike,
    eatFitnessParameter: number,
    eat2consume: number,
    eatthreshold: number,
    step: number,
  ): EatResult {
    // Native `agent.cc:838`: the *third* out-param of the `fFoodEnergy` clamp is the energy the
    // clamp threw away (`Energy::constrain( min, max, result_overflow )`), and `Simulation.cc:2703`
    // feeds exactly that to `FoodEnergyOut` — not the food's contents. It was declared here and
    // never assigned, so `eat()`'s `lost` was always zero and `run/stats/stat.N`'s `totFoodEnergy`
    // read `0.87` against the golden's `0.98` (the depleted food's remaining energy is counted by
    // `RemoveFood`/`maintain.ts` instead). Lane L11 run fix.
    let lost = new Energy(0);
    // Lane L11 run fix (cross-lane, 2 lines): this was declared but never assigned, so every
    // returned `rawEat` was 0 and `run/energy/consumption.txt`'s EnergyRaw column was
    // `0.000000` against the golden's raw eat. Native returns `return_rawEat` here
    // (`agent.cc:843-848`); the raw value is the `food::eat` result, not the scaled one.
    let rawEat = new Energy(0);
    let actuallyEat = new Energy(0);

    if (this.eatNerve() > eatthreshold) {
      const trytoeat = new Energy(f32(this.eatNerve() * eat2consume));
      const polarity = this.fMetabolism!.energyPolarity.multiply(food.energyPolarity());
      const maxeat = Energy.fromPolarity(
        energySub(this.fMaxEnergy, this.fEnergy),
        this.fEnergy,
        polarity,
      );
      trytoeat.constrain(new Energy(0), maxeat);

      const raw = food.eat(trytoeat);
      rawEat = raw.clone();
      actuallyEat = raw
        .mulPolarity(this.fMetabolism!.energyPolarity)
        .mulPolarity(food.energyPolarity())
        .mulMultiplier(this.fMetabolism!.eatMultiplier)
        .mulMultiplier(food.eatMultiplier());

      // The eatMultiplier could have made us exceed our limits.
      actuallyEat.constrainOverflow(
        this.fEnergy.mulScalar(-1),
        energySub(this.fMaxEnergy, this.fEnergy),
      );

      this.fEnergy.addAssign(actuallyEat);
      this.fFoodEnergy.addAssign(actuallyEat);

      lost = this.fFoodEnergy.constrainOverflow(new Energy(0), this.fMaxEnergy);

      this.fHeuristicFitness = f32(
        this.fHeuristicFitness +
          f32(
            f32(eatFitnessParameter * actuallyEat.sum()) / f32(eat2consume * this.maxAge()),
          ),
      );

      if (!actuallyEat.isZero()) {
        this.fLastEat = step;
        this.fLastEatPosition[0] = this.fPosition[0];
        this.fLastEatPosition[1] = this.fPosition[1];
        this.fLastEatPosition[2] = this.fPosition[2];
        this.fLastEatEnergy = actuallyEat.clone();
        this.fLastEatEnergyRaw = raw.clone();
      }
    }

    return { lost, rawEat: rawEat.clone(), actuallyEat };
  }

  /** Native `agent::receive( agent *giver, const Energy &requested )`. */
  receive(giver: Agent, requested: Energy): Energy {
    const amount = requested.clone();
    amount.constrain(new Energy(0), energySub(this.fMaxEnergy, this.fEnergy));

    this.fEnergy.addAssign(amount);
    giver.fEnergy.subAssign(amount);

    return amount;
  }

  /**
   * Native `agent::damage( const Energy &e, bool nullMode )`.
   *
   * `scaleFactor` is a `double` in native and the multiply is `Energy * float`, so the
   * double is narrowed to `float` *at the call* — reproduced with `f32(scaleFactor)`.
   */
  damage(e: Energy, nullMode: boolean): Energy {
    const scaleFactor =
      this.deps.simulation.fLowPopulationAdvantageFactor *
      this.deps.simulation.fGlobalEnergyScaleFactor *
      this.domainEnergyScaleFactor();
    const actual = e.mulScalar(f32(scaleFactor));
    actual.constrain(new Energy(0), this.fEnergy);

    if (!nullMode) this.fEnergy.subAssign(actual);

    return actual;
  }

  /** `fSimulation->fDomains[ fDomain ].energyScaleFactor` (L11 owns the table). */
  private domainEnergyScaleFactor(): number {
    return this.deps.simulation.fDomains[this.fDomain]!.energyScaleFactor;
  }

  /** Native `agent::MateProbability( agent *c )`. */
  mateProbability(c: Agent): number {
    return this.fGenome.mateProbability(c.fGenome);
  }

  /** Native `agent::mating( mateFitnessParam, mateWait, lockstep )`. */
  mating(mateFitnessParam: number, mateWaitIn: number, lockstep: boolean): Energy {
    let mateWait = mateWaitIn;
    if (mateWait <= 0) mateWait = 1;

    const mymateenergy = this.fEnergy.mulScalar(this.fGenome.get('MateEnergyFraction'));

    if (!lockstep) {
      this.fLastMate = this.fAge;
      this.fHeuristicFitness = f32(
        this.fHeuristicFitness + f32(f32(mateFitnessParam * mateWait) / this.maxAge()),
      );
      this.fEnergy.subAssign(mymateenergy);
      this.fFoodEnergy.subAssign(mymateenergy);
      this.fFoodEnergy.constrain(new Energy(0), this.fMaxEnergy);
    }

    return mymateenergy;
  }

  /** Native `agent::rewardmovement( moveFitnessParam, speed2dpos )` (`agent.cc:920-925`). */
  rewardMovement(moveFitnessParam: number, speed2dpos: number): void {
    // Native: `fHeuristicFitness += moveFitnessParam * (
    // fabs(fPosition[0] - fLastPosition[0]) + fabs(fPosition[2] - fLastPosition[2]) ) /
    // ( geneCache.maxSpeed * speed2dpos * MaxAge() );` — each difference, each `fabs`, the
    // sum, both products and the division are float; the `+=` narrows too.
    const dxAbs = f32(Math.abs(f32(this.fPosition[0] - this.fLastPosition[0])));
    const dzAbs = f32(Math.abs(f32(this.fPosition[2] - this.fLastPosition[2])));
    this.fHeuristicFitness = f32(
      this.fHeuristicFitness +
        f32(
          f32(moveFitnessParam * f32(dxAbs + dzAbs)) /
            // Native divides by `geneCache.maxSpeed * speed2dpos * MaxAge()`, all float.
            f32(f32(this.geneCache.maxSpeed * speed2dpos) * this.maxAge()),
        ),
    );
  }

  /**
   * Native `agent::lastrewards( energyFitness, ageFitness )` (`agent.cc:931-935`) —
   * `fHeuristicFitness += energyFitness * NormalizedEnergy() + ageFitness * fAge / MaxAge();`
   *
   * The shipped `__ZN5agent11lastrewardsEff` contracts the **energy** product only:
   *
   *   25e34:  fmul   s1, s8, s1       ; ageFitness * fAge      (a real binary32 rounding)
   *   25e38:  fdiv   s1, s1, s2       ; / MaxAge()             (ditto — the age term is right)
   *   25e3c:  fmadd  s0, s9, s0, s1   ; energyFitness * NormalizedEnergy() + that, ONE rounding
   *   25e44:  fadd   s0, s1, s0       ; fHeuristicFitness + that
   *
   * so the energy product is *never* narrowed before the add. The pre-sweep port rounded it,
   * which differs in the last bit on 2.4 % of the model's operands (200 000 exact-rational
   * samples, review round 3) — and `fHeuristicFitness` feeds least-fit/smite selection
   * (`sim/interact.ts`), the status text and the anatomy dumps. Pinned by a live drive in
   * `tests/agent.test.ts` (*the contraction sweep — the lastrewards/ProjectedHeuristicFitness
   * sites*, `dis/gen_heur_pins.py`).
   */
  lastRewards(energyFitness: number, ageFitness: number): void {
    const ageTerm = f32(f32(ageFitness * this.fAge) / this.maxAge()); // 0x25e34/0x25e38
    this.fHeuristicFitness = f32(
      this.fHeuristicFitness + f32Fma(energyFitness, this.normalizedEnergy(), ageTerm), // 0x25e3c
    );
  }

  /** Native `agent::ProjectedHeuristicFitness()`. */
  projectedHeuristicFitness(): number {
    const sim = this.deps.simulation;
    if (sim.lifeFractionSamples() >= 50) {
      // `fHeuristicFitness * LifeFractionRecent() * MaxAge() / fAge` — three separate float
      // operations (`0x25e98`/`0x25ea4 fmul`, `0x25eb0 fdiv`), each rounded; this one is right.
      const base = f32(
        f32(f32(this.fHeuristicFitness * sim.lifeFractionRecent()) * this.maxAge()) / this.fAge,
      );
      // The two adds are contracted: `0x25ed4 fmadd s0, s10, s0, s9` and
      // `0x25f00 fmadd s0, s1, s2, s0` keep each product exact and round once into the sum.
      // The pre-sweep port rounded both products to float first — a different last bit on
      // 12.0 % / 10.8 % of the model's operands (17.6 % together, exact-rational measurement
      // in `dis/gen_heur_pins.py`). Pinned by a live drive in `tests/agent.test.ts`.
      return f32Fma(
        sim.ageFitnessParameter(),
        sim.lifeFractionRecent(),
        f32Fma(sim.energyFitnessParameter(), this.normalizedEnergy(), base), // 0x25ed4
      ); // 0x25f00
    }
    return this.fHeuristicFitness;
  }

  /** Native `agent::HeuristicFitness()` — projected while alive, current once dead. */
  heuristicFitness(): number {
    return this.fAlive ? this.projectedHeuristicFitness() : this.fHeuristicFitness;
  }

  // ---------------------------------------------------------------------------
  // death
  // ---------------------------------------------------------------------------

  /** Native `agent::Die()`. */
  die(): void {
    this.fAlive = false;

    for (const listener of this.listeners) listener.died(this);
    this.listeners.length = 0;

    if (this.fLifeSpan.death.reason === DeathReason.SIMEND) return;

    for (const o of this.fCarries) o.dropped();
    this.fCarries.length = 0;

    if (this.beingCarried()) {
      const carrier = this.fCarriedBy as unknown as Agent;
      carrier.dropObject(this);
    }

    AgentStatics.agentsLiving--;

    this.deps.simulation.agentPovRenderer().remove(this);
  }

  // ---------------------------------------------------------------------------
  // the step: vision (seam), brain (seam), body (the lane's core)
  // ---------------------------------------------------------------------------

  /**
   * Native `agent::SetGraphics()` (`agent.cc:1019-1034`) plus the per-step part of
   * `agent::UpdateVision()` (`:1065-1093`): the numbers the agent's `fCamera` holds while the
   * scene is drawn through it.
   *
   * `updateVision()` configures the camera from this, and the POV renderer reads the same
   * numbers back through `PovAgent.povCamera()`. Native needs no such accessor because its
   * renderer reaches the camera *object* (`QtAgentPovRenderer::render` → `a->GetScene().Draw()`
   * → `gscene::Draw()` → `fCamera->Use()`, `QtAgentPovRenderer.cc:148-150`); the port's
   * `AgentDeps.visionCamera` is `null` off the WebGL path, so the numbers themselves cross the
   * seam. One description of the camera keeps both paths bit-identical — the alternative (the
   * renderer re-deriving `fovx` from a focus round trip) is a second rounding of the same
   * expression (`agent.cc:1070` derives it once and hands *that* float to `SetAspect`).
   * PORT-NOTE(L8/pov-camera-is-one-object).
   */
  povCamera(): {
    fovx: number;
    aspect: number;
    pitch: number;
    yaw: number;
    localPosition: [number, number, number];
  } {
    const fovx = this.fieldOfView();
    const aspect = f32(
      f32(fovx * this.deps.retinaHeight) / f32(agentConfig.agentFOV * this.deps.retinaWidth),
    );
    return {
      fovx,
      aspect,
      // `0` unless the nerve is enabled — native leaves the camera's stored pitch/yaw untouched
      // in that case (`agent.cc:1077-1087`).
      pitch: agentConfig.enableVisionPitch
        ? f32(
            this.visionPitchNerve() * f32(agentConfig.maxVisionPitch - agentConfig.minVisionPitch) +
              agentConfig.minVisionPitch,
          )
        : 0,
      yaw: agentConfig.enableVisionYaw
        ? f32(
            this.visionYawNerve() * f32(agentConfig.maxVisionYaw - agentConfig.minVisionYaw) +
              agentConfig.minVisionYaw,
          )
        : 0,
      // `SetGraphics`'s `settranslation( 0.0, (eyeHeight-0.5)*agentHeight, -0.5*fLengthZ )`.
      localPosition: [
        0,
        f32(f32(agentConfig.eyeHeight - 0.5) * agentConfig.agentHeight),
        f32(-0.5 * this.fLengthZ),
      ],
    };
  }

  /**
   * Native `agent::GetRetina()` — the object the POV renderer copies its framebuffer row into
   * (`QtAgentPovRenderer.cc:153`, `Retina::updateBuffer`). The object itself is lane L9/L16's
   * (`SimRetinaSensor`); this is only the accessor the renderer needs, kept next to its caller.
   * PORT-NOTE(L8/pov-renderer-readback).
   */
  povRetina(): unknown {
    return this.fRetina;
  }

  /** Native `agent::UpdateVision()` — the numbers are the lane's, the camera is L9/L16's. */
  updateVision(): void {
    if (!agentConfig.vision) return;

    const pov = this.povCamera();

    const camera = this.deps.visionCamera;
    if (camera !== null) {
      camera.setFrustum(
        this.fPosition[0],
        this.fPosition[2],
        this.fAngle[0],
        pov.fovx,
        agentConfig.maxRadius,
      );
      camera.setAspect(pov.aspect);
      if (agentConfig.enableVisionPitch) camera.setPitch(pov.pitch);
      if (agentConfig.enableVisionYaw) camera.setYaw(pov.yaw);
    }

    this.deps.simulation.agentPovRenderer().render(this);
  }

  /** Native `agent::UpdateBrain()` — `fCns->update( false )` plus the event. */
  updateBrain(): void {
    this.fCns.update(false);
    this.deps.events.postEvent({ type: 16, a: this } as SimEvent<unknown, unknown, Energy>);
  }

  /**
   * Native `agent::UpdateBody( moveFitnessParam, speed2dpos, solidObjects, carrier )` —
   * returns the energy consumed by this agent *and everything it carries*.
   */
  updateBody(
    moveFitnessParam: number,
    speed2dpos: number,
    solidObjects: number,
    carrier: Agent | null,
  ): number {
    // Native: `assert( lxor( !BeingCarried(), carrier ) )` — the two must agree, i.e. an
    // agent is updated with a carrier exactly when it is being carried.
    if (this.beingCarried() !== (carrier !== null)) {
      throw new Error(`agent::UpdateBody(): lxor( BeingCarried, carrier ) violated (agent ${this.typeNumber})`);
    }

    // In some simulations we use a dynamic energy delta to shape difficulty.
    if (!this.fMetabolism!.energyDelta.isZero()) {
      this.fEnergy.addAssign(this.fMetabolism!.energyDelta);
      this.fEnergy.constrain(new Energy(0), this.fMaxEnergy);
    }

    let dx = 0;
    let dz = 0;
    let energyUsed = 0;

    // just do x & z dimensions in this version
    this.saveLastPosition();

    if (this.beingCarried()) {
      // the agent carrying this agent initiated the update
      this.setX(carrier!.x());
      this.setZ(carrier!.z());
      dx = f32(this.x() - this.lastX());
      dz = f32(this.z() - this.lastZ());
    } else {
      let dpos = f32(this.speedNerve() * this.geneCache.maxSpeed * agentConfig.speed2DPosition);
      if (dpos > agentConfig.maxVelocity) dpos = agentConfig.maxVelocity;
      // PORT-NOTE(L8/motion-sincos-stret): the shipped `agent::UpdateBody` reaches Apple's
      // **double** `__sincos_stret` for the pair (`0x265f8 → bl 0xa3988`, i.e. Apple's joint
      // sin+cos, not the `sinf`/`cosf` pair — see PARITY's
      // `W1d-fu/camera-calls-sincosf-not-sinf-cosf`). The argument is `yaw() * DEGTORAD`: `yaw()`
      // is a `float`, `DEGTORAD` (`0.017453292`) is a `double` literal, so the call gets a
      // **double** and the `-dpos * …` product stays double until the assignment narrows to
      // `float`. V8's `Math.sin`/`Math.cos` are not that function: over 20,000 `f32` yaw values
      // in [0, 360) the two disagree on **847 (sin) / 953 (cos)** of them, pinned in
      // `tests/agent.test.ts`. The narrowing is *not* a mitigation but it is why no golden sees
      // this: `f32(-dpos * s)` round-trips the two forms identically on all 80,000 (yaw, dpos)
      // samples measured there, so no recorded artifact can catch a revert — the test pins the
      // counts and the call site itself.
      dx = f32(-dpos * libmSin(this.yaw() * DEGTORAD));
      dz = f32(-dpos * libmCos(this.yaw() * DEGTORAD));
      this.addX(dx);
      this.addZ(dz);
    }

    // --- steering (no `DirectYaw`, no `TestWorld`) --------------------------
    let dyaw: number;
    switch (agentConfig.yawEncoding) {
      case 1: // YE_OPPOSE
        dyaw = f32(this.yawNerve() - this.yawOpposeNerve());
        break;
      case 0: // YE_SQUASH
        dyaw = f32(2.0 * this.yawNerve() - 1.0);
        break;
      default:
        throw new Error('agent::UpdateBody(): unknown yaw encoding');
    }
    this.addYaw(f32(f32(dyaw * this.geneCache.maxSpeed) * agentConfig.yaw2DYaw));

    // Whether being carried or not, behaviors cost energy
    //
    // PORT-NOTE(L11/L8-energyused-double-chain): native's `energyused` chain is **double** until
    // one narrowing. `Nerve::get()` returns a `double` and the config constants are widened
    // (`fcvt d14,s0`), so clang keeps the products and the sum in `d` registers and narrows to
    // `float` once. Shipped `agent::UpdateBody` (`libpolyworld.dylib`): `fmul d0,d0,d1` +
    // `fmadd d10,d10,d14,d0` @0x266d8/0x266dc, `fmadd d10,d0,d1,d10` @0x266f8,
    // `fmadd d0,d0,d1,d10` @0x26714, the `|dyaw| * fYaw2Energy` **float** product
    // (`fmul s1,s1,s2` @0x26720) then `fcvt d1,s1` + `fadd d10,d0,d1` @0x26728,
    // `fadd d0,d10,d0` (getEnergyUse) @0x26738, `fadd d0,d0,d1` (fixedEnergyDrain) @0x26744,
    // and the single `fcvt s12,d0` @0x26748. The pre-fix transcription rounded after every
    // product and every `+`, which lands 1 ulp away on about half the inputs; over a run that is
    // the drift that walks `fEnergy` off the golden (`minitest_voff` agent 13 step 22 was the
    // first per-step trace divergence: golden `119.322693` vs port `119.322701`, 1 ulp at that
    // magnitude, growing ~1 ulp/step).
    let energyusedD = fma(
      this.eatNerve(),
      agentConfig.eat2Energy,
      this.mateNerve() * agentConfig.mate2Energy,
    );
    energyusedD = fma(this.fightNerve(), agentConfig.fight2Energy, energyusedD);
    energyusedD = fma(this.speedNerve(), this.fSpeed2Energy, energyusedD);
    energyusedD = energyusedD + f32(Math.abs(dyaw) * this.fYaw2Energy); // the yaw term is a float product
    energyusedD = energyusedD + this.fCns.getEnergyUse(); // `float NervousSystem::getEnergyUse()`
    energyusedD = energyusedD + agentConfig.fixedEnergyDrain;

    let energyused = f32(energyusedD);

    if (agentConfig.hasLightBehavior) {
      // Native narrows and re-widens around each optional term (`fcvt s12,d0` @0x26748 …
      // `fcvt d2,s12` + `fmadd d0,d0,d1,d2` + `fcvt s12,d0` @0x26774-0x2677c).
      energyused = f32(fma(this.lightNerve(), agentConfig.light2Energy, energyused));
    }
    if (agentConfig.enableGive) {
      energyused = f32(fma(this.giveNerve(), agentConfig.give2Energy, energyused));
    }
    if (agentConfig.enableCarry) {
      energyused = f32(energyused + this.carryEnergy()); // `fadd s12,s12,s10` @0x2689c
    }

    // `fmul s0,s12,s0` @0x268a4 then `fmadd s1,s2,s1,s3` @0x268c0 (`s3` = `1.0f`, `s2` =
    // `ageEnergyMultiplier`, `s1` = `float(fAge)`) then `fmul s10,s0,s1` @0x268c4.
    let denergy = f32(
      f32(energyused * this.strength()) *
        f32Fma(agentConfig.ageEnergyMultiplier, f32(this.fAge), 1.0),
    );

    // Apply large-population energy penalty (only if NumDepletionSteps > 0)
    const populationEnergyPenalty = f32(
      this.deps.simulation.fPopulationPenaltyFraction * this.fMaxEnergy.mean(),
    );
    denergy = f32(denergy + populationEnergyPenalty);

    // Apply energy-based population controls
    const scaleFactor =
      this.deps.simulation.fLowPopulationAdvantageFactor *
      this.deps.simulation.fGlobalEnergyScaleFactor *
      this.domainEnergyScaleFactor();
    denergy = f32(denergy * scaleFactor);

    denergy = f32(denergy * agentConfig.energyUseMultiplier);

    this.fEnergy.subAssign(new Energy(denergy));
    this.fFoodEnergy.subAssign(new Energy(denergy));

    energyUsed = denergy;

    this.updateColor();

    this.fAge++;

    let skipDomainCheck = false;

    if (!this.beingCarried()) {
      // --- barriers --------------------------------------------------------
      // PORT-NOTE(L8/contraction-barrier): every `x() ± FF * CarryRadius()` in this pass is
      // a hardware `fmadd` in the shipped binary — `UpdateBody`, `0x26a04`, `0x26a18`,
      // `0x26a2c`, `0x26a40`, `0x26a58`, `0x26a6c`, `0x26a80`, `0x26a94`, with `±1.01f`
      // baked into the multiplier register (`w23 = 0xbf8147ae`, `w24 = 0x3f8147ae`) — so the
      // product is never rounded to float first, only the sum is. The one place the compiler
      // *does* materialise the rounded product is the containment test
      // `fabs( dist ) < FF * CarryRadius()` (`0x26ae4: fmul s7, s1, s6`), which is what
      // `ffCarry` is; the two `p` values fuse again (`0x26b08`/`0x26b30` `fmadd s1, s1, s7,
      // s4`, `0x26b34` `fnmadd`). The previous form rounded the product in every one of
      // those comparisons, which disagrees with the binary on **18 798 of 200 000** bounds
      // (9.4 %, `x = 8.3325f`, `CarryRadius` on a 1/200 000 grid in `[0.5, 1.5]`) and can
      // flip an `xmin`/`xmax`/`zmin`/`zmax` test on the barrier's own coordinates. Pinned in
      // `tests/fma-contraction-sweep.test.ts`.
      const cr = this.carryRadius();
      const ffCarry = f32(FF * cr); // `0x26ae4`: the rounded product the |dist| test uses
      this.deps.barrierList.reset();
      for (let entry = this.deps.barrierList.next(); entry !== null; entry = this.deps.barrierList.next()) {
        const b: BarrierLike = entry.barrier;
        if (b.xmax() > f32Fma(-FF, cr, this.x()) || b.xmax() > f32Fma(-FF, cr, this.lastX())) {
          if (b.xmin() > f32Fma(FF, cr, this.x()) && b.xmin() > f32Fma(FF, cr, this.lastX())) {
            break; // no overlap, and none can follow in the sorted list
          } else {
            if (
              (b.zmin() < f32Fma(FF, cr, this.z()) || b.zmin() < f32Fma(FF, cr, this.lastZ())) &&
              (b.zmax() > f32Fma(-FF, cr, this.z()) || b.zmax() > f32Fma(-FF, cr, this.lastZ()))
            ) {
              if (this.deps.barrierList.stickyBarriers()) {
                this.fPosition[0] = this.lastX();
                this.fPosition[2] = this.lastZ();
              } else {
                // also overlap in z, so there may be an intersection
                const dist = b.dist(this.x(), this.z());
                const disto = b.dist(this.lastX(), this.lastZ());
                let p: number;

                if (Math.abs(dist) < ffCarry) {
                  // they actually overlap/intersect
                  if (f32(dist * disto) < 0.0) {
                    // sign change, so crossed the barrier already
                    p = f32Fma(FF, cr, Math.abs(dist));
                    if (disto < 0.0) p = -p;
                  } else {
                    p = f32Fma(FF, cr, -Math.abs(dist));
                    if (dist < 0.0) p = -p;
                  }
                  this.addZ(f32(p * b.sina()));
                  this.addX(f32(-p * b.cosa()));
                } else if (f32(disto * dist) < 0.0) {
                  // the agent completely passed through the barrier
                  p = f32Fma(FF, cr, Math.abs(dist));
                  if (disto < 0.0) p = -p;
                  this.addZ(f32(p * b.sina()));
                  this.addX(f32(-p * b.cosa()));
                }
              }

              this.deps.events.postEvent({
                type: 256,
                a: this,
                ot: ObjectTypeCode.OT_BARRIER,
              } as SimEvent<unknown, unknown, Energy>);
            }
          }
        }
      }

      // --- solid objects ---------------------------------------------------
      if (
        (solidObjects !== GObject.BRICKTYPE && solidObjects > 0) ||
        (solidObjects === GObject.BRICKTYPE && this.deps.brickStatics.numBricks() > 0)
      ) {
        if (dx !== 0.0 || dz !== 0.0) {
          this.avoidCollisions(solidObjects);
        }
      }

      // --- world edges -----------------------------------------------------
      if (globals.blockedEdges) {
        let collision = false;

        if (this.fPosition[0] > globals.worldsize) {
          collision = true;
          this.fPosition[0] = globals.worldsize;
        } else if (this.fPosition[0] < 0.0) {
          collision = true;
          this.fPosition[0] = 0.0;
        }

        if (this.fPosition[2] < -globals.worldsize) {
          collision = true;
          this.fPosition[2] = -globals.worldsize;
        } else if (this.fPosition[2] > 0.0) {
          collision = true;
          this.fPosition[2] = 0.0;
        }

        if (collision) {
          if (globals.stickyEdges) {
            this.fPosition[0] = this.lastX();
            this.fPosition[2] = this.lastZ();
          }
          this.deps.events.postEvent({
            type: 256,
            a: this,
            ot: ObjectTypeCode.OT_EDGE,
          } as SimEvent<unknown, unknown, Energy>);
        }
      } else if (globals.wraparound) {
        if (this.fPosition[0] > globals.worldsize) this.fPosition[0] = f32(this.fPosition[0] - globals.worldsize);
        else if (this.fPosition[0] < 0.0) this.fPosition[0] = f32(this.fPosition[0] + globals.worldsize);

        if (this.fPosition[2] < -globals.worldsize) this.fPosition[2] = f32(this.fPosition[2] + globals.worldsize);
        else if (this.fPosition[2] > 0.0) this.fPosition[2] = f32(this.fPosition[2] - globals.worldsize);
      } else {
        if (
          this.fPosition[0] > globals.worldsize ||
          this.fPosition[0] < 0.0 ||
          this.fPosition[2] < -globals.worldsize ||
          this.fPosition[2] > 0.0
        ) {
          // The agent fell off a tabletop world, so it's no longer in a domain.
          // Native calls `error( 2, "Possible Wile E. Coyote detected" )` here, which
          // **exits**; it then (unreachably) sets skipDomainCheck. The port throws.
          throw new Error('Possible Wile E. Coyote detected');
        }
      }
    }

    // Keep track of the domain in which the agent resides
    if (!skipDomainCheck) {
      const newDomain = this.deps.simulation.whichDomain(
        this.fPosition[0],
        this.fPosition[2],
        this.fDomain,
      );
      if (newDomain !== this.fDomain) {
        this.deps.simulation.switchDomain(newDomain, this.fDomain, GObject.AGENTTYPE);
        this.fDomain = newDomain;
      }
    }

    this.fVelocity[0] = f32(this.x() - this.lastX());
    this.fVelocity[2] = f32(this.z() - this.lastZ());

    this.fSpeed = f32(
      // Native `agent.cc:1435` / `agent::UpdateBody` 0x26da8: `fmul` + `fmadd` + `fsqrt` —
      // the z-product rounds, the x-product stays exact across the add (clang
      // `-ffp-contract=on`), and `fsqrt` rounds the sum once. `fMaxSpeed` and
      // `rewardmovement` are both consumers.
      Math.sqrt(
        f32Fma(
          this.fVelocity[0],
          this.fVelocity[0],
          f32(this.fVelocity[2] * this.fVelocity[2]),
        ),
      ),
    );

    if (this.fSpeed > this.fMaxSpeed) this.fMaxSpeed = this.fSpeed;

    this.rewardMovement(moveFitnessParam, speed2dpos);

    // Now update any objects we are carrying
    // (They will not be updated in TSimulation::UpdateAgents*().)
    for (const carried of this.fCarries) {
      switch (carried.getType()) {
        case GObject.AGENTTYPE:
          energyUsed = f32(
            energyUsed +
              (carried as unknown as Agent).updateBody(
                moveFitnessParam,
                speed2dpos,
                solidObjects,
                this,
              ),
          );
          // carried agent's domain will be taken care of in its UpdateBody() call
          break;

        case GObject.FOODTYPE: {
          carried.setx(this.x());
          carried.setz(this.z());
          const food = carried as unknown as FoodLike;
          this.deps.simulation.switchDomain(this.domain(), food.domain(), GObject.FOODTYPE);
          food.setDomain(this.domain());
          break;
        }

        case GObject.BRICKTYPE:
          carried.setx(this.x());
          carried.setz(this.z());
          // bricks do not currently identify their domain, nor are they counted in domains
          break;

        default:
          throw new Error('updating carried objects; encountered unknown object type');
      }
    }

    this.deps.events.postEvent({
      type: 32,
      a: this,
      energyUsed: denergy,
      energyUsedRaw: energyused,
    } as SimEvent<unknown, unknown, Energy>);

    return energyUsed;
  }

  /** Native `agent::UpdateColor()`. */
  updateColor(): void {
    switch (agentConfig.bodyRedChannel) {
      case 0: // BRC_FIGHT
        this.setRed(this.fightNerve());
        break;
      case 2: // BRC_GIVE
        this.setRed(this.giveNerve());
        break;
      default:
        break;
    }

    switch (agentConfig.bodyGreenChannel) {
      case 1: // BGC_LIGHT
        this.setGreen(this.lightNerve());
        break;
      case 2: // BGC_EAT
        this.setGreen(this.eatNerve());
        break;
      case 3: // BGC_FOOD
        this.setGreen(this.normalizedFoodEnergy());
        break;
      default:
        break;
    }

    switch (agentConfig.bodyBlueChannel) {
      case 0: // BBC_MATE
        this.setBlue(this.mateNerve());
        break;
      case 2: // BBC_ENERGY
        this.setBlue(f32(1 - this.normalizedEnergy()));
        break;
      default:
        break;
    }

    if (agentConfig.noseColor === 0 /* NC_LIGHT */) {
      const light = this.lightNerve();
      this.fNoseColor[0] = this.fNoseColor[1] = this.fNoseColor[2] = light;
    }
  }

  // ---------------------------------------------------------------------------
  // collisions
  // ---------------------------------------------------------------------------

  /** Native `agent::AvoidCollisions( solidObjects )`. */
  avoidCollisions(solidObjects: number): void {
    const list: SortedObjectListLike = this.deps.sortedObjects;

    list.setMark(GObject.AGENTTYPE);
    this.avoidCollisionDirectional(GObject.PREV, solidObjects);

    list.toMark(GObject.AGENTTYPE);
    this.avoidCollisionDirectional(GObject.NEXT, solidObjects);

    list.toMark(GObject.AGENTTYPE);
  }

  /** Native `agent::AvoidCollisionDirectional( direction, solidObjects )`. */
  avoidCollisionDirectional(direction: number, solidObjects: number): void {
    const list = this.deps.sortedObjects;

    const dx = f32(this.x() - this.lastX());
    const dz = f32(this.z() - this.lastZ());
    const agtRadius = f32(this.radius() * COLLISION_RADIUS_REDUCTION_FACTOR);

    for (let entry = list.anotherObj(direction, solidObjects); entry !== null; entry = list.anotherObj(direction, solidObjects)) {
      const obj = entry.obj;
      const objRadius = f32(obj.radius() * COLLISION_RADIUS_REDUCTION_FACTOR);

      // Test to see if we're close enough in x; if not, get out, we're done,
      // because all objects after this one are even farther away
      // Native `agent.cc:1564-1573`: `obj->x() - objRadius` and `max( x(), LastX() ) +
      // agtRadius` are float expressions, so each is narrowed here.
      if (direction === GObject.NEXT) {
        if (
          f32(obj.x() - objRadius) > f32(Math.max(this.x(), this.lastX()) + agtRadius)
        ) {
          break;
        }
      } else {
        if (f32(obj.x() + objRadius) < f32(Math.min(this.x(), this.lastX()) - agtRadius)) break;
      }

      // Test to see if we're too far away in z; if so, we're done with this object
      if (
        f32(obj.z() - objRadius) > f32(Math.max(this.z(), this.lastZ()) + agtRadius) ||
        f32(obj.z() + objRadius) < f32(Math.min(this.z(), this.lastZ()) - agtRadius)
      ) {
        continue;
      }

      // If we're carrying the object, then there's nothing to be done
      if (this.carrying(obj)) continue;

      // We only want to adjust the position of our agent if it was traveling in the
      // direction of the object it is touching...
      let xs: number;
      let zs: number;
      // Native `agent.cc:1595` / `agent::AvoidCollisionDirectional` 0x27420: each difference
      // is a float store, the z-product rounds and the x-product stays exact across the add
      // (`fmul` + `fmadd`, clang `-ffp-contract=on`).
      const dox = f32(obj.x() - this.lastX());
      const doz = f32(obj.z() - this.lastZ());
      const dosquared = f32Fma(dox, dox, f32(doz * doz));
      if (Math.abs(dx) > Math.abs(dz)) {
        const s = f32(dz / dx);
        xs = f32(this.lastX() + f32(dx / globals.worldsize));
        zs = f32Fma(s, f32(xs - this.lastX()), this.lastZ()); // 0x27444: fmadd
      } else {
        const s = f32(dx / dz);
        zs = f32(this.lastZ() + f32(dz / globals.worldsize));
        xs = f32Fma(s, f32(zs - this.lastZ()), this.lastX()); // 0x27454: fmadd
      }
      const dsx = f32(obj.x() - xs);
      const dsz = f32(obj.z() - zs);
      const dssquared = f32Fma(dsx, dsx, f32(dsz * dsz)); // 0x27468/0x2746c

      // Test to see if the agent is approaching the potential collision object
      if (dssquared < dosquared) {
        const fixed = this.getCollisionFixedCoordinates(
          this.lastX(),
          this.lastZ(),
          this.x(),
          this.z(),
          obj.x(),
          obj.z(),
          agtRadius,
          objRadius,
        );
        this.setX(fixed.xf);
        this.setZ(fixed.zf);

        let ot: number;
        switch (obj.getType()) {
          case GObject.AGENTTYPE:
            ot = ObjectTypeCode.OT_AGENT;
            break;
          case GObject.FOODTYPE:
            ot = ObjectTypeCode.OT_FOOD;
            break;
          case GObject.BRICKTYPE:
            ot = ObjectTypeCode.OT_BRICK;
            break;
          default:
            throw new Error('agent::AvoidCollisionDirectional(): unknown object type');
        }

        this.deps.events.postEvent({
          type: 256,
          a: this,
          ot,
        } as unknown as SimEvent<unknown, unknown, Energy>);
      }
    }
  }

  /**
   * Native `agent::GetCollisionFixedCoordinates( xo, zo, xn, zn, xb, zb, rc, rb, *xf, *zf )`.
   * Pure float geometry — the one agent method with no dependencies at all, and therefore the
   * one the native probe can check exhaustively (see `native/`).
   */
  getCollisionFixedCoordinates(
    xo: number,
    zo: number,
    xn: number,
    zn: number,
    xb: number,
    zb: number,
    rc: number,
    rb: number,
  ): { xf: number; zf: number } {
    let xf1: number;
    let zf1: number;
    let xf2: number;
    let zf2: number;
    const dx = f32(xn - xo);
    const dz = f32(zn - zo);

    if (dx === 0.0 && dz === 0.0) return { xf: xn, zf: zn };

    // Native mixes `float` locals with the `double` literals `2.0`/`4.0`: each float
    // operation rounds (f32 below), and only the final assignment to a float narrows the
    // double sub-expression. On top of that, clang's `-ffp-contract=on` (the native build's
    // `-O2` default) keeps a product exact across the following add, so every `a*b + c` in
    // the shipped `libpolyworld.dylib` is a single `fmadd`/`fmsub`/`fnmsub` rounding — those
    // sites go through `f32Fma` (`numeric.ts`, PORT-NOTE `L8/contraction`) instead of
    // rounding the product first. The annotations name the instruction the disassembled
    // `agent::GetCollisionFixedCoordinates` (0x27504) actually uses; this transcription is
    // what makes all 3022 native cases bit-exact.
    if (Math.abs(dx) > Math.abs(dz)) {
      const s = f32(dz / dx); // fdiv
      const a = f32Fma(s, s, 1.0); // fmadd: 1 + s*s
      const t1 = f32(zo - zb); // fsub
      const t2 = f32Fma(-s, xo, t1); // fmsub: (zo - zb) - s*xo
      const b = f32(2 * f32Fma(s, t2, -xb)); // fnmsub + fadd: 2 * (s*(...) - xb)
      let acc = f32Fma(xb, xb, f32(zb * zb)); // fmul + fmadd: xb*xb + zb*zb
      acc = f32Fma(f32(xo * f32(s * s)), xo, acc); // fmul,fmul,fmadd: + s*s*xo*xo
      acc = f32Fma(zo, zo, acc); // fmadd: + zo*zo
      const inner = f32Fma(f32(xo * s), f32(zb - zo), -f32(zo * zb)); // fmul,fsub,fnmul,fmadd
      // `acc + 2.0 * (...)` is a double (2.0 is a double literal); native narrows once, at
      // the assignment to the float `c`.
      const c = f32((acc + 2.0 * inner) - f32(f32(rc + rb) * f32(rc + rb)));
      // `b*b` is narrowed to a float *by the source* before the double subtraction, so this
      // one is deliberately not fused (an `fmadd` would keep `b*b` exact).
      const discriminant = f32(f32(b * b) - 4.0 * a * c);
      if (discriminant < 0.0) {
        // roots are not real; shouldn't be possible, but protect against it
        return { xf: xn, zf: zn };
      }
      const d = f32(Math.sqrt(discriminant));
      const e = f32(0.5 / a);
      xf1 = f32(f32(-b + d) * e);
      xf2 = f32(f32(-b - d) * e);
      zf1 = f32Fma(s, f32(xf1 - xo), zo); // fmadd: zo + s*(xf1 - xo)
      zf2 = f32Fma(s, f32(xf2 - xo), zo); // fmadd
    } else {
      const s = f32(dx / dz);
      const a = f32Fma(s, s, 1.0); // fmadd: 1 + s*s
      const t1 = f32(xo - xb); // fsub
      const t2 = f32Fma(-s, zo, t1); // fmsub: (xo - xb) - s*zo
      const b = f32(2 * f32Fma(s, t2, -zb)); // fnmsub + fadd
      let acc = f32Fma(xb, xb, f32(zb * zb)); // fmul + fmadd
      acc = f32Fma(f32(zo * f32(s * s)), zo, acc); // fmul,fmul,fmadd: + s*s*zo*zo
      acc = f32Fma(xo, xo, acc); // fmadd: + xo*xo
      const inner = f32Fma(f32(zo * s), f32(xb - xo), -f32(xb * xo)); // fmul,fsub,fnmul,fmadd
      const c = f32((acc + 2.0 * inner) - f32(f32(rc + rb) * f32(rc + rb)));
      const discriminant = f32(f32(b * b) - 4.0 * a * c);
      if (discriminant < 0.0) {
        return { xf: xn, zf: zn };
      }
      const d = f32(Math.sqrt(discriminant));
      const e = f32(0.5 / a);
      zf1 = f32(f32(-b + d) * e);
      zf2 = f32(f32(-b - d) * e);
      xf1 = f32Fma(s, f32(zf1 - zo), xo); // fmadd: xo + s*(zf1 - zo)
      xf2 = f32Fma(s, f32(zf2 - zo), xo); // fmadd
    }

    // Native computes `dsquared` after the branch (scheduling only: `dx`/`dz` are untouched
    // by both branches) and fuses its add as well.
    const dsquared = f32Fma(dx, dx, f32(dz * dz));
    // In both branches the z-difference square is the rounded (`fmul`) operand and the
    // x-difference square the exact (`fmadd`) one — 0x276c0/0x276cc.
    const d1squared = f32Fma(f32(xf1 - xo), f32(xf1 - xo), f32(f32(zf1 - zo) * f32(zf1 - zo)));
    const d2squared = f32Fma(f32(xf2 - xo), f32(xf2 - xo), f32(f32(zf2 - zo) * f32(zf2 - zo)));
    if (d1squared < d2squared) {
      if (d1squared < dsquared) return { xf: xf1, zf: zf1 };
      return { xf: xn, zf: zn };
    }
    if (d2squared < dsquared) return { xf: xf2, zf: zf2 };
    return { xf: xn, zf: zn };
  }

  // ---------------------------------------------------------------------------
  // carrying
  // ---------------------------------------------------------------------------

  /** Native `agent::PickupObject( gobject *o )`. */
  pickupObject(o: CarryableLike): void {
    o.pickedUp(this, this.fLength[1]);
    this.fCarries.push(o);
    if (o.radius() > this.fCarryRadius) this.fCarryRadius = o.radius();

    this.deps.events.postEvent({ type: 512, a: this, action: 0, obj: o } as unknown as SimEvent<unknown, unknown, Energy>);
  }

  /** Native `agent::DropMostRecent()`. */
  dropMostRecent(): void {
    const o = this.fCarries.pop()!;
    o.dropped();

    if (o.radius() === this.fCarryRadius) this.recalculateCarryRadius();

    this.deps.events.postEvent({ type: 512, a: this, action: 1, obj: o } as unknown as SimEvent<unknown, unknown, Energy>);
  }

  /** Native `agent::DropObject( gobject *o )`. */
  dropObject(o: CarryableLike): void {
    o.dropped();
    const index = this.fCarries.indexOf(o);
    if (index >= 0) this.fCarries.splice(index, 1);
    if (o.radius() === this.fCarryRadius) this.recalculateCarryRadius();

    this.deps.events.postEvent({ type: 512, a: this, action: 2, obj: o } as unknown as SimEvent<unknown, unknown, Energy>);
  }

  /** Native `agent::RecalculateCarryRadius()`. */
  recalculateCarryRadius(): void {
    let newCarryRadius = this.radiusValue;
    for (const carried of this.fCarries) {
      if (carried.radius() > newCarryRadius) newCarryRadius = carried.radius();
    }
    this.fCarryRadius = newCarryRadius;
  }

  /** Native `gobject::Carrying( gobject *o )` — the agent version asks `o->CarriedBy()`. */
  carrying(o: CarryableLike): boolean {
    return o.carriedBy() === (this as unknown as CarryableLike);
  }

  /** Native `agent::CarryEnergy()` — what carrying costs per step. */
  carryEnergy(): number {
    let energy = 0.0;

    for (const o of this.fCarries) {
      switch (o.getType()) {
        case GObject.AGENTTYPE:
          energy = f32(energy + agentConfig.carryAgent2Energy);
          if (agentConfig.minAgentSize !== agentConfig.maxAgentSize) {
            energy = f32(
              energy +
                f32(
                  f32(
                    agentConfig.carryAgentSize2Energy *
                      f32((o as unknown as Agent).size() - agentConfig.minAgentSize),
                  ) / f32(agentConfig.maxAgentSize - agentConfig.minAgentSize),
                ),
            );
          }
          break;

        case GObject.FOODTYPE:
          energy = f32(
            energy +
              f32(
                f32(
                  this.deps.foodStatics.carryFood2Energy() * o.radius(),
                ) / this.deps.foodStatics.maxFoodRadius(),
              ),
          );
          break;

        case GObject.BRICKTYPE:
          energy = f32(energy + this.deps.brickStatics.carryBrick2Energy());
          break;

        default:
          throw new Error('unknown object type in CarryEnergy()');
      }
    }

    return energy;
  }

  /** Native `agent::PrintCarries( FILE* )` — the port returns the line instead of writing. */
  printCarries(): string {
    let text = `${this.deps.simulation.fStep}: agent # ${this.typeNumber} is carrying`;
    if (this.fCarries.length > 0) {
      for (const o of this.fCarries) text += ` ${o.getType() === GObject.FOODTYPE ? 'food' : o.getType() === GObject.BRICKTYPE ? 'brick' : 'agent'} # ${o.getTypeNumber()}`;
      return `${text}\n`;
    }
    return `${text} nothing\n`;
  }

  // ---------------------------------------------------------------------------
  // carry state of *this* object (native `gobject`)
  // ---------------------------------------------------------------------------

  /** Native `gobject::PickedUp( gobject* carrier, float dy )`. */
  pickedUp(carrier: CarryableLike, dy: number): void {
    this.fCarriedBy = carrier;
    this.fCarryOffset[0] = f32(carrier.x() - this.x());
    this.fCarryOffset[1] = dy;
    this.fCarryOffset[2] = f32(carrier.z() - this.z());
    this.fPosition[0] = carrier.x();
    this.fPosition[1] = f32(this.fPosition[1] + dy);
    this.fPosition[2] = carrier.z();
  }

  /** Native `gobject::Dropped()`. */
  dropped(): void {
    this.fCarriedBy = null;
    this.fPosition[0] = f32(this.fPosition[0] - this.fCarryOffset[0]);
    this.fPosition[1] = f32(this.fPosition[1] - this.fCarryOffset[1]);
    this.fPosition[2] = f32(this.fPosition[2] - this.fCarryOffset[2]);

    if (this.fPosition[0] < 0.0) this.fPosition[0] = 0.0;
    else if (this.fPosition[0] > globals.worldsize) this.fPosition[0] = globals.worldsize;

    if (this.fPosition[2] > 0.0) this.fPosition[2] = 0.0;
    else if (this.fPosition[2] < -globals.worldsize) this.fPosition[2] = -globals.worldsize;
  }

  /** Native `gobject::CarriedBy()`. */
  carriedBy(): CarryableLike | null {
    return this.fCarriedBy;
  }

  /** Native `gobject::BeingCarried()`. */
  beingCarried(): boolean {
    return this.fCarriedBy !== null;
  }

  /** Native `gobject::NumCarries()`. */
  numCarries(): number {
    return this.fCarries.length;
  }

  /** Native `gobject::getType()` / `getTypeNumber()` / `setTypeNumber()`. */
  getType(): number {
    return this.objType;
  }

  getTypeNumber(): number {
    return this.typeNumber;
  }

  setTypeNumber(n: number): void {
    this.typeNumber = n;
  }

  // ---------------------------------------------------------------------------
  // body accessors (native `gobject` / `gpolygon` / `agent` inlines)
  // ---------------------------------------------------------------------------

  x(): number {
    return this.fPosition[0];
  }

  y(): number {
    return this.fPosition[1];
  }

  z(): number {
    return this.fPosition[2];
  }

  setX(x: number): void {
    this.fPosition[0] = x;
  }

  setY(y: number): void {
    this.fPosition[1] = y;
  }

  setZ(z: number): void {
    this.fPosition[2] = z;
  }

  setx(x: number): void {
    this.setX(x);
  }

  setz(z: number): void {
    this.setZ(z);
  }

  addX(x: number): void {
    this.fPosition[0] = f32(this.fPosition[0] + x);
  }

  addZ(z: number): void {
    this.fPosition[2] = f32(this.fPosition[2] + z);
  }

  addx(x: number): void {
    this.addX(x);
  }

  addz(z: number): void {
    this.addZ(z);
  }

  yaw(): number {
    return this.fAngle[0];
  }

  setYaw(yaw: number): void {
    this.fAngle[0] = yaw;
  }

  addYaw(yaw: number): void {
    this.fAngle[0] = f32(this.fAngle[0] + yaw);
  }

  radius(): number {
    return this.radiusValue;
  }

  lastX(): number {
    return this.fLastPosition[0];
  }

  lastY(): number {
    return this.fLastPosition[1];
  }

  lastZ(): number {
    return this.fLastPosition[2];
  }

  setLastX(x: number): void {
    this.fLastPosition[0] = x;
  }

  setLastY(y: number): void {
    this.fLastPosition[1] = y;
  }

  setLastZ(z: number): void {
    this.fLastPosition[2] = z;
  }

  /** Native `agent::SaveLastPosition()`. */
  saveLastPosition(): void {
    this.fLastPosition[0] = this.fPosition[0];
    this.fLastPosition[1] = this.fPosition[1];
    this.fLastPosition[2] = this.fPosition[2];
  }

  velocity(i: number): number {
    return this.fVelocity[i]!;
  }

  velocityX(): number {
    return this.fVelocity[0];
  }

  velocityZ(): number {
    return this.fVelocity[2];
  }

  speed(): number {
    return this.fSpeed;
  }

  maxSpeedReached(): number {
    return this.fMaxSpeed;
  }

  /** Native `NormalizedSpeed()` == `min( 1.0f, Speed() / agent::config.maxVelocity )`. */
  normalizedSpeed(): number {
    return Math.min(1.0, f32(this.fSpeed / agentConfig.maxVelocity));
  }

  /** Native `NormalizedYaw()`. */
  normalizedYaw(): number {
    switch (agentConfig.yawEncoding) {
      case 1: // YE_OPPOSE
        return clamp(
          f32(f32((this.yawNerve() - this.yawOpposeNerve()) * this.geneCache.maxSpeed) / agentConfig.maxmaxspeed),
          -1.0,
          1.0,
        );
      case 0: // YE_SQUASH
        return clamp(
          f32(f32(f32(2.0 * this.yawNerve() - 1.0) * this.geneCache.maxSpeed) / agentConfig.maxmaxspeed),
          -1.0,
          1.0,
        );
      default:
        throw new Error('agent::NormalizedYaw(): unknown yaw encoding');
    }
  }

  /** Native `agent::FieldOfView()` (`agent.cc:1899-1904`). */
  fieldOfView(): number {
    // Native: `outputNerves.focus->get() * ( minFocus - maxFocus ) + maxFocus` — the
    // difference, the product and the sum are all float; the function returns `float`.
    const focus = this.focusNerve();
    // PORT-NOTE(L8/contraction-fov): `agent::FieldOfView` (`agent.cc:1899-1904`) is
    // `focus * ( maxFocus - minFocus ) + minFocus`, and the shipped binary fuses the
    // multiply-add in **double** (`0x261d0`: `fsub s2, s2, s1` for the bounds' float
    // difference, `fmadd d0, d0, d2, d1`, then `fcvt` for the `float` return). Both product
    // operands are binary32, so the product is exact in binary64 and the single rounding is
    // the sum's: `f32(focus * f32(hi - lo) + lo)`. An inner `f32(...)` around the product
    // (the round-1 form) rounds it to binary32 first and is the *unfused* value.
    return agentConfig.invertFocus
      ? f32(focus * f32(agentConfig.minFocus - agentConfig.maxFocus) + agentConfig.maxFocus)
      : f32(focus * f32(agentConfig.maxFocus - agentConfig.minFocus) + agentConfig.minFocus);
  }

  mass(): number {
    return this.fMass;
  }

  setMass(m: number): void {
    this.fMass = m;
  }

  lengthX(): number {
    return this.fLengthX;
  }

  lengthZ(): number {
    return this.fLengthZ;
  }

  length(): readonly [number, number, number] {
    return this.fLength;
  }

  sizeAdvantage(): number {
    return this.fSizeAdvantage;
  }

  speed2Energy(): number {
    return this.fSpeed2Energy;
  }

  yaw2Energy(): number {
    return this.fYaw2Energy;
  }

  color(): readonly [number, number, number] {
    return this.fColor;
  }

  noseColor(): readonly [number, number, number] {
    return this.fNoseColor;
  }

  private setRed(r: number): void {
    this.fColor[0] = r;
  }

  private setGreen(g: number): void {
    this.fColor[1] = g;
  }

  private setBlue(b: number): void {
    this.fColor[2] = b;
  }

  // ---------------------------------------------------------------------------
  // energy / gene / lifecycle accessors
  // ---------------------------------------------------------------------------

  energy(): Energy {
    return this.fEnergy;
  }

  foodEnergy(): Energy {
    return this.fFoodEnergy;
  }

  /**
   * Native `agent::SetEnergy( const Energy &e )` (`agent.h:400`) — **copy** assignment:
   * `Energy` holds a `float values[MAX_ENERGY_TYPES]` member, so `fEnergy = e` copies the array
   * and the two energies are independent afterwards.
   *
   * PORT-NOTE(L11/L8-setenergy-copies): the port's setters stored the *reference*, so the birth
   * path's native-verbatim `SetEnergy( eenergy ); SetFoodEnergy( eenergy )` (`Simulation.cc:2266`
   * / `:2267`, called with the same object) aliased the two fields: every later
   * `fEnergy -= denergy; fFoodEnergy -= denergy` (`UpdateBody`) and every `damage()` then hit
   * both at once. Measured on `minitest_voff`, agent 26 (born step 28, energy `338.421906` in
   * both): the golden's step 29 is `318.456055 / 326.897797` (energy − damage) while the port
   * had `306.931946 / 306.931946` = `338.421906 − 2·denergy − damage` on both.
   */
  setEnergy(e: Energy): void {
    this.fEnergy = e.clone();
  }

  setFoodEnergy(e: Energy): void {
    this.fFoodEnergy = e.clone();
  }

  maxEnergy(): Energy {
    return this.fMaxEnergy;
  }

  starvationFoodEnergy(): Energy {
    return this.fStarvationFoodEnergy;
  }

  normalizedEnergy(): number {
    return f32(this.fEnergy.sum() / this.fMaxEnergy.sum());
  }

  normalizedFoodEnergy(): number {
    return f32(this.fFoodEnergy.sum() / this.fMaxEnergy.sum());
  }

  metabolism(): Metabolism | null {
    return this.fMetabolism;
  }

  strength(): number {
    return this.geneCache.strength;
  }

  size(): number {
    return this.geneCache.size;
  }

  isSeed(): boolean {
    return this.fIsSeed;
  }

  age(): number {
    return this.fAge;
  }

  maxAge(): number {
    return this.geneCache.lifespan;
  }

  lastMate(): number {
    return this.fLastMate;
  }

  lastEat(): number {
    return this.fLastEat;
  }

  /**
   * Native `agent::LastEatDistance()` (`agent.h:419`) — `dist( fPosition[0], fPosition[2],
   * fLastEatPosition[0], fLastEatPosition[2] )`, `dist` being `utils/misc.h:96`'s `float`
   * 2-D square sum. The shipped build contracts it, inlined into `TSimulation::GetMatePotential`
   * at 0x9947c-0x9948c:
   *
   *   9947c: fsub  s3, s3, s5     ; dx
   *   99480: fsub  s4, s4, s6     ; dz
   *   99484: fmul  s4, s4, s4     ; f32(dz*dz)  <- the one rounded square
   *   99488: fmadd s3, s3, s3, s4 ; dx*dx + that, ONE rounding
   *   9948c: fsqrt s3, s3         ; **float** sqrt
   *
   * `Math.hypot` is neither the fused square sum nor a float `sqrt` (it is also
   * correctly-rounded in a different sense), so it cannot express this site.
   */
  lastEatDistance(): number {
    // the two differences are `fsub`s on `float` registers (0x9947c/0x99480), i.e. float
    // differences — not the binary64 differences of the same operands
    const dx = f32(this.fPosition[0] - this.fLastEatPosition[0]);
    const dz = f32(this.fPosition[2] - this.fLastEatPosition[2]);
    return f32(Math.sqrt(f32Fma(dx, dx, f32(dz * dz))));
  }

  lastEatEnergy(): Energy {
    return this.fLastEatEnergy;
  }

  lastEatEnergyRaw(): Energy {
    return this.fLastEatEnergyRaw;
  }

  genes(): GenomeLike {
    return this.fGenome;
  }

  getNervousSystem(): NervousSystemLike {
    return this.fCns;
  }

  number(): number {
    return this.typeNumber;
  }

  /** Native `agent::NumberToName()` — `sprintf( "agent#%ld", agentsEver )`. */
  numberToName(): string {
    return `agent#${AgentStatics.agentsEver}`;
  }

  currentHeuristicFitness(): number {
    return this.fHeuristicFitness;
  }

  complexity(): number {
    return this.fComplexity;
  }

  setComplexity(value: number): void {
    this.fComplexity = value;
  }

  alive(): boolean {
    return this.fAlive;
  }

  lifeSpan(): LifeSpan {
    return this.fLifeSpan;
  }

  deathByPatch(): boolean {
    return this.fDeathByPatch;
  }

  setDeathByPatch(): void {
    this.fDeathByPatch = true;
  }

  domain(): number {
    return this.fDomain;
  }

  setDomain(id: number): void {
    this.fDomain = id;
  }

  carryRadius(): number {
    return this.fCarryRadius;
  }

  setCarryRadius(radius: number): void {
    this.fCarryRadius = radius;
  }

  carryList(): readonly CarryableLike[] {
    return this.fCarries;
  }

  addListener(listener: AgentListenerLike): void {
    this.listeners.push(listener);
  }

  removeListener(listener: AgentListenerLike): void {
    if (this.fAlive) {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    }
  }

  /** Native `agent::Heal()` — `assert( false )` with the body commented out. */
  heal(): never {
    throw new Error('agent::Heal(): not implemented (native asserts false)');
  }

  /** Native `agent::setGenomeReady()`'s friend: the lifespan record L11/L12 stamp. */
  stampBirth(step: number, reason: BirthReason): void {
    this.fLifeSpan.setBirth(step, reason);
  }

  /** The event sink (native's global `logs`), for lanes that need to raise for an agent. */
  events(): EventSinkLike {
    return this.deps.events;
  }

  // ---------------------------------------------------------------------------
  // the nerve table (native `outputNerves.*`)
  // ---------------------------------------------------------------------------

  outputNervesTable(): AgentOutputNerves {
    return this.outputNerves;
  }

  private eatNerve(): number {
    return this.outputNerves.eat.get();
  }

  private mateNerve(): number {
    return this.outputNerves.mate.get();
  }

  private fightNerve(): number {
    return this.outputNerves.fight.get();
  }

  private speedNerve(): number {
    return this.outputNerves.speed.get();
  }

  private yawNerve(): number {
    return this.outputNerves.yaw.get();
  }

  private yawOpposeNerve(): number {
    return this.outputNerves.yawOppose!.get();
  }

  private lightNerve(): number {
    return this.outputNerves.light!.get();
  }

  private focusNerve(): number {
    return this.outputNerves.focus.get();
  }

  private visionPitchNerve(): number {
    return this.outputNerves.visionPitch!.get();
  }

  private visionYawNerve(): number {
    return this.outputNerves.visionYaw!.get();
  }

  private giveNerve(): number {
    return this.outputNerves.give!.get();
  }
}

/** Native `agent::agentinit()` — the class-level initializer (the polygon load is L15's). */
function agentInit(): void {
  if (AgentStatics.classInited) return;
  AgentStatics.classInited = true;
  AgentStatics.agentsLiving = 0;
}
