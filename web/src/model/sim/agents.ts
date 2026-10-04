/**
 * Lane L11 (sim) — the agent lifecycle: `CreateAgents`, `Birth`, `Kill`, `analyzeBrain`,
 * `updateFittest`, `AgentFitness` and the two parent-selection walkers (native `Simulation.cc`
 * 2914-3148, 3384-3717, 3772-3817, 1221-1240, 3360-3378, 114-128).
 *
 * PORT-NOTE(sim/lifecycle-deferral): `Birth` and `Kill` are where the recorded (parallel) schedule
 * shows through. `Kill` posts `analyzeBrain` on the *parallel* batch and `updateFittest`/`delete`
 * on the *serial* batch, so in the recorded configuration the fittest-list update happens after the
 * whole `Interact()` master task has finished — while `CreateAgents` (a later master task) still
 * sees it. Inlining either would change the trajectory (sim-spec PORT-NOTE(sched-deferral)).
 *
 * PORT-NOTE(sim/carcass-food): `Kill`'s carcass path builds a real `food` object through lane L10's
 * constructor with the agent's `GetFoodEnergy()`, the metabolism's carcass `FoodType` and the
 * min-energy rules; the *energy accounting* (`FoodEnergyIn( addedEnergy * -1 )`, `FoodEnergyOut`)
 * is exactly native's, because the recorded `energy/**` logs are the acceptance gate.
 */

import { Agent, agentConfig, Energy, f32, f32Fma, type EnergyPolarity } from '../agent';
import { Food, FoodType, gXSortedObjects } from '../environment';
import { genomeUtil, separationCache, type Genome } from '../genome';
import {
  BirthReason,
  DeathReason,
  Event_AgentBirth,
  Event_AgentDeath,
  Event_BrainAnalysisBegin,
  Event_BrainAnalysisEnd,
  GObjectType,
  globals,
  type SimEvent,
} from '../types';
import type { Simulation } from './simulation';
import { brainAnalysisParmsOf } from './bindings';
import { asGenome } from './fittestList';
import { calcComplexityBrainfunction, type AgentEventSource } from '../complexity';

const AGENTTYPE = GObjectType.AGENT;
const FOODTYPE = GObjectType.FOOD;

//===========================================================================
// small native helpers
//===========================================================================

/**
 * Native `AverageAngles( a, b )` (`Simulation.cc:114-128`) — `inline float`, and the shipped
 * code (inlined into `TSimulation::Mate`, `libpolyworld.dylib` 0x984a0-0x98500) keeps every step
 * in **single precision**:
 *
 * ```
 * 984a0: ldp  s2, s3, [..]        ; the two yaws
 * 984ac: fabd s3, s2, s4          ; |a - b|            (one float rounding)
 * 984b0: fadd s2, s2, s4          ; a + b              (float)
 * 984b4: mov  w8, #0x43340000     ; 180.0f
 * 984bc: fcmp s3, s4              ; the test is a *float* compare against 180.0f
 * 984c0: b.le 0x98500
 * 984d8: fmadd d2, d2, d4, d3     ; >180 arm: f32( 0.5 * (double)(a+b) + 180.0 )
 * 984e8: fcmp s12, s2             ; c vs 360.0f (float)
 * 984f8: fadd s12, s12, s2        ; c += -360.0f (float)
 * 98500: fmul s12, s2, s5         ; <=180 arm: f32( (a+b) * 0.5f )
 * ```
 *
 * The first port computed `0.5 * (a + b) + 180.0` in double off the *unrounded* double sum, which
 * is 1 ulp away whenever the float sum rounds — measured on `minitest_voff` agent 32's birth
 * (parents #11/#4 at step 61): native `0xc2fb0204`, port `0xc2fb0203`. That 1 ulp of yaw is what
 * put the port's step-64 body position one ulp below the native build's, which flipped the
 * x-sorted order of agents 4 and 32 at step 64 (the first whole-tree divergence of the run).
 */
export function averageAngles(a: number, b: number): number {
  // `fabd` — the float difference, absolute (the sign clear is exact).
  const difference = Math.abs(f32(a - b));
  // `fadd` — the sum is a *float* add; the rest of the arm is double, narrowed once.
  const sum = f32(a + b);
  let c: number;
  if (difference > 180.0) {
    c = f32(0.5 * sum + 180.0);
    // `fcmp s12, #360.0f` / `fadd s12, s12, #-360.0f`: float compare, float subtract.
    if (c >= 360.0) c = f32(c - 360.0);
  } else {
    c = f32(sum * 0.5);
  }
  // Native's return type is `float`.
  return c;
}

/** Native `TSimulation::PickParentsUsingTournament( numInPool, &i, &j )` (`1221-1240`). */
export function pickParentsUsingTournament(
  sim: Simulation,
  numInPool: number,
): { i: number; j: number } {
  let iParent = numInPool - 1;
  for (let z = 0; z < sim.fTournamentSize; z++) {
    const r = Math.floor(sim.randpw() * numInPool);
    if (iParent > r) iParent = r;
  }

  let jParent: number;
  do {
    jParent = numInPool - 1;
    for (let z = 0; z < sim.fTournamentSize; z++) {
      const r = Math.floor(sim.randpw() * numInPool);
      if (jParent > r) jParent = r;
    }
    // The redraw loop can consume an unbounded number of draws; it is part of the RNG stream.
  } while (jParent === iParent);

  return { i: iParent, j: jParent };
}

/** Native `TSimulation::ijfitinc( n, &i, &j )` (`3360-3378`). */
export function ijfitinc(n: number, iIn: number, jIn: number): { i: number; j: number } {
  // Native's parameters are `short`s, so the increments wrap at 32767; the values here are
  // fittest-list sizes (single digits), and the port keeps the arithmetic in `short` range the way
  // native does by storing into Int16 at the end. See PORT-NOTE(sim/ijfitinc-short).
  let i: number = iIn;
  let j: number = jIn;

  j++;
  if (j === i) j++;
  if (j > n - 1) {
    j = 0;
    i++;
    if (i > n - 1) {
      i = 0;
      j = 1;
    }
  }

  return { i: toShort(i), j: toShort(j) };
}

/** Native `(short)` conversion. */
function toShort(value: number): number {
  return ((value + 0x8000) & 0xffff) - 0x8000;
}

//===========================================================================
// Birth
//===========================================================================

/**
 * Native `TSimulation::Birth( a, reason, p1, p2 )` (`3384-3436`).
 *
 * PORT-NOTE(sim/birth-null-agent): `a` is null only for a virtual birth (`BR_VIRTUAL`), where
 * native still posts the event and counts it. The lifespan stamp happens only for a real agent, and
 * the event's `a` field is what lane L12's `BirthsDeathsLog` prints as `0` for a virtual birth.
 */
export function birth(
  sim: Simulation,
  a: Agent | null,
  reason: BirthReason,
  parent1: Agent | null = null,
  parent2: Agent | null = null,
): void {
  const event = {
    type: Event_AgentBirth,
    a,
    reason,
    parent1,
    parent2,
  } as SimEvent;
  sim.postEvent(event);

  if (a !== null) {
    sim.fNumberAlive++;
    sim.fNumberAliveWithMetabolism[a.metabolism()!.index]!++;
    a.stampBirth(sim.fStep, reason);
    separationCache.birth(a as unknown as never);
  }

  if (sim.fEvents !== null && reason !== BirthReason.SIMINIT) {
    // Native adds `'m'` for both parents for BR_NATURAL / BR_LOCKSTEP / BR_VIRTUAL, and nothing for
    // BR_CREATE.
    if (reason === BirthReason.NATURAL || reason === BirthReason.LOCKSTEP || reason === BirthReason.VIRTUAL) {
      if (parent1 !== null) sim.fEvents.addEvent(sim.fStep, parent1.number(), 'm');
      if (parent2 !== null) sim.fEvents.addEvent(sim.fStep, parent2.number(), 'm');
    }
  }
}

//===========================================================================
// Kill
//===========================================================================

/** Native `TSimulation::Kill( c, reason )` (`3443-3603`). */
export function kill(sim: Simulation, c: Agent, reason: DeathReason): void {
  const deathEvent = { type: Event_AgentDeath, a: c, reason } as SimEvent;

  sim.fNumberAlive--;
  sim.fNumberAliveWithMetabolism[c.metabolism()!.index]!--;

  c.lifeSpan().setDeath(sim.fStep, reason);

  if (reason === DeathReason.SIMEND) {
    sim.postEvent(deathEvent);
    separationCache.death(c as unknown as never);
    c.die();
    return;
  }

  const id = c.domain();

  sim.fNewDeaths++;
  sim.fNumberDied++;
  sim.fDomains[id]!.numdied++;
  sim.fDomains[id]!.numAgents--;

  sim.fLifeSpanStats.add(c.age());
  sim.fLifeSpanRecentStats.add(c.age());
  // Native `c->Age() / c->MaxAge()` is a `long / long` division promoted to `float` by the
  // `StatRecent::add( float )` parameter; the division itself is integer in C.
  sim.fLifeFractionRecentStats.add(Math.trunc(c.age() / c.maxAge()));

  // Make any final contributions to the agent's overall, lifetime fitness.
  c.lastRewards(sim.fEnergyFitnessParameter, sim.fAgeFitnessParameter);

  // --- turn into food, if applicable
  const domain = sim.fDomains[id]!;
  const rFood =
    sim.fAgentsRfood === 1 /* RFOOD_TRUE */ ||
    (sim.fAgentsRfood === 2 /* RFOOD_TRUE__FIGHT_ONLY */ && reason === DeathReason.FIGHT);

  let foodPatch: ReturnType<(typeof domain)['whichFoodPatch']> = null;
  if (
    rFood &&
    gXSortedObjects.getCount(FOODTYPE) < sim.fMaxFoodCount &&
    domain.foodCount < domain.maxFoodCount &&
    (foodPatch = domain.whichFoodPatch(c.x(), c.z())) !== null &&
    foodPatch.foodCount < foodPatch.maxFoodCount &&
    (globals.blockedEdges ||
      (c.x() >= 0.0 && c.x() <= globals.worldsize && c.z() <= 0.0 && c.z() >= -globals.worldsize))
  ) {
    const carcassFoodType = c.metabolism()!.carcassFoodType;
    if (carcassFoodType !== null) {
      const foodEnergy = c.foodEnergy().clone();
      // Multiply by polarity^2 so the values are positive and an UNDEFINED polarity zeroes them.
      const polarity = (carcassFoodType as unknown as { energyPolarity: EnergyPolarity }).energyPolarity;
      const minFoodEnergyAtDeath = new Energy(sim.fMinFoodEnergyAtDeath)
        .mulPolarity(polarity)
        .mulPolarity(polarity);
      const minFoodEnergy = new Energy(Food.gMinFoodEnergy).mulPolarity(polarity).mulPolarity(polarity);

      if (foodEnergy.isDepleted(minFoodEnergyAtDeath)) {
        if (!minFoodEnergyAtDeath.isDepleted(minFoodEnergy)) {
          // Native's three-argument `constrain( min, max, added )` reports how much was added; lane
          // L8's `Energy` exposes the two-argument form, so the delta is computed here
          // (PORT-NOTE(sim/constrain-added-energy) in PARITY.md).
          const before = foodEnergy.clone();
          foodEnergy.constrain(minFoodEnergyAtDeath, new Energy(Food.gMaxFoodEnergy));
          const addedEnergy = foodEnergy.clone();
          addedEnergy.subAssign(before);
          sim.foodEnergyIn(addedEnergy.mulScalar(-1));
        }
      }

      if (foodEnergy.isDepleted(carcassTypeDepletion(carcassFoodType))) {
        sim.foodEnergyOut(foodEnergy);
      } else {
        const f = new Food(
          carcassFoodType as unknown as ConstructorParameters<typeof Food>[0],
          sim.fStep,
          foodEnergy,
          c.x(),
          c.z(),
        );
        const saveCurr = gXSortedObjects.getcurr();
        gXSortedObjects.add(f as never); // dead agent becomes food
        gXSortedObjects.setcurr(saveCurr);
        sim.getStage().addObject(f as never);
        foodPatch.foodCount++;
        f.setPatch(foodPatch);
        f.setDomain(id);
        domain.foodCount++;
      }
    }
  } else {
    sim.foodEnergyOut(c.foodEnergy());
  }

  // Must call Die() before any of the uses of Fitness() below, so the final, true, post-death
  // fitness is what gets recorded.
  sim.postEvent(deathEvent);
  separationCache.death(c as unknown as never);
  c.die();

  sim.getStage().removeObject(c as never);

  // Requires the list to be currently pointing at `c`; leaves it one item back.
  gXSortedObjects.removeObjectWithLink(c as never);

  sim.fScheduler.postParallel(() => {
    analyzeBrain(sim, c);
  });

  sim.fScheduler.postSerial(() => {
    updateFittest(sim, c);
    // PORT-NOTE(sim/kill-delete): native `delete c` here. The port keeps the object reachable (JS
    // frees it when nothing references it) — the dead agent has already been removed from the
    // x-sorted list, the stage and every list that could hold it, which is what the model observes.
  });
}

/** The carcass food type's `depletionThreshold` (lane L10's `FoodType`). */
function carcassTypeDepletion(foodType: { name: string }): Energy {
  const t = foodType as unknown as { depletionThreshold?: Energy };
  if (t.depletionThreshold instanceof Energy) return t.depletionThreshold;
  throw new Error(`sim: FoodType '${foodType.name}' has no depletionThreshold (lane L10's shape changed)`);
}

//===========================================================================
// analyzeBrain
//===========================================================================

/**
 * Native `CalcComplexity_brainfunction( path, part, events )` (`complexity_brain.cc:110`, lane L13)
 * over one dead agent's recorded brain-function file.
 *
 * The value is native's `double` return, *not* narrowed: every call site below stores into
 * `agent::SetComplexity( float )` (or narrows on assignment, in native's `D` branch) and applies
 * `f32` there, at the same places the binary does.
 *
 * `events` is `NULL` on the `D` branch's two calls in both call sites (disassembled:
 * `0x9aa68`/`0x9aa94` in `analyzeBrain`, `0x9b1a0`/`0x9b1cc` in `AgentFitness` set `x2` to zero),
 * and `fEvents` otherwise — which is itself `NULL` unless `ComplexityType` carries a lowercase
 * letter (the ctor's event-filtering gate).
 */
function brainFunctionComplexity(
  sim: Simulation,
  path: string,
  part: string,
  events: AgentEventSource | null,
): number {
  return calcComplexityBrainfunction({ file: sim.openBrainFunctionFile(path), part, events }).complexity;
}

/** Native `TSimulation::analyzeBrain( c )` (`3610-3635`). */
export function analyzeBrain(sim: Simulation, c: Agent): void {
  sim.postEvent({ type: Event_BrainAnalysisBegin, a: c } as SimEvent);

  if (sim.fCalcComplexity) {
    // Native's comment: "This should have been configured in response to the begin event."
    // Lane L12's `BrainFunctionLog` handles that event synchronously — `Simulation.postEvent`
    // dispatches on the calling thread, exactly as `Logs::postEvent` does — closing the agent's
    // `incomplete_brainFunction_<n>.txt` (which is what decompresses a `.gz` run's bytes),
    // renaming it to `brainFunction_<n>.txt` and recording that path in `brainAnalysisParms`.
    const brainFunctionPath = brainAnalysisParmsOf(c).functionPath;

    // Native `assert( *brainFunctionPath )` — the analysis refuses rather than scoring a zero
    // (a zero would reach `run/brain/Recent/<epoch>/complexity_<type>.plt` and the fitness).
    if (brainFunctionPath === '') {
      throw new Error(
        'sim: analyzeBrain: the brain-analysis begin event recorded no function path ' +
          "(native asserts; lane L12's BrainFunctionLog writes `brainAnalysisParms.functionPath`)",
      );
    }

    if (sim.fComplexityType === 'D') {
      // `float pComplexity = …; float iComplexity = …; c->SetComplexity( p - i )` — two
      // narrowings from the `double` return and a *float* subtraction
      // (`0x9aa84`/`0x9aab0`/`0x9aab4`), each with `events == NULL`.
      const pComplexity = f32(brainFunctionComplexity(sim, brainFunctionPath, 'P', null));
      const iComplexity = f32(brainFunctionComplexity(sim, brainFunctionPath, 'I', null));
      c.setComplexity(f32(pComplexity - iComplexity));
    } else if (sim.fComplexityType !== 'Z') {
      // `c->SetComplexity( CalcComplexity_brainfunction( path, fComplexityType, fEvents ) )`:
      // the `double` result narrows into the `float` store (`0x9aaf4` `fcvt s0, d0`). `Z` is the
      // evolve-towards-zero-velocity hack and computes nothing at all (`0x9aad4` branches past
      // the whole block).
      c.setComplexity(f32(brainFunctionComplexity(sim, brainFunctionPath, sim.fComplexityType, sim.fEvents)));
    }
  }

  sim.postEvent({ type: Event_BrainAnalysisEnd, a: c } as SimEvent);
}

//===========================================================================
// updateFittest / AgentFitness
//===========================================================================

/** Native `TSimulation::updateFittest( c )` (`3642-3701`). */
export function updateFittest(sim: Simulation, c: Agent): void {
  // Remove `c` from the current-fittest window if it is in it, keeping the order of the rest.
  for (let i = 0; i < sim.fCurrentFittestCount; i++) {
    if (sim.fCurrentFittestAgent[i] === c) {
      for (let j = i; j < sim.fCurrentFittestCount - 1; j++) {
        sim.fCurrentFittestAgent[j] = sim.fCurrentFittestAgent[j + 1]!;
        sim.fCurrentMaxFitness[j] = sim.fCurrentMaxFitness[j + 1]!;
      }
      sim.fCurrentFittestCount--;
      sim.fCurrentFittestAgent[sim.fCurrentFittestCount] = null;
      sim.fCurrentMaxFitness[sim.fCurrentFittestCount] = 0;
      break;
    }
  }

  const cFitness = agentFitness(sim, c);
  if (cFitness > sim.fMaxFitness) sim.fMaxFitness = cFitness;

  const id = c.domain();
  const domain = sim.fDomains[id]!;

  if (domain.fittest !== null) domain.fittest.update(c, cFitness);
  if (sim.fFittest !== null) sim.fFittest.update(c, cFitness);
  if (sim.fRecentFittest !== null) sim.fRecentFittest.update(c, cFitness);

  // Remove `c` from its domain's least-fit queue.
  for (let i = 0; i < domain.numLeastFit; i++) {
    if (domain.leastFit[i] === c) {
      for (let j = i; j < domain.numLeastFit - 1; j++) {
        domain.leastFit[j] = domain.leastFit[j + 1]!;
      }
      domain.numLeastFit--;
      domain.leastFit[domain.numLeastFit] = null;
      break;
    }
  }
}

/**
 * Native `TSimulation::AgentFitness( c )` (`3772-3817`) — must be called on a dead agent.
 *
 * The weighted branch's complexity term comes from `c->Complexity()`, which `analyzeBrain` has
 * already set; native only re-reads the file itself when it is still `< 0` — its "complexity being
 * calculated when it should already be known" warning path — and it rebuilds the path from the
 * agent's *number* rather than reading `brainAnalysisParms` (`sprintf( "run/brain/function/
 * brainFunction_%ld.txt", c->Number() )`), which is the same file.
 */
export function agentFitness(sim: Simulation, c: Agent): number {
  if (c.alive()) {
    throw new Error('sim: AgentFitness: must be called on a dead agent (native exits)');
  }

  if (sim.fComplexityFitnessWeight === 0) {
    return c.heuristicFitness() / sim.fTotalHeuristicFitness;
  }

  if (sim.fComplexityType === 'Z') {
    return 0.01 / (c.maxSpeedReached() + 0.01);
  }

  if (c.complexity() < 0.0) {
    const filename = `run/brain/function/brainFunction_${c.number()}.txt`;

    if (sim.fComplexityType === 'D') {
      // `0x9b194`-`0x9b1f4`: the same two `events == NULL` calls and float subtraction as
      // `analyzeBrain`'s `D` branch.
      const pComplexity = f32(brainFunctionComplexity(sim, filename, 'P', null));
      const iComplexity = f32(brainFunctionComplexity(sim, filename, 'I', null));
      c.setComplexity(f32(pComplexity - iComplexity));
    } else {
      // `0x9b1f8`-`0x9b220`: `CalcComplexity_brainfunction( filename, fComplexityType, fEvents )`,
      // narrowed at the `SetComplexity( float )` store.
      c.setComplexity(f32(brainFunctionComplexity(sim, filename, sim.fComplexityType, sim.fEvents)));
    }
  }

  // `fitness = ( hw*HeuristicFitness()/total + cw*Complexity ) / ( hw + cw )`, in the binary's own
  // shape (`0x9b250`-`0x9b268`) — every step a `float` operation, three of them rounded and one
  // contracted:
  //
  //   9b250: fmul  s0, s8, s0      ; fHeuristicFitnessWeight * HeuristicFitness
  //   9b258: fdiv  s0, s0, s3      ; / fTotalHeuristicFitness
  //   9b260: fmadd s0, s3, s1, s0  ; fComplexityFitnessWeight * Complexity + that, ONE rounding
  //   9b264: fadd  s1, s3, s2      ; fComplexityFitnessWeight + fHeuristicFitnessWeight
  //   9b268: fdiv  s0, s0, s1      ; the normalisation
  //
  // The `fmadd` is the site PARITY.md's mutation table recorded as "no ported site to pin"; it is
  // pinned by `tests/sim-complexity-seam.test.ts` against exact-rational values whose fused and
  // round-product-then-sum forms differ in the last bit.
  const heuristicTerm = f32(
    f32(sim.fHeuristicFitnessWeight * c.heuristicFitness()) / sim.fTotalHeuristicFitness,
  );
  const weighted = f32Fma(sim.fComplexityFitnessWeight, c.complexity(), heuristicTerm);
  return f32(weighted / f32(sim.fComplexityFitnessWeight + sim.fHeuristicFitnessWeight));
}

//===========================================================================
// CreateAgents
//===========================================================================

/** Native `TSimulation::CreateAgents()` (`2914-3148`). */
export function createAgents(sim: Simulation): void {
  const maxToCreate = sim.maxAgents() - gXSortedObjects.getCount(AGENTTYPE);

  if (maxToCreate > 0) {
    // --- load-balance the domain creations.
    let numToCreate = 0;
    for (let id = 0; id < sim.fNumDomains; id++) {
      const domain = sim.fDomains[id]!;
      domain.numToCreate = Math.max(0, domain.minNumAgents - domain.numAgents);
      numToCreate += domain.numToCreate;
    }
    while (numToCreate > maxToCreate) {
      let domainWithLeastNeed = -1;
      let leastAgentsNeeded = sim.maxAgents() + 1;
      for (let id = 0; id < sim.fNumDomains; id++) {
        const domain = sim.fDomains[id]!;
        if (domain.numToCreate > 0 && domain.numToCreate < leastAgentsNeeded) {
          leastAgentsNeeded = domain.numToCreate;
          domainWithLeastNeed = id;
        }
      }
      sim.fDomains[domainWithLeastNeed]!.numToCreate--;
      numToCreate--;
    }

    // --- the per-domain creations.
    for (let id = 0; id < sim.fNumDomains; id++) {
      const domain = sim.fDomains[id]!;
      for (let ic = 0; ic < domain.numToCreate; ic++) {
        sim.fNumberCreated++;
        domain.numcreated++;
        sim.fNumBornSinceCreated = 0;
        domain.numbornsincecreated = 0;
        sim.fLastCreated = sim.fStep;
        domain.lastcreate = sim.fStep;

        const newAgent = Agent.getFreeAgent(sim.deps());
        const genes = asGenome(newAgent.genes());

        if (domain.fittest !== null && domain.fittest.isFull()) {
          if (sim.fFitness1Frequency && (domain.numcreated / sim.fFitness1Frequency) * sim.fFitness1Frequency === domain.numcreated) {
            // Revive 1 fittest.
            genes.copyFrom(domain.fittest.get(0).genes!);
            sim.fNumberCreated1Fit++;
          } else if (
            sim.fFitness2Frequency &&
            (domain.numcreated / sim.fFitness2Frequency) * sim.fFitness2Frequency === domain.numcreated
          ) {
            // Mate 2 from the array of fittest.
            if (sim.fTournamentSize > 0) {
              const parents = pickParentsUsingTournament(sim, domain.fittest.getSize());
              genes.crossover(domain.fittest.get(parents.i).genes!, domain.fittest.get(parents.j).genes!, true);
            } else {
              genes.crossover(
                domain.fittest.get(domain.ifit).genes!,
                domain.fittest.get(domain.jfit).genes!,
                true,
              );
              const next = ijfitinc(domain.fittest.getSize(), domain.ifit, domain.jfit);
              domain.ifit = next.i;
              domain.jfit = next.j;
            }
            sim.fNumberCreated2Fit++;
          } else {
            genes.randomize();
            sim.fNumberCreatedRandom++;
          }
        } else {
          genes.randomize();
          sim.fNumberCreatedRandom++;
        }

        newAgent.setGenomeReady();

        sim.fScheduler.postParallel(() => {
          newAgent.grow(sim.fMateWait);
        });

        const x = Math.fround(sim.randpw() * (domain.absoluteSizeX - 0.02) + domain.startX + 0.01);
        const z = Math.fround(sim.randpw() * (domain.absoluteSizeZ - 0.02) + domain.startZ + 0.01);
        const y = Math.fround(0.5 * agentConfig.agentHeight);
        const yaw = Math.fround(sim.randpw() * 360.0);

        newAgent.setX(x);
        newAgent.setY(y);
        newAgent.setZ(z);
        newAgent.setYaw(yaw);
        newAgent.setDomain(id);
        sim.getStage().addObject(newAgent as never);
        domain.numAgents++;
        gXSortedObjects.add(newAgent as never);
        sim.fNewLifes++;

        sim.fScheduler.postSerial(() => {
          sim.foodEnergyIn(newAgent.foodEnergy());
        });

        birth(sim, newAgent, BirthReason.CREATE);
      }
    }

    // --- the global top-up (note: the global body runs `grow()` inline, not posted).
    while (gXSortedObjects.getCount(AGENTTYPE) < sim.fMinNumAgents) {
      sim.fNumberCreated++;
      const numglobalcreated = sim.bumpNumGlobalCreated();

      sim.fNumBornSinceCreated = 0;
      sim.fLastCreated = sim.fStep;

      const newAgent = Agent.getFreeAgent(sim.deps());
      const genes = asGenome(newAgent.genes());

      if (sim.fFittest !== null && sim.fFittest.isFull()) {
        if (sim.fFitness1Frequency && (numglobalcreated / sim.fFitness1Frequency) * sim.fFitness1Frequency === numglobalcreated) {
          genes.copyFrom(sim.fFittest.get(0).genes!);
          sim.fNumberCreated1Fit++;
        } else if (
          sim.fFitness2Frequency &&
          (numglobalcreated / sim.fFitness2Frequency) * sim.fFitness2Frequency === numglobalcreated
        ) {
          if (sim.fTournamentSize > 0) {
            const parents = pickParentsUsingTournament(sim, sim.fFittest.getSize());
            genes.crossover(sim.fFittest.get(parents.i).genes!, sim.fFittest.get(parents.j).genes!, true);
          } else {
            genes.crossover(sim.fFittest.get(sim.fFitI).genes!, sim.fFittest.get(sim.fFitJ).genes!, true);
            const next = ijfitinc(sim.fFittest.getSize(), sim.fFitI, sim.fFitJ);
            sim.fFitI = next.i;
            sim.fFitJ = next.j;
          }
          sim.fNumberCreated2Fit++;
        } else {
          genes.randomize();
          sim.fNumberCreatedRandom++;
        }
      } else {
        genes.randomize();
        sim.fNumberCreatedRandom++;
      }

      newAgent.setGenomeReady();
      newAgent.grow(sim.fMateWait);
      sim.foodEnergyIn(newAgent.foodEnergy());

      const x = Math.fround(sim.randpw() * globals.worldsize);
      const y = Math.fround(0.5 * agentConfig.agentHeight);
      const z = Math.fround(sim.randpw() * -globals.worldsize);
      newAgent.setX(x);
      newAgent.setY(y);
      newAgent.setZ(z);

      const yaw = Math.fround(sim.randpw() * 360.0);
      newAgent.setYaw(yaw);

      const id = sim.whichDomain(x, z, 0);
      newAgent.setDomain(id);
      const domain = sim.fDomains[id]!;
      domain.numcreated++;
      domain.lastcreate = sim.fStep;
      domain.numAgents++;

      sim.getStage().addObject(newAgent as never);
      gXSortedObjects.add(newAgent as never);
      sim.fNewLifes++;

      birth(sim, newAgent, BirthReason.CREATE);
    }
  }
}

/** Re-exported so the lane's barrel can name the types the lifecycle uses. */
export { genomeUtil, Food, FoodType, type Genome };
