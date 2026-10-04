// Lane L11 (sim) — native differential probe for the whole-run sim.
//
// Why it exists: `./oracle/run_parity.sh microtest_voff` leaves a handful of one-line diffs that
// the recorded artifacts cannot resolve, because they are *ordering* questions of a list whose
// order is never written to disk. The x-sorted object list (`objectxsortedlist::gXSortedObjects`)
// is walked by the body pass (which is what emits `CollisionEvent`) and by `Interact`, and its
// order is a function of the agents' *boot* positions/radii -- neither of which any golden file
// records. This probe links the oracle's own `libpolyworld.dylib`, boots the recorded scenario
// exactly as `Polyworld --ui term` does, and prints that list.
//
// Usage (via run_simprobe.sh, which supplies the CWD and the flags):
//   simprobe <worldfile> [mode]
//
//   boot       (default) the x-sorted list right after construction, in list order
//   step1      the same list after one `step()`, then the same again
//
// The scenario's own argv (`--Vision False`) is passed through the `proplib::ParameterMap` the
// probe builds, the way `app/main.cc` does it.

#include <cstdio>
#include <cstring>
#include <string>
#include <csignal>
#include <execinfo.h>
#include <unistd.h>
#include <cstdint>
#include <mach-o/dyld.h>

#include "agent/agent.h"
#include "proplib/interpreter.h"
#include "sim/Simulation.h"
#include "utils/objectxsortedlist.h"

// The probe links the oracle's own dylib, so a crash inside libpolyworld is otherwise a bare
// "Segmentation fault: 11" with no location (this environment cannot attach lldb to a process).
// The handler prints the backtrace symbolically, which is enough to name the frame.
static void crashHandler( int sig )
{
	void *frames[64];
	int n = backtrace( frames, 64 );

	fprintf( stderr, "\nsimprobe: caught signal %d\n", sig );
	backtrace_symbols_fd( frames, n, 2 );

	// The image list is what `atos` needs to symbolicate: `-l <header> <address>`.
	for( int i = 0; i < _dyld_image_count(); i++ )
	{
		const char *name = _dyld_get_image_name( i );
		if( name && strstr( name, "libpolyworld" ) )
		{
			fprintf( stderr, "image %s header=%p slide=%p\n",
					name,
					(void *)_dyld_get_image_header( i ),
					(void *)(intptr_t)_dyld_get_image_vmaddr_slide( i ) );
		}
	}

	_exit( 128 + sig );
}

static void printList( const char *label )
{
	agent *a = NULL;

	printf( "%s\n", label );
	objectxsortedlist::gXSortedObjects.reset();
	while( objectxsortedlist::gXSortedObjects.nextObj( AGENTTYPE, (gobject **)&a ) )
	{
		printf( "  #%ld x=%.9g z=%.9g radius=%.9g key=%.9g\n",
				a->Number(), a->x(), a->z(), a->radius(), a->x() - a->radius() );
	}
	fflush( stdout );
}

int main( int argc, char **argv )
{
	if( argc < 2 )
	{
		fprintf( stderr, "usage: simprobe <worldfile> [boot|step1]\n" );
		return 2;
	}

	std::string worldfilePath( argv[1] );
	std::string mode = (argc > 2) ? argv[2] : "boot";

	proplib::Interpreter::init();

	signal( SIGSEGV, crashHandler );
	signal( SIGBUS, crashHandler );
	signal( SIGABRT, crashHandler );

	proplib::ParameterMap parameters;
	parameters["Vision"] = "False";	// the recorded scenario's argv (oracle/<scenario>/meta.json)

	TSimulation *sim = new TSimulation( worldfilePath, parameters );

	printList( "boot list order (key = x - radius):" );

	if( mode == "step1" )
	{
		printf( "\n-- step 1 --\n" );
		sim->Step();
		printList( "post-step-1 list order:" );

		// The status text itself (`Simulation.cc:4870-5230`) — the exact bytes `run/stats/stat.1`
		// is written from (`Monitor::update`), so the port's `statusText.ts` can be compared line
		// by line against the oracle's own code.
		{
			sim::StatusText statusText;
			sim->getStatusText( statusText, 0 );
			printf( "--- statusText (frequency 0) ---\n" );
			for( size_t i = 0; i < statusText.size(); i++ )
				printf( "[%02zu] %s\n", i, statusText[i] );
		}
	}

	proplib::Interpreter::dispose();
	return 0;
}
