# Distribution: deb, rpm, AppImage, signing and updates

**Status: proposed, not started (2026-11-12).** This is the design for
[ISSUE-appimage-packaging](../issues/ISSUE-appimage-packaging.md): a person who
is not on the distribution's package manager has no single file to install, no
signed artefact and no update road. Flatpak is built; this is the other half.

## What exists

- `cmake --install` is the whole Linux tree: the runtime, the IDE as a project,
  the shipped libraries, the examples, the documentation, the plugin header
  and the pkg-config file. Measured here: **14 MB, 520 files**, of which the
  runtime is 7.4 MB and the IDE 2.3 MB.
- `lib/package` writes the Flatpak build context -- the metainfo, the
  `.desktop`, the icon, a copy of the project and the manifest -- and
  `tools/pack` is its command line. `tests/pack` reads every file back.
- `tests/install.sh` installs into a staging prefix and starts the *installed*
  IDE on a display of its own.
- CI's `package` job builds a minimal tarball (libxml2 and libsecret hidden on
  purpose) and the Windows zip/setup. `docs/installing.md` documents all three.
- Flatpak is the sandboxed road: a BaseApp, the IDE and an example in a static
  repository of its own.

## What was measured

Measured on Fedora 44, from the staged `/usr` tree of a full development build:

- **The runtime/IDE RPM**: 2.6 MB compressed, 10 MB installed, 610 entries.
  `rpmbuild`'s `AutoReqProv` found the shared libraries by itself
  (`libgtk-4.so.1`, `libgtksourceview-5.so.0`, GLib, Cairo, Pango, and the
  optional libs this build linked), and the package answers
  `mimehandler(application/x-bintana-project)` and `pkgconfig(bintana)`.
- **The application RPM** for `examples/hello`: 15 KB, with
  `Requires: bintana >= 0.3.1`, the project under
  `/usr/share/bintana/apps/bintana-hello`, a launcher, the menu entry, the
  metainfo and the icon.
- `bin/bintana-ide` resolves its data relative to its own location, so a
  package does not bake a prefix into it and a relocated tree still works.
- `dpkg-deb` is not installed on this Fedora host, so the `.deb` half is
  measured in a Debian/Ubuntu container in Stage 0.
- **Every command maps GTK today.** `bintana --version` maps 153 libraries,
  and `LD_DEBUG=libs` shows `calling init` for `libgtk-4`, `libgtksourceview-5`
  and `libvte-2.91-gtk4`; `bintana check tests/smoke` and a `main` project
  (`tests/pack`) do the same. Maximum RSS was 37 MB for `--version`, 45.6 MB
  for the `main` and 49.4 MB for `check`. This is the headless plan's Phase 0
  evidence, and the reason a package built today cannot be installed on a
  machine without GTK even for `check`.

**The tarball is minimal on purpose; a distribution package is not.** The
tarball hides libxml2 and libsecret so a downloader needs no optional library.
`lib/package` and `Metainfo` use `Xml`, so the IDE needs libxml2 to package a
project at all. A distro package is built with the distro's optional
dependencies and lists them; the tarball keeps hiding them.

## Decisions

**One runtime family, many application packages.** The runtime is shared; an
application package carries only its project, launcher and metadata. How many
packages the runtime itself is depends on the headless host, and that is the
one boundary this plan does not freeze yet:

- **If headless Phase 1 says no:** one `bintana` package with the runtime, the
  IDE and the shared data.
- **If it says yes:** `bintana` is the console host and the dispatcher,
  `bintana-gui` is the graphical host (GTK, GtkSourceView and VTE), and
  `bintana-ide` is the IDE data, its launcher and its menu entry, depending on
  both. A `main` application depends on `bintana`; a `startup` application
  depends on `bintana-gui`; the IDE package depends on `bintana-ide`.

**`bintana-desktop` is the name to publish before the split.** It keeps
`bintana` free for the core: before headless it is the one GUI package; after
the split it is a meta-package depending on `bintana`, `bintana-gui` and
`bintana-ide`, so an installed user keeps the name and gains the console host
without a renamed package to migrate from.

| artefact | runtime | GTK / GtkSourceView | updates |
|---|---|---|---|
| `.deb` | `Depends: bintana` (and `bintana-gui` when headless) | the distribution's | apt repository |
| `.rpm` | `Requires: bintana` (and `bintana-gui` when headless) | the distribution's | dnf repository |
| AppImage | core, plus the GUI host for a windowed application | bundled | AppImageUpdate / a new file |
| Flatpak | both hosts in `/app/bin` | the runtime | `flatpak update` |

**The package boundary waited on headless Phase 1.** The headless plan's Phase 0
and Phase 1 decide whether `bintana` is one binary or a console host plus a GUI
host. **Phase 1 now passes (2026-11-12):** `bintana-meta` answers the class
metadata, `PropertyNames`, `Methods` and `Members` with `Doc`, with `forms.js`
loaded and no GTK in its link (15 libraries against 153), so the split is the working
layout and the names above are not placeholders. The staging layer in Stage 1
takes a list of hosts and a list of data directories, never one hard-coded
binary.

**The core `bintana` package still waits for the rest of Phase 2**, because
`bintana-headless` today runs `check` and not an arbitrary project's `main`;
until that runner and the installation exist, the package that ships is
`bintana-desktop`. The staging code is written for the split list now, not for
one binary. The console binary is 4.1 MB and 17 libraries, and
`bintana-headless check` already matches the graphical check byte for byte.

**`Package` stays the Flatpak context.** `Deb`, `Rpm` and `AppImage` are
separate classes beside `Nsis`, because each one consumes a different tree and
a different external tool: a `.deb`/`.rpm` installs into a system prefix and
depends on `bintana`; an AppImage needs a runtime prefix and its libraries;
the Flatpak manifest is a build context for `flatpak-builder`. A `Format`
option on `Package.Write` would put three different inputs behind one name.

**The packages are built by native tools, not by a writer of our own.**
`dpkg-deb`/`dpkg-shlibdeps` and `rpmbuild` already know the dependency names
and the file format; `lib/package` owns the staging, the metadata and the
refusals, and calls the tool. A missing tool is a sentence naming it, the way
`Exporter` names `tar`.

**No custom updater.** apt and dnf update from a signed static repository;
Flatpak updates itself; AppImage embeds the update information AppImageUpdate
reads. A single `latest.json` may later power a "new version available"
notice, but it does not install anything.

**Signing is a release key, and CI never gets it in a pull request.** The owner
generates the key and stores it as a secret. CI signs when the secret is
present and says *unsigned* otherwise. The public key ships in the release and
in the repository's instructions. A private key is never committed.

**A package version is not free text.** `project.btp.version` is free text on
purpose; a `.deb`/`.rpm` version must start with a digit and follow the
format's rules. The packager accepts `x.y.z` (and `x.y` as `x.y.0`) or a
`--version` override, and refuses anything else with a sentence rather than
guessing at `~`/`-` mappings.

**Maintainer and licence come from the project, or from the caller.** The
metainfo carries the project licence; the packager reads it. It has no email,
and a Debian control file needs one, so an application package takes
`--maintainer "Name <email>"` and refuses without it. The runtime package uses
the release owner's constant. Nothing invents an address.

## Sequencing with the headless host

`headless-runtime-plan.md` is the gate for the package boundary, not for the
whole distribution. Its Phase 0 measures the closure and its Phase 1 proves
that `Widget.*` and `bintana check` can answer without GTK; together they are
about a week, and Phase 1 is the technical risk. Run them before Stage 1 here,
and do not publish a package whose name or dependency list would have to move
afterwards.

Stage 0 here -- the `.deb` in a container and the AppImage spike -- can run
alongside Phase 0/1: it measures the installed tree, the external tools and
the clean-container run, none of which depends on how many hosts the tree has.
The staging code in Stage 1 takes `Hosts` and `Data` lists, so the same code
builds the one-package layout and the split one.

If Phase 1 says no, the one `bintana` package is the answer and distribution
continues as written. If it says yes, freeze the `bintana`/`bintana-gui`/
`bintana-ide` names after the phase, and let Phase 2/3 of the headless plan
land while Stage 2/3 here build the packages; the package split is then a
question of which files and dependencies go in which package, not a second
design.

## Stages

### 0. Spike, measured (1-2 days)

- Build the `.deb` in a `debian:13` container and install it with
  `apt install ./bintana_*.deb`; run `bintana --version`, `bintana check` on an
  installed example, and `bintana-ide` under `Xvfb`; remove it and check the
  caches.
- Build the AppImage with `linuxdeploy --plugin gtk`, plus GtkSourceView's
  libraries and data, and run it with `--appimage-extract-and-run` in an
  `ubuntu:24.04` container that has no GTK installed. Measure its size and
  what it still asks of the host.
- Install the RPM in a `fedora:44` container (the build on this host already
  succeeded) and repeat the same checks.

**The decision this stage makes:** whether the AppImage bundles GTK and
GtkSourceView (the self-contained answer the issue asks for) or only the
runtime and says it needs GTK 4.10+. The number that decides is the measured
size and a clean-container run, not a guess.

### 1. The staging layer and the two package formats

- `lib/package/Linux.js`: the shared tree -- `usr/share/bintana/apps/<command>`
  (the project, without hidden entries), `usr/bin/<command>` (the launcher),
  `usr/share/applications/<id>.desktop`, `usr/share/metainfo/<id>.metainfo.xml`,
  `usr/share/icons/hicolor/<dir>/apps/<id>.<ext>` and
  `usr/share/doc/<command>/copyright`. It reuses `Package.configOf`,
  `Metainfo`, `Package.iconOf`, `Package.topLevel` and `Package.copyProject`.
- `lib/package/Deb.js`: `DEBIAN/control`, `postinst`/`postrm`, the copyright
  file and `dpkg-deb --build`; `Depends` from `dpkg-shlibdeps`, not a list
  written twice.
- `lib/package/Rpm.js`: the `.spec`, `%files`, the scriptlets and `rpmbuild`;
  `AutoReqProv` is what finds the libraries.
- A runtime mode: stage the `cmake --install` tree, add the package metadata
  and build the `bintana` package. No project copy.
- `tools/pack.sh` gains `--deb`, `--rpm`, `--runtime-deb` and `--runtime-rpm`,
  one subcommand per invocation, the way `--nsis` already works.
- Refusals before the first write: no id, no metainfo, no icon, a metainfo that
  disagrees with `project.btp`, an output inside the project, a missing runtime
  prefix, a missing external tool and a version that is not packageable.

### 2. CI and the release

- The `package` job builds the `.deb` and `.rpm` from the staged tree, runs
  `dpkg-deb -I/-c`, `rpm -qpi/-qpl`, and installs each into a clean container
  for the version and the project check.
- A tag attaches both files beside the tarball, the Windows zip and the setup.
- The first release needs one target per format: Ubuntu 24.04 for the `.deb`
  and Fedora 44 for the `.rpm`. More distros are more matrix rows, not a
  second design.

### 3. AppImage

- `lib/package/AppImage.js` writes the AppDir from the same staging layer and
  calls `appimagetool`; `AppRun` is the launcher of the IDE or of the
  application.
- Bundle GTK, GtkSourceView and their data (`schemas`, `pixbuf` loaders, icon
  themes, `gtksourceview-5` specs) according to what Stage 0 measured.
- Embed the update information and sign the file; `.zsync` beside it.
- Test in a clean container with no GTK and with FUSE absent
  (`--appimage-extract-and-run`).

### 4. Signing, repositories and updates

- A static apt repository (`Packages`, `Release`, `InRelease`, `Release.gpg`)
  and a static dnf repository (`repodata`, signed `repomd.xml`), both published
  the way `getbintana/flatpak` publishes its own.
- `rpm --addsign` and the apt repository's metadata signature; `debsigs` only
  if the standalone `.deb` has to be signed as a file, which is a separate
  question from trusting the repository.
- `docs/installing.md` gains the two repository lines, the AppImage download,
  the public key, and what updates each road uses.

### 5. The IDE's own door (optional)

*Project → Package…* with a format choice and a file chooser, the `Installer`
shape: save dirty tabs, call the format class, log the output. It is optional
because a package is a release step, and the CLI is what CI and a packager
need; the menu is a convenience for the person who has the tools installed.

## Tests and docs

- `tests/pack`: the control file, the `.spec`, `%files`, the launcher, the
  desktop entry, the metainfo and the icon; every refusal writes nothing; the
  version and maintainer rules.
- `tests/packages.sh`: a Debian/Ubuntu container and a Fedora container install
  the package, run the runtime and the project check, start the IDE under
  `Xvfb`, and uninstall. Skips a format whose tool is absent, like the suite
  already does for `desktop-file-validate`.
- `tests/install.sh` stays as the prefix test; a package is metadata around the
  tree it already proves.
- `tests/api.sh` and the JSDoc comments for the new public members.
- `docs/installing.md`, `docs/agents/packaging.md` with the traps,
  `docs/testing.md` with the counts, `CHANGELOG.md`, and the issue is deleted
  when all four artefacts are built.

## What is deliberately not here

- **Flathub.** It rejects applications generated by AI; the project's own
  repository is the channel, and that decision is in `flatpak-plan.md`.
- **Snap, MSIX, macOS and a cross-architecture matrix.** Each is a platform
  port, not a package format.
- **An update daemon of our own.** The package managers and AppImageUpdate are
  the roads; a notice is not an installer.
- **Bundling glibc or building GTK.** The AppImage follows the platform's
  glibc rule, and the floor is the GTK 4.10 one the runtime already has.
- **A package per distribution release.** Ubuntu 24.04 and Fedora 44 are the
  first row; the matrix grows when somebody needs a row.

## Prior art

AppImage, `dpkg-deb`/`apt` and `rpmbuild`/`dnf`, Flatpak, and
`electron-builder`'s one configuration for several formats. The lesson from
the last one is the shape of this plan: one staging layer, one metadata model,
and a thin adapter per format.
