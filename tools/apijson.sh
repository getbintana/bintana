#!/usr/bin/env bash
# Writes `api.json`, the runtime's public surface as data -- the artifact the
# documentation repositories are checked against.
#
#   tools/apijson.sh                 rewrite it
#   tools/apijson.sh --check         fail when it is not what the runtime says
#
# The builder lives in `tools/apijson/Catalog.js` and is sourced by
# `tests/api` as well, so the file and the check cannot drift. A description
# changed in the C, or a member added, makes both of them red until this runs.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tools/apijson "$PWD" "$@"
