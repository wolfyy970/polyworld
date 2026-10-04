/**
 * Lane L11 (sim) — `TSimulation::processWorldFile` and the three mode-forcing functions (native
 * `Simulation.cc` 3822-4579, 4584-4631, 4636-4672, 4677-4725).
 *
 * Every parameter the step loop reads is set here, in native's order, plus the derived world the
 * loop runs in: the `Edges` string -> `globals.blockedEdges/wraparound/stickyEdges` mapping, the
 * food types, the metabolisms (definition order is contract — a gene stores an index), the domains
 * with their patches, and `globals.worldsize`.
 *
 * PORT-NOTE(sim/worldfile-order): the reads are transcribed in native order because two of them
 * have side effects that the rest of the run depends on: `NumEnergyTypes` must reach
 * `globals.numEnergyTypes` **before** any `Energy` is constructed (every `Energy` sizes itself from
 * it — the same ordering trap the L8 handoff flags), and the `StaticTimestepGeometry` branch sets
 * `RandomNumberGenerator.set( NERVOUS_SYSTEM, LOCAL )`, which is what makes per-agent brain RNG a
 * separate MT19937 stream (sim-spec PORT-NOTE(rng-local-per-agent)).
 *
 * PORT-NOTE(sim/parallel-flags): `ParallelInitAgents=false` and `ParallelInteract=false` are
 * **unsupported** in v1 (the recorded scenarios set both true; the measured behaviour of the false
 * paths differs — sim-spec §3.3). The port refuses such a worldfile with a clear error rather than
 * silently running the deferred ordering. `ParallelBrains`/`ParallelCreateAgents` are no-ops.
 */

import { Energy, EnergyMultiplier, EnergyPolarity, agentConfig, Metabolism, nint } from '../agent';
import { Barrier, Brick, BrickPatch, Food, FoodPatch, FoodType, Patch } from '../environment';
import { RandomNumberGenerator, globalRngSurface } from '../rng';
import { Config, globals, ConcreteFileType, GObjectType, RngType, RngRole, nativeFloat } from '../types';
import type { Color, PropertyNode } from '../types';
import type { Simulation } from './simulation';
import { Domain } from './domain';
import { FittestList } from './fittestList';

const AGENTTYPE = GObjectType.AGENT;
const FOODTYPE = GObjectType.FOOD;
const BRICKTYPE = GObjectType.BRICK;

/** A numeric array property (`EnergyPolarity`, `EatMultiplier`, `EnergyDelta`, `Variables`). */
function numbersOf(node: PropertyNode): number[] {
  return node.elements().map((element) => nativeFloat(element.scalarText()));
}

/** Native `nint` for a `float` argument (lane L8's `numeric.ts` definition). */
function nintOf(value: number): number {
  return nint(value);
}

/** Native `TSimulation::processWorldFile( docWorldFile )` (`Simulation.cc:3822-4579`). */
export function processWorldFile(sim: Simulation, doc: Config): void {
  // --- top-level flags and parameters, in native order.
  sim.fLockStepWithBirthsDeathsLog = doc.getBool('PassiveLockstep');
  sim.fAdaptivityMode = doc.getBool('AdaptivityMode');
  sim.fMaxSteps = doc.getInt('MaxSteps');
  sim.fStepsPerSecond = doc.getInt('StepsPerSecond');
  sim.fEndOnPopulationCrash = doc.getBool('EndOnPopulationCrash');
  sim.fDumpFrequency = doc.getInt('CheckPointFrequency');

  {
    const edges = doc.getString('Edges');
    if (edges === 'B') {
      globals.blockedEdges = true;
      globals.wraparound = false;
      globals.stickyEdges = false;
    } else if (edges === 'W') {
      globals.blockedEdges = false;
      globals.wraparound = true;
      globals.stickyEdges = false;
    } else if (edges === 'T') {
      globals.blockedEdges = false;
      globals.wraparound = false;
      globals.stickyEdges = false;
    } else if (edges === 'S') {
      globals.blockedEdges = true;
      globals.wraparound = false;
      globals.stickyEdges = true;
    } else {
      throw new Error(`sim: unknown Edges value '${edges}' (native asserts)`);
    }
  }

  globals.numEnergyTypes = doc.getInt('NumEnergyTypes');

  sim.fStaticTimestepGeometry = doc.getBool('StaticTimestepGeometry');
  if (sim.fStaticTimestepGeometry) {
    // Brains execute in parallel, so we need brain-local RNG state.
    RandomNumberGenerator.set(RngRole.NERVOUS_SYSTEM, RngType.LOCAL);
  }

  sim.fParallelInitAgents = doc.getBool('ParallelInitAgents');
  sim.fParallelInteract = doc.getBool('ParallelInteract');
  sim.fParallelCreateAgents = doc.getBool('ParallelCreateAgents');
  sim.fParallelBrains = doc.getBool('ParallelBrains');

  // PORT-NOTE(sim/parallel-flags): see the module header.
  if (!sim.fParallelInitAgents) {
    throw new Error(
      'sim: ParallelInitAgents False is unsupported in the port (measured to change the trajectory; ' +
        'sim-spec §3.3 / PORT-NOTE(sched-flags)) — see PARITY.md -> Gaps',
    );
  }
  if (!sim.fParallelInteract) {
    throw new Error(
      'sim: ParallelInteract False is unsupported in the port (measured to change the trajectory; ' +
        'sim-spec §3.3 / PORT-NOTE(sched-flags)) — see PARITY.md -> Gaps',
    );
  }

  sim.fMinNumAgents = doc.getInt('MinAgents');
  SimulationSetMaxAgents(sim, doc.getInt('MaxAgents'));
  sim.fInitNumAgents = doc.getInt('InitAgents');
  sim.fNumberToSeed = doc.getInt('SeedAgents');
  sim.fProbabilityOfMutatingSeeds = doc.getFloat('SeedMutationProbability');
  sim.fRawSeedMutationRate = doc.getFloat('RawSeedMutationRate');
  sim.fSeedFromFile = doc.getBool('SeedGenomeFromRun');
  sim.fPositionSeedsFromFile = doc.getBool('SeedPositionFromRun');
  sim.fMiscAgents = doc.getInt('MiscegenationDelay');
  sim.fInitFoodCount = doc.getInt('InitFood');
  sim.fMinFoodCount = doc.getInt('MinFood');
  sim.fMaxFoodCount = doc.getInt('MaxFood');
  sim.fMaxFoodGrownCount = doc.getInt('MaxFoodGrown');
  sim.fFoodRate = doc.getFloat('FoodGrowthRate');

  {
    const foodGrowthModel = doc.getString('FoodGrowthModel');
    sim.fFoodGrowthModel = foodGrowthModel === 'MaxIndependent' ? 1 : 0;
  }
  sim.fFoodRemoveEnergy = doc.getFloat('FoodRemoveEnergy');
  sim.fFoodRemoveFirstEat = doc.getBool('FoodRemoveFirstEat');
  Food.gMaxLifeSpan = doc.getInt('FoodMaxLifeSpan');
  sim.fRandomInitFoodAge = doc.getBool('RandomInitFoodAge');
  sim.fPositionSeed = doc.getInt('PositionSeed'); // never used (PORT-NOTE(position-seed-unused))
  sim.fGenomeSeed = doc.getInt('InitSeed');
  sim.fSimulationSeed = doc.getInt('SimulationSeed');

  {
    // Native reads the property as a `Property` and tests both the string "Fight" and the bool.
    const rfood = doc.node('AgentsAreFood');
    const text = rfood.scalarText();
    if (text === 'Fight') sim.fAgentsRfood = 2; // RFOOD_TRUE__FIGHT_ONLY
    else sim.fAgentsRfood = nativeBoolOf(text) ? 1 : 0;
  }

  sim.fFitness1Frequency = doc.getInt('EliteFrequency');
  sim.fFitness2Frequency = doc.getInt('PairFrequency');
  sim.fEpochFrequency = doc.getInt('EpochFrequency');
  sim.fEpoch = sim.fEpochFrequency;

  {
    const numberFittest = doc.getInt('NumberFittest');
    sim.fFittest = numberFittest > 0 ? new FittestList(numberFittest, true) : null;
  }
  {
    const numberRecentFittest = doc.getInt('NumberRecentFittest');
    sim.fRecentFittest = numberRecentFittest > 0 && sim.fEpochFrequency > 0
      ? new FittestList(numberRecentFittest, false)
      : null;
  }

  sim.fEatFitnessParameter = doc.getFloat('FitnessWeightEating');
  sim.fMateFitnessParameter = doc.getFloat('FitnessWeightMating');
  sim.fMoveFitnessParameter = doc.getFloat('FitnessWeightMoving');
  sim.fEnergyFitnessParameter = doc.getFloat('FitnessWeightEnergyAtDeath');
  sim.fAgeFitnessParameter = doc.getFloat('FitnessWeightLongevity');
  sim.fTotalHeuristicFitness =
    Math.fround(
      sim.fEatFitnessParameter +
        sim.fMateFitnessParameter +
        sim.fMoveFitnessParameter +
        sim.fEnergyFitnessParameter +
        sim.fAgeFitnessParameter,
    );

  Food.gMinFoodEnergy = doc.getFloat('MinFoodEnergy');
  Food.gMaxFoodEnergy = doc.getFloat('MaxFoodEnergy');
  Food.gSize2Energy = doc.getFloat('FoodEnergySizeScale');
  sim.fEat2Consume = doc.getFloat('FoodConsumptionRate');

  sim.fCarryObjects = objectMask(doc, 'Carry');
  sim.fShieldObjects = objectMask(doc, 'Shield');

  sim.fCarryPreventsEat = doc.getFloat('CarryPreventsEat');
  sim.fCarryPreventsFight = doc.getFloat('CarryPreventsFight');
  sim.fCarryPreventsGive = doc.getFloat('CarryPreventsGive');
  sim.fCarryPreventsMate = doc.getFloat('CarryPreventsMate');

  sim.fEatWait = doc.getInt('EatWait');
  sim.fProbabilisticMating = doc.getBool('ProbabilisticMating');
  sim.fMateWait = doc.getInt('MateWait');
  sim.fEatMateSpan = doc.getInt('EatMateWait');
  sim.fEatMateMinDistance = doc.getFloat('EatMateMinDistance');
  sim.fMaxMateVelocity = doc.getFloat('MaxMateVelocity');
  sim.fMinEatVelocity = doc.getFloat('MinEatVelocity');
  sim.fMaxEatVelocity = doc.getFloat('MaxEatVelocity');
  sim.fMaxEatYaw = doc.getFloat('MaxEatYaw');

  sim.fMinMateFraction = doc.getFloat('MinMateEnergyFraction');
  sim.fPower2Energy = doc.getFloat('DamageRate');
  Food.gCarryFood2Energy = doc.getFloat('EnergyUseCarryFood');
  Brick.gCarryBrick2Energy = doc.getFloat('EnergyUseCarryBrick');

  sim.fAgentHealingRate = doc.getFloat('AgentHealingRate');
  sim.fHealing = sim.fAgentHealingRate > 0.0;

  sim.fEatThreshold = doc.getFloat('EatThreshold');
  sim.fMateThreshold = doc.getFloat('MateThreshold');
  sim.fFightThreshold = doc.getFloat('FightThreshold');
  sim.fFightFraction = doc.getFloat('FightMultiplier');
  {
    const fightMode = doc.getString('FightMode');
    if (fightMode === 'Normal') sim.fFightMode = 0;
    else if (fightMode === 'Null') sim.fFightMode = 1;
    else throw new Error(`sim: unknown FightMode '${fightMode}' (native asserts)`);
  }
  sim.fGiveThreshold = doc.getFloat('GiveThreshold');
  sim.fGiveFraction = doc.getFloat('GiveFraction');
  sim.fPickupThreshold = doc.getFloat('PickupThreshold');
  sim.fDropThreshold = doc.getFloat('DropThreshold');

  sim.fSolidObjects = objectMask(doc, 'Solid');

  Food.gFoodHeight = doc.getFloat('FoodHeight');
  Food.gFoodColor = colorOf(doc, 'FoodColor');
  Brick.gBrickHeight = doc.getFloat('BrickHeight');
  Barrier.gBarrierHeight = doc.getFloat('BarrierHeight');
  Barrier.gBarrierColor = colorOf(doc, 'BarrierColor');
  Barrier.gStickyBarriers = doc.getBool('StickyBarriers');
  Barrier.gRatioPositions = doc.getBool('RatioBarrierPositions');
  sim.fGroundColor = colorOf(doc, 'GroundColor');
  sim.fGroundClearance = doc.getFloat('GroundClearance');
  globals.worldsize = doc.getFloat('WorldSize');

  // --- barriers
  {
    const propBarriers = doc.getArray('Barriers');
    for (let ibarrier = 0; ibarrier < propBarriers.length; ibarrier++) {
      const propBarrier = new Config(propBarriers[ibarrier]!);
      const b = new Barrier({ rand: () => globalRngSurface().rand() });
      Barrier.gBarriers.push(b);

      b.getPosition().xa = propBarrier.getFloat('X1');
      b.getPosition().za = propBarrier.getFloat('Z1');
      b.getPosition().xb = propBarrier.getFloat('X2');
      b.getPosition().zb = propBarrier.getFloat('Z2');

      b.init();
      Barrier.gXSortedBarriers.add(b);
    }
  }

  // --- food types (definition order is the log column order: PORT-NOTE(L10/foodtype-log-columns))
  {
    const propFoodTypes = doc.getArray('FoodTypes');
    for (const propFoodTypeNode of propFoodTypes) {
      const propFoodType = new Config(propFoodTypeNode);

      const name = propFoodType.getString('Name');
      if (FoodType.lookup(name) !== null) {
        throw new Error(`sim: duplicate FoodType name '${name}' (native errs)`);
      }

      const foodColor = propFoodType.has('FoodColor') ? colorOf(propFoodType, 'FoodColor') : colorOf(doc, 'FoodColor');
      const energyPolarity = EnergyPolarity.fromNumbers(numbersOf(propFoodType.node('EnergyPolarity')));
      const eatMultiplier = EnergyMultiplier.fromNumbers(numbersOf(propFoodType.node('EatMultiplier')));
      const depletionThreshold = Energy.createDepletionThreshold(new Energy(sim.fFoodRemoveEnergy), energyPolarity);

      FoodType.define(name, foodColor, energyPolarity, eatMultiplier, depletionThreshold);
    }
  }

  // --- metabolisms (definition order is contract: a genome stores the index)
  {
    const propAgentMetabolisms = doc.getArray('AgentMetabolisms');
    if (propAgentMetabolisms.length > 10 /* MAXMETABOLISMS */) {
      throw new Error('sim: more AgentMetabolisms than MAXMETABOLISMS (native asserts)');
    }

    for (let iMetabolism = 0; iMetabolism < propAgentMetabolisms.length; iMetabolism++) {
      const propMetabolism = new Config(propAgentMetabolisms[iMetabolism]!);

      let name = propMetabolism.getString('Name');
      if (name === 'Null') name = `Metabolism${iMetabolism}`;

      const energyPolarity = EnergyPolarity.fromNumbers(numbersOf(propMetabolism.node('EnergyPolarity')));

      let carcassFoodType: FoodType | null;
      const carcassFoodTypeMode = propMetabolism.getString('CarcassFoodTypeMode');
      if (carcassFoodTypeMode === 'None') {
        carcassFoodType = null;
      } else if (carcassFoodTypeMode === 'FoodTypeName') {
        const foodTypeName = propMetabolism.getString('CarcassFoodTypeName');
        carcassFoodType = FoodType.lookup(foodTypeName);
        if (carcassFoodType === null) {
          throw new Error(`sim: CarcassFoodTypeName references unknown FoodType '${foodTypeName}'`);
        }
      } else if (carcassFoodTypeMode === 'FindEnergyPolarity') {
        carcassFoodType = FoodType.find(energyPolarity);
        if (carcassFoodType === null) {
          throw new Error('sim: cannot find a FoodType with the metabolism\'s energy polarity');
        }
      } else {
        throw new Error(`sim: unknown CarcassFoodTypeMode '${carcassFoodTypeMode}' (native asserts)`);
      }

      const eatMultiplier = EnergyMultiplier.fromNumbers(numbersOf(propMetabolism.node('EatMultiplier')));
      const energyDelta = Energy.fromNumbers(numbersOf(propMetabolism.node('EnergyDelta')));
      const minEatAge = propMetabolism.getFloat('MinEatAge');

      Metabolism.define(name, energyPolarity, eatMultiplier, energyDelta, minEatAge, carcassFoodType);
    }

    for (let i = 0; i < Metabolism.getNumberOfDefinitions(); i++) {
      sim.fMinNumAgentsWithMetabolism[i] =
        nintOf(doc.getInt('MinAgents') / Metabolism.getNumberOfDefinitions());
    }
  }

  {
    const mode = doc.getString('AgentMetabolismSelectionMode');
    if (mode === 'Gene') Metabolism.selectionMode = 0;
    else if (mode === 'Random') Metabolism.selectionMode = 1;
    else throw new Error(`sim: unknown AgentMetabolismSelectionMode '${mode}' (native asserts)`);
  }

  // --- domains
  {
    const propDomains = doc.getArray('Domains');
    sim.fNumDomains = propDomains.length;
    sim.fDomains = [];
    for (let id = 0; id < sim.fNumDomains; id++) sim.fDomains.push(new Domain());

    let totmaxnumagents = 0;
    let totminnumagents = 0;
    let numFoodPatchesNeedingRemoval = 0;

    for (let id = 0; id < sim.fNumDomains; id++) {
      const dom = new Config(propDomains[id]!);
      const domain = sim.fDomains[id]!;

      // --- the domain's box
      {
        domain.centerX = dom.getFloat('CenterX');
        domain.centerZ = dom.getFloat('CenterZ');
        domain.sizeX = dom.getFloat('SizeX');
        domain.sizeZ = dom.getFloat('SizeZ');

        domain.absoluteSizeX = Math.fround(globals.worldsize * domain.sizeX);
        domain.absoluteSizeZ = Math.fround(globals.worldsize * domain.sizeZ);

        domain.startX = Math.fround(domain.centerX * globals.worldsize - domain.absoluteSizeX / 2.0);
        domain.startZ = Math.fround(-domain.centerZ * globals.worldsize - domain.absoluteSizeZ / 2.0);

        domain.endX = Math.fround(domain.centerX * globals.worldsize + domain.absoluteSizeX / 2.0);
        domain.endZ = Math.fround(-domain.centerZ * globals.worldsize + domain.absoluteSizeZ / 2.0);

        // Clean up for floating point precision a little.
        if (domain.startX < 0.0006) domain.startX = 0.0;
        if (domain.startZ > -0.0006) domain.startZ = 0.0;
        if (domain.endX > globals.worldsize * 0.9994) domain.endX = globals.worldsize;
        if (domain.endZ < -globals.worldsize * 0.9994) domain.endZ = -globals.worldsize;
      }

      // --- the domain's agent budgets (fractions of the global ones)
      {
        let minAgentsFraction = dom.getFloat('MinAgentsFraction');
        if (minAgentsFraction < 0.0) minAgentsFraction = domain.sizeX * domain.sizeZ;
        domain.minNumAgents = nintOf(minAgentsFraction * sim.fMinNumAgents);

        let maxAgentsFraction = dom.getFloat('MaxAgentsFraction');
        if (maxAgentsFraction < 0.0) maxAgentsFraction = domain.sizeX * domain.sizeZ;
        domain.maxNumAgents = nintOf(maxAgentsFraction * sim.maxAgents());

        let initAgentsFraction = dom.getFloat('InitAgentsFraction');
        if (initAgentsFraction < 0.0) initAgentsFraction = domain.sizeX * domain.sizeZ;
        domain.initNumAgents = nintOf(initAgentsFraction * sim.fInitNumAgents);

        let initSeedsFraction = dom.getFloat('InitSeedsFraction');
        if (initSeedsFraction < 0.0) initSeedsFraction = domain.sizeX * domain.sizeZ;
        domain.numberToSeed = nintOf(initSeedsFraction * sim.fNumberToSeed);

        domain.probabilityOfMutatingSeeds = dom.getFloat('ProbabilityOfMutatingSeeds');
        if (domain.probabilityOfMutatingSeeds < 0.0) {
          domain.probabilityOfMutatingSeeds = sim.fProbabilityOfMutatingSeeds;
        }

        let initFoodFraction = dom.getFloat('InitFoodFraction');
        if (initFoodFraction < 0.0) {
          domain.initFoodCount = nintOf(domain.sizeX * domain.sizeZ * sim.fInitFoodCount);
        } else {
          domain.initFoodCount = nintOf(initFoodFraction * sim.fInitFoodCount);
        }

        let minFoodFraction = dom.getFloat('MinFoodFraction');
        if (minFoodFraction < 0.0) {
          domain.minFoodCount = nintOf(domain.sizeX * domain.sizeZ * sim.fMinFoodCount);
        } else {
          domain.minFoodCount = nintOf(minFoodFraction * sim.fMinFoodCount);
        }

        let maxFoodFraction = dom.getFloat('MaxFoodFraction');
        if (maxFoodFraction < 0.0) {
          domain.maxFoodCount = nintOf(domain.sizeX * domain.sizeZ * sim.fMaxFoodCount);
        } else {
          domain.maxFoodCount = nintOf(maxFoodFraction * sim.fMaxFoodCount);
        }

        let maxFoodGrownFraction = dom.getFloat('MaxFoodGrownFraction');
        if (maxFoodGrownFraction < 0.0) {
          domain.maxFoodGrownCount = nintOf(domain.sizeX * domain.sizeZ * sim.fMaxFoodGrownCount);
        } else {
          domain.maxFoodGrownCount = nintOf(maxFoodGrownFraction * sim.fMaxFoodGrownCount);
        }

        domain.foodRate = dom.getFloat('FoodRate');
        if (domain.foodRate < 0.0) domain.foodRate = sim.fFoodRate;
      }

      // --- the initial agent-placement patch
      {
        const propPatch = dom.getObject('InitAgentsPatch');
        const cfgPatch = new Config(propPatch);
        const centerX = cfgPatch.getFloat('CenterX');
        const centerZ = cfgPatch.getFloat('CenterZ');
        const sizeX = cfgPatch.getFloat('SizeX');
        const sizeZ = cfgPatch.getFloat('SizeZ');
        const shape = shapeOf(cfgPatch.getString('Shape'));
        const distribution = distributionOf(cfgPatch.getString('Distribution'));

        const patch = new Patch(sim.getStage());
        patch.initBase(centerX, centerZ, sizeX, sizeZ, shape, distribution, 0.0, domain, id);
        domain.initAgentsPatch = patch;
      }

      // --- food patches
      {
        const propPatches = dom.getArray('FoodPatches');
        domain.numFoodPatches = propPatches.length;
        domain.foodPatches = [];
        let patchFractionSpecified = 0.0;

        for (let i = 0; i < domain.numFoodPatches; i++) {
          const propPatch = new Config(propPatches[i]!);

          const foodType = FoodType.lookup(propPatch.getString('FoodTypeName'));
          if (foodType === null) {
            throw new Error(`sim: unknown FoodType name '${propPatch.getString('FoodTypeName')}'`);
          }

          const centerX = propPatch.getFloat('CenterX');
          const centerZ = propPatch.getFloat('CenterZ');
          const sizeX = propPatch.getFloat('SizeX');
          const sizeZ = propPatch.getFloat('SizeZ');

          let foodFraction = propPatch.getFloat('FoodFraction');
          if (foodFraction < 0.0) foodFraction = sizeX * sizeZ;

          let initFoodFraction = propPatch.getFloat('InitFoodFraction');
          if (initFoodFraction < 0.0) initFoodFraction = foodFraction;
          const initFood = nintOf(initFoodFraction * domain.initFoodCount);

          let minFoodFraction = propPatch.getFloat('MinFoodFraction');
          if (minFoodFraction < 0.0) minFoodFraction = foodFraction;
          const minFood = nintOf(minFoodFraction * domain.minFoodCount);

          let maxFoodFraction = propPatch.getFloat('MaxFoodFraction');
          if (maxFoodFraction < 0.0) maxFoodFraction = foodFraction;
          const maxFood = nintOf(maxFoodFraction * domain.maxFoodCount);

          let maxFoodGrownFraction = propPatch.getFloat('MaxFoodGrownFraction');
          if (maxFoodGrownFraction < 0.0) maxFoodGrownFraction = foodFraction;
          const maxFoodGrown = nintOf(maxFoodGrownFraction * domain.maxFoodGrownCount);

          let foodRate = propPatch.getFloat('FoodRate');
          if (foodRate < 0.0) foodRate = domain.foodRate;

          const foodEnergy = propPatch.getFloat('FoodEnergy');
          const shape = shapeOf(propPatch.getString('Shape'));
          const distribution = distributionOf(propPatch.getString('Distribution'));
          const nhsize = propPatch.getFloat('NeighborhoodSize');
          const removeFood = propPatch.getBool('RemoveFood');
          if (removeFood) numFoodPatchesNeedingRemoval++;

          const on = propPatch.getBool('On');

          const patch = new FoodPatch(sim.getStage());
          patch.init(
            foodType,
            centerX,
            centerZ,
            sizeX,
            sizeZ,
            foodRate,
            foodEnergy,
            initFood,
            minFood,
            maxFood,
            maxFoodGrown,
            foodFraction,
            shape,
            distribution,
            nhsize,
            on,
            removeFood,
            domain,
            id,
          );
          domain.foodPatches.push(patch);

          patchFractionSpecified = Math.fround(patchFractionSpecified + foodFraction);
        }

        // If all the fractions are 0.0, set them from the patch areas.
        if (patchFractionSpecified === 0.0) {
          let totalArea = 0.0;
          for (let i = 0; i < domain.numFoodPatches; i++) {
            totalArea += domain.foodPatches[i]!.getArea();
          }
          for (let i = 0; i < domain.numFoodPatches; i++) {
            const patch = domain.foodPatches[i]!;
            const newFraction = patch.getArea() / totalArea;
            patch.setInitCounts(
              Math.trunc(newFraction * domain.initFoodCount),
              Math.trunc(newFraction * domain.minFoodCount),
              Math.trunc(newFraction * domain.maxFoodCount),
              Math.trunc(newFraction * domain.maxFoodGrownCount),
              newFraction,
            );
            patchFractionSpecified = Math.fround(patchFractionSpecified + newFraction);
          }
        }

        if (patchFractionSpecified < 0.99999 || patchFractionSpecified > 1.00001) {
          throw new Error(
            `sim: patch fractions sum to ${patchFractionSpecified}, when they must sum to 1.0 (native exits)`,
          );
        }
      }

      // --- brick patches
      {
        const propPatches = dom.getArray('BrickPatches');
        domain.numBrickPatches = propPatches.length;
        domain.brickPatches = [];

        for (let i = 0; i < domain.numBrickPatches; i++) {
          const propPatch = new Config(propPatches[i]!);
          const centerX = propPatch.getFloat('CenterX');
          const centerZ = propPatch.getFloat('CenterZ');
          const sizeX = propPatch.getFloat('SizeX');
          const sizeZ = propPatch.getFloat('SizeZ');
          const brickCount = propPatch.getInt('BrickCount');
          const shape = shapeOf(propPatch.getString('Shape'));
          const distribution = distributionOf(propPatch.getString('Distribution'));
          const nhsize = propPatch.getFloat('NeighborhoodSize');
          const color = propPatch.has('BrickColor') ? colorOf(propPatch, 'BrickColor') : colorOf(doc, 'BrickColor');
          const on = propPatch.getBool('On');

          const patch = new BrickPatch(sim.getStage());
          patch.init(color, centerX, centerZ, sizeX, sizeZ, brickCount, shape, distribution, nhsize, domain, id, on);
          domain.brickPatches.push(patch);
        }
      }

      totmaxnumagents += domain.maxNumAgents;
      totminnumagents += domain.minNumAgents;
    }

    // Native only warns (`errorflash`) about the two global/domain mismatches; the port keeps the
    // run going, with a comment instead of a swallowed error.
    //   totmaxnumagents > fMaxNumAgents  -> "there may still be some indirect global influences"
    //   totminnumagents < fMinNumAgents  -> same note on the minimum side.

    if (numFoodPatchesNeedingRemoval > 0) {
      sim.fFoodPatchesNeedingRemoval = new Array(numFoodPatchesNeedingRemoval).fill(null);
      sim.fFoodRemovalNeeded = true;
    } else {
      sim.fFoodRemovalNeeded = false;
    }

    const numberFittest = doc.getInt('NumberFittest');
    for (let id = 0; id < sim.fNumDomains; id++) {
      const domain = sim.fDomains[id]!;
      domain.numAgents = 0;
      domain.numcreated = 0;
      domain.numborn = 0;
      domain.numbornsincecreated = 0;
      domain.numdied = 0;
      domain.lastcreate = 0;
      domain.maxgapcreate = 0;
      domain.energyScaleFactor = 1.0;
      domain.ifit = 0;
      domain.jfit = 1;
      domain.fittest = numberFittest > 0 ? new FittestList(numberFittest, true) : (null as unknown as FittestList);
    }
  }

  sim.fUseProbabilisticFoodPatches = doc.getBool('ProbabilisticFoodPatches');
  sim.fMinFoodEnergyAtDeath = doc.getFloat('MinFoodEnergyAtDeath');
  sim.fRandomBirthLocation = doc.getBool('RandomBirthLocation');
  sim.fRandomBirthLocationRadius = doc.getFloat('RandomBirthLocationRadius');

  {
    const prop = doc.getString('SmiteMode');
    if (prop === 'O') sim.fSmiteMode = 'O';
    else if (prop === 'R') sim.fSmiteMode = 'R';
    else if (prop === 'L') sim.fSmiteMode = 'L';
    else throw new Error(`sim: unknown SmiteMode '${prop}' (native asserts)`);
  }
  sim.fSmiteFrac = doc.getFloat('SmiteFrac');
  sim.fSmiteAgeFrac = doc.getFloat('SmiteAgeFrac');

  sim.fNumDepletionSteps = doc.getInt('NumDepletionSteps');
  if (sim.fNumDepletionSteps) sim.fMaxPopulationPenaltyFraction = 1.0 / Math.fround(sim.fNumDepletionSteps);

  sim.fApplyLowPopulationAdvantage = doc.getBool('ApplyLowPopulationAdvantage');
  sim.fEnergyBasedPopulationControl = doc.getBool('EnergyBasedPopulationControl');
  sim.fPopControlGlobal = doc.getBool('PopControlGlobal');
  sim.fPopControlDomains = doc.getBool('PopControlDomains');
  sim.fPopControlMinFixedRange = doc.getFloat('PopControlMinFixedRange');
  sim.fPopControlMaxFixedRange = doc.getFloat('PopControlMaxFixedRange');
  sim.fPopControlMinScaleFactor = doc.getFloat('PopControlMinScaleFactor');
  sim.fPopControlMaxScaleFactor = doc.getFloat('PopControlMaxScaleFactor');

  sim.fAllowBirths = doc.getBool('AllowBirths');
  sim.fAllowMinDeaths = doc.getBool('AllowMinDeaths');

  sim.fComplexityType = doc.getString('ComplexityType');
  sim.fComplexityFitnessWeight = doc.getFloat('ComplexityFitnessWeight');
  if (sim.fComplexityFitnessWeight) sim.fCalcComplexity = true;
  sim.fHeuristicFitnessWeight = doc.getFloat('HeuristicFitnessWeight');
  sim.fTournamentSize = doc.getInt('TournamentSize');

  globals.recordFileType = doc.getBool('CompressFiles') ? ConcreteFileType.TYPE_GZIP_FILE : ConcreteFileType.TYPE_FILE;

  sim.fFogFunction = doc.getString('FogFunction')[0]!;
  sim.fExpFogDensity = doc.getFloat('ExpFogDensity');
  sim.fLinearFogEnd = doc.getInt('LinearFogEnd');

  // --- the worldfile's `Variables` array (native pushes them into `Document::variables`, which the
  //     proplib lanes own; the sim reads none of them) — PORT-NOTE(sim/variables-owner).
}

/** Native `fMaxNumAgents` is a static; the worldfile is its only writer. */
function SimulationSetMaxAgents(sim: Simulation, value: number): void {
  sim.setStaticMaxNumAgents(value);
}

/** Native's `__SET` macro blocks (`Carry*`, `Shield*`, `Solid*` -> the object-type mask). */
function objectMask(doc: Config, prefix: string): number {
  let mask = 0;
  if (doc.getBool(`${prefix}Agents`)) mask |= AGENTTYPE;
  if (doc.getBool(`${prefix}Food`)) mask |= FOODTYPE;
  if (doc.getBool(`${prefix}Bricks`)) mask |= BRICKTYPE;
  return mask;
}

/**
 * Native `Color::Color( proplib::Property &prop )` (`graphics.cc:17-20`) as the sim uses it:
 * `set( (float)prop.get("R"), (float)prop.get("G"), (float)prop.get("B") )` — three components,
 * each coerced by `strtof` into a `float`, alpha 1.0 (never read on this path).
 *
 * PORT-NOTE(sim/color-block): every colour the worldfile feeds the sim (`FoodColor`,
 * `BrickColor`, `BarrierColor`, `GroundColor`, and the per-`FoodType` / per-patch overrides) is a
 * `Color` **block** in `etc/worldfile.wfs` (`{ R G B }`), so the property must be opened as a
 * container before the component reads. Reading the property itself as a float is the
 * `ERROR! Expecting Float` the boot reported; `worldParams.ts` (`reads.rgb`) opens the same block
 * for the browser shell.
 */
function colorOf(cfg: Config | PropertyNode, id: string): Color {
  const config = cfg instanceof Config ? cfg : new Config(cfg);
  const block = new Config(config.getObject(id));
  return { r: block.getFloat('R'), g: block.getFloat('G'), b: block.getFloat('B') };
}

/** Native Patch's shape token -> constant. */
function shapeOf(value: string): number {
  if (value === 'R') return 0;
  if (value === 'E') return 1;
  throw new Error(`sim: unknown patch Shape '${value}' (native asserts)`);
}

/** Native Patch's distribution token -> constant. */
function distributionOf(value: string): number {
  if (value === 'U') return 0;
  if (value === 'L') return 1;
  if (value === 'G') return 2;
  throw new Error(`sim: unknown patch Distribution '${value}' (native asserts)`);
}

/** Native `(bool)prop` for the mixed string/bool `AgentsAreFood` property. */
function nativeBoolOf(text: string): boolean {
  return text !== '0' && text !== '' && text.toLowerCase() !== 'false';
}

/** Native `TSimulation::initLockstepMode()` (`4584-4631`). */
export function initLockstepMode(sim: Simulation): void {
  agentConfig.dieAtMaxAge = false;
  agentConfig.eat2Energy = 0;
  agentConfig.mate2Energy = 0;
  agentConfig.fight2Energy = 0;
  agentConfig.maxSizePenalty = 0;
  agentConfig.speed2Energy = 0;
  agentConfig.yaw2Energy = 0;
  agentConfig.light2Energy = 0;
  agentConfig.focus2Energy = 0;
  agentConfig.pickup2Energy = 0;
  agentConfig.drop2Energy = 0;
  agentConfig.carryAgent2Energy = 0;
  agentConfig.carryAgentSize2Energy = 0;
  agentConfig.fixedEnergyDrain = 0;
  Food.gCarryFood2Energy = 0;
  Brick.gCarryBrick2Energy = 0;

  sim.fNumDepletionSteps = 0;
  sim.fMaxPopulationPenaltyFraction = 0;
  sim.fApplyLowPopulationAdvantage = false;
  sim.fEnergyBasedPopulationControl = false;
}

/**
 * Native `TSimulation::initFitnessMode()` (`Simulation.cc:4636-4672`, body `4638-4653`).
 *
 * A steady-state GA run — the ctor calls this whenever
 * `fHeuristicFitnessWeight != 0.0 || fComplexityFitnessWeight != 0` (`Simulation.cc:292`) —
 * forces the population-control machinery off, so the worldfile's own values for those
 * parameters are discarded. The transcription below is the whole forced list; the native
 * `cout` block (`4655-4671`) prints the same fields and is **stdout only** (the parity
 * harness compares the run-tree bytes, never stdout), so it is deliberately not ported.
 */
export function initFitnessMode(sim: Simulation): void {
  // `fMinNumAgents = fMaxNumAgents = fInitNumAgents` — the first is the instance field
  // (`Simulation.h:316`), the second the *static* one (`Simulation.h:61`), so the latter goes
  // through the same writer `processWorldFile` uses for `MaxAgents`.
  sim.fMinNumAgents = sim.fInitNumAgents;
  sim.setStaticMaxNumAgents(sim.fInitNumAgents);

  for (let i = 0; i < sim.fNumDomains; i++) {
    // over all domains
    const domain = sim.fDomains[i]!;
    domain.minNumAgents = domain.initNumAgents;
    domain.maxNumAgents = domain.initNumAgents;
  }

  sim.fNumDepletionSteps = 0; // turn off the high-population penalty
  sim.fMaxPopulationPenaltyFraction = 0.0; // ditto
  sim.fApplyLowPopulationAdvantage = false; // turn off the low-population advantage
  sim.fEnergyBasedPopulationControl = false; // turn off energy-based population control
  sim.fEndOnPopulationCrash = false;
}

/** Native `TSimulation::initAdaptivityMode()` (`4677-4725`). */
export function initAdaptivityMode(sim: Simulation): void {
  if (sim.fComplexityFitnessWeight === 0 && sim.fHeuristicFitnessWeight === 0) {
    throw new Error(
      'sim: AdaptivityMode requires ComplexityFitnessWeight or HeuristicFitnessWeight (native errors)',
    );
  }
}
