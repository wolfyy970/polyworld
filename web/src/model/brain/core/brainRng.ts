/**
 * Lane L6 (brain core) — the RNG roles the brain wiring draws from.
 *
 * Native `utils/RandomNumberGenerator` gives three *roles* (`NERVOUS_SYSTEM`,
 * `TOPOLOGICAL_DISTORTION`, `INIT_WEIGHT`), each independently typed as `GLOBAL` (the shared
 * glibc streams — `drand48()` for `drand`, `nrand()` for `nrand`) or `LOCAL` (a private
 * MT19937). Which role is which is set in `GroupsBrain::init()`:
 *
 *     RandomNumberGenerator::set( TOPOLOGICAL_DISTORTION, LOCAL );
 *     RandomNumberGenerator::set( INIT_WEIGHT, LOCAL );
 *
 * and `NERVOUS_SYSTEM` is left at the module-init default, `GLOBAL`.
 *
 * PORT-NOTE(l6/rng-roles): the port keeps the distinction instead of collapsing it to "an
 * RNG", because the two paths draw *different sequences* — and the worldfile can flip
 * between them per connection (`EnableTopologicalDistortionRngSeed`,
 * `EnableInitWeightRngSeed`, both `False` in the recorded scenarios, in which case
 * `GroupsBrain::growSynapses` uses the nervous system's GLOBAL stream for both). A port that
 * always used the MT19937 stream (or always the glibc one) reproduces neither.
 *
 * `NervousSystem` only ever needs the GLOBAL surface (`RandomNumberGenerator::create(
 * NERVOUS_SYSTEM )`, whose `drand()` is `drand48()` and whose `nrand()` is the Marsaglia
 * polar normal over `drand48`), so it is injected an `RngSurface` (frozen in
 * `types/rng.ts`, implemented by lane W1d). Only `GroupsBrain` needs `createLocal`.
 */

import type { Mt19937Stream, RngRole, RngSurface } from '../../types';

/** Native `RandomNumberGenerator::create( role )` for a role that is set to `LOCAL`. */
export interface BrainRngProvider {
  /** The shared GLOBAL stream (`NERVOUS_SYSTEM`). */
  readonly global: RngSurface;
  /** A fresh, unseeded MT19937 stream — native `create()` on a `LOCAL` role. */
  createLocal(role: RngRole): Mt19937Stream;
}

/** A `BrainRngProvider` backed by an already-constructed surface plus an MT19937 factory. */
export class InjectedBrainRng implements BrainRngProvider {
  readonly global: RngSurface;
  private readonly factory: (role: RngRole) => Mt19937Stream;

  constructor(global: RngSurface, factory: (role: RngRole) => Mt19937Stream) {
    this.global = global;
    this.factory = factory;
  }

  createLocal(role: RngRole): Mt19937Stream {
    return this.factory(role);
  }
}
