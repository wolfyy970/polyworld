#define GLW_DEBUG 0

// System
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <sstream>

// OpenGL
#include <gl.h>

// Qt
#include <QImage>
#include <QFont>
#include <QPainter>

// Self
#include "GLWidget.h"

#if GLW_DEBUG
	#define glwPrint( ... ) { printf( "%s: ", __FUNCTION__ ); printf( __VA_ARGS__ ); }
#else
	#define glwPrint( ... )
#endif

GLWidget::GLWidget( QWidget *parent,
					char** legendParam )
	: QOpenGLWidget( parent )
{
//	printf( "%s: width = %lu\n", __func__, width );

	legend = legendParam;
	frame = NULL;

	glwPrint( "width = %lu, height = %lu\n", width, height );
}

GLWidget::~GLWidget()
{
}

void GLWidget::SetFrame( Frame *frame )
{
	this->frame = frame;

	Draw();
}

void GLWidget::initializeGL()
{
	glwPrint( "called\n" );

	glClearColor( 0.0f, 0.0f, 0.0f, 1.0f );
	glColor4ub( 255, 255, 255, 255 );
}

void GLWidget::Draw()
{
	// QOpenGLWidget renders in paintGL(); this asks for the repaint.
	update();
}

void GLWidget::paintGL()
{
	QPainter painter( this );

	//
	// The frame, drawn with plain OpenGL.  QGLWidget's makeCurrent() /
	// swapBuffers() / setAutoBufferSwap() no longer exist, so the widget
	// simply draws into its own framebuffer here.
	//
	painter.beginNativePainting();

	// 2D pixel-space projection, what resizeGL() used to establish.
	glViewport( 0, 0, width(), height() );
	glMatrixMode( GL_PROJECTION );
	glLoadIdentity();
	glOrtho( 0, width(), 0, height(), -1.0, 1.0 );
	glMatrixMode( GL_MODELVIEW );
	glLoadIdentity();

	if( frame == NULL )
	{
		glClear(GL_COLOR_BUFFER_BIT);
	}
	else
	{
		glRasterPos2i( 0, 0 );
		glPixelZoom( width()/float(frame->width), height()/float(frame->height) );
		glDrawPixels( frame->width, frame->height, GL_RGBA, GL_UNSIGNED_BYTE, frame->rgbBuf );
	}

	painter.endNativePainting();

	//
	// Text overlay.  QGLWidget::renderText() was removed in Qt 6; QPainter
	// draws the same strings.
	//
	if( frame != NULL )
	{
		painter.setPen( Qt::white );

		// Superimpose the timestep number
		QFont font( "Monospace", 8 );
		font.setStyleHint( QFont::TypeWriter );
		font.setPixelSize( 8 );
		painter.setFont( font );

		char timestepString[16];
		sprintf( timestepString, "%8u", frame->timestep );
		painter.drawText( width() - 60, 15, timestepString );

		// Draw the legend
		if( legend )
		{
			int i = 0;
			int y = 24;

			QFont font2( "Arial", 12 );
			QFont font3( "Arial", 20 );
			while( legend[i] )
			{
				painter.setFont( i == 0 ? font2 : font3 );
				painter.drawText( 10, y, legend[i] );

				i++;
				y += 24;
			}
		}
	}
}

void GLWidget::Write( FILE *file )
{
	fwrite( frame->rgbBuf, sizeof(uint32_t), frame->width * frame->height, file );
}

void GLWidget::Save()
{
	std::stringstream fileName;
	fileName << frame->index << ".png";
	QImage image( (uchar*)frame->rgbBuf, frame->width, frame->height, QImage::Format_ARGB32 );
	image.rgbSwapped().mirrored().save( fileName.str().c_str() );
}

void GLWidget::resizeGL( int width, int height )
{
	glwPrint( "width = %lu, height = %lu\n", width, height );
}
