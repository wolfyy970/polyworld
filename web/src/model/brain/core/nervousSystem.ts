/**
 * Lane L6 (brain core) — `brain/NervousSystem.h/.cc`: the nerve registry the brain grows
 * into, plus the sensor walk whose order is model behaviour.
 *
 * PORT-NOTE(l6/nerve-registry): native keeps `map<string,Nerve*>` *and* `all`/`lists[type]`
 * vectors; `createNerve` appends to the vectors and stores `all.size()` as the nerve's
 * (unused) `igroup`. Only the vectors are ever read (`getNerves()` is the ordering the
 * models iterate), the map is only used by name. The port keeps both and keeps the
 * insertion order of the vectors exactly: `GroupsBrain::grow` derives the input/output
 * neuron indices from `_cns->getNerveCount()` and `getNeuronCount(type)` in that order, so
 * a reordered registry changes every neuron index in the brain.
 *
 * PORT-NOTE(l6/getNerve-missing): native `getNerve(name)` is `map[name]`, which *inserts* a
 * null entry and returns null for an unknown nerve; the caller (`GroupsBrain::grow`,
 * `SheetsBrain::grow`) then dereferences it. The port throws instead: a missing nerve is a
 * wiring bug in the genome/worldfile, and reproducing the segfault is not useful behaviour to
 * preserve.
 *
 * PORT-NOTE(l6/sensors-are-ordered): `grow`/`update`/`prebirthSignal`/`startFunctional`/
 * `dumpAnatomical` walk `SensorList` in insertion order, and the sensors write into neuron
 * ranges *and* consume the GLOBAL RNG in that order (`RandomSensor` draws one value per
 * step). The port keeps one array and never reorders it.
 */

import { Nerve, NerveType } from './nerve';
import type { Sensor } from './sensor';
import type { Brain } from './brain';
import type { BrainTextFile } from './textFile';
import type { RngSurface } from '../../types';

export class NervousSystem {
  /** Native `NerveList` — every nerve, in creation order. */
  private readonly all: Nerve[] = [];
  /** Native `lists[Nerve::__NTYPES]`. */
  private readonly lists: Nerve[][] = [[], []];
  /** Native `NerveMap map`. Kept so a duplicate name can be rejected the way native can't. */
  private readonly byName = new Map<string, Nerve>();
  private readonly sensors: Sensor[] = [];

  protected rng: RngSurface;
  protected b: Brain | null = null;

  /** Native `NervousSystem::NervousSystem()` — `create( NERVOUS_SYSTEM )`, a GLOBAL role. */
  constructor(rng: RngSurface) {
    this.rng = rng;
  }

  /**
   * Native `NervousSystem::grow` — `b = g->createBrain( this )` followed by every
   * `sensor_grow`. The genome is passed as a callback so this lane never depends on the
   * genome lane's type (`brainGenome.ts` is the boundary).
   */
  grow(createBrain: (cns: NervousSystem) => Brain): void {
    this.b = createBrain(this);

    for (const sensor of this.sensors) sensor.sensorGrow(this);
  }

  /** Native `NervousSystem::update` — sensors first, then the brain. */
  update(bprint: boolean): void {
    for (const sensor of this.sensors) sensor.sensorUpdate(bprint);
    this.requireBrain().update(bprint);
  }

  getEnergyUse(): number {
    return this.requireBrain().getEnergyUse();
  }

  getBrain(): Brain | null {
    return this.b;
  }

  /** For the port's use where native would have a dangling `Brain *` before `grow`. */
  private requireBrain(): Brain {
    if (!this.b) throw new Error('NervousSystem: used before grow()');
    return this.b;
  }

  getRNG(): RngSurface {
    return this.rng;
  }

  /**
   * Native `NervousSystem::createNerve( type, name )`. The native third argument (`igroup`)
   * is stored nowhere — `Nerve`'s constructor ignores it — so the port drops it.
   */
  createNerve(type: NerveType, name: string): Nerve {
    if (this.byName.has(name)) {
      throw new Error(`NervousSystem: duplicate nerve '${name}'`);
    }
    const nerve = new Nerve(type, name);
    this.byName.set(name, nerve);
    this.lists[type]!.push(nerve);
    this.all.push(nerve);
    return nerve;
  }

  getNerve(name: string): Nerve {
    const nerve = this.byName.get(name);
    if (!nerve) throw new Error(`NervousSystem: no such nerve '${name}'`);
    return nerve;
  }

  hasNerve(name: string): boolean {
    return this.byName.has(name);
  }

  addSensor(sensor: Sensor): void {
    this.sensors.push(sensor);
  }

  getSensorCount(): number {
    return this.sensors.length;
  }

  getNerveCount(type?: NerveType): number {
    return type === undefined ? this.all.length : this.lists[type]!.length;
  }

  /** Native `NervousSystem::getNeuronCount( type )` — the sum over that type's nerves. */
  getNeuronCount(type: NerveType): number {
    let count = 0;
    for (const nerve of this.lists[type]!) count += nerve.getNeuronCount();
    return count;
  }

  getNerves(type?: NerveType): readonly Nerve[] {
    return type === undefined ? this.all : this.lists[type]!;
  }

  /** Native `NervousSystem::prebirth`. */
  prebirth(): void {
    this.requireBrain().prebirth();
  }

  /** Native `NervousSystem::prebirthSignal` — one draw per sensor, in order. */
  prebirthSignal(): void {
    for (const sensor of this.sensors) sensor.sensorPrebirthSignal(this.rng);
  }

  /** Native `NervousSystem::startFunctional` — the "organs" part of the functional header. */
  startFunctional(f: BrainTextFile): void {
    for (const sensor of this.sensors) sensor.sensorStartFunctional(f);
  }

  /** Native `NervousSystem::dumpAnatomical`. */
  dumpAnatomical(f: BrainTextFile): void {
    for (const sensor of this.sensors) sensor.sensorDumpAnatomical(f);
  }
}
