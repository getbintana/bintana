#!/usr/bin/env bash
#
# Build refs from the application registry into a publishable Flatpak
# repository.
#
#   tools/flatpak-build.sh <repo-dir> <apps-dir> <sources-dir> [--sign KEYID] [ref...]
#
# A ref is `BaseApp` or the name of a directory in `<apps-dir>` -- the registry,
# one `app.json` per application (`tools/flatpak-plan` documents it). With no
# ref named, every application in the registry is built and the BaseApp with
# them. Nothing here names an application: add the directory and it is built.
#
# `<sources-dir>` holds one checkout per source: `bintana` for the runtime and
# the applications that live in it, and one named after an application for a
# source with a `repo` of its own. `tools/flatpak-plan` decides which refs those
# are; this builds what it names.
#
# The runtime and the SDK come from Flathub, and an application is built on the
# BaseApp: `flatpak build-init --base` looks it up the way `flatpak info` does,
# so the base is built and installed first when it is among the refs, and
# installed from the repository when it is not.
#
# What it leaves is a repository: `flatpak build-update-repo` has written the
# summary, the static deltas and -- when a key is given -- the signature, so
# serving the directory is the whole of publishing it.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)

repo=$(realpath "${1:?usage: tools/flatpak-build.sh <repo-dir> <apps-dir> <sources-dir> [--sign KEYID] [ref...]}")
apps=$(realpath "${2:?the registry directory}")
sources=$(realpath "${3:?the sources directory}")
shift 3

sign=""
if [[ ${1:-} == --sign ]]; then
    sign=${2:?--sign needs a key id}
    shift 2
fi

refs=("$@")
if [[ ${#refs[@]} -eq 0 ]]; then
    refs=(BaseApp)
    for entry in "$apps"/*/app.json; do
        [[ -e $entry ]] || continue
        refs+=("$(basename "$(dirname "$entry")")")
    done
fi

bintana="$sources/bintana"
[[ -d $bintana ]] || { echo "flatpak-build: no bintana checkout at $bintana" >&2; exit 2; }

work="$here/build-flatpak"
mkdir -p "$repo" "$work"

# The target may be a checkout of the published branch -- `gh-pages` has a
# `.git` in it -- and flatpak-builder reads any directory that already exists as
# the repository, so it dies at the export with `opendir(objects)` instead of
# making one. An *empty* directory it creates itself; one with anything else in
# it has to be made here.
if [ ! -d "$repo/objects" ]; then
    ostree init --repo="$repo" --mode=archive-z2
fi

# **A repository that was committed and checked out again has lost two of its
# directories.**  `refs/mirrors/` and `refs/remotes/` are empty, and git does
# not record an empty directory -- so they are there the first time and gone the
# next, while `objects/` and the ref files under `refs/heads/` come back.  The
# failure names the directory and not the publish step that dropped it:
#
#     error: Listing refs: opendir(refs/remotes): No such file or directory
#
# `flatpak build-update-repo` lists them, so they are made and not assumed.
mkdir -p "$repo/refs/heads" "$repo/refs/mirrors" "$repo/refs/remotes"

# An application built on the base needs it installed, and the repository is
# where it is when this run is not building it.
if [[ ! " ${refs[*]} " =~ " BaseApp " ]] && [ -f "$repo/summary" ]; then
    flatpak remote-add --user --if-not-exists --no-gpg-verify bintana "$repo" \
        2>/dev/null || true
    flatpak install --user -y --noninteractive bintana \
        io.github.getbintana.BaseApp//0.1 || true
fi

# One field of an application's registration. `python3` is the runner's and
# already there; reading JSON with `sed` is how a registry gets a second,
# wrong parser.
json() {
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2"
}

for ref in "${refs[@]}"; do
    echo "== $ref"

    if [[ $ref == BaseApp ]]; then
        flatpak-builder --user --install --force-clean --install-deps-from=flathub \
            --repo="$repo" "$work/BaseApp" \
            "$bintana/flatpak/io.github.getbintana.BaseApp.yml"
        continue
    fi

    entry="$apps/$ref/app.json"
    [[ -f $entry ]] || { echo "flatpak-build: no $entry" >&2; exit 2; }

    id=$(json "$entry" id)
    project=$(json "$entry" project)
    manifest=$(json "$entry" manifest)

    if [[ -n $(json "$entry" repo) ]]; then
        src="$sources/$ref"
    else
        src="$bintana"
    fi
    [[ -d $src ]] || { echo "flatpak-build: no source checkout at $src" >&2; exit 2; }

    if [[ -n $manifest ]]; then
        flatpak-builder --user --install --force-clean --install-deps-from=flathub \
            --repo="$repo" "$work/$ref" "$src/$manifest"
        continue
    fi

    # A project: `tools/pack.sh` writes the build context -- the project, the
    # metainfo, the entry, the icon and the manifest -- and the manifest it
    # wrote is what is built.
    out="$work/$ref-out"
    rm -rf "$out"
    "$bintana/tools/pack.sh" "$src/$project" "$out"
    flatpak-builder --user --install --force-clean --install-deps-from=flathub \
        --repo="$repo" "$work/$ref" "$out/$id.json"
done

flatpak build-update-repo --title="Bintana" \
    --comment="The Bintana runtime and its applications" \
    --default-branch=stable --generate-static-deltas --prune \
    ${sign:+--gpg-sign="$sign"} "$repo"

echo
echo "repository: $repo"
