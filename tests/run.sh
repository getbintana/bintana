#!/usr/bin/env bash
# Runs the Bintana test projects.
#
#   ./tests/run.sh                all of them
#   ./tests/run.sh widgets        only that project
#   ./tests/run.sh ide menus      only that one, stopping after its `menus` phase
#   ./tests/run.sh ide list       what phases it has
#
# `BINTANA=<path>` runs a build other than ./build/bintana; `HEADLESS=1` forces the
# virtual display even when there is a real one, and `TIMEOUT=<seconds>` moves
# the hang guard.
#
# **The suite itself is `tests/runner`, written in Bintana**, and this is the
# ten lines that cannot be: finding the binary and saying so when there is none
# is the one job that has to work when the runtime does not. Everything past
# that -- the display, the guard, which projects, what to filter -- is
# tests/runner/Main.js, in the language being tested.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

# exec, so the runner's exit status is this script's, and the chosen binary is
# the one the runner reports as its own (Application.Executable): there is no path to
# pass down and nothing that can disagree about which build ran.
exec "$BINTANA" tests/runner "$@"
