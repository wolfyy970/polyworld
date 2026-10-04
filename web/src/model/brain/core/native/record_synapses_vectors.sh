#!/bin/sh
# Lane L6 (brain core) — regenerate the committed `synapses` corpus.
#
#   ./record_synapses_vectors.sh
#
# `brainprobe synapses` drives the oracle's own `Brain::dumpSynapses` -> `loadSynapses` ->
# `copySynapses`/`scaleSynapses` and writes `spec.<tag>.txt`, `syndump.<tag>.txt` and
# `synapses.<tag>.txt`. `tests/brain-core.test.ts` replays them through the port, so the
# corpus under `vectors/` is committed and `npm test` needs no C++ (CI, the browser lane and a
# reviewer without a native build all replay the same numbers); the probe re-runs the same
# mode when the native tree *is* present and fails if the regenerated files differ.
#
# PORT-NOTE(L6/synapse-vectors): re-run this script only when the probe's *inputs* change
# (a new family, a new `maxWeight`, a new shape). A diff in `vectors/` is a change to the
# ORACLE, not to the port: it means the native build's dump/load behaviour moved.
set -u -o pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "$HERE/../../../../.." && pwd)"

NATIVE=${POLYWORLD_NATIVE:-}
if [ -z "$NATIVE" ] && [ -f "$REPO_DIR/tools/parity.config.json" ]; then
    NATIVE=$(python3 -c "import json;print(json.load(open('$REPO_DIR/tools/parity.config.json')).get('native_dir',''))" 2>/dev/null || true)
fi
if [ -z "$NATIVE" ]; then
    NATIVE="$REPO_DIR/../polyworld"
fi
if [ ! -f "$NATIVE/lib/libpolyworld.dylib" ]; then
    echo "record_synapses_vectors: '$NATIVE/lib/libpolyworld.dylib' is missing; build the native tree first" >&2
    exit 2
fi

WORK=${TMPDIR:-/tmp}/brainprobe.synapses.$$
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

CXX=${CXX:-/usr/bin/clang++}
SDK=$(xcrun --show-sdk-path)
GSL_PREFIX=/opt/homebrew/opt/gsl

"$CXX" -std=c++17 -O2 -g -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$SDK/System/Library/Frameworks/OpenGL.framework/Headers" \
    -I"$GSL_PREFIX/include" \
    -I/opt/homebrew/include \
    "$HERE/brainprobe.cc" \
    -L"$NATIVE/lib" -lpolyworld -Wl,-rpath,"$NATIVE/lib" \
    -L"$GSL_PREFIX/lib" -lgsl -lgslcblas -Wl,-rpath,"$GSL_PREFIX/lib" \
    -framework OpenGL \
    -o "$WORK/brainprobe"

"$WORK/brainprobe" synapses "$WORK"

for tag in synrandom synexact; do
    for name in "spec.$tag.txt" "syndump.$tag.txt" "synapses.$tag.txt"; do
        if cmp -s "$WORK/$name" "$HERE/vectors/$name"; then
            echo "vectors/$name unchanged"
        else
            echo "vectors/$name CHANGED (a change to the oracle — see this script's PORT-NOTE)"
            diff -u "$HERE/vectors/$name" "$WORK/$name" | head -20 || true
            cp "$WORK/$name" "$HERE/vectors/$name"
        fi
    done
done
