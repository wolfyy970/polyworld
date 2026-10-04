/**
 * Lane L5 (genome) — `genome/Genome.{h,cc}`: the mutable genome bitstring and every
 * operator that touches it (seeding, randomization, mutation, crossover, separation).
 *
 * The RNG is **injected**: every draw goes through the frozen `RngSurface`
 * (`src/model/types/rng.ts`), whose concrete implementation is lane W1d
 * (`src/model/rng/**`). The genome lane never calls `Math.random`, never re-seeds and never
 * merges streams; the draw *order* below is the contract (`randpw()` is `drand48()` on the
 * shared global stream, and the mutation/crossover algorithms interleave their draws with
 * whoever else is running).
 *
 * PORT-NOTE(genome/rng-injection): native reaches `randpw()`/`rrand()`/`nrand()` through
 * macros on the process-wide C library state. The port takes one `RngSurface` instance and
 * records which native entry point each call corresponds to (`RngSurface.drand48` =
 * `randpw`, `RngSurface.nrandScaled` = `nrand(mean, stdev)`).
 *
 * PORT-NOTE(genome/seedval): native `SEEDVAL(VAL)` is `(unsigned char)(VAL == 1 ? 255 :
 * VAL * 256)` — note `VAL == 1` compares the *float* against 1, so `0.9999999` seeds with
 * 255.99997 → `(unsigned char)` truncates to 255 anyway, but the branch is kept verbatim.
 * `SEEDCHECK` is an assert in native and throws here (a ratio outside [0,1] is a bug, not a
 * clamp).
 *
 * PORT-NOTE(genome/c-round): `mutateOneByte` uses C's `round()`, which rounds halves *away
 * from zero*; `Math.round` rounds halves toward +Infinity. `cRound` reproduces C.
 *
 * PORT-NOTE(genome/libm-pow-cos): `mutateBytes` and `mateProbability` call libm
 * transcendentals, and all of them now go to lane L1's transcriptions
 * (`src/model/rng/libm.ts`): `mutateBytes`' `pow(2.0, MutationStdevPower)` (which the
 * oracle's clang folds to `exp2`, and `exp2` is bit-identical to `pow(2, ·)` — see the note
 * at the site), `mateProbability`'s `_pow`/`_cos` pair, and its last line, which is `_powf`
 * @0x7611c — the **float** overload, transcribed as `powf` (card t_29e0a2fc) after the
 * disassembly showed the double `pow` is not a stand-in for it (measured over the base ×
 * slope lattice: V8's `Math.pow` and the ported `pow` are bit-identical to each other and
 * each disagree with the shipped `powf` on 138 of 106,995 pairs). `interpolate`'s
 * `GeneInterpolationPower` path is the same `_pow` and is switched too (`gene.ts`). All of
 * these sites are *unreachable* in the oracle scenarios — the recorded worldfiles set
 * `GeneticOperatorResolution Bit` (so `mutateBytes` never runs), no worldfile sets
 * `GeneInterpolationPower`, and `mateProbability` is dead code (`agent::MateProbability` has
 * no callers) — so this is port fidelity, not a golden-moving change; see PARITY.md -> Gaps.
 *
 * PORT-NOTE(genome/misc-genes-are-absent): `MISC_BIAS`/`MISC_INVIS_SLOPE` are
 * `gene("MiscBias")`/`gene("MiscInvisSlope")` and **no schema in the oracle build defines
 * those genes**, so native holds `NULL` and `mateProbability` would dereference it. The
 * port throws with that explanation instead of inventing the genes or a default value.
 *
 * PORT-NOTE(genome/dump-seam): `dump`/`load` take the abstract-file seam of lane L2 as
 * `write(text)` / `readInt()`, so this lane owns the byte format (`"%d\n"`, gray-decoded)
 * and L2/L12 own the file. `print()` returns a string rather than writing to `cout`
 * (nothing frozen depends on it).
 */

import { binofgray, grayofbin } from './graybin';
import { NonVectorGene, toImmutableInterpolated, toNonVector, type Gene } from './gene';
import type { GenomeLayout } from './genomeLayout';
import { GenomeSchema } from './genomeSchema';
import { Scalar } from './values';
import type { RngSurface } from '../types';
import { pow, powf } from '../rng';
import { cos } from '../rng/libm';

/** Native `SEEDCHECK( VAL )`. */
function seedCheck(name: string, ratio: number): void {
  if (!(ratio >= 0 && ratio <= 1)) {
    throw new Error(`Genome::seed(${name}): raw value ratio ${ratio} outside [0, 1]`);
  }
}

/** Native `SEEDVAL( VAL )`. */
function seedVal(ratio: number): number {
  return (ratio === 1 ? 255 : ratio * 256) & 0xff;
}

/** Native `clamp( val, 0, 255 )`. */
function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

/** C `round()`: nearest integer, halves away from zero. */
function cRound(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** The writer seam for `dump` (native: `AbstractFile *`, lane L2). */
export interface GenomeSink {
  write(text: string): void;
}

/** The reader seam for `load` (native: `AbstractFile::scanf( "%d\n", &num )`). */
export interface GenomeSource {
  /** `%d\n"` — the parsed integer, or null when the field is absent/not an integer. */
  readInt(): number | null;
}

/** Native `Genome` (the base class; `GroupsGenome` is the concrete one). */
export abstract class Genome {
  /** Native `Genome::MISC_BIAS` — NULL in this build, see the PORT-NOTE above. */
  readonly miscBias: Gene | null;
  /** Native `Genome::MISC_INVIS_SLOPE` — NULL in this build. */
  readonly miscInvisSlope: Gene | null;

  readonly nbytes: number;
  readonly mutableData: Uint8Array;

  protected readonly schema: GenomeSchema;
  protected readonly layout: GenomeLayout;
  private readonly gray: boolean;
  private readonly rng: RngSurface;

  constructor(schema: GenomeSchema, layout: GenomeLayout, rng: RngSurface) {
    this.schema = schema;
    this.layout = layout;
    this.rng = rng;

    this.miscBias = this.gene('MiscBias');
    this.miscInvisSlope = this.gene('MiscInvisSlope');
    this.gray = GenomeSchema.config.grayCoding;

    this.nbytes = schema.getMutableSize();
    this.mutableData = new Uint8Array(this.nbytes);
  }

  /** Native `Genome::gene( const char * )`. */
  gene(name: string): Gene | null {
    return this.schema.get(name);
  }

  /** Native `Genome::get( const char * )`. */
  get(name: string): Scalar {
    return this.getByGene(this.gene(name));
  }

  /** Native `Genome::get( Gene * )`. */
  getByGene(gene: Gene | null): Scalar {
    const nonVector = toNonVector(gene);
    if (!nonVector) {
      throw new Error('Genome::get: no such gene (native dereferences a NULL gene here)');
    }
    return nonVector.get(this);
  }

  /** Native `randpw()` — the shared `drand48` stream (see the RNG PORT-NOTE above). */
  protected randpw(): number {
    return this.rng.drand48();
  }

  /** Native `Genome::get_raw( int offset )`. */
  getRaw(offset: number): number {
    if (!(offset >= 0 && offset < this.nbytes)) {
      throw new Error(`Genome::get_raw: offset ${offset} outside 0..${this.nbytes - 1}`);
    }
    const layoutOffset = this.layout.getMutableDataOffset(offset);
    const value = this.mutableData[layoutOffset] ?? 0;
    return this.gray ? (binofgray[value] ?? 0) : value;
  }

  /** Native `Genome::get_raw_uint( long byte )`. */
  getRawUint(byte: number): number {
    return this.getRaw(byte);
  }

  /** Native `Genome::set_raw` — public here because `Gene::seed` calls it (see PORT-NOTE). */
  setRaw(offset: number, n: number, value: number): void {
    if (!(offset >= 0 && offset + n <= this.nbytes)) {
      throw new Error(`Genome::set_raw: ${offset}+${n} outside 0..${this.nbytes}`);
    }
    const stored = this.gray ? (grayofbin[value] ?? 0) : value;
    for (let i = 0; i < n; i++) {
      this.mutableData[this.layout.getMutableDataOffset(offset + i)] = stored;
    }
  }

  /** Native `Genome::set_raw_random`. */
  setRawRandom(offset: number, n: number, min: number, max: number): void {
    if (!(offset >= 0 && offset + n <= this.nbytes)) {
      throw new Error(`Genome::set_raw_random: ${offset}+${n} outside 0..${this.nbytes}`);
    }
    for (let i = 0; i < n; i++) {
      // Native `rrand( min, max + 1 )` == `interp( randpw(), min, max + 1 )`.
      const raw = min + this.rng.drand48() * (max + 1 - min);
      this.mutableData[this.layout.getMutableDataOffset(offset + i)] = Math.trunc(raw) & 0xff;
    }
  }

  /** Native `Genome::updateSum`. */
  updateSum(sum: Float64Array, sum2: Float64Array): void {
    for (let i = 0; i < this.nbytes; i++) {
      const layoutOffset = this.layout.getMutableDataOffset_nocheck(i);
      const raw = this.mutableData[layoutOffset] ?? 0;
      const value = this.gray ? (binofgray[raw] ?? 0) : raw;
      sum[i] = (sum[i] ?? 0) + value;
      sum2[i] = (sum2[i] ?? 0) + value * value;
    }
  }

  /** Native `Genome::seed( Gene *, float )`. */
  seedByGene(gene: Gene | null, ratio: number): void {
    if (!gene) throw new Error('Genome::seed: no such gene');
    seedCheck(gene.name, ratio);
    gene.seed(this, seedVal(ratio));
  }

  /** Native `Genome::seedRandom( Gene *, float, float )`. */
  seedRandomByGene(gene: Gene | null, min: number, max: number): void {
    if (!gene) throw new Error('Genome::seedRandom: no such gene');
    seedCheck(gene.name, min);
    seedCheck(gene.name, max);
    gene.randomize(this, seedVal(min), seedVal(max));
  }

  /** Native `Genome::seedAll( float )`. */
  seedAll(ratio: number): void {
    seedCheck('seedAll', ratio);
    this.mutableData.fill(seedVal(ratio));
  }

  /** Native `Genome::randomizeBits( float bitonprob )`. */
  randomizeBits(bitonprob: number): void {
    for (let byte = 0; byte < this.nbytes; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const current = this.mutableData[byte] ?? 0;
        if (this.rng.drand48() < bitonprob) this.mutableData[byte] = current | (1 << (7 - bit));
        else this.mutableData[byte] = current & (255 ^ (1 << (7 - bit)));
      }
    }
  }

  /** Native `Genome::randomizeBits()`. */
  randomizeBitsDefault(): void {
    const gene = toImmutableInterpolated(this.gene('BitProbability'));
    this.randomizeBits(gene.interpolateRatio(this.rng.drand48()).asFloat());
  }

  /** Native `Genome::randomizeBytes()`. */
  randomizeBytes(): void {
    this.setRawRandom(0, this.nbytes, 0, 255);
  }

  /** Native `Genome::randomize()`. */
  randomize(): void {
    if (GenomeSchema.config.resolution === GenomeSchema.RESOLUTION_BIT) this.randomizeBitsDefault();
    else if (GenomeSchema.config.resolution === GenomeSchema.RESOLUTION_BYTE) this.randomizeBytes();
    else throw new Error('Genome::randomize: unknown genetic operator resolution');
  }

  /** Native `Genome::mutateBits( float rate )`. */
  mutateBits(rate: number): void {
    for (let byte = 0; byte < this.nbytes; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        if (this.rng.drand48() < rate) {
          this.mutableData[byte] = (this.mutableData[byte] ?? 0) ^ (1 << (7 - bit));
        }
      }
    }
  }

  /** Native `Genome::mutateBits()`. */
  mutateBitsDefault(): void {
    this.mutateBits(this.get('MutationRate').asFloat());
  }

  /** Native `Genome::mutateOneByte( long byte, float stdev )`. */
  mutateOneByte(byte: number, stdev: number): void {
    const current = this.mutableData[byte] ?? 0;
    const val = cRound(this.rng.nrandScaled(current, stdev));
    this.mutableData[byte] = clampByte(val);
  }

  /** Native `Genome::mutateBytes( float rate )`. */
  mutateBytes(rate: number): void {
    // PORT-NOTE(genome/libm-pow-cos): the oracle's code here has **no** `pow` call at all —
    // `pow( 2.0, get("MutationStdevPower") )` is `pow(double, double)` (the `Scalar` widens via
    // `operator double()`, which is `(double)(float)fval`), and clang folds a constant base 2
    // to `exp2` (`bl _exp2` @0x75900, then `fcvt s0, d0`). `exp2(y)` and `pow(2.0, y)` agree
    // bit-for-bit on all 400,000 doubles of a `[-80, 80]` sweep, so calling L1's transcribed
    // `pow` — plus the `fround` store boundary, unchanged — reproduces the oracle exactly.
    const stdev = Math.fround(pow(2.0, this.get('MutationStdevPower').asFloat()));
    for (let byte = 0; byte < this.nbytes; byte++) {
      if (this.rng.drand48() < rate) this.mutateOneByte(byte, stdev);
    }
  }

  /** Native `Genome::mutateBytes()`. */
  mutateBytesDefault(): void {
    this.mutateBytes(this.get('MutationRate').asFloat());
  }

  /** Native `Genome::mutate( float rate )`. */
  mutateRate(rate: number): void {
    if (!GenomeSchema.config.enableEvolution) return;
    if (GenomeSchema.config.resolution === GenomeSchema.RESOLUTION_BIT) this.mutateBits(rate);
    else if (GenomeSchema.config.resolution === GenomeSchema.RESOLUTION_BYTE) this.mutateBytes(rate);
    else throw new Error('Genome::mutate: unknown genetic operator resolution');
  }

  /** Native `Genome::mutate()`. */
  mutate(): void {
    this.mutateRate(this.get('MutationRate').asFloat());
  }

  /** Native `Genome::crossover( Genome *g1, Genome *g2, bool mutate )`. */
  crossover(g1: Genome, g2: Genome, mutate: boolean): void {
    if (g1 === g2) throw new Error('Genome::crossover: g1 == g2');

    // Randomly select number of crossover points from chosen genome
    let numCrossPoints =
      this.rng.drand48() < 0.5
        ? g1.get('CrossoverPointCount').asInt()
        : g2.get('CrossoverPointCount').asInt();

    if (!GenomeSchema.config.enableEvolution) numCrossPoints = 0;

    if (numCrossPoints === 0) {
      const gTemplate = this.rng.drand48() < 0.5 ? g1 : g2;
      this.copyFrom(gTemplate);
      if (mutate) this.mutate();
      return;
    }

    const crossoverPoints = new Array<number>(numCrossPoints).fill(0);
    this.getCrossoverPoints(crossoverPoints, numCrossPoints);

    let begbyte = 0;
    let endbyte = -1;
    let first = this.rng.drand48() < 0.5;

    for (let i = 0; i <= numCrossPoints; i++) {
      if (i === numCrossPoints) {
        endbyte = this.nbytes;
      } else if (GenomeSchema.config.resolution === GenomeSchema.RESOLUTION_BIT) {
        endbyte = (crossoverPoints[i] ?? 0) >> 3;
      } else if (GenomeSchema.config.resolution === GenomeSchema.RESOLUTION_BYTE) {
        endbyte = crossoverPoints[i] ?? 0;
      } else {
        throw new Error('Genome::crossover: unknown genetic operator resolution');
      }

      const ga = first ? g1 : g2;
      const gb = first ? g2 : g1;

      for (let j = begbyte; j < endbyte; j++) {
        this.mutableData[j] = ga.mutableData[j] ?? 0;
      }

      if (i < numCrossPoints) {
        if (GenomeSchema.config.resolution === GenomeSchema.RESOLUTION_BIT) {
          const bit = (crossoverPoints[i] ?? 0) - (endbyte << 3);
          this.mutableData[endbyte] =
            ((ga.mutableData[endbyte] ?? 0) & (255 << (8 - bit))) |
            ((gb.mutableData[endbyte] ?? 0) & (255 >> bit));
        } else {
          this.mutableData[endbyte] = gb.mutableData[endbyte] ?? 0;
        }
      }

      first = !first;
      begbyte = endbyte + 1;
    }

    if (mutate) this.mutate();
  }

  /** Native `Genome::copyFrom`. */
  copyFrom(g: Genome): void {
    if (this.schema !== g.schema) throw new Error('Genome::copyFrom: schema mismatch');
    this.mutableData.set(g.mutableData);
  }

  /** Native `Genome::separation`. */
  separation(g: Genome): number {
    if (this.schema !== g.schema) throw new Error('Genome::separation: schema mismatch');

    let sep = 0;
    if (this.gray) {
      for (let i = 0; i < this.nbytes; i++) {
        const vi = binofgray[this.mutableData[i] ?? 0] ?? 0;
        const vj = binofgray[g.mutableData[i] ?? 0] ?? 0;
        sep += Math.abs(vi - vj);
      }
    } else {
      for (let i = 0; i < this.nbytes; i++) {
        sep += Math.abs((this.mutableData[i] ?? 0) - (g.mutableData[i] ?? 0));
      }
    }

    return Math.fround(Math.fround(sep) / Math.fround(255 * this.nbytes));
  }

  /** Native `Genome::mateProbability`. Dead code in this build (see PORT-NOTEs). */
  mateProbability(g: Genome): number {
    const miscbias = this.getByGene(this.miscBias).asDouble();

    // returns probability that two agents will successfully mate
    // based on their degree of genetic similarity/difference
    if (miscbias === 0.0) return 1.0;

    const a = this.separation(g);
    // PORT-NOTE(genome/libm-pow-cos): the oracle's disassembly of this function calls
    // `_pow` @0x760b8 on `((double)a, miscbias)` and `_cos` @0x760d4 on the double product —
    // both are L1 transcriptions, so these two calls are no longer drifted. The last line is
    // **not** a `pow` site: native calls `_powf` @0x7611c on two floats, i.e. the C++ `float`
    // overload, which the double `pow` does not reproduce (over the base × slope lattice the
    // ported `pow` and V8's `Math.pow` are bit-identical to each other and each disagree with
    // the shipped `powf` on 138 of 106,995 pairs) — it now calls L1's own transcription of
    // that overload, `powf`, whose corpus covers exactly this lattice.
    const cosa = cos(pow(a, miscbias) * Math.PI);
    const s = cosa > 0.0 ? 0.5 : -0.5;
    const p = 0.5 + s * powf(Math.abs(cosa), this.getByGene(this.miscInvisSlope).asDouble());

    return Math.fround(p);
  }

  /** Native `Genome::dump` — one gray-decoded byte per line. */
  dump(out: GenomeSink): void {
    for (let i = 0; i < this.nbytes; i++) {
      out.write(`${this.getRaw(i)}\n`);
    }
  }

  /** Native `Genome::load`. */
  load(input: GenomeSource): void {
    for (let i = 0; i < this.nbytes; i++) {
      const num = input.readInt();
      if (num === null) {
        throw new Error(
          'Failure in reading seed file\nProbably due to genome schema mismatch.',
        );
      }
      this.setRaw(i, 1, num);
    }

    const extra = input.readInt();
    if (extra !== null) {
      throw new Error(
        `Unexpected data in seed file after genome bytes: ${extra}\n` +
          'Probably due to genome schema mismatch.',
      );
    }
  }

  /** Native `Genome::print()` — a string here, not `cout` (see PORT-NOTE). */
  print(lobit = 0, hibit = this.nbytes * 8): string {
    let text = `genome bits ${lobit} through ${hibit} =\n`;
    for (let i = lobit; i <= hibit; i++) {
      const byte = i >> 3; // 0-based
      const bit = i % 8; // 0-based, from left
      text += ((this.getRaw(byte) >> (7 - bit)) & 1).toString();
    }
    return `${text}\n`;
  }

  /** Native `Genome::getCrossoverPoints` — the derived class implements it. */
  protected getCrossoverPoints(_crossoverPoints: number[], _numCrossPoints: number): void {
    throw new Error('Genome::getCrossoverPoints: not implemented by this genome');
  }

  /** Native `createBrain` is lane L6/L7; only the subclass can supply it. */
  abstract createBrain(cns: object): object;
}

export { NonVectorGene };
