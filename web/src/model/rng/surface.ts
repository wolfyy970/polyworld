/**
 * Lane W1d — the RNG surface the model actually calls, assembled behind
 * `src/model/types/rng.ts`'s frozen interfaces.
 *
 * PORT-NOTE(W1d/rng-surface-assembly): the native side keeps three *process-global* C
 * objects — the `rand`/`srand` state, the `drand48`/`srand48` state, and `nrand()`'s static
 * spare — and per-instance GSL state for `RandomNumberGenerator::LOCAL`. The port mirrors
 * exactly that: `createRngSurface()` is one stream set (use it for a test or for a second,
 * independent simulation), and `globalRngSurface()` is the shared instance that ports of the
 * native code (`graphics/gobject.cc`'s colours, `complexity`'s `srand`, agent energy's
 * `nrand`, genome mutation's `rrand`) must all reach for. Creating a second instance per call
 * site would change the draw *order*, which is part of the contract.
 *
 * `rand()` and `drand48()` are deliberately separate: `randpw()` is `drand48()`, while
 * graphics/complexity call `rand()`. See the PORT-NOTE in `rand.ts` for why `rand()` here is
 * Park–Miller and not glibc's TYPE_3 alias of `random()`.
 */

import { RngType, type Mt19937Stream, type RngRole, type RngSurface } from '../types/rng';
import { Drand48 } from './drand48';
import { LibcRand } from './rand';
import { Mt19937 } from './mt19937';
import { NRand } from './nrand';

/** One set of streams: C `rand`, C `drand48`, and the shared `nrand()` spare. */
export function createRngSurface(): RngSurface {
  const libc = new LibcRand();
  const dr = new Drand48();
  const normal = new NRand(() => dr.drand48());
  return {
    srand: (seed: number) => libc.srand(seed),
    rand: () => libc.rand(),
    srand48: (seed: number) => dr.srand48(seed),
    drand48: () => dr.drand48(),
    lrand48: () => dr.lrand48(),
    nrand: () => normal.nrand(),
    nrandScaled: (mean: number, stdev: number) => normal.nrandScaled(mean, stdev),
  };
}

let global: RngSurface | undefined;

/**
 * The process-wide RNG surface — the port's equivalent of the C globals. Lanes porting native
 * code that calls `randpw()`, `rrand()`, `nrand()` or `rand()` directly must use this, not a
 * fresh surface, so draw order matches.
 */
export function globalRngSurface(): RngSurface {
  if (global === undefined) global = createRngSurface();
  return global;
}

/** Test hook: forget the shared surface (the C globals are never reset either). */
export function resetGlobalRngSurface(): void {
  global = undefined;
}

/**
 * A GSL `gsl_rng_mt19937` stream (native `RandomNumberGenerator`'s LOCAL state).
 * GSL's `gsl_rng_alloc` leaves the MT19937 state as if seeded with 0, i.e. GSL's default
 * seed 4357 (`Mt19937` does the same when constructed without a seed).
 */
export function createMt19937Stream(seed?: number): Mt19937Stream {
  return new Mt19937(seed);
}

/**
 * Lane W1d — a port of native `RandomNumberGenerator` (`utils/RandomNumberGenerator.{h,cc}`).
 *
 * PORT-NOTE(W1d/random-number-generator): the native class is a thin front end that routes to
 * either the global C streams (`GLOBAL`) or one `gsl_rng_mt19937` (`LOCAL`), selected per
 * `Role` by the static `types[]` table — set from the worldfile's `StaticTimestepGeometry`
 * path. `seed()` seeds `srand48` for GLOBAL and `gsl_rng_set` for LOCAL; `seedIfLocal()` is
 * the identity for GLOBAL; `drand()` is `drand48()`/`gsl_rng_uniform`; `nrand()` is
 * `::nrand()`/`gsl_ran_ugaussian`; `range( lo, hi )` is `interp( drand(), lo, hi )`. Porting
 * it here keeps L5/L6 (genome, brain) from each re-inventing the routing.
 */
export class RandomNumberGenerator {
  private static readonly types: RngType[] = [RngType.GLOBAL, RngType.GLOBAL, RngType.GLOBAL];
  private readonly local: Mt19937 | null;

  private constructor(
    private readonly type: RngType,
    private readonly shared: RngSurface,
  ) {
    this.local = type === RngType.LOCAL ? new Mt19937() : null;
  }

  /** Native `RandomNumberGenerator::set( role, type )`. */
  static set(role: RngRole, type: RngType): void {
    RandomNumberGenerator.types[role] = type;
  }

  /** Native `RandomNumberGenerator::create( role )`. */
  static create(role: RngRole, shared: RngSurface = globalRngSurface()): RandomNumberGenerator {
    return new RandomNumberGenerator(RandomNumberGenerator.types[role]!, shared);
  }

  /** Native `RandomNumberGenerator::dispose` — garbage collection does the work here. */
  static dispose(_rng: RandomNumberGenerator): void {
    /* no-op */
  }

  /** Native `seed( long x )`. */
  seed(x: number): void {
    if (this.type === RngType.LOCAL) this.local!.set(x);
    else this.shared.srand48(x);
  }

  /** Native `seedIfLocal( long x )`. */
  seedIfLocal(x: number): void {
    if (this.type === RngType.LOCAL) this.seed(x);
  }

  /** Native `drand()`. */
  drand(): number {
    return this.type === RngType.LOCAL ? this.local!.uniform() : this.shared.drand48();
  }

  /** Native `nrand()`. */
  nrand(): number {
    return this.type === RngType.LOCAL ? this.local!.gaussian() : this.shared.nrand();
  }

  /** Native `range( lo, hi )` == `interp( drand(), lo, hi )`. */
  range(lo: number, hi: number): number {
    return lo + this.drand() * (hi - lo);
  }
}
