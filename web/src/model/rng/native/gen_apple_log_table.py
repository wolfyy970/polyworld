"""Emit src/model/rng/appleLogTable.ts from a dumped table (native/apple_log_table.txt).

The table is *data*: it must be reproduced exactly, so it is committed as literals (Python's
repr is the shortest round-trip decimal, which JS parses back to the identical double).

  python3 gen_apple_log_table.py            # from the repo root
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "apple_log_table.txt")
OUT = os.path.abspath(os.path.join(HERE, "..", "appleLogTable.ts"))


def strip_comments(s: str) -> str:
    out, depth, i = [], 0, 0
    while i < len(s):
        if s.startswith("/*", i):
            depth += 1
            i += 2
        elif s.startswith("*/", i):
            depth -= 1
            i += 2
        elif depth == 0:
            out.append(s[i])
            i += 1
        else:
            i += 1
    return "".join(out)


polys, entries = [], []
for line in (l.strip() for l in open(SRC)):
    if not line:
        continue
    if line.startswith("{"):
        vals = [v.strip() for v in strip_comments(line).strip("{}, ").split(",") if v.strip()]
        entries.append([float(v) for v in vals])
    elif "0x" in line and not line.startswith("//") and not line.startswith("#"):
        try:
            polys.append(float(strip_comments(line).strip()))
        except ValueError:
            continue  # the dump's "log @ 0x… table @ 0x…" header line

assert len(polys) == 6, len(polys)
assert len(entries) == 129, len(entries)

body = []
body.append("""/**
 * Lane W1d — the oracle libm `log` data (macOS 26.5.2, arm64).
 *
 * GENERATED — do not edit. `log()` in ./libm.ts is a transcription of the shipped
 * libSystem `log`, and these are its polynomial coefficients and its 129 table entries:
 *
 *   index i        -> the interval around z = 1 + i/128, z in [1, 2)
 *   entry[0]       -> `invc`, a double near 1/c (c hand-chosen in [1,2) to make the
 *                     reduction error small)
 *   entry[1]/[2]   -> log(c) as a two-part split that keeps the final sum error-free
 *                     (for i >= 64 it stores log(c) - ln2, which is why the algorithm's
 *                     exponent k is floor(log2 x) + 1)
 *   entry[3]       -> always 0 and never read; not included here
 *
 * Regenerate with native/gen_apple_log_table.py from native/apple_log_table.txt, which is
 * the textual dump of the table that native/dump_libm.c + native/dump_tables.c read out of
 * the running process's own libSystem (see src/model/rng/native/README.md).
 */

/** The 6 polynomial coefficients (r^2 * (c0 + c1 r)(c2 + c3 r + r^2)(c4 + c5 r + r^2)). */
export const LOG_POLY: readonly number[] = [
""")
body.append("  " + ", ".join(repr(v) for v in polys) + ",\n];\n\n")
body.append("/** `invc[i]` — one per interval. */\nexport const LOG_TAB_INVC = new Float64Array([\n")
for row in entries:
    body.append(f"  {row[0]!r},\n")
body.append("]);\n\n/** High part of log(c) for each interval. */\nexport const LOG_TAB_LOGC_HI = new Float64Array([\n")
for row in entries:
    body.append(f"  {row[1]!r},\n")
body.append("]);\n\n/** Low part of log(c) for each interval. */\nexport const LOG_TAB_LOGC_LO = new Float64Array([\n")
for row in entries:
    body.append(f"  {row[2]!r},\n")
body.append("]);\n")

open(OUT, "w").write("".join(body))
print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")
