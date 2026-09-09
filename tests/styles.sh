#!/usr/bin/env bash
# Which style classes this desktop's theme defines, and what each one is written
# for.
#
#   tests/styles.sh                 the theme compiled into GTK (what everyone gets)
#   tests/styles.sh --all           every class in it, by how much it is used
#   tests/styles.sh --json          the same as a machine reads it
#   tests/styles.sh path/to/gtk.css a theme of your own
#
# The tool is `tests/styles`, a Bintana console project: it reads the theme out
# of the library and parses the selectors, with no display and no window. This
# is the part that has to work when the runtime does not.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tests/styles "$@"
