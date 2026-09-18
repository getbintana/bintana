# macOS: a plan, not a feature

**Not started.** The deliverable is the runtime and the IDE running natively on
macOS: built from Homebrew dependencies, shipped as a portable `.app` bundle,
with the examples. The scope is agreed and narrow: **Homebrew + a portable
`.app`**, verified by **a `macos` CI job plus an external tester with a Mac**
(the machine this tree is developed on is Linux, and its owner has none), with
**`Terminal` degrading the way it does on Windows** if what Homebrew ships does
not work. Signing and notarization are out of scope here and listed at the end:
they need the machine owner's Apple Developer account, not a change in this
tree.

This plan is written from reading, not from running: an audit of every
`G_OS_WIN32` / `NOT WIN32` guard and every Unix assumption against Darwin, plus
the Homebrew and CI facts of 2026. Stage 0 exists to confirm it against a real
Mac before anything below is built.

## Why this is cheaper than Windows

The Windows port (`portability-plan.md`) had to redo the process layer, the
binary's own path, the display question, the console codepage and the locale
grouping. On macOS none of that applies: it is Unix, and the guards already in
the tree uniformly do the right thing there.

| Question | Windows (what it cost) | macOS (what it costs) |
|---|---|---|
| Processes (`setsid`, `killpg`, groups) | rework: no groups, `force_exit` + `taskkill` | nothing: `killpg`/`setsid`/`pipe` + fd 3 are identical POSIX on Darwin (`bta_sys.c`) |
| The binary's own path (`/proc/self/exe`) | rework: `GetModuleFileNameW` | one `__APPLE__` branch: `_NSGetExecutablePath()` + `realpath()` |
| `HasDisplay` | rework: always true | one line: `__APPLE__` answers true (Quartz sets no `DISPLAY`) |
| Console UTF-8 / `%'` grouping | rework both | nothing: UTF-8 natively, Darwin libc implements `'` |
| `Exec`'s `Control` stream (`gio-unix`) | refused with a sentence | nothing: `gio-unix-2.0` ships with Homebrew GLib |
| `Terminal`/VTE | no port exists, stub mandatory | probably works (`vte3` bottles `vte-2.91-gtk4`); the stub already covers it if not |
| `Logger.Target = "Journal"` | stub (no systemd) | stub (systemd is Linux-only by design; terminal logging is the answer) |
| QuickJS vendored | already portable | nothing: bottles arm64, no JIT so no extra entitlement |

The dependencies exist in Homebrew at versions that match this tree:

| Dependency | Homebrew |
|---|---|
| GTK4 (Quartz backend, no XQuartz) | `gtk4` (4.22) |
| GtkSourceView 5 | `gtksourceview5` (5.20) |
| GLib/GIO/GModule/`gio-unix-2.0` | `glib` |
| libsoup3 | `libsoup` |
| sqlite3 (≥ 3.25; keg-only, needs `PKG_CONFIG_PATH`) | `sqlite` |
| GStreamer + Rust plugins | `gstreamer` (1.28, plugins merged in) |
| VTE | `vte3` (ships `vte-2.91-gtk4`) — verify, then degrade if absent |
| `gtk4paintablesink` | inside `gstreamer`, or the official 1.28 macOS framework — verify with `gst-inspect-1.0` |
| `gtk4-unix-print` | expected absent (Unix print dialog); the CMake check is already optional and stays that way |
| `libsystemd` | absent by design; the stub is the port |

One rule carries over from Windows unchanged: **never mix ecosystems** — all of
Homebrew, or all of the official GStreamer framework, never half and half (the
MSVC-GStreamer-against-MinGW-GTK4 shape: two GTK4 copies in one process).

## Stage 0 — toolchain spike via CI (1–2 days)

No Mac here means the spike is a CI job, not a shell: add a temporary `macos`
job (`macos-15`, arm64) that installs, builds, and probes. Its log is the
deliverable — every line below is confirmed against the tree, none against a
machine.

```sh
brew install gtk4 gtksourceview5 glib sqlite libsoup gstreamer vte3 \
  pkgconf cmake ninja gobject-introspection meson vala rust
cmake -S . -B build && cmake --build build -j
pkg-config --exists gio-unix-2.0 && echo "gio-unix: present"
pkg-config --exists gtk4-unix-print || echo "unix-print: absent, expected"
pkg-config --modversion vte-2.91-gtk4 || echo "no vte: stub covers it"
gst-inspect-1.0 gtk4paintablesink || echo "no sink: Video refuses, AudioPlayer works"
grep M_LIB build/CMakeCache.txt || echo "no libm entry: read the row in Stage 1"
```

Four answers decide the rest: VTE's `.pc` + pty, the paintable sink, `gio-unix`
present, and what `M_LIB` ended up as in the cache. Everything in Stage 1
assumes the expected ones.

## Stage 1 — the runtime, four tweaks (2–3 days)

| File | Work |
|---|---|
| `runtime/src/bta_sys.c` (`bta_exe_path`) | no `/proc` on Darwin, so it answers NULL and `Application.Executable` degrades to `"bintana"`. Add the `__APPLE__` branch (`_NSGetExecutablePath()` + `realpath()`); without it `lib_candidates` loses two paths |
| `runtime/src/bta_sys.c` (`env_has_display`) | Quartz sets neither `DISPLAY` nor `WAYLAND_DISPLAY`, so a Mac desktop would answer false and the runner would go looking for `xvfb-run`. `__APPLE__` answers true, the same line Windows has |
| `runtime/src/bta_runtime.c` (`lib_candidates`) | the `/usr/share/bintana/lib` fallback is behind SIP and never fires; add `/opt/homebrew/share` and `/usr/local/share`, or drop it — the `<bin>/../share` hop already covers a Homebrew install once the exe path is fixed. `BINTANA_LIB_PATH` splits on `:` there too, so the separator is already right |
| `CMakeLists.txt` (`find_library(M_LIB m)` + `pthread`) | **probably nothing, and Stage 0 is what says so.** The SDK ships `libm.tbd` and CMake resolves it, so the line most likely configures as it stands — which is why it is a probe here and not a finding. If it does not resolve, `M_LIB-NOTFOUND` is a configure error by the file's own comment, and the answer is to guard `m` and `pthread` independently; on Darwin both are libSystem either way |

What is deliberately not in this table: `setsid`/`killpg`, `take_fd`, `poll.h`,
`uname` (it answers `Darwin` + the kernel release — enough unless the UI wants
`sw_vers`), `locale_group_double` (correctly Windows-only), the console codepage
(macOS terminals are UTF-8), the journal and unix-print stubs, and QuickJS. The
optional-dependency pattern (sqlite, soup, GStreamer, VTE, systemd, unix-print)
already degrades correctly wherever Homebrew lacks a package.

## Stage 2 — the test harness (1 week, the actual work)

The runtime will compile; what does not run on a Mac is the suite's X11 spine.
Quartz needs no wrapper and no virtual display — the runners' own literature
says headless setup is not needed on macOS — so every Linux display mechanism
becomes a branch not taken on Apple:

- `tests/runner/Main.js` (`display()`, the `no display and no xvfb-run` abort):
  return the native `{argv:[],env:{}}` on Apple and never force
  `GDK_BACKEND=x11`. **Keying that off the fixed `HasDisplay` is not enough**:
  `display()` asks `HEADLESS` *first*, and `tests/run.sh` exports
  `HEADLESS=${HEADLESS-1}`, so the suite's own front door forces the virtual
  display, finds no `xvfb-run` and aborts before `HasDisplay` is ever read. The
  Apple branch therefore comes before the forced one, and `HEADLESS` is
  documented there as a variable with nothing to name rather than left looking
  honoured: under Quartz there is no second display to send the windows to.
- **The house rule does not survive the crossing, and that is the news.** On
  Linux the suite opens no window on anybody's screen, which is what makes it
  runnable at any moment; on macOS every windowed project opens on the tester's
  real desktop and takes the focus while it runs. The screenshot and the
  interactive checks were already the tester's to run — this hands them the
  whole windowed half of the suite, and the plan says so rather than discovering
  it on their machine.
- `tests/try.sh`: skip the `xvfb-run` wrapper on macOS; the binary runs on
  Quartz directly.
- `tests/probe.sh shot` (`xdotool` + `import`): port to `screencapture` +
  `cliclick`/AppleScript. `pixel`/`region`/`diff` (ImageMagick, brew-installable)
  stay as they are.
- `tests/install.sh` + `tests/install/Main.js` (own `Xvfb :90-99`, `xdotool`
  queries, `desktop-file-validate`, `gio launch`): bring the installed IDE up
  natively; validate `Info.plist` instead of the `.desktop` file.
- `tests/icons` / `tests/styles`: `gtkLibrary()` is two hard-coded directories
  (`/usr/lib64`, `/usr/lib`) *and* a glob (`libgtk-4.so*`), and both halves move.
  Homebrew keeps the library in `/opt/homebrew/lib` on arm64 and
  `/usr/local/lib` on Intel, and the file to match is `libgtk-4.*.dylib`.
  `gresource`, which both tests then run against it, comes with Homebrew's
  glib.
- `tools/bintana-ide.in`: BSD `readlink` has no `-f` (use `realpath` or
  `python3`); macOS `/bin/bash` is 3.2, so re-exec portably.
- Expectations, not code: accelerators are `⌘` not `Ctrl` on the global menu
  bar, the file chooser may be `NSOpenPanel`, fonts and metrics differ from the
  Xvfb theme the numbers were written against. `until()` over frame counts —
  already the rule — covers most of it.

## Stage 3 — the portable `.app` (1 week)

A sibling of `tools/windows-portable.sh`, e.g. `tools/macos-bundle.sh`:

- Layout `Bintana.app/Contents/{MacOS/<exe>,Resources/{ide,examples,lib,icons,gschemas,language-specs},Frameworks/*.dylib}` + `Info.plist`
  (`CFBundleExecutable`, `CFBundleIdentifier`, `NSHighResolutionCapable`).
- Dylib closure the way the Windows script does DLLs: `otool -L`, copy into
  `Frameworks/`, `install_name_tool -change /opt/homebrew/... @executable_path/../Frameworks/...`,
  then `glib-compile-schemas`, `gdk-pixbuf-query-loaders`,
  `gtk4-update-icon-cache`, GtkSourceView's language specs.
- The plugin contract needs no work of its own — GModule abstracts `dlopen`,
  and `G_MODULE_SUFFIX` is `.so` on Darwin too, matching what CMake builds —
  but decide whether the loader also looks for `.dylib`, since that is what a
  Mac author will produce by hand.
- Desktop integration (`bta_desktop.c`, `Desktop.Entries`, the `.desktop` +
  icon lines in `CMakeLists.txt`): Finder ignores `.desktop` files, so this
  becomes `Info.plist` + `open` integration; the `Exec`-quoting helper is
  freedesktop-specific and stays Linux-only.

## Verification

- Build + `tests/api.sh` (parses C and Markdown, needs no display) green on the
  `macos-15` job; the console projects next; the windowed projects directly on
  Quartz, no wrapper.
- The external tester opens the staged `.app`: the IDE opens, Run shows a log,
  Stop works, the terminal tab is present (VTE) or correctly absent (stub), one
  example with `Video` if the sink probe passed.
- `gst-inspect-1.0 gtk4paintablesink` and `pkg-config --modversion
  vte-2.91-gtk4` re-run after any Homebrew or Xcode bump, the same way the
  `Bintana patch` grep follows a QuickJS upgrade.

## Out of scope here, and why

- **Signing and notarization.** `codesign --deep --options runtime`, `hdiutil`,
  `notarytool submit`, `stapler staple` — and the hardened-runtime question for
  plugins of another Team ID (`disable-library-validation`) — need an Apple
  Developer account and the machine owner's hands. An unsigned bundle runs where
  it was built and in CI; a public `.dmg` waits for its owner.
- **A real terminal if VTE fails.** The Windows plan already scoped ConPTY +
  an emulation core as its own plan; on macOS the same fallback (stub, palette
  hides the button via `Widget.Available`) is the agreed answer.
- **`os_log` for the journal.** Terminal logging is the answer, as on Windows;
  a macOS log backend is a feature nobody asked for.
- **Native print-dialog specifics.** `Printer.Send`/`ToFile` go through core
  GTK (CUPS underneath); verify with `gtk4-print-editor` in the tester's
  session rather than designing for it here.

## Risks

- **`gtk4paintablesink` may be missing from the bottle** (in 2025 it needed a
  hand-built `cargo cinstall -p gst-plugin-gtk4`). The design already survives
  it: `AudioPlayer` works without the sink, only `Video` refuses.
- **VTE's `.pc` may exist while the pty misbehaves under Quartz.** The probe is
  `Run`/`Stop`/`Kill` + resize, not the version number; the stub is the floor.
- **Fonts, metrics, icon names and the global menu bar** differ from the Linux
  desktop, so `.form`s drawn under Adwaita measure differently. Same class of
  finding `examples/` already exists to measure.
- **Gatekeeper on a downloaded artifact** (`spctl -a -vv`, quarantine
  attributes) can fail what runs fine from a checkout. Test the quarantine path
  on the tester's machine, not in CI.
- **Homebrew moves.** Formula versions above are 2026 facts, not constants;
  the Stage 0 probes are what notices a rename, which is why they are probes
  and not a list.
