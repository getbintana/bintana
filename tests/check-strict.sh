#!/usr/bin/env bash
# The strict project pass: what `tests/check.sh` does, with warnings failing
# too, over the projects a release is judged by -- the IDE and the examples.
# The tests and tools are left to the ordinary pass: several of them carry
# warnings on purpose (an undefined name, a missing accessible name) and a
# release should not call those errors.
#
#   ./tests/check-strict.sh
#   BINTANA=/other/bintana ./tests/check-strict.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA && -x "$BINTANA.exe" ]]; then
    BINTANA="$BINTANA.exe"
fi
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

checked=0
failed=0

for project in ide examples/*; do
    [[ -f "$project/project.btp" ]] || continue

    echo "== $project (strict)"
    if "$BINTANA" check --strict "$project"; then
        checked=$((checked + 1))
    else
        echo "check-strict: $project failed" >&2
        failed=$((failed + 1))
    fi
done

echo "check-strict: $checked checked, $failed failed"
[[ $failed -eq 0 ]]
