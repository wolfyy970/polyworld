/**
 * Lane L13 (complexity) — the Adami complexity and heuristic-fitness machinery.
 *
 * Native `src/library/complexity/**` (`complexity_algorithm.cc`, `complexity_brain.cc`,
 * `adami.cc`) behind the frozen types. `analyzeBrain` and `AgentFitness` are its two runtime
 * callers in the sim; lane L12's `BrainComplexityLog` and `AdamiComplexityLog` are the other
 * two.
 *
 * The GSL surface native leans on (`gsl_matrix`, `gsl_stats_covariance`, `gsl_linalg_LU_*`,
 * `gsl_rng_mt19937`, `gsl_ran_ugaussian`) is replaced by `./gsl.ts`'s two transcribed kernels
 * and lane L1's own RNG; `c_log` (`log2`) is transcribed in `./log2.ts` because this machine's
 * `log2` is not correctly rounded.
 *
 * Native `complexity/complexity_motion.cc` is **not** ported here: its only caller is
 * `src/tools/CalcComplexity/motion.cc`, i.e. lane L17 (tools), and nothing on the model's path
 * reaches it.
 */

export {
  DEFAULT_SEED,
  Matrix,
  NUM_SAMPLES,
  MAX_NUM_TIMESTEPS_TO_COMPUTE_COMPLEXITY_OVER,
  calcApproximateFullComplexityWithMatrix,
  calcApproximateFullComplexityWithVector,
  calcCk,
  calcCkExact,
  calcCOV,
  calcI,
  calcIK,
  calcComplexityWithMatrix,
  calcComplexityWithVector,
  getGaussianize,
  gsamp,
  matrixCrosssection,
  matrixSubsetCol,
  nChooseKLeS,
  nextCombination,
  setGaussianize,
} from './algorithm';

export {
  calcComplexityBrainfunction,
  calcComplexityBrainfunctionBatch,
  calcComplexityWithMatrixBrainfunction,
  filterActivity,
  getListOfBrainanatomyLogfiles,
  getListOfBrainfunctionLogfiles,
  openBrainFunctionFile,
  readinBrainanatomy,
  readinBrainfunction,
  type AgentEventSource,
  type BrainActivity,
  type BrainFunctionFile,
  type BrainFunctionFileOpener,
  type DirectoryLister,
} from './brain';

export { determinant, luDecomp, statsCovariance, statsMean } from './gsl';
export { log2 } from './log2';
export { LOG2_POLY, LOG2_TAB_INVC, LOG2_TAB_LOGC } from './appleLog2Table';
export {
  ADAMI_COMPLEXITY_PATHS,
  createComputeAdamiComplexity,
  type AdamiAgent,
  type AdamiEnvironment,
  type AdamiSchema,
  type AdamiSink,
  type AdamiWorld,
  type ComputeAdamiComplexity,
} from './adami';
