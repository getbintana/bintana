#!/usr/bin/env bash
# `lib/package`, tried the way the packaging step uses it.
#
#   ./tests/pack.sh
#
# It builds a scratch project, packages it, and reads every file back: the
# manifest as JSON, the entry as the desktop format, the metainfo and the icon
# where the manifest says they are. No display and no flatpak -- what is under
# test is the output, and `flatpak-builder` is what would consume it.
#
# The tool is `tests/pack`, a Bintana console project; this is the part that
# has to work when the runtime does not.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/pack "$@"
