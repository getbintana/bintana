# The headless runtime: Phase 0 measured, Phase 1 spiked

**Status: Phase 0 measured, the Phase 1 spike passed, and Phase 2's console
host runs `check`, a project's `main`, and dispatches a `startup` project to the
graphical host (2026-11-12, Linux).** The remaining Phase 2 work is the
installation; the prelude's JavaScript half is carried as data for `check`.
The design is
[`plans/headless-runtime-plan.md`](../plans/headless-runtime-plan.md).

## What Phase 0 measured

The measurements are from Fedora 44, a full development build with every
optional dependency linked, on one machine. `RSS` is `/usr/bin/time -v`'s
maximum resident set; `libs` is the number of lines `ldd` prints.

| command | wall | max RSS | libraries |
|---|---:|---:|---:|
| `bintana --version` | 0.08 s | 37.1 MB | 153 |
| `bintana tests/pack` (a `main`) | 0.43 s | 45.6 MB | 153 |
| `bintana check tests/smoke` | 0.61 s | 49.4 MB | 153 |
| `bintana tests/smoke` (a `startup` + 174 assertions) | 11.75 s | 169.1 MB | 153 |
| `bintana-meta tests/headless/Main.js` | 0.06 s | 9.4 MB | 15 |
| `bintana tests/headless` (the same questions as a `main`) | 0.11 s | 46.3 MB | 153 |

These rows predate the split: the one binary was `bintana`, which is today
`bintana-gui`.

- **`LD_DEBUG=libs` shows `calling init` for `libgtk-4`, `libgtksourceview-5`
  and `libvte-2.91-gtk4` for `--version` and for a `main`**, not only for a
  window. The loader maps them before `main`; no project type is exempt.
- The windowed row includes the suite's own 174 assertions and a real window,
  so it is not a startup number; it is there to show the order of magnitude of
  the graphical path.
- The metadata row is the same questions as the `bintana tests/headless` row,
  asked by the target that links no toolkit. The difference is the closure:
  **153 mapped libraries against 15**, and 46.3 MB against 9.4 MB.
- The build sizes are 7.4 MB for `bintana` and 3.5 MB for `bintana-meta`.
  Those are Debug builds; the release comparison is Phase 3's.

**What this answers.** The headless plan's Phase 0 go/no-go was about whether
the graph is worth it for speed. It is not only speed: a `.deb`/`.rpm` built
today must depend on GTK even when it is installed to run `bintana check`, and
a `--version` maps three graphical libraries. That is the packaging argument,
and it is now measured.

## The audit, confirmed

`runtime/include/bta.h` includes `<gtk/gtk.h>`, and every widget file includes
`bta.h`, so **the compile is not the boundary; the link is.** The class rows and
property tables are the one declaration of what a control is, and they are
spread over fourteen files:

`bta_widget.c`, `bta_controls.c`, `bta_layout.c`, `bta_notebook.c`,
`bta_switcher.c`, `bta_paint.c`, `bta_text.c`, `bta_editor.c`,
`bta_terminal.c`, `bta_menu.c`, `bta_tree.c`, `bta_table.c`, `bta_media.c`,
and the host in `bta_meta.c`.

The rest of the runtime -- the globals, `File`, `Exec`, `Xml`, the database,
the sockets, `Task` -- is already free of GTK in the parts that matter; the
audit's table in the plan is the starting list for Phase 2.

## The Phase 1 spike: the stub path works

The plan offered two roads. **The second one -- compile the widget files with
`BTA_META_ONLY`, stub every property entry and drop `build`/`probe` -- works,
and it needs no metadata generator.** The mechanism is in `bta.h` and
`bta_widget.c`:

- `JS_CFUNC_DEF`, `JS_CFUNC_MAGIC_DEF`, `JS_CGETSET_DEF` and their `2`/`MAGIC`
  variants point at `static inline` stubs. The **name, flags, magic, arity and
  the presence or absence of a setter are kept**, so `Widget.Member` still says
  `Property`, `ReadOnly` or `Method`, and `Params` still comes from the length
  the row declared.
- `BTA_CLASS_AT` drops `build` and `probe` under `BTA_META_ONLY`; the class row
  keeps `name`, `parent`, `options`, `texts`, `events`, `deferred` and
  `available`.
- `bta_widgets_init` skips `JS_NewClassID`/`JS_NewClass` and uses the stub
  constructor. `bta_widgets_cleanup` still frees the prototypes and
  constructors, or `JS_FreeRuntime` would abort.
- The target compiles with `-ffunction-sections -fdata-sections` and links with
  `-Wl,--gc-sections`; every function that would call GTK is unreferenced and
  dropped. `ldd build/bintana-meta` lists GLib, GIO and the C library, and no
  GTK, GtkSourceView or VTE.

The functions the widget files still reach for are supplied by the host:
`bta_lookup_global` (the same bare-name/dotted-name rule, without the
identifier validation), `bta_module_runtime_owns` (false: there is no module
loader here), `bta_dump_error` (a line on stderr) and `bta_current_app` (NULL).
`bta_symbols` is the compiler's symbol pass without the module detection, and
`bta_prelude_sources` hands it the two generated prelude sources; that is what
puts the prelude's `Doc` in `Widget.Members`.

`bta_meta.c` builds a QuickJS context, installs `Widget` and its prototypes,
evaluates the ten captures `forms.js` expects from `rad.js` (plus a stub
`FormPart`), then evaluates `forms.js` itself, and finally the file. It calls
`Main` if the file declares one. That is what lets **the same
`tests/headless/Main.js` run under `bintana-gui` as a `main` project and under
`bintana-meta`**, which is how the test compares them.

The captures are the reflection (`defineProperty`, `prototypeOf`, `ownNames`,
`ownDescriptor`, `objectProto`, `hasOwn`), the `namespaces` list
`Widget.TypeName` reads, and three functions the serialiser's body mentions but
the metadata queries never call. The language half of `rad.js` is not needed
for class metadata; the widget half is.

## What the spike proves, and what it does not

`tests/headless.sh` diffs the two outputs. These answers are identical:

- `Widget.Types()`
- `Widget.PropertyNames("Button")` -- including `DataField`, `Caption` out
- `Widget.Methods("Button")` -- C and `forms.js` together
- `Widget.Members("Button")` -- name, kind, arity, signature, return type,
  `Native` **and `Doc`**, for the C members and the `forms.js` ones
- `Widget.EventNames("Button")`
- `Widget.Member` for a property and for a method
- `Widget.Signature`, `Widget.EventSignature`
- `Widget.TextProperties`
- `Widget.PropertyOptions`
- `Widget.DeferredProperties("RowList")`
- `Widget.Available("Button")`

`Widget.Members("Button")` is the whole row, `Doc` included, for the C members
and the `forms.js` ones: `bta_meta.c` runs the engine's symbol pass over both
generated prelude sources (`bta_symbols` without the module machinery), so the
JSDoc a member carries is attached the way the graphical host attaches it. The
test diffs the whole array, not a projection of it.

**The two gaps, named:**

1. **`SourceEditor.Language` and `.Theme` are GtkSourceView's own lists.** A
   host that does not link GtkSourceView cannot answer them; `editor_options`
   returns `NULL` under `BTA_META_ONLY`, which reads as free-form. The real
   list belongs to the graphical host.
2. **`Video.Available` is the row's `available`, not the machine's probe.**
   The probe is what the graphical host runs; the metadata host drops it.

Neither is a metadata question the IDE asks of a class; both are answers about
the machine or about a library's catalogue, and the graphical host is where
they belong.

`Widget.PropertyNames` now uses the real walk `forms.js` declares on
`Widget.prototype`. The C walk in `bta_widget.c` remains as the fallback for a
host whose prelude did not load; it is not the answer the test exercises.

## What Phase 2 starts from

- The class rows are usable without GTK. **The header is not yet**: `bta.h`
  still includes `<gtk/gtk.h>` for its types, so the core host still compiles
  against GTK even when it does not link it. Phase 2 moves `BtaClass`,
  `BtaWidget` and the row macros into a core header, or gives the metadata
  host its own minimal one.
- `bta_meta.c` is a test host, not a console host: it has no `project.btp`, no
  `File`/`Exec`/`Xml`, no `rad.js` (only the ten captures) and no `check`.
  Phase 2 builds `bta_core_globals.c` and `bta_headless.c` around the same
  rows.
- **Do not move `check` to the graphical host to make the spike easier.** The
  whole point is that `check` is the console path; it needs `Widget.*` and the
  C metadata, which this spike proves are there.

## Phase 2: the console host, first slice

**The console host is `bintana`; the graphical host is `bintana-gui`.**
`bintana` is the first real console runtime: `--version`, `check`, a project's
`main` and its tests, and the dispatch of a window project to the graphical
host, with no GTK in the link. It is not a test host -- it loads `tools/check`, `lib/check`, and
an arbitrary console project with the libraries its `uses` names -- and both
hosts install.

| command | wall | max RSS | libraries |
|---|---:|---:|---:|
| `bintana --version` | 0.00 s | 9.8 MB | 44 |
| `bintana check examples/hello` | 0.09 s | 24.1 MB | 44 |
| `bintana check ide` | 5.49 s | 38.6 MB | 44 |
| `bintana-gui check ide` | 5.58 s | 60.3 MB | 153 |
| `bintana tests/headless/projects/run` (a `main`) | 0.02 s | 13.4 MB | 44 |
| `bintana-gui tests/headless/projects/run` | 0.04 s | 43.3 MB | 153 |
| `bintana tests/headless/projects/draw` (`Drawing`) | 0.05 s | 27.5 MB | 44 |
| `bintana-gui tests/headless/projects/draw` | 0.13 s | 56.9 MB | 153 |

The `check ide` rows are the same pass, and their output is byte for byte the
same (`--json` too); the core uses less memory and maps no toolkit.
The `check` rows are the Debug build (`build/`). On `RelWithDebInfo`
(`build-rwd`) the same check is **1.57 s and 36.7 MB** against **1.62 s and
57.6 MB** for the graphical binary; `--version` is 9.8 MB. The project rows are
`RelWithDebInfo`: a `main` over a tiny library costs the core **13.4 MB against
43.3 MB**, and a `Drawing` document with a logo **27.5 MB against 56.9 MB** --
the toolkit is mapped before the graphical runtime's `main` even reads
`project.btp`. The binary is **3.4 MB**
in the Debug build and **7.9 MB** with `RelWithDebInfo`'s symbols -- a packager
strips them; the metadata document it loads for `check` is **1.7 MB**.

**How it is put together.** The core `bintana` links **no widget file**. At build
time `bintana-meta --dump` writes `check/widgets.json` from the real class rows,
their property tables, both preludes and the generated signatures;
`runtime/js/widget-meta.js` reads that document and answers `Widget.*` from it.
`bta_sys.c` is compiled with `BTA_HEADLESS`, which leaves `Screen`, `Dialog`,
`Clipboard` and the GTK `File.Open` out and keeps `File`, `Directory`, `Exec`,
`Hash` and `Environment`. **`bta_project.c` is the boot both hosts share**:
`project.btp`, `uses`, the six-place library search and the order sources load
in. It has no toolkit in it, so `bintana` resolves a library the same
way `bintana` does instead of keeping a second answer. `bta_headless.c` is the
rest of the host: core globals, `Application`, `rad.js`, then either the
project's libraries, sources and `main`, or -- for `check` only -- the metadata
document, `bta_modules_scope`, `lib/check` and `tools/check`'s `main`. The
files `bta_runtime.c` would have supplied -- `bta_lookup_global`,
`bta_dump_error`, `bta_symbols`, `bta_split_doc`, `bta_read_file`,
`bta_drain_jobs` and the error text -- are in the host.
`bintana-meta` is the generator and the test; it is not installed.

**`bintana <project>` runs a `main`.** The words after the project are
`Application.Arguments`, exactly as the graphical runtime hands them over. A
`main` that names a widget sees no `Widget` at all -- the metadata is a `check`
document, not a toolkit -- and the language's own `ReferenceError` is the
answer, not a stub that pretends.

**`bintana test` is the same split.** A console project's `tests/*Test.js`
run here, with `runTests` from rad.js and no toolkit; a window project's tests
are exec'd as `bintana-gui test ...`, because the tests build widgets. `--json`
and the filter travel unchanged.

**A project that declares `startup` is exec'd as the graphical host**, with
every word, descriptor and the exit status unchanged. The decision is made from
the manifest before any QuickJS context exists -- the top-level object is read
for a string `"main"` -- because a window project must not pay to start the
language before the toolkit. `$BINTANA_GUI` names the host; otherwise
`bintana-gui` beside this binary is used. A candidate that resolves to this
process is skipped, so the dispatch can never exec itself forever.

`tests/headless/projects/` holds the fixtures the shell test uses: a console
project with a library, a window project, and one that asks `typeof Widget`. The
window fixture is exec'd against a fake graphical host the test writes, so the
dispatch is watched without opening a window; a `main` is run with the same
fake in place and must not dispatch at all.

**What is deliberately a stub.** `Message`, `Dialog`, `Screen`, `Clipboard`,
`Printer`, `Tray`, `Notification`, `Desktop`, `Popover`, `Keyring`, `Http`,
`Socket`, `SerialPort`, `Database`, `Task`, `Media` and the rest of the
graphical/optional surface are **empty objects**, so `Application.Globals()`
answers the same names the graphical host has and a check does not report a
false "not declared". A project that calls one gets a `TypeError` today; Phase 3
replaces each with its refusal sentence. `Application.Replacements()` is empty
for the same reason: this host does not close the hatches, so the names are
still there. The widget classes are not stubs in the binary: they do not exist
until `check` loads the metadata; then `widget-meta.js` installs names that
throw on construction and answer the metadata questions.

**The drawing plugin spike (2026-11-13).** `tests/headless/drawing_plugin.c`
is a real plugin built with cc and cairo, loaded by `uses: ["drawing"]`, that
offers a subset of `Drawing.SavePdf` and `Painter` as methods. The fixture
`tests/headless/projects/drawplugin` draws 20,000 line pairs in **35.2 ms**;
the same loop through the linked `Drawing` (`drawspeed`) takes **51.3 ms**.
That is **not** pure ABI overhead: the native painter records every call for
`Dump()` and validates its arguments, and the spike does neither. What it does
show is that cairo can live in a plugin, that the core can drive a painter
through `host->call`, and that the boundary is not the hot-path catastrophe it
looked like. A real `lib/drawing` would still need the full API, a JavaScript
façade for the property/class semantics, Pango text and images, and a decision
between `uses: ["drawing"]` and load-on-first-use. The linked code stays until
that exists.

**Native plugins are core too.** A project's `uses` resolves a library
directory and, when it holds `<name>.<suffix>`, the core loads it before
`rad.js` and before the project's sources, with `host->call` available. The
suite's reference plugin is the fixture: `tests/headless/projects/plugin` with
`uses: ["testplug"]`. A plugin that cannot load is a sentence on stderr and exit
2, as in the graphical host. That is the road by which `taglib` -- or a
`drawing` plugin -- can be optional.

**Drawing is core.** `Painter`, `Metrics`, `Bitmap` and `Drawing` are in the
host -- cairo, Pango and GdkPixbuf, none of GTK -- so a `main` writes a PNG or a
PDF and measures text with no display. `DrawingArea`, which needs a widget, is
the GUI's. **The report's document half is core too:** `lib/report` and
`lib/charts` define `ReportDocument`/`ChartDocument` always, and their
`Report`/`Chart` controls only when `Component` exists, so a `main` lays out and
writes a report with `uses: ["report", "charts"]` and no display. `PdfDocument`
is still a stub (poppler and PoDoFo are not linked here), so a report's form
fields remain the graphical host's until the core globals are split. `File.Info` answers no icon name -- there is no theme to ask
-- which no check reads.

**What it does not do yet.** The dispatch lives in the core; both hosts
install, and the graphical one is `bintana-gui`. **Two installed binaries are
the design -- a core and a graphical host; the third binary that is not wanted
is one that exists only for `check` and the test tools.** The Windows split
does not exist yet, and the Phase 2 acceptance
projects -- `tests/report`'s `testDocument`, `tests/media`, and `tests/api` with
its `Widget.*` -- are still the graphical host's. A `main` refuses `--strict`
and `--profile` with a sentence: strictness is about widget properties and this
host has no widgets, and the profiler is not linked yet. `--debug` works.

## Reproducing

```sh
cmake --build build --target bintana-meta bintana bintana-gui
./tests/headless.sh
ldd build/bintana-meta build/bintana | grep -Ei 'gtk|gtksource|vte'  # no output
```

`tests/headless.sh` needs no display: the metadata host and the core run `main`
projects, and the check it diffs is the graphical host's.
