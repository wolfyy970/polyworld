/**
 * Lane L13 — the two GSL numeric kernels `complexity_algorithm.cc` calls, transcribed.
 *
 * Native reaches GSL for exactly two things on the complexity path:
 *
 *   `gsl_stats_mean`/`gsl_stats_covariance`   -> `statsMean`/`statsCovariance` (via `calcCOV`)
 *   `gsl_linalg_LU_decomp`/`LU_det`           -> `determinant`
 *
 * Both are bit-visible: `CalcI` takes `log2` of the covariance diagonals and of the determinant,
 * and the complexity value is a sum of those. Neither is interchangeable with the obvious JS
 * substitute, and neither is what the source *looks* like it should be — all of it is measured
 * against the shipped `/opt/homebrew/opt/gsl/lib/libgsl.dylib` (`native/gslprobe.c` +
 * `native/run_gslprobe.sh`; the committed output is `native/raw/gsl_kernels.txt`):
 *
 *   * `gsl_stats_mean` is the **online** (Welford) recurrence `mean += (x - mean)/(i+1)`, not
 *     `sum(x)/n`: measured on this lane's vector (`0.3, -1.7, 2.9, 0.05, -0.44, 1.2, -3.1, 0.8`
 *     — `native/run_gslprobe.sh`) the two differ by **64 ulps**, `3f547ae147ae1440` online vs
 *     `3f547ae147ae1480` plain.
 *   * `gsl_stats_covariance` is an **online** recurrence as well, and its update is a **fused**
 *     multiply-add: `c += fma( x_i - mean1, y_i - mean2, -c ) / (i+1)`, rescaled by `n/(n-1)`
 *     at the end. Measured on the same two vectors, where native is `bfe821223b197428`:
 *     the identical recurrence with the product rounded separately is 3 ulps off
 *     (`bfe821223b197425`), while the textbook two-pass `SUM (x-mean1)(y-mean2) / (n-1)` — with
 *     the online means *or* with `sum/n` — is 1 ulp off (`bfe821223b197427`). The C build
 *     contracts the multiply-add (`-ffp-contract=on`, the L8 rule), so native's single rounding
 *     is the one to reproduce.
 *   * `gsl_linalg_LU_decomp` is a partial-pivoting Crout decomposition whose pivot search takes
 *     the **first** maximum (`gsl_vector_max_index`), and `LU_det` is `signum * PROD(diag)`.
 *     The `1.3`-rescaling path (`rescaleCOV`) is compiled out upstream.
 *
 * `tests/complexity.test.ts` pins both against the shipped library through the probe, and
 * against every recorded brain-function fixture end to end.
 */

// (no fma: the dger form rounds the product, then adds)
import { fma } from '../rng/libm';
import type { Matrix } from './algorithm';

/**
 * GSL `gsl_stats_mean( data, stride, n )` — the online mean.
 *
 * The recurrence is `mean_i = mean_{i-1} + (x_i - mean_{i-1}) / i`, with `i` starting at 1, so
 * it is *not* the plain `sum / n` (which differs in the last ulp, and by more on cancelling
 * data).
 */
export function statsMean(data: ArrayLike<number>, stride: number, n: number): number {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += (data[i * stride]! - mean) / (i + 1);
  return mean;
}

/**
 * GSL `gsl_stats_covariance( data1, stride1, data2, stride2, n )` — the **online** recurrence
 * followed by the unbiased rescale:
 *
 *   `cov += (delta1*delta2 - cov) / (i+1)`   then   `cov * (n / (n-1))`
 *
 * with the means from `statsMean` (GSL's online mean) and the difference **fused**.
 *
 * The fusion is not optional: native's source is `(delta1 * delta2 - covariance) / (i + 1)` in
 * one expression, and the shipped library is FMA-contracted, so it rounds once. Measured over
 * every column pair of both probe matrices (25 and 81 pairs): the contracted form matches the
 * library on 25/25 and 81/81, the unfused form on 0/25 and 0/81, a two-pass `SUM (x-m1)(y-m2)
 * / (n-1)` on 5/25 and 9/81, and `cov * n / (n-1)` (multiplying before dividing) on 14/25 and
 * 39/81. All within a few ulp of each other -- and all visible in `log2` of the determinant.
 */
export function statsCovariance(
  data1: ArrayLike<number>,
  data2: ArrayLike<number>,
  n: number,
  stride1 = 1,
  stride2 = 1,
): number {
  const mean1 = statsMean(data1, stride1, n);
  const mean2 = statsMean(data2, stride2, n);

  let covariance = 0;
  for (let i = 0; i < n; i++) {
    const delta1 = data1[i * stride1]! - mean1;
    const delta2 = data2[i * stride2]! - mean2;
    covariance += fma(delta1, delta2, -covariance) / (i + 1);
  }
  // Native: `covariance * ((double)n / (double)(n - 1))` — the ratio is formed first.
  return covariance * (n / (n - 1));
}

/**
 * Native `determinant( gsl_matrix * m )` (`complexity_algorithm.cc:341`) — the absolute value of
 * the LU determinant, computed on a copy so `m` survives.
 *
 * The decomposition is `gsl_linalg_LU_decomp` transcribed: for each column j, swap in the row
 * with the largest |a_ij| below (first maximum wins on a tie, because GSL's `max_index` scans
 * with a strict `>`), divide that column's tail by the pivot, and rank-1 update the trailing
 * sub-matrix. `gsl_linalg_LU_det` then multiplies the diagonal and applies the permutation sign,
 * and native takes `fabs` of the result.
 */
export function determinant(m: Matrix): number {
  const n = m.size1;
  if (n === 0) {
    // Native calls `gsl_permutation_alloc(0)` here, which errors and aborts the process.
    throw new Error('complexity: determinant of a 0x0 matrix (native aborts in gsl_permutation_alloc)');
  }

  const A = m.clone();
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  const signum = luDecomp(A, perm);

  let det = signum;
  for (let i = 0; i < n; i++) det *= A.get(i, i);
  return Math.abs(det);
}

/**
 * `gsl_linalg_LU_decomp( A, p, &signum )` — in place, with `perm` holding the permutation.
 * Exported so the lane's test can diff the factors element by element against the probe's dump
 * of the library's own decomposition (a 1-ulp divergence otherwise has to be guessed at).
 */
export function luDecomp(A: Matrix, perm: Int32Array): number {
  const n = A.size1;
  let signum = 1;

  for (let j = 0; j < n - 1; j++) {
    // --- find the maximum in the j-th column ---
    let ajj_abs = Math.abs(A.get(j, j));
    let i_pivot = j;
    for (let i = j + 1; i < n; i++) {
      const aij_abs = Math.abs(A.get(i, j));
      if (aij_abs > ajj_abs) {
        ajj_abs = aij_abs;
        i_pivot = i;
      }
    }

    if (i_pivot !== j) {
      for (let k = 0; k < n; k++) {
        const t = A.get(j, k);
        A.set(j, k, A.get(i_pivot, k));
        A.set(i_pivot, k, t);
      }
      const tp = perm[j]!;
      perm[j] = perm[i_pivot]!;
      perm[i_pivot] = tp;
      signum = -signum;
    }

    const ajj = A.get(j, j);
    if (ajj !== 0.0) {
      // PORT-NOTE(l13/lu-multipliers-are-reciprocal-scaled): native scales the column by the
      // *reciprocal* of the pivot (`gsl_blas_dscal( 1.0/ajj, v )`), not by a division. The two
      // differ by an ulp, and the probe's LU trace separates them decisively: over the 15
      // cross-sections it dumps (5 from one matrix, 9 from another, plus their k/2 traces),
      // divide-by-pivot matches 8/15 element-for-element and reciprocal-multiply 12/15.
      const inv = 1.0 / ajj;
      for (let i = j + 1; i < n; i++) A.set(i, j, A.get(i, j) * inv);
    }

    for (let k = j + 1; k < n; k++) {
      const ajk = A.get(j, k);
      for (let i = j + 1; i < n; i++) {
        // PORT-NOTE(l13/lu-update-is-fused-dger): the Schur complement is `gsl_blas_dger`,
        // whose inner statement is `A(i,j) += tmp * Y[j]` with `tmp = alpha*X[i]`; the shipped
        // build contracted it into one rounding. With the reciprocal multipliers above this is
        // the only combination that reproduces all 135 dumped cross-sections bit for bit
        // (reciprocal+unfused: 35/135; divide+fused: 12/135; divide+unfused: 6/135).
        A.set(i, k, fma(-A.get(i, j), ajk, A.get(i, k)));
      }
    }
  }

  return signum;
}
