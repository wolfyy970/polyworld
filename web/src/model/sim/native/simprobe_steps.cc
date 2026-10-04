// Lane L11 (sim) — native step-wise probe: the *native* x-sorted list and the watched agents'
// exact bit patterns, step by step.
//
// Why: `simprobe.cc`'s `boot` mode prints the list once, and `step1` cannot run because
// `QtAgentPovRenderer::beginStep()` constructs a `PwOffscreenGLSurface` (a `QOpenGLContext`)
// with no `QGuiApplication` in the process. This probe creates one first, so the native simulation
// can be *stepped* outside the Qt app and its per-step state (x/z/radius as exact bit patterns,
// plus the x-sorted order) can be compared against the port's — which is what the
// `minitest_voff` step-64 order-swap residual needs (the recorded artifacts keep only 4
// significant digits).
//
// Usage (see run_simprobe_steps.sh, which supplies the CWD and the linked dylibs):
//   simprobe_steps <worldfile> [numSteps] [agentNumbers...]
//
// Nothing under the native tree is modified; the sim's own `run/` output lands in the probe's CWD.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <csignal>
#include <execinfo.h>
#include <cstdint>
#include <unistd.h>
#include <mach-o/dyld.h>

#include <QGuiApplication>

#include "agent/agent.h"
#include "brain/Nerve.h"
#include "brain/NervousSystem.h"
#include "proplib/interpreter.h"
#include "sim/Simulation.h"
#include "utils/objectxsortedlist.h"

static std::vector<long> gWatch;

static void crashHandler( int sig )
{
	void *frames[64];
	int n = backtrace( frames, 64 );

	fprintf( stderr, "\nsimprobe_steps: caught signal %d\n", sig );
	backtrace_symbols_fd( frames, n, 2 );

	for( int i = 0; i < _dyld_image_count(); i++ )
	{
		const char *name = _dyld_get_image_name( i );
		if( name && strstr( name, "polyworld" ) )
			fprintf( stderr, "image %s header=%p slide=%p\n",
					name,
					(void *)_dyld_get_image_header( i ),
					(void *)(intptr_t)_dyld_get_image_vmaddr_slide( i ) );
	}

	_exit( 128 + sig );
}

static bool watched( long number )
{
	for( size_t i = 0; i < gWatch.size(); i++ )
		if( gWatch[i] == number )
			return true;
	return false;
}

// One line per watched agent: number, x, z, radius, key — all as exact bit patterns (`%a`), plus
// the two steering nerves' activations as exact bit patterns.
//
// The nerves are the *input* to the yaw chain in `agent::UpdateBody` (`OutputNerves::yaw` /
// `yawOppose` → `dyaw` → `gobject::addyaw`), and they are the one value in that chain the start of
// any run is the same for in both implementations but the accumulated `fYaw` is a `float`: a
// sub-f32 difference in the nerve only shows when the sum lands on a rounding boundary, so the
// `%g` resolution of `run/brain/function/brainFunction_*.txt.gz` cannot see it. `%a` can.
// `agent::GetNervousSystem()->getNerve( "Yaw" | "YawOppose" )` is the public path to them.
static void dumpWatched( const char *label, long step )
{
	agent *a = NULL;

	objectxsortedlist::gXSortedObjects.reset();
	while( objectxsortedlist::gXSortedObjects.nextObj( AGENTTYPE, (gobject **)&a ) )
	{
		if( !watched( a->Number() ) )
			continue;

		Nerve *yawNerve = a->GetNervousSystem()->getNerve( "Yaw" );
		Nerve *yawOpposeNerve = a->GetNervousSystem()->getNerve( "YawOppose" );

		printf( "step %ld %s #%ld x=%a z=%a radius=%a key=%a yaw=%a yawNerve=%a yawOpposeNerve=%a\n",
				step, label, a->Number(), a->x(), a->z(), a->radius(),
				a->x() - a->radius(), a->yaw(),
				yawNerve ? yawNerve->get() : 0.0,
				yawOpposeNerve ? yawOpposeNerve->get() : 0.0 );
	}

	fflush( stdout );
}

// The whole agent list in order — the walk `Interact` decides its contact pairs with.
static void dumpOrder( long step, const char *label )
{
	agent *a = NULL;

	printf( "step %ld %s order:", step, label );
	objectxsortedlist::gXSortedObjects.reset();
	while( objectxsortedlist::gXSortedObjects.nextObj( AGENTTYPE, (gobject **)&a ) )
		printf( " %ld", a->Number() );
	printf( "\n" );
	fflush( stdout );
}

int main( int argc, char **argv )
{
	if( argc < 2 )
	{
		fprintf( stderr, "usage: simprobe_steps <worldfile> [numSteps] [agentNumbers...]\n" );
		return 2;
	}

	std::string worldfilePath( argv[1] );
	long numSteps = (argc > 2) ? strtol( argv[2], NULL, 10 ) : 10;

	if( argc > 3 )
		for( int i = 3; i < argc; i++ )
			gWatch.push_back( strtol( argv[i], NULL, 10 ) );
	else
	{
		gWatch.push_back( 4 );
		gWatch.push_back( 32 );
	}

	signal( SIGSEGV, crashHandler );
	signal( SIGBUS, crashHandler );
	signal( SIGABRT, crashHandler );

	// `PwOffscreenGLSurface` (reached from `Step()` through the agent POV renderer) needs a
	// QGuiApplication to exist before it can create its QOpenGLContext.
	QGuiApplication app( argc, argv );

	proplib::Interpreter::init();

	proplib::ParameterMap parameters;
	parameters["Vision"] = "False"; // the recorded scenario's argv (oracle/<scenario>/meta.json)

	TSimulation *sim = new TSimulation( worldfilePath, parameters );

	dumpOrder( 0, "boot" );

	for( long step = 1; step <= numSteps; step++ )
	{
		sim->Step();
		dumpOrder( step, "post" );
		dumpWatched( "post", step );
	}

	proplib::Interpreter::dispose();
	return 0;
}
