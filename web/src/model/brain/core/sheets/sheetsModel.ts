/**
 * Lane L6 (brain core) — `brain/sheets/SheetsModel.{h,cc}`, the "Sheets" brain geometry:
 * sheets of neurons placed on planes, receptive fields between sheets, synapse creation by
 * distance-dependent probability, and the cull that keeps only neurons on a path from an
 * input sheet to an output sheet.
 *
 * NOT COVERED BY THE RECORDED SCENARIOS: `minitest.wf`/`microtest.wf` both set
 * `BrainArchitecture Groups`, so no oracle artifact exercises this file. That is a reason for
 * extra care, not less: the port is written line-by-line against the C++ and every semantic
 * decision is PORT-NOTEd, and the lane's tests pin the pieces that can be pinned without a
 * native counterpart (geometry, receptive-field subsets, cull reachability, synapse-map
 * ordering). See PARITY.md → Gaps for the coverage statement.
 *
 * PORT-NOTE(l6/sheets-map-order): native's `SynapseMap` is `std::map< Neuron *, Synapse *,
 * NeuronKeyCompare >` ordered by `nonCulledId` — the *construction order* of the neurons,
 * not by pointer. `SheetsBrain::grow` walks `synapsesIn` to lay out the flat synapse array,
 * and `cull` walks both maps to delete edges, so iteration order is model behaviour.
 * `SynapseMap` reproduces std::map's ordering (and `erase`/`lookup`) explicitly.
 *
 * PORT-NOTE(l6/sheets-float-ops): the geometry is all `float`: spacings, positions,
 * distances and the synapse probability. `f32` is applied at each native float store, and
 * `ceilf`/`floorf`/`round` are the C functions (not `Math.trunc`): `round` is half-away-from
 * zero, which `Math.round` matches only for non-negative arguments.
 *
 * PORT-NOTE(l6/sheets-exp-libm): `getProbabilitySynapse` uses `exp`. Like `logistic`, it is
 * written against `Math.exp`; there is no native counterpart to diff against for the sheets
 * architecture, so the risk is recorded in PARITY.md rather than measured away.
 */

import { f32 } from '../nativeMath';
import { f32Fma } from '../../../agent/numeric';

/** Native `sheets::Orientation`. */
export const Orientation = { PlaneXY: 0, PlaneXZ: 1, PlaneZY: 2 } as const;
export type Orientation = (typeof Orientation)[keyof typeof Orientation];

/** C `round()` — halfway cases away from zero. */
export function cRound(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

/** Native `sheets::Vector2<float>`. */
export class Vector2f {
  a: number;
  b: number;

  constructor(a = 0, b = 0) {
    this.a = a;
    this.b = b;
  }

  static splat(v: number): Vector2f {
    return new Vector2f(v, v);
  }

  clone(): Vector2f {
    return new Vector2f(this.a, this.b);
  }

  set(a: number, b: number): void {
    this.a = a;
    this.b = b;
  }

  add(other: Vector2f): void {
    this.a = f32(this.a + other.a);
    this.b = f32(this.b + other.b);
  }

  plus(other: Vector2f): Vector2f {
    return new Vector2f(f32(this.a + other.a), f32(this.b + other.b));
  }

  minus(other: Vector2f): Vector2f {
    return new Vector2f(f32(this.a - other.a), f32(this.b - other.b));
  }

  scale(s: Vector2f): void {
    this.a = f32(this.a * s.a);
    this.b = f32(this.b * s.b);
  }

  /** Native `operator/( const Vector2<T> &vec, float scalar )`. */
  divide(scalar: number): Vector2f {
    return new Vector2f(f32(this.a / scalar), f32(this.b / scalar));
  }
}

/** Native `sheets::Vector2<int>`. */
export class Vector2i {
  a: number;
  b: number;

  constructor(a = 0, b = 0) {
    this.a = a;
    this.b = b;
  }

  set(a: number, b: number): void {
    this.a = a;
    this.b = b;
  }

  clone(): Vector2i {
    return new Vector2i(this.a, this.b);
  }
}

/** Native `sheets::Vector3<float>`. */
export class Vector3f {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  setFromPlane(orientation: Orientation, plane: Vector2f, planePos: number): void {
    switch (orientation) {
      case Orientation.PlaneXY:
        this.x = plane.a;
        this.y = plane.b;
        this.z = planePos;
        break;
      case Orientation.PlaneXZ:
        this.x = plane.a;
        this.y = planePos;
        this.z = plane.b;
        break;
      case Orientation.PlaneZY:
        this.x = planePos;
        this.z = plane.a;
        this.y = plane.b;
        break;
      default:
        throw new Error('Vector3::set: unknown orientation');
    }
  }

  scale(s: Vector3f): void {
    this.x = f32(this.x * s.x);
    this.y = f32(this.y * s.y);
    this.z = f32(this.z * s.z);
  }

  /**
   * Native `sheets::Vector3<T>::distance` (`SheetsModel.h:76-81`):
   *
   *     return sqrt( (x - other.x) * (x - other.x)
   *                + (y - other.y) * (y - other.y)
   *                + (z - other.z) * (z - other.z) );
   *
   * The shipped build materialises **one** of the three squares and fuses the other two into
   * `fmadd`s (`addReceptiveField` 0x60ff4-0x61018, where the call is inlined):
   *
   *   61000: fmul  s1, s1, s1        ; f32(dy*dy)     <- the one rounded square
   *   61004: fmadd s0, s0, s0, s1    ; dx*dx + that, ONE rounding
   *   61014: fmadd s0, s1, s1, s0    ; dz*dz + that, ONE rounding
   *   61018: fsqrt s0, s0            ; float sqrt
   *
   * i.e. `sqrt(fma(dz, dz, fma(dx, dx, f32(dy*dy))))`. The port used to round all three
   * products (the `food::setradius`/`gpoly::setradius` defect class).
   */
  distance(other: Vector3f): number {
    // each difference is a `float` `fsub` (`61000`-`61010`: `fsub s1, s1, s3`, …) before the
    // squares are formed
    const dx = f32(this.x - other.x);
    const dy = f32(this.y - other.y);
    const dz = f32(this.z - other.z);
    return f32(Math.sqrt(f32Fma(dz, dz, f32Fma(dx, dx, f32(dy * dy)))));
  }
}

/** Native `sheets::Synapse`. */
export class Synapse {
  from: Neuron;
  to: Neuron;
  attrs = { weight: 0, lrate: 0 };

  constructor(from: Neuron, to: Neuron) {
    this.from = from;
    this.to = to;
  }
}

/** Native `sheets::Neuron::Attributes::Type`. */
export const SheetsNeuronType = { E: 0, I: 1, EI: 2 } as const;
export type SheetsNeuronType = (typeof SheetsNeuronType)[keyof typeof SheetsNeuronType];

const DEFAULT_NEURON_TYPE: SheetsNeuronType = SheetsNeuronType.E;

/** Native `sheets::Neuron`. */
export class Neuron {
  sheet: Sheet | null = null;
  nonCulledId = 0;
  id = -1;
  sheetIndex = new Vector2i();
  sheetPosition = new Vector2f();
  absPosition = new Vector3f();
  synapsesOut = new SynapseMap();
  synapsesIn = new SynapseMap();
  attrs: { type: SheetsNeuronType; neuronModel: { bias: number; tau: number; gain: number; spikingParameterA: number; spikingParameterB: number; spikingParameterC: number; spikingParameterD: number } } = {
    type: DEFAULT_NEURON_TYPE,
    neuronModel: { bias: 0, tau: 0, gain: 0, spikingParameterA: 0, spikingParameterB: 0, spikingParameterC: 0, spikingParameterD: 0 },
  };
  cullState = { touchedFromInput: false, touchedFromOutput: false };
}

/** Native `NeuronKeyCompare` — `x->nonCulledId < y->nonCulledId`. */
export function neuronKeyCompare(x: Neuron, y: Neuron): number {
  return x.nonCulledId - y.nonCulledId;
}

/** Native `sheets::SynapseMap` — `std::map< Neuron *, Synapse *, NeuronKeyCompare >`. */
export class SynapseMap {
  private readonly entries: Array<{ key: Neuron; value: Synapse }> = [];

  get size(): number {
    return this.entries.length;
  }

  /** Native `map::operator[]` for a *read* — native's `m[k]` for a missing key inserts a
   * null entry; the only read site (`createSynapse`) compares it against NULL, so the port
   * returns undefined without inserting. */
  get(key: Neuron): Synapse | undefined {
    return this.entries.find((e) => e.key === key)?.value;
  }

  has(key: Neuron): boolean {
    return this.entries.some((e) => e.key === key);
  }

  /** Ordered insert, keeping std::map's key order. */
  set(key: Neuron, value: Synapse): void {
    const existing = this.entries.findIndex((e) => e.key === key);
    if (existing >= 0) {
      this.entries[existing]!.value = value;
      return;
    }
    let at = 0;
    while (at < this.entries.length && neuronKeyCompare(this.entries[at]!.key, key) < 0) at++;
    this.entries.splice(at, 0, { key, value });
  }

  erase(key: Neuron): void {
    const at = this.entries.findIndex((e) => e.key === key);
    if (at >= 0) this.entries.splice(at, 1);
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Sorted iteration (native: `itfor( SynapseMap, map, it )`). */
  values(): Synapse[] {
    return this.entries.map((e) => e.value);
  }

  entriesInOrder(): ReadonlyArray<{ key: Neuron; value: Synapse }> {
    return this.entries;
  }
}

/** Native `sheets::NeuronSubset`. */
export class NeuronSubset {
  begin = new Vector2i();
  end = new Vector2i();

  /** Native `Iterator` — a and b walk the rectangle b-fastest. */
  *indices(): Generator<Vector2i> {
    const index = this.begin.clone();
    const endPlus = new Vector2i(this.end.a + 1, this.begin.b);
    while (index.a !== endPlus.a || index.b !== endPlus.b) {
      yield index.clone();
      index.b += 1;
      if (index.b > this.end.b) {
        index.a += 1;
        index.b = this.begin.b;
      }
    }
  }

  size(): number {
    return Math.max(0, this.end.a - this.begin.a + 1) * Math.max(0, this.end.b - this.begin.b + 1);
  }
}

/** Native `sheets::Sheet`. */
export class Sheet {
  static readonly Input = 0;
  static readonly Output = 1;
  static readonly Internal = 2;

  static getName(type: number): string {
    switch (type) {
      case Sheet.Input:
        return 'Input';
      case Sheet.Output:
        return 'Output';
      case Sheet.Internal:
        return 'Internal';
      default:
        throw new Error('Sheet::getName: unknown type');
    }
  }

  private readonly _sheetsModel: SheetsModel;
  private readonly _name: string;
  private readonly _id: number;
  private readonly _type: number;
  private readonly _orientation: Orientation;
  private readonly _slot: number;
  private readonly _center: Vector2f;
  private readonly _size: Vector2f;
  private readonly _neuronCount: Vector2i;
  private readonly _neuronSpacing: Vector2f;
  private readonly _neuronInsets: Vector2f;
  private readonly _nneurons: number;
  private readonly _neurons: Neuron[];

  /** Native `Sheet::Sheet` — note the *trim before* creating neurons. */
  constructor(
    model: SheetsModel,
    name: string,
    id: number,
    type: number,
    orientation: Orientation,
    slot: number,
    center: Vector2f,
    size: Vector2f,
    neuronCount: Vector2i,
    neuronCreated: (neuron: Neuron) => void,
  ) {
    this._sheetsModel = model;
    this._name = name;
    this._id = id;
    this._type = type;
    this._orientation = orientation;
    this._slot = slot;
    this._center = center;
    this._size = size;
    this._neuronCount = neuronCount;
    this._neuronSpacing = new Vector2f(f32(1.0 / neuronCount.a), f32(1.0 / neuronCount.b));
    this._neuronInsets = this._neuronSpacing.divide(2);
    this._nneurons = neuronCount.a * neuronCount.b;
    this._neurons = new Array<Neuron>(this._nneurons);
    for (let i = 0; i < this._nneurons; i++) this._neurons[i] = new Neuron();

    // If the sheet exceeds the model boundaries, then we must scale it down and translate it
    this.trimAxis(center, size, 'a');
    this.trimAxis(center, size, 'b');

    this.createNeurons(neuronCreated);
  }

  getId(): number {
    return this._id;
  }

  getName(): string {
    return this._name;
  }

  getType(): number {
    return this._type;
  }

  getNeuronCount(): Vector2i {
    return this._neuronCount;
  }

  getNeuron(a: number, b: number): Neuron {
    if (!(a < this._neuronCount.a && a >= 0 && b < this._neuronCount.b && b >= 0)) {
      throw new Error(`Sheet::getNeuron: index (${a},${b}) out of range for a ${this._neuronCount.a}x${this._neuronCount.b} sheet`);
    }
    const offset = a + b * this._neuronCount.a;
    if (!(offset >= 0 && offset < this._nneurons)) throw new Error('Sheet::getNeuron: bad offset');
    return this._neurons[offset]!;
  }

  getNeuronAt(index: Vector2i): Neuron {
    return this.getNeuron(index.a, index.b);
  }

  /** Native `Sheet::addReceptiveField`. */
  addReceptiveField(
    role: number,
    currentCenter: Vector2f,
    currentSize: Vector2f,
    otherCenter: Vector2f,
    otherSize: Vector2f,
    fieldOffset: Vector2f,
    fieldSize: Vector2f,
    other: Sheet,
    neuronPredicate: (neuron: Neuron, role: number) => boolean,
    synapseCreated: (synapse: Synapse) => void,
  ): void {
    currentSize.a = Math.max(currentSize.a, this._neuronSpacing.a);
    currentSize.b = Math.max(currentSize.b, this._neuronSpacing.b);

    fieldSize.a = Math.max(fieldSize.a, other._neuronSpacing.a);
    fieldSize.b = Math.max(fieldSize.b, other._neuronSpacing.b);

    let currentNeuronRole: number;
    let otherNeuronRole: number;
    switch (role) {
      case SheetReceptiveFieldRole.Source:
        currentNeuronRole = ReceptiveFieldNeuronRole.To;
        otherNeuronRole = ReceptiveFieldNeuronRole.From;
        break;
      case SheetReceptiveFieldRole.Target:
        currentNeuronRole = ReceptiveFieldNeuronRole.From;
        otherNeuronRole = ReceptiveFieldNeuronRole.To;
        break;
      default:
        throw new Error('Sheet::addReceptiveField: unknown role');
    }

    const currentNeurons = this.findNeurons(currentCenter, currentSize);
    const otherNeurons = other.findNeurons(otherCenter, otherSize);

    for (const currentNeuronIndex of currentNeurons.indices()) {
      const currentNeuron = this.getNeuronAt(currentNeuronIndex);
      if (!neuronPredicate(currentNeuron, currentNeuronRole)) continue;

      const allReceptiveFieldNeurons = other.findReceptiveFieldNeurons(currentNeuron.sheetPosition, fieldOffset, fieldSize);

      const constrained = new NeuronSubset();
      constrained.begin.a = Math.max(allReceptiveFieldNeurons.begin.a, otherNeurons.begin.a);
      constrained.begin.b = Math.max(allReceptiveFieldNeurons.begin.b, otherNeurons.begin.b);
      constrained.end.a = Math.min(allReceptiveFieldNeurons.end.a, otherNeurons.end.a);
      constrained.end.b = Math.min(allReceptiveFieldNeurons.end.b, otherNeurons.end.b);

      if (constrained.size() < 1) continue;

      const fieldNeurons: Neuron[] = [];
      let totalDistance = 0;

      for (const otherNeuronIndex of constrained.indices()) {
        const otherNeuron = other.getNeuronAt(otherNeuronIndex);
        if (currentNeuron === otherNeuron) continue; // ignore self-synapse
        if (!neuronPredicate(otherNeuron, otherNeuronRole)) continue;
        fieldNeurons.push(otherNeuron);
        totalDistance = f32(totalDistance + currentNeuron.absPosition.distance(otherNeuron.absPosition));
      }

      if (fieldNeurons.length === 0) continue;

      const meanDistance = f32(totalDistance / fieldNeurons.length);
      const probabilitySynapse = this._sheetsModel.getProbabilitySynapse(meanDistance);
      let nsynapses = Math.trunc(cRound(f32(probabilitySynapse * fieldNeurons.length)));

      if (nsynapses === 0) continue;

      const stride = Math.trunc(fieldNeurons.length / nsynapses);

      for (let offset = 0; nsynapses > 0; offset += stride, nsynapses--) {
        const otherNeuron = fieldNeurons[offset]!;
        let synapse: Synapse | null = null;

        switch (role) {
          case SheetReceptiveFieldRole.Source:
            synapse = this.createSynapse(otherNeuron, currentNeuron);
            break;
          case SheetReceptiveFieldRole.Target:
            synapse = this.createSynapse(currentNeuron, otherNeuron);
            break;
          default:
            throw new Error('Sheet::addReceptiveField: unknown role');
        }

        if (synapse) synapseCreated(synapse);
      }
    }
  }

  /** Native `Sheet::trim( float &center, float &size )` on one axis. */
  private trimAxis(center: Vector2f, size: Vector2f, axis: 'a' | 'b'): void {
    let overflow: number;

    overflow = f32(f32(center[axis] + f32(size[axis] / 2)) - 1.0);
    if (overflow > 0) {
      size[axis] = f32(size[axis] - overflow);
      center[axis] = f32(center[axis] - f32(overflow / 2));
      if (!(Math.abs(f32(f32(center[axis] + f32(size[axis] / 2)) - 1.0)) < 1e-6)) {
        throw new Error('Sheet::trim: top/right trim did not land on the boundary');
      }
    } else {
      overflow = f32(0 - f32(center[axis] - f32(size[axis] / 2)));
      if (overflow > 0) {
        size[axis] = f32(size[axis] - overflow);
        center[axis] = f32(center[axis] + f32(overflow / 2));
        if (!(Math.abs(f32(center[axis] - f32(size[axis] / 2))) < 1e-6)) {
          throw new Error('Sheet::trim: bottom/left trim did not land on the boundary');
        }
      }
    }
  }

  /** Native `Sheet::createNeurons`. */
  private createNeurons(neuronCreated: (neuron: Neuron) => void): void {
    for (let i = 0; i < this._neuronCount.a; i++) {
      for (let j = 0; j < this._neuronCount.b; j++) {
        const neuron = this.getNeuron(i, j);

        neuron.sheet = this;
        neuron.nonCulledId = this._sheetsModel.nextNonCulledId();
        neuron.id = -1;
        neuron.sheetIndex.set(i, j);
        neuron.cullState.touchedFromInput = false;
        neuron.cullState.touchedFromOutput = false;

        // 2D position within sheet. `__ZN6sheets5Sheet13createNeuronsE…` 0x608fc-0x60910:
        //   60904: fmadd s0, s9, s2, s0   ; (float)i * _neuronSpacing.a + _neuronInsets.a
        //   6090c: fmadd s1, s2, s3, s1   ; (float)j * _neuronSpacing.b + _neuronInsets.b
        // — one rounding for each `inset + index*spacing`, not a rounded product plus an add.
        neuron.sheetPosition.set(
          f32(f32Fma(i, this._neuronSpacing.a, this._neuronInsets.a)),
          f32(f32Fma(j, this._neuronSpacing.b, this._neuronInsets.b)),
        );

        // Scale 2D position by sheet size, translate by sheet location, make it 3D
        const position = neuron.sheetPosition.clone();
        position.scale(this._size);
        position.add(this._center.minus(this._size.divide(2)));
        neuron.absPosition.setFromPlane(this._orientation, position, this._slot);
        neuron.absPosition.scale(this._sheetsModel.getSize());

        if (neuron !== this.getNeuron(neuron.sheetIndex.a, neuron.sheetIndex.b)) {
          throw new Error('Sheet::createNeurons: neuron index mismatch');
        }

        neuronCreated(neuron);
      }
    }
  }

  /** Native `Sheet::findNeurons`. */
  findNeurons(center: Vector2f, size: Vector2f): NeuronSubset {
    const result = new NeuronSubset();
    const ul = center.minus(size.divide(2));
    const lr = center.plus(size.divide(2));

    result.begin.a = Math.max(0, Math.trunc(Math.ceil(f32(f32(ul.a - this._neuronInsets.a) / this._neuronSpacing.a))));
    result.end.a = Math.min(this._neuronCount.a - 1, Math.trunc(Math.floor(f32(f32(lr.a - this._neuronInsets.a) / this._neuronSpacing.a))));
    result.begin.b = Math.max(0, Math.trunc(Math.ceil(f32(f32(ul.b - this._neuronInsets.b) / this._neuronSpacing.b))));
    result.end.b = Math.min(this._neuronCount.b - 1, Math.trunc(Math.floor(f32(f32(lr.b - this._neuronInsets.b) / this._neuronSpacing.b))));

    return result;
  }

  /** Native `Sheet::findReceptiveFieldNeurons`. */
  findReceptiveFieldNeurons(neuronPosition: Vector2f, fieldOffset: Vector2f, fieldSize: Vector2f): NeuronSubset {
    const center = neuronPosition.clone();
    offsetCenter(center, 'a', fieldOffset.a);
    offsetCenter(center, 'b', fieldOffset.b);
    return this.findNeurons(center, fieldSize);
  }

  /** Native `Sheet::createSynapse` — `NULL` when it is a self-synapse or already exists. */
  private createSynapse(from: Neuron, to: Neuron): Synapse | null {
    if (from === to) return null;
    if (from.synapsesOut.get(to) !== undefined) return null;

    const synapse = new Synapse(from, to);
    from.synapsesOut.set(to, synapse);
    to.synapsesIn.set(from, synapse);
    return synapse;
  }

  /** Native `Sheet::distance( Neuron *, Neuron * )` — `gobject::distance` (unused by the model). */
  static distance(a: Neuron, b: Neuron): number {
    return a.absPosition.distance(b.absPosition);
  }
}

/** Native `Sheet::ReceptiveFieldRole`. */
export const SheetReceptiveFieldRole = { Source: 0, Target: 1 } as const;

/** Native `Sheet::ReceptiveFieldNeuronRole`. */
export const ReceptiveFieldNeuronRole = { From: 0, To: 1 } as const;

/**
 * Native `Sheet::findReceptiveFieldNeurons`'s local `offsetCenter`:
 *
 *     static void offsetCenter( float &center, float offset ) {
 *         if( offset < 0 ) center += center * offset;
 *         else            center += (1 - center) * offset;
 *     }
 *
 * A `float` multiply-add, contracted by the shipped build (`fmla.2s v0, v2, v1` at 0x60ea8
 * where the call is inlined, and the scalar `fmadd` pairs the same function produces when the
 * two axes are not vectorised): one rounding for `center + <factor> * offset`, not a rounded
 * product plus an add. The `<factor>` is the *pre-update* `center` (the `1 - center`
 * subtraction is its own float op).
 */
export function offsetCenter(center: Vector2f, axis: 'a' | 'b', offset: number): void {
  const current = center[axis];
  const factor = offset < 0 ? current : f32(1 - current);
  center[axis] = f32(f32Fma(factor, offset, current));
}

/** Native `sheets::SheetsModel`. */
export class SheetsModel {
  private _numNonCulledNeurons = 0;
  private readonly _size: Vector3f;
  private readonly _synapseProbabilityX: number;
  private readonly _allSheets: Sheet[] = [];
  private readonly _inputSheets: Sheet[] = [];
  private readonly _outputSheets: Sheet[] = [];
  private readonly _internalSheets: Sheet[] = [];
  private readonly _neurons: Neuron[] = [];

  constructor(size: Vector3f, synapseProbabilityX: number) {
    this._size = size;
    this._synapseProbabilityX = f32(synapseProbabilityX);
  }

  getSize(): Vector3f {
    return this._size;
  }

  /** Native `SheetsModel::_numNonCulledNeurons++` inside `Sheet::createNeurons`. */
  nextNonCulledId(): number {
    return this._numNonCulledNeurons++;
  }

  /** Native `SheetsModel::createSheet`. */
  createSheet(
    name: string,
    id: number,
    type: number,
    orientation: Orientation,
    slot: number,
    center: Vector2f,
    size: Vector2f,
    neuronCount: Vector2i,
    neuronCreated: (neuron: Neuron) => void,
  ): Sheet {
    if (id === -1) id = this._allSheets.length;

    const sheet = new Sheet(this, name, id, type, orientation, slot, center, size, neuronCount, neuronCreated);

    while (this._allSheets.length <= id) this._allSheets.push(undefined as unknown as Sheet);
    if (this._allSheets[id] !== undefined) throw new Error(`SheetsModel::createSheet: sheet id ${id} already exists`);
    this._allSheets[id] = sheet;

    switch (type) {
      case Sheet.Input:
        this._inputSheets.push(sheet);
        break;
      case Sheet.Output:
        this._outputSheets.push(sheet);
        break;
      case Sheet.Internal:
        this._internalSheets.push(sheet);
        break;
      default:
        throw new Error('SheetsModel::createSheet: unknown sheet type');
    }

    return sheet;
  }

  getSheet(id: number): Sheet | undefined {
    if (id >= this._allSheets.length) return undefined;
    return this._allSheets[id];
  }

  getSheets(type: number): Sheet[] {
    switch (type) {
      case Sheet.Input:
        return this._inputSheets;
      case Sheet.Output:
        return this._outputSheets;
      case Sheet.Internal:
        return this._internalSheets;
      default:
        throw new Error('SheetsModel::getSheets: unknown sheet type');
    }
  }

  /** Native `SheetsModel::cull`. */
  cull(): void {
    if (this._inputSheets.length === 0) throw new Error('SheetsModel::cull: no input sheets');
    if (this._outputSheets.length === 0) throw new Error('SheetsModel::cull: no output sheets');

    for (const sheet of this._inputSheets) {
      const count = sheet.getNeuronCount();
      for (let a = 0; a < count.a; a++) for (let b = 0; b < count.b; b++) this.touchFromInput(sheet.getNeuron(a, b));
    }

    for (const sheet of this._outputSheets) {
      const count = sheet.getNeuronCount();
      for (let a = 0; a < count.a; a++) for (let b = 0; b < count.b; b++) this.touchFromOutput(sheet.getNeuron(a, b));
    }

    this.addNonCulledNeurons(this._inputSheets);
    this.addNonCulledNeurons(this._outputSheets);
    this.addNonCulledNeurons(this._internalSheets);
  }

  getNeurons(): Neuron[] {
    return this._neurons;
  }

  /** Native `SheetsModel::getProbabilitySynapse`. */
  getProbabilitySynapse(distance: number): number {
    if (this._synapseProbabilityX === 0.0) return 1.0;
    return f32((1 / this._synapseProbabilityX) * Math.exp(f32(-f32(distance / this._synapseProbabilityX))));
  }

  private touchFromInput(neuron: Neuron): void {
    if (neuron.cullState.touchedFromInput) return;
    neuron.cullState.touchedFromInput = true;
    for (const syn of neuron.synapsesOut.values()) this.touchFromInput(syn.to);
  }

  private touchFromOutput(neuron: Neuron): void {
    if (neuron.cullState.touchedFromOutput) return;
    neuron.cullState.touchedFromOutput = true;
    for (const syn of neuron.synapsesIn.values()) this.touchFromOutput(syn.from);
  }

  /** Native `SheetsModel::addNonCulledNeurons` — keeps neurons on an input→output path. */
  private addNonCulledNeurons(sheets: Sheet[]): void {
    for (const sheet of sheets) {
      const count = sheet.getNeuronCount();
      for (let a = 0; a < count.a; a++) {
        for (let b = 0; b < count.b; b++) {
          const neuron = sheet.getNeuron(a, b);
          if (neuron.cullState.touchedFromOutput && neuron.cullState.touchedFromInput) {
            neuron.id = this._neurons.length;
            this._neurons.push(neuron);
          } else {
            for (const syn of neuron.synapsesIn.values()) {
              syn.from.synapsesOut.erase(neuron);
            }
            neuron.synapsesIn.clear();

            for (const syn of neuron.synapsesOut.values()) {
              syn.to.synapsesIn.erase(neuron);
            }
            neuron.synapsesOut.clear();
          }
        }
      }
    }
  }
}
