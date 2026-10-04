/**
 * Lane L6 (brain core) — `brain/NeuralNetRenderer.h` (the interface only).
 *
 * Native `GroupsBrain::initNeuralNet` / `SheetsBrain::grow` construct a renderer next to the
 * neuron model:
 *
 *     _renderer = new GroupsNeuralNetRenderer<FiringRateModel>( firingRate, _genome );
 *
 * `GroupsNeuralNetRenderer.h` is fixed-function OpenGL: it reads the model's raw
 * `neuron`/`synapse`/activation arrays and draws one coloured patch per neuron and per
 * synapse, i.e. it is a *view* of the brain, not part of the model. Its consumers are the
 * monitor lane (L14, `BrainMonitorView`) and the graphics lane (L15).
 *
 * PORT-NOTE(l6/renderer-injection): the brain lane keeps the interface and takes a factory
 * (`rendererFactory` on the architecture configs) instead of constructing a GL object, so
 *   (a) `src/model/brain/**` stays free of GL/WebGL and can be bundled as-is, and
 *   (b) headless runs (the oracle scenarios run `--ui term`) build no renderer at all,
 * exactly like native with the GL path compiled but never called. L14/L15 provide the
 * factory; with none injected, `_renderer` stays null and the brain behaves identically —
 * nothing in the model reads the renderer. See PARITY.md Gaps.
 */

import type { NeuronModel } from './neuronModel';

/** Native `NeuralNetRenderer`. */
export interface NeuralNetRenderer {
  /** Native `getSize( patchWidth, patchHeight, &width, &height )`. */
  getSize(patchWidth: number, patchHeight: number): { width: number; height: number };
  /** Native `render( patchWidth, patchHeight )`. */
  render(patchWidth: number, patchHeight: number): void;
}

/** Native `GroupsNeuralNetRenderer`'s construction signature (L15 implements it). */
export type RendererFactory = (neuronModel: NeuronModel, orderedGroups: readonly number[]) => NeuralNetRenderer;
