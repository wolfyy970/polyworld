/**
 * Lane L10 — native `environment/food.{h,cc}`: one food object, plus native's process-wide
 * `food::gAllFood` list.
 *
 * FOUR THINGS HERE ARE FROZEN
 *
 *  1. **`food::setradius()` is *not* `gbox::setradius()`.** `food` overrides the virtual
 *     deriver (`food.cc:213-220`) to use `fLength[0]` and `fLength[2]` **only** — the height
 *     is excluded. `initlen()` calls `setlen()`, which calls the virtual `setradius()`, so a
 *     fully-constructed `food` never picks up the `gbox` rule that includes `fLength[1]`.
 *     PORT-NOTE(L10/food-radius-xz-only).
 *  2. **The construction order of the RNG draws.** `gobject::init()` spends three `rand()`
 *     values (colour) and `setlen` is called only later, in `initlen()`; the drand48 draws are
 *     *energy first, then x, then z* (`food.cc:169-176`).
 *     PORT-NOTE(L10/food-draw-order).
 *  3. **`initlen()` is called again after every bite** (`food::eat`), so `fLength` and
 *     `fRadius` track the *remaining* energy. `fPosition[1]` is **not** re-derived — it was
 *     fixed at creation from the original length. PORT-NOTE(L10/eat-reinitlen-only).
 *  4. **`fFoodEver` numbering** — `setTypeNumber( ++fFoodEver )` counts every food ever
 *     constructed, including carcass food and the negative-step `RandomInitFoodAge` path; it
 *     is written to `run/events/energy.log`'s `ObjectNumber` column.
 *
 * `gAllFood` is ordered by *creation step*: a non-negative step appends, and a negative step
 * (the `RandomInitFoodAge` path, `Simulation.cc:3710`) inserts **before the first food whose
 * creation step is greater**, i.e. the list stays ascending by step with FIFO among equals
 * (a `std::list::insert` at the located position). PORT-NOTE(L10/gallfood-order).
 *
 * PORT-NOTE(L10/gallfood-node-list): native erases through a stored `std::list` iterator, so
 * an erase of one food leaves every other food's iterator valid. The port keeps a doubly
 * linked node list for the same reason — an array index would go stale the moment any *other*
 * food is destroyed (the sim destroys several per step in `EndStep`).
 */

import { globalRngSurface } from '../rng';
import { contractedSquareSumXZ, f32, scaledRadius } from '../geometry';
import { globals, type Color, type RngSurface } from '../types';
import { GObjectType } from '../types/simconst';
import { GoBoxFilled } from './object';
import { Energy } from './energy';
import type { FoodType } from './foodType';
import type { FoodPatch } from './foodPatch';

/** A node of native's `list<food*>` — needed because native erases through an iterator. */
export interface FoodListNode {
  food: Food;
  prev: FoodListNode | null;
  next: FoodListNode | null;
}

/** Native `food::FoodList` — `std::list<food*>`, walked front-to-back and erased by position. */
export class FoodList {
  head: FoodListNode | null = null;
  tail: FoodListNode | null = null;
  private kount = 0;

  get size(): number {
    return this.kount;
  }
  empty(): boolean {
    return this.kount === 0;
  }
  front(): Food | null {
    return this.head?.food ?? null;
  }
  back(): Food | null {
    return this.tail?.food ?? null;
  }

  /** Native `push_back`. */
  pushBack(food: Food): FoodListNode {
    const node: FoodListNode = { food, prev: this.tail, next: null };
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.kount++;
    return node;
  }

  /** Native `insert( iterator, food* )` — insert `food` immediately before `node`. */
  insertBefore(food: Food, node: FoodListNode): FoodListNode {
    const inserted: FoodListNode = { food, prev: node.prev, next: node };
    if (node.prev) node.prev.next = inserted;
    else this.head = inserted;
    node.prev = inserted;
    this.kount++;
    return inserted;
  }

  /** Native `erase( iterator )`. */
  erase(node: FoodListNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = node.next = null;
    this.kount--;
  }

  /** Native's `itfor( FoodList, food::gAllFood, it )` walks — front to back. */
  toArray(): Food[] {
    const out: Food[] = [];
    for (let n = this.head; n !== null; n = n.next) out.push(n.food);
    return out;
  }

  /** Test/simulation hook (native's global lives for the process). */
  clear(): void {
    this.head = this.tail = null;
    this.kount = 0;
  }
}

/** Native `class food : public gboxf` (`food.h:33-92`). */
export class Food extends GoBoxFilled {
  // --- statics (native `food.cc:33-41`, all written by `TSimulation::processWorldFile`) ---
  static gFoodHeight = 0.0;
  static gFoodColor: Color = { r: 0, g: 0, b: 0 };
  static gMinFoodEnergy = 0.0;
  static gMaxFoodEnergy = 0.0;
  /** Native `gSize2Energy` — "converts between food/agent size and available energy". */
  static gSize2Energy = 0.0;
  static gMaxFoodRadius = 0.0;
  static gCarryFood2Energy = 0.0;
  static gMaxLifeSpan = 0;
  /** Native `food::gAllFood` — the process-wide list of every living food object. */
  static readonly gAllFood = new FoodList();
  private static fFoodEver = 0;

  private energy = new Energy();
  private fDomain = 0;
  private patch: FoodPatch | null = null;
  private foodType: FoodType | null = null;
  private creationStep = 0;
  private allFoodNode: FoodListNode | null = null;

  /**
   * Native's three constructors:
   *   `food( ft, step )`               — random energy in [ MinFoodEnergy, MaxFoodEnergy )
   *   `food( ft, step, e )`            — given energy, random position
   *   `food( ft, step, e, x, z )`      — given energy and position (carcass food)
   */
  constructor(foodType: FoodType, step: number, energy?: Energy, x?: number, z?: number, rng?: RngSurface) {
    super(rng ?? globalRngSurface());
    // One surface for the whole construction: native reaches the process-wide `randpw()` for
    // all three draws, so an injected surface must supply all three (a split would silently
    // interleave two streams and break `L10/food-draw-order`'s contract for a test that
    // injects one). PORT-NOTE(L10/food-draw-order).
    const surface = rng ?? globalRngSurface();
    if (energy === undefined) {
      // Native `food::initfood( ft, step )`: one draw for the energy, then the 3-arg form.
      //
      // PORT-NOTE(L10/food-energy-operand-f32): **the difference is narrowed to `float`
      // before it is widened.** `__ZN4food8initfoodEPK8FoodTypel` (`0x5ac38`) is
      //
      //   5ac70:  fsub   s1, s1, s2         ; s1 = f32( gMaxFoodEnergy - gMinFoodEnergy )
      //   5ac74:  fcvt   d1, s1             ; widen *that float* to double
      //   5ac78:  fcvt   d2, s2             ; widen gMinFoodEnergy to double (exact)
      //   5ac7c:  fmadd  d0, d0, d1, d2     ; randpw() * d1 + d2, ONE double rounding
      //   5ac80:  fcvt   s0, d0             ; narrow the result to float
      //
      // (and `__ZN4foodC2EPK8FoodTypel` `0x5ab08` inlines the identical five at
      // `0x5ab94`/`0x5ab98`/`0x5ab9c`/`0x5aba0`/`0x5aba4`). So native is
      // `f32( randpw() * (double)f32(Max - Min) + (double)Min )`: the `fsub` rounds the
      // difference to binary32 *first*, which the port did not do — the plain
      // `gMaxFoodEnergy - gMinFoodEnergy` is a binary64 subtraction, and its result
      // differs from the binary's operand by ~2^-24 relative, i.e. a wrong operand far
      // above any last-bit question. Fixed here (`f32( ... )` around the difference);
      // pinned in `tests/environment.test.ts` -> *the food energy draw*.
      //
      // What is **not** fixed, and cannot be, is the `fmadd d0, d0, d1, d2` itself: the
      // product is `double` x `double` with a 48-bit factor, so no JS expression is one
      // rounding — that is the residual double-contraction class PARITY.md's standing
      // human decision covers (`-ffp-contract=off` vs an `f64Fma` helper). This
      // expression therefore keeps the two-rounding multiply-then-add.
      const e = new Energy(
        f32(surface.drand48() * f32(Food.gMaxFoodEnergy - Food.gMinFoodEnergy) + Food.gMinFoodEnergy),
      );
      this.initFood(foodType, step, e, surface);
    } else if (x === undefined || z === undefined) {
      this.initFood(foodType, step, energy, surface);
    } else {
      this.initFoodAt(foodType, step, energy, f32(x), f32(z));
    }
  }

  /** Native `food::initfood( ft, step, e )` — draws `x` then `z`. */
  private initFood(foodType: FoodType, step: number, e: Energy, rng: RngSurface): void {
    const x = f32(rng.drand48() * globals.worldsize);
    const z = f32(rng.drand48() * globals.worldsize);
    this.initFoodAt(foodType, step, e, x, z);
  }

  /**
   * Native `food::initfood( ft, step, e, x, z )` (`food.cc:188-225`). `x`/`z` are already
   * `float`s in native (the parameter type narrows them), so the stores below are exact.
   */
  private initFoodAt(foodType: FoodType, step: number, e: Energy, x: number, z: number): void {
    this.foodType = foodType;
    this.energy = e;
    this.initlen();
    this.position[0] = f32(x);
    this.position[1] = f32(0.5 * this.length[1]!);
    this.position[2] = f32(z);

    // `initrest()`: type, type number (counting every food ever), colour from the food type.
    this.setType(GObjectType.FOOD);
    this.setTypeNumber(++Food.fFoodEver);
    this.setcolor(foodType.color);

    this.creationStep = step;
    if (step >= 0) {
      this.allFoodNode = Food.gAllFood.pushBack(this);
    } else {
      // Native locates the first food with a *greater* creation step and inserts before it;
      // falling off the end appends.
      let n = Food.gAllFood.head;
      while (n !== null && !(n.food.creationStep > step)) n = n.next;
      this.allFoodNode = n === null ? Food.gAllFood.pushBack(this) : Food.gAllFood.insertBefore(this, n);
    }
  }

  /** Native `food::~food()` — asserts the stored position, then erases. */
  destroy(): void {
    if (this.allFoodNode === null) throw new Error('food::destroy: this food is not in gAllFood');
    Food.gAllFood.erase(this.allFoodNode);
    this.allFoodNode = null;
  }

  /** Native `food::dump( ostream & )` — `fEnergy` is `assert(false)`d out in native too. */
  dump(): string {
    return `${this.position[0]} ${this.position[1]} ${this.position[2]}\n`;
  }

  /** Native `food::load( istream & )` — position, then `initlen()`. */
  load(x: number, y: number, z: number): void {
    this.position[0] = f32(x);
    this.position[1] = f32(y);
    this.position[2] = f32(z);
    this.initlen();
  }

  /**
   * Native `food::eat( const Energy &e )` — take at most `fEnergy`, subtract, re-size.
   * `actual.constrain( 0, fEnergy )` clamps per component, so a request larger than what is
   * left yields what is left.
   */
  eat(e: Energy): Energy {
    const actual = e.clone();
    actual.constrain(new Energy(0), this.energy);
    this.energy.subAssign(actual);
    this.initlen();
    return actual;
  }

  /** Native `food::isDepleted()` — tested against the *food type's* depletion threshold. */
  isDepleted(): boolean {
    return this.energy.isDepleted(this.foodTypeOf().depletionThreshold);
  }

  /** Native `food::getAge( long step )` — `long` arithmetic. */
  getAge(step: number): number {
    return step - this.creationStep;
  }

  getEnergy(): Energy {
    return this.energy;
  }
  getEnergyPolarity() {
    return this.foodTypeOf().energyPolarity;
  }
  getEatMultiplier() {
    return this.foodTypeOf().eatMultiplier;
  }
  /**
   * L8's `FoodLike` seam (`src/model/agent/contracts.ts`) names `getEnergyPolarity`/
   * `getEatMultiplier` without the `get`; both spellings are kept so the seam binds without an
   * adapter and the native names stay greppable. PORT-NOTE(L10/food-getter-aliases).
   */
  energyPolarity() {
    return this.foodTypeOf().energyPolarity;
  }
  eatMultiplier() {
    return this.foodTypeOf().eatMultiplier;
  }
  getType_(): FoodType {
    return this.foodTypeOf();
  }
  setPatch(fp: FoodPatch | null): void {
    this.patch = fp;
  }
  getPatch(): FoodPatch | null {
    return this.patch;
  }
  domain(): number {
    return this.fDomain;
  }
  setDomain(id: number): void {
    this.fDomain = id;
  }
  creationStepValue(): number {
    return this.creationStep;
  }

  /**
   * Native `food::initlen()` (`food.cc:228-233`): `float lxz = 0.75 * fEnergy.mean() /
   * gSize2Energy;` — `0.75` is a **double** literal, so the product and the division are
   * double and the store into `float lxz` narrows once.
   */
  private initlen(): void {
    const lxz = f32((0.75 * this.energy.mean()) / Food.gSize2Energy);
    this.setlen(lxz, Food.gFoodHeight, lxz);
  }

  /**
   * Native `food::setradius()` (`food.cc:213-220`) — the x/z-only radius. Overrides the
   * `gbox` deriver that `setlen` would otherwise reach.
   */
  protected override deriveRadius(): void {
    if (this.radiusFixed) return;
    const l0 = this.length[0]!;
    const l2 = this.length[2]!;
    // PORT-NOTE(L10/fma-contraction): `food::setradius` (0x5aa7c-0x5aa84) is
    //
    //   5aa7c:  ldr    s1, [x0, #0x90]     ; fLength[2]
    //   5aa80:  fmul   s1, s1, s1          ; f32(fLength[2]*fLength[2]) — ROUNDED
    //   5aa84:  fmadd  s0, s0, s0, s1      ; fLength[0]*fLength[0] + that, ONE rounding
    //
    // so the operand the binary rounds is the **second** square and `fLength[0]`'s square
    // stays exact. The previous form rounded *both* squares (`f32(l0*l0)` first) — the
    // unfused semantics, which disagrees with the shipped binary on **6 741 of 200 000**
    // `l2` values (3.4 %, `l0 = 0.09f`, `l2` on a 1/200 000 grid in `[0.05, 0.051]`), e.g.
    // `l0 = 0x3db851ec`, `l2 = 0x3d4cd20b`: fused `0x3c2dadb9` vs rounded `0x3c2dadb8`.
    // Pinned in `tests/fma-contraction-sweep.test.ts`. The sum and the tail are lane L15's
    // (`primitives.ts`'s `contractedSquareSumXZ`/`scaledRadius`, one definition shared with
    // `gpoly`/`gpolyobj`/`gbox`/`agent`); this override only chooses the x/z pair.
    this.fRadius = scaledRadius(contractedSquareSumXZ(l0, l2), this.radiusScale, this.scale);
  }

  private foodTypeOf(): FoodType {
    if (this.foodType === null) throw new Error('food: no food type (constructed without one)');
    return this.foodType;
  }
}

/** Test hook: clear the process-wide list (native's global never resets). */
export function resetFoodList(): void {
  Food.gAllFood.clear();
}
