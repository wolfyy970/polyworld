/**
 * Lane L5 (genome) — `genome/GenomeSchema.{h,cc}`: the architecture-independent half of
 * the genome schema (physiology genes, seed policy, worldfile parameters).
 *
 * `GenomeSchema::config` is a process-wide POD in native (`static struct Configuration`),
 * so it is **zero-initialized** until `processWorldfile()` runs — and zero means
 * `layoutType = None` and `resolution = RESOLUTION_BIT`. The port keeps that: one mutable
 * module singleton, same defaults, same single writer.
 *
 * PORT-NOTE(genome/scalar-macros): native's `SCALAR( NAME, MIN, MAX )` picks the gene class
 * from `MIN == MAX` and the *C type* of its arguments (`long`/`short` -> `Scalar(int)`,
 * `float`/`double` -> `Scalar(float)`), which is what makes `LifeSpan` an INT gene and
 * `Strength` a FLOAT gene. The port spells the two kinds out (`scalarInt` / `scalarFloat`)
 * at the same call sites, so the *kind* of every gene is still decided at its definition.
 * `ROUND_INT_FLOOR` for `SCALAR`, `ROUND_INT_BIN` for `INDEX`,
 * `ROUND_INT_NEAREST` for the immutable interpolated genes — as native.
 *
 * PORT-NOTE(genome/foreign-config-seam): `define()` reads the neighbouring config
 * singletons (`agent::config`, `Brain::config`, `GroupsBrain::config`,
 * `Metabolism::selectionMode`) to decide which genes exist and over what ranges. Those
 * singletons belong to lanes L6/L8, so this lane consumes them through an explicit input
 * object (`GenomeSchemaInputs`) instead of declaring a second copy. Where native compares
 * an enum (`bodyGreenChannel == BGC_ID`, `neuronModel == SPIKING`, `architecture ==
 * Groups`), the seam carries the *worldfile spelling* that enum is derived from
 * one-to-one, so the genome lane does not re-declare another lane's enum.
 *
 * PORT-NOTE(genome/seed-rng): `seed()` draws `randpw()` directly (global in native), so the
 * port passes the `RngSurface` in — the same single instance the rest of the model uses.
 */

import { Config, type Config as ConfigType } from '../types';
import { GeneSchema } from './geneSchema';
import { ImmutableInterpolatedGene, ImmutableScalarGene, MutableScalarGene, Rounding, type Gene } from './gene';
import { LayoutType } from './genomeLayout';
import type { Genome } from './genome';
import { Scalar } from './values';
import type { RngSurface } from '../types';

/** Native `GenomeSchema::Resolution`. */
export const Resolution = {
  BIT: 0,
  BYTE: 1,
} as const;

export type Resolution = (typeof Resolution)[keyof typeof Resolution];

/** Native `GenomeSchema::SeedType`. */
export const SeedType = {
  LEGACY: 0,
  SIMPLE: 1,
  RANDOM: 2,
} as const;

export type SeedType = (typeof SeedType)[keyof typeof SeedType];

/** The worldfile spelling of `Brain::config.architecture` (`BrainArchitecture`). */
export type Architecture = 'Groups' | 'Sheets';

/** The worldfile spelling of `Brain::config.neuronModel` (`NeuronModel`: F/T/S). */
export type NeuronModelSpelling = 'F' | 'T' | 'S';

/** The worldfile spelling of `agent::config.bodyGreenChannel` (`BodyGreenChannel`). */
export type BodyGreenChannelSpelling = 'I' | 'L' | 'E' | 'F' | 'const';

/** The worldfile spelling of `agent::config.yawEncoding` (`YawEncoding`). */
export type YawEncodingSpelling = 'Squash' | 'Oppose';

/** The worldfile spelling of `Metabolism::selectionMode` (`AgentMetabolismSelectionMode`). */
export type MetabolismSelectionSpelling = 'Gene' | 'Fixed' | 'other';

/**
 * The neighbouring config singletons `define()`/`seed()` read. Values, not owners: lanes
 * L6/L8 build this from `agent::config`, `Brain::config`, `GroupsBrain::config` and the
 * metabolism table (see PORT-NOTE(genome/foreign-config-seam)).
 */
export interface GenomeSchemaInputs {
  /** Native `Brain::config.architecture` (`BrainArchitecture`). */
  architecture: Architecture;
  /** Native `Brain::config.neuronModel` (`NeuronModel`). */
  neuronModel: NeuronModelSpelling;
  /** Native `Brain::config.maxbias` (`MaxBiasWeight`, float). */
  brainMaxBias: number;
  /** Native `Brain::config.enableLearning` (`EnableLearning`). */
  brainEnableLearning: boolean;
  /** Native `Brain::config.minlrate` (`MinLearningRate`, float). */
  brainMinLearningRate: number;
  /** Native `Brain::config.maxlrate` (`MaxLearningRate`, float). */
  brainMaxLearningRate: number;
  /** Native `Brain::config.gaussianInitWeight` (`GaussianInitSynapseWeight`). */
  brainGaussianInitWeight: boolean;
  /** Native `Brain::config.Tau` (`TauMin`/`TauMax`/`TauSeed`, float). */
  brainTau: { minVal: number; maxVal: number; seedVal: number };
  /** Native `Brain::config.Gain` (`GainMin`/`GainMax`/`GainSeed`, float). */
  brainGain: { minVal: number; maxVal: number; seedVal: number };
  /** Native `Brain::config.Spiking` (`EnableSpikingGenes`, `Spiking{A,B,C,D}{Min,Max}`). */
  brainSpiking: {
    enableGenes: boolean;
    aMinVal: number;
    aMaxVal: number;
    bMinVal: number;
    bMaxVal: number;
    cMinVal: number;
    cMaxVal: number;
    dMinVal: number;
    dMaxVal: number;
  };

  agent: {
    /** native `long` -> INT gene (`MinLifeSpan`). */
    minLifeSpan: number;
    /** native `long` -> INT gene (`MaxLifeSpan`). */
    maxLifeSpan: number;
    /** native `float` -> FLOAT gene (`MinAgentStrength`). */
    minStrength: number;
    /** native `float` -> FLOAT gene (`MaxAgentStrength`). */
    maxStrength: number;
    /** native `float` -> FLOAT gene (`MinAgentSize`). */
    minAgentSize: number;
    /** native `float` -> FLOAT gene (`MaxAgentSize`). */
    maxAgentSize: number;
    /** native `float` -> FLOAT gene (`MinAgentMaxSpeed`). */
    minMaxSpeed: number;
    /** native `float` -> FLOAT gene (`MaxAgentMaxSpeed`). */
    maxMaxSpeed: number;
    /** native `float` -> FLOAT gene (`MinEnergyFractionToOffspring`). */
    minMateEnergyFraction: number;
    /** native `float` -> FLOAT gene (`MaxEnergyFractionToOffspring`). */
    maxMateEnergyFraction: number;
    /** Native `agent::config.bodyGreenChannel` (`BodyGreenChannel`). */
    bodyGreenChannel: BodyGreenChannelSpelling;
    /** Native `agent::config.yawEncoding` (`YawEncoding`). */
    yawEncoding: YawEncodingSpelling;
    /** Native `agent::config.hasLightBehavior` — derived, see the worldfile reader. */
    hasLightBehavior: boolean;
    enableMateWaitFeedback: boolean;
    enableSpeedFeedback: boolean;
    enableCarry: boolean;
    enableVisionPitch: boolean;
    enableVisionYaw: boolean;
    enableGive: boolean;
  };

  groupsBrain: {
    /** native `short` -> INT (`MinVisionNeuronsPerGroup`). */
    minVisionNeuronsPerGroup: number;
    /** native `short` -> INT (`MaxVisionNeuronsPerGroup`). */
    maxVisionNeuronsPerGroup: number;
    /** native `short` -> INT (`MinInternalNeuralGroups`). */
    minInternalNeuralGroups: number;
    /** native `short` -> INT (`MaxInternalNeuralGroups`). */
    maxInternalNeuralGroups: number;
    /** native `short` -> INT (`MinExcitatoryNeuronsPerGroup`). */
    minExcitatoryNeuronsPerGroup: number;
    /** native `short` -> INT (`MaxExcitatoryNeuronsPerGroup`). */
    maxExcitatoryNeuronsPerGroup: number;
    /** native `short` -> INT (`MinInhibitoryNeuronsPerGroup`). */
    minInhibitoryNeuronsPerGroup: number;
    /** native `short` -> INT (`MaxInhibitoryNeuronsPerGroup`). */
    maxInhibitoryNeuronsPerGroup: number;
    orderedInternalNeuralGroups: boolean;
    /** native `float` (`MinConnectionDensity`). */
    minConnectionDensity: number;
    /** native `float` (`MaxConnectionDensity`). */
    maxConnectionDensity: number;
    /** native `float` (`MinTopologicalDistortion`). */
    minTopologicalDistortion: number;
    /** native `float` (`MaxTopologicalDistortion`). */
    maxTopologicalDistortion: number;
    /** native `float` (`SeedVisionNeurons`). */
    seedVisionNeurons: number;
    /** native `float` (`SimpleSeedConnectionDensity`). */
    simpleSeedConnectionDensity: number;
    /** native `float` (`SimpleSeedIOConnectionDensity`). */
    simpleSeedIOConnectionDensity: number;
    mirroredTopologicalDistortion: boolean;
    enableTopologicalDistortionRngSeed: boolean;
    minTopologicalDistortionRngSeed: number;
    maxTopologicalDistortionRngSeed: number;
    enableInitWeightRngSeed: boolean;
    minInitWeightRngSeed: number;
    maxInitWeightRngSeed: number;
  };

  metabolism: {
    /** Native `Metabolism::selectionMode` (`AgentMetabolismSelectionMode`). */
    selectionMode: MetabolismSelectionSpelling;
    /** Native `Metabolism::getNumberOfDefinitions()`. */
    definitionCount: number;
  };
}

/** Native `GenomeSchema::Configuration` — a zero-initialized process-wide POD. */
export const GenomeSchemaConfig = {
  layoutType: LayoutType.None as LayoutType,
  resolution: Resolution.BIT as Resolution,
  /** `std::map<std::string,float>` — insertion order is irrelevant, only the lookup is. */
  geneInterpolationPower: new Map<string, number>(),

  enableEvolution: false,

  seedType: SeedType.LEGACY as SeedType,
  seedMutationRate: 0,
  simpleSeedYawBiasDelta: 0,
  seedFightBias: 0,
  seedFightExcitation: 0,
  seedGiveBias: 0,
  seedPickupBias: 0,
  seedDropBias: 0,
  seedPickupExcitation: 0,
  seedDropExcitation: 0,

  minMutationRate: 0,
  maxMutationRate: 0,
  minMutationStdevPower: 0,
  maxMutationStdevPower: 0,
  minNumCpts: 0,
  maxNumCpts: 0,
  miscBias: 0,
  miscInvisSlope: 0,
  minBitProb: 0,
  maxBitProb: 0,
  grayCoding: false,
};

/** Native `GenomeSchema`. */
export abstract class GenomeSchema extends GeneSchema {
  /** Native `GenomeSchema::config` (a zero-initialized POD; see the module PORT-NOTEs). */
  static readonly config = GenomeSchemaConfig;
  /** Native `GenomeSchema::RESOLUTION_BIT` / `RESOLUTION_BYTE`. */
  static readonly RESOLUTION_BIT = Resolution.BIT;
  static readonly RESOLUTION_BYTE = Resolution.BYTE;

  /** Native: the other config singletons (see PORT-NOTE(genome/foreign-config-seam)). */
  readonly inputs: GenomeSchemaInputs;

  constructor(inputs: GenomeSchemaInputs) {
    super();
    this.inputs = inputs;
  }

  /** Native `GenomeSchema::processWorldfile` — the genome half. */
  static processWorldfile(cfg: ConfigType): void {
    {
      const layout = cfg.getString('GenomeLayout');
      if (layout === 'NeurGroup') GenomeSchemaConfig.layoutType = LayoutType.NeurGroup;
      else if (layout === 'None') GenomeSchemaConfig.layoutType = LayoutType.None;
      else throw new Error(`GenomeLayout: unknown value '${layout}'`);
    }
    {
      const resolution = cfg.getString('GeneticOperatorResolution');
      if (resolution === 'Bit') GenomeSchemaConfig.resolution = Resolution.BIT;
      else if (resolution === 'Byte') GenomeSchemaConfig.resolution = Resolution.BYTE;
      else throw new Error(`GeneticOperatorResolution: unknown value '${resolution}'`);
    }

    GenomeSchemaConfig.enableEvolution = cfg.getBool('EnableEvolution');
    GenomeSchemaConfig.minMutationRate = cfg.getFloat('MinMutationRate');
    GenomeSchemaConfig.maxMutationRate = cfg.getFloat('MaxMutationRate');
    GenomeSchemaConfig.minMutationStdevPower = cfg.getFloat('MinMutationStdevPower');
    GenomeSchemaConfig.maxMutationStdevPower = cfg.getFloat('MaxMutationStdevPower');
    GenomeSchemaConfig.minNumCpts = cfg.getInt('MinCrossoverPoints');
    GenomeSchemaConfig.maxNumCpts = cfg.getInt('MaxCrossoverPoints');
    GenomeSchemaConfig.miscBias = cfg.getFloat('MiscegenationFunctionBias');
    GenomeSchemaConfig.miscInvisSlope = cfg.getFloat('MiscegenationFunctionInverseSlope');

    {
      const powers = cfg.getArray('GeneInterpolationPower');
      GenomeSchemaConfig.geneInterpolationPower = new Map();
      for (const element of powers) {
        const entry = new Config(element);
        GenomeSchemaConfig.geneInterpolationPower.set(
          entry.getString('Name'),
          entry.getFloat('Power'),
        );
      }
    }

    GenomeSchemaConfig.minBitProb = cfg.getFloat('MinInitialBitProb');
    GenomeSchemaConfig.maxBitProb = cfg.getFloat('MaxInitialBitProb');

    {
      const seedType = cfg.getString('SeedType');
      if (seedType === 'Legacy') GenomeSchemaConfig.seedType = SeedType.LEGACY;
      else if (seedType === 'Simple') GenomeSchemaConfig.seedType = SeedType.SIMPLE;
      else if (seedType === 'Random') GenomeSchemaConfig.seedType = SeedType.RANDOM;
      else throw new Error(`SeedType: unknown value '${seedType}'`);
    }
    GenomeSchemaConfig.seedMutationRate = cfg.getFloat('SeedMutationRate');
    GenomeSchemaConfig.simpleSeedYawBiasDelta = cfg.getFloat('SimpleSeedYawBiasDelta');
    GenomeSchemaConfig.seedFightBias = cfg.getFloat('SeedFightBias');
    GenomeSchemaConfig.seedFightExcitation = cfg.getFloat('SeedFightExcitation');
    GenomeSchemaConfig.seedGiveBias = cfg.getFloat('SeedGiveBias');
    GenomeSchemaConfig.seedPickupBias = cfg.getFloat('SeedPickupBias');
    GenomeSchemaConfig.seedDropBias = cfg.getFloat('SeedDropBias');
    GenomeSchemaConfig.seedPickupExcitation = cfg.getFloat('SeedPickupExcitation');
    GenomeSchemaConfig.seedDropExcitation = cfg.getFloat('SeedDropExcitation');
    GenomeSchemaConfig.grayCoding = cfg.getBool('GrayCoding');

    // Native then calls SheetsGenomeSchema::processWorldfile( doc ) — not ported with the
    // sheets schema itself, a measured deviation rather than outstanding work (the oracle
    // grows no Sheets brain). See PARITY.md -> *The `Sheets` architecture in the shipped
    // oracle* and genome/native/probe_sheets_architecture.sh.
  }

  /** Native `GenomeSchema::define` — the derived class calls this first. */
  define(): void {
    this.immutableInterpolated('BitProbability', GenomeSchemaConfig.minBitProb, GenomeSchemaConfig.maxBitProb);

    this.scalarFloat('MutationRate', GenomeSchemaConfig.minMutationRate, GenomeSchemaConfig.maxMutationRate);

    if (GenomeSchemaConfig.resolution === Resolution.BYTE) {
      this.scalarFloat(
        'MutationStdevPower',
        GenomeSchemaConfig.minMutationStdevPower,
        GenomeSchemaConfig.maxMutationStdevPower,
      );
    }

    this.scalarInt('CrossoverPointCount', GenomeSchemaConfig.minNumCpts, GenomeSchemaConfig.maxNumCpts);

    this.scalarInt('LifeSpan', this.inputs.agent.minLifeSpan, this.inputs.agent.maxLifeSpan);

    if (this.inputs.agent.bodyGreenChannel === 'I') {
      this.scalarFloat('ID', 0.0, 1.0);
    }

    this.scalarFloat('Strength', this.inputs.agent.minStrength, this.inputs.agent.maxStrength);

    this.scalarFloat('Size', this.inputs.agent.minAgentSize, this.inputs.agent.maxAgentSize);

    this.scalarFloat('MaxSpeed', this.inputs.agent.minMaxSpeed, this.inputs.agent.maxMaxSpeed);

    this.scalarFloat(
      'MateEnergyFraction',
      this.inputs.agent.minMateEnergyFraction,
      this.inputs.agent.maxMateEnergyFraction,
    );

    if (this.inputs.metabolism.selectionMode === 'Gene' && this.inputs.metabolism.definitionCount > 1) {
      this.index('MetabolismIndex', 0, this.inputs.metabolism.definitionCount - 1);
    }

    if (this.inputs.neuronModel === 'S') {
      this.scalarFloat('ScaleLatestSpikes', 0.1, 0.9);
    }
  }

  /** Native `GenomeSchema::seed` — the derived class calls this first. */
  seed(genome: Genome, rng: RngSurface): void {
    for (const gene of this.getAll()) {
      if (gene.ismutable && gene.type === 'SCALAR') {
        genome.seedByGene(gene, 0.5);
      }
    }

    if (GenomeSchemaConfig.minMutationRate !== GenomeSchemaConfig.maxMutationRate) {
      genome.seedByGene(this.get('MutationRate'), GenomeSchemaConfig.seedMutationRate);
    }

    if (this.inputs.metabolism.selectionMode === 'Gene' && this.inputs.metabolism.definitionCount > 1) {
      genome.seedByGene(this.get('MetabolismIndex'), rng.drand48());
    }
  }

  // ------------------------------------------------------------------------------------ #
  // Native's define-time macros, spelled out per scalar kind (PORT-NOTE above).
  // ------------------------------------------------------------------------------------ #

  /** Native `SCALAR( NAME, MIN, MAX )` with `int`/`long` arguments. */
  protected scalarInt(name: string, min: number, max: number): Gene {
    if (min === max) return this.add(new ImmutableScalarGene(name, Scalar.int(min)));
    return this.add(
      new MutableScalarGene(name, Scalar.int(min), Scalar.int(max), Rounding.INT_FLOOR),
    );
  }

  /** Native `SCALAR( NAME, MIN, MAX )` with `float` arguments. */
  protected scalarFloat(name: string, min: number, max: number): Gene {
    if (min === max) return this.add(new ImmutableScalarGene(name, Scalar.float(min)));
    return this.add(
      new MutableScalarGene(name, Scalar.float(min), Scalar.float(max), Rounding.INT_FLOOR),
    );
  }

  /** Native `INDEX( NAME, MIN, MAX )` — always mutable, `ROUND_INT_BIN`. */
  protected index(name: string, min: number, max: number): Gene {
    return this.add(
      new MutableScalarGene(name, Scalar.int(min), Scalar.int(max), Rounding.INT_BIN),
    );
  }

  /** Native `INTERPOLATED_IMMUTABLE( NAME, MIN, MAX )` — float range, `ROUND_INT_NEAREST`. */
  protected immutableInterpolated(name: string, min: number, max: number): Gene {
    return this.add(
      new ImmutableInterpolatedGene(
        name,
        Scalar.float(min),
        Scalar.float(max),
        Rounding.INT_NEAREST,
      ),
    );
  }
}
