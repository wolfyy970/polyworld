/**
 * Lane W1j/L16 — vision + retina raster (`src/model/vision/**`).
 *
 * Replaces the native fixed-function GL retina path with a batched WebGL2 atlas. The contract
 * is in `docs/specs/vision-spec.md` (lane W1j) and PARITY.md's vision finding: with vision on
 * the native model is *reproducible* (two native runs of `minitest.wf` differ in exactly one
 * file, `run/movie.pmv`), so the browser port must keep the model artifacts byte-exact. Retina
 * **pixels** are a debugging aid; the **neurons** are the contract.
 *
 * | Module | Native | What it is |
 * |---|---|---|
 * | `encoder.ts` | `agent/Retina.cc` `Channel::init/update` | the acceptance arithmetic: 88 readback bytes → `3 × numneurons` nerve doubles, f32 store for store (PN-V5/V6/V7/V8) |
 * | `retina.ts` | `agent/Retina.{h,cc}` | the retina buffer, its three named channels, the prebirth noise draw (`range(0,255)` × `width*4`), the row update |
 * | `atlas.ts` | `qtrenderer/.../QtAgentPovRenderer.cc` | the atlas packing (240×72 at 25 agents × 22 px), the per-slot viewport, and the batched readback addressing |
 * | `matrix.ts` | — | an **f32 storage adapter** over lane L15's `geometry/matrix.ts`: this lane's WebGL2 code wants `Float32Array` for a uniform upload, the single definition speaks `number[]`. It computes no matrix arithmetic (PORT-NOTE `vision/gl-matrix-adapter`; PARITY.md *Open questions* 6) |
 * | `camera.ts` | `agent.cc` `SetGraphics`/`UpdateVision` + `gcamera.cc` `Use` | the per-agent vision camera **configuration** (focus → FOV → aspect, which nerves drive pitch/yaw) applied to lane L15's `Camera` (`geometry/camera.ts`), plus this lane's f32 view of it (`VisionCamera`) |
 * | `raster.ts` | `QtAgentPovRenderer::{beginStep,render,endStep}` | the batched WebGL2 atlas: one clear + N viewport draws + **one** `readPixels` per step |
 *
 * Evidence (see PARITY.md's L16 section):
 *
 * * `tests/vision-camera.test.ts` — 18/18, every recorded native camera/matrix golden reproduced
 *   bit-exactly (one documented residual for the both-pitch-and-yaw configuration).
 * * `tests/vision-encoder.test.ts` — 11/11, including the golden fingerprint recomputed from
 *   `brainFunction_10` and the 27 uniform-barrier steps reproduced as printed strings.
 * * `tests/vision-native-rows.test.ts` — 6/6 against the committed native retina dump: 83
 *   agents, 7315 rows, 191 660 nerve values reproduced exactly, plus the atlas slot set the
 *   native renderer itself handed out. This is where the packing and the addressing meet native
 *   bytes; there is no `tests/vision-atlas.test.ts`.
 * * `tests/vision-raster.test.ts` — the batched path against a **recording** GL double: one
 *   `readPixels` per step (never one per agent), the viewport assignment and the row
 *   addressing. The double synthesizes its pixels from absolute coordinates, so it cannot prove
 *   that a row sliced out of the batched readback equals a real per-viewport readback; that
 *   measurement is the real-WebGL2 probe's job (`native/atlas-browser-check.mjs`, card
 *   `t_a8fae02c`).
 *
 * PORT-NOTEs of this lane are indexed in PARITY.md; the in-code comments carry the detail.
 */

export * from './encoder';
export * from './retina';
export * from './atlas';
export * from './camera';
export * from './matrix';
export * from './raster';
export * from './povRaster';
export * from './povScan';
