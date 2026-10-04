/**
 * Lane L14 — the chart monitors (`library/monitor/Monitor.h:58-145`, `Monitor.cc:64-218`).
 *
 * These four are the lane's "pure data" monitors: each declares a curve (a y-range and an
 * RGB colour) and emits a value on `curveUpdated` when it has something to say. Native hands
 * the values to the GUI's chart window; the browser lane (L18) does the same with its own
 * chart. Nothing here is frozen (no artifact), except the *step* it is called on, which is
 * `MonitorManager`'s.
 *
 * Float discipline (`PORT_SPEC.md` rule 3): every value native stores into a `float` is
 * `Math.fround`ed here, and the divisions reproduce the native's *float* division exactly
 * (e.g. `(in - out) / (in + out)` is `float`/`float`, not `double`/`double` — for a ratio near
 * 1 the two differ in the last ulp, and the value is what the chart draws).
 */

import { Monitor, MonitorType } from './monitor';
import type { Signal } from './signal';
import { Signal as SignalImpl } from './signal';
import {
  AgentBirthType,
  FitnessStatType,
  FitnessWeightType,
  FoodEnergyStatScope,
  FoodEnergyStatType,
  type MonitorSim,
} from './simSurface';

const f = Math.fround;

/** Native `ChartMonitor::CurveDef`. */
export interface CurveDef {
  /** Native `id` — assigned as `curves.size()` at `defineCurve` time, i.e. declaration order. */
  readonly id: number;
  /** Native `float range[2]` — `[min, max]` of the y axis. */
  readonly range: readonly [number, number];
  /**
   * Native `float color[3]` — the sentinel `-1` (all three channels) means "no colour
   * specified"; `defineCurve`'s defaults are `-1, -1, -1` and `BirthRateMonitor`/
   * `FoodEnergyMonitor` rely on it (the chart supplies its own colour).
   */
  readonly color: readonly [number, number, number];
}

/** Native `ChartMonitor` — base for the chart family; cannot be instantiated (native's
 * constructor is `protected` and `step` stays pure). */
export abstract class ChartMonitor extends Monitor {
  /**
   * Native `util::Signal<short, float> curveUpdated` — `(curveId, value)`.
   *
   * The `curveId` is a `short` in native and a `number` here; the ids assigned by
   * `defineCurve` are 0..n-1 so the widening is lossless.
   */
  readonly curveUpdated: Signal<[number, number]> = new SignalImpl<[number, number]>();

  private readonly curves: CurveDef[] = [];

  protected constructor(sim: MonitorSim, id: string, name: string, title: string) {
    super(MonitorType.CHART, sim, id, name, title);
  }

  getCurveDefs(): readonly CurveDef[] {
    return this.curves;
  }

  /** Native `ChartMonitor::defineCurve( rmin, rmax, r = -1, g = -1, b = -1 )`. */
  protected defineCurve(rmin: number, rmax: number, r = -1, g = -1, b = -1): void {
    this.curves.push({
      id: this.curves.length,
      range: [f(rmin), f(rmax)],
      color: [f(r), f(g), f(b)],
    });
  }
}

/**
 * Native `BirthRateMonitor` — `born / (born + created)`, always on curve 0, only emitted when
 * one of the two counters moved (the chart is otherwise left alone).
 *
 * PORT-NOTE(monitor/birthrate-counter-choice): the counter is chosen **once, in the
 * constructor**: `ABT__BORN_VIRTUAL` when the run is in lockstep *or* either fitness weight is
 * non-zero, else `ABT__BORN`; the denominator is always `ABT__CREATED`. A run whose weights
 * change mid-run therefore keeps charting the counter it started with — ported as-is.
 */
export class BirthRateMonitor extends ChartMonitor {
  private readonly birthType: AgentBirthType;
  private prevBorn = 0;
  private prevCreated = 0;

  constructor(sim: MonitorSim) {
    super(sim, 'birthrate', 'Birth Rate', 'born / (born + created)');

    this.birthType =
      sim.isLockstep() ||
      sim.getFitnessWeight(FitnessWeightType.COMPLEXITY) !== 0.0 ||
      sim.getFitnessWeight(FitnessWeightType.HEURISTIC) !== 0.0
        ? AgentBirthType.BORN_VIRTUAL
        : AgentBirthType.BORN;

    this.defineCurve(0.0, 1.0);
  }

  step(_timestep: number): void {
    const numBorn = this.sim.getNumBorn(this.birthType);
    const numCreated = this.sim.getNumBorn(AgentBirthType.CREATED);

    if (numBorn !== this.prevBorn || numCreated !== this.prevCreated) {
      this.prevBorn = numBorn;
      this.prevCreated = numCreated;

      // Native: `float(numBorn) / float(numBorn + numCreated)` -- the sum is an integer sum
      // first, then a float division (0/0 -> NaN, exactly as native).
      this.curveUpdated.emit(0, f(f(numBorn) / f(numBorn + numCreated)));
    }
  }
}

/** Native `FitnessMonitor` — max / current-max / average fitness, three curves. */
export class FitnessMonitor extends ChartMonitor {
  constructor(sim: MonitorSim) {
    super(sim, 'fitness', 'Fitness', 'maxfit, curmaxfit, avgfit');

    this.defineCurve(0.0, 1.0, 1.0, 1.0, 1.0);
    this.defineCurve(0.0, 1.0, 1.0, 0.3, 0.0);
    this.defineCurve(0.0, 1.0, 0.0, 1.0, 1.0);
  }

  step(_timestep: number): void {
    this.curveUpdated.emit(0, f(this.sim.getFitnessStat(FitnessStatType.MAX_FITNESS)));
    this.curveUpdated.emit(1, f(this.sim.getFitnessStat(FitnessStatType.CURRENT_MAX_FITNESS)));
    this.curveUpdated.emit(2, f(this.sim.getFitnessStat(FitnessStatType.AVERAGE_FITNESS)));
  }
}

/**
 * Native `FoodEnergyMonitor` — `(in - out) / (in + out)` over three scopes (step / total /
 * average), one curve each, every step.
 *
 * PORT-NOTE(monitor/foodenergy-float-division): native divides two `float`s
 * (`float in = getFoodEnergyStat(...)`), so the subtraction, the addition and the division are
 * all f32 operations. The port does the same; a f64 division would differ in the last ulp for
 * ratios that are not exactly representable.
 */
export class FoodEnergyMonitor extends ChartMonitor {
  constructor(sim: MonitorSim) {
    super(sim, 'foodenergy', 'Food Energy', 'energy in, total, avg');

    this.defineCurve(-1.0, 1.0);
    this.defineCurve(-1.0, 1.0);
    this.defineCurve(-1.0, 1.0);
  }

  step(_timestep: number): void {
    this.updateCurve(0, FoodEnergyStatScope.STEP);
    this.updateCurve(1, FoodEnergyStatScope.TOTAL);
    this.updateCurve(2, FoodEnergyStatScope.AVERAGE);
  }

  updateCurve(curve: number, scope: FoodEnergyStatScope): void {
    const inValue = f(this.sim.getFoodEnergyStat(FoodEnergyStatType.IN, scope));
    const outValue = f(this.sim.getFoodEnergyStat(FoodEnergyStatType.OUT, scope));

    this.curveUpdated.emit(curve, f(f(inValue - outValue) / f(inValue + outValue)));
  }
}

/**
 * Native `PopulationMonitor` — curve 0 is the total population, curves 1..n are one per
 * domain (only when the world has more than one domain), and the curve *count* is fixed in the
 * constructor by the domain count at that moment.
 *
 * PORT-NOTE(monitor/population-curve-count): `npops = (GetNumDomains() < 2) ? 1 :
 * GetNumDomains() + 1` — note the `+ 1` for the total, and that the `assert( ncolors >= npops )`
 * is a real check (the native build has assertions enabled: `nm -u lib/libpolyworld.dylib`
 * lists `___assert_rtn`). A world with more than 6 domains therefore *aborts* natively; the
 * port throws the same failure loudly rather than clamping the palette.
 */
export class PopulationMonitor extends ChartMonitor {
  /** Native `float colors[][3]` — 7 entries; index 0 is the total-population colour. */
  private static readonly COLORS: readonly (readonly [number, number, number])[] = [
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.0, 1.0, 1.0],
    [1.0, 0.0, 1.0],
    [1.0, 1.0, 0.0],
    [1.0, 1.0, 1.0],
  ];

  constructor(sim: MonitorSim) {
    super(sim, 'population', 'Population', 'Population');

    const npops = sim.GetNumDomains() < 2 ? 1 : sim.GetNumDomains() + 1;

    if (PopulationMonitor.COLORS.length < npops) {
      // Native `assert( ncolors >= npops )`: abort with assertions on (which the recorded
      // build has), never a silent clamp to the palette size.
      throw new Error(
        `PopulationMonitor: only ${PopulationMonitor.COLORS.length} curve colours for ${npops} populations`,
      );
    }

    for (let i = 0; i < npops; i++) {
      const color = PopulationMonitor.COLORS[i]!;
      this.defineCurve(0, f(sim.GetMaxAgents()), color[0], color[1], color[2]);
    }
  }

  step(_timestep: number): void {
    this.curveUpdated.emit(0, f(this.sim.getNumAgents()));

    if (this.sim.GetNumDomains() > 1) {
      for (let domain = 0; domain < this.sim.GetNumDomains(); domain++) {
        this.curveUpdated.emit(domain + 1, f(this.sim.getNumAgents(domain)));
      }
    }
  }
}
