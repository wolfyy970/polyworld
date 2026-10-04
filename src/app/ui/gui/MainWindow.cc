#include "MainWindow.h"

// System
#include <climits>

// Qt
#include <QApplication>
#include <QActionGroup>
#include <QCloseEvent>
#include <QInputDialog>
#include <QMenuBar>
#include <QMessageBox>
#include <QScreen>
#include <QSettings>

// Local
#include "BrainMonitorView.h"
#include "ChartMonitorView.h"
#include "MainWindow.h"
#include "PovMonitorView.h"
#include "SceneMonitorView.h"
#include "StatusTextMonitorView.h"
#include "ToggleWidgetOpenAction.h"
#include "agent/agent.h"
#include "monitor/Monitor.h"
#include "monitor/MonitorManager.h"
#include "sim/globals.h"
#include "sim/Simulation.h"
#include "ui/SimulationController.h"
#include "utils/misc.h"

#if __APPLE__
static QMenuBar *menuBar = NULL;
#endif

//===========================================================================
// MainWindow
//===========================================================================

//---------------------------------------------------------------------------
// MainWindow::MainWindow
//---------------------------------------------------------------------------
MainWindow::MainWindow( SimulationController *_simulationController,
						bool _endOnClose )
	: QMainWindow( 0, Qt::WindowFlags() )
	, simulationController( _simulationController )
	, endOnClose( _endOnClose )
{
	QApplication::setQuitOnLastWindowClosed( endOnClose );

	setWindowTitle( "Polyworld" );
	setMinimumSize(QSize(200, 200));
	loadSettings();

	show();

	createMonitorViews();

#if __APPLE__
	QMenuBar *menuBar = ::menuBar = new QMenuBar(0);
#else
	QMenuBar *menuBar = this->menuBar();
#endif

	addRunMenu( menuBar );
	addViewMenu( menuBar );
}


//---------------------------------------------------------------------------
// MainWindow::~MainWindow
//---------------------------------------------------------------------------
MainWindow::~MainWindow()
{
#if __APPLE__
	delete ::menuBar;
#endif

	saveSettings();

	itfor( MonitorViews, monitorViews, it )
	{
		delete *it;
	}
}

//---------------------------------------------------------------------------
// MainWindow::closeEvent
//---------------------------------------------------------------------------
void MainWindow::closeEvent(QCloseEvent* ce)
{
	if( endOnClose )
	{
		if( !exitOnUserConfirm() )
		{
			ce->ignore();
		}
	}

	if( ce->isAccepted() )
		emit closing();
}

//---------------------------------------------------------------------------
// MainWindow::createMonitorViews
//---------------------------------------------------------------------------
void MainWindow::createMonitorViews()
{
	citfor( Monitors, simulationController->getMonitorManager()->getMonitors(), it )
	{
		Monitor *_monitor = *it;
		MonitorView *view = NULL;

		switch( _monitor->getType() )
		{
		case Monitor::CHART:
			{
				ChartMonitor *monitor = dynamic_cast<ChartMonitor *>( _monitor );
				view = new ChartMonitorView( monitor );
			}
			break;
		case Monitor::BRAIN:
			{
				BrainMonitor *monitor = dynamic_cast<BrainMonitor *>( _monitor );
				view = new BrainMonitorView( monitor );
			}
			break;
		case Monitor::POV:
			{
				PovMonitor *monitor = dynamic_cast<PovMonitor *>( _monitor );
				view = new PovMonitorView( monitor );
			}
			break;
		case Monitor::STATUS_TEXT:
			{
				StatusTextMonitor *monitor = dynamic_cast<StatusTextMonitor *>( _monitor );
				view = new StatusTextMonitorView( monitor );
			}
			break;
		case Monitor::SCENE:
			{
				SceneMonitor *monitor = dynamic_cast<SceneMonitor *>( _monitor );
				view = new SceneMonitorView( monitor );
			}
			break;
		case Monitor::FARM:
			{
				// no-op
			}
			break;
		default:
			assert( false );
		}

		if( view )
		{
			if( (_monitor->getType() == Monitor::SCENE)
				&& (centralWidget() == NULL) )
			{
				setCentralWidget( view );
			}

			view->loadSettings();

			monitorViews.push_back( view );
		}
	}
}

//---------------------------------------------------------------------------
// MainWindow::addRunMenu
//---------------------------------------------------------------------------
void MainWindow::addRunMenu( QMenuBar *menuBar )
{
	// Run menu
	QMenu* menu = new QMenu( "&Run", this );
	menuBar->addMenu( menu );
	
	menu->addAction( "&Pause/Resume", this, SLOT(pauseOrResume()), Qt::CTRL + Qt::Key_P);

	pausedStepAction = new QAction( "Step", this );
	pausedStepAction->setShortcut( Qt::Key_Right );
	pausedStepAction->setEnabled( false );
	connect( pausedStepAction, SIGNAL(triggered()),
			 simulationController, SLOT(pausedStep()) );
	menu->addAction( pausedStepAction );

	menu->addSeparator();

	//
	// Speed: a cap on how fast the simulation runs.  The model is step-indexed,
	// so this sets the pace of a run, never its outcome.
	//
	QMenu *speedMenu = menu->addMenu( "&Speed" );

	QActionGroup *speedGroup = new QActionGroup( this );
	speedGroup->setObjectName( "speedActions" );

	static const struct { const char *label; int stepsPerSecond; } speedOptions[] = {
		{ "&Unlimited",   0 },
		{ "1000 steps/s", 1000 },
		{ "100 steps/s",  100 },
		{ "30 steps/s",   30 },
		{ "10 steps/s",   10 },
		{ "1 step/s",     1 },
	};

	for( const auto &option : speedOptions )
	{
		QAction *action = speedMenu->addAction( option.label );
		action->setCheckable( true );
		action->setChecked( option.stepsPerSecond == simulationController->getStepsPerSecond() );
		action->setProperty( "stepsPerSecond", option.stepsPerSecond );
		speedGroup->addAction( action );

		int stepsPerSecond = option.stepsPerSecond;
		connect( action, &QAction::triggered,
				 this, [=]() { simulationController->setStepsPerSecond( stepsPerSecond ); } );
	}

	connect( simulationController, SIGNAL(stepsPerSecondChanged(int)),
			 this, SLOT(syncSpeedMenu(int)) );

	menu->addSeparator();

	menu->addAction( "End At &Timestep...", this, SLOT(endAtTimestep()));
	menu->addAction( "End &Now", this, SLOT(endNow()));

#if __APPLE__
	// This is automatically moved over to the application menu.
    menu->addAction( "&Quit", this, SLOT(endNow()) );
#endif
}

//---------------------------------------------------------------------------
// MainWindow::syncSpeedMenu
//
// Keep the Speed menu's check mark honest when the pace is changed from
// somewhere else (e.g. the terminal UI).
//---------------------------------------------------------------------------
void MainWindow::syncSpeedMenu( int stepsPerSecond )
{
	QActionGroup *speedGroup = findChild<QActionGroup *>( "speedActions" );
	if( !speedGroup )
		return;

	const QList<QAction *> actions = speedGroup->actions();
	for( QAction *action : actions )
	{
		if( action->property( "stepsPerSecond" ).toInt() == stepsPerSecond )
			action->setChecked( true );
	}
}

//---------------------------------------------------------------------------
// MainWindow::addViewMenu
//---------------------------------------------------------------------------
void MainWindow::addViewMenu( QMenuBar *menuBar )
{
	// View menu
	QMenu *menu = new QMenu( "&View", this );
	menuBar->addMenu( menu );

	itfor( MonitorViews, monitorViews, it )
	{
		MonitorView *view = *it;
		QAction *action = new ToggleWidgetOpenAction( this,
													  view,
													  view->getMonitor()->getName() );
		menu->addAction( action );
	}
}

//---------------------------------------------------------------------------
// MainWindow::pauseOrResume
//---------------------------------------------------------------------------
void MainWindow::pauseOrResume()
{
	if( simulationController->isPaused() )
	{
		simulationController->resume();
	}
	else
	{
		simulationController->pause();
	}

	pausedStepAction->setEnabled( simulationController->isPaused() );
}

//---------------------------------------------------------------------------
// MainWindow::endAtTimestep
//---------------------------------------------------------------------------
void MainWindow::endAtTimestep()
{
	bool promptAgain;
	int defaultValue = simulationController->getSimulation()->GetMaxSteps();

	do
	{
		promptAgain = false;

		bool ok;
		int requestedTimestep =
			QInputDialog::getInt( this,
								  "Enter Final Timestep",
								  "On what timestep should Polyworld end?",
								  defaultValue,
								  1,
								  INT_MAX,
								  1,
								  &ok );

		if( ok )
		{
			string result = simulationController->end( requestedTimestep );
			if( result != "" )
			{
				QMessageBox::critical( this,
									   "Failed Setting End Timestep",
									   result.c_str() );
				promptAgain = true;
				defaultValue = requestedTimestep;
			}
		}
	} while( promptAgain );
}

//---------------------------------------------------------------------------
// MainWindow::endNow
//---------------------------------------------------------------------------
void MainWindow::endNow()
{
	exitOnUserConfirm();
}

//---------------------------------------------------------------------------
// MainWindow::loadSettings
//---------------------------------------------------------------------------
void MainWindow::loadSettings()
{
	// Attempt to restore window size and position from prefs
	// Save size and location to prefs
	QSettings settings;
	settings.beginGroup( "mainWindow" );

	// QDesktopWidget is gone in Qt 6; the primary screen's geometry supplies
	// the same numbers desktop->width()/height() did.
	const QRect screenRect = QGuiApplication::primaryScreen()->geometry();

	resize( settings.value("w", int(screenRect.width() * 0.5)).toInt(),
			settings.value("h", int(screenRect.height() * 0.5)).toInt() );

	move( settings.value("x", int(screenRect.width() * 0.25)).toInt(),
		  settings.value("y", int(screenRect.height() * 0.25)).toInt() );
}

//---------------------------------------------------------------------------
// MainWindow::saveSettings
//---------------------------------------------------------------------------
void MainWindow::saveSettings()
{
	QSettings settings;
	settings.beginGroup( "mainWindow" );
	
	settings.setValue( "x", x() );
	settings.setValue( "y", y() );
	settings.setValue( "w", width() );
	settings.setValue( "h", height() );
}

//---------------------------------------------------------------------------
// MainWindow::exitOnUserConfirm
//---------------------------------------------------------------------------
bool MainWindow::exitOnUserConfirm()
{
	QMessageBox::StandardButton response =
		QMessageBox::question( this,
							   "Confirm End Polyworld",
							   "Really end Polyworld now?",
							   QMessageBox::Yes | QMessageBox::Cancel,
							   QMessageBox::Yes );

	if( response == QMessageBox::Yes )
	{
		simulationController->end();

		return true;
	}
	else
	{
		return false;
	}
}
