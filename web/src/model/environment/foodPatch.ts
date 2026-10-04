/**
 * Lane L10 — native `environment/FoodPatch.{h,cc}`.
 *
 * A food patch is a `Patch` plus the food *bookkeeping*: how many food objects it currently
 * has, how many it may hold, whether it is `on`, and the energy a new food gets. The growth
 * *decision* is the simulation's (`sim/Simulation.cc`'s `GrowFood`/`EndStep`), but the creation
 * path is here — `addFood` is the only place a live food object is constructed from a patch.
 *
 * PORT-NOTE(L10/foodpatch-energy-sentinel): `energy == -1.0` means "use the worldfile's random
 * `[ MinFoodEnergy, MaxFoodEnergy )`". This is an *exact* float comparison against a double
 * literal, so a worldfile value of `-1` (which arrives as `float -1.0f`) triggers it and
 * `-0.9999999` does not. The port keeps `=== -1.0` for exactly that reason.
 *
 * PORT-NOTE(L10/addfood-draws-two-positions): `addFood` constructs the food (which draws its
 * own random energy and position when the patch's energy is the sentinel) and **then**
 * overwrites `x`/`z` from `setPoint`. Both sets of draws happen; the port keeps both, because
 * dropping the constructor's draws would shift the whole drand48 stream.
 */

import { Patch, type DomainLike, type StageLike } from './patch';
import { Food } from './food';
import { Energy } from './energy';
import { gXSortedObjects, type XSortedObjects } from './objectXSortedList';
import type { FoodType } from './foodType';

/** Native `class FoodPatch : public Patch` (`FoodPatch.h:33-77`). */
export class FoodPatch extends Patch {
  growthRate = 0;
  energy = 0;

  foodCount = 0;
  initFoodCount = 0;
  minFoodCount = 0;
  maxFoodCount = 0;
  maxFoodGrownCount = 0;

  fraction = 0;
  foodRate = 0;

  removeFood = false;
  foodGrown = false;

  private on = false;
  private onPrev = false;
  private foodType: FoodType | null = null;

  constructor(stage: StageLike) {
    super(stage);
  }

  /** Native `FoodPatch::init(...)` (`FoodPatch.cc:39-69`). */
  init(
    foodType: FoodType,
    x: number,
    z: number,
    sx: number,
    sz: number,
    rate: number,
    e: number,
    initFood: number,
    minFood: number,
    maxFood: number,
    maxFoodGrown: number,
    patchFraction: number,
    shape: number,
    distrib: number,
    nhsize: number,
    on: boolean,
    inRemoveFood: boolean,
    domain: DomainLike,
    domainNumber: number,
  ): void {
    this.initBase(x, z, sx, sz, shape, distrib, nhsize, domain, domainNumber);

    this.fraction = patchFraction;
    this.growthRate = rate;
    this.energy = e;
    this.initFoodCount = initFood;
    this.foodCount = 0;
    this.foodGrown = false;

    this.minFoodCount = minFood;
    this.maxFoodCount = maxFood;
    this.maxFoodGrownCount = maxFoodGrown;

    this.on = on;
    this.onPrev = false;
    this.foodType = foodType;

    this.removeFood = inRemoveFood;
  }

  /** Native `FoodPatch::setInitCounts(...)` (`FoodPatch.cc:76-86`). */
  setInitCounts(initFood: number, minFood: number, maxFood: number, maxFoodGrown: number, newFraction: number): void {
    this.initFoodCount = initFood;
    this.minFoodCount = minFood;
    this.maxFoodCount = maxFood;
    this.maxFoodGrownCount = maxFoodGrown;
    this.fraction = newFraction;
  }

  /** Native `FoodPatch::addFood( long step )` (`FoodPatch.cc:107-146`). */
  addFood(step: number, worldObjects: XSortedObjects = gXSortedObjects): Food | null {
    if (this.foodCount < this.maxFoodCount) {
      const f =
        this.energy === -1.0
          ? new Food(this.foodTypeOf(), step)
          : new Food(this.foodTypeOf(), step, new Energy(this.energy));

      // set the values of x and y to a legal point in the foodpatch
      const { x, z } = this.setPoint();
      f.setx(x);
      f.setz(z);

      f.setDomain(this.domainNumberOfParent);
      f.setPatch(this);

      worldObjects.add(f);
      this.stageRef().addObject(f);

      this.foodCount++;
      return f;
    }
    return null;
  }

  /** Native `FoodPatch::isOn()`. */
  isOn(): boolean {
    return this.on;
  }
  /** Native `FoodPatch::isOnChanged()` — a `dyn()` property changes `on`. */
  isOnChanged(): boolean {
    return this.on !== this.onPrev;
  }
  /** Native `FoodPatch::endStep()` — latch `onPrev` for the next `isOnChanged()`. */
  endStep(): void {
    this.onPrev = this.on;
  }

  /** Native `FoodPatch::initFoodGrown()` / `initFoodGrown( bool )`. */
  isInitFoodGrown(): boolean {
    return this.foodGrown;
  }
  setInitFoodGrown(value: boolean): void {
    this.foodGrown = value;
  }

  /** Native's `on` member, for the cppprops binding. */
  setOn(on: boolean): void {
    this.on = on;
  }

  foodTypeRef(): FoodType | null {
    return this.foodType;
  }

  private foodTypeOf(): FoodType {
    if (this.foodType === null) throw new Error('FoodPatch::addFood: the patch has no food type');
    return this.foodType;
  }
}
