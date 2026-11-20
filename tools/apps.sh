#!/usr/bin/env bash
# The applications a user installed for themselves: list them, what each one
# wrote, and take them out of the menu.
#
#   tools/apps.sh                 the entries the IDE installed
#   tools/apps.sh files <id>      the files one of them installed
#   tools/apps.sh remove <id>...  take them out of the menu
#   tools/apps.sh --json          one object per line
#
# `bintana apps ...` is the same command from a terminal: the core dispatches
# this project. The script is for a build tree, the way `tools/check.sh` is.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tools/apps "$@"
