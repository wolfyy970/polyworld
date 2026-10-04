/**
 * Lane L8 — the lane's boundary: what the agent core needs from its neighbours.
 *
 * `agent.cc` is the most entangled file in the tree: an `agent` *is* a `gpolyobj` (graphics),
 * it owns a `NervousSystem` (brain), a `Genome` (genome), an `Energy` vector (environment),
 * it iterates barriers, bricks, food and the x-sorted object list, and it posts events to
 * the global `logs`. PORT_SPEC's interface-cut rule ("lanes import `types/*` and nothing else
 * from another lane's internals") means the port states that surface *here*, as interfaces
 * with the native semantics spelled out, instead of importing modules that other lanes have
 * not written yet.
 *
 * PORT-NOTE(L8/lane-seams): every interface below is a *cut*, not a redesign. The methods
 * are the native calls the agent core makes, in the order and with the units the native code
 * uses; a lane that lands a concrete implementation binds it here (one import at the seam)
 * and the agent code does not change. Gaps in PARITY.md name the lane that closes each one.
 *
 * What is deliberately NOT here:
 *  - anything the agent core only *stores* (Retina, the renderer) — opaque handles;
 *  - GL/drawing (`draw()`, the camera, the frustum): presentation, L15/L16/L18;
 *  - the worldfile -> `Metabolism`/config wiring: that is L11's `processWorldFile` (this
 *    file declares the *result* types, L11 performs the registration).
 */

import type { RngSurface, SimEvent } from '../types';
import type { Energy, EnergyMultiplier, EnergyPolarity } from '../environment/energy';
import type { Metabolism } from './metabolism';
import type { NervousSystemLike } from './nervousSystem';

/**
 * Native `graphics/gobject.h` object-type bits (`AGENTTYPE`/`FOODTYPE`/`BRICKTYPE`) plus the
 * traversal-direction constants of `utils/objectxsortedlist.h`.
 *
 * PORT-NOTE(L8/gobject-direction-constants): the two are *separate* native vocabularies and
 * must not be conflated. The object-type bits share no numbering with the directions:
 * `objectxsortedlist.h:4-5` is `#define NEXT 1` / `#define PREV 2`, and
 * `objectxsortedlist::anotherObj` (`objectxsortedlist.cc:129-139`) prints
 * "ERROR--Unknown direction" and `exit(1)`s for anything that is neither. They live in one
 * const because both are passed to `setMark`/`anotherObj` at the same call sites
 * (`avoidCollisions`), but `NEXT` is *not* `AGENTTYPE` even though both are 1.
 */
export const GObject = {
  AGENTTYPE: 0x1,
  FOODTYPE: 0x2,
  BRICKTYPE: 0x4,
  // Native `utils/objectxsortedlist.h:4-5`.
  NEXT: 1,
  PREV: 2,
} as const;

/** Native `sim::ObjectType` values used by the collision log (`OT_*`). */
export const ObjectTypeCode = {
  OT_AGENT: 0,
  OT_FOOD: 1,
  OT_BRICK: 2,
  OT_BARRIER: 3,
  OT_EDGE: 4,
} as const;

// ---------------------------------------------------------------------------
// genome (lane L5)
// ---------------------------------------------------------------------------

/**
 * Native `genome::Genome` — the agent core reads four genes by name and asks one question
 * (`mateProbability`). `get(name)` is native's templated `get<T>()` on a *numeric* gene:
 * `MaxSpeed`, `Strength`, `Size`, `LifeSpan` and `MateEnergyFraction` are all floats except
 * `LifeSpan`, which is a long (`InitGeneCache` stores it in a `long`).
 */
export interface GenomeLike {
  /** Native `fGenome->get( "MaxSpeed" | "Strength" | "Size" | "MateEnergyFraction" | "ID" )`. */
  get(name: string): number;
  /** Native `fGenome->get( "LifeSpan" )` — a `long` gene. */
  getLong(name: string): number;
  /** Native `fGenome->mateProbability( other->fGenome )`. */
  mateProbability(other: GenomeLike): number;
}

/** Native `GenomeUtil::createGenome()` / `GenomeUtil::getMetabolism( genome )` — lane L5. */
export interface GenomeFactoryLike {
  createGenome(): GenomeLike;
  /** Native `GenomeUtil::getMetabolism( fGenome )` — the gene's metabolism (mode `Gene`). */
  getMetabolism(genome: GenomeLike): Metabolism;
}

// ---------------------------------------------------------------------------
// nervous system (lane L6), sensors (this lane + L9), brain
// ---------------------------------------------------------------------------

/** Native `Nerve` — `get()` is the nerve's current value, `set()` what the sensors write. */
export interface NerveLike {
  get(): number;
  set(value: number): void;
}

/** Native `NervousSystem::createNerve( Nerve::Kind, name )`. */
export const NerveKind = {
  INPUT: 0,
  OUTPUT: 1,
} as const;

export type NerveKind = (typeof NerveKind)[keyof typeof NerveKind];

/**
 * Native `NervousSystem` — the parts `agent::grow()`, `UpdateBrain()`, `UpdateBody()` and
 * `print()` touch. See `nervousSystem.ts` for the output-nerve table the agent core reads.
 */
export interface NervousSystemDeps {
  readonly inputNerveNames: readonly string[];
  readonly outputNerveNames: readonly string[];
}

/** Native `RandomNumberGenerator *NervousSystem::getRNG()`. */
export interface NervousSystemRngLike {
  /** Native `drand()` on the LOCAL (MT19937) stream when the world sets static geometry. */
  drand(): number;
  /** Native `RandomNumberGenerator::seedIfLocal( seed )` — a no-op for GLOBAL streams. */
  seedIfLocal(seed: number): void;
}

/** Native `class Brain` — `freeze()` is the only call the agent core makes. */
export interface BrainLike {
  freeze(): void;
}

/** Native `class Sensor` — the agent core only registers sensors. */
export interface SensorLike {
  readonly sensorName: string;
}

// ---------------------------------------------------------------------------
// object graph: gobject / food / brick / barrier (lanes L10, L15)
// ---------------------------------------------------------------------------

/** Native `graphics/gobject.h` — the kinematic, identity and carry state of any object. */
export interface CarryableLike {
  /** Native `gobject::getType()` — one of the `GObject` bits. */
  getType(): number;
  /** Native `gobject::getTypeNumber()`. */
  getTypeNumber(): number;
  /** Native `gobject::x()` / `z()`. */
  x(): number;
  z(): number;
  /** Native `gobject::setx()` / `setz()`. */
  setx(x: number): void;
  setz(z: number): void;
  /** Native `gobject::radius()`. */
  radius(): number;
  /** Native `gobject::PickedUp( gobject *by, float y )`. */
  pickedUp(by: CarryableLike, y: number): void;
  /** Native `gobject::Dropped()`. */
  dropped(): void;
  /** Native `gobject::CarriedBy()` — the carrying object, or null. */
  carriedBy(): CarryableLike | null;
  /** Native `gobject::NumCarries()`. */
  numCarries(): number;
}

/**
 * Native `class FoodType` — a worldfile-declared food kind (`FoodTypes [ { Name ... } ]`).
 * Lane L10 owns it; the agent core only carries a reference to a metabolism's carcass food
 * type, so it is opaque here.
 */
export interface FoodTypeLike {
  readonly name: string;
}

/** Native `class food` — the half of it the agent core uses. */
export interface FoodLike extends CarryableLike {
  /** Native `food::eat( const Energy &requested )` — returns what was actually taken. */
  eat(requested: Energy): Energy;
  /** Native `food::getEnergyPolarity()`. */
  energyPolarity(): EnergyPolarity;
  /** Native `food::getEatMultiplier()`. */
  eatMultiplier(): EnergyMultiplier;
  /** Native `food::domain()` / `food::domain( id )`. */
  domain(): number;
  setDomain(id: number): void;
}

/** Native `food`'s class-level statics used by `agent::CarryEnergy()`. */
export interface FoodStaticsLike {
  /** Native `food::gCarryFood2Energy`. */
  carryFood2Energy(): number;
  /** Native `food::gMaxFoodRadius`. */
  maxFoodRadius(): number;
}

/** Native `brick`'s class-level statics used by `CarryEnergy()`/`UpdateBody()`. */
export interface BrickStaticsLike {
  /** Native `brick::gCarryBrick2Energy`. */
  carryBrick2Energy(): number;
  /** Native `brick::GetNumBricks()`. */
  numBricks(): number;
}

/** Native `class barrier` — the geometry `UpdateBody()`'s barrier pass reads. */
export interface BarrierLike {
  xmin(): number;
  xmax(): number;
  zmin(): number;
  zmax(): number;
  /** Native `barrier::dist( x, z )` — signed distance to the barrier's line. */
  dist(x: number, z: number): number;
  /** Native `barrier::sina()` / `cosa()`. */
  sina(): number;
  cosa(): number;
}

/** Native `barrier::gXSortedBarriers` — an x-sorted cursor over the barriers. */
export interface BarrierListLike {
  reset(): void;
  /** Native `next( barrier *&b )` — false when the list is exhausted. */
  next(): { barrier: BarrierLike } | null;
  /** Native `barrier::gStickyBarriers`. */
  stickyBarriers(): boolean;
}

/** Native `objectxsortedlist::gXSortedObjects` — the master x-sorted object list. */
export interface SortedObjectListLike {
  /** Native `setMark( int objectType )`. */
  setMark(objectType: number): void;
  /** Native `toMark( int objectType )` — re-position the cursor on the marked object. */
  toMark(objectType: number): void;
  /**
   * Native `anotherObj( int direction, int solidObjectTypes, gobject **obj )`: advances the
   * cursor *direction* (`GObject.PREV`/`NEXT`) and yields the next object whose type is in
   * `solidObjectTypes`; false when the walk ends.
   */
  anotherObj(direction: number, solidObjectTypes: number): { obj: CarryableLike } | null;
}

// ---------------------------------------------------------------------------
// simulation (lane L11) and the renderer (lanes L9/L16)
// ---------------------------------------------------------------------------

/** Native `TSimulation`'s state and calls the agent core touches. */
export interface SimulationLike {
  /** Native `TSimulation::fStep` (used by `PrintCarries`). */
  readonly fStep: number;
  /** Native `fSimulation->fLowPopulationAdvantageFactor`. */
  readonly fLowPopulationAdvantageFactor: number;
  /** Native `fSimulation->fGlobalEnergyScaleFactor`. */
  readonly fGlobalEnergyScaleFactor: number;
  /** Native `fSimulation->fPopulationPenaltyFraction`. */
  readonly fPopulationPenaltyFraction: number;
  /** Native `fSimulation->fDomains[ fDomain ].energyScaleFactor`. */
  readonly fDomains: readonly { readonly energyScaleFactor: number }[];

  /** Native `TSimulation::WhichDomain( x, z, currentDomain )`. */
  whichDomain(x: number, z: number, currentDomain: number): number;
  /** Native `TSimulation::SwitchDomain( newDomain, oldDomain, objectType )`. */
  switchDomain(newDomain: number, oldDomain: number, objectType: number): void;

  /** Native `GetAgentPovRenderer()` (L9/L16; opaque here). */
  agentPovRenderer(): AgentPovRendererLike;

  /** Native `fSimulation->LifeFractionSamples()`. */
  lifeFractionSamples(): number;
  /** Native `fSimulation->LifeFractionRecent()`. */
  lifeFractionRecent(): number;
  /** Native `fSimulation->EnergyFitnessParameter()`. */
  energyFitnessParameter(): number;
  /** Native `fSimulation->AgeFitnessParameter()`. */
  ageFitnessParameter(): number;
}

/** Native `AgentPovRenderer` — only the three calls the agent core makes. */
export interface AgentPovRendererLike {
  add(agent: unknown): void;
  remove(agent: unknown): void;
  render(agent: unknown): void;
}

/**
 * Native `gcamera` / `frustumXZ` setup `agent::UpdateVision()` performs before rendering.
 * Lane L15 owns the camera; the vision lane (L9/L16) owns the frustum. The port passes the
 * exact numbers native computes.
 */
export interface VisionCameraLike {
  setFrustum(x: number, z: number, angle: number, fov: number, radius: number): void;
  setAspect(aspect: number): void;
  setPitch(pitch: number): void;
  setYaw(yaw: number): void;
}

// ---------------------------------------------------------------------------
// graphics geometry (lane L15) — the polygon mesh an agent is drawn from
// ---------------------------------------------------------------------------

/**
 * Native `gpolyobj` — the mesh half of the agent's body (`SetGeometry`, `setlen`,
 * `setradius`). Native's `gpolyobj::setlen()` computes the bounding box of the *scaled*
 * polygon vertices and then calls `setradius()`; the port asks for the box and keeps the
 * agent-side consequences (`fLengthX/Z`, `fCarryRadius`) itself.
 */
export interface BodyGeometryLike {
  /** Native `gpolyobj::clonegeom( *agentobj )`. */
  cloneGeometry(template: unknown): void;
  /** The vertex scaling `agent::SetGeometry()` performs, in native's order. */
  scaleVertices(lengthX: number, height: number, lengthZ: number): void;
  /** Native `gpolyobj::setlen()`'s bounding box over the scaled vertices. */
  lengths(): readonly [number, number, number];
  /** Native `gpoly::radiusscale()`. */
  radiusScale(): number;
  /** Native `gpoly::scale()`. */
  scale(): number;
  /** Native `gpoly::fRadiusFixed`. */
  radiusFixed(): boolean;
}

// ---------------------------------------------------------------------------
// events (lane L12 consumes; L11/L8 raise)
// ---------------------------------------------------------------------------

/**
 * Native `logs->postEvent( ... )`. The port injects the sink through `AgentDeps` instead of
 * reading a global `logs` pointer: same single sink for every agent, no global mutable
 * state, and lane L12's recorder becomes the sink.
 *
 * PORT-NOTE(L8/event-sink-is-injected): native's `logs` is a process-wide pointer set by the
 * simulation; injecting it is a structural choice (PORT_SPEC: behaviour frozen, structure
 * free), and it is what lets a lane test drive the agent without constructing the whole
 * recorder stack.
 */
export interface EventSinkLike {
  postEvent(event: SimEvent<unknown, unknown, Energy>): void;
}

/** Native `AgentListener` — listeners are notified when an agent dies. */
export interface AgentListenerLike {
  died(agent: unknown): void;
}

// ---------------------------------------------------------------------------
// the dependency bundle an agent is constructed with
// ---------------------------------------------------------------------------

/**
 * Native `agent::agent( TSimulation *sim, gstage *stage )` plus the process-wide globals it
 * reaches through `agent::agentobj`, `GenomeUtil::createGenome()`, `new NervousSystem()`,
 * `logs`, the `randpw()` stream and the environment statics.
 *
 * PORT-NOTE(L8/deps-bundle): the port passes them explicitly. Native's statics are
 * zero-initialized and then overwritten by the simulation at startup; an explicit bundle
 * cannot be read before it is set, which removes a whole class of "worked in the native run,
 * silently zero in the port" divergence.
 */
export interface AgentDeps {
  readonly simulation: SimulationLike;
  readonly genomeFactory: GenomeFactoryLike;
  readonly geometry: BodyGeometryLike;
  /** Native `agent::agentobj` (the shared polygon source, loaded by `Resources`). */
  readonly bodyTemplate: unknown;
  /** Native `gstage` the agent's scene is attached to. */
  readonly stage: unknown;
  /** Native `randpw()` / `drand48()` — the process-wide glibc stream (lane L1). */
  readonly rng: RngSurface;
  readonly events: EventSinkLike;
  readonly barrierList: BarrierListLike;
  readonly sortedObjects: SortedObjectListLike;
  readonly foodStatics: FoodStaticsLike;
  readonly brickStatics: BrickStaticsLike;
  /** Native `new NervousSystem()` (lane L6). */
  readonly nervousSystemFactory: NervousSystemFactoryLike;
  /** Native `new Retina( Brain::config.retinaWidth )` (lane L9). */
  readonly retinaFactory: RetinaFactoryLike;
  /** Native `Brain::config.retinaWidth`. */
  readonly retinaWidth: number;
  /** Native `Brain::config.retinaHeight` (used for the POV camera's aspect). */
  readonly retinaHeight: number;
  /**
   * Native `Brain::config.learningMode == LEARN_PREBIRTH` (`agent::grow` line 598). Lane L6
   * owns the brain configuration; the agent only asks the question.
   */
  readonly preBirthLearning: boolean;
  /**
   * Native `fCamera` + `fFrustum` (lane L15/L16). `null` in a lane test that only needs the
   * vision *numbers* (the fov/pitch/yaw the agent computes); the recorded runs always have
   * one, and `updateVision()` is a no-op without it except for the renderer notification.
   */
  readonly visionCamera: VisionCameraLike | null;
}

/** Native `new NervousSystem()` — lane L6. */
export interface NervousSystemFactoryLike {
  create(): NervousSystemLike;
}

/** Native `new Retina( width )` — lane L9. */
export interface RetinaFactoryLike {
  create(width: number): SensorLike;
}
