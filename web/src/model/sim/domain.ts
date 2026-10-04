/**
 * Lane L11 (sim) — `class Domain` (native `sim/Domain.h`): one region of the world.
 *
 * A domain owns a rectangular area, its agent/food bookkeeping, its food and brick patches, its
 * breeding parameters and — the part that is easy to under-port — two *lists* that are read on
 * the step path: `fittest` (genomes stored, drained by `CreateAgents`) and the smite queue
 * (`fLeastFit`, worst-first, built by `DeathAndStats`, consumed by `Smite`).
 *
 * PORT-NOTE(sim/domain-patch-ownership): native's `Domain` holds `FoodPatch *fFoodPatches` /
 * `BrickPatch *fBrickPatches` arrays and a `Patch *initAgentsPatch`. The port keeps the same
 * three, but as the lane-L10 classes (`src/model/environment`) — the patches are built by the
 * worldfile step, in domain order, and only their *counts* and *indices* are the sim's business.
 * `fNumLeastFit`/`fNumSmited` are per-domain in native but the sim keeps working copies on the
 * simulation object as well (`fNumLeastFit`/`fNumSmited` there are used by the single-domain
 * paths) — the port follows the C++ exactly: these fields exist here *and* there.
 */

import { FoodPatch } from '../environment';
import { BrickPatch } from '../environment';
import type { Patch } from '../environment';
import { FittestList } from './fittestList';
import type { Agent } from '../agent';

/** Native `class Domain` (`Domain.h:12-64`). Field names keep native spelling minus the `f`. */
export class Domain {
  centerX = 0;
  centerZ = 0;
  absoluteSizeX = 0;
  absoluteSizeZ = 0;
  sizeX = 0;
  sizeZ = 0;
  startX = 0;
  startZ = 0;
  endX = 0;
  endZ = 0;

  numFoodPatches = 0;
  numBrickPatches = 0;

  fraction = 0;
  foodRate = 0;
  foodCount = 0;
  initFoodCount = 0;
  minFoodCount = 0;
  maxFoodCount = 0;
  maxFoodGrownCount = 0;
  numFoodPatchesGrown = 0;

  /** Native `FoodPatch *fFoodPatches` — `numFoodPatches` live entries. */
  foodPatches: FoodPatch[] = [];
  /** Native `BrickPatch *fBrickPatches` — `numBrickPatches` live entries. */
  brickPatches: BrickPatch[] = [];
  /** Native `Patch *initAgentsPatch` — null until the worldfile step builds it. */
  initAgentsPatch: Patch | null = null;

  minNumAgents = 0;
  maxNumAgents = 0;
  initNumAgents = 0;
  numberToSeed = 0;

  numAgents = 0;
  numcreated = 0;
  numborn = 0;
  numbornsincecreated = 0;
  numdied = 0;
  lastcreate = 0;
  maxgapcreate = 0;
  numToCreate = 0;

  probabilityOfMutatingSeeds = 0;

  /** Native `double energyScaleFactor` — read every step by `agent::damage` (lane L8). */
  energyScaleFactor = 0;

  /** Native `short ifit, jfit` — the crossover-walker cursors (`CreateAgents`). */
  ifit = 0;
  jfit = 0;

  /** Native `FittestList *fittest` — complete fitness, genomes stored. */
  fittest: FittestList;

  /** Native `int fNumLeastFit` / `fMaxNumLeastFit` / `fNumSmited`. */
  numLeastFit = 0;
  maxNumLeastFit = 0;
  numSmited = 0;
  /** Native `agent **fLeastFit` — worst-first, capacity `maxNumLeastFit`. */
  leastFit: (Agent | null)[] = [];

  constructor() {
    // Native `Domain::Domain()` only clears `foodCount`; everything else is written by
    // `processWorldFile`/`InitFittest`. The port constructs the two lists here (native's
    // `fittest` is allocated at the same place, `processWorldFile`) and leaves the rest at zero.
    this.fittest = new FittestList(0, true);
  }

  /** Native `Domain::whichFoodPatch( x, z )` — first patch containing the point, or null. */
  whichFoodPatch(x: number, z: number): FoodPatch | null {
    for (let i = 0; i < this.numFoodPatches; i++) {
      const fp = this.foodPatches[i]!;
      if (fp.pointIsInside(x, z, 0.0)) return fp;
    }
    return null;
  }

  /** Native `Domain::whichBrickPatch( x, z )` — the brick twin (used by `BrickPatch` setup). */
  whichBrickPatch(x: number, z: number): BrickPatch | null {
    for (let i = 0; i < this.numBrickPatches; i++) {
      const bp = this.brickPatches[i]!;
      if (bp.pointIsInside(x, z, 0.0)) return bp;
    }
    return null;
  }
}
