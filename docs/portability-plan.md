# Portability: a plan, not a feature

**Nothing in this document is implemented.** What it depended on is: the IDE's
output pane is a read-only `TextEditor` over `Exec`, `Terminal` is optional at
build time (`BTA_HAVE_VTE`) and `Widget.Available` is what hides a control this
build cannot run — so nothing on the IDE's critical path needs VTE, which has no
Windows port. See [`widgets.md`](widgets.md#a-build-without-vte) and
[`ide.md`](ide.md#running).

The target is **native Windows**, built with **MSYS2 / MinGW-w64 (UCRT64)**.
The scope is deliberately narrow: **the runtime and the IDE compile and run,
and the examples with them.** The test suite and CI, packaging/installer, and a
real Windows terminal are out of scope here and listed at the end.

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
| VTE | **does not exist on Windows** — and nothing needs it: `BTA_HAVE_VTE` is already optional, and the class without it draws, loads and answers, refusing only the three verbs that need a child |
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
| `CMakeLists.txt` | `find_library(M_LIB m)` and `pthread` only where they exist; `-Wall -Wextra` guarded to GCC/Clang; VTE absent (`BTA_HAVE_VTE` undefined); install layout unchanged (`bin/` beside `share/bintana/` is the hop `lib_candidates` already walks) |
| `runtime/src/bta_sys.c` | the process layer: no `killpg`/`kill`/`setsid`. `g_subprocess_get_identifier` returns `GetProcessId()` on Windows (GLib documents it), so a PID is a real PID; `g_subprocess_force_exit()` (GLib ≥ 2.80) replaces `Kill`, and `taskkill /T /F` over the PID is what reaches what a wrapper started, since Windows has no process groups here. `exec_child_setup`'s `setsid` compiles out. `uname()` becomes `g_get_os_info()`. `HasDisplay` answers `true` on Windows — a Windows session offers a display, and `tests/runner` must not go looking for `xvfb-run` |
| `runtime/src/bta_runtime.c` | `g_file_read_link("/proc/self/exe")` twice (`Application.Executable`, `lib_candidates`) becomes `GetModuleFileNameW`; `BINTANA_LIB_PATH` splits on `G_SEARCHPATH_SEPARATOR` (`:` splits `C:\...` in two); the `/usr/share/bintana/lib` fallback is harmless |
| `runtime/src/bta_locale.c` | `%'.*f` is a POSIX printf flag UCRT does not implement; `Locale.Number`/`Currency` for doubles go through the hand-written grouping `locale_group` already does for decimals, or are proven against MinGW's ANSI printf. Asserted by `Locale.Number` and the `JsonFiles` decimal-comma test |
| `runtime/src/main.c` | console UTF-8 (`SetConsoleOutputCP(CP_UTF8)` / the UCRT's `.UTF-8` locale) and the subsystem decision: a console build keeps `print`/`Logger` output when launched from a shell, which is what the IDE's Run and the suite want |
| `bta_journal.c`, `bta_terminal.c` | no work: both are already stubbed without their dependency, and everything either stub needs (`signal.h`, `sys/wait.h`) is inside the `#ifdef` |

QuickJS is already portable, and the two patches in `vendor/` — arithmetic on
a `Decimal`, and `js_atod` for JSON numbers — are platform-independent, so
nothing there changes.

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
  traceback is clickable, Stop works, and the terminal tab is correctly
  absent (no VTE on this platform yet) — as is the palette's `Terminal` button.
  The `no-vte` CI job already runs the whole suite that way on Linux, so what is
  left to find here is Windows and not the stub.
- The console-tool projects, which need no display, are the first part of a
  future Windows CI: `tests/api`, `tests/icons`, `tests/styles`.

## Out of scope here, and why

- **The test suite and CI.** The four windowed projects need a real desktop
  session, and `tests/install` (Xvfb + xdotool) and `tests/icons`/`styles`
  (they read the Linux theme off the disk) are Linux-only as they stand. A
  second plan, and the first caller that wants it.
- **Packaging.** A ZIP or an installer with the DLLs collected (`ntldd`), a
  `bintana-ide.cmd` launcher and a Start-menu entry. The runtime's own
  install layout is already right; what is missing is a Windows face for it.
- **A real terminal on Windows.** ConPTY (Windows 10 1809+) plus an emulation
  core — MSYS2 has `libvterm` — behind the same `Terminal` surface. That is its
  own plan, and the day it lands `Available` becomes true and the IDE's tab
  appears by itself.

## Risks

- **No process groups.** A `Stop()` that signals a wrapper is not enough on
  Windows; `taskkill /T` over the PID is the pragmatic answer, Job Objects the
  complete one. The runner's hang guard is the caller to test it with.
- **Fonts, metrics and icons** differ from the Linux desktop, so `.form`s
  drawn with a Linux theme can measure differently on Windows. That is the
  same class of finding `examples/` already exists to measure.
- **`%'` and the console codepage** are silent-wrong-answer territory, which
  is why both are asserted and not eyeballed.
- **Never mix MSVC GStreamer with MinGW GTK4** — two GTK4 copies in one
  process. The ecosystem is picked once, at Stage 0.
