# src/model/environment

Lane L10 — food, bricks/barriers, patches and world geometry

Only the owning lane writes files here.

## What is in here

| File | Contents |
|---|---|
| `energy.ts` | native `environment/Energy.{h,cc}` — `Energy`/`EnergyPolarity`/`EnergyMultiplier`/`Polarity`, `MAX_ENERGY_TYPES`, `ENERGY_EPSILON`. The module **body** moved here from `src/model/agent/energy.ts` (lane L8 carried it until this directory existed; PORT-NOTE `L8/energy-home`), so the agent lane imports *this* file and there is exactly one definition |
| `distributions.ts` | native `utils/distributions.{h,cc}` — `normalPDF`/`linearPDF`/`getLinear`/`getNormal`, the rejection samplers `Patch::setPoint` uses |
| `object.ts` | the environment's slice of `graphics/gobject` + `gbox` + `gboxf`: position/length/colour/type/type-number/carry state, and the three `rand()` draws every `gobject` construction makes. The derived radius is **L15's** rule (`geometry/primitives.ts`'s `boxRadius`, re-exported here as `focusRadius`) — this file carries no radius arithmetic |
| `patch.ts` | native `environment/Patch.{h,cc}` — `initBase`, `setPoint` (shape × distribution), `getArea`, `pointIsInside`, the agent counters, plus the `DomainLike`/`StageLike` lane cuts |
| `foodType.ts` | native `environment/FoodType.{h,cc}` — the name→type map (`find` walks it in `strcmp` order) and the definition-order vector (`run/energy/food.txt`'s columns) |
| `food.ts` | native `environment/food.{h,cc}` — the food object (x/z-only radius override, `eat`, `initlen`, `getAge`) and `food::gAllFood` |
| `foodPatch.ts` | native `environment/FoodPatch.{h,cc}` — counts, fraction, `on`, `addFood` |
| `brick.ts` | native `environment/brick.{h,cc}` — `gBrickHeight`/`gBrickRadius`, `NumBricks`, `dump` |
| `brickPatch.ts` | native `environment/BrickPatch.{h,cc}` — `updateOn`/`addBricks`/`removeBricks` |
| `barrier.ts` | native `environment/barrier.{h,cc}` — `LineSegment`, `updateVertices` (`a`/`b`/`c`/`f`/`sina`/`cosa`), `dist`, `bxsortedlist` |
| `objectXSortedList.ts` | native `utils/objectxsortedlist.{h,cc}` — the x-sorted world-object list and its cursor (the environment is the only lane that creates objects) |
| `index.ts` | the lane's public surface |
| `golden/nativeEnvironment.ts` | **generated** — native values + the fixtures that produced them. Do not hand-edit |
| `native/run_envprobe.{cc,sh}` | the generator: compiles against the oracle's own headers and links `libpolyworld.dylib` |

Tests: `tests/environment.test.ts` (bit-exact goldens + the recorded-run checks).

Regenerate the goldens with `bash src/model/environment/native/run_envprobe.sh --ts` (needs the
native build at `../polyworld`, overridable with `POLYWORLD_NATIVE`).
