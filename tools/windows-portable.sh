#!/usr/bin/env bash
#
# A portable Windows build: the tree somebody unzips and runs, DLLs and all.
#
#   tools/windows-portable.sh <build-dir> <destination>
#
# Run from the repository root, inside an MSYS2 UCRT64 shell, after the build:
#
#   cmake -S . -B build -G Ninja
#   cmake --build build -j
#   tools/windows-portable.sh build stage/bintana-0.2.0-windows-x86_64
#
# The layout is the install prefix with GTK's runtime data under it, which is
# the layout GLib computes its own prefix from on Windows -- a DLL in
# `<prefix>/bin` means the prefix is `<prefix>` -- so schemas, icons, mime and
# GtkSourceView's language specs are found with no environment variable at all.
# `bin/bintana-ide.cmd` is the Windows spelling of the installed launcher.
#
# **Nothing here is verified on Windows by whoever edits it.** This repository
# develops on Linux, and the `windows` job in `.github/workflows/ci.yml` is the
# only Windows compiler it has: this script is that job's packaging step, and
# the zip it produces is what a person downloads to find out. Keep the steps
# small and the why next to them -- the log names a line, not a reason.
set -euo pipefail

build=${1:?usage: tools/windows-portable.sh <build-dir> <destination>}
dest=${2:?usage: tools/windows-portable.sh <build-dir> <destination>}

# Where MSYS2 keeps the toolchain; the UCRT64 shell exports this, and every
# path the build links comes from under it.
ucrt=${MINGW_PREFIX:-/ucrt64}

command -v ldd >/dev/null \
    || { echo "no ldd: run this in an MSYS2 shell (the runtime ships it)" >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest"
dest=$(cd "$dest" && pwd)

# --- 1. what the installer lays down -----------------------------------------
#
# The runtime, the IDE as the project directory it is, the shipped libraries,
# the examples and the reference.  --prefix instead of a configured one, so the
# tree is exactly what lands here.
cmake --install "$build" --prefix "$dest"

# The Linux launcher is a shell script that resolves its own location; Windows
# gets a .cmd that does the same.
rm -f "$dest/bin/bintana-ide"

# --- 2. every DLL the executable links ---------------------------------------
#
# `ldd` is recursive, so one pass over the exe is its whole closure.  Only the
# ones that live under the MSYS2 prefix are copied: the system's own
# (kernel32, ntdll, ucrtbase) belong to Windows and shipping a copy of them is
# how a portable build breaks a machine.
copy_deps() {
    for file in "$@"; do
        [ -f "$file" ] || continue

        # A here-string and not a pipe: a `while` on the right of one runs in a
        # subshell, and a `cp` that failed in there would not stop anything --
        # an incomplete zip is the one failure this must not report as success.
        while read -r name arrow path rest; do
            [ "$arrow" = "=>" ] || continue
            case "$path" in
                "$ucrt"/*)
                    [ -e "$dest/bin/$(basename "$path")" ] || cp "$path" "$dest/bin/"
                    ;;
            esac
        done <<<"$(ldd "$file" 2>/dev/null || true)"
    done
}

copy_deps "$dest/bin/bintana.exe"

# --- 3. the data GTK opens at run time ---------------------------------------
#
# None of it is in the exe's link closure -- it is loaded by name, later, from
# paths GLib computes -- so ldd cannot see it and it is copied by hand.

# Schemas: GtkSettings is what the theme, the font and the decoration layout
# come from, and without a compiled schema set every read answers the default.
if [ -d "$ucrt/share/glib-2.0/schemas" ]; then
    mkdir -p "$dest/share/glib-2.0"
    cp -R "$ucrt/share/glib-2.0/schemas" "$dest/share/glib-2.0/"
    glib-compile-schemas "$dest/share/glib-2.0/schemas"
fi

# The gdk-pixbuf loaders, which are what draw an SVG icon or read a PNG.
#
# **The cache holds absolute paths**, and on the machine that downloads the zip
# the absolute path is nobody's.  So the loaders go into `bin` -- beside the
# executable, which is the first place Windows looks a bare DLL name -- and the
# cache is written with bare names to match.  `gdk-pixbuf` finds the *cache*
# itself through GLib's prefix rule, the same one the icons use.
for dir in "$ucrt"/lib/gdk-pixbuf-2.0/*/loaders; do
    [ -d "$dir" ] || continue
    ver=$(basename "$(dirname "$dir")")
    out="$dest/lib/gdk-pixbuf-2.0/$ver"

    mkdir -p "$out"
    cp -f "$dir"/*.dll "$dest/bin/" 2>/dev/null || true

    # Only the loaders, and only by their bare names: the query tool loads each
    # one to ask what it can read, and every other DLL in `bin` is not a loader.
    shopt -s nullglob
    set -- "$dest/bin"/libpixbufloader-*.dll
    shopt -u nullglob

    if [ $# -gt 0 ] && command -v gdk-pixbuf-query-loaders >/dev/null; then
        (cd "$dest/bin" && gdk-pixbuf-query-loaders "${@##*/}") > "$out/loaders.cache" \
            || true
        # Whatever the tool wrote, the file names it wrote are what the cache
        # may keep: a path is not portable, a name is.
        sed -i 's|"[^"]*[\\/]\([^"\\/]*\.dll\)"|"\1"|g' "$out/loaders.cache" \
            2>/dev/null || true
    fi
done

# GIO's modules: proxy resolution, TLS, the things a URI scheme reaches.
if [ -d "$ucrt/lib/gio/modules" ]; then
    mkdir -p "$dest/lib/gio/modules"
    cp -f "$ucrt"/lib/gio/modules/*.dll "$dest/lib/gio/modules/" 2>/dev/null || true
    cp -f "$ucrt/lib/gio/modules/giomodule.cache" "$dest/lib/gio/modules/" 2>/dev/null || true
    copy_deps "$ucrt"/lib/gio/modules/*.dll
fi

# GTK's own input-method modules, where the package has them.
for dir in "$ucrt"/lib/gtk-4.0/*/immodules; do
    [ -d "$dir" ] || continue
    at="$dest/lib/gtk-4.0/$(basename "$(dirname "$dir")")/immodules"
    mkdir -p "$at"
    cp -f "$dir"/*.dll "$at/" 2>/dev/null || true
    copy_deps "$dir"/*.dll
done

# The icon themes.  Adwaita is what GTK falls back to and hicolor is the
# mandatory last resort -- the IDE's own drawings resolve through those two.
for theme in Adwaita hicolor; do
    [ -d "$ucrt/share/icons/$theme" ] || continue
    mkdir -p "$dest/share/icons"
    cp -R "$ucrt/share/icons/$theme" "$dest/share/icons/"
    gtk-update-icon-cache -q -t -f "$dest/share/icons/$theme" 2>/dev/null || true
done

# GtkSourceView's language specs, styles and fonts: without them a SourceEditor
# is a plain text view that still edits, and every completion has no language.
for dir in "$ucrt/share/gtksourceview-5" "$ucrt/lib/gtksourceview-5"; do
    if [ -d "$dir" ]; then
        at="$dest/$(basename "$(dirname "$dir")")/$(basename "$dir")"
        mkdir -p "$(dirname "$at")"
        cp -R "$dir" "$at"
        copy_deps "$at"/*.dll
    fi
done

# The shared MIME database: content types for `File.Info` and the choosers.
if [ -d "$ucrt/share/mime" ]; then
    cp -R "$ucrt/share/mime" "$dest/share/"
fi

# The font GTK draws with on Windows, which has no Cantarell: the setting the
# GTK project's own Windows notes name.
mkdir -p "$dest/etc/gtk-4.0"
printf '[Settings]\ngtk-font-name=Segoe UI 9\n' > "$dest/etc/gtk-4.0/settings.ini"

# --- 4. the launcher ---------------------------------------------------------
#
# The Windows spelling of `bintana-ide`: the IDE is the project directory beside
# this binary, resolved from the script's own location so the tree can be
# unzipped anywhere.  Nothing here has to name the window -- the runtime takes
# the class from the project's own id -- so this only starts the right project
# and hands the arguments over.
cat > "$dest/bin/bintana-ide.cmd" <<'EOF'
@echo off
rem The IDE, from wherever this tree was unzipped to.
setlocal
set "HERE=%~dp0"
"%HERE%bintana.exe" "%HERE%..\share\bintana\ide" %*
EOF

# --- what it came to ---------------------------------------------------------
echo "windows-portable: $dest"
echo "  $(find "$dest" -type f | wc -l) files, $(du -sh "$dest" | cut -f1)"
