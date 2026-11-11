# Portability: a plan, not a feature

**Windows is below. macOS has a plan of its own in
[macos-plan.md](macos-plan.md)** — a Homebrew build plus a portable `.app`,
cheaper than this one because every guard here that says "not Windows" already
does the right thing on Darwin.

**In progress.** The `windows` job in `.github/workflows/ci.yml` builds with
MSYS2/UCRT64, runs `tests/api.sh`, runs the project pass (`tests/check.sh`) and
stages a portable zip (`tools/windows-portable.sh`), which is Stage 0/1 as far
as it has got: what it proves is the build, that the runtime runs, and that the
staged tree it ships runs too. The smoke suite is the first windowed project
there, as a **diagnostic** step (`tests/run.sh smoke`, 171 assertions on a real
Windows 11 desktop, 2026-11-10); the rest of the windowed suite is still the
out-of-scope list at the end. The terminal has landed since: ConPTY plus
libvterm, behind the same `Terminal` surface, and the IDE's tab appears by
itself. The zip itself is unverified until somebody opens it on a Windows
desktop. The
Stage 1 pieces that are in: the CMake guards (`gio-unix`, `libm` and pthread
only where they exist), the process layer (`setsid`/`killpg` compiled out,
`g_subprocess_force_exit` as the one ending `Stop` and `Kill` have, `uname`
asked of GLib, `HasDisplay` true), `bta_exe_path` in place of `/proc/self/exe`,
`G_SEARCHPATH_SEPARATOR` for `BINTANA_LIB_PATH`, the console's UTF-8 code page,
and `%'` replaced by the same grouping written out. `Exec`'s `Control` stream is
**refused with a sentence** on Windows rather than accepted and ignored: it is a
descriptor a child inherits by number, and there is no such thing there.

What the port depended on is: the IDE's output pane is a read-only `TextEditor`
over `Exec`, and `Terminal` is optional at build time and answers through
`Widget.Available` — so a build without a terminal backend still hides the
control instead of offering one that would refuse. Linux's backend is VTE, which
has no Windows port; Windows' is ConPTY (Windows 10 1809+) plus libvterm, in
`bta_terminal_win32.c`. See
[`widgets.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/widgets.md#a-build-without-vte) and
[`ide.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/ide.md#running).

**The build environment and the `windows` job carry GStreamer with
gst-plugins-rs and poppler now** (2026-11-10). `Video` answers
`Widget.Available("Video") == true` and `PdfDocument.CanRead` is true on
Windows, measured with a console project in the environment; the job installs
the same packages, so the halves are compiled on every push instead of being
found out by whoever unzips the tree.

The target is **native Windows**, built with **MSYS2 / MinGW-w64 (UCRT64)**.
The scope is deliberately narrow: **the runtime and the IDE compile and run,
and the examples with them.** The terminal has landed (ConPTY + libvterm); the
rest of the windowed suite the build environment, and packaging/installer are
out of scope here and listed at the end.

## Why this is possible

The C is almost entirely GLib/GTK4/cairo and compiles for Windows unchanged.
The dependencies exist in MSYS2's `mingw64`/`ucrt64` repositories at versions
that match this tree:

| Dependency | Windows |
|---|---|
| GTK4 | `mingw-w64-ucrt-x86_64-gtk4` (4.22) |
| GtkSourceView 5 | `mingw-w64-ucrt-x86_64-gtksourceview5` |
| libsoup3 | `mingw-w64-ucrt-x86_64-libsoup3` |
| sqlite3 | `mingw-w64-ucrt-x86_64-sqlite3` |
| GStreamer + GTK4 sink | `gstreamer` + `gst-plugins-rs`, whose `/mingw64/lib/gstreamer-1.0/libgstgtk4.dll` is `gtk4paintablesink` (the official GStreamer 1.28 Windows installers carry it too — but they are MSVC, and **must not be mixed** with a MinGW GTK4) |
| poppler | `mingw-w64-ucrt-x86_64-poppler`, whose `poppler-glib.pc` turns on `PdfDocument`'s reading half and `lib/pdfview` |
| VTE, and the terminal | **VTE does not exist on Windows.** The backend is ConPTY (Windows 10 1809+) plus `mingw-w64-ucrt-x86_64-libvterm`: the child gets a real console, libvterm interprets its VT output, and `bta_terminal_win32.c` draws the grid. `BTA_HAVE_LIBVTERM` is optional exactly as `BTA_HAVE_VTE` is; without it the class draws and refuses only the three verbs that need a child |
| QuickJS | vendored, and already has native `_WIN32` paths; no pthread needed |

The GTK4 Win32 backend implements `request_layout`/`compute_size`, so
`GdkSurface::layout` — which `Form_Resize` rides — fires there as it does on
Wayland/X11.

## Stage 0 — toolchain spike (2–3 days)

Configure and build with the packages above before changing anything, and
collect the real error list. Expected, in order: `/proc/self/exe`, `killpg`,
`setsid`, `uname`, the `BINTANA_LIB_PATH` separator, `%'` in the locale
formatting, and `HasDisplay` reading environment variables Windows does not
have. The spike's deliverable is that list confirmed against the tree — every
shim below already has its place.

## Stage 1 — the platform layer (1–2 weeks)

| File | Work |
|---|---|
| `CMakeLists.txt` | `find_library(M_LIB m)` and `pthread` only where they exist; `-Wall -Wextra` guarded to GCC/Clang; VTE absent (`BTA_HAVE_VTE` undefined) and libvterm optional (`BTA_HAVE_LIBVTERM`); install layout unchanged (`bin/` beside `share/bintana/` is the hop `lib_candidates` already walks) |
| `runtime/src/bta_sys.c` | the process layer: no `killpg`/`kill`/`setsid`. `g_subprocess_get_identifier` returns `GetProcessId()` on Windows (GLib documents it), so a PID is a real PID; `g_subprocess_force_exit()` (GLib ≥ 2.80) replaces `Kill`, and `taskkill /T /F` over the PID is what reaches what a wrapper started, since Windows has no process groups here. `exec_child_setup`'s `setsid` compiles out. `uname()` becomes `g_get_os_info()`. `HasDisplay` answers `true` on Windows — a Windows session offers a display, and `tests/runner` must not go looking for `xvfb-run` |
| `runtime/src/bta_runtime.c` | `g_file_read_link("/proc/self/exe")` twice (`Application.Executable`, `lib_candidates`) becomes `GetModuleFileNameW`; `BINTANA_LIB_PATH` splits on `G_SEARCHPATH_SEPARATOR` (`:` splits `C:\...` in two); the `/usr/share/bintana/lib` fallback is harmless |
| `runtime/src/bta_locale.c` | `%'.*f` is a POSIX printf flag UCRT does not implement; `Locale.Number`/`Currency` for doubles go through the hand-written grouping `locale_group` already does for decimals, or are proven against MinGW's ANSI printf. Asserted by `Locale.Number` and the `JsonFiles` decimal-comma test |
| `runtime/src/main.c` | console UTF-8 (`SetConsoleOutputCP(CP_UTF8)` / the UCRT's `.UTF-8` locale) and the subsystem decision: a console build keeps `print`/`Logger` output when launched from a shell, which is what the IDE's Run and the suite want |
| `runtime/src/bta_plugin.c` | no work of its own: GModule names the suffix (`.dll`) and does the load, and the plugin contract is a table of function pointers, so a plugin compiled by MSVC, MinGW or clang links nothing and needs no export list. `BTA_PLUGIN_EXPORT` is the one platform line, at the plugin's side of the header |
| `bta_journal.c`, `bta_terminal.c`, `bta_terminal_win32.c` | the journal is already stubbed without its dependency; `bta_terminal.c` keeps the shared surface and VTE, and the Windows half is ConPTY + libvterm in its own file. Everything VTE's stub needs (`signal.h`, `sys/wait.h`) is inside the `#ifdef`; the Windows half uses `windows.h` and `vterm.h` only under `G_OS_WIN32` |

QuickJS is already portable, and the patches in `vendor/` — arithmetic on
a `Decimal`, `js_atod` for JSON numbers and the rest — are platform-independent,
so nothing there changes.

## Stage 2 — the IDE and the examples (1–2 weeks)

- `Application.Executable` now answers with the real `.exe`, which is what the
  IDE's Run spawns and what `tests/runner` re-invokes.
- External tools the IDE calls are all present or reported: `tar` ships with
  Windows 10+ as `tar.exe`, and `msgmerge`/`msgfmt` come from MSYS2's gettext;
  `Application.HasCommand` already guards both, so a missing one is a sentence
  and not a crash.
- `Logger.Target = "Journal"` answers *not available* with no code change (the
  stub is already there).
- Walk every example — `hello`, `calculator`, `agenda`, `quote`, `clients`,
  `notes`, `drawing`, `charts`, `report`, `usage`, `jokes`, `http`, `serve`,
  `session`, `video` — and write down what the platform changes: fonts and
  metrics, icon names the Windows GTK theme lacks, menus and shortcuts, the
  file dialogs, drag and drop, and `Video`'s sink being a plugin.
- The IDE designed on Windows must save a form that Linux reopens and vice
  versa; the `.form` is text and the paths inside it are relative.

## Verification

- `cmake -S . -B build && cmake --build build -j` under MSYS2 UCRT64, no
  `-DBTA_HAVE_*` forced at all and again with sqlite/soup/GStreamer/VTE absent
  — the stubs are part of the deliverable.
- `./build/bintana.exe examples/hello`, then `./build/bintana.exe ide
  examples/hello`: the IDE opens, the log view shows a run's output, a
  traceback is clickable, Stop works, and the terminal tab is **present**:
  `Terminal.Available` is true, `Run(["cmd.exe"])` gives a prompt, `ssh` runs
  as an ordinary child, and `Exit` reaches the form. The `no-vte` CI job runs
  the whole suite against a build without a backend on Linux, so the stub is
  already covered; what is left to find here is Windows.
- The console-tool projects, which need no display, are the first part of a
  future Windows CI: `tests/api`, `tests/icons`, `tests/styles`.

## Out of scope here, and why

- **The rest of the suite and CI.** `tests/check.sh` checks every project with
  no window, and `tests/smoke` runs (171 assertions, 2026-11-10); the other
  windowed projects, `tests/install` (Xvfb + xdotool) and `tests/icons`/`styles`
  (they read the Linux theme off the disk) are Linux-only as they stand. A
  second plan, and the first caller that wants it.
- **Packaging.** The ZIP exists (`tools/windows-portable.sh`, attached by the
  `windows` job), and the installer is `lib/package/Nsis.js` behind *Project →
  Windows installer…*: an NSIS script out of the project's metainfo, staged
  from the running tree, compiled on Windows by the `makensis` the tree ships
  under `share/bintana/tools/nsis`. What is still missing is a signature (no
  certificate) and an end-to-end run of a produced installer on a real desktop
  -- CI builds the compiler bundle but cannot click through a setup.

## Risks

- **No process groups.** A `Stop()` that signals a wrapper is not enough on
  Windows; `taskkill /T` over the PID is the pragmatic answer, Job Objects the
  complete one. The terminal uses a `KILL_ON_JOB_CLOSE` job per child so
  `ClosePseudoConsole` and process exit leave no grandchildren. The runner's
  hang guard is the caller to test it with.
- **Fonts, metrics and icons** differ from the Linux desktop, so `.form`s
  drawn with a Linux theme can measure differently on Windows. That is the
  same class of finding `examples/` already exists to measure.
- **`%'` and the console codepage** are silent-wrong-answer territory, which
  is why both are asserted and not eyeballed.
- **Never mix MSVC GStreamer with MinGW GTK4** — two GTK4 copies in one
  process. The ecosystem is picked once, at Stage 0.
