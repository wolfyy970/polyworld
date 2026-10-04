/**
 * Lane W1e — `frustumXZ`: the native XZ culling wedge (`graphics/gmisc.{h,cc}`).
 *
 * `frustumXZ` is what the *model* (not GL) uses to decide whether an object is in front of
 * an agent: `agent::UpdateVision()` builds one per agent per step
 * (`agent.cc:1074`, `fFrustum.Set(pos.x, pos.z, yaw, fovx, maxRadius)`), `TLightList` and
 * `TGraphicObjectList::Draw(fxz)` cull against it, and `monitor` uses the same shape.
 *
 * PORT-NOTE(W1e/frustumxz-is-dead-for-the-retina): the agent's `fFrustum` is written and
 * never read — `agent::GetFrustum()` has no caller and the POV render path draws the whole
 * world list (`docs/specs/vision-spec.md` PN-V4). It is ported anyway because it is the
 * native *culling* semantics L15/L14 need, and because it is cheap: it is six lines of
 * maths with a genuinely surprising corner (below).
 *
 * PORT-NOTE(W1e/frustumxz-angmax-bug): `Set` normalises `angmax` with
 * `if (fabs(angmax) > PI) angmax -= (angmin > 0.0) ? TWOPI : (-TWOPI);` — it tests
 * **`angmin`, which was already rewritten by the previous statement**, not `angmax`
 * (`gmisc.cc:310`). The port reproduces that (PORT_SPEC ground rule 1: port it wrong the
 * same way). The goldens `frustumQ.*` pin the consequences: `Set(0,0,-200,20)` yields
 * `angmax = -9.5993109` (≈ −550°) rather than the "wrapped" 170°, and
 * `Set(0,0,45,360)` yields `angmax = 10.2101765` (≈ 585°). Both are unreachable from agent
 * configuration (`fov ≤ 140`, yaw ∈ [0,360)), which is why they survived: see PARITY.md
 * open questions.
 */

import type { Vec3 } from '../types/geometry';
import { DEGTORAD, PI, TWOPI, f32, nativeAtan2f } from './float';

/** The native `frustumXZ` (x/z apex plus the two edge angles, in radians). */
export class FrustumXZ {
  x0 = 0;
  z0 = 0;
  angmin = 0;
  angmax = 0;

  constructor(x = 0, z = 0, ang = 0, fov = 0, rad?: number) {
    if (rad === undefined) this.set(x, z, ang, fov);
    else this.setAtRadius(x, z, ang, fov, rad);
  }

  /** `frustumXZ::Set(x, z, ang, fov)` — `gmisc.cc:299-315`. */
  set(x: number, z: number, ang: number, fov: number): void {
    this.x0 = f32(x);
    this.z0 = f32(z);
    // all expressions are double in C (DEGTORAD/TWOPI are double, fmod is double) and each
    // assignment to a float member rounds — including the `-=` below, which is a *second*
    // rounding of an already-rounded value
    this.angmin = f32(((ang - 0.5 * fov) * DEGTORAD) % TWOPI);
    if (Math.abs(this.angmin) > PI) {
      this.angmin = f32(this.angmin - (this.angmin > 0.0 ? TWOPI : -TWOPI));
    }

    let angmax = f32(((ang + 0.5 * fov) * DEGTORAD) % TWOPI);
    // native reads the *updated* angmin here (the bug): this.angmin, not angmax
    if (Math.abs(angmax) > PI) angmax = f32(angmax - (this.angmin > 0.0 ? TWOPI : -TWOPI));
    this.angmax = angmax;
  }

  /**
   * `frustumXZ::Set(x, z, ang, fov, rad)` — `gmisc.cc:318-327`: the apex is pushed back
   * along the view direction until a `rad`-radius sphere around the agent is fully inside.
   * The argument is `agent::config.maxRadius` at the one call site.
   */
  setAtRadius(x: number, z: number, ang: number, fov: number, rad: number): void {
    const x1 = x + (rad * Math.sin(ang * DEGTORAD)) / Math.sin(fov * 0.5 * DEGTORAD);
    const z1 = z + (rad * Math.cos(ang * DEGTORAD)) / Math.sin(fov * 0.5 * DEGTORAD);
    this.set(x1, z1, ang, fov);
  }

  /**
   * `frustumXZ::Inside(p)` — `gmisc.cc:333-375`. Returns the native `int` (0/1), not a
   * boolean, because the port's callers count in/out the way the native statics do.
   *
   * The angle is `atan2(x0 - px, z0 - pz)`: measured from **+Z** towards +X, so an object
   * straight down the agent's +Z is `ang = 0` — i.e. the native wedge encodes "the agent
   * looks down −Z" as an agent yaw of 0 with the wedge spanning `[-fov/2, +fov/2]` about
   * `yaw` (vision-spec §5.4).
   */
  inside(p: Vec3): 0 | 1 {
    // `atan2f`, not `atan2`: the native argument types are floats (see nativeAtan2f)
    const ang = nativeAtan2f(this.x0 - p.x, this.z0 - p.z);
    if (this.angmin < this.angmax) {
      if (ang < this.angmin) return 0;
      if (ang > this.angmax) return 0;
      return 1;
    }
    if (ang > this.angmin) return 1;
    if (ang < this.angmax) return 1;
    return 0;
  }
}
