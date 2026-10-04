/**
 * Lane L10 — native `environment/Patch.{h,cc}`: the generic patch geometry that
 * `FoodPatch` and `BrickPatch` share, plus the two lane cuts it needs (`Domain`, `gstage`).
 *
 * `Patch::setPoint` is the only source of *positions* for newly grown food and for the bricks
 * a `BrickPatch` adds, so it is squarely in the frozen surface even though its result is an
 * RNG draw: the draw *count* per call differs by shape and distribution (the elliptical ones
 * re-draw until the point lands inside, the LINEAR/GAUSSIAN ones rejection-sample), and
 * `( x, z )` is then written straight into the object's `fPosition`.
 *
 * PORT-NOTE(L10/patch-float-order): every arithmetic step is native float. `randpw()` is a
 * **double** (`drand48`), so `startX + sizeX * randpw()` is evaluated in double and narrowed
 * once at the store into `*x`; the elliptical containment test is float throughout (its
 * operand `1.0` is a double literal promoted against a float sum, which does not change the
 * comparison). `PI` is `M_PI`, a double, so `getArea()`'s elliptical branch is double math
 * narrowed once on return.
 *
 * PORT-NOTE(L10/patch-fields-start-at-zero): native's `Patch()` default ctor is empty, so
 * until `initBase` runs every member is indeterminate. The port's fields start at 0 and
 * `initBase` is the only thing the model calls before reading them (`FoodPatch::init` /
 * `BrickPatch::init` both go through it), so no recorded value can observe the difference.
 */

import { globalRngSurface } from '../rng';
import { f32 } from '../geometry';
import { getLinear, getNormal } from './distributions';
import type { GoObject } from './object';

/** Native `Patch.h` shape constants. */
export const RECTANGULAR = 0;
export const ELLIPTICAL = 1;

/** Native `Patch.h` distribution constants. */
export const UNIFORM = 0;
export const LINEAR = 1;
export const GAUSSIAN = 2;

/** Native `M_PI` (`utils/misc.h:108`). */
const NATIVE_PI = Math.PI;

/**
 * `Patch::setPoint`'s four distribution parameters (`Patch.cc:78-81`), at native's own width:
 * the oracle declares them `float`, so these are the values it hands `getNormal`/`getLinear`.
 * Exported because a JS `0.3` in their place is a *different function* downstream and the only
 * place that can be caught is here — see PORT-NOTE(L10/patch-setpoint-literal-widths); pinned in
 * `tests/distributions-normalpdf.test.ts` and measured in `tools/measure_distributions_insitu.ts`.
 */
export const PATCH_GAUSS_SIGMA = f32(0.3); // 0x3e99999a
export const PATCH_GAUSS_MU = f32(0.5); // 0x3f000000
export const PATCH_LINEAR_SLOPE = f32(-0.4); // 0xbecccccd
export const PATCH_LINEAR_Y_INTERCEPT = f32(0.4); // 0x3ecccccd

/**
 * Lane cut: native `File src/library/sim/Domain.h` — the *parent* of every patch. Only four
 * of its fields are read by `Patch::initBase` (`startX`, `startZ`, `absoluteSizeX`,
 * `absoluteSizeZ`); the rest of `Domain` (agent counts, fittest lists, the patch arrays) is
 * lane L11's. PORT-NOTE(L10/domain-lane-cut).
 */
export interface DomainLike {
  readonly startX: number;
  readonly startZ: number;
  readonly absoluteSizeX: number;
  readonly absoluteSizeZ: number;
}

/**
 * Lane cut: native `graphics/gstage`'s two calls the environment makes — `AddObject` and
 * `RemoveObject`. `gstage` itself (lights, props, cameras, display lists, the whole GL scene)
 * is lane L15's and none of that is reachable from `FoodPatch::addFood` /
 * `BrickPatch::addBricks`. PORT-NOTE(L10/stage-lane-cut).
 */
export interface StageLike {
  addObject(obj: GoObject): void;
  removeObject(obj: GoObject): void;
}

/**
 * A `StageLike` that only records — for lane tests and for the probe's mirror.
 *
 * `objects` mirrors native's `TCastList` (`gstage::AddObject` pushes, `RemoveObject` erases
 * every element == the object, which is `std::list::remove`), because the stage's *size* is
 * one of the probe's pins.
 */
export class RecordingStage implements StageLike {
  readonly added: GoObject[] = [];
  readonly removed: GoObject[] = [];
  private readonly objects: GoObject[] = [];

  addObject(obj: GoObject): void {
    this.added.push(obj);
    this.objects.push(obj);
  }
  removeObject(obj: GoObject): void {
    this.removed.push(obj);
    for (let i = this.objects.length - 1; i >= 0; i--) {
      if (this.objects[i] === obj) this.objects.splice(i, 1);
    }
  }
  /** Native `TCastList::size()` — how many objects the stage currently holds. */
  size(): number {
    return this.objects.length;
  }
  /** Native's iteration order — the cast list, in insertion order. */
  contents(): readonly GoObject[] {
    return this.objects;
  }
}

/**
 * Native `class Patch` (`Patch.h:31-76`) — generic rectangle/ellipse area in a domain.
 *
 * The coordinates split is native's: `centerX`/`centerZ`/`sizeX`/`sizeZ` are *normalized*
 * (0..1 of the domain) inputs turned into absolute world coordinates by `initBase`;
 * `startX`/`endX`/`startZ`/`endZ` are the absolute corners; `pointIsInside`/`checkIfAgent*`
 * work in absolute coordinates.
 */
export class Patch {
  centerX = 0;
  centerZ = 0;
  startX = 0;
  startZ = 0;
  endX = 0;
  endZ = 0;
  sizeX = 0;
  sizeZ = 0;

  areaShape = RECTANGULAR;
  distribution = UNIFORM;

  agentInsideCount = 0;
  agentNeighborhoodCount = 0;

  neighborhoodSize = 0;

  readonly fStage: StageLike;
  domainNumberOfParent: number;

  constructor(stage: StageLike) {
    // Native's `Patch::Patch()` leaves every member indeterminate; the port starts clear and
    // `initBase` is the only writer before any read (PORT-NOTE above).
    this.fStage = stage;
    this.domainNumberOfParent = 0;
  }

  /** The stage this patch was built with (`fStage`), for `addFood`/`addBricks`. */
  stageRef(): StageLike {
    return this.fStage;
  }

  /**
   * Native `Patch::initBase` (`Patch.cc:25-49`).
   *
   * PORT-NOTE(L10/fma-contraction-in-initbase): `dm->startX + x * dm->absoluteSizeX` is one
   * multiply feeding an add, which the oracle binary's compiler contracts into a fused
   * multiply-add: the product is kept exact and the *sum* is rounded to `float` once. The port
   * writes exactly that (`f32(x * absoluteSizeX + startX)`, the product being exact in f64 for
   * `float` inputs) rather than rounding the product first — **measured** by reverting this
   * line alone: rounding the product first moves 8 golden values by one ulp, 7 of them from
   * `centerX` (`patch.ellipseGauss.centerX`/`.startX`/`.endX`/`.setPoint.{0..3}.x`) and 1 from
   * `centerZ` (`patch.recorded1.centerZ`). With the fused form, 0 of the probe's 1,909 pins
   * move.
   */
  initBase(
    x: number,
    z: number,
    sx: number,
    sz: number,
    shape: number,
    distrib: number,
    nhsize: number,
    domain: DomainLike,
    domainNumber: number,
  ): void {
    const fx = f32(x);
    const fz = f32(z);
    const fsx = f32(sx);
    const fsz = f32(sz);
    const dStartX = f32(domain.startX);
    const dStartZ = f32(domain.startZ);
    const dSizeX = f32(domain.absoluteSizeX);
    const dSizeZ = f32(domain.absoluteSizeZ);

    this.centerX = f32(fx * dSizeX + dStartX);
    this.centerZ = f32(fz * dSizeZ + dStartZ);

    this.sizeX = f32(fsx * dSizeX);
    this.sizeZ = f32(fsz * dSizeZ);

    this.startX = f32(this.centerX - this.sizeX * 0.5);
    this.endX = f32(this.startX + this.sizeX);

    this.startZ = f32(this.centerZ - this.sizeZ * 0.5);
    this.endZ = f32(this.startZ + this.sizeZ);

    this.areaShape = shape;
    this.distribution = distrib;

    this.neighborhoodSize = f32(nhsize);

    this.agentInsideCount = 0;
    this.agentNeighborhoodCount = 0;

    this.domainNumberOfParent = domainNumber;
  }

  /**
   * Native `Patch::setPoint( float *x, float *z )` (`Patch.cc:74-161`).
   *
   * PORT-NOTE(L10/patch-setpoint-draw-count): the re-draw loops are the model's draw-count
   * contract, not an implementation detail — an elliptical patch consumes 2 `randpw()` per
   * attempt and an out-of-ellipse attempt loops, and LINEAR/GAUSSIAN consume 2 per attempt
   * inside `getLinear`/`getNormal` plus 2 per containment failure. The port therefore keeps
   * native's structure (draw, test, repeat) rather than sampling differently. The four
   * distribution parameters it passes are native **`float`s**, and their width is part of the
   * contract — see PORT-NOTE(L10/patch-setpoint-literal-widths) below.
   *
   * PORT-NOTE(L10/patch-setpoint-literal-widths): the four distribution parameters native
   * declares here are **`float`s** (`Patch.cc:78-81`): `float sigma = .3; float mu = 0.5;
   * float slope = -0.4; float yIntercept = 0.4;` — so the oracle hands `getNormal`/`getLinear`
   * `0.3f` (`0x3e99999a`), `0.5f`, `-0.4f` (`0xbecccccd`) and `0.4f` (`0x3ecccccd`), never the
   * JS doubles `0.3`/`-0.4`/`0.4`. `normalPDF` widens its parameter with `fcvt d1, s1`
   * (0xfb78) and `linearPDF`'s else arm fuses binary32 operands (`fmadd s1, s1, s0, s2`
   * @0xfbdc), so the width is observable: measured against the shipped function
   * (`tools/measure_distributions_insitu.ts`, corpora `native/raw/normalpdf_insitu.tsv` and
   * `native/raw/linearpdf_insitu.tsv`, both dumped from `libpolyworld.dylib`), the doubles move
   * `left` on **10 000 / 10 000** rows (`0x3faa3723` vs the oracle's `0x3faa3722`), the
   * `normalPDF` return value on **9 456 / 10 000 (94.6 %)** and `linearPDF` on **7 991 /
   * 40 001 (20.0 %)** of `x`. The literals are therefore `f32(...)` here, as the binary has
   * them. They are not the only line of defence: the four functions also narrow their own
   * parameters, because native's signatures are `float` —
   * PORT-NOTE(L10/distributions-float-parameters) in `distributions.ts`. In situ the residue is
   * a draw-count risk, not a moved artifact: both recorded scenarios use `Distribution U`, and
   * on one deterministic 20 000-draw stream the doubles and the floats produced **0** differing
   * samples in `getNormal`/`getLinear`.
   */
  setPoint(randpw: () => number = () => globalRngSurface().drand48()): { x: number; z: number } {
    // Native's literals, verbatim — and at native's width (`float`, `Patch.cc:78-81`).
    const sigma = PATCH_GAUSS_SIGMA;
    const mu = PATCH_GAUSS_MU;
    const slope = PATCH_LINEAR_SLOPE;
    const yIntercept = PATCH_LINEAR_Y_INTERCEPT;

    let x = 0;
    let z = 0;

    if (this.areaShape === RECTANGULAR) {
      if (this.distribution === UNIFORM) {
        x = f32(this.startX + this.sizeX * randpw());
        z = f32(this.startZ + this.sizeZ * randpw());
      } else if (this.distribution === LINEAR) {
        x = f32(this.startX + this.sizeX * getLinear(slope, yIntercept, randpw));
        z = f32(this.startZ + this.sizeZ * getLinear(slope, yIntercept, randpw));
      } else if (this.distribution === GAUSSIAN) {
        x = f32(this.startX + this.sizeX * getNormal(sigma, mu, randpw));
        z = f32(this.startZ + this.sizeZ * getNormal(sigma, mu, randpw));
      }
    } else if (this.areaShape === ELLIPTICAL) {
      const a = f32(this.sizeX / 2.0);
      const b = f32(this.sizeZ / 2.0);
      // Native's containment test, on absolute coordinates — float per operation.
      const outside = (px: number, pz: number): boolean => {
        const dx = f32(px - this.centerX);
        const dz = f32(pz - this.centerZ);
        const termX = f32(f32(dx * dx) / f32(a * a));
        const termZ = f32(f32(dz * dz) / f32(b * b));
        return f32(termX + termZ) > 1.0;
      };
      if (this.distribution === UNIFORM) {
        do {
          x = f32(this.startX + this.sizeX * randpw());
          z = f32(this.startZ + this.sizeZ * randpw());
        } while (outside(x, z));
      } else if (this.distribution === LINEAR) {
        do {
          x = f32(this.startX + this.sizeX * getLinear(slope, yIntercept, randpw));
          z = f32(this.startZ + this.sizeZ * getLinear(slope, yIntercept, randpw));
        } while (outside(x, z));
      } else if (this.distribution === GAUSSIAN) {
        do {
          x = f32(this.startX + this.sizeX * getNormal(sigma, mu, randpw));
          z = f32(this.startZ + this.sizeZ * getNormal(sigma, mu, randpw));
        } while (outside(x, z));
      }
    } else {
      // Native prints and exits(1). The port throws a *ConfigError-free* Error: this is a
      // worldfile-shape value that already passed schema validation, so reaching it means the
      // caller invented a shape (same reasoning as W1a's "a config error is a throw").
      throw new Error(`Illegal patch shape: ${this.areaShape}`);
    }

    return { x, z };
  }

  /** Native `Patch::resetAgentCounts()`. */
  resetAgentCounts(): void {
    this.agentInsideCount = 0;
    this.agentNeighborhoodCount = 0;
  }

  /** Native `Patch::getArea()` (`Patch.cc:171-182`). */
  getArea(): number {
    // The rectangular branch is `sizeX * sizeZ` in float; the elliptical one is
    // `PI * (sizeX * 0.5) * (sizeZ * 0.5)` where `PI` is `M_PI` and `0.5` is a double literal,
    // so the whole expression is double and narrows **once** on the return (rounding the
    // intermediate product first moves the result by one ulp — measured).
    if (this.areaShape === RECTANGULAR) return f32(this.sizeX * this.sizeZ);
    return f32(NATIVE_PI * (this.sizeX * 0.5) * (this.sizeZ * 0.5));
  }

  /**
   * Native `Patch::pointIsInside( x, z, outerRange )` (`Patch.cc:187-211`). The parameters are
   * native `float`s, so the caller's values narrow on the way in.
   */
  pointIsInside(x: number, z: number, outerRange: number): boolean {
    const fx = f32(x);
    const fz = f32(z);
    const fr = f32(outerRange);
    if (this.areaShape === RECTANGULAR) {
      return (
        fx >= f32(this.startX - fr) &&
        fx <= f32(this.endX + fr) &&
        fz >= f32(this.startZ - fr) &&
        fz <= f32(this.endZ + fr)
      );
    }
    const a = f32(this.sizeX * 0.5 + fr);
    const b = f32(this.sizeZ * 0.5 + fr);
    const dx = f32(fx - this.centerX);
    const dz = f32(fz - this.centerZ);
    const termX = f32(f32(dx * dx) / f32(a * a));
    const termZ = f32(f32(dz * dz) / f32(b * b));
    return f32(termX + termZ) <= 1.0;
  }

  /** Native `Patch::checkIfAgentIsInside( agentX, agentZ )`. */
  checkIfAgentIsInside(agentX: number, agentZ: number): void {
    if (this.pointIsInside(agentX, agentZ, 0)) this.agentInsideCount++;
  }

  /** Native `Patch::checkIfAgentIsInsideNeighborhood( agentX, agentZ )`. */
  checkIfAgentIsInsideNeighborhood(agentX: number, agentZ: number): void {
    if (this.pointIsInside(agentX, agentZ, this.neighborhoodSize) && !this.pointIsInside(agentX, agentZ, 0)) {
      this.agentNeighborhoodCount++;
    }
  }
}
