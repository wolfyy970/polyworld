/**
 * Lane L11 (sim) — the lane's bindings: the concrete side of every seam lane L8's
 * `agent/contracts.ts` declares, plus the two graphics-ish objects the model keeps (`gstage`,
 * `AgentPovRenderer`) as no-ops until the graphics lanes land.
 *
 * PORT-NOTE(sim/bind-dont-reimplement): each binding below is one adapter over a module another
 * lane owns (L5 genome, L6 brain, L10 environment, L12 logs, L15 graphics). Nothing here
 * re-implements model behaviour: the adapters translate a *name* (native call -> port method) and,
 * in one place, the direction constants of the x-sorted list (see
 * PORT-NOTE(sim/direction-constants)).
 *
 * PORT-NOTE(sim/direction-constants): native `utils/objectxsortedlist.h:4-5` defines `NEXT 1` and
 * `PREV 2`; lane L8's `contracts.ts` declares the same two values, so this adapter is a typed
 * pass-through (`anotherObj( direction, … )` forwards L8's direction unchanged).
 *
 * PORT-NOTE(sim/graphics-stubs): `SimStage` and `NullAgentPovRenderer` are the two objects
 * native's `TSimulation` owns from `graphics/gstage` and `agent/AgentPovRenderer`. Neither touches
 * the model unless vision rendering is on (the oracle scenarios run `Vision False`, where
 * `agent::UpdateVision()` is a no-op and no retina renderer is consulted), so the port keeps them
 * as recording no-ops behind a Gaps row naming L9/L15/L16.
 *
 * PORT-NOTE(sim/geometry-binding): `BodyGeometryLike` (lane L15's `gpolyobj`) is model-visible:
 * `agent::setlen()`'s bounding box over the scaled polygon sets the agent's collision radius
 * (`fRadius`, `fCarryRadius`), so a run cannot be byte-exact without the real mesh. Lane L15
 * landed it (`src/model/geometry/body.ts`: the `pw1` loader + `AgentBodyGeometry` over the
 * verbatim `etc/objects/agent.obj` bundled in `golden/nativeBodyMesh.ts`), so this bundle binds
 * the real object — `options.geometry` still overrides it for a lane test.
 *
 * PORT-NOTE(sim/cns-rng-adapter): native `NervousSystem` holds a `RandomNumberGenerator` created
 * for the `NERVOUS_SYSTEM` role; lane L6's `NervousSystem` takes the frozen `RngSurface` instead.
 * The adapter routes `drand48`/`nrand` to the role object's `drand()`/`nrand()` (LOCAL: MT19937 +
 * `gsl_ran_ugaussian`; GLOBAL: `drand48`), and `srand48` to the role's `seed()` (native
 * `RandomNumberGenerator::seed`). The three calls the role object cannot serve (`rand`, `srand`,
 * `lrand48`) throw: nothing in the model reaches them through this stream, and a silent zero would
 * be a divergence with no message.
 */

import { createComputeAdamiComplexity } from '../complexity';
import {
  Agent,
  agentConfig,
  Energy,
  GObject,
  Metabolism,
  type AgentDeps,
  type BarrierLike,
  type BarrierListLike,
  type BodyGeometryLike,
  type BrickStaticsLike,
  type EventSinkLike,
  type FoodStaticsLike,
  type GenomeLike,
  type NervousSystemLike,
  type NervousSystemRngLike,
  type NerveLike,
  type SortedObjectListLike,
} from '../agent';
import {
  Brain,
  GroupsBrain,
  InjectedBrainRng,
  NervousSystem,
  brainConfig,
  NeurGroupType,
  NeuronType,
  sprintfC,
  type BrainTextFile,
  type CValue,
  type GroupsGenomeView,
  type Nerve,
  type Sensor,
} from '../brain/core';
import { VisionRetina } from '../vision';
import { genomeUtil, type Genome, type GroupsGenome } from '../genome';
import { RandomNumberGenerator, createMt19937Stream, globalRngSurface } from '../rng';
import { RngRole, type Config, type Mt19937Stream, type RngSurface, type SimEvent } from '../types';
import {
  Event_AgentBirth,
  Event_AgentDeath,
  Event_AgentGrown,
  Event_BodyUpdated,
  Event_BrainAnalysisBegin,
  Event_BrainAnalysisEnd,
  Event_BrainGrown,
  Event_BrainUpdated,
  Event_Carry,
  Event_Collision,
  Event_ContactBegin,
  Event_Energy,
} from '../types';
import { Barrier, Brick, Food, FoodType, gXSortedObjects, NEXT as LIST_NEXT, PREV as LIST_PREV, type GoObject } from '../environment';
import { Logs, postEvent, type LogContext, type LogSimulation } from '../logs';
import { retinaFactory } from './retinaSensor';
import { bodyGeometry, agentBodyTemplate } from './bodyGeometry';
import {
  Signal,
  type ControllerCamera,
  type CppPropertyMetadataProvider,
  type FarmRunner,
  type MonitorSim,
  type MovieWriter,
  type SceneRendererSurface,
  type TrackedAgent,
  type TrackedAgentCamera,
} from '../monitor';
import type { Simulation } from './simulation';

//===========================================================================
// graphics stand-ins
//===========================================================================

/**
 * Native `graphics/gstage` (lane L15). The model needs `AddObject`/`RemoveObject`; the display-list
 * calls are the stage's own and are no-ops here (Gaps: L15).
 */
export class SimStage {
  readonly added: GoObject[] = [];
  readonly removed: GoObject[] = [];

  /** Native `gstage::AddObject`. */
  addObject(obj: GoObject): void {
    this.added.push(obj);
  }

  /** Native `gstage::RemoveObject`. */
  removeObject(obj: GoObject): void {
    const index = this.added.indexOf(obj);
    if (index >= 0) this.added.splice(index, 1);
    this.removed.push(obj);
  }

  /** Native `gstage::Compile()` — display lists; nothing model-visible. */
  compile(): void {}

  /** Native `gstage::Decompile()`. */
  decompile(): void {}

  /** Native `gstage::Clear()`. */
  clear(): void {
    this.added.length = 0;
    this.removed.length = 0;
  }

  /** Native `gstage::SetCast( TCastList * )` — the camera cast (lane L15). */
  setCast(_cast: unknown): void {}

  /** Native `gstage::SetSet( TSetList * )` — the object set (lane L15). */
  setSet(_set: unknown): void {}
}

/**
 * Native `agent/AgentPovRenderer` — the per-agent POV buffer. Lane L9/L16 owns the real ones (the
 * batched WebGL2 atlas, and the node-side `PovScanRenderer` in `vision/povScan.ts`). A vision-off
 * run only ever calls `beginStep`/`endStep` (Simulation step 12) and `add`
 * (`agent::getfreeagent`); a vision-on run with no renderer would keep the retina's prebirth
 * noise forever — the defect `t_83dc2e2c` fixed. Gaps row: L9/L16.
 */
export interface AgentPovRendererSurface {
  add(agent: unknown): void;
  remove(agent: unknown): void;
  beginStep(): void;
  render(agent: unknown): void;
  endStep(): void;
}

/** The do-nothing `AgentPovRenderer` (a vision-off run's, or a lane test's). */
export class NullAgentPovRenderer implements AgentPovRendererSurface {
  beginStep(): void {}
  render(_agent: unknown): void {}
  endStep(): void {}
  add(_agent: unknown): void {}
  remove(_agent: unknown): void {}
}

/**
 * Native `class agent`'s body geometry (`gpolyobj`) is bound from lane L15
 * (`src/model/geometry/body.ts`, PORT-NOTE(sim/geometry-binding)); the throwing stand-in this
 * file used to carry is gone. `SimulationOptions.geometry` still injects a substitute for a lane
 * test. See the `createAgentDeps` bundle below for the two objects it binds.
 */

//===========================================================================
// genome -> brain view (the adapter PARITY.md's Gaps row assigns to L11)
//===========================================================================

/**
 * Lane L5's `GroupsGenome` as lane L6's `GroupsGenomeView`.
 *
 * PORT-NOTE(sim/genome-view-adapter): this is the adapter the Gaps table assigns to the first
 * caller (`agent` -> `NervousSystem` -> `genome->createBrain(cns)`). It is a *rename*, not
 * arithmetic: every method forwards to the L5 accessor of the same native function, so the gene
 * arithmetic stays in one place. Gene values are returned as the `float` native's `Scalar` holds,
 * with one exception: the two RNG-seed genes are `long`-ranged and read through
 * `namedGeneValue`'s `asInt()` (PORT-NOTE(sim/rng-seed-gene-long-read)).
 */
export class GroupsGenomeViewAdapter implements GroupsGenomeView {
  readonly synapseTypeEE: GroupsGenomeView['synapseTypeEE'];
  readonly synapseTypeEI: GroupsGenomeView['synapseTypeEI'];
  readonly synapseTypeIE: GroupsGenomeView['synapseTypeIE'];
  readonly synapseTypeII: GroupsGenomeView['synapseTypeII'];

  constructor(private readonly genome: GroupsGenome) {
    this.synapseTypeEE = genome.EE;
    this.synapseTypeEI = genome.EI;
    this.synapseTypeIE = genome.IE;
    this.synapseTypeII = genome.II;
  }

  groupCount(): number {
    // Native `getGroupCount( NeurGroupType::ANY )`.
    return this.genome.getGroupCount(NeurGroupType.ANY);
  }

  maxGroupCount(type: NeurGroupType): number {
    return this.genome.getSchema().getMaxGroupCount(type);
  }

  groupType(group: number): NeurGroupType {
    return this.genome.getSchema().getNeurGroupType(group);
  }

  groupName(group: number): string {
    return this.genome.getSchema().getGroupGene(group).name;
  }

  neuronCount(type: NeuronType, group: number): number {
    return this.genome.getNeuronCount(type, group);
  }

  neuronCountTotal(group: number): number {
    return this.genome.getNeuronCountOfGroup(group);
  }

  orderedGroups(): readonly number[] {
    return this.genome.getOrderedGroups();
  }

  synapseCount(type: GroupsGenomeView['synapseTypeEE'], from: number, to: number): number {
    return this.genome.getSynapseCount(type as GroupsGenome['EE'], from, to);
  }

  synapseCountTotal(from: number, to: number): number {
    return this.genome.getSynapseCountOfGroups(from, to);
  }

  groupGeneValue(gene: string, group: number): number {
    const geneDef = this.genome.getSchema().get(gene);
    if (!geneDef) throw new Error(`sim: genome has no gene '${gene}'`);
    return this.genome.getGroupAttr(geneDef, group).asFloat();
  }

  synapseGeneValue(gene: string, type: GroupsGenomeView['synapseTypeEE'], from: number, to: number): number {
    const geneDef = this.genome.getSchema().get(gene);
    if (!geneDef) throw new Error(`sim: genome has no gene '${gene}'`);
    return this.genome.getSynapseAttr(geneDef, type as GroupsGenome['EE'], from, to).asFloat();
  }

  namedValue(name: string): number {
    return this.genome.get(name).asFloat();
  }

  /**
   * Native `get( seedGene, synapseType, from, to )` for the two RNG-seed genes.
   *
   * PORT-NOTE(sim/rng-seed-gene-long-read): native reads these as `long td_seed =
   * _genome->get( td_seedGene, … )` (`GroupsBrain.cc:696,704`), i.e. `Scalar::operator
   * long()` -> `operator int()`, which asserts the scalar is an `INT` — the two genes are
   * `long`-ranged in the schema for exactly that reason
   * (PORT-NOTE(genome/rng-seed-gene-int)). `.asFloat()` here would both throw on the `INT`
   * scalar and, before the schema fix, silently narrow an f32 to the seed. `asInt()` is the
   * native conversion. Unlike the neighbouring float genes, this one has no float branch.
   */
  namedGeneValue(name: string, type: GroupsGenomeView['synapseTypeEE'], from: number, to: number): number {
    const geneDef = this.genome.getSchema().get(name);
    if (!geneDef) throw new Error(`sim: genome has no gene '${name}'`);
    return this.genome.getSynapseAttr(geneDef, type as GroupsGenome['EE'], from, to).asInt();
  }
}

//===========================================================================
// the agent dependency bundle
//===========================================================================

/** Native `GenomeUtil::createGenome()` / `GenomeUtil::getMetabolism( genome )` (lane L5). */
export function genomeFactory(): AgentDeps['genomeFactory'] {
  return {
    createGenome: () => new AgentGenomeAdapter(genomeUtil.createGenome(false, globalRngSurface())),
    getMetabolism: (genome) => {
      const index = genomeUtil.getMetabolismIndex(
        asConcreteGenome(genome),
        Metabolism.getNumberOfDefinitions(),
      );
      return Metabolism.require(index);
    },
  };
}

/**
 * Native `genome::Genome *` as lane L8's narrow `GenomeLike` (name -> value), keeping the concrete
 * `Genome` reachable for the sim's own uses (fittest-list copies, gene statistics, the brain view).
 */
export class AgentGenomeAdapter implements GenomeLike {
  constructor(readonly genome: Genome) {}

  /** Native `get<T>( name )` for a float/bit/byte gene (`Scalar` -> float). */
  get(name: string): number {
    return this.genome.get(name).asFloat();
  }

  /** Native `get<T>( name )` for a `long` gene (`InitGeneCache` stores `LifeSpan` in a `long`). */
  getLong(name: string): number {
    return this.genome.get(name).asInt();
  }

  /** Native `Genome::mateProbability( other )`. */
  mateProbability(other: { get(name: string): number }): number {
    return this.genome.mateProbability(asConcreteGenome(other));
  }
}

/** The concrete `Genome` behind an L8/L5 seam value (the same object at runtime). */
export function asConcreteGenome(genome: unknown): Genome {
  if (genome instanceof AgentGenomeAdapter) return genome.genome;
  return genome as Genome;
}

//===========================================================================
// lane L12's log views (the naming half of that seam)
//===========================================================================

/**
 * PORT-NOTE(sim/log-view-names): lane L12's `seams.ts` names its collaborators after the native
 * call site with the `get` prefix dropped (`gobject::getTypeNumber()` → `typeNumber()`,
 * `food::getType()` → `type()`), and names two `agent` members that native exposes otherwise —
 * `agent::GetBrain()` → `brain()`, and the public member `agent::brainAnalysisParms`. Lanes L8 and
 * L10 kept the native spellings (`getTypeNumber()`, `getType()`, `getNervousSystem().getBrain()`)
 * and no agent owns a `brainAnalysisParms`. The sim is the fan-in lane that builds every event, so
 * it binds the two here (PORT-NOTE(sim/bind-dont-reimplement) — adapters translate a name, they do
 * not re-implement model behaviour). Reported to lane L12 in PARITY.md → Open questions.
 *
 * PORT-NOTE(sim/log-view-identity): L12 keys its per-agent writers by **the object it is handed**
 * (`createWriterFor( e.a, … )` / `getWriterFor( a )`, native `AgentAttachedData`), so a view must
 * be the same object every time — `logAgent()` memoizes per agent in a `WeakMap`. A fresh wrapper
 * per event would lose every per-agent file at the first `StepEnd`.
 *
 * PORT-NOTE(sim/log-view-type-ambiguity): native's `getType()` means two different things
 * depending on the *static* type of the pointer: in `CarryLog` `e.obj` is a `gobject *`, so
 * `getType()` is the object-type bit (`"A"`/`"F"`/`"B"`), while `FoodConsumptionLog`/
 * `FoodEnergyLog` hold a `food *` and `getType()` is the `FoodType`. Lane L10 dodged the C++
 * name-hiding trap by keeping `getType()` = the bit and naming the `FoodType` accessor `getType_()`.
 * One JS object cannot answer both, so the sim hands the carry path a `LogGameObject` view and the
 * food paths a `LogFood` view.
 */

/** Native `agent::brainAnalysisParms` (`agent/agent.h:271`); `BrainFunctionLog` writes the path. */
export interface LogBrainAnalysisParms {
  functionPath: string;
}

const agentViews = new WeakMap<object, object>();
const energyViews = new WeakMap<object, object>();
const brainAnalysisParms = new WeakMap<object, LogBrainAnalysisParms>();

/** Native `Energy` as lane L12's `LogEnergy` (`at(i)` is native's `operator[]`, `sum()` its own). */
function logEnergy(raw: object): object {
  let view = energyViews.get(raw);
  if (view === undefined) {
    const energy = raw as { sum(): number; get(index: number): number };
    view = { sum: () => energy.sum(), at: (index: number) => energy.get(index) };
    energyViews.set(raw, view);
  }
  return view;
}

/**
 * Native `agent` as lane L12's `LogAgent`, over lane L8's agent. The view is `Object.create`d from
 * the agent so every member L12 and the agent lane agree on (`number()`, `x()`, `lifeSpan()`, …)
 * is reached unchanged; only the renamed/missing members are own properties.
 */
export function logAgent(raw: object): object {
  let view = agentViews.get(raw);
  if (view === undefined) {
    const agent = raw as {
      number(): number;
      getType(): number;
      getTypeNumber(): number;
      genes(): unknown;
      getNervousSystem(): { getBrain(): unknown };
      energy(): object;
      foodEnergy(): object;
      maxEnergy(): object;
    };
    const created: Record<string, unknown> = Object.create(raw) as unknown as Record<string, unknown>;
    created['type'] = () => agent.getType();
    created['typeNumber'] = () => agent.getTypeNumber();
    // PORT-NOTE(sim/log-view-shadowing): the view is `Object.create(agent)`, so an own property
    // here **shadows** a same-named state field the agent's own prototype methods read through
    // `this`. Lane L8 reads `this.typeNumber` twice — `agent::Number()`
    // (`agent.cc` `Number()`, the agent-identity every recorder file name is built from) and
    // `getTypeNumber()` — so the `typeNumber` method above made `view.number()` return the
    // *function*: measured as `SeparationCache::getEntries: agent ()=>agent.getTypeNumber() has no
    // slot` (`separationCache.ts:58`) on the first `StepEnd` of microtest_voff. The identity is
    // therefore bound explicitly, by closing over the agent instead of letting `this` resolve to
    // the view. Only `typeNumber` is read as a field by the agent's own methods; the other own
    // properties below (`genes`, `brain`, `energy`, …) are method names, not state.
    created['number'] = () => agent.number();
    // Native `agent::Genes()` is the concrete `Genome` (the brain view's `dump`/`getRawUint`/
    // `separation` live there), not lane L8's narrow `GenomeLike`.
    created['genes'] = () => logGenome(asConcreteGenome(agent.genes()));
    // Native `agent::GetBrain()` — lane L8 exposes it as `getNervousSystem().getBrain()`.
    created['brain'] = () => logBrain(agent.getNervousSystem().getBrain() as object);
    created['energy'] = () => logEnergy(agent.energy());
    created['foodEnergy'] = () => logEnergy(agent.foodEnergy());
    created['maxEnergy'] = () => logEnergy(agent.maxEnergy());
    created['brainAnalysisParms'] = brainAnalysisParmsOf(raw);
    view = created;
    agentViews.set(raw, view);
  }
  return view;
}

/**
 * The per-agent `brainAnalysisParms` box (native's `agent::brainAnalysisParms` member, written by
 * lane L12's `BrainFunctionLog` and read by `TSimulation::analyzeBrain` under complexity). Native
 * keeps it on the agent; no port agent owns the field, so the sim keeps it — one box per agent, and
 * both lanes reach it through this function.
 */
export function brainAnalysisParmsOf(agent: object): LogBrainAnalysisParms {
  let box = brainAnalysisParms.get(agent);
  if (box === undefined) {
    box = { functionPath: '' };
    brainAnalysisParms.set(agent, box);
  }
  return box;
}

/**
 * PORT-NOTE(sim/log-brain-file): lane L12's brain recorders hand the brain the `TextSink` their
 * `createFile` returned (`printf( text )` — the recorder formats, native's
 * `fprintf( f, "%s", text )`), while lane L6's `Brain` dumps through `BrainTextFile`, i.e. native's
 * *variadic* `AbstractFile::printf`. The sim bridges the two here, applying the C format with the
 * brain lane's own `sprintfC` (one formatting implementation, PORT_SPEC rule 4) before the sink
 * sees the text. Without the bridge the sink wrote the **format string** verbatim — measured in
 * `run/brain/anatomy/brainAnatomy_10_birth.txt.gz`:
 * `brain %ld fitness=%g numneurons+1=%d …` instead of `brain 10 fitness=0 numneurons+1=38 …`.
 *
 * `Brain::startFunctional` prints native's `TSimulation::fStep` (a *static*, `Brain.cc:194`), which
 * lane L6 takes as its third argument (the brain cannot see the sim); the view supplies it from
 * `logViewStep` — see PORT-NOTE(sim/log-view-step).
 */
function brainTextFile(sink: unknown): BrainTextFile {
  const out = sink as { printf?: (text: string) => void };
  if (typeof out.printf !== 'function') {
    throw new Error('sim: the brain was handed a file that is not a text sink (native `AbstractFile *`)');
  }
  return {
    printf: (format: string, ...args: CValue[]) => out.printf!(sprintfC(format, ...args)),
    // Native's `AbstractFile::scanf` reads a file back; the recording sink is write-only and only
    // `Brain::loadSynapses` ever reads, which the record path never calls.
    scanf: () => {
      throw new Error('sim: the brain recording sink cannot be read back (Brain::loadSynapses)');
    },
  };
}

/**
 * PORT-NOTE(sim/log-view-step): native's `TSimulation::fStep` is a **static**, so `Brain` reads it
 * directly; the port's step lives on the simulation instance, and `Simulation.postEvent` publishes
 * it here before the views are built (the recorders run synchronously inside the step, so the value
 * is exactly native's).
 */
let logViewStep = 0;

/** Native `TSimulation::fStep` as the log views read it (see PORT-NOTE(sim/log-view-step)). */
export function setLogViewStep(step: number): void {
  logViewStep = step;
}

const brainViews = new WeakMap<object, object>();

/** Native `brain::Brain` as lane L12's `LogBrain` (see PORT-NOTE(sim/log-brain-file)). */
function logBrain(raw: object): object {
  let view = brainViews.get(raw);
  if (view === undefined) {
    const brain = raw as {
      dumpAnatomical(file: unknown, index: number, fitness: number): void;
      dumpSynapses(file: unknown, index: number): void;
      startFunctional(file: unknown, index: number, step: number): void;
      endFunctional(file: unknown, fitness: number): void;
      writeFunctional(file: unknown): void;
    };
    const created: Record<string, unknown> = Object.create(raw) as unknown as Record<string, unknown>;
    created['dumpAnatomical'] = (file: unknown, index: number, fitness: number) =>
      brain.dumpAnatomical(brainTextFile(file), index, fitness);
    created['dumpSynapses'] = (file: unknown, index: number) => brain.dumpSynapses(brainTextFile(file), index);
    created['startFunctional'] = (file: unknown, index: number) =>
      brain.startFunctional(brainTextFile(file), index, logViewStep);
    created['endFunctional'] = (file: unknown, fitness: number) =>
      brain.endFunctional(brainTextFile(file), fitness);
    created['writeFunctional'] = (file: unknown) => brain.writeFunctional(brainTextFile(file));
    view = created;
    brainViews.set(raw, view);
  }
  return view;
}

/** Native `gobject` as lane L12's `LogGameObject` (`type()` = the object-type bit). */
function logGameObject(raw: object): object {
  const obj = raw as { getType(): number; getTypeNumber(): number };
  return { type: () => obj.getType(), typeNumber: () => obj.getTypeNumber() };
}

/**
 * PORT-NOTE(sim/log-genome-sink): lane L5's `Genome::dump` takes its writer seam (`GenomeSink`,
 * native `AbstractFile *`) as `write( text )`, while lane L12's `LogGenome` hands it the sink its
 * own `createFile` returns (`TextSink`, native `fprintf`). Same native call, two shapes — so the
 * genome view adapts: a `printf` sink is wrapped into the `write` seam (`fprintf( f, "%s", t )` is
 * the `printf` L12 documents). Reported to L5/L12 in PARITY.md → Open questions.
 */
function genomeSink(out: unknown): { write(text: string): void } {
  const sink = out as { write?: (text: string) => void; printf?: (text: string) => void };
  if (typeof sink.write === 'function') return sink as { write(text: string): void };
  if (typeof sink.printf === 'function') return { write: (text: string) => sink.printf!(text) };
  throw new Error('sim: genome dump sink is neither a write() nor a printf() sink');
}

const genomeViews = new WeakMap<object, object>();

/** Native `genome::Genome` as lane L12's `LogGenome` (see PORT-NOTE(sim/log-genome-sink)). */
function logGenome(raw: object): object {
  let view = genomeViews.get(raw);
  if (view === undefined) {
    const genome = raw as unknown as { dump(out: unknown): void };
    const created = Object.create(raw) as unknown as Record<string, unknown>;
    created['dump'] = (out: unknown) => genome.dump(genomeSink(out));
    view = created;
    genomeViews.set(raw, view);
  }
  return view;
}

/**
 * Native `food` as lane L12's `LogFood` (`type()` = the `FoodType`, `energySum()`), plus the
 * `gobject` half the *other* logger of the same event needs.
 *
 * PORT-NOTE(sim/log-energy-object-view): `sim::EnergyEvent::obj` is an `agent*` for `Fight`/`Give`
 * and a `food*` for `Eat` (`Simulation.cc:2436,2443,2535,2641,2699`) — and the two loggers that
 * consume the event disagree about its *static* type: `EnergyLog` writes
 * `(long)e.obj->getTypeNumber()` (via `gobject*`) while `FoodConsumptionLog` writes
 * `((food*)e.obj)->getType()->name`. So the view for a food slot carries both spellings:
 * `type()` is the `FoodType` lane L10 names `getType_()` (the C++ name-hiding dance, see
 * PORT-NOTE(sim/log-view-type-ambiguity)) and `typeNumber()` is the object-type number, which
 * `EnergyLog` reads unconditionally. Without `typeNumber` the loop died at the first `Eat`:
 * `e.obj.typeNumber is not a function` (`logs/eventLogs.ts:301`).
 */
const foodViews = new WeakMap<object, object>();

function logFood(raw: object): object {
  let view = foodViews.get(raw);
  if (view === undefined) {
    const food = raw as {
      getType_(): unknown;
      getTypeNumber(): number;
      getEnergy(): { sum(): number };
    };
    view = {
      type: () => food.getType_(),
      typeNumber: () => food.getTypeNumber(),
      energySum: () => food.getEnergy().sum(),
    };
    foodViews.set(raw, view);
  }
  return view;
}

/** A world object as the recorders that walk `gXSortedObjects` see it (agents or food only). */
export function logWorldObject(raw: object): object {
  return typeof (raw as { number?: unknown }).number === 'function' ? logAgent(raw) : logFood(raw);
}

function agentOrNull(value: unknown): unknown {
  return value === null || value === undefined ? value : logAgent(value as object);
}

/**
 * Native `logs->postEvent( e )`'s event, with its object slots replaced by the views above. A copy
 * is returned (the caller keeps its own, unadapted event — native passes a `const &`, and
 * `DeathAndStats` goes on using `deathEvent.a` after posting it).
 */
export function logEvent(event: SimEvent): SimEvent {
  const e = event as unknown as Record<string, unknown>;
  switch (event.type as number) {
    case Event_AgentBirth:
      return {
        ...e,
        a: agentOrNull(e['a']),
        parent1: agentOrNull(e['parent1']),
        parent2: agentOrNull(e['parent2']),
      } as unknown as SimEvent;
    case Event_AgentDeath:
    case Event_BrainGrown:
    case Event_AgentGrown:
    case Event_BrainUpdated:
    case Event_BodyUpdated:
    case Event_Collision:
    case Event_BrainAnalysisBegin:
    case Event_BrainAnalysisEnd:
      return { ...e, a: agentOrNull(e['a']) } as unknown as SimEvent;
    case Event_ContactBegin:
      return {
        ...e,
        c: agentContactView(e['c']),
        d: agentContactView(e['d']),
      } as unknown as SimEvent;
    case Event_Carry:
      return {
        ...e,
        a: agentOrNull(e['a']),
        obj: logGameObject(e['obj'] as object),
      } as unknown as SimEvent;
    case Event_Energy: {
      const other = e['obj'] as object;
      return {
        ...e,
        a: agentOrNull(e['a']),
        obj: typeof (other as { getType_?: unknown }).getType_ === 'function' ? logFood(other) : logAgent(other),
        energy: logEnergy(e['energy'] as object),
        energyRaw: logEnergy(e['energyRaw'] as object),
      } as unknown as SimEvent;
    }
    default:
      return event;
  }
}

/** Native `AgentContactBeginEvent::AgentInfo` — its `a` is the only object the recorders read. */
function agentContactView(info: unknown): unknown {
  if (info === null || info === undefined) return info;
  const record = info as { a: unknown };
  return { ...record, a: logAgent(record.a as object) };
}

/** The event sink: lane L12's registry (native `logs->postEvent`) over the views above. */
export const eventSink: EventSinkLike = {
  postEvent(event: SimEvent<unknown, unknown, Energy>): void {
    postEvent(logEvent(event as unknown as SimEvent));
  },
};

/**
 * The `NERVOUS_SYSTEM` role object's draw surface — lane L6's `RngSurface` (the frozen contract)
 * and lane L8's `NervousSystemRngLike` served by one object, exactly as native has one
 * `RandomNumberGenerator` class behind `NervousSystem::getRNG()`.
 */
export interface CnsRng extends RngSurface, NervousSystemRngLike {
  /** Native `RandomNumberGenerator::range( lo, hi )` — `Retina::sensor_prebirth_signal` reads it. */
  range(lo: number, hi: number): number;
}

/**
 * Native `RandomNumberGenerator` (the `NERVOUS_SYSTEM` role object) as the frozen `RngSurface`
 * lane L6 asks for, **plus** the two methods lane L8's `NervousSystemRngLike` reads off the same
 * object (`drand()`, `seedIfLocal()`) — native has one class, so the port serves both seams from
 * one object. See PORT-NOTE(sim/cns-rng-adapter).
 */
export function cnsRngSurface(rng: RandomNumberGenerator): CnsRng {
  const unsupported = (what: string) => (): never => {
    throw new Error(`sim: cns RngSurface.${what}() is not a RandomNumberGenerator operation`);
  };
  return {
    srand: unsupported('srand'),
    rand: unsupported('rand'),
    srand48: (seed: number) => rng.seed(seed),
    drand48: () => rng.drand(),
    lrand48: unsupported('lrand48'),
    nrand: () => rng.nrand(),
    nrandScaled: (mean: number, stdev: number) => mean + rng.nrand() * stdev,
    // L8's view of the same object (native `RandomNumberGenerator::drand`/`seedIfLocal`).
    drand: () => rng.drand(),
    seedIfLocal: (seed: number) => rng.seedIfLocal(seed),
    range: (lo: number, hi: number) => rng.range(lo, hi),
  };
}

/**
 * PORT-NOTE(sim/nerve-set-binding): native `Nerve` has **two** `set`s — `set( double activation,
 * buf )` (the sensors' form: `numneurons == 0` returns, otherwise `assert( numneurons == 1 )` then
 * `set( 0, activation, buf )`; `Nerve.cc:31-42`) and `set( int ineuron, double activation, buf )` —
 * plus `get( ineuron = 0 )`, `getIndex()` and `getNeuronCount()`. Lane L8's `NerveLike` seam declares
 * only `get()`/`set( value )`, which is what its six proprioceptive sensors call, while lane L6's
 * `Nerve` ports the *indexed* `set` with the buffer argument (and `setScalar` for the native
 * `set( double )` overload). Handing L8 the raw L6 nerve makes `nerve.set( energy )` mean "set the
 * neuron numbered `energy`" — measured: `Nerve 'Energy': index 1 out of range (1 neurons, index 1)`
 * as soon as an agent's normalized energy reached exactly 1.0.
 *
 * The adapter below restores native's one JS-visible nerve: `set` dispatches on arity
 * (`set( value )` -> native's `set( double )`, `set( i, value )` -> native's `set( int, double )`),
 * and the read-only accessors come along because the one sensor that is not lane L8's — the retina —
 * caches its channel nerves and then reads each one's neuron count and bone index
 * (`Retina::Channel::init`, `agent/Retina.cc:160-178`; lane W1j/L16's `NerveTarget`). Until this
 * adapter carried them, the retina's `sensor_grow` was the boot's wall: `channel.nerve
 * .getNeuronCount is not a function` at `vision/retina.ts:74`. Lane L6's nerve stays the object the
 * brain wires its activation buffers into.
 */
export interface NativeNerveFacade extends NerveLike {
  /** Native `Nerve::name` (read by `Retina::Channel::dump_anatomical`). */
  readonly name: string;
  /** Native `Nerve::getIndex()`. */
  getIndex(): number;
  /** Native `Nerve::getNeuronCount()`. */
  getNeuronCount(): number;
  /** Native's two `set` overloads, dispatched on arity (see the PORT-NOTE above). */
  set(first: number, second?: number): void;
}

function nativeNerve(nerve: Nerve): NativeNerveFacade {
  return {
    name: nerve.name,
    get: () => nerve.get(),
    getIndex: () => nerve.getIndex(),
    getNeuronCount: () => nerve.getNeuronCount(),
    set: (first: number, second?: number) => {
      if (second === undefined) nerve.setScalar(first);
      else nerve.set(first, second);
    },
  };
}

/**
 * The same binding for a sensor's `sensorGrow( cns )`: lane L6 hands the sensors its own
 * `NervousSystem` (the raw object), so its `getNerve` must be the nerve-bound one before a sensor
 * caches the nerve it will `set()` every step.
 */
function nerveBindingCns(cns: NervousSystem): NervousSystemLike {
  const view = Object.create(cns) as Record<string, unknown>;
  view['getNerve'] = (name: string) => nativeNerve(cns.getNerve(name));
  return view as unknown as NervousSystemLike;
}

/**
 * PORT-NOTE(sim/sensor-dump-defaults): native `Sensor::sensor_start_functional` and
 * `sensor_dump_anatomical` are *non-pure* virtuals with empty bodies (`brain/Sensor.h`), and only
 * the retina overrides them. Lane L8's sensors are faithful to that (its `AgentSensorLike` has
 * neither), while lane L6's `Sensor` declares both as required. The sim binds the difference: a
 * sensor that does not define them is given native's empty body.
 */
function withNativeSensorDefaults(sensor: unknown): Sensor {
  const s = sensor as unknown as {
    sensorGrow(cns: NervousSystemLike): void;
    sensorPrebirthSignal(rng: RngSurface): void;
    sensorUpdate(bprint: boolean): void;
    sensorStartFunctional?(file: BrainTextFile): void;
    sensorDumpAnatomical?(file: BrainTextFile): void;
  };
  return {
    // Native hands `sensor_grow` the `NervousSystem` itself; the sim hands it the nerve-bound view
    // (see PORT-NOTE(sim/nerve-set-binding)) — lane L8's sensors ask only for that surface.
    sensorGrow: (cns) => s.sensorGrow(nerveBindingCns(cns)),
    sensorPrebirthSignal: (rng) => s.sensorPrebirthSignal(rng),
    sensorUpdate: (bprint) => s.sensorUpdate(bprint),
    sensorStartFunctional: (file) => s.sensorStartFunctional?.(file),
    sensorDumpAnatomical: (file) => s.sensorDumpAnatomical?.(file),
  };
}

/**
 * The `NervousSystem` factory (native `new NervousSystem()`), wrapping lane L6's class so L8's
 * `grow(genome)` seam (`NervousSystem::grow( genome )`) grows a real `GroupsBrain`.
 */
export function nervousSystemFactory(): AgentDeps['nervousSystemFactory'] {
  return {
    create(): NervousSystemLike {
      const role = RandomNumberGenerator.create(RngRole.NERVOUS_SYSTEM);
      const cns = new NervousSystem(cnsRngSurface(role));
      // PORT-NOTE(sim/brain-local-rng-provider): native `GroupsBrain::init()` sets the two
      // wiring roles to `LOCAL` (`RandomNumberGenerator::set( TOPOLOGICAL_DISTORTION, LOCAL )`,
      // `… INIT_WEIGHT, LOCAL )`) and `GroupsBrain::growSynapses` calls
      // `RandomNumberGenerator::create( role )` **once per call**, which for a LOCAL role is a
      // fresh `gsl_rng_alloc( gsl_rng_mt19937 )` — i.e. a stream seeded with GSL's default
      // (seed 0, remapped to 4357; lane W1d's `Mt19937` default) and then `seedIfLocal()`-ed
      // from the genome's per-connection seed gene
      // (`EnableTopologicalDistortionRngSeed` / `EnableInitWeightRngSeed`). Lane L6 exposes
      // exactly that as `GroupsBrainOptions.rngProvider`; without a provider the brain throws
      // where native would have drawn — so the sim, which owns the ctor's `initBrain()` step,
      // supplies it here. The recorded Tier-A scenarios keep both flags `False` (their
      // `normalized.wf`), so this path is not entered there and no frozen artifact moves.
      const rngProvider = new InjectedBrainRng(cns.getRNG(), () => createMt19937Stream());
      const wrapper = {
        createNerve: (kind: number, name: string) =>
          nativeNerve(cns.createNerve(kind as 0 | 1, name)),
        getNerve: (name: string) => nativeNerve(cns.getNerve(name)),
        addSensor: (sensor: unknown) => cns.addSensor(withNativeSensorDefaults(sensor)),
        grow: (genome: unknown) => {
          // Lane L8 hands this seam the `GenomeLike` its agent holds; the concrete `GroupsGenome`
          // the brain view needs is the object that seam wraps (see `asConcreteGenome`).
          const view = new GroupsGenomeViewAdapter(asConcreteGenome(genome) as GroupsGenome);
          cns.grow((inner) => new GroupsBrain(inner, view, { rngProvider }));
        },
        prebirth: () => cns.prebirth(),
        update: (debugCheck: boolean) => cns.update(debugCheck),
        getEnergyUse: () => cns.getEnergyUse(),
        getRNG: () => cns.getRNG(),
        getBrain: () => cns.getBrain(),
      };
      return wrapper as unknown as NervousSystemLike;
    },
  };
}

/** Native `food::gCarryFood2Energy` / `food::gMaxFoodRadius` as L8 reads them. */
export const foodStatics: FoodStaticsLike = {
  carryFood2Energy: () => Food.gCarryFood2Energy,
  maxFoodRadius: () => Food.gMaxFoodRadius,
};

/** Native `brick::gCarryBrick2Energy` / `brick::GetNumBricks()` as L8 reads them. */
export const brickStatics: BrickStaticsLike = {
  carryBrick2Energy: () => Brick.gCarryBrick2Energy,
  numBricks: () => Brick.GetNumBricks(),
};

/** Native `barrier::gXSortedBarriers` as L8's `BarrierListLike`. */
export const barrierList: BarrierListLike = {
  reset: () => {
    Barrier.gXSortedBarriers.reset();
  },
  next: () => {
    const barrier = Barrier.gXSortedBarriers.next();
    if (barrier === null) return null;
    return { barrier: barrier as unknown as BarrierLike };
  },
  stickyBarriers: () => Barrier.gStickyBarriers,
};

/** Native `objectxsortedlist::gXSortedObjects` as L8's `SortedObjectListLike`. */
export const sortedObjectList: SortedObjectListLike = {
  setMark: (objectType: number) => gXSortedObjects.setMark(objectType),
  toMark: (objectType: number) => gXSortedObjects.toMark(objectType),
  anotherObj: (direction: number, solidObjectTypes: number) => {
    // See PORT-NOTE(sim/direction-constants): lane L8's `GObject.NEXT`/`PREV` are native's
    // `NEXT 1`/`PREV 2` (`contracts.ts:46-47`), i.e. exactly lane L10's `LIST_NEXT`/`LIST_PREV`,
    // so the direction crosses the seam unchanged (only its static type is narrowed here).
    const listDirection = direction === GObject.NEXT ? LIST_NEXT : LIST_PREV;
    const obj = gXSortedObjects.anotherObj(listDirection, solidObjectTypes);
    if (obj === null) return null;
    return { obj: obj as unknown as Agent };
  },
};

/** The `AgentDeps` bundle plus the two graphics objects the sim keeps a handle on. */
export interface AgentDepsBundle {
  readonly deps: AgentDeps;
  readonly stage: SimStage;
  readonly povRenderer: AgentPovRendererSurface;
}

/** Build the `AgentDeps` bundle once per run (native's process-wide statics, made explicit). */
export function createAgentDeps(
  simulation: AgentDeps['simulation'],
  options: {
    readonly stage: SimStage;
    readonly povRenderer: AgentPovRendererSurface;
    readonly geometry?: BodyGeometryLike;
    readonly bodyTemplate?: unknown;
    readonly events?: EventSinkLike;
  },
): AgentDepsBundle {
  const geometry: BodyGeometryLike = options.geometry ?? bodyGeometry().geometry;
  const deps: AgentDeps = {
    simulation,
    genomeFactory: genomeFactory(),
    geometry,
    bodyTemplate: options.bodyTemplate ?? agentBodyTemplate(),
    stage: options.stage,
    rng: globalRngSurface(),
    events: options.events ?? eventSink,
    barrierList,
    sortedObjects: sortedObjectList,
    foodStatics,
    brickStatics,
    nervousSystemFactory: nervousSystemFactory(),
    retinaFactory: retinaFactory(),
    retinaWidth: brainConfig.retinaWidth,
    retinaHeight: brainConfig.retinaHeight,
    // Native `Brain::config.learningMode == LEARN_PREBIRTH` (agent.cc:598).
    preBirthLearning: brainConfig.learningMode === 1,
    visionCamera: null,
  };

  return { deps, stage: options.stage, povRenderer: options.povRenderer };
}

//===========================================================================
// lane L12's log environment
//===========================================================================

/**
 * Build lane L12's `LogContext` from the sim's own world objects.
 *
 * PORT-NOTE(l13/adami-binding): `computeAdamiComplexity` defaults to lane L13's own
 * transcription over the same world/genome-util views this function hands the recorders (native
 * reaches it as the process-global `computeAdamiComplexity`, so there was never an injection
 * point to keep). A caller that wants a different one can still pass it.
 */
export function logContext(
  fs: LogContext['fs'],
  computeAdamiComplexity?: LogContext['computeAdamiComplexity'],
): LogContext {
  const world: LogContext['world'] = {
    reset: () => gXSortedObjects.reset(),
    next: (type: number, out: { value: unknown }) => {
      const obj = gXSortedObjects.nextObj(type);
      if (obj === null) return false;
      // PORT-NOTE(sim/log-view-names): the recorders that walk the world read the same
      // renamed members as the ones that read an event (`type()`, `energySum()`), and the
      // per-agent writers are keyed by the walk view — which is the *same* object the birth
      // event handed them, because `logAgent` memoizes.
      out.value = logWorldObject(obj);
      return true;
    },
  };
  const genomeUtilView: LogContext['genomeUtil'] = {
    schema: genomeUtil.schema as LogContext['genomeUtil']['schema'],
    layout: genomeUtil.layout as LogContext['genomeUtil']['layout'],
  };

  return {
    fs,
    world,
    genomeUtil: genomeUtilView,
    foodTypes: {
      getNumberDefinitions: () => FoodType.getNumberDefinitions(),
      get: (index: number) => FoodType.get(index) as unknown as ReturnType<LogContext['foodTypes']['get']>,
    },
    computeAdamiComplexity:
      computeAdamiComplexity ??
      createComputeAdamiComplexity({
        world,
        schema: (genomeUtil.schema ?? null) as { getMutableSize(): number } | null,
      }),
  };
}

/** Construct lane L12's recorders over a `LogSimulation` (native `logs = new Logs( this, doc )`). */
export function createLogs(sim: LogSimulation, doc: Config, env: LogContext): Logs {
  return new Logs(sim, doc, env);
}

//===========================================================================
// lane L14's monitor environment (what native's `main.cc` mounts)
//===========================================================================

/**
 * PORT-NOTE(sim/monitor-agent-view): native's monitors see an `agent` directly
 * (`AgentTracker::setTarget( agent* )`, `CameraController::setAgentTarget`), and lane L14's
 * `TrackedAgent` seam names the members it reads with the **native** spellings — `Number()`,
 * `x()`, `z()`, `getCamera()`, `addListener`/`removeListener`. Lane L8's `Agent` provides
 * `number()`, `x()`, `z()`, `addListener`/`removeListener` (native names for everything except the
 * type-number accessor) and **no camera**: native's `agent::fCamera` is a `gcamera` the agent
 * builds in `SetGraphics()` and attaches to itself (`agent.cc:285, 1024-1033`), and the port's
 * agent has only the `visionCamera` seam (`AgentDeps.visionCamera`, null off the vision path).
 * This adapter maps the one renamed accessor and answers `getCamera()` by **throwing** rather than
 * approximating a graphics object: it is reached only by a `Perspective POV` camera controller
 * (`SinglePOVScene`, `Enabled` only under `--ui gui`, `etc/monitors.mfs`) — never by the recorded
 * `--ui term` runs, whose single enabled scene (`MainScene`) uses `Mode Rotate`. Gaps row: L8/L9.
 */
export function trackedAgentView(agent: Agent): TrackedAgent {
  return {
    Number: () => agent.number(),
    x: () => agent.x(),
    z: () => agent.z(),
    getCamera: (): TrackedAgentCamera => {
      throw new Error(
        'sim: TrackedAgent.getCamera(): lane L8 has no agent camera (native `agent::fCamera`); ' +
          'only the POV-perspective camera controller reads it and no recorded scenario enables it',
      );
    },
    addListener: (listener) => agent.addListener(listener as never),
    removeListener: (listener) => agent.removeListener(listener as never),
  };
}

/**
 * PORT-NOTE(sim/monitor-sim-view): the same idea for the simulation — lane L14's `MonitorSim` is
 * declared with native method spellings and two agent-returning methods typed as `TrackedAgent`.
 * The sim class carries the native spellings too (PORT-NOTE(sim/monitor-accessor-aliases)), so this
 * adapter only re-wraps the two agent-returning methods through `trackedAgentView`; every other
 * member is the sim's own method, forwarded by name.
 */
export function monitorSimView(sim: Simulation): MonitorSim {
  return {
    getStep: () => sim.getStep(),
    isLockstep: () => sim.isLockstep(),
    getFitnessWeight: (type) => sim.getFitnessWeight(type),
    GetMaxAgents: () => sim.GetMaxAgents(),
    GetNumDomains: () => sim.getNumDomains(),
    getNumAgents: (domain) => sim.getNumAgents(domain),
    getNumBorn: (type) => sim.getNumBorn(type as never),
    getFitnessStat: (type) => sim.getFitnessStat(type as never),
    getFoodEnergyStat: (type, scope) => sim.getFoodEnergyStat(type as never, scope as never),
    getCurrentFittest: (rank) => {
      const agent = sim.getCurrentFittest(rank);
      return agent === null ? null : trackedAgentView(agent);
    },
    getAgentByNumber: (number) => {
      const agent = sim.getAgentByNumber(number);
      return agent === null ? null : trackedAgentView(agent);
    },
    getStatusText: (out, statusFrequency) => sim.getStatusText(out, statusFrequency),
    GetAgentPovRenderer: () => sim.GetAgentPovRenderer(),
    getStage: () => sim.getStage(),
  };
}

/**
 * PORT-NOTE(sim/null-scene-renderer): native's `MonitorManager` builds a `SceneRenderer` for every
 * enabled scene (`SceneRenderer::create( sim->getStage(), … )` — a Qt/GL object) and a
 * `SceneMovieController` with a `PwMovieWriter` for every scene whose `Movie.Record` is set
 * (the term document inherits `RecordMovie True`, so `MainScene` **does** request one). Both are
 * the graphics lanes' (L15's renderer, L16's recorder/encoder, `utils/PwMovieUtils.cc`), and
 * PORT_SPEC puts their output outside the frozen surface: `run/movie.pmv` is the one artifact the
 * harness reports as `IGNORED` at every tier, and the scene *selection* is what lane L14 owns.
 * The runner therefore mounts a renderer whose `render()` is a no-op: the camera controller still
 * runs (`Mode Rotate` steps its angle), the recorder is still created on `renderComplete`, and no
 * pixel or `.pmv` byte is produced. Gaps row: L15/L16.
 */
export function nullSceneRenderer(): SceneRendererSurface {
  const renderComplete = new Signal<[]>();
  return {
    getCamera: () => nullSceneCamera(),
    getBufferWidth: () => 0,
    getBufferHeight: () => 0,
    renderComplete,
    createMovieRecorder: () => ({ recordFrame: () => {} }),
    render: () => {},
  };
}

/** The camera a scene renderer would own (`SceneRenderer::getCamera`), as the controller drives it. */
function nullSceneCamera(): ControllerCamera {
  let x = 0;
  let y = 0;
  let z = 0;
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  return {
    SetFixationPoint: () => {},
    SetRotation: (newYaw, newPitch, newRoll) => {
      yaw = newYaw;
      pitch = newPitch;
      roll = newRoll;
    },
    settranslation: (newX, newY, newZ) => {
      x = newX;
      y = newY;
      z = newZ;
    },
    AttachTo: () => {},
    x: () => x,
    y: () => y,
    z: () => z,
    getyaw: () => yaw,
    getpitch: () => pitch,
    getroll: () => roll,
  };
}

/** The `MovieWriter` a scene's `SceneMovieController` is handed (see PORT-NOTE(sim/null-scene-renderer)). */
export function nullMovieWriter(): MovieWriter {
  return {
    writeFrame: () => {},
    close: () => {},
  };
}

/**
 * Native `proplib::CppProperties::getMetadata()` for the runner/UI mount. Lane W1h's cppprops is a
 * **build-time** step in the port (`docs/specs/cppprops.md`), so there is no table to hand over
 * here; the recorded scenarios resolve to **zero** run-time properties (measured: the golden
 * `run/stats/stat.1` and the recorded `stdout.txt` carry no dynamic line), and the only consumer,
 * `FarmMonitor`, is constructed solely when `PWFARM_STATUS` is set (it is not). A worldfile that
 * *does* carry `dyn` properties gets a real table from `sim/cppProperties.ts`
 * (`createCppProperties({ spec })` → `SimulationOptions.dynamicProperties`, and the same object is
 * the `cppProperties` provider); Gaps row: W1h.
 */
export const emptyCppProperties: CppPropertyMetadataProvider = {
  getMetadata: () => [],
};

/**
 * Native `system( command )` for the farm monitor — never called unless `PWFARM_STATUS` is set
 * (see `emptyCppProperties`); throwing keeps an accidental call loud instead of spawning shells.
 */
export const unavailableFarmRunner: FarmRunner = {
  run: () => {
    throw new Error('sim: the farm monitor needs `system()` and no run has PWFARM_STATUS set');
  },
};

/** Re-exported so the simulation can name the graphics/lang types it binds without deep imports. */
export { Agent, agentConfig, Brain, Energy, Food, type Mt19937Stream };

