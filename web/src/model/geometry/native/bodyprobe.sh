#!/usr/bin/env bash
# Lane L15/W1e — build the agent-body-mesh probe and regenerate this lane's body goldens.
#
#   src/model/geometry/native/bodyprobe.sh mesh     # mesh only (no scenario needed)
#   src/model/geometry/native/bodyprobe.sh all      # mesh + both recorded scenarios -> --ts
#   src/model/geometry/native/bodyprobe.sh all --ts # also (re)write golden/nativeBodyMesh.ts
#   src/model/geometry/native/bodyprobe.sh build    # compile only
#
# PORT-NOTE(W1e/body-probe-is-oracle-tooling): the native tree is the oracle and is
# READ-ONLY — this script includes its headers, links its already-built libpolyworld.dylib,
# and runs with cwd = the native tree (so `./etc/worldfile.wfs` and `./etc/objects/agent.obj`
# resolve exactly as they do for the oracle binary). It writes nothing inside the native
# tree, never touches `oracle/**`, and the compiled probe lives in a scratch directory: the
# *goldens* under `golden/` are what is committed, so `npm test` needs no C++ and no native
# tree.
#
# Environment: POLYWORLD_NATIVE (native tree), POLYWORLD_WEB (repo root),
# POLYWORLD_ORACLE_ROOT (where the recorded scenarios live), CXX, BUILD_DIR.
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "$HERE/../../../.." && pwd)"
NATIVE="${POLYWORLD_NATIVE:-$(cd "$WEB_ROOT/.." && pwd)/polyworld}"
ORACLE="${POLYWORLD_ORACLE_ROOT:-$WEB_ROOT/oracle}"
BUILD="${BUILD_DIR:-${TMPDIR:-/tmp}/bodyprobe.$$}"
CXX="${CXX:-/usr/bin/clang++}"
DEST="$WEB_ROOT/src/model/geometry/golden/nativeBodyMesh.ts"
SCENARIOS="${BODYPROBE_SCENARIOS:-microtest_voff minitest_voff}"

die() { printf 'bodyprobe: %s\n' "$*" >&2; exit 2; }

[ -d "$NATIVE" ] || die "no native tree at $NATIVE (set POLYWORLD_NATIVE)"
[ -f "$NATIVE/lib/libpolyworld.dylib" ] || die "no $NATIVE/lib/libpolyworld.dylib — build the native tree first"
[ -f "$NATIVE/etc/objects/agent.obj" ] || die "no $NATIVE/etc/objects/agent.obj"
[ -d "$NATIVE/etc" ] || die "no $NATIVE/etc — the probe needs etc/worldfile.wfs relative to its cwd"

SDK_INC="$(xcrun --show-sdk-path)/System/Library/Frameworks/OpenGL.framework/Headers"

build() {
  mkdir -p "$BUILD"
  printf 'bodyprobe: compiling against %s\n' "$NATIVE" >&2
  "$CXX" -std=c++17 -g -O2 -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$NATIVE/src/library/graphics" \
    -I"$SDK_INC" \
    -I/opt/homebrew/include \
    "$HERE/bodyprobe.cpp" -o "$BUILD/bodyprobe" \
    -L"$NATIVE/lib" -lpolyworld -Wl,-rpath,"$NATIVE/lib" \
    -Wl,-rpath,/opt/homebrew/opt/gsl/lib \
    -Wl,-rpath,/opt/homebrew/opt/libomp/lib \
    || die "compile/link failed"
}

# cwd is the native tree; the arguments are absolute paths into this repo.
run_in_native() { ( cd "$NATIVE" && "$BUILD/bodyprobe" "$@" ); }

# The scenario's worldfile and `--Key value` arguments, from the harness' own registry (the
# base registry plus this repo's lane overlays), so the probe's config is the config the
# recorded goldens were produced with — no second copy of the scenario definition.
scenario_parts() {
  python3 - "$WEB_ROOT" "$1" <<'PY' || exit 2
import json, sys
web, scenario = sys.argv[1], sys.argv[2]
paths = [web + "/oracle/scenarios/scenarios.json"]
overlay = web + "/tools/scenarios.d/" + scenario + ".json"
try:
    json.load(open(overlay))
    paths.append(overlay)
except OSError:
    pass
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
}

mesh_raw() {
  run_in_native mesh "$BUILD/mesh.txt" || die "mesh mode failed"
  printf 'bodyprobe: mesh goldens\n' >&2
  cat "$BUILD/mesh.txt" >&2
}

body_raw() {
  local scenario="$1"
  local run_dir="$ORACLE/$scenario/run"
  [ -d "$run_dir/genome/agents" ] || die "no recorded genomes at $run_dir/genome/agents (scenario $scenario)"

  local parts wf params
  parts="$(scenario_parts "$scenario")" || die "could not resolve scenario '$scenario'"
  wf="$(printf '%s\n' "$parts" | head -1)"
  params=()
  while IFS= read -r line; do
    [ -n "$line" ] && params+=("$line")
  done < <(printf '%s\n' "$parts" | tail -n +2)

  [ -f "$NATIVE/$wf" ] || die "no worldfile $NATIVE/$wf (scenario $scenario)"

  # The worldfile and the `--Key value` arguments come from the harness' registry, and the
  # genomes come from the recorded golden: the probe's inputs are the scenario's own.
  run_in_native body "$BUILD/body.$scenario.txt" "$run_dir" "$wf" ${params[@]+"${params[@]}"} \
    || die "body mode failed for $scenario"
  printf 'bodyprobe: %s: %s vectors\n' "$scenario" "$(grep -c '^body ' "$BUILD/body.$scenario.txt")" >&2
}

TS=0
MODE=""
for arg in "$@"; do
  case "$arg" in
    --ts) TS=1 ;;
    -*) die "unknown option '$arg'" ;;
    *) if [ -z "$MODE" ]; then MODE="$arg"; else die "unexpected argument '$arg'"; fi ;;
  esac
done

case "$MODE" in
  build) build ;;
  mesh)
    build
    mesh_raw
    ;;
  all)
    build
    mesh_raw
    for scenario in $SCENARIOS; do body_raw "$scenario"; done
    ;;
  *) die "unknown mode '${MODE:-}' (build|mesh|all [--ts])" ;;
esac

if [ "$TS" = "1" ]; then
  python3 "$HERE/make_body_mesh_module.py" "$BUILD" "$NATIVE/etc/objects/agent.obj" "$DEST" "$SCENARIOS" \
    || die "golden module generation failed"
  printf 'wrote %s\n' "$DEST" >&2
fi

if [ "$TS" = "1" ] || [ "$MODE" = "all" ]; then
  rm -rf "$BUILD"
fi
