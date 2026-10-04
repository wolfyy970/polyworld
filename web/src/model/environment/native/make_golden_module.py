#!/usr/bin/env python3
"""Turn `envprobe`'s raw output into the TypeScript golden module (lane L10).

Input lines:  key<TAB>kind<TAB>value
  kind = f32  -> value is `0x` + 8 hex digits: the exact float32 bit pattern
  kind = int  -> value is a decimal integer
  kind = bool -> value is 0/1
  kind = str  -> value is the literal string
`#` lines and blank lines are comments from the probe.

The port never parses a decimal to reproduce a native float, so the `f32` entries are kept
as *bit patterns*: a test asserts `f32Bits( portValue ) === parseInt( goldenKey, 16 )`.
"""

import re
import sys


def parse(path):
    f32 = {}
    ints = {}
    bools = {}
    strs = {}
    comments = []
    with open(path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            if line.startswith("#"):
                comments.append(line[1:].strip())
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            key, kind, value = parts[0], parts[1], parts[2]
            if kind == "f32":
                bits = value[2:] if value.startswith("0x") else value
                if not re.fullmatch(r"[0-9a-fA-F]{8}", bits):
                    raise SystemExit(f"bad f32 bits for {key}: {value}")
                f32[key] = bits.lower()
            elif kind == "int":
                ints[key] = int(value)
            elif kind == "bool":
                bools[key] = value == "1"
            elif kind == "str":
                strs[key] = value
            else:
                raise SystemExit(f"unknown kind {kind!r} for key {key}")
    return f32, ints, bools, strs, comments


def ts_key(k):
    return "'" + k.replace("\\", "\\\\").replace("'", "\\'") + "'"


def ts_string(v):
    out = v.replace("\\", "\\\\").replace('"', '\\"')
    return '"' + out + '"'


def main():
    src, dest = sys.argv[1], sys.argv[2]
    f32, ints, bools, strs, comments = parse(src)

    lines = []
    lines.append("/**")
    lines.append(" * Lane L10 — native values for the environment classes, generated from the")
    lines.append(" * NATIVE code path. Do not edit by hand.")
    lines.append(" *")
    lines.append(" * Produced by `src/model/environment/native/run_envprobe.sh --ts` (see envprobe.cc):")
    lines.append(" * the values come from the real `Energy`, `FoodType`, `food`, `FoodPatch`,")
    lines.append(" * `brick`, `BrickPatch`, `barrier` and `objectxsortedlist` objects linked out of the")
    lines.append(" * native build's `libpolyworld.dylib`. `GOLDEN_F32` holds exact float32 *bit")
    lines.append(" * patterns*, so a comparison cannot drift through a decimal parse:")
    lines.append(" *")
    lines.append(" *   expect(f32Bits(portValue)).toBe(parseInt(GOLDEN_F32[key], 16))")
    lines.append(" *")
    for c in comments:
        lines.append(f" *   {c}")
    lines.append(" *")
    lines.append(" * Regenerate with `bash src/model/environment/native/run_envprobe.sh --ts`.")
    lines.append(" */")
    lines.append("")
    lines.append("/** Probe provenance (informational; nothing compares these). */")
    lines.append("export const GOLDEN_PROBE = {")
    lines.append("  probe: 'envprobe',")
    lines.append(f"  f32Keys: {len(f32)},")
    lines.append(f"  intKeys: {len(ints)},")
    lines.append(f"  boolKeys: {len(bools)},")
    lines.append(f"  strKeys: {len(strs)},")
    lines.append("} as const;")
    lines.append("")

    def emit_map(name, entries, render):
        lines.append(f"/** {name} */")
        lines.append(f"export const {name}: Readonly<Record<string, {render['type']}>> = {{")
        for k, v in entries.items():
            lines.append(f"  {ts_key(k)}: {render['value'](v)},")
        lines.append("};")
        lines.append("")

    emit_map("GOLDEN_F32", f32, {"type": "string", "value": lambda v: "'" + v + "'"})
    emit_map("GOLDEN_INT", ints, {"type": "number", "value": lambda v: str(v)})
    emit_map("GOLDEN_BOOL", bools, {"type": "boolean", "value": lambda v: "true" if v else "false"})
    emit_map("GOLDEN_STR", strs, {"type": "string", "value": ts_string})

    with open(dest, "w") as fh:
        fh.write("\n".join(lines))
    print(
        f"wrote {dest}: f32={len(f32)} int={len(ints)} bool={len(bools)} str={len(strs)}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
