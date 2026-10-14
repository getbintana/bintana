# Packaging and Flatpak

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Flatpak, and the packaging step

**One identity runs through the whole chain.** `project.json`'s `id` becomes
`Application.Id`; the runtime hands it to `GtkApplication` (Wayland's app id) and
to the program name (X11's `WM_CLASS`), so it is the window's class; the
project's `<id>.metainfo.xml` declares the same string; and a package installs
under it. The IDE asks for it when a project is created, *Project settings*
renames the metainfo when it changes, and the runtime refuses one that is not an
application id **at load**, naming the key.

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

**And a package's file dialog is the desktop's portal, with no other.** GTK
routes a sandboxed application's chooser through
`org.freedesktop.portal.Desktop` — `gdk_running_in_sandbox()` is just
`/.flatpak-info`, and `gdk_display_should_use_portal` returns `TRUE` before it
probes anything — so a desktop whose portal cannot start gives the application
**no file dialog at all**, silently, which reads as the application being
broken. `bintana-project` was reported exactly that way. A GTK application run
from a source tree is not sandboxed, probes the portal, and falls back to its
own chooser when the probe fails; that is the difference between the IDE and a
package, and not a difference in the code. **Why this machine's portal could
not start, since the symptom names the application and the cause is nowhere
near it**: xdg-desktop-portal 1.22 added `Requisite=graphical-session.target`,
an Xfce session never activates that target, and `RefuseManualStart=yes` on the
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
