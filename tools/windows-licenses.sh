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
    # The versions are what makes the source findable: MSYS2 keeps every
    # version's source package under repo.msys2.org/mingw/sources. pacman
    # answers for the whole environment, a superset of the bundle, and the
    # notices say so; no pacman, no list, and the section says that instead.
    echo
    echo "## Versions installed when this tree was built"
    echo
    echo "Source: https://repo.msys2.org/mingw/sources/"
    echo
    if command -v pacman >/dev/null; then
        echo '```'
        pacman -Q | grep '^mingw-w64-ucrt-' || true
        echo '```'
    else
        echo "(no pacman in the build environment: versions not recorded)"
    fi
} > "$dest/share/licenses/bintana/MSYS2-PACKAGES.md"

count=$(find "$out" -mindepth 1 -maxdepth 1 -type d | wc -l)
echo "windows-licenses: $count package license directories under share/licenses/bintana/msys2"
