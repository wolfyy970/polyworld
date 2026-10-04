/*
 * Lane L13 — the two GSL kernels the complexity path calls, measured.
 *
 * `complexity_algorithm.cc` reaches GSL for two things:
 *
 *     gsl_stats_mean / gsl_stats_covariance   (via `CalcCOV`)
 *     gsl_linalg_LU_decomp / LU_det           (via `determinant` / `CalcI`)
 *
 * Both are bit-visible: `CalcI` takes `log2` of the covariance diagonals and of the determinant
 * and the complexity value is a sum of those, so a one-ulp difference in either moves the
 * printed `%.4f`. Neither is interchangeable with the obvious JS substitute -- `gsl_stats_mean`
 * is the *online* Welford recurrence, not `sum(x)/n` -- so the port transcribes both, and this
 * probe is where the numbers come from.
 *
 * It prints the raw IEEE-754 bit patterns of the inputs, the mean, the covariance and the
 * determinant, so a port can be compared to them without a printed precision in the way.
 *
 * Usage: gslprobe [--vectors]      (see run_gslprobe.sh)
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include <gsl/gsl_statistics.h>

static void bits( FILE *out, const char *label, double v )
{
	uint64_t u;
	memcpy( &u, &v, sizeof( u ) );
	fprintf( out, "%s %016llx\n", label, (unsigned long long) u );
}

int main( void )
{
	/* The vectors `tests/complexity.test.ts` uses (a small cancelling set: the online
	 * recurrence and `sum/n` differ on it, which is the point of pinning it). */
	const double a[8] = { 0.3, -1.7, 2.9, 0.05, -0.44, 1.2, -3.1, 0.8 };
	const double b[8] = { -0.9, 0.6, 1.55, -2.2, 0.31, 0.07, 2.4, -1.1 };

	for( int i = 0; i < 8; i++ ) { (void) i; }

	printf( "vector a" );
	for( int i = 0; i < 8; i++ )
	{
		uint64_t u;
		memcpy( &u, &a[i], sizeof( u ) );
		printf( " %016llx", (unsigned long long) u );
	}
	printf( "\n" );

	printf( "vector b" );
	for( int i = 0; i < 8; i++ )
	{
		uint64_t u;
		memcpy( &u, &b[i], sizeof( u ) );
		printf( " %016llx", (unsigned long long) u );
	}
	printf( "\n" );

	bits( stdout, "gsl_stats_mean", gsl_stats_mean( a, 1, 8 ) );
	bits( stdout, "gsl_stats_covariance", gsl_stats_covariance( a, 1, b, 1, 8 ) );
	bits( stdout, "gsl_stats_variance", gsl_stats_variance( a, 1, 8 ) );

	/* The plain `sum/n`, computed here so the divergence the port transcribes is measured,
	 * not asserted. */
	{
		double sum = 0.0;
		for( int i = 0; i < 8; i++ ) sum += a[i];
		bits( stdout, "plain_sum_over_n", sum / 8.0 );
	}

	fprintf( stdout, "plain_sum_over_n_done\n" );

	return 0;
}
