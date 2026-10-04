#!/bin/sh
# Lane L13 (complexity) — build and run the native differential probe.
#
#   ./src/model/complexity/native/run_complexityprobe.sh [outdir]
#
# Compiles `complexityprobe.cc` against the *oracle's* own `libpolyworld.dylib` and headers
# (read-only; nothing under the native tree is modified) and runs its modes into `outdir`
# (default `<repo>/node_modules/.cache/complexityprobe`, which is gitignored).
#
# The native tree is found through `POLYWORLD_NATIVE`, then `tools/parity.config.json`'s
# `native_dir`, then `../polyworld` (the layout the plan documents).
#
# Outputs:
#   brain.txt    the real `CalcComplexity_brainfunction()` over the recorded
#                `run/brain/function/brainFunction_*.txt.gz` fixtures, one line per
#                (file, parts) with the bits of the returned double
#   pieces.txt   `CalcApproximateFullComplexityWithMatrix`'s pipeline stage by stage
#                (noise, `gsamp`, `calcCOV`, `determinant`, `CalcI`, `calcC_k_exact`) over a
#                matrix the probe generates itself -- plus the library's own end-to-end value
#                for that matrix, which the replica must reproduce (the probe exits 3 if not)
#
# The probe needs the fixtures, so it reads them where the goldens live (`oracle/**`, which is
# read-only). The datalib/gzip readers are the native tree's own, so no decompression happens
# here.

set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../../.." && pwd)

NATIVE=${POLYWORLD_NATIVE:-}
if [ -z "$NATIVE" ] && [ -f "$REPO_DIR/tools/parity.config.json" ]; then
    NATIVE=$(python3 -c "import json;print(json.load(open('$REPO_DIR/tools/parity.config.json')).get('native_dir',''))" 2>/dev/null || true)
fi
if [ -z "$NATIVE" ]; then
    NATIVE="$REPO_DIR/../polyworld"
fi
if [ ! -d "$NATIVE" ]; then
    echo "run_complexityprobe: no native tree at '$NATIVE' (set POLYWORLD_NATIVE)" >&2
    exit 2
fi
if [ ! -f "$NATIVE/lib/libpolyworld.dylib" ]; then
    echo "run_complexityprobe: '$NATIVE/lib/libpolyworld.dylib' is missing; build the native tree first" >&2
    exit 2
fi

OUT=${1:-$REPO_DIR/node_modules/.cache/complexityprobe}
mkdir -p "$OUT"

CXX=${CXX:-/usr/bin/clang++}
SDK=$(xcrun --show-sdk-path)
GSL_PREFIX=$(dirname "$(dirname "$(ls -d /opt/homebrew/Cellar/gsl/*/include | tail -1)")")
if [ -z "$GSL_PREFIX" ] || [ ! -d "$GSL_PREFIX/include" ]; then
    GSL_PREFIX=/opt/homebrew/opt/gsl
fi

echo "run_complexityprobe: native=$NATIVE out=$OUT"

"$CXX" -std=c++17 -O2 -g -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$SDK/System/Library/Frameworks/OpenGL.framework/Headers" \
    -I"$GSL_PREFIX/include" \
    -I/opt/homebrew/include \
    "$SCRIPT_DIR/complexityprobe.cc" \
    -L"$NATIVE/lib" -lpolyworld -Wl,-rpath,"$NATIVE/lib" \
    -L"$GSL_PREFIX/lib" -lgsl -lgslcblas -Wl,-rpath,"$GSL_PREFIX/lib" \
    -framework OpenGL \
    -o "$OUT/complexityprobe"

"$OUT/complexityprobe" pieces "$OUT" 12 5 1
"$OUT/complexityprobe" pieces "$OUT" 30 9 1
"$OUT/complexityprobe" brain "$OUT" "$REPO_DIR/oracle/minitest_voff/run/brain/function"

echo "run_complexityprobe: wrote probe output to $OUT"
