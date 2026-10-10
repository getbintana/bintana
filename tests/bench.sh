#!/usr/bin/env bash
# How fast the interpreter is: Gambas's eight benchmark programs, timed.
#
#   tests/bench.sh                    every program, best of three
#   tests/bench.sh nbody primes       those two
#   tests/bench.sh --runs 5           best of five
#   BINTANA=/other/bintana tests/bench.sh   another build, to compare
#
# The tool is `tests/bench`, a Bintana console project -- no display. This is
# the part that has to work when the runtime does not: find the binary, and
# say so when there is none. **Measure an optimised build**: `build/` is Debug
# unless it was configured otherwise, and -O0 is two to four times slower.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/bench "$@"
