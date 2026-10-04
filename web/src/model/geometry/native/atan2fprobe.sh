#!/usr/bin/env bash
# Lane W1e — build and run the `atan2f` census, then check the port against it.
#
#   src/model/geometry/native/atan2fprobe.sh identity        # the two symbols + the +-pi arm
#   src/model/geometry/native/atan2fprobe.sh census          # (re)build the committed corpus
#   src/model/geometry/native/atan2fprobe.sh wide 400000     # a big sweep into $TMPDIR (not committed)
#   src/model/geometry/native/atan2fprobe.sh compare         # npx tsx tools/measure_atan2f.ts
#   src/model/geometry/native/atan2fprobe.sh all             # census + compare
#
# PORT-NOTE(W1e/atan2f-census): unlike this lane's other probes (`glprobe.sh`, `bodyprobe.sh`)
# this one needs **no native tree and no libpolyworld**: `atan2f` is the platform's libm, and the
# native code's only contribution to the question is the argument *types* at
# `src/library/graphics/gmisc.cc:335` (`float ang = atan2(x0 - p[0], z0 - p[2]);` — float
# arguments, so the C++ overload resolution picks `atan2f`). The probe therefore dlsyms the
# shipped `atan2f`/`atan2` out of this machine's libSystem and runs one native process per
# invocation, exactly as the lane's other censuses do. It writes nothing inside the native tree
# and never touches `oracle/**`; the *corpus* and the *native output* under `raw/` are what is
# committed, so `npm test` needs no C compiler.
#
# Environment: CC (default cc), PROBE_OPT (default -O2), TMPDIR.
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "$HERE/../../../.." && pwd)"
RAW="$HERE/raw"
CC="${CC:-/usr/bin/cc}"
OPT="${PROBE_OPT:--O2}"
BUILD="${BUILD_DIR:-${TMPDIR:-/tmp}/atan2fprobe.$$}"

die() { printf 'atan2fprobe: %s\n' "$*" >&2; exit 2; }

build() {
  mkdir -p "$BUILD"
  "$CC" $OPT -std=c11 -Wall -Wextra -Wno-unused-result \
    "$HERE/atan2fprobe.c" -o "$BUILD/atan2fprobe" -lm || die "compile failed"
  printf 'atan2fprobe: built %s (%s %s)\n' "$BUILD/atan2fprobe" "$CC" "$OPT" >&2
}

identity() {
  build
  "$BUILD/atan2fprobe" --identity
}

# One native process for the whole corpus: the run is a single invocation, so a probe crash
# cannot be mistaken for a per-row disagreement.
census() {
  [ -f "$RAW/atan2f_args.txt" ] || die "no $RAW/atan2f_args.txt (run gen_atan2f_corpus.py)"
  build
  "$BUILD/atan2fprobe" < "$RAW/atan2f_args.txt" > "$BUILD/atan2f_native.txt" \
    || die "probe run failed"
  local rows
  rows="$(grep -c '^atan2f ' "$BUILD/atan2f_native.txt")"
  [ "$rows" -gt 0 ] || die "probe produced no rows"
  mv "$BUILD/atan2f_native.txt" "$RAW/atan2f_native.txt"
  printf 'atan2fprobe: wrote %s (%s rows)\n' "$RAW/atan2f_native.txt" "$rows" >&2
  "$BUILD/atan2fprobe" --identity >&2
}

wide() {
  local n="${1:-400000}"
  local args="${2:-${TMPDIR:-/tmp}/atan2f_wide_args.txt}"
  python3 "$RAW/gen_atan2f_corpus.py" --wide "$n" "$args" >&2 || die "corpus generation failed"
  build
  # one native process for the whole sweep
  "$BUILD/atan2fprobe" < "$args" > "${args%.txt}_native.txt" || die "wide probe run failed"
  printf 'atan2fprobe: wide native output %s\n' "${args%.txt}_native.txt" >&2
}

compare() {
  ( cd "$WEB_ROOT" && npx tsx tools/measure_atan2f.ts "$@" )
}

MODE="${1:-all}"
shift || true
case "$MODE" in
  build) build ;;
  identity) identity ;;
  census) census ;;
  wide) wide "${1:-400000}" "${2:-${TMPDIR:-/tmp}/atan2f_wide_args.txt}" ;;
  compare) compare "$@" ;;
  all)
    census
    compare "$@"
    ;;
  *) die "unknown mode '$MODE' (build|identity|census|wide|compare|all)" ;;
esac

if [ "$MODE" != "build" ]; then
  rm -rf "$BUILD"
fi
