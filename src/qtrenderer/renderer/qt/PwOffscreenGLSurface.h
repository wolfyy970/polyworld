#pragma once

#include <QImage>
#include <QOffscreenSurface>
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QSize>

//===========================================================================
// PwOffscreenGLSurface
//
// Offscreen OpenGL rendering surface: a framebuffer object rendered through a
// dedicated legacy-profile context on an offscreen surface.
//
// This replaces the QGLPixelBuffer that Qt 5 provided for the same purpose;
// QGLPixelBuffer was removed in Qt 6.  It implements the subset of the
// QGLPixelBuffer API that the renderers use, so the rendering code is
// unchanged.
//===========================================================================
class PwOffscreenGLSurface
{
 public:
	PwOffscreenGLSurface( int width, int height );
	~PwOffscreenGLSurface();

	// Make this surface's context current, with its framebuffer object bound
	// as the draw target.
	void makeCurrent();
	void doneCurrent();

	QSize size() const;

	// Read the rendered image back.  Must be called with this surface current
	// (or from doneCurrent() state; the read-back manages its own binding).
	QImage toImage();

	PwOffscreenGLSurface( const PwOffscreenGLSurface & ) = delete;
	PwOffscreenGLSurface &operator=( const PwOffscreenGLSurface & ) = delete;

 private:
	QOpenGLContext *context;
	QOffscreenSurface *surface;
	QOpenGLFramebufferObject *fbo;
	int width;
	int height;
};
