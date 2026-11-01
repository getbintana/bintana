#!/usr/bin/env bash
# Mutation fuzzing for the `.form` loader.
#
#   tests/formfuzz.sh                 40 cases with ./build/bintana
#   CASES=200 tests/formfuzz.sh       more
#   BINTANA=build-asan/bintana tests/formfuzz.sh
#
# Each case is a whole project run as a child, because the loader runs at
# startup; a crash is a child that dies without a `Bintana error:` sentence.
# The cases are deterministic (`tests/formfuzz/Main.js`): a failure prints the
# case number, and running that many cases again reproduces it.
#
# **Under AddressSanitizer the child is sanitized too**, and a report goes to
# the log below rather than to the terminal (`abort_on_error=0` lets the child
# finish). The grep at the end turns one into a failure of this run, the same
# bargain `tests/asan.sh` makes.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

CASES=${CASES:-40}
LOG=/tmp/bta-formfuzz-asan
own=

if [[ -z ${ASAN_OPTIONS-} ]]; then
    export ASAN_OPTIONS="detect_leaks=1:log_path=$LOG:abort_on_error=0"
    export LSAN_OPTIONS="suppressions=$PWD/tests/lsan.supp"
    rm -f "$LOG".*
    own=1
fi

"$BINTANA" tests/formfuzz "$CASES"
status=$?

if [[ -n $own ]]; then
    found=$(grep -hE "ERROR: (AddressSanitizer|LeakSanitizer)" "$LOG".* 2>/dev/null)
    if [[ -n $found ]]; then
        echo "$found"
        echo "(full reports in $LOG.*)"
        status=1
    fi
fi

exit $status
