#!/usr/bin/env python3
"""Turn glprobe's stdout into the TypeScript golden module.

    make_golden_module.py <goldens.txt> <out.ts>

Input line grammar (one vector or one fixture per line, from `glprobe.cpp`):

    str  <key> <text...>
    f32  <key> <value>:<8 hex digits> ...
    f64  <key> <value> ...
    mat4 <key> <value>:<8 hex digits> x16
    bool <key> <0|1> ...
    scene/camuse/camfix/objpose/fqcase/fqrad/geom/glrotatef/glperspective/gltranslate  <fixture>

The f32/mat4 values are rebuilt from their hex bits, so the module carries the exact
float32 pattern the native code produced (a decimal round-trip cannot be trusted).
"""

import math
import re
import sys
from collections import OrderedDict


def f32_from_bits(hexs: str) -> float:
    import struct

    return struct.unpack(">f", bytes.fromhex(hexs))[0]


def ts_number(v: float) -> str:
    """Shortest round-trip repr; -0 and infinities made explicit."""
    if v != v:
        return "NaN"
    if v == float("inf"):
        return "Infinity"
    if v == float("-inf"):
        return "-Infinity"
    if v == 0.0:
        return "-0" if math.copysign(1.0, v) < 0 else "0"
    s = repr(float(v))
    return s


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]

    strs = OrderedDict()
    f32s = OrderedDict()
    f64s = OrderedDict()
    mat4s = OrderedDict()
    bools = OrderedDict()
    fixtures = OrderedDict()

    with open(src) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            head, _, rest = line.partition(" ")
            if head in ("f32", "mat4", "f64", "bool", "str"):
                key, _, body = rest.partition(" ")
                if head == "str":
                    strs[key] = body
                elif head == "f64":
                    f64s[key] = [float(x) for x in body.split()]
                elif head == "bool":
                    bools[key] = [x == "1" for x in body.split()]
                else:
                    vals = []
                    for tok in body.split():
                        m = re.match(r"^(.*):([0-9a-fA-F]{8})$", tok)
                        vals.append(f32_from_bits(m.group(2)) if m else float(tok))
                    (mat4s if head == "mat4" else f32s)[key] = vals
            else:
                # fixture lines: keep the whole tail; each emitter parses its own grammar
                fixtures.setdefault(head, []).append(rest)

    out = []
    out.append("/**")
    out.append(" * Lane W1e — golden vectors generated from the NATIVE code path, do not edit.")
    out.append(" *")
    out.append(" * Produced by `src/model/geometry/native/glprobe.sh` (see glprobe.cpp): the values")
    out.append(" * come from the real `gcamera`/`gpoint`/`gpolyobj`/`frustumXZ` objects linked out")
    out.append(" * of the native build's `libpolyworld.dylib`, driving the same fixed-function GL")
    out.append(" * (Apple OpenGL + GLU) the oracle binary links:")
    out.append(" *")
    for k in ("gl.version", "gl.renderer", "glu.version"):
        if k in strs:
            out.append(f" *   {k}: {strs[k]}")
    out.append(" *")
    out.append(" * `f32`/`mat4` entries keep the exact float32 bit pattern the native side produced;")
    out.append(" * `f64` entries are the native-side double computations (frustum planes, eye point).")
    out.append(" * The `*FIXTURES` lists are the inputs those vectors were generated from, so a test")
    out.append(" * can replay each case through the port instead of duplicating the constants.")
    out.append(" */")
    out.append("")
    out.append("/** Hardware/implementation the goldens were recorded on. */")
    out.append("export const GOLDEN_ENVIRONMENT = {")
    out.append(f"  glVersion: '{strs.get('gl.version', '')}',")
    out.append(f"  glRenderer: '{strs.get('gl.renderer', '')}',")
    out.append(f"  gluVersion: '{strs.get('glu.version', '')}',")
    out.append("} as const;")
    out.append("")

    def emit(name: str, table, kind: str, isBool: bool = False):
        out.append(f"/** {kind} */")
        out.append(
            f"export const {name}: Readonly<Record<string, readonly {'boolean' if isBool else 'number'}[]>> = {{"
        )
        for key, vals in table.items():
            if isBool:
                body = ", ".join("true" if v else "false" for v in vals)
            else:
                body = ", ".join(ts_number(v) for v in vals)
            out.append(f"  '{key}': [{body}],")
        out.append("};")
        out.append("")

    emit("GOLDEN_F32", f32s, "Native float32 results (bit-exact: rebuilt from the recorded bits).")
    emit("GOLDEN_MAT4", mat4s, "Native 4x4 matrices, GL column-major (16 entries).")
    emit("GOLDEN_F64", f64s, "Native double results.")
    emit("GOLDEN_BOOLS", bools, "Native boolean results.", True)

    out.append("/** The fixed scene configs behind the `gl.obj-><name>.*` vectors. */")
    out.append("export interface GoldenScene {")
    out.append("  readonly name: string;")
    out.append("  readonly worldSize: number;")
    out.append("  readonly agentFOV: number;")
    out.append("  readonly minFocus: number;")
    out.append("  readonly maxFocus: number;")
    out.append("  readonly eyeHeight: number;")
    out.append("  readonly agentHeight: number;")
    out.append("  readonly retinaWidth: number;")
    out.append("  readonly retinaHeight: number;")
    out.append("  /** agent::SetGeometry(): Size() * sqrt(geneCache.maxSpeed) */")
    out.append("  readonly fLengthZ: number;")
    out.append("  readonly agentX: number;")
    out.append("  readonly agentY: number;")
    out.append("  readonly agentZ: number;")
    out.append("  /** agent fAngle[0] in degrees */")
    out.append("  readonly agentYaw: number;")
    out.append("  /** outputNerves.focus->get(), 0..1 */")
    out.append("  readonly focus: number;")
    out.append("  readonly enablePitch: boolean;")
    out.append("  /** outputNerves.visionPitch->get(), 0..1 */")
    out.append("  readonly visionPitch: number;")
    out.append("  readonly enableYaw: boolean;")
    out.append("  /** outputNerves.visionYaw->get(), 0..1 */")
    out.append("  readonly visionYaw: number;")
    out.append("}")
    out.append("")
    out.append("const sceneFlag = (v: string): boolean => v === '1';")
    out.append("")
    out.append("export const GOLDEN_SCENES: readonly GoldenScene[] = [")
    for body in fixtures.get("scene", []):
        name, _, kvbody = body.partition(" ")
        kv = dict(kv.split("=", 1) for kv in kvbody.split())
        out.append("  {")
        out.append(f"    name: '{name}',")
        out.append(f"    worldSize: {ts_number(float(kv['worldSize']))},")
        out.append(f"    agentFOV: {ts_number(float(kv['agentFOV']))},")
        out.append(f"    minFocus: {ts_number(float(kv['minFocus']))},")
        out.append(f"    maxFocus: {ts_number(float(kv['maxFocus']))},")
        out.append(f"    eyeHeight: {ts_number(float(kv['eyeHeight']))},")
        out.append(f"    agentHeight: {ts_number(float(kv['agentHeight']))},")
        out.append(f"    retinaWidth: {int(kv['retinaWidth'])},")
        out.append(f"    retinaHeight: {int(kv['retinaHeight'])},")
        out.append(f"    fLengthZ: {ts_number(float(kv['fLengthZ']))},")
        out.append(f"    agentX: {ts_number(float(kv['agentX']))},")
        out.append(f"    agentY: {ts_number(float(kv['agentY']))},")
        out.append(f"    agentZ: {ts_number(float(kv['agentZ']))},")
        out.append(f"    agentYaw: {ts_number(float(kv['agentYaw']))},")
        out.append(f"    focus: {ts_number(float(kv['focus']))},")
        out.append(f"    enablePitch: sceneFlag('{kv['enablePitch']}'),")
        out.append(f"    visionPitch: {ts_number(float(kv['visionPitch']))},")
        out.append(f"    enableYaw: sceneFlag('{kv['enableYaw']}'),")
        out.append(f"    visionYaw: {ts_number(float(kv['visionYaw']))},")
        out.append("  },")
    out.append("];")
    out.append("")

    out.append("/** `glrotatef <axis> <degrees>`: the six angles x three axes of the primitive probe. */")
    out.append("export const GOLDEN_ROTATEF: readonly { axis: 'x' | 'y' | 'z'; degrees: number }[] = [")
    for body in fixtures.get("glrotatef", []):
        axis, deg = body.split()
        out.append(f"  {{ axis: '{axis}', degrees: {ts_number(float(deg))} }},")
    out.append("];")
    out.append("")

    out.append("/** `glperspective <fov> <aspect> <near> <far>`. */")
    out.append("export const GOLDEN_PERSPECTIVES: readonly { fov: number; aspect: number; near: number; far: number }[] = [")
    for body in fixtures.get("glperspective", []):
        fov, aspect, near, far = body.split()
        out.append(
            f"  {{ fov: {ts_number(float(fov))}, aspect: {ts_number(float(aspect))},"
            f" near: {ts_number(float(near))}, far: {ts_number(float(far))} }},"
        )
    out.append("];")
    out.append("")

    out.append("/** `gltranslate <x> <y> <z>`. */")
    out.append("export const GOLDEN_TRANSLATE: readonly { x: number; y: number; z: number }[] = [")
    for body in fixtures.get("gltranslate", []):
        x, y, z = body.split()
        out.append(f"  {{ x: {ts_number(float(x))}, y: {ts_number(float(y))}, z: {ts_number(float(z))} }},")
    out.append("];")
    out.append("")

    out.append("/** `objpose <name> x y z yaw pitch roll scale setRotation` (gobject::position + glScalef). */")
    out.append("export interface GoldenObjectPose {")
    out.append("  readonly name: string;")
    out.append("  readonly x: number;")
    out.append("  readonly y: number;")
    out.append("  readonly z: number;")
    out.append("  readonly yaw: number;")
    out.append("  readonly pitch: number;")
    out.append("  readonly roll: number;")
    out.append("  readonly scale: number;")
    out.append("  /** false: the object never had SetRotation called, so gobject::rotate() is a no-op */")
    out.append("  readonly setRotation: boolean;")
    out.append("}")
    out.append("")
    out.append("export const GOLDEN_OBJECT_POSES: readonly GoldenObjectPose[] = [")
    for body in fixtures.get("objpose", []):
        name, _, rest2 = body.partition(" ")
        x, y, z, yaw, pitch, roll, scale, rot = rest2.split()
        out.append("  {")
        out.append(f"    name: '{name}',")
        out.append(f"    x: {ts_number(float(x))}, y: {ts_number(float(y))}, z: {ts_number(float(z))},")
        out.append(
            f"    yaw: {ts_number(float(yaw))}, pitch: {ts_number(float(pitch))},"
            f" roll: {ts_number(float(roll))},"
        )
        out.append(f"    scale: {ts_number(float(scale))}, setRotation: {str(rot == '1').lower()},")
        out.append("  },")
    out.append("];")
    out.append("")

    out.append("/** `camuse <name> fov aspect near far x y z` (gcamera::Use, no follow object). */")
    out.append("export interface GoldenCameraUse {")
    out.append("  readonly name: string;")
    out.append("  readonly fov: number;")
    out.append("  readonly aspect: number;")
    out.append("  readonly near: number;")
    out.append("  readonly far: number;")
    out.append("  readonly x: number;")
    out.append("  readonly y: number;")
    out.append("  readonly z: number;")
    out.append("}")
    out.append("")
    out.append("export const GOLDEN_CAMERA_USES: readonly GoldenCameraUse[] = [")
    for body in fixtures.get("camuse", []):
        name, _, kvbody = body.partition(" ")
        kv = dict(kv.split("=", 1) for kv in kvbody.split())
        out.append(
            f"  {{ name: '{name}', fov: {ts_number(float(kv['fov']))},"
            f" aspect: {ts_number(float(kv['aspect']))}, near: {ts_number(float(kv['near']))},"
            f" far: {ts_number(float(kv['far']))}, x: {ts_number(float(kv['x']))},"
            f" y: {ts_number(float(kv['y']))}, z: {ts_number(float(kv['z']))} }},"
        )
    out.append("];")
    out.append("")

    out.append("/** `camfix <name> fov near far width height x y z` (FixPerspective + Use). */")
    out.append("export interface GoldenCameraFix {")
    out.append("  readonly name: string;")
    out.append("  readonly fov: number;")
    out.append("  readonly near: number;")
    out.append("  readonly far: number;")
    out.append("  /** SetAspect(width, height) */")
    out.append("  readonly width: number;")
    out.append("  readonly height: number;")
    out.append("  readonly x: number;")
    out.append("  readonly y: number;")
    out.append("  readonly z: number;")
    out.append("}")
    out.append("")
    out.append("export const GOLDEN_CAMERA_FIXES: readonly GoldenCameraFix[] = [")
    for body in fixtures.get("camfix", []):
        name, _, kvbody = body.partition(" ")
        kv = dict(kv.split("=", 1) for kv in kvbody.split())
        out.append(
            f"  {{ name: '{name}', fov: {ts_number(float(kv['fov']))},"
            f" near: {ts_number(float(kv['near']))}, far: {ts_number(float(kv['far']))},"
            f" width: {ts_number(float(kv['width']))}, height: {ts_number(float(kv['height']))},"
            f" x: {ts_number(float(kv['x']))}, y: {ts_number(float(kv['y']))},"
            f" z: {ts_number(float(kv['z']))} }},"
        )
    out.append("];")
    out.append("")

    out.append("/** `fqcase <name> x z ang fov`: frustumXZ::Set(x, z, ang, fov). */")
    out.append("export const GOLDEN_FRUSTUM_CASES: readonly { name: string; x: number; z: number; ang: number; fov: number }[] = [")
    for body in fixtures.get("fqcase", []):
        name, _, rest2 = body.partition(" ")
        x, z, ang, fov = rest2.split()
        out.append(
            f"  {{ name: '{name}', x: {ts_number(float(x))}, z: {ts_number(float(z))},"
            f" ang: {ts_number(float(ang))}, fov: {ts_number(float(fov))} }},"
        )
    out.append("];")
    out.append("")

    out.append("/** `fqrad <name> x z ang fov rad`: frustumXZ::Set(x, z, ang, fov, rad). */")
    out.append("export const GOLDEN_FRUSTUM_RADII: readonly { name: string; x: number; z: number; ang: number; fov: number; rad: number }[] = [")
    for body in fixtures.get("fqrad", []):
        name, _, rest2 = body.partition(" ")
        x, z, ang, fov, rad = rest2.split()
        out.append(
            f"  {{ name: '{name}', x: {ts_number(float(x))}, z: {ts_number(float(z))},"
            f" ang: {ts_number(float(ang))}, fov: {ts_number(float(fov))},"
            f" rad: {ts_number(float(rad))} }},"
        )
    out.append("];")
    out.append("")

    out.append("/** `geom polyobj nPolys=.. points=.. v=..|..`: the gpolyobj fixture polygons. */")
    out.append("export const GOLDEN_POLYOBJ: { readonly polygons: readonly (readonly number[])[] } = {")
    for body in fixtures.get("geom", []):
        _, _, kvbody = body.partition(" ")
        kv = dict(kv.split("=", 1) for kv in kvbody.split())
        polys = kv["v"].split("|")
        out.append("  polygons: [")
        for p in polys:
            out.append(f"    [{', '.join(ts_number(float(x)) for x in p.split(','))}],")
        out.append("  ],")
    out.append("};")
    out.append("")

    out.append("/** The inside/outside fan of the frustum cases, in `fqcase` order. */")
    out.append("export const GOLDEN_FRUSTUM_INSIDE: Readonly<Record<string, readonly boolean[]>> = {")
    for key, vals in bools.items():
        if key.endswith(".inside"):
            out.append(f"  '{key[:-len('.inside')]}': [{', '.join('true' if v else 'false' for v in vals)}],")
    out.append("};")
    out.append("")

    import os

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "w") as fh:
        fh.write("\n".join(out))
    print(f"wrote {dst}: f32={len(f32s)} mat4={len(mat4s)} f64={len(f64s)} bool={len(bools)} fixtures={ {k: len(v) for k, v in fixtures.items()} }", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
