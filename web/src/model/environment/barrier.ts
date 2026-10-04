/**
 * Lane L10 — native `environment/barrier.{h,cc}`: the world's barrier segments (plus native's
 * `bxsortedlist`, the x-sorted barrier list).
 *
 * A barrier is a *line segment* in the XZ plane turned into a **signed perpendicular
 * distance** — `dist( x, z ) = (a*x + b*z + c) * f`, with `(a,b)` the segment normal,
 * `c` its offset and `f` the inverse normal length. `agent::UpdateBody()` is the consumer: it
 * compares `dist` (and its sign change between the agent's old and new position) to decide
 * whether the agent crossed a barrier, then pushes the agent out along `( -cosa, sina )`.
 * So `a`, `b`, `c`, `f`, `sina` and `cosa` — not just the endpoints — are observable.
 *
 * PORT-NOTE(L10/barrier-ratio-scaling): `gRatioPositions` decides whether the worldfile's
 * endpoint values are absolute or fractions of `WorldSize`. When it is set, the *scaling is
 * applied in `updateVertices`*, i.e. to the *absolute* copy, every time the position changes;
 * `currPosition` keeps the raw (normalized) values and `nextPosition` is the worldfile's own
 * segment. `RatioBarrierPositions True` is what both recorded worldfiles use, so the two
 * barriers sit at `0.3333 * 25` and `0.6667 * 25`.
 *
 * PORT-NOTE(L10/barrier-degenerate-segment): a zero-length segment makes the distance
 * meaningless, and native hard-codes `c = 1.0; f = 1.0e+10;` for it rather than dividing by
 * zero. The port reproduces the sentinel (`f32(1.0e+10)`) — the comparison is on `a` and `b`
 * being *exactly* zero, which happens whenever both endpoints coincide.
 *
 * PORT-NOTE(L10/barrier-construction-draws): native's `barrier()` runs the `gpoly`/`gobject`
 * constructors first, and `gobject::init()` spends **three `rand()` values** on the default
 * colour. `Simulation.cc` constructs barriers in `processWorldFile`, before food and agents,
 * so those three draws are part of the stream order. The probe's `barrier.draws*` fixtures pin
 * them.
 *
 * PORT-NOTE(L10/barrier-xsort-is-dead): `bxsortedlist::xsort()` only does anything when
 * `needXSort` is set, and `needXSort` can only be set from `barrier::needXSort()`, which is
 * `return false;` — a hard-coded constant. Native therefore never runs `actuallyXSort()`. The
 * port keeps the flag and the guard, and implements `xsort()` as the *equivalent* stable
 * ordering (a stable sort by `xmin`) rather than porting `gdlist`'s link surgery for a branch
 * that cannot execute; `add`'s insertion order, which *is* observable, is ported exactly.
 *
 * PORT-NOTE(L10/barrier-gbarriers-is-append-only): native keeps both `gXSortedBarriers` (the
 * sorted list the model walks) and `gBarriers` (a `vector` in creation order that nothing
 * reads after `processWorldFile` — `sim/Simulation.cc` pushes and nothing else touches it).
 * Both are exposed so L11 can push exactly as native does.
 */

import { globalRngSurface } from '../rng';
import { f32 } from '../geometry';
import { globals, type Color } from '../types';

/**
 * Native `barrier::LineSegment` (`barrier.h:40-76`) — the four `float` members.
 *
 * PORT-NOTE(L10/linsegment-narrows-on-store): native's members are `float`, so *every* store
 * narrows — including the worldfile assignment `b->getPosition().xa = propBarrier.get("X1")`,
 * which passes a `double` in and keeps only the `float`. The port's accessors apply `f32` for
 * exactly that reason: a plain field assignment would keep the double and shift the whole
 * geometry (measured: `0.3333` un-narrowed moves `xmin` by one ulp).
 */
export class LineSegment {
  private _xa: number;
  private _za: number;
  private _xb: number;
  private _zb: number;

  constructor(xa = 0, za = 0, xb = 0, zb = 0) {
    this._xa = f32(xa);
    this._za = f32(za);
    this._xb = f32(xb);
    this._zb = f32(zb);
  }

  get xa(): number {
    return this._xa;
  }
  set xa(v: number) {
    this._xa = f32(v);
  }
  get za(): number {
    return this._za;
  }
  set za(v: number) {
    this._za = f32(v);
  }
  get xb(): number {
    return this._xb;
  }
  set xb(v: number) {
    this._xb = f32(v);
  }
  get zb(): number {
    return this._zb;
  }
  set zb(v: number) {
    this._zb = f32(v);
  }

  equals(other: LineSegment): boolean {
    return this._xa === other._xa && this._za === other._za && this._xb === other._xb && this._zb === other._zb;
  }
}

/**
 * Native `bxsortedlist : public gdlist<barrier*>` (`barrier.h:24-40`).
 *
 * `add` inserts before the first barrier whose `xmin()` is *strictly greater* (so equal
 * `xmin`s keep insertion order) and appends otherwise; it also ORs in `needXSort`, which is
 * permanently false (PORT-NOTE above).
 */
export class BxSortedList {
  private items: Barrier[] = [];
  private cursor = -1;
  private needXSort = false;

  /** Native `gdlist::reset()`. */
  reset(): void {
    this.cursor = -1;
  }
  /** Native `gdlist::next( barrier *&b )` — the next barrier, or null at the end. */
  next(): Barrier | null {
    if (this.cursor + 1 >= this.items.length) {
      this.cursor = this.items.length;
      return null;
    }
    this.cursor++;
    return this.items[this.cursor]!;
  }
  count(): number {
    return this.items.length;
  }
  /** Native's iteration order, front to back. */
  toArray(): Barrier[] {
    return [...this.items];
  }
  /** Native `gdlist::inserthere` / `append`. */
  add(newBarrier: Barrier): void {
    let inserted = false;
    this.reset();
    for (;;) {
      const old = this.next();
      if (old === null) break;
      if (newBarrier.xmin() < old.xmin()) {
        this.items.splice(this.cursor, 0, newBarrier);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.items.push(newBarrier);

    // If any barrier says it needs to be x-sorted, then they all must be
    if (!this.needXSort) this.needXSort = newBarrier.needXSort();
  }

  /** Native `bxsortedlist::xsort()`. */
  xsort(): void {
    if (this.needXSort) this.actuallyXSort();
  }

  /** Native `bxsortedlist::actuallyXSort()` — unreachable (see the PORT-NOTE); stable. */
  private actuallyXSort(): void {
    this.items = this.items
      .map((b, i) => ({ b, i }))
      .sort((l, r) => l.b.xmin() - r.b.xmin() || l.i - r.i)
      .map((e) => e.b);
  }

  clear(): void {
    this.items = [];
    this.cursor = -1;
    this.needXSort = false;
  }
}

/** Native `class barrier : public gpoly` (`barrier.h:47-121`). */
export class Barrier {
  // --- statics (native `barrier.cc:20-26`, written by `processWorldFile`) ---
  static gBarrierHeight = 0.0;
  static gBarrierColor: Color = { r: 0, g: 0, b: 0 };
  static gStickyBarriers = false;
  static gRatioPositions = false;
  /** Native `barrier::gXSortedBarriers`. */
  static readonly gXSortedBarriers = new BxSortedList();
  /** Native `barrier::gBarriers` — the append-only creation-order vector. */
  static readonly gBarriers: Barrier[] = [];

  /** Native's `nextPosition`; `getPosition()` hands this out for `processWorldFile` to fill. */
  readonly nextPosition = new LineSegment();
  private readonly currPosition = new LineSegment();
  private readonly absCurrPosition = new LineSegment();

  /** Native `float fVertices[12]` (4 points × xyz) and `long fNumPoints = 4`. */
  readonly vertices: number[] = new Array(12).fill(0);
  readonly numPoints = 4;

  color: Color = { r: 0, g: 0, b: 0 };

  private xmn = 0;
  private xmx = 0;
  private zmn = 0;
  private zmx = 0;
  private a = 0;
  private b = 0;
  private c = 0;
  private f = 0;
  private sna = 0;
  private csa = 0;

  /**
   * Native `barrier::barrier()` — the segment seeds are all `(0,0,0,0)`, and the `gobject`
   * constructor's three `rand()` draws happen first. Pass `rng` to drive them from a test;
   * native reads the process-wide stream.
   */
  constructor(rng: { rand(): number } = globalRngSurface()) {
    rng.rand();
    rng.rand();
    rng.rand();
  }

  /** Native's `getPosition()` — a *reference* to `nextPosition`. */
  getPosition(): LineSegment {
    return this.nextPosition;
  }

  /** Native `barrier::init()` — colour, then `updateVertices()`. */
  init(): void {
    this.setColor(Barrier.gBarrierColor);
    this.updateVertices();
  }

  /** Native `barrier::update()` — recompute only when the position actually changed. */
  update(): void {
    if (!this.nextPosition.equals(this.currPosition)) this.updateVertices();
  }

  /**
   * Native `barrier::updateVertices()` (`barrier.cc:100-172`), including the `gRatioPositions`
   * scaling of the absolute copy and the exact float order of `a`/`b`/`c`/`f`/`sna`/`csa`.
   */
  updateVertices(): void {
    copySegment(this.currPosition, this.nextPosition);
    copySegment(this.absCurrPosition, this.currPosition);
    if (Barrier.gRatioPositions) {
      const w = globals.worldsize;
      this.absCurrPosition.xa = f32(this.absCurrPosition.xa * w);
      this.absCurrPosition.za = f32(this.absCurrPosition.za * w);
      this.absCurrPosition.xb = f32(this.absCurrPosition.xb * w);
      this.absCurrPosition.zb = f32(this.absCurrPosition.zb * w);
    }

    this.vertices[0] = this.absCurrPosition.xa;
    this.vertices[1] = 0.0;
    this.vertices[2] = this.absCurrPosition.za;
    this.vertices[3] = this.absCurrPosition.xa;
    this.vertices[4] = f32(Barrier.gBarrierHeight);
    this.vertices[5] = this.absCurrPosition.za;
    this.vertices[6] = this.absCurrPosition.xb;
    this.vertices[7] = f32(Barrier.gBarrierHeight);
    this.vertices[8] = this.absCurrPosition.zb;
    this.vertices[9] = this.absCurrPosition.xb;
    this.vertices[10] = 0.0;
    this.vertices[11] = this.absCurrPosition.zb;

    let x1: number;
    let x2: number;
    let z1: number;
    let z2: number;

    if (this.absCurrPosition.xa < this.absCurrPosition.xb) {
      this.xmn = x1 = this.absCurrPosition.xa;
      this.xmx = x2 = this.absCurrPosition.xb;
      z1 = this.absCurrPosition.za;
      z2 = this.absCurrPosition.zb;
    } else {
      this.xmn = x1 = this.absCurrPosition.xb;
      this.xmx = x2 = this.absCurrPosition.xa;
      z1 = this.absCurrPosition.zb;
      z2 = this.absCurrPosition.za;
    }

    if (this.absCurrPosition.za < this.absCurrPosition.zb) {
      this.zmn = this.absCurrPosition.za;
      this.zmx = this.absCurrPosition.zb;
    } else {
      this.zmn = this.absCurrPosition.zb;
      this.zmx = this.absCurrPosition.za;
    }

    this.a = f32(z2 - z1);
    this.b = f32(x1 - x2);
    // Native contracts `x2 * z1  -  x1 * z2` into one fused multiply-subtract: the *second*
    // product is rounded to float and the first is kept exact, then the difference is rounded
    // once (PORT-NOTE(L10/fma-contraction)). Measured by reverting this line alone: rounding the
    // first product instead misses 21 of the probe's pins (the 2 `dist` values the shift also
    // reaches are a subset of those 21).
    this.c = f32(x2 * z1 - f32(x1 * z2));
    if (this.a === 0.0 && this.b === 0.0) {
      // zero-size barrier, so distance is meaningless; make it very large
      this.c = 1.0;
      this.f = f32(1.0e10);
    } else {
      // `sqrt( a*a + b*b )` is fused the same way: `a*a` exact, `b*b` rounded, one rounding.
      this.f = f32(1.0 / f32(Math.sqrt(f32(this.a * this.a + f32(this.b * this.b)))));
    }
    this.sna = f32(-this.b * this.f);

    if (this.a < 0.0) this.sna = f32(this.sna * -1.0);

    this.csa = f32(Math.abs(f32(this.a * this.f)));
  }

  /**
   * Native `barrier::dist( float x, float z )` — the signed perpendicular distance
   * `( a*x + b*z + c ) * f`, with native's fused `a*x + b*z` (see the PORT-NOTE above).
   */
  dist(x: number, z: number): number {
    // Native's parameters are `float`, so the callers' doubles narrow on the way in.
    const fx = f32(x);
    const fz = f32(z);
    const bxz = f32(this.b * fz);
    const sum = f32(this.a * fx + bxz);
    return f32(f32(sum + this.c) * this.f);
  }

  xmin(): number {
    return this.xmn;
  }
  xmax(): number {
    return this.xmx;
  }
  zmin(): number {
    return this.zmn;
  }
  zmax(): number {
    return this.zmx;
  }
  sina(): number {
    return this.sna;
  }
  cosa(): number {
    return this.csa;
  }
  /** Native `barrier::needXSort()` — a hard-coded `false`. */
  needXSort(): boolean {
    return false;
  }
  /** Native's protected `absCurrPosition`, exposed for the probe and for diagnostics. */
  absolutePosition(): LineSegment {
    return this.absCurrPosition;
  }
  currentPosition(): LineSegment {
    return this.currPosition;
  }
  /** The plane coefficients native keeps private, for the probe. */
  plane(): { a: number; b: number; c: number; f: number } {
    return { a: this.a, b: this.b, c: this.c, f: this.f };
  }
  /** Native `gpoly::setcolor` → `gobject::setcolor`, three float stores. */
  setColor(c: Color): void {
    this.color = { r: f32(c.r), g: f32(c.g), b: f32(c.b) };
  }
}

function copySegment(dst: LineSegment, src: LineSegment): void {
  dst.xa = src.xa;
  dst.za = src.za;
  dst.xb = src.xb;
  dst.zb = src.zb;
}
