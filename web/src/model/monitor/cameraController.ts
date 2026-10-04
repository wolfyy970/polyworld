/**
 * Lane L14 — `CameraController` (`library/monitor/CameraController.{h,cc}`): the camera
 * *placement* logic for the three scene types the monitor document can configure, as pure
 * data + arithmetic (no UI, no Windows, no window manager).
 *
 * ```
 * Rotate          orbit the world at (0.5+r·sinθ, h, -0.5+r·cosθ)·worldsize, looking at the
 *                 fixation point; `step()` advances θ by `rate`
 * AgentTracking   park the camera over the tracked agent's (x,z) at 0.2·worldsize, or copy the
 *                 agent's own camera (POV); with no target, back off to (0, 100, 0) at 90°
 * Static          fixed at (0.5·worldsize, h·worldsize, -0.5·worldsize) looking straight down
 * ```
 *
 * Everything this file computes lands in the camera object; **none of it reaches a frozen
 * artifact** (the camera feeds the scene render, i.e. `movie.pmv`, which is Tier C — see
 * PARITY.md). It is nevertheless ported bit-for-bit, because a camera that drifts changes the
 * rendered frame and the movie frame *schedule* is frozen (`MovieSettings`), and because the
 * value written is the value the native writes.
 *
 * PORT-NOTE(monitor/degtorad-is-a-literal): native `utils/misc.h:114` is
 * `#define DEGTORAD 0.017453292` — a **7-digit decimal literal**, not `M_PI/180` and not
 * `M_PI/180.0`. Ported as the literal, because `angle * 0.017453292` and
 * `angle * (Math.PI/180)` differ in the last ulp for many angles, and `float camrad` truncates
 * that difference into the stored angle. Pinned by the camera vectors
 * (`native/vectors/camera.json`, all cases bit-compared).
 *
 * PORT-NOTE(monitor/camera-single-precision-trig): **native calls the C++ `float` overloads of
 * `sin`/`cos`** — and, in the build the vectors came from, LLVM's sincos combine merges the two
 * adjacent calls into the *two-output* entry point `__sincosf_stret`, not a pair of
 * `sinf`/`cosf` calls.** Measured, not assumed, twice:
 *
 *  * compiling a translation unit with `CameraController.cc`'s include chain and flags prints
 *    `sizeof(sin(camrad)) == 4` / `sizeof(cos(camrad)) == 4` while
 *    `sizeof(sin((double)camrad)) == 8` — the argument is a `float`, so the `float` overloads;
 *  * disassembling the shipped `libpolyworld.dylib`'s
 *    `CameraController::setRotationAngle(float)` shows the merge directly:
 *    `fcvt d0, s0` / the double `DEGTORAD` literal / `fmul` / `fcvt s0, d0` (the reduction, in
 *    double, exactly as this file computes it) and then `bl ___sincosf_stret` — whose address
 *    is `sinf + 0x1ac`, the two-output function in the same `libsystem_m` unit, returning
 *    `(sin, cos)` in `s0`/`s1`.
 *
 * `__sincosf_stret` is therefore transcribed like the rest of lane W1d's surface
 * (`../rng/libm.ts#sincosf`, tables in `../rng/appleSinfTable.ts`, C transcription in
 * `../rng/native/raw/apple_sinf_impl.h`, corpus `../rng/native/raw/libm_native_sincosf.txt`
 * captured from the shipped function with `../rng/native/raw/sincosf_census.c`).
 *
 * It is **not** the same function as `cosf`/`sinf`, which is what the 117 recorded camera frames
 * prove: `rotate[3]` frame 3 (`camrad = -1.1122977733612061f`) is `1123315328`, which is
 * `__sincosf_stret`'s cosine (`0x3ee29cc3`); the scalar `cosf` gives `0x3ee29cc2` and lands on
 * `1123315326`.  A port that narrows the *double* result — `Math.fround(Math.cos(camrad))`, what
 * this file used to compute, or the ported double `cos` narrowed the same way — happens to agree
 * with the recorded frame there, but it is not the oracle's algorithm either: over the 5,016
 * float-argument corpora it disagrees with `sinf`/`cosf` on 304 + 135 of them
 * (`../rng/native/README.md` §3d, `tests/rng.test.ts`).
 *
 * PORT-NOTE(monitor/camera-float-narrowing): native computes `radius * sin(camrad)` as a
 * **float** product (both operands are float, and `__sincosf_stret`'s own outputs are the
 * float32s the native multiplies), then adds the *double* literal `0.5`, then multiplies by the
 * float `globals::worldsize` in double, and narrows at the call into
 * `settranslation(float, float, float)`. The port `Math.fround`s at exactly those two points
 * (the product, and the argument) and nowhere else — `sincosf` narrows internally.
 *
 * PORT-NOTE(monitor/camera-object-is-L15s): native holds a `gcamera &` and this file only
 * programs against it. The real `gcamera` is lane L15's (`graphics/**`); the port declares the
 * `ControllerCamera` surface below and never a second camera implementation (the same hazard
 * `PORT-NOTE(vision/camera-scope)` in `src/model/vision/camera.ts` records for the retina).
 * The camera vectors were produced by driving the *native* `CameraController` with a real
 * `gcamera`, so the arithmetic is pinned even though the object is not this lane's.
 *
 * PORT-NOTE(monitor/camera-undefined-mode): native `step()` ends in `default: assert(false)`
 * for `MODE__UNDEFINED`. The recorded native build has assertions **enabled** (measured:
 * `nm -u lib/libpolyworld.dylib` lists `___assert_rtn`), so the native behaviour is an abort,
 * not a silent no-op; the port throws. Same convention W1a froze for `err()+exit(1)`.
 */

import { globals } from '../types';
import { sincosf } from '../rng/libm';
import type { AgentTracker } from './agentTracker';
import type { TrackedAgent, TrackedAgentCamera } from './simSurface';

const f = Math.fround;

/** Native `#define DEGTORAD` — see `PORT-NOTE(monitor/degtorad-is-a-literal)`. */
export const DEGTORAD = 0.017453292;

/** Native `CameraController::Mode` (private in native; exported here so a caller can assert). */
export const CameraControllerMode = {
  UNDEFINED: 0,
  ROTATE: 1,
  AGENT_TRACKING: 2,
  STATIC: 3,
} as const;
export type CameraControllerMode = (typeof CameraControllerMode)[keyof typeof CameraControllerMode];

/** Native `CameraController::AgentTrackingParms::Perspective`. Pinned by `vectors/enums.json`. */
export const Perspective = {
  OVERHEAD: 0,
  POV: 1,
} as const;
export type Perspective = (typeof Perspective)[keyof typeof Perspective];

/**
 * Native `gcamera`, restricted to what this file calls (lane L15 owns the implementation).
 *
 * Names are native's, including the lower-case `settranslation`/`getyaw` next to
 * `SetRotation`/`SetFixationPoint`.
 */
export interface ControllerCamera {
  /** Native `gcamera::SetFixationPoint( x, y, z )` — also switches the camera to look-at mode. */
  SetFixationPoint(x: number, y: number, z: number): void;
  /** Native `gobject::SetRotation( yaw, pitch, roll )` — degrees. */
  SetRotation(yaw: number, pitch: number, roll: number): void;
  /** Native `gobject::settranslation( p0, p1, p2 )`. */
  settranslation(x: number, y: number, z: number): void;
  /** Native `gcamera::AttachTo( gobject* )` — follow this object's inverse transform. */
  AttachTo(obj: unknown): void;

  x(): number;
  y(): number;
  z(): number;
  getyaw(): number;
  getpitch(): number;
  getroll(): number;
}

/** Native `CameraController::RotationParms` (native members are private to the controller). */
export interface RotationParms {
  readonly radius: number;
  readonly height: number;
  readonly rate: number;
  readonly angleStart: number;
  /** Native `float fixationPoint[3]`, already in world units. */
  readonly fixationPoint: readonly [number, number, number];
}

/** Native `CameraController::RotationParms( ... )`. */
export function rotationParms(
  radius: number,
  height: number,
  rate: number,
  angleStart: number,
  fixationPointX: number,
  fixationPointY: number,
  fixationPointZ: number,
): RotationParms {
  return {
    radius: f(radius),
    height: f(height),
    rate: f(rate),
    angleStart: f(angleStart),
    fixationPoint: [f(fixationPointX), f(fixationPointY), f(fixationPointZ)],
  };
}

/** Native `CameraController::AgentTrackingParms`. */
export interface AgentTrackingParms {
  readonly tracker: AgentTracker;
  readonly perspective: Perspective;
}

/** Native `CameraController::AgentTrackingParms( tracker, perspective )`. */
export function agentTrackingParms(tracker: AgentTracker, perspective: Perspective): AgentTrackingParms {
  return { tracker, perspective };
}

/** Native `CameraController::StaticParms`. */
export interface StaticParms {
  readonly height: number;
}

/** Native `CameraController::StaticParms( height )`. */
export function staticParms(height: number): StaticParms {
  return { height: f(height) };
}

export class CameraController {
  private readonly camera: ControllerCamera;

  private mode: CameraControllerMode = CameraControllerMode.UNDEFINED;

  /** Native `struct RotationState { RotationParms parms; float angle; }`. */
  private rotationState: { parms: RotationParms; angle: number } | null = null;

  /** Native `struct AgentTrackingState { AgentTrackingParms parms; }`. */
  private agentTrackingState: { parms: AgentTrackingParms } | null = null;

  constructor(camera: ControllerCamera) {
    this.camera = camera;
  }

  /** Native `CameraController::getAgentTracker()` — non-null only in agent-tracking mode. */
  getAgentTracker(): AgentTracker | null {
    return this.mode === CameraControllerMode.AGENT_TRACKING
      ? (this.agentTrackingState!.parms.tracker ?? null)
      : null;
  }

  getMode(): CameraControllerMode {
    return this.mode;
  }

  /** Native `CameraController::step()`. */
  step(): void {
    switch (this.mode) {
      case CameraControllerMode.ROTATE:
        this.setRotationAngle(f(this.rotationState!.angle + this.rotationState!.parms.rate));
        break;
      case CameraControllerMode.AGENT_TRACKING:
        this.setAgentTrackingTarget();
        break;
      case CameraControllerMode.STATIC:
        break;
      default:
        // Native `assert(false)` with assertions enabled (see the PORT-NOTE above).
        throw new Error('CameraController::step(): camera has no mode (native assert(false))');
    }
  }

  /** Native `CameraController::initRotation( const RotationParms & )`. */
  initRotation(parms: RotationParms): void {
    this.mode = CameraControllerMode.ROTATE;
    this.rotationState = { parms, angle: 0 };

    this.camera.SetFixationPoint(parms.fixationPoint[0], parms.fixationPoint[1], parms.fixationPoint[2]);
    this.camera.SetRotation(0.0, 90.0, 0.0);

    this.setRotationAngle(parms.angleStart);
  }

  /** Native `CameraController::initAgentTracking( const AgentTrackingParms & )`. */
  initAgentTracking(parms: AgentTrackingParms): void {
    this.mode = CameraControllerMode.AGENT_TRACKING;
    this.agentTrackingState = { parms };

    this.setAgentTrackingTarget();
  }

  /** Native `CameraController::initStatic( const StaticParms & )`. */
  initStatic(parms: StaticParms): void {
    this.mode = CameraControllerMode.STATIC;

    this.camera.SetRotation(0.0, -90, 0.0);
    this.camera.settranslation(
      f(0.5 * globals.worldsize),
      f(parms.height * globals.worldsize),
      f(-0.5 * globals.worldsize),
    );
  }

  /** Native `CameraController::setRotationAngle( float angle )`. */
  private setRotationAngle(angle: number): void {
    const parms = this.rotationState!.parms;
    this.rotationState!.angle = angle;

    const camrad = f(angle * DEGTORAD);
    // Native `radius * sin(camrad)` is a float*float product of the *single-precision*
    // transcendentals (see the PORT-NOTE below); `0.5` is a double literal and
    // `globals.worldsize` is a float promoted to double, with the narrowing happening at the
    // `settranslation( float, float, float )` call.
    const [sinRad, cosRad] = sincosf(camrad);
    const sinProduct = f(parms.radius * sinRad);
    const cosProduct = f(parms.radius * cosRad);

    this.camera.settranslation(
      f((0.5 + sinProduct) * globals.worldsize),
      f(parms.height * globals.worldsize),
      f((-0.5 + cosProduct) * globals.worldsize),
    );
  }

  /** Native `CameraController::setAgentTrackingTarget()`. */
  private setAgentTrackingTarget(): void {
    const target: TrackedAgent | null = this.agentTrackingState!.parms.tracker.getTarget();

    if (target !== null) {
      switch (this.agentTrackingState!.parms.perspective) {
        case Perspective.OVERHEAD:
          this.camera.SetRotation(0.0, -90, 0.0);
          this.camera.settranslation(target.x(), f(0.2 * globals.worldsize), target.z());
          break;
        case Perspective.POV: {
          this.camera.AttachTo(target);

          const agentCamera: TrackedAgentCamera = target.getCamera();
          this.camera.settranslation(agentCamera.x(), agentCamera.y(), agentCamera.z());
          this.camera.SetRotation(
            agentCamera.getyaw(),
            agentCamera.getpitch(),
            agentCamera.getroll(),
          );
          break;
        }
        default:
          // Native `assert( false )` on an unknown perspective (assertions enabled; see the
          // file's PORT-NOTE on MODE__UNDEFINED).
          throw new Error(
            `CameraController::setAgentTrackingTarget(): unknown perspective ${String(
              this.agentTrackingState!.parms.perspective,
            )}`,
          );
      }
    } else {
      this.camera.SetRotation(0.0, 90, 0.0);
      this.camera.settranslation(0.0, 100.0, 0.0);
    }
  }
}
