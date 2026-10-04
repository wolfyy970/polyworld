/**
 * Lane L10 — the environment lane's public surface.
 *
 *   import { Energy, FoodType, Food, FoodPatch, Brick, BrickPatch, Barrier,
 *            gXSortedObjects, Patch } from '../environment';
 *
 * What is here is native `src/library/environment/**` — the energy vector, the food types and
 * food objects, the rectangle/ellipse patches (food and brick), bricks, barriers and the
 * x-sorted world-object list — plus the two lane cuts they need (`DomainLike`, `StageLike`)
 * and the environment's slice of `gobject`/`gbox`/`gboxf` (`object.ts`).
 *
 * `Energy`/`EnergyPolarity`/`EnergyMultiplier` (native `environment/Energy.{h,cc}`) **are** here,
 * in `energy.ts`, with `MAX_ENERGY_TYPES`/`ENERGY_EPSILON`: the module body moved out of
 * `src/model/agent/energy.ts` (lane L8 carried it while this directory did not exist) once both
 * lanes were quiescent, so the agent lane imports it from this directory now — one definition,
 * PORT-NOTE(`L8/energy-home`) there.
 *
 * What is NOT here, and who owns it:
 *   - `sim/Domain` (the patch parent) is lane L11's; this lane only reads its four geometry
 *     fields through `DomainLike`.
 *   - `graphics/gstage` and the full `gobject`/`gbox`/`gpoly` are lane L15's; this lane sees
 *     `StageLike` (two calls) and `object.ts`'s environment slice, whose one piece of shared
 *     arithmetic — the `gbox` radius rule — is L15's too (`geometry/primitives.ts`, re-exported
 *     here as `focusRadius`).
 *   - `proplib::CppProperties` (which binds a worldfile `dyn(...)` property to `FoodPatch::on`)
 *     is the cppprops lane's; the setters are exposed here for it to bind.
 *   - the code path that *decides* when food grows and when agents eat is lane L11's
 *     (`sim/Simulation.cc`); this lane owns the objects and the arithmetic they do.
 *
 * Evidence: `golden/nativeEnvironment.ts` is generated from the native code by
 * `native/run_envprobe.sh` (it links the oracle's own `libpolyworld.dylib`) and checked in
 * `tests/environment.test.ts`.
 */

export * from './energy';
export * from './distributions';
export * from './object';
export * from './patch';
export * from './foodType';
export * from './food';
export * from './foodPatch';
export * from './brick';
export * from './brickPatch';
export * from './barrier';
export * from './objectXSortedList';
