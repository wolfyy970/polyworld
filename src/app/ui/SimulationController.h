#pragma once

#include <string>

#include <QObject>


//===========================================================================
// SimulationController
//===========================================================================

class SimulationController : public QObject
{
	Q_OBJECT

 public:
	SimulationController( class TSimulation *simulation,
                          class MonitorManager *monitorManager );
	virtual ~SimulationController();

	class TSimulation *getSimulation();
    class MonitorManager *getMonitorManager();

	void start();
	std::string end( long timestep = -1 );

	bool isPaused();

	// Cap on the simulation's pace, in steps per second (0 = unlimited).
	// Purely a pacing knob: the model is step-indexed, so this cannot change
	// a run's outcome.
	int getStepsPerSecond() const;
	void setStepsPerSecond( int stepsPerSecond );

 signals:
	void step();
	void stepsPerSecondChanged( int stepsPerSecond );

 public slots:
	void pause();
	void resume();
	void pausedStep();

 private slots:
	void execStep();
	void simulationEnded();

 private:
	// QTimer interval in milliseconds that realizes stepsPerSecond.
	int stepInterval() const;

	class TSimulation *simulation;
    class MonitorManager *monitorManager;
	class QTimer *timer;
	bool paused;
	int stepsPerSecond;
};
