# Installing Bintana

Everything here is the same on any Linux with GTK 4.10 or newer; Fedora and
Debian/Ubuntu are written out because those are the two the suite is run on.
Windows has a plan of its own in [plans/portability-plan.md](plans/portability-plan.md),
and macOS in [plans/macos-plan.md](plans/macos-plan.md).

## What it needs

| | |
|---|---|
| **GTK 4.10+** | the toolkit, with headers. `GtkAlertDialog` (the error dialog) and `GtkFileDialog` (every chooser) are the floor — Debian 13 and Ubuntu 24.04 and newer; Debian 12 (4.8) and Ubuntu 22.04 (4.6) are too old |
| **GtkSourceView 5** | the source editor, with headers |
| **GLib, GIO, GModule** | come with GTK. GModule is the plugin loader, `gio-unix-2.0` is `Exec`'s third stream |
| **a C11 compiler** | gcc or clang |
| **CMake 3.16+** and **pkg-config** | the build |
| **QuickJS** | **not a dependency to install**: quickjs-ng v0.16.1 is vendored in `vendor/quickjs`, with six patches of ours in it ([AGENTS.md](../AGENTS.md#the-six-patches-in-vendor)) |

Six more are optional, and CMake prints what it found either way. Without each
the runtime builds and the thing itself says which package is missing when it is
called — see the table below.

### Fedora

```sh
sudo dnf install gcc make cmake pkgconf-pkg-config gtk4-devel gtksourceview5-devel
```

### Debian / Ubuntu

```sh
sudo apt install build-essential cmake pkg-config libgtk-4-dev libgtksourceview-5-dev
```

## Build

```sh
cmake -S . -B build
cmake --build build -j"$(nproc)"
```

That is the whole build. QuickJS is compiled from `vendor/`, `runtime/js/rad.js`
is embedded into the binary, and `.js`/`.form` files are read at run time — so
editing anything under `examples/`, `ide/`, `lib/` or `tests/` needs no rebuild.

```sh
./build/bintana examples/hello        # any project, straight from the tree
./build/bintana examples/i18n         # layout under translation
LANGUAGE=es ./build/bintana ide examples/hello   # the IDE in Spanish
```

`./build/bintana` finds the shipped libraries (`lib/charts`, `lib/report`,
`lib/markdown`) one hop from its own binary, so nothing has to be installed to
run an example or the IDE from the source tree.

## Install

```sh
cmake -S . -B build -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build build -j
sudo cmake --install build          # or: sudo make -C build install
```

`/usr/local` on both distributions, for one reason: both pkg-configs search it,
so a plugin later runs `pkg-config --cflags bintana` with no special path.

**Fedora is the one worth knowing about, because the obvious way to ask lies.**
`pkg-config --variable pc_path pkg-config` answers `/usr/lib64/pkgconfig:
/usr/share/pkgconfig` and hides the truth: `/usr/bin/pkg-config` is a wrapper
that sets `PKG_CONFIG_LIBDIR` to `/usr/local/lib64/pkgconfig:/usr/local/share/
pkgconfig:/usr/lib64/pkgconfig:/usr/share/pkgconfig` before exec'ing pkgconf,
and a set `PKG_CONFIG_LIBDIR` replaces the compiled-in default rather than
adding to it. So the variable reports pkgconf's own default, and the question
that has a true answer is `pkg-config --cflags bintana` itself. Debian's
pkg-config searches `/usr/local` too, with no wrapper involved.

Any other prefix works as well; then `PKG_CONFIG_PATH` is what tells pkg-config
where the file went -- `<prefix>/lib*/pkgconfig` -- and for a user-level install
that is the whole cost of not using root:

```sh
cmake -S . -B build -DCMAKE_INSTALL_PREFIX=$HOME/.local
cmake --build build -j && cmake --install build
PKG_CONFIG_PATH=$HOME/.local/lib64/pkgconfig cmake -S some-plugin -B some-plugin/build
```

**And not installing is also an answer.** The build tree carries a
`bintana.pc` of its own, under `<build>/pkgconfig`, that describes *this source
tree* -- so a plugin can be built against a checkout with nothing installed:

```sh
PKG_CONFIG_PATH=<bintana>/build/pkgconfig cmake -S some-plugin -B some-plugin/build
```

| lands | what it is |
|---|---|
| `<prefix>/bin/bintana` | the runtime |
| `<prefix>/bin/bintana-ide` | a one-line launcher for the IDE, under a name a menu entry can carry |
| `<prefix>/share/bintana/ide/` | the IDE as the project directory it is |
| `<prefix>/share/bintana/examples/` | the examples, to open and copy |
| `<prefix>/share/bintana/lib/` | the three shipped libraries |
| `<prefix>/share/bintana/bintana.d.ts` | the declarations an editor that is not the IDE reads |
| `<prefix>/include/bintana/bta_plugin.h` | the only header a native plugin compiles against |
| `<prefix>/lib*/pkgconfig/bintana.pc` | what points a compiler at that header |
| `<prefix>/share/applications/` + `share/icons/` | the menu entry and its icon |

A packager who installs somewhere else stages it first, which needs no second
configure — the two paths that resolve from the binary are relative hops:

```sh
sudo env DESTDIR=/tmp/pkg cmake --install build
```

The installed examples are read-only like everything under a prefix; copy one
somewhere writable before opening it in the IDE to edit.

```sh
bintana-ide                              # the IDE, from the menu or a shell
bintana-ide ~/my-project                 # ...opening a project
bintana /usr/local/share/bintana/examples/hello
bintana --version                        # the runtime's own release
```

`bintana --version` is the runtime's release, which is also `BTA_VERSION` in a
program and the `Version` of `bintana.pc`; an *application's* version is
`Application.Version`, out of its own `project.json`.

**Per-user is the other half**, and it is not this install at all: a project can
put *itself* in the user's menu from the IDE — *Project → Install as user
application…* — which writes one `.desktop` file under
`~/.local/share/applications` pointing at the runtime and the project. No root,
no prefix, and nothing here (`Desktop.Entries` is the runtime's own door to
those files, in [`llm/library.md`](llm/library.md#desktopentries); the IDE's
half is in [`ide.md`](ide.md#installing-it-in-the-menu)).

`./tests/install.sh` does all of the above into a staging prefix under `/tmp`
and starts the *installed* IDE through the installed launcher on a display of
its own — so *would an install work* has an answer that installs nothing.

### A downloadable build

The `package` job in the CI produces exactly that tree as one file —
`bintana-<version>-linux-<arch>.tar.gz` — and every push keeps it as an
artifact of the run; a tag also attaches it to the release. The `windows` job
does the same for Windows, as a `.zip` with the GTK runtime data
(`tools/windows-portable.sh`), and that one **is unverified**: it is built and
staged by the job, but the IDE on Windows is a first look and not a claim.

It is the install prefix, so it is extracted anywhere and runs without
installing:

```sh
tar xzf bintana-0.1.0-linux-x86_64.tar.gz
./bin/bintana-ide                    # the IDE
./bin/bintana share/bintana/examples/hello
```

**The IDE is in there because the IDE is data.** The runtime, the `ide/`
project directory, the shipped libraries, the examples and the reference under
`share/doc/` all resolve from the binary by *relative* hops, which is why
moving the tree after the fact changes nothing. On Windows the same is true and
the launcher is `bin\bintana-ide.cmd` — the IDE, from wherever the zip was
unzipped to. What Windows needs that Linux does not is GTK's runtime data
alongside: schemas, the icon themes, the gdk-pixbuf loaders and GtkSourceView's
language specs, which the packaging script copies and arranges the way GLib's
own prefix rule expects to find them.

Three things it deliberately does not do: it does not bundle GTK (the machine
needs GTK 4.10+ and GtkSourceView 5), it is built on `ubuntu-24.04` and so wants
a glibc at least as new (2.39 — Fedora 40, Debian 13, Ubuntu 24.04), and it is
built **without** the optional dependencies (`sqlite3`, `libsoup`, GStreamer,
VTE) so that none of them becomes a shared library the downloader has to have.
The features that need one say which package is missing, the same way a build
without them always does. A distribution package makes the opposite trade, and
that is the packager's to make.

## Flatpak

The other way to ship an application: a package that brings its runtime, with
the project inside it. `tools/pack.sh` turns a project into the files a package
is built from, and `flatpak-builder` builds them.

```sh
tools/pack.sh ~/my-project /tmp/my-app       # the metainfo, the .desktop,
                                             # the icon and <id>.json
flatpak-builder --user --install \
    --install-deps-from=flathub /tmp/my-app/build /tmp/my-app/<id>.json
flatpak run <id>
```

Three host-side tools nothing declares, and each failure lands after minutes
of compiling: `elfutils` is flatpak-builder's own stripper (`eu-strip`,
`eu-elfcompress`); `ostree` is what `tools/flatpak-build.sh` initializes the
repository with, because the target may be a checkout of the published branch
and flatpak-builder will not make one in a directory that already has anything
in it; and `librsvg2-common` is the host's gdk-pixbuf SVG loader, which
`appstreamcli compose` rasterizes a scalable icon through -- without it the
compose dies with `file-read-error`, naming no file. A Fedora desktop carries
all three, which is why a local build does not meet any of them.

It needs the shared BaseApp, which is where the runtime comes from -- the same
one every Bintana application is built on, so nothing here rebuilds GTK or the
interpreter:

```sh
flatpak install --user flathub org.gnome.Platform//50 org.gnome.Sdk//50
# ...and the BaseApp from the repository it is published in
flatpak remote-add --if-not-exists --no-gpg-verify bintana https://...
flatpak install --user bintana io.github.getbintana.BaseApp//0.1
```

The project must declare an `id`, have an `icons/` drawing and carry a
`<id>.metainfo.xml` -- *Project → Application info…* in the IDE writes one. What
each file has to say, and what the packaging step refuses, is
[`lib/package`](llm/package.md); the Flatpak manifest is JSON and the output
directory is a build context, so it can be copied to a build machine and built
there.

**The BaseApp is a build dependency and not a runtime one.** Its files are
copied into each application when it is built -- that is what makes one runtime
on disk serve every app -- so a change to the runtime means rebuilding and
republishing every application, in one run. `tools/flatpak-build.sh` is that
run: with no application named it builds the BaseApp, the IDE and the example
into one repository, and naming some builds those -- which is what a CI does
when only one application changed. [`flatpak/ci/`](../flatpak/ci/README.md) is
the workflow that decides, and the repository it publishes to.

**Building locally wants a flatpak that works.** flatpak 1.18.0 to 1.18.2 have a
[regression](https://github.com/flatpak/flatpak/issues/6818) that makes
`build-init --base` fail with `lsetxattr(security.selinux): Operation not
supported`; it is fixed in 1.18.3, and it is not SELinux -- the call fails in
permissive mode too. The CI runs Ubuntu 24.04, whose flatpak is older than the
regression.

## Uninstall

```sh
sudo cmake --build build --target uninstall     # or: sudo make -C build uninstall
```

**CMake has no uninstall, so the manifest is what one is made of.**
`cmake --install` writes every path it installed to `build/install_manifest.txt`,
and the target removes exactly those — and then the directories among them that
are **empty**, so `/usr/share/bintana` goes once the last form is out of it,
while `/usr/bin`, `/usr/lib64/pkgconfig` and `/usr/share/applications` stay
whether or not they happen to be empty.

A `--prefix` used at install time is baked into the manifest; a `DESTDIR` is
not, and the target applies `$DESTDIR` the same way the install did:

```sh
sudo env DESTDIR=/tmp/pkg cmake --build build --target uninstall
```

Two things it deliberately does not do.  It does not `rm -rf` a prefix: that is
right for a private one (`/tmp/stage`, `~/.local`) and wrong for `/usr`, where
the prefix is shared — for a private prefix, deleting the tree is simply another
answer.  And it does not touch what a **program** wrote while it ran: the
settings and recovery files under `~/.config/bintana/<project>`, and any project
the IDE created. Those were never the install's, and they are the user's to
decide about.

A later `cmake --install` overwrites the manifest — it always describes the last
install, which is the one the target undoes. A native plugin installs a
directory of its own and is uninstalled by removing it; the reference CMake
project in [plugins.md](plugins.md#building-one) says where that is.

## The optional dependencies

| what it turns on | Fedora | Debian / Ubuntu | without it |
|---|---|---|---|
| `Database.Sqlite(path)` | `sqlite-devel` | `libsqlite3-dev` | the class is there and says which package is missing when called |
| `Logger.Target = "Journal"` | `systemd-devel` | `libsystemd-dev` | logging goes to the terminal |
| `Http`, `Http.Server`, `Http.Stream` | `libsoup3-devel` | `libsoup-3.0-dev` | `Http` exists and refuses by name |
| `Video`, `AudioPlayer` | `gstreamer1-devel gstreamer1-plugins-base-devel` | `libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev` | both exist and say nothing can be played |
| ...and the picture, not just the sound | `gstreamer1-plugin-gtk4` | `gstreamer1.0-gtk4` | `Video`'s sink (`gtk4paintablesink`, from gst-plugins-rs) is missing and `AudioPlayer` still works |
| `Terminal` | `vte291-gtk4-devel` | `libvte-2.91-gtk4-dev` | the class still draws and still round-trips a `.form`; only `Run`, `Stop` and `Kill` refuse. The only dependency with no Windows port |
| `Xml`, `File.LoadXml`/`SaveXml` | `libxml2-devel` | `libxml2-dev` | `Xml` exists, `Available` is `false`, and every verb refuses with a sentence. GTK4 itself already loads libxml2 at runtime on most desktops, so this is a **build** dependency and not a new runtime one |

`Widget.Available(type)` is how a program asks what the build it is running on
can actually do — a palette filters on it, and so should anything that offers a
feature rather than using one. For the two globals that are not widgets the
question is spelled `Xml.Available` (a value, read off the build) and a refusing
call for `Database.Sqlite`.

## Running the test suite

```sh
# Fedora
sudo dnf install xorg-x11-server-Xvfb xdotool python3 openssl
# Debian / Ubuntu
sudo apt install xvfb xdotool python3 openssl

# the media test generates its clips with gst-launch-1.0:
#   Fedora         gstreamer1
#   Debian/Ubuntu  gstreamer1.0-tools
```

```sh
./tests/run.sh            # every project, on a virtual display
./tests/run.sh widgets    # one project
./tests/api.sh            # is docs/llm/ still the whole public surface?
./tests/install.sh        # what `make install` produces
./tests/asan.sh           # the suite under AddressSanitizer
```

`run.sh` and `asan.sh` export `HEADLESS=1`, so the suite draws on `xvfb-run` and
never on your screen; `HEADLESS=` — empty, not `0` — is the way back to a real
one for the few questions that need a real icon theme. `tests/install.sh` needs
`Xvfb` and `xdotool` itself (it asks a display what the installed IDE drew), and
`tests/asan.sh` expects **clang** plus its sanitizer runtime — Fedora's
`compiler-rt` is enough, and `libasan` from gcc is not shipped there.

**The suite is written against Xvfb, and a substitute display is a false red
one.** Measured: under `weston --backend=headless` the windows map and are never
allocated, so `tests/widgets` reported 75 failures — `Bounds()` answering 0x0 and
`never became true` — every one of them a layout assertion in code nobody had
touched; with `Xvfb` the same tree passes. When `xvfb-run` is missing, install it
rather than borrowing whatever display is around.

The HTTP tests start local servers with `python3`, and one of them makes a
throwaway TLS certificate with `openssl`; where either tool is missing that step
is skipped rather than failed.

## Writing a native plugin

A plugin is compiled **against the installed runtime and links neither `bintana`
nor QuickJS**. What it needs from the runtime is the one header and the
`pkg-config` file that points at it, both installed above; what it links is the
C library it wraps, and nothing else:

```sh
cc -shared -fPIC -O2 -o taglib.so taglib.c \
   $(pkg-config --cflags --libs taglib_c) $(pkg-config --cflags bintana)
```

There is no `Libs` in `bintana.pc`, because there is nothing to link from the
runtime. A CMake project asks for it the same way and gets the same flags --
`pkg_check_modules(BINTANA REQUIRED bintana)`, which is the reference pattern
[plugins.md](plugins.md#building-one) writes out. A library that ships native
code puts it at `lib/<name>/<name>.so` and names the directory in `uses`,
exactly as a library of `.js` files. [plugins.md](plugins.md) is the contract
and a TagLib wrapper worked through.

## When CMake says something is missing

| message | install |
|---|---|
| `Could NOT find PkgConfig` | `pkgconf-pkg-config` / `pkg-config` |
| `Package 'gtk4' not found` | `gtk4-devel` / `libgtk-4-dev` |
| `Package 'gtksourceview-5' not found` | `gtksourceview5-devel` / `libgtksourceview-5-dev` |
| compile errors about `gtk_alert_dialog` or `gtk_file_dialog` | the GTK is older than 4.10 — Debian 13 / Ubuntu 24.04 or newer |
| `no vte: Terminal exists and refuses to run one` | not an error: the optional table above |
| `no sqlite3`, `no libsoup`, `no gstreamer`, `no libxml2` | likewise — a build line, not a failure |
