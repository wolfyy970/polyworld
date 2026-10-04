// pmv2raw — dump a Polyworld .pmv movie to a raw RGBA stream (for ffmpeg) + a PNG per frame is
// not needed; the raw stream keeps this tool tiny and dependency-free.
//
// Build:  clang++ -std=c++17 -O2 -I<repo>/src/library pmv2raw.cc -L<repo>/lib -lpolyworld \
//           -Wl,-rpath,<repo>/lib -o pmv2raw
// Usage:  ./pmv2raw run/movie.pmv out.raw   → prints "frames=WxH count" to stdout.
//
// Frames are written RGBA (native writes RGBA since version 5; unrle* handles both ABGR/RGBA by
// version). Timestep is ignored: the movie is a frame sequence, time is ours to re-time.

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include "PwMovieUtils.h"

int main(int argc, char **argv) {
	if (argc != 3) { fprintf(stderr, "usage: %s movie.pmv out.raw\n", argv[0]); return 2; }
	FILE *in = fopen(argv[1], "rb");
	if (!in) { fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }
	FILE *out = fopen(argv[2], "wb");
	if (!out) { fprintf(stderr, "cannot open %s\n", argv[2]); return 2; }

	PwMovieReader reader(in);
	uint32_t count = reader.getFrameCount();
	uint32_t w = 0, h = 0;
	for (uint32_t i = 1; i <= count; i++) {
		uint32_t timestep = 0, width = 0, height = 0;
		uint32_t *buf = nullptr;
		reader.readFrame(i, &timestep, &width, &height, &buf);
		if (!buf) { fprintf(stderr, "frame %u: no data\n", i); return 3; }
		if (i == 1) { w = width; h = height; }
		else if (width != w || height != h) { fprintf(stderr, "frame %u: size changed\n", i); return 3; }
		size_t n = (size_t)width * height;
		if (fwrite(buf, 4, n, out) != n) { fprintf(stderr, "frame %u: short write\n", i); return 3; }
	}
	fclose(out); fclose(in);
	printf("frames=%u size=%ux%u\n", count, w, h);
	return 0;
}
