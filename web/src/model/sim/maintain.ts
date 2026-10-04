/**
 * Lane L11 (sim) — `MaintainBricks`, `MaintainFood`, `AddFood`, `RemoveFood`, `FoodEnergyIn/Out`
 * and `getRandomPatch` (native `Simulation.cc` 3153-3163, 3168-3355, 3706-3745, 3750-3770,
 * 5261-5301).
 *
 * This module owns the step's *last* RNG consumers: the probabilistic food growth (`randpw() <
 * probAdd`), the patch picks (`ranval = randpw() * maxFractions`) and the initial-age draw in
 * `AddFood` (`trand( -gMaxLifeSpan, 0 )` when `fStep == 0`). Their count and order are contract —
 * any extra or missing draw shifts every later genome, position and food placement
 * (sim-spec §8.3, PORT-NOTE(rng-shortcircuit)).
 *
 * PORT-NOTE(sim/float32-foodmath): native's `probAdd`, `fraction`, `growthRate`, `maxFractions` and
 * `ranval` are `float`s and the accumulations happen in `float`; the port `Math.fround`s at the
 * same places (`floor` on a `float`, `randpw()` is already a double narrowed on store).
 */

import { Energy, f32 } from '../agent';
import { Food, type FoodPatch } from '../environment';
import { gXSortedObjects } from '../environment';
import { GObjectType, type Config } from '../types';
import type { Simulation } from './simulation';

const FOODTYPE = GObjectType.FOOD;

/** f64 `Math.floor` returns an f64; native's `floor` here is on a `float`. */
function f32Floor(value: number): number {
  return Math.fround(Math.floor(Math.fround(value)));
}

/** Native `TSimulation::MaintainBricks` (`3153-3163`). */
export function maintainBricks(sim: Simulation): void {
  for (let domainNumber = 0; domainNumber < sim.fNumDomains; domainNumber++) {
    const domain = sim.fDomains[domainNumber]!;
    for (let brickPatchNumber = 0; brickPatchNumber < domain.numBrickPatches; brickPatchNumber++) {
      domain.brickPatches[brickPatchNumber]!.updateOn();
    }
  }
}

/** Native `TSimulation::MaintainFood` (`3168-3355`). */
export function maintainFood(sim: Simulation): void {
  // --- remove any food that has exceeded its lifespan
  if (Food.gMaxLifeSpan > 0) {
    for (;;) {
      const f = Food.gAllFood.front();
      if (f === null || f.getAge(sim.fStep) < Food.gMaxLifeSpan) break;

      // `gAllFood` is ordered by creation, and `RemoveFood` takes the food out of it, so the head
      // is re-examined every iteration.
      gXSortedObjects.setcurr(f.listLink as unknown as Parameters<typeof gXSortedObjects.setcurr>[0]);
      removeFood(sim, f);
    }

    gXSortedObjects.reset();
  }

  // --- bring every patch up to its minimum and grow by the food rate
  if (gXSortedObjects.getCount(FOODTYPE) < sim.fMaxFoodCount) {
    for (let domainNumber = 0; domainNumber < sim.fNumDomains; domainNumber++) {
      const domain = sim.fDomains[domainNumber]!;

      // Dynamic patches that have not had their initial growth yet but are now on.
      if (domain.numFoodPatchesGrown < domain.numFoodPatches) {
        for (let patchNumber = 0; patchNumber < domain.numFoodPatches; patchNumber++) {
          const patch = domain.foodPatches[patchNumber]!;
          if (!patch.isInitFoodGrown() && patch.isOn()) {
            for (let j = 0; j < patch.initFoodCount; j++) {
              if (domain.foodCount < domain.maxFoodCount) {
                addFood(sim, domainNumber, patchNumber);
              }
            }
            patch.setInitFoodGrown(true);
            domain.numFoodPatchesGrown++;
          }
        }
      }

      if (sim.fUseProbabilisticFoodPatches) {
        if (domain.foodCount < domain.maxFoodGrownCount) {
          // Grow by a probability based on the decimal part of the domain's foodRate.
          const probAdd =
            sim.fFoodGrowthModel === 0 /* MaxRelative */
              ? (domain.maxFoodGrownCount - domain.foodCount) *
                Math.fround(domain.foodRate - f32Floor(domain.foodRate))
              : Math.fround(domain.foodRate - f32Floor(domain.foodRate));

          if (sim.randpw() < probAdd) {
            const patchNumber = getRandomPatch(sim, domainNumber);
            if (patchNumber >= 0) addFood(sim, domainNumber, patchNumber);
          }

          // Grow by the integer part of the domain's foodRate.
          const foodToGrow = Math.trunc(domain.foodRate);
          for (let i = 0; i < foodToGrow; i++) {
            const patchNumber = getRandomPatch(sim, domainNumber);
            if (patchNumber >= 0) {
              addFood(sim, domainNumber, patchNumber);
            } else {
              break; // no active patches in this domain, so give up
            }
          }

          // Keep at least the minimum amount of food around.
          const newFood = domain.minFoodCount - domain.foodCount;
          for (let i = 0; i < newFood; i++) {
            const patchNumber = getRandomPatch(sim, domainNumber);
            if (patchNumber >= 0) {
              addFood(sim, domainNumber, patchNumber);
            } else {
              break; // no active patches in this domain, so give up
            }
          }
        }
      } else {
        for (let patchNumber = 0; patchNumber < domain.numFoodPatches; patchNumber++) {
          const patch = domain.foodPatches[patchNumber]!;
          if (!patch.isOn()) continue;
          if (patch.foodCount >= patch.maxFoodGrownCount) continue;

          // Grow by a probability based on the decimal part of the patch's growthRate.
          const probAdd =
            sim.fFoodGrowthModel === 0 /* MaxRelative */
              ? (patch.maxFoodGrownCount - patch.foodCount) *
                Math.fround(patch.growthRate - f32Floor(patch.growthRate))
              : Math.fround(patch.growthRate - f32Floor(patch.growthRate));

          if (sim.randpw() < probAdd) {
            addFood(sim, domainNumber, patchNumber);
          }

          // Grow by the integer part of the growthRate.
          const foodToGrow = Math.trunc(patch.growthRate);
          for (let i = 0; i < foodToGrow; i++) {
            addFood(sim, domainNumber, patchNumber);
          }

          // Keep at least the minimum amount of food around.
          const newFood = patch.minFoodCount - patch.foodCount;
          for (let i = 0; i < newFood; i++) {
            addFood(sim, domainNumber, patchNumber);
          }
        }
      }
    }
  }

  // --- dynamic patches that destroy their food when turned off
  if (sim.fFoodRemovalNeeded) {
    const patchesNeedingRemoval: FoodPatch[] = [];
    for (let domainNumber = 0; domainNumber < sim.fNumDomains; domainNumber++) {
      const domain = sim.fDomains[domainNumber]!;
      for (let ipatch = 0; ipatch < domain.numFoodPatches; ipatch++) {
        const patch = domain.foodPatches[ipatch]!;
        if (patch.removeFood && !patch.isOn() && patch.isOnChanged()) {
          patchesNeedingRemoval.push(patch);
        }
      }
    }

    if (patchesNeedingRemoval.length > 0) {
      gXSortedObjects.reset();
      for (;;) {
        const f = gXSortedObjects.nextObj(FOODTYPE) as Food | null;
        if (f === null) break;
        for (const patch of patchesNeedingRemoval) {
          if (f.getPatch() === patch) {
            removeFood(sim, f);
            break; // found the patch and removed the food
          }
        }
      }
    }
  }

  // --- the per-patch end-of-step bookkeeping
  for (let domainNumber = 0; domainNumber < sim.fNumDomains; domainNumber++) {
    const domain = sim.fDomains[domainNumber]!;
    for (let patch = 0; patch < domain.numFoodPatches; patch++) {
      domain.foodPatches[patch]!.endStep();
    }
  }
}

/** Native `TSimulation::getRandomPatch( domainNumber )` (`5261-5301`). */
export function getRandomPatch(sim: Simulation, domainNumber: number): number {
  const domain = sim.fDomains[domainNumber]!;
  let patch: number;
  let maxFractions = 0.0;

  // Only the patches that are "on" may grow food, so the maximum attainable fraction is theirs.
  for (let i = 0; i < domain.numFoodPatches; i++) {
    const fp = domain.foodPatches[i]!;
    if (fp.isOn()) maxFractions = Math.fround(maxFractions + fp.fraction);
  }

  if (maxFractions > 0.0) {
    let sumFractions = 0.0;
    const ranval = Math.fround(sim.randpw() * maxFractions);

    for (let i = 0; i < domain.numFoodPatches; i++) {
      const fp = domain.foodPatches[i]!;
      if (fp.isOn()) {
        sumFractions = Math.fround(sumFractions + fp.fraction);
        if (ranval <= sumFractions) return i; // this is the patch
      }
    }

    // Shouldn't get here.
    patch = Math.trunc(Math.fround(Math.floor(ranval * domain.numFoodPatches)));
    if (patch >= domain.numFoodPatches) patch = domain.numFoodPatches - 1;
    // Native prints to stderr here; the port keeps the value (the print is diagnostic only).
  } else {
    patch = -1; // no patches are active in this domain
  }

  return patch;
}

/** Native `TSimulation::AddFood( domainNumber, patchNumber )` (`3706-3717`). */
export function addFood(sim: Simulation, domainNumber: number, patchNumber: number): void {
  let step = sim.fStep;
  if (sim.fStep === 0 && sim.fRandomInitFoodAge) {
    // Native `(int)trand( -food::gMaxLifeSpan, 0 )` — `trand` draws from `drand48`.
    step = Math.trunc(sim.randpw() * (0 - -Food.gMaxLifeSpan) + -Food.gMaxLifeSpan);
  }

  const f = sim.fDomains[domainNumber]!.foodPatches[patchNumber]!.addFood(step);
  if (f !== null) {
    sim.fDomains[domainNumber]!.foodCount++;
    foodEnergyIn(sim, f.getEnergy());
  }
}

/** Native `TSimulation::RemoveFood( f )` (`3722-3745`). */
export function removeFood(sim: Simulation, f: Food): void {
  const fp = f.getPatch();
  if (fp !== null) fp.foodCount--;

  const domain = f.domain();
  if (!(domain >= 0 && domain < sim.fNumDomains)) {
    throw new Error(`sim: RemoveFood: domain ${domain} out of range (native asserts)`);
  }
  sim.fDomains[domain]!.foodCount--;

  // Native asserts the cursor is on `f`; the port asserts the same way, because
  // `removeCurrentObject` would otherwise remove the wrong object.
  if (gXSortedObjects.current() !== (f as unknown as ReturnType<typeof gXSortedObjects.current>)) {
    throw new Error('sim: RemoveFood: the x-sorted cursor is not on this food (native asserts)');
  }
  gXSortedObjects.removeCurrentObject(); // get it out of the list

  sim.getStage().removeObject(f as never); // get it out of the world

  // Native `if( f->BeingCarried() ) ((agent*)(f->CarriedBy()))->DropObject( (gobject*) f );`
  // The carrier accessor is lane L10's; the port calls it defensively because the environment lane
  // owns its name (PORT-NOTE(sim/carrier-accessor-seam)).
  const carrier = (f as unknown as { carriedByObject?: () => unknown }).carriedByObject?.() ?? null;
  if (carrier !== null) {
    (carrier as { dropObject(o: unknown): void }).dropObject(f);
  }

  foodEnergyOut(sim, f.getEnergy());
}

/**
 * Native `TSimulation::FoodEnergyIn( e )` (`3750-3759`).
 *
 * PORT-NOTE(sim/food-energy-index): native adds `e[0]` — the **first** energy-type slot only —
 * after a one-time warning when the run has more than one energy type or food type. The port keeps
 * the single slot (the recorded scenarios have one energy type; a multi-type worldfile would need
 * the same warning and the same first slot).
 */
export function foodEnergyIn(sim: Simulation, e: Energy): void {
  // `__ZN11TSimulation12FoodEnergyInERK6Energy` 0x9621c-0x96224: `fadd s0, s0, s1` then
  // `str s0` — a **float** add and a float store into `fFoodEnergyIn`, not a binary64 running
  // total (`run/stats/stat.1`'s `totFoodEnergy` reads these fields).
  sim.fFoodEnergyIn = f32(sim.fFoodEnergyIn + e.get(0));
}

/** Native `TSimulation::FoodEnergyOut( e )` (`3762-3767`). */
export function foodEnergyOut(sim: Simulation, e: Energy): void {
  sim.fFoodEnergyOut = f32(sim.fFoodEnergyOut + e.get(0));
}

/** Re-exported for the barrel (the recorders read the food type table through lane L10). */
export type { Config };
