#!/usr/bin/env bash
# Writes `llms-full.txt`, the runtime's own documentation as one file.
#
#   tools/llms.sh            rewrite it
#   tools/llms.sh --check    fail when it is not what the sources say
#
# The parts are `llm.txt`'s list, concatenated in order; `tests/api.sh` runs
# `--check` with the rest, so a document edited and not regenerated is red.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tools/llms "$PWD" "$@"
