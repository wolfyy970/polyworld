/**
 * Lane L13 — `complexity/adami.cc`, transcribed.
 *
 * `AdamiComplexityLog` (lane L12) calls this once per `AdamiComplexityRecordFrequency` steps:
 * it walks the world's agents in **x-sorted order** (`gXSortedObjects`, so the walk order is
 * model behaviour, not a detail), reads one gene across all of them per iteration, and writes
 * three files plus a summary:
 *
 *   `AdamiComplexity-1bit.txt`    the information of each of the 8 bits, per gene
 *   `AdamiComplexity-2bit.txt`    the information of each of the 4 two-bit windows, per gene
 *   `AdamiComplexity-4bit.txt`    the information of each of the 2 four-bit windows, per gene
 *   `AdamiComplexity-summary.txt` `timestep sum1 sum2 sum4`
 *
 * Adami's measure here is the *information* of a symbol: `1 - H(p)` for a single bit,
 * `k - H(p)` for a k-bit window with `2^k` outcomes, with `0*log0` taken as 0 and every symbol
 * probability a **float** in native (`float prob_1 = (float) ones / (float) numagents`), as are
 * the entropy/information arrays (`float informationOneBit[8]`), the `log2` results they store
 * (a double narrowed into a float variable), and the three running sums
 * (`float SumInformationOneBit = 0`). The port keeps each of those `Math.fround` boundaries,
 * because the printed values are `%.4f` of those floats.
 *
 * PORT-NOTE(l13/adami-first-record): native guards its `%`-header lines with
 * `if( ftell( FileOneBit ) == 0 )`. The lane's file seam (`TextSink`) has no `tell`, and lane
 * L12's recorder opens each artifact with `AbstractFile::open( path, "a" )` per record, so "the
 * first record of this run" is the same condition; the returned closure tracks it, one closure
 * per simulation.
 *
 * PORT-NOTE(l13/adami-header-format): `adami.cc:36-38` write `"%% BitsInGenome: %d WindowSize:
 * 1\n"` — a format *with* a value, so the sink applies it and one `%` reaches the file — while
 * `adami.cc:39` writes `"% Timestep 1bit 2bit 4bit\n"` with no value at all (the `%` is
 * literal). Both shapes are the two `fprintf` shapes lane L12's `TextSink.printf` now takes.
 *
 * Verification (`tests/complexity-adami.test.ts`): the arithmetic is pinned against
 * `native/adami_reference.py`, a second implementation of it in another language whose output is
 * committed under `golden/adami/`, and — end to end, over a whole recorded run — against the
 * native build's own four files for the scenario `minitest_adami`
 * (`tools/scenarios.d/minitest_adami.json`, the same worldfile as `minitest_voff` with
 * `--RecordAdamiComplexity True`). That comparison needs a simulation that reaches `MaxSteps`
 * with births in it; it is skipped, loudly, while that path in lanes L11/L5 raises.
 */

import { GObjectType } from '../types';
// The oracle contracts the entropy sums (see the comment on the one-bit branch and PORT-NOTE
// (l13/adami-entropy-is-contracted)): `f32Fma` is lane L8's correctly rounded binary32 `a*b + c`,
// the same helper the other lanes' contracted sites use.
import { f32Fma } from '../agent/numeric';
import { log2 } from './log2';

/** Native `gobject` as this file reads it: `c->Genes()->get_raw_uint( gene )`. */
export interface AdamiAgent {
  genes(): { getRawUint(index: number): number };
}

/**
 * Native `objectxsortedlist::gXSortedObjects` as this file reads it: `reset()` then
 * `nextObj( AGENTTYPE, (gobject **) &c )` in x-sorted order. Lane L12's `LogSortedObjectList`
 * satisfies this structurally (its `next` hands out the log world view, which carries
 * `genes()`).
 */
export interface AdamiWorld {
  reset(): void;
  next(type: number, out: { value: unknown }): boolean;
}

/** Native `GenomeUtil::schema` as this file reads it. */
export interface AdamiSchema {
  getMutableSize(): number;
}

/** Everything `computeAdamiComplexity` reaches outside its arguments (native reads globals). */
export interface AdamiEnvironment {
  readonly world: AdamiWorld;
  readonly schema: AdamiSchema | null;
}

/** The `TextSink` surface this file uses: native's two `fprintf` shapes. */
export interface AdamiSink {
  printf(text: string, ...args: readonly (number | string)[]): void;
}

/** Native `Logs::AdamiComplexityLog`'s entry point, as the frozen `LogContext` names it. */
export type ComputeAdamiComplexity = (
  timestep: number,
  oneBit: AdamiSink,
  twoBit: AdamiSink,
  fourBit: AdamiSink,
  summary: AdamiSink,
) => void;

/** The four artifact paths (`Logs.cc:670-672`, `Logs.cc:724`). */
export const ADAMI_COMPLEXITY_PATHS = [
  'run/genome/AdamiComplexity-1bit.txt',
  'run/genome/AdamiComplexity-2bit.txt',
  'run/genome/AdamiComplexity-4bit.txt',
  'run/genome/AdamiComplexity-summary.txt',
] as const;

const AGENT_TYPE = GObjectType.AGENT;

/**
 * The x-sorted walk, twice: native calls `getCount( AGENTTYPE )` for the `bits` array's first
 * dimension and then walks the same list again per gene.
 */
function countAgents(world: AdamiWorld): number {
  const scratch: { value: unknown } = { value: null };
  let n = 0;
  world.reset();
  while (world.next(AGENT_TYPE, scratch)) n++;
  return n;
}

/**
 * Native `computeAdamiComplexity( timestep, FileOneBit, FileTwoBit, FileFourBit, FileSummary )`
 * (`adami.cc:12`), bound to the run's world and genome schema.
 */
export function createComputeAdamiComplexity(env: AdamiEnvironment): ComputeAdamiComplexity {
  let firstRecord = true;

  return (timestep, fileOneBit, fileTwoBit, fileFourBit, fileSummary) => {
    const mutableSize = env.schema === null ? 0 : env.schema.getMutableSize();

    if (firstRecord) {
      // "write the number of bits into the top of the file"
      fileOneBit.printf('%% BitsInGenome: %d WindowSize: 1\n', mutableSize * 8);
      fileTwoBit.printf('%% BitsInGenome: %d WindowSize: 2\n', mutableSize * 8);
      fileFourBit.printf('%% BitsInGenome: %d WindowSize: 4\n', mutableSize * 8);
      fileSummary.printf('% Timestep 1bit 2bit 4bit\n');
      firstRecord = false;
    }

    // Native `fprintf( FileOneBit, "%ld:", timestep )` — the argument is a C `long`.
    fileOneBit.printf('%ld:', timestep);
    fileTwoBit.printf('%ld:', timestep);
    fileFourBit.printf('%ld:', timestep);
    fileSummary.printf('%ld ', timestep);

    const numagents = countAgents(env.world);

    // Native declares `bool bits[numagents][8]` **once**, outside the gene loop, and only ever
    // writes the rows it walks -- so a gene whose walk yields fewer rows sees the previous
    // gene's bits in the tail. Kept exactly (the dimension is the count taken above).
    const bits = new Int8Array(numagents * 8);
    const scratch: { value: unknown } = { value: null };

    let sumInformationOneBit = 0;
    let sumInformationTwoBit = 0;
    let sumInformationFourBit = 0;

    for (let gene = 0; gene < mutableSize; gene++) {
      let count = 0;

      env.world.reset();
      while (env.world.next(AGENT_TYPE, scratch)) {
        const c = scratch.value as AdamiAgent;
        let genevalue = c.genes().getRawUint(gene);

        if (genevalue >= 128) {
          bits[count * 8 + 0] = 1;
          genevalue -= 128;
        } else bits[count * 8 + 0] = 0;
        if (genevalue >= 64) {
          bits[count * 8 + 1] = 1;
          genevalue -= 64;
        } else bits[count * 8 + 1] = 0;
        if (genevalue >= 32) {
          bits[count * 8 + 2] = 1;
          genevalue -= 32;
        } else bits[count * 8 + 2] = 0;
        if (genevalue >= 16) {
          bits[count * 8 + 3] = 1;
          genevalue -= 16;
        } else bits[count * 8 + 3] = 0;
        if (genevalue >= 8) {
          bits[count * 8 + 4] = 1;
          genevalue -= 8;
        } else bits[count * 8 + 4] = 0;
        if (genevalue >= 4) {
          bits[count * 8 + 5] = 1;
          genevalue -= 4;
        } else bits[count * 8 + 5] = 0;
        if (genevalue >= 2) {
          bits[count * 8 + 6] = 1;
          genevalue -= 2;
        } else bits[count * 8 + 6] = 0;
        if (genevalue === 1) bits[count * 8 + 7] = 1;
        else bits[count * 8 + 7] = 0;

        count++;
      }

      // --- one-bit windows -----------------------------------------------------------------
      const entropyOneBit = new Float32Array(8);
      const informationOneBit = new Float32Array(8);
      for (let i = 0; i < 8; i++) {
        let number_of_ones = 0;
        for (let agent = 0; agent < numagents; agent++) {
          if (bits[agent * 8 + i] === 1) number_of_ones++;
        }

        const prob_1 = Math.fround(Math.fround(number_of_ones) / Math.fround(numagents));
        const prob_0 = Math.fround(1.0 - prob_1);

        // `float logprob_0, logprob_1;` -- the double `log2` narrows on assignment
        const logprob_1 = Math.fround(prob_1 === 0.0 ? 0.0 : log2(prob_1));
        const logprob_0 = Math.fround(prob_0 === 0.0 ? 0.0 : log2(prob_0));

        // PORT-NOTE(l13/adami-entropy-is-contracted): the oracle's build contracts this sum, so
        // the port must too — the source's two products are NOT two roundings.
        //
        // `__Z22computeAdamiComplexitylP7__sFILES0_S0_S0_` (the loop at `0xeb8c`, one iteration
        // per window `i`):
        //
        //   ebc0: fmul  s1, s8, s11      ; f32( prob_1 * logprob_1 )     <- the one rounded product
        //   ebc4: fmadd s0, s9, s0, s1   ; prob_0 * logprob_0 + that, ONE rounding
        //   ebc8: fadd  s0, s0, s12      ; + 1.0f (s12), i.e. clang folded the source's
        //                                ; `-1 * ( … )` and `1.0 - entropy` into one add
        //
        // so `informationOneBit = f32( f32Fma( prob_0, logprob_0, f32( prob_1 * logprob_1 ) ) +
        // 1.0f )`. With rounds-per-operation (the port's earlier shape) the sum lands 1 ulp away
        // whenever the fused and unfused additions round differently — invisible in this file's
        // `%.4f` columns, but not in `AdamiComplexity-summary.txt`'s running float sums, which
        // accumulate one such difference per gene × window (measured: the summary is the first
        // Adami artifact to diverge on `minitest_adami`, by exactly that route — see
        // `tests/complexity-adami.test.ts`).
        const entropySum = f32Fma(prob_0, logprob_0, Math.fround(prob_1 * logprob_1));
        entropyOneBit[i] = Math.fround(-1 * entropySum);
        informationOneBit[i] = Math.fround(1.0 + entropySum);
        sumInformationOneBit = Math.fround(sumInformationOneBit + informationOneBit[i]!);
      }
      fileOneBit.printf(
        ' %.4f %.4f %.4f %.4f %.4f %.4f %.4f %.4f',
        informationOneBit[0]!,
        informationOneBit[1]!,
        informationOneBit[2]!,
        informationOneBit[3]!,
        informationOneBit[4]!,
        informationOneBit[5]!,
        informationOneBit[6]!,
        informationOneBit[7]!,
      );

      // --- two-bit windows -----------------------------------------------------------------
      const entropyTwoBit = new Float32Array(4);
      const informationTwoBit = new Float32Array(4);
      for (let i = 0; i < 4; i++) {
        const number_of = [0, 0, 0, 0];
        for (let agent = 0; agent < numagents; agent++) {
          if (bits[agent * 8 + i * 2] === 1) {
            if (bits[agent * 8 + (i * 2 + 1)] === 1) number_of[3]!++;
            else number_of[2]!++;
          } else {
            if (bits[agent * 8 + (i * 2 + 1)] === 1) number_of[1]!++;
            else number_of[0]!++;
          }
        }

        let sum = 0;
        for (let j = 0; j < 4; j++) {
          const prob = Math.fround(Math.fround(number_of[j]!) / Math.fround(numagents));
          const logprob = Math.fround(prob === 0.0 ? 0.0 : log2(prob));
          // `0xefe0-0xf04c`: four `fdiv` + `fmadd` pairs, i.e. `sum += prob * logprob` is FUSED
          // here too — `fmadd s10, s8, s0, s10`, one rounding per outcome, starting from the
          // zeroed accumulator (`fma(p, lp, 0)` is the rounded product, so the first iteration is
          // the unchanged one). NOTE the contrast with the four-bit loop below, which the same
          // compiler **vectorised** and therefore did *not* fuse — disassembled, not assumed.
          sum = f32Fma(prob, logprob, sum);
        }
        entropyTwoBit[i] = Math.fround(sum * -1);
        informationTwoBit[i] = Math.fround(2.0 + sum); // `0xf054/f058`: entropy = -sum, + 2.0f
        sumInformationTwoBit = Math.fround(sumInformationTwoBit + informationTwoBit[i]!);
      }
      fileTwoBit.printf(
        ' %.4f %.4f %.4f %.4f',
        informationTwoBit[0]!,
        informationTwoBit[1]!,
        informationTwoBit[2]!,
        informationTwoBit[3]!,
      );

      // --- four-bit windows ----------------------------------------------------------------
      const entropyFourBit = new Float32Array(2);
      const informationFourBit = new Float32Array(2);
      for (let i = 0; i < 2; i++) {
        const number_of = new Array<number>(16).fill(0);
        for (let agent = 0; agent < numagents; agent++) {
          // Native walks the same four bits with nested ifs; reading them as a number is the
          // same partition of the agents into 16 outcomes.
          const v =
            (bits[agent * 8 + i * 4]! << 3) |
            (bits[agent * 8 + (i * 4 + 1)]! << 2) |
            (bits[agent * 8 + (i * 4 + 2)]! << 1) |
            bits[agent * 8 + (i * 4 + 3)]!;
          number_of[v] = number_of[v]! + 1;
        }

        let sum = 0;
        for (let j = 0; j < 16; j++) {
          const prob = Math.fround(Math.fround(number_of[j]!) / Math.fround(numagents));
          const logprob = Math.fround(prob === 0.0 ? 0.0 : log2(prob));
          // NOT contracted, and that is the oracle's own shape, not a port choice: clang
          // **vectorised** this 16-outcome loop (four groups of four: `fdiv.4s` @0xf1ec/0xf28c/
          // 0xf32c/0xf3cc, the four `log2` results masked by `fcmeq.4s`/`bic.16b`, then
          // `fmul.4s` @0xf25c/0xf2fc/0xf39c/0xf440) and sums the four rounded products with
          // scalar `fadd`s in ascending order (@0xf26c-0xf278 and the three repetitions), so each
          // product is rounded and each add is rounded — rounds-per-operation, unlike the one-
          // and two-bit loops above. `fmul.4s`/`fadd` is what `fround(prob * logprob)` + `fround`
          // already expresses.
          sum = Math.fround(sum + Math.fround(prob * logprob));
        }
        entropyFourBit[i] = Math.fround(sum * -1);
        informationFourBit[i] = Math.fround(4.0 + sum);
        sumInformationFourBit = Math.fround(sumInformationFourBit + informationFourBit[i]!);
      }
      fileFourBit.printf(' %.4f %.4f', informationFourBit[0]!, informationFourBit[1]!);
    }

    fileOneBit.printf('\n'); // end the line
    fileTwoBit.printf('\n');
    fileFourBit.printf('\n');
    fileSummary.printf(
      '%.4f %.4f %.4f\n',
      sumInformationOneBit,
      sumInformationTwoBit,
      sumInformationFourBit,
    );
  };
}
