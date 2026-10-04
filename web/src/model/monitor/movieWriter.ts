/**
 * Lane L14 — the two movie interfaces the monitor lane programs against.
 *
 * Native: `MovieRecorder.h` (a 11-line pure-virtual interface, one method) and
 * `utils/PwMovieUtils.h`'s `PwMovieWriter` (the pmv container writer).
 *
 * PORT-NOTE(monitor/movie-writer-is-not-this-lane): neither is implemented here. Native
 * `MovieRecorder` is implemented per renderer (`QtMovieRecorder`, created by
 * `SceneRenderer::createMovieRecorder`) and `PwMovieWriter` lives in `library/utils/**
 * (PwMovieUtils.cc, ~1278 lines of RLE/RLE-diff frame encoding). `PORT_SPEC.md` assigns
 * `library/utils/**` to L1/L2 and the renderer to L15/L16/L18; the monitor lane only *drives*
 * them. Declaring the two shapes here (rather than importing a module that does not exist yet)
 * is the same device `src/model/types/{rng,datalib,geometry}.ts` use for the other cuts: the
 * contract is frozen at the boundary, the implementation lands with its owner.
 *
 * `run/movie.pmv` itself is Tier C (not frozen — `PORT_SPEC.md`), so the byte-level fidelity of
 * the encoder is not this lane's acceptance, with one exception the monitor lane *does* own:
 * the timestep written for each frame, i.e. the frame schedule (see `movieController.ts`).
 */

/** Native `class MovieRecorder` (`MovieRecorder.h`). */
export interface MovieRecorder {
  /** Native `virtual void recordFrame( uint32_t timestep )` — called on `renderComplete`. */
  recordFrame(timestep: number): void;
}

/**
 * Native `class PwMovieWriter` (`utils/PwMovieUtils.h`) — restricted to the calls the monitor
 * lane makes (`writeFrame` from the recorder, `close` from the destructor).
 */
export interface MovieWriter {
  /** Native `void writeFrame( timestep, width, height, rgbBufOld, rgbBufNew )`. */
  writeFrame(
    timestep: number,
    width: number,
    height: number,
    rgbBufOld: Uint32Array | null,
    rgbBufNew: Uint32Array,
  ): void;
  /** Native `void close()` — writes the file header and closes the file. */
  close(): void;
}

/** Native `PwMovieWriter *writer = new PwMovieWriter( f )` — the `FILE*` is opened outside. */
export type MovieWriterFactory = (moviePath: string) => MovieWriter;
