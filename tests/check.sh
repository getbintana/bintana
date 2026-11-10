#!/usr/bin/env bash
# `bintana check` over every project in the tree, with no window.
#
#   ./tests/check.sh
#   BINTANA=/other/bintana ./tests/check.sh
#
# This is the project pass the Windows CI can run without a desktop: it reads
# every `project.btp`, every `.form` and every source, and exits 1 on an error.
# Warnings are printed and do not fail the run, exactly as `bintana check` does.
#
# **`tests/ide` is skipped when its `.form` files are not real symlinks.** The
# project's forms are symlinks to `ide/forms/`; a Windows checkout without
# Developer Mode (or without `core.symlinks=true` and the privilege to make
# one) writes the target path as a text file, and checking that as JSON is a
# false failure. It is one sentence in the log, not a silent skip.
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
skipped=0
failed=0

for project in examples/* tests/*; do
    [[ -f "$project/project.btp" ]] || continue

    if [[ $project == tests/ide && ! -L tests/ide/MainForm.form ]]; then
        echo "check: tests/ide: the .form symlinks are not materialized -- " \
             "skipping (Windows: enable Developer Mode or set core.symlinks=true)"
        skipped=$((skipped + 1))
        continue
    fi

    echo "== $project"
    if "$BINTANA" check "$project"; then
        checked=$((checked + 1))
    else
        echo "check: $project failed" >&2
        failed=$((failed + 1))
    fi
done

echo "check: $checked checked, $skipped skipped, $failed failed"
[[ $failed -eq 0 ]]
