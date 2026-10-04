#!/bin/sh
# Lane L11 (sim) — build and run the native whole-sim probe (`simprobe.cc`).
#
#   ./src/model/sim/native/run_simprobe.sh <worldfile> [mode]
#
# Compiles `simprobe.cc` against the *oracle's* own `libpolyworld.dylib` and headers (read-only:
# nothing under the native tree is modified) and runs it from a scratch CWD that symlinks the
# native tree's `etc/` and `worldfiles/` (the paths `RPATH` and the worldfile argument resolve
# against), so the sim's own `run/` output lands in the scratch dir and never in the native tree.
#
# The native tree is found through `POLYWORLD_NATIVE`, then `tools/parity.config.json`'s
# `native_dir`, then `../polyworld` (the layout the plan documents).

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
    echo "run_simprobe: no native tree at '$NATIVE' (set POLYWORLD_NATIVE)" >&2
    exit 2
fi
if [ ! -f "$NATIVE/lib/libpolyworld.dylib" ]; then
    echo "run_simprobe: '$NATIVE/lib/libpolyworld.dylib' is missing; build the native tree first" >&2
    exit 2
fi

WORLDFILE=${1:-worldfiles/tests/low-spec-pc/microtest.wf}
MODE=${2:-boot}
OUT=${SIMPROBE_OUT:-$REPO_DIR/node_modules/.cache/simprobe}
mkdir -p "$OUT"

CXX=${CXX:-/usr/bin/clang++}
SDK=$(xcrun --show-sdk-path)
GSL_PREFIX=$(dirname "$(dirname "$(ls -d /opt/homebrew/Cellar/gsl/*/include | tail -1)")")
if [ -z "$GSL_PREFIX" ] || [ ! -d "$GSL_PREFIX/include" ]; then
    GSL_PREFIX=/opt/homebrew/opt/gsl
fi

echo "run_simprobe: native=$NATIVE out=$OUT worldfile=$WORLDFILE mode=$MODE"

"$CXX" -std=c++17 -O2 -g -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$NATIVE/src/qtrenderer" \
    -I"$SDK/System/Library/Frameworks/OpenGL.framework/Headers" \
    -I"$GSL_PREFIX/include" \
    -I/opt/homebrew/include \
    "$SCRIPT_DIR/simprobe.cc" \
    -L"$NATIVE/lib" -lpolyworld -lpwqtrenderer -Wl,-rpath,"$NATIVE/lib" \
    -L"$GSL_PREFIX/lib" -lgsl -lgslcblas -Wl,-rpath,"$GSL_PREFIX/lib" \
    -framework OpenGL \
    -o "$OUT/simprobe"

WORK="$OUT/work"
mkdir -p "$WORK"
[ -e "$WORK/etc" ] || ln -s "$NATIVE/etc" "$WORK/etc"
[ -e "$WORK/worldfiles" ] || ln -s "$NATIVE/worldfiles" "$WORK/worldfiles"
# `Resources::getInterpreterScript()` finds `src/library/proplib/interpreter.py` through the same
# `RPATH` ("./"), so the probe needs the native tree's `src/` next to `etc/` in its CWD.
[ -e "$WORK/src" ] || ln -s "$NATIVE/src" "$WORK/src"

cd "$WORK"
"$OUT/simprobe" "$WORLDFILE" "$MODE"
