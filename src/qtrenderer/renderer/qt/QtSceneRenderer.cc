#include <QImage>
#include <QPainter>
#include <QOpenGLWidget>

#include "PwMovieOffscreenGLRecorder.h"
#include "PwOffscreenGLSurface.h"
#include "QtSceneRenderer.h"
#include "utils/PwMovieUtils.h"

//===========================================================================
// SceneRenderer
//===========================================================================

//---------------------------------------------------------------------------
// SceneRenderer::create
//---------------------------------------------------------------------------
SceneRenderer *SceneRenderer::create( gstage &stage,
                                      const CameraProperties &cameraProps,
                                      int width,
                                      int height )
{
    return new QtSceneRenderer(stage, cameraProps, width, height);
}

//===========================================================================
// QtSceneRenderer
//===========================================================================

//---------------------------------------------------------------------------
// QtSceneRenderer::QtSceneRenderer
//---------------------------------------------------------------------------
QtSceneRenderer::QtSceneRenderer( gstage &stage,
                                  const CameraProperties &cameraProps,
                                  int width,
                                  int height )
    : SceneRenderer(stage, cameraProps, width, height)
    , pixelBuffer(nullptr)
{
}

//---------------------------------------------------------------------------
// QtSceneRenderer::~QtSceneRenderer
//---------------------------------------------------------------------------
QtSceneRenderer::~QtSceneRenderer()
{
	if( pixelBuffer )
		delete pixelBuffer;
}

//---------------------------------------------------------------------------
// QtSceneRenderer::render
//---------------------------------------------------------------------------
void QtSceneRenderer::render()
{
	// Don't render if no slots connected
	if( renderComplete.receivers() == 0 )
	{
		return;
	}

	if( pixelBuffer == NULL )
	{
		pixelBuffer = new PwOffscreenGLSurface( width, height );
		pixelBuffer->makeCurrent();

		static GLfloat pos[4] = { 5.0, 5.0, 10.0, 1.0 };
		glLightfv( GL_LIGHT0, GL_POSITION, pos );
    
		//glEnable(GL_CULL_FACE);
		glEnable( GL_DEPTH_TEST );
		glEnable( GL_NORMALIZE );

		glViewport( 0, 0, width, height );

		glMatrixMode( GL_PROJECTION );
		glLoadIdentity();
		glMatrixMode( GL_MODELVIEW );
		glLoadIdentity();

		GLfloat w = (float) width / (float) height;
		GLfloat h = 1.0;
		glFrustum( -w, w, -h, h, 5.0, 60.0 );
	}
	else
	{
		pixelBuffer->makeCurrent();
	}

	glClearColor( 0, 0, 0, 1 );
	glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

	glPushMatrix();
		scene.Draw();
	glPopMatrix();

	pixelBuffer->doneCurrent();

	renderComplete();
}

//---------------------------------------------------------------------------
// QtSceneRenderer::copyTo
//
// The frame is read back here, on demand: the original QGLPixelBuffer-based
// code also paid for the read-back only when a view was displaying.
//---------------------------------------------------------------------------
void QtSceneRenderer::copyTo( QOpenGLWidget *dst )
{
	if( pixelBuffer )
	{
		QImage image = pixelBuffer->toImage();

		QPainter painter( dst );
		painter.drawImage( QRect(0,0,dst->width(),dst->height()), image );
	}
}

//---------------------------------------------------------------------------
// QtSceneRenderer::createMovieRecorder
//---------------------------------------------------------------------------
MovieRecorder *QtSceneRenderer::createMovieRecorder( PwMovieWriter *writer )
{
	assert( pixelBuffer );

	return new PwMovieOffscreenGLRecorder( pixelBuffer, writer );
}
