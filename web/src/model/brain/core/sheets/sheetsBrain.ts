/**
 * Lane L6 (brain core) — `brain/sheets/SheetsBrain.{h,cc}`: flattens a built `SheetsModel`
 * (sheets of neurons, receptive fields, culling) into the neural net's neuron/synapse arrays
 * and wires the input/output nerves to the sheets of the same name.
 *
 * The model is built by the *genome* lane (`SheetsGenomeSchema::createSheetsModel`), which is
 * why the constructor takes it as an argument: the brain owns the flattening and the nerve
 * assignment, L5 owns which sheets exist.
 *
 * Like `SheetsModel`, no recorded scenario uses this architecture (`BrainArchitecture
 * Groups` in both recorded worldfiles); see PARITY.md → Gaps.
 *
 * PORT-NOTE(l6/sheets-sheet-indexing): native indexes a `sheetNeuronCount[]` array (sized by
 * the number of sheets) with `neuron->sheet->getId()` while filling it, then reads it back by
 * sheet id in the 0..(numInputSheets+numOutputSheets) range, and uses `model->getSheet( id )`
 * (which returns NULL for a missing id) to fetch the nerve name. The port keeps the same
 * array + id arithmetic and fails loudly on a missing sheet instead of dereferencing NULL.
 *
 * PORT-NOTE(l6/sheets-synapse-layout): synapses are laid out group-by-group, in
 * `model->getNeurons()` order, and within a neuron in `synapsesIn` order — which is the
 * `SynapseMap` order by `nonCulledId` (see `sheetsModel.ts`), *not* creation order. Then
 * `set_neuron_endsynapses` closes the range. A different iteration order produces a
 * different (but internally consistent) synapse array, i.e. different bytes.
 */

import { Brain, brainConfig, NeuronModelKind } from '../brain';
import { FiringRateModel } from '../firingRateModel';
import { SpikingModel } from '../spikingModel';
import type { SheetsGenomeView } from '../brainGenome';
import type { NervousSystem } from '../nervousSystem';
import type { NeuronAttrs } from '../neuronModel';
import { Sheet, type Neuron, type SheetsModel } from './sheetsModel';

/** The worldfile reader for `SheetsBrain::processWorldfile` (W1a's `Config`, nested). */
export interface SheetsWorldfileReader {
  /** A `Config` for the nested `Sheets` object. */
  at(path: string): SheetsWorldfileReader;
  getInt(id: string): number;
  getFloat(id: string): number;
}

/** Native `SheetsBrain::Configuration` (the `Sheets { … }` block of the worldfile). */
export interface SheetsBrainConfig {
  minBrainSize: { x: number; y: number; z: number };
  maxBrainSize: { x: number; y: number; z: number };
  minSynapseProbabilityX: number;
  maxSynapseProbabilityX: number;
  minLearningRate: number;
  maxLearningRate: number;
  minVisionNeuronsPerSheet: number;
  maxVisionNeuronsPerSheet: number;
  minInternalSheetsCount: number;
  maxInternalSheetsCount: number;
  minInternalSheetSize: number;
  maxInternalSheetSize: number;
  minInternalSheetNeuronCount: number;
  maxInternalSheetNeuronCount: number;
}

export const sheetsConfig: SheetsBrainConfig = {
  minBrainSize: { x: 0, y: 0, z: 0 },
  maxBrainSize: { x: 0, y: 0, z: 0 },
  minSynapseProbabilityX: 0,
  maxSynapseProbabilityX: 0,
  minLearningRate: 0,
  maxLearningRate: 0,
  minVisionNeuronsPerSheet: 0,
  maxVisionNeuronsPerSheet: 0,
  minInternalSheetsCount: 0,
  maxInternalSheetsCount: 0,
  minInternalSheetSize: 0,
  maxInternalSheetSize: 0,
  minInternalSheetNeuronCount: 0,
  maxInternalSheetNeuronCount: 0,
};

/** Native `SheetsBrain::processWorldfile` — reads the `Sheets` sub-object. */
export function processSheetsWorldfile(doc: SheetsWorldfileReader): void {
  const sheets = doc.at('Sheets');

  sheetsConfig.minBrainSize.x = sheets.at('MinBrainSize').getFloat('X');
  sheetsConfig.minBrainSize.y = sheets.at('MinBrainSize').getFloat('Y');
  sheetsConfig.minBrainSize.z = sheets.at('MinBrainSize').getFloat('Z');

  sheetsConfig.maxBrainSize.x = sheets.at('MaxBrainSize').getFloat('X');
  sheetsConfig.maxBrainSize.y = sheets.at('MaxBrainSize').getFloat('Y');
  sheetsConfig.maxBrainSize.z = sheets.at('MaxBrainSize').getFloat('Z');

  sheetsConfig.minSynapseProbabilityX = sheets.getFloat('MinSynapseProbabilityX');
  sheetsConfig.maxSynapseProbabilityX = sheets.getFloat('MaxSynapseProbabilityX');

  sheetsConfig.minLearningRate = sheets.getFloat('MinLearningRate');
  sheetsConfig.maxLearningRate = sheets.getFloat('MaxLearningRate');

  sheetsConfig.minVisionNeuronsPerSheet = sheets.getInt('MinVisionNeuronsPerSheet');
  sheetsConfig.maxVisionNeuronsPerSheet = sheets.getInt('MaxVisionNeuronsPerSheet');

  sheetsConfig.minInternalSheetsCount = sheets.getInt('MinInternalSheetsCount');
  sheetsConfig.maxInternalSheetsCount = sheets.getInt('MaxInternalSheetsCount');

  sheetsConfig.minInternalSheetSize = sheets.getFloat('MinInternalSheetSize');
  sheetsConfig.maxInternalSheetSize = sheets.getFloat('MaxInternalSheetSize');

  sheetsConfig.minInternalSheetNeuronCount = sheets.getInt('MinInternalSheetNeuronCount');
  sheetsConfig.maxInternalSheetNeuronCount = sheets.getInt('MaxInternalSheetNeuronCount');
}

export class SheetsBrain extends Brain {
  private _numInternalSheets = 0;
  private _numInternalNeurons = 0;
  private readonly _numSynapses: number[][];

  constructor(cns: NervousSystem, genome: SheetsGenomeView, model: SheetsModel) {
    super(cns);
    this._numSynapses = [new Array(3).fill(0), new Array(3).fill(0), new Array(3).fill(0)];

    this.grow(genome, model);
  }

  getNumInternalSheets(): number {
    return this._numInternalSheets;
  }

  getNumInternalNeurons(): number {
    return this._numInternalNeurons;
  }

  /**
   * Native `SheetsBrain::getNumSynapses( Sheet::Type from, Sheet::Type to )`.
   *
   * PORT-NOTE(l6/sheets-getnumsynapses-name): native's two-argument overload *hides*
   * `Brain::getNumSynapses()` rather than overloading it (C++ name hiding), so a caller with
   * no arguments would not compile. TypeScript has no hiding, so the port gives the
   * sheets-specific count its own name and leaves `Brain.getNumSynapses()` reachable.
   */
  numSynapsesBetween(from: number, to: number): number {
    return this._numSynapses[from]![to]!;
  }

  /** Native `SheetsBrain::grow`. */
  private grow(genome: SheetsGenomeView, model: SheetsModel): void {
    const dims = this._dims;
    const neurons = model.getNeurons();

    // --- Configure Neuron Count ---
    dims.numNeurons = neurons.length;

    // --- Configure Synapse Count ---
    for (const neuron of neurons) dims.numSynapses += neuron.synapsesOut.size;

    // --- Configure Input/Output Neurons/Nerves ---
    {
      const numInputSheets = model.getSheets(Sheet.Input).length;
      const numOutputSheets = model.getSheets(Sheet.Output).length;
      const numInternalSheets = model.getSheets(Sheet.Internal).length;
      const numSheets = numInputSheets + numOutputSheets + numInternalSheets;
      const sheetNeuronCount = new Array<number>(numSheets).fill(0);

      for (const neuron of neurons) {
        switch (neuron.sheet!.getType()) {
          case Sheet.Input:
            dims.numInputNeurons++;
            break;
          case Sheet.Output:
            dims.numOutputNeurons++;
            break;
          case Sheet.Internal:
            // no-op
            break;
          default:
            throw new Error('SheetsBrain::grow: unknown sheet type');
        }

        sheetNeuronCount[neuron.sheet!.getId()] = (sheetNeuronCount[neuron.sheet!.getId()] ?? 0) + 1;
      }

      let neuronIndex = 0;

      for (let sheetId = 0; sheetId < numInputSheets + numOutputSheets; sheetId++) {
        const sheet = model.getSheet(sheetId);
        if (!sheet) throw new Error(`SheetsBrain::grow: no sheet with id ${sheetId}`);
        const nerve = this._cns.getNerve(sheet.getName());

        const neuronCount = sheetNeuronCount[sheetId]!;
        nerve.configCount(neuronCount, neuronIndex);
        neuronIndex += neuronCount;
      }

      for (let sheetId = numInputSheets + numOutputSheets; sheetId < numSheets; sheetId++) {
        if (sheetNeuronCount[sheetId]) {
          this._numInternalSheets++;
          this._numInternalNeurons += sheetNeuronCount[sheetId]!;
        }
      }
    }

    // --- Instantiate Neural Net ---
    {
      switch (brainConfig.neuronModel) {
        case NeuronModelKind.SPIKING: {
          const spiking = new SpikingModel(this._cns, genome.scaleLatestSpikes());
          this._neuralnet = spiking;
          break;
        }
        case NeuronModelKind.FIRING_RATE:
        case NeuronModelKind.TAU_GAIN: {
          this._neuralnet = new FiringRateModel(this._cns);
          break;
        }
        default:
          throw new Error('SheetsBrain::grow: unknown neuron model');
      }

      this._neuralnet.init(dims, 0.0);
    }

    // --- Configure Neural Net ---
    {
      let synapseIndex = 0;

      for (const neuron of neurons) {
        this._neuralnet.setNeuron(neuron.id, neuron.attrs.neuronModel as NeuronAttrs, synapseIndex);

        for (const synapse of neuron.synapsesIn.values()) {
          this._neuralnet.setSynapse(
            synapseIndex++,
            synapse.from.id,
            synapse.to.id,
            synapse.attrs.weight,
            synapse.attrs.lrate,
          );

          this._numSynapses[synapse.from.sheet!.getType()]![synapse.to.sheet!.getType()]! += 1;
        }

        this._neuralnet.setNeuronEndSynapses(neuron.id, synapseIndex);
      }
    }
  }

  /** For the harness: the flattened neuron order (native `SheetsModel::getNeurons`). */
  static flattenedIds(neurons: readonly Neuron[]): number[] {
    return neurons.map((n) => n.id);
  }
}
