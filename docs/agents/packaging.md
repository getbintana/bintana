# Packaging and Flatpak

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Flatpak, and the packaging step

**One identity runs through the whole chain.** `project.btp`'s `id` becomes
`Application.Id`; the runtime hands it to `GtkApplication` (Wayland's app id) and
to the program name (X11's `WM_CLASS`), so it is the window's class; the
project's `<id>.metainfo.xml` declares the same string; and a package installs
under it. The IDE asks for it when a project is created, *Project settings*
renames the metainfo when it changes, and the runtime refuses one that is not an
application id **at load**, naming the key. **Packaging refuses it too**, in
`Package.configOf`, which every road goes through (`Write`, `Nsis`, the IDE's
user install): the id lands unquoted in the Flatpak `build-commands`, in file
names under `out` and in the setup's registry key, and packaging neither starts
the application nor runs `check` -- before the refusal, `"id": "../x"` wrote
outside `out` and `"a.b;c"` ran `c` in the build. The regex is
`ProjectFile.idValid`'s, copied because `Package.js` is a script and a library
names no other; `tests/pack` puts one list of ids through both.

The packaging step is [`lib/package`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/package.md) — `Metainfo`, the
AppStream file, and `Package`, which writes the four artefacts and the Flatpak
manifest — with `tools/pack.sh` as its command line. The manifest is JSON
(flatpak-builder reads both, and the runtime already writes JSON) and the output
directory is a build context: everything the manifest names is beside it.

**The applications are a registry and not a list in the CI.**
`flatpak/ci/apps/<name>/app.json` is one application — its id, where its source
is, and whether it is packaged from a project (`tools/pack.sh`) or built from a
manifest — and adding an application is adding the directory. `tools/
flatpak-plan` discovers them and prints what has to be rebuilt:
- a new tag, or no state at all, is everything;
- the runtime's paths, `lib/`, the vendor and the packaging tool are the
  BaseApp **and every application**, because a base's files are copied into each
  application at build time;
- `ide/**` or `examples/hello/**` are that one application — which is why the
  base does not carry the IDE or the examples;
- an application's own repository is that application alone, when the commit it
  was built at and its HEAD differ (`watch` is not consulted there: a source
  with a `repo` of its own is checked out shallow, so there is no history to
  diff).

`tools/flatpak-build.sh` builds what the plan names into a publishable
repository — `BaseApp` or registry directories, all of them when none is named
— and [`flatpak/ci/README.md`](../../flatpak/ci/README.md) is the format, the
one-time setup and the workflow that runs both.

Five things cost a build cycle each when this was built, so they are here:
- **AppStream will not compose an application with no icon**, and it says
  `icon-not-found` from `appstreamcli` half a build after the mistake, naming a
  file nobody wrote. `Package.Write` refuses a project with no drawing, and the
  icon is copied as `<id>.<ext>` -- the name the desktop's `Icon=` asks the
  theme for.
- **The BaseApp is baked into each application at build time**, not mounted at
  runtime: the IDE runs with the BaseApp uninstalled, and a runtime change means
  rebuilding and republishing *every* application, in one run.
- **flatpak-builder's state dir has to be on the same filesystem as the build
  dir** (`--state-dir`): the default `./.flatpak-builder` under a btrfs checkout
  and a `/tmp` target is *"not on the same filesystem"* and nothing builds.
- **A `dir` source merges into the build directory** (`flatpak_cp_a` with
  `MERGE`), so a manifest cannot put the project under a subdirectory: the
  generated one copies the top-level names it listed instead.
- **flatpak 1.18.0 to 1.18.2 have a regression** ([#6818]) that makes
  `build-init --base` fail with `lsetxattr(security.selinux): Operation not
  supported`; 1.18.3 fixes it, it is not SELinux (permissive fails too), and CI's
  Ubuntu 24.04 is older than the regression.
- **`icons/` holds the application's drawing and its controls' glyphs, so
  "the first drawing in `icons/`" is a glyph as often as it is the
  application.** `Package`, `Metainfo.create` and the IDE's desktop-entry dialog
  each took the alphabetically first svg/png. All three ask
  `Package.iconOf(project, id)` now: `icons/<id>.svg|png`, else the only
  drawing not named `*-symbolic`, else a refusal naming `icons/<id>.svg`. A PNG
  is measured from its IHDR (bytes 16-23, big-endian), because where it installs
  is its size -- it used to go under `128x128` whatever it was.
- **A copy whose destination is inside its source never ends.** `tools/pack h
  h/dist` copied `dist` into `dist/project/dist`, until the path was too long,
  leaving 9.6 MB behind. `Package.topLevel` compares absolute paths and leaves a
  top-level output out; one nested deeper is refused, since `Directory.Copy` has
  no exclude. And every refusal comes **before** `Directory.Make(out)`, so a
  refused run leaves no half-written build context.
- **`appstreamcli validate` exits non-zero on warnings.** `url-homepage-missing`
  alone is exit 3, and a fresh metainfo cannot know a homepage -- so a test
  asserts on the `E:` lines, not the status. What *was* an error, and shipped:
  `Metainfo.create` wrote an empty `<description><p/>` and copied a multi-line
  Description into `<summary>`; `Metainfo.problems` refuses both now, so
  `Package.Write` cannot hand one to flatpak-builder.
- **The BaseApp's version is written by hand in four places and derived in one.**
  `Package` takes it from `BTA_VERSION`; the manifests, `docs/installing.md` and
  `flatpak-build.sh` spelled `0.1`. `tests/pack` compares them now, and the
  build script installs the base with `--or-update` instead of `|| true`, which
  had turned a failed install into an obscure `build-init --base` error later.
  An application's own manifest is always in what `tools/flatpak-plan` watches
  -- the IDE's was not, so editing its finish-args rebuilt nothing.
- **A regex over a whole file wants `{ Multiline: true }` for `^`.** Without it
  `^branch:` matches nothing, and a version check reads "no version found"
  rather than failing on the real disagreement.

[#6818]: https://github.com/flatpak/flatpak/issues/6818
[#1983]: https://github.com/flatpak/xdg-desktop-portal/issues/1983

## The Windows installer

**The payload list has to mirror the portable tree's optional data.** `Nsis.Stage`
copies GTK's schemas, icon themes, loaders, GtkSourceView's specs, the MIME
database and the shipped libraries -- but it did **not** copy
`lib/gstreamer-1.0`, `libexec/gstreamer-1.0`, `share/gstreamer-1.0` or
`share/poppler`. Measured on Windows 11 (2026-11-11): an 85 MB setup installed
and launched, and the installed runtime answered `Video=false` and
`PdfRead=false`; the portable tree answered true for both. With the four
directories in the list the setup is 125 MB, the installed runtime answers
`Video=true`, `PdfRead=true`, `Terminal=true`, and `tests/pack` asserts all four
are staged. **A smaller setup is not a smaller application when the missing
piece is a plugin directory**, and the only way to see it is to run the
installed tree, not just to compile the installer.

**The payload also carries the third-party licences.** `Nsis.Stage` copies
`share/licenses` (CMake installs Bintana's and QuickJS's there, and
`tools/windows-portable.sh` adds the MSYS2 packages' texts). The setup writes
`$INSTDIR\bintana-installed`; the directory page refuses a non-empty folder
without that marker, and the uninstaller leaves such a folder alone instead of
`RMDir /r` it. The license list and the source-offer caveat are in
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md).

**The project folder travels whole, a database included, and is only
named.** `Package.copyProject` takes every top-level entry but the hidden ones,
and Run starts a program in its project folder -- so a relative
`Database.Sqlite("x.db")` tried under the IDE is in the next setup.
`Package.dataFiles` lists the databases (by extension, `/` separators on every
system); the IDE's installer says them in its closing message and the log,
`tools/pack` prints `carries:` lines, and `Package.Write` answers them in
`Data`. **Not excluded, and not a `bintana check` finding** (decided
2026-11-24): projects ship a database on purpose -- reference data, a starting
copy -- and a warning on every open would be one nobody could silence. How to
ship one is in `bintana-docs`' `first-app.md` and `bintana-llm`'s
`06-data.md`.

**The setup is named after the application** (`Nsis.setupName`:
`<Name>-<version>-setup.exe`, what Windows refuses in a name a dash), and
`Nsis.Script` answers it in `Setup` for `tools/pack` and the IDE's chooser.

**Run from the payload, before installing** (2026-11-24): the staged
`payload\bin\bintana-gui.exe` on `payload\share\bintana\apps\<command>`, started
in `payload` with only `System32` on `PATH` -- the shortcut's target and its
working directory -- loaded `report`, built the menu bar and wrote a PDF to
`DataDirectory`. **Then installed and uninstalled by hand, the same day**
(an agent's silent install is refused: it writes the user's Start Menu,
desktop and registry). The setup wrote the uninstall key (name, version,
location, uninstaller), a Start Menu folder with the application and
*Uninstall*, and a desktop shortcut, each starting `bin\bintana-gui.exe` on the
project in `$INSTDIR`; the application reported `$INSTDIR` as its working
directory. The uninstaller took the key, both shortcuts' places and the whole
`$INSTDIR`, and left `%LOCALAPPDATA%\<id>`, as it should. **The Apps page showed no icon,
publisher or size** -- `DisplayIcon` and `Publisher` were written only when
the project had an icon and the metainfo a developer, and `EstimatedSize`
never. Now `DisplayIcon` falls back to `bin\bintana-gui.exe,0`,
`EstimatedSize` is `${GetSize}` of `$INSTDIR` after the copy (`FileFunc.nsh`),
and `Metainfo.create` names a developer (the id's prefix, `Environment.UserName`)
so a new project has a `Publisher`. **461 MB installed**, 269 MB of it
`bin` -- the largest DLLs video encoders (`libx265`, `avcodec`, `libaom`,
`SvtAv1Enc`) -- and 141 MB `lib/gstreamer-1.0`, for an application that uses
neither `Video` nor audio.

**The Start Menu shortcut starts in `$INSTDIR`** (`SetOutPath` comes before
`CreateShortCut` in `Nsis.Script`), Run in the project folder, and a Linux
menu entry has no `Path=`, so a relative path means three places.

The rest of the end-to-end test, so the next person can repeat it:

```powershell
# stage the tree, then build the IDE's setup from it. The portable tree does
# not carry NSIS: copy the official bundle into
# stage/bintana/share/bintana/tools/nsis first -- CI does the same -- or leave
# that --with out and have makensis on PATH.
tools/windows-portable.sh build stage/bintana
BINTANA=stage/bintana/bin/bintana.exe tools/pack.sh --nsis ide stage/setup \
    --exe stage/bintana-setup.exe --prefix stage/bintana \
    --with share/bintana/examples --with share/doc/bintana \
    --with share/bintana/tools/nsis
# silent, per-user, into a scratch directory; /D must be last
stage/bintana-setup.exe /S /D=C:\Temp\bintana-installed
# then, with only System32 on PATH:
C:\Temp\bintana-installed\bin\bintana.exe --version
C:\Temp\bintana-installed\Uninstall.exe /S
```

The shortcut starts `bin\bintana-gui.exe` with the installed project directory as
its argument -- read back from the `.lnk` and launched -- and the uninstaller
removes the directory, the Start Menu folder and the `HKCU` uninstall key.
`bin\bintana-exec.exe` travels too: every `Exec` starts its child through it,
so the console tools an application runs have no window of their own.

**The `.cmd` beside the executable starts a host by the project's kind, and the
shortcut does not.** `Nsis.Stage` writes one launcher per application, and which
host it starts is the rule the core dispatches on (`bta_project_has_main`): a
project with a `main` runs in `bintana.exe`, and the window the `.cmd` is run in
is its output; one that opens a form -- every application with a `startup`, and
everything that declares neither -- starts `bintana-gui.exe` through
`start ""`, so a double-clicked launcher does not leave a `cmd.exe` behind the
window for as long as it runs. It used to be `bintana.exe` for both, which was
the IDE's own launcher opening with a console behind it; the shortcut was
always the graphical host, which is what a menu entry needs.
The bundled compiler was checked too: the official NSIS 3.12 tree under
`share/bintana/tools/nsis` answered `v3.12` from the installed directory, so a
setup can be built without NSIS installed. There is no `tools/check` beside an
installed runtime, so `bintana check` is a development-tree command and not a
post-install probe.

**File types and URL schemes are the installer's options, not the project's**
(`Nsis.Script(project, out, { Files, Schemes })`, `tools/pack.sh --nsis …
--file invoice=Invoice --scheme myapp`, 2026-11-15). Nothing in the project
format declares them, and the owner chose Windows only for now, so the IDE's
*Windows installer…* passes none: it would have nowhere to keep them between
runs. The script writes `HKCU\Software\Classes`: a ProgID
`<command>.<extension>` with an `open` verb on `"%1"`, `OpenWithProgids` on the
extension, and the extension's default **only when it had none**. A scheme gets
a key with `URL Protocol`. Then `SHChangeNotify(SHCNE_ASSOCCHANGED)` runs through
NSIS's `System` plugin, which the bundled subset carries under `Plugins`. The
uninstaller removes the ProgID, and removes a default or a scheme only while it
is still this installer's: another program may have taken it since. Every
application's verb starts `bintana-gui.exe`, so `FriendlyAppName` on the verb
carries the application's name. Whether *Open with* honours it there has not
been seen yet. `tests/pack` reads the script back, and a script with an
extension and a scheme compiled clean with `makensis` 3.x. **Not yet run:**
installing one and double-clicking a file. The file or URL reaches the program
as `Application.Arguments[0]`, and with `SingleInstance` through the running
instance.

**And a package's file dialog is the desktop's portal, with no other.** GTK
routes a sandboxed application's chooser through
`org.freedesktop.portal.Desktop` — `gdk_running_in_sandbox()` is just
`/.flatpak-info`, and `gdk_display_should_use_portal` returns `TRUE` before it
probes anything — so a desktop whose portal cannot start gives the application
**no file dialog at all**, silently, which reads as the application being
broken. `bintana-project` was reported exactly that way. A GTK application run
from a source tree is not sandboxed, probes the portal, and falls back to its
own chooser when the probe fails; that is the difference between the IDE and a
package, and not a difference in the code. **Why a desktop's portal can fail to
start, since the symptom names the application and the cause is nowhere
near it**: xdg-desktop-portal 1.22 added `Requisite=graphical-session.target`,
a session that never activates that target (some desktops do not), and `RefuseManualStart=yes` on the
target then leaves the portal unstartable — so *every* packaged application
loses its file dialogs at once ([#1983], fixed upstream; a distro package will
carry it). The workaround is a **full** user unit
(`~/.config/systemd/user/xdg-desktop-portal.service` with `Requires=dbus.service`
where the `Requisite` was), not a drop-in: dependency directives merge across
fragments and a `Requisite=` written in `override.conf` is silently ignored.
Measure before blaming the code, from the host and from inside the package —
`gdbus call --session --dest org.freedesktop.portal.Desktop --object-path
/org/freedesktop/portal/desktop --method org.freedesktop.DBus.Properties.Get
org.freedesktop.portal.FileChooser version` answers `(<uint32 4>,)` when it
works, and the package's `gdbus` is there to ask with (`flatpak run
--command=sh <id> -c '…'`).

Two things follow for an application that opens files. The registry entry
declares `finish-args` (`tools/pack.sh --finish-args`), since the default is
only what a windowed program needs — and `--filesystem=home` is still wanted
with a working portal, because the portal hands over one file at a time at a
`/run/user/<uid>/doc/...` path that dies with the session, so a path the
program remembered cannot be reopened.
