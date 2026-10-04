// Self
#include "BrainMonitorView.h"

#include <glu.h>

// Local
#include "agent/agent.h"
#include "agent/Retina.h"
#include "brain/Brain.h"
#include "monitor/AgentTracker.h"
#include "monitor/Monitor.h"


using namespace std;

// The default size is only used until we get an agent (presumably on the first step)
#define DEFAULT_WIDTH 300
#define DEFAULT_HEIGHT 100

#define PATCH_WIDTH 8
#define PATCH_HEIGHT 8

//===========================================================================
// BrainMonitorView
//===========================================================================

//---------------------------------------------------------------------------
// BrainMonitorView::BrainMonitorView
//---------------------------------------------------------------------------
BrainMonitorView::BrainMonitorView( BrainMonitor *monitor )
	: MonitorView( monitor, DEFAULT_WIDTH, DEFAULT_HEIGHT )
	, fAgent(NULL)
{
	updateTarget( monitor->getTracker() );

    updateTarget_handle =
        monitor->getTracker()->targetChanged += [=](AgentTracker *tracker) {this->updateTarget(tracker);};
    monitor->update += [=]() {this->update();};
}


//---------------------------------------------------------------------------
// BrainMonitorView::~BrainMonitorView
//---------------------------------------------------------------------------
BrainMonitorView::~BrainMonitorView()
{
    ((BrainMonitor*)getMonitor())->getTracker()->targetChanged -= updateTarget_handle;
}


//---------------------------------------------------------------------------
// BrainMonitorView::paintGL
//---------------------------------------------------------------------------
void BrainMonitorView::paintGL()
{
	draw();
}


//---------------------------------------------------------------------------
// BrainMonitorView::initializeGL
//---------------------------------------------------------------------------
void BrainMonitorView::initializeGL()
{
	glClearColor( 0.0f, 0.0f, 0.0f, 1.0f );
    glShadeModel( GL_SMOOTH );
}


//---------------------------------------------------------------------------
// BrainMonitorView::resizeGL
//---------------------------------------------------------------------------
void BrainMonitorView::resizeGL(int width, int height)
{
	glViewport(0, 0, width, height);
	glMatrixMode(GL_PROJECTION);
	glLoadIdentity();
	gluOrtho2D(0.0, width, 0.0, height);	
	glMatrixMode(GL_MODELVIEW);
}
   
    
//---------------------------------------------------------------------------
// BrainMonitorView::draw
//
// Draws into the widget's GL context; QOpenGLWidget calls this from
// paintGL(), which is the only place its context is current.
//---------------------------------------------------------------------------
void BrainMonitorView::draw()
{	
	if( !isVisible() )
		return;

	glClearColor( 0.0f, 0.0f, 0.0f, 1.0f );
	glClear( GL_COLOR_BUFFER_BIT );

	if( fAgent != NULL )
	{
		// Frame and draw the actual vision pixels
		glColor3f( 0.5f, 0.5f, 0.5f );
		glRecti( 2*PATCH_WIDTH-1, 0, (2+Brain::config.retinaWidth)*PATCH_WIDTH+1, PATCH_HEIGHT );
		glPixelZoom( float(PATCH_WIDTH), float(PATCH_HEIGHT) );
		glRasterPos2i( 2*PATCH_WIDTH, 0 );
		glDrawPixels( Brain::config.retinaWidth, 1, GL_RGBA, GL_UNSIGNED_BYTE, fAgent->GetRetina()->getBuffer() );
		glPixelZoom( 1.0, 1.0 );

		// Render brain
		fAgent->GetBrain()->getRenderer()->render( PATCH_WIDTH, PATCH_HEIGHT );
	}
}

//---------------------------------------------------------------------------
// BrainMonitorView::updateTarget
//---------------------------------------------------------------------------
void BrainMonitorView::updateTarget( AgentTracker *tracker )
{
	fAgent = tracker->getTarget();
	if( (fAgent == NULL) || (fAgent->GetBrain()->getRenderer() == NULL) )
	{
		setFixedSize( DEFAULT_WIDTH, DEFAULT_HEIGHT );
		fAgent = NULL;
	}
	else
	{
		short winWidth;
		short winHeight;

		fAgent->GetBrain()->getRenderer()->getSize( PATCH_WIDTH, PATCH_HEIGHT, &winWidth, &winHeight );				  
		setFixedSize(winWidth, winHeight);
	}

	char title[128];
	sprintf( title, "%s (%s)", getMonitor()->getTitle(), tracker->getStateTitle().c_str() );

	setWindowTitle( title );
}
