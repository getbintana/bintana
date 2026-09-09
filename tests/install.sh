#!/usr/bin/env bash
# What `make install` produces, tried the way somebody who ran it would.
#
#   ./tests/install.sh
#
# It installs into a staging prefix under /tmp and starts the *installed* IDE
# out of it, on an X server it brings up itself -- never on your screen, and
# never over the top of anything you have installed for real.
#
# The tool is `tests/install`, a Bintana console project. This is the part that
# has to work when the runtime does not: find the binary, and say so when there
# is none. The build it installs from is the one this binary came out of, so
# `BINTANA=<path>` needs nothing passed down.
#
# Needs `cmake`, `Xvfb` and `xdotool`; the project says so itself when one is
# missing.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/install "$@"
