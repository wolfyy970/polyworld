/**
 * Lane W1d — the exact PRNG surface, as lanes import it.
 *
 *   import { globalRngSurface, log, RandomNumberGenerator } from '../rng';
 *
 * Everything here is verified against the native oracle: `tests/rng.test.ts` reproduces
 * `../polyworld/bin/rancheck`'s table byte-for-byte and checks ~200,000 captured
 * `log()` samples plus every stream's seed vectors. The frozen *types* stay in
 * `src/model/types/rng.ts` (owned by lane W1a); this module is the behaviour behind them.
 *
 * PORT-NOTE(W1d/w1a-doc-correction): `src/model/types/rng.ts` describes `rand()` as
 * "glibc rand() (TYPE_3 additive feedback)". On the machine the goldens were recorded on
 * (macOS 26.5.2 / Apple Libc) `rand()` is Park–Miller and `random()` is the TYPE_3 generator,
 * and `bin/rancheck` prints them as separate columns — implementing glibc's alias would move
 * every frozen artifact that calls `rand()` (`graphics/gobject.cc`,
 * `complexity/complexity_motion.cc`, `sim/Simulation.cc`'s `srand(1)`). This module follows
 * the oracle; see `rand.ts` and PARITY.md.
 */

export { RAND_MAX, LibcRand, BsdRandom } from './rand';
export { Drand48 } from './drand48';
export { Mt19937 } from './mt19937';
export { NRand } from './nrand';
export { exp, log, pow, powf } from './libm';
export {
  createRngSurface,
  globalRngSurface,
  resetGlobalRngSurface,
  createMt19937Stream,
  RandomNumberGenerator,
} from './surface';
export { LOG_POLY, LOG_TAB_INVC, LOG_TAB_LOGC_HI, LOG_TAB_LOGC_LO } from './appleLogTable';
