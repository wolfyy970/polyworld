#include "PwOffscreenGLSurface.h"

#include <QSurfaceFormat>

//---------------------------------------------------------------------------
// PwOffscreenGLSurface::PwOffscreenGLSurface
//---------------------------------------------------------------------------
PwOffscreenGLSurface::PwOffscreenGLSurface( int _width,
											int _height )
	: width( _width )
	, height( _height )
{
	// The graphics code uses fixed-function OpenGL, so ask for a compatibility
	// profile context.  On macOS this is the legacy 2.1 context, which is the
	// only profile that still provides the immediate mode API.
	QSurfaceFormat format;
	format.setRenderableType( QSurfaceFormat::OpenGL );
	format.setProfile( QSurfaceFormat::CompatibilityProfile );
	format.setVersion( 2, 1 );
	format.setDepthBufferSize( 24 );
	format.setStencilBufferSize( 8 );

	context = new QOpenGLContext;
	context->setFormat( format );
	if( !context->create() )
	{
		qFatal( "PwOffscreenGLSurface: unable to create an OpenGL context" );
	}

	surface = new QOffscreenSurface;
	surface->setFormat( context->format() );
	surface->create();
	if( !surface->isValid() )
	{
		qFatal( "PwOffscreenGLSurface: unable to create an offscreen surface" );
	}

	// The framebuffer object is created through the context's function table,
	// which requires the context to be current.
	context->makeCurrent( surface );

	QOpenGLFramebufferObjectFormat fboFormat;
	fboFormat.setAttachment( QOpenGLFramebufferObject::Depth );
	fbo = new QOpenGLFramebufferObject( width, height, fboFormat );
	if( !fbo->isValid() )
	{
		qFatal( "PwOffscreenGLSurface: unable to create a %dx%d framebuffer object", width, height );
	}

	context->doneCurrent();
}

//---------------------------------------------------------------------------
// PwOffscreenGLSurface::~PwOffscreenGLSurface
//---------------------------------------------------------------------------
PwOffscreenGLSurface::~PwOffscreenGLSurface()
{
	delete fbo;
	delete surface;
	delete context;
}

//---------------------------------------------------------------------------
// PwOffscreenGLSurface::makeCurrent
//---------------------------------------------------------------------------
void PwOffscreenGLSurface::makeCurrent()
{
	context->makeCurrent( surface );
	fbo->bind();
}

//---------------------------------------------------------------------------
// PwOffscreenGLSurface::doneCurrent
//---------------------------------------------------------------------------
void PwOffscreenGLSurface::doneCurrent()
{
	fbo->release();
	context->doneCurrent();
}

//---------------------------------------------------------------------------
// PwOffscreenGLSurface::size
//---------------------------------------------------------------------------
QSize PwOffscreenGLSurface::size() const
{
	return QSize( width, height );
}

//---------------------------------------------------------------------------
// PwOffscreenGLSurface::toImage
//---------------------------------------------------------------------------
QImage PwOffscreenGLSurface::toImage()
{
	QOpenGLContext *previous = QOpenGLContext::currentContext();

	makeCurrent();
	QImage image = fbo->toImage();
	doneCurrent();

	if( previous )
	{
		previous->makeCurrent( previous->surface() );
	}

	return image;
}
