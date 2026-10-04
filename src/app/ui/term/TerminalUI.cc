#include "TerminalUI.h"

#include <QApplication>
#include <QTimer>

#include "Prompt.h"
#include "monitor/Monitor.h"
#include "monitor/MonitorManager.h"
#include "sim/Simulation.h"
#include "utils/misc.h"
#include "ui/gui/MainWindow.h"
#include "ui/SimulationController.h"

using namespace std;


//===========================================================================
// TerminalUI
//===========================================================================

//---------------------------------------------------------------------------
// TerminalUI::TerminalUI
//---------------------------------------------------------------------------
TerminalUI::TerminalUI( SimulationController *_simulationController )
	: simulationController( _simulationController )
	, statusTextMonitor( NULL )
	, gui( NULL )
{
	connectMonitors();

	prompt = new Prompt();

	connect( simulationController, SIGNAL(step()),
			 this, SLOT(step()) );
}

//---------------------------------------------------------------------------
// TerminalUI::~TerminalUI
//---------------------------------------------------------------------------
TerminalUI::~TerminalUI()
{
	if( gui )
		delete gui;
}

//---------------------------------------------------------------------------
// TerminalUI::connectMonitors
//---------------------------------------------------------------------------
void TerminalUI::connectMonitors()
{
	citfor( Monitors, simulationController->getMonitorManager()->getMonitors(), it )
	{
		Monitor *monitor = *it;

		if( monitor->getType() == Monitor::STATUS_TEXT )
		{
			statusTextMonitor = dynamic_cast<StatusTextMonitor *>( monitor );
            statusTextMonitor->update += [=]() {this->status();};
		}
	}
}

//---------------------------------------------------------------------------
// TerminalUI::step
//---------------------------------------------------------------------------
void TerminalUI::step()
{
	char *_cmd = prompt->getUserInput();
	if( _cmd )
	{
		string cmd = _cmd;
		free( _cmd );

		if( cmd == "end" )
		{
			simulationController->end();
		}
		else if( cmd == "gui" )
		{
			if( gui == NULL )
			{
				gui = new MainWindow( simulationController, false );
				connect( gui, SIGNAL(closing()),
						 this, SLOT(guiClosing()) );
				cout << "GUI shown. You may need to raise the window." << endl;
			}
		}
		else if( cmd.compare( 0, 6, "speed " ) == 0 )
		{
			int stepsPerSecond = atoi( cmd.c_str() + 6 );

			simulationController->setStepsPerSecond( stepsPerSecond );

			if( stepsPerSecond > 0 )
				cout << "Speed: " << stepsPerSecond << " steps/second" << endl;
			else
				cout << "Speed: unlimited" << endl;
		}
		else
		{
			if( cmd != "help" )
			{
				cerr << "Invalid command." << endl;
			}

			cerr << "help - Show this message." << endl;
			cerr << "end - End simulation." << endl;
			cerr << "gui - Show GUI." << endl;
			cerr << "speed N - Limit the simulation to N steps/second (0 = unlimited)." << endl;
		}
	}
}

//---------------------------------------------------------------------------
// TerminalUI::status
//---------------------------------------------------------------------------
void TerminalUI::status()
{
	if( prompt->isActive() )
		return;

	printf( "------------------------------------------------------------\n" );

	itfor( StatusText, statusTextMonitor->getStatusText(), it )
	{
		printf( "%s\n", *it );
	}
}

//---------------------------------------------------------------------------
// TerminalUI::guiClosing
//---------------------------------------------------------------------------
void TerminalUI::guiClosing()
{
	delete gui;
	gui = NULL;
}
