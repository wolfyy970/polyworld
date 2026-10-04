/**
 * Lane W1e — golden-vector tests for the geometry primitives.
 *
 * Every number asserted here comes from `src/model/geometry/golden/nativeCameraVectors.ts`,
 * which is generated from the **native** code path (`src/model/geometry/native/glprobe.sh`):
 * the real `gcamera` / `gpoint` / `gpolyobj` / `frustumXZ` objects linked out of the native
 * build's `libpolyworld.dylib`, driving the same fixed-function GL (Apple OpenGL 2.1 + GLU
 * 1.3) the oracle binary links. Nothing in this file hardcodes a value the port produced.
 *
 * Four kinds of assertion, deliberately distinct:
 *
 *   1. **bit-exact** (`expectF32`) — the port reproduces the native float32 pattern, ±0
 *      aside (GL's matrix builders leave `-0` where an exact product leaves `+0`; the values
 *      are identical, so the comparison treats the two zeros as equal: `float.ts` PORT-NOTE).
 *   2. **≤N ulp** (`expectF32Within`) — entries the goldens leave a rounding step open: GLU's
 *      `m[0][0]`/`m[2][2]` division path, and the modelview translation column, whose value is
 *      a difference of large products whose composition rounding the driver's internal matrix
 *      path hides. Bounds are per case and small.
 *   3. **absolute bound near zero** (`expectModelview`) — modelview entries that are pure
 *      cancellation noise (`|golden| < 1e-4`, e.g. 1.3e-08): they land ±1e-8 either side of
 *      zero depending on the composition path.
 *   4. **self-consistent** — properties the goldens imply but do not tabulate: the frustum
 *      planes must classify points the same way the clip matrix does, the ray helpers must
 *      agree with analytic values, the radius machinery must follow the native fix/unfix
 *      rules, and every branch the oracle exercises must actually be entered.
 *
 * The residuals are carried as open questions in PARITY.md.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AGENT_OBJ_NUM_POLYGONS,
  AGENT_OBJ_TEXT,
  AgentBodyGeometry,
  BODY_GOLDEN_ENVIRONMENT,
  Camera,
  FrustumXZ,
  GOLDEN_BOOLS,
  GOLDEN_CAMERA_FIXES,
  GOLDEN_CAMERA_USES,
  GOLDEN_ENVIRONMENT,
  GOLDEN_F32,
  GOLDEN_F64,
  GOLDEN_FRUSTUM_CASES,
  GOLDEN_FRUSTUM_INSIDE,
  GOLDEN_FRUSTUM_RADII,
  GOLDEN_MAT4,
  GOLDEN_OBJECT_POSES,
  GOLDEN_PERSPECTIVES,
  GOLDEN_POLYOBJ,
  GOLDEN_ROTATEF,
  GOLDEN_SCENES,
  GOLDEN_TRANSLATE,
  NATIVE_AGENT_BODIES,
  NATIVE_BODY_CONFIG,
  NATIVE_BODY_TEMPLATE,
  PolyObj,
  PolyObjFormatError,
  agentBodyTemplate,
  boundsOfPolygons,
  colorToByte,
  composeMatrix,
  createAgentBodyGeometry,
  eyePositionFromModelview,
  f32,
  f32Bits,
  f32UlpDistance,
  frustumPlanes,
  matrixEquals,
  nativeAtan2f,
  objectMatrix,
  parsePolyObjFile,
  perspectiveMatrix,
  planeDistance,
  pointInFrustum,
  rayBounds,
  rayPlane,
  raySphere,
  rotationMatrix,
  scaleMatrix,
  sphereFromBounds,
  sphereFromRadius,
  spheresOverlap,
  transformPoint3,
  translationMatrix,
  vec3,
  type GoldenScene,
} from '../src/model/geometry';
import { f32Fma } from '../src/model/agent/numeric';
import type { Vec3 } from '../src/model/types/geometry';


function f32BitsHex(v: number): string {
  return f32Bits(v).toString(16).padStart(8, '0');
}

/** Bit-exact f32 equality, ignoring the sign of zero (see the file header). */
function expectF32(actual: number, golden: number, what = ''): void {
  const a = f32(actual);
  if (!(a === golden)) {
    throw new Error(`${what}: got ${a} (0x${f32BitsHex(a)}), want ${golden} (0x${f32BitsHex(golden)})`);
  }
}

function expectF32Array(actual: readonly number[], golden: readonly number[], what = ''): void {
  expect(actual.length, `${what}: length`).toBe(golden.length);
  actual.forEach((v, i) => expectF32(v, golden[i] as number, `${what}[${i}]`));
}

/** f32 equality within `maxUlps` steps. */
function expectF32Within(actual: number, golden: number, maxUlps: number, what = ''): void {
  const d = f32UlpDistance(actual, golden);
  if (!(d <= maxUlps)) {
    throw new Error(
      `${what}: got ${f32(actual)} (0x${f32BitsHex(actual)}), want ${golden} (0x${f32BitsHex(golden)}), ${d} ulp apart`,
    );
  }
}

/** The modelview policy: bit-exact, except the translation column (≤1 ulp: the composition's
 *  per-term rounding on a difference of large products — see `W1e/compose-rounding`) and the
 *  cancellation-noise entries (absolute bound; the one case that produces them is the
 *  both-pitch-and-yaw camera, `PORT-NOTE(vision/pitch-yaw-residual)`). */
function expectModelview(actual: readonly number[], golden: readonly number[], what: string): void {
  expect(actual.length, `${what}: length`).toBe(golden.length);
  for (let i = 0; i < 16; i++) {
    const g = golden[i] as number;
    const a = f32(actual[i] as number);
    if (i === 12 || i === 13 || i === 14) {
      expectF32Within(a, g, 1, `${what}[${i}] (translation column)`);
    } else if (Math.abs(g) < 1e-4) {
      expect(Math.abs(a - g), `${what}[${i}] (near-zero entry)`).toBeLessThan(1e-6);
    } else {
      expectF32(a, g, `${what}[${i}]`);
    }
  }
}

/** The probe wrote its projection keys with `%.6g` for the fov/aspect and plain literals. */
const fmtProbe = (v: number): string => (v === 0.00001 ? '1e-05' : String(Number(v.toFixed(6))));

const PLANE_NAMES = ['left', 'right', 'bottom', 'top', 'near', 'far'] as const;

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

describe('golden provenance', () => {
  it('was recorded on the same GL implementation the native build links', () => {
    // guards against a golden file regenerated somewhere else: a different GL implementation
    // would silently move the low bits of every matrix
    expect(GOLDEN_ENVIRONMENT.glVersion).toMatch(/^2\.1/);
    expect(GOLDEN_ENVIRONMENT.gluVersion).toMatch(/^1\.3/);
    expect(GOLDEN_SCENES.length).toBeGreaterThanOrEqual(5);
    expect(GOLDEN_ROTATEF.length).toBe(18);
    expect(GOLDEN_PERSPECTIVES.length).toBe(7);
    expect(GOLDEN_OBJECT_POSES.length).toBe(4);
    expect(GOLDEN_FRUSTUM_CASES.length).toBe(6);
    expect(GOLDEN_FRUSTUM_RADII.length).toBe(3);
    expect(GOLDEN_CAMERA_USES.length).toBe(1);
    expect(GOLDEN_CAMERA_FIXES.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GL primitives: translate / rotatef / gluPerspective
// ---------------------------------------------------------------------------

describe('gl primitives', () => {
  it('glTranslatef matches bit-for-bit', () => {
    const t = GOLDEN_TRANSLATE[0] as { x: number; y: number; z: number };
    expectF32Array(translationMatrix(t.x, t.y, t.z), GOLDEN_MAT4['gl.translate'] as readonly number[], 'translate');
  });

  it('glRotatef matches bit-for-bit for every recorded axis/angle', () => {
    for (const { axis, degrees } of GOLDEN_ROTATEF) {
      const key = `gl.rotatef.${axis}.${degrees}`;
      const golden = GOLDEN_MAT4[key];
      expect(golden, `missing golden ${key}`).toBeDefined();
      expectF32Array(rotationMatrix(axis, degrees), golden as readonly number[], key);
    }
  });

  it('glRotatef uses float trigonometry, not double (cos 90° is -4.37e-08, not 6.1e-17)', () => {
    const m = rotationMatrix('y', 90);
    expectF32(m[0] as number, (GOLDEN_MAT4['gl.rotatef.y.90'] as readonly number[])[0] as number, 'cos90');
    expect(m[0] as number).toBeCloseTo(-4.371138828673793e-8, 14);
    expect(Math.abs((m[0] as number) - Math.cos(Math.PI / 2))).toBeGreaterThan(1e-9);
  });

  it('gluPerspective matches the native projection entries', () => {
    for (const { fov, aspect, near, far } of GOLDEN_PERSPECTIVES) {
      const key = `gl.gluPerspective.${fmtProbe(fov)}.${fmtProbe(aspect)}.${fmtProbe(near)}.${fmtProbe(far)}`;
      const golden = GOLDEN_MAT4[key];
      expect(golden, `missing golden ${key}`).toBeDefined();
      const got = perspectiveMatrix(fov, aspect, near, far);
      const g = golden as readonly number[];
      expectF32(got[5] as number, g[5] as number, `${key}.m11`);
      expectF32(got[10] as number, g[10] as number, `${key}.m22`);
      expectF32(got[11] as number, g[11] as number, `${key}.m23`);
      expectF32(got[14] as number, g[14] as number, `${key}.m32`);
      // m00 is bit-exact too, now that the near-plane entries use the f32 **reciprocal** of the
      // frustum width (PORT-NOTE `W1e/glu-perspective-reciprocal`): the division form this
      // assertion used to leave 1 ulp open missed aspect 5 (`0x40124dfe` vs `0x40124dff`) as soon
      // as the near was the camera's float rather than a double literal.
      expectF32(got[0] as number, g[0] as number, `${key}.m00`);
    }
  });

  it('pins the float tangent: GL rounds tan(fov/2) to f32 before the reciprocal', () => {
    const golden = GOLDEN_MAT4['gl.gluPerspective.10.8.0.01.37.5'] as readonly number[];
    const floatTangent = f32(1 / f32(Math.tan(((10 * 0.5 * Math.PI) / 180) as number)));
    expectF32(floatTangent, golden[5] as number, 'm11 from the float tangent');
    // the double-precision value is exactly one ulp away — the goldens pick the float one
    expect(f32UlpDistance(1 / Math.tan((10 * 0.5 * Math.PI) / 180), golden[5] as number)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// gcamera
// ---------------------------------------------------------------------------

describe('gcamera', () => {
  it('keeps the native constructor defaults', () => {
    const cam = new Camera();
    expect(cam.fov).toBe(90);
    expect(cam.aspect).toBe(0);
    expect(cam.near).toBe(0.00001);
    expect(cam.far).toBe(10000);
    expect(cam.perspectiveInUse).toBe(false);
    expect(cam.followObject).toBeNull();
    expect(cam.usingLookAt).toBe(false);
  });

  it('Use() reproduces the native projection + modelview for an unattached camera', () => {
    for (const cfg of GOLDEN_CAMERA_USES) {
      const cam = new Camera();
      cam.setFOV(cfg.fov);
      cam.setAspect(cfg.aspect);
      cam.setNear(cfg.near);
      cam.setFar(cfg.far);
      cam.setTranslation(cfg.x, cfg.y, cfg.z);
      const view = cam.use();
      const wantProj = GOLDEN_MAT4[`${cfg.name}.projection`] as readonly number[];
      expect(wantProj, `missing ${cfg.name}.projection`).toBeDefined();
      expectF32((view.projection as number[])[0] as number, wantProj[0] as number, `${cfg.name}.projection.m00`);
      // m22 keeps its 1-ulp bound: measured, the port's depth form reproduces every *scene* and
      // every `gl.gluPerspective` fixture bit-exactly but lands 1 ulp off the two recorded
      // unattached-camera matrices (`0xbf810101` vs `0xbf810102` here, `0xbf884211` vs
      // `0xbf884210` for `fixPerspective`) — a residual neither the division nor the reciprocal
      // form reproduced, and PARITY.md *Open questions* 3 already carries it.
      expectF32Within((view.projection as number[])[10] as number, wantProj[10] as number, 1, `${cfg.name}.projection.m22`);
      for (const i of [5, 11, 14]) {
        expectF32((view.projection as number[])[i] as number, wantProj[i] as number, `${cfg.name}.projection[${i}]`);
      }
      expectF32Array(view.modelview as number[], GOLDEN_MAT4[`${cfg.name}.modelview`] as readonly number[], `${cfg.name}.modelview`);
      expect(cam.perspectiveInUse).toBe(true);
    }
  });

  it('FixPerspective sets the aspect from pixels, latches the projection, and Use() keeps it', () => {
    for (const cfg of GOLDEN_CAMERA_FIXES) {
      const cam = new Camera();
      cam.setFOV(cfg.fov);
      cam.setNear(cfg.near);
      cam.setFar(cfg.far);
      cam.fixPerspective(true, cfg.width, cfg.height);
      expectF32(cam.aspect, f32(f32(cfg.width) / f32(cfg.height)), 'aspect from pixels');

      const projKey = `${cfg.name}.projection`;
      const wantProj = GOLDEN_MAT4[projKey] as readonly number[];
      const proj = cam.use().projection as number[];
      expectF32(proj[5] as number, wantProj[5] as number, `${projKey}.m11`);
      expectF32(proj[11] as number, wantProj[11] as number, `${projKey}.m23`);
      expectF32(proj[14] as number, wantProj[14] as number, `${projKey}.m32`);
      // m00 is bit-exact (the f32 reciprocal of the frustum width); m22 keeps the same 1-ulp
      // residual as the unattached-camera `Use()` case above.
      expectF32(proj[0] as number, wantProj[0] as number, `${projKey}.m00`);
      expectF32Within(proj[10] as number, wantProj[10] as number, 1, `${projKey}.m22`);

      cam.setTranslation(cfg.x, cfg.y, cfg.z);
      const view = cam.use();
      expectF32Array(view.modelview as number[], GOLDEN_MAT4[`${cfg.name}.modelview`] as readonly number[], `${cfg.name}.modelview`);
      // UpdatePerspective() does nothing while fPerspectiveFixed, so the latched projection is
      // still the one FixPerspective applied (the golden records it after the second Use())
      expectF32Within(
        (view.projection as number[])[10] as number,
        wantProj[10] as number,
        1,
        `${cfg.name}.projectionAfterUse.m22`,
      );
      expectF32(
        (view.projection as number[])[5] as number,
        wantProj[5] as number,
        `${cfg.name}.projectionAfterUse.m11`,
      );
      expect(matrixEquals(view.projection, GOLDEN_MAT4[`${cfg.name}.projection`] as readonly number[])).toBe(false);
    }
  });

  it('reports the same PerspectiveSet() latch the native camera does', () => {
    for (const key of ['gcamera.use65_aspect1.perspectiveSet', 'gcamera.fixPerspective.perspectiveSet']) {
      expect(GOLDEN_BOOLS[key]).toEqual([true]);
    }
    const cam = new Camera();
    expect(cam.perspectiveInUse).toBe(false);
    cam.use();
    expect(cam.perspectiveInUse).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the agent POV camera (agent::SetGraphics / agent::UpdateVision)
// ---------------------------------------------------------------------------

/** Drive the port from a golden scene config exactly as the probe drove the native camera. */
function buildAgentCamera(scene: GoldenScene): { cam: Camera; fovx: number; aspect: number } {
  const cam = new Camera();
  const { fovx, aspect } = cam.configureAgentPov({
    focus: scene.focus,
    minFocus: scene.minFocus,
    maxFocus: scene.maxFocus,
    invertFocus: false,
    agentFOV: scene.agentFOV,
    retinaWidth: scene.retinaWidth,
    retinaHeight: scene.retinaHeight,
    eyeHeight: scene.eyeHeight,
    agentHeight: scene.agentHeight,
    fLengthZ: scene.fLengthZ,
    worldSize: scene.worldSize,
    enableVisionPitch: scene.enablePitch,
    visionPitch: scene.visionPitch,
    minVisionPitch: -7.5,
    maxVisionPitch: 7.5,
    enableVisionYaw: scene.enableYaw,
    visionYaw: scene.visionYaw,
    minVisionYaw: -90,
    maxVisionYaw: 90,
  });
  cam.attachTo({
    position: vec3(scene.agentX, scene.agentY, scene.agentZ),
    angles: vec3(scene.agentYaw, 0, 0),
    rotated: true,
  });
  return { cam, fovx, aspect };
}

describe('agent POV camera (fixed scene configs from the oracle world)', () => {
  it('reproduces every recorded scene', () => {
    for (const scene of GOLDEN_SCENES) {
      const { cam, fovx, aspect } = buildAgentCamera(scene);

      expectF32(fovx, (GOLDEN_F32[`${scene.name}.fovx`] as readonly number[])[0] as number, `${scene.name}.fovx`);
      expectF32(aspect, (GOLDEN_F32[`${scene.name}.aspect`] as readonly number[])[0] as number, `${scene.name}.aspect`);
      expectF32(cam.getFOV(), (GOLDEN_F32[`${scene.name}.fov`] as readonly number[])[0] as number, `${scene.name}.fov`);
      expectF32(cam.near, f32(0.01), `${scene.name}.near`);
      expectF32(cam.far, f32(1.5 * scene.worldSize), `${scene.name}.far`);
      expectF32(
        aspect,
        f32(f32(f32(fovx) * f32(scene.retinaHeight)) / f32(f32(scene.agentFOV) * f32(scene.retinaWidth))),
        `${scene.name}.aspect formula`,
      );

      const view = cam.use();
      const wantProj = GOLDEN_MAT4[`gl.obj->${scene.name}.projection`] as readonly number[];
      const wantMv = GOLDEN_MAT4[`gl.obj->${scene.name}.modelview`] as readonly number[];
      // every entry the scene cameras produce is pinned bit-exactly: the near-plane entries via
      // the f32 reciprocal (`W1e/glu-perspective-reciprocal`) and the depth entries via the f32
      // numerator over the double plane delta (`W1e/glFrustum-float-delta`).
      expectF32((view.projection as number[])[0] as number, wantProj[0] as number, `${scene.name}.m00`);
      expectF32((view.projection as number[])[10] as number, wantProj[10] as number, `${scene.name}.m22`);
      for (const i of [5, 11, 14]) {
        expectF32((view.projection as number[])[i] as number, wantProj[i] as number, `${scene.name}.proj[${i}]`);
      }
      expectModelview(view.modelview as number[], wantMv, `${scene.name}.mv`);

      // the camera's world eye point: the probe recovered it by inverting GL's own f32
      // matrix, so it carries that inversion's error — compare with a tolerance
      const eye = view.eyeWorld as Vec3;
      const wantEye = GOLDEN_F64[`${scene.name}.eyeWorld`] as readonly number[];
      expect(eye).not.toBeNull();
      (['x', 'y', 'z'] as const).forEach((k, i) => {
        expect(Math.abs(eye[k] - (wantEye[i] as number)), `${scene.name}.eyeWorld.${k}`).toBeLessThan(1e-5);
      });
    }
  });

  it('the POV eye sits at the agent position on the nose plane (vision-spec §5.1)', () => {
    const scene = GOLDEN_SCENES.find((s) => s.name === 'world100_origin') as GoldenScene;
    const { cam } = buildAgentCamera(scene);
    const view = cam.use();
    const eye = view.eyeWorld as Vec3;
    expectF32(eye.y, f32(0.1), 'eye.y');     // 0.5*agentHeight, EyeHeight 0.5 => no y offset
    expectF32(eye.z, f32(-0.25), 'eye.z');   // -0.5*fLengthZ, yaw 0 => straight down -Z
    expectF32(eye.x, 0, 'eye.x');
  });

  it('applies vision pitch/yaw only when enabled, in the native order', () => {
    const scene = GOLDEN_SCENES.find((s) => s.name === 'vision_pitch_yaw') as GoldenScene;
    expect(scene.enablePitch && scene.enableYaw).toBe(true);
    const { cam } = buildAgentCamera(scene);
    // raw nerve 0.25 over [-7.5,7.5] -> -3.75°; raw 0.75 over [-90,90] -> +45°
    expectF32(cam.angles.y, -3.75, 'pitch');
    expectF32(cam.angles.x, 45, 'yaw');
    const view = cam.use();
    expectModelview(view.modelview as number[], GOLDEN_MAT4[`gl.obj->${scene.name}.modelview`] as readonly number[], 'mv');
  });

  it('leaves pitch/yaw alone when the flags are off (the minitest configuration)', () => {
    const scene = GOLDEN_SCENES.find((s) => s.name === 'minitest_a10_focus_mid') as GoldenScene;
    const cam = new Camera();
    cam.configureAgentPov({
      focus: scene.focus,
      minFocus: scene.minFocus,
      maxFocus: scene.maxFocus,
      invertFocus: false,
      agentFOV: scene.agentFOV,
      retinaWidth: scene.retinaWidth,
      retinaHeight: scene.retinaHeight,
      eyeHeight: scene.eyeHeight,
      agentHeight: scene.agentHeight,
      fLengthZ: scene.fLengthZ,
      worldSize: scene.worldSize,
      enableVisionPitch: false,
      visionPitch: 1,
      minVisionPitch: -7.5,
      maxVisionPitch: 7.5,
      enableVisionYaw: false,
      visionYaw: 1,
      minVisionYaw: -90,
      maxVisionYaw: 90,
    });
    expect(cam.angles.x).toBe(0);
    expect(cam.angles.y).toBe(0);
  });

  it('computes the focus -> horizontal FOV mapping of agent::FieldOfView', () => {
    expectF32(Camera.horizontalFovForFocus(0, 20, 140, false), 20, 'focus 0');
    expectF32(Camera.horizontalFovForFocus(1, 20, 140, false), 140, 'focus 1');
    expectF32(Camera.horizontalFovForFocus(0.5, 20, 140, false), 80, 'focus 0.5');
    expectF32(Camera.horizontalFovForFocus(0.5, 20, 140, true), 80, 'inverted mid');
    expectF32(Camera.horizontalFovForFocus(1, 20, 140, true), 20, 'inverted 1');
    expectF32(Camera.horizontalFovForFocus(0, 20, 140, true), 140, 'inverted 0');
  });
});

// ---------------------------------------------------------------------------
// object transforms
// ---------------------------------------------------------------------------

describe('object transforms (gobject::position + glScalef)', () => {
  it('matches the native pushed matrix for every recorded pose', () => {
    for (const pose of GOLDEN_OBJECT_POSES) {
      const m = objectMatrix(
        vec3(pose.x, pose.y, pose.z),
        vec3(pose.yaw, pose.pitch, pose.roll),
        pose.scale,
        pose.setRotation,
      );
      const golden = GOLDEN_MAT4[pose.name] as readonly number[];
      expect(golden, `missing golden ${pose.name}`).toBeDefined();
      expectF32Array(m, golden, pose.name);
    }
  });

  it('keeps the native fRotated switch (an unrotated gobject ignores its angles)', () => {
    const unrotated = objectMatrix(vec3(5, 2, 0), vec3(0, 0, 0), 0.5, false);
    const rotatedZero = objectMatrix(vec3(5, 2, 0), vec3(0, 0, 0), 0.5, true);
    expectF32Array(unrotated, GOLDEN_MAT4['obj.unrotated'] as readonly number[], 'unrotated');
    expectF32Array(rotatedZero, GOLDEN_MAT4['obj.rotated_zero_angles'] as readonly number[], 'rotated-zero');
  });

  it('composeMatrix folds a GL call sequence left to right, as GL post-multiplies', () => {
    const combined = composeMatrix(translationMatrix(1, 0, 0), rotationMatrix('y', 90), scaleMatrix(2));
    const manual = objectMatrix(vec3(1, 0, 0), vec3(90, 0, 0), 2, true);
    expect(matrixEquals(combined, manual)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// frustumXZ
// ---------------------------------------------------------------------------

describe('frustumXZ', () => {
  const probes = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1), vec3(-1, 0, -1), vec3(3, 0, -4)];

  it('reproduces the native wedge for every recorded case (including the angmax bug)', () => {
    let sawWrapped = false;
    for (const c of GOLDEN_FRUSTUM_CASES) {
      const f = new FrustumXZ();
      f.set(c.x, c.z, c.ang, c.fov);
      const golden = GOLDEN_F32[c.name];
      expect(golden, `missing golden ${c.name}`).toBeDefined();
      expectF32Array([f.x0, f.z0, f.angmin, f.angmax], golden as readonly number[], c.name);
      const inside = GOLDEN_FRUSTUM_INSIDE[c.name];
      expect(inside, `missing inside golden ${c.name}`).toBeDefined();
      (inside as readonly boolean[]).forEach((want, i) => {
        expect(f.inside(probes[i] as Vec3), `${c.name}.inside[${i}]`).toBe(want ? 1 : 0);
      });
      if (f.angmin > f.angmax) sawWrapped = true;
    }
    expect(sawWrapped, 'the wrapped (angmin > angmax) branch must be exercised').toBe(true);
  });

  it('reproduces the radius overload (apex pushed back by rad/sin(fov/2))', () => {
    for (const c of GOLDEN_FRUSTUM_RADII) {
      const f = new FrustumXZ();
      f.setAtRadius(c.x, c.z, c.ang, c.fov, c.rad);
      expectF32Array([f.x0, f.z0, f.angmin, f.angmax], GOLDEN_F32[c.name] as readonly number[], c.name);
    }
  });

  it('pins the latent angmax bug: Set(0,0,-200,20) writes -550°, not the wrapped 170°', () => {
    const f = new FrustumXZ();
    f.set(0, 0, -200, 20);
    const golden = GOLDEN_F32['frustumQ.neg200_fov20'] as readonly number[];
    expectF32(f.angmin, golden[2] as number, 'angmin');   // correctly wrapped to +150°
    expectF32(f.angmax, golden[3] as number, 'angmax');   // the bug: -550°
    expect(f.angmax).toBeLessThan(-9);
  });

  it('pins the atan2f π case, which decides a boundary probe of frustumQ.yaw90_fov180', () => {
    // arm64 atan2f returns 0x40490FDA for exact ±π; the correctly rounded f32 of the double
    // result is 0x40490FDB, and that one ulp classifies the probe point the other way
    expect(nativeAtan2f(0, -1)).toBe(3.1415925025939941);
    expect(nativeAtan2f(-0, -1)).toBe(-3.1415925025939941);
    expect(f32(Math.atan2(0, -1))).not.toBe(nativeAtan2f(0, -1));
    const f = new FrustumXZ();
    f.set(0, 0, 90, 180);
    const golden = GOLDEN_F32['frustumQ.yaw90_fov180'] as readonly number[];
    expectF32(f.angmax, golden[3] as number, 'angmax');
    expect(f.inside(vec3(0, 0, 1))).toBe(1);
    expect(f.inside(probes[1] as Vec3)).toBe(0);
  });

  it('uses the agent yaw/focus of UpdateVision at the one real call site', () => {
    const scene = GOLDEN_SCENES.find((s) => s.name === 'minitest_a10_focus_mid') as GoldenScene;
    const f = new FrustumXZ();
    f.set(scene.agentX, scene.agentZ, scene.agentYaw, 80);
    expectF32Array(
      [f.x0, f.z0, f.angmin, f.angmax],
      GOLDEN_F32[`${scene.name}.frustumXZ`] as readonly number[],
      `${scene.name}.frustumXZ`,
    );
  });

  it('is centred on the agent yaw with its apex at the agent position', () => {
    const f = new FrustumXZ();
    f.set(0, 0, 0, 90);
    expect(f.inside(vec3(0, 0, -5))).toBe(1);   // straight down -Z: ang = atan2(0, 5) = 0
    expect(f.inside(vec3(0, 0, 5))).toBe(0);    // behind: ang = atan2(0, -5) = ±π
  });
});

// ---------------------------------------------------------------------------
// frustum planes (derived from the golden matrices)
// ---------------------------------------------------------------------------

describe('frustum planes', () => {
  it('reproduces the planes the probe derived from GL\u2019s own matrices', () => {
    for (const scene of GOLDEN_SCENES) {
      const { cam } = buildAgentCamera(scene);
      const planes = cam.use().frustum.planes;
      PLANE_NAMES.forEach((name, i) => {
        const key = `${scene.name}.worldPlanes.${name}`;
        const want = GOLDEN_F64[key] as readonly number[];
        expect(want, `missing golden ${key}`).toBeDefined();
        const got = planes[i] as { a: number; b: number; c: number; d: number };
        (['a', 'b', 'c', 'd'] as const).forEach((k, j) => {
          // a plane is a derived quantity of the f32 clip matrix. The normals are
          // well-conditioned; d is not for the far plane, whose normaliser is 1 + m[2][2]
          // (a cancellation of ~1.3e-4 — see the frustum-planes test), so its allowed
          // difference scales with the plane's own offset
          const want1 = want[j] as number;
          const tolerance = k === 'd' ? 1e-2 + 2e-3 * Math.abs(want1) : 1e-4;
          expect(Math.abs(got[k] - want1), `${key}.${k}`).toBeLessThan(tolerance);
        });
      });
    }
  });

  it('classifies points the same way the clip matrix does', () => {
    const scene = GOLDEN_SCENES.find((s) => s.name === 'minitest_a10_focus_mid') as GoldenScene;
    const { cam } = buildAgentCamera(scene);
    const view = cam.use();
    const clip = view.clip as number[];
    const planes = view.frustum.planes;
    let inside = 0;
    let compared = 0;
    for (let x = -25; x <= 25; x += 2.5) {
      for (let y = -1; y <= 3; y += 0.5) {
        for (let z = -25; z <= 0; z += 2.5) {
          const p = vec3(x, y, z);
          const v = [
            (clip[0] as number) * p.x + (clip[4] as number) * p.y + (clip[8] as number) * p.z + (clip[12] as number),
            (clip[1] as number) * p.x + (clip[5] as number) * p.y + (clip[9] as number) * p.z + (clip[13] as number),
            (clip[2] as number) * p.x + (clip[6] as number) * p.y + (clip[10] as number) * p.z + (clip[14] as number),
            (clip[3] as number) * p.x + (clip[7] as number) * p.y + (clip[11] as number) * p.z + (clip[15] as number),
          ];
          const w = v[3] as number;
          const clipInside =
            w > 0 && (v[0] as number) >= -w && (v[0] as number) <= w && (v[1] as number) >= -w &&
            (v[1] as number) <= w && (v[2] as number) >= -w && (v[2] as number) <= w;
          const planeInside = pointInFrustum(planes, p);
          compared++;
          if (clipInside !== planeInside) {
            // only points within a rounding step of a boundary may disagree
            const margin = Math.min(...planes.map((pl) => Math.abs(planeDistance(pl, p))));
            expect(margin, `disagreement far from a boundary at (${p.x},${p.y},${p.z})`).toBeLessThan(1e-3);
          }
          if (planeInside) inside++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(inside, 'the sampled volume must contain points').toBeGreaterThan(0);
    expect(inside).toBeLessThan(compared);
  });

  it('the eye-space near/far planes are z = -near and z = -far', () => {
    const proj = perspectiveMatrix(10, 8, 0.01, 37.5);
    const planes = frustumPlanes(proj);
    const near = planes[4] as { a: number; b: number; c: number; d: number };
    const far = planes[5] as { a: number; b: number; c: number; d: number };
    expect(near.c).toBeCloseTo(-1, 6);
    expect(near.d).toBeCloseTo(-0.01, 6);
    expect(far.c).toBeCloseTo(1, 6);
    expect(far.d).toBeCloseTo(37.5, 2);
  });
});

// ---------------------------------------------------------------------------
// polygons, bounds, radius
// ---------------------------------------------------------------------------

describe('gpolyobj (polygons, bounds, radius)', () => {
  const polygons = GOLDEN_POLYOBJ.polygons.map((v) => ({ vertices: v }));

  it('derives the native bounding lengths from the vertex soup', () => {
    const obj = new PolyObj(polygons);
    expectF32Array([obj.length.x, obj.length.y, obj.length.z], GOLDEN_F32['polyobj.length'] as readonly number[], 'length');
  });

  it('derives the native radius, and the scale / radiusscale / fixed overrides', () => {
    const obj = new PolyObj(polygons);
    expectF32(obj.radius, (GOLDEN_F32['polyobj.radius'] as readonly number[])[0] as number, 'radius');
    obj.setScale(2.0);
    expectF32(obj.radius, (GOLDEN_F32['polyobj.radius.scale2'] as readonly number[])[0] as number, 'radius.scale2');
    obj.setRadiusScale(3.0);
    expectF32(obj.radius, (GOLDEN_F32['polyobj.radius.radiusscale3'] as readonly number[])[0] as number, 'radius.radiusscale3');
    obj.setRadius(4.0);
    obj.setScale(0.5);
    expectF32(obj.radius, (GOLDEN_F32['polyobj.radius.fixed'] as readonly number[])[0] as number, 'radius.fixed');
  });

  it('the radius is half the bounding-box diagonal times the scales (native formula, contracted sum)', () => {
    const obj = new PolyObj(polygons);
    const { x, y, z } = obj.length;
    // `gpolyobj::setradius()` ships with the square sum *contracted* (`0x84ca0 fmul s1, s1, s1`
    // rounds `y²` only, `0x84ca4`/`0x84cac fmadd` keep `x²`/`z²` exact — PORT-NOTE
    // `W1e/radius-fma-contraction`, `primitives.ts`), so the sum rounds once, not three times.
    // This fixture does not separate the two forms; `tests/fma-contraction-sweep.test.ts`
    // pins both with exact-rational constants and drives this class live.
    expect(obj.radius).toBe(f32(Math.sqrt(f32Fma(z, z, f32Fma(x, x, f32(y * y)))) * 0.5));
  });

  it('boundsOfPolygons agrees with the derived lengths', () => {
    const b = boundsOfPolygons(polygons);
    expect(b).not.toBeNull();
    const obj = new PolyObj(polygons);
    const bb = b as { min: Vec3; max: Vec3 };
    expectF32(bb.max.x - bb.min.x, obj.length.x, 'bx');
    expectF32(bb.max.y - bb.min.y, obj.length.y, 'by');
    expectF32(bb.max.z - bb.min.z, obj.length.z, 'bz');
  });

  it('cloneGeometry copies vertices without touching the radius state', () => {
    const obj = new PolyObj(polygons);
    obj.setScale(4);
    const clone = obj.cloneGeometry();
    expect(clone.scale).toBe(1);
    expect(clone.polygons.length).toBe(obj.polygons.length);
    expect(clone.polygons[0]?.vertices).toEqual(obj.polygons[0]?.vertices);
  });
});

// ---------------------------------------------------------------------------
// derived colour rule and the ray/sphere/plane helpers
// ---------------------------------------------------------------------------

describe('colour quantization and ray helpers', () => {
  it('quantizes colours the way the framebuffer byte does (vision-spec §11.4)', () => {
    expect(colorToByte(0.35)).toBe(89);   // barrier red
    expect(colorToByte(0.6)).toBe(153);
    expect(colorToByte(0.1)).toBe(26);    // ground red
    expect(colorToByte(0.05)).toBe(13);
    expect(colorToByte(-1)).toBe(0);
    expect(colorToByte(2)).toBe(255);
  });

  it('ray/sphere agrees with the analytic intersection distances', () => {
    const s = sphereFromRadius(vec3(0, 0, -10), 1);
    expect(raySphere({ origin: vec3(0, 0, 0), direction: vec3(0, 0, -1) }, s)).toBeCloseTo(9, 12);
    expect(raySphere({ origin: vec3(0, 0, 0), direction: vec3(0, 0, 1) }, s)).toBeNull();
    // starting inside the sphere returns the exit distance (the near root is negative)
    expect(raySphere({ origin: vec3(0, 0, -10), direction: vec3(0, 0, -1) }, s)).toBeCloseTo(1, 12);
  });

  it('ray/plane and ray/bounds agree with the analytic hits', () => {
    const plane = { a: 0, b: 0, c: -1, d: -5 };   // z = -5
    expect(rayPlane({ origin: vec3(0, 0, 0), direction: vec3(0, 0, -1) }, plane)).toBeCloseTo(5, 12);
    expect(rayPlane({ origin: vec3(0, 0, 0), direction: vec3(1, 0, 0) }, plane)).toBeNull();
    const b = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
    expect(rayBounds({ origin: vec3(0, 0, 5), direction: vec3(0, 0, -1) }, b)).toBeCloseTo(4, 12);
    expect(rayBounds({ origin: vec3(0, 0, 5), direction: vec3(0, 0, 1) }, b)).toBeNull();
  });

  it('sphere helpers: enclosure, overlap and bounds', () => {
    const s = sphereFromRadius(vec3(1, 2, 3), 2);
    expect(spheresOverlap(s, sphereFromRadius(vec3(1, 2, 6), 1.1))).toBe(true);
    expect(spheresOverlap(s, sphereFromRadius(vec3(1, 2, 6), 0.9))).toBe(false);
    const b = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
    const enclosing = sphereFromBounds(b);
    expect(enclosing.center).toEqual(vec3(0, 0, 0));
    expect(enclosing.radius).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('eyePositionFromModelview inverts GL\u2019s own modelview', () => {
    // a pure translation maps the world point (-x,-y,-z) to the origin, so that is the eye
    expect(eyePositionFromModelview(translationMatrix(3, 4, 5))).toEqual(vec3(-3, -4, -5));
    const rigid = composeMatrix(translationMatrix(1, -2, 3), rotationMatrix('y', 30), rotationMatrix('x', 15));
    const eye = eyePositionFromModelview(rigid) as Vec3;
    const back = transformPoint3(rigid, eye);
    expect(back.x).toBeCloseTo(0, 9);
    expect(back.y).toBeCloseTo(0, 9);
    expect(back.z).toBeCloseTo(0, 9);
    expect(eyePositionFromModelview(scaleMatrix(0))).toBeNull();
  });

  it('the world100 camera maps its own eye point to the local origin', () => {
    const scene = GOLDEN_SCENES.find((s) => s.name === 'world100_origin') as GoldenScene;
    const { cam } = buildAgentCamera(scene);
    const view = cam.use();
    const eye = view.eyeWorld as Vec3;
    const local = transformPoint3(view.modelview as number[], eye);
    expect(Math.abs(local.x)).toBeLessThan(1e-5);
    expect(Math.abs(local.y)).toBeLessThan(1e-5);
    expect(Math.abs(local.z)).toBeLessThan(1e-5);
  });
});

// ---------------------------------------------------------------------------
// the agent body mesh (`gpolyobj`, native `graphics/gpolygon.{h,cc}`)
// ---------------------------------------------------------------------------

/**
 * Everything in this section asserts against
 * `src/model/geometry/golden/nativeBodyMesh.ts`, recorded by
 * `src/model/geometry/native/bodyprobe.sh` from the **native** code path:
 *
 *   * `mesh` — the real `etc/objects/agent.obj` read by the real
 *     `Resources::loadPolygons`/`operator>>`, and the bounding box + radius the native
 *     `gpolyobj::setlen()`/`setradius()` derive from it;
 *   * `NATIVE_AGENT_BODIES` — for every agent of `microtest_voff` (25) and `minitest_voff`
 *     (87): the `Size`/`MaxSpeed` genes read out of the recorded `genome/agents/genome_<n>.txt.gz`
 *     by the real `Genome::load()`, and `fLengthX`/`fLengthZ`/`lx`/`ly`/`lz`/`radius`/`carryRadius`
 *     produced by the real `agent::SetGeometry()` on a real `agent` object.
 *
 * So the radius asserted at the bottom of this section is the native collision radius of the
 * recorded scenario's own agents, replayed through the ported geometry **and** lane L8's ported
 * `agent::setradius` — bit-for-bit.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const NATIVE_ROOT = process.env.POLYWORLD_NATIVE ?? join(REPO_ROOT, '..', 'polyworld');
const NATIVE_AGENT_OBJ = join(NATIVE_ROOT, 'etc', 'objects', 'agent.obj');
const nativeTreeAvailable = existsSync(NATIVE_AGENT_OBJ);

function latin1Bytes(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('agent body mesh (native gpolyobj)', () => {
  it('bundles etc/objects/agent.obj verbatim', () => {
    expect(AGENT_OBJ_TEXT.startsWith('pw1\n')).toBe(true);
    expect(sha256Hex(latin1Bytes(AGENT_OBJ_TEXT))).toBe(BODY_GOLDEN_ENVIRONMENT.objectSha256);
  });

  it.skipIf(!nativeTreeAvailable)('is byte-identical to the native file it was recorded from', () => {
    const nativeBytes = readFileSync(NATIVE_AGENT_OBJ);
    expect(sha256Hex(latin1Bytes(AGENT_OBJ_TEXT))).toBe(sha256Hex(nativeBytes));
    expect(latin1Bytes(AGENT_OBJ_TEXT).equals(nativeBytes)).toBe(true);
  });

  it('parses the pw1 file into the template the native loader built', () => {
    const parsed = parsePolyObjFile(AGENT_OBJ_TEXT, 'etc/objects/agent.obj');
    expect(parsed.version).toBe('pw1');
    expect(parsed.polygons.length).toBe(AGENT_OBJ_NUM_POLYGONS);
    expect(parsed.polygons.length).toBe(NATIVE_BODY_TEMPLATE.numPolygons);

    let points = 0;
    parsed.polygons.forEach((polygon, i) => {
      const golden = NATIVE_BODY_TEMPLATE.polygons[i] as readonly number[];
      expect(polygon.vertices.length, `polygon ${i} vertex count`).toBe(golden.length);
      points += polygon.vertices.length / 3;
      expectF32Array(polygon.vertices, golden, `polygon ${i}`);
    });
    expect(points).toBe(NATIVE_BODY_TEMPLATE.numPoints);
  });

  it('derives the native bounding box and radius (gpolyobj::setlen/setradius)', () => {
    const template = new PolyObj(parsePolyObjFile(AGENT_OBJ_TEXT).polygons);
    expectF32Array([template.length.x, template.length.y, template.length.z], NATIVE_BODY_TEMPLATE.length, 'setlen');
    expectF32(template.radius, NATIVE_BODY_TEMPLATE.radius, 'gpolyobj::setradius');
    expectF32(template.radiusScale, NATIVE_BODY_TEMPLATE.radiusScale, 'fRadiusScale');
  });

  it('refuses a malformed pw1 file the way the native loader does', () => {
    // native `operator>>( const char*, gpolyobj& )`: unknown version, `invalid number of polys`,
    // `premature end-of-file`, and the `_fail reading` branch for a token that is not a number
    expect(() => parsePolyObjFile('pw2\n1\n3\n0 0 0\n1 0 0\n0 1 0\n')).toThrow(PolyObjFormatError);
    expect(() => parsePolyObjFile('pw2\n1\n3\n0 0 0\n1 0 0\n0 1 0\n')).toThrow(/unknown type/);
    expect(() => parsePolyObjFile('pw1\n0\n')).toThrow(/invalid number of polys/);
    expect(() => parsePolyObjFile('pw1\n1\n4\n0 0 0\n1 0 0\n')).toThrow(/premature end-of-file/);
    expect(() => parsePolyObjFile('pw1\n1\n3\n0 0 0\n1 0 x\n0 1 0\n')).toThrow(/formatting error/);
    expect(() => parsePolyObjFile('pw1\n1\n0\n')).toThrow(/invalid number of points/);
    // a well-formed file still parses
    expect(parsePolyObjFile('pw1\n1\n3\n0 0 0\n1 0 0\n0 1 0\n').polygons).toHaveLength(1);
  });

  it('keeps the native radius fix/unfix rule (fRadiusFixed)', () => {
    const geometry = createAgentBodyGeometry();
    expect(geometry.radiusFixed()).toBe(false);
    expectF32(geometry.radiusScale(), 1.0, 'fRadiusScale');
    expectF32(geometry.scale(), 1.0, 'gobject::fScale');

    const derived = geometry.radius();
    geometry.setScale(2.0);
    expectF32(geometry.radius(), f32(derived * 2), 'setscale re-derives');
    geometry.setRadiusScale(3.0);
    expectF32(geometry.radius(), f32(derived * 6), 'setradiusscale re-derives');
    geometry.setRadius(4.0);
    expect(geometry.radiusFixed()).toBe(true);
    geometry.setScale(0.5);
    expectF32(geometry.radius(), 4.0, 'a fixed radius survives both scale setters');
    expectF32(geometry.scale(), 0.5, 'the scale itself still moves');
  });

  it('reproduces the native bounding box for every recorded agent', () => {
    // one geometry object, reused, exactly as `createAgentDeps` hands it to every agent of a
    // run: `SetGeometry` clones the template first, so an agent's scaling must never leak into
    // the next one.
    const geometry = createAgentBodyGeometry();
    const template = agentBodyTemplate();
    let checked = 0;
    let scaledToSomethingElse = 0;

    for (const scenario of Object.keys(NATIVE_AGENT_BODIES)) {
      const config = NATIVE_BODY_CONFIG[scenario]!;
      for (const body of NATIVE_AGENT_BODIES[scenario]!) {
        // `agent::SetGeometry()`'s roots are single-precision: `sqrt` here is the float
        // overload (`native/sqrt_discipline.py` measures it on all 112 recorded agents).
        const rootMaxSpeed = f32(Math.sqrt(body.maxSpeed));
        const lengthX = f32(body.size / rootMaxSpeed);
        const lengthZ = f32(body.size * rootMaxSpeed);
        expectF32(lengthX, body.lengthX, `${scenario}#${body.number} fLengthX`);
        expectF32(lengthZ, body.lengthZ, `${scenario}#${body.number} fLengthZ`);

        geometry.cloneGeometry(template);
        geometry.scaleVertices(lengthX, config.agentHeight, lengthZ);
        const [lx, ly, lz] = geometry.lengths();
        expectF32(lx, body.lx, `${scenario}#${body.number} fLength[0]`);
        expectF32(ly, body.ly, `${scenario}#${body.number} fLength[1]`);
        expectF32(lz, body.lz, `${scenario}#${body.number} fLength[2]`);

        // the box is the scaled template's box: the mesh's own extremes are exactly ±0.5, so
        // the scaling is exact for this file and the box equals the scale factors
        expectF32(lx, lengthX, `${scenario}#${body.number} lx == fLengthX`);
        expectF32(lz, lengthZ, `${scenario}#${body.number} lz == fLengthZ`);
        expectF32(ly, config.agentHeight, `${scenario}#${body.number} ly == agentHeight`);

        if (lz !== body.lz) scaledToSomethingElse++;
        checked++;
      }
    }

    expect(checked).toBe(25 + 87);
    expect(scaledToSomethingElse).toBe(0);
  });

  it('reproduces the native collision radius through the ported agent', async () => {
    const { Agent } = await import('../src/model/agent');

    // A minimal `AgentDeps` double: this lane's subject is the geometry, and the only seams the
    // geometry path touches are the two factories the constructor calls and
    // `geometry`/`bodyTemplate` (set by `agent::SetGeometry`).
    const template = agentBodyTemplate();
    const geometry = createAgentBodyGeometry(template);
    const deps = {
      simulation: {},
      genomeFactory: { createGenome: () => ({ get: () => 0, getLong: () => 0, mateProbability: () => 0 }) },
      geometry,
      bodyTemplate: template,
      stage: null,
      rng: {},
      events: { postEvent: () => {} },
      barrierList: {},
      sortedObjects: {},
      foodStatics: {},
      brickStatics: {},
      nervousSystemFactory: { create: () => ({ getRNG: () => ({ seedIfLocal: () => {} }) }) },
      retinaFactory: { create: () => ({}) },
      retinaWidth: 2,
      retinaHeight: 2,
      preBirthLearning: false,
      visionCamera: null,
    } as unknown as import('../src/model/agent').AgentDeps;

    let checked = 0;
    for (const scenario of Object.keys(NATIVE_AGENT_BODIES)) {
      for (const body of NATIVE_AGENT_BODIES[scenario]!) {
        const agent = new Agent(deps);
        // native `agent::InitGeneCache()`: geneCache.size = get( "Size" ), .maxSpeed = get( "MaxSpeed" )
        (agent as unknown as { geneCache: { size: number; maxSpeed: number; strength: number; lifespan: number } }).geneCache = {
          size: body.size,
          maxSpeed: body.maxSpeed,
          strength: 1,
          lifespan: 0,
        };
        agent.setGeometry();

        expectF32(agent.lengthX(), body.lengthX, `${scenario}#${body.number} lengthX`);
        expectF32(agent.lengthZ(), body.lengthZ, `${scenario}#${body.number} lengthZ`);
        expectF32(agent.radius(), body.radius, `${scenario}#${body.number} radius`);
        expectF32(agent.carryRadius(), body.carryRadius, `${scenario}#${body.number} carryRadius`);
        checked++;
      }
    }
    expect(checked).toBe(25 + 87);
  });

  it('exposes the scaled mesh to the renderer (L16) as the native fPolygon array', () => {
    const config = NATIVE_BODY_CONFIG['microtest_voff']!;
    const body = (NATIVE_AGENT_BODIES['microtest_voff'] as readonly { lx: number }[])[0]!;
    const geometry = createAgentBodyGeometry();
    geometry.cloneGeometry(agentBodyTemplate());
    geometry.scaleVertices(body.lx, config.agentHeight, body.lx);

    expect(geometry.numPolygons()).toBe(AGENT_OBJ_NUM_POLYGONS);
    let points = 0;
    for (let i = 0; i < geometry.numPolygons(); i++) {
      expect(geometry.polygonVertices(i).length).toBe(geometry.numPointsOf(i) * 3);
      points += geometry.numPointsOf(i);
      // every scaled vertex is stored as a float32
      for (const v of geometry.polygonVertices(i)) expect(f32(v)).toBe(v);
    }
    expect(points).toBe(NATIVE_BODY_TEMPLATE.numPoints);

    // the same object answers the L8 seam
    const asSeam: AgentBodyGeometry = geometry;
    expectF32(asSeam.radiusScale(), 1.0);
    expectF32(asSeam.scale(), 1.0);
    expect(asSeam.radiusFixed()).toBe(false);
  });
});
