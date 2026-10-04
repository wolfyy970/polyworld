/**
 * Lane L10 — native `environment/BrickPatch.{h,cc}`.
 *
 * A brick patch is a `Patch` whose `on` flag is re-checked once per step: a rising edge adds
 * `brickCount` bricks, a falling edge removes every brick that points back at this patch. The
 * two edges are the only place the environment takes objects *out* of the world, so the
 * removal walk is where the x-sorted list's cursor semantics matter
 * (`removeCurrentObject()` while walking).
 *
 * PORT-NOTE(L10/brickpatch-removal-leaks): native removes the brick from the printed list and
 * the stage and **never deletes it** (`BrickPatch.cc:96-117`, and `TSimulation`'s teardown
 * has the same comment). The port reproduces that: the removed brick is dropped from the
 * list and the stage and nothing else happens to it. Deleting it would be a silent fix.
 *
 * PORT-NOTE(L10/brickpatch-on-is-constant-in-the-recorded-runs): `on` is a `Dynamic` property
 * in the schema but neither recorded worldfile uses a `dyn(...)` form
 * (`docs/specs/cppprops.md` measured 4 runtime properties and no dynamic patch property), so
 * `updateOn()` never sees an edge there. The setter is exposed so the cppprops lane's binding
 * can drive it.
 */

import { Patch, type DomainLike, type StageLike } from './patch';
import type { Color } from '../types';
import { Brick } from './brick';
import { gXSortedObjects, type XSortedObjects } from './objectXSortedList';
import { GObjectType } from '../types/simconst';

/** Native `class BrickPatch : public Patch` (`BrickPatch.h:24-48`). */
export class BrickPatch extends Patch {
  brickCount = 0;

  private brickColor: Color = { r: 0, g: 0, b: 0 };
  private on = false;
  private onPrev = false;

  constructor(stage: StageLike) {
    super(stage);
  }

  /** Native `BrickPatch::init(...)` (`BrickPatch.cc:31-40`). */
  init(
    color: Color,
    x: number,
    z: number,
    sx: number,
    sz: number,
    numberBricks: number,
    shape: number,
    distrib: number,
    nhsize: number,
    domain: DomainLike,
    domainNumber: number,
    on: boolean,
  ): void {
    this.initBase(x, z, sx, sz, shape, distrib, nhsize, domain, domainNumber);
    this.brickCount = numberBricks;
    this.brickColor = color;
    this.onPrev = false;
    this.on = on;
  }

  /** Native's `on` member, for the cppprops binding. */
  setOn(on: boolean): void {
    this.on = on;
  }
  isOn(): boolean {
    return this.on;
  }
  isOnChanged(): boolean {
    return this.on !== this.onPrev;
  }

  /** Native `BrickPatch::updateOn()` (`BrickPatch.cc:50-62`). */
  updateOn(worldObjects: XSortedObjects = gXSortedObjects): void {
    if (this.on !== this.onPrev) {
      if (this.on) this.addBricks(worldObjects);
      else this.removeBricks(worldObjects);
      this.onPrev = this.on;
    }
  }

  /** Native `BrickPatch::addBricks()` (`BrickPatch.cc:64-81`). */
  private addBricks(worldObjects: XSortedObjects): void {
    for (let i = 0; i < this.brickCount; i++) {
      const b = new Brick(this.brickColor);
      // Native's own new brick draws its position, then the patch overwrites x and z from
      // `setPoint` — both draws happen (the constructor's are simply discarded). The port
      // keeps them: dropping them would move the drand48 stream.
      const { x, z } = this.setPoint();
      b.setx(x);
      b.setz(z);
      b.setPatch(this);
      worldObjects.add(b);
      this.stageRef().addObject(b);
    }
  }

  /** Native `BrickPatch::removeBricks()` (`BrickPatch.cc:83-117`). */
  private removeBricks(worldObjects: XSortedObjects): void {
    worldObjects.reset();
    for (;;) {
      const b = worldObjects.nextObj(GObjectType.BRICK);
      if (b === null) break;
      // `nextObj` leaves the cursor on `b`, which is what `removeCurrentObject` removes.
      if ((b as Brick).getBrickPatch() === this) {
        worldObjects.removeCurrentObject();
        this.stageRef().removeObject(b);
        if (b.beingCarried()) {
          const carrier = b.carriedBy();
          carrier?.dropObject(b);
        }
      }
    }
  }
}
