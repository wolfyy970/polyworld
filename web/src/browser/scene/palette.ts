/**
 * Lane L18 (browser wiring) — scene palette + world-scale helpers.
 *
 * Single source of truth for the shell's *presentation* colours and for the mapping from the
 * worldfile's colours (`{ R G B }`, 0..1 blocks) to three.js hex. The CSS file
 * (src/browser/style.css) mirrors the UI subset by hand; both are owned by this lane.
 *
 * PORT-NOTE (L18/visuals): visuals are explicitly NOT part of the frozen surface
 * (PORT_SPEC.md "Not frozen — Three.js visuals, camera feel"). Nothing in this file may
 * influence model behaviour. Colours that the worldfile *does* describe (ground, food, brick,
 * barrier) are read from it (`sim/worldParams.ts`); colours it does not describe are this
 * file's invention. Since L18b the agents' own colour is **not** one of them: it comes from the
 * model (`agent::color()`), and `PALETTE.agents` is only the instance buffers' initial fill
 * (it is overwritten by the first `sync()` and exists so `instanceColor` is allocated).
 */

import type { Rgb } from '../sim/worldParams';

/**
 * World extent used only when nothing has been booted (tests, examples). Every real path reads
 * `WorldSize` from the worldfile — both recorded scenarios say 25
 * (`oracle/<scenario>/run/normalized.wf`).
 */
export const DEFAULT_WORLD_SIZE = 25;

/** Hex colours, kept as numbers for three.js and mirrored in style.css as CSS vars. */
export const PALETTE = {
  /** Sky/clear colour and fog colour — one value, so the horizon disappears cleanly. */
  sky: 0x0b0f0c,
  groundEdge: 0x2f4a2f,
  accent: 0xb9e26b,
  /** Presentation agent colours, picked by `SimulationAgent.colorIndex` (see the header). */
  agents: [0xb9e26b, 0x8fd6a0, 0x6fc2d0, 0xe3a04b, 0xd47a7a, 0xb99ce0],
} as const;

export const LIGHTING = {
  ambient: 0x9fb69a,
  ambientIntensity: 0.55,
  keyColor: 0xfff3d6,
  keyIntensity: 1.35,
  fillColor: 0x8fc9d6,
  fillIntensity: 0.35,
} as const;

/** A worldfile colour (`{ R G B }`, 0..1, f32) → three.js hex. */
export function rgbToHex(color: Rgb): number {
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));
  return (channel(color.r) << 16) | (channel(color.g) << 8) | channel(color.b);
}

/** Mix two hex colours, `t` = weight of `b` (0..1). Used for the food patches' tint. */
export function mixHex(a: number, b: number, t: number): number {
  const lerp = (shift: number): number => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * t) & 0xff;
  };
  return (lerp(16) << 16) | (lerp(8) << 8) | lerp(0);
}

/**
 * Camera framing, expressed as fractions of the world so it survives a worldfile change.
 *
 * PORT-NOTE (L18/camera-fit): the native monitor camera positions itself in world-size units
 * too (`monitor/CameraController.cc:68-80`: translations of `0.5 * globals::worldsize`,
 * `parms.height * globals::worldsize`, …). Camera *feel* is not frozen (PORT_SPEC), and this
 * rig is an orbit rig over the world centre rather than the native's scene/agent cameras, but
 * the framing fractions are chosen so the whole world fits at the default distance.
 */
export function cameraDefaults(worldSize: number): {
  fov: number;
  near: number;
  far: number;
  position: [number, number, number];
  target: [number, number, number];
  minDistance: number;
  maxDistance: number;
  maxPolarAngle: number;
} {
  const unit = (fraction: number): number => worldSize * fraction;
  return {
    fov: 45,
    near: Math.max(0.01, unit(0.008)),
    far: unit(60),
    /** A low, slightly off-axis three-quarter view — same framing the shell has always had. */
    position: [unit(0.375), unit(0.29), unit(0.49)],
    target: [0, 0, 0],
    minDistance: unit(0.05),
    maxDistance: unit(2),
    maxPolarAngle: Math.PI * 0.49,
  };
}
