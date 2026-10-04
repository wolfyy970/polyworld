#!/usr/bin/env bash
# Lane L14 — build the native reference probe and regenerate this lane's differential vectors.
#
#   ./monitorprobe.sh all          rebuild + regenerate every vector file (default)
#   ./monitorprobe.sh camera       just one mode (camera|moviesettings|monitorconfig|enums)
#   ./monitorprobe.sh build        compile only
#
# The native tree is located through $POLYWORLD_NATIVE (default: <repo>/../polyworld), the same
# variable oracle/run_parity.sh uses.  The probe links libpolyworld.dylib — i.e. the code the
# recorded goldens came from — and *reads* the native tree; it never writes into it.
#
# PORT-NOTE(L14/native-probe): the vectors under vectors/ are committed, so `npm test` does not
# need the native tree (CI, the browser lane, and a reviewer without C++ all replay the same
# numbers).  Re-run this script only when the *inputs* change, and treat a diff in vectors/ as a
# change to the oracle: it means the native build changed, not the port.
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "$HERE/../../../.." && pwd)"
NATIVE="${POLYWORLD_NATIVE:-$(cd "$WEB_ROOT/.." && pwd)/polyworld}"
VECTORS="$HERE/vectors"
BUILD="${BUILD_DIR:-$HERE/.probe-build}"
CXX="${CXX:-/usr/bin/clang++}"

# PORT-NOTE(L14/native-probe/build-dir): `.probe-build/` (the compiled probe and its dSYM) is a
# transient artifact — regenerate it with `./monitorprobe.sh build`. It is deliberately *not*
# committed: only `monitorprobe.{cpp,sh}` and `vectors/*.json` belong in the tree, so a reviewer
# can replay the vectors without a compiler. Remove it with `rm -rf .probe-build` when done.

CAMERA_CASES="${CAMERA_CASES:-24}"

die() { printf 'monitorprobe: %s\n' "$*" >&2; exit 2; }

[ -d "$NATIVE" ] || die "no native tree at $NATIVE (set POLYWORLD_NATIVE)"
[ -f "$NATIVE/lib/libpolyworld.dylib" ] || die "no $NATIVE/lib/libpolyworld.dylib — build the native tree first"
[ -d "$NATIVE/etc" ] || die "no $NATIVE/etc — the probe needs etc/monitors.mfs relative to its cwd"

SDK_PATH="$(xcrun --show-sdk-path)"
SDK_INC="$SDK_PATH/System/Library/Frameworks/OpenGL.framework/Headers"

build() {
  mkdir -p "$BUILD"
  printf 'monitorprobe: compiling against %s\n' "$NATIVE"
  "$CXX" -std=c++17 -g -O2 -DGL_SILENCE_DEPRECATION \
    -I"$NATIVE/src/library" \
    -I"$SDK_INC" \
    -I/opt/homebrew/include \
    "$HERE/monitorprobe.cpp" -o "$BUILD/monitorprobe" \
    -L"$NATIVE/lib" -lpolyworld -Wl,-rpath,"$NATIVE/lib" \
    || die "compile/link failed"
}

# cwd is the native tree: the monitor documents are read through the same relative paths the
# native MonitorManager uses ("./etc/monitors.mfs" is the schema; the document is the --ui file).
run_in_native() {
  ( cd "$NATIVE" && "$BUILD/monitorprobe" "$@" )
}

mode_camera() {
  mkdir -p "$VECTORS"
  run_in_native camera "$VECTORS/camera.json" "$CAMERA_CASES" || die "camera mode failed"
  printf 'monitorprobe: wrote %s\n' "$VECTORS/camera.json"
}

mode_moviesettings() {
  mkdir -p "$VECTORS"
  run_in_native moviesettings "$VECTORS/moviesettings.json" || die "moviesettings mode failed"
  printf 'monitorprobe: wrote %s\n' "$VECTORS/moviesettings.json"
}

mode_monitorconfig() {
  mkdir -p "$VECTORS"
  run_in_native monitorconfig "$VECTORS/monitorConfig.term.json" "./etc/term.mf" \
    || die "monitorconfig term mode failed"
  run_in_native monitorconfig "$VECTORS/monitorConfig.gui.json" "./etc/gui.mf" \
    || die "monitorconfig gui mode failed"
  printf 'monitorprobe: wrote %s and %s\n' \
    "$VECTORS/monitorConfig.term.json" "$VECTORS/monitorConfig.gui.json"
}

mode_enums() {
  mkdir -p "$VECTORS"
  run_in_native enums "$VECTORS/enums.json" || die "enums mode failed"
  printf 'monitorprobe: wrote %s\n' "$VECTORS/enums.json"
}

mode="$1"
case "$mode" in
  build) build ;;
  camera|moviesettings|monitorconfig|enums)
    build
    "mode_$mode"
    ;;
  all|"")
    build
    mode_camera
    mode_moviesettings
    mode_monitorconfig
    mode_enums
    ;;
  *) die "unknown mode '$mode' (build|camera|moviesettings|monitorconfig|enums|all)" ;;
esac
