#!/usr/bin/env bash
# Copy the license texts of the MSYS2 packages whose binaries travel with a
# Windows build. Called by `tools/windows-portable.sh` after `cmake --install`;
# the setup copies the resulting `share/licenses` directory wholesale.
#
#   tools/windows-licenses.sh <staged-tree>
#
# The MSYS2 tree keeps one directory per package under `share/licenses`.
# Copying all of them is deliberately over-inclusive: a DLL's package is not
# recorded in the DLL, and a license that travels without the file it covers is
# harmless, while the reverse is not.
set -euo pipefail

dest=${1:?usage: tools/windows-licenses.sh <staged-tree>}
ucrt=${MINGW_PREFIX:-/ucrt64}
src="$ucrt/share/licenses"
out="$dest/share/licenses/bintana/msys2"

if [ ! -d "$src" ]; then
    echo "windows-licenses: no $src -- the staged tree carries no third-party notices" >&2
    exit 0
fi

rm -rf "$out"
mkdir -p "$out"
cp -R "$src"/. "$out"/

{
    echo "# MSYS2 packages whose license texts travel with this build"
    echo
    echo "The source of each package is published at https://packages.msys2.org/"
    echo "and by the upstream project. See THIRD-PARTY-NOTICES.md."
    echo
    for dir in "$out"/*/; do
        [ -d "$dir" ] || continue
        printf -- '- %s\n' "$(basename "$dir")"
    done
} > "$dest/share/licenses/bintana/MSYS2-PACKAGES.md"

count=$(find "$out" -mindepth 1 -maxdepth 1 -type d | wc -l)
echo "windows-licenses: $count package license directories under share/licenses/bintana/msys2"
