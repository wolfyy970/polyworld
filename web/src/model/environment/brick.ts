/**
 * Lane L10 — native `environment/brick.{h,cc}`.
 *
 * A brick is a `gboxf` of side `brick::gBrickHeight`, coloured by its patch, numbered by a
 * process-wide counter (`brick::NumBricks`, which is `brick::GetNumBricks()` — the test
 * `sim/Simulation.cc`'s solid-object pass makes) and positioned by the *brick patch* that
 * created it. Its radius comes from `gbox::setradius()` (all three lengths), **not** from
 * `food`'s x/z-only override — both use `sqrt`, and the two differ by `fLength[1]`.
 *
 * PORT-NOTE(L10/brick-argument-evaluation-order): native's convenience constructor is
 * `initBrick( color, randpw() * globals::worldsize, randpw() * globals::worldsize )`. C++
 * leaves the evaluation order of *function arguments* unspecified, so which of the two
 * `drand48()` draws becomes `x` and which becomes `z` is a property of the compiler, not of
 * the source. The port fixes it to the order the recorded oracle binary used; the probe's
 * `brick.draws*` fixtures pin it (a swap would move every brick in the world).
 *
 * PORT-NOTE(L10/brick-pickup-is-dead): `brick::pickup( float e )` is *declared* in
 * `brick.h:51` and defined **nowhere** in the tree, and nothing calls it (verified by grep
 * over the whole native source). It is therefore not ported — a port of it would be an
 * invention, and there is no call site for it to be faithful to.
 */

import { globalRngSurface } from '../rng';
import { f32 } from '../geometry';
import { globals, type Color, type RngSurface } from '../types';
import { GObjectType } from '../types/simconst';
import { GoBoxFilled } from './object';
import type { BrickPatch } from './brickPatch';

/** Native `class brick : public gboxf` (`brick.h:21-61`). */
export class Brick extends GoBoxFilled {
  /** Native `static float brick::gBrickHeight` — written by `processWorldFile`. */
  static gBrickHeight = 0.0;
  /** Native `static float brick::gBrickRadius` — derived in `InitBrickClass`. */
  static gBrickRadius = 0.0;
  /** Native `static float brick::gCarryBrick2Energy`. */
  static gCarryBrick2Energy = 0.0;

  private static numBricks = 0;
  private static brickClassInited = false;

  private myBrickPatch: BrickPatch | null = null;

  /** Native `brick::GetNumBricks()` — the live brick count (`unsigned long`). */
  static GetNumBricks(): number {
    return Brick.numBricks;
  }

  /** Test/simulation hook (native's statics live for the process). */
  static resetBrickClass(): void {
    Brick.numBricks = 0;
    Brick.brickClassInited = false;
    Brick.gBrickRadius = 0.0;
  }

  /**
   * Native's two constructors:
   *   `brick( Color color )`              — position drawn from `randpw() * WorldSize`
   *   `brick( Color color, float x, float z )`
   *
   * `xOrRng` is a number for the second native form and an `RngSurface` for the first; the
   * surface is injectable so a lane test can drive the draws (native reads the global).
   */
  constructor(color: Color, xOrRng?: number | RngSurface, z?: number, rng?: RngSurface) {
    const surface = typeof xOrRng === 'object' ? xOrRng : (rng ?? globalRngSurface());
    super(surface);
    if (typeof xOrRng === 'number' && typeof z === 'number') {
      this.initBrickAt(color, f32(xOrRng), f32(0.5 * Brick.gBrickHeight), f32(z));
    } else {
      // The two draws, in the order the oracle binary evaluated them (see the PORT-NOTE).
      const dx = f32(surface.drand48() * globals.worldsize);
      const dz = f32(surface.drand48() * globals.worldsize);
      this.initBrickAt(color, dx, f32(0.5 * Brick.gBrickHeight), dz);
    }
  }

  /** Native `brick::initBrick( color, x, y, z )` (`brick.cc:113-133`). */
  private initBrickAt(color: Color, x: number, y: number, z: number): void {
    if (!Brick.brickClassInited) Brick.InitBrickClass();

    Brick.numBricks++;

    this.setType(GObjectType.BRICK);
    this.setTypeNumber(Brick.numBricks);

    this.position[0] = f32(x);
    this.position[1] = f32(y);
    this.position[2] = f32(z);

    this.setlen(Brick.gBrickHeight, Brick.gBrickHeight, Brick.gBrickHeight);

    this.setcolor(color);
  }

  /**
   * Native `brick::InitBrickClass()` (`brick.cc:138-148`):
   * `gBrickRadius = 0.5 * sqrt( 2.0 ) * gBrickHeight` — double arithmetic (`sqrt(2.0)`,
   * `0.5`, and the `gBrickHeight` promotion), narrowed once on the store into a `float`.
   */
  private static InitBrickClass(): void {
    if (Brick.brickClassInited) return;
    Brick.brickClassInited = true;
    Brick.numBricks = 0;
    Brick.gBrickRadius = f32(0.5 * Math.sqrt(2.0) * Brick.gBrickHeight);
  }

  /** Native `brick::dump( ostream & )` — position only. */
  dump(): string {
    return `${this.position[0]} ${this.position[1]} ${this.position[2]}\n`;
  }

  /** Native `brick::setPatch( BrickPatch* )`. */
  setPatch(bp: BrickPatch | null): void {
    this.myBrickPatch = bp;
  }
  /** Native's `myBrickPatch` is public. */
  getBrickPatch(): BrickPatch | null {
    return this.myBrickPatch;
  }
}
