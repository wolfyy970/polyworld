#!/bin/sh
# Lane L11 (sim) — build and run the native *step-wise* probe (`simprobe_steps.cc`).
#
#   ./src/model/sim/native/run_simprobe_steps.sh <worldfile> [numSteps] [agentNumbers...]
#
# Same contract as `run_simprobe.sh` (read-only native tree, scratch CWD that symlinks `etc/`,
# `worldfiles/` and `src/`), plus the Qt bits `simprobe.cc` does not need: the probe creates a
# `QGuiApplication` so `QtAgentPovRenderer::beginStep()` can build its offscreen GL surface, which
# is what makes `sim->Step()` runnable outside the Qt app.
#
# `QT_QPA_PLATFORM` is passed through; the default here is `offscreen` (no window-server access is
# needed). Use `QT_QPA_PLATFORM=minimal` if the offscreen plugin cannot make a GL context.

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

if [ ! -f "$NATIVE/lib/libpolyworld.dylib" ]; then
    echo "run_simprobe_steps: '$NATIVE/lib/libpolyworld.dylib' is missing; build the native tree first" >&2
    exit 2
fi

QT_PREFIX=${QT_PREFIX:-/opt/homebrew/opt/qtbase}
QT_PLUGINS=${QT_PLUGINS:-/opt/homebrew/share/qt/plugins}
if [ ! -d "$QT_PREFIX/lib" ]; then
    echo "run_simprobe_steps: no Qt at '$QT_PREFIX' (set QT_PREFIX)" >&2
    exit 2
fi

WORLDFILE=${1:-worldfiles/tests/low-spec-pc/minitest.wf}
NUMSTEPS=${2:-70}
shift 2 2>/dev/null || true

OUT=${SIMPROBE_OUT:-$REPO_DIR/node_modules/.cache/simprobe}
mkdir -p "$OUT"

CXX=${CXX:-/usr/bin/clang++}
SDK=$(xcrun --show-sdk-path)
GSL_PREFIX=$(dirname "$(dirname "$(ls -d /opt/homebrew/Cellar/gsl/*/include | tail -1)")")
if [ -z "$GSL_PREFIX" ] || [ ! -d "$GSL_PREFIX/include" ]; then
    GSL_PREFIX=/opt/homebrew/opt/gsl
fi

echo "run_simprobe_steps: native=$NATIVE out=$OUT worldfile=$WORLDFILE steps=$NUMSTEPS"

"$CXX" -std=c++17 -O1 -g -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$NATIVE/src/qtrenderer" \
    -I"$SDK/System/Library/Frameworks/OpenGL.framework/Headers" \
    -I"$GSL_PREFIX/include" \
    -I/opt/homebrew/include \
    -F"$QT_PREFIX/lib" \
    -I"$QT_PREFIX/lib/QtCore.framework/Headers" \
    -I"$QT_PREFIX/lib/QtGui.framework/Headers" \
    "$SCRIPT_DIR/simprobe_steps.cc" \
    -L"$NATIVE/lib" -lpolyworld -lpwqtrenderer -Wl,-rpath,"$NATIVE/lib" \
    -F"$QT_PREFIX/lib" -framework QtGui -framework QtCore \
    -L"$GSL_PREFIX/lib" -lgsl -lgslcblas -Wl,-rpath,"$GSL_PREFIX/lib" \
    -framework OpenGL \
    -o "$OUT/simprobe_steps"

WORK="$OUT/work-steps"
mkdir -p "$WORK"
[ -e "$WORK/etc" ] || ln -s "$NATIVE/etc" "$WORK/etc"
[ -e "$WORK/worldfiles" ] || ln -s "$NATIVE/worldfiles" "$WORK/worldfiles"
[ -e "$WORK/src" ] || ln -s "$NATIVE/src" "$WORK/src"

cd "$WORK"
QT_QPA_PLATFORM=${QT_QPA_PLATFORM:-offscreen} \
QT_PLUGIN_PATH="$QT_PLUGINS" \
DYLD_FRAMEWORK_PATH="$QT_PREFIX/lib" \
    "$OUT/simprobe_steps" "$WORLDFILE" "$NUMSTEPS" "$@"
