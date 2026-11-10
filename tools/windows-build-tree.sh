#!/usr/bin/env bash
#
# A portable Bintana build for Windows: the MSYS2 UCRT64 tree the runtime is
# developed in, with the compiler, the headers and the tools, copied out as a
# directory somebody unzips and uses.
#
#   tools/windows-build-tree.sh <destination>
#
# Run from the repository root, inside the MSYS2 UCRT64 shell that already has
# the packages installed (the `windows` job's list):
#
#   tools/windows-build-tree.sh stage/bintana-build-0.3.1-windows-x86_64
#
# The tree is the shell's own root -- `cygpath -w /`, `C:\msys64` on the
# runner -- minus the package cache, the logs, the homes and the temporary
# files.  Symlinks are followed: a ZIP extracted on a Windows machine must not
# need the privilege to create them, and a copy of `bash.exe` named `sh.exe`
# is still bash.  `bintana-build.cmd`, written at the root, starts the UCRT64
# shell in the directory it is run from.
#
# **Nothing here is verified on Windows by whoever edits it**, as with
# `tools/windows-portable.sh`: the `windows` job's log is the first place a
# change is seen working.
set -euo pipefail

dest=${1:?usage: tools/windows-build-tree.sh <destination>}

command -v cygpath >/dev/null \
    || { echo "windows-build-tree: no cygpath -- run this in an MSYS2 shell" >&2; exit 1; }
command -v tar >/dev/null \
    || { echo "windows-build-tree: no tar" >&2; exit 1; }

root=$(cygpath -w /)

rm -rf "$dest"
mkdir -p "$dest"
dest=$(cd "$dest" && pwd)

# What the environment is for: a missing one is a tree that cannot build this
# repository, and it is named while it is being made, not found out by the
# person who unzipped it.
need() {
    [ -e "$dest/$1" ] || { echo "windows-build-tree: no $1 -- $2" >&2; exit 1; }
}

# Every top-level directory MSYS2 installs into, and the launchers at the root.
# `mingw32`, `mingw64`, `clang64` and `clangarm64` are the other toolchains,
# which were not installed and are not part of this one.  `home` and `tmp` are
# kept as empty directories: the login shell writes them, and a tree without
# them is a shell that cannot find `$HOME`.
#
# The top-level files are listed by name instead of archiving `/` wholesale:
# on MSYS2 `/` is the installation and the drives are mounts inside it, so a
# recursive copy of `/` would descend into `C:` -- and on a runner that is
# the whole disk.
top=()
while IFS= read -r f; do
    top+=("$f")
done < <(cd / && find . -maxdepth 1 -type f \
             \( -name 'msys2*' -o -name 'ucrt64*' -o -name 'autorebase.bat' \) \
             -printf '%f\n')

dirs=()
for d in etc home opt tmp usr var ucrt64 dev; do
    [ -d "/$d" ] && dirs+=("$d")
done

# The cache is what `pacman -Syu` downloads again; the logs and the homes are
# the machine's, not the environment's.  `--dereference` is the one choice a
# ZIP forces: see the header.  The patterns have no `./` because the members
# are named by the directories above, not by `.`.
tar -C / --dereference \
    --exclude='var/cache/*' \
    --exclude='var/log/*' \
    --exclude='home/*' \
    --exclude='tmp/*' \
    -cf - "${dirs[@]}" "${top[@]}" | tar -C "$dest" -xf -

# The launcher: `-ucrt64` is the toolchain, `-here` is the directory it was
# run from (a checkout, usually).  Everything after it is handed to the shell,
# so `bintana-build.cmd -c 'cmake --build build'` works too.
cat > "$dest/bintana-build.cmd" <<'EOF'
@echo off
rem The Bintana build environment: an MSYS2 UCRT64 shell rooted here.
call "%~dp0msys2_shell.cmd" -ucrt64 -here %*
EOF

# `cmd.exe` wants CRLF, and the heredoc is the shell's LF.
sed -i 's/$/\r/' "$dest/bintana-build.cmd"

cat > "$dest/README.md" <<'EOF'
# Bintana build for Windows

A portable MSYS2 UCRT64 tree with what Bintana is built with on Windows:
GCC, binutils, gdb, cmake, ninja, pkgconf, git, gettext, GTK4, GtkSourceView 5,
sqlite3, libsoup3, libxml2 and their headers. It is the same environment the
Windows CI uses.

Unzip anywhere and run `bintana-build.cmd` from the directory where you keep
your source -- or `bintana-build.cmd -where C:\src`; it opens a UCRT64 shell
there. The repository's `.gitattributes` forces LF, so a Windows checkout is
the same bytes as the others. Then:

    git clone https://github.com/getbintana/bintana.git
    cd bintana
    cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
    cmake --build build -j

    ./build/bintana.exe examples/hello
    ./build/bintana.exe ide

`pacman -Syu` updates the environment. The package cache is not included;
`pacman` downloads what it needs.

The source is not in this ZIP: it is a checkout of
<https://github.com/getbintana/bintana>, not a copy of the environment.
EOF

# The checks that say the copy is a build environment and not a directory of
# DLLs: the compiler, the CMake and Ninja that drive it, git, gettext, and the
# two pkg-config files the runtime's configure step asks for.
need ucrt64/bin/gcc.exe       "the UCRT64 C compiler"
need ucrt64/bin/g++.exe       "the UCRT64 C++ compiler"
need ucrt64/bin/cmake.exe     "CMake"
need ucrt64/bin/ninja.exe     "Ninja"
need ucrt64/bin/pkgconf.exe   "pkgconf"
need usr/bin/git.exe          "git"
need usr/bin/bash.exe         "the MSYS2 shell"
need usr/bin/msgmerge.exe     "gettext's msgmerge"
need ucrt64/include/gtk-4.0/gtk/gtk.h "the GTK4 headers"
need ucrt64/lib/pkgconfig/gtk4.pc     "GTK4's pkg-config file"
need ucrt64/lib/pkgconfig/gtksourceview-5.pc "GtkSourceView 5's pkg-config file"

echo "windows-build-tree: $root -> $dest"
