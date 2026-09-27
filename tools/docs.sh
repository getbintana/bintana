#!/usr/bin/env bash
# Writes the member rows of docs/llm and docs/reference from the code.
#
#   tools/docs.sh            rewrite the pages whose rows are out of date
#   tools/docs.sh --check    say which, and fail, writing nothing
#
# A member's description lives beside it -- the lines after its signature
# comment in runtime/src -- and this is what copies it into the tables. The
# tables and the prose around them are written by hand. tests/api.sh runs the
# same comparison and fails while a page is out of date.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tools/docs "$PWD" "$@"
