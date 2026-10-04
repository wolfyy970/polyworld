#!/usr/bin/env bash
# Build and run the W1e golden generator (src/model/geometry/native/glprobe.cpp).
#
#   src/model/geometry/native/glprobe.sh            # build, run, print the raw goldens
#   src/model/geometry/native/glprobe.sh --ts <out> # also write the TypeScript module
#
# The native tree is the oracle and is READ-ONLY: this script includes its headers and
# links its already-built libpolyworld.dylib. It never writes inside it, never touches
# oracle/**, and takes no dependency the port itself depends on (it is a probe, not part
# of the shipped model).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(cd "$here/../../../.." && pwd)"
native="${POLYWORLD_NATIVE:-$(cd "$web_root/../polyworld" && pwd)}"

if [ ! -f "$native/lib/libpolyworld.dylib" ]; then
  echo "glprobe: no native build at $native (set POLYWORLD_NATIVE)" >&2
  exit 2
fi

sdk="$(xcrun --show-sdk-path)"
out="${TMPDIR:-/tmp}/glprobe.$$"
mkdir -p "$out"

clang++ -std=c++17 -O1 -DGL_SILENCE_DEPRECATION \
  -I"$sdk/System/Library/Frameworks/OpenGL.framework/Headers" \
  -I"$native/src/library" \
  -I"$native/src/library/graphics" \
  "$here/glprobe.cpp" \
  -L"$native/lib" -lpolyworld \
  -framework OpenGL \
  -Wl,-rpath,"$native/lib" \
  -Wl,-rpath,/opt/homebrew/opt/gsl/lib \
  -Wl,-rpath,/opt/homebrew/opt/libomp/lib \
  -o "$out/glprobe"

"$out/glprobe" > "$out/goldens.txt"
cat "$out/goldens.txt"

if [ "${1:-}" = "--ts" ]; then
  dest="${2:-$web_root/src/model/geometry/golden/nativeCameraVectors.ts}"
  python3 "$here/make_golden_module.py" "$out/goldens.txt" "$dest"
  echo "wrote $dest" >&2
fi
rm -rf "$out"
