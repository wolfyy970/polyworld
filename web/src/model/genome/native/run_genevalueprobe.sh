#!/usr/bin/env bash
# Build and run the L5 gene-value probe (src/model/genome/native/genevalueprobe.cc).
#
#   src/model/genome/native/run_genevalueprobe.sh                  # build, run, print the rows
#   src/model/genome/native/run_genevalueprobe.sh --out <file>     # also save the raw rows
#
# The probe measures the native union read `*(T *)( &(gene->smin.__val) )` — the
# read a `$[gene, NAME, min|max]` cpp symbol becomes (see the probe's header).
#
# The native tree is the oracle and is READ-ONLY: this script includes its headers
# and links its already-built libpolyworld.dylib. It never writes inside it, never
# touches oracle/**, and takes no dependency the port itself depends on (it is a
# probe, not part of the shipped model).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(cd "$here/../../../.." && pwd)"
native="${POLYWORLD_NATIVE:-$(cd "$web_root/../polyworld" && pwd)}"

if [ ! -f "$native/lib/libpolyworld.dylib" ]; then
  echo "genevalueprobe: no native build at $native (set POLYWORLD_NATIVE)" >&2
  exit 2
fi

out_arg=""
if [ "${1:-}" = "--out" ]; then
  out_arg="${2:?--out needs a file}"
fi

out="${TMPDIR:-/tmp}/genevalueprobe.$$"
mkdir -p "$out"

clang++ -std=c++17 -O1 \
  -I"$native/src/library" \
  "$here/genevalueprobe.cc" \
  -L"$native/lib" -lpolyworld \
  -Wl,-rpath,"$native/lib" \
  -Wl,-rpath,/opt/homebrew/opt/gsl/lib \
  -Wl,-rpath,/opt/homebrew/opt/libomp/lib \
  -o "$out/genevalueprobe"

"$out/genevalueprobe" > "$out/rows.txt"
cat "$out/rows.txt"

if [ -n "$out_arg" ]; then
  cp "$out/rows.txt" "$out_arg"
  echo "wrote $out_arg" >&2
fi

rm -rf "$out"
