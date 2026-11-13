#!/usr/bin/env bash
# Runs the Bintana test projects.
#
#   ./tests/run.sh                all of them
#   ./tests/run.sh widgets        only that project
#   ./tests/run.sh ide menus      only that one, stopping after its `menus` phase
#   ./tests/run.sh ide list       what phases it has
#
# `BINTANA=<path>` runs a build other than ./build/bintana and `TIMEOUT=<seconds>`
# moves the hang guard.  `BINTANA_PROFILE=<dir>` profiles every project the run
# starts, one `<project>.syscap` under that directory (the runner reads it and
# turns it into `--profile` on each child, since it builds their command lines).
#
# **The virtual display is the default on Linux**, and `HEADLESS=` -- empty,
# not 0 -- is the way back to a real screen for the questions that need one (an
# icon, a theme). It used to be the other way round: the runner falls back to
# `xvfb-run` only when there is no `DISPLAY`, which is the CI case and never the
# desktop case, so the bare command opened the whole suite over whatever the
# user was doing and took the keyboard for a minute. That happened five times,
# always by somebody who knew the rule, which is what makes it a default and not
# a rule. `asan.sh` had reached the same conclusion first.
#
# **Windows has no Xvfb.** Its only display is the session's own, so the default
# there is the desktop and `HEADLESS=1` cannot be honored; that is said once,
# below, rather than left to the runner's "install Xvfb" sentence.
#
# **The suite itself is `tests/runner`, written in Bintana**, and this is the
# ten lines that cannot be: finding the binary and saying so when there is none
# is the one job that has to work when the runtime does not. Everything past
# that -- the display, the guard, which projects, what to filter -- is
# tests/runner/Main.js, in the language being tested.
set -uo pipefail
cd "$(dirname "$0")/.."

# Exported and not passed, because the runner reads it out of the environment --
# and with `-` rather than `:-`, or an explicitly empty one would be replaced
# here and the way back to a real screen would not work. On Windows there is no
# virtual display to force: the session's own is the only one.
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) export HEADLESS=${HEADLESS-} ;;
    *)                    export HEADLESS=${HEADLESS-1} ;;
esac

# **The suite's assertions are English, and a library may ship a catalogue.**
# `lib/check` now does, and a developer whose desktop is Spanish saw its
# accessibility sentences translated while the test still expected the English
# ones. A test that is about translation sets `LANGUAGE` itself, in the child it
# starts or in the project it writes; the suite as a whole must not inherit the
# machine's answer.
export LANGUAGE=C

# **The libraries under test are this tree's, not the ones installed for the
# user.** `~/.local/share/bintana/lib` is searched before the copy beside the
# binary, so a machine with an older install ran every suite against *those*
# libraries -- a change to `lib/report` was tested with the installed
# Report.js, and passed. `BINTANA_LIB_PATH` comes before both; a test that
# sets its own still replaces it.
export BINTANA_LIB_PATH="$PWD/lib${BINTANA_LIB_PATH:+:$BINTANA_LIB_PATH}"

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

# exec, so the runner's exit status is this script's, and the chosen binary is
# the one the runner reports as its own (Application.Executable): there is no path to
# pass down and nothing that can disagree about which build ran.
exec "$BINTANA" tests/runner "$@"
