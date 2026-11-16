#!/usr/bin/env bash
# The mechanical half of a release: the version, the CHANGELOG, the regenerated
# files, the checks, the commit and the tag.
#
#   tools/release.sh 0.4.1              prepare, verify, commit and tag v0.4.1
#   tools/release.sh 0.4.1-rc1          the same, as a pre-release
#   tools/release.sh 0.4.1 --dry-run    say what it would change, write nothing
#   tools/release.sh 0.4.1 --quick      skip check, install and the suite
#
# It stops before `git push`: the push and the tag's push are the owner's.
# The one thing a person writes is the notes under `## Unreleased` in
# `CHANGELOG.md`; `docs/agents/build-and-tools.md` has the rest.
#
# The tool is `tools/release`, a console project. The rebuild it runs replaces
# the binary that is running it, which Linux allows and Windows does not: this
# is a Linux-side command.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tools/release "$@"
