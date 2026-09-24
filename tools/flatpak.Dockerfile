# A container that builds the Flatpak repository, so a machine needs no flatpak
# and no SDK of its own:
#
#   docker build -f tools/flatpak.Dockerfile -t bintana-flatpak .
#   docker run --privileged -v "$PWD/out:/out" bintana-flatpak
#
# **`--privileged` is bubblewrap's and not ours.** flatpak-builder builds inside
# a sandbox of its own, which needs user namespaces and `/dev/fuse` that a
# default container does not grant. `--device /dev/fuse --cap-add SYS_ADMIN` is
# the narrower spelling where the daemon allows it.
#
# Ubuntu 24.04 and not this developer's Fedora, for one reason worth writing
# down: flatpak 1.18.0 to 1.18.2 have a regression (#6818) that makes
# `build-init --base` fail, and Ubuntu's flatpak is older than it. The CI runs
# the same image, so a build that works here works there.
FROM ubuntu:24.04

# `elfutils` is flatpak-builder's stripper (`eu-strip`, `eu-elfcompress`) and
# `ostree` is the CLI the build script initializes the repository with; neither
# is a dependency of the package on Ubuntu, and without the first the build
# dies at the last step of the first module, and without the second at the
# export -- the target is a checkout of the published branch, with a `.git` in
# it, and flatpak-builder will not make a repository in a directory that
# already has anything in it.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates flatpak flatpak-builder elfutils ostree \
    && rm -rf /var/lib/apt/lists/*

# The runtime and the SDK come from here, and `--install-deps-from=flathub`
# in the build script finds them.
RUN flatpak remote-add --if-not-exists --system flathub \
        https://dl.flathub.org/repo/flathub.flatpakrepo

COPY . /src
WORKDIR /src

VOLUME /out
CMD ["tools/flatpak-build.sh", "/out"]
