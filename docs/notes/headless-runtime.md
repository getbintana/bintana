# The headless runtime: Phase 0 measured, Phase 1 spiked

**Status: Phase 0 measured and the Phase 1 spike passed on the C half
(2026-11-12, Linux).** Phase 2 and 3 are not started; the prelude's JavaScript
half is still the open decision. The design is
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
`tests/headless/Main.js` run under `bintana` as a `main` project and under
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

`bintana-headless` is the first real console runtime: `--version` and `check`,
with no GTK in the link. It is not a test host -- it loads `tools/check`, the
`lib/check` modules and the core globals a check needs -- and it is not
installed yet.

| command | wall | max RSS | libraries |
|---|---:|---:|---:|
| `bintana-headless --version` | 0.00 s | 5.6 MB | 17 |
| `bintana-headless check examples/hello` | 0.09 s | 14.0 MB | 17 |
| `bintana-headless check ide` | 5.40 s | 31.1 MB | 17 |
| `bintana check ide` | 5.50 s | 60.2 MB | 153 |

The `check ide` rows are the same pass, and their output is byte for byte the
same (`--json` too); the console host uses half the memory and maps no toolkit.
Those rows are the Debug build (`build/`). On `RelWithDebInfo` (`build-rwd`)
the same check is **1.63 s and 28.6 MB** against **1.68 s and 57.1 MB** for the
graphical binary; `--version` stays at 5.6 MB.

**How it is put together.** The widget files are compiled into an object
library with `BTA_META_ONLY` (the metadata host's stubs); `bta_sys.c` is compiled
with `BTA_HEADLESS`, which leaves `Screen`, `Dialog`, `Clipboard` and
`File.Open` out and keeps `File`, `Directory`, `Exec`, `Hash` and `Environment`.
`bta_headless.c` is the boot: it installs the core globals, `Application`, rad.js
and forms.js, then `bta_modules_scope`, then `lib/check` and `tools/check`'s
`main`. The files `bta_runtime.c` would have supplied -- `bta_lookup_global`,
`bta_dump_error`, `bta_symbols`, `bta_split_doc`, `bta_read_file`,
`bta_drain_jobs`, the error text, the library listing -- are in the host.

**What is deliberately a stub.** `Message`, `Dialog`, `Screen`, `Clipboard`,
`Printer`, `Tray`, `Notification`, `Desktop`, `Popover`, `Keyring`, `Http`,
`Socket`, `SerialPort`, `Database`, `Task`, `Media` and the rest of the
graphical/optional surface are **empty objects**, so `Application.Globals()`
answers the same names the graphical host has and a check does not report a
false "not declared". A project that calls one gets a `TypeError` today; Phase 3
replaces each with its refusal sentence. `Application.Replacements()` is empty
for the same reason: this host does not close the hatches, so the names are
still there.

`Text.LineOf` is the one measuring answer a check reads, and it is implemented
in the host over `bta_line_of_utf16`; the rest of `Text` needs Pango and a font
map and belongs to the graphical host. `File.Info` answers no icon name -- there
is no theme to ask -- which no check reads.

**What it does not do yet.** A project's `main` is not the command; the host
runs `tools/check`, not an arbitrary project. There is no dispatch to the
graphical host, no `bintana-headless <project>`, no Windows target, and the
binary is not installed. Those are the rest of Phase 2 and Phase 3.

## Reproducing

```sh
cmake --build build --target bintana-meta bintana-headless
./tests/headless.sh
ldd build/bintana-meta build/bintana-headless | grep -Ei 'gtk|gtksource|vte'  # no output
```

`tests/headless.sh` needs no display: both the metadata host and the console
host run a `main` project, and the check it diffs is the graphical one's.
