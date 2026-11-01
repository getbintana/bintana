#!/usr/bin/env bash
# Runs every test of `tests/widgets` on its own, with only the prerequisites
# its `NEEDS` entry declares.
#
#   tests/alone.sh                 every test
#   tests/alone.sh Table           the ones whose name contains it
#   TIMEOUT=600 tests/alone.sh     a slower machine
#
# **What this asks is the invariant the project claims**: a test stands by
# itself, and the order the suite happens to use is not what makes it pass. A
# shared process can hide the opposite -- state left by the test before -- and
# the symptom is a test that goes red only when somebody runs it, or when the
# list is reordered. `NEEDS` is the declaration, and the filter `=Name` runs
# exactly one name; a substring would run every test it is part of.
#
# Not part of run.sh: it starts one process per test, which is tens of minutes,
# and it is the desk check for an ordering bug rather than a property of every
# change.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

filter=${1:-}
names=$(./tests/run.sh widgets list 2>/dev/null | sed -n 's/^  //p')
if [[ -z $names ]]; then
    echo "the widgets project listed no tests" >&2
    exit 2
fi

failed=()
ran=0
for name in $names; do
    if [[ -n $filter && $name != *"$filter"* ]]; then
        continue
    fi
    ran=$((ran + 1))
    if out=$(TIMEOUT=${TIMEOUT:-300} ./tests/run.sh widgets "=$name" 2>&1); then
        printf '.'
    else
        printf '\nFAIL %s\n%s\n' "$name" "$out"
        failed+=("$name")
    fi
done
printf '\n'

if ((${#failed[@]})); then
    printf 'alone: %d failed of %d -- %s\n' "${#failed[@]}" "$ran" "${failed[*]}" >&2
    exit 1
fi
printf 'alone: %d passed, each with only its NEEDS\n' "$ran"
