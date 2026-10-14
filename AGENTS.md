# AGENTS.md

Guidance for coding agents working **on** this repository: the runtime, the
IDE, the shipped libraries and their tests. Read it top to bottom before the
first change; it is short on purpose. Everything it states briefly is argued,
measured and dated in [`docs/agents/`](docs/agents/) and
[`docs/notes/`](docs/notes/) — the [index](#index-read-it-when) at the end
says which file to open for which kind of change.

- [`README.md`](README.md) — what Bintana is and how it is used.
- [`docs/architecture.md`](docs/architecture.md) — how the runtime fits
  together: boot, the C/JS split, the class table, dispatch, lifetimes.
- [`docs/extending.md`](docs/extending.md) — read it before adding a widget,
  a property, an event or a global.
- Writing an *application* with Bintana is documented elsewhere:
  [`bintana-docs`](https://github.com/getbintana/bintana-docs) (reference and
  the compact `llm/` contract) and
  [`bintana-llm`](https://github.com/getbintana/bintana-llm) (the guide).

## The repository

| path | what it is |
|---|---|
| `runtime/src/` | the runtime in C: widgets, globals, the loader (`bta_*.c`) |
| `runtime/js/rad.js`, `runtime/js/forms.js` | the JavaScript prelude — **baked into the binary**, a rebuild is needed after editing either |
| `runtime/include/bta_plugin.h` | the only header a native plugin compiles against |
| `lib/` | the libraries shipped with the runtime (`charts`, `report`, `markdown`, `dialog`, `xlsx`, `package`, …); a project names them in `uses` |
| `ide/` | the IDE, itself a Bintana project: `ide/forms/` (a `.form` beside its `.js`) and `ide/modules/` |
| `tests/` | the suite: Bintana projects, plus console tools driven by their `.sh` |
| `tools/` | generators and desk tools (`apijson.sh`, `llms.sh`, `pack.sh`, …), also Bintana projects |
| `vendor/quickjs` | submodule: quickjs-ng plus eighteen patches of ours, on the fork [`getbintana/quickjs`](https://github.com/getbintana/quickjs), branch `bintana` |
| `examples/` | example applications; several are run by the suite |
| `api.json` | the public surface as data, generated — never edited by hand |
| `docs/` | technical documentation for working on the runtime |

`.js` and `.form` files under `ide/`, `tests/` and `examples/` are read at
run time and need no rebuild. **`rad.js` and `forms.js` do**, and nothing
warns when you invoke `./build/bintana` by hand: the suite then tests the
previous prelude and every assertion that should fail passes.
`tests/run.sh` warns when a source is newer than the binary.

There is no Python in the repository. A desk tool is a Bintana console
project (`"main"` in `project.json`) with a short `.sh` in front of it.

## Build

```sh
git submodule update --init                      # once, QuickJS is a submodule
cmake -S . -B build && cmake --build build -j    # needed after any C change
```

Required: `gtk4` **4.10 or newer**, `gtksourceview-5` (with headers),
`gmodule-2.0`, pkg-config. Optional, each reported by CMake either way:
`sqlite3`, `libsystemd`, `libsoup-3.0`, `gstreamer-1.0`, `vte-2.91-gtk4`,
`libxml2`, `libsecret-1`, `sysprof-capture-4`. Package names per
distribution are in [`docs/installing.md`](docs/installing.md), with the
`Xvfb`/`xdotool`/`openssl` the suites need.

- **Build both ways before touching anything under an `#ifdef`** of an
  optional dependency: a `pkg-config` wrapper that answers "no" for one module
  is the whole of it, and CI has a job per such build. See
  [`build-and-tools.md`](docs/agents/build-and-tools.md).
- **The floor is GTK 4.10, and CI runs older libraries than a current
  distribution** (Ubuntu 24.04: GCC 13, GTK 4.14, glib 2.80, libxml2 2.9).
  Check every new GTK/GDK function, enumerator *and signal* against its
  `GDK_AVAILABLE_IN_*` or GIR version, not against the machine you build on.
- An unset `CMAKE_BUILD_TYPE` is `Debug` (about four times slower); measure
  speed only on `RelWithDebInfo` or `Release`.
- A new `.c` file goes in `add_executable(bintana …)` by hand; the signature
  extractor globs and will already see it, so a missing line looks half
  registered and fails only at link.

## Commands

```sh
./tests/run.sh                                    # whole suite
./tests/run.sh widgets                            # one project
./tests/run.sh widgets record                     # one test of it (case-sensitive)
./tests/run.sh ide designer                       # one project, up to one phase
./tests/run.sh ide list                           # what a project can be asked for
BINTANA=/other/bintana ./tests/run.sh             # suite against another build
TIMEOUT=2400 ./tests/run.sh                       # a slower machine
BINTANA_PROFILE=/tmp/caps ./tests/run.sh          # a Sysprof capture per project
./tests/asan.sh                                   # suite under AddressSanitizer (clang)
tests/try.sh <project> [args...]                  # run any project on a virtual display
./tests/api.sh                                    # is the documented surface the real one, is api.json current, do links land
./tools/apijson.sh                                # rewrite api.json
./tools/llms.sh                                   # rewrite llms-full.txt from llm.txt's list
./tests/icons.sh                                  # which declared icons the desktop has, and which draw
./tests/styles.sh                                 # which style classes the theme defines
./tests/install.sh                                # stage `cmake --install` and run a plugin against it
./tests/pack.sh                                   # what lib/package writes, read back
./tests/bench.sh                                  # interpreter benchmarks (not part of run.sh)
```

**Nothing an agent runs may open a window on the user's screen.** `run.sh`
and `asan.sh` default to a virtual display (`HEADLESS=${HEADLESS-1}`), and
`tests/try.sh` is the way to run anything else — `HEADLESS=1 ./build/bintana`
is *not*: the binary ignores that variable. A run on a real screen also fails
assertions (another theme, another font, focus stolen by a click). `HEADLESS=`
(empty) is for a question about the real desktop that you can say out loud.

**When a tool, a package or a permission is missing, ask the person at the
machine.** If `Xvfb` is not installed, ask for it: another virtual display
(a headless Wayland compositor, for instance) produced dozens of false layout
failures. Do not improvise substitutes for a missing tool, a failed push or a
denied permission.

These need a real display and should be said out loud before running:

```sh
./build/bintana ide examples/hello                # the IDE
./build/bintana examples/hello                    # a project on its own
LANGUAGE=es ./build/bintana ide examples/hello    # the IDE in Spanish
```

Copy a project to a scratch directory before driving it by hand: a stray drag
plus a save edits `examples/` for real.

## Keep the documentation true

**Any change to the API, the runtime or the widgets is documented in the same
change** — not afterwards, not only in a commit message. A fact that lives
anywhere but where it is read gets rediscovered at the cost of an afternoon.

Three repositories, and a change crosses them in one direction:

- **`bintana`** (this one): the code, the description beside each member, and
  `api.json` — built by `./tools/apijson.sh`, held to the C by `./tests/api.sh`.
- **`bintana-docs`**: the pages an application author reads. Its `check.sh`
  holds every page to `api.json`; its `tools/docs.sh` writes member rows from
  it. Point it at your `api.json` (`BINTANA_API=$PWD/api.json`), or it checks
  the previous surface.
- **`bintana-llm`**: the guide for writing an application with no IDE.

| a change to | goes in |
|---|---|
| a widget's property, method or event | **its description in the comment above its C entry**, then `./tools/apijson.sh`; the row in `bintana-docs` is generated from it |
| a library in `lib/` | a JSDoc comment on the declaration, `./tools/apijson.sh`, and its page `docs/llm/<library>.md` in `bintana-docs` |
| a global (`File`, `Exec`, `Locale` …) | `api.json`, plus `runtime-api.md`/`llm/library.md` in `bintana-docs` and its section in that repo's `check/Check.js` |
| the `.form`, `project.json` or the serialiser | `formats.md` and `llm/forms.md` in `bintana-docs` |
| what `cmake --install` lays down | [`docs/installing.md`](docs/installing.md), and `tests/install.sh` must pass |
| the plugin ABI or loader | [`docs/plugins.md`](docs/plugins.md); `tests/plugins/testplug.c` is the reference |
| how a widget, property or event is added | [`docs/extending.md`](docs/extending.md) |
| an intrinsic of the language | `llm/language.md` in `bintana-llm` |
| a gap reported in `docs/issues/` | **delete the issue file** and its rows in `docs/issues/README.md` and `docs/llm/issues.md` |
| anything a test now proves | [`docs/testing.md`](docs/testing.md), and the counts it quotes |
| a trap you walked into | the file of its area in [`docs/agents/`](docs/agents/); a line here only if it is a rule for every change |

The rest of the rule:

- **A member's description is written once, beside it.** C: the comment above
  the entry, signature on the first line, description after it
  (`/* Load(path) -> string` …). JavaScript (`rad.js`, `forms.js`, `lib/`): a
  JSDoc comment that *touches* the declaration; a plain `/* */` is never read.
  `tests/api.sh` fails on a public member with no description.
- **A new property, method, event or global is not finished until
  `./tests/api.sh` passes** — and it also fails while `api.json` or
  `llms-full.txt` is stale, or a relative link in the docs lands nowhere.
- **Read the counts a check prints.** A check that stops seeing something
  (a new `bta_emit*` spelling, a table its parser cannot read) goes quiet, not
  red; the total moving is the only sign.
- **An answered issue is deleted, not archived** — a refusal is an answer, and
  a finished plan goes the same way. Git keeps the history.
- **The numbers in a document are part of it.** A stale count reads as
  authoritative as a fresh one; `./tests/run.sh` prints the three that matter.
- **If you had to read the C to find something out, or were surprised, write
  it down** — in `docs/agents/<area>.md`, with what you measured.

Detail, and what the checks can and cannot see:
[`docs/agents/documentation.md`](docs/agents/documentation.md).

## The rule that governs this codebase

**The IDE is written in Bintana and has no privileged API.** When the IDE needs
something the runtime lacks, the fix is a runtime feature every application
then gets — never a special case in the IDE. And the corollary: before writing
C, check whether the thing is expressible as a Bintana form (`AskForm` and
`ConfirmForm` are dialogs, not primitives).

- **Every file of the IDE is a module.** A file says `export class <Name>`
  named like the file; what another file uses is exported where it is
  declared and reached by its bare name with no `import`. A missing export
  stops the load with `ReferenceError: X is not defined` at the use, or with a
  list of the uses at load.
- **The IDE's tree is `forms/` and `modules/`**, and a folder a tool named
  (`TOOL_DIRS` in `ide/modules/Classes.js`) is not a node in the project view.
  No folder name is a namespace.
- **`tests/ide` loads the real `ide/**/*.js`.** Its `.form` files are symlinks
  to the IDE's own: a form added to the IDE is a symlink added there, and its
  `.js` goes in `tests/ide/project.json`'s `sources`.
- **The workspace (palette, tree, canvas or editor, property grid) is built per
  tab** by `ide/modules/Workspace.js`; a widget built in code is not published
  on the form, so a new per-tab widget needs its line in
  `TabSet.placeContent`.

More: [`docs/agents/ide.md`](docs/agents/ide.md).

## Runtime architecture: the contract

**All widget classes share one `JSClassID`.** What makes a `Button` a `Button`
is its prototype; the hierarchy is assembled in one loop in
`bta_widgets_init` from rows each module contributes with
`bta_register_classes`, and **a parent must be registered before its
children**. Adding a widget is a `build` function filling `w->gtk` (what the
parent lays out), `w->inner` (the control proper) and `w->slot` (where a
container's children go), a `JS_CGETSET_DEF` array, and one registrar row.

**Events dispatch by name, and by `On`.** `bta_emit(w, "Click", …)` reads
the control's own `On` handlers, then calls `<w->name>_Click` on `w->form`; a
form's own events use the literal name `Form` (`Form_Open`). Returning `true`
from `KeyPress` consumes the key. Raise a widget event with `bta_emit`,
`bta_emit_ok` or `bta_emit_answer` — `bta_emit_on` is the menus' road and
skips `On` silently.

**The `.form` format knows no control.** The loader assigns each property as
an ordinary JS assignment through the real setter (properties first,
`Arrangement` first and `Action` last, then children). The serialiser in
`rad.js` is its exact inverse: it saves every accessor with **both** a getter
and a setter whose value differs from a fresh control's. So **a property added
in C is designable, serialisable and editable with no other change**, and a
read-only accessor is excluded by construction. A property's legal values are
declared in its class row (`BTA_CLASS_ENUM` and an `options` function), and a
property that holds text a person reads is declared with `BTA_CLASS_TEXT`;
both are published (`Widget.PropertyOptions`, `Widget.TextProperties`) and
drive the property grid, translation and the extractor. A component written
in JS declares the same through `static Events`, `static Options`,
`static TextProperties`.

**A class answers about itself with no control built** —
`Widget.PropertyNames/Methods/EventNames/Members(type, …)` resolve the name
like `Widget.New` and never touch GTK (they work in a console project).

**A project declares `startup` or `main`.** `main` names a function, never
initialises GTK, cannot make a widget, and ends when nothing is owed an answer.
It is for tools, never for tests: a test that does not go through GTK proves
nothing about a GTK binding.

**A file with `export` is a module**: what it exports reaches every other file
by bare name, the rest is private. A bare class name resolves the way
JavaScript does — the project's declaration before a runtime global.
Details: [`docs/agents/modules.md`](docs/agents/modules.md),
[`docs/agents/runtime.md`](docs/agents/runtime.md).

## Rules for C in the runtime

Each of these was paid for; the evidence is in the linked file.

**Lifetimes** ([`lifetimes.md`](docs/agents/lifetimes.md)):

- Controls point back at their form, so the graph has cycles: **report every
  held `JSValue` in `gc_mark`**, or forms are never collected. A `JSValue` in a
  wrapper's opaque slot is marked and freed in the finaliser with
  `JS_FreeValueRT` — no `JSContext*` carried beside it.
- A `JSValue` held from C across an async boundary is invisible to the
  collector: **free it on every exit path**, including teardown and the branch
  that gives up — `JS_FreeRuntime` aborts on anything left. When you write a
  give-up branch, read the success branch beside it and account for every
  release.
- **Every path that adds a child calls `bta_widget_adopt`, every path that
  removes one `bta_widget_release`**, and a verb that brings a control into a
  container asks `bta_widget_bring_in` first.
- **A finalised `BtaWidget` must not be reachable from GTK**: connect signals
  on anything that is not the widget through `bta_widget_watch`, and unwatch a
  replaced object, since the watch holds a reference.
- **No JavaScript runs inside a GTK signal that disposes or hides**; mark and
  queue an idle that holds a reference, not a pointer.
- A callback the program can replace mid-call is `JS_DupValue`'d across its
  own call. A source queued from a worker thread holds a job reference, not an
  id.
- **ASan does not see QuickJS's arena**: a small `JS_FreeCString` followed by
  a use is invisible to `tests/asan.sh`. Read the C; a clean ASan run is not
  evidence for `JSValue`s, `GBytes` or glib rc boxes.
- Read the transfer annotation of every GLib/soup getter before freeing what
  it returns; `get` usually lends.

**Arguments, numbers and refusals** ([`runtime.md`](docs/agents/runtime.md)):

- Numbers from JS go through `bta_to_number`/`bta_to_int`, never a bare
  `JS_ToInt32` (which turns anything into 0); paths through `bta_file_path`,
  never `JS_ToCString` (which turns `undefined` into `./undefined`).
- QuickJS pads `argv` to the declared arity: check `argc` before reading
  `argv[0]`. An empty `JS_EXCEPTION` with nothing thrown is a crash in some
  builds — throw a sentence.
- The runtime never throws `JS_ThrowInternalError` (uncatchable upstream);
  use `JS_ThrowPlainError`, `TypeError` or `RangeError`.
- A conversion that can throw is either reported or consumed — never left
  pending for whoever calls into JS next.
- Convert everything **before** touching what you are filling, so a refusal
  leaves the list, menu or tree as it was.
- Format numbers for CSS, JSON or a test with `g_ascii_formatd`/`g_ascii_dtostr`:
  `printf("%g")` writes the locale's decimal comma. Never quote a GLib
  `err->message` in an error: it is translated.
- A subclass member must not shadow a base member's name (`Widget.Expand`,
  `Widget.Remove`, `Widget.Resize`); check the base table before naming.
- A property setter does not raise an event; a `.form` applies properties in
  alphabetical order, so apply configuration where the configured thing is made.

**The language** ([`quickjs.md`](docs/agents/quickjs.md)):

- Most of `Object` is gone (`Object.assign`, `keys`, `freeze` …), as are
  `RegExp` (use `Regex`), `Promise`, `async`, `await`, `import()` and
  `localeCompare` (use `Locale.Compare`). Use `Dictionary` and `hasOwn`, never
  `key in bag`, which answers for `toString`.
- The eighteen patches in `vendor/` **do not fail to build when dropped**;
  `tests/widgets` asserts each of them. A patch goes in a checkout of the fork
  on branch `bintana`, and the submodule moves to the resulting commit. Fetch
  before trusting a remote-tracking ref in the submodule.

## Tests

Seven Bintana projects under `tests/` are the suite (`ide`, `markdown`, `qr`,
`report`, `smoke`, `widgets`, `xlsx`); a directory with a `project.json` that
does not declare `main` is a test project, and nothing lists them. Write
assertions the way the suite already does. Details and traps:
[`docs/agents/testing.md`](docs/agents/testing.md).

- **Event tests make the round trip**: assign from JS, let GTK emit the real
  signal, assert the handler ran. Testing the JS side alone proves nothing.
- **Assert the effect, not the flag** that was supposed to cause it, and put
  the bug back once to watch the test go red.
- **Wrap `Form_Open` in `try`/`catch`** in a test project, or a throw hangs the
  run until the timeout. A test that throws on purpose takes
  `Application.OnError` first.
- **A frame is not a promise**: wait with `until(cond)`, never count frames,
  and never assert that something has *not happened yet*. Re-measure a
  rectangle before every gesture.
- **Anything that depends on layout needs a frame first**; `Form_Open` runs
  before the window is presented.
- A test that waits must be counted, or a condition that never comes true is a
  smaller total instead of a red line.
- A provider's or handler's arguments are the toolkit's: a test that invents
  them tests itself. Raise events with `Emit` rather than calling handlers by
  name.
- A test about the room around something sets the room; settings files the
  suite shares are somebody else's state.
- `tests/ide` phases are a narrative: a run can stop early
  (`run.sh ide <phase>`) but not start late. `tests/widgets` tests run alone;
  declare couplings in `NEEDS`.

**Verifying by hand** (rendering, real input, focus, window management) asks
in this order: the running application (`Dump()`, `Bounds()`), then
`tests/probe.sh` on a capture, and only then a look. Do it on an `Xvfb` of
your own with a real window manager, never on the user's display. See
[`testing.md`](docs/agents/testing.md#verifying-by-hand).

## Git

- **`git checkout <file>` throws away every uncommitted change in it.** Undo a
  probe with the inverse edit or `git stash` first.
- **The push is the repository owner's.** The remote is SSH and an agent's
  shell usually has no key: commit locally, leave any tag made, and say the
  commands. Do not reach for HTTPS, tokens or other remotes.
- **A commit says who wrote it.** The machine owner is the author (the
  repository's own `user.name`); the agent goes in a `Co-Authored-By:` trailer
  naming the agent and the model that actually wrote the change. Never copy the
  previous commit's trailer; if you do not know your own name, ask.

## Index: read it when…

Traps and their evidence, by area, in `docs/agents/`:

- [`documentation.md`](docs/agents/documentation.md) — you change the public surface, or a check says something you do not understand.
- [`build-and-tools.md`](docs/agents/build-and-tools.md) — you touch CMake, an `#ifdef`, CI, a compiler- or GTK-version question, or a desk tool.
- [`runtime.md`](docs/agents/runtime.md) — you add a property, method, event, global or plugin verb, or convert arguments.
- [`lifetimes.md`](docs/agents/lifetimes.md) — you hold a `JSValue`, connect a signal, add an async job, or free anything.
- [`quickjs.md`](docs/agents/quickjs.md) — you touch `vendor/quickjs`, rebase the fork, or wonder why a builtin is missing.
- [`modules.md`](docs/agents/modules.md) — you touch `export`/`import`, the loader or `bta_module.c`.
- [`testing.md`](docs/agents/testing.md) — you write a test, a test is flaky, or you verify something by hand.
- [`profiling.md`](docs/agents/profiling.md) — you measure speed, read a Sysprof capture or `perf`, or wonder whether something is expensive.
- [`layout.md`](docs/agents/layout.md) — you touch `Fixed`, anchors, boxes, `Split`, margins, or lay out a form.
- [`widgets.md`](docs/agents/widgets.md) — you touch a GTK widget: lists, popovers, menus, drag and drop, icons, themes, editors, calendars.
- [`tables.md`](docs/agents/tables.md) — you touch `TableView`: sorting, cell editors, links, geometry.
- [`ide.md`](docs/agents/ide.md) — you change the IDE: designer, tabs, git panel, commands, recovery.
- [`data.md`](docs/agents/data.md) — you touch `Record`, `Xml`, `Database`/`Table`, `Csv`, `Decimal` or JSON.
- [`drawing.md`](docs/agents/drawing.md) — you touch `Painter`, `DrawingArea`, `Drawing`, printing or a drawing library.
- [`media-desktop.md`](docs/agents/media-desktop.md) — you touch `Video`/`AudioPlayer`, `Keyring`, `Notification` or desktop entries.
- [`network.md`](docs/agents/network.md) — you touch `Http` or TLS.
- [`i18n.md`](docs/agents/i18n.md) — you touch translation, the extractor or `.po` files.
- [`packaging.md`](docs/agents/packaging.md) — you touch `lib/package`, Flatpak or the CI registry of applications.

Design narratives — why something is the way it is — in `docs/notes/`:

- [`library-promotion.md`](docs/notes/library-promotion.md) — how a library becomes a default (`lib/dialog`).
- [`ide-completion.md`](docs/notes/ide-completion.md) — how the IDE completes names by asking the runtime.
- [`drawing-document.md`](docs/notes/drawing-document.md) — `Drawing`: a document with no display.
- [`probe.md`](docs/notes/probe.md) — why `Probe.Image` is not a verb on `File`.
- [`crypto-gzip.md`](docs/notes/crypto-gzip.md) — `Random`, `Hmac`, `Gzip`: what was measured.
- [`zip-xlsx.md`](docs/notes/zip-xlsx.md) — the zip reader and the `.xlsx` writer.
- [`charts.md`](docs/notes/charts.md) — `lib/charts`: the kinds, the format, the document's window.
- [`task-threads.md`](docs/notes/task-threads.md) — `Task`: what a thread costs here.
