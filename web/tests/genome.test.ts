/**
 * Lane L5 (genome) — `src/model/genome/**`.
 *
 * Two kinds of assertion:
 *
 *  1. **Oracle parity.** `run/genome/meta/*.txt` is part of PORT_SPEC's frozen surface. The
 *     schema is built from the *recorded* worldfile of each scenario, the five meta files are
 *     rendered, and they are compared byte-for-byte with what the native build wrote
 *     (`oracle/<scenario>/run/genome/meta/*.txt`). The candidate tree those files are written
 *     into is also what `./oracle/run_parity.sh <scenario> --candidate <dir>` reads, so the
 *     harness evidence and this test agree by construction. Goldens are only ever read.
 *
 *  2. **Semantics.** The pieces the golden cannot reach on its own (mutation, crossover,
 *     separation, the gray tables, the offsets/validators, the `sort -n` pass) are checked
 *     against the behaviour read out of `../polyworld/src/library/genome/**`, with a scripted
 *     `RngSurface` so a draw-order change fails the test instead of passing it.
 *
 * Fixture note: `run/normalized.wf` keeps the worldfile's *unevaluated expressions*
 * (`GenomeLayout NeurGroup if BrainArchitecture == …`); proplib evaluates them on access
 * (lane L4). The fixture therefore substitutes the evaluated spelling for the three
 * expression-valued keys the genome schema reads, and asserts the raw text it is
 * substituting *is* that expression — so the substitution cannot silently apply to a
 * different worldfile. Each replaced value is evidenced by the golden itself (see
 * EVALUATED_EXPRESSIONS).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { threadId } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import {
  Config,
  createConfig,
  documentFromJs,
  type MemoryValue,
  type RngSurface,
} from '../src/model/types';
import {
  GeneSchema,
  Genome,
  GenomeLayout,
  GenomeSchema,
  GenomeUtil,
  GroupsGenome,
  GroupsGenomeSchema,
  ImmutableScalarGene,
  MutableScalarGene,
  NeurGroupType,
  NeuronType,
  Rounding,
  Scalar,
  SeparationCache,
  assertPrintableSchema,
  formatFloat6,
  nint,
  readGenomeSchemaInputs,
  renderGeneLayoutSorted,
  renderGeneStatsHeader,
  renderGenomeMeta,
  type Gene,
  type GenomeMetaFiles,
} from '../src/model/genome';
import { assertUsableStagingRoot } from '../src/oracle/guard';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const oracleRoot = process.env.POLYWORLD_ORACLE_ROOT ?? path.join(repoRoot, 'oracle');
const laneRoot = path.join(repoRoot, 'src', 'model', 'genome');

const SCENARIOS = ['microtest_voff', 'minitest_voff'] as const;
const META_FILES = [
  'geneindex.txt',
  'genelayout.txt',
  'genelayout-sorted.txt',
  'genetitle.txt',
  'generange.txt',
] as const;

// ======================================================================================== //
// Fixtures
// ======================================================================================== //

/**
 * The keys whose *recorded text* is not the value the model reads: normalized.wf keeps the
 * worldfile's expressions and identifier references unevaluated (proplib evaluates them on
 * access — lane L4). Each substitution is checked against the raw text it replaces, and each
 * value is evidenced by the golden:
 *
 *   GenomeLayout            -> NeurGroup  `genelayout.txt` != `geneindex.txt` (a `None` layout
 *                                        is the identity map, so the two files would be equal)
 *   Min/MaxMutationRate     -> 0.01/0.05  `generange.txt`: `IntFloor FLOAT 0.010000 FLOAT
 *                                        0.050000 MutationRate` — the `Bit` branch
 *   EnableSpikingGenes      -> False      `geneindex.txt` has no `SpikingParameter*` genes
 *   MaxBiasWeight           -> 8.0        identifier reference to `MaxSynapseWeight`;
 *                                        `generange.txt`: `None FLOAT -8.000000 FLOAT
 *                                        8.000000 Bias`
 *   SimpleSeed{,IO}ConnectionDensity
 *                           -> 0.0        identifier references to `MinConnectionDensity`
 *                                        (= 0.0 in the worldfile); inert here because
 *                                        `SeedType Legacy`
 */
interface Substitution {
  readonly rawStartsWith?: string;
  readonly rawIdentifier?: string;
  /** The property a raw identifier points at; its literal is read from the same file. */
  readonly referencedKey?: string;
  readonly value: string;
}

const SUBSTITUTIONS: Record<string, Substitution> = {
  GenomeLayout: {
    rawStartsWith: 'NeurGroup if BrainArchitecture ==',
    value: 'NeurGroup',
  },
  MinMutationRate: {
    rawStartsWith: '( 0.01 if GeneticOperatorResolution ==',
    value: '0.01',
  },
  MaxMutationRate: {
    rawStartsWith: '( 0.05 if GeneticOperatorResolution ==',
    value: '0.05',
  },
  EnableSpikingGenes: {
    rawStartsWith: '( True if NeuronModel ==',
    value: 'False',
  },
  MaxBiasWeight: {
    rawIdentifier: 'MaxSynapseWeight',
    referencedKey: 'MaxSynapseWeight',
    value: '8.0',
  },
  SimpleSeedConnectionDensity: {
    rawIdentifier: 'MinConnectionDensity',
    referencedKey: 'MinConnectionDensity',
    value: '0.0',
  },
  SimpleSeedIOConnectionDensity: {
    rawIdentifier: 'MinConnectionDensity',
    referencedKey: 'MinConnectionDensity',
    value: '0.0',
  },
  // `InitAgents MaxAgents` — how many agents exist at SimInit, i.e. how many agent genomes
  // are the *seeded* genome rather than a crossover product of the run.
  InitAgents: {
    rawIdentifier: 'MaxAgents',
    referencedKey: 'MaxAgents',
    value: '25',
  },
};

/** Every scalar key `readGenomeSchemaInputs` (and `GenomeSchema::processWorldfile`) reads. */
const WORLD_KEYS = [
  'GenomeLayout',
  'GeneticOperatorResolution',
  'EnableEvolution',
  'MinMutationRate',
  'MaxMutationRate',
  'MinMutationStdevPower',
  'MaxMutationStdevPower',
  'MinCrossoverPoints',
  'MaxCrossoverPoints',
  'MiscegenationFunctionBias',
  'MiscegenationFunctionInverseSlope',
  'MinInitialBitProb',
  'MaxInitialBitProb',
  'SeedType',
  'SeedMutationRate',
  'SimpleSeedYawBiasDelta',
  'SeedFightBias',
  'SeedFightExcitation',
  'SeedGiveBias',
  'SeedPickupBias',
  'SeedDropBias',
  'SeedPickupExcitation',
  'SeedDropExcitation',
  'GrayCoding',
  'BrainArchitecture',
  'NeuronModel',
  'MaxBiasWeight',
  'MaxSynapseWeight',
  'LearningMode',
  'MinLearningRate',
  'MaxLearningRate',
  'GaussianInitSynapseWeight',
  'TauMin',
  'TauMax',
  'TauSeed',
  'GainMin',
  'GainMax',
  'GainSeed',
  'EnableSpikingGenes',
  'SpikingAMin',
  'SpikingAMax',
  'SpikingBMin',
  'SpikingBMax',
  'SpikingCMin',
  'SpikingCMax',
  'SpikingDMin',
  'SpikingDMax',
  'MinLifeSpan',
  'MaxLifeSpan',
  'MinAgentStrength',
  'MaxAgentStrength',
  'MinAgentSize',
  'MaxAgentSize',
  'MinAgentMaxSpeed',
  'MaxAgentMaxSpeed',
  'MinEnergyFractionToOffspring',
  'MaxEnergyFractionToOffspring',
  'BodyGreenChannel',
  'NoseColor',
  'YawEncoding',
  'EnableMateWaitFeedback',
  'EnableSpeedFeedback',
  'EnableCarry',
  'EnableVisionPitch',
  'EnableVisionYaw',
  'EnableGive',
  'MinVisionNeuronsPerGroup',
  'MaxVisionNeuronsPerGroup',
  'MinInternalNeuralGroups',
  'MaxInternalNeuralGroups',
  'MinExcitatoryNeuronsPerGroup',
  'MaxExcitatoryNeuronsPerGroup',
  'MinInhibitoryNeuronsPerGroup',
  'MaxInhibitoryNeuronsPerGroup',
  'OrderedInternalNeuralGroups',
  'MinConnectionDensity',
  'MaxConnectionDensity',
  'MinTopologicalDistortion',
  'MaxTopologicalDistortion',
  'SeedVisionNeurons',
  'SimpleSeedConnectionDensity',
  'SimpleSeedIOConnectionDensity',
  'MirroredTopologicalDistortion',
  'EnableTopologicalDistortionRngSeed',
  'MinTopologicalDistortionRngSeed',
  'MaxTopologicalDistortionRngSeed',
  'EnableInitWeightRngSeed',
  'MinInitWeightRngSeed',
  'MaxInitWeightRngSeed',
  'AgentMetabolismSelectionMode',
  'MaxAgents',
  'InitAgents',
] as const;

function worldfileText(scenario: string): string {
  return readFileSync(path.join(oracleRoot, scenario, 'run', 'normalized.wf'), 'utf8');
}

/** The normalized worldfile's text for one top-level key (comment and `;` stripped). */
function rawValue(text: string, key: string): string {
  const line = text
    .split('\n')
    .find((candidate) => new RegExp(`^\\s*${key}\\s+\\S`).test(candidate));
  if (line === undefined) throw new Error(`normalized.wf: no top-level key '${key}'`);
  return line
    .replace(/^\s*[^\s]+\s+/, '')
    .replace(/\s*#.*$/, '')
    .replace(/;\s*$/, '')
    .trim();
}

/**
 * Count the elements of an indented worldfile block: `Key [\n    {\n … \n    }\n  ]` — one
 * element per line whose only content is `{`. (`AgentMetabolisms` is the only block this lane
 * needs; the count is `Metabolism::getNumberOfDefinitions()`.)
 */
function blockElementCount(text: string, key: string): number {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*[\\[{]\\s*$`).test(line));
  if (start === -1) throw new Error(`normalized.wf: no block '${key}'`);
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*[\]}]\s*$/.test(line)) break;
    if (line.trim() === '{') count++;
  }
  return count;
}

/** A `PropertyNode` document holding exactly the keys the genome lane reads. */
function genomeDocument(scenario: string): ReturnType<typeof createConfig> {
  const text = worldfileText(scenario);
  const values: Record<string, MemoryValue> = {};

  for (const key of WORLD_KEYS) {
    const raw = rawValue(text, key);
    const substitution = SUBSTITUTIONS[key];
    if (substitution) {
      if (substitution.rawStartsWith !== undefined) {
        expect(raw.startsWith(substitution.rawStartsWith)).toBe(true);
      }
      if (substitution.rawIdentifier !== undefined) {
        expect(raw).toBe(substitution.rawIdentifier);
      }
      if (substitution.referencedKey !== undefined && substitution.referencedKey !== key) {
        // The substituted value must be the referenced property's own literal in this file.
        expect(Number(rawValue(text, substitution.referencedKey)).toString()).toBe(
          Number(substitution.value).toString(),
        );
      }
      values[key] = substitution.value;
    } else {
      values[key] = raw;
    }
  }

  // `GeneInterpolationPower []` — native reads `.elements()`, which is empty here.
  expect(rawValue(text, 'GeneInterpolationPower')).toBe('[]');
  values['GeneInterpolationPower'] = [];

  // `Metabolism::getNumberOfDefinitions()` — only the count matters to this lane.
  const metabolismCount = blockElementCount(text, 'AgentMetabolisms');
  values['AgentMetabolisms'] = Array.from({ length: metabolismCount }, (_, i) => ({
    Name: `metabolism-${i}`,
  }));

  return createConfig(documentFromJs(values));
}

interface BuiltGenome {
  readonly util: GenomeUtil;
  readonly schema: GenomeSchema;
  readonly layout: GenomeLayout;
  readonly files: GenomeMetaFiles;
  /** `MaxAgents` — `InitAgents` is an identifier reference to it in the recorded worldfiles. */
  readonly maxAgents: number;
}

function buildGenome(scenario: string): BuiltGenome {
  const cfg = genomeDocument(scenario);
  const inputs = readGenomeSchemaInputs(cfg);

  GenomeSchema.processWorldfile(cfg);

  const util = new GenomeUtil();
  const schema = util.createSchema(inputs);
  const layout = util.layout;
  if (!layout) throw new Error('no layout');

  assertPrintableSchema(schema);
  return {
    util,
    schema,
    layout,
    files: renderGenomeMeta(schema, layout),
    maxAgents: cfg.getInt('MaxAgents'),
  };
}

/** Where the parity harness looks for this lane's candidate run tree.
 *
 * t_37bf7212: refused when it resolves into the frozen oracle — this tree is written file-by-file
 * under `<candidateRoot>/<scenario>/run/**`, so a candidate root of `oracle` would rewrite the
 * golden. Allowed: `$TMPDIR` and `oracle/_t_*`.
 *
 * t_84885d07: the **default** is keyed per worker process —
 * `<tmpdir>/polyworld-genome-candidates/pid-<pid>[-t<thread>]`, the shape t_37bf7212 gave the logs
 * corpus and t_1ce9957f the browser
 * lane. One fixed directory was shared by every concurrent `npx vitest run` on the checkout while
 * `writeCandidateTree` writes each meta file with `writeFileSync` (truncate-then-write) and
 * `writes the candidate run tree the parity harness reads` reads them straight back: two
 * processes had one reading a file the other had just truncated — `expected '' to be '0\tMutation
 * Rate\n1\tCrossoverPointCou…'`, 1 red round in 4 at four-way concurrency (measured 2026-09-29;
 * zero in 12 rounds with the key). `POLYWORLD_GENOME_CANDIDATE_ROOT` is still honoured verbatim:
 * nothing is appended to a caller's root, so the `run_parity.sh --candidate <dir>` recipe in
 * PARITY.md keeps resolving.
 */
function defaultGenomeCandidateRoot(tmpdir: string, pid: number, thread: number): string {
  const leaf = thread === 0 ? `pid-${pid}` : `pid-${pid}-t${thread}`;
  return path.join(tmpdir, 'polyworld-genome-candidates', leaf);
}

const candidateRoot = assertUsableStagingRoot(
  process.env.POLYWORLD_GENOME_CANDIDATE_ROOT ??
    defaultGenomeCandidateRoot(os.tmpdir(), process.pid, threadId),
  'POLYWORLD_GENOME_CANDIDATE_ROOT (the genome lane candidate root)',
);

function writeCandidateTree(scenario: string, built: BuiltGenome): string {
  const dir = path.join(candidateRoot, scenario);
  assertUsableStagingRoot(dir, `genome.test/writeCandidateTree(${scenario})`);
  for (const name of META_FILES) {
    const target = path.join(dir, 'run', 'genome', 'meta', name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, built.files[`run/genome/meta/${name}`]);
  }

  // The initial population's genomes (`genome_<n>.txt.gz`, n = 1..InitAgents). Native writes
  // them through the datalib gzip sink (lane L2/L12); the framing below is that sink's, and
  // it is verified byte-identical to the golden (see `seedGenomeGz`).
  for (let n = 1; n <= built.maxAgents; n++) {
    const target = path.join(dir, 'run', 'genome', 'agents', `genome_${n}.txt.gz`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, seedGenomeGz(built));
  }
  return dir;
}

/** Native `GenomeLog`: `birth.a->Genes()->dump( out )` for `BR_SIMINIT` births. */
function seedGenome(built: BuiltGenome): string {
  const rng = new ScriptedRng([], 0, 0.5);
  const genome = (built.schema as GroupsGenomeSchema).createGenome(built.layout, rng);
  built.schema.seed(genome, rng);
  rng.drand48(); // `if ( randpw() < probabilityOfMutatingSeeds )` — SeedMutationProbability
  genome.mutateRate(0.0); // `genes->mutate( fRawSeedMutationRate )` — RawSeedMutationRate
  const lines: string[] = [];
  genome.dump({ write: (text) => void lines.push(text) });
  return lines.join('');
}

/**
 * The gzip framing of `run/genome/agents/genome_<n>.txt.gz`: gzip, Z_DEFAULT_COMPRESSION
 * (level 6), mtime 0, no name, OS byte 0x13 (darwin), then CRC32/ISIZE little-endian —
 * measured byte-identical to the recorded goldens (`zlib.deflateRawSync` at level 6 emits
 * the same deflate stream as the native's libz).
 */
function seedGenomeGz(built: BuiltGenome): Buffer {
  const raw = Buffer.from(seedGenome(built), 'latin1');
  const body = deflateRawSync(raw, { level: 6 });
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x13]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw) >>> 0, 0);
  trailer.writeUInt32LE(raw.length >>> 0, 4);
  return Buffer.concat([header, body, trailer]);
}

/** CRC-32 (IEEE), as the gzip trailer carries it. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const goldenAvailable = SCENARIOS.every((scenario) =>
  existsSync(path.join(oracleRoot, scenario, 'run', 'genome', 'meta', 'geneindex.txt')),
);

describe.skipIf(!goldenAvailable)('L5 genome — oracle parity (run/genome/meta/**)', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario, () => {
      const built = buildGenome(scenario);

      it('renders every meta file byte-for-byte', () => {
        const goldenDir = path.join(oracleRoot, scenario, 'run', 'genome', 'meta');
        const mismatches: string[] = [];

        for (const name of META_FILES) {
          const golden = readFileSync(path.join(goldenDir, name), 'utf8');
          const candidate = built.files[`run/genome/meta/${name}`];
          if (golden !== candidate) mismatches.push(name);
        }

        expect(mismatches).toEqual([]);
        expect(built.schema.getMutableSize()).toBe(2843);
      });

      it('writes the candidate run tree the parity harness reads', () => {
        const dir = writeCandidateTree(scenario, built);
        for (const name of META_FILES) {
          const written = readFileSync(
            path.join(dir, 'run', 'genome', 'meta', name),
            'utf8',
          );
          expect(written).toBe(built.files[`run/genome/meta/${name}`]);
        }
      });

      it('matches the genestats.txt header (the schema size, written at init)', () => {
        const golden = readFileSync(
          path.join(oracleRoot, scenario, 'run', 'genome', 'genestats.txt'),
          'utf8',
        );
        const firstLine = `${golden.split('\n')[0] ?? ''}\n`;
        expect(renderGeneStatsHeader(built.schema)).toBe(firstLine);
      });

      it('anchors the gene layout to the golden offsets', () => {
        // Both files walk the *genes* in schema order, so line N is the gene whose gene
        // offset is N; genelayout.txt prints that gene's *mutable data* offset instead.
        const index = built.files['run/genome/meta/geneindex.txt'];
        const layout = built.files['run/genome/meta/genelayout.txt'];
        const lineAt = (text: string, geneOffset: number): string =>
          text.split('\n')[geneOffset] ?? '';

        const byGene: Record<number, readonly [string, string]> = {
          0: ['0\tMutationRate', '0\tMutationRate'],
          8: ['8\tRed', '8\tRed'],
          11: ['11\tInternalNeuronGroupCount', '11\tInternalNeuronGroupCount'],
          12: ['12\tExcitatoryNeuronCount_0', '2048\tExcitatoryNeuronCount_0'],
          17: ['17\tInhibitoryNeuronCount_0', '2049\tInhibitoryNeuronCount_0'],
          22: ['22\tBias_0', '792\tBias_0'],
          35: ['35\tEEConnectionDensity_0->5', '12\tEEConnectionDensity_0->5'],
          971: ['971\tEELearningRate_0->5', '13\tEELearningRate_0->5'],
          1907: ['1907\tEETopologicalDistortion_0->5', '14\tEETopologicalDistortion_0->5'],
          2842: [
            '2842\tIETopologicalDistortion_17->17',
            '2842\tIETopologicalDistortion_17->17',
          ],
        };

        for (const [offset, [expectedIndex, expectedLayout]] of Object.entries(byGene)) {
          const geneOffset = Number(offset);
          expect(lineAt(index, geneOffset)).toBe(expectedIndex);
          expect(lineAt(layout, geneOffset)).toBe(expectedLayout);
        }

        // geneindex != genelayout: the layout really is a reordering, not the identity map.
        expect(layout).not.toBe(index);
      });
    });
  }

  it('both recorded scenarios share one schema (their genome configs are identical)', () => {
    const micro = buildGenome('microtest_voff');
    const mini = buildGenome('minitest_voff');
    expect(mini.files).toEqual(micro.files);
  });

  /**
   * The initial population's genomes: `run/genome/agents/genome_<n>.txt.gz`. Native
   * (`sim/Simulation.cc: TSimulation::SeedGenome`) builds each one with
   *
   *   GenomeUtil::seed( genes )                      -> schema->seed( genome )
   *   if ( randpw() < probabilityOfMutatingSeeds )   -> SeedMutationProbability == 0.0
   *   genes->mutate( fRawSeedMutationRate )          -> RawSeedMutationRate == 0.0
   *
   * so the *contents* are RNG-free (the draws happen, they just cannot flip a bit at a rate
   * of 0) — which is why the initial agents' genomes are byte-identical to each other. That
   * makes the whole seeding path checkable without the simulation: this lane produces the
   * dumped bytes and the gzip framing (lane L2's sink, measured byte-identical here) and
   * compares every initial-population file with the golden.
   *
   * Agents born *after* SimInit are crossover products of the run and are out of reach for
   * this lane (they need the simulation, L11); the recorded minitest golden shows exactly
   * that boundary — files 1..25 are the seeded genome and 26..87 differ from it.
   */
  for (const scenario of SCENARIOS) {
    it(`${scenario}: reproduces every initial-population genome byte-for-byte`, () => {
      const built = buildGenome(scenario);
      const seed = seedGenome(built);
      const gz = seedGenomeGz(built);

      const agentDir = path.join(oracleRoot, scenario, 'run', 'genome', 'agents');
      const goldenFiles = readdirSync(agentDir).filter((name) => name.endsWith('.txt.gz'));
      expect(goldenFiles.length).toBeGreaterThanOrEqual(built.maxAgents);

      const seededGolden: string[] = [];
      for (let n = 1; n <= built.maxAgents; n++) {
        const goldenGz = readFileSync(path.join(agentDir, `genome_${n}.txt.gz`));
        const golden = gunzipSync(goldenGz).toString('latin1');
        expect(golden).toBe(seed);
        expect(goldenGz.toString('latin1')).toBe(gz.toString('latin1'));
        seededGolden.push(`genome_${n}.txt.gz`);
      }
      expect(seededGolden.length).toBe(built.maxAgents);

      // Beyond the initial population the golden *does* diverge (crossovers need the run).
      const born = goldenFiles.filter((name) => !seededGolden.includes(name));
      if (born.length > 0) {
        const firstBorn = readFileSync(path.join(agentDir, born[0] ?? ''));
        expect(gunzipSync(firstBorn).toString('latin1')).not.toBe(seed);
      }
    });
  }
});

// ======================================================================================== //
// Semantics
// ======================================================================================== //

/** A scripted `RngSurface`: draws come from a list, anything unused throws. */
class ScriptedRng implements RngSurface {
  drand48Calls = 0;
  nrandScaledCalls = 0;

  constructor(
    private readonly draws: readonly number[] = [],
    private readonly normalOffset = 0,
    /** Returned once the script is exhausted; `undefined` makes an extra draw an error. */
    private readonly defaultDraw?: number,
  ) {}

  srand(_seed: number): void {
    throw new Error('scripted rng: srand');
  }

  rand(): number {
    throw new Error('scripted rng: rand');
  }

  srand48(_seed: number): void {
    throw new Error('scripted rng: srand48');
  }

  drand48(): number {
    const value = this.draws[this.drand48Calls] ?? this.defaultDraw;
    this.drand48Calls++;
    if (value === undefined) throw new Error('scripted rng: exhausted');
    return value;
  }

  lrand48(): number {
    throw new Error('scripted rng: lrand48');
  }

  nrand(): number {
    throw new Error('scripted rng: nrand');
  }

  nrandScaled(mean: number, _stdev: number): number {
    this.nrandScaledCalls++;
    return mean + this.normalOffset;
  }
}

function builtSchemaFor(scenario = 'microtest_voff'): BuiltGenome {
  return buildGenome(scenario);
}

describe('L5 genome — values and printf', () => {
  it('reproduces C "%f" (six decimals, from the exact value)', () => {
    expect(formatFloat6(0.1)).toBe('0.100000');
    expect(formatFloat6(0.6)).toBe('0.600000');
    expect(formatFloat6(-8)).toBe('-8.000000');
    expect(formatFloat6(0)).toBe('0.000000');
    expect(formatFloat6(-0)).toBe('-0.000000');
    expect(formatFloat6(0.9999999)).toBe('1.000000');
    expect(formatFloat6(Math.fround(1 / 3))).toBe('0.333333');
    expect(formatFloat6(1e21)).toBe('1000000000000000000000.000000');
  });

  it('reproduces the native Scalar text', () => {
    expect(Scalar.int(2).str()).toBe('INT 2');
    expect(Scalar.float(0.1).str()).toBe('FLOAT 0.100000');
    expect(Scalar.float(1 / 3).str()).toBe('FLOAT 0.333333');
    expect(Scalar.bool(true).str()).toBe('BOOL true');
  });

  it('nint truncates toward zero after the native +-0.499999999 shift', () => {
    // The epsilon is 0.499999999, not 0.5: nint(0.5) is (long)0.999999999 == 0.
    expect(nint(0.5)).toBe(0);
    expect(nint(0.5000001)).toBe(1);
    expect(nint(0.6)).toBe(1);
    expect(nint(0.4)).toBe(0);
    expect(nint(-0.5)).toBe(0); // (long)-0.999999999 truncates toward zero
    expect(nint(-0.6)).toBe(-1);
    expect(nint(-1.5)).toBe(-1);
    expect(nint(8.529)).toBe(9);
  });
});

/** The f32 bit pattern of a value, as `%08x` — the form the native probe dumps. */
function f32Hex(value: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return view.getUint32(0).toString(16).padStart(8, '0');
}

/**
 * `__InterpolatedGene::interpolate( unsigned char raw )` written out longhand from
 * `../polyworld/src/library/genome/Gene.cc:182-224` and `utils/misc.h:36-38`, so the sweep
 * below tests `gene.ts` against the C it claims to reproduce instead of against itself:
 *
 *   static const float OneOver255 = 1. / 255.;
 *   double ratio = float(raw) * OneOver255;   // float * float, i.e. an f32 product
 *   if( interpolationPower != 1.0 ) ratio = pow( ratio, interpolationPower );
 *   case Scalar::FLOAT: return (float)interp( ratio, float(smin), float(smax) );
 *   #define interp(x,ylo,yhi) ((ylo)+(x)*((yhi)-(ylo)))
 *
 * `float(smin)`/`float(smax)` are what make `(yhi)-(ylo)` a **float** subtraction; the INT
 * cases of the switch subtract two `int`s and have no float operand. `interpolationPower`
 * is 1.0 for every gene any recorded worldfile defines, so the `pow` branch is not modelled
 * here (PARITY.md → Gaps: L1 owns a bit-exact `pow`).
 */
function nativeFloatInterpolateBits(gene: Gene, raw: number): string {
  // `float(raw) * OneOver255` with both operands float: the f64 product of two f32 values is
  // exact, so one `Math.fround` of it *is* the correctly rounded float multiply.
  const ratio = Math.fround(Math.fround(raw) * Math.fround(1 / 255));
  const lo = gene.getMin().asFloat();
  const hi = gene.getMax().asFloat();
  return f32Hex(lo + ratio * Math.fround(hi - lo)); // (float) of the double expression
}

describe('L5 genome — interpolation', () => {
  it('interpolates each rounding mode as native does', () => {
    const nearest = new MutableScalarGene('g', Scalar.int(1), Scalar.int(16), Rounding.INT_NEAREST);
    expect(nearest.interpolate(0).asInt()).toBe(1);
    expect(nearest.interpolate(255).asInt()).toBe(16);
    expect(nearest.interpolate(128).asInt()).toBe(9); // nint( 1 + (128/255)*15 )

    const floor = new MutableScalarGene('g', Scalar.int(2), Scalar.int(100), Rounding.INT_FLOOR);
    expect(floor.interpolate(0).asInt()).toBe(2);
    expect(floor.interpolate(255).asInt()).toBe(100);
    expect(floor.interpolate(4).asInt()).toBe(3); // truncate( 2 + (4/255)*98 ) == 3

    const bin = new MutableScalarGene('g', Scalar.int(0), Scalar.int(5), Rounding.INT_BIN);
    expect(bin.interpolate(0).asInt()).toBe(0);
    expect(bin.interpolate(255).asInt()).toBe(5);
    expect(bin.interpolate(51).asInt()).toBe(1); // (int)(0 + (51/255)*6) == 1

    const float = new MutableScalarGene('g', Scalar.float(0.5), Scalar.float(2), Rounding.INT_FLOOR);
    expect(float.interpolate(0).asFloat()).toBe(0.5);
    expect(float.interpolate(255).asFloat()).toBe(2);
  });

  it('rounds the ratio to f32 (float(raw) * float(1/255), not a double product)', () => {
    const gene = new MutableScalarGene('g', Scalar.float(0), Scalar.float(1), Rounding.INT_FLOOR);

    // A non-power-of-two raw is where the double product and the float product differ.
    expect(gene.interpolate(33).asFloat()).toBe(Math.fround(33 * Math.fround(1 / 255)));
    expect(Math.fround(33 * Math.fround(1 / 255))).not.toBe(33 * Math.fround(1 / 255));

    // At raw 128 the double product is exact, so both roundings coincide — which is why the
    // recorded scenarios (raw 0 / 128 / 255) cannot see this on their own.
    expect(gene.interpolate(128).asFloat()).toBe(Math.fround(128 * Math.fround(1 / 255)));
    expect(Math.fround(128 * Math.fround(1 / 255))).toBe(128 * Math.fround(1 / 255));
  });

  it('rounds the FLOAT range difference to f32 (interp subtracts two floats)', () => {
    // `interp(ratio, float(smin), float(smax))`: (hi - lo) is float - float and is rounded
    // before the double multiply. 0.6f - 0.1f is the recorded BitProbability range and is one
    // of the differences that does *not* survive as a double.
    const gene = new MutableScalarGene(
      'BitProbability',
      Scalar.float(0.1),
      Scalar.float(0.6),
      Rounding.INT_NEAREST,
    );
    const ratio = Math.fround(123 * Math.fround(1 / 255));
    const lo = Math.fround(0.1);
    const hi = Math.fround(0.6);
    expect(Math.fround(hi - lo)).not.toBe(hi - lo);

    expect(gene.interpolate(123).asFloat()).toBe(Math.fround(lo + ratio * Math.fround(hi - lo)));
    // ... and the same value in the native build's own spelling (see the anchors below).
    expect(formatFloat6(gene.interpolate(123).asFloat())).toBe('0.341176');
  });

  it('matches the native expression for every interpolated FLOAT gene and raw byte', () => {
    const { schema } = builtSchemaFor();
    const genes = schema
      .getAll()
      .filter((gene) => gene.isInterpolated() && gene.getMin().kind === 'FLOAT');

    // The scenario's FLOAT genes: the physiology scalars + the neuron-group ranges.
    expect(genes.map((gene) => gene.name).sort()).toEqual([
      'Bias',
      'BitProbability',
      'ConnectionDensity',
      'ID',
      'LearningRate',
      'MateEnergyFraction',
      'MaxSpeed',
      'MutationRate',
      'Size',
      'Strength',
      'TopologicalDistortion',
    ]);

    const mismatches: string[] = [];
    for (const gene of genes) {
      for (let raw = 0; raw < 256; raw++) {
        const actual = f32Hex(gene.interpolate(raw).asFloat());
        const expected = nativeFloatInterpolateBits(gene, raw);
        if (actual !== expected) mismatches.push(`${gene.name} raw=${raw} ${actual} != ${expected}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * Anchors from a probe compiled from the oracle tree's own `Gene.cc`/`GeneSchema.cc`
   * (`clang++ -std=c++17 -O2`), run over all 19 interpolated genes x 256 raw bytes with the
   * min/max dumped bit-exactly from this port. The pre-fix arithmetic (`Math.fround(raw) *
   * ONE_OVER_255` and `hi - lo` both in f64) disagreed with that probe on **540 of 4864**
   * rows across 8 genes (Bias 158, MutationRate 83, BitProbability 76, LearningRate 60,
   * MaxSpeed 54, MateEnergyFraction 41, Size 34, Strength 34); with the f32 product and the
   * f32 range difference it agrees on **4864/4864**. These rows are the first diverging row
   * of three of the affected genes plus one unaffected pair, so a regression here fails even
   * if `nativeFloatInterpolateBits` above drifts with the implementation.
   */
  it('matches the native build at non-power-of-two raw values (probe anchors)', () => {
    const { schema } = builtSchemaFor();

    const anchors = [
      // name, raw, native f32 bits, native `Scalar::str()` text (pre-fix port value)
      ['Bias', 33, 'c0bdbdbe', '-5.929412'], // pre-fix: c0bdbdbd / -5.929411
      ['BitProbability', 123, '3eaeaeaf', '0.341176'], // pre-fix: 3eaeaeb0 / 0.341177
      ['Strength', 208, '3fdc9c9e', '1.723530'], // pre-fix: 3fdc9c9d / 1.723529
      ['Size', 208, '3fdc9c9e', '1.723530'], // pre-fix: 3fdc9c9d / 1.723529
      ['MutationRate', 208, '3d2e9a20', '0.042627'], // unaffected by the fix
      ['MateEnergyFraction', 123, '3efa942f', '0.489412'], // unaffected by the fix
    ] as const;

    for (const [name, raw, bits, text] of anchors) {
      const gene = schema.get(name);
      expect(gene, `no gene '${name}'`).not.toBeNull();
      const value = (gene as Gene).interpolate(raw).asFloat();
      expect([name, raw, f32Hex(value)]).toEqual([name, raw, bits]);
      expect([name, raw, formatFloat6(value)]).toEqual([name, raw, text]);
    }
  });

  it('keeps an immutable gene out of the mutable data', () => {
    const gene = new ImmutableScalarGene('g', Scalar.int(7));
    expect(gene.ismutable).toBe(false);
    expect(gene.getMutableSize()).toBe(0);
    expect(gene.get({}).asInt()).toBe(7);
  });
});

describe('L5 genome — schema mechanics', () => {
  it('assigns offsets left to right and rejects duplicates', () => {
    const schema = new GeneSchema();
    const first = schema.add(new MutableScalarGene('a', Scalar.int(0), Scalar.int(1), Rounding.INT_FLOOR));
    const second = schema.add(new MutableScalarGene('b', Scalar.int(0), Scalar.int(255), Rounding.INT_BIN));

    expect(first.offset).toBe(-1);
    expect(() => schema.getMutableSize()).toThrow(/not complete and not caching/);
    expect(() => schema.add(new MutableScalarGene('b', Scalar.int(0), Scalar.int(1), Rounding.INT_FLOOR))).toThrow(
      /duplicate gene name/,
    );

    schema.complete();
    expect(schema.getMutableSize()).toBe(2);
    expect(first.offset).toBe(0);
    expect(second.offset).toBe(1);
    expect(schema.get('a')).toBe(first);
    expect(schema.get('nope')).toBe(null);
    expect(() => schema.add(new MutableScalarGene('c', Scalar.int(0), Scalar.int(1), Rounding.INT_FLOOR))).toThrow(
      /while constructing/,
    );
  });

  it('prints a layout hole as an error (native exits 1)', () => {
    const layout = new GenomeLayout(3);
    layout.set(0, 0);
    layout.set(1, 2);
    layout.set(2, 1);
    layout.validate();
    expect(layout.getMutableDataOffset(1)).toBe(2);

    // A slot that is claimed twice (and one never claimed) is what validate() rejects.
    const doubled = new GenomeLayout(2);
    doubled.set(0, 0);
    doubled.set(1, 0);
    expect(() => doubled.validate()).toThrow(/\[0\]=2/);

    // An unset slot maps to -1, which the native validate() would index with (-1).
    const hole = new GenomeLayout(2);
    hole.set(0, 0);
    expect(() => hole.validate()).toThrow(/maps to -1/);
  });

  it('renders ranges with the native rounding names', () => {
    const { files } = builtSchemaFor();
    const ranges = files['run/genome/meta/generange.txt'].split('\n');
    expect(ranges[0]).toBe('None FLOAT 0.100000 FLOAT 0.600000 BitProbability');
    expect(ranges[1]).toBe('None FLOAT 0.010000 FLOAT 0.050000 MutationRate');
    expect(ranges[2]).toBe('IntFloor INT 2 INT 100 CrossoverPointCount');
    expect(ranges[3]).toBe('IntFloor INT 500 INT 1000 LifeSpan');
    expect(ranges.length - 1).toBe(19);
    expect(files['run/genome/meta/genetitle.txt'].split('\n').length - 1).toBe(35);
  });

  it('sorts genelayout with the sort -n rule (unique keys, byte tie-break)', () => {
    expect(renderGeneLayoutSorted('10\tx\n2\ty\n0\tz\n')).toBe('0\tz\n2\ty\n10\tx\n');
  });
});

describe.skipIf(!goldenAvailable)('L5 genome — the Sheets refusal is a measured deviation, not a stub', () => {
  it('names the PARITY.md finding and the probe, and claims no lane', () => {
    const inputs = readGenomeSchemaInputs(genomeDocument('microtest_voff'));
    const util = new GenomeUtil();

    let message = '';
    try {
      util.createSchema({ ...inputs, architecture: 'Sheets' });
    } catch (error) {
      message = (error as Error).message;
    }

    // The refusal is the honest equivalent of native's inert Sheets run — it must say so,
    // and it must not read as work waiting for a lane.
    expect(message).toContain('the Sheets architecture is not ported');
    expect(message).toContain('probe_sheets_architecture.sh');
    expect(message).toMatch(/The `Sheets` architecture in the shipped oracle/);
    expect(message).not.toMatch(/deferred|lane L6|see PARITY\.md -> Gaps/);
  });
});

describe('L5 genome — Groups schema shape', () => {
  const { schema } = builtSchemaFor();
  const groups = schema as GroupsGenomeSchema;

  it('counts groups the way the layout depends on', () => {
    expect(groups.getPhysicalCount()).toBe(8);
    expect(groups.getMaxGroupCount(NeurGroupType.INPUT)).toBe(5);
    expect(groups.getMaxGroupCount(NeurGroupType.OUTPUT)).toBe(8);
    expect(groups.getMaxGroupCount(NeurGroupType.INTERNAL)).toBe(5);
    expect(groups.getMaxGroupCount(NeurGroupType.ANY)).toBe(18);
    expect(groups.getMaxGroupCount(NeurGroupType.NONINPUT)).toBe(13);
    expect(groups.getFirstGroupOfType(NeurGroupType.OUTPUT)).toBe(5);
    expect(groups.getFirstGroupOfType(NeurGroupType.INTERNAL)).toBe(13);
    expect(groups.getNeurGroupType(4)).toBe(NeurGroupType.INPUT);
    expect(groups.getNeurGroupType(5)).toBe(NeurGroupType.OUTPUT);
    expect(groups.getNeurGroupType(13)).toBe(NeurGroupType.INTERNAL);
  });

  it('sizes the four synapse matrices exactly', () => {
    expect(groups.getSynapseTypeCount()).toBe(4);
    expect(groups.getSynapseType('EE').getMutableSize()).toBe(18 * 13);
    expect(schema.get('ConnectionDensity')?.getMutableSize()).toBe(4 * 18 * 13);
    expect(schema.getMutableSize()).toBe(8 + 4 + 5 + 5 + 13 + 3 * 4 * 18 * 13);
  });
});

describe('L5 genome — the genome operators', () => {
  const built = builtSchemaFor();

  function freshGenome(rng: RngSurface): GroupsGenome {
    return new GroupsGenome(
      built.schema as GroupsGenomeSchema,
      built.layout,
      rng,
    );
  }

  it('seeds by ratio with the native SEEDVAL mapping', () => {
    const genome = freshGenome(new ScriptedRng([]));
    genome.seedAll(0.5);
    expect(Array.from(genome.mutableData.slice(0, 4))).toEqual([128, 128, 128, 128]);
    genome.seedAll(1);
    expect(genome.mutableData[0]).toBe(255);
    genome.seedAll(0);
    expect(genome.mutableData[0]).toBe(0);
    expect(() => genome.seedAll(1.5)).toThrow(/outside \[0, 1\]/);
  });

  it('randomizes every bit from the injected surface (draw order is the contract)', () => {
    const rng = new ScriptedRng([], 0, 0.0);
    const genome = freshGenome(rng);
    const mutable = genome.nbytes;

    genome.mutateBits(1.0);
    expect(rng.drand48Calls).toBe(8 * mutable); // 8 draws per byte, MSB first
    expect(genome.mutableData[0]).toBe(255); // 0 ^ 0b11111111

    const rng0 = new ScriptedRng([], 0, 0.0);
    const genome0 = freshGenome(rng0);
    genome0.mutableData[0] = 255;
    genome0.mutateBits(0.0);
    expect(rng0.drand48Calls).toBe(8 * mutable);
    expect(genome0.mutableData[0]).toBe(255); // nothing cleared by a rate of 0
  });

  it('mutates one byte through nrand and C round()', () => {
    const up = new ScriptedRng([], 0.5);
    const genome = freshGenome(up);
    genome.mutableData[0] = 10;
    genome.mutateOneByte(0, 1);
    expect(up.nrandScaledCalls).toBe(1);
    expect(genome.mutableData[0]).toBe(11); // round( 10.5 ) == 11 in C

    const clampHigh = new ScriptedRng([], 1000);
    const high = freshGenome(clampHigh);
    high.mutableData[0] = 10;
    high.mutateOneByte(0, 1);
    expect(high.mutableData[0]).toBe(255);

    const clampLow = new ScriptedRng([], -1000);
    const low = freshGenome(clampLow);
    low.mutableData[0] = 10;
    low.mutateOneByte(0, 1);
    expect(low.mutableData[0]).toBe(0);
  });

  it('computes separation with the native f32 division', () => {
    const genome = freshGenome(new ScriptedRng([]));
    const other = freshGenome(new ScriptedRng([]));
    genome.mutableData.fill(0);
    other.mutableData.fill(0);
    genome.mutableData[0] = 255;
    other.mutableData[0] = 0;

    const expected = Math.fround(Math.fround(255) / Math.fround(255 * genome.nbytes));
    expect(genome.separation(other)).toBe(expected);
    expect(genome.separation(genome)).toBe(0);
    expect(other.separation(genome)).toBe(expected);
  });

  it('counts synapses with the output/inhibitory rules', () => {
    const genome = freshGenome(new ScriptedRng([]));
    genome.mutableData.fill(255); // every ConnectionDensity cell at its max (1.0)

    const ee = (built.schema as GroupsGenomeSchema).getSynapseType('EE');
    const ei = (built.schema as GroupsGenomeSchema).getSynapseType('EI');
    const ie = (built.schema as GroupsGenomeSchema).getSynapseType('IE');

    expect(genome.getSynapseCount(ee, 5, 6)).toBe(1); // 1 neuron each way, density 1
    expect(genome.getSynapseCount(ee, 5, 5)).toBe(0); // self group, same neuron type
    expect(genome.getSynapseCount(ie, 5, 5)).toBe(0); // output-to-output through IE
    expect(genome.getSynapseCount(ei, 5, 6)).toBe(0); // inhibitory targets are never used
    expect(genome.getNeuronCount(NeuronType.INHIBITORY, 5)).toBe(1); // fixed output group
  });

  it('copies a template genome when there are no crossover points', () => {
    // `CrossoverPointCount` can never interpolate to 0 (its range is 2..100 here), so native
    // reaches this branch only with evolution disabled — which is exactly what it does first.
    const saved = GenomeSchema.config.enableEvolution;
    GenomeSchema.config.enableEvolution = false;
    try {
      const genome = freshGenome(new ScriptedRng([0.4, 0.6]));
      const g1 = freshGenome(new ScriptedRng([]));
      const g2 = freshGenome(new ScriptedRng([]));
      g1.mutableData.fill(7);
      g2.mutableData.fill(9);

      genome.crossover(g1, g2, false);
      // draw 1 (< 0.5) picks g1 for the point count, draw 2 (>= 0.5) picks g2 as template.
      expect(Array.from(genome.mutableData)).toEqual(Array.from(g2.mutableData));
    } finally {
      GenomeSchema.config.enableEvolution = saved;
    }
  });

  it('dumps one gray-decoded byte per line', () => {
    const genome = freshGenome(new ScriptedRng([]));
    genome.mutableData.fill(0);
    genome.mutableData[0] = 3;
    const lines: string[] = [];
    genome.dump({ write: (text) => void lines.push(text) });
    expect(lines[0]).toBe('3\n');
    expect(lines.length).toBe(genome.nbytes);
  });
});

describe('L5 genome — separation cache', () => {
  it('memoizes the pair and keys it by the smaller agent number', () => {
    const cache = new SeparationCache();
    let calls = 0;
    const makeAgent = (number: number, value: number) => ({
      number: () => number,
      genes: () => ({
        separation: (_other: { separation(o: unknown): number }) => {
          calls++;
          return value;
        },
      }),
    });

    const a = makeAgent(7, 0.25);
    const b = makeAgent(3, 0.75);
    cache.init();
    cache.birth(a);
    cache.birth(b);

    expect(cache.createEntry(a, b)).toBe(0.75); // x is the smaller number (b)
    expect(cache.createEntry(b, a)).toBe(0.75); // cached
    expect(calls).toBe(1);
    expect(cache.getEntries(b).get(7)).toBe(0.75);

    cache.death(b);
    expect(() => cache.getEntries(b)).toThrow(/no slot/);
    expect(calls).toBe(1);
  });
});

describe('L5 genome — the lane never rolls its own randomness', () => {
  it('has no Math.random in src/model/genome/**', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith('.ts') ? [full] : [];
      });

    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const offenders = walk(laneRoot).filter((file) =>
      stripComments(readFileSync(file, 'utf8')).includes('Math.random'),
    );
    expect(offenders).toEqual([]);
  });
});
