// Lane L11 (sim) — native probe for the ctor step-13 *food* radius arithmetic.
//
// Why it exists: `Simulation.cc:324-326`
//
//     float maxfoodlen    = 0.75 * food::gMaxFoodEnergy / food::gSize2Energy;
//     float maxfoodradius = 0.5 * sqrt(maxfoodlen * maxfoodlen * 2.0);
//     food::gMaxFoodRadius = maxfoodradius;
//
// is three width decisions wide (a double product narrowed once, a *float* square, a double
// `sqrt` whose result is narrowed on store). `PARITY.md`'s L11 Gaps row asked for the oracle's
// own bits for the recorded scenarios before the port's expression is changed, and the run log's
// `%g` print (`Simulation.cc:1469`) shows only 6 significant digits, so the log cannot answer it.
//
// This probe links the oracle's own `libpolyworld.dylib`, boots the recorded scenario exactly as
// `Polyworld --ui term` does (so `food::gMaxFoodEnergy`/`food::gSize2Energy` are the ones
// `TSimulation::processWorldFile` resolved from that worldfile), and prints:
//
//   * the two resolved inputs, as float bit patterns;
//   * `food::gMaxFoodRadius` and `agent::config.maxRadius` as stored by the real ctor;
//   * the three intermediate values recomputed from the oracle's own source lines, each as the
//     value *and* bit pattern the C++ abstract machine produces for it (double product, float
//     square, double root, narrowed store) so the port's candidate can be compared term by term.
//
// Usage (via run_foodradiusprobe.sh, which supplies the CWD and the flags):
//   foodradiusprobe <worldfile>

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <csignal>
#include <string>
#include <cmath>
#include <execinfo.h>
#include <unistd.h>
#include <mach-o/dyld.h>

#include "agent/agent.h"
#include "environment/food.h"
#include "proplib/interpreter.h"
#include "sim/Simulation.h"

// The probe links the oracle's own dylib, so a crash inside libpolyworld is otherwise a bare
// "Segmentation fault: 11" with no location. Same handler as `simprobe.cc`.
static void crashHandler( int sig )
{
	void *frames[64];
	int n = backtrace( frames, 64 );

	fprintf( stderr, "\nfoodradiusprobe: caught signal %d\n", sig );
	backtrace_symbols_fd( frames, n, 2 );

	for( int i = 0; i < _dyld_image_count(); i++ )
	{
		const char *name = _dyld_get_image_name( i );
		if( name && strstr( name, "libpolyworld" ) )
			fprintf( stderr, "image %s header=%p slide=%p\n",
					name,
					(void *)_dyld_get_image_header( i ),
					(void *)(intptr_t)_dyld_get_image_vmaddr_slide( i ) );
	}

	_exit( 128 + sig );
}

static uint32_t f32Bits( float v )
{
	uint32_t u;
	memcpy( &u, &v, sizeof( u ) );
	return u;
}

static uint64_t f64Bits( double v )
{
	uint64_t u;
	memcpy( &u, &v, sizeof( u ) );
	return u;
}

static void printF32( const char *label, float v )
{
	printf( "  %-34s %a  (0x%08x)  %.17g\n", label, (double)v, f32Bits( v ), (double)v );
}

static void printF64( const char *label, double v )
{
	printf( "  %-34s %a  (0x%016llx)  %.17g\n", label, v, (unsigned long long)f64Bits( v ), v );
}

int main( int argc, char **argv )
{
	if( argc < 2 )
	{
		fprintf( stderr, "usage: foodradiusprobe <worldfile>\n" );
		return 2;
	}

	std::string worldfilePath( argv[1] );

	proplib::Interpreter::init();

	signal( SIGSEGV, crashHandler );
	signal( SIGBUS, crashHandler );
	signal( SIGABRT, crashHandler );

	proplib::ParameterMap parameters;
	parameters["Vision"] = "False";	// the recorded scenario's argv (oracle/<scenario>/meta.json)

	printf( "=== foodradiusprobe: %s ===\n", worldfilePath.c_str() );

	// The real ctor: it runs `processWorldFile` (which resolves the two inputs) and step 13
	// (which stores `food::gMaxFoodRadius`), so what is read back below is the oracle's own
	// result, not a re-derivation.
	TSimulation *sim = new TSimulation( worldfilePath, parameters );
	(void)sim;

	printf( "-- resolved inputs (as stored) --\n" );
	printF32( "food::gMaxFoodEnergy", food::gMaxFoodEnergy );
	printF32( "food::gSize2Energy", food::gSize2Energy );

	printf( "-- stored by the real ctor (Simulation.cc:326-328) --\n" );
	printF32( "food::gMaxFoodRadius", food::gMaxFoodRadius );
	printF32( "agent::config.maxRadius", agent::config.maxRadius );

	printf( "-- recomputed from Simulation.cc:324-325 --\n" );
	// Line 324: `0.75` is a double literal, so the multiply and the divide are double and the
	// store into `float maxfoodlen` narrows once.
	double maxfoodlen_d = 0.75 * food::gMaxFoodEnergy / food::gSize2Energy;
	float  maxfoodlen   = 0.75 * food::gMaxFoodEnergy / food::gSize2Energy;
	printF64( "maxfoodlen (double, pre-narrow)", maxfoodlen_d );
	printF32( "maxfoodlen (float, as stored)", maxfoodlen );

	// Line 325: `float * float` rounds to binary32 first; `* 2.0` is double; `sqrt` is the
	// double overload; `0.5 * ...` is double; the assignment narrows once.
	float  square_f32 = maxfoodlen * maxfoodlen;
	double square_x2  = maxfoodlen * maxfoodlen * 2.0;
	double root_d     = std::sqrt( square_x2 );
	double half_d     = 0.5 * root_d;
	float  narrowed   = 0.5 * std::sqrt( maxfoodlen * maxfoodlen * 2.0 );
	printF32( "maxfoodlen*maxfoodlen (float)", square_f32 );
	printF64( "maxfoodlen*maxfoodlen*2.0 (double)", square_x2 );
	printF64( "sqrt(...) (double)", root_d );
	printF64( "0.5*sqrt(...) (double, pre-narrow)", half_d );
	printF32( "0.5*sqrt(...) (float, as stored)", narrowed );

	// The same expression with the *port's* current widths (binary64 all the way through), so the
	// tabulation below is the oracle's own arithmetic on both sides.
	{
		double p_len    = (0.75 * (double)food::gMaxFoodEnergy) / (double)food::gSize2Energy;
		double p_radius = 0.5 * std::sqrt( p_len * p_len * 2.0 );
		printF64( "PORT current: maxfoodlen (double)", p_len );
		printF64( "PORT current: maxfoodradius (double)", p_radius );
		printF32( "PORT current narrowed for compare", (float)p_radius );
	}

	fflush( stdout );

	proplib::Interpreter::dispose();
	return 0;
}
