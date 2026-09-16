#!/usr/bin/env bash
# Rewrites the declarations an editor that is not the Bintana IDE reads.
#
#   tests/typings.sh                  the runtime, and the IDE's own forms
#   tests/typings.sh examples/clients ...and that project's too
#
# The tool is `tools/typings`, a Bintana project. It has to open a window --
# `Widget.New` refuses in a project with a `main`, and asking a real control what
# it has is the whole method -- so it runs under the virtual display like the
# test projects, and the window is never shown.
#
# What it writes:
#
#   tools/typings/bintana.d.ts   every class and global the runtime publishes
#   <project>/forms.d.ts         every .form of that project, as its controls
#   <project>/tsconfig.json      "lib": ["es2022"], which is the knob that
#                                matters -- not noLib, which takes the language
#
# `tests/api.sh` fails when the first of those and the runtime disagree, which
# is what keeps a generated file from being a stale one.
set -uo pipefail
cd "$(dirname "$0")/.."

export HEADLESS=${HEADLESS-1}

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

exec "$BINTANA" tools/typings "$PWD" ide "$@"
