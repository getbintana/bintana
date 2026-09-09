#!/usr/bin/env bash
# Which declared icons this desktop really has.
#
#   tests/icons.sh            every .form in the tree
#   tests/icons.sh ide        only that directory
#
# The tool is `tests/icons`, a Bintana console project -- no display, no GTK,
# and that is the design rather than an economy: asking GTK would answer about
# whatever display the process has, which under Xvfb is Adwaita, which is the
# bug this exists to catch. This is the part that has to work when the runtime
# does not: find the binary, and say so when there is none.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/icons "$@"
