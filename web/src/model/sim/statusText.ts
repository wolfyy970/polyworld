/**
 * Lane L11 (sim) — `TSimulation::getStatusText` (native `Simulation.cc:4870-5230`), the bytes lane
 * L14's `StatusTextMonitor` writes to `run/stats/stat.<timestep>` **and** the terminal UI prints.
 *
 * The function is pure formatting over the running totals the sim already keeps: it consumes no
 * RNG, reads no clock (the one `Rate …` line prints the FPS fields, which the port keeps at zero —
 * see PORT-NOTE(sim/fps-skipped) — and lane L14's store filter drops that line anyway) and mutates
 * only its own two function-statics (`lastTotalEnergyEaten`/`deltaEnergy`,
 * `lastNumberBorn`/`deltaBorn`). Native's `static`s live in the function body, i.e. they persist
 * across simulations in one process; the module-level state below reproduces that.
 *
 * This file is the transcription of the C++ `sprintf` calls *including their format strings*,
 * because the artifact is bytes: `%4d` vs `%d`, the two-space `created  =`, the `-two    =`
 * padding of the metabolism lines, the `( %ld, %ld )` domain suffixes (whose separators are
 * inconsistent in the C++ — `", %ld"` for agents/food, `",%ld"` for created/born/died — and are
 * reproduced as written, PORT-NOTE(sim/status-text-separators)), the `\xb1` byte of the `±`
 * statistics, and the `Rate`/`Domain`/`FP` block order.
 *
 * PORT-NOTE(sim/status-text-float): the C++ mixes `float` members with `double` ones, and every
 * expression below is transcribed at the width the source spells: `(float)` casts are `fround`,
 * a `float`-by-`float` operator (`(in - out) / (in + out)`, `deltaEnergy[0] / statusFrequency`,
 * `agentInsideCount * makePercent`, `HeuristicFitness() / fTotalHeuristicFitness`) rounds once to
 * binary32 — and every `float` expression is promoted to `double` only where `printf`'s variadic
 * promotion does it. The `%.1f`/`%.2f`/`%2.1f` conversions run through lane L6's `sprintfC`, whose
 * `%f` is a correctly-rounded glibc-compatible fixed conversion, so the bytes match the goldens
 * rather than `toFixed`'s tie rule.
 *
 * PORT-NOTE(sim/status-text-contraction-residual): `PARITY.md`'s contraction sweep lists three
 * fused multiply-adds inside `getStatusText` (`0x9cc08`/`0x9ccc8`/`0x9ce14`) and classifies them
 * as the **double-precision contraction class** — they are the inlined `sim::Stat::stddev()`
 * (`sum2 / count - m * m`, an `fnmadd`) and the sweep measured the whole class below every
 * recorded artifact's resolution (≤ 1 binary64 ulp; the recorded status texts print `0.0` for
 * every `Stat` here). Transcribed per-operation, as that section records, not fixed by guessing.
 *
 * PORT-NOTE(sim/status-text-dynamic-props): the tail block walks
 * `proplib::CppProperties::getMetadata()` and prints every `Dynamic` entry
 * (`cppprops.h:47-50`, `Dynamic = 0`). Lane W1h's cppprops is a build-time step in the port
 * (`docs/specs/cppprops.md`), so the sim reads it through the same optional seam that drives
 * `CppProperties::update()` (see `sim/cppprops-seam`); absent, the block is empty — which is what
 * the recorded scenarios measure (the golden `run/stats/stat.1` and the recorded `stdout.txt` end
 * at the `FP*` row and carry no dynamic line). Gaps row: W1h.
 */

import { GObjectType, globals } from '../types';
import { sprintfC, BrainArchitecture, brainConfig } from '../brain/core';
import { Metabolism } from '../agent';
import type { Simulation } from './simulation';

/** Native `graphics/gobject.h` object-type bits, as the sim's switches name them. */
const AGENTTYPE = GObjectType.AGENT;
const FOODTYPE = GObjectType.FOOD;

const f32 = Math.fround;

/** Native `PropertyMetadata::Type::Dynamic` (`cppprops.h:47-50`). */
const CPP_PROPERTY_DYNAMIC = 0;

/**
 * Native's two function-statics. `static Energy lastTotalEnergyEaten;` and `static Energy
 * deltaEnergy;` default-construct to all-zero `Energy`s (`Simulation.cc:5110-5111`), and
 * `static long lastNumberBorn = 0; static long deltaBorn;` likewise.
 */
let lastTotalEnergyEaten: Float32Array | null = null;
let deltaEnergy: Float32Array | null = null;
let lastNumberBorn = 0;
let deltaBorn = 0;

/** Native `TSimulation::getStatusText( StatusText&, int statusFrequency )`. */
export function statusTextOf(sim: Simulation, statusText: string[], statusFrequency: number): void {
  statusText.push(sprintfC('step = %ld', sim.fStep));

  // agents = %4d  (+ ` (a, b, c)` when there is more than one domain)
  let line = sprintfC('agents = %4d', sim.objects().getCount(AGENTTYPE));
  if (sim.fNumDomains > 1) {
    let tail = sprintfC(' (%ld', sim.fDomains[0]!.numAgents);
    for (let id = 1; id < sim.fNumDomains; id++) {
      tail += sprintfC(', %ld', sim.fDomains[id]!.numAgents);
    }
    line += `${tail})`;
  }
  statusText.push(line);

  if (Metabolism.getNumberOfDefinitions() > 1) {
    for (let i = 0; i < Metabolism.getNumberOfDefinitions(); i++) {
      statusText.push(
        sprintfC(' -%s = %4ld', Metabolism.get(i)!.name, sim.fNumberAliveWithMetabolism[i]!),
      );
    }
  }

  // food = %4d  (+ the same domain suffix, which uses `%d` here and `%ld` above)
  line = sprintfC('food = %4d', sim.objects().getCount(FOODTYPE));
  if (sim.fNumDomains > 1) {
    let tail = sprintfC(' (%d', sim.fDomains[0]!.foodCount);
    for (let id = 1; id < sim.fNumDomains; id++) {
      tail += sprintfC(', %d', sim.fDomains[id]!.foodCount);
    }
    line += `${tail})`;
  }
  statusText.push(line);

  statusText.push(sprintfC('foodEnergy = %.1f', sim.getFoodEnergy()));

  line = sprintfC('created  = %4ld', sim.fNumberCreated);
  if (sim.fNumDomains > 1) {
    let tail = sprintfC(' (%ld', sim.fDomains[0]!.numcreated);
    for (let id = 1; id < sim.fNumDomains; id++) tail += sprintfC(',%ld', sim.fDomains[id]!.numcreated);
    line += `${tail})`;
  }
  statusText.push(line);

  statusText.push(sprintfC(' -random = %4ld', sim.fNumberCreatedRandom));
  statusText.push(sprintfC(' -two    = %4ld', sim.fNumberCreated2Fit));
  statusText.push(sprintfC(' -one    = %4ld', sim.fNumberCreated1Fit));

  line = sprintfC('born     = %4ld', sim.fNumberBorn);
  if (sim.fNumDomains > 1) {
    let tail = sprintfC(' (%ld', sim.fDomains[0]!.numborn);
    for (let id = 1; id < sim.fNumDomains; id++) tail += sprintfC(',%ld', sim.fDomains[id]!.numborn);
    line += `${tail})`;
  }
  statusText.push(line);

  if (
    sim.fHeuristicFitnessWeight !== 0.0 ||
    sim.fComplexityFitnessWeight !== 0.0 ||
    sim.fLockStepWithBirthsDeathsLog
  ) {
    statusText.push(sprintfC('born_v   = %4ld', sim.fNumberBornVirtual));
  }

  line = sprintfC('died     = %4ld', sim.fNumberDied);
  if (sim.fNumDomains > 1) {
    let tail = sprintfC(' (%ld', sim.fDomains[0]!.numdied);
    for (let id = 1; id < sim.fNumDomains; id++) tail += sprintfC(',%ld', sim.fDomains[id]!.numdied);
    line += `${tail})`;
  }
  statusText.push(line);

  statusText.push(sprintfC(' -age    = %4ld', sim.fNumberDiedAge));
  statusText.push(sprintfC(' -energy = %4ld', sim.fNumberDiedEnergy));
  statusText.push(sprintfC(' -fight  = %4ld', sim.fNumberDiedFight));
  statusText.push(sprintfC(' -eat    = %4ld', sim.fNumberDiedEat));
  statusText.push(sprintfC(' -edge   = %4ld', sim.fNumberDiedEdge));
  statusText.push(sprintfC(' -smite  = %4ld', sim.fNumberDiedSmite));
  statusText.push(sprintfC(' -patch  = %4ld', sim.fNumberDiedPatch));

  statusText.push(sprintfC('birthDenials = %ld', sim.fBirthDenials));
  statusText.push(sprintfC('miscDenials = %ld', sim.fMiscDenials));

  line = sprintfC('ageCreate = %ld', sim.fLastCreated);
  if (sim.fNumDomains > 1) {
    let tail = sprintfC(' (%ld', sim.fDomains[0]!.lastcreate);
    for (let id = 1; id < sim.fNumDomains; id++) tail += sprintfC(',%ld', sim.fDomains[id]!.lastcreate);
    line += `${tail})`;
  }
  statusText.push(line);

  line = sprintfC('maxGapCreate = %ld', sim.fMaxGapCreate);
  if (sim.fNumDomains > 1) {
    let tail = sprintfC(' (%ld', sim.fDomains[0]!.maxgapcreate);
    for (let id = 1; id < sim.fNumDomains; id++) tail += sprintfC(',%ld', sim.fDomains[id]!.maxgapcreate);
    line += `${tail})`;
  }
  statusText.push(line);

  if (sim.fHeuristicFitnessWeight !== 0.0 || sim.fComplexityFitnessWeight !== 0.0) {
    statusText.push(
      sprintfC(
        'born_v/(c+bv) = %.2f',
        f32(Math.fround(sim.fNumberBornVirtual) / Math.fround(sim.fNumberCreated + sim.fNumberBornVirtual)),
      ),
    );
  } else {
    statusText.push(
      sprintfC(
        'born/total = %.2f',
        f32(Math.fround(sim.fNumberBorn) / Math.fround(sim.fNumberCreated + sim.fNumberBorn)),
      ),
    );
  }

  statusText.push(
    sprintfC(
      'Fitness m=%.2f, c=%.2f, a=%.2f',
      sim.fMaxFitness,
      f32(sim.fCurrentMaxFitness[0]! / sim.fTotalHeuristicFitness),
      sim.fAverageFitness,
    ),
  );

  const fittest = sim.fFittest;
  if (fittest === null) throw new Error('sim: getStatusText: fFittest is null (native dereferences it)');

  line = 'Fittest =';
  const fittestCount = Math.min(5, fittest.getSize());
  for (let i = 0; i < fittestCount; i++) line += sprintfC(' %lu', fittest.get(i).agentID);
  statusText.push(line);

  if (fittestCount > 0) {
    line = ' ';
    for (let i = 0; i < fittestCount; i++) line += sprintfC('  %.2f', fittest.get(i).fitness);
    statusText.push(line);
  }

  line = 'CurFit =';
  for (let i = 0; i < sim.fCurrentFittestCount; i++) {
    line += sprintfC(' %lu', sim.fCurrentFittestAgent[i]!.number());
  }
  statusText.push(line);

  if (sim.fCurrentFittestCount > 0) {
    line = ' ';
    for (let i = 0; i < sim.fCurrentFittestCount; i++) {
      line += sprintfC(
        '  %.2f',
        f32(sim.fCurrentFittestAgent[i]!.heuristicFitness() / sim.fTotalHeuristicFitness),
      );
    }
    statusText.push(line);
  }

  const avgIn = sim.fAverageFoodEnergyIn;
  const avgOut = sim.fAverageFoodEnergyOut;
  statusText.push(sprintfC('avgFoodEnergy = %.2f', f32(f32(avgIn - avgOut) / f32(avgIn + avgOut))));

  const totIn = sim.fTotalFoodEnergyIn;
  const totOut = sim.fTotalFoodEnergyOut;
  statusText.push(sprintfC('totFoodEnergy = %.2f', f32(f32(totIn - totOut) / f32(totIn + totOut))));

  line = sprintfC('totEnergyEaten = %.1f', sim.fTotalEnergyEaten.get(0));
  for (let i = 1; i < globals.numEnergyTypes; i++) {
    line += sprintfC(', %.1f', sim.fTotalEnergyEaten.get(i));
  }
  statusText.push(line);

  if (lastTotalEnergyEaten === null) lastTotalEnergyEaten = new Float32Array(globals.numEnergyTypes);
  if (deltaEnergy === null) deltaEnergy = new Float32Array(globals.numEnergyTypes);
  if (sim.fStep % statusFrequency === 0) {
    for (let i = 0; i < globals.numEnergyTypes; i++) {
      deltaEnergy[i] = sim.fTotalEnergyEaten.get(i) - lastTotalEnergyEaten[i]!;
      lastTotalEnergyEaten[i] = sim.fTotalEnergyEaten.get(i);
    }
  }
  line = sprintfC('EatRate = %.1f', f32(deltaEnergy[0]! / statusFrequency));
  for (let i = 1; i < globals.numEnergyTypes; i++) {
    line += sprintfC(', %.1f', f32(deltaEnergy[i]! / statusFrequency));
  }
  statusText.push(line);

  let numberBorn: number;
  if (
    sim.fComplexityFitnessWeight !== 0.0 ||
    sim.fHeuristicFitnessWeight !== 0.0 ||
    sim.fLockStepWithBirthsDeathsLog
  ) {
    numberBorn = sim.fNumberBornVirtual;
  } else {
    numberBorn = sim.fNumberBorn;
  }
  if (sim.fStep % statusFrequency === 0) {
    deltaBorn = numberBorn - lastNumberBorn;
    lastNumberBorn = numberBorn;
  }
  statusText.push(sprintfC('MateRate = %.2f', deltaBorn / statusFrequency));

  statusText.push(
    sprintfC(
      'LifeSpan = %lu \xb1 %lu [%lu, %lu]',
      nint(sim.fLifeSpanStats.mean()),
      nint(sim.fLifeSpanStats.stddev()),
      unsignedLong(sim.fLifeSpanStats.min()),
      unsignedLong(sim.fLifeSpanStats.max()),
    ),
  );
  statusText.push(
    sprintfC(
      'RecLifeSpan = %lu \xb1 %lu [%lu, %lu]',
      nint(sim.fLifeSpanRecentStats.mean()),
      nint(sim.fLifeSpanRecentStats.stddev()),
      unsignedLong(sim.fLifeSpanRecentStats.min()),
      unsignedLong(sim.fLifeSpanRecentStats.max()),
    ),
  );

  // --- addStat() ---------------------------------------------------------
  const stats = sim.fCurrentBrainStats;
  statusText.push(statLine('CurNeurons', stats.neuronCount));
  switch (brainConfig.architecture) {
    case BrainArchitecture.Groups:
      statusText.push(statLine('CurNeurGroups', stats.groups.groupCount));
      break;
    default:
      // Native's `Sheets` arm adds `CurInternalSheets`/`CurInternalNeurons`/`CurSynapse*` columns;
      // `default: assert( false )`. No recorded scenario runs the Sheets architecture, so the port
      // stops loudly instead of printing columns it cannot fill (Gaps row: L6/Sheets).
      throw new Error(
        `sim: getStatusText: brain architecture '${String(brainConfig.architecture)}' has no status text (native asserts)`,
      );
  }
  statusText.push(statLine('CurSynapses', stats.synapseCount));

  statusText.push(
    sprintfC(
      'Rate %2.1f (%2.1f) %2.1f (%2.1f) %2.1f (%2.1f)',
      sim.fFramesPerSecondInstantaneous,
      sim.fSecondsPerFrameInstantaneous,
      sim.fFramesPerSecondRecent,
      sim.fSecondsPerFrameRecent,
      sim.fFramesPerSecondOverall,
      sim.fSecondsPerFrameOverall,
    ),
  );

  if (sim.fCalcFoodPatchAgentCounts) {
    let numAgentsInAnyFoodPatchInAnyDomain = 0;
    let numAgentsInOuterRangesInAnyDomain = 0;

    for (let domainNumber = 0; domainNumber < sim.fNumDomains; domainNumber++) {
      statusText.push(sprintfC('Domain %d', domainNumber));

      const domain = sim.fDomains[domainNumber]!;
      let numAgentsInAnyFoodPatch = 0;
      let numAgentsInOuterRanges = 0;

      for (let i = 0; i < domain.numFoodPatches; i++) {
        numAgentsInAnyFoodPatch += domain.foodPatches[i]!.agentInsideCount;
        numAgentsInOuterRanges += domain.foodPatches[i]!.agentNeighborhoodCount;
      }

      const makePercent = f32(100.0 / domain.numAgents);
      const makePercentNorm = f32(100.0 / numAgentsInAnyFoodPatch);

      for (let i = 0; i < domain.numFoodPatches; i++) {
        const patch = domain.foodPatches[i]!;
        statusText.push(
          sprintfC(
            '  FP%d %d %3d %3d  %4.1f %4.1f  %4.1f',
            i,
            patch.foodCount,
            patch.agentInsideCount,
            patch.agentInsideCount + patch.agentNeighborhoodCount,
            f32(patch.agentInsideCount * makePercent),
            f32((patch.agentInsideCount + patch.agentNeighborhoodCount) * makePercent),
            f32(patch.agentInsideCount * makePercentNorm),
          ),
        );
      }

      statusText.push(
        sprintfC(
          '  FP* %3d %3d  %4.1f %4.1f 100.0',
          numAgentsInAnyFoodPatch,
          numAgentsInAnyFoodPatch + numAgentsInOuterRanges,
          f32(numAgentsInAnyFoodPatch * makePercent),
          f32((numAgentsInAnyFoodPatch + numAgentsInOuterRanges) * makePercent),
        ),
      );

      numAgentsInAnyFoodPatchInAnyDomain += numAgentsInAnyFoodPatch;
      numAgentsInOuterRangesInAnyDomain += numAgentsInOuterRanges;
    }

    if (sim.fNumDomains > 1) {
      const makePercent = f32(100.0 / sim.objects().getCount(AGENTTYPE));
      statusText.push(
        sprintfC(
          '**FP* %3d %3d  %4.1f %4.1f 100.0',
          numAgentsInAnyFoodPatchInAnyDomain,
          numAgentsInAnyFoodPatchInAnyDomain + numAgentsInOuterRangesInAnyDomain,
          f32(numAgentsInAnyFoodPatchInAnyDomain * makePercent),
          f32((numAgentsInAnyFoodPatchInAnyDomain + numAgentsInOuterRangesInAnyDomain) * makePercent),
        ),
      );
    }
  }

  // --- Dynamic Properties ------------------------------------------------
  for (const metadata of sim.cppPropertiesMetadata()) {
    if (metadata.type !== CPP_PROPERTY_DYNAMIC) continue;
    statusText.push(`${metadata.name} = ${metadata.toString()}`);
  }
}

/** Native's `addStat` lambda: `"%s = %.1f \xb1 %.1f [%lu, %lu]"`. */
function statLine(name: string, stat: { mean(): number; stddev(): number; min(): number; max(): number }): string {
  return sprintfC(
    '%s = %.1f \xb1 %.1f [%lu, %lu]',
    name,
    stat.mean(),
    stat.stddev(),
    unsignedLong(stat.min()),
    unsignedLong(stat.max()),
  );
}

/** Native `#define nint(a) ((long)((a)+(((a)<0.0)?-0.499999999:0.499999999)))`. */
function nint(a: number): number {
  return Math.trunc(a + (a < 0.0 ? -0.499999999 : 0.499999999));
}

/** Native `(unsigned long) x` on a non-negative `float` — truncation toward zero. */
function unsignedLong(x: number): number {
  return Math.trunc(x) >>> 0;
}
