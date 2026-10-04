#!/bin/sh
# Lane L11 (sim) — build and run the native step-13 food-radius probe (`foodradiusprobe.cc`).
#
#   ./src/model/sim/native/run_foodradiusprobe.sh <worldfile>
#
# Same shape as `run_simprobe.sh`: compiles against the *oracle's* own `libpolyworld.dylib` and
# headers (read-only — nothing under the native tree is modified) and runs from a scratch CWD that
# symlinks the native tree's `etc/` and `worldfiles/`, so the sim's `run/` output never lands in
# the native tree.
#
# The native tree is found through `POLYWORLD_NATIVE`, then `tools/parity.config.json`'s
# `native_dir`, then `../polyworld`.

set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../../.." && pwd)

NATIVE=${POLYWORLD_NATIVE:-}
if [ -z "$NATIVE" ] && [ -f "$REPO_DIR/tools/parity.config.json" ]; then
    NATIVE=$(python3 -c "import json,sys;print(json.load(open('$REPO_DIR/tools/parity.config.json')).get('native_dir',''))" 2>/dev/null || true)
fi
if [ -z "$NATIVE" ]; then
    NATIVE="$REPO_DIR/../polyworld"
fi

if [ ! -d "$NATIVE" ]; then
    echo "run_foodradiusprobe: no native tree at '$NATIVE' (set POLYWORLD_NATIVE)" >&2
    exit 2
fi
if [ ! -f "$NATIVE/lib/libpolyworld.dylib" ]; then
    echo "run_foodradiusprobe: '$NATIVE/lib/libpolyworld.dylib' is missing; build the native tree first" >&2
    exit 2
fi

WORLDFILE=${1:-worldfiles/tests/low-spec-pc/microtest.wf}
OUT=${FOODRADIUSPROBE_OUT:-$REPO_DIR/node_modules/.cache/foodradiusprobe}
mkdir -p "$OUT"

CXX=${CXX:-/usr/bin/clang++}
SDK=$(xcrun --show-sdk-path)
GSL_PREFIX=$(dirname "$(dirname "$(ls -d /opt/homebrew/Cellar/gsl/*/include | tail -1)")")
if [ -z "$GSL_PREFIX" ] || [ ! -d "$GSL_PREFIX/include" ]; then
    GSL_PREFIX=/opt/homebrew/opt/gsl
fi

echo "run_foodradiusprobe: native=$NATIVE out=$OUT worldfile=$WORLDFILE"

"$CXX" -std=c++17 -O2 -g -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$NATIVE/src/qtrenderer" \
    -I"$SDK/System/Library/Frameworks/OpenGL.framework/Headers" \
    -I"$GSL_PREFIX/include" \
    -I/opt/homebrew/include \
    "$SCRIPT_DIR/foodradiusprobe.cc" \
    -L"$NATIVE/lib" -lpolyworld -lpwqtrenderer -Wl,-rpath,"$NATIVE/lib" \
    -L"$GSL_PREFIX/lib" -lgsl -lgslcblas -Wl,-rpath,"$GSL_PREFIX/lib" \
    -framework OpenGL \
    -o "$OUT/foodradiusprobe"

WORK="$OUT/work"
mkdir -p "$WORK"
[ -e "$WORK/etc" ] || ln -s "$NATIVE/etc" "$WORK/etc"
[ -e "$WORK/worldfiles" ] || ln -s "$NATIVE/worldfiles" "$WORK/worldfiles"
[ -e "$WORK/src" ] || ln -s "$NATIVE/src" "$WORK/src"

cd "$WORK"
"$OUT/foodradiusprobe" "$WORLDFILE"
