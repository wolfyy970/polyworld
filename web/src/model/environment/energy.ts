/**
 * Lane L10 — native `environment/Energy.{h,cc}`: the energy vector, at home.
 *
 * PORT-NOTE(L8/energy-home): this module used to be `src/model/agent/energy.ts`. Lane L8 carried
 * the definition there because the agent core cannot be expressed without it (`eat`, `damage`,
 * `receive`, `mating`, `UpdateBody`, `grow`) and this directory did not exist when L8 landed —
 * its own PORT-NOTE(`L8/energy-home`) and L10's PORT-NOTE(`L10/energy-temporary-home`) both asked
 * for the module to be **moved** here once both lanes were quiescent, and PARITY.md → Gaps
 * tracked it as "one hop". This is that hop: the body moved whole, `src/model/agent/energy.ts`
 * is **gone** (not left as a re-export), and the agent lane's importers point at this file, so
 * `grep -rn '^export class Energy\b' src` is exactly one line. The alternative failure mode —
 * two definitions — silently changes every recorded energy log, which is why the acceptance for
 * the move is `run/energy/**` still byte-identical on the six recorded scenarios, not "it
 * compiles".
 *
 * `MAX_ENERGY_TYPES` (`Energy.h`) and `ENERGY_EPSILON` (`Energy.cc`'s `#define EPSILON
 * 0.00001`) came with the body out of `agent/numeric.ts` for the same reason: they are this
 * module's symbols, and a second copy is the same class of defect as a second `Energy`.
 *
 * SEMANTICS THAT MATTER
 *
 *  - The vector has `MAX_ENERGY_TYPES` (4) slots but only the first `globals.numEnergyTypes`
 *    are ever read or written; native leaves the rest uninitialized, so *nothing* may read
 *    them (a port that iterated 4 would read a different garbage value than the native run).
 *  - Every slot is a `float`: all stores go through `f32` (PORT_SPEC ground rule 3).
 *  - `sum()` accumulates in `float` order 0..n-1 and `mean()` divides by `numEnergyTypes`
 *    (so a 0-length vector's mean is NaN, as native).
 *  - `operator*( Energy, EnergyMultiplier )` is not a plain multiply: a zero multiplier or
 *    one whose sign differs from the value's *passes the value through unchanged*.
 *  - `sign()` never returns 0 (`numeric.ts`), so the multiplier test above is a sign test,
 *    not a magnitude test.
 *  - `constrain(min, max, overflow)` records how far each component was out of range.
 */

import { globals } from '../types';
import { f32, sign } from '../agent/numeric';

/** Native `MAX_ENERGY_TYPES` (`environment/Energy.h`) — the storage width of an `Energy`. */
export const MAX_ENERGY_TYPES = 4;

/** Native `EPSILON` (`environment/Energy.cc`) — the `isZero`/multiplier-compare tolerance. */
export const ENERGY_EPSILON = 0.00001;

/** Native `EnergyPolarity::Polarity`. */
export const Polarity = {
  NEGATIVE: -1,
  POSITIVE: 1,
  UNDEFINED: 0,
} as const;

export type Polarity = (typeof Polarity)[keyof typeof Polarity];

/** Native `class EnergyPolarity` — one polarity per energy type. */
export class EnergyPolarity {
  readonly values: number[];

  /** Native `EnergyPolarity()` — every component POSITIVE. */
  constructor() {
    this.values = [];
    for (let i = 0; i < globals.numEnergyTypes; i++) this.values[i] = Polarity.POSITIVE;
  }

  /** Native `EnergyPolarity( proplib::Property & )` — an array of `-1`/`0`/`1`. */
  static fromNumbers(values: readonly number[]): EnergyPolarity {
    const result = new EnergyPolarity();
    for (let i = 0; i < globals.numEnergyTypes; i++) result.values[i] = Math.trunc(values[i] ?? 0);
    return result;
  }

  get(i: number): Polarity {
    return this.values[i] as Polarity;
  }

  /** Native `operator*( const EnergyPolarity & )` — component-wise multiply. */
  multiply(other: EnergyPolarity): EnergyPolarity {
    const result = new EnergyPolarity();
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      result.values[i] = Math.trunc(this.values[i]! * other.values[i]!);
    }
    return result;
  }

  /** Native `operator==`. */
  equals(other: EnergyPolarity): boolean {
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      if (this.values[i] !== other.values[i]) return false;
    }
    return true;
  }
}

/** Native `class EnergyMultiplier` — one float per energy type. */
export class EnergyMultiplier {
  readonly values: number[];

  /** Native `EnergyMultiplier()` — every component 1. */
  constructor() {
    this.values = [];
    for (let i = 0; i < globals.numEnergyTypes; i++) this.values[i] = 1;
  }

  /** Native `EnergyMultiplier( float *values )`. */
  static fromNumbers(values: readonly number[]): EnergyMultiplier {
    const result = new EnergyMultiplier();
    for (let i = 0; i < globals.numEnergyTypes; i++) result.values[i] = f32(values[i] ?? 0);
    return result;
  }

  get(i: number): number {
    return this.values[i]!;
  }
}

/** Native `operator==( const EnergyMultiplier &, const EnergyMultiplier & )` (EPSILON compare). */
export function energyMultiplierEquals(a: EnergyMultiplier, b: EnergyMultiplier): boolean {
  for (let i = 0; i < globals.numEnergyTypes; i++) {
    if (Math.abs(a.get(i) - b.get(i)) > ENERGY_EPSILON) return false;
  }
  return true;
}

/** Native `class Energy` — `float values[ MAX_ENERGY_TYPES ]`. */
export class Energy {
  /** The 4 slots. Only `[0, globals.numEnergyTypes)` is meaningful (see the header note). */
  readonly values: number[];

  /** Native `Energy()` / `Energy( float val )` — `init(val)`. */
  constructor(value = 0.0) {
    this.values = [];
    for (let i = 0; i < globals.numEnergyTypes; i++) this.values[i] = f32(value);
  }

  /**
   * Native `Energy( const Energy &positive, const Energy &negative, const EnergyPolarity & )`:
   * NEGATIVE picks from `negative`, everything else (POSITIVE **and UNDEFINED**) picks from
   * `positive`.
   */
  static fromPolarity(positive: Energy, negative: Energy, polarity: EnergyPolarity): Energy {
    const result = new Energy();
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      result.values[i] = f32(
        polarity.get(i) === Polarity.NEGATIVE ? negative.values[i]! : positive.values[i]!,
      );
    }
    return result;
  }

  /** Native `Energy( proplib::Property & )` — an array of floats. */
  static fromNumbers(values: readonly number[]): Energy {
    const result = new Energy();
    for (let i = 0; i < globals.numEnergyTypes; i++) result.values[i] = f32(values[i] ?? 0);
    return result;
  }

  /** Component read (native `operator[]`). */
  get(index: number): number {
    return this.values[index]!;
  }

  /** Component write, as a native `values[i] = ...` inside the class. */
  set(index: number, value: number): void {
    this.values[index] = f32(value);
  }

  clone(): Energy {
    const result = new Energy();
    for (let i = 0; i < globals.numEnergyTypes; i++) result.values[i] = this.values[i]!;
    return result;
  }

  /** Native `isZero()` — every component within +-EPSILON. */
  isZero(): boolean {
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      const v = this.values[i]!;
      if (v < -ENERGY_EPSILON || v > ENERGY_EPSILON) return false;
    }
    return true;
  }

  /** Native `isDepleted( const Energy &threshold )` — `<=` on any component. */
  isDepleted(threshold: Energy): boolean {
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      if (this.values[i]! <= threshold.values[i]!) return true;
    }
    return false;
  }

  /** Native `isDepleted()` — the same test against the scalar EPSILON threshold. */
  isDepletedDefault(): boolean {
    return this.isDepleted(Energy.single(ENERGY_EPSILON));
  }

  /** `Energy( val )` for a scalar threshold (helper around the single-value constructor). */
  static single(value: number): Energy {
    return new Energy(value);
  }

  /** Native `sum()` — float accumulation in slot order. */
  sum(): number {
    let result = 0;
    for (let i = 0; i < globals.numEnergyTypes; i++) result = f32(result + this.values[i]!);
    return result;
  }

  /** Native `mean()` — `sum() / globals::numEnergyTypes` (NaN for 0 types, as native). */
  mean(): number {
    return f32(this.sum() / globals.numEnergyTypes);
  }

  /** Native `zero()`. */
  zero(): void {
    for (let i = 0; i < globals.numEnergyTypes; i++) this.values[i] = 0.0;
  }

  /** Native `constrain( const Energy &minEnergy, const Energy &maxEnergy )`. */
  constrain(minEnergy: Energy, maxEnergy: Energy): void {
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      const v = this.values[i]!;
      if (v < minEnergy.values[i]!) this.values[i] = minEnergy.values[i]!;
      else if (v > maxEnergy.values[i]!) this.values[i] = maxEnergy.values[i]!;
    }
  }

  /**
   * Native `constrain( min, max, Energy &result_overflow )`: clamps in place and reports,
   * per component, how far the value was outside the range (0 when it was inside).
   */
  constrainOverflow(minEnergy: Energy, maxEnergy: Energy): Energy {
    const overflow = new Energy();
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      let diff = f32(this.values[i]! - minEnergy.values[i]!);
      if (diff < 0) {
        overflow.values[i] = diff;
        this.values[i] = minEnergy.values[i]!;
      } else {
        diff = f32(this.values[i]! - maxEnergy.values[i]!);
        if (diff > 0) {
          overflow.values[i] = diff;
          this.values[i] = maxEnergy.values[i]!;
        }
      }
    }
    return overflow;
  }

  /** Native `createDepletionThreshold( threshold, polarity )` — UNDEFINED becomes NaN. */
  static createDepletionThreshold(threshold: Energy, polarity: EnergyPolarity): Energy {
    const result = threshold.clone();
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      if (polarity.get(i) === Polarity.UNDEFINED) result.values[i] = NaN;
    }
    return result;
  }

  /** Native `operator+=`. */
  addAssign(other: Energy): void {
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      this.values[i] = f32(this.values[i]! + other.values[i]!);
    }
  }

  /** Native `operator-=`. */
  subAssign(other: Energy): void {
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      this.values[i] = f32(this.values[i]! - other.values[i]!);
    }
  }

  /** Native `operator*( const Energy &, float )`. */
  mulScalar(value: number): Energy {
    const result = new Energy();
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      result.values[i] = f32(this.values[i]! * value);
    }
    return result;
  }

  /** Native `operator*( const Energy &, const EnergyPolarity & )`. */
  mulPolarity(polarity: EnergyPolarity): Energy {
    const result = new Energy();
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      result.values[i] = f32(this.values[i]! * polarity.get(i));
    }
    return result;
  }

  /**
   * Native `operator*( const Energy &, const EnergyMultiplier & )`: a component whose
   * multiplier is 0, or whose sign differs from the value's, is passed through unchanged.
   */
  mulMultiplier(multiplier: EnergyMultiplier): Energy {
    const result = new Energy();
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      const m = multiplier.get(i);
      const v = this.values[i]!;
      result.values[i] = m !== 0 && sign(m) === sign(v) ? f32(v * Math.abs(m)) : v;
    }
    return result;
  }
}

/** Native `operator+( const Energy &a, const Energy &b )`. */
export function energyAdd(a: Energy, b: Energy): Energy {
  const result = new Energy();
  for (let i = 0; i < globals.numEnergyTypes; i++) {
    result.values[i] = f32(a.values[i]! + b.values[i]!);
  }
  return result;
}

/** Native `operator-( const Energy &a, const Energy &b )`. */
export function energySub(a: Energy, b: Energy): Energy {
  const result = new Energy();
  for (let i = 0; i < globals.numEnergyTypes; i++) {
    result.values[i] = f32(a.values[i]! - b.values[i]!);
  }
  return result;
}

/** Native `operator*( const Energy &e, const EnergyPolarity &p )` (`e * p`). */
export function energyMulPolarity(e: Energy, p: EnergyPolarity): Energy {
  return e.mulPolarity(p);
}

/** Native `operator*( const Energy &e, const EnergyMultiplier &m )`. */
export function energyMulMultiplier(e: Energy, m: EnergyMultiplier): Energy {
  return e.mulMultiplier(m);
}

/** Native `operator*( const Energy &e, const EnergyMultiplier &m )` (explicit name). */
export function energyMulScalar(e: Energy, value: number): Energy {
  return e.mulScalar(value);
}
