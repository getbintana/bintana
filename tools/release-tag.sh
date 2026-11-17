#!/usr/bin/env bash
#
# tools/release-tag.sh TAG [CMakeLists.txt]
#
# Whether TAG may publish a release of this tree, and as what. Prints `final`
# or `prerelease`; anything else is a refusal, on stderr, with exit 1.
#
# **The rule.** A version never carries a `v` -- `CMakeLists.txt`,
# `--version`, `project.btp`, the metainfo, the Flatpak branch, the CHANGELOG
# headings and the asset names all say `0.4.0`. A public tag is `v` and the
# version: `v0.4.0` is the release, `v0.4.0-rc1` a pre-release of it -- the
# two shapes tools/release makes, and the only two this accepts (CMake
# cannot carry the suffix, so an rc's binary says `0.4.0`). Only what *names
# the tag* writes the `v`: a compare link, a Flatpak source's `tag:`.
#
# Two failures this exists for, both silent before: the CI read "a letter
# anywhere in the tag" as a pre-release, and the `v` of `v0.4.0` is a letter,
# so the final release would never have become the repository's *latest*; and
# nothing compared the tag with CMake, so a tag pushed without the version
# bump would have published assets named after the old version.
#
# Plain bash with `grep -E`, since the Windows job runs it in Git Bash.
set -euo pipefail

tag=${1:?usage: tools/release-tag.sh TAG [CMakeLists.txt]}
cmake=${2:-CMakeLists.txt}

version=$(grep -m1 -oE 'project\(bintana VERSION [0-9][^ )]*' "$cmake" | awk '{ print $3 }' || true)
if [[ -z $version ]]; then
    echo "release-tag: no 'project(bintana VERSION ...)' in $cmake" >&2
    exit 1
fi

if [[ $tag != v* ]]; then
    echo "release-tag: '$tag' does not start with v -- a public tag is v and the version: v$version" >&2
    exit 1
fi

rest=${tag#v}
if [[ $rest == "$version" ]]; then
    echo final
elif [[ $rest =~ ^"$version"-rc[0-9]+$ ]]; then
    echo prerelease
else
    echo "release-tag: '$tag' is not v$version or v$version-rcN -- CMakeLists.txt says $version" >&2
    exit 1
fi
