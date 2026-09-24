#!/usr/bin/env bash
#
# Build the BaseApp and the applications that live in this repository into a
# publishable Flatpak repository.
#
#   tools/flatpak-build.sh <repo-dir> [--sign KEYID] [app...]
#
# With no application named it builds all three; naming some builds those, and
# the BaseApp is then expected to be **installed** already -- from the published
# repository, which is where a CI that rebuilds one application finds it. The
# runtime and the SDK come from Flathub, and an application built on the base
# needs it installed because `flatpak build-init --base` looks it up the way
# `flatpak info` does. Each ref is installed as it is built, which is what makes
# the next one find the base.
#
# What it leaves is a repository: `flatpak build-update-repo` has written the
# summary, the static deltas and -- when a key is given -- the signature, so
# serving the directory is the whole of publishing it. `tests/pack.sh` is the
# library's half; this is the build.
#
# **A change to the runtime rebuilds everything.** The BaseApp's files are
# copied into each application at build time, so this is not an optimisation to
# make later: it is why the default is all three, and why whoever decides what
# changed has to name all three when the base did.
set -euo pipefail
cd "$(dirname "$0")/.."

repo=${1:?usage: tools/flatpak-build.sh <repo-dir> [--sign KEYID] [app...]}
shift || true

sign=""
if [[ ${1:-} == --sign ]]; then
    sign=${2:?--sign needs a key id}
    shift
fi

apps=("$@")
if [[ ${#apps[@]} -eq 0 ]]; then
    apps=(BaseApp Ide Hello)
fi

work=build-flatpak
mkdir -p "$repo" "$work"

# **The target may be a checkout of the published branch.** `gh-pages` has a
# `.git` in it, and flatpak-builder reads any directory that already exists as
# the repository -- so it dies at the export with `opendir(objects): No such
# file or directory` instead of making one. An *empty* directory it creates
# itself; one with anything else in it has to be made here, in the mode flatpak
# repositories use.
if [ ! -d "$repo/objects" ]; then
    ostree init --repo="$repo" --mode=archive-z2
fi

for app in "${apps[@]}"; do
    echo "== $app"
    flatpak-builder --user --install --force-clean \
        --install-deps-from=flathub \
        --repo="$repo" \
        "$work/$app" "flatpak/io.github.getbintana.$app.yml"
done

flatpak build-update-repo --title="Bintana" \
    --comment="The Bintana runtime and its applications" \
    --default-branch=stable --generate-static-deltas --prune \
    ${sign:+--gpg-sign="$sign"} "$repo"

echo
echo "repository: $repo"
echo "serve it, or copy it where a static host can reach it"
