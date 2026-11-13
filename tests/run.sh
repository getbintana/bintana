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
# **Windows has no Xvfb, and its answer is a desktop**: the helper built below
# creates a private one and runs the suite on it, so the default there is a
# virtual screen too.  `HEADLESS=` (empty) is the way back to the real one,
# exactly as on Linux; it is the only way to see an icon or a theme.
#
# **The suite itself is `tests/runner`, written in Bintana**, and this is the
# ten lines that cannot be: finding the binary and saying so when there is none
# is the one job that has to work when the runtime does not. Everything past
# that -- the display, the guard, which projects, what to filter -- is
# tests/runner/Main.js, in the language being tested.
set -uo pipefail
cd "$(dirname "$0")/.."

# Exported and not passed, because the runner reads it out of the environment --
# and with `+x` rather than `:-`, or an explicitly empty one would be replaced
# here and the way back to a real screen would not work.  Unset means the
# private screen on both platforms; `HEADLESS=` means this one.
if [[ -z ${HEADLESS+x} ]]; then
    export HEADLESS=1
fi

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
# On Windows the build is `bintana.exe`; the bare name is what the docs tell a
# person to run, so the default finds the executable beside it.
if [[ ! -x $BINTANA && -x $BINTANA.exe ]]; then
    BINTANA=$BINTANA.exe
fi
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

# **Windows gets a desktop of its own.** The helper is a test tool built here,
# beside the binary, from `tests/win-desktop.c`; it creates a desktop, starts
# the runner on it and waits.  The runner then sees an ordinary session and
# takes its normal path -- the private desktop is already the one the child
# owns.  A machine without a compiler falls back to this screen with a
# sentence, because a suite that refuses to start is worse than a visible one.
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        # GTK 4's Win32 IME filter crashes when a window message reaches a
        # context that was already destroyed -- a SIGSEGV in libgtk-4-1.dll
        # measured with gdb, minutes into tests/widgets.  The suite types no
        # IME text on Windows, so it runs without one; this is a GTK bug and
        # not a runtime setting.  `GTK_IM_MODULE=` (empty) opts back in.
        export GTK_IM_MODULE=${GTK_IM_MODULE-none}
        if [[ -n ${HEADLESS:-} ]]; then
            helper=build/win-desktop.exe
            if [[ ! -x $helper || tests/win-desktop.c -nt $helper ]]; then
                if command -v cc >/dev/null 2>&1; then
                    cc -O2 -municode -o "$helper" tests/win-desktop.c || helper=
                else
                    helper=
                fi
            fi
            if [[ -n ${helper:-} ]]; then
                export HEADLESS=
                exec "$helper" "$BINTANA" tests/runner "$@"
            fi
            echo "no C compiler for the private desktop: this run uses the real screen" >&2
            export HEADLESS=
        fi
        ;;
esac

# exec, so the runner's exit status is this script's, and the chosen binary is
# the one the runner reports as its own (Application.Executable): there is no path to
# pass down and nothing that can disagree about which build ran.
exec "$BINTANA" tests/runner "$@"
