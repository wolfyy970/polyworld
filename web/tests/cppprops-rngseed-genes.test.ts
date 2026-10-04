/**
 * Lane L5 (genome) × lane L6 (brain core) — the two `Groups` RNG-seed genes, from the port's own
 * schema (card t_cc4faf49).
 *
 * `GroupsGenomeSchema::define` builds `TopologicalDistortionRngSeed` and `InitWeightRngSeed` with
 * `SYNAPSE_ATTR( NAME, false, false, … )` from `GroupsBrain::config.min/max…RngSeed` — the four
 * `long` fields of `GroupsBrain::Configuration`, and the *only* non-`float` bounds the Groups
 * schema passes to a range gene. `Scalar( long )` is an `INT` scalar, so native's `SynapseAttrGene`
 * interpolates these two as `nint( interp( ratio, min, max ) )` (`ROUND_INT_NEAREST`, fixed by its
 * ctor) and `printRanges` writes `IntNearest INT 0 INT 255 <name>`. The port built both from
 * `Scalar.float`, which is what the card measured: `run/genome/meta/generange.txt` differed from
 * the native recording on exactly these two rows (`None FLOAT 0.000000 FLOAT 255.000000 …`).
 *
 * Why this needs its own file, and why it needs no run:
 *
 *  * **No recorded Tier-A scenario can see it.** They keep
 *    `EnableTopologicalDistortionRngSeed`/`EnableInitWeightRngSeed` False, so the genes do not
 *    exist in their `generange.txt` goldens; only the `growers_*`/`gene_dyn` worldfiles turn them
 *    on, and those have no oracle harness. `tests/cppprops-recorded-tree.test.ts` pins the same
 *    rows as *text* in a `growers_dyn` recording; this file asserts them at the source, and on the
 *    card's other world.
 *  * **No stepping is needed.** `GenomeMetaLog::init` registers for `SimInited` with no worldfile
 *    guard and writes the five `run/genome/meta/*` files on that event, which the `Simulation`
 *    ctor posts last — and the seeded agents' brains are grown *in* the ctor, so this boot is also
 *    the run that exercises the other half of the fix: `GroupsBrain::growSynapses` seeds its two
 *    per-connection generators per connection from these genes, through the `long` read
 *    (`PORT-NOTE(sim/rng-seed-gene-long-read)` -> `asInt()`). With the pre-fix schema that read
 *    throws (`Scalar: float conversion of INT`), and with a pre-fix `asFloat()` read the `INT`
 *    scalar throws — which is why "the boot returned" is itself part of the acceptance.
 *
 * One `Simulation` per process (see `cpppropsSimWorld.ts`), so this file boots exactly one world.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { genomeUtil, type GroupsGenomeSchema, type SynapseAttrGene } from '../src/model/genome';
import { GObjectType } from '../src/model/types';
import { haveNativeTree, newSim } from './cpppropsSimWorld';

const SCENARIO = 'growers_small';

/** The two genes, in `define()`'s order (they are the last two `SYNAPSE_ATTR`s). */
const NAMES = ['TopologicalDistortionRngSeed', 'InitWeightRngSeed'] as const;

/** Native's rows: the `min`/`max` band is the worldfile schema's `0..255` default for both. */
const ROWS = [
  'IntNearest INT 0 INT 255 TopologicalDistortionRngSeed',
  'IntNearest INT 0 INT 255 InitWeightRngSeed',
] as const;

describe.skipIf(!haveNativeTree)('L5 × L6 — the Groups `*RngSeed` genes', () => {
  // Native's cwd never moves, so the whole run writes under one root: chdir *before* the ctor
  // (the init-time recorders open their `run/**` files there). See `runWorld`'s doc comment.
  const outDir = mkdtempSync(join(tmpdir(), 'cppprops-rngseed-'));
  const previous = process.cwd();
  let agentsAtCtor = 0;
  process.chdir(outDir);
  try {
    const sim = newSim(SCENARIO, undefined, ['--Vision', 'False']);
    agentsAtCtor = sim.objects().getCount(GObjectType.AGENT);
    sim.dispose();
  } finally {
    process.chdir(previous);
  }

  const schema = genomeUtil.schema as GroupsGenomeSchema;
  const generange = readFileSync(join(outDir, 'run/genome/meta/generange.txt'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);

  /** The gene as the schema actually built it (not a stand-in). */
  const gene = (name: string): SynapseAttrGene => {
    const found = schema.get(name) as SynapseAttrGene | null;
    if (found === null) throw new Error(`schema has no gene '${name}'`);
    return found;
  };

  it('grew the seeded agents’ brains through those genes (the `long` read did not throw)', () => {
    // The worldfile's `InitAgents`; `growSynapses` runs for each of them inside the ctor and
    // reads both genes there.
    expect(agentsAtCtor).toBe(180);
  });

  it('defines both ranges as native does — `INT`, `0..255`', () => {
    for (const name of NAMES) {
      const g = gene(name);
      expect(g.getMin().kind, `${name} min kind`).toBe('INT');
      expect(g.getMax().kind, `${name} max kind`).toBe('INT');
      expect(g.getMin().asInt(), `${name} min`).toBe(0);
      expect(g.getMax().asInt(), `${name} max`).toBe(255);
      // The ctor's fixed rounding, which is what makes the dump read `IntNearest` rather than
      // `IntFloor`/`IntBin`.
      expect(g.isInterpolated()).toBe(true);
    }
  });

  it('writes native’s two rows into generange.txt, and leaves the others alone', () => {
    expect(generange.slice(-2)).toEqual([...ROWS]);
    // The 21 rows that every recorded scenario's golden already pins, plus these two.
    expect(generange).toHaveLength(23);
    expect(generange.filter((row) => row.includes('RngSeed'))).toEqual([...ROWS]);
    // The pre-fix text, which the card measured in this very file.
    expect(generange.some((row) => row.includes('None FLOAT 0.000000 FLOAT 255.000000'))).toBe(false);
  });

  it('seeds a per-connection generator with the raw genome byte', () => {
    // The *value* half of the acceptance: over the byte domain `nint( interp( ratio, 0, 255 ) )` is
    // the raw byte itself — the same number the pre-fix FLOAT range narrowed to — so the seeded
    // generator state is unchanged by this fix and no grown synapse moves. Measured on the card:
    // `growers_dyn` with `--RecordSynapses True` is byte-identical to the native recording on all
    // 1,195 `run/brain/synapses/*` payloads, before and after. A band that is *not* the byte domain
    // is where the two spellings diverge (measured over all 256 raws: 0 of them on `0..255`, 125 of
    // them on `0..100`), which is why the scalar kind is contract and not a printing detail.
    for (const name of NAMES) {
      const g = gene(name);
      for (let raw = 0; raw < 256; raw++) {
        expect(g.interpolate(raw).asInt(), `${name} raw=${raw}`).toBe(raw);
      }
    }
  });
});
