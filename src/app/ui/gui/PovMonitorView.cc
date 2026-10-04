// Self
#include "PovMonitorView.h"

// Local
#include "monitor/Monitor.h"
#include "renderer/qt/QtAgentPovRenderer.h"

QtAgentPovRenderer *to_qt(AgentPovRenderer *r) {return dynamic_cast<QtAgentPovRenderer *>(r);}

//===========================================================================
// PovMonitorView
//===========================================================================

//---------------------------------------------------------------------------
// PovMonitorView::PovMonitorView
//---------------------------------------------------------------------------
PovMonitorView::PovMonitorView( PovMonitor *monitor )
	: MonitorView( monitor,
				   to_qt(monitor->getRenderer())->getBufferWidth(),
				   to_qt(monitor->getRenderer())->getBufferHeight(),
				   false )
	, renderer( to_qt(monitor->getRenderer()) )
{
    renderer->renderComplete += [=]() {this->draw();};
}


//---------------------------------------------------------------------------
// PovMonitorView::~PovMonitorView
//---------------------------------------------------------------------------
PovMonitorView::~PovMonitorView()
{
}

//---------------------------------------------------------------------------
// PovMonitorView::paintGL
//---------------------------------------------------------------------------
void PovMonitorView::paintGL()
{
	renderer->copyTo( this );
}

//---------------------------------------------------------------------------
// PovMonitorView::draw
//---------------------------------------------------------------------------
void PovMonitorView::draw()
{
	// Called from the renderer's completion signal.  QOpenGLWidget content can
	// only be drawn from paintGL(), so schedule a repaint.
	if( isVisible() )
	{
		update();
	}
}
