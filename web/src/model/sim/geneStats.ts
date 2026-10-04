/**
 * Lane L11 (sim) — `GeneStats` (native `sim/GeneStats.{h,cc}`): the per-gene mean/stddev that
 * `run/genome/genestats.txt` logs (lane L12's `GeneStatsLog` reads `getMean()`/`getStddev()`).
 *
 * The native class snapshots the live agent list, then computes the sums in a `postParallel`
 * task — i.e. concurrently with the rest of the `Interact` master task, after which the master
 * task may kill and birth agents. That deferral is model-visible only through *which* agents were
 * sampled (the snapshot), not through the arithmetic, so the port reproduces the snapshot and
 * runs the accumulation in the posted-parallel phase (`PORT-NOTE(sched-deferral)`).
 *
 * PORT-NOTE(sim/genestats-threading): the native sums are `unsigned long` arrays and the mean /
 * stddev are `float`-returning expressions over `float` casts. The port keeps `Float64Array`
 * accumulators (exact for these magnitudes) and applies `Math.fround` at the same places native
 * casts, so the logged values are the native ones.
 */

import { genomeUtil } from '../genome';
import { f32, f32Fma } from '../agent/numeric';
import { asGenome } from './fittestList';
import type { Agent } from '../agent';
import type { Scheduler } from './scheduler';

/** Native `GeneStats` (`sim/GeneStats.h`). */
export class GeneStats {
  private maxAgents = 0;
  /** Native `agent **_agents` — the snapshot of the agents alive when `compute` ran. */
  private agents: Agent[] = [];
  private sum: Float64Array | null = null;
  private sum2: Float64Array | null = null;
  private nagents = 0;
  private mean: Float64Array | null = null;
  private stddev: Float64Array | null = null;

  /**
   * Native `GeneStats::init( long maxAgents )`. Native asserts a second call passes the same
   * `maxAgents`; the port does the same.
   */
  init(maxAgents: number): void {
    if (this.maxAgents !== 0) {
      if (this.maxAgents !== maxAgents) {
        throw new Error(`GeneStats::init: maxAgents changed (${this.maxAgents} -> ${maxAgents})`);
      }
      return;
    }

    this.maxAgents = maxAgents;
    this.agents = new Array(maxAgents).fill(null);

    const schema = genomeUtil.schema;
    if (schema === null) throw new Error('GeneStats::init: no genome schema (GenomeUtil::createSchema first)');
    const ngenes = schema.getMutableSize();
    this.sum = new Float64Array(ngenes);
    this.sum2 = new Float64Array(ngenes);
    this.mean = new Float64Array(ngenes);
    this.stddev = new Float64Array(ngenes);
    this.nagents = 0;
  }

  /** Native `GeneStats::getMean()`. */
  getMean(): Float64Array {
    if (this.mean === null) throw new Error('GeneStats::getMean: not initialized');
    return this.mean;
  }

  /** Native `GeneStats::getStddev()`. */
  getStddev(): Float64Array {
    if (this.stddev === null) throw new Error('GeneStats::getStddev: not initialized');
    return this.stddev;
  }

  /** Native `GeneStats::compute( Scheduler &scheduler )`. */
  compute(scheduler: Scheduler, snapshotAgents: readonly Agent[]): void {
    if (this.maxAgents === 0) return;

    // The snapshot: the agents alive right now, in x-sorted order (native walks
    // `gXSortedObjects` into `_agents`). The caller owns the walk because the list is lane L10's;
    // the count is native `getCount(AGENTTYPE)`.
    this.nagents = snapshotAgents.length;
    for (let i = 0; i < this.nagents; i++) this.agents[i] = snapshotAgents[i]!;

    scheduler.postParallel(() => this.computeStats());
  }

  private computeStats(): void {
    const nagents = this.nagents;
    const sum = this.sum!;
    const sum2 = this.sum2!;

    sum.fill(0);
    sum2.fill(0);

    for (let i = 0; i < nagents; i++) {
      asGenome(this.agents[i]!.genes()).updateSum(sum, sum2);
    }

    const mean = this.mean!;
    const stddev = this.stddev!;
    for (let i = 0; i < mean.length; i++) {
      // Native `GeneStats::compute`'s inlined loop (`libpolyworld.dylib`, 0x9e10c-0x9e134):
      //   ucvtf s1, sum[i] / fdiv s1, s1, s0        ; mean[i] = (float) sum[i] / (float) nagents
      //   ucvtf s2, sum2[i] / fdiv s2, s2, s0       ; float division
      //   fmsub s1, s1, s1, s2                      ; ONE rounding: s2 - mean * mean
      //   fsqrt s1, s1                              ; **float** sqrt
      // i.e. every step is single precision and the `- mean*mean` is a *fused* multiply-subtract.
      // The port computed `m` as a double quotient and left the subtraction and the sqrt in
      // double, which lands 1 ulp away on the printed `%.1f` (`minitest_voff` genestats.txt line
      // 115: golden `8.5,27.1` vs port `8.5,27.0` — the line was the run's last divergence).
      mean[i] = f32(f32(sum[i]!) / f32(nagents));
      const m = f32(f32(sum2[i]!) / f32(nagents));
      stddev[i] = f32(Math.sqrt(f32Fma(-f32(mean[i]!), f32(mean[i]!), m)));
    }
  }
}
