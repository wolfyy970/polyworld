#!/bin/sh
# Lane L13 (complexity) — build and run the GSL kernel probe.
#
#   ./src/model/complexity/native/run_gslprobe.sh [outfile]
#
# Compiles `gslprobe.c` against the *shipped* GSL (`/opt/homebrew/opt/gsl`, the same library the
# oracle's `libpolyworld.dylib` links) and writes the bit patterns of `gsl_stats_mean`,
# `gsl_stats_covariance`, `gsl_stats_variance` and the plain `sum/n` for the lane's own vectors.
# Default output: `native/raw/gsl_kernels.txt`, which is committed — the two numbers
# `tests/complexity.test.ts` pins come from here, and re-running this script on the recording
# machine reproduces it byte-for-byte.
#
# The GSL version line is part of the output: the kernels are the library's, so a different GSL
# is a different oracle (the port transcribes this one's algorithms).

set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=${1:-$SCRIPT_DIR/raw/gsl_kernels.txt}

GSL_PREFIX=$(dirname "$(dirname "$(ls -d /opt/homebrew/Cellar/gsl/*/include | tail -1)")")
if [ -z "$GSL_PREFIX" ] || [ ! -d "$GSL_PREFIX/include" ]; then
    GSL_PREFIX=/opt/homebrew/opt/gsl
fi

CC=${CC:-/usr/bin/clang}
BIN=${TMPDIR:-/tmp}/gslprobe.$$

"$CC" -std=c99 -O2 -I"$GSL_PREFIX/include" "$SCRIPT_DIR/gslprobe.c" \
    -L"$GSL_PREFIX/lib" -lgsl -lgslcblas -Wl,-rpath,"$GSL_PREFIX/lib" -o "$BIN"

mkdir -p "$(dirname -- "$OUT")"
{
    echo "# lane L13 (complexity) — GSL kernels, measured on $(uname -s)/$(uname -m) $(sw_vers -productVersion 2>/dev/null || true)"
    echo "# library: $GSL_PREFIX/lib/libgsl.dylib"
    echo "# produced by src/model/complexity/native/run_gslprobe.sh — regenerate, do not edit"
    "$BIN"
} > "$OUT"
rm -f "$BIN"

echo "run_gslprobe: wrote $OUT"
cat "$OUT"
