/**
 * Lane L5 (genome) — `genome/Gene.{h,cc}`: the gene base class, the interpolation
 * machinery and the scalar gene types.
 *
 * Every semantic choice that is not a literal transcription carries a `PORT-NOTE`.
 *
 * PORT-NOTE(genome/flattened-diamonds): native builds its gene types with multiple
 * inheritance (`MutableScalarGene : NonVectorGene, __InterpolatedGene`;
 * `MutableNeurGroupGene : NeurGroupGene, __InterpolatedGene`), which TypeScript has no
 * equivalent for. The port *flattens* the diamonds into `Gene`: the interpolation state and
 * `interpolate()`/`getMin()`/`getMax()`/`setInterpolationPower()` live on the base, and a
 * gene opts in with `initInterpolated()` (native: the `__InterpolatedGene` constructor).
 * `NonVectorGene` keeps native's `getMutableSizeImpl() == sizeof(unsigned char) == 1`.
 * Observable behaviour is unchanged; the class graph is not.
 *
 * PORT-NOTE(genome/interpolation-arithmetic): `interpolate( raw )` reproduces the C
 * expression exactly, including its types:
 *   `double ratio = float(raw) * OneOver255;` — in C both operands are `float`, so this is a
 *   **float × float** multiply: the product is rounded to f32 and only then widened into the
 *   `double ratio`. Computing it in f64 (`fround(raw) * ONE_OVER_255`) and never rounding the
 *   product back is a *different value*: measured on the recorded schema, 540 of the 4,864
 *   `(gene, raw)` pairs differ from the native build in the resulting f32 (see
 *   `tests/genome.test.ts` → interpolated engines);
 *   `ratio = pow(ratio, interpolationPower)` only when the power is not 1.0 (the default,
 *   and the only value any oracle worldfile sets — a worldfile that overrides
 *   `GeneInterpolationPower` now gets lane L1's transcribed `pow`: the oracle's
 *   `__InterpolatedGene::interpolate(unsigned char)` calls `_pow` with **both operands
 *   double** (`bl _pow` @0x6ab48), so this is a `_pow` site and no longer drifted; the site
 *   is still unreachable in the recorded scenarios. See PARITY.md → Gaps);
 *   `interp(x, ylo, yhi) = (ylo) + (x)*((yhi)-(ylo))`, also with the macro's operand types:
 *   in the FLOAT case `(yhi)-(ylo)` is a **float − float** subtraction (f32-rounded) before
 *   the double multiply, while in the INT cases it is integer arithmetic (exact); the
 *   multiply/add themselves are always double;
 *   `nint(a) = (long)( a + (a < 0 ? -0.499999999 : 0.499999999) )` (truncation *toward
 *   zero* of the shifted value, not `round`);
 *   `ROUND_INT_FLOOR` is `(int)` — truncation toward zero, **not** `floor`;
 *   `ROUND_INT_BIN` is `min( (int)interp(ratio, smin, smax + 1), smax )`;
 *   the FLOAT case is `(float)interp(...)`, i.e. rounded to f32 (`Scalar.float`, which is
 *   itself `Math.fround`).
 *
 * PORT-NOTE(genome/print-ranges): native dispatches `printRanges` on the *class*
 * (`Gene::printRanges` prints a title line and skips immutable genes; `__InterpolatedGene::
 * printRanges` always prints `<rounding> <min> <max> <prefix><name>`). Because the diamonds
 * are flattened, the flattened `Gene::printRanges` checks the `interpolated` flag first —
 * that flag is exactly "this gene is an `__InterpolatedGene`", so the two behaviours are
 * still selected by the same property the native vtable would.
 */

import { Scalar, nint } from './values';
import { GeneType, assertNever, type AnyGeneType } from './vocabulary';
import { pow } from '../rng';

// ================================================================================
// === Interpolation
// ================================================================================

/** Native `__InterpolatedGene::Rounding`. */
export const Rounding = {
  NONE: 0,
  INT_FLOOR: 1,
  INT_NEAREST: 2,
  INT_BIN: 3,
} as const;

export type Rounding = (typeof Rounding)[keyof typeof Rounding];

/** Native `roundingNames[]` in `__InterpolatedGene::printRanges`. */
const ROUNDING_NAMES = ['None', 'IntFloor', 'IntNearest', 'IntBin'] as const;

/** Native `interp(x, ylo, yhi)` (`utils/misc.h`) — a macro, so `ylo`/`yhi` keep their type. */
function interp(x: number, ylo: number, yhi: number): number {
  return ylo + x * (yhi - ylo);
}

/**
 * The same macro for the FLOAT case, where native passes `float(smin)`/`float(smax)`: the
 * operand types make `(yhi) - (ylo)` a **float − float** subtraction, so it is rounded to
 * f32 before the (double) multiply — `ylo + x * d` is then evaluated in double, in that
 * order. Folding the two roundings of `interp` into one is what the original port did and
 * why it disagreed with the native build on 540 of 4,864 `(gene, raw)` pairs.
 */
function interpFloat(x: number, ylo: number, yhi: number): number {
  return ylo + x * Math.fround(yhi - ylo);
}

/** The native `1./255` constant is stored in a `static const float`. */
const ONE_OVER_255 = Math.fround(1.0 / 255.0);

// ================================================================================
// === Gene
// ================================================================================

/**
 * Native `Gene` (`genome/Gene.h`), with the two `__InterpolatedGene`/`__ConstantGene`
 * diamond bases flattened in (see the PORT-NOTE above).
 */
export abstract class Gene {
  /** Native `Gene::type` — which `GeneType` token this gene carries. */
  type: AnyGeneType = GeneType.SCALAR;
  /** Native `Gene::name`. */
  name = '';
  /** Native `Gene::ismutable`. */
  ismutable = false;
  /** Native `Gene::offset` — assigned by `GeneSchema::getMutableSize()`, `-1` when immutable. */
  offset = -1;

  /** True when this gene is one of native's `__InterpolatedGene` subclasses. */
  protected interpolated = false;
  private smin: Scalar = Scalar.int(0);
  private smax: Scalar = Scalar.int(0);
  private rounding: Rounding = Rounding.NONE;
  private interpolationPower = 1.0;

  /** Native `__ConstantGene::value` (flattened; set by `initConstant`). */
  private constantValue: Scalar | null = null;

  /** Native `Gene::init`. */
  protected init(type: AnyGeneType, ismutable: boolean, name: string): void {
    this.type = type;
    this.ismutable = ismutable;
    this.name = name;
    this.offset = -1;
  }

  /**
   * Native `__ConstantGene`'s constructor role: an immutable gene whose value is fixed.
   * (`ImmutableScalarGene` and `ImmutableNeurGroupGene`.)
   */
  protected initConstant(type: AnyGeneType, name: string, value: Scalar): void {
    this.init(type, false, name);
    this.constantValue = value;
  }

  /** Native `__ConstantGene::get()`. */
  getConstant(): Scalar {
    if (this.constantValue === null) throw new Error(`${this.name}: not a constant gene`);
    return this.constantValue;
  }

  /** Native `__InterpolatedGene`'s constructor role. */
  protected initInterpolated(
    type: AnyGeneType,
    ismutable: boolean,
    name: string,
    min: Scalar,
    max: Scalar,
    rounding: Rounding,
  ): void {
    this.init(type, ismutable, name);
    this.smin = min;
    this.smax = max;
    this.rounding = rounding;
    this.interpolationPower = 1.0;
    this.interpolated = true;

    // Native: assert( smin.type == smax.type ).
    if (min.kind !== max.kind) {
      throw new Error(`${name}: interpolation range type mismatch (${min.kind} vs ${max.kind})`);
    }
  }

  /** True when this gene is one of the flattened `__InterpolatedGene` types. */
  isInterpolated(): boolean {
    return this.interpolated;
  }

  /** Native `__InterpolatedGene::getMin()`. */
  getMin(): Scalar {
    return this.smin;
  }

  /** Native `__InterpolatedGene::getMax()`. */
  getMax(): Scalar {
    return this.smax;
  }

  /** Native `__InterpolatedGene::setInterpolationPower`. */
  setInterpolationPower(power: number): void {
    this.interpolationPower = power;
  }

  /** Native `__InterpolatedGene::interpolate( unsigned char raw )`. */
  interpolate(raw: number): Scalar {
    // `double ratio = float(raw) * OneOver255;` — "temporarily cast to double for backwards
    // compatibility": both operands are float, so the product is an f32 *before* it widens.
    let ratio = Math.fround(Math.fround(raw) * ONE_OVER_255);
    if (this.interpolationPower !== 1.0) ratio = pow(ratio, this.interpolationPower);
    return this.interpolateRatio(ratio);
  }

  /** Native `__InterpolatedGene::interpolate( double ratio )`. */
  interpolateRatio(ratio: number): Scalar {
    if (this.smin.kind === 'INT') {
      const lo = this.smin.asInt();
      const hi = this.smax.asInt();
      switch (this.rounding) {
        case Rounding.INT_FLOOR:
          return Scalar.int(Math.trunc(interp(ratio, lo, hi)));
        case Rounding.INT_NEAREST:
          return Scalar.int(nint(interp(ratio, lo, hi)));
        case Rounding.INT_BIN:
          return Scalar.int(Math.min(Math.trunc(interp(ratio, lo, hi + 1)), hi));
        default:
          return assertNever(`${this.name}: rounding`, this.rounding);
      }
    }
    if (this.smin.kind === 'FLOAT') {
      // `(float)interp( ratio, float(smin), float(smax) )` — see interpFloat.
      return Scalar.float(interpFloat(ratio, this.smin.asFloat(), this.smax.asFloat()));
    }
    return assertNever(`${this.name}: interpolation range type`, this.smin.kind);
  }

  /** Native `Gene::seed( genome, rawval )`. */
  seed(genome: { setRaw(offset: number, n: number, value: number): void }, rawval: number): void {
    if (!(this.ismutable && this.offset > -1)) {
      throw new Error(`${this.name}: seed of a non-mutable gene`);
    }
    genome.setRaw(this.offset, this.getMutableSize(), rawval);
  }

  /** Native `Gene::randomize( genome, rawval_min, rawval_max )`. */
  randomize(
    genome: { setRawRandom(offset: number, n: number, min: number, max: number): void },
    rawvalMin: number,
    rawvalMax: number,
  ): void {
    if (!(this.ismutable && this.offset > -1)) {
      throw new Error(`${this.name}: randomize of a non-mutable gene`);
    }
    genome.setRawRandom(this.offset, this.getMutableSize(), rawvalMin, rawvalMax);
  }

  /** Native `Gene::getMutableSize()`. */
  getMutableSize(): number {
    return this.ismutable ? this.getMutableSizeImpl() : 0;
  }

  /** Native `Gene::getOffset()`. */
  getOffset(): number {
    return this.offset;
  }

  /** Native `Gene::getMutableSizeImpl()` — the base asserts; only mutable genes reach it. */
  protected getMutableSizeImpl(): number {
    throw new Error(`${this.name}: getMutableSizeImpl not implemented`);
  }

  /** Native `Gene::printIndexes` (a mutable gene that is not vector-like). */
  printIndexes(out: Output, prefix: string, layout: LayoutLike | null): void {
    if (!this.ismutable) return;
    let index = this.offset;
    if (layout) index = layout.getMutableDataOffset(index);
    out.write(`${index}\t${prefix}${this.name}\n`);
  }

  /** Native `Gene::printTitles`. */
  printTitles(out: Output, prefix: string): void {
    if (!this.ismutable) return;
    out.write(`${prefix}${this.name} :: ${prefix}${this.name}\n`);
  }

  /** Native `Gene::printRanges` / `__InterpolatedGene::printRanges` (see PORT-NOTE). */
  printRanges(out: Output, prefix: string): void {
    if (this.interpolated) {
      const roundingName =
        this.smin.kind === 'INT'
          ? (ROUNDING_NAMES[this.rounding] ?? 'None')
          : ROUNDING_NAMES[Rounding.NONE];
      out.write(`${roundingName} ${this.smin.str()} ${this.smax.str()} ${prefix}${this.name}\n`);
      return;
    }

    if (!this.ismutable) return;
    out.write(`${prefix}${this.name} :: ${prefix}${this.name}\n`);
  }
}

/** Anything the genome printers write to (`FILE *` in native). */
export interface Output {
  write(text: string): void;
}

/** Native `GenomeLayout` as the printers see it. */
export interface LayoutLike {
  getMutableDataOffset(geneOffset: number): number;
}

// ================================================================================
// === NonVectorGene
// ================================================================================

/** Native `NonVectorGene`: a gene that holds a single value and occupies one byte. */
export abstract class NonVectorGene extends Gene {
  /** Native `NonVectorGene::get( Genome * )`. */
  abstract get(genome: object): Scalar;

  protected override getMutableSizeImpl(): number {
    return 1; // sizeof( unsigned char )
  }
}

// ================================================================================
// === ImmutableScalarGene / MutableScalarGene / ImmutableInterpolatedGene
// ================================================================================

/** Native `ImmutableScalarGene`: a public constant. */
export class ImmutableScalarGene extends NonVectorGene {
  constructor(name: string, value: Scalar) {
    super();
    this.initConstant(GeneType.SCALAR, name, value);
  }

  override get(_genome: object): Scalar {
    return this.getConstant();
  }
}

/** Native `MutableScalarGene`: one mutable byte interpolated over a range. */
export class MutableScalarGene extends NonVectorGene {
  constructor(name: string, min: Scalar, max: Scalar, rounding: Rounding) {
    super();
    this.initInterpolated(GeneType.SCALAR, true, name, min, max, rounding);
  }

  override get(genome: { getRaw(offset: number): number }): Scalar {
    return this.interpolate(genome.getRaw(this.offset));
  }
}

/**
 * Native `ImmutableInterpolatedGene`: the raw value comes from outside the genome, so the
 * gene is immutable and never occupies mutable data (only `BitProbability` is one).
 */
export class ImmutableInterpolatedGene extends Gene {
  constructor(name: string, min: Scalar, max: Scalar, rounding: Rounding) {
    super();
    this.initInterpolated(GeneType.SCALAR, false, name, min, max, rounding);
  }
}

// ================================================================================
// === Casts (native `GeneType::to_*`)
// ================================================================================

/**
 * Native `GeneType::to_T( Gene *gene )`: NULL in, NULL out; a failed `dynamic_cast` is an
 * `assert`. The port throws instead of returning a wrong object — never a silent default.
 */
export function toNonVector(gene: Gene | null | undefined): NonVectorGene | null {
  if (!gene) return null;
  if (!(gene instanceof NonVectorGene)) {
    throw new Error(`GeneType::to_NonVector: ${gene.name} is not a NonVectorGene`);
  }
  return gene;
}

/** Native `GeneType::to_ImmutableScalar`. */
export function toImmutableScalar(gene: Gene | null | undefined): ImmutableScalarGene {
  if (!(gene instanceof ImmutableScalarGene)) {
    throw new Error(`GeneType::to_ImmutableScalar: ${gene?.name ?? 'null'} is not one`);
  }
  return gene;
}

/** Native `GeneType::to_MutableScalar`. */
export function toMutableScalar(gene: Gene | null | undefined): MutableScalarGene {
  if (!(gene instanceof MutableScalarGene)) {
    throw new Error(`GeneType::to_MutableScalar: ${gene?.name ?? 'null'} is not one`);
  }
  return gene;
}

/** Native `GeneType::to_ImmutableInterpolated`. */
export function toImmutableInterpolated(gene: Gene | null | undefined): ImmutableInterpolatedGene {
  if (!(gene instanceof ImmutableInterpolatedGene)) {
    throw new Error(`GeneType::to_ImmutableInterpolated: ${gene?.name ?? 'null'} is not one`);
  }
  return gene;
}

/** Native `GeneType::to___Interpolated` — any gene that carries an interpolation range. */
export function toInterpolated(gene: Gene | null | undefined): Gene {
  if (!gene || !gene.isInterpolated()) {
    throw new Error(`GeneType::to___Interpolated: ${gene?.name ?? 'null'} is not interpolated`);
  }
  return gene;
}
