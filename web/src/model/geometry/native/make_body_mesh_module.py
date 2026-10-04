#!/usr/bin/env python3
"""Turn bodyprobe's output into the TypeScript golden module.

    make_body_mesh_module.py <build-dir> <native-agent.obj> <out.ts> "<scenario> <scenario> ..."

Inputs:

    <build-dir>/mesh.txt               `bodyprobe mesh`  — the template mesh + its bounds
    <build-dir>/body.<scenario>.txt    `bodyprobe body`  — one line per recorded agent
    <native-agent.obj>                 the real `etc/objects/agent.obj`, embedded verbatim

Output grammar of a probe line (see `bodyprobe.cpp`):

    mesh <key> <value...>            integers and the per-polygon vertex lists
    f32  <key> <value>:<8 hex> ...   native float32 results
    str  <key> <text...>             provenance
    body number <n> size <v>:<bits> maxSpeed <v>:<bits> lengthX ... radius ... carryRadius ...
    mesh count <n>                   the number of recorded agents in that scenario

Every float is rebuilt from its recorded IEEE-754 bits, so the module carries the exact
float32 pattern the native code produced (a decimal round-trip cannot be trusted).
"""

import struct
import sys
from collections import OrderedDict


def f32_from_bits(hexs: str) -> float:
    return struct.unpack(">f", bytes.fromhex(hexs))[0]


def ts_number(v: float) -> str:
    if v != v:
        return "NaN"
    if v == float("inf"):
        return "Infinity"
    if v == float("-inf"):
        return "-Infinity"
    if v == 0.0:
        import math

        return "-0" if math.copysign(1.0, v) < 0 else "0"
    return repr(float(v))


def parse_f32_pairs(parts):
    """`value:bits` pairs -> list of floats rebuilt from the bits."""
    out = []
    for p in parts:
        value, _, bits = p.partition(":")
        out.append(f32_from_bits(bits) if bits else float(value))
    return out


def parse_probe(path):
    """(ints, floats, strs, bodies) — one pass over a probe output file."""
    ints, floats, strs, bodies = OrderedDict(), OrderedDict(), OrderedDict(), []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            kind, _, rest = line.partition(" ")
            if kind == "mesh":
                key, _, tail = rest.partition(" ")
                if key == "count":
                    ints["count"] = int(tail)
                elif key.startswith("polygon.") and key.endswith(".vertices"):
                    ints[key] = parse_f32_pairs(tail.split())
                elif key.startswith("polygon.") and key.endswith(".numPoints"):
                    ints[key] = int(tail)
                elif key.startswith("template."):
                    ints[key] = int(tail)
                elif key == "numPolygons":
                    ints["numPolygons"] = int(tail)
                elif key == "numPoints":
                    ints["numPoints"] = int(tail)
                else:
                    raise SystemExit("make_body_mesh_module: unknown mesh key %r" % key)
            elif kind == "f32":
                key, _, tail = rest.partition(" ")
                floats[key] = parse_f32_pairs(tail.split())
            elif kind == "str":
                key, _, tail = rest.partition(" ")
                strs[key] = tail
            elif kind == "body":
                fields = rest.split()
                rec = {}
                i = 0
                while i < len(fields):
                    name = fields[i]
                    if name == "number":
                        rec["number"] = int(fields[i + 1])
                    else:
                        rec[name] = f32_from_bits(fields[i + 1].partition(":")[2])
                    i += 2
                bodies.append(rec)
            else:
                raise SystemExit("make_body_mesh_module: unknown line kind %r" % kind)
    return ints, floats, strs, bodies


def ts_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__, file=sys.stderr)
        return 2
    build, obj_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    scenarios = sys.argv[4].split()

    with open(obj_path, "rb") as fh:
        obj_bytes = fh.read()
    import hashlib

    obj_sha = hashlib.sha256(obj_bytes).hexdigest()
    obj_text = obj_bytes.decode("latin-1")

    ints, floats, strs, _ = parse_probe("%s/mesh.txt" % build)

    per_scenario = OrderedDict()
    for scenario in scenarios:
        sints, sfloats, sstrs, sbodies = parse_probe("%s/body.%s.txt" % (build, scenario))
        # The `agent::agentinit()` template the agents clone from must be the same object the
        # mesh mode loaded independently (`Resources::loadPolygons`), or the two halves of
        # this module would describe different meshes.
        if sints.get("template.numPolygons") != ints["numPolygons"]:
            raise SystemExit("make_body_mesh_module: %s: template/numPolygons differ" % scenario)
        for key in ("mesh.template.length", "mesh.template.radius"):
            if sfloats.get(key) != floats[key.replace("template.", "")]:
                raise SystemExit("make_body_mesh_module: %s: %s differs from %s" % (scenario, key, key))
        per_scenario[scenario] = (sints, sfloats, sstrs, sbodies)

    out = []
    w = out.append

    w("/**")
    w(" * Lane W1e — the *agent body mesh* goldens, generated from the NATIVE code path.")
    w(" * DO NOT EDIT: regenerate with `src/model/geometry/native/bodyprobe.sh all --ts`.")
    w(" *")
    w(" * `bodyprobe.cpp` links the real `libpolyworld.dylib` and drives the code the oracle")
    w(" * runs: `Resources::loadPolygons` over the real `etc/objects/agent.obj` for the mesh,")
    w(" * then, per agent of a recorded scenario, the real `Genome::load()` over the recorded")
    w(" * `genome/agents/genome_<n>.txt.gz` and the real `agent::SetGeometry()`")
    w(" * (clonegeom -> in-place vertex scaling -> `gpolyobj::setlen()` -> the virtual")
    w(" * `agent::setradius()`). Every float below is rebuilt from the IEEE-754 bits the")
    w(" * native side printed, so a replay compares bit patterns, not decimals.")
    w(" */")
    w("")
    w("/** What the goldens were recorded from (provenance for a reviewer). */")
    w("export const BODY_GOLDEN_ENVIRONMENT = {")
    w("  native: 'libpolyworld.dylib (the library the oracle binary links), macOS arm64',")
    w("  objectFile: 'etc/objects/agent.obj',")
    w("  objectSha256: '%s'," % obj_sha)
    w("  probe: 'src/model/geometry/native/bodyprobe.cpp',")
    w("} as const;")
    w("")
    w("/** `etc/objects/agent.obj` verbatim — the file `Resources::loadPolygons( obj, \"agent\" )`")
    w(" *  reads (`Resources.cc`'s RPATH `./etc/objects/`). */")
    w("export const AGENT_OBJ_TEXT = `" + ts_escape(obj_text) + "`;")
    w("")
    w("/** The `pw1` file's own `numPolygons` line, kept so a parser can cross-check. */")
    w("export const AGENT_OBJ_HEADER_VERSION = 'pw1';")
    w("export const AGENT_OBJ_NUM_POLYGONS = %d;" % ints["numPolygons"])
    w("")
    w("/** The template `gpolyobj` the native loader built (`agent::agentobj`). */")
    w("export const NATIVE_BODY_TEMPLATE = {")
    w("  numPolygons: %d," % ints["numPolygons"])
    w("  numPoints: %d," % ints["numPoints"])
    w("  /** Per polygon, the vertices as a flat `[x, y, z, ...]` float32 list, in file order. */")
    w("  polygons: [")
    for i in range(ints["numPolygons"]):
        verts = ints["polygon.%d.vertices" % i]
        w("    [%s]," % ", ".join(ts_number(v) for v in verts))
    w("  ],")
    w("  /** `gpolyobj::setlen()`'s bounding box (`fLength`). */")
    w("  length: [%s]," % ", ".join(ts_number(v) for v in floats["mesh.length"]))
    w("  /** `gpolyobj::setradius()`'s value (the 3-D diagonal rule — an `agent` overrides it). */")
    w("  radius: %s," % ts_number(floats["mesh.radius"][0]))
    w("  /** `gpolyobj::init`'s `fRadiusScale`. */")
    w("  radiusScale: %s," % ts_number(floats["mesh.radiusscale"][0]))
    w("} as const;")
    w("")
    w("/** One recorded agent's body, as the native geometry path produced it. */")
    w("export interface NativeAgentBody {")
    w("  /** The agent's Number() — the `genome_<n>.txt.gz` it was read from. */")
    w("  readonly number: number;")
    w("  /** `agent::InitGeneCache()`'s `geneCache.size` (`fGenome->get( \"Size\" )`). */")
    w("  readonly size: number;")
    w("  /** `geneCache.maxSpeed` (`fGenome->get( \"MaxSpeed\" )`). */")
    w("  readonly maxSpeed: number;")
    w("  /** `agent::SetGeometry()`: `Size() / sqrt( geneCache.maxSpeed )`. */")
    w("  readonly lengthX: number;")
    w("  /** `agent::SetGeometry()`: `Size() * sqrt( geneCache.maxSpeed )`. */")
    w("  readonly lengthZ: number;")
    w("  /** `gpolyobj::setlen()`'s bounding box over the scaled mesh. */")
    w("  readonly lx: number;")
    w("  readonly ly: number;")
    w("  readonly lz: number;")
    w("  /** `agent::setradius()`: the collision radius (`fRadius`, and then `fCarryRadius`). */")
    w("  readonly radius: number;")
    w("  readonly carryRadius: number;")
    w("}")
    w("")
    w("/** The `agent::config` values those bodies were computed with. (`maxRadius` and")
    w(" *  `globals::worldsize` are *not* here: the simulation, not the worldfile pipeline this")
    w(" *  probe runs, sets them — Simulation.cc:327/4012.) */")
    w("export interface NativeBodyConfig {")
    w("  readonly worldfile: string;")
    w("  readonly agentHeight: number;")
    w("  readonly minAgentSize: number;")
    w("  readonly maxAgentSize: number;")
    w("  readonly minMaxSpeed: number;")
    w("  readonly maxMaxSpeed: number;")
    w("}")
    w("")
    w("/** Recorded agents per scenario, in agent-number order. */")
    w("export const NATIVE_AGENT_BODIES: Readonly<Record<string, readonly NativeAgentBody[]>> = {")
    for scenario in scenarios:
        sints, sfloats, sstrs, sbodies = per_scenario[scenario]
        w("  %s: [" % scenario)
        for rec in sbodies:
            w(
                "    { number: %d, size: %s, maxSpeed: %s, lengthX: %s, lengthZ: %s, lx: %s, ly: %s,"
                " lz: %s, radius: %s, carryRadius: %s },"
                % (
                    rec["number"],
                    ts_number(rec["size"]),
                    ts_number(rec["maxSpeed"]),
                    ts_number(rec["lengthX"]),
                    ts_number(rec["lengthZ"]),
                    ts_number(rec["lx"]),
                    ts_number(rec["ly"]),
                    ts_number(rec["lz"]),
                    ts_number(rec["radius"]),
                    ts_number(rec["carryRadius"]),
                )
            )
        w("  ],")
    w("};")
    w("")
    w("/** The config each scenario's bodies were produced under. */")
    w("export const NATIVE_BODY_CONFIG: Readonly<Record<string, NativeBodyConfig>> = {")
    for scenario in scenarios:
        sints, sfloats, sstrs, sbodies = per_scenario[scenario]
        w("  %s: {" % scenario)
        w("    worldfile: '%s'," % sstrs["worldfile"])
        w("    agentHeight: %s," % ts_number(sfloats["config.agentHeight"][0]))
        w("    minAgentSize: %s," % ts_number(sfloats["config.minAgentSize"][0]))
        w("    maxAgentSize: %s," % ts_number(sfloats["config.maxAgentSize"][0]))
        w("    minMaxSpeed: %s," % ts_number(sfloats["config.minmaxspeed"][0]))
        w("    maxMaxSpeed: %s," % ts_number(sfloats["config.maxmaxspeed"][0]))
        w("  },")
    w("};")
    w("")

    with open(dst, "w") as fh:
        fh.write("\n".join(out))

    print(
        "wrote %s: mesh %d polys / %d points, %s bodies"
        % (
            dst,
            ints["numPolygons"],
            ints["numPoints"],
            ", ".join("%s=%d" % (s, len(per_scenario[s][3])) for s in scenarios),
        ),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
