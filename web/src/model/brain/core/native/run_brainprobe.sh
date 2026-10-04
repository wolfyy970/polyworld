#!/bin/sh
# Lane L6 (brain core) — build and run the native differential probe.
#
#   ./src/model/brain/core/native/run_brainprobe.sh [outdir]
#
# Compiles `brainprobe.cc` against the *oracle's* own `libpolyworld.dylib` and headers
# (read-only; nothing under the native tree is modified) and runs both probe modes into
# `outdir` (default `$BRAINPROBE_DIR`, else `<repo>/node_modules/.cache/brainprobe/pid-$$`, which
# is gitignored). t_d5ed17d8: the default used to be ONE fixed directory shared by every process on
# the checkout, so two concurrent `npx vitest run` linked `$OUT/brainprobe` at the same time and
# one `clang++` read a binary the other was rewriting (`cannot parse the debug map … dsymutil
# command failed`). The directory is now keyed per process; the test passes its own keyed
# directory as `[outdir]`, and `BRAINPROBE_DIR` still pins a known path for a caller.
#
# The native tree is found through `POLYWORLD_NATIVE`, then `tools/parity.config.json`'s
# `native_dir`, then `../polyworld` (the layout the plan documents).
#
# Outputs (per variant, `firingrate` / `taugain` / `spiking`):
#   spec.<variant>.txt       the brain the port must rebuild
#   function.<variant>.txt   native Brain::startFunctional + writeFunctional per step
#   synapses.<variant>.txt   native Brain::dumpSynapses
#   anatomy.<variant>.txt    native Brain::dumpAnatomical
#   summary.<variant>.txt    raw double/float bits, energy use, drand48 samples
# plus format.txt — `%g`/`%f`/`%hd`/`%+06.4f` vectors from this machine's printf,
#      math.txt   — native `logistic()`/`exp()` values as raw bits (the libm census),
#      growexpr.txt — the `GroupsBrain::growSynapses` expressions over the grid,
#      fma.txt    — hardware fused multiply-add rows (the port's `fma64` emulation), and
#      learnclamp.<tag>.txt + spec.<tag>.txt — the learning rule's clamp chain, driven through the
#                  shipped models on a brain whose constructed efficacies sit above the clamp
#                  (`tag` = `clampfiringrate`, `clampfiringrate2`, `clampspiking`), and
#      learndelta.txt + spec.learndelta.txt — the learning rule's fused delta (`fmadd d17, d18,
#                  d19, d17` at 0x5e8a8), driven through the shipped FiringRateModel on rows whose
#                  destination neuron is saturated and whose input activation is a free double, and
#      synapses.<tag>.txt + syndump.<tag>.txt — the `dumpSynapses` → `loadSynapses` → `copySynapses`
#                  → `scaleSynapses` cycle through the shipped `Brain`/`BaseNeuronModel`, on two
#                  families whose short names cannot collide with `models`' `synapses.<variant>.txt`
#                  (`tag` = `synrandom` / `synexact`; each family's brain is that run's `spec.<tag>.txt`)

set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../../../.." && pwd)

NATIVE=${POLYWORLD_NATIVE:-}
if [ -z "$NATIVE" ] && [ -f "$REPO_DIR/tools/parity.config.json" ]; then
    NATIVE=$(python3 -c "import json,sys;print(json.load(open('$REPO_DIR/tools/parity.config.json')).get('native_dir',''))" 2>/dev/null || true)
fi
if [ -z "$NATIVE" ]; then
    NATIVE="$REPO_DIR/../polyworld"
fi
if [ ! -d "$NATIVE" ]; then
    echo "run_brainprobe: no native tree at '$NATIVE' (set POLYWORLD_NATIVE)" >&2
    exit 2
fi
if [ ! -f "$NATIVE/lib/libpolyworld.dylib" ]; then
    echo "run_brainprobe: '$NATIVE/lib/libpolyworld.dylib' is missing; build the native tree first" >&2
    exit 2
fi

OUT=${1:-${BRAINPROBE_DIR:-$REPO_DIR/node_modules/.cache/brainprobe/pid-$$}}
mkdir -p "$OUT"

CXX=${CXX:-/usr/bin/clang++}
SDK=$(xcrun --show-sdk-path)
GSL_PREFIX=$(dirname "$(dirname "$(ls -d /opt/homebrew/Cellar/gsl/*/include | tail -1)")")
if [ -z "$GSL_PREFIX" ] || [ ! -d "$GSL_PREFIX/include" ]; then
    GSL_PREFIX=/opt/homebrew/opt/gsl
fi

echo "run_brainprobe: native=$NATIVE out=$OUT"

"$CXX" -std=c++17 -O2 -g -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$SDK/System/Library/Frameworks/OpenGL.framework/Headers" \
    -I"$GSL_PREFIX/include" \
    -I/opt/homebrew/include \
    "$SCRIPT_DIR/brainprobe.cc" \
    -L"$NATIVE/lib" -lpolyworld -Wl,-rpath,"$NATIVE/lib" \
    -L"$GSL_PREFIX/lib" -lgsl -lgslcblas -Wl,-rpath,"$GSL_PREFIX/lib" \
    -framework OpenGL \
    -o "$OUT/brainprobe"

"$OUT/brainprobe" models "$OUT"
"$OUT/brainprobe" format "$OUT"
"$OUT/brainprobe" math "$OUT"
"$OUT/brainprobe" growexpr "$OUT"
"$OUT/brainprobe" learnclamp "$OUT"
"$OUT/brainprobe" learndelta "$OUT"
"$OUT/brainprobe" synapses "$OUT"
"$OUT/brainprobe" fma "$OUT"

echo "run_brainprobe: wrote probe output to $OUT"
