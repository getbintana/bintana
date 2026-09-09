#!/usr/bin/env bash
# Runs a project without putting it on anybody's screen.
#
#   tests/try.sh <project-dir> [args...]
#
# `HEADLESS=1` is read by `tests/runner`, which wraps the suite in `xvfb-run` --
# **the binary does not read it at all**.  So `HEADLESS=1 ./build/bintana <dir>` is a
# window on the user's desktop, and it looks exactly like the safe thing right up
# until it opens.  That mistake has been made; this is the shape that cannot make
# it.
#
# It is for the ad-hoc probe -- "what does this property really do", "measure this
# allocation" -- which is a project of two files under a scratch directory and a
# `print` of what it found.  The suite has `tests/run.sh`; this is for everything
# that is not the suite.
#
# `BINTANA=<path>` points at a build other than ./build/bintana.  `HEADLESS=` (empty) is
# the way back to a real screen, for the questions that need one -- an icon, a
# theme -- and it should be a question you can say out loud.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ $# -ge 1 ]] || { sed -n '2,20p' "$0" | sed 's/^# \?//' >&2; exit 2; }

BINTANA=${BINTANA:-./build/bintana}
[[ -x $BINTANA ]] || { echo "try.sh: no build at $BINTANA -- cmake --build build" >&2; exit 1; }

if [[ -n ${HEADLESS-1} ]]; then
    exec xvfb-run -a "$BINTANA" "$@"
fi
exec "$BINTANA" "$@"
