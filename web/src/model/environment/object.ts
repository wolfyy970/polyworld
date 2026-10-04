/**
 * Lane L10 — the environment's slice of native `graphics/gobject` + `gbox`/`gboxf`.
 *
 * WHY THE SLICE IS HERE
 *
 * `food`, `brick` and `barrier` are `gobject`s: `food`/`brick` are `gboxf`es (an axis-aligned
 * box whose "radius of influence" is the bounding-sphere radius) and `barrier` is a `gpoly`.
 * The full graphics classes are lane L15's (`graphics/**` minus the rasterizer) and are not
 * written yet, so this module carries exactly the `gobject`/`gbox` behaviour the environment
 * classes touch — position, length, the derived radius, colour, object type/number, and the
 * carry state — with the native implementation order preserved. Everything a renderer needs
 * (vertices, materials, `draw()`, scenes, lights) is deliberately absent.
 *
 * PORT-NOTE(L10/gobject-base-is-a-lane-cut): L15 owns `gobject`/`gbox`/`gpoly`. When it lands,
 * one of the two must re-export the other (the same resolution W1e's `src/model/vision/**`
 * duplication needs); this file is the environment's *use* of it, not a second definition of
 * the radius rule. Tracked in PARTS of PARITY.md → Gaps.
 *
 * WHAT MUST NOT BE "CLEANED UP"
 *
 *  - `init()` draws **three `rand()` values** for the default colour and stores each as
 *    `f32( rand() / 32767.0 )` (`gobject.cc:44-47`). Every `food`, `brick` and `barrier`
 *    construction therefore advances the `rand()` stream by three, *before* the subclass sets
 *    its own colour. Dropping it (or merging it into the drand48 stream) changes the whole
 *    downstream draw order — `rand()` is a different generator from `randpw()`/`drand48()`
 *    (see `src/model/types/rng.ts`), and the sim's `srand(1)` is in `sim/Simulation.cc`.
 *    PORT-NOTE(L10/gobject-colour-draws).
 *  - `init()` also runs `setsize( 1., 1., 1. )` (the `gbox` default ctor), so the radius is
 *    computed once before the subclass calls `setlen` — and `setradius()` only recomputes
 *    while `fRadiusFixed` is false (`gbox::setradius`, `gsquare.cc:230-235`).
 *  - `PickedUp` adds the carry offset into the *position* and `Dropped` subtracts it back and
 *    then clamps x to `[0, WorldSize]` and z to `[-WorldSize, 0]` — note the clamp is
 *    asymmetric (`gobject.cc:334-357`).
 */

import { globalRngSurface } from '../rng';
import { boxRadius, f32 } from '../geometry';
import { globals, type Color, type RngSurface } from '../types';
import { GObjectType } from '../types/simconst';

/** Native `graphics/gobject.h` object-type bits, re-exported for the environment's readers. */
export const ObjectTypeBits = GObjectType;

/** The default colour `gobject::init()` draws; kept because it is observable via `rand()`. */
export interface GObjectListLink {
  /** The object this link holds (`gdlink<gobject*>::e`). */
  readonly obj: GoObject;
}

/**
 * Native `class gobject` — the kinematic/identity/carry half of every world object.
 *
 * PORT-NOTE(L10/gobject-rng-injection): native reaches the process-wide `rand()` directly.
 * The port defaults to `globalRngSurface()` (the same stream, same order) and lets a test
 * pass its own surface, which is what makes a food/brick construction reproducible in a unit
 * test without a whole simulation.
 */
export class GoObject {
  /** Native `float fPosition[3]`. */
  readonly position: number[] = [0, 0, 0];
  /** Native `float fAngle[3]` — never read by the environment. */
  readonly angle: number[] = [0, 0, 0];
  /** Native `float fScale`. */
  scale = 1.0;
  /** Native `float fColor[4]` (r, g, b, transparency). */
  readonly color: number[] = [0, 0, 0, 0];
  /**
   * Native `float fRadius` — the radius of influence. **Not the contract**: native spells
   * every consumer `radius()`, and lane L8's `agent` (a `gpolyobj`, not a `GoObject`) has no
   * such field at all — it exposes the method over its own private state. `objectxsortedlist`
   * reads the key through `radius()` for exactly that reason; a field read here is a NaN key
   * for every agent. PORT-NOTE(L10/radius-is-an-accessor).
   */
  fRadius = 0.0;
  /** Native `int objType` — one of the `AGENTTYPE`/`FOODTYPE`/`BRICKTYPE` bits. */
  objType = 0;
  /** Native `unsigned long fTypeNumber`. */
  typeNumber = 0;
  /** Native `gdlink<gobject*> *listLink` — the x-sorted object list's node for this object. */
  listLink: GObjectListLink | null = null;
  /** Native `gObjectList fCarries` — what this object is carrying. */
  readonly carries: GoObject[] = [];

  private carrier: (GoObject & CarrierLike) | null = null;
  private readonly carryOffset: number[] = [0, 0, 0];
  /** Native `bool fRotated` — set by `gobject::rotate()`, read by nothing here. */
  private rotated = false;

  protected constructor(rng: RngSurface = globalRngSurface()) {
    this.init(rng);
  }

  /** Native `gobject::init()` (`gobject.cc:36-56`), including its three `rand()` draws. */
  protected init(rng: RngSurface): void {
    this.rotated = false;
    this.fRadius = 0.0;
    this.position[0] = this.position[1] = this.position[2] = 0.0;
    this.scale = 1.0;
    this.angle[0] = this.angle[1] = this.angle[2] = 0.0;
    this.color[0] = f32(rng.rand() / 32767.0);
    this.color[1] = f32(rng.rand() / 32767.0);
    this.color[2] = f32(rng.rand() / 32767.0);
    this.color[3] = 0.0;
    this.listLink = null;
    this.carrier = null;
    this.typeNumber = 0;
    this.carryOffset[0] = 0.0;
    this.carryOffset[1] = 0.0;
    this.carryOffset[2] = 0.0;
  }

  // --- position (all native float stores) -----------------------------------
  x(): number {
    return this.position[0]!;
  }
  y(): number {
    return this.position[1]!;
  }
  z(): number {
    return this.position[2]!;
  }
  setx(x: number): void {
    this.position[0] = f32(x);
  }
  sety(y: number): void {
    this.position[1] = f32(y);
  }
  setz(z: number): void {
    this.position[2] = f32(z);
  }
  addx(x: number): void {
    this.position[0] = f32(this.position[0]! + x);
  }
  addy(y: number): void {
    this.position[1] = f32(this.position[1]! + y);
  }
  addz(z: number): void {
    this.position[2] = f32(this.position[2]! + z);
  }
  setpos(index: number, p: number): void {
    this.position[index] = f32(p);
  }

  // --- colour ---------------------------------------------------------------
  /** Native `gobject::setcolor( const Color &c )` = `setcol3( &c.r )`. */
  setcolor(c: Color): void {
    this.color[0] = f32(c.r);
    this.color[1] = f32(c.g);
    this.color[2] = f32(c.b);
  }
  setcolorRGBA(r: number, g: number, b: number, t: number): void {
    this.color[0] = f32(r);
    this.color[1] = f32(g);
    this.color[2] = f32(b);
    this.color[3] = f32(t);
  }
  /**
   * Native `gobject::radius()` (`gobject.h:196`) — the radius of influence, read through the
   * accessor the list and the model use. Lane L8's `agent` supplies its own (over private
   * state), so nothing may read `fRadius` directly outside this class and its subclasses.
   * PORT-NOTE(L10/radius-is-an-accessor).
   */
  radius(): number {
    return this.fRadius;
  }
  /** Native `gobject::setradius( float r )` — assigns, does not latch `fRadiusFixed`. */
  setradius(r: number): void {
    this.fRadius = f32(r);
  }

  // --- identity -------------------------------------------------------------
  getType(): number {
    return this.objType;
  }
  setType(type: number): void {
    this.objType = type;
  }
  getTypeNumber(): number {
    return this.typeNumber;
  }
  setTypeNumber(n: number): void {
    this.typeNumber = n;
  }

  // --- carry state ----------------------------------------------------------
  beingCarried(): boolean {
    return this.carrier !== null;
  }
  /**
   * Native `gobject::CarriedBy()`. L8's `CarryableLike` seam (`src/model/agent/contracts.ts`)
   * spells this `carriedBy()`, so that is the name here too.
   */
  carriedBy(): (GoObject & CarrierLike) | null {
    return this.carrier;
  }
  numCarries(): number {
    return this.carries.length;
  }
  /** Native `gobject::IsCarrying( int type )` — a *bit* test against `fCarries`. */
  isCarrying(type: number): boolean {
    for (const o of this.carries) if ((o.getType() & type) !== 0) return true;
    return false;
  }

  /** Native `gobject::PickedUp( gobject *carrier, float dy )` (`gobject.cc:320-331`). */
  pickedUp(carrier: GoObject, dy: number): void {
    this.carrier = carrier as GoObject & CarrierLike;
    this.carryOffset[0] = f32(carrier.x() - this.x());
    this.carryOffset[1] = f32(dy);
    this.carryOffset[2] = f32(carrier.z() - this.z());
    this.position[0] = carrier.x();
    this.position[1] = f32(this.position[1]! + dy);
    this.position[2] = carrier.z();
  }

  /**
   * Native `gobject::Dropped( void )` (`gobject.cc:334-357`), clamps included. It reads
   * `globals::worldsize` itself — the port keeps the signature argument-free for that reason.
   */
  dropped(): void {
    const worldSize = globals.worldsize;
    this.carrier = null;
    this.position[0] = f32(this.position[0]! - this.carryOffset[0]!);
    this.position[1] = f32(this.position[1]! - this.carryOffset[1]!);
    this.position[2] = f32(this.position[2]! - this.carryOffset[2]!);

    if (this.position[0]! < 0.0) this.position[0] = 0.0;
    else if (this.position[0]! > worldSize) this.position[0] = f32(worldSize);

    if (this.position[2]! > 0.0) this.position[2] = 0.0;
    else if (this.position[2]! < -worldSize) this.position[2] = f32(-worldSize);
  }
}

/**
 * Native `gobject::CarriedBy()` needs the carrier's `DropObject` (the environment calls it
 * from `BrickPatch::removeBricks`); that method is `agent`'s and belongs to lane L8, so the
 * environment sees it through this interface. See `src/model/agent/contracts.ts` for L8's
 * side of the cut.
 */
export interface CarrierLike {
  dropObject(obj: GoObject): void;
}

/**
 * Native `class gbox` (`gsquare.h:96-140`) — a box with `fLength[3]`, the derived bounding
 * radius, and the fix/unfix rules.
 */
export class GoBox extends GoObject {
  /** Native `float fLength[3]`. */
  readonly length: number[] = [0, 0, 0];
  protected radiusScale = 1.0;
  protected radiusFixed = false;

  protected constructor(rng: RngSurface = globalRngSurface()) {
    super(rng);
    this.boxInit();
    this.setsize(1.0, 1.0, 1.0);
  }

  /** Native `gbox::init()`. */
  protected boxInit(): void {
    this.radiusFixed = false;
    this.radiusScale = 1.0;
  }

  /** Native `gbox::setsize` / `gbox::setlen`. */
  setsize(lx: number, ly: number, lz: number): void {
    this.length[0] = f32(lx);
    this.length[1] = f32(ly);
    this.length[2] = f32(lz);
    this.deriveRadius();
  }
  setlen(lx: number, ly: number, lz: number): void {
    this.setsize(lx, ly, lz);
  }
  setleni(i: number, l: number): void {
    this.length[i] = f32(l);
    this.deriveRadius();
  }
  setlenx(lx: number): void {
    this.setleni(0, lx);
  }
  setleny(ly: number): void {
    this.setleni(1, ly);
  }
  setlenz(lz: number): void {
    this.setleni(2, lz);
  }
  /** Native `gbox::setradius( float r )` — latches `fRadiusFixed` before `gobject::setradius`. */
  setradius(r: number): void {
    this.radiusFixed = true;
    super.setradius(r);
  }
  setradiusscale(s: number): void {
    this.radiusFixed = false;
    this.radiusScale = f32(s);
    this.deriveRadius();
  }
  setscale(s: number): void {
    this.scale = f32(s);
    this.deriveRadius();
  }

  /**
   * Native `gbox::setradius()` (`gsquare.cc:230-235`): the rule is lane L15's — this slice just
   * reaches for it. `fRadius` is assigned only while the radius is not fixed, and the whole
   * computation (`recordedSquareSum` + `scaledRadius`, `primitives.ts`) stays in that one file.
   */
  protected deriveRadius(): void {
    if (this.radiusFixed) return;
    this.fRadius = boxRadius(this.length, this.radiusScale, this.scale);
  }
}

/**
 * Native `gbox::setradius()`'s rule, **re-exported** from where L15 defines it.
 *
 * PORT-NOTE(L10/gobject-base-is-a-lane-cut): the environment's slice of `gobject`/`gbox`/`gboxf`
 * used to carry its own copy of the radius arithmetic. PARITY.md → Gaps resolved that the way the
 * row prescribes — one of the two re-exports the other — and the *radius rule* is the part that
 * matters (L10's probe pins it for `food`/`brick`, L15's `body.ts` pins the agent's
 * `fCarryRadius`), so it now lives in exactly one place: `src/model/geometry/primitives.ts`,
 * whose `scaledRadius`/`contractedSquareSum`/`recordedSquareSum`/`boxRadius` the environment
 * imports. This name is kept as the environment lane's spelling of `boxRadius` — a re-export,
 * never a second implementation. `GoBox.deriveRadius` above is the only user inside the lane.
 */
export { boxRadius as focusRadius } from '../geometry/primitives';

/** Native `class gboxf` (`gsquare.h:143-152`) — the filled variant `food` and `brick` are. */
export class GoBoxFilled extends GoBox {
  /** Native `gboxf()` sets `fFilled = true` *after* `gbox`'s ctor body has run. */
  filled = false;

  constructor(rng: RngSurface = globalRngSurface()) {
    super(rng);
    this.filled = true;
  }
}
