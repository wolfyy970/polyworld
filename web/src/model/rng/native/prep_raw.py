"""One-off prep: copy/sample the probe outputs from the working scratch dir into
native/raw/ so the fixture generator (gen_native_vectors.py) has its inputs.

  python3 prep_raw.py <scratch-dir>
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
SCRATCH = sys.argv[1]
os.makedirs(RAW, exist_ok=True)


def section_lines(path, name):
    out, on = [], False
    for line in open(path):
        if line.startswith("### "):
            on = line[4:].strip() == name
            if on:
                out.append(line)
            continue
        if on:
            out.append(line)
    return out


def stratify(lines, want):
    if len(lines) <= want:
        return lines
    step = len(lines) / want
    return [lines[int(i * step)] for i in range(want)]


def write(name, lines):
    with open(os.path.join(RAW, name), "w") as f:
        f.writelines(lines)
    print(f"{name}: {len(lines)} lines, {os.path.getsize(os.path.join(RAW, name))} bytes")


shutil.copy(os.path.join(SCRATCH, "rng_probe.out"), os.path.join(RAW, "rng_probe.out"))
write("rng_probe.out (copy)", open(os.path.join(RAW, "rng_probe.out")).readlines())

# the seven-seed vectors, everything before the LOG_BIG marker
seed = []
for line in open(os.path.join(SCRATCH, "rng_vectors.out")):
    if line.startswith("### LOG_BIG"):
        break
    seed.append(line)
write("rng_seed_vectors.out", seed)

shutil.copy(os.path.join(SCRATCH, "libm_probe.out"), os.path.join(RAW, "libm_probe.out"))
write("libm_probe.out (copy)", open(os.path.join(RAW, "libm_probe.out")).readlines())

big = section_lines(os.path.join(SCRATCH, "rng_vectors.out"), "LOG_BIG")
write("log_big_sample.txt", stratify(big, 1500))

wide = section_lines(os.path.join(SCRATCH, "wide_probe.out"), "LOG_WIDE")
write("log_wide_sample.txt", stratify(wide, 1500))
