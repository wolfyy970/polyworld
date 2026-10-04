#include "SimulationController.h"

#include <QApplication>
#include <QTimer>

#include "monitor/MonitorManager.h"
#include "sim/Simulation.h"

//===========================================================================
// SimulationController
//===========================================================================

//---------------------------------------------------------------------------
// SimulationController::SimulationController
//---------------------------------------------------------------------------
SimulationController::SimulationController( TSimulation *simulation_,
                                            MonitorManager *monitorManager_ )
	: simulation( simulation_ )
    , monitorManager( monitorManager_ )
	, timer( new QTimer(this) )
	, paused( false )
	, stepsPerSecond( simulation_->GetStepsPerSecond() )
{
	connect(timer, SIGNAL(timeout()), this, SLOT(execStep()));

    simulation->stepEnding += [=]{monitorManager->step();};
    simulation->ended += [=](){simulationEnded();};
}

//---------------------------------------------------------------------------
// SimulationController::~SimulationController
//---------------------------------------------------------------------------
SimulationController::~SimulationController()
{
}

//---------------------------------------------------------------------------
// SimulationController::getSimulation
//---------------------------------------------------------------------------
TSimulation *SimulationController::getSimulation()
{
	return simulation;
}

//---------------------------------------------------------------------------
// SimulationController::getMonitorManager
//---------------------------------------------------------------------------
MonitorManager *SimulationController::getMonitorManager()
{
	return monitorManager;
}

//---------------------------------------------------------------------------
// SimulationController::start
//---------------------------------------------------------------------------
void SimulationController::start()
{
	// Start the simulation
	timer->start( stepInterval() );
}

//---------------------------------------------------------------------------
// SimulationController::stepInterval
//
// The QTimer interval that realizes the requested steps-per-second cap.
// 0 means "no cap": QTimer then fires whenever the event loop is idle, which
// is the original behavior.
//---------------------------------------------------------------------------
int SimulationController::stepInterval() const
{
	if( stepsPerSecond <= 0 )
		return 0;

	int interval = 1000 / stepsPerSecond;

	return interval > 0 ? interval : 1;
}

//---------------------------------------------------------------------------
// SimulationController::getStepsPerSecond
//---------------------------------------------------------------------------
int SimulationController::getStepsPerSecond() const
{
	return stepsPerSecond;
}

//---------------------------------------------------------------------------
// SimulationController::setStepsPerSecond
//
// Pace control only; see the note in the header.  Takes effect immediately,
// including mid-run.
//---------------------------------------------------------------------------
void SimulationController::setStepsPerSecond( int stepsPerSecond_ )
{
	if( stepsPerSecond_ < 0 )
		stepsPerSecond_ = 0;

	if( stepsPerSecond_ == stepsPerSecond )
		return;

	stepsPerSecond = stepsPerSecond_;

	if( !paused )
		timer->start( stepInterval() );

	stepsPerSecondChanged( stepsPerSecond );
}

//---------------------------------------------------------------------------
// SimulationController::end
//---------------------------------------------------------------------------
string SimulationController::end( long timestep )
{
	if( timestep != -1 )
	{
		return simulation->EndAt( timestep );
	}
	else
	{
		simulation->End( "userExit" );
		return "";
	}
}

//---------------------------------------------------------------------------
// SimulationController::isPaused
//---------------------------------------------------------------------------
bool SimulationController::isPaused()
{
	return paused;
}

//---------------------------------------------------------------------------
// SimulationController::pause
//---------------------------------------------------------------------------
void SimulationController::pause()
{
	if( !paused )
	{
		timer->stop();
		timer->setSingleShot( true );
		paused = true;
	}
}

//---------------------------------------------------------------------------
// SimulationController::resume
//---------------------------------------------------------------------------
void SimulationController::resume()
{
	if( paused )
	{
		timer->setSingleShot( false );
		timer->start( stepInterval() );
		paused = false;
	}
}

//---------------------------------------------------------------------------
// SimulationController::pausedStep
//---------------------------------------------------------------------------
void SimulationController::pausedStep()
{
	if( paused )
	{
		timer->start();
	}
}

//---------------------------------------------------------------------------
// SimulationController::execStep
//---------------------------------------------------------------------------
void SimulationController::execStep()
{
	emit step();

	simulation->Step();
}

//---------------------------------------------------------------------------
// SimulationController::simulationEnded
//---------------------------------------------------------------------------
void SimulationController::simulationEnded()
{
	QCoreApplication::exit( 0 );
}
