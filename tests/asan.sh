#!/usr/bin/env bash
# Runs the suite under AddressSanitizer.
#
# Two questions it answers that the ordinary run cannot: whether anything reads
# memory it no longer owns -- the family of bug that bit `Notebook.Append` and
# the teardown sweep -- and whether we leak. GTK, fontconfig and the GL stack
# leak plenty of their own; tests/lsan.supp is what keeps those out of the way so
# what remains is ours.
#
#   tests/asan.sh              build if needed, run the test projects
#   BUILD=other tests/asan.sh  use another build directory
#
# Reports go to files rather than the terminal on purpose: the child project the
# IDE test runs writes to a pty the test then reads, and a leak summary in there
# looks exactly like the child misbehaving.
set -uo pipefail

cd "$(dirname "$0")/.."
BUILD=${BUILD:-build-asan}
LOG=/tmp/bta-asan.log

# Configure once, but build every time: a stale sanitizer binary reports on code
# that is no longer there, which reads as a failing test and is not one.
if [[ ! -f $BUILD/CMakeCache.txt ]]; then
    # clang and not gcc by default: Fedora ships compiler-rt but not libasan.
    cmake -S . -B "$BUILD" -DCMAKE_BUILD_TYPE=Debug -DCMAKE_C_COMPILER="${CC:-clang}" \
          -DCMAKE_C_FLAGS="-fsanitize=address -fno-omit-frame-pointer -g" \
          -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address" >/dev/null || exit 2
fi
echo "== building $BUILD"
cmake --build "$BUILD" -j"$(nproc)" >/dev/null || exit 2

rm -f "$LOG".*
export ASAN_OPTIONS="detect_leaks=1:log_path=$LOG:abort_on_error=0"
export LSAN_OPTIONS="suppressions=$PWD/tests/lsan.supp"

# **Virtual display, always**, which `run.sh` does too now -- this script got
# there first. A sanitizer run is dozens of windows over whatever the user is
# doing, taking the focus and a stray click with it, which is the other half of
# why it is wrong: an input meant for something else lands in a test that is
# measuring. Nobody watches this run, so there is nothing to lose by not showing
# it. `HEADLESS= tests/asan.sh` -- empty, not 0 -- is the way back to the real
# screen for the one case that needs a real icon theme: the runner tests the
# variable for being *non-empty*, so 0 forces the virtual display just as 1 does.
#
# `-` and not `:-`, which is a real fix and not a tidy-up: with `:-` an
# explicitly empty HEADLESS was replaced by 1 right here, so the way back this
# comment offers did not work.
export HEADLESS=${HEADLESS-1}

# A sanitized binary is about twice as slow, and run.sh's hang guard is set for an
# ordinary one: the guard fired and reported a hang that was not one -- which is
# exactly the false failure this whole script exists to avoid producing. The
# ordinary guard is 600 now (tests/ide measures 4m45 unsanitized, and tripped a
# guard of 300), so this one stays at 900 -- which is still only about twice the
# sanitized time and is the next one to grow into.
export TIMEOUT=${TIMEOUT:-900}

BINTANA="$BUILD/bintana" ./tests/run.sh
status=$?

echo "== sanitizer"
found=$(grep -hE "ERROR: (AddressSanitizer|LeakSanitizer)" "$LOG".* 2>/dev/null)
if [[ -n $found ]]; then
    echo "$found"
    echo "(full reports in $LOG.*)"
    status=1
else
    echo "no errors and no leaks of our own"
fi

exit $status
