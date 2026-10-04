"""Emit src/model/rng/nativeVectors.ts from the raw probe outputs in native/raw/.

  python3 gen_native_vectors.py     # from the repo root (or any cwd)

The raw files are the oracle's own output (see native/README.md for how each was produced).
Sections are kept verbatim, marked with "### NAME", and parsed by tests/rng.test.ts.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
OUT = os.path.abspath(os.path.join(HERE, "..", "nativeVectors.ts"))


def read(name):
    with open(os.path.join(RAW, name)) as f:
        return f.read()


def section(text, name):
    """Return the lines of the "### name" section (without the marker)."""
    out, on = [], False
    for line in text.splitlines():
        if line.startswith("### "):
            on = line[4:].strip() == name
            continue
        if on and line.strip():
            out.append(line.rstrip())
    return out


def sample(lines, want, stride=None):
    """Stratified sample: keep `want` lines spread across the file."""
    if len(lines) <= want:
        return lines
    step = len(lines) / want
    return [lines[int(i * step)] for i in range(want)]


rng_probe = read("rng_probe.out")
seed_vectors = read("rng_seed_vectors.out")
polar_probe = read("gsl_polar_probe.out")

sections = []
for line in rng_probe.splitlines():
    if line.startswith("### "):
        name = line[4:].strip()
        body = section(rng_probe, name)
        sections.append((name, body))
# the multi-seed sections from the second probe come after the RNG_SEED vectors
seed_sections = []
cur = None
for line in seed_vectors.splitlines():
    if line.startswith("### "):
        cur = (line[4:].strip(), [])
        seed_sections.append(cur)
    elif cur and line.strip():
        cur[1].append(line.rstrip())

# gsl_polar_probe.out: the gaussian draw-count sections (uniform_pos vs uniform)
polar_sections = []
cur = None
for line in polar_probe.splitlines():
    if line.startswith("### "):
        cur = (line[4:].strip(), [])
        polar_sections.append(cur)
    elif cur and line.strip():
        cur[1].append(line.rstrip())

# interleave: seed sections first (they cover rand/drand48/lrand48/random/mt per seed)
all_sections = seed_sections + sections + polar_sections

body = []
for name, lines in all_sections:
    body.append(f"### {name}\n")
    body.extend(l + "\n" for l in lines)
probe_output = "".join(body)

log_corpus = section(read("libm_probe.out"), "LOG_CORPUS")
log_big = sample(section(read("log_big_sample.txt"), "LOG_BIG"), 800)
log_wide = sample(section(read("log_wide_sample.txt"), "LOG_WIDE"), 1200)

header = '''/**
 * Lane W1d — captured native vectors for tests/rng.test.ts.
 *
 * GENERATED — do not edit. Regenerate with native/gen_native_vectors.py from native/raw/,
 * which holds the verbatim output of the probes described in native/README.md:
 *
 *   raw/rng_probe.out        full-precision vectors for rand/drand48/lrand48/random/MT19937,
 *                            GSL uniform/uniform_pos/ugaussian/range, nrand() (incl. its
 *                            spare-value draw counts), and the rancheck replica
 *   raw/rng_seed_vectors.out five draws per stream for seeds 0, 1, 2, 42, 12345, 2^31-1, 2^32-1
 *   raw/libm_probe.out       the log() corpus (uniform, near-1, extremes, subnormals) and the
 *                            exact inputs nrand()/gsl_ran_ugaussian() feed to log()
 *   raw/log_big_sample.txt   stratified sample of the 180,000-value log() sweep
 *   raw/log_wide_sample.txt  stratified sample of the 23,640-value log() sweep
 *   raw/gsl_polar_probe.out  gaussian draw counts from the shipped GSL: the fixed streams
 *                            that tell gsl_rng_uniform_pos from gsl_rng_uniform, plus the
 *                            injected-zero streams (outer/inner draw counts per gaussian)
 *
 * They are test data only: no model code imports this module.
 */

/** Verbatim stdout of `../polyworld/bin/rancheck` (seed 42) — the lane's acceptance table. */
export const RANCHECK_STDOUT = `'''

header += "\\n".join(section(rng_probe, "RANCHECK")) + "\n`;\n\n"
header += "/** Probe output, `### NAME` sections, parsed by the test. */\nexport const PROBE_OUTPUT = `"
header += probe_output
header += "`;\n\n"
header += "/** `log()` corpus: \"x log(x)\" pairs, full precision. */\nexport const LOG_CORPUS = `"
header += "\n".join(log_corpus) + "\n`;\n\n"
header += "/** Stratified sample of the 180,000-value log() sweep. */\nexport const LOG_BIG_SAMPLE = `"
header += "\n".join(log_big) + "\n`;\n\n"
header += "/** Stratified sample of the wide-magnitude log() sweep (subnormals to 1e308). */\nexport const LOG_WIDE_SAMPLE = `"
header += "\n".join(log_wide) + "\n`;\n"

open(OUT, "w").write(header)
print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")
print(f"sections: {len(all_sections)}, log_corpus {len(log_corpus)}, big {len(log_big)}, wide {len(log_wide)}")
