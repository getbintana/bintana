#!/usr/bin/env bash
# The packaging step, from a shell: the project, and where the files go.
#
#   tools/pack.sh <project> <out>
#
# It is `tools/pack`, a console project, so this is only the ten lines that
# find the runtime -- the same shape `tests/*.sh` have, and for the same
# reason: the binary can be another build's (`BINTANA=<path>`).
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tools/pack "$@"
