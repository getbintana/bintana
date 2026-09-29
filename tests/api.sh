#!/usr/bin/env bash
# Does the runtime still say what it publishes?
#
#   tests/api.sh
#
# The tool is `tests/api`, a Bintana console project -- no display and no
# window. It reads `runtime/src/*.c`, `runtime/js/*.js`, `lib/*` and
# `api.json`, and fails when something exists that is not written down:
#
#   signatures  every method and event of every widget, and every native verb
#               of every global, declares its parameters beside itself
#   docs        every public member and event has a description beside its C
#               entry or in its JSDoc
#   api.json    the manifest built by `tools/apijson/Catalog.js` -- the contract
#               the documentation repositories read -- against the same tables,
#               the same events and the same types, and against the file
#               itself, so one that is stale or was edited fails here
#   globals     every global the runtime installs with public members is in
#               that manifest
#   lib/        two libraries may not declare the same top-level name
#   links       every relative link and picture in the Markdown that stayed,
#               against the files they name -- the failure a reorganisation
#               leaves behind
#
# **The pages are not here any more.** They live in `bintana-docs`, which
# checks them against this manifest; what cannot be asked from there -- the C,
# the prelude, and a runtime that answers with no display at all -- is here.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/api "$PWD"
