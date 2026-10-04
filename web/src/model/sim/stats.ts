/**
 * Lane L11 (sim) — `sim::Stat` and `sim::StatRecent` (native `sim/simtypes.h:333-389`).
 *
 * These are the run's running statistics: `lifespans.txt`'s mean/stddev/min/max come from
 * `fLifeSpanStats`, the status text's "LifeFractionRecent" from `fLifeFractionRecentStats`, and
 * the brain-count columns from three more.
 *
 * PORT-NOTE(sim/stat-float-detail): native stores `mn`/`mx` as `float` initialised to `FLT_MAX`
 * and **`FLT_MIN`** (the smallest *positive normal*, 1.17549435e-38 — not `-FLT_MAX`) and
 * accumulates into `double` `sum`/`sum2`. `mean()` and `stddev()` are `float`-returning but
 * computed in double, and `stddev()` takes the `sqrt` in double. All of that is reproduced
 * verbatim, including the `!count` special cases, because the values are written to log files.
 * PORT-NOTE(sim/stat-float-narrowing): the native declarations are `float mean()`, `float
 * stddev()`, `float min()`, `float max()` (`simtypes.h:340-343`, `:365-368`), so every returned
 * value is **narrowed to binary32** on the way out — `sum / count` is computed in double and then
 * rounded once. The port therefore applies `Math.fround` to the `mean()`/`stddev()` results
 * (`min`/`max` return the stored `float` samples, which `add` already narrowed). This is
 * model-visible: `TSimulation::LifeFractionRecent()` (`Simulation.h:583`) is `StatRecent::mean()`
 * and feeds lane L8's heuristic fitness, and the status text prints `nint( mean() )` /
 * `(unsigned long) min()`. Measured before this edit: `lifeFractionRecent()` returned the
 * un-narrowed double.
 * PORT-NOTE(sim/stat-recent-history-float): native `StatRecent::history` is a `float*`
 * (`simtypes.h:380`), so a stored sample is narrowed on *store* and it is the narrowed value the
 * roll-off arithmetic (`sum += v - history[index]`) reads back; the port keeps the same array as
 * `Float32Array` (it was `Float64Array`, which only agreed because every caller happened to
 * fround first).
 * PORT-NOTE(sim/stat-recent-window): `StatRecent` keeps the last `w` samples (default 1000) and
 * rolls off the oldest; `min`/`max` are the extrema **over the window**, recomputed lazily when
 * the evicted sample was an extremum.
 */

/** Native `<float.h>` `FLT_MAX` / `FLT_MIN` (the latter is the smallest positive normal). */
export const FLT_MAX = 3.4028234663852886e38;
export const FLT_MIN = 1.1754943508222875e-38;

/** Native `sim::Stat` (`simtypes.h:335-358`). */
export class Stat {
  /** Native `float mn, mx` — `FLT_MAX` / `FLT_MIN`. */
  private mn = FLT_MAX;
  private mx = FLT_MIN;
  /** Native `double sum, sum2`. */
  private sum = 0;
  private sum2 = 0;
  /** Native `unsigned long count`. */
  private count = 0;

  constructor() {
    this.reset();
  }

  mean(): number {
    if (!this.count) return 0.0;
    return Math.fround(this.sum / this.count);
  }

  stddev(): number {
    if (!this.count) return 0.0;
    const m = this.sum / this.count;
    return Math.fround(Math.sqrt(this.sum2 / this.count - m * m));
  }

  min(): number {
    if (!this.count) return 0.0;
    return this.mn;
  }

  max(): number {
    if (!this.count) return 0.0;
    return this.mx;
  }

  /** Native `Stat::add( float v )` — the caller passes a `float`. */
  add(v: number): void {
    this.sum += v;
    this.sum2 += v * v;
    this.count++;
    this.mn = v < this.mn ? v : this.mn;
    this.mx = v > this.mx ? v : this.mx;
  }

  reset(): void {
    this.mn = FLT_MAX;
    this.mx = FLT_MIN;
    this.sum = 0;
    this.sum2 = 0;
    this.count = 0;
  }

  samples(): number {
    return this.count;
  }
}

/** Native `sim::StatRecent` (`simtypes.h:360-388`). */
export class StatRecent {
  private mn = FLT_MAX;
  private mx = FLT_MIN;
  private sum = 0;
  private sum2 = 0;
  private count = 0;
  /** Native `unsigned int w` — the window width. */
  private readonly w: number;
  /** Native `float *history` — `w` recent samples (narrowed on store, see the file's PORT-NOTE). */
  private readonly history: Float32Array;
  /** Native `unsigned int index` — where the next sample goes. */
  private index = 0;
  private needMin = false;
  private needMax = false;

  constructor(width = 1000) {
    this.w = width;
    this.history = new Float32Array(width);
    this.reset();
  }

  mean(): number {
    if (!this.count) return 0.0;
    return Math.fround(this.sum / this.count);
  }

  stddev(): number {
    if (!this.count) return 0.0;
    const m = this.sum / this.count;
    return Math.fround(Math.sqrt(this.sum2 / this.count - m * m));
  }

  min(): number {
    if (!this.count) return 0.0;
    if (this.needMin) this.recomputeMin();
    return this.mn;
  }

  max(): number {
    if (!this.count) return 0.0;
    if (this.needMax) this.recomputeMax();
    return this.mx;
  }

  /**
   * Native `StatRecent::add( float v )`. The `history` slot receives the `float`; `v` itself is
   * the caller's `float` (the sim lane frounds before calling, as the native signature forces).
   */
  add(v: number): void {
    if (this.count < this.w) {
      this.sum += v;
      this.sum2 += v * v;
      this.mn = v < this.mn ? v : this.mn;
      this.mx = v > this.mx ? v : this.mx;
      this.history[this.index++] = v;
      this.count++;
      return;
    }

    if (this.index >= this.w) this.index = 0;
    const evicted = this.history[this.index]!;
    this.sum += v - evicted;
    this.sum2 += v * v - evicted * evicted;

    if (v >= this.mx) this.mx = v;
    else if (evicted === this.mx) this.needMax = true;

    if (v <= this.mn) this.mn = v;
    else if (evicted === this.mn) this.needMin = true;

    this.history[this.index++] = v;
  }

  reset(): void {
    this.mn = FLT_MAX;
    this.mx = FLT_MIN;
    this.sum = 0;
    this.sum2 = 0;
    this.count = 0;
    this.index = 0;
    this.needMin = false;
    this.needMax = false;
  }

  samples(): number {
    return this.count;
  }

  private recomputeMin(): void {
    this.mn = FLT_MAX;
    for (let i = 0; i < this.w; i++) this.mn = this.history[i]! < this.mn ? this.history[i]! : this.mn;
    this.needMin = false;
  }

  private recomputeMax(): void {
    this.mx = FLT_MIN;
    for (let i = 0; i < this.w; i++) this.mx = this.history[i]! > this.mx ? this.history[i]! : this.mx;
    this.needMax = false;
  }
}
