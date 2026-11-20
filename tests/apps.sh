#!/usr/bin/env bash
# `bintana apps`: what it lists, what each entry installed, and what it refuses
# to remove.
#
#   ./tests/apps.sh
#
# Two entries in a scratch `XDG_DATA_HOME` of its own -- one the IDE would have
# written and one it would not -- and the command run as a child. No display and
# no project.
#
# The tool is `tests/apps`, a Bintana console project; this is the part that has
# to work when the runtime does not.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/apps "$@"
