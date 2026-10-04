/**
 * Lane W1e — the **agent body mesh**: native `graphics/gpolygon.{h,cc}`'s `gpolyobj` as lane L8's
 * `BodyGeometryLike` seam, plus the `pw1` object-file loader `Resources::loadPolygons` drives.
 *
 * PORT-NOTE(W1e/body-mesh-is-model-visible): this is the one piece of the graphics lane the model
 * itself reads. `agent::SetGeometry()` (`agent.cc:993-1013`) clones `agent::agentobj`, scales every
 * vertex in place, calls `setlen()` (the bounding box) and then — through the *virtual*
 * `setradius()` — `agent::setradius()` (`agent.cc:786-792`), whose result is `fRadius`, copied to
 * `fCarryRadius`. Both are read by the collision, carry and contact code, so their bytes decide
 * `run/motion/**` and `run/events/*.log`.
 *
 * The mesh is `etc/objects/agent.obj`, bundled verbatim in `golden/nativeBodyMesh.ts` (generated
 * from the native file by `native/bodyprobe.sh`; its sha256 is pinned there) because the browser
 * has no filesystem. Everything the native code does with it — the bond of the loader, the clone,
 * the in-place scaling, the bounding box, `fRadiusScale`/`fScale`/`fRadiusFixed` — is here.
 *
 * Native's `gpolyobj` and `agent` differ in exactly one place, and the seam keeps the difference
 * visible rather than hiding it: `gpolyobj::setradius()` uses the 3-D diagonal
 * (`gpolygon.cc:249-254`), `agent::setradius()` only `x` and `z` (`agent.cc:786-792`). This module
 * implements the `gpolyobj` rule and *exposes* the box (`lengths()`); the agent-side rule continues
 * to live in `src/model/agent/agent.ts`, exactly where native has it.
 */

import {
  AGENT_OBJ_NUM_POLYGONS,
  AGENT_OBJ_TEXT,
} from './golden/nativeBodyMesh';
import { f32 } from './float';
import { PolyObj, contractedSquareSum, scaledRadius, type Polygon } from './primitives';
import type { Vec3 } from '../types/geometry';
import { vec3 } from './vector';
import type { BodyGeometryLike } from '../agent';

// PORT-NOTE(W1e/body-vec3-import): the *shape* `Vec3` comes from lane W1a's frozen
// `../types/geometry` (data only — `types/geometry-boundary`), the `vec3` *constructor* from this
// lane's `./vector`, which is where every other module in `src/model/geometry/**` takes it
// (camera/primitives/raycast/matrix). W1e's body.ts originally imported both from
// `'../types/geometry'`, which exports no `vec3`; the shape module is not the place to add one
// (PORT_SPEC rule 4: no new API shapes, and `types/geometry.ts` is another lane's file), so the
// import was corrected to the tree's existing spelling.

// ---------------------------------------------------------------------------
// the `pw1` object file (`operator>>( const char*, gpolyobj& )`, `gpolygon.cc:369-441`)
// ---------------------------------------------------------------------------

/**
 * PORT-NOTE(W1e/polyobj-throws-not-exits): native's loader calls
 * `error( 1, ... )` on every malformed input, i.e. prints and `exit(1)`s. The port throws with
 * the same wording (the `proplib/throw-not-exit` convention), so a bad mesh stops the run
 * instead of producing a wrong radius.
 */
export class PolyObjFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolyObjFormatError';
  }
}

/** One polygon of a `pw1` file as the loader produces it (`opoly`, `gpolygon.h:15-19`). */
export interface PolyObjFile {
  /** The `pw1` version token the file starts with (native compares it to `"pw1"`). */
  readonly version: string;
  readonly polygons: readonly Polygon[];
}

/**
 * Native `operator>>( istream&, opoly& )` + `operator>>( const char*, gpolyobj& )`: a `pw1`
 * header, the polygon count, then each polygon's point count and `count * 3` float vertices.
 *
 * The stream operator skips whitespace and parses a C++ float token. This reader splits on
 * whitespace and parses with `Number` + an `f32` round, which is what `istream >> float` does for
 * the decimal text this file contains; a token that is not a number fails the same way the native
 * `_fail reading polyobj file` branch does.
 *
 * PORT-NOTE(W1e/pw1-text-reader): native's `istream >> float` also accepts hex-float, `inf`/`nan`
 * and locale-specific forms; the reader deliberately accepts only plain decimal tokens and refuses
 * anything else loudly. The one file the model loads (`etc/objects/agent.obj`, and `ground.obj`
 * beside it) contains only plain decimals — verified by the golden test, which re-parses the
 * verbatim native text and compares every vertex bit.
 */
export function parsePolyObjFile(text: string, source = '<polyobj>'): PolyObjFile {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  let at = 0;

  const fail = (message: string): never => {
    throw new PolyObjFormatError(message);
  };

  if (tokens.length === 0) return fail(`premature end-of-file for polyobj (${source})`);
  const version = tokens[at++]!;
  if (version !== 'pw1') {
    return fail(`object "${source}" is of unknown type (${version})`);
  }

  const readInt = (what: string): number => {
    if (at >= tokens.length) return fail(`premature end-of-file for polyobj (${source})`);
    const token = tokens[at++]!;
    if (!/^[+-]?\d+$/.test(token)) return fail(`_fail reading polyobj file; probably a formatting error (${what} in ${source})`);
    return Number.parseInt(token, 10);
  };

  const readFloat = (what: string): number => {
    if (at >= tokens.length) return fail(`premature end-of-file for polyobj (${source})`);
    const token = tokens[at++]!;
    const value = Number(token);
    if (Number.isNaN(value) || token === '') {
      return fail(`_fail reading polyobj file; probably a formatting error (${what} in ${source})`);
    }
    // Native stores into a `float` array: the stream's double is narrowed once, here.
    return f32(value);
  };

  const numPolygons = readInt('numPolygons');
  if (numPolygons <= 0) return fail(`invalid number of polys (${numPolygons}) in "${source}"`);

  const polygons: Polygon[] = [];
  for (let i = 0; i < numPolygons; i++) {
    const numPoints = readInt(`polygon ${i} numPoints`);
    if (numPoints <= 0) return fail(`invalid number of points (${numPoints}) in polyobj`);
    const vertices: number[] = [];
    for (let j = 0; j < numPoints * 3; j++) vertices.push(readFloat(`polygon ${i} vertex ${j}`));
    polygons.push({ vertices });
  }

  return { version, polygons };
}

// ---------------------------------------------------------------------------
// the bundled mesh
// ---------------------------------------------------------------------------

/** The `pw1` text of `etc/objects/agent.obj` (verbatim; see `golden/nativeBodyMesh.ts`). */
export const AGENT_OBJ_FILE_TEXT = AGENT_OBJ_TEXT;

/**
 * Native `Resources::loadPolygons( agent::agentobj, "agent" )` + `gpolyobj::init`'s `setlen()`
 * — the template every agent clones (native `agent::agentobj`, built lazily by
 * `agent::agentinit`).
 */
let agentTemplate: PolyObj | null = null;

export function agentBodyTemplate(): PolyObj {
  if (agentTemplate === null) {
    const parsed = parsePolyObjFile(AGENT_OBJ_TEXT, 'etc/objects/agent.obj');
    if (parsed.polygons.length !== AGENT_OBJ_NUM_POLYGONS) {
      throw new PolyObjFormatError(
        `etc/objects/agent.obj: parsed ${parsed.polygons.length} polygons, the golden recorded ${AGENT_OBJ_NUM_POLYGONS}`,
      );
    }
    agentTemplate = new PolyObj(parsed.polygons);
  }
  return agentTemplate;
}

// ---------------------------------------------------------------------------
// gpolyobj as the agent's body geometry
// ---------------------------------------------------------------------------

/** A mutable polygon: native `opoly`'s `float *fVertices`, which `agent::SetGeometry` rewrites. */
interface MutablePolygon {
  numPoints: number;
  vertices: number[];
}

function asTemplatePolygons(template: unknown): readonly Polygon[] {
  const candidate = template as { polygons?: unknown } | null;
  const polygons = candidate?.polygons;
  if (!Array.isArray(polygons) || polygons.length === 0) {
    throw new PolyObjFormatError(
      'AgentBodyGeometry.cloneGeometry(): the body template is not a polygon soup ' +
        '(native `agent::agentobj`; lane L15 loads it with `agentBodyTemplate()`)',
    );
  }
  return polygons as readonly Polygon[];
}

/**
 * Native `gpolyobj` as lane L8's `BodyGeometryLike`: the agent's own copy of the body mesh, with
 * `clonegeom` (from `agent::agentobj`), the in-place vertex scaling `agent::SetGeometry` performs,
 * `setlen`'s bounding box and the radius state (`fRadiusScale`, `fScale`, `fRadiusFixed`).
 *
 * PORT-NOTE(W1e/body-clone-always-allocates): native `clonegeom` (`gpolygon.cc:177-200`) only
 * allocates when `fPolygon == NULL` and otherwise prints `cloning with allocated mem` and copies
 * into the existing buffers. A JS object cannot be half-constructed, so the port always replaces
 * its polygon array — the copies are identical either way, and native's `printf` is debug output,
 * not model state. What matters (and is pinned by `tests/geometry.test.ts`) is that the *target's*
 * vertices become the template's, because `agent::SetGeometry` scales the target in place.
 *
 * PORT-NOTE(W1e/body-scale-in-place): `scaleVertices` rewrites the stored vertices with an `f32`
 * per store, exactly like the native loop (`agent.cc:1005-1010`), and `lengths()` then measures
 * *those* values. Computing the box from the template and scaling the result would be a different
 * (and for a non-power-of-two mesh, observably different) computation.
 */
export class AgentBodyGeometry implements BodyGeometryLike {
  /** Native `fPolygon` + `fNumPolygons`. */
  private polygons: MutablePolygon[] = [];
  /** Native `fLength[3]` — `setlen`'s bounding box, and what `setradius` reads. */
  private length: [number, number, number] = [0, 0, 0];
  /** Native `gobject::fRadius` (this class's own rule; an agent overrides it). */
  private radiusValue = 0;
  /** Native `fRadiusScale`. */
  private radiusScaleValue = 1.0;
  /** Native `gobject::fScale`. */
  private scaleValue = 1.0;
  /** Native `fRadiusFixed` — `setradius( r )` sets it, the two scale setters clear it. */
  private radiusFixedFlag = false;

  /**
   * Native `gpolyobj::clonegeom( const gpolyobj& inPolyObj )` (`gpolygon.cc:177-200`). Takes the
   * template `PolyObj` native keeps in `agent::agentobj`.
   */
  cloneGeometry(template: unknown): void {
    const polygons = asTemplatePolygons(template);
    this.polygons = polygons.map((p) => ({ numPoints: p.vertices.length / 3, vertices: p.vertices.map(f32) }));
  }

  /** Native `agent::SetGeometry()`'s vertex loop: `[x] *= lengthX`, `[y] *= height`, `[z] *= lengthZ`. */
  scaleVertices(lengthX: number, height: number, lengthZ: number): void {
    const lx = f32(lengthX);
    const h = f32(height);
    const lz = f32(lengthZ);
    for (const polygon of this.polygons) {
      const v = polygon.vertices;
      for (let j = 0; j < polygon.numPoints; j++) {
        v[j * 3] = f32(f32(v[j * 3]!) * lx);
        v[j * 3 + 1] = f32(f32(v[j * 3 + 1]!) * h);
        v[j * 3 + 2] = f32(f32(v[j * 3 + 2]!) * lz);
      }
    }
  }

  /**
   * Native `gpolyobj::setlen()` (`gpolygon.cc:271-295`): the axis-aligned bounding box over every
   * vertex of every polygon. (The native comparison `xmin = xmin < v ? xmin : v` is a strict
   * less-than, so ties keep the earlier value; `Math.min`/`Math.max` return the same *value*, which
   * is all `fLength[0]-fLength[2]` keeps.)
   */
  lengths(): readonly [number, number, number] {
    const first = this.polygons[0];
    if (first === undefined) return this.length;
    let xmin = first.vertices[0]!;
    let xmax = xmin;
    let ymin = first.vertices[1]!;
    let ymax = ymin;
    let zmin = first.vertices[2]!;
    let zmax = zmin;
    for (const polygon of this.polygons) {
      const v = polygon.vertices;
      for (let j = 0; j < polygon.numPoints; j++) {
        const x = v[j * 3]!;
        const y = v[j * 3 + 1]!;
        const z = v[j * 3 + 2]!;
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
      }
    }
    this.length = [f32(xmax - xmin), f32(ymax - ymin), f32(zmax - zmin)];
    this.deriveRadius();
    return this.length;
  }

  /**
   * Native `gpolyobj::setradius()` (`gpolygon.cc:249-254`) — the **3-D** diagonal rule. An
   * `agent` overrides this (`agent::setradius`, `agent.cc:786-792`, which uses `x` and `z` only);
   * lane L8 owns that override and calls it from `Agent.setRadius()`. This one is what a plain
   * `gpolyobj` (a scene object) would use.
   */
  deriveRadius(): void {
    if (!this.radiusFixedFlag) {
      const [lx, ly, lz] = this.length;
      // `gpolyobj::setradius()`'s square sum is **contracted** in the shipped build
      // (PORT-NOTE `W1e/radius-fma-contraction` in `primitives.ts`, `0x84ca0 fmul s1, s1, s1`
      // + `0x84ca4`/`0x84cac fmadd`): `lz^2` is the one rounded square and `lx^2`/`ly^2` stay
      // exact, so the sum rounds once. The pre-sweep form rounded all three products — a
      // different value for 45 244 of 200 000 `(lx, ly, lz)` in the model's ranges (22.6 %),
      // and this is the **live** agent-body path (`agent::SetGeometry` → `setlen` → here), so
      // it decided a real `fRadius`/`fCarryRadius`. Both the sum and the tail are
      // `primitives.ts`'s `contractedSquareSum`/`scaledRadius` — one definition, this call site.
      this.radiusValue = scaledRadius(
        contractedSquareSum(lx, ly, lz),
        this.radiusScaleValue,
        this.scaleValue,
      );
    }
  }

  /** Native `gpolyobj::setradius( float r )` — fixes the radius against both scale setters. */
  setRadius(r: number): void {
    this.radiusFixedFlag = true;
    this.radiusValue = f32(r);
  }

  /** Native `gpolyobj::setradiusscale( float s )` — unfixes and re-derives. */
  setRadiusScale(s: number): void {
    this.radiusFixedFlag = false;
    this.radiusScaleValue = f32(s);
    this.deriveRadius();
  }

  /** Native `gpolyobj::setscale( float s )` — unfixes and re-derives. */
  setScale(s: number): void {
    this.scaleValue = f32(s);
    this.deriveRadius();
  }

  // --- the seam lane L8's `BodyGeometryLike` declares ----------------------

  /** Native `gpoly::fRadiusFixed` (the field both `setradius` overrides test). */
  radiusFixed(): boolean {
    return this.radiusFixedFlag;
  }

  /** Native `gpolyobj::radiusscale()`. */
  radiusScale(): number {
    return this.radiusScaleValue;
  }

  /** Native `gobject::fScale` (read through `gpolyobj`'s `setradius`). */
  scale(): number {
    return this.scaleValue;
  }

  // --- readers for the other graphics lanes (L16 renders this mesh) --------

  /** Native `gpolyobj::radius()` — this object's own radius (see `deriveRadius`). */
  radius(): number {
    return this.radiusValue;
  }

  /** Native `gpolyobj::numPolygons()`. */
  numPolygons(): number {
    return this.polygons.length;
  }

  /** Native `fPolygon[i].fVertices` — the scaled vertices, as a `[x, y, z, ...]` list. */
  polygonVertices(index: number): readonly number[] {
    return this.polygons[index]?.vertices ?? [];
  }

  /** Native `fPolygon[i].fNumPoints`. */
  numPointsOf(index: number): number {
    return this.polygons[index]?.numPoints ?? 0;
  }

  /** The bounding box as a vector (convenience for a renderer; native reads `fLength[]`). */
  lengthVector(): Vec3 {
    return vec3(this.length[0], this.length[1], this.length[2]);
  }
}

/**
 * Build the geometry lane L8 asks for: a `gpolyobj` whose template is the bundled
 * `etc/objects/agent.obj`, i.e. the port's `agent::agentobj`.
 *
 * One instance serves every agent of a run: `agent::SetGeometry` always clones the template first,
 * so nothing an agent does to the mesh is visible to the next one — the same reason native keeps
 * one `agentobj` and clones per agent.
 */
export function createAgentBodyGeometry(template: PolyObj = agentBodyTemplate()): AgentBodyGeometry {
  const geometry = new AgentBodyGeometry();
  geometry.cloneGeometry(template);
  return geometry;
}
