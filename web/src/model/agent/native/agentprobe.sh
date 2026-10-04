#!/usr/bin/env bash
# Lane L8 — build the native reference probe and regenerate this lane's differential vectors.
#
#   ./agentprobe.sh all            rebuild + regenerate every vector file (default)
#   ./agentprobe.sh collision      just one mode (collision|energy|lifespan|config)
#   ./agentprobe.sh build          compile only
#
# The native tree is located through $POLYWORLD_NATIVE (default: <repo>/../polyworld), the
# same variable oracle/run_parity.sh uses.  The probe links libpolyworld.dylib — i.e. the
# code the recorded goldens came from — and *reads* the native tree; it never writes to it
# (its two temp documents are created and removed in the working directory).
#
# PORT-NOTE(L8/native-probe): the vectors under vectors/ are committed, so `npm test` does
# not need the native tree (CI, the browser lane, and a reviewer without C++ all replay the
# same numbers).  Re-run this script only when the *inputs* change, and treat a diff in
# vectors/ as a change to the oracle: it means the native build changed, not the port.
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "$HERE/../../../.." && pwd)"
NATIVE="${POLYWORLD_NATIVE:-$(cd "$WEB_ROOT/.." && pwd)/polyworld}"
VECTORS="$HERE/vectors"
# The probe binary is a build artifact, not a deliverable: the *vectors* under vectors/ are
# committed (so `npm test` needs no C++), and every sibling lane's probe builds into a
# scratch directory for the same reason (W1e/W1j: `${TMPDIR}/<name>.$$`).
BUILD="${BUILD_DIR:-${TMPDIR:-/tmp}/agentprobe.$$}"
CXX="${CXX:-/usr/bin/clang++}"

COLLISION_CASES="${COLLISION_CASES:-3000}"
ENERGY_CASES="${ENERGY_CASES:-600}"

die() { printf 'agentprobe: %s\n' "$*" >&2; exit 2; }

[ -d "$NATIVE" ] || die "no native tree at $NATIVE (set POLYWORLD_NATIVE)"
[ -f "$NATIVE/lib/libpolyworld.dylib" ] || die "no $NATIVE/lib/libpolyworld.dylib — build the native tree first"
[ -d "$NATIVE/etc" ] || die "no $NATIVE/etc — the probe needs etc/worldfile.wfs relative to its cwd"

SDK_INC="$($CXX --print-resource-dir 2>/dev/null >/dev/null; xcrun --show-sdk-path)/System/Library/Frameworks/OpenGL.framework/Headers"

build() {
  mkdir -p "$BUILD"
  printf 'agentprobe: compiling against %s\n' "$NATIVE"
  "$CXX" -std=c++17 -g -O2 -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$SDK_INC" \
    -I/opt/homebrew/include \
    "$HERE/agentprobe.cpp" -o "$BUILD/agentprobe" \
    -L"$NATIVE/lib" -lpolyworld -Wl,-rpath,"$NATIVE/lib" \
    || die "compile/link failed"
}

run_in_native() {
  # cwd is the native tree: buildDocument()./etc/worldfile.wfs is resolved relative to it,
  # and the probe's temp documents are created and removed there (the tree is untouched
  # otherwise — no run/ directory is read or written).
  ( cd "$NATIVE" && "$BUILD/agentprobe" "$@" )
}

mode_collision() {
  mkdir -p "$VECTORS"
  run_in_native collision "$VECTORS/collision.json" "$COLLISION_CASES" || die "collision mode failed"
  printf 'agentprobe: wrote %s\n' "$VECTORS/collision.json"
}

mode_energy() {
  mkdir -p "$VECTORS"
  run_in_native energy "$VECTORS/energy.json" "$ENERGY_CASES" || die "energy mode failed"
  printf 'agentprobe: wrote %s\n' "$VECTORS/energy.json"
}

mode_lifespan() {
  mkdir -p "$VECTORS"
  run_in_native lifespan "$VECTORS/lifespan.json" || die "lifespan mode failed"
  printf 'agentprobe: wrote %s\n' "$VECTORS/lifespan.json"
}

mode_config() {
  # The worldfile and its `--Key value` arguments come from the harness' own registry (the
  # base registry plus this repo's lane overlays), so the probe's config is the config the
  # recorded goldens were produced with -- no second copy of the scenario definition.
  local scenario="${CONFIG_SCENARIO:-minitest_voff}"
  local parts
  parts="$(python3 - "$WEB_ROOT" "$scenario" <<'PY' || exit 2
import json, sys
web, scenario = sys.argv[1], sys.argv[2]
paths = [web + "/oracle/scenarios/scenarios.json"]
overlay = web + "/tools/scenarios.d/" + scenario + ".json"
try:
    paths.append(overlay)
    json.load(open(overlay))
except OSError:
    paths.pop()
spec = None
for path in paths:
    doc = json.load(open(path))
    entries = doc if isinstance(doc, list) else doc.get("scenarios", [])
    for entry in entries:
        if isinstance(entry, dict) and entry.get("name") == scenario:
            spec = entry
if spec is None:
    raise SystemExit("scenario '%s' is not registered" % scenario)
args = spec.get("args", [])
print(spec["worldfile"])
for i in range(0, len(args) - 1, 2):
    if args[i].startswith("--"):
        print("%s=%s" % (args[i][2:], args[i + 1]))
PY
)"
  [ -n "$parts" ] || die "could not resolve scenario '$scenario' from the registry"

  local wf params
  wf="$(printf '%s\n' "$parts" | head -1)"
  params=()
  while IFS= read -r line; do
    [ -n "$line" ] && params+=("$line")
  done < <(printf '%s\n' "$parts" | tail -n +2)

  [ -f "$NATIVE/$wf" ] || die "no worldfile $NATIVE/$wf (scenario $scenario)"
  mkdir -p "$VECTORS"
  run_in_native config "$VECTORS/config.$scenario.json" "$wf" ${params[@]+"${params[@]}"} \
    || die "config mode failed"
  printf 'agentprobe: wrote %s (worldfile %s, params: %s)\n' \
    "$VECTORS/config.$scenario.json" "$wf" "${params[*]:-none}"
}

mode="$1"
case "$mode" in
  build) build ;;
  collision|energy|lifespan|config)
    build
    "mode_$mode"
    ;;
  all|"")
    build
    mode_collision
    mode_energy
    mode_lifespan
    mode_config
    ;;
  *) die "unknown mode '$mode' (build|collision|energy|lifespan|config|all)" ;;
esac
