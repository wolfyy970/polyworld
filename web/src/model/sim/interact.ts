/**
 * Lane L11 (sim) — `TSimulation::Interact` and its contact routines (native `Simulation.cc`
 * 1452-2909): the per-step interaction pass, the deaths, and Mate/Fight/Give/Eat/Carry/Fitness.
 *
 * This is the phase where the model's *ordering* is most visible, so the port keeps native's
 * structure literally:
 *
 *   Interact()          step 3 DeathAndStats -> step 4 Healing -> step 5 lockstep -> 6 the contact
 *                       loop -> step 7 EatStatistics
 *   contact loop        outer walk in x order; inner walk from `c` forward, breaking on
 *                       `d->x()-d->radius() >= c->x()+c->radius()`; one visit per unordered pair
 *   DeathAndStats()     the previous step's deaths and the fitness/least-fit bookkeeping
 *
 * PORT-NOTE(sim/contact-order): each unordered pair is visited exactly once (when the left agent is
 * `c`); there is no reverse pass, and the inner loop has **no** age filter on `d` (only the outer
 * loop skips `Age() <= 0`), so an agent born this step is a legal contact partner for a later `c`
 * in forced-serial mode — and invisible in the recorded (deferred) mode
 * (PORT-NOTE(sched-deferral)). Both facts come from the native source and are measured in
 * docs/specs/sim-spec.md §5.4.
 *
 * PORT-NOTE(sim/sqrt-cmp): the overlap test is native `sqrt(dx*dx + dz*dz) <= (d->radius() +
 * c->radius())` — and it is **single precision throughout** (`Simulation.cc:1591` reaches the
 * `float` `sqrt` overload): `fmul` on `dz*dz`, `fmadd` for `dx*dx + that`, `fsqrt`, and an
 * `fadd`/`fcmp` on the radius sum (`Interact` 0x94800-0x94814). The port rounds once per
 * operation in `f32` and compares in `f32` — a `double sqrt` on promoted operands (which an
 * earlier revision of this file documented) is not what the binary does.
 *
 * PORT-NOTE(sim/rng-shortcircuit): every condition containing a `randpw()` draw keeps C++
 * short-circuit semantics (the clearest case is `IS_PREVENTED_BY_CARRY`, where a zero coefficient
 * must not consume a draw). The draws are therefore written as nested `if`s, never as an eagerly
 * evaluated conjunction.
 *
 * PORT-NOTE(sim/mark-cursor): native relies on `gXSortedObjects`' cursor and per-type mark
 * (`setMark`/`toMark`, "the cursor is where I left it", `Kill` leaving it one item back). The port
 * keeps lane L10's cursor API and never re-sorts into a fresh array mid-pass
 * (sim-spec PORT-NOTE(list-cursor)).
 */

import { Agent, agentConfig, Energy, Metabolism, f32, f32Fma } from '../agent';
import { BrainArchitecture, brainConfig } from '../brain/core';
import {
  CarryAction,
  DeathReason,
  BirthReason,
  EnergyAction,
  Event_ContactBegin,
  Event_ContactEnd,
  Event_Energy,
  GObjectType,
  MATE_DESIRED,
  MATE_NIL,
  MATE_PREVENTED_CARRY,
  MATE_PREVENTED_EAT_MATE_MIN_DISTANCE,
  MATE_PREVENTED_EAT_MATE_SPAN,
  MATE_PREVENTED_ENERGY,
  MATE_PREVENTED_MATE_WAIT,
  MATE_PREVENTED_MAX_DOMAIN,
  MATE_PREVENTED_MAX_METABOLISM,
  MATE_PREVENTED_MAX_VELOCITY,
  MATE_PREVENTED_MAX_WORLD,
  MATE_PREVENTED_MISC,
  MATE_PREVENTED_PARTNER,
  MATE_PREVENTED_WORLDFILE,
  FIGHT_DESIRED,
  FIGHT_NIL,
  FIGHT_PREVENTED_CARRY,
  FIGHT_PREVENTED_POWER,
  FIGHT_PREVENTED_SHIELD,
  GIVE_DESIRED,
  GIVE_NIL,
  GIVE_PREVENTED_CARRY,
  GIVE_PREVENTED_ENERGY,
  globals,
  type AgentContactBeginEvent,
  type AgentContactBeginInfo,
  type SimEvent,
} from '../types';
import { gXSortedObjects, Brick, Food, type GoObject } from '../environment';
import { sincosf } from '../rng/libm';
import { averageAngles } from './agents';
import { asConcreteGenome } from './bindings';
import type { Simulation } from './simulation';
import { SheetSynapseTypes } from './simulation';

const AGENTTYPE = GObjectType.AGENT;
const FOODTYPE = GObjectType.FOOD;

/** Native `food::gMaxFoodRadius` (lane L10's static; set by the ctor's radius arithmetic). */
function maxFoodRadius(): number {
  return Food.gMaxFoodRadius;
}

/** Native `brick::gBrickRadius`. */
function brickRadius(): number {
  return Brick.gBrickRadius;
}

/** Native `globals::worldsize`. */
function globalsWorldsize(): number {
  return globals.worldsize;
}

/** Native `clamp( v, lo, hi )`. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

//===========================================================================
// Interact
//===========================================================================

/** Native `TSimulation::Interact` (`Simulation.cc:1452-1683`). */
export function interact(sim: Simulation): void {
  sim.fNewLifes = 0;
  sim.fNewDeaths = 0;
  sim.fEatStatistics.stepBegin();

  // --- step 1: keep the object list x-sorted (it is only nearly sorted between steps).
  gXSortedObjects.sort();

  // --- step 2: the fitness accumulators.
  sim.fCurrentFittestCount = 0;
  sim.fPrevAvgFitness = sim.fAverageFitness;
  sim.fAverageFitness = 0.0;
  sim.fNumAverageFitness = 0;
  for (let id = 0; id < sim.fNumDomains; id++) {
    sim.fDomains[id]!.numLeastFit = 0;
    sim.fDomains[id]!.numSmited = 0;
  }

  // --- step 3: the previous step's deaths, brain stats and least-fit bookkeeping.
  deathAndStats(sim);

  // --- step 4: Virgil healing (native `c->Heal( fAgentHealingRate, 0.0 )`; lane L8's `heal()` is
  //     the native `assert( false )` — a `Healing True` worldfile aborts in both.
  if (sim.fHealing) {
    gXSortedObjects.reset();
    for (;;) {
      const c = gXSortedObjects.nextObj(AGENTTYPE) as Agent | null;
      if (c === null) break;
      c.heal();
    }
  }

  // --- step 5: the lockstep births.
  if (sim.fLockStepWithBirthsDeathsLog && sim.fLockstepTimestep === sim.fStep) {
    mateLockstep(sim);
    sim.setNextLockstepEvent();
  }

  // --- step 6: the contact loop.
  gXSortedObjects.reset();
  for (;;) {
    const c = gXSortedObjects.nextObj(AGENTTYPE) as Agent | null;
    if (c === null) break;

    // Newborns are skipped for the whole pass (they are Age() == 0 this step).
    if (c.age() <= 0) continue;

    gXSortedObjects.setMark(AGENTTYPE);

    let cDied = false;
    for (;;) {
      const d = gXSortedObjects.nextObj(AGENTTYPE) as Agent | null;
      if (d === null) break;
      if (d === c) continue;

      // The x-sorted early-out: keys are `x - radius`, so once `d` starts beyond `c`'s right edge
      // no later object can overlap `c`.
      //
      // PORT-NOTE(L11/float-edge-comparisons): every `x ± radius` edge test on the contact/eat/
      // carry walks is a **float** comparison in native — both sides are `float` expressions, so
      // each sum/subtraction rounds to single precision before the compare. The port compared the
      // exact doubles, which decides a 1-ulp-straddling pair differently; measured on the
      // `minitest_voff` step-233..235 walk (agents 48/64).
      if (f32(d.x() - d.radius()) >= f32(c.x() + c.radius())) break;

      const dx = f32(d.x() - c.x());
      const dz = f32(d.z() - c.z());
      // `Interact` 0x947f0-0x94814 — all single precision, and the sum is contracted:
      //   94800: fmul  s3, s3, s3        ; f32(dz*dz)     <- the one rounded square
      //   94804: fmadd s2, s2, s2, s3    ; dx*dx + that, ONE rounding
      //   94808: fsqrt s2, s2            ; **float** sqrt (not the `double` overload)
      //   9480c: fadd  s0, s0, s1        ; f32(c->radius() + d->radius())
      //   94810: fcmp  s2, s0            ; the comparison is float too
      const distance = f32(Math.sqrt(f32Fma(dx, dx, f32(dz * dz))));
      if (distance > f32(d.radius() + c.radius())) continue;

      const ev = contactBegin(c, d);
      sim.postEvent(ev as unknown as SimEvent);

      mate(sim, c, d, ev);
      let dDied = false;
      if (sim.fPower2Energy > 0.0) {
        const fightResult = fight(sim, c, d, ev);
        cDied = fightResult.cDied;
        dDied = fightResult.dDied;
      }
      if (agentConfig.enableGive && !cDied && !dDied) {
        cDied = give(sim, c, d, ev, cDied, true);
        if (!cDied) dDied = give(sim, d, c, ev, dDied, false);
      }
      sim.postEvent(contactEnd(ev) as unknown as SimEvent);

      if (cDied) break;
    }

    if (cDied) continue;

    if (eat(sim, c)) continue;
    if (agentConfig.enableCarry) carry(sim, c);
    fitness(sim, c);
  }

  // --- step 7.
  sim.fEatStatistics.stepEnd();
}

//===========================================================================
// contact events (the mutators native keeps on the event structs)
//===========================================================================

/** Native `AgentContactBeginEvent::AgentInfo::init( agent * )`. */
function contactInfo(a: Agent): AgentContactBeginInfo<Agent> {
  return { a, number: a.number(), mate: MATE_NIL, fight: FIGHT_NIL, give: GIVE_NIL };
}

/** Native `AgentContactBeginEvent( c, d )`. */
function contactBegin(c: Agent, d: Agent): AgentContactBeginEvent<Agent> {
  return { type: Event_ContactBegin, c: contactInfo(c), d: contactInfo(d) } as AgentContactBeginEvent<Agent>;
}

/** Native `AgentContactBeginEvent::mate( agent*, int )` / `fight` / `give`. */
function setContactFlag(ev: AgentContactBeginEvent<Agent>, a: Agent, which: 'mate' | 'fight' | 'give', status: number): void {
  const info = ev.c.a === a ? ev.c : ev.d;
  info[which] = status;
}

/** Native `AgentContactEndEvent( AgentContactBeginEvent & )` — the same four fields, no pointers. */
function contactEnd(ev: AgentContactBeginEvent<Agent>) {
  return {
    type: Event_ContactEnd,
    c: { number: ev.c.number, mate: ev.c.mate, fight: ev.c.fight, give: ev.c.give },
    d: { number: ev.d.number, mate: ev.d.mate, fight: ev.d.fight, give: ev.d.give },
  };
}

//===========================================================================
// DeathAndStats
//===========================================================================

/** Native `TSimulation::DeathAndStats` (`Simulation.cc:1689-1920`). */
export function deathAndStats(sim: Simulation): void {
  // --- 1: the food patches' agent counts.
  if (sim.fCalcFoodPatchAgentCounts) {
    for (let id = 0; id < sim.fNumDomains; id++) {
      const domain = sim.fDomains[id]!;
      for (let p = 0; p < domain.numFoodPatches; p++) domain.foodPatches[p]!.resetAgentCounts();
    }
  }

  // --- 2: the lockstep deaths (1 draw each, walking the live list by random index).
  if (sim.fLockStepWithBirthsDeathsLog && sim.fLockstepTimestep === sim.fStep) {
    const count = gXSortedObjects.getCount(AGENTTYPE);
    for (let i = 0; i < sim.fLockstepNumDeathsAtTimestep; i++) {
      const randomIndex = Math.floor(sim.randpw() * count);
      gXSortedObjects.reset();
      let randAgent: Agent | null = null;
      for (let j = 0; j <= randomIndex; j++) {
        const a = gXSortedObjects.nextObj(AGENTTYPE) as Agent | null;
        if (a === null) break;
        randAgent = a; // the last agent seen wins, as in native
      }
      if (randAgent === null) throw new Error('sim: DeathAndStats: no agent for a lockstep death');
      sim.kill(randAgent, DeathReason.LOCKSTEP);
    }
  }

  // --- 3: the brain-stat accumulator's reset (native switches on the architecture, 1748-1763).
  switch (brainConfig.architecture) {
    case BrainArchitecture.Groups:
      sim.fCurrentBrainStats.groups.groupCount.reset();
      break;
    case BrainArchitecture.Sheets:
      sim.fCurrentBrainStats.sheets.internalSheetCount.reset();
      sim.fCurrentBrainStats.sheets.internalNeuronCount.reset();
      for (const [from, to] of SheetSynapseTypes) {
        sim.fCurrentBrainStats.sheets.synapseCount[from]![to]!.reset();
      }
      break;
    default:
      // Native `default: assert( false )`.
      throw new Error(`sim: DeathAndStats: unknown brain architecture ${String(brainConfig.architecture)}`);
  }
  sim.fCurrentBrainStats.neuronCount.reset();
  sim.fCurrentBrainStats.synapseCount.reset();

  // --- 4: the death test, in x order.
  const list = gXSortedObjects;
  list.reset();
  for (;;) {
    const c = list.nextObj(AGENTTYPE) as Agent | null;
    if (c === null) break;

    accumulateBrainStats(sim, c);

    const id = c.domain();

    if (!sim.fLockStepWithBirthsDeathsLog) {
      // The native condition, short-circuit included. In the oracle configuration
      // (`EnergyBasedPopulationControl True`, `ApplyLowPopulationAdvantage False`,
      // `AllowMinDeaths False`) clause 1 is false, clause 2 decides, and the `randpw()` of clause 3
      // is **never drawn** — a port that draws it desynchronises the global stream from step 1.
      let allowed: boolean;
      if (
        (!sim.fApplyLowPopulationAdvantage && !sim.fEnergyBasedPopulationControl) ||
        (gXSortedObjects.getCount(AGENTTYPE) > sim.fMinNumAgents &&
          sim.fNumberAliveWithMetabolism[c.metabolism()!.index]! > sim.fMinNumAgentsWithMetabolism[c.metabolism()!.index]! &&
          sim.fDomains[c.domain()]!.numAgents > sim.fDomains[c.domain()]!.minNumAgents)
      ) {
        allowed = true;
      } else if (sim.fAllowMinDeaths) {
        allowed = sim.randpw() > sim.fNumberBorn / (sim.fNumberCreated + sim.fNumberBorn);
      } else {
        allowed = false;
      }

      if (allowed) {
        const deathByPatch = c.deathByPatch();
        const energyDepleted = c.energy().isDepletedDefault();
        const tooOld = c.age() >= c.maxAge();
        const outOfBounds =
          !globals.blockedEdges &&
          !globals.wraparound &&
          (c.x() < 0.0 || c.x() > globals.worldsize || c.z() > 0.0 || c.z() < -globals.worldsize);

        if (energyDepleted || tooOld || outOfBounds || deathByPatch) {
          // Native picks the reason and counts the sub-reason in this order: age, energy, patch,
          // else edge (a patch death is the only one that changes the reason).
          let reason: DeathReason = DeathReason.NATURAL;
          if (tooOld) {
            sim.fNumberDiedAge++;
          } else if (energyDepleted) {
            sim.fNumberDiedEnergy++;
          } else if (deathByPatch) {
            sim.fNumberDiedPatch++;
            reason = DeathReason.PATCH;
          } else {
            sim.fNumberDiedEdge++;
          }
          sim.kill(c, reason);
          continue; // nothing else to do for this poor schmo
        }
      }
    }

    // --- the inside/neighbourhood counts for the patches (every domain, as in native).
    if (sim.fCalcFoodPatchAgentCounts) {
      for (let domainNumber = 0; domainNumber < sim.fNumDomains; domainNumber++) {
        const d = sim.fDomains[domainNumber]!;
        for (let foodPatchNumber = 0; foodPatchNumber < d.numFoodPatches; foodPatchNumber++) {
          const fp = d.foodPatches[foodPatchNumber]!;
          fp.checkIfAgentIsInside(c.x(), c.z());
          fp.checkIfAgentIsInsideNeighborhood(c.x(), c.z());
        }
      }
    }

    // --- the least-fit queue (native 1864-1913): only for a domain that has a queue at all.
    const domain = sim.fDomains[id]!;
    if (sim.fNumDomains > 0 && domain.maxNumLeastFit > 0) {
      if (
        domain.numAgents > domain.maxNumAgents - domain.maxNumLeastFit &&
        c.age() >= sim.fSmiteAgeFrac * c.maxAge() &&
        c.heuristicFitness() < sim.fPrevAvgFitness &&
        (domain.numLeastFit < domain.maxNumLeastFit ||
          c.heuristicFitness() < domain.leastFit[domain.numLeastFit - 1]!.heuristicFitness())
      ) {
        insertLeastFit(domain, c);
      }
    }
  }

  // --- 5: the gene statistics (snapshot + postParallel; no RNG).
  const snapshot: Agent[] = [];
  const snapshotList = gXSortedObjects;
  snapshotList.reset();
  for (;;) {
    const a = snapshotList.nextObj(AGENTTYPE) as Agent | null;
    if (a === null) break;
    snapshot.push(a);
  }
  sim.fGeneStats.compute(sim.fScheduler, snapshot);
}

/** Native `DeathAndStats`'s per-agent brain-stat accumulation (1748-1792). */
function accumulateBrainStats(sim: Simulation, c: Agent): void {
  const brain = c.getNervousSystem().getBrain() as unknown as {
    getNumNeurons(): number;
    getNumSynapses(): number;
    numNeuronGroups?(ignoreEmpty?: boolean): number;
    getNumInternalSheets?(): number;
    getNumInternalNeurons?(): number;
  };

  // PORT-NOTE(sim/brain-stats-architecture): native switches on `Brain::config.architecture` and
  // reads the architecture-specific accessor through a `dynamic_cast` to the concrete class
  // (`GroupsBrain::NumNeuronGroups()`, default `ignoreEmpty = true`; `SheetsBrain::getNumInternal*`).
  // The port's brain object *is* lane L6's concrete class, so the same switch applies; the sim
  // lane's earlier duck-typing (`typeof brain.getNumGroups === 'function'`) never matched — lane
  // L6 names the accessor `numNeuronGroups`, so `CurNeurGroups` measured `0.0 ± 0.0 [0, 0]` where
  // the golden `run/stats/stat.1` has `13.0 ± 0.0 [13, 13]`.
  switch (brainConfig.architecture) {
    case BrainArchitecture.Groups: {
      if (typeof brain.numNeuronGroups !== 'function') {
        throw new Error('sim: deathAndStats: the Groups architecture needs `GroupsBrain::NumNeuronGroups`');
      }
      sim.fCurrentBrainStats.groups.groupCount.add(Math.fround(brain.numNeuronGroups()));
      break;
    }
    case BrainArchitecture.Sheets: {
      if (typeof brain.getNumInternalSheets !== 'function' || typeof brain.getNumInternalNeurons !== 'function') {
        throw new Error('sim: deathAndStats: the Sheets architecture needs the `SheetsBrain` counters');
      }
      sim.fCurrentBrainStats.sheets.internalSheetCount.add(Math.fround(brain.getNumInternalSheets()));
      sim.fCurrentBrainStats.sheets.internalNeuronCount.add(Math.fround(brain.getNumInternalNeurons()));
      break;
    }
    default:
      // Native `default: assert( false )`.
      throw new Error(`sim: deathAndStats: unknown brain architecture ${String(brainConfig.architecture)}`);
  }

  sim.fCurrentBrainStats.neuronCount.add(Math.fround(brain.getNumNeurons()));
  sim.fCurrentBrainStats.synapseCount.add(Math.fround(brain.getNumSynapses()));
}

/** Native `DeathAndStats`'s least-fit insertion (1864-1913): worst-first, strict `<` comparisons. */
function insertLeastFit(
  domain: { leastFit: (Agent | null)[]; numLeastFit: number; maxNumLeastFit: number },
  c: Agent,
): void {
  const fitness = c.heuristicFitness();

  if (domain.numLeastFit === 0) {
    // It's the first one, so just store it.
    domain.leastFit[0] = c;
    domain.numLeastFit++;
    return;
  }

  // Find the position to be replaced.
  let i = 0;
  for (; i < domain.numLeastFit; i++) {
    if (fitness < domain.leastFit[i]!.heuristicFitness()) break; // worse than the one in this slot
  }

  if (i < domain.numLeastFit) {
    // Move some of the items in the list down; if there is room left, add a slot.
    if (domain.numLeastFit < domain.maxNumLeastFit) domain.numLeastFit++;
    for (let j = domain.numLeastFit - 1; j > i; j--) {
      domain.leastFit[j] = domain.leastFit[j - 1]!;
    }
  } else {
    // PORT-NOTE(sim/leastfit-overflow): native increments past `fMaxNumLeastFit` here, writing one
    // past the end of an array of exactly that size (the queue's own capacity check upstream makes
    // it unreachable in practice). JS arrays grow, so the port's assignment is defined where
    // native's was undefined; the counter and the ordering are identical.
    domain.numLeastFit++;
  }

  // Store the new i-th worst.
  domain.leastFit[i] = c;
}

//===========================================================================
// Mate
//===========================================================================

/** Native `TSimulation::GetMatePotential( agent *x )` (`Simulation.cc:2040-2078`). */
function getMatePotential(sim: Simulation, x: Agent): number {
  let status = MATE_NIL;

  const nerves = x.outputNervesTable();
  let desiresMate = nerves.mate.get() > sim.fMateThreshold;
  if (sim.fProbabilisticMating && desiresMate) {
    desiresMate = sim.randpw() < x.mateProbability(x);
  }

  if (!desiresMate) return MATE_NIL;

  status |= MATE_DESIRED;

  if (isPreventedByCarry(sim, 'mate', x)) status |= MATE_PREVENTED_CARRY;
  if (x.age() - x.lastMate() < sim.fMateWait) status |= MATE_PREVENTED_MATE_WAIT;
  if (x.normalizedEnergy() <= sim.fMinMateFraction) status |= MATE_PREVENTED_ENERGY;
  if (sim.fEatMateSpan > 0 && sim.fStep - x.lastEat() >= sim.fEatMateSpan) status |= MATE_PREVENTED_EAT_MATE_SPAN;
  if (sim.fEatMateMinDistance > 0 && x.lastEat() > 0 && x.lastEatDistance() < sim.fEatMateMinDistance) {
    status |= MATE_PREVENTED_EAT_MATE_MIN_DISTANCE;
  }
  if (x.normalizedSpeed() > sim.fMaxMateVelocity) status |= MATE_PREVENTED_MAX_VELOCITY;

  return status;
}

/** Native `TSimulation::GetMateStatus( xPotential, yPotential )` (`Simulation.cc:2083-2096`). */
function getMateStatus(xPotential: number, yPotential: number): number {
  let status = xPotential;

  // Native *adds* the partner bit and leaves `MATE__DESIRED` standing — the contact log prints
  // `M` from it (`Logs.cc:1076-1087`), so clearing it here would drop a letter from
  // `run/events/contacts.log`. The pair is only mate-worthy when both sides are *exactly*
  // `MATE__DESIRED` (native's `GetMateDenialStatus`/`Mate` comparison).
  if (xPotential & MATE_DESIRED) {
    if (yPotential !== MATE_DESIRED) status |= MATE_PREVENTED_PARTNER;
  }

  return status;
}

/**
 * Native `TSimulation::GetMateDenialStatus( x, &xStatus, y, &yStatus, domainID )`
 * (`Simulation.cc:2101-2149`).
 *
 * PORT-NOTE(sim/mate-denial-accumulates): native **ORs every** prevention bit into `status`
 * (`__SET` for MaxDomain, MaxWorld, MaxMetabolism), only then tests `status == MATE__NIL` for the
 * `Misc` draw, and finally ORs the result into *both* agents' statuses. An early return would lose
 * `MATE__PREVENTED__MAX_WORLD` whenever the domain is already full — which is exactly the case for
 * every contact in a run that starts at `MaxNumAgents` — and the golden's `run/events/contacts.log`
 * prints `MdxF` (M + MAX_DOMAIN + MAX_WORLD + F) against the port's `MF`.
 */
function getMateDenialStatus(
  sim: Simulation,
  x: Agent,
  y: Agent,
  xStatus: { value: number },
  yStatus: { value: number },
  domainID: number,
): number {
  const domain = sim.fDomains[domainID]!;
  let status = MATE_NIL;

  const preventedByMaxDomain = domain.numAgents >= domain.maxNumAgents;
  const preventedByMaxWorld = sim.fNumberAlive >= sim.maxAgents();

  // Native divides the *static* `fMaxNumAgents` by the metabolism count (integer division) and
  // tests **both** agents' metabolisms.
  let preventedByMaxMetabolism = false;
  const metabolisms = Metabolism.getNumberOfDefinitions();
  if (metabolisms > 1) {
    const quota = Math.trunc(sim.maxAgents() / metabolisms);
    preventedByMaxMetabolism =
      sim.fNumberAliveWithMetabolism[x.metabolism()!.index]! >= quota ||
      sim.fNumberAliveWithMetabolism[y.metabolism()!.index]! >= quota;
  }

  if (preventedByMaxDomain) status |= MATE_PREVENTED_MAX_DOMAIN;
  if (preventedByMaxWorld) status |= MATE_PREVENTED_MAX_WORLD;
  if (preventedByMaxMetabolism) status |= MATE_PREVENTED_MAX_METABOLISM;

  if (status === MATE_NIL) {
    // We only check misc if not rejected by max. We do this so the random number
    // generator state is the same as in older versions of the simulator (native comment).
    if (sim.fMiscAgents >= 0 && domain.numbornsincecreated >= sim.fMiscAgents) {
      if (sim.randpw() >= x.mateProbability(y)) status |= MATE_PREVENTED_MISC;
    }
  }

  if (!sim.fAllowBirths) status |= MATE_PREVENTED_WORLDFILE;

  xStatus.value |= status;
  yStatus.value |= status;

  return status;
}

/** Native `TSimulation::Mate( c, d, contactEvent )` (`Simulation.cc:2154-2287`). */
function mate(sim: Simulation, c: Agent, d: Agent, ev: AgentContactBeginEvent<Agent>): void {
  const cPot = getMatePotential(sim, c);
  const dPot = getMatePotential(sim, d);
  let cStat = getMateStatus(cPot, dPot);
  let dStat = getMateStatus(dPot, cPot);

  if (cStat === MATE_DESIRED && dStat === MATE_DESIRED) {
    if (sim.fHeuristicFitnessWeight !== 0 || sim.fComplexityFitnessWeight !== 0 || sim.fLockStepWithBirthsDeathsLog) {
      // --- steady-state GA / lockstep: virtual births (no new agent).
      c.mating(sim.fMateFitnessParameter, sim.fMateWait, false);
      d.mating(sim.fMateFitnessParameter, sim.fMateWait, false);
      sim.fNumberBornVirtual++;
      sim.birth(null, BirthReason.VIRTUAL, c, d);
    } else {
      const kd = sim.whichDomain(0.5 * (c.x() + d.x()), 0.5 * (c.z() + d.z()), 0);

      smite(sim, kd, c, d);

      const cStatBox = { value: cStat };
      const dStatBox = { value: dStat };
      const denial = getMateDenialStatus(sim, c, d, cStatBox, dStatBox, kd);
      cStat = cStatBox.value;
      dStat = dStatBox.value;
      if (denial !== MATE_NIL) {
        sim.fBirthDenials++;
        if (denial & MATE_PREVENTED_MISC) sim.fMiscDenials++;
      } else {
        sim.fNumBornSinceCreated++;
        sim.fDomains[kd]!.numbornsincecreated++;

        const e = Agent.getFreeAgent(sim.deps());
        // Native `e->Genes()->crossover( c->Genes(), d->Genes(), true )`. Lane L8's `GenomeLike`
        // has no `crossover` (it is the narrow seam), so unwrap to the concrete `Genome` — the same
        // helper `asConcreteGenome` that `AgentGenomeAdapter.mateProbability` uses two lines away.
        asConcreteGenome(e.genes()).crossover(
          asConcreteGenome(c.genes()),
          asConcreteGenome(d.genes()),
          true,
        );
        e.setGenomeReady();

        const cEnergy = c.mating(sim.fMateFitnessParameter, sim.fMateWait, false);
        const dEnergy = d.mating(sim.fMateFitnessParameter, sim.fMateWait, false);
        // Native `eenergy = c->mating(...) + d->mating(...)`.
        const eenergy = cEnergy.clone();
        eenergy.addAssign(dEnergy);

        // Native `TSimulation::Mate` 0x98490-0x98510 / 0x98614-0x9861c: the birth location is
        // **single precision** — `fadd s0, s0, s1` (float sum) then `fmul s13, s0, s5` (×0.5f),
        // for x, z *and* y (the y pair is loaded at 0x98504/0x98508 and combined at 0x98618).
        // The port's `0.5 * (c.x() + d.x())` left the sum in double, which is 1 ulp away whenever
        // the float sum rounds.
        let x = f32(f32(c.x() + d.x()) * 0.5);
        const y = f32(f32(c.y() + d.y()) * 0.5);
        let z = f32(f32(c.z() + d.z()) * 0.5);
        const yaw = averageAngles(c.yaw(), d.yaw());

        if (sim.fRandomBirthLocation) {
          // `TSimulation::Mate` 0x98524-0x98610 — every step below is single precision and the
          // two position updates are contracted (`PARITY.md` -> *the contraction sweep*):
          //   98540: fmul  s1, s11, s8       ; f32(worldsize * fRandomBirthLocationRadius)
          //   98544/98548/9854c: fcvt/fmul/fcvt  ; distance = f32(randpw() * that)
          //   98564/98568: fmul/fcvt          ; angle = f32(2*M_PI * randpw())
          //   9856c: bl    ___sincosf_stret   ; ONE call, both lanes — see below
          //   98570: fmadd s1, s8, s1, s13    ; x = distance*cosf(angle) + x   ONE rounding
          //   98574: fmsub s0, s8, s0, s14    ; z = z - distance*sinf(angle)   ONE rounding
          // (`fmsub a, b, c` is `c - a*b`, i.e. `f32Fma(-a, b, c)` — the negation is exact.)
          //
          // The trig is **not** a narrowed `Math.cos`/`Math.sin`: `0x9856c` is a single
          // `bl 0xa3994 <symbol stub for: ___sincosf_stret>` — LLVM's fused two-output
          // float entry in the `sinf`/`cosf` unit (`sinf + 0x1ac`), the *same* overload the
          // camera reaches (PARITY -> `W1d-fu/camera-calls-sincosf-not-sinf-cosf`) and a
          // different algorithm from the scalar pair. The returned pair is `[sin, cos]`, which
          // is the order `98570`/`98574` read: `s1` = cos feeds x, `s0` = sin feeds z.
          const distance = f32(sim.randpw() * f32(globalsWorldsize() * sim.fRandomBirthLocationRadius));
          const angle = f32(2 * Math.PI * sim.randpw());
          const [sinAngle, cosAngle] = sincosf(angle);
          x = f32(f32Fma(distance, cosAngle, x));
          z = f32(f32Fma(-distance, sinAngle, z));
          x = clamp(x, 0.01, f32(globalsWorldsize() - 0.01));
          z = clamp(z, f32(-globalsWorldsize() + 0.01), -0.01);
        }

        e.setX(x);
        e.setY(y);
        e.setZ(z);
        e.setYaw(yaw);
        e.setDomain(kd);

        sim.fNewLifes++;
        sim.fDomains[kd]!.numAgents++;
        sim.fNumberBorn++;
        sim.fDomains[kd]!.numborn++;

        sim.birth(e, BirthReason.NATURAL, c, d);

        // Native POST PARALLEL.
        sim.fScheduler.postParallel(() => {
          e.grow(sim.fMateWait);
          eenergy.constrain(new Energy(0), e.maxEnergy());
          e.setEnergy(eenergy);
          e.setFoodEnergy(eenergy);
        });

        // Native POST SERIAL: stage + the x-sorted list. The cursor is saved and restored around
        // the insertion, because the outer pass is walking the same list.
        sim.fScheduler.postSerial(() => {
          sim.getStage().addObject(e as never);
          const cursor = gXSortedObjects.getcurr();
          gXSortedObjects.add(e as never);
          gXSortedObjects.setcurr(cursor);
        });
      }
    }
  }

  setContactFlag(ev, c, 'mate', cStat);
  setContactFlag(ev, d, 'mate', dStat);
}

//===========================================================================
// Smite
//===========================================================================

/** Native `TSimulation::Smite( kd, c, d )` (`Simulation.cc:2292-2361`). */
function smite(sim: Simulation, kd: number, c: Agent, d: Agent): void {
  const domain = sim.fDomains[kd]!;

  if (sim.fSmiteMode === 'L') {
    // Smite the least fit.
    if (domain.numAgents >= domain.maxNumAgents && domain.numLeastFit > domain.numSmited) {
      while (
        domain.numSmited < domain.numLeastFit &&
        (domain.leastFit[domain.numSmited] === c || // trying to smite mommy
          domain.leastFit[domain.numSmited] === d || // trying to smite daddy
          (sim.fCurrentFittestCount > 0 &&
            domain.leastFit[domain.numSmited]!.heuristicFitness() >=
              sim.fCurrentMaxFitness[sim.fCurrentFittestCount - 1]!))
      ) {
        domain.numSmited++;
      }

      if (domain.numSmited < domain.numLeastFit) {
        sim.kill(domain.leastFit[domain.numSmited]!, DeathReason.SMITE);
        domain.numSmited++;
        sim.fNumberDiedSmite++;
      }
    }
    return;
  }

  if (sim.fSmiteMode === 'R') {
    // Random smite.
    if (domain.numAgents >= domain.maxNumAgents) {
      let i = 0;
      let randAgent: Agent | null = null;
      const randomIndex = Math.floor(sim.randpw() * domain.numAgents);

      const saveCurr = gXSortedObjects.getcurr(); // save the state of the x-sorted list

      // As native notes: `randAgent` may not be exactly the randomIndex-th agent in the domain, but
      // it will be close, and any legitimate agent will do.
      gXSortedObjects.reset();
      for (;;) {
        const testAgent = gXSortedObjects.nextObj(AGENTTYPE) as Agent | null;
        if (testAgent === null || i > randomIndex) break;

        if (testAgent.domain() === kd) {
          i++; // in the right domain: count it even if it may not be smited
          if (
            testAgent.age() > sim.fSmiteAgeFrac * testAgent.maxAge() &&
            testAgent.number() !== c.number() &&
            testAgent.number() !== d.number()
          ) {
            randAgent = testAgent;
          }
        }

        if (i > randomIndex && randAgent !== null) break;
      }

      gXSortedObjects.setcurr(saveCurr); // restore the state of the x-sorted list

      if (randAgent !== null) {
        domain.numSmited++;
        sim.fNumberDiedSmite++;
        sim.kill(randAgent, DeathReason.SMITE);
      }
    }
    return;
  }

  // `'O'` (off) — the oracle worldfiles. Nothing happens.
}

//===========================================================================
// Fight
//===========================================================================

/** Native `TSimulation::GetFightStatus( x, y, &power )` (`Simulation.cc:2366-2402`). */
function getFightStatus(sim: Simulation, x: Agent, y: Agent): { status: number; power: number } {
  const nerves = x.outputNervesTable();
  // Native `float agent::Fight()` — the nerve's value crosses a `float` boundary: the brain's
  // activation buffer is `double` (`Brain::getActivations`), but the accessor the sim calls returns
  // a `float`, so *both* the threshold test and the power chain below see the f32-rounded value.
  // (Measured: agent 5's `1 5 F 2 … 26.815681` row is 1 ulp low with the un-narrowed activation.)
  const fightNerve = Math.fround(nerves.fight.get());
  const desiresFight = fightNerve > sim.fFightThreshold;

  // Native `*out_power = fFightFraction * x->Strength() * x->SizeAdvantage() * x->Fight() *
  // x->NormalizedEnergy()` with `*out_power` a **float** — every step of the chain is rounded to
  // float32. Evaluated in double (JS default) the chain is 1-2 ulp off, which
  // `run/events/energy.log` shows as `Energy0 16.703859` against the golden's `16.703857`.
  // PORT-NOTE(sim/fight-power-float-chain).
  let power = Math.fround(
    Math.fround(
      Math.fround(Math.fround(sim.fFightFraction * x.strength()) * x.sizeAdvantage()) * fightNerve,
    ) * x.normalizedEnergy(),
  );

  if (!desiresFight) power = 0;

  let status = FIGHT_NIL;
  if (!desiresFight) return { status, power };

  status |= FIGHT_DESIRED;
  if (isPreventedByCarry(sim, 'fight', x)) status |= FIGHT_PREVENTED_CARRY;
  if (carriesAnyOf(y, sim.fShieldObjects)) status |= FIGHT_PREVENTED_SHIELD;
  if (power <= 0) status |= FIGHT_PREVENTED_POWER;

  if (status !== FIGHT_DESIRED) power = 0;

  return { status, power };
}

/**
 * Native `TSimulation::Fight( c, d, contactEvent, cDied, dDied )` (`Simulation.cc:2407-2473`).
 *
 * PORT-NOTE(sim/fight-died-out-params): native writes `*cDied`/`*dDied` by reference and
 * `Interact`'s contact walk depends on them — `if (cDied) break;` inside the inner walk and
 * `if (!cDied && !dDied)` for the Give calls. Dropping them (the port's earlier shape) let the
 * inner walk carry on after the killed `c` had been unlinked, which re-reached the same pair and
 * killed the agent a *second* time (`AgentEnergyLog` then wrote a row for an agent whose file was
 * already closed: `datalib: addRow without a table`, `minitest_voff` step 28, agent 23 — the
 * golden's own `lifespans.txt` row `23 0 SIMINIT 28 FIGHT` is the death the port reproduced twice).
 */
function fight(
  sim: Simulation,
  c: Agent,
  d: Agent,
  ev: AgentContactBeginEvent<Agent>,
): { cDied: boolean; dDied: boolean } {
  // Native has no early return for the lockstep mode: it gates only the *deaths* (below), so the
  // damage, the fight count and the contact flags all happen under lockstep too.
  const cStatus = getFightStatus(sim, c, d);
  const dStatus = getFightStatus(sim, d, c);

  const nullMode = sim.fFightMode === 1; // native `FM_NULL`

  // Native `Simulation.cc:2422-2423`: the contact event carries both statuses **always**, even
  // when neither side wants to fight (the pair's `Events` column reads them).
  setContactFlag(ev, c, 'fight', cStatus.status);
  setContactFlag(ev, d, 'fight', dStatus.status);

  let cDied = false;
  let dDied = false;

  // Native `Simulation.cc:2425`: the whole body is guarded by "somebody wants to fight". The port
  // applied the damage and ran the depletion checks unconditionally, so a pair where
  // `GetFightStatus` zeroed both powers still counted as a fight and — the model-visible half — an
  // agent whose energy was already depleted (it is killed NATURAL by the *next* step's
  // `DeathAndStats`) was killed here instead, as `FIGHT`. Measured on `minitest_voff` step 100:
  // golden `-fight 2` / `-energy 15` against the port's `-fight 10` / `-energy 13`, and the
  // `lifespans.txt` rows `5 0 SIMINIT 53 NATURAL` (golden) vs `5 0 SIMINIT 58 FIGHT`.
  if (cStatus.power > 0 || dStatus.power > 0) {
    sim.fNumberFights++;

    if (cStatus.power > 0) {
      const dDamage = d.damage(new Energy(Math.fround(cStatus.power * sim.fPower2Energy)), nullMode);
      if (!dDamage.isZero()) {
        sim.postEvent({
          type: Event_Energy,
          a: c,
          obj: d,
          neuralActivation: c.outputNervesTable().fight.get(),
          energy: dDamage,
          energyRaw: dDamage,
          action: EnergyAction.Fight,
        } as unknown as SimEvent);
      }
    }

    if (dStatus.power > 0) {
      const cDamage = c.damage(new Energy(Math.fround(dStatus.power * sim.fPower2Energy)), nullMode);
      if (!cDamage.isZero()) {
        sim.postEvent({
          type: Event_Energy,
          a: d,
          obj: c,
          neuralActivation: d.outputNervesTable().fight.get(),
          energy: cDamage,
          energyRaw: cDamage,
          action: EnergyAction.Fight,
        } as unknown as SimEvent);
      }
    }

    // Native `Simulation.cc:2446-2469`: only the deaths are gated on the lockstep mode — damage
    // and the events above happen under lockstep too.
    if (!sim.fLockStepWithBirthsDeathsLog) {
      if (d.energy().isDepletedDefault()) {
        sim.kill(d, DeathReason.FIGHT);
        sim.fNumberDiedFight++;
        dDied = true;
      }
      if (c.energy().isDepletedDefault()) {
        gXSortedObjects.toMark(AGENTTYPE);
        sim.kill(c, DeathReason.FIGHT);
        sim.fNumberDiedFight++;
        cDied = true;
      }
    }
  }

  return { cDied, dDied };
}

//===========================================================================
// Give
//===========================================================================

/** Native `TSimulation::GetGiveStatus( x, &energy )` (`Simulation.cc:2478-2510`). */
function getGiveStatus(sim: Simulation, x: Agent): { status: number; energy: Energy } {
  const nerves = x.outputNervesTable();
  const desiresGive = nerves.give === null ? false : nerves.give.get() > sim.fGiveThreshold;

  if (!desiresGive) return { status: GIVE_NIL, energy: new Energy(0) };

  let status = GIVE_DESIRED;
  const energy = x.energy().mulScalar(nerves.give!.get() * sim.fGiveFraction);
  if (isPreventedByCarry(sim, 'give', x)) status |= GIVE_PREVENTED_CARRY;
  if (energy.isDepletedDefault()) status |= GIVE_PREVENTED_ENERGY;

  if (status !== GIVE_DESIRED) return { status, energy: new Energy(0) };
  return { status, energy };
}

/** Native `TSimulation::Give( x, y, contactEvent, xDied, toMarkOnDeath )` (`Simulation.cc:2515-2554`). */
function give(
  sim: Simulation,
  x: Agent,
  y: Agent,
  ev: AgentContactBeginEvent<Agent>,
  xDiedIn: boolean,
  toMarkOnDeath: boolean,
): boolean {
  let xDied = xDiedIn;
  const { status, energy } = getGiveStatus(sim, x);

  if (status === GIVE_DESIRED) {
    const actual = y.receive(x, energy);
    if (!actual.isZero()) {
      sim.postEvent({
        type: Event_Energy,
        a: x,
        obj: y,
        neuralActivation: x.outputNervesTable().give!.get(),
        energy: actual,
        energyRaw: energy,
        action: EnergyAction.Give,
      } as unknown as SimEvent);
    }
  }

  setContactFlag(ev, x, 'give', status);

  if (!sim.fLockStepWithBirthsDeathsLog && x.energy().isDepletedDefault()) {
    if (toMarkOnDeath) gXSortedObjects.toMark(AGENTTYPE);
    // Native kills a giver that gave itself to death with `DR_NATURAL` (`Simulation.cc:2543`).
    sim.kill(x, DeathReason.NATURAL);
    xDied = true;
  }

  return xDied;
}

//===========================================================================
// Eat
//===========================================================================

/** Native `TSimulation::Eat( c, cDied )` (`Simulation.cc:2561-2739`). */
function eat(sim: Simulation, c: Agent): boolean {
  const nerves = c.outputNervesTable();

  const carryPrevented = isPreventedByCarry(sim, 'eat', c);
  const tooFast = c.normalizedSpeed() > sim.fMaxEatVelocity;
  const tooSlow = c.normalizedSpeed() < sim.fMinEatVelocity;
  const tooCrooked = Math.abs(c.normalizedYaw()) > sim.fMaxEatYaw;
  const tooYoung = c.age() < c.metabolism()!.minEatAge;
  const eatWait = sim.fStep - c.lastEat() < sim.fEatWait;

  const eatAllowed = !carryPrevented && !tooFast && !tooSlow && !tooCrooked && !tooYoung && !eatWait;

  let eatAttempted = false;
  let failedYaw = false;
  let failedVel = false;
  let failedMinAge = false;

  // --- 1: the backwards scan from the mark.
  //
  // PORT-NOTE(sim/eat-scan-compat): with `CompatibilityMode` (=1) the backward walk is **only**
  // the early-out test (`Simulation.cc:2610-2619`, `#if CompatibilityMode`): it walks back until
  // even the largest possible piece of food would entirely precede the agent, then stops. It never
  // eats and never sets `eatAttempted` — the eat attempt lives in the forward scan below, which is
  // guarded by `!ateBackwardFood && !eatAttempted` and therefore *always* runs here. A port that
  // ate in the backward walk skipped the forward walk and ate a different piece of food.
  gXSortedObjects.toMark(AGENTTYPE);
  for (;;) {
    const f = gXSortedObjects.prevObj(FOODTYPE) as Food | null;
    if (f === null) break;

    if (f.x() + 2 * maxFoodRadius() < c.x() - c.radius()) break;
  }

  // --- 2: the forwards scan.
  //
  // PORT-NOTE(sim/eat-forward-cursor): native only re-points the list at the agent's mark for the
  // forward scan in the `#else` branch (`Simulation.cc:2652-2654`, `#if ! CompatibilityMode`).
  // With `CompatibilityMode` = 1 (`Simulation.cc:26`) the forward walk **continues from wherever
  // the backward walk left the cursor**: if that walk broke on the distance test the cursor is one
  // food *behind* the agent, and if it ran off the front of the list the forward walk starts from
  // the head. Re-marking the agent here skipped the food the golden eats (agent 14's
  // `1 14 E 1 0.991517 10.578552` row was missing entirely and its step-1 energy was the unscaled
  // 740.401855 instead of 750.980408).
  {
    for (;;) {
      const f = gXSortedObjects.nextObj(FOODTYPE) as Food | null;
      if (f === null) break;

      if (f32(f.x() - f.radius()) > f32(c.x() + c.radius())) break;

      // `#if CompatibilityMode`'s overlap test. See PORT-NOTE(L11/float-edge-comparisons): both
      // edges and the z reach are float expressions.
      if (f32(f.x() + f.radius()) > f32(c.x() - c.radius())) {
        if (Math.abs(f32(f.z() - c.z())) < f32(f.radius() + c.radius())) {
          eatAttempted = true;
          failedYaw = tooCrooked;
          failedVel = tooFast || tooSlow;
          failedMinAge = tooYoung;
          if (!eatAllowed) break;

          eatOne(sim, c, f);
          break;
        }
      }
    }
  }

  if (eatAttempted) {
    sim.fEatStatistics.agentEatAttempt(eatAllowed, failedYaw, failedVel, failedMinAge);
  }

  gXSortedObjects.toMark(AGENTTYPE);

  // --- 3: the eat death test (never in lockstep mode).
  if (!sim.fLockStepWithBirthsDeathsLog) {
    const starved =
      c.isSeed() || c.age() >= agentConfig.starvationWait
        ? c.foodEnergy().isDepleted(c.starvationFoodEnergy())
        : false;
    if (c.energy().isDepletedDefault() || starved) {
      sim.kill(c, DeathReason.EAT);
      sim.fNumberDiedEat++;
      return true;
    }
  }

  return false;
}

/** Native `Eat`'s per-food body (the eat call, the energy events and the removal rules). */
function eatOne(sim: Simulation, c: Agent, f: Food): void {
  const result = c.eat(
    f as unknown as Parameters<typeof c.eat>[0],
    sim.fEatFitnessParameter,
    sim.fEat2Consume,
    sim.fEatThreshold,
    sim.fStep,
  );

  sim.postEvent({
    type: Event_Energy,
    a: c,
    obj: f,
    neuralActivation: c.outputNervesTable().eat.get(),
    energy: result.actuallyEat,
    energyRaw: result.rawEat,
    action: EnergyAction.Eat,
  } as unknown as SimEvent);

  if (sim.fEvents !== null) {
    sim.fEvents.addEvent(sim.fStep, c.number(), 'e');
  }

  // Native `FoodEnergyOut( foodEnergyLost )` (`Simulation.cc:2703`): the eat's contribution to the
  // "out" total is what the agent's *food energy* clamp threw away, not what the food held — the
  // food's own contents are counted once, by `RemoveFood` (`maintain.ts`), when it is depleted.
  sim.foodEnergyOut(result.lost);
  sim.fEnergyEaten.addAssign(result.actuallyEat);

  if (f.isDepleted() || sim.fFoodRemoveFirstEat) {
    sim.removeFood(f);
  }
}

//===========================================================================
// Carry / Pickup / Drop
//===========================================================================

/** Native `TSimulation::Carry( c )` (`Simulation.cc:2744-2755`). */
function carry(sim: Simulation, c: Agent): void {
  const nerves = c.outputNervesTable();

  if (nerves.pickup !== null && nerves.pickup.get() > sim.fPickupThreshold && c.numCarries() < agentConfig.maxCarries) {
    pickup(sim, c);
  }
  if (nerves.drop !== null && nerves.drop.get() > sim.fDropThreshold && c.numCarries() > 0) {
    drop(sim, c);
  }
}

/** Native `TSimulation::Pickup( c )` (`Simulation.cc:2760-2810`). */
function pickup(sim: Simulation, c: Agent): void {
  const maxOut = Math.max(maxFoodRadius(), agentConfig.maxRadius);
  const maxRadius = Math.max(maxOut, brickRadius());

  const tryPickup = (o: unknown): boolean => {
    if (c.numCarries() >= agentConfig.maxCarries) return false;
    const obj = o as {
      carriedBy(): unknown;
      numCarries(): number;
      x(): number;
      z(): number;
      radius(): number;
    };
    if (obj.carriedBy() !== null) return false;
    if (obj.numCarries() > 0) return false;
    if (
      f32(c.x() - c.radius()) < f32(obj.x() + obj.radius()) &&
      f32(c.x() + c.radius()) > f32(obj.x() - obj.radius()) &&
      Math.abs(f32(c.z() - obj.z())) < f32(obj.radius() + c.radius())
    ) {
      c.pickupObject(obj as never);
      return true;
    }
    return false;
  };

  // --- backwards from the mark.
  gXSortedObjects.toMark(AGENTTYPE);
  for (;;) {
    const o = gXSortedObjects.prevObj(sim.fCarryObjects) as unknown | null;
    if (o === null) break;
    if (c.numCarries() >= agentConfig.maxCarries) break;
    const obj = o as { x(): number; radius(): number };
    if (obj.x() + 2 * maxRadius < c.x() - c.radius()) break;
    tryPickup(o);
  }

  // --- forwards, if there is still room.
  if (c.numCarries() < agentConfig.maxCarries) {
    gXSortedObjects.toMark(AGENTTYPE);
    for (;;) {
      const o = gXSortedObjects.nextObj(sim.fCarryObjects) as unknown | null;
      if (o === null) break;
      if (c.numCarries() >= agentConfig.maxCarries) break;
      const obj = o as { x(): number; radius(): number };
      if (f32(obj.x() - obj.radius()) > f32(c.x() + c.radius())) break;
      tryPickup(o);
    }
  }

  gXSortedObjects.toMark(AGENTTYPE);
}

/** Native `TSimulation::Drop( c )` (`Simulation.cc:2815-2830`). */
function drop(sim: Simulation, c: Agent): void {
  void sim;
  c.dropMostRecent();
}

//===========================================================================
// Fitness
//===========================================================================

/** Native `TSimulation::Fitness( c )` (`Simulation.cc:2864-2909`). */
function fitness(sim: Simulation, c: Agent): void {
  const hf = c.heuristicFitness();

  if (c.age() >= sim.fSmiteAgeFrac * c.maxAge()) {
    sim.fAverageFitness += hf;
    sim.fNumAverageFitness++;
  }

  if (
    sim.fCurrentFittestCount < 5 ||
    hf > sim.fCurrentMaxFitness[sim.fCurrentFittestCount - 1]!
  ) {
    let rank = -1;
    for (let i = 0; i < sim.fCurrentFittestCount; i++) {
      if (hf > sim.fCurrentMaxFitness[i]!) {
        rank = i;
        break;
      }
    }
    if (rank === -1) {
      if (sim.fCurrentFittestCount >= 5) return;
      rank = sim.fCurrentFittestCount;
    }

    if (sim.fCurrentFittestCount < 5) sim.fCurrentFittestCount++;

    for (let i = sim.fCurrentFittestCount - 1; i > rank; i--) {
      sim.fCurrentMaxFitness[i] = sim.fCurrentMaxFitness[i - 1]!;
      sim.fCurrentFittestAgent[i] = sim.fCurrentFittestAgent[i - 1]!;
    }
    sim.fCurrentMaxFitness[rank] = hf;
    sim.fCurrentFittestAgent[rank] = c;
  }
}

//===========================================================================
// MateLockstep
//===========================================================================

/** Native `TSimulation::MateLockstep()` (`Simulation.cc:1925-2035`). */
function mateLockstep(sim: Simulation): void {
  for (let i = 0; i < sim.fLockstepNumBirthsAtTimestep; i++) {
    // The parents are drawn by random index out of the live list, then the child is placed at the
    // parents' midpoint (two more draws for the position and one for the yaw).
    const count = gXSortedObjects.getCount(AGENTTYPE);
    const iParent = Math.floor(sim.randpw() * count);
    const jParent = Math.floor(sim.randpw() * count);

    gXSortedObjects.reset();
    let c: Agent | null = null;
    let d: Agent | null = null;
    for (let j = 0; j < count; j++) {
      const a = gXSortedObjects.nextObj(AGENTTYPE) as Agent | null;
      if (a === null) break;
      if (j === iParent) c = a;
      if (j === jParent) d = a;
    }
    if (c === null || d === null) {
      throw new Error('sim: MateLockstep: could not resolve a parent (native asserts)');
    }

    // A lockstep "birth" draws the position, not the parents' genes: native picks x, z and yaw.
    const x = sim.randpw() * globalsWorldsize();
    const z = -sim.randpw() * globalsWorldsize();
    const yaw = sim.randpw() * 360.0;

    sim.kill(c, DeathReason.LOCKSTEP);
    void d;
    void x;
    void z;
    void yaw;
    throw new Error(
      'sim: MateLockstep is reachable only in `PassiveLockstep` mode, which no recorded scenario ' +
        'uses; its remaining body (the genome draw + Birth) is transcribed in `PARITY.md -> Gaps` ' +
        'for the lane that lands lockstep replay',
    );
  }
}

//===========================================================================
// shared predicates
//===========================================================================

/**
 * Native `agent::IsCarrying( int objectType )` — true when the agent carries an object whose
 * `gobject::getType()` bit is in `objectType` (used for the fight shield test and `IS_PREVENTED_BY_CARRY`'s
 * sibling in `GetFightStatus`).
 */
function carriesAnyOf(a: Agent, objectTypes: number): boolean {
  for (const carried of a.carryList()) {
    if ((carried.getType() & objectTypes) !== 0) return true;
  }
  return false;
}

/**
 * Native `IS_PREVENTED_BY_CARRY( ACTION, AGENT )` (`Simulation.cc:182-183`):
 *
 *     (fCarryPrevents<ACTION> != 0) && ((AGENT)->NumCarries() > 0) && (randpw() < fCarryPrevents<ACTION>)
 *
 * PORT-NOTE(sim/rng-shortcircuit): the draw happens **only** when the first two clauses hold, so a
 * zero coefficient (the oracle worldfiles) consumes nothing.
 */
function isPreventedByCarry(sim: Simulation, action: 'eat' | 'fight' | 'give' | 'mate', agent: Agent): boolean {
  const coefficient =
    action === 'eat'
      ? sim.fCarryPreventsEat
      : action === 'fight'
        ? sim.fCarryPreventsFight
        : action === 'give'
          ? sim.fCarryPreventsGive
          : sim.fCarryPreventsMate;

  if (coefficient === 0) return false;
  if (agent.numCarries() <= 0) return false;
  return sim.randpw() < coefficient;
}
