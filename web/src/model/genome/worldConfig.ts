/**
 * Lane L5 (genome) — the worldfile keys the genome schema consumes.
 *
 * `readGenomeSchemaInputs` is the bridge between the normalized worldfile document
 * (`types/config` over proplib's `PropertyNode`) and the `GenomeSchemaInputs` seam. It reads
 * exactly the keys the *other* lanes' config classes read, with the same coercion
 * (`types/scalar` through `Config`), so a lane (or a test) can build the genome schema for a
 * recorded scenario without those lanes existing yet:
 *
 *   Brain::config      BrainArchitecture, NeuronModel, MaxBiasWeight, EnableLearning,
 *                      MinLearningRate, MaxLearningRate, GaussianInitSynapseWeight,
 *                      Tau/Gain/Spiking ranges, MaxSynapseWeight (for MaxBiasWeight = "MaxSynapseWeight")
 *   agent::config      Min/MaxLifeSpan, Min/MaxAgentStrength, Min/MaxAgentSize,
 *                      Min/MaxAgentMaxSpeed, Min/MaxEnergyFractionToOffspring,
 *                      BodyGreenChannel, NoseColor (via hasLightBehavior), YawEncoding,
 *                      EnableMateWaitFeedback/SpeedFeedback/Carry/VisionPitch/VisionYaw/Give
 *   GroupsBrain::config  Min/MaxVisionNeuronsPerGroup, Min/MaxInternalNeuralGroups,
 *                      OrderedInternalNeuralGroups, Min/MaxExcitatory/InhibitoryNeuronsPerGroup,
 *                      Min/MaxConnectionDensity, Min/MaxTopologicalDistortion,
 *                      SeedVisionNeurons, SimpleSeedConnectionDensity, SimpleSeedIOConnectionDensity,
 *                      MirroredTopologicalDistortion, Enable{TopologicalDistortion,InitWeight}RngSeed + ranges
 *   metabolism         AgentMetabolisms (count), AgentMetabolismSelectionMode
 *
 * PORT-NOTE(genome/worldfile-reader-seam): this reader duplicates *reads*, not definitions:
 * coercion is `types/scalar` and each key has one owner lane that reads it the same way.
 * Lanes L6/L8/L11 should pass their own config values into `GenomeSchemaInputs` instead
 * once they exist; the reader stays as the way to reproduce a recorded scenario (and as the
 * fixture loader for `tests/genome.test.ts`).
 *
 * PORT-NOTE(genome/max-bias-indirection): the worldfile may spell `MaxBiasWeight` as
 * `MaxSynapseWeight`, which is the *name of another property*, not a number. Native resolves
 * it because both are read through proplib's document: `doc.get("MaxBiasWeight")` on the
 * normalized document returns the text `MaxSynapseWeight` and `(float)` of that fails... but
 * the recorded worldfiles never hit it (the `MaxBiasWeight MaxSynapseWeight` spelling in the
 * reference worldfile is a *symbol reference* resolved during normalization, and
 * `run/normalized.wf` shows the resolved text). The reader therefore reads the key as a
 * number and throws the native "Expecting float." error otherwise — never a silent 8.0.
 */

import { Config, type PropertyNode } from '../types';
import type { GenomeSchemaInputs } from './genomeSchema';
import {
  readArchitecture,
  readBodyGreenChannel,
  readNeuronModel,
  readYawEncoding,
} from './worldfileSpellings';

/** The worldfile key names, in one place (native reads them in the config classes). */
export const GENOME_WORLDFILE_KEYS = {
  architecture: 'BrainArchitecture',
  neuronModel: 'NeuronModel',
  maxBiasWeight: 'MaxBiasWeight',
  /** Native derives `Brain::config.enableLearning` from this, not from a bool key. */
  learningMode: 'LearningMode',
  minLearningRate: 'MinLearningRate',
  maxLearningRate: 'MaxLearningRate',
  gaussianInitWeight: 'GaussianInitSynapseWeight',
} as const;

/** Native `agent::config.hasLightBehavior`: `bodyGreenChannel == BGC_LIGHT || noseColor == NC_LIGHT`. */
export function deriveHasLightBehavior(cfg: Config): boolean {
  const bodyGreenChannel = readBodyGreenChannel(cfg.getString('BodyGreenChannel'));
  const noseColor = cfg.getString('NoseColor');
  return bodyGreenChannel === 'L' || noseColor === 'L';
}

/**
 * Native `Brain::config.enableLearning = learningMode != LEARN_NONE` (`brain/Brain.cc`), i.e.
 * derived from `LearningMode`, not from a dedicated bool key.
 */
export function deriveEnableLearning(cfg: Config): boolean {
  return cfg.getString('LearningMode') !== 'None';
}

/** Build the genome schema inputs from a normalized worldfile document. */
export function readGenomeSchemaInputs(cfg: Config): GenomeSchemaInputs {
  const metabolismCount = countElements(cfg, 'AgentMetabolisms');

  return {
    architecture: readArchitecture(cfg.getString('BrainArchitecture')),
    neuronModel: readNeuronModel(cfg.getString('NeuronModel')),
    brainMaxBias: cfg.getFloat('MaxBiasWeight'),
    brainEnableLearning: deriveEnableLearning(cfg),
    brainMinLearningRate: cfg.getFloat('MinLearningRate'),
    brainMaxLearningRate: cfg.getFloat('MaxLearningRate'),
    brainGaussianInitWeight: cfg.getBool('GaussianInitSynapseWeight'),
    brainTau: {
      minVal: cfg.getFloat('TauMin'),
      maxVal: cfg.getFloat('TauMax'),
      seedVal: cfg.getFloat('TauSeed'),
    },
    brainGain: {
      minVal: cfg.getFloat('GainMin'),
      maxVal: cfg.getFloat('GainMax'),
      seedVal: cfg.getFloat('GainSeed'),
    },
    brainSpiking: {
      enableGenes: cfg.getBool('EnableSpikingGenes'),
      aMinVal: cfg.getFloat('SpikingAMin'),
      aMaxVal: cfg.getFloat('SpikingAMax'),
      bMinVal: cfg.getFloat('SpikingBMin'),
      bMaxVal: cfg.getFloat('SpikingBMax'),
      cMinVal: cfg.getFloat('SpikingCMin'),
      cMaxVal: cfg.getFloat('SpikingCMax'),
      dMinVal: cfg.getFloat('SpikingDMin'),
      dMaxVal: cfg.getFloat('SpikingDMax'),
    },

    agent: {
      minLifeSpan: cfg.getInt('MinLifeSpan'),
      maxLifeSpan: cfg.getInt('MaxLifeSpan'),
      minStrength: cfg.getFloat('MinAgentStrength'),
      maxStrength: cfg.getFloat('MaxAgentStrength'),
      minAgentSize: cfg.getFloat('MinAgentSize'),
      maxAgentSize: cfg.getFloat('MaxAgentSize'),
      minMaxSpeed: cfg.getFloat('MinAgentMaxSpeed'),
      maxMaxSpeed: cfg.getFloat('MaxAgentMaxSpeed'),
      minMateEnergyFraction: cfg.getFloat('MinEnergyFractionToOffspring'),
      maxMateEnergyFraction: cfg.getFloat('MaxEnergyFractionToOffspring'),
      bodyGreenChannel: readBodyGreenChannel(cfg.getString('BodyGreenChannel')),
      yawEncoding: readYawEncoding(cfg.getString('YawEncoding')),
      hasLightBehavior: deriveHasLightBehavior(cfg),
      enableMateWaitFeedback: cfg.getBool('EnableMateWaitFeedback'),
      enableSpeedFeedback: cfg.getBool('EnableSpeedFeedback'),
      enableCarry: cfg.getBool('EnableCarry'),
      enableVisionPitch: cfg.getBool('EnableVisionPitch'),
      enableVisionYaw: cfg.getBool('EnableVisionYaw'),
      enableGive: cfg.getBool('EnableGive'),
    },

    groupsBrain: {
      minVisionNeuronsPerGroup: cfg.getInt('MinVisionNeuronsPerGroup'),
      maxVisionNeuronsPerGroup: cfg.getInt('MaxVisionNeuronsPerGroup'),
      minInternalNeuralGroups: cfg.getInt('MinInternalNeuralGroups'),
      maxInternalNeuralGroups: cfg.getInt('MaxInternalNeuralGroups'),
      minExcitatoryNeuronsPerGroup: cfg.getInt('MinExcitatoryNeuronsPerGroup'),
      maxExcitatoryNeuronsPerGroup: cfg.getInt('MaxExcitatoryNeuronsPerGroup'),
      minInhibitoryNeuronsPerGroup: cfg.getInt('MinInhibitoryNeuronsPerGroup'),
      maxInhibitoryNeuronsPerGroup: cfg.getInt('MaxInhibitoryNeuronsPerGroup'),
      orderedInternalNeuralGroups: cfg.getBool('OrderedInternalNeuralGroups'),
      minConnectionDensity: cfg.getFloat('MinConnectionDensity'),
      maxConnectionDensity: cfg.getFloat('MaxConnectionDensity'),
      minTopologicalDistortion: cfg.getFloat('MinTopologicalDistortion'),
      maxTopologicalDistortion: cfg.getFloat('MaxTopologicalDistortion'),
      seedVisionNeurons: cfg.getFloat('SeedVisionNeurons'),
      simpleSeedConnectionDensity: cfg.getFloat('SimpleSeedConnectionDensity'),
      simpleSeedIOConnectionDensity: cfg.getFloat('SimpleSeedIOConnectionDensity'),
      mirroredTopologicalDistortion: cfg.getBool('MirroredTopologicalDistortion'),
      enableTopologicalDistortionRngSeed: cfg.getBool('EnableTopologicalDistortionRngSeed'),
      minTopologicalDistortionRngSeed: cfg.getInt('MinTopologicalDistortionRngSeed'),
      maxTopologicalDistortionRngSeed: cfg.getInt('MaxTopologicalDistortionRngSeed'),
      enableInitWeightRngSeed: cfg.getBool('EnableInitWeightRngSeed'),
      minInitWeightRngSeed: cfg.getInt('MinInitWeightRngSeed'),
      maxInitWeightRngSeed: cfg.getInt('MaxInitWeightRngSeed'),
    },

    metabolism: {
      selectionMode: readMetabolismSelection(cfg.getString('AgentMetabolismSelectionMode')),
      definitionCount: metabolismCount,
    },
  };
}

/** Native `Metabolism::getNumberOfDefinitions()` — the `AgentMetabolisms` array length. */
function countElements(cfg: Config, key: string): number {
  const node: PropertyNode = cfg.node(key);
  return node.elements().length;
}

/** Native `sim::Simulation`'s `AgentMetabolismSelectionMode` mapping. */
function readMetabolismSelection(value: string): GenomeSchemaInputs['metabolism']['selectionMode'] {
  if (value === 'Gene') return 'Gene';
  if (value === 'Fixed') return 'Fixed';
  return 'other';
}
