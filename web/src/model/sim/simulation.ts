/**
 * Lane L11 (sim) — `TSimulation` (native `library/sim/Simulation.{h,cc}`, 5374 + 588 lines).
 *
 * The step loop and everything it owns: the init phase order, the per-step phase order, the agent
 * update passes, `Interact`'s contact/eat/mate/fight/give passes, `CreateAgents`' regeneration,
 * the fitness/epoch bookkeeping, energy accounting, seeding and lockstep replay, and the end phase.
 *
 * PORT-NOTE(sim/native-field-names): the port keeps native's field names **verbatim** (`fStep`,
 * `fMaxNumAgents`, `fDomains`, `fLowPopulationAdvantageFactor`, …). Lane L8's `SimulationLike`
 * seam is declared in those names, the sim-spec quotes them, and a reviewer can then diff this file
 * against `Simulation.h` field by field. The methods the frozen seams ask for in camelCase
 * (`step()`, `numAgents()`, `fittest(scope)`, …) are declared next to the fields they read.
 *
 * PORT-NOTE(sim/one-definition): the modules this class drives live beside it and own their own
 * native functions — `worldfile.ts` (`processWorldFile` + the three mode-forcing functions),
 * `interact.ts` (`Interact`/`DeathAndStats` + the contact routines), `agents.ts` (`CreateAgents`,
 * `Birth`, `Kill`, `updateFittest`, `AgentFitness`), `maintain.ts` (`MaintainFood`,
 * `MaintainBricks`, `AddFood`, `RemoveFood`, `FoodEnergyIn/Out`). They are functions over this
 * object, exactly as the native member functions are, so the class stays the state and the loop.
 *
 * PORT-NOTE(sim/ctor-seams): native's constructor builds its own `proplib` documents, writes
 * `run/{converted,normalized,original}.wf`, and moves the old `run` aside with `rename`/`mkdir`.
 * The port takes the already-built, already-applied document plus the four artifact texts from the
 * caller (lane W1b's converter / lane L18's boot) and performs the same *writes* through the
 * injected `RecordFileSystem` (lane L12's seam), so a browser run has no `node:fs` and a parity run
 * writes the same bytes in the same order.
 */

import { Agent, agentConfig, Metabolism, Energy, f32, f32Fma, processWorldfile, type AgentDeps, type EventSinkLike } from '../agent';
import type { BodyGeometryLike, SimulationLike as AgentSimulationLike } from '../agent';
import { initBrain, processBrainWorldfile, Brain, brainConfig } from '../brain/core';
import {
  genomeUtil,
  GenomeSchema,
  readGenomeSchemaInputs,
  separationCache,
  type Genome,
} from '../genome';
import { Food, FoodType, Barrier, Brick } from '../environment';
import { globalRngSurface, RandomNumberGenerator, pow } from '../rng';
// Lane W1d's correctly-rounded binary64 `fma` (`libm.ts`) — the barrel re-exports `exp`/`log`/
// `pow` but not `fma`, and `EnergyScaleFactor`'s two branches are both fused in the binary.
import { fma } from '../rng/libm';
import {
  Config,
  globals,
  RngRole,
  RngType,
  type EventType,
  type PropertyNode,
  type SimEvent,
} from '../types';
import {
  Event_None,
  Event_SimInited,
  Event_StepEnd,
  Event_EpochEnd,
  Event_SimEnd,
  BirthReason,
  DeathReason,
  GObjectType,
  MAXDOMAINS,
  MAXFITNESSITEMS,
  MAXMETABOLISMS,
} from '../types';
import { gXSortedObjects, type XSortedObjects } from '../environment';
// Lane W1j/L16's node-side POV renderer (see PORT-NOTE(sim/pov-renderer-for-vision) below).
import { PovScanRenderer } from '../vision';
// Lane L13's brain-function read-back (`openBrainFunctionFile` below re-exports the seam the
// complexity lane takes: native `AbstractFile *`).
import { openBrainFunctionFile as openBrainFunctionBytes, type BrainFunctionFile } from '../complexity';

/** Native `graphics/gobject.h` object-type bits, as the sim's switches name them. */
const AGENTTYPE = GObjectType.AGENT;
const FOODTYPE = GObjectType.FOOD;
const BRICKTYPE = GObjectType.BRICK;
import type { LogContext, LogSimulation, RecordFileSystem } from '../logs';
import { FitnessScope as LogFitnessScope, type LogFitStruct, type LogFittestList, type LogGeneStats } from '../logs';
import {
  asConcreteGenome,
  brainAnalysisParmsOf,
  createLogs,
  createAgentDeps,
  logContext as buildLogContext,
  logEvent,
  setLogViewStep,
  NullAgentPovRenderer,
  type AgentPovRendererSurface,
  SimStage,
} from './bindings';
import { Events } from './events';
import { EatStatistics } from './eatStatistics';
import { FittestList } from './fittestList';
import { GeneStats } from './geneStats';
import { Scheduler } from './scheduler';
import { Stat, StatRecent } from './stats';
import { Domain } from './domain';
import { interact, deathAndStats } from './interact';
import {
  birth as birthAgent,
  createAgents as createAgentsPass,
  kill as killAgent,
} from './agents';
import {
  addFood as addFoodImpl,
  foodEnergyIn as addFoodEnergyIn,
  foodEnergyOut as foodEnergyOutImpl,
  getRandomPatch as pickRandomPatch,
  maintainBricks as maintainBricksPass,
  maintainFood as maintainFoodPass,
  removeFood as removeFoodImpl,
} from './maintain';
import { processWorldFile, initLockstepMode, initFitnessMode, initAdaptivityMode } from './worldfile';
import { statusTextOf } from './statusText';

/** Native `sim::FitnessScope` (`simconst.h:18`) for the class's own `fittest()` accessor. */
export { LogFitnessScope as FitnessScope };

/** Native `TSimulation::AgentBirthType` (`simconst.h:56`). */
export const AgentBirthType = { CREATED: 0, BORN: 1, BORN_VIRTUAL: 2 } as const;
export type AgentBirthType = (typeof AgentBirthType)[keyof typeof AgentBirthType];

/** Native `sim::FitnessWeightType` / `FitnessStatType` / `FoodEnergyStatType`/`Scope`. */
export const FitnessWeightType = { COMPLEXITY: 0, HEURISTIC: 1 } as const;
export const FitnessStatType = { MAX_FITNESS: 0, CURRENT_MAX_FITNESS: 1, AVERAGE_FITNESS: 2 } as const;
export const FoodEnergyStatType = { IN: 0, OUT: 1 } as const;
export const FoodEnergyStatScope = { STEP: 0, TOTAL: 1, AVERAGE: 2 } as const;
export const FightMode = { NORMAL: 0, NULL: 1 } as const;
export const FoodGrowthModel = { MaxRelative: 0, MaxIndependent: 1 } as const;
export const AgentsAreFood = { FALSE: 0, TRUE: 1, TRUE_FIGHT_ONLY: 2 } as const;
export const SheetSynapseTypes: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, 2],
  [1, 1],
  [1, 2],
  [2, 1],
  [2, 2],
];

/**
 * Native `proplib::CppProperties::PropertyMetadata` (`cppprops.h:43-57`) — the shape the status
 * text's tail block reads. `type` carries the native enum (`Dynamic = 0`, `Runtime = 1`);
 * `toString()` is native's own renderer (INT `%d`, FLOAT `%g`, BOOL `True`/`False`).
 *
 * PORT-NOTE(sim/status-text-dynamic-props): lane W1h's cppprops is a build-time step in the port
 * (`docs/specs/cppprops.md`), so the table arrives through the same optional seam that drives
 * `CppProperties::update()`; absent, the block is empty, which is what the recorded scenarios
 * measure.
 */
export interface CppPropertyMetadataView {
  readonly name: string;
  /** Native `PropertyMetadata::Type` — `Dynamic = 0` (`cppprops.h:47-50`). */
  readonly type: number;
  toString(): string;
}

/**
 * Native `proplib::CppProperties` as the sim drives it — the two calls `TSimulation` makes and
 * the metadata table the status text / farm monitor read.
 *
 * Native (`Simulation.cc:599-604`, `:648`, cppprops.cc): `CppProperties::init( docWorldFile,
 * context )` compiles the worldfile's `dyn` set and calls `CppProperties_Init( context )` (which
 * binds every property's storage to its cpp symbol and runs the init bodies), then
 * `CppProperties::update()` runs at the **start** of every `Step()`.
 *
 * PORT-NOTE(sim/cppprops-seam): native compiles + `dlopen`s `run/.cppprops`; the port replaces the
 * compiler with the build-time spec W1h's `extract_cppprops.py` writes and the interpreter that
 * reads it (`tools/cppprops/lib/cppprops.mjs`), injected here. What the interpreter cannot supply
 * is the *engine* half — the live runtime values and the two engine callbacks an unportable body
 * reaches through `UpdateContext { TSimulation *sim; }` (`cppprops.h:32`) — so lane L11 provides
 * it (`sim/cppProperties.ts`) and the sim hands itself over exactly where native hands over
 * `context->sim`: `init( sim )` at the ctor's `InitCppProperties` step, `update( sim )` at the
 * update step. Both are optional: without a set (every recorded oracle scenario — their
 * worldfiles fold every expression at load and carry no `dyn` property) the seam is a no-op.
 */
export interface DynamicPropertySet {
  /**
   * Native `CppProperties_Init`: bind each dynamic property's storage to its cpp symbol and run
   * its init body once (these may call engine functions — `FoodPatchTokenRing::add( … )`).
   */
  init?(sim: Simulation): void;
  /** Native `CppProperties_Update()` — evaluated once per step, before `UpdateAgents`/`Interact`. */
  update(sim: Simulation): void;
  /** Native `CppProperties::getMetadata( &metadata, &count )` — the status text's tail block. */
  getMetadata?(): readonly CppPropertyMetadataView[];
}

/** Native `TSimulation::TSimulation`'s parameters, with the proplib boot hoisted to the caller. */
export interface SimulationOptions {
  /** The built and `apply()`-ed worldfile document (lane W1b's builder). */
  readonly doc: Config;
  /** Native argv path of the worldfile (`worldfile->getPath()`), for `run/original.wf`. */
  readonly worldfilePath: string;
  /** Native argv path of the schema (`./etc/worldfile.wfs`), for `run/original.wfs`. */
  readonly schemaPath: string;
  /** The document writer's output before `apply()` — `run/converted.wf`. */
  readonly convertedWorldfileText: string;
  /** The document writer's output after `apply()` — `run/normalized.wf`. */
  readonly normalizedWorldfileText: string;
  /** The worldfile bytes — `run/original.wf`. */
  readonly originalWorldfileText: string;
  /** The schema bytes — `run/original.wfs`. */
  readonly originalSchemaText: string;
  /** The run tree's file backend (lane L12's seam; `nodeFiles.ts` in node, a map in tests). */
  readonly fs: RecordFileSystem;
  /** Native `CppProperties::init`'s run-time property set — W1h's spec + this lane's engine half
   *  (`sim/cppProperties.ts`; a no-op without it). */
  readonly dynamicProperties?: DynamicPropertySet;
  /** Native `computeAdamiComplexity` (lane L13; only reachable when complexity is on). */
  readonly computeAdamiComplexity?: LogContext['computeAdamiComplexity'];
  /**
   * Native `AbstractFile::open( path, "r" )` for the brain-function files lane L13 reads back
   * in `analyzeBrain`/`AgentFitness` (only reachable when `ComplexityFitnessWeight != 0`).
   * Node passes `readAbstractFileBytes`; a browser shell its own fetch.
   */
  readonly brainFunctionBytes?: (abstractPath: string) => Uint8Array;
  /** Lane L15's body geometry (the real `gpolyobj`); the default is the bundled agent mesh. */
  readonly geometry?: BodyGeometryLike;
  /** Lane L12's event sink; defaults to the process-wide logger registry. */
  readonly events?: EventSinkLike;
  /** Native `AgentPovRenderer::create(...)` — lane L9/L16; a no-op default. */
  readonly povRenderer?: AgentPovRendererSurface;
  /** Native `gstage` — lane L15; a recording default. */
  readonly stage?: SimStage;
  /** Skip the `run` rename/mkdir dance (tests, repeated runs into one tree). */
  readonly keepRunDirectory?: boolean;
}

/** Native `class TSimulation`. */
export class Simulation implements AgentSimulationLike {
  // -----------------------------------------------------------------------
  // native statics (`Simulation.h:61, 97-104`)
  // -----------------------------------------------------------------------

  /** Native `static long fMaxNumAgents` — read by `AgentPovRenderer::create` and the loggers. */
  private static globalMaxNumAgents = 0;
  static get fMaxNumAgents(): number {
    return Simulation.globalMaxNumAgents;
  }

  /** Native `static long fStep` (`Simulation.cc:92`) — 1-based, incremented at the top of `Step`. */
  fStep = 0;

  /** Native `TSimulation::fMaxSteps` (private in native; public here for the runner/tests). */
  fMaxSteps = 0;
  /**
   * Native `int fStepsPerSecond = 0` — a UI pacing value. **It never affects results**
   * (sim-spec PORT-NOTE(steps-per-second)); kept so a reader sees the parameter was considered.
   */
  fStepsPerSecond = 0;
  fEndOnPopulationCrash = false;
  fEnded = false;
  fDumpFrequency = 0;
  fLoadState = false;

  // -----------------------------------------------------------------------
  // population control / energy scaling
  // -----------------------------------------------------------------------

  fNumDepletionSteps = 0;
  fMaxPopulationPenaltyFraction = 0.0;
  fApplyLowPopulationAdvantage = false;
  fLowPopulationAdvantageFactor = 1.0;
  fPopulationPenaltyFraction = 0.0;
  fEnergyBasedPopulationControl = false;
  fPopControlGlobal = false;
  fPopControlDomains = false;
  fPopControlMinFixedRange = 0.0;
  fPopControlMaxFixedRange = 0.0;
  fPopControlMinScaleFactor = 0.0;
  fPopControlMaxScaleFactor = 0.0;
  fGlobalEnergyScaleFactor = 1.0;

  fAllowBirths = false;
  fAllowMinDeaths = false;

  // -----------------------------------------------------------------------
  // epochs / fitness
  // -----------------------------------------------------------------------

  fEpochFrequency = 0;
  fEpoch = 0;

  fFitI = 0;
  fFitJ = 1;
  fMaxFitness = 0.0;
  fAverageFitness = 0.0;
  fPrevAvgFitness = 0.0;
  fNumAverageFitness = 0;
  fTotalHeuristicFitness = 0.0;
  /** Native `agent* fCurrentFittestAgent[MAXFITNESSITEMS]` — heuristic fitness, capacity 5. */
  fCurrentFittestAgent: (Agent | null)[] = new Array(MAXFITNESSITEMS).fill(null);
  fCurrentMaxFitness: number[] = new Array(MAXFITNESSITEMS).fill(0);
  fCurrentFittestCount = 0;
  /** Native `FittestList *fFittest` — complete fitness, genomes stored. */
  fFittest: FittestList | null = null;
  /** Native `FittestList *fRecentFittest` — per-epoch, no genomes. */
  fRecentFittest: FittestList | null = null;
  fFitness1Frequency = 0;
  fFitness2Frequency = 0;
  fTournamentSize = 0;

  // -----------------------------------------------------------------------
  // tallies
  // -----------------------------------------------------------------------

  fNumberAlive = 0;
  fNumberAliveWithMetabolism: number[] = new Array(MAXMETABOLISMS).fill(0);
  fNumberBorn = 0;
  fNumberBornVirtual = 0;
  fNumberDied = 0;
  fNumberDiedAge = 0;
  fNumberDiedEnergy = 0;
  fNumberDiedFight = 0;
  fNumberDiedEat = 0;
  fNumberDiedEdge = 0;
  fNumberDiedSmite = 0;
  fNumberDiedPatch = 0;
  fNumberCreated = 0;
  fNumberCreatedRandom = 0;
  fNumberCreated1Fit = 0;
  fNumberCreated2Fit = 0;
  fNumberFights = 0;
  fBirthDenials = 0;
  fMiscDenials = 0;
  fLastCreated = 0;
  fMaxGapCreate = 0;
  fNumBornSinceCreated = 0;
  fNewLifes = 0;
  fNewDeaths = 0;

  /**
   * Native's file-static `numglobalcreated` (`Simulation.cc:89`) — "needs to be static so we only
   * get warned about influence of global creations once ever". It is **process-wide**, not
   * per-simulation, and `CreateAgents` uses it for the global top-up's genome-source choice.
   */
  private static numglobalcreated = 0;
  static get numGlobalCreated(): number {
    return Simulation.numglobalcreated;
  }
  static set numGlobalCreated(value: number) {
    Simulation.numglobalcreated = value;
  }

  /** Native `numglobalcreated++` from the global top-up: post-increment, returns the new value. */
  bumpNumGlobalCreated(): number {
    Simulation.numglobalcreated++;
    return Simulation.numglobalcreated;
  }

  // -----------------------------------------------------------------------
  // energy accounting
  // -----------------------------------------------------------------------

  fFoodEnergyIn = 0.0;
  fFoodEnergyOut = 0.0;
  fTotalFoodEnergyIn = 0.0;
  fTotalFoodEnergyOut = 0.0;
  fAverageFoodEnergyIn = 0.0;
  fAverageFoodEnergyOut = 0.0;
  fEnergyEaten = new Energy(0);
  fTotalEnergyEaten = new Energy(0);

  /**
   * Native `TSimulation::fFramesPerSecond{Overall,Recent,Instantaneous}` /
   * `fSecondsPerFrame{…}` (`Simulation.h:97-104`) — **UI status only**. Step 6's bookkeeping is
   * deliberately not ported (PORT-NOTE(sim/fps-skipped)): it reads `hirestime()`, and nothing in a
   * frozen artifact depends on it. The six fields exist because `getStatusText` prints them in its
   * `Rate` row; they stay at the native statics' initial value (0.0), which is what the recorded
   * run's own status text shows at step 1 (`Rate 0.0 (0.0) 0.0 (0.0) 0.0 (0.0)`,
   * `oracle/microtest_voff/stdout.txt`) — and lane L14's `StatusTextMonitor` filters every `Rate`
   * line out of `run/stats/**` anyway (`StorePerformance False`).
   */
  fFramesPerSecondOverall = 0.0;
  fSecondsPerFrameOverall = 0.0;
  fFramesPerSecondRecent = 0.0;
  fSecondsPerFrameRecent = 0.0;
  fFramesPerSecondInstantaneous = 0.0;
  fSecondsPerFrameInstantaneous = 0.0;

  // -----------------------------------------------------------------------
  // agents / seeds
  // -----------------------------------------------------------------------

  fMinNumAgents = 0;
  fMinNumAgentsWithMetabolism: number[] = new Array(MAXMETABOLISMS).fill(0);
  fInitNumAgents = 0;
  fNumberToSeed = 0;
  fProbabilityOfMutatingSeeds = 0;
  fRawSeedMutationRate = 0;
  fSeedFromFile = false;
  fSeedFilePaths: string[] = [];
  fPositionSeedsFromFile = false;
  fSeedPositions: { x: number; y: number; z: number }[] = [];
  fPositionSeed = 0;
  fGenomeSeed = 0;
  fSimulationSeed = 0;

  // -----------------------------------------------------------------------
  // interaction parameters
  // -----------------------------------------------------------------------

  fMinMateFraction = 0;
  fEatWait = 0;
  fProbabilisticMating = false;
  fMateWait = 0;
  fMiscAgents = 0;
  fMateThreshold = 0;
  fMaxMateVelocity = 0;
  fMinEatVelocity = 0;
  fMaxEatVelocity = 0;
  fMaxEatYaw = 0;
  fEatMateSpan = 0;
  fEatMateMinDistance = 0;
  fFightThreshold = 0;
  fFightFraction = 0;
  fFightMode: number = FightMode.NORMAL;
  fGiveThreshold = 0;
  fGiveFraction = 0;
  fPickupThreshold = 0;
  fDropThreshold = 0;
  fEatThreshold = 0;
  fEatFitnessParameter = 0;
  fMateFitnessParameter = 0;
  fMoveFitnessParameter = 0;
  fEnergyFitnessParameter = 0;
  fAgeFitnessParameter = 0;
  fEat2Consume = 0;
  fPower2Energy = 0;
  fAgentHealingRate = 0;
  fHealing = false;
  fCarryPreventsEat = 0;
  fCarryPreventsFight = 0;
  fCarryPreventsGive = 0;
  fCarryPreventsMate = 0;
  fSolidObjects = 0;
  fCarryObjects = 0;
  fShieldObjects = 0;
  fAgentsRfood: number = AgentsAreFood.FALSE;

  // -----------------------------------------------------------------------
  // food / bricks / patches
  // -----------------------------------------------------------------------

  fUseProbabilisticFoodPatches = false;
  fFoodRemovalNeeded = false;
  fNumFoodPatches = 0;
  fFoodPatchesNeedingRemoval: unknown[] = [];
  fNumBrickPatches = 0;
  fMinFoodCount = 0;
  fMaxFoodCount = 0;
  fMaxFoodGrownCount = 0;
  fInitFoodCount = 0;
  fFoodRate = 0;
  fFoodGrowthModel: number = FoodGrowthModel.MaxRelative;
  fFoodRemoveEnergy = 0;
  fFoodRemoveFirstEat = false;
  fRandomInitFoodAge = false;
  fFoodPatchOuterRange = 0;
  fMinFoodEnergyAtDeath = 0;

  // -----------------------------------------------------------------------
  // domains / world
  // -----------------------------------------------------------------------

  fNumDomains = 0;
  fDomains: Domain[] = [];
  fGroundClearance = 0;
  fGroundColor = { r: 0, g: 0, b: 0 };
  fFogFunction = 'N';
  fExpFogDensity = 0;
  fLinearFogEnd = 0;
  fStaticTimestepGeometry = false;
  fParallelInitAgents = false;
  fParallelInteract = false;
  fParallelCreateAgents = false;
  fParallelBrains = false;

  // -----------------------------------------------------------------------
  // smiting
  // -----------------------------------------------------------------------

  fSmiteMode = 'O';
  fSmiteFrac = 0;
  fSmiteAgeFrac = 0;
  fNumLeastFit = 0;
  fMaxNumLeastFit = 0;
  fNumSmited = 0;

  // -----------------------------------------------------------------------
  // complexity / events / lockstep / mode forcing
  // -----------------------------------------------------------------------

  fComplexityType = '';
  fCalcComplexity = false;
  fComplexityFitnessWeight = 0;
  fHeuristicFitnessWeight = 0;
  fRandomBirthLocation = false;
  fRandomBirthLocationRadius = 0;
  fCalcFoodPatchAgentCounts = true;
  fAdaptivityMode = false;

  fEvents: Events | null = null;

  fLockStepWithBirthsDeathsLog = false;
  fLockstepFile: unknown = null;
  fLockstepTimestep = 0;
  fLockstepNumDeathsAtTimestep = 0;
  fLockstepNumBirthsAtTimestep = 0;
  /** The remaining lockstep lines, in file order (`SetNextLockstepEvent` parses one at a time). */
  fLockstepLines: string[] = [];
  fLockstepLineIndex = 0;

  // -----------------------------------------------------------------------
  // statistics
  // -----------------------------------------------------------------------

  fLifeSpanStats = new Stat();
  fLifeSpanRecentStats = new StatRecent();
  fLifeFractionRecentStats = new StatRecent();
  fCurrentBrainStats = {
    neuronCount: new Stat(),
    synapseCount: new Stat(),
    groups: { groupCount: new Stat() },
    sheets: {
      internalSheetCount: new Stat(),
      internalNeuronCount: new Stat(),
      synapseCount: [] as Stat[][],
    },
  };

  fEatStatistics = new EatStatistics();
  fGeneStats = new GeneStats();

  // -----------------------------------------------------------------------
  // scheduler, stage, logs, renderer
  // -----------------------------------------------------------------------

  fScheduler = new Scheduler();
  fStage: SimStage;
  fWorldCast: unknown[] = [];
  fWorldSet: unknown[] = [];
  /** Native `AgentPovRenderer *agentPovRenderer` (named for the field; the seam wants a method). */
  fAgentPovRenderer: AgentPovRendererSurface;

  /** Native's global `logs` pointer, as a field. */
  fLogs: ReturnType<typeof createLogs> | null = null;

  // -----------------------------------------------------------------------
  // the port's own wiring (not native fields)
  // -----------------------------------------------------------------------

  readonly fs: RecordFileSystem;
  readonly doc: Config;
  readonly worldfilePath: string;
  readonly schemaPath: string;
  readonly options: SimulationOptions;
  private agentDeps: AgentDeps | null = null;
  /** Native's `run/` rename is skipped when the caller manages the tree. */
  readonly keepRunDirectory: boolean;
  private readonly computeComplexity: LogContext['computeAdamiComplexity'] | undefined;
  /**
   * The run tree's read-back for lane L13 (`SimulationOptions.brainFunctionBytes`) — native's
   * `AbstractFile::open( path, "r" )` over `run/brain/function/brainFunction_<n>.txt`; `undefined`
   * makes that read refuse (see `openBrainFunctionFile`).
   */
  private readonly brainFunctionBytes: ((abstractPath: string) => Uint8Array) | undefined;
  private dynamicProperties: DynamicPropertySet | undefined;

  // =======================================================================
  // construction
  // =======================================================================

  /** Native `TSimulation::TSimulation( worldfilePath, parameters )`. */
  constructor(options: SimulationOptions) {
    this.options = options;
    this.doc = options.doc;
    this.fs = options.fs;
    this.worldfilePath = options.worldfilePath;
    this.schemaPath = options.schemaPath;
    this.keepRunDirectory = options.keepRunDirectory ?? false;
    this.dynamicProperties = options.dynamicProperties;
    // Lane L13 binds `computeAdamiComplexity` by default inside `logContext()` (see
    // PORT-NOTE(l13/adami-binding)); an explicit one still wins.
    this.computeComplexity = options.computeAdamiComplexity;
    this.brainFunctionBytes = options.brainFunctionBytes;

    // Native constructs `fStage` as a member (before the init phases ever touch it).
    this.fStage = options.stage ?? new SimStage();
    this.fAgentPovRenderer = options.povRenderer ?? new NullAgentPovRenderer();

    // --- native ctor steps 1-2: member defaults are the field initializers above; fStep = 0.
    this.fStep = 0;
    this.fNumberAliveWithMetabolism = new Array(MAXMETABOLISMS).fill(0);
    for (let i = 0; i < SheetSynapseTypes.length; i++) {
      // Native allocates `synapseCount[__NTYPES][__NTYPES]`, one `Stat` per (from,to) pair.
      this.fCurrentBrainStats.sheets.synapseCount[i] = [];
      this.fCurrentBrainStats.sheets.synapseCount[i]![i] = new Stat();
    }
    for (const [from, to] of SheetSynapseTypes) {
      this.fCurrentBrainStats.sheets.synapseCount[from] = this.fCurrentBrainStats.sheets.synapseCount[from] ?? [];
      this.fCurrentBrainStats.sheets.synapseCount[from]![to] = new Stat();
    }

    // --- native ctor step 3: `srand(1)` — the model never calls `rand()` except gobject.cc.
    globalRngSurface().srand(1);

    // --- native ctor step 4: rename the old run/ aside, then mkdir run.
    if (!this.keepRunDirectory) this.prepareRunDirectory();

    // --- native ctor steps 5-7: the document is built by the caller (W1b) and already applied;
    //     the writes it performs, in order, are converted.wf then (after apply) the readers.
    this.fs.makeParentDir('run/converted.wf');
    writeText(this.fs, 'run/converted.wf', options.convertedWorldfileText);

    processWorldFile(this, this.doc);
    // Native `agent::processWorldfile( *worldfile )` — lane L8's reader (statically ordered after
    // the sim's own: `agent::config.yawEncoding` decides which output nerves `grow()` creates, and
    // `InitGeneCache`/`processWorldfile` order is not interchangeable).
    processWorldfile(this.doc.doc);
    // Native `GenomeSchema::processWorldfile( *worldfile )`.
    GenomeSchema.processWorldfile(this.doc);
    // Native `Brain::processWorldfile( *worldfile )` (+ Groups/Sheets halves).
    processBrainWorldfile(this.doc);

    // --- native ctor steps 8-10: mode forcing.
    if (this.fLockStepWithBirthsDeathsLog) initLockstepMode(this);
    if (this.fHeuristicFitnessWeight !== 0.0 || this.fComplexityFitnessWeight !== 0) initFitnessMode(this);
    if (this.fAdaptivityMode) initAdaptivityMode(this);

    // --- native ctor step 11: Brain::init(), agent::agentinit(), SeparationCache::init(),
    //     GenomeUtil::createSchema(). (`agent::agentinit()` is the agent class's own lazy
    //     first-construction initializer in the port — see PORT-NOTE(sim/agentinit-lazy).)
    initBrain(brainFlagsFrom(agentConfig));
    separationCache.init();
    genomeUtil.createSchema(readGenomeSchemaInputs(this.doc));

    // --- native ctor step 12: InitCppProperties (the W1h spec's property set, given its engine
    //     context — see PORT-NOTE(sim/cppprops-seam) on `DynamicPropertySet`).
    this.dynamicProperties?.init?.(this);

    // --- native ctor step 13: the food/max radius arithmetic (uses sqrt).
    // `__ZN11TSimulationC2E…` 0x8928c-0x89318:
    //   89294: fsqrt s1, s1          ; sqrtf(minmaxspeed)      — the **float** overload
    //   89298: fdiv  s1, s0, s1      ; maxagentlenx (float)
    //   8929c: fsqrt s2, s2          ; sqrtf(maxmaxspeed)
    //   892a0: fmul  s0, s0, s2      ; maxagentlenz (float)
    //   892a4: fmul  s0, s0, s0      ; f32(malz^2)   <- the one rounded square
    //   892a8: fmadd s0, s1, s1, s0  ; malx^2 + that, ONE rounding
    //   892ac: fsqrt s0, s0
    //   892b0/892b4: fmul × 0.5f
    // The port used to compute the whole radius in binary64 with both squares rounded.
    const maxagentlenx = f32(agentConfig.maxAgentSize / f32(Math.sqrt(agentConfig.minmaxspeed)));
    const maxagentlenz = f32(agentConfig.maxAgentSize * f32(Math.sqrt(agentConfig.maxmaxspeed)));
    const maxagentradius = f32(
      0.5 * f32(Math.sqrt(f32Fma(maxagentlenx, maxagentlenx, f32(maxagentlenz * maxagentlenz)))),
    );
    // Native step 13's *food* half (`Simulation.cc:324-326`), which is three width decisions wide:
    //
    //   float maxfoodlen    = 0.75 * food::gMaxFoodEnergy / food::gSize2Energy;
    //   float maxfoodradius = 0.5 * sqrt(maxfoodlen * maxfoodlen * 2.0);
    //   food::gMaxFoodRadius = maxfoodradius;
    //
    //   (1) `0.75` is a **double** literal, so the product and the division are binary64 and the
    //       store into `float maxfoodlen` narrows **once** (the same shape as `food::initlen`,
    //       `food.ts:311`).
    //   (2) `maxfoodlen * maxfoodlen` is `float * float`: the abstract machine rounds the square
    //       to binary32 **before** the `* 2.0` (which is double, and exact).
    //   (3) `sqrt` is the double overload and `0.5 * …` is double, but the assignment to
    //       `float maxfoodradius` — the value `food::gMaxFoodRadius` holds — narrows again.
    //
    // Measured against the oracle, not read off the run log (`Simulation.cc:1469`'s `%g` carries
    // six significant digits): `src/model/sim/native/foodradiusprobe.cc` boots the real
    // `TSimulation` the way `Polyworld --ui term` does and prints every field as a bit pattern.
    // The recorded tier-A worldfiles resolve `gMaxFoodEnergy = 0x1.f4p+9` (1000) and
    // `gSize2Energy = 0x1.9p+8` (400), both exact, so there (1) and (2) do not separate and only
    // the store's width moves the value:
    //
    //   0.5*sqrt(…) as native computes it   0x1.536948017481p+0  (0x3ff5369480174810)
    //   native's stored `gMaxFoodRadius`    0x1.536948p+0        (0x3fa9b4a4)  <- the float
    //   the port's old stored value                              0x3ff5369480174810  (the double)
    //
    // A probe worldfile (`inexact.wf`: `MaxFoodEnergy 1000.5`, `FoodEnergySizeScale 300.3`) is the
    // case where all three decisions bite: native stores `0x3fe22942` (1.7668840885162354) and the
    // old binary64 spelling narrows to `0x3fe22941` — one ulp below.
    //
    // `gMaxFoodRadius` is model-visible (`agent.cc:1971` divides by it in the carried-food energy
    // conversion, and twice more in the contact walk's prune), so the double form was a real
    // divergence, not a cosmetic one. `PARITY.md`'s L11 Gaps row carries the tabulation.
    const maxfoodlen = f32((0.75 * Food.gMaxFoodEnergy) / Food.gSize2Energy);
    const maxfoodradius = f32(0.5 * Math.sqrt(f32(maxfoodlen * maxfoodlen) * 2.0));
    (Food as unknown as { gMaxFoodRadius: number }).gMaxFoodRadius = maxfoodradius;
    agentConfig.maxRadius = maxagentradius > maxfoodradius ? maxagentradius : maxfoodradius;

    // --- native ctor step 14: InitFittest.
    this.initFittest();

    // --- native ctor step 15: the lockstep banner + file handling (the file itself is read by
    //     the runner through the fs seam; the parsing is `SetNextLockstepEvent`).
    if (this.fLockStepWithBirthsDeathsLog) {
      this.fs.system('cp LOCKSTEP-BirthsDeaths.log run/');
      this.setNextLockstepEvent();
    }

    // --- native ctor step 16.
    this.fStage.setCast(this.fWorldCast);

    // --- native ctor steps 17-19.
    this.fFoodEnergyIn = 0.0;
    this.fFoodEnergyOut = 0.0;
    this.fEnergyEaten.zero();

    // Native step 18: `srand48( fGenomeSeed )` — the model-wide drand48 stream starts here.
    globalRngSurface().srand48(this.fGenomeSeed);

    // Native step 19: `AgentPovRenderer::create( fMaxNumAgents, retinaWidth, retinaHeight )` —
    // built above so `fStage` exists for step 16.
    //
    // PORT-NOTE(sim/pov-renderer-for-vision): native creates the *real* renderer here, after the
    // worldfile has been read (so `Brain::config.vision`/`retinaWidth` are known), and a vision-on
    // run renders through it every step. The port's field is created early — the ctor needs a
    // renderer before the document is read — so a run that has no injected renderer and a
    // worldfile that turns vision **on** swaps in lane L16's node-side POV scanner here. Without
    // that swap `render()` is a no-op, the retina keeps its prebirth noise for the whole run, and
    // a vision-on tree comes out byte-identical to the vision-off tree (t_83dc2e2c). The
    // vision-off path never calls `render()`, so it is untouched; `deps()` is built later (step
    // 23's `InitAgents`), so the agents see the renderer chosen here.
    if (this.options.povRenderer === undefined && agentConfig.vision) {
      this.fAgentPovRenderer = new PovScanRenderer({
        scene: {
          setList: () => this.fWorldSet,
          castList: () => this.fStage.added,
        },
        agentFOV: agentConfig.agentFOV,
        eyeHeight: agentConfig.eyeHeight,
        agentHeight: agentConfig.agentHeight,
        retinaWidth: brainConfig.retinaWidth,
        retinaHeight: brainConfig.retinaHeight,
        worldSize: globals.worldsize,
      });
    }

    // --- native ctor step 20: `logs = new Logs( this, worldfile )`.
    // PORT-NOTE(sim/log-sim-adapter): lane L12's `LogSimulation` names the step *reader* `step()`,
    // while this class's `step()` advances the run (native `TSimulation::Step` vs `getStep()`), so
    // the recorders get a small adapter instead of the instance. Same object, no behaviour change.
    const logEnv = buildLogContext(this.fs, this.computeComplexity);
    this.fLogs = createLogs(this.logSimulationSurface(), this.doc, logEnv);

    // --- native ctor step 21 (`SetMaximumFiles`) is a POSIX rlimit; nothing model-visible.

    // --- native ctor step 22: InitGround (lane L15's polygon load).
    this.initGround();

    // --- native ctor step 23: InitAgents (a master task), then food, bricks, barriers.
    if (!this.fLoadState) {
      this.fScheduler.execMasterTask(() => this.initAgents(), !this.fParallelInitAgents);
      this.initFood();
      this.initBricks();
      this.initBarriers();
    }

    // --- native ctor steps 24-26.
    this.fEatStatistics.init();
    this.fTotalFoodEnergyIn = this.fFoodEnergyIn;
    this.fTotalFoodEnergyOut = this.fFoodEnergyOut;
    this.fTotalEnergyEaten = this.fEnergyEaten.clone();
    this.fAverageFoodEnergyIn = 0.0;
    this.fAverageFoodEnergyOut = 0.0;
    this.fStage.setSet(this.fWorldSet);

    // --- native ctor step 27: complexity event filtering.
    if (this.fCalcComplexity) {
      let eventFiltering = false;
      for (let i = 0; i < this.fComplexityType.length; i++) {
        const ch = this.fComplexityType[i]!;
        if (ch >= 'a' && ch <= 'z') {
          eventFiltering = true;
          break;
        }
      }
      if (eventFiltering) this.fEvents = new Events(this.fMaxSteps);
    }

    // --- native ctor step 28: save the worldfile data to run/, then dispose the documents.
    this.fs.makeParentDir('run/original.wf');
    writeText(this.fs, 'run/original.wf', options.originalWorldfileText);
    writeText(this.fs, 'run/original.wfs', options.originalSchemaText);
    writeText(this.fs, 'run/normalized.wf', options.normalizedWorldfileText);

    // --- native ctor step 29.
    this.postEvent({ type: Event_SimInited } as SimEvent);
  }

  /** Native's `rename("run", "run_<time(NULL)>")` + `mkdir("run")`. */
  private prepareRunDirectory(): void {
    this.fs.makeDirs('run');
  }

  /**
   * Native `agent::agentinit()` (step 11) loads the agent polygon through lane L15's `Resources`
   * and initializes the class statics. The port's agent class initializes its own statics lazily on
   * first construction (`agent.ts` guards with `AgentStatics.classInited`), so this is covered.
   * PORT-NOTE(sim/agentinit-lazy).
   */
  private initGround(): void {
    // Native `Resources::loadPolygons( &fGround, "ground" )` + y/scale/colour + `fWorldSet.Add`.
    // PORT-NOTE(sim/ground-stub): lane L15's polygon loader; nothing in the frozen artifacts reads
    // the ground mesh (it is drawn, never simulated). Gaps row: L15.
  }

  // =======================================================================
  // init phases
  // =======================================================================

  /** Native `TSimulation::InitFittest` (`Simulation.cc:791-815`). */
  initFittest(): void {
    if (this.fSmiteFrac > 0.0) {
      for (let id = 0; id < this.fNumDomains; id++) {
        const domain = this.fDomains[id]!;
        domain.numLeastFit = 0;
        domain.maxNumLeastFit = Math.round(this.fSmiteFrac * domain.maxNumAgents);

        if (domain.maxNumLeastFit > 0) {
          domain.leastFit = new Array(domain.maxNumLeastFit).fill(null);
        } else {
          domain.leastFit = [];
        }
      }
    }
  }

  /** The agent-dependency bundle, built once (native's process-wide statics). */
  deps(): AgentDeps {
    if (this.agentDeps === null) {
      this.agentDeps = createAgentDeps(this, {
        stage: this.fStage,
        povRenderer: this.fAgentPovRenderer,
        geometry: this.options.geometry,
        events: this.options.events,
      }).deps;
    }
    return this.agentDeps;
  }

  /** Native `TSimulation::InitAgents` (`Simulation.cc:833-990`). */
  initAgents(): void {
    let numSeededTotal = 0;

    // --- the per-domain pass
    for (let id = 0; id < this.fNumDomains; id++) {
      let numSeededDomain = 0;

      const limit = Math.min(
        Simulation.fMaxNumAgents - this.objects().getCount(AGENTTYPE),
        this.fDomains[id]!.initNumAgents,
      );
      for (let i = 0; i < limit; i++) {
        let isSeed = false;

        const c = Agent.getFreeAgent(this.deps());
        if (c === null) throw new Error('sim: agent::getfreeagent returned NULL');

        this.fNumberCreated++;
        this.fNumberCreatedRandom++;
        this.fDomains[id]!.numcreated++;

        if (numSeededDomain < this.fDomains[id]!.numberToSeed) {
          isSeed = true;
          this.seedGenome(c, this.fDomains[id]!.probabilityOfMutatingSeeds, numSeededDomain + numSeededTotal);
          numSeededDomain++;
        } else {
          asGenomeOf(c).randomize();
        }

        c.setGenomeReady();

        // Native POST PARALLEL: `c->grow( fMateWait, true )`.
        this.fScheduler.postParallel(() => {
          c.grow(this.fMateWait, true);
        });

        this.fStage.addObject(c as never);

        const point = this.fDomains[id]!.initAgentsPatch!.setPoint();
        const x = point.x;
        const z = point.z;
        const y = Math.fround(0.5 * agentConfig.agentHeight);
        if (isSeed) {
          this.setSeedPosition(c, numSeededDomain + numSeededTotal - 1, x, y, z);
        } else {
          setAgentTranslation(c, x, y, z);
        }
        c.saveLastPosition();

        const yaw = Math.fround(360.0 * this.randpw());
        c.setYaw(yaw);

        this.objects().add(c as never);

        // PORT-NOTE(sim/sched-init-grow-boundary): native posts `c->grow(...)` to the thread pool
        // *and then* inserts `c` into the x-sorted list in the same master-loop iteration
        // (`Simulation.cc:875` vs `:906`). The pool runs concurrently with the master thread, so by
        // the time the next agent is created every earlier agent has its grown radius, while the
        // agent being inserted still has `fRadius = 0` (`gobject`'s ctor) and its key is therefore
        // `x()` alone. That is measurable: measured with the native build itself
        // (`src/model/sim/native/simprobe.cc`, mode `boot`) the boot list of the recorded
        // `microtest_voff` world is `3, 6, 11, 12, 23, 1, 14, 20, …, 9` — not key order
        // (`6, 3, …`) — and the golden's `run/events/collisions.log` (emitted by the *pre-sort*
        // body pass, `Simulation.cc:1433-1445`) prints `1 3 edge` before `1 6 edge`. Deferring the
        // whole batch to the end of the master task (the scheduler's default for a step) gives the
        // key-order list and the golden's lifespans/separations/collisions row order is off by one
        // pair.
        this.fScheduler.drainParallel();

        c.setDomain(id);
        this.fDomains[id]!.numAgents++;

        // Native POST SERIAL: `FoodEnergyIn( c->GetFoodEnergy() )`.
        this.fScheduler.postSerial(() => {
          this.foodEnergyIn(c.foodEnergy());
        });

        this.birth(c, BirthReason.SIMINIT);
      }

      numSeededTotal += numSeededDomain;
    }

    // --- the global top-up
    if (this.fInitNumAgents > Simulation.fMaxNumAgents) {
      throw new Error('sim: fInitNumAgents > fMaxNumAgents (native asserts)');
    }

    while (this.objects().getCount(AGENTTYPE) < this.fInitNumAgents) {
      let isSeed = true;

      const c = Agent.getFreeAgent(this.deps());

      this.fNumberCreated++;
      this.fNumberCreatedRandom++;

      if (numSeededTotal < this.fNumberToSeed) {
        isSeed = true;
        this.seedGenome(c, this.fProbabilityOfMutatingSeeds, numSeededTotal);
        numSeededTotal++;
      } else {
        asGenomeOf(c).randomize();
      }

      c.setGenomeReady();

      this.fScheduler.postParallel(() => {
        c.grow(this.fMateWait, true);
      });

      this.fStage.addObject(c as never);

      const x = Math.fround(0.01 + this.randpw() * (globals.worldsize - 0.02));
      const z = Math.fround(-0.01 - this.randpw() * (globals.worldsize - 0.02));
      const y = Math.fround(0.5 * agentConfig.agentHeight);
      if (isSeed) {
        this.setSeedPosition(c, numSeededTotal - 1, x, y, z);
      } else {
        setAgentTranslation(c, x, y, z);
      }

      const yaw = Math.fround(360.0 * this.randpw());
      c.setYaw(yaw);

      this.objects().add(c as never);

      // PORT-NOTE(sim/sched-init-grow-boundary) — the same boundary as the per-domain loop above.
      this.fScheduler.drainParallel();

      const id = this.whichDomain(x, z, 0);
      c.setDomain(id);
      this.fDomains[id]!.numAgents++;

      this.fScheduler.postSerial(() => {
        this.foodEnergyIn(c.foodEnergy());
      });

      this.birth(c, BirthReason.SIMINIT);
    }
  }

  /** Native `TSimulation::InitFood` (`Simulation.cc:995-1018`). */
  initFood(): void {
    for (let domainNumber = 0; domainNumber < this.fNumDomains; domainNumber++) {
      const domain = this.fDomains[domainNumber]!;
      domain.numFoodPatchesGrown = 0;

      for (let foodPatchNumber = 0; foodPatchNumber < domain.numFoodPatches; foodPatchNumber++) {
        const patch = domain.foodPatches[foodPatchNumber]!;
        if (patch.isOn()) {
          for (let j = 0; j < patch.initFoodCount; j++) {
            if (domain.foodCount < domain.maxFoodCount) {
              this.addFood(domainNumber, foodPatchNumber);
            }
          }
          patch.setInitFoodGrown(true);
          domain.numFoodPatchesGrown++;
        }
      }
    }
  }

  /** Native `TSimulation::InitBricks` (`Simulation.cc:1023-1033`). */
  initBricks(): void {
    for (let domainNumber = 0; domainNumber < this.fNumDomains; domainNumber++) {
      const domain = this.fDomains[domainNumber]!;
      for (let brickPatchNumber = 0; brickPatchNumber < domain.numBrickPatches; brickPatchNumber++) {
        domain.brickPatches[brickPatchNumber]!.updateOn();
      }
    }
  }

  /** Native `TSimulation::InitBarriers` (`Simulation.cc:1038-1045`). */
  initBarriers(): void {
    Barrier.gXSortedBarriers.reset();
    for (;;) {
      const b = Barrier.gXSortedBarriers.next();
      if (b === null) break;
      this.fWorldSet.push(b);
    }
  }

  /** Native `TSimulation::SeedGenome` (`Simulation.cc:1051-1069`). */
  seedGenome(agent: Agent, probabilityOfMutatingSeeds: number, numSeeded: number): void {
    if (this.fSeedFromFile) {
      this.seedGenomeFromFile(agent, numSeeded);
    } else {
      genomeUtil.seed(asGenomeOf(agent), globalRngSurface());
    }

    // The draw happens for every seed, whether or not the test succeeds.
    if (this.randpw() < probabilityOfMutatingSeeds) {
      asGenomeOf(agent).mutate();
    }
    asGenomeOf(agent).mutateRate(this.fRawSeedMutationRate);
  }

  /**
   * Native `TSimulation::SeedGenomeFromFile` (`Simulation.cc:1075-1097`). The file input is lane
   * L17/L2's (`seedSynapsePath`'s sibling); no recorded scenario sets `SeedGenomeFromRun`, so the
   * port fails loudly rather than guessing a byte format. Gaps row: L17.
   */
  seedGenomeFromFile(agent: Agent, numSeeded: number): void {
    void agent;
    void numSeeded;
    throw new Error(
      'sim: SeedGenomeFromRun is set but the seed-file input (genomeSeeds.txt + Genome::load) ' +
        'belongs to lanes L17/L2 and is not bound; no recorded scenario uses it — see PARITY.md -> Gaps',
    );
  }

  /** Native `TSimulation::SetSeedPosition` (`Simulation.cc:1138-1158`). */
  setSeedPosition(a: Agent, numSeeded: number, x: number, y: number, z: number): void {
    let posX = x;
    let posY = y;
    let posZ = z;

    if (this.fPositionSeedsFromFile) {
      throw new Error(
        'sim: SeedPositionFromRun is set but seedPositions.txt belongs to lane L17 and is not bound; ' +
          'no recorded scenario uses it — see PARITY.md -> Gaps',
      );
    }

    a.setX(posX);
    a.setY(posY);
    a.setZ(posZ);
  }

  // =======================================================================
  // the step
  // =======================================================================

  /** Native `TSimulation::Step` (`Simulation.cc:560-739`). */
  step(): void {
    // Native's `frame` is a function-static: it is 0 only on the first call ever.
    if (Simulation.frames === 0 && this.fSimulationSeed !== 0) {
      globalRngSurface().srand48(this.fSimulationSeed);
    }
    Simulation.frames++;

    if (this.fMaxSteps && this.fStep + 1 > this.fMaxSteps) {
      this.end('MaxSteps');
      return;
    } else if (this.fEndOnPopulationCrash && this.objects().getCount(AGENTTYPE) <= this.fMinNumAgents) {
      this.end('PopulationCrash');
      return;
    }

    this.fStep++;

    // Native step 6: FPS bookkeeping. PORT-NOTE(sim/fps-skipped): the FPS fields are UI status only
    // (sim-spec §11.3: "no log file or model decision reads them"), so the port does not read the
    // clock here — reading it would be a wall-clock dependency in the model.

    // Native step 7: the max-gap-create tallies.
    if (this.fStep - this.fLastCreated > this.fMaxGapCreate && this.fLastCreated > 0) {
      this.fMaxGapCreate = this.fStep - this.fLastCreated;
    }
    if (this.fNumDomains > 1) {
      for (let id = 0; id < this.fNumDomains; id++) {
        const domain = this.fDomains[id]!;
        if (this.fStep - domain.lastcreate > domain.maxgapcreate && domain.lastcreate > 0) {
          domain.maxgapcreate = this.fStep - domain.lastcreate;
        }
      }
    }

    // Native step 8.
    this.fFoodEnergyIn = 0.0;
    this.fFoodEnergyOut = 0.0;
    this.fEnergyEaten.zero();

    // Native step 9: `proplib::CppProperties::update()`.
    if (this.dynamicProperties) this.dynamicProperties.update(this);

    // Native step 10: barriers update + xsort.
    Barrier.gXSortedBarriers.reset();
    for (;;) {
      const b = Barrier.gXSortedBarriers.next();
      if (b === null) break;
      b.update();
    }
    Barrier.gXSortedBarriers.xsort();

    // Native step 11.
    this.maintainEnergyCosts();

    // Native step 12: the agent update passes.
    this.fAgentPovRenderer.beginStep();
    if (this.fStaticTimestepGeometry) {
      this.updateAgentsStaticTimestepGeometry();
    } else {
      this.updateAgents();
    }
    this.fAgentPovRenderer.endStep();

    // Native step 13: `execMasterTask( Interact, !fParallelInteract )`.
    this.fScheduler.execMasterTask(() => interact(this), !this.fParallelInteract);

    // Native step 14.
    if (this.fNumberAlive !== this.objects().getCount(AGENTTYPE)) {
      throw new Error(
        `sim: fNumberAlive (${this.fNumberAlive}) != x-sorted agent count ` +
          `(${this.objects().getCount(AGENTTYPE)}) at step ${this.fStep} (native asserts)`,
      );
    }

    // Native step 15.
    if (this.fNumAverageFitness > 0) {
      this.fAverageFitness /= this.fNumAverageFitness * this.fTotalHeuristicFitness;
    }

    // Native step 16: `execMasterTask( CreateAgents, !fParallelCreateAgents )`.
    this.fScheduler.execMasterTask(() => this.createAgents(), !this.fParallelCreateAgents);

    // Native steps 17-18.
    this.maintainBricks();
    this.maintainFood();

    // Native step 19. `TSimulation::Step` 0x93174-0x93180: `fadd.2s` on the
    // {fTotalFoodEnergyIn, fTotalFoodEnergyOut} / {fFoodEnergyIn, fFoodEnergyOut} float pairs,
    // with a narrowing `str d0` back into the float fields — a float add and a float store,
    // not a binary64 accumulator.
    this.fTotalFoodEnergyIn = f32(this.fTotalFoodEnergyIn + this.fFoodEnergyIn);
    this.fTotalFoodEnergyOut = f32(this.fTotalFoodEnergyOut + this.fFoodEnergyOut);
    this.fTotalEnergyEaten.addAssign(this.fEnergyEaten);

    // Native step 20. `TSimulation::Step` 0x9319c-0x931bc (the vectorised float pair):
    //   931b0: dup.2s v1, v1[0]        ; {f32(fStep), f32(fStep)}
    //   931b4: fmla.2s v3, v2, v0[0]   ; avg * f32(fStep-1) + foodIn, ONE rounding
    //   931b8: fdiv.2s v0, v3, v1      ; / f32(fStep)
    //   931bc: str d0, [x9]            ; narrowing store into the float pair
    this.fAverageFoodEnergyIn = f32(
      f32Fma(Math.fround(this.fStep - 1), this.fAverageFoodEnergyIn, this.fFoodEnergyIn) / Math.fround(this.fStep),
    );
    this.fAverageFoodEnergyOut = f32(
      f32Fma(Math.fround(this.fStep - 1), this.fAverageFoodEnergyOut, this.fFoodEnergyOut) / Math.fround(this.fStep),
    );

    // Native step 21: `stepEnding()` — the monitors (lane L14) hang off the signal.
    if (this.stepEnding) this.stepEnding();

    // Native step 22: the epoch block (event first, then fEpoch, then the recent list).
    if (this.fEpochFrequency && this.fStep % this.fEpochFrequency === 0) {
      this.postEvent({ type: Event_EpochEnd, epoch: this.fStep } as SimEvent);
      this.fEpoch += this.fEpochFrequency;
      this.fRecentFittest!.clear();
    }

    // Native step 23.
    this.postEvent({ type: Event_StepEnd } as SimEvent);
  }

  /** Native `static unsigned long frame` inside `Step()`. */
  private static frames = 0;

  /** The monitor hook (native `util::Signal<> stepEnding`); the shell/runner attaches. */
  stepEnding: (() => void) | null = null;
  /** The end hook (native `util::Signal<> ended`). */
  ended: (() => void) | null = null;

  /** Native `TSimulation::UpdateAgents` (`Simulation.cc:1369-1395`). */
  updateAgents(): void {
    const list = this.objects();
    list.reset();
    for (;;) {
      const a = list.nextObj(AGENTTYPE) as Agent | null;
      if (a === null) break;

      a.updateVision();
      a.updateBrain();
      if (!a.beingCarried()) {
        this.fFoodEnergyOut += a.updateBody(
          this.fMoveFitnessParameter,
          agentConfig.speed2DPosition,
          this.fSolidObjects,
          null,
        );
      }
    }
  }

  /** Native `TSimulation::UpdateAgents_StaticTimestepGeometry` (`Simulation.cc:1401-1446`). */
  updateAgentsStaticTimestepGeometry(): void {
    this.fScheduler.execMasterTask(() => {
      this.fStage.compile();
      const list = this.objects();
      list.reset();
      for (;;) {
        const a = list.nextObj(AGENTTYPE) as Agent | null;
        if (a === null) break;

        a.updateVision();

        this.fScheduler.postParallel(() => {
          a.updateBrain();
        });
      }
      this.fStage.decompile();
    }, !this.fParallelBrains);

    // --- the body pass, always serial, in x order.
    const list = this.objects();
    list.reset();
    for (;;) {
      const a = list.nextObj(AGENTTYPE) as Agent | null;
      if (a === null) break;
      if (!a.beingCarried()) {
        this.fFoodEnergyOut += a.updateBody(
          this.fMoveFitnessParameter,
          agentConfig.speed2DPosition,
          this.fSolidObjects,
          null,
        );
      }
    }
  }

  // =======================================================================
  // delegated phases (native member functions, kept in the modules that own them)
  // =======================================================================

  /** Native `TSimulation::CreateAgents`. */
  createAgents(): void {
    createAgentsPass(this);
  }

  /** Native `TSimulation::DeathAndStats`. */
  deathAndStats(): void {
    deathAndStats(this);
  }

  /** Native `TSimulation::MaintainBricks`. */
  maintainBricks(): void {
    maintainBricksPass(this);
  }

  /** Native `TSimulation::MaintainFood`. */
  maintainFood(): void {
    maintainFoodPass(this);
  }

  /** Native `TSimulation::Birth`. */
  birth(a: Agent | null, reason: BirthReason, parent1: Agent | null = null, parent2: Agent | null = null): void {
    birthAgent(this, a, reason, parent1, parent2);
  }

  /** Native `TSimulation::Kill`. */
  kill(c: Agent, reason: DeathReason): void {
    killAgent(this, c, reason);
  }

  /** Native `TSimulation::AddFood` (`maintain.ts` owns the body). */
  addFood(domainNumber: number, patchNumber: number): void {
    addFoodImpl(this, domainNumber, patchNumber);
  }

  /** Native `TSimulation::FoodEnergyIn`. */
  foodEnergyIn(e: Energy): void {
    addFoodEnergyIn(this, e);
  }

  /** Native `TSimulation::FoodEnergyOut`. */
  foodEnergyOut(e: Energy): void {
    foodEnergyOutImpl(this, e);
  }

  /** Native `TSimulation::RemoveFood`. */
  removeFood(f: Food): void {
    removeFoodImpl(this, f);
  }

  /** Native `TSimulation::getRandomPatch`. */
  getRandomPatch(domainNumber: number): number {
    return pickRandomPatch(this, domainNumber);
  }

  // =======================================================================
  // population control / energy
  // =======================================================================

  /**
   * Native `TSimulation::EnergyScaleFactor` (`Simulation.cc:1246-1271`).
   *
   * PORT-NOTE(L11/energy-scale-factor-float-quotient): the shipped code does the quotient in
   * **float** and keeps the double only after it. Disassembled
   * (`__ZN11TSimulation17EnergyScaleFactorElll`, `libpolyworld.dylib`):
   * `scvtf s0,x9` + `scvtf s1,x8` + `fdiv s0,s0,s1` + `fcvt d0,s0` @0x96fdc-0x96fe8 (bottom
   * branch) and @0x97034-0x97044 (top branch) — i.e. `double( float(botFixedRange - numAgents) /
   * float(botFixedRange - minAgents) )`, not a double quotient of the same operands. The two
   * branches then fuse (`fmsub d0,d1,d0,d2` @0x96ff8, `fmadd d0,d1,d0,d2` @0x97064) and the top
   * branch calls **Apple's libm `pow`** (`bl _pow` @0x97050) — `Math.pow` is V8's own and
   * disagrees with it (`src/model/rng/native/README.md`: 387 of 4 471 vectors), so lane W1d's
   * transcribed `pow` is the one to call.
   *
   * Model-visible through `agent::damage`'s `double scaleFactor` (which is narrowed to `float`
   * there) — it is what `run/events/energy.log`'s per-step damage amounts read.
   */
  energyScaleFactor(minAgents: number, maxAgents: number, numAgents: number): number {
    let scaleFactor = 1.0;

    const topFixedRange = minAgents + Math.round(this.fPopControlMaxFixedRange * (maxAgents - minAgents));
    const botFixedRange = minAgents + Math.round(this.fPopControlMinFixedRange * (maxAgents - minAgents));

    if (numAgents < botFixedRange) {
      const fraction = f32(f32(botFixedRange - numAgents) / f32(botFixedRange - minAgents));
      scaleFactor = fma(this.fPopControlMinScaleFactor - 1.0, fraction, 1.0); // `fmsub`, fused
      if (scaleFactor < 0.0) scaleFactor = 0.0;
    } else if (numAgents > topFixedRange) {
      const fraction = f32(f32(numAgents - topFixedRange) / f32(maxAgents - topFixedRange));
      const fractionReduced = pow(fraction, 4.0); // Apple's libm `pow`, not `Math.pow`
      scaleFactor = fma(this.fPopControlMaxScaleFactor - 1.0, fractionReduced, 1.0); // `fmadd`
    }

    return scaleFactor;
  }

  /** Native `TSimulation::MaintainEnergyCosts` (`Simulation.cc:1277-1363`). */
  maintainEnergyCosts(): void {
    if (this.fEnergyBasedPopulationControl) {
      if (this.fPopControlGlobal) {
        const numAgents = this.objects().getCount(AGENTTYPE);
        this.fGlobalEnergyScaleFactor = this.energyScaleFactor(
          this.fMinNumAgents,
          Simulation.globalMaxNumAgents,
          numAgents,
        );
      }

      if (this.fPopControlDomains) {
        if (this.fNumDomains > 1 || !this.fPopControlGlobal) {
          for (let i = 0; i < this.fNumDomains; i++) {
            const domain = this.fDomains[i]!;
            domain.energyScaleFactor = this.energyScaleFactor(
              domain.minNumAgents,
              domain.maxNumAgents,
              domain.numAgents,
            );
          }
        }
      }
      return;
    }

    if (this.fApplyLowPopulationAdvantage || this.fNumDepletionSteps) {
      let numAgents = this.objects().getCount(AGENTTYPE);
      let initNumAgents = this.fInitNumAgents;
      let minNumAgents = this.fMinNumAgents + Math.round(0.1 * (this.fInitNumAgents - this.fMinNumAgents));
      let maxNumAgents = Simulation.globalMaxNumAgents;
      let excess = numAgents - this.fInitNumAgents;

      // Use the *lowest* excess to produce the most help or the least penalty.
      if (this.fNumDomains > 1) {
        for (let id = 0; id < this.fNumDomains; id++) {
          const domain = this.fDomains[id]!;
          const domainExcess = domain.numAgents - domain.initNumAgents;
          if (domainExcess < excess) {
            numAgents = domain.numAgents;
            initNumAgents = domain.initNumAgents;
            minNumAgents = domain.minNumAgents + Math.round(0.1 * (domain.initNumAgents - domain.minNumAgents));
            maxNumAgents = domain.maxNumAgents;
            excess = domainExcess;
          }
        }
      }

      if (excess < 0) {
        this.fPopulationPenaltyFraction = 0.0;
        if (this.fApplyLowPopulationAdvantage) {
          this.fLowPopulationAdvantageFactor =
            1.0 - (initNumAgents - numAgents) / Math.fround(initNumAgents - minNumAgents);
          if (this.fLowPopulationAdvantageFactor < 0.0) this.fLowPopulationAdvantageFactor = 0.0;
          if (this.fLowPopulationAdvantageFactor > 1.0) this.fLowPopulationAdvantageFactor = 1.0;
        }
      } else if (excess > 0) {
        this.fLowPopulationAdvantageFactor = 1.0;
        this.fPopulationPenaltyFraction =
          (this.fMaxPopulationPenaltyFraction * (numAgents - initNumAgents)) / (maxNumAgents - initNumAgents);
        if (this.fPopulationPenaltyFraction < 0.0) this.fPopulationPenaltyFraction = 0.0;
        if (this.fPopulationPenaltyFraction > this.fMaxPopulationPenaltyFraction) {
          this.fPopulationPenaltyFraction = this.fMaxPopulationPenaltyFraction;
        }
      }
    }
  }

  // =======================================================================
  // domains
  // =======================================================================

  /** Native `TSimulation::WhichDomain` (`Simulation.cc:4809-4833`). */
  whichDomain(x: number, z: number, d: number): number {
    for (let i = 0; i < this.fNumDomains; i++) {
      const domain = this.fDomains[i]!;
      if (x >= domain.startX && x <= domain.endX && z >= domain.startZ && z <= domain.endZ) return i;
    }

    const ranges = [];
    for (let i = 0; i < this.fNumDomains; i++) {
      const domain = this.fDomains[i]!;
      ranges.push(
        `  ${i}: ranging over x = (${fmt(domain.startX)} -> ${fmt(domain.endX)}) and ` +
          `z = (${fmt(domain.startZ)} -> ${fmt(domain.endZ)})`,
      );
    }
    throw new Error(
      `sim: WhichDomain failed to find any domain for point at (x, z) = (${x}, ${z}) & d, nd = ${d}, ` +
        `${this.fNumDomains}\n${ranges.join('\n')} (native error(2) aborts)`,
    );
  }

  /** Native `TSimulation::SwitchDomain` (`Simulation.cc:4841-4866`). */
  switchDomain(newDomain: number, oldDomain: number, objectType: number): void {
    if (newDomain === oldDomain) return;

    switch (objectType) {
      case AGENTTYPE:
        this.fDomains[newDomain]!.numAgents++;
        this.fDomains[oldDomain]!.numAgents--;
        break;
      case FOODTYPE:
        this.fDomains[newDomain]!.foodCount++;
        this.fDomains[oldDomain]!.foodCount--;
        break;
      case BRICKTYPE:
        // Domains do not currently keep track of brick counts.
        break;
      default:
        throw new Error(`sim: SwitchDomain: unknown object type ${objectType}`);
    }
  }

  // =======================================================================
  // the end phase
  // =======================================================================

  /** Native `TSimulation::End` (`Simulation.cc:744-759`). */
  end(reason: string): void {
    if (this.fEnded) return;
    this.fEnded = true;

    writeText(this.fs, 'run/endReason.txt', `${reason}\n`);
    this.postEvent({ type: Event_SimEnd } as SimEvent);

    if (this.ended) this.ended();
  }

  /** Native `TSimulation::EndAt` (`Simulation.cc:766-776`) — a non-empty string means an error. */
  endAt(timestep: number): string {
    if (timestep < this.fStep) return 'Invalid end timestep. Simulation already beyond.';
    this.fMaxSteps = timestep;
    return '';
  }

  /**
   * Native `TSimulation::~TSimulation` (`Simulation.cc:479-554`).
   *
   * PORT-NOTE(sim/simend-kills): every survivor is killed with `DR_SIMEND` here, and those deaths
   * are *logged model events* (the golden `lifespans.txt` contains 23 `SIMEND` rows), so this is not
   * cleanup — it is the last phase of the run.
   */
  dispose(): void {
    const list = this.objects();
    list.reset();
    for (;;) {
      const a = list.nextObj(AGENTTYPE) as Agent | null;
      if (a === null) break;
      this.kill(a, DeathReason.SIMEND);
    }

    this.fLogs?.dispose();
    this.fLogs = null;

    // Native deletes every barrier here; the port drops the list — lane L10's `Barrier` holds no
    // resource to release and the objects become unreachable with the list.
    Barrier.gXSortedBarriers.clear();

    // PORT-NOTE(sim/destructor-list-clear): native calls `gXSortedObjects.clear()` here. Lane L10's
    // list exposes no `clear` (its objects are removed one by one), and nothing after this point
    // reads the list, so the port leaves the container to the garbage collector.
    list.reset();

    this.fStage.clear();

    for (let id = 0; id < this.fNumDomains; id++) {
      this.fDomains[id]!.leastFit = [];
    }
    this.fFittest = null;
    this.fRecentFittest = null;

    writeText(this.fs, 'run/endStep.txt', `${this.fStep}\n`);
  }

  // =======================================================================
  // accessors: the frozen log seam (`LogSimulation`) and lane L8's `SimulationLike`
  // =======================================================================

  /** The `LogSimulation` adapter lane L12's recorders are constructed with (see the ctor note). */
  logSimulationSurface(): LogSimulation {
    return {
      step: () => this.fStep,
      epoch: () => this.fEpoch,
      numAgents: () => this.fNumberAlive,
      maxAgents: () => Simulation.globalMaxNumAgents,
      geneStats: () => this.fGeneStats,
      fittest: (scope: LogFitnessScope) => this.fittest(scope),
      enableComplexityCalculations: () => {
        this.enableComplexityCalculations();
      },
    };
  }

  /** Native `TSimulation::getStep()` — the reader half (the class's `step()` advances the run). */
  getStepNumber(): number {
    return this.fStep;
  }

  /** Native `TSimulation::getEpoch()`. */
  epoch(): number {
    return this.fEpoch;
  }

  /** Native `TSimulation::getNumAgents( domain = -1 )`. */
  numAgents(domain = -1): number {
    if (domain === -1) return this.fNumberAlive;
    return this.fDomains[domain]!.numAgents;
  }

  /**
   * PORT-NOTE(sim/monitor-accessor-aliases): lane L14's `MonitorSim` seam
   * (`src/model/monitor/simSurface.ts`) declares the native *spellings* — `getStep()`,
   * `getNumAgents()`, `GetMaxAgents()`, `GetAgentPovRenderer()` — with the deliberate note that
   * "METHOD NAMES ARE NATIVE'S, including their inconsistencies (`getNumBorn` vs `GetNumDomains`)",
   * while the port's own class uses the JS-style names this lane settled on early (`getStepNumber`,
   * `numAgents`, `maxAgents`). The four aliases below are the native spellings over the same
   * accessors, so the sim satisfies `MonitorSim` **structurally** (`implements` is checked by
   * `tsc`) instead of the runner hand-adapting the object.
   */
  getNumAgents(domain = -1): number {
    return this.numAgents(domain);
  }

  /** Native `TSimulation::GetMaxAgents()`. */
  GetMaxAgents(): number {
    return this.maxAgents();
  }

  /** Native `TSimulation::getStep()`. */
  getStep(): number {
    return this.getStepNumber();
  }

  /** Native `TSimulation::GetAgentPovRenderer()`. */
  GetAgentPovRenderer(): AgentPovRendererSurface {
    return this.getAgentPovRenderer();
  }

  /** Native `TSimulation::GetMaxAgents()`. */
  maxAgents(): number {
    return Simulation.globalMaxNumAgents;
  }

  /** Native `TSimulation::GetInitNumAgents()`. */
  getInitNumAgents(): number {
    return this.fInitNumAgents;
  }

  /** Native `TSimulation::GetNumDomains()`. */
  getNumDomains(): number {
    return this.fNumDomains;
  }

  /** Native `TSimulation::GetMaxSteps()`. */
  getMaxSteps(): number {
    return this.fMaxSteps;
  }

  /** Native `TSimulation::GetStepsPerSecond()`. */
  getStepsPerSecond(): number {
    return this.fStepsPerSecond;
  }

  /** Native `TSimulation::getNumBorn( AgentBirthType )`. */
  getNumBorn(type: AgentBirthType): number {
    switch (type) {
      case AgentBirthType.CREATED:
        return this.fNumberCreated;
      case AgentBirthType.BORN:
        return this.fNumberBorn;
      case AgentBirthType.BORN_VIRTUAL:
        return this.fNumberBornVirtual;
      default:
        throw new Error(`sim: getNumBorn: unknown AgentBirthType ${String(type)}`);
    }
  }

  /** Native `TSimulation::getFittest( scope )`. */
  fittest(scope: LogFitnessScope): LogFittestList {
    const list = scope === LogFitnessScope.OVERALL ? this.fFittest : this.fRecentFittest;
    if (list === null) throw new Error('sim: getFittest: that list does not exist (native dereferences NULL)');
    return list;
  }

  /** The port's typed form of `getFittest` for the sim's own callers. */
  fittestList(scope: LogFitnessScope): FittestList | null {
    return scope === LogFitnessScope.OVERALL ? this.fFittest : this.fRecentFittest;
  }

  /** Native `TSimulation::getAgentByNumber( number )` (`Simulation.h:500-509`). */
  getAgentByNumber(number: number): Agent | null {
    const list = this.objects();
    list.reset();
    for (;;) {
      const a = list.nextObj(AGENTTYPE) as Agent | null;
      if (a === null) break;
      if (a.number() === number) return a;
    }
    return null;
  }

  /** Native `TSimulation::getCurrentFittest( rank )` (`Simulation.h:510-519`). */
  getCurrentFittest(rank: number): Agent | null {
    if (rank === 0) throw new Error('sim: getCurrentFittest( 0 ) (native asserts rank != 0)');
    if (rank < 0) {
      if (rank + this.fCurrentFittestCount >= 0) {
        return this.fCurrentFittestAgent[rank + this.fCurrentFittestCount] ?? null;
      }
    } else if (rank <= this.fCurrentFittestCount) {
      return this.fCurrentFittestAgent[rank - 1] ?? null;
    }
    return null;
  }

  /** Native `TSimulation::getFitnessWeight( type )` (`Simulation.h:521-529`). */
  getFitnessWeight(type: number): number {
    switch (type) {
      case FitnessWeightType.COMPLEXITY:
        return this.fComplexityFitnessWeight;
      case FitnessWeightType.HEURISTIC:
        return this.fHeuristicFitnessWeight;
      default:
        throw new Error(`sim: getFitnessWeight: unknown type ${type}`);
    }
  }

  /** Native `TSimulation::getFitnessStat( type )` (`Simulation.h:531-540`). */
  getFitnessStat(type: number): number {
    switch (type) {
      case FitnessStatType.MAX_FITNESS:
        return this.fMaxFitness;
      case FitnessStatType.CURRENT_MAX_FITNESS:
        return this.fCurrentMaxFitness[0]!;
      case FitnessStatType.AVERAGE_FITNESS:
        return this.fAverageFitness;
      default:
        throw new Error(`sim: getFitnessStat: unknown type ${type}`);
    }
  }

  /** Native `TSimulation::getFoodEnergyStat( type, scope )` (`Simulation.h:541-565`). */
  getFoodEnergyStat(type: number, scope: number): number {
    if (type === FoodEnergyStatType.IN) {
      if (scope === FoodEnergyStatScope.STEP) return this.fFoodEnergyIn;
      if (scope === FoodEnergyStatScope.TOTAL) return this.fTotalFoodEnergyIn;
      if (scope === FoodEnergyStatScope.AVERAGE) return this.fAverageFoodEnergyIn;
    } else if (type === FoodEnergyStatType.OUT) {
      if (scope === FoodEnergyStatScope.STEP) return this.fFoodEnergyOut;
      if (scope === FoodEnergyStatScope.TOTAL) return this.fTotalFoodEnergyOut;
      if (scope === FoodEnergyStatScope.AVERAGE) return this.fAverageFoodEnergyOut;
    }
    throw new Error(`sim: getFoodEnergyStat: unknown type/scope ${type}/${scope}`);
  }

  /**
   * Native `TSimulation::getFoodEnergy()` (`Simulation.h:566-576`).
   *
   * PORT-NOTE(sim/food-energy-float-accumulation): native declares `float foodEnergy = 0.0f` and
   * accumulates with `+=` inside the loop, so **every step of the sum is narrowed to binary32**
   * before the next one (`Energy::sum()` is a `float` too). The status text prints this value
   * (`foodEnergy = %.1f`, a frozen byte in `run/stats/stat.1`), and the port's double accumulator
   * differed from the native float chain in its last bits.
   */
  getFoodEnergy(): number {
    let foodEnergy = 0.0;
    const list = this.objects();
    list.reset();
    for (;;) {
      const f = list.nextObj(FOODTYPE) as Food | null;
      if (f === null) break;
      foodEnergy = Math.fround(foodEnergy + f.getEnergy().sum());
    }
    return foodEnergy;
  }

  /** Native `TSimulation::getGeneStats()`. */
  geneStats(): LogGeneStats {
    return this.fGeneStats;
  }

  /** Native `TSimulation::getGeneStats()` in the sim's own type. */
  geneStatsRef(): GeneStats {
    return this.fGeneStats;
  }

  /** Native `TSimulation::enableComplexityCalculations()` (`Simulation.h:462`). */
  enableComplexityCalculations(): void {
    this.fCalcComplexity = true;
  }

  /**
   * Native `AbstractFile::open( path, "r" )` as lane L13's two reads use it — `analyzeBrain`'s
   * complexity calculation and `AgentFitness`'s lazy re-read of the same file.
   *
   * PORT-NOTE(sim/brain-function-read-seam): native opens the path `BrainFunctionLog` recorded in
   * `c->brainAnalysisParms.functionPath` (or rebuilds `run/brain/function/brainFunction_<n>.txt`
   * from the agent's number) with the run's *auto-detecting* `AbstractFile::open( path, "r" )`,
   * which probes the `.gz` sibling first — so the reader is injected
   * (`SimulationOptions.brainFunctionBytes`: `readAbstractFileBytes` in node) rather than reached
   * through `fs`, which is a write-only `RecordFileSystem`. A shell that injects no reader
   * **refuses** here: native `exit(1)`s on a failed open, and a zero would be recorded into
   * `run/brain/Recent/<epoch>/complexity_<type>.plt` and folded into the agent's fitness.
   */
  openBrainFunctionFile(abstractPath: string): BrainFunctionFile {
    const read = this.brainFunctionBytes;
    if (read === undefined) {
      throw new Error(
        `sim: cannot read '${abstractPath}' back for the complexity calculation (native ` +
          `AbstractFile::open( path, "r" )): this Simulation was built without ` +
          '`brainFunctionBytes` — see SimulationOptions',
      );
    }
    return openBrainFunctionBytes(read(abstractPath));
  }

  /** Native `TSimulation::GetAgentHealingRate()`. */
  getAgentHealingRate(): number {
    return this.fAgentHealingRate;
  }

  /** Native `TSimulation::getStage()`. */
  getStage(): SimStage {
    return this.fStage;
  }

  /**
   * Native `TSimulation::getStatusText( StatusText& statusText, int statusFrequency )`
   * (`Simulation.cc:4870-5230`) — **appends** the run's status lines to `statusText`, exactly as
   * native does (lane L14's `StatusTextMonitor` clears the vector first, `Monitor.cc:288-292`).
   *
   * The transcription lives in `statusText.ts`; this method is the native call shape the monitor
   * lane's `MonitorSim` seam asks for.
   */
  getStatusText(statusText: string[], statusFrequency: number): void {
    statusTextOf(this, statusText, statusFrequency);
  }

  /** Native `proplib::CppProperties::getMetadata()` as the status text reads it (see the PORT-NOTE). */
  cppPropertiesMetadata(): readonly CppPropertyMetadataView[] {
    return this.dynamicProperties?.getMetadata?.() ?? [];
  }

  /** Native `TSimulation::GetAgentPovRenderer()`. */
  getAgentPovRenderer(): AgentPovRendererSurface {
    return this.fAgentPovRenderer;
  }

  /** Lane L8's `SimulationLike.agentPovRenderer()`. */
  agentPovRenderer(): AgentPovRendererSurface {
    return this.fAgentPovRenderer;
  }

  /** Native `TSimulation::EnergyFitnessParameter()` (lane L8's seam). */
  energyFitnessParameter(): number {
    return this.fEnergyFitnessParameter;
  }

  /** Native `TSimulation::AgeFitnessParameter()` (lane L8's seam). */
  ageFitnessParameter(): number {
    return this.fAgeFitnessParameter;
  }

  /** Native `TSimulation::LifeFractionRecent()`. */
  lifeFractionRecent(): number {
    return this.fLifeFractionRecentStats.mean();
  }

  /** Native `TSimulation::LifeFractionSamples()`. */
  lifeFractionSamples(): number {
    return this.fLifeFractionRecentStats.samples();
  }

  /** Native `TSimulation::isLockstep()`. */
  isLockstep(): boolean {
    return this.fLockStepWithBirthsDeathsLog;
  }

  /** Native `TSimulation::SetNextLockstepEvent` (`Simulation.cc:5303-5362`). */
  setNextLockstepEvent(): void {
    if (!this.fLockStepWithBirthsDeathsLog) {
      throw new Error(
        "sim: SetNextLockstepEvent() called but 'fLockStepWithBirthsDeathsLog' is not set (native exits)",
      );
    }

    this.fLockstepNumDeathsAtTimestep = 0;
    this.fLockstepNumBirthsAtTimestep = 0;

    // --- native `fgets`: read the next line, or leave the counters at zero at EOF.
    if (this.fLockstepLineIndex >= this.fLockstepLines.length) return;
    const firstLine = this.fLockstepLines[this.fLockstepLineIndex]!;
    this.fLockstepTimestep = atoi(strtokFirst(firstLine));
    if (!(this.fLockstepTimestep > 0)) {
      throw new Error(`sim: lockstep line has a non-positive timestep: '${firstLine}' (native asserts)`);
    }

    let lineIndex = this.fLockstepLineIndex;
    let nexttimestep = 0;
    do {
      nexttimestep = 0;

      // The tokens of the current line, from the one after the timestep.
      const tokens = strtokFields(this.fLockstepLines[lineIndex]!);
      for (let t = 1; t < tokens.length; t++) {
        const event = tokens[t]![0]!;
        if (event === 'B') {
          this.fLockstepNumBirthsAtTimestep++;
        } else if (event === 'D') {
          this.fLockstepNumDeathsAtTimestep++;
        } else if (event === 'C') {
          this.fLockstepNumBirthsAtTimestep++;
          // Native warns on stderr and treats a CREATION as a random BIRTH.
        } else {
          throw new Error(
            `sim: SetNextLockstepEvent: only DEATH, BIRTH and CREATION events are supported ` +
              `(latest event: '${event}') — native exits`,
          );
        }
      }

      // `currentpos = ftell(...)`, then peek the next line's timestep.
      lineIndex++;
      if (lineIndex < this.fLockstepLines.length) {
        nexttimestep = atoi(strtokFirst(this.fLockstepLines[lineIndex]!));
      }
    } while (this.fLockstepTimestep === nexttimestep);

    // Native seeks back to the start of the first line of the *next* timestep.
    this.fLockstepLineIndex = lineIndex;
  }

  /** Native `TSimulation::END`'s last phase helper: the step the run stopped after. */
  getRunSteps(): number {
    return this.fStep;
  }

  /** Native `TSimulation::GetMaxAgents()` — a static in native, a getter here for the runner. */
  static getMaxAgents(): number {
    return Simulation.globalMaxNumAgents;
  }

  /** The worldfile sets the static; exposed so `worldfile.ts` writes one place. */
  static setMaxNumAgents(value: number): void {
    Simulation.globalMaxNumAgents = value;
  }

  /** Instance form of `setMaxNumAgents` — what `processWorldFile` calls (native `fMaxNumAgents = ...`). */
  setStaticMaxNumAgents(value: number): void {
    Simulation.globalMaxNumAgents = value;
  }

  /** Native `TSimulation::glFogFunction()` / `glExpFogDensity()` / `glLinearFogEnd()`. */
  glFogFunction(): string {
    return this.fFogFunction;
  }
  glExpFogDensity(): number {
    return this.fExpFogDensity;
  }
  glLinearFogEnd(): number {
    return this.fLinearFogEnd;
  }

  // =======================================================================
  // small helpers the port needs
  // =======================================================================

  /** Native `randpw()` — `drand48()` on the process-wide stream (lane L1). */
  randpw(): number {
    return globalRngSurface().drand48();
  }

  /** Native `objectxsortedlist::gXSortedObjects` (lane L10's process-wide singleton). */
  objects(): XSortedObjects {
    return gXSortedObjects;
  }

  /** Native `logs->postEvent( e )`. */
  postEvent(event: SimEvent): void {
    // PORT-NOTE(sim/log-view-names) (`bindings.ts`): the recorders read L12's own spellings
    // (`typeNumber()`, `brain()`, `brainAnalysisParms`), so the event crosses that seam through
    // `logEvent`'s views — the same adaptation lane L8's own event sink applies to its events.
    // PORT-NOTE(sim/log-view-step): native's `TSimulation::fStep` is a static, so `Brain`'s dumps
    // read it directly; the port publishes the current step to the views here.
    setLogViewStep(this.fStep);
    const logged = logEvent(event);
    if (this.fLogs) {
      this.fLogs.postEvent(logged as never);
      return;
    }
    this.options.events?.postEvent(logged as SimEvent<unknown, unknown, Energy>);
  }

  /** Whether the run has a logger set installed (native's global `logs` is non-null). */
  hasLogs(): boolean {
    return this.fLogs !== null;
  }
}

// ===========================================================================
// module-level helpers
// ===========================================================================

/** Native `gobject::settranslation( x, y, z )` — the port's kinematic setters hold the same three
 * `fPosition` slots. PORT-NOTE(sim/settranslation-via-setters): lane L8's agent keeps the position
 * fields and `setX/setY/setZ` are native's `setx/sety/setz` (each storing through `f32`, as native
 * does), so a translation is three of them; there is no separate `settranslation` in the port.
 */
function setAgentTranslation(a: Agent, x: number, y: number, z: number): void {
  a.setX(x);
  a.setY(y);
  a.setZ(z);
}

/** The agent's concrete genome (lane L5) behind lane L8's narrow `GenomeLike`. */
function asGenomeOf(agent: Agent): Genome {
  // Lane L8 keeps `GenomeLike` (name -> value) behind `agent.genes()`; the concrete `Genome` the
  // sim mutates/seeds is the object that seam wraps (see `bindings.ts`'s `AgentGenomeAdapter`).
  return asConcreteGenome(agent.genes());
}

/** Native `atoi( strtok( line, " " ) )` — the leading integer of a lockstep line. */
function strtokFirst(line: string): string {
  return strtokFields(line)[0] ?? '';
}

/** Native `strtok( line, " " )` — the non-empty fields of a lockstep line, in order. */
function strtokFields(line: string): string[] {
  return line.split(' ').filter((field) => field.length > 0);
}

/** Native `atoi`. */
function atoi(text: string): number {
  const match = /^\s*[+-]?\d+/.exec(text);
  return match === null ? 0 : Number.parseInt(match[0], 10);
}

/** Native `agent::config`'s brain flags (lane L6's `initBrain` argument). */
function brainFlagsFrom(config: typeof agentConfig) {
  return {
    enableMateWaitFeedback: config.enableMateWaitFeedback,
    enableSpeedFeedback: config.enableSpeedFeedback,
    enableCarry: config.enableCarry,
    yawEncodingIsOppose: config.yawEncoding === 1,
    hasLightBehavior: config.hasLightBehavior,
    enableVisionPitch: config.enableVisionPitch,
    enableVisionYaw: config.enableVisionYaw,
    enableGive: config.enableGive,
  };
}

/** Native `ofstream` + `<<` — a text write through lane L12's file seam. */
function writeText(fs: RecordFileSystem, path: string, text: string): void {
  fs.makeParentDir(path);
  const sink = fs.openPlain(path, 'w');
  sink.printf(text);
  sink.close();
}

/** Native `%f` for the WhichDomain diagnostic (`printf( "%f" )`). */
function fmt(value: number): string {
  return value.toFixed(6);
}
