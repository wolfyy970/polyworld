/**
 * Lane L13 — `complexity/complexity_algorithm.cc`, transcribed.
 *
 * Native is GSL-based (`gsl_matrix`, `gsl_stats_covariance`, `gsl_linalg_LU_decomp`,
 * `gsl_rng_mt19937` + `gsl_ran_ugaussian`). The port replaces every GSL primitive with either
 * a local transcription (`./matrix.ts`, `./gsl.ts`) or lane L1's own RNG (`Mt19937`), because
 * the numbers here are model-visible the moment `ComplexityFitnessWeight != 0`:
 *
 *   gsl_matrix / views   -> `Matrix` (row-major `Float64Array`, `get`/`set`, `size1`/`size2`)
 *   gsl_stats_covariance -> `statsCovariance` (`./gsl.ts`, GSL's *online* form, not a two-pass
 *                           one; the difference is visible in the last bits)
 *   gsl_linalg_LU_*      -> `determinant` (`./gsl.ts`, GSL's partial-pivoting Crout form)
 *   gsl_rng_mt19937      -> lane L1's `Mt19937` (`create_rng(42)` == `new Mt19937(42)`)
 *   gsl_ran_ugaussian    -> lane L1's `Mt19937.gaussian()` (GSL's polar method, `uniform_pos`
 *                           draws and all -- see PORT-NOTE W1d/gaussian-polar-uses-uniform-pos)
 *   log2 (`c_log`)       -> `./log2.ts`, transcribed from this machine's libm
 *
 * Compile-time options are transcribed as the same constants: `RescaleCOV 0` (so
 * `rescaleCOV` is dead code upstream and is not ported), `Fix_I 1` (so `CalcI` uses the
 * per-column entropy form), `c_log log2` and `DebugCalcC_k false`.
 *
 * PORT-NOTES for this file are in PARITY.md under `l13/*`.
 */

import { Mt19937 } from '../rng';
import { log2 } from './log2';
import { determinant, statsCovariance, statsMean } from './gsl';

/** Native `DEFAULT_SEED` (`complexity_algorithm.h:17`) — every complexity RNG is seeded with it. */
export const DEFAULT_SEED = 42;

/** Native `NumSamples` in `calcC_k` (`complexity_algorithm.cc:383`). */
export const NUM_SAMPLES = 1000;

/** Native `MaxNumTimeStepsToComputeComplexityOver` (`complexity_brain.cc:41`). */
export const MAX_NUM_TIMESTEPS_TO_COMPUTE_COMPLEXITY_OVER = 500;

//===========================================================================
// matrices
//===========================================================================

/**
 * Native `gsl_matrix` — row-major doubles with `size1` rows and `size2` columns.
 *
 * `size1`/`size2` are mutable because native mutates them (`complexity_motion.cc:347`
 * shrinks a matrix in place instead of reallocating), and the port keeps that behaviour.
 */
export class Matrix {
  size1: number;
  size2: number;
  readonly data: Float64Array;

  constructor(size1: number, size2: number, data?: Float64Array) {
    this.size1 = size1;
    this.size2 = size2;
    this.data = data ?? new Float64Array(size1 * size2);
  }

  get(i: number, j: number): number {
    return this.data[i * this.size2 + j]!;
  }

  set(i: number, j: number, v: number): void {
    this.data[i * this.size2 + j] = v;
  }

  clone(): Matrix {
    return new Matrix(this.size1, this.size2, this.data.slice());
  }
}

/**
 * Native `matrix_crosssection( mInput, indexArray, indexArrayLength )`
 * (`complexity_algorithm.cc:297`) — the square sub-matrix named by `indexArray`.
 */
export function matrixCrosssection(mInput: Matrix, indexArray: ArrayLike<number>, indexArrayLength: number): Matrix {
  const mOutput = new Matrix(indexArrayLength, indexArrayLength);
  for (let row = 0; row < indexArrayLength; row++) {
    for (let col = 0; col < indexArrayLength; col++) {
      mOutput.set(row, col, mInput.get(indexArray[row]!, indexArray[col]!));
    }
  }
  return mOutput;
}

/**
 * Native `matrix_subset_col( mInput, columns, numColumns )` (`complexity_algorithm.cc:324`) —
 * the columns named by `columns`, in that order.
 */
export function matrixSubsetCol(mInput: Matrix, columns: ArrayLike<number>, numColumns: number): Matrix {
  const mOutput = new Matrix(mInput.size1, numColumns);
  for (let col = 0; col < numColumns; col++) {
    const src = columns[col]!;
    for (let row = 0; row < mInput.size1; row++) mOutput.set(row, col, mInput.get(row, src));
  }
  return mOutput;
}

//===========================================================================
// small numeric helpers (the ones the header declares)
//===========================================================================

/**
 * Native `n_choose_k_le_s( n, k, s )` (`complexity_algorithm.cc:45`) — "is n choose k <= s?",
 * computed by multiplying the terms from the largest down and bailing as soon as `s` is
 * exceeded. Kept literal, including its `double` accumulation and its warning that it is only
 * accurate to ~1e13 (which is all `calcC_k` uses it for).
 */
export function nChooseKLeS(n: number, k: number, s: number): boolean {
  let lessEqual = true;
  let product = 1.0;

  for (let i = 1; i < k + 1; i++) {
    product *= (n - (k - i)) / i;
    if (product > s) {
      lessEqual = false;
      break;
    }
  }

  return lessEqual;
}

/** Native's `Gaussianize` static (`complexity_algorithm.cc:30`), default `true`. */
let gaussianize = true;

/** Native `setGaussianize( gaussianize )` (`complexity_algorithm.cc:70`). */
export function setGaussianize(value: boolean): void {
  gaussianize = value;
}

/** The current value of the `Gaussianize` static (the port needs it for the same flow). */
export function getGaussianize(): boolean {
  return gaussianize;
}

/** Native `sort_compare_double` (`complexity_algorithm.cc:107`) — ascending by the first double. */
function compareDouble(a: number, b: number): number {
  if (a < b) return -1;
  else if (a > b) return 1;
  else return 0;
}

/**
 * Native `qsort(...)` over the `{value, index}` pairs `gsamp` builds.
 *
 * PORT-NOTE(l13/gsamp-sort-is-stable): native calls C `qsort`, which does not promise a stable
 * order among equal keys, and the mapping it produces for a tie *is* visible (which tied entry
 * receives which rank-ordered Gaussian). A tie cannot arise on the model's path: every element
 * `gsamp` sees has already had a per-element Gaussian added to it (`noise_scale *
 * gsl_ran_ugaussian()`), so equal inputs become distinct doubles, and the Gaussian series
 * itself is continuous. This port therefore uses a stable sort — the one choice that is
 * reproducible off the recording machine — and `tests/complexity.test.ts` pins the result
 * against the native values for all 87 recorded brain-function fixtures, which is where a tie
 * would show up if the argument were wrong.
 */
function sortPairs(values: Float64Array, indexes: Float64Array, n: number): void {
  // Insertion sort over a parallel index array: stable by construction, and `gsamp`'s inputs
  // are at most a few hundred rows.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const items: { v: number; i: number }[] = new Array(n);
  for (let i = 0; i < n; i++) items[i] = { v: values[i]!, i };
  items.sort((a, b) => compareDouble(a.v, b.v));
  for (let i = 0; i < n; i++) {
    values[i] = items[i]!.v;
    indexes[i] = items[i]!.i;
  }
  void order;
}

//===========================================================================
// gsamp
//===========================================================================

/**
 * Native `gsamp( gsl_matrix * m )` (`complexity_algorithm.cc:129`) — "a re-implementation of
 * gsamp.m": replaces each column (neuron) by a rank-ordered Gaussian series.
 *
 * PORT-NOTE(l13/gsamp-takes-a-pointer): `complexity_algorithm.h:43` declares
 * `gsamp( gsl_matrix_view )` while `complexity_algorithm.cc:129` defines
 * `gsamp( gsl_matrix * )`. The library is built from the definition (the probe confirmed the
 * replica matches the shipped `CalcApproximateFullComplexityWithMatrix` on both of its
 * matrices), and the declared form would take the view by value -- a no-op. The port follows
 * the definition.
 *
 * The RNG is native's `create_rng( DEFAULT_SEED )`: a *fresh* MT19937 seeded with 42 for every
 * call, which is what makes the transformation independent of how much noise was drawn first.
 */
export function gsamp(m: Matrix): void {
  const r = m.size1;
  const c = m.size2;

  if (r < c) {
    throw new Error(
      "gsamp: There are more cols than rows. gsamp() requires that each neuron be a column (native exits).",
    );
  }

  const randNumGen = new Mt19937(DEFAULT_SEED);
  const values = new Float64Array(r);
  const indexes = new Float64Array(r);
  const gauss = new Float64Array(r);

  for (let j = 0; j < c; j++) {
    for (let i = 0; i < r; i++) {
      values[i] = m.get(i, j);
      indexes[i] = i;
    }

    sortPairs(values, indexes, r);

    for (let i = 0; i < r; i++) gauss[i] = randNumGen.gaussian();

    gauss.sort(compareDouble);

    for (let i = 0; i < r; i++) {
      // Native: `gsl_matrix_set( m, (int)round( data[i][1] ), j, gauss[i] )` -- `round()` is
      // only there "to be super safe"; the index is an exact integer already.
      m.set(Math.round(indexes[i]!), j, gauss[i]!);
    }
  }
}

//===========================================================================
// covariance / entropy / integration
//===========================================================================

/**
 * Native `calcCOV( gsl_matrix * )` (`complexity_algorithm.cc:184`) — the NxN covariance matrix
 * of the input's N columns, via GSL's `gsl_stats_covariance` (see `./gsl.ts` for why that is a
 * two-pass `/(n-1)` with an online mean, and not any of the obvious substitutes).
 *
 * Native fills the lower triangle, then mirrors it into the upper one, so both halves are the
 * *same* double rather than two computations that happen to agree.
 */
export function calcCOV(m: Matrix): Matrix {
  const COV = new Matrix(m.size2, m.size2);
  const colI = new Float64Array(m.size1);
  const colJ = new Float64Array(m.size1);

  for (let i = 0; i < m.size2; i++) {
    for (let j = 0; j <= i; j++) {
      for (let count = 0; count < m.size1; count++) {
        colI[count] = m.get(count, i);
        colJ[count] = m.get(count, j);
      }
      COV.set(i, j, statsCovariance(colI, colJ, m.size1));
    }
  }

  for (let i = 0; i < m.size2; i++) {
    for (let j = i + 1; j < m.size2; j++) COV.set(i, j, COV.get(j, i));
  }

  return COV;
}

/**
 * Native `CalcI( COV, det )` (`complexity_algorithm.cc:509`) with `Fix_I 1`:
 *
 *   `0.5 * ( SUM_i log2( COV[i][i] ) - log2( det ) )`
 *
 * `c_log` is `log2` (native's own `#define c_log log2`), which is why the lane carries a
 * transcribed `log2`.
 */
export function calcI(COV: Matrix, det: number): number {
  let sumHxi = 0.0;
  for (let i = 0; i < COV.size1; i++) sumHxi += log2(COV.get(i, i));
  return 0.5 * (sumHxi - log2(det));
}

/**
 * Native `CalcI_k( COV, indexes, k )` (`complexity_algorithm.cc:528`) — the Integration of one
 * k-sized subset of the n random variables.
 */
export function calcIK(COV: Matrix, indexes: ArrayLike<number>, k: number): number {
  const COV_k = matrixCrosssection(COV, indexes, k);
  const det = determinant(COV_k);
  return calcI(COV_k, det);
}

/**
 * Native `next_combination( index, index+k, index+n )` (`utils/next_combination.h:32`, Hannu
 * Helminen's algorithm) — shuffles an index array so that its first `k` entries exhaustively
 * cycle through every k-subset.
 *
 * Transcribed literally rather than replaced by a lexicographic generator: `calcC_k_exact`
 * *sums* the subset Integrations in this order, and floating-point addition is not
 * associative, so the order is part of the answer.
 */
export function nextCombination(a: Int32Array, begin: number, mid: number, end: number): boolean {
  if (begin === mid || mid === end) return false;

  let tailPos = end - 1;
  let headPos = mid - 1;
  let headLen = 1;
  while (headPos !== begin && !(a[headPos]! < a[tailPos]!)) {
    headPos--;
    headLen++;
  }
  if (headPos === begin && !(a[headPos]! < a[tailPos]!)) {
    // Last combination: rotate everything back into order and stop.
    rotate(a, begin, mid, end);
    return false;
  }

  let tailLen = 1;
  while (tailPos > mid) {
    tailPos--;
    tailLen++;
    if (!(a[tailPos]! > a[headPos]!)) {
      tailPos++;
      tailLen--;
      break;
    }
  }

  if (headLen === 1 || tailLen === 1) {
    swap(a, headPos, tailPos);
    return true;
  }
  if (headLen === tailLen) {
    for (let i = 0; i < headLen; i++) swap(a, headPos + i, tailPos + i);
    return true;
  }
  swap(a, headPos, tailPos);
  disjointRotate(a, headPos + 1, mid, headLen - 1, tailPos + 1, end, tailLen - 1);
  return true;
}

function swap(a: Int32Array, i: number, j: number): void {
  const t = a[i]!;
  a[i] = a[j]!;
  a[j] = t;
}

/** `std::rotate( begin, mid, end )` — a left rotation of the whole range. */
function rotate(a: Int32Array, begin: number, mid: number, end: number): void {
  const tmp = new Int32Array(end - begin);
  const n = end - begin;
  const k = mid - begin;
  for (let i = 0; i < n; i++) tmp[i] = a[begin + ((i + k) % n)]!;
  for (let i = 0; i < n; i++) a[begin + i] = tmp[i]!;
}

/**
 * Native `disjoint_rotate` (`utils/next_combination.h:7`) — rotates the concatenation of two
 * *non-adjacent* ranges. `type` in native is an unused scratch parameter and is not ported.
 */
function disjointRotate(
  a: Int32Array,
  begin1: number,
  end1: number,
  size1: number,
  begin2: number,
  end2: number,
  size2: number,
): void {
  const total = size1 + size2;
  let gcd = total;
  for (let div = size1; div !== 0; ) {
    gcd %= div;
    const t = gcd;
    gcd = div;
    div = t;
  }
  const skip = total / gcd - 1;

  for (let i = 0; i < gcd; ++i) {
    let curr = i < size1 ? begin1 + i : begin2 + (i - size1);
    let ctr = i;
    const v = a[curr]!;
    for (let j = 0; j < skip; ++j) {
      ctr = (ctr + size1) % total;
      const next = ctr < size1 ? begin1 + ctr : begin2 + (ctr - size1);
      a[curr] = a[next]!;
      curr = next;
    }
    a[curr] = v;
  }
  void end1;
  void end2;
}

/**
 * Native `calcC_k_exact( COV, I_n, k )` (`complexity_algorithm.cc:475`) — C_k over *all*
 * k-subsets: `I_n * k / n - sumI_k / n_choose_k`.
 *
 * PORT-NOTE(l13/k0-aborts): `k == 0` (or an empty matrix) makes native call `determinant()` on
 * a 0x0 matrix, and GSL's `gsl_permutation_alloc(0)` raises "permutation length n must be
 * positive integer" and *aborts the process* (measured: a `parts` string of `H` alone, which
 * selects one column, kills the native probe). The port raises instead of aborting.
 */
export function calcCkExact(COV: Matrix, I_n: number, k: number): number {
  const n = COV.size1;
  if (k <= 0 || n === 0) {
    throw new Error(`complexity: determinant of a ${k}x${k} sub-matrix (native aborts in gsl_permutation_alloc)`);
  }

  const index = new Int32Array(n);
  for (let i = 0; i < n; i++) index[i] = i;

  let sumI_k = 0;
  let n_choose_k = 0;

  do {
    const xCOV = matrixCrosssection(COV, index, k);
    const det = determinant(xCOV);
    sumI_k += calcI(xCOV, det);
    n_choose_k++;
  } while (nextCombination(index, 0, k, n));

  return (I_n * k) / n - sumI_k / n_choose_k;
}

/**
 * Native `calcC_k( COV, I_n, k )` (`complexity_algorithm.cc:381`) — the linear I minus the
 * actual I for subset size k, sampled unless `n choose k <= NumSamples`.
 *
 * `k == n-1` and the small-`n` cases go through `calcC_k_exact`; `k == 1`, `k == 0` and
 * `k == n` are closed forms; everything else averages `NumSamples` random subsets drawn with
 * GSL's uniform, from a *freshly seeded* MT19937(42).
 */
export function calcCk(COV: Matrix, I_n: number, k: number): number {
  const n = COV.size1;

  if (k === n - 1) return calcCkExact(COV, I_n, k);
  else if (k === 1) return I_n / n;
  else if (k === 0 || k === n) return 0.0;
  else if (nChooseKLeS(n, k, NUM_SAMPLES)) return calcCkExact(COV, I_n, k);

  const LI_k = (I_n * k) / n;

  const randNumGen = new Mt19937(DEFAULT_SEED);
  const indexes = new Int32Array(k);
  let EI_k = 0.0;

  for (let i = 0; i < NUM_SAMPLES; i++) {
    let numChosen = 0;
    let numVisited = 0;
    for (let j = 0; j < n; j++) {
      const prob = (k - numChosen) / (n - numVisited);
      if (randNumGen.uniform() < prob) indexes[numChosen++] = j;
      numVisited++;
    }
    EI_k += calcIK(COV, indexes, k);
  }

  EI_k /= NUM_SAMPLES;

  return LI_k - EI_k;
}

//===========================================================================
// the entry points
//===========================================================================

/**
 * Native `CalcApproximateFullComplexityWithMatrix( data, numPoints )`
 * (`complexity_algorithm.cc:552`) — the whole pipeline:
 *
 *   copy the data, add `1e-5 * ugaussian()` to every element, `gsamp()` it (rank-ordered
 *   Gaussians per column), take its covariance, and integrate C_k over `numPoints` subset
 *   sizes (1 = the original simplified TSE, `C_{n-1}`).
 *
 * The two RNG consumers are: the noise (one `create_rng(42)` stream, drawn row-major) and
 * `gsamp` (its own `create_rng(42)` per call). A zero determinant re-noises with a ×10 scale,
 * up to `noise_scale*10 < 1.1`, and otherwise substitutes `1e-250` — kept exactly.
 */
export function calcApproximateFullComplexityWithMatrix(data: Matrix | null, numPoints: number): number {
  let complexity = 0.0;

  if (data === null) return complexity;

  const m = data.clone();

  const randNumGen = new Mt19937(DEFAULT_SEED);
  let noise_scale = 0.00001;
  for (let i = 0; i < data.size1; i++) {
    for (let j = 0; j < data.size2; j++) {
      m.set(i, j, data.get(i, j) + noise_scale * randNumGen.gaussian());
    }
  }

  if (gaussianize) gsamp(m);

  let COV: Matrix;
  let n: number;
  let det: number;

  do {
    COV = calcCOV(m);
    n = COV.size1;

    det = determinant(COV);

    if (det === 0.0) {
      if (noise_scale * 10.0 < 1.1) {
        noise_scale *= 10.0;
        for (let i = 0; i < data.size1; i++) {
          for (let j = 0; j < data.size2; j++) {
            m.set(i, j, m.get(i, j) + noise_scale * randNumGen.gaussian());
          }
        }
      } else {
        det = 1e-250;
      }
    }
  } while (det === 0.0);

  const I_n = calcI(COV, det);

  if (numPoints <= 0 || numPoints >= n) numPoints = n - 1;

  if (numPoints === 1) {
    complexity = calcCkExact(COV, I_n, n - 1);
  } else if (numPoints < n) {
    const delta_k = Math.fround(n - 2) / (numPoints - 1);

    let k = 1;
    let dk = 1;
    let c_k = I_n / n;
    let delta_c = dk * 0.5 * c_k;
    complexity = delta_c;

    let k_prev = 1;
    let c_prev = c_k;
    let float_k = 1.0;
    for (let i = 2; i < numPoints; i++) {
      float_k += delta_k;
      k = Math.round(float_k);
      c_k = calcCk(COV, I_n, k);
      dk = k - k_prev;
      delta_c = dk * 0.5 * (c_k + c_prev);
      complexity += delta_c;
      k_prev = k;
      c_prev = c_k;
    }

    k = n - 1;
    dk = k - k_prev;
    c_k = calcCkExact(COV, I_n, k);
    delta_c = dk * 0.5 * (c_k + c_prev);
    complexity += delta_c;
    k_prev = k;
    c_prev = c_k;

    k = n;
    c_k = 0.0;
    dk = k - k_prev;
    delta_c = dk * 0.5 * (c_k + c_prev);
    complexity += delta_c;

    complexity /= n;
  }

  return complexity;
}

/** Native `CalcComplexityWithMatrix( data )` (`complexity_algorithm.cc:541`) — `numPoints = 1`. */
export function calcComplexityWithMatrix(data: Matrix | null): number {
  return calcApproximateFullComplexityWithMatrix(data, 1);
}

/**
 * Native `CalcApproximateFullComplexityWithVector( vector, blockDuration, blockOffset, numPoints )`
 * (`complexity_algorithm.cc:716`) — the vector is cut into `blockDuration`-long blocks every
 * `blockOffset` points, and those blocks become the columns.
 *
 * PORT-NOTE(l13/vector-block-underflow): native computes the block count in `size_t`, so a
 * vector shorter than `blockDuration` wraps to an astronomical count and GSL fails on the
 * allocation. The port raises the same condition as an error.
 */
export function calcApproximateFullComplexityWithVector(
  vector: ArrayLike<number> | null,
  blockDuration: number,
  blockOffset: number,
  numPoints: number,
): number {
  if (vector === null) return 0.0;

  const size = vector.length;
  if (size < blockDuration) {
    throw new Error(
      `complexity: vector of ${size} points is shorter than the block duration ${blockDuration} (native underflows size_t)`,
    );
  }
  const numBlocks = Math.floor((size - blockDuration) / blockOffset);

  const m = new Matrix(blockDuration, numBlocks);
  for (let col = 0; col < numBlocks; col++) {
    let i = col * blockOffset;
    for (let row = 0; row < blockDuration; row++, i++) m.set(row, col, vector[i]!);
  }

  return calcApproximateFullComplexityWithMatrix(m, numPoints);
}

/** Native `CalcComplexityWithVector( vector, blockDuration, blockOffset )` — `numPoints = 1`. */
export function calcComplexityWithVector(
  vector: ArrayLike<number>,
  blockDuration: number,
  blockOffset: number,
): number {
  return calcApproximateFullComplexityWithVector(vector, blockDuration, blockOffset, 1);
}

/** Re-exported so callers of this module can name the pieces without a second import. */
export { statsMean };
