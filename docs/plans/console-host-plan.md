# The console host: what is left

**Status: open items, none started (2026-11-13).** The console host exists:
`bintana` runs `--version`, `check`, a project's `main` and its tests with no
toolkit in the link, and execs `bintana-gui` for a project that declares
`startup`. How it was built, what was measured and why each decision went the
way it did is [`notes/headless-runtime.md`](../notes/headless-runtime.md);
`tests/headless.sh` holds the two hosts to each other. What follows is what
the headless plan left open when it closed. The Windows split went to
[`distribution-plan.md`](distribution-plan.md), because a package is what
needs it.

Each item is a commit of its own with a test that goes red without it, and
the rule that governs all of them is the one this work kept running into: **a
program is the same program under `bintana` and `bintana-gui`**. Where the two
hosts answer differently, that is the bug.

## 1. One console installer

The globals a console program is written with are installed in three places
that copy one list: `install_globals` (`bta_runtime.c`), `install_core`
(`bta_headless.c`) and `task_build_worker` (`bta_task.c`). They have drifted:
a `Task` worker has no `Key`, `Keyring`, `Desktop` or `Network`, and a
`Desktop.Entries.Write` in a task is a `ReferenceError` instead of a sentence.

- One `bta_console_install(ctx, global, mode)` in a shared file. The main mode
  installs what `install_core` installs now; the worker mode uses the variants
  that exist (`bta_http_init_worker`, `bta_socket_init_worker`,
  `bta_serial_init_worker`, a read-only `Environment`, `Exec` reduced to
  `Wait`), and what needs the main loop refuses by name.
- Each host adds its own on top; `bta_task_worker_host` is already that shape
  for a worker.
- Decide, for each of the four a worker lacks, whether it is deliberate.
- The `globals` fixture prints what a `Task` sees, in both hosts.
- **Not** a `bintana` process per task: `Lock` is a table in the process, a
  hard cancel interrupts the interpreter in the same process, and every task
  would pay the core's start-up.

## 2. Refusals for the graphical names

`Dialog`, `Screen`, `Clipboard`, `Printer` (all but `Papers`), `Tray`,
`Notification`, `Popover`, `Probe`, `Media`, `AudioPlayer`, `Video` and
`PdfDocument` are empty objects in the core, so `Application.Globals()` names
them and `check` does not invent "not declared". Calling one is
`TypeError: not a function`. Each should refuse with what it needs -- a
display, GStreamer, poppler -- and the name of the host that has it.

- `check` could say it before a run: a `main` project that calls `Dialog` or
  `Clipboard` has written something that cannot work.

## 3. The boot both hosts share

`bta_project.c` is the shared half of the boot (the manifest, `uses`, the
library search, the load order) and `bta_language.c` the context. Left in
`bta_runtime.c`: `bta_app_new`/`bta_app_free` and the order globals go in. The
core has its own sequence in `run_project` and `run_check`; one boot that both
call is what keeps the next difference from growing in the gap. The old
`objcopy` step and any dead code the split left go in the same pass.

## 4. The language half of the prelude

`forms.js` is one block and keeps its helpers to itself (2026-11-13); `rad.js`
is still one scope with the program, so `runTests`, `testMethods`,
`defaultsFor`, `sameValue`, `plainData`, `savableValue` and the rest are
globals a program can call or replace and the IDE offers to complete. Some are
shared with `forms.js` on purpose, and C calls `runTests` by name. The way out
is the one `forms.js` took: a block, and the names C and `forms.js` need handed
over through a hatch the runtime deletes.

## 5. Questions to settle

- **`Application.Executable` in the graphical host** answers the graphical
  binary, so the IDE's *Run* starts `bintana-gui` for a `main` and maps GTK.
  Answer the console host when it is beside it, or accept the cost and say so.
- **The runner's freshness check** (`tests/run.sh` warns when a source is
  newer than the binary) has to look at both binaries and the drawing module.

## 6. Acceptance not yet run

- `./tests/asan.sh` and `./tests/alone.sh` on this work.
- `bintana --version`, `bintana check` and a `main` on a machine with **no
  GTK installed** (a container), not only a link with none in it.

## 7. Measured, not decided

- **libsoup, GnuTLS and libsecret on first use**, as the drawing module is
  loaded: they are most of the 25 libraries and about 6 MB of resident memory
  the console globals cost every run, `--version` included.
- **`"display"` read by more than the core**: `check` could warn when a `main`
  uses such a library, the IDE could grey it out in a `main` project's library
  list, and `lib/package` could know a console application needs no display.
