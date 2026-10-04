"""Zip a native corpus section against a candidate's (x, value) output."""
import subprocess
import sys

native_section = sys.argv[1]
cand_bin = sys.argv[2]
native_file = sys.argv[3] if len(sys.argv) > 3 else 'wide_probe.out'

rows = []
in_sec = False
for line in open(native_file):
    if line.startswith('### '):
        in_sec = native_section in line
        continue
    if not in_sec or not line.strip():
        continue
    parts = line.split()
    if len(parts) != 2:
        continue
    rows.append((float(parts[0]), float(parts[1])))

inp = "\n".join(repr(x) for x, _ in rows) + "\n"
out = subprocess.run([cand_bin], input=inp, capture_output=True, text=True).stdout
cand = []
for line in out.splitlines():
    if not line.strip():
        continue
    a, b = line.split()
    cand.append((float(a), float(b)))

n = min(len(rows), len(cand))
bad = 0
for i in range(n):
    if rows[i][0] != cand[i][0]:
        print(f"x mismatch at {i}: {rows[i][0]!r} vs {cand[i][0]!r}")
        break
    if rows[i][1] != cand[i][1]:
        bad += 1
        if bad <= 6:
            print(f"  DIFF x={rows[i][0]!r} native={rows[i][1]!r} cand={cand[i][1]!r}")
print(f"{native_section}: n={n} (native {len(rows)}, cand {len(cand)}) mismatches={bad}")
