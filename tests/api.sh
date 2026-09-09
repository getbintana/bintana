#!/usr/bin/env bash
# Does docs/llm/ still document the whole runtime surface?
#
#   tests/api.sh
#
# The tool is `tests/api`, a Bintana console project -- no display and no window.
# It reads `runtime/src/*.c`, `lib/*` and the four references, and fails when
# something exists that is not written down:
#
#   widgets   the accessor tables and the `bta_emit` calls, against controls.md --
#             a property, method or event with no row, or an event documented
#             with the wrong number of arguments
#   globals   the same tables and the `JS_SetPropertyStr` runs that build
#             `File`, `Dialog`, `Application` and the rest, against library.md
#   lib/      what a shipped library publishes, against llm/<library>.md
#
# The reference claims to be complete rather than a selection, and this is what
# makes that claim cost something.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/api "$PWD"
