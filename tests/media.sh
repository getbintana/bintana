#!/usr/bin/env bash
# What the elements API answers: `Media.Element` and the classes behind it.
#
#   tests/media.sh                    every check
#   BINTANA=/other/bintana tests/media.sh   another build, to compare
#   TIMEOUT=300 tests/media.sh        a slower machine
#
# **Name a host that installs `Media`** -- `bintana-gui`, the default. The
# core (`bintana`) does not link the media module and stubs the global, so
# `BINTANA=./build/bintana` fails the first check instead of testing a build:
# see docs/agents/media-desktop.md.
#
# The tool is `tests/media`, a Bintana console project -- no display. This is
# the part that has to work when the runtime does not: find the binary, and
# say so when there is none. **The timeout is the assertion a hang cannot
# make**: a pipeline the accounting forgot to answer keeps the console loop
# alive forever, and a red run is what that has to look like.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana-gui}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

# **Freed memory is filled, so a use-after-free crashes instead of reading
# what was there**: the bus scenario that drops a wrapper from another's
# handler passed on the old code without it, and segfaulted with it.
export MALLOC_PERTURB_=${MALLOC_PERTURB_-165}

exec timeout "${TIMEOUT:-120}" "$BINTANA" tests/media "$@"
