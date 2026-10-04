#include "PwMovieOffscreenGLRecorder.h"

#include <gl.h>

#include "PwOffscreenGLSurface.h"

//---------------------------------------------------------------------------
//---------------------------------------------------------------------------
//---------------------------------------------------------------------------
//---
//--- PwMovieOffscreenGLRecorder
//---
//---------------------------------------------------------------------------
//---------------------------------------------------------------------------
//---------------------------------------------------------------------------
PwMovieOffscreenGLRecorder::PwMovieOffscreenGLRecorder( PwOffscreenGLSurface *surface,
														PwMovieWriter *writer )
{
	this->surface = surface;
	this->writer = writer;

	width = surface->size().width();
	height = surface->size().height();
	
	rgbBufOld = NULL;
	rgbBufNew = NULL;

	uint32_t rgbBufSize = width * height * sizeof(*rgbBufNew);
	rgbBufOld = (uint32_t *)malloc( rgbBufSize );
	rgbBufNew = (uint32_t *)malloc( rgbBufSize );
}

PwMovieOffscreenGLRecorder::~PwMovieOffscreenGLRecorder()
{
	if( rgbBufOld ) free( rgbBufOld );
	if( rgbBufNew ) free( rgbBufNew );
}

void PwMovieOffscreenGLRecorder::recordFrame( uint32_t timestep )
{
	surface->makeCurrent();

	glReadPixels( 0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, rgbBufNew );

	writer->writeFrame( timestep, width, height, rgbBufOld, rgbBufNew );

	uint32_t *rgbBufSwap = rgbBufNew;
	rgbBufNew = rgbBufOld;
	rgbBufOld = rgbBufSwap;

	surface->doneCurrent();
}
