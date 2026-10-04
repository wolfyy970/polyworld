#pragma once

#include "monitor/MovieRecorder.h"
#include "utils/PwMovieUtils.h"

//===========================================================================
// PwMovieOffscreenGLRecorder
//
// Records frames off a PwOffscreenGLSurface (the QGLPixelBuffer replacement)
// into a PwMovie.
//===========================================================================
class PwMovieOffscreenGLRecorder : public MovieRecorder
{
 public:
	PwMovieOffscreenGLRecorder( class PwOffscreenGLSurface *surface, PwMovieWriter *writer );
	virtual ~PwMovieOffscreenGLRecorder();
	
	virtual void recordFrame( uint32_t timestep ) override;

 private:
	class PwOffscreenGLSurface *surface;
	PwMovieWriter *writer;
	uint32_t width;
	uint32_t height;
	uint32_t *rgbBufOld;
	uint32_t *rgbBufNew;
};
