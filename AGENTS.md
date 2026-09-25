# AGENTS.md

This file provides guidance to coding agents when working with code in this
repository. Read `README.md` first for what Bintana is and how to use it, and
`docs/` for the technical documentation — [`docs/architecture.md`](docs/architecture.md)
for how the runtime fits together and [`docs/extending.md`](docs/extending.md)
before adding a widget or a property. This file is about working *on* the repo:
the commands, the conventions, and the traps.

## The rule about this file

**Any change to the API, the runtime or the widgets is documented here in the same
change.** Not afterwards, not in a commit message, not only in `docs/`. If you
added a property, changed what a setter accepts, fixed a lifetime, moved a default
or made a container behave differently, this file gets the sentence that would
have saved the next agent the afternoon you just spent.

This is not bookkeeping. `AGENTS.md` is the first thing an agent reads, and it is
the only document written *for* the one doing the work rather than for the one
using the result — so a fact that lives anywhere else is a fact that gets
rediscovered. Measured, in this repository:

- `Arrangement` "must be set before a container has children" was false, and said
  so here and in two other documents, for as long as nobody measured it. The
  restriction had been removed on purpose and the note stayed.
- `MouseWheel` was written `(dx, dy, ctrl, shift)` in three documents and passes
  two.

**And it covers `lib/` too.** A library that ships with the runtime is part of the
contract -- a project writes `uses: ["charts"]` and gets its classes, so what they
publish is as public as a control's properties. The check reads the surface out of
the Bintana by the convention this tree already follows: a capital initial is
public (`get Type()`, `Refresh()`), a lower-case one is the class talking to
itself (`view()`, `reduce()`), an underscore is a handler. `static Events` gives
the names and each `Emit` gives the arity. The page is `docs/llm/<library>.md`,
and a library with no page at all is the first thing it reports.
- `run.sh` did not default to `HEADLESS=1` and `asan.sh` did; that asymmetry was
  walked into five times, most of them after being apologised for. It is gone —
  both default to the virtual display now — and it stayed a documented rule for
  four of those five times, which is the lesson rather than the fix.
- A `GtkGrid` had no removal branch, so a grid could be filled once and never
  rebuilt. Nothing said so anywhere, and it took an application written against
  `docs/llm/` to find it.

None of those was a hard bug to fix. Each was expensive because the knowledge
existed and was not written down where it is read.

**What to write.** Not a changelog entry — the repository has git for that. Write
the thing that is not derivable from the diff: what the trap is, what it looked
like when it bit, what you measured, and what the rule is now. A sentence naming
the failure beats a paragraph naming the fix.

**Where it also has to land**, because this file is the working notes and not the
reference:

| A change to | goes in |
|---|---|
| a widget's properties, methods or events | [`docs/llm/controls.md`](docs/llm/controls.md) — and `tests/api.sh` **fails** until it does — plus [`docs/widgets.md`](docs/widgets.md) for the behaviour a table cannot state (`README.md` is presentation only since it was cut to ~60 lines, and takes no API) |
| a component in `lib/` (the shipped libraries) | [`docs/llm/<library>.md`](docs/llm/charts.md) — and `tests/api.sh` **fails** until it does, the same rule the runtime's own surface is held to |
| a global (`File`, `Exec`, `Locale`, `Record` …) | [`docs/runtime-api.md`](docs/runtime-api.md) and [`docs/llm/library.md`](docs/llm/library.md) — **and a line in `GLOBAL_TABLES`/`GLOBAL_VARS` in `tests/api/Check.js`**, or the check cannot see it — **and `docs/reference/globals/<Name>.md` with a line in `GLOBAL_PAGES`**, the long page a global is held to member by member. The page is the one part nothing asks about by name: a global with no page at all is invisible to the check, which is how a whole family was added without one |
| the `.form`, `project.json` or the serialiser | [`docs/formats.md`](docs/formats.md) and [`docs/llm/forms.md`](docs/llm/forms.md) |
| what `cmake --install` lays down, or the `uninstall` target | [`docs/installing.md`](docs/installing.md) — and `tests/install.sh` must still pass, since it stages a real install, compiles a plugin against it and runs it |
| the language: an intrinsic installed or removed | [`docs/llm/language.md`](docs/llm/language.md) and `runtime-api.md`'s *language underneath* |
| how a widget, property or event is added | [`docs/extending.md`](docs/extending.md) |
| the native plugin ABI or loader (`bta_plugin.h`, `bta_plugin.c`, a `.so` in a library) | [`docs/plugins.md`](docs/plugins.md), plus [`docs/formats.md`](docs/formats.md) and [`docs/llm/forms.md`](docs/llm/forms.md) for the `uses` half — and `tests/plugins/testplug.c` is the reference every verb is held to |
| **filling a gap `docs/issues/` reported** | **delete the issue file**, and the row for it in [`docs/issues/README.md`](docs/issues/README.md) and in [`docs/llm/issues.md`](docs/llm/issues.md)'s *what is known to be missing* — see below |
| anything a test now proves | [`docs/testing.md`](docs/testing.md), and the counts it quotes |

**An answered issue is deleted, not archived — and a refusal is an answer.** `docs/issues/` is the list of what
is *missing*; an issue kept past its answer is a second description of the same
feature, written by somebody who did not have it yet, sitting in the one
directory whose whole meaning is that nothing in it exists. Three went that way
when `Painter.Image`, `Text` and `SavePdf` landed. Completed plans go the same
way: `docs/http-plan.md` was deleted once its staging was built, with its one
live leftover (`Done` sequencing) already living in `docs/plans/async-plan.md` — a plan
kept past its building is the same second description. What the runtime can do is in
`docs/llm/`, which is where anybody looks; git holds what the asking looked like.
A refusal goes the same way, with the argument written into *what is deliberately
not here* in `llm/controls.md` — an issue whose answer is *no* is not a gap
either, and leaving the file there is how it gets argued a second time. The one
exception is the worked example inside `llm/issues.md`, which is quoted there to
teach the form and says so.

**And the numbers in a document are part of it.** Assertion totals, phase lists,
class counts, per-test timings: every one of those was stale at some point in this
repository, and a stale number reads exactly as authoritative as a fresh one.
`./tests/run.sh` prints the three that matter.

Two rules of thumb for whether a change belongs here at all. If you had to *read
the C* to find something out, that is a candidate — the point of this file is that
the next agent does not. And if you were surprised, write it: being surprised is
the whole signal.

## Commands

```sh
cmake -S . -B build && cmake --build build -j    # build (needed after any C change)
./tests/run.sh                                    # whole suite
./tests/run.sh widgets                            # one project
./tests/run.sh widgets record                     # one test of it
./tests/run.sh ide designer                       # one project, up to one phase
./tests/run.sh ide list                           # what a project can be asked for
BINTANA=/other/bintana ./tests/run.sh             # suite against another build
TIMEOUT=300 ./tests/run.sh                        # a slower machine than this one
./tests/asan.sh                                   # suite under AddressSanitizer
tests/try.sh <project> [args...]                  # run any project, on a virtual display
./tests/api.sh                                    # is docs/llm/ still the whole public surface, and do the links land?
./tests/typings.sh                                # rewrite bintana.d.ts (api.sh fails when it is stale)
./tests/icons.sh                                  # which declared icons this desktop has, and which draw
./tests/styles.sh                                 # which style classes its theme defines
./tests/install.sh                                # what `make install` produces, run out of a staging prefix
./tests/pack.sh                                   # what `lib/package` writes, read back file by file
```

**Nothing here opens a window, and that is the scripts' doing rather than
yours.** `run.sh` and `asan.sh` both export `HEADLESS=${HEADLESS-1}`, so the
suite draws on a virtual display whatever the machine has; `HEADLESS=` — empty,
not `0` — is the way back to a real screen. It was a rule before it was a
default, written in three documents, and it was still walked into five times:
the runner falls back to `xvfb-run` only when there is **no** `DISPLAY`, which
is CI and never a desktop, so the bare form opened the suite over somebody's
work and took the keyboard for a minute. A rule that has to be remembered on
every invocation is a rule that will be forgotten on one of them. Anything else
that draws goes through `tests/try.sh`, which cannot make the mistake either.

These need a real screen and so need saying out loud before running one:

```sh
./build/bintana tests/widgets                         # one test project, by hand
./build/bintana ide examples/hello                    # the IDE
./build/bintana examples/hello                        # a project on its own
LANGUAGE=es ./build/bintana ide examples/hello        # the IDE in Spanish (ide/po/es.po)
./build/bintana examples/i18n                         # layout under translation, measured
```

**A new property, method, event or global is not finished until `tests/api.sh`
passes.** `docs/llm/` claims to be the *complete* public surface — the thing you
hand somebody who has to write an application and should never have to read
`runtime/src` — and that claim is only worth something because something fails
when it stops being true. The check reads the accessor tables and the `bta_emit`
calls against `controls.md`, and the globals against `library.md`, so adding
either without a row breaks it; so does documenting an event with the wrong
number of arguments. Both of those were real: `MouseWheel` was written
`(dx, dy, ctrl, shift)` in three documents and passes two, and
`Application.LibraryPath` had been public and called by the IDE with no row
anywhere.

**It also holds `tools/typings/bintana.d.ts` to the same surface**, which is what
makes a *generated* file worth having rather than a stale one nobody notices: run
`./tests/typings.sh` after adding a member, or `api.sh` fails naming it. That
check found sixteen read-only properties missing the hour it was written --
`Children`, `Focused`, `Line`, `CanUndo` and twelve more -- because
`PropertyNames()` answers *what a property grid can set*, which is the right
answer to a different question. **And it covered only the table-driven half**:
`File.Within` was added, the declarations were not regenerated, and the check
passed -- the globals built one `JS_SetPropertyStr` at a time were in no list it
read. It reads their names out of the C now, the way `checkGlobals` does, and the
one exception is `Desktop.Entries`, which the declarations hold as a single
`any`.

**Every one of those but `asan.sh` is a Bintana project now** — `tests/runner`,
`tests/icons`, `tests/styles`, `tests/install`, each a console project (`"main"`,
no display) with a ten-line `.sh` in front of it that finds the binary. There is
no Python left in the repository, and adding a desk tool means writing a project,
not a script.

`tools/typings` is the exception that proves what a console project cannot do:
it asks real controls what they have, and `Widget.New` refuses in a project with
a `main` — *"a project with a `main` has no display, so it cannot make widgets"*.
So it is a **form** project run headless, with a window nobody sees.

`tests/install.sh` is the only one that needs no `HEADLESS` of its own, and it is
not an exception to the rule above: it never uses the caller's display at all. It brings up an `Xvfb` of its own, because the check is a second command
asking that display what the first one drew — which is precisely what `xvfb-run`
cannot do, since it owns its display for the length of one command.

The suite needs a display but not yours: it runs under `xvfb-run` by default, and
falls back to it anyway when there is no `DISPLAY`/`WAYLAND_DISPLAY`, which is
what `.github/workflows/ci.yml` relies on. Anything you drive by hand still needs a real display. Build deps:
`gtk4` (**4.10 or newer** -- `GtkAlertDialog` and `GtkFileDialog`),
`gtksourceview-5` (with headers), pkg-config, and `gmodule-2.0`, which is the
plugin loader and comes with glib. QuickJS is vendored, so
nothing to install for it. Six are optional and CMake says what it found either
way: `sqlite3`, `libsystemd`, `libsoup-3.0`, `gstreamer-1.0`,
**`vte-2.91-gtk4`** -- the pty behind `Terminal`, and the only dependency with
no Windows port -- and `libxml2`, which is what `Xml` parses with. The last is
optional in the build only: on most desktops GTK4 already loads libxml2 at
runtime, so what the package buys is the headers. **Package names per distribution and what each
one turns on are in [`docs/installing.md`](docs/installing.md)**, which is also
where the `Xvfb`/`xdotool`/`python3`/`openssl` the suites want are listed. **Build both ways before touching anything under
an `#ifdef`**: a wrapper `pkg-config` that exits 1 for one module name and
delegates the rest is the whole of it
(`cmake -S . -B build-x -DPKG_CONFIG_EXECUTABLE=<wrapper>`), and
`BINTANA=<path> BINTANA_LIB_PATH=$PWD/lib ./tests/run.sh` runs the
suite against it -- the library path because `lib/` is found relative to the
*executable*, so a build in another directory fails twelve chart assertions for
a reason that has nothing to do with what was turned off.

`.js` and `.form` files are data read at runtime — **no rebuild needed** after
editing anything under `ide/`, `tests/`, or `examples/`.

**`runtime/js/rad.js` is the exception, and it does not look like one.** It is
baked into the binary (`bta_prelude.h`), so editing it and running the suite tests
the *previous* one — silently, and every assertion that should have failed passes.
`tests/run.sh` warns when a source is newer than the binary; invoking `./build/bintana`
by hand skips that warning, which is how it bites.

**A push is the machine owner's, and a failure to push is a question for them.**
The remote is SSH (`git@github.com:getbintana/bintana.git`) and an agent's shell
has no key, so `git push` answers `Permission denied (publickey)`. That is not a
puzzle with a workaround — HTTPS, a token, another remote are all ways of not
asking. Commit locally, leave the tag made, and say the two commands.  It is the
same rule as the Xvfb one in the traps: **when a thing fails for a missing tool,
a permission or a package, ask the person at the machine; do not retry
alternatives.** Their one sentence costs less than your half hour, and an
improvised substitute is what turns a question into a false result.

**And a commit says who wrote it, by its own name.** Every commit an agent makes
carries a trailer — `Co-Authored-By: opencode (deepseek-v4.1-flash)
<noreply@opencode.ai>` for this one — and it never names another tool. The
history had ninety-two commits signed `Co-Authored-By: Claude` while the agent
writing them was not Claude, because each one copied the trailer of the commit
before it; a false statement in the permanent record is precisely what a trailer
exists to prevent. **An agent that does not know its own name asks rather than
copying the last one it saw**, and the whole history was rewritten to take those
out — which is why a `git log` older than that rewrite and a checkout of it
disagree.

## The rule that governs this codebase

**The IDE's own tree is `forms/` and `modules/`.** A form is two files that
travel together, so `MainForm.form` and `MainForm.js` live side by side in
`ide/forms/`; the loose classes -- `Designer`, `TabSet`, `Classes` -- are in
`ide/modules/`. That is the shape the IDE now creates for any project (a new
form with nothing open goes to `forms/`), and it was applied here first because
this is the biggest project there is to try it on: the root had thirty-five
files in it.

Two things follow. A path in a document or a test is `ide/forms/MainForm.js`
now; and **a folder a tool named is not a node in the project view.** `TOOL_DIRS`
in `ide/modules/Classes.js` lists the four -- `forms`, `components`, `modules`,
`po` -- and the view reads off it: a `forms` node with a `Formularios` inside it
says one thing twice. A folder the programmer organised means something; a folder
a tool named does not.

That rule used to have a second half -- *and it is not a namespace either* --
which is gone, because **no folder's name is a namespace any more**: a namespace
is what the code declares and nothing else, so there is nothing to exempt.
`namespaceHere(folder)` answers what the classes already in a folder declare,
which is what the New form dialog offers; the first class of a namespace is told
which one. See the note above it, and [`docs/ide.md`](docs/ide.md#folders-and-namespaces-which-are-not-the-same-thing).

**The classes in `ide/modules/` are `Ide.<name>`.** Each file declares
`Namespace("Ide")` and assigns one class, and its name is the file's:
`Ide.Designer`, `Ide.TabSet`, `Ide.Classes`. Twenty-three generic names are off the
global lexical scope, where a top-level `class` silently wins over a runtime
global of the same name -- and the largest Bintana program there is now uses the
feature it offers everyone else. The namespace is **declared by the code**: it is
`Ide` and not `Modules`, because the folder is not what named it. The forms stay
bare -- a form's name is what the runtime looks it up by.

**The IDE is written in Bintana and has no privileged API.** When the IDE
needs something the runtime lacks, the fix is a runtime feature every
application then gets — not a special case in the IDE.

The corollary runs the other way too, and is easy to forget: before writing C,
check whether the thing is expressible as a Bintana form. `AskForm` and
`ConfirmForm` are dialogs, not runtime primitives.

## Runtime architecture

**All widget classes share one `JSClassID`.** What makes a `Button` a `Button`
is its prototype, not its native class. The hierarchy lives entirely in the
prototype chain, assembled in one loop in `bta_widgets_init` from a table that
each module contributes rows to via `bta_register_classes`. Registration order
is load-bearing: a parent must be registered before its children.

Adding a widget is: a `build` function that fills `w->gtk` / `w->inner` /
`w->slot`, an array of `JS_CGETSET_DEF` properties, and one row in that
module's registrar. Nothing else.

Each JS object carries a `BtaWidget` in its opaque slot. `w->gtk` is what the
parent lays out, `w->inner` the control proper (they differ when something is
wrapped in a scroller), `w->slot` is where a container's children go.

**Events dispatch by name.** `bta_emit(w, "Click", ...)` looks up
`<w->name>_Click` on `w->form` and calls it. A form's own events use the
literal name `Form` (`Form_Open`), whatever the class is called. Returning
`true` from a `KeyPress` handler consumes the key.

**The `.form` format knows no control.** The loader applies each property as an
ordinary JS assignment, so it goes through the widget's real setter. The
serializer (`rad.js`) is the exact inverse: it discovers what to save by
walking the prototype chain for accessors that have **both** a getter and a
setter, and omits anything equal to a freshly constructed control's value.
`Widget.PropertyNames()` exposes the same discovery to the designer's property
grid.

This is the invariant worth protecting: **add a property to a widget in C and
it becomes designable, serializable, and editable with no other change.** A
read-only accessor is automatically excluded, because the loader could never
assign it back.

A property that only accepts certain values says so in its class row
(`BTA_CLASS_ENUM` plus a one-line `options` function), and
`Widget.PropertyOptions()` hands the list to whoever is editing it — that is
what makes the designer's grid offer a drop-down for `Alignment` without ever
having heard of `Alignment`. The list can be computed (`SourceEditor` asks
GtkSourceView which languages it has), so it cannot drift from what the setter
accepts.

A property that holds **text a person reads** says so the same way
(`BTA_CLASS_TEXT` plus a comma-separated list), and `Widget.TextProperties()`
publishes it — accumulated along the class chain, unlike `options`, since a
Button's are its own `Text` plus `Widget`'s `Tooltip`. One declaration, three
consumers: the `.form` loader looks the string up in `po/<lang>.po`, the property
grid offers a design value for it, and the IDE's extractor collects it. Declared
per class and never deduced from the name, because `SourceEditor.Text` is source
code while a plain `TextEditor`'s is prose. See [`docs/resources.md`](docs/resources.md).

**A component written in JS declares the same three in the class**, since those
three walk the class *table* and a class of the project is not in it — so a
`Stepper` used to answer with Widget's mouse events, no drop-down and nothing for
the extractor, however much it emitted:

```js
class Stepper extends Component {
    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];
}
```

Named after the methods that publish them, and answered **declared first, then
inherited**, so `[0]` is still the event a double click writes.

Read in **two** places, because the two sides know the class differently.
`w_property_options` and `class_list_of` in `bta_widget.c` read the static off
the prototype's own `constructor` at each step of the walk they already do —
inside it, and never as a second pass in `rad.js`, which would get the order
wrong and lose the middle of a `class Chip extends Stepper` chain. Own
properties throughout: a constructor inherits its parent's statics, and reading
through would report the parent's at the child's step and again at the parent's.
The IDE never loads the project's code, so `Ide.Classes` parses the same
declarations out of the source and the designer, the grid, the completion and
the extractor ask it.

A class that declares none must keep answering *nothing* — which is not an empty
list, and the difference is load-bearing on the IDE side: see `docs/ide.md`.

**A class answers about itself with no control built, and every caller that
needed it was holding a name.** `Widget.PropertyNames/Methods/EventNames/
TextProperties/PropertyOptions/Member(type, …)` resolve the type the way
`Widget.New` does — the class table first, then `bta_lookup_global` for the
project's own and its libraries' — and run the same walks the instance methods
run, started at the class prototype. Three consequences worth knowing before
touching them:

- **Abstract classes answer**, which is the one thing no probe could ask:
  `Widget.PropertyNames("Widget")` works where `Widget.New("Widget")` refuses.
  `PropertyGrid.baseProperties` used `try { Widget.New } catch` to skip exactly
  those, and now includes them — harmless, because an ancestor's names are
  already in the intersection.
- **`PropertyNames` is still `rad.js`'s walk.** The static hands it an empty
  object whose prototype is the class, so the function a control answers is the
  one a class answers and neither was reimplemented. Do not add a second
  accessor walk in C.
- **`Member` is `in` with a kind**, and it walks into `Object.prototype` because
  `in` did; `Methods` and `PropertyNames` stop before it. A method is a
  function-valued data property — nothing declares one — and the class's own
  `constructor`, which `JS_SetConstructor` leaves on every prototype, is
  filtered out. `ReadOnly` is the kind the loader refuses a `.form` over.
- **Nothing here may touch GTK**, and `tests/api` (a console project) asks one
  of these to keep that true: the whole point is that `Widget.New` was the only
  way to ask, and it needs a display.
- **The parameters are declared beside the member**, because a function knows
  its count and not its names: one line directly above the C entry —
  `/* Bounds([container]) */` — or, for an event, above the class row that
  already lists it. `tools/extract_signatures.cmake` turns those comments into
  `generated/bta_signatures.h` and the runtime answers with it, so there is no
  second declaration to drift. A JS class states its own as
  `static Signatures`. **`Signature` is the method's and `EventSignature` the
  event's**, because a name can be both — `ListBox.Select` is a method that
  selects a row and the event that says the selection moved — and the walk stops
  at the first class that declares the member, so an override
  (`Form.Serialize`) answers its own. `tests/api` fails on a method or event
  that declares none, and compares both `controls.md`/`reference/widgets` and
  `bintana.d.ts` against what the runtime answers.
- **And the table parser in `tests/api` and `tools/typings` was `[^}]*`**, which
  a signature comment with an options object broke: `/* Search(text,
  [{CaseSensitive, …}]) */` stopped the body at its first `}` and every member
  of that table was silently lost — a completeness check that stops checking
  without failing. The body is lazy to the `};` that ends a table now
  (`[\s\S]*?`), which is what a parser over C that can contain braces in
  comments has to be.

**`Environment` is the context a program was started in** — `Get`/`Set`,
`Variables`, `CurrentDirectory`, `HasDisplay`, `ProcessId`, `ProcessorCount`,
`UserName`, `HostName`, `OS`. One object, because they are asked together and
were four different shell builtins. `HasDisplay` answers about the *environment*
(`DISPLAY` / `WAYLAND_DISPLAY`) and not about this process, which is the version a
runner needs. `Environment.Set` is `export`; one child's environment is `Exec`'s
`Environment`.

**`Exec`'s handle takes two verbs and no flag**: `Stop()` asks (SIGTERM), `Kill()`
makes (SIGKILL), and both reach the child's whole **process group** — a child is
usually a wrapper, and signalling only the wrapper is what left an X server
orphaned to init once per timeout. `Terminal` takes the same two verbs meaning the
same two things (`Kill` alone used to be SIGTERM there). The handle also carries
`Running` and `ExitCode`, written onto it before the exit callback runs, because
the ordinary place to read an exit code is after the child is gone.
`{ Stderr: "separate" }` keeps the two streams apart and tags each line `"out"` or
`"err"`; merged is the default because merging is what keeps the order — and note
`xvfb-run` merges them itself (`"$@" 2>&1`), so under it there is nothing to split.

**A project declares `startup` or it declares `main`**, and the difference is
whether it draws. `"main": "Main"` names a function, calls it once the sources are
loaded, and **never initialises GTK**: the program has no display, and ends when
nothing is owed an answer — no child running, no timer armed, no file watched
(`bta_sys_pending`). `Application.Quit(code)` is the only way to end it with a
status. It exists for the work *around* an application, which was shell scripts:
a test runner, a build step, a tool that reads the icon themes off the disk. It is
**not** a way to write a test — a test that does not go through GTK proves nothing
about a GTK binding, which is the whole point of `tests/`. See
[`docs/formats.md`](docs/formats.md#main-a-project-with-no-window).

**A project's `id` is its window's class, and making it one takes two calls in
two places because GTK reads it from two.** `gtk_application_new(id, …)` is what
Wayland reads — `gdktoplevel-wayland.c` takes the xdg-toplevel app id from
`application.application_id` — and `g_set_prgname(id)` is what X11 reads:
`gdksurface-x11.c` builds `WM_CLASS` out of the program name and **never looks
at the application id**. One id, two calls, because `StartupWMClass` is one
string and it has to match on both — and a window classed by something else is
one no dock recognises, in silence. The rule is the platform's
(`g_application_id_is_valid`: reverse DNS, at least one dot, no element starting
with a digit) and it is refused **at load**, naming the key, rather than
ignored -- and so is an `id` that is not a string, which `json_str`'s fallback
used to read as no id at all; a project that declares none keeps the old answer, which is the
program's own name. `GtkApplication` also takes the id as the default window
icon when the theme has one by that name (`gtkapplication.c`).

## The six patches in vendor/

All six are marked `Bintana patch` in the source, and an upgrade that drops
one takes a feature or brings a bug back with it. Grep for the marker after any
QuickJS upgrade; there is no build-time check that they survived.

### 1. Operators on a Decimal

`quickjs.h` gains `JS_SetArithHandler`, and four of the arithmetic slow paths in
`quickjs.c` -- `js_add_slow`, `js_binary_arith_slow`, `js_unary_arith_slow`,
`js_relational_slow` -- consult it **before** they reach `ToPrimitive`. One
helper, `js_arith_hook`, maps the interpreter's opcode to a public enum so an
embedder never depends on the opcode numbering.

It is what makes `precio * cantidad + iva` exact
(`runtime/src/bta_decimal.c`), where a value is an exact **fraction** rather than
a scaled integer -- the scaled version could not make `(10 / 3) * 3` be ten, and
that is the assertion to run first if this ever looks broken. quickjs-ng removed the operator overloading and
the `BigDecimal` that Bellard's quickjs carried, so without this the only decimal
possible is `a.Plus(b)` -- which for the audience this language is written for is
not a decimal at all. **Dropping the patch does not fail to build**: the handler
is never called, every operator on a `Decimal` silently falls through to
`ToPrimitive`, and arithmetic answers with doubles again. `tests/widgets`
asserts it (`Decimal`), including that nothing *else* changed -- a patch to the
interpreter's arithmetic is where a language breaks quietly.

### 2. JSON numbers and the decimal comma

`json_parse_number` used `strtod`, which reads the C locale's decimal separator:
`json_parse_number` used `strtod`, which reads the C locale's decimal separator.
The runtime calls `setlocale(LC_ALL, "")` at startup and so does GTK, so on any
desktop that writes a
decimal comma -- es, de, fr, pt, ru -- **`JSON.parse("0.05")` answered 0**, and
silently: a `.form` carrying `Step: 0.05` loaded a spin that would not step, a
rate in a settings file came back whole, and nothing said so. It is fixed by
calling `js_atod`, which is QuickJS's own conversion and what every other number
path in that file already uses.

`tests/widgets` asserts it (`JsonFiles`), and that assertion only means anything
in a locale with a comma -- which is the machine this is developed on, and not
CI's. Check it after any QuickJS upgrade.

### 3. Which property was refused

Three sites that refuse an addition to a non-extensible object threw *"object is
not extensible"*, and the atom was in hand at every one of them. They name it
now: **`no 'Txt' to assign: the object is not extensible`**. Two lines of helper
and three call sites, the same shape `JS_ThrowTypeErrorReadOnly` two lines above
has always had.

It matters because of `bintana --strict`, where a control is made
non-extensible so a misspelt property throws where it is written
(`docs/plans/strict-plan.md`). The point of that mode is to be told *which* name the
class does not have, and without this it says only that something was refused --
which, on a line that assigns three properties in a row, is the wrong half of the
answer.

**Dropping this patch does not fail to build**, and nothing stops working: the
refusal is still a refusal. The message goes back to the vague one, and
`tests/widgets` says so (`strictChecks` asserts `no 'Txt' to assign`).

### 4. The debugger

`quickjs.h` gains `JS_SetDebugHandler`, `JS_DebugStopOnThrow` and six readers --
`JS_DebugPosition`, `JS_DebugBacktrace`, `JS_DebugLocals`, `JS_DebugLines`,
`JS_DebugEval` and `JS_DebugSetLocal` -- and `JSStackFrame` gains two fields. Everything that *decides* anything is in
`runtime/src/bta_debug.c`; the vendor only exposes what its own frames already
hold. `docs/plans/debug-plan.md` is the design and the measurements.

- **The hook is a branch in the `SWITCH` macro of `JS_CallInternal`**, both
  spellings of it (the `switch` and the computed-goto one). With no handler
  installed it is one predictable branch, and what that costs is the number in
  the plan: **+12.5 % on tight arithmetic and +16.4 % on property reads**, off,
  against the same tree built without it and measured back to back. That is why stage 5
  of the plan is the bytecode patch and why this one is called scaffolding in
  its own comment.
- **`JSStackFrame.this_obj`** exists because `this` is a *parameter* of the call
  and had no slot on the frame: a debugger could read every local of a method
  and not the one name its body uses most. Borrowed like `cur_func` -- the
  caller holds it for the length of the call -- so it is neither duplicated nor
  marked.
- **`JSStackFrame.debug_line`** is the line that frame was last reported at.
  One line is many opcodes, so something has to say when the program *left* it,
  and a single global "last line" cannot: returning from a call lands back on
  the line that made it, which stopped twice. The memory belongs to the frame
  because the question does.
- **A line with no pc2line entry of its own cannot stop.** QuickJS emits an
  entry where the line *changes*, so two statements it runs together share one:
  `let total = 0;` right under `function Main() {` has none. A breakpoint there
  would arm and never fire, silently. `JS_DebugLines` is what lets
  `bta_debug.c` move it to the next line that exists and tell the IDE where it
  went -- which is why a file is compiled and run in two steps under `--debug`
  and in one otherwise.
- **A direct eval cannot read a frame, and that is not a bug to work around.**
  It is the eval that sees an enclosing scope, and QuickJS compiles one against
  a lexical scope index the *compiler* wrote into each `OP_eval`; there is no
  such number for an arbitrary pc, so with none of them arguments and `var`s are
  in scope and a `let` is not. `JS_DebugEval` wraps the expression in a function
  of the frame's own names and calls it with the frame's own values instead,
  which also buys the property worth having: **what an immediate window can name
  is exactly what the values panel shows.**
- **Frame 0 is the topmost frame running *code*.** A throw is reported from
  inside `Error`'s own constructor -- a native frame with no line and no locals
  -- so the numbering skips native frames *at the top*, in one place
  (`bta_frame_first`), and `frame: 1` means the same frame to the backtrace, to
  `locals` and to `eval`. A native frame *between* two JavaScript ones is a real
  part of the stack and is reported as `(native)`.
- **Stopping on a throw is every throw.** Whether something above will catch it
  is not a question the engine can answer when it is raised. The hook is in
  `build_backtrace`, after `in_build_stack_trace` is back down so the handler
  can build one of its own, and it is told apart from the per-opcode call by a
  **NULL pc** -- one handler, because two would be two places to keep in step.
- **The debugger must not stop inside its own expression.** A watch, a condition
  or an immediate runs JavaScript while the program is held; without a flag the
  hook fires inside it and the debugger stops in itself, with the program's
  stack underneath. `dbg.evaluating` is that flag and every entry point sets it.
- **An audit found four ways the channel ended the program wrongly, and each is
  now a rule.** *The IDE going away* set RUN and left every breakpoint and
  stop-on-throw armed, so the next breakpoint said so down a closed pipe and
  SIGPIPE killed the program (exit -13, the code after it never run):
  `detach()` disarms everything on end of input or `EPIPE`, and SIGPIPE is
  **blocked around the write** and taken off the queue with `sigtimedwait`
  rather than ignored, because an ignored signal is inherited by every child
  `Exec` starts. *The debugger's own JavaScript* -- `JS_ParseJSON` of an order,
  the getters `locals` renders -- stopped the program inside the debugger when
  stop-on-throw was on: every order runs under `evaluating`
  (`obey_as_debugger`). *`JS_DebugSetLocal`* returned early on a frame with no
  locals without freeing the value, and `JS_FreeRuntime` aborted (134) -- the
  vendor patch now frees it on every road. *Two orders in one write* went into
  stdio's buffer while `poll` watched the descriptor, and the second waited
  forever: stdin is unbuffered under `--debug`. Two more from the same audit:
  an order past **8 KB** was split by a fixed `fgets` buffer into two fragments
  that each failed to parse, so a long `eval` never answered -- `read_order`
  reads a whole line into a `GString`; and a breakpoint matched the file by a
  **bare suffix**, so one on `Form1.js` stopped in `MyForm1.js` (and an empty
  name in every file) -- `path_is` wants the tail to start at a separator. `testDebuggerOrders` is red on
  the old binary for the second and third; the SIGPIPE half needs the channel
  closed from outside and was measured with a Python driver.
- **Dropping this patch does not fail to build.** The handler is never called,
  `--debug` waits for a debugger that can never stop anything, and the IDE's
  Debug menu does nothing at all. `tests/widgets` asserts it (`testDebugger`):
  it runs a real program under `--debug` through `Exec`'s `Control` and `Write`,
  and *the debugger stopped it once* is zero without the hook. `tests/ide`'s
  `debug` phase covers the IDE's half -- the commands, and the gutter mark being
  the state -- and deliberately starts no child, because driving one from there
  says the same thing again, slower and through a window.

### 5. `async` is refused where it is written

Two guards in `js_parse_function_decl2` (`quickjs.c`) turn every spelling of
`async` into a `SyntaxError` on the word itself. Two, because `func_kind`
arrives two ways: a method or an arrow is called with it already set, a
declaration or an expression has it upgraded from the keyword a few lines in.
Both are one `if`.

**What it replaced is the reason it exists, and it is not obvious.** Not
installing `JS_AddIntrinsicPromise` is a decision about the language and a good
one -- but that intrinsic is also **the only thing that registers the engine's
ten async classes**, `JS_CLASS_ASYNC_FUNCTION` among them. An unregistered
class has a NULL finalizer and a NULL mark function, so the object `js_closure`
built for an `async` function never released its bytecode and was never
collected, and `JS_FreeRuntime`'s `assert(list_empty(&rt->gc_obj_list))` aborted
the process at exit -- **after** the program had done its work and called
`Application.Quit(0)`, with an exit status of 134. A build with `NDEBUG` leaked
it in silence instead. It cost nothing for years because nothing in this tree
writes `async`; the day an application did, it would have looked like a bug in
the runtime's teardown and not in a word the manual said was unavailable.

The bisection that found it is worth keeping: an async function **inside a
function that is never called** is clean, which rules out the parser and the
bytecode and names the culprit as *creating the object*. That is why the guard
is in the parser rather than in `js_closure` -- the refusal belongs where the
word is, so `Application.CheckSource` sees it and an editor can underline it.

**Dropping this patch does not fail to build**, and nothing stops working until
somebody writes the word. `tests/widgets` asserts it
(`testCuratedLanguage`): seven spellings -- declaration, expression, arrow,
class method, object method, async generator, and one that awaits -- each
refused with a message and a column.

### 6. The parser reports what it declared

`quickjs.h` gains `JS_SetSymbolHandler` and `JSSymbolKind`, and the parser calls
the handler -- installed for one compile and taken out after it -- from
`js_parse_class` (the class at its name, each method at its own), from
`js_parse_function_decl2` (a top-level `function`), and from `set_object_name`
and `js_parse_assign_expr2` (an anonymous class expression, named by the
assignment that wraps it). It is what `Application.Symbols` is: classes, methods
and top-level functions with their line, so an editor does not have to guess
with a pattern.

**The four patterns it retired are the argument.** `FormFiles.hasHandler`,
`openHandler`, `handlersIn` and `Navigator.SYMBOL` each answered *what does this
file declare* differently: one anchored at four spaces, one matched a mention in
a call, all of them found a method in a comment, and the IDE marked handlers as
written and jumped to calls because of it. A parser knows what a comment and a
string are, and there is one of it. It is also faster: **3.4 ms against 5.1 and
6.9 ms**, measured on the IDE's own 110 KB `MainForm.js`.

**Three things about the patch itself are load-bearing.** The handler lives on
the runtime and is installed around a single `JS_Eval(COMPILE_ONLY)` rather than
gated by a flag, because what an embedder wants is one compile's answer and a
handler that stayed would report `rad.js` and every `.form`; a syntax error
still reports what was collected, because half a file is the ordinary state of
one somebody is typing in; and an anonymous class expression is reported *after*
its methods, since its name only exists once the assignment around it is parsed
-- the one case where the order is not source order.

**Dropping this patch does not fail to build.** `Application.Symbols` compiles
and answers `[]` for every source, so the IDE's outline, its handler marks and
its go-to-symbol all go empty together -- with the suite red in `tests/widgets`
(`testCuratedLanguage` asserts the classes, methods and lines) and in `tests/ide`
(`goto` asserts a method typed and not saved is still found).

## Memory rules

- Controls point back at their form, so the object graph has cycles. Report the
  edge in `gc_mark` or forms never get collected.
- **A wrapper's unref disposes the whole tree, and GTK dispatches while it does.**
  Unhooking the widget being finalised is not enough: `gtk_window_dispose` moves
  the focus, which emits `focus-leave` on a child that is still connected and
  whose `w->form` is the object being freed in the same cycle. `widget_disconnect_tree`
  unhooks everything under it first, and the finaliser clears the back-pointer on
  `w->slot` as well as on `w->gtk` or that walk finds a freed `BtaWidget`.
- `JSValue`s held from C across an async boundary (`Exec`, `Dialog`, timers,
  menu actions) are strong references the collector cannot see. Free them on
  **every** exit path, including runtime teardown while a child still runs —
  `JS_FreeRuntime` aborts on anything left alive. See `bta_sys_cleanup`.
- **A shown form is the same kind of reference, and it is what makes
  `new AskForm().Show()` the whole of a dialog.** `form_hold` (`bta_controls.c`)
  takes the wrapper in `Show` and `form_drop` releases it when the close is
  allowed — **not** in `Close()`, which `Form_Close` may veto; `HideOnClose`
  releases too, and a later `Show` takes it again. It is deliberately absent from
  `gc_mark`: a cycle detector that could see it would collect the object it
  protects, so a form still held at teardown has to be swept by
  `bta_forms_cleanup` or `JS_FreeRuntime` aborts. `tests/widgets`' `FormKeepalive`
  leaves one open (the sweep) and closes another (the drop). **Before this,
  sixteen IDE dialogs kept a module-level array alive by hand** because a form
  nothing referenced was collected and its window was left on screen with every
  handler disconnected. Measured with a probe on its own `Xvfb` **plus a real
  window manager** — under a bare `xvfb-run` a synthetic click never reached GTK
  at all (`xdotool getmouselocation` reported the pointer over no client window,
  with the window mapped and focused; `xfwm4` on the same `Xvfb` made the first
  try work): with the hold, a click before and a click after a 400 000-object
  ball both answer; with `form_hold` compiled out, the first answers and the
  second is silent **while the window is still on screen**, which is the
  reported symptom exactly.
- The class table's prototypes and constructors are static and outlive the
  context; `bta_widgets_cleanup` drops them.
- **"Every exit path" includes the branch that gives up, and that is the branch
  nothing exercises.** `bta_task_cleanup` waits a bounded two seconds and then
  casts an unresponsive worker adrift with its *job* deliberately unfreed --
  which is right, and documented in the `Task` notes below. What the `continue`
  also skipped was `JS_FreeValue(job->ctx, job->self)`: the **proxy** is an
  ordinary main-context `JSValue` that no JavaScript scope owns, the worker
  never touches it, and leaving it alive left an object on `gc_obj_list`. So the
  process printed *"1 task still inside a native call at exit ... closing
  anyway"* and then aborted in `JS_FreeRuntime`'s assertion two lines later. The
  rule above was followed on the path that succeeds and not on the one that only
  runs after something already went wrong. **When you write a give-up branch,
  read the success branch next to it and account for every release in it.**
- **`memcpy` with a length of zero is still undefined behaviour if the pointer
  is `NULL`**, and an empty `Bytes` carries `NULL` on purpose. `Bytes.Concat`
  copied unguarded, so any concatenation touching an empty value was formal UB
  a UBSan run reports -- harmless only because glib's allocator does not poison.
  `bta_bytes_get` exists to hand back `""` instead; a copy that bypasses it
  guards by the length itself.
- **An idle source queued from another thread cannot be tracked by its id, and
  the symmetry that suggests it is a trap.** A `BtaTaskJob` owns four sources.
  `timeout_src` and `force_src` are armed on the main thread, so keeping their
  ids on the job and removing them there is correct. `task_deliver` and
  `task_progress_drain` are attached from inside the **worker**, and the same
  treatment is a use-after-free of its own: the loop can dispatch the source and
  free the job before `g_idle_add_full` has returned into the assignment, and
  the worker then writes a `guint` into freed memory. Reaching for the pattern
  two lines above in the same struct is exactly what makes this one easy to get
  wrong.
  The answer is **a reference per queued source** -- `task_job_ref` before the
  attach, `task_job_unref` as the `GDestroyNotify` -- which needs no id, no lock
  and no assumption about when GLib dispatches. It also replaced an invariant
  that lived nowhere: the old code was safe only because GLib dispatches
  equal-priority sources in insertion order, so a drain queued before a delivery
  always ran before the delivery freed the job.
  **And the exposure was not theoretical.** `bta_task_cleanup` takes the whole
  job list and frees what it can join -- but the worker attaches `task_deliver`
  *after* saying `ended`, which is the very thing that wait is waiting for.
  Measured with eight tasks started and `Application.Quit(0)` on the next line:
  the live reference is dropped with the refcount at **2 in all eight cases**,
  i.e. every one of those jobs had a delivery still attached and would have been
  freed under it. Nothing dispatches the default context after teardown today,
  which is the only reason it never crashed -- and the reason no test can go red
  for it, so this paragraph is the record.
- **A cache of the filesystem must not believe a negative answer.** `form_path`
  rebuilds its index on a miss and says why -- *"a file that appeared since,
  which is the normal state of affairs while an IDE is writing forms in the same
  directory it is running from"*. `task_class_file` carried a comment claiming
  the same rebuild and did not do it, so a `<Name>.js` created while the program
  ran stayed invisible for the life of the process. It rebuilds once on a miss
  now, and the cost settles it rather than the symmetry: a miss means
  `Task.Start` is about to throw *cannot find task class*, so the walk is on the
  path that was going to fail anyway and never on the one that succeeds. The
  narrow shape this is reachable in -- the class declared in a file named after
  something else, its own `<Name>.js` written later -- is what `testTask` drives,
  as a **child process**, because the cache lives for a process and the
  alternative was writing a `.js` into the suite's own project directory.
- **A wrong answer that looks like the right tool is worse than a missing one,
  and `localeCompare` was the case that proves it.** With no ICU it compared
  code units, so `"Álvarez".localeCompare("Zapata")` was `1` -- and measured,
  `list.sort((a, b) => a.localeCompare(b))` returns **exactly** what
  `list.sort()` with no comparator returns. It was not a rough approximation of
  alphabetical order; it added nothing at all, while carrying the name of the
  thing that would. Five documents warned about it and nothing ever argued for
  keeping it. It is a `TypeError` naming `Locale.Compare` now.
  **The refusal lives in `rad.js` and not in `close_hatches`** for one reason
  worth reusing: a deletion says only *not a function*, while a replacement can
  say what to use -- the same bargain as the QuickJS patch that made the
  extensibility refusal name its property. Either place would have reached both
  sides; **a worker calls `bta_close_hatches` too** (`bta_task.c`, right after
  its own `task_delete` list, which is about main-thread globals and not about
  hatches), so the `gone[]` list is one catalogue and not two. The worker gets a
  **different sentence**,
  because `Locale` is not installed there at all and sending it to
  `Locale.Compare` would be the second wrong answer in a row. That gap is
  `docs/issues/ISSUE-worker-locale-order.md`.
- **The bare `sort()` is the half of that which cannot be refused**, and after
  the refusal above it is the one that stays silent. It gives the same wrong
  order and never consults the locale -- a comparator-less `sort` compares UTF-16
  code units by specification, so this is true on every desktop and under `C`.
  It cannot go the same way as `localeCompare` because it is *right* almost
  everywhere it is used: all 26 bare sorts in this tree order paths, file
  extensions, class names, namespaces and the keys of a bag, and **not one of
  them sorts text a person reads**. So this one is documentation and an
  assertion rather than a refusal, and `a < b` is in the same position.
  There is deliberately **no `Locale.Sort`**: `list.sort(Locale.Compare)` is the
  whole of it, nothing in the tree wants more, and a name gets published when
  something needs one -- the rule `close_hatches` states when it empties
  `Object`.
- **`RegExp` is gone and regular expressions are not, which is the whole of what
  taking the name buys.** `/x/g` is syntax and still makes one, so the removal
  could only ever reach `new RegExp(p, flags)` -- the engine built from a
  *string* -- and that is the half worth having: a dynamic pattern has one
  spelling now, `Regex`, which captured the constructor before `close_hatches`
  ran. `RegExp.prototype.constructor` goes with the name, or
  `(/(?:)/).constructor` hands the function straight back; what that read falls
  through to is `Object`, which cannot make a pattern. The documents said for
  years that this "would buy little" and left it; `architecture.md` and
  `runtime-api.md` now say what changed, and the 14 `new RegExp(…)` in the IDE
  and `tests/styles` are `Regex` and literal patterns.
  **And the flag that was only reachable through the constructor is
  `{ Unicode: true }`.** Measured: without it `\p{L}` does not throw -- it
  compiles and matches the literal text `p{L}`, so a Unicode pattern that is not
  a literal was silently wrong rather than missing -- and `.` counts UTF-16
  units, so an emoji is two matches. `Matches` steps a **code point** on an empty
  match under it, which is what `Symbol.matchAll` does; stepping a code unit
  would start the next match inside an emoji.
- **The editor's find bar is a different regex engine, and three differences are
  the kind a pattern notices.** `SourceEditor.Search(text, { Regex: true })` is
  GtkSourceView's `GtkSourceSearchContext`, which compiles with GRegex/PCRE2 --
  read from 5.20.0: `compile_flags = G_REGEX_MULTILINE` always, `CASELESS` when
  the setting says so, `G_REGEX_MATCH_NOTEMPTY` at match time -- and GLib turns
  PCRE2's UCP on for every pattern (2.74 and later). So in the find bar `^` and
  `$` match at every line whatever the pattern, `\d`/`\w`/`\b` are Unicode-aware
  (`ñ`, `٣`), `$` also matches before a final newline, and PCRE2 grammar
  (`\p{L}`, `\K`, atomic groups) is available. In a `Regex` the same text is
  ECMAScript: ASCII `\w`, one line unless `{ Multiline: true }`, `\p{L}` behind
  `{ Unicode: true }`. Two engines in one application, documented where each is
  read -- `library.md`'s `Regex` section, the `Search` row, the `SourceEditor`
  page and `widgets.md` -- because a find bar and a lint that share a pattern
  otherwise disagree in silence.
- **A runtime answer must not be breakable by what the program did to `Error`.**
  `Application.CheckSource` returns `{Message, Line, Column}` and the position
  has exactly one source: a QuickJS error carries no `lineNumber`,
  `columnNumber` or `fileName` (measured, all three `undefined`), so
  `check_position` parses `<check>:LINE:COL` out of `.stack`. That made two
  ordinary assignments break it silently -- `Error.prepareStackTrace` replaces
  the string, `Error.stackTraceLimit = 0` empties it, and both returned
  `Line: 0, Column: 0` for source whose answer is `2:9`, **with the message
  still correct**, so the IDE underlined the first character and nothing said
  why. The second is the likelier: it is what somebody sets to quieten a log.
  `js_check_source` neutralises both for the length of the compile and hands
  them back untouched. The rule generalises: **when a runtime verb reads
  something the program can configure, it reads its own copy.**
- **`docs/llm/` claims to be the whole public surface, and eight names were
  outside it**: `BigInt`, `WeakMap`, `WeakSet`, `Iterator`, `DisposableStack`,
  `queueMicrotask`, `escape` and `unescape` were all installed and in neither
  list -- neither *what is here* nor *what is not*. `tests/api.sh` cannot catch
  this, because it checks the globals the runtime *registers* against
  `library.md`; a name QuickJS installs of its own accord is invisible to it.
  Three were removed and five documented. If you add an `JS_AddIntrinsic*` call,
  the names it brings are yours to list.
- **`for...in` is safe from the builtins, and not for the reason the manual gave
  for years.** It said *nothing can put anything on a prototype any more*, which
  was three claims stacked and only one true. Measured: `for...in` over `{a:1}`
  answers `[a]` -- `toString` and its siblings are reachable (`"toString" in {}`
  is `true`) and simply **non-enumerable**, which is the engine's doing and has
  nothing to do with emptying `Object`. So the safety is real and would survive
  any further curation. But `Object.prototype.x = 1` still works, and from then
  on `for...in` recites `x` over every bag in the program.
  **And the program cannot defend itself**: `freeze`, `seal`,
  `preventExtensions` and `isExtensible` all went with `Object`'s statics, so
  there is no way to lock the prototype and no way to ask whether anything wrote
  to it. That makes the old sentence not merely false but unfalsifiable from
  inside the language. It stays a small risk only because there are no imports:
  the only code that can do it is the project's own and its `uses` libraries.
  **`Dictionary.Keys` is immune** -- it is the `Object.keys` `rad.js` captured,
  own and enumerable -- which is the strongest argument for it and was written
  down nowhere.
  Do not file this under the `in`-operator trap above: that one is about
  **non-enumerable** inherited names, which `for...in` never sees. Two different
  mechanisms, and confusing them is how somebody fixes the sentence and leaves
  the bug.
- **Every name the runtime looks something up by is ASCII, and that is narrower
  than the language it is written in.** QuickJS takes `Peón` as an identifier --
  `Application.CheckSource("class Peón {}")` answers `null` -- and
  `is_identifier` does not: `bta_runtime.c`, `bta_form.c` and `bta_task.c` each
  keep a byte-at-a-time copy on `g_ascii_isalpha`. It covers a `.form` node's
  `type` and `name`, `startup` and `entry`, and a `Task` subclass. **The three
  copies refuse three different things with three different sentences**, so a
  single fix does not cover them and reading one tells you little about the
  others: `bta_runtime.c` answers *"'%s' is not a valid class name"*,
  `bta_form.c` answers *"form: '%s' is not a usable control name"* and is about
  the control's `name` rather than its `type`, and `bta_task.c`'s is not a
  refusal at all -- a folder it cannot spell contributes no namespace prefix and
  what is under it stays findable by its bare name, which is deliberate and says
  so. A *file* called `Peón.js` is indexed; it is the class the code declares
  that has to be spellable, and that is refused later at lookup with the first
  sentence, which is what makes it read as *the class is missing*.
  Documented in `formats.md` and `llm/forms.md` rather than widened: reading
  UTF-8 means unifying three copies first, to enable something nobody has asked
  for, and a class name is also a file name.
- **`tests/api.sh` asked whether what is *declared* is documented, and could not
  ask whether what is *installed* is declared.** Those are different questions
  and the second has the worse failure: a global nobody listed is invisible to
  every list in `Check.js`, so nothing fails and its documentation is free to be
  absent. Measured when the check was added: **six** were in that state --
  `BTA_VERSION`, `Field`, `Multipart`, `Namespace`, `Painter` and `Record` were
  installed and named nowhere in that file. `checkGlobalsListed` reads the
  installed set from where it is decided -- `JS_SetPropertyStr(ctx, global, …)`
  in the C, `GLOBAL.X =` in the prelude, minus `close_hatches`' own `gone[]` --
  and fails on a name with no home at all. A page written by hand counts as a
  home; `GLOBALS_ELSEWHERE` is for the ones documented inside another global's
  page, with the where written next to the name.
  The general shape is worth keeping: **a completeness check that reads only its
  own list is a completeness check about its own list.** The same blind spot let
  eight QuickJS-installed names sit outside `llm/language.md` for as long as
  they did.
- **There are nine hand-rolled async job shapes, and two of them have already
  forgotten to release.** `WatchJob` (`bta_sys.c`), `ExecJob`, `TimerJob`,
  `PasteJob`, `DialogJob`, `HttpJob` (`bta_http.c`), `BtaTaskJob`
  (`bta_task.c`), `PrintRun` (`bta_printer.c`) and `BtaMedia` (`bta_media.c`)
  each carry a `JSContext`, one or more `JSValue`s, a list of live jobs and a
  free path that has to release on **every** exit. `bta_widget_watch` and
  `http_job_alive` exist because two of them did not -- they are the repairs,
  not the design. So when you add the tenth, or touch one of the nine, the
  question to ask first is *which exit path did the one next to me forget*: the
  adrift `Task`'s unreleased proxy and its untracked idle sources -- the two
  paragraphs above -- were both in `BtaTaskJob`, and neither was found by
  reading that struct's success path.
  A shared base for *a job with values and a dead flag* would shrink the surface
  where forgetting is possible; nobody has built one, and this paragraph is the
  cheaper half of that.
  **`ExecJob` was the third, and CI's core dump is what named it.** A job ends
  when stdout drains and the child is reaped -- descriptor 3 ending is *not*
  the child ending, on purpose -- so `exec_maybe_finish` freed it with the
  `Control` read still armed, and `exec_job_free` never cancelled
  `job->cancel` (only teardown did). The debugger's last event races its exit;
  when the exit won, the read completed into freed memory and
  `on_exec_line` segfaulted in `JS_IsFunction` -- exit 139 on the
  `no-unix-print` job, one run in several, and never in forty here. And the
  callback read `job->err`/`job->control` *before* checking for the cancel, so
  even teardown's cancel was a read of freed memory. Now: the free cancels,
  the callback finishes the read before touching the job and also asks
  `exec_jobs`, the context and the handler are held across the `JS_Call`
  (a handler can spin a nested loop that ends the job), and the next read is
  armed only if the job survived it. `testExecControlLate` makes the race
  deterministic -- a grandchild writes to descriptor 3 a third of a second
  after its parent exits -- and is `heap-use-after-free` under `asan.sh`
  without the fix. **A read that outlives what says the run is over has to be
  cancelled by whatever frees the job, not by teardown alone.**
  **And `Write` was the other half of that struct's trouble: it blocked.** A
  synchronous `g_output_stream_write_all` on the UI thread deadlocks with any
  child that writes while it reads -- once `cat`'s stdout pipe fills it stops
  reading, the write waits for it, and the reader that would drain it is a
  callback on the loop the write is holding. 300 KB into `cat` hung for good
  (`testExecWriteLarge`). Lines are queued on the job (`unwritten`) and written
  one async operation at a time; each operation owns its `GBytes` and names the
  job only to look it up in `exec_jobs` when it answers, because the job may
  be freed -- and the operation cancelled -- while a line is in flight.
  **And a reaped leader is not an ended job.** Every signalling verb stopped at
  `reaped`, so `Timeout`, `Stop()` and `Kill()` did nothing to `sh -c "sleep 30
  & echo up"`, whose `sleep` holds stdout: no exit callback, a console program
  that never ended. `exec_job_signal` signals the **group** when the leader is
  reaped and the output is not drained -- a group keeps its id while any member
  lives, and an open pipe says one does -- and never falls back to `kill(pid)`,
  which after the reap could be a stranger. `testExecGrandchild` waits thirty
  seconds and fails three assertions on the old code.
  **`PrintRun` was the fourth to forget, and at teardown.** Its callback was
  released only by `done`, so `Printer.Send(a, cb)` then `Application.Quit(0)`
  aborted in `JS_FreeRuntime` (exit 134, `testPrintAtQuit` runs it as a
  child). `bta_printer_cleanup` cancels what is still waiting, cut loose from
  its handlers first. The run also holds the control's own wrapper now
  (`self`), since `run->w` was a raw `BtaWidget*` and a control built only to
  be printed could be collected under an open dialog -- the AudioPlayer
  keepalive's lesson, and absent from `gc_mark` for the same reason.
- **`Terminal.Run` was a tenth async shape, and nobody had counted it.**
  `vte_terminal_spawn_async` answers on a later turn and was handed the raw
  `BtaWidget*`, with no cancellable and nothing holding it: `t.Run(cmd);
  t.Delete(); t = null` plus a collection before the answer wrote into freed
  memory -- measured, twenty terminals and a 400 000-object ball are a
  `heap-use-after-free` in `on_spawned` under `build-asan`, and clean with the
  fix. The callback is handed the **scroller** now, referenced for the spawn,
  and asks it for its `BtaWidget` (`BTA_WIDGET_QUARK`, which the finaliser
  clears); none means nothing to report to, and the pty hangs the child up when
  the terminal goes. That is the cheap shape for any GIO-style callback on a
  widget: a reference to the GObject and a lookup through the quark, rather than
  a pointer to the wrapper. `testTerminalSpawnLifetime` runs it as a child, so
  under `tests/asan.sh` the report lands in the log that script reads.
- **A callback the program can replace from inside itself has to be held for
  its own call.** `Http.Server`'s `Request` is documented as replaceable while
  running, and `http_server_set_request` releases the old function at once --
  so a handler that did `srv.Request = next` freed the closure it was
  executing. **What is freed is the closure, not the code** (an arrow's
  bytecode lives in the constant pool of the function around it), so the
  use-after-free only happens when the handler reads a *captured* variable
  afterwards: a first test that allocated but captured nothing passed under
  ASan against the bug, and one that reads `served++` after the swap is
  `heap-use-after-free`. The handler is `JS_DupValue`'d across the call, and
  nothing after the call reads the server. Every other callback shape was
  checked: timers are held by GLib's dispatch, `File.Watch` and the Http
  deliverers by their `calling`/`dead` pair, events by `JS_GetProperty`'s own
  reference -- `Request` was the only one a program could replace mid-call.
- **The appearance stylesheet is read back, which is why its rebuild can only be
  held for a stretch with no JavaScript in it.** Every `Font`, `Padding`,
  `Radius`, `Shadow`, `Color`, `Border`, `Scale` or `Opacity` reloads the whole
  accumulated sheet, so loading a `.form` was quadratic in its styled controls:
  **50 → 112 ms, 100 → 667 ms, 200 → 2392 ms**, measured, against 5 ms for the
  same form with none. `bta_form_build` holds the rebuild around the whole tree
  and drops it once (**counted** -- a component with a `.form` of its own nests
  one build inside another), which is 14.8 ms at 200.
  **Coalescing it on an idle instead is wrong and looks right**, which is the
  part worth remembering: a `DrawingArea` takes its ink from its control's style
  context and `Save()` draws **synchronously**, so a program that sets
  `Foreground` and saves a PNG in the same turn gets the theme's colour.
  `tests/widgets` says so in one line -- *a drawing takes its ink from the
  control's Foreground* -- and two of `tests/ide`'s designer assertions agree.
  The rule generalises past CSS: **before deferring anything, ask what reads it
  back and whether that reader waits for a frame.**
- **The other four cost claims were measured and are fine, and the numbers are
  here so nobody has to guess again.** An external audit named five places the
  runtime is slow; one of them was real and is the paragraph above. These are
  the rest, on this machine, so a future *this looks expensive* has something to
  be compared against:
  - **A class looked up with no `.form`** compiles its identifier through
    `JS_Eval` per instance (`bta_lookup_global`). Two hundred project
    components: **2 ms** over the same form built from runtime classes, so about
    10 µs each.
  - **A `.form`'s prose-membership walk** (`bta_widget_text_prop_field`, once
    per property per node, `g_strsplit` every time) is inside a **5 ms** floor
    for two hundred controls -- it does not separate from the noise.
  - **Dispatching an event with no handler.** Every widget carries a motion
    controller at `GTK_PHASE_BUBBLE`, so a pointer over a twelve-deep tree
    raises **12.8 dispatches per position**, each building `<name>_<event>` and
    walking the form's prototype chain for a property that is not there.
    Measured over three full sweeps: 3850 dispatches, **one** of which found a
    handler, **580 ns each** and **2.2 ms** of continuous movement in three
    seconds. It scales with *depth*, not with handlers -- which is the wrong
    way round -- and is still 0.07 % of a core.
  - **Emptying a container** runs `indexOf` and `splice` through the interpreter
    on `__children`, which is superlinear: 100 children **1.4 ms**, 200 **3.7**,
    400 **10.5**, 800 **34.2** with `Clear()`. **`Clear()` is twice as fast as
    deleting children one at a time** (68.8 ms at 800), which is worth knowing
    because it is already the documented verb and now has a reason.

  None of the four is worth changing at the sizes a form reaches. What made them
  worth measuring is that the fifth, which read the same on paper, was two and a
  half seconds.
- **`form_path` walks the project on every miss, and a class built in code
  misses forever — deliberately, and here is the number to reconsider it
  against.** The index maps a class name to its `.form`; a hit is a hash lookup
  and a **miss throws the whole index away and re-walks the project and every
  library**, because a miss also means *a `.form` that appeared since*, which is
  the normal state of affairs while the IDE writes forms in the directory it is
  running from. The comment over the function argues that trade and the argument
  is good.
  What it does not say is that the other half of its own *or* — a class built
  entirely in code, which is legal and documented — misses on **every**
  instantiation, and that a miss is a **filesystem walk** whose cost scales with
  the project rather than with the program. Measured, a form of 200 components
  with no `.form` of their own:
  | project | that form | the same form of runtime classes |
  |---|---|---|
  | 6 files | 7.3 ms | 5.4 ms |
  | 300 files | **67.8 ms** | 5.3 ms |
  | 300 files + a library in `uses` | 69.5 ms | 5.4 ms |

  So about **0.31 ms per instantiation at 300 files**, against 0.01 ms at six,
  and the runtime-class form does not move at all.
  **Left as it is on purpose.** 70 ms is perceptible and not broken, and the fix
  that would work -- treating the index as a cache of the filesystem and
  invalidating it when *this process* writes under the project, since `File.Save`
  is the same runtime -- turns a heuristic into an invariant at the price of a
  silent failure if any writing verb is ever missed. That failure is precisely
  the one the current design exists to prevent.
  **Reconsider when** a project is big enough that opening a form is felt, or
  when components built in code become common -- **which `Widget.On(event, fn)`
  now encourages, so this is the live half of this note rather than the
  hypothetical one.** A palette or a list of cards built from `new <Component>()`
  is exactly the shape that misses on every instantiation, and the table above
  is what it costs. The same question belongs to `task_class_file`, which
  rebuilds on a miss too and for a cheaper reason: there, a miss means
  `Task.Start` is about to throw.
- **And the smallest one, measured anyway because reasoning about it is how the
  others went wrong.** `bta_sys_pending` walks two `GList`s about fifty times a
  second, and only in a **console** project -- `run_console` arms the poll, so an
  application with a window never asks. **20 ns a call**, so 1 µs per second of
  runtime. Counters would be state to keep in step for nothing.
  **The first attempt at that number said 3.1 µs, which is 150× wrong**, and the
  reason is worth more than the measurement: timing one call with
  `g_get_monotonic_time` on either side measures the clock. Two of those cost
  **88 ns** between them and the function returns **microseconds**, so a 20 ns
  body is rounding noise sitting under an instrument four times heavier than
  itself. **Time a thousand iterations and divide** -- and when a micro-benchmark
  reports something surprisingly expensive, suspect the instrument first.
- **Five things a static analyser flags here that are not leaks**, each read and
  dismissed, so the next run of one does not cost the same afternoon:
  `bta_widget.c:1124` (freed by `g_clear_pointer`, with the strv beside it by
  `g_strfreev`), `bta_controls.c:3196` (`strv` by `g_strfreev` on the line
  before), `bta_controls.c:4778` (a `NULL` widget cannot reach `cal_marks` --
  all five callers guard), `bta_http.c:3583` (the list and its elements are
  freed on both early-outs) and `bta_notebook.c:161` (the output is assigned on
  every path that returns success).

## Flatpak, and the packaging step

**One identity runs through the whole chain.** `project.json`'s `id` becomes
`Application.Id`; the runtime hands it to `GtkApplication` (Wayland's app id) and
to the program name (X11's `WM_CLASS`), so it is the window's class; the
project's `<id>.metainfo.xml` declares the same string; and a package installs
under it. The IDE asks for it when a project is created, *Project settings*
renames the metainfo when it changes, and the runtime refuses one that is not an
application id **at load**, naming the key.

The packaging step is [`lib/package`](docs/llm/package.md) — `Metainfo`, the
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
— and [`flatpak/ci/README.md`](flatpak/ci/README.md) is the format, the
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

## Tests

Six Bintana projects are run by the suite — `ide`, `markdown`, `qr`, `report`,
`smoke` and `widgets` — each printing `N passed, M failed` and quitting with a
non-zero status on failure. They are applications, not a harness — write
assertions the way the suite already does. A project is any directory under
`tests/` with a `project.json` that does not declare `main`, so adding one is
adding a directory: nothing lists them. (The console projects — `api`, `icons`,
`install`, `pack`, `runner`, `styles` — are tools and are driven by their own
`.sh`.)

**`tests/plugins/` is not a project**: it holds the C sources of the native
plugins the suite loads (`testplug.c` — the reference implementation
`docs/plugins.md` points at — plus a no-entry-point one and `abi1/`, a frozen
copy of the version-1 header). CMake builds them into
`<build>/testlibs/<name>/<name>.so`, and `tests/widgets` copies one from beside
the running binary into a scratch library. No `project.json`, so the runner
walks past it.

**`tests/runner` is the suite's own runner, and it is a Bintana project too** —
a console one (`"main"`), so it needs no display and can be the thing that decides
whether the projects need a virtual one. `tests/run.sh` is ten lines: find the
binary, say so when there is none, `exec` it. The binary it picks is the one the
runner reports as `Application.Executable`, so `BINTANA=<path>` needs nothing passed down.
Do not grow the shell script back — the display, the hang guard, the filtering and
the reporting all live in `tests/runner/Main.js`.

`tests/ide` loads the **real** `ide/**/*.js` (see its `project.json`) and drives
the IDE the way a user would. Its `.form` files are symlinks to the IDE's own,
so the two cannot drift — and **a form added to the IDE is a symlink added
here**, or the test project builds that dialog with no controls at all and the
first assignment to one of them throws `cannot set property 'Text' of
undefined`. The new `.js` has to go in `tests/ide/project.json`'s `sources` too;
a file listed in neither place is a class that never loads.

**The runner points `XDG_DATA_HOME` at a scratch directory under `/tmp`**
(`bta-suite-<pid>/data`), because `tests/ide`'s `apps` phase installs a menu
entry for real. Without it every suite run would leave a `bta-suite-app.desktop`
in the developer's menu, and only that phase would be able to say why. What is
deliberately *not* moved is `~/.config/bintana`: the projects' own settings
directory has always been written to by the tests, and `tests/ide`'s `settings`
and `session` phases are about it.

**`tests/report` is how a shipped library is tested, and the shape is worth
copying.** `Save()` runs the same `Canvas_Draw` synchronously against an image
surface, so `Canvas.Dump()` on the next line is *that page's* calls -- which is
how a banded document is asserted page by page without a screen and without
waiting for a frame a preview would only ever give you for the current one. The
five regressions it covers are in the file's header, and every one of them was
put back and watched go red: a test that passes against the bug it names is not
a test.

Event tests must make the round trip: assigning `TextBox1.Text` from JS has to
reach GTK, come back as a real `changed` signal, and land on
`TextBox1_Change`. Testing the JS side alone proves nothing.

**Always wrap `Form_Open` in try/catch in a test project.** An uncaught throw
aborts `Form_Open` before `Application.Quit`, and the run hangs until the runner's
timeout instead of failing. The same shape of hang comes from *nobody reporting*:
in both large projects something has to call the reporter when the last thing that
would have is filtered out.

**`tests/asan.sh` is worth a run after anything that touches lifetimes.** It
builds with clang (Fedora ships compiler-rt but not gcc's `libasan`), runs the
projects, and reports what `tests/lsan.supp` did not suppress. Both memory
bugs this codebase has had were use-after-free that only showed up as a crash on
some machines; the sanitizer says so on every machine. A third joined them and
was found by reading rather than by running: `Painter.LineDash` built its
refusal message out of the array *after* `g_free`, which came out right on every
normal build because `g_free` does not poison -- the rejection list now carries
`p.LineDash = [-1]`, which is what makes the sanitizer the thing that would say
so next time.

**When `asan.sh` fails talking about the compiler, the problem is the cache.**
A `build-asan/` left over from another toolchain keeps that compiler's absolute
path in `CMakeCache.txt`, and CMake refuses to change the compiler of an
existing cache -- so the run dies in `cmake_check_build_system` with *"is not a
full path to an existing compiler tool"* before building anything, naming a
`clang` that is simply gone. `CC=` does not help, because the cache wins.
**Delete `build-asan/` and let the script reconfigure**; it is generated, git
ignores it, and the script creates it when it is missing.

**A frame is not a promise.** `tests/ide/Driver.js` has `until(cond)`: it yields
until something is true instead of counting frames by hand. A text change
re-measures on a frame of GTK's choosing, and a machine under a sanitizer takes
more of them -- counting is what made two of these tests flaky.

**And the sharper version: never assert that something has *not* happened yet.**
`until` fixes waiting for a frame; nothing fixes racing one. `tests/widgets`
asserted `ScrollY === 0` immediately after `GotoLine(380)`, on the reasoning
that a scroll asked for through a text mark lands on a later frame -- which is
true when the view has no validated allocation and **false when it has one**,
because `gtk_text_view_scroll_to_mark` then honours it at once. Measured at
about one failure in five, standalone, on an idle machine; it read as a
regression three separate times during unrelated work, which is the real cost of
a test like this. The assertion is gone and the `until` below it carries the
half that is real -- *the scroll does arrive*. The documents that stated the
same thing as a certainty (`reference/widgets/Editor.md`, `plans/git-plan.md`)
say *may* now. **A negative about timing is not a property of the code; it is a
bet on the scheduler.**
**And the same bet can hide in a test that waits, because what it waits *for*
is not the only clock in it.** `testExecControlLate` starts a child whose
grandchild writes to descriptor 3 a third of a second later, and asserts the
line is dropped -- which is only true if the job was freed first, and the job is
freed on a loop that does not start until the rest of `Form_Open` has run.
Under AddressSanitizer that takes longer than 0.3 s, so the exit, the read and
the write were all pending at once, the read was dispatched first, the line was
delivered while the job was alive -- correct behaviour -- and the test went red
in every sanitized run while passing five out of five standalone. The sleep is
two seconds now, which is an order of magnitude of headroom for the free path.
The lesson is the same one: **find every clock a test depends on, not only the
one it waits on.** `tests/ide`'s `recovery` phase had one more: the IDE's own thirty-second
snapshot tick, which could land between answering the recovery offer and
asserting the snapshot was gone -- with the tab deliberately left dirty, so the
tick wrote a correct new one. Never inside an ordinary run, once under
`asan.sh`, whose `ide` takes ten minutes. The phase stops the tick and takes
its snapshots by hand.

**And a rectangle is not a promise either: measure it again before every
gesture.** The stack assertions took the overlay's rectangle once and aimed two
drops at it -- and what lands in a container changes that container's own
rectangle, so by the second drop the point was outside it. Green here, red under
`asan.sh`, which is the signature of this mistake rather than of a bug in the
code being tested. `middleOf(c)` re-reads `rectOf` each time and `settled(ide)`
goes between the gestures; three assertions came back green under the sanitizer
with nothing else changed.

**Anything that depends on layout needs a frame first.** `PickAt`, `OriginIn`
and an unset `Width`/`Height` all read GTK's allocation, and a widget that was
just created, or whose container was just made visible, has none until the main
loop runs again. `Form_Open` itself runs *before* the window is presented. This
is why `tests/ide/Driver.js` is a generator: each `yield` hands control back to
GTK for a frame. Add one after showing the designer, switching to a form tab,
or creating a control — before clicking on it.

## Verifying by hand

Some things the suite cannot see: rendering, real key and pointer delivery,
focus, window management. Checking them has repeatedly found what the tests
could not — z-order occlusion, a desktop stealing a shortcut, a relative path
breaking only under a real `cwd`, an icon that resolves and renders blank, a drag
that never starts because a `Button`'s gesture claimed the press.

**Ask in this order.** A screenshot is the last resort, not the first: looking at
one is expensive and proves nothing twice.

**1. Ask the running application.** Most questions are numeric, and a number can
become an assertion that stays in the suite:

```js
print(this.Dump());            // the widget tree, with what GTK really gave
this.Btn.Bounds()              // {X, Y, Width, Height}, allocated, window coords
this.Btn.Bounds(this.Panel1)   // the same in that container's coordinates
```

`Width`/`Height` report the **request**, which is a minimum — `Bounds()` is what
tells you a label declared 120 wide is really 433 and has stretched its window.
Note that `Bounds()` returns the drawn box, so a theme's margins make a `Button`
smaller than the size it was given; a `Panel` matches exactly.

**2. Ask the screenshot instead of reading it.** `tests/probe.sh` captures by
window name and answers questions about the pixels:

```sh
tests/probe.sh shot   "Bintana IDE" /tmp/s.png    # capture + geometry to click by
tests/probe.sh pixel  /tmp/s.png 30 49             # srgb(237,216,182)
tests/probe.sh region /tmp/s.png 400x200+300+120   # mean= spread=   (spread~0: blank)
tests/probe.sh diff   /tmp/a.png /tmp/b.png        # pixels that differ
```

A uniform region is an empty one: that is the shape of the blank-band bug, and
`region` is how it stays found.

**3. Look, only for what has to be judged by eye** — does this icon read as a
frame, is this dialog well composed. Crop to the part in question: a window costs
ten times the corner of it that matters.

When a screenshot and an in-app measurement disagree, believe the measurement.

Three things that will waste your time:

- **The window manager places the window differently on every run.** Get the
  geometry from `probe.sh shot` (or `xdotool getwindowgeometry --shell`) and click
  relative to it. Hardcoded coordinates from an earlier screenshot land outside
  the window and look exactly like "the app lost focus".
- **Activate a window before clicking it.** GTK draws an unfocused window greyed
  out (`:backdrop`) — which looks exactly like every button being disabled — and
  the click that focuses it is eaten. `probe.sh shot` activates; a bare `xdotool
  click` does not.
- **Capture the window, not the screen**, and make sure no earlier instance
  survived (`pkill -x bintana`). A leftover window overlapping the new one produces
  screenshots of a state that no longer exists — which reads as a rendering bug
  and is not one. Menus and drag icons are the exception: they are separate
  surfaces and only appear in a root capture.
- **A form is asked whether it is closing, and the answer is a return value.**
  `on_close_request` in `bta_controls.c` hands back what `Form_Close` returned, so
  **true keeps the window open** -- `KeyPress`'s convention, and returning nothing
  (which is every handler written before this) lets it go. It governs `Close()`
  as much as the X, so a Cancel button, Escape and the frame's button are one
  road. What a handler must not do is close its own window again from inside
  itself; `Application.Quit`, or a `Close()` from the dialog's answer, are a
  return to the main loop away and are fine. This is what `PoForm` and the IDE's
  own quit are built on -- both used to have to choose what the *ungovernable*
  path did, and both chose differently.
- **An editor must not lose what it does not model.** `Locale.Read` exists
  because the catalogue reader *discards* everything it cannot show -- fuzzy
  entries, comments, `#~` blocks -- and an editor built on that would destroy a
  translator's work the first time it saved. The trick that keeps it small:
  unmodelled lines ride along as raw strings on the entry and are written back
  untouched, so being lossless costs a `comments` array rather than a model of
  the whole format. The suite asserts *nothing lost* and *writing twice changes
  nothing*, not byte-identity -- re-wrapping a split value is spelling, and
  asserting bytes would be asserting a formatter nobody wrote.
  **And the promise is only as good as the writer, which is why `Locale.Write`
  is the runtime's and not eighty-seven lines of JavaScript in the IDE.** Two
  implementations of one format, one of them the reader's opposite number in C,
  is how the promise gets broken silently. A writer is also where a wrong type
  becomes a wrong file: a `msgid`, a form, a flag or a comment that is not text
  is refused naming the entry and the property -- `JS_ToCString` would have
  written a number as `"5"` and called it a translation -- and **the whole text
  is built before the file is touched**, so a refusal leaves the catalogue as it
  was rather than half rewritten.
- **Selecting a row must never start a process.** A tree selection moves with the
  arrow keys, so "open it when it is selected" -- which is what the IDE does for
  every file -- would spawn a translation editor once per row walked through. A
  catalogue is opened on `Activate` (double click, or Enter) instead, and the
  status bar says so, because a click that appears to do nothing is worse than
  either. That also means it is never *open*, so the tree's menu could not act on
  it the usual way: `selectedCatalogue` is what the left button pointed at, kept
  separately from the open file and released the moment anything else is chosen.
- **A right click does not move a `TreeView`'s selection.** So a context menu item
  that aims at the row it was opened over acts on a *different* row — whichever was
  selected last. The IDE's tree menu acts on the file that is **open** instead,
  which is what the File menu's Rename and Delete already did; the left button is
  what opens, so *select then ask* is the gesture. Found by right-clicking a form
  and getting a menu greyed out for the previous selection.
- **An uncaught error in a handler used to be a paragraph on stderr that nothing
  read.** The runtime prints one and carries on, which is right for an
  application -- a handler that throws should not take the window down -- and
  wrong for the suite: `GitForm` threw six TypeErrors into a run that reported
  *0 failed*, because the phase that opened it asserted the window existed and
  moved on. Every assertion it made was true and the window was broken.
  `tests/ide` installs `Application.OnError` now and counts one as a failure,
  with the first frame of its stack. **A new phase does not have to remember
  this**, which is the point; what it does mean is that a test deliberately
  provoking an error has to catch it.
- **`tests/ide/Driver.js` is forty-five phases, and the phase is the scope.** It used
  to be one 4000-line generator where every `const` shared one scope, so a name
  near the top collided with one added at the bottom and the suite died with
  `SyntaxError: invalid redefinition of lexical identifier` — three times in one
  sitting, over declarations 2000 lines apart. Add assertions inside the phase they
  belong to; a name only has to be unique within it now.
- **`tests/widgets` selects where `tests/ide` runs a prefix**, and the difference is
  the shape of the tests, not a missing feature: the widget tests each build what
  they need and delete it, so any one of them can run alone (`run.sh widgets record`
  is 71 assertions in 0.2 s). Its couplings are declared in `NEEDS`, both ways --
  the async tail checks what `Terminal` and `TimerShorthand` set up, so asking for
  either brings the other. A test whose deferred half lives in the tail and does not
  say so answers with half its assertions and looks complete.
- **The phases are a narrative, so a run can stop early but not start late.**
  `./tests/run.sh ide designer` runs the prefix ending at that phase —
  364 assertions against 2591 for the whole project -- 9.4 s against 265 on this
  machine -- which is what makes iterating on an early phase bearable. Each phase works on the project the ones before it built and
  renamed, so selecting one in the middle *alone* would fail on state that was
  never created.
- **`tests/ide` always passes a project, so `Form_Open`'s no-project branch is
  never taken.** Reading a field in `refresh()` that only `listFiles()` fills
  crashed `bintana ide` on startup with every one of the 967 assertions still passing —
  the welcome-page ones included, because the crash happens *after* them. Anything
  `refresh()` touches has to be declared as a class field (which is what the note on
  those fields says), and the driver now calls `ide.refresh()` on the welcome page
  to cover it.
- **The desktop grabs bare function keys.** On Xfce, `F2`, `F3` and `Alt+F2` open
  the application finder and never reach the app. Menu `shortcut` accepts a list
  for this reason: *Find next* is `["F3", "<Control>g"]` and only the second one
  fires here. Verified by hand — the accelerator is registered and correct, and
  the key simply never arrives.
- **And a stolen key steals the focus with it, which makes every test after it
  lie.** Pressing `F3` at the IDE opened the finder *in front of it*, so the next
  `Ctrl+G` went to the finder and looked like a broken accelerator, and the next
  `Escape` looked like an event the runtime never delivered. Both were fine. When
  a key does nothing, check `xdotool getactivewindow` before believing the app is
  at fault — and `pkill -x xfce4-appfinder` (never `pkill -f`, whose pattern
  matches the shell command containing it, killing your own shell).

Copy a project to `/tmp` before driving it interactively — a stray drag plus a
save will edit `examples/hello` for real.

## Traps

**This list is where the sentence from
[the rule about this file](#the-rule-about-this-file) usually belongs.** Every
entry below is something that cost somebody a debugging session and now costs a
paragraph. Add to it when you are surprised; nothing here was obvious to the
person who wrote it either.

- **Fedora's `pkg-config` does search `/usr/local`, and the way to ask whether
  it does answers wrongly.** `pkg-config --variable pc_path pkg-config` prints
  `/usr/lib64/pkgconfig:/usr/share/pkgconfig`, so `/usr/local/lib64/pkgconfig`
  reads as unsearchable -- and `pkg-config --cflags bintana` finds a `.pc` there
  anyway, because `/usr/bin/pkg-config` is a wrapper (`pkgconf-pkg-config`) that
  sets `PKG_CONFIG_LIBDIR=/usr/local/lib64/pkgconfig:/usr/local/share/pkgconfig:/usr/lib64/pkgconfig:/usr/share/pkgconfig`
  before exec'ing pkgconf, and a set `PKG_CONFIG_LIBDIR` **replaces** the
  compiled-in default rather than adding to it. This produced a wrong
  `docs/installing.md` once -- an "install to `/usr` on Fedora" that was never
  necessary. The question with a true answer is `pkg-config --cflags bintana`;
  the variable is a report about pkgconf and not about this machine's
  `pkg-config`. (The pc under `<build>/pkgconfig` is a different case: it is for
  building against a checkout with nothing installed at all.)
- **A plugin is a table and not a link, and every corner of that decision was
  arrived at by getting it wrong first.** The contract is
  `runtime/include/bta_plugin.h` -- the *only* header a plugin compiles against,
  installed with the runtime -- and a plugin links neither `bintana` nor
  QuickJS. What follows, each of which was assumed the other way at least once:
  - **`JS_NewCClosure` pads `argv` up to the declared arity but reports the
    actual `argc`.** So a C function declared with two arguments and called with
    none receives `argc == 0` and a pointer it may index to two entries. The
    first trampoline passed that short `argc` on and the plugin's `argv[1]` read
    NULL -- the fix is to carry the declared arity as the closure's `magic` and
    hand the plugin `max(argc, magic)`, which is what makes the header's promise
    true rather than aspirational.
  - **`JSValue` is a 16-byte struct in this build, not a `uint64_t`.** The
    public `BtaValue` is an opaque two-word struct and the host `memcpy`s in and
    out, so the header does not change when the engine's boxing does; a
    `G_STATIC_ASSERT(sizeof(JSValue) <= sizeof(BtaValue))` is what turns a
    future engine that grows past it into a build failure.
  - **Ownership is the API.** Everything a host verb returns is the plugin's;
    everything passed into `set`, `push` or a return is handed over. The first
    test plugin released a value it had already given to `set` and QuickJS
    aborted in `gc_decref_child`. `argv` and `text()` are borrowed until the
    callback returns -- and `text()`'s borrow is implemented here as a list of
    `JS_ToCString` conversions freed when the outermost call ends, because
    returning the engine's pointer would dangle and never freeing it would leak.
  - **`bta.h` and `quickjs.h` are deliberately not installed.** The day a plugin
    needs them the contract has become the runtime's internals, which is the
    thing this design exists to avoid: `BtaHost` is append-only, `BTA_PLUGIN_ABI`
    moves only for a real break, and a capability not in the table is a line to
    add on purpose rather than a symbol that happens to resolve.  **`call` was
    the first append** (a plugin handed a JavaScript function has to be able to
    invoke it), and it needed no bump: the golden `testplug-abi1` keeps working
    because a version-1 plugin never reads past `log`.  An appended capability
    also gets a `BTA_PLUGIN_HAS_<NAME>` macro, which is what lets one source be
    compiled against either header -- `testplug.c` guards `Apply` with it.
  - **Do not add `-rdynamic`.** Nothing needs it: the plugin has no undefined
    symbols, so there is nothing for the host to export and no collision to
    have. `g_module_open(path, G_MODULE_BIND_LOCAL)` in a library directory
    named `<name>/<name>.<G_MODULE_SUFFIX>` is the whole loader.
- **`cleanup` runs after the JavaScript context is gone, so it must not call the
  host.** The table's verbs all build values in a context that no longer exists,
  and a plugin that stored the `BtaHost *` and used it there would build values
  into freed memory. The contract says C resources only; the loader calls it
  after `JS_FreeRuntime`, in reverse `uses` order, and then closes the shared
  object.
- **A plugin's `init` runs before `rad.js`.** The runtime's own globals are there
  (`Application`, `Logger`), so `host->get(global, "Application")` answers -- but
  `Dictionary`, `Record` and every prototype convenience are not, because the
  prelude has not run. Anything that needs them belongs in the library's `.js`,
  which loads after `init` returns; the suite asserts that order (a library's
  `.js` sees the global the `.so` installed).
- **The test plugins are built by CMake and are not installed.** They land in
  `<build>/testlibs/<name>/<name>.so`, and `tests/widgets` copies one from beside
  the running binary -- `File.Directory(Application.Executable)` -- into a scratch
  library directory, which is what makes the test follow `BINTANA=<other-build>`.
  A shared object that is *there* and cannot be used stops the program, while a
  directory with no `.so` at all is an ordinary JavaScript library and says
  nothing; that asymmetry is the loader's, and both halves are asserted (`Plugin`).
  **One of them is the golden `testplug-abi1`**, compiled against the frozen
  version-1 header in `tests/plugins/abi1/`: reorder a field in `BtaHost` without
  bumping `BTA_PLUGIN_ABI` and the suite goes red -- measured by swapping
  `object`/`array` and watching `Fields()` come back `[]` -- which no plugin
  rebuilt from the current source can catch. A real bump deletes that directory,
  and its note says so.
- **The JS stack budget is bytes, and what it buys is levels -- a different
  number in each build.** `JS_SetMaxStackSize` is what stops a recursive walk of
  a widget tree before it reaches the real end of the stack, and the walks are
  recursive because the data is: the serialiser, the loader, the designer.
  Measured, serialising a tower of `Panel`s: **2 MB is a hundred levels in an
  ordinary build and ten under AddressSanitizer**, whose frames are about ten
  times fatter. Ten is exactly the depth of `MainForm.form`, so the sanitized
  suite had no headroom whatever and `tests/ide` failed in the `projects` phase
  with `Maximum call stack size exceeded` -- green in every ordinary run, red
  under the sanitizer, on a tree nobody had touched. Which is precisely the false
  failure `tests/asan.sh` exists to avoid producing rather than to produce. The
  budget follows the build now (6 MB under a sanitizer, 25 levels), both numbers
  well under the thread's 8 MB so a runaway still throws instead of crashing, and
  `tests/widgets`' `DeepSerialize` asserts fifteen levels in whatever build is
  running. **If you make a walk of the tree deeper per level, that is the number
  to re-measure.**
- **`Exec.Wait` used to stop at the first NUL, and nothing said so.** It was
  built on `g_subprocess_communicate_utf8`, which hands back a C string: a child
  whose answer contains a NUL had everything past it silently thrown away. That
  is exactly the tools this call exists for -- `git status -z`, `find -print0`,
  `xargs -0` all separate records with the one byte a file name cannot hold, so
  one file name with a space in it read fine and a *list* of them read as one
  entry. It captures `GBytes` now and builds the string with `JS_NewStringLen`.
  Two things that came with it: the bytes spelling of `communicate` **asserts**
  on a NULL stdin buffer where the utf8 one accepted it, so an empty `GBytes` is
  passed (every child has had a stdin pipe since `Write`); and a child whose
  output is not valid UTF-8 no longer fails the call, which is a widening and
  not a loss.
- **A `"Deleted"` from `File.Watch` does not mean the file is gone.** It means
  something happened to that path, and plenty of programs rewrite a file by
  taking the old one away and putting a new one there -- `git restore` among
  them, which is how discarding a change came to report *ClientsForm.js is no
  longer on disk* about a file that was sitting right there, restored. The event
  is a hint; the disk is the answer, and asking is one `File.Exists`. The same
  shape as every other trap in this list: a flag believed instead of a fact
  looked at.
- **A side by side diff is not two files side by side.** The viewer showed the
  old version on the left and the new one on the right, scrolled together, and
  that is genuinely useless: nothing says which lines are the change, and after
  the first added line the two columns are off by one, so the locked scrolling
  lines up code with unrelated code. What makes it a diff is the padding -- a
  `Gap` row facing every added line -- and the paint. `Ide.Diff` reads git's own
  unified output for both; it never computes a diff, and the reason is worth
  keeping: the pair a viewer is handed can be four thousand lines, and an LCS of
  that is a table of sixteen million cells.
- **git names a file from the root of the repository; the IDE names it from the
  root of the project.** They are the same sentence only when the project *is*
  the repository, which is what every test and every hand-run had been. Open
  `examples/clients` -- a project inside *this* repository -- and git says
  `examples/clients/ClientsForm.js` where `openInTab`, the tree's keys and
  `File.Join(project, …)` all say `ClientsForm.js`. Nothing errors: the tree
  marks nothing because no name ever matches, and the diff's worktree pane comes
  up **empty**, because it went looking for
  `<project>/examples/clients/ClientsForm.js`. `Ide.Git` keeps git's own answer
  (`rev-parse --show-prefix`) and crosses the boundary in `strip`/`full`; and
  every listing carries `-- .`, since a repository can hold more than this
  project and the panel must not offer to stage somebody else's folder.
- **A `Scroller` fills as well as scrolls, and the property that decides it is
  `Arrangement` -- which nothing said, so it was reported as a missing
  container.** Its slot is a `BtaFixed` by default, and a `Fixed` sizes what is
  in it at the content's own minimum: there is no design size for an anchor to
  keep a gap against (only a **form** has one -- the `is_form` note above), so
  `HAlign: "Fill"` on a scroller's content has nothing to fill and a declared
  `Width` is not even a floor on a `Fill` axis. Arranged `Horizontal` or
  `Vertical` the slot is a `GtkBox`, which stretches an expanding child across
  itself and lets it outgrow the view along itself. Measured, a `Grid` of
  `Homogeneous` tiles with a 180x130 floor in a 900x500 view: **one tile
  898x498, four 2x2 at 445x245, twenty a 924x538 grid with `ScrollMaxY 38`**,
  and the view 900x500 throughout. The same declarations unarranged leave the
  grid at its content's own floor -- **180x130 for the one tile and 366x266 for
  the four**, in the same 900x500 view, with the rest of it empty.
  `tests/widgets`' `FillScroll` asserts both halves and goes red on three
  assertions with the arrangement taken away.
  **What decides scrolling versus growing the window is `Scrollbars`, and a
  floor is not it**: the same twenty tiles under `Scrollbars: "Vertical"` take
  the window from 900 to 924 wide, with `MinWidth` set or not (measured both
  ways, four runs). An axis that may not scroll has to be given its content's
  minimum and propagates it outwards.
  `docs/issues/ISSUE-fill-and-scroll.md` is deleted as answered, and the
  lesson is the one that keeps recurring here: **before reporting a gap,
  measure the properties the container already has.** The report was written
  against `Grid` (fills, cannot scroll), `Flow` (scrolls, does not fill) and
  `Scroller` (documented as *content as big as it needs*, which is the default
  slot and not the only one) -- three true sentences, and the fourth was in
  nobody's reach because no document had put `Arrangement` and `Scroller` in
  the same paragraph.
- **A `Split` inside a `Fixed` gave its diff 46 pixels of a 620-pixel window.**
  Two mistakes that look like one. The window was a `Fixed` root with every
  region at an `X`, a `Y` and a height of its own, so a taller window gave the
  extra room to nobody -- that half is the rule
  [`docs/widgets.md`](docs/widgets.md#which-of-the-two-models-a-form-should-use)
  already states, *a window of regions is boxes*, written and then broken anyway.
  The half that made it unusable rather than merely rigid: the `Split`'s two
  children were bare `Panel`s with `Spacing` and nothing else, so **the
  expansion stopped there** -- everything inside them had `VExpand` and it
  counted for nothing, and the panes came out at the tab strip's natural height.
  `VExpand` on a control is a claim on the room *its parent has*; a parent that
  claims none has none to give. Measured both ways in `tests/ide` (`git`), which
  is what the assertion there is for: 46 pixels before, 395 after.
- **`refresh()` runs on every keystroke, so nothing in it may spawn a child.**
  The IDE's `refresh()` is called from typing, from selecting, from every tab
  switch; asking a tool a question there costs a process per event. `Git`'s
  branches were already filled in `refreshGit()` for this reason, and the
  remotes joined them: *is there anywhere to fetch from* reads `remoteNames`,
  which the last refresh worked out, and never `git remote`. The general shape:
  anything in `refresh()` must be a field somebody else filled.
- **A field initialiser does not beat the `.form` load.** A form's controls are
  built inside `Form`'s own constructor, i.e. inside `super()`, and a subclass's
  field initialisers run only after `super()` returns. So a handler for an event
  the **load itself** raises finds every helper on the class still `undefined` —
  a `Switcher` raises `Switch` when its first page makes `Current` go from nothing
  to zero, and a `Notebook` does the same when a page is added. `MainForm.js` said
  the opposite in a comment for as long as nobody added a handler for one of those:
  being a field rather than `Form_Open` fixes every event raised *after* the window
  exists, and nothing about the ones raised while it is being built. The traceback
  when it happens names `at Form (native)`. Such a handler guards
  (`if (this.events) …`) and says why.

  **It happened twice**, months of comments apart. `GitForm` shipped with its
  `Which` switcher raising `Switch` during its own `.form` load, and the handler
  read `this.Which.Current` on a window whose controls were not named yet. So a
  window whose `.form` holds a `Switcher` or a `Notebook` gets one `ready`
  question -- *do I have my IDE and my controls* -- that every handler the load
  can reach asks, rather than a check per handler that the next one forgets.
- A widget must be attached to its parent **before** X/Y are applied, or the
  coordinates never reach a live surface. The loader and `Container.AddNode`
  both do this in that order.
- **A `Fixed` slot is `BtaFixed`, not `GtkFixed`** (`runtime/src/bta_fixed.c`).
  It reads x/y/w/h and `HAlign`/`VAlign` off each child's `BtaWidget`, so moving
  a control is `gtk_widget_queue_allocate` on the parent and attaching one is a
  bare `gtk_widget_set_parent` — there are no coordinates to hand over and no
  per-child layout data to keep in step.
- **`BTA_IS_FIXED` and `bta_surface_is_fixed` are two questions.** The macro says
  the widget is one of our surfaces, which is what `Arrangement` may re-arrange;
  the function says which arrangement it is wearing *now*, since the same widget
  answers `Fixed` before lunch and `Horizontal` after. Reading the type where the
  arrangement was meant is how `HAlign` gets taken away from every child of a box
  (`widget_apply_align`). Its reference size is latched from its
  **first real allocation**; code that resizes a surface before it has ever been
  allocated is setting the design size, not resizing anything.
- **A `Split` used to let a window be made smaller than its own contents**, and
  the symptom is overlap rather than clipping: GTK's paned defaults to
  `shrink-*-child = TRUE`, so it reports a minimum of nothing and the halves are
  drawn over each other and over their neighbours. `build_split` turns both off.
  The cost is that a window's minimum becomes real -- the IDE's went from 720
  (broken at that size) to 1100, which is what `SideBar` 260, `SidePanel` 280 and
  the rest add up to. Lowering it means expressing those as split **positions**
  rather than child widths, which is a separate piece of work.
- **`MinWidth`/`MinHeight` mean nothing in a box.** They are the floor for a
  *stretched* control on a surface; in a box the floor is `Height`/`Width`
  itself, and `Expand` is what makes the control take more. `PoForm`'s editors
  got `MinHeight` first and were squeezed to 46px; `Height` plus `Expand` is the
  pair that gives a floor of 64 and growth to whatever there is.
- **A `Fixed` inside a hidden page latches the wrong design size, and the symptom
  is a whole panel laid out at the old window size.** A hidden `Switcher` page is
  never allocated, so its first allocation happens when it is *shown* -- and if
  the window was enlarged first, that is the size it latches. Every anchor under
  it then has `dx = 0` and nothing fills. Enlarging the IDE on the welcome page
  and then opening a project is the case: the workspace came up at 1100x720
  inside a 1500x950 window. **Not a runtime bug**: `WorkBox`, `SideBar` and
  `ConsoleBox` were `Fixed` when each of them is a *column* -- a label over a
  tree, a toolbar over a split -- with every child `Fill` at the full width and
  coordinates that never meant anything. A box has no design size to get wrong.
  (`ConsoleBox` is a `Notebook` now, for a further reason: how many pages it has
  depends on whether the build has VTE, so it is not something written down.)
  Reach for `Fixed` when a person drew it, not when the shape happens to be
  rectangles.
- **`Width` is not "has it been allocated", and a guard that asks it may be
  asking nothing.** `tests/ide`'s `whenLaidOut` waited for `FileTree.Width > 0`,
  and FileTree declared 260 -- so it answered before GTK had allocated anything
  and the guard returned immediately, for as long as the declaration was there.
  `Bounds()` is the allocation and nothing else. Swapping it in makes that guard
  wait for real, and it then times out, so something in the driver's startup does
  not lay the window out when it runs -- worth chasing, and noted where it lives.
- **`Margin` on a `Form` used to leave a transparent window**, and that is worth
  knowing because the symptom pointed nowhere near the cause. A margin is room
  *outside* a widget and outside a toplevel there is nothing, so GTK honoured it
  by insetting the window's *content* -- and the window's background is painted
  on the content, so what was left was a band of window that nothing drew:
  transparent under a compositor, black in an `import` capture. Measured, a form
  declaring `Width: 1120` came up as a 1120x620 X window with a 1104x604 form in
  it, and the right and bottom strips read `mean=0.567 spread=0.471` against
  `0.96 spread=0.01` for the same strips of a form without a margin. The two
  examples it happened to were the two using a `DrawingArea`, which is what the
  bug looked like it was about; it was the only two forms in the tree declaring
  `Margin` on the form.
  `w_set_margin` puts it on the surface for a form now (`margin_target`), so the
  window keeps its whole size and paints all of it and what moves is what is
  inside -- which is what anyone writing it meant. A menu bar is a sibling of the
  surface, so it still spans the window. The old workaround -- one `Panel`
  holding everything with the margin on that -- is no longer needed, though the
  two dialogs that use it are correct as they stand. `testFormMargin` asserts both
  halves, since either alone passes for the broken version.
- **A `Grid` on a `Fixed` surface negotiates with nobody.** Its neighbours are
  placed by coordinate and have no say, so a grid whose contents outgrow its
  declared width overflows them exactly as the row of buttons it replaced did.
  Putting the menu editor's six buttons in a grid changed *nothing* until the
  dialog itself stopped being a surface -- measured, not guessed: still 15px over
  the tree's edge afterwards. What makes columns give way to each other is the
  parent being elastic.
- **A form's contents can make it open wider than it was drawn, and that is what
  translation does to every dialog.** `bta_fixed_measure` reports the bounding box
  of each child's *minimum*, so a caption whose translated text outgrew its
  declared width pushes the surface out instead of clipping -- right, and the
  reason the anchor origin cannot be the first allocation. It used to be, so on a
  pushed form the design size *became* the pushed size: every anchor went inert
  and the extra room sat dead against the far edge. The IDE's own *New
  translation* dialog is where it was seen -- the input stopped 77px short and the
  buttons sat 85px left of the corner. **A form's declared `Width`/`Height` is the
  origin now**, and only a form's: a `Width` inside a box is a minimum, not a
  size, so a `Panel` a box stretched to 280 has no business calling its declared
  60 the design. Getting that wrong broke two assertions in `testAnchors` and is
  what the `is_form` check in `bta_fixed.c` is for.
- **The design height is the declared one less what sits around the surface,
  read off the widgets.** It was `MIN(declared, allocated)` -- a menu bar's
  subtraction guessed from the allocation, right only when the window opens at
  the size it declares. A form drawn 400 tall and opened at 300 (a remembered
  size, a `Resize` in `Form_Open`) latched 300, and a `Fill` panel drawn 380
  tall kept a negative gap at every size after: 560 tall in a 480 window,
  measured. Now it subtracts the other children of the surface's holder (the
  menu bar) and the surface's own margins, which are the same numbers whatever
  size the window happens to be; `testDesignHeightShort` is red without it.
- **A `Fill` child's far-side gap is part of what the surface has to measure.**
  `bta_fixed_measure` asked for `offset + minimum`, which is the left coordinate
  and nothing about the right margin -- so the control that grew pushed the
  surface by exactly its own growth and came out flush against the edge while
  every control beside it kept its 16px. Only `Fill`, whose promise is to keep
  *both* distances; adding a `Start` child's trailing gap would grow the surface
  by the whole margin it was drawn inside. Measuring needs the design size to know
  that gap and the first pass has none, so latching one queues a resize: **a
  pushed form is laid out twice, and `Bounds().Width > 1` is true a frame before
  the layout is right.** That cost a red test that was measuring the first frame.
- **And the floor is applied *after* the anchor, growing away from the anchored
  edge.** A control that outgrew its declared width would otherwise take its own
  growth *and* the whole slack, ending up past the edge it is anchored to.
  `anchor_axis` takes the declared size and the floor separately for this reason;
  it used to take `max(declared, floor)` and add the slack to that.
- **`Ellipsize` and `Wrap` collapse a label's width request, so a label with no
  declared `Width` has nothing to wrap or ellipsize into.** `label_fit` sets
  `max-width-chars = 1` for either, and GTK clamps the request back up to the
  declared `Width` -- which a value label in a `Grid` cell has not got, so a
  table of forty values drawn while building `examples/factory` came out as a
  column of `...` while `Text` answered every one of them. It reads as a table
  of missing values and it is a table of labels with no box; the fix is the
  width or not asking, never the label.
- **An anchor keeps the gap a control was *drawn* with, so a container can only
  be drawn in coordinates if its size follows from what the `.form` declares.**
  A guess taken from a measurement is wrong for good: the IDE's `SidePanel` is
  the split's height minus a tab strip the theme sizes, and drawing `PropGrid`
  against a measured 431 left it 4px outside a real 427 — at every window size,
  because the negative gap is preserved like any other. That panel is a column
  for this reason, and so are `WorkArea` and the views inside `Tabs`.
- **A surface stretched to room that is nobody's design size must have
  `Anchored` off.** The designer's `Surface`/`Glass` are sized by the IDE, not by
  the form on them, so anchoring showed every control resized to the canvas — a
  `TextBox` declaring 380 drawn at 504. `Designer.js` turns it off for both. The
  flag lives on the container's `BtaWidget` as well as in the layout manager,
  because a new manager has nowhere to read it from; `cont_set_arrangement`
  carries it over.
- **A `GtkPaned` that cannot give a child its minimum hands it the space
  anyway.** The design canvas demanded the full width of the form on it, so
  widening the property panel pushed the canvas 120px outside its own half of the
  split and over that panel. Content whose size is not its parent's business goes
  in a `Scroller`: the view is the room there is, the board is as big as what is
  on it. Making the board "ask for no room" instead is not the fix — it clips,
  and a form bigger than the canvas becomes unreachable, which is what stopped
  `MainForm` from being editable in its own designer.
- **Taking a child out mirrors putting it in, per kind of slot.**
  `bta_container_detach` has a branch each for `BtaFixed`, `GtkBox`, a notebook
  page, `GtkStack`, `GtkGrid`, `GtkPaned` and `GtkOverlay`, and each one is the
  inverse of the matching branch in the attach above it. Three defects came from
  that symmetry being incomplete, all found at once by an application that
  rebuilt a container:
  - `GtkGrid` had **no branch**, so `Clear`/`Delete`/`Remove` on a grid threw
    `cannot remove from this container`. Now `gtk_grid_remove`, with the existing
    `bta_grid_reflow` closing the hole.
  - `bta_container_clear` walked `gtk_widget_get_first_child` and unparented
    anything that was not ours — a paned's drag handle among them, which is three
    `Gtk-CRITICAL gtk_widget_unparent` per call and success reported anyway. It
    now collects what is ours in one pass and detaches in a second. **The two
    passes are load-bearing**: detaching moves the sibling list, so a
    `while (first_child)` loop only terminates while every child is going.
  - `GtkPaned` and `GtkOverlay` were *unparented* rather than cleared through the
    property holding them, so GTK kept its pointer and the container went on
    believing it was full — a cleared split refused the next `Add`, a cleared
    overlay tripped an assertion. Latent until something refilled one.
  - And a fourth, later: taking the **base layer** out of a `GtkOverlay` left
    floaters with nothing filling, and `Children[0]` no longer the base — which
    is the whole of what an index means in a stack. Attach makes the first child
    the base, so detach promotes the next one, guarded by
    `gtk_widget_in_destruction` because GTK unparents everything in dispose and
    promoting a child on its way out is handing `set_child` a corpse.
  The test to keep is `tests/widgets`' `Removal`: fill, empty, fill again, on
  every container. Nothing had asked for that round trip before.
- **Open: two `GLib-GObject-CRITICAL: instance has no handler with id` at
  teardown.** Reproducible, and not ours to explain yet. It fires only after
  `testTabAction`'s exact sequence — a notebook action widget adopted, replaced,
  cleared, then re-adopted at the other end, then the notebook deleted — and
  **only when the process tears down**, never during a step. `SetAction` on its
  own, `Strip` through every value, and deleting a notebook, a switcher or an
  action widget each emit nothing. What produces that message is
  `g_signal_handler_disconnect(instance, id)`, and the only call by id in this
  repository is `bta_tree.c:on_unbind_row` — instrumented, and it never fires for
  this. **The caller is now named, and it is GTK's own.** From a backtrace under
  the suite's exact child invocation — which is the part that had been getting in
  the way, because the project does not run its tests unless it is started the way
  the runner starts it:

      xvfb-run -a env G_DEBUG=fatal-criticals \
          gdb -batch -ex run -ex "bt 30" \
          --args ./build/bintana --strict tests/widgets 99999

  `--strict` and the pid argument are both required; without them the process
  opens and exits without running anything, and the critical never comes. It
  reproduces on the first try, and the frames are:

      g_signal_handler_disconnect
      gtk_notebook_remove_tab_label
      gtk_notebook_remove
      gtk_notebook_dispose
      g_object_unref
      widget_finalizer            ← the unref of w->gtk

  So the handler is `page->mnemonic_activate_signal`, which GTK connects on a
  page's **tab label** and disconnects when the page goes, and the id is already
  stale when dispose reaches it. Two things narrow what remains: the teardown is
  driven from `widget_finalizer`, so it runs **inside a QuickJS collection cycle,
  in no particular order** — the same hazard `widget_disconnect_tree` above was
  written for — and `tests/asan.sh` is clean over this path, which says the
  instance is a live object that has lost the handler rather than freed memory.
  Still open, and still two lines with nothing failing; but it starts from the
  frames above now, and **not** from `_by_data`, which this note used to blame and
  which the backtrace clears: our sweeps pass the `BtaWidget` as data and GTK's
  handler carries the notebook, so they cannot be reaching it.
- **A geometry is the display's range, not `int32`'s.** `bta_to_int` accepts
  anything an integer holds, and two failures were a long way from the
  assignment: `Width = 2147483000` grew the window past what X can allocate and
  the process died of `BadAlloc`, and `X = 2147483600` with `HAlign: "End"`
  overflowed `offset + size` in `bta_fixed.c` -- undefined in C, measured as a
  `Bounds().X` of `-2147483648`. `geom_in_range` refuses outside ±32767 for a
  coordinate and `-1..32767` for a size (`-1` is *not asked*, what a control
  starts with and what `Resize(w)` carries for the height). The range check is
  in the setters rather than the layout because a clamp there would make a
  property read back something the program did not write.
- **Every numeric setter goes through `bta_to_number` / `bta_to_int`, and must.**
  `JS_ToInt32` cannot fail: ToNumber of a string that is not a number is NaN and
  ToInt32(NaN) is 0, so a setter that converts its own value silently accepts
  anything. `Margin = "0 0 0 12"` — `Padding`'s spelling — was a zero in a
  delivered application, with no throw and no gap to see. **And a range check is
  not a type check**: NaN fails every comparison, so `FontScale` and `Opacity`
  validated their range and still let a word through. Twenty-eight setters, one
  helper; `""` and `null` stay `0`, and `Radius`/`Padding`/`Shadow`/`Border` go
  through `sizes_parse` and are untouched. A new numeric property that calls
  `JS_ToInt32` directly is the regression to watch for.
  **And it was never only setters.** An audit found forty-five *method*
  arguments still converting with a bare `JS_ToInt32` -- every list's
  `RemoveRow`/`Select`/`Activate`/`Reveal`, `RemovePage`, the table's
  `Cell`/`SetCell`/`SortBy`, the editors' line verbs, `Move`/`Resize` -- so
  `lb.RemoveRow(undefined)`, or a key passed where an index goes, quietly took
  out **the first row**. The rule was written as a rule about setters and read
  as one; the danger is a conversion, wherever it is. They are `bta_to_int`
  with the method's name now, and `testArgumentRefusals` holds a sample of each
  family. The same sweep found the timer: `setTimer` read its delay with
  `JS_ToInt32`, so `Timer.Every("abc", fn)` ran on every turn of the loop and
  `3e9` wrapped negative into `0`. It is `bta_to_number`, clamped to a `guint`
  (Infinity is forty-nine days), and `Timer.After`/`Every` refuse a tick that is
  not a function -- `fire` skipped one in silence, so `Timer.After(fn, 300)`,
  the arguments swapped, ran nothing ever. Found by making exactly that mistake
  in a probe during the same audit.
- **`Arrangement` is only on a container whose slot is a `BtaFixed`.** `Panel`,
  `Frame`, `Expander`, `Scroller`, `Form` and a `Component` have one; `Split`
  overrides the property with `Horizontal`/`Vertical` and no `Fixed`; `Grid`,
  `Flow`, `RowList`, `Overlay`, `Notebook` and `Switcher` throw *arranges its
  children by its own nature* and read `""`. It may be set at **any** time,
  children and all — `cont_set_arrangement` swaps the layout manager and nothing
  moves. (It used to refuse once a container held something, which is what made
  the property useless for the one thing it exists for; that restriction is gone
  and so is the note that used to be here.)
- **An alignment is carried out by the *parent's* layout, so the parent is what
  has to be told.** `gtk_widget_set_halign` queues an allocate on the **child**,
  and that only re-allocates the child into the rectangle it already had -- so
  the value is stored and never applied. Measured on a layer of an `Overlay`:
  declared `Center`, then set to `Start` from code, it stayed at (185, 91) and
  moved to (0, 0) only when something else made the overlay lay out, which is
  how it was found -- hiding the layer and showing it again. `widget_apply_align`
  queues the allocate on the parent for that reason, for every kind of container
  and not only a `BtaFixed` (which had its own queue in `bta_widget_relayout`
  because it reads x/y off the child). Anything a person changes in a property
  grid is exactly that sequence, so this is the shape of bug that only ever
  shows up by hand: `tests/widgets`' `Reorder` now asserts the move.
- **`HAlign`/`VAlign` are carried out by two different things, and the container
  decides which.** In a box they are GTK's `halign`/`valign`; on a `BtaFixed`
  they are the anchor rule and GTK's must stay `Fill`, or GTK would align the
  widget *inside* the rectangle the surface just worked out -- a control drawn
  200 wide with `Start` comes back its natural width. `widget_apply_align()` is
  re-asked on every adoption and every relayout, because a control changes
  containers and `Arrangement` alone turns the row under it into a surface. The
  default is `Auto` and not `Start` for the same reason: the two containers
  disagree about what nothing-was-asked-for means, and a shared default would
  have moved every box child ever written.
- **A `GtkStack` cannot be reordered and its pages are addressed by name.** GTK
  offers nothing for either, so a `Switcher` counts pages by walking the stack's
  children and `Reorder` takes every page out and puts it back -- referencing
  each one first, since removing it drops the last reference GTK holds, and
  blocking the `Switch` handler for the duration, or a rebuild that ends where it
  started reports a fistful of switches nobody made. A page's title lives on the
  `GtkStackPage`, which goes away with the page, so it is carried across by hand.
- **An order lives in one function, `bta_container_reorder`, and three callers
  ask it**: `Reorder(child, index)`, `Raise`/`Lower`, and the designer's drag.
  It sits beside `bta_container_attach`/`detach` because it is the same
  knowledge — what a slot does with a child — and because an index has to mean
  the same thing to all three. It did not: `Raise()` on an overlay's base moved
  it to last sibling while `overlay->child` still pointed at it, so the base went
  on filling and painted *over* its own floaters. `Container.Placement` is the
  same knowledge published (`Coordinates` `Order` `Layers` `Pages` `Halves`),
  because the IDE was keeping a table of class names instead and it drifted:
  `Overlay`, `Flow` and `RowList` reached the palette classified as boxes.
- **A `GtkListBox` and a `GtkFlowBox` keep their children in a `GSequence` of
  their own, so a sibling move is not a reorder.** Indices, the keyboard walk,
  headers and the filter all read that sequence, and `gtk_widget_insert_after`
  does not touch it — so a reorder goes out through `remove` and back in through
  `insert`, at which point three things bite. The wrapper must be referenced
  across the two calls: the box holds the only reference and `remove` ends in
  `gtk_widget_unparent`, so a row finalised between them takes the control's
  parent with it and leaves a control that exists, answers, and is in no list.
  The handlers must be blocked, or a move that ends where it began reports a
  `Select` nobody made. And **the row must be unselected before the remove**:
  `gtk_list_box_remove` clears the box's own pointer but leaves
  `ROW_PRIV(row)->selected` set, and `gtk_list_box_select_row` returns early on a
  row that already claims to be selected — so the row comes back *drawing*
  selected while `Index` answers `-1`, and nothing but a click gets out of it.
  One more, for the future: `insert` ignores its position when a sort function is
  set, so a `Sorted` property on either would make `Reorder` a silent no-op.
- **A `GtkAspectFrame` is not a `GtkFrame`**, and that one fact is most of what
  `AspectFrame` cost. It descends straight from `GtkWidget`, has no caption, and
  its CSS node is `aspectframe` -- so `GTK_IS_FRAME` does not catch it, both
  `bta_container_attach` and `bta_container_detach` need a branch of their own,
  and the detach goes through `gtk_aspect_frame_set_child(af, NULL)` rather than
  an unparent, or GTK keeps its pointer and the container goes on believing it is
  full. Its `Placement` is `Single`, the sixth word: one child and one place, so
  a gesture there is *land* -- told `Coordinates` an editor offers X/Y that do
  nothing, told `Order` it asks for an order the container has not got.
- **A `GtkPopover` is a surface and not a widget in the layout, and five things
  were measured before it could be one of ours.** Each is a bullet because each
  one changed the design:
  - **It contributes no measure.** A box holding a button and a popover as tall
    as a paragraph still asks for the button's 34 pixels, closed *and* open --
    which is what makes it safe to draw one into a `.form` at all.
  - **GTK 4.22 wraps its content in a `GtkPopoverContent` of its own**, so
    `gtk_widget_get_first_child(popover)` is that wrapper and the widget an
    application means is `gtk_popover_get_child`. Every walk over a slot that
    can be a popover goes through `bta_slot_first_child` now (`Children`,
    `Clear`, the binding cascade, `bta_container_count`, and the
    `Default`/`Cancel` searches `bta_widget_flagged` and `form_keep_one` --
    which this sentence claimed for a commit while those two still read GTK's
    first child, so a `Cancel` button inside a popover was never found) and `bta_container_detach` finds the popover as the content's
    *ancestor* -- without which `Remove()` of the content refused with *cannot
    remove from this container*, and `Children` answered `0` about a popover
    holding a `RowList`. **A `GtkPopover` setter is a property, not an
    unparent**: `Clear`, `Remove` and a second `Add` all go through
    `gtk_popover_set_child`.
  - **`gtk_widget_set_visible(TRUE)` before there is a toplevel is a segfault**,
    not a warning: the popup surface is made against a toplevel that is not
    there. That is why `Visible` is **read-only on a `Popover`** -- the one
    place a class shadows a property `Widget` already had -- and why `Show()`
    refuses and `Popup(anchor)` is the only verb. `Widget.Member("Popover",
    "Visible")` answers `ReadOnly`, so a `.form` that declares it is refused at
    load; the serialiser never writes it, and the property grid never offers
    it. (`tests/api.sh` flags the shadow; it is on the deliberate list there.)
  - **GTK's autohide focus walk asserts on a window with no focus.** With
    `Autohide` on and nothing focusable inside, `gtk_popover_focus` reads
    `gtk_root_get_focus` and calls `gtk_widget_is_ancestor` on the `NULL` --
    one critical per open, measured, after a popover closed onto a panel that
    cannot take the focus. `Popup` seeds one: the anchor if it can take it
    (which also keeps the keyboard in the field that opened a suggestion list),
    otherwise the window's own first focusable control.
  - **Only a container that lays children out through a layout manager can
    hold one.** GTK presents a popover from `gtk_layout_manager_allocate`,
    which skips it through `should_layout`; a `GtkPaned`'s halves, a
    `GtkAspectFrame`'s child, a notebook's or stack's page and an overlay's base
    are allocated by the container itself, so the popover got an ordinary
    rectangle and opening it was `pixman_region32_init_rect: Invalid
    rectangle` (a page added `gtk_widget_map` criticals the moment it was
    added). Measured by probe on each; a surface, a `Grid`, a `Flow` and a
    `RowList` are clean. `bta_container_attach` refuses the rest, and an
    `Overlay` whole: its floaters are laid out properly, but `Reorder(x, 0)`,
    `Lower()` and the base leaving all promote one to base.
  - **`Popup` asks the popover's own container, not only the anchor.** The point
    is computed in the container's coordinates, and a hidden one has none: the
    popover opened pointing at nothing while `Open` fired. And the focus seed
    raises `GotFocus` synchronously, so everything read before it is read again
    after -- a handler can take the popover out between the two.
  - **A closed popover is not a Tab stop, and leaving it in the list broke the
    walk.** GTK sets the surface's `focus_child` to the popover while it is
    open and a closed one goes on naming it, so `bta_fixed_focus` started
    *after* the popover it could not focus and found nothing left -- `FocusNext()`
    answered `false` on a panel full of controls. `bta_fixed_focus` skips
    `GTK_IS_POPOVER` when it builds its stops.
- **`settableProperties` had the override rule backwards, and a read-only
  property could not be taken away.** The walk collected a name if *any* class
  in the chain had both accessors, so a subclass's getter-only declaration was
  skipped and the base's setter was offered, serialised and loaded anyway --
  exactly the `Popover.Visible` that has to be refused. It is the boundary
  `Widget.Member` already walked: **the most derived class that declares a name
  decides whether it is settable**, tracked with a `seen` list rather than a
  check on the result. `forms.js`, and the general fix rather than a special
  case for one class.
- **A margin that uses up the paper is a loop that never ends.** `lib/markdown`'s
  `pageBreaks` advanced by the printable height, and `Margins = 421` on A4
  leaves none: `SavePdf` and `Send` hung the program. It refuses before the
  loop and throws if a page ever fails to advance; the object form of `Margins`
  refuses a side that is not a finite number in both `markdown` and `report`,
  which the number form always had.
- **`printf("%g")` writes the locale's decimal separator, and this machine writes
  a comma.** `Ratio = 1.5` came back `"1,5"`, which is what the `.form` would
  then carry and what `JSON.parse` would read as **nothing** -- the same fault
  the QuickJS number patch exists for, one layer up, and it was caught by a test
  asserting the round trip rather than by anybody reading the code.
  `g_ascii_dtostr` on the way out, `g_ascii_strtod` on the way in, for any
  property that keeps a number as text. **`Painter.Foreground` was the third
  one**, and it is the one that threw: `rgba(%d,%d,%d,%.3g)` read
  `rgba(32,64,96,0,5)` here, `lib/charts` assigned it straight to `p.Color`, and
  `gdk_rgba_parse` refused it from inside a `Draw`. The alpha goes through
  `g_ascii_formatd`, and `tests/widgets` matches the **whole** string now -- the
  prefix test it had accepted the comma.
- **The order of the two parsers is the whole of a number setter, and getting it
  backwards is silent.** `DecimalBox.Value` takes machine text (`"1234.567"`,
  what a `.form` and `Decimal.toJSON()` carry) and this desktop's spelling
  (`"1.234,56"`) -- and the locale parser **first** read Argentina's grouping
  separator as a decimal point, so `"1234.567"` became `1234567`: a value off by
  a thousand, from a file the serialiser had written correctly. Machine text
  first, locale second, and only text that is not machine-readable falls
  through.
- **A `Decimal`-valued property was invisible to the serialiser, and
  `savableValue` is where.** The serialiser walks the prototype chain for
  accessors and then filters what it found -- strings, numbers, booleans and
  arrays -- so every object was skipped as "not a plain value". A `Decimal` is an
  object and **is** savable (`JSON.stringify` writes it through its own
  `toJSON`), so `DecimalBox.Value` was not written and a field came back at zero
  with nothing said. `v instanceof Decimal` is the one object that passes the
  filter; a new property holding one needs no other change, and one holding a
  *different* object will be skipped the same way.
- **`GTK_INPUT_ERROR` leaves GTK using an uninitialized `new_value`.** The
  documented way to refuse what was typed into a `GtkSpinButton` is to answer
  `GTK_INPUT_ERROR` from the `input` handler, and it reads a `gdouble` the
  handler never wrote -- measured, the field came out holding a denormal. A
  refusal restores the text itself (`gtk_editable_set_text` on the entry) and
  answers `true`, which is what `DecimalBox` does; the double is only a view and
  the exact value lives in a note, so the handler always has the text it wants.
- **A `.desktop` entry's `Exec` is quoted twice, and the outer layer is not the
  one you think.** `Exec` has a quoting of its own -- every argument in double
  quotes, with `"`, `` ` ``, `$` and `\` escaped inside them, and `%` doubled
  because a single one is the format's field-code marker (`%f`, `%u`) -- and all
  of *that* is a string value in a key file, which escapes the backslashes again
  on the way out. So the file a hand-written command produces is either rejected
  by `desktop-file-validate` (`contains a non-escaped character '$' in a quote,
  but it should be escaped with two backslashes`) or accepted and splits the
  argument in two at launch. **The parser to test against is `gio launch`**, a
  real `GDesktopAppInfo` and the same road a menu takes; `desktop-file-validate`
  is the other half, and it only checks the file. `Desktop.Entries.Exec(argv)`
  is that whole job, and `tests/widgets` (`Desktop`) installs an entry, launches
  it with `gio` and reads the arguments back -- space, `%`, `"`, `$`, `\` and an
  accent in one command. Writing the string by hand in JS is the regression to
  watch for, and it is the build-another-parser mistake this file keeps warning
  about.
- **A generated menu entry is a file a test can leave in somebody's menu.**
  `tests/ide`'s `apps` phase installs a real `.desktop` under
  `$XDG_DATA_HOME/applications`, which without care is the developer's own menu
  -- surviving the run as an entry for a project in `/tmp`. The runner points
  `XDG_DATA_HOME` at a scratch directory (`bta-suite-<pid>/data`) for exactly
  this, and the test still removes what it installs, because `tests/try.sh` has
  no runner to isolate it.
- **`GKeyFile` drops the translations this machine does not speak, unless it is
  told not to.** Without `G_KEY_FILE_KEEP_TRANSLATIONS`, a `Key[locale]` is
  kept only when the locale is one of `g_get_language_names()`'s -- so
  `Name[es]` is a key on a desktop set to Spanish and is **not** on one set to
  English, and `Desktop.Entries.Read` lost every translation on CI's `C` locale
  while passing in `es_AR` here. A read-and-write-back is how a file loses what
  nobody looked at, and this one is invisible where it is written: any
  `GKeyFile` a program means to write back loads with the flag. Caught by the
  first CI run that got as far as the suite (`tests/widgets`'s `Desktop`).
- **The compiler in CI is older than the one here.** The runner is GCC 13 and
  this machine is GCC 16, so a name the new one knows is a *syntax* error there:
  `#if defined(__SANITIZE_ADDRESS__) || (defined(__has_feature) && __has_feature(address_sanitizer))`
  reads as a guard and is not one -- `&&` does not short-circuit the token, and
  GCC 13 stops with `missing binary operator before token "("`. Clang's
  `__has_feature` question is nested inside the `#ifdef` that knows the name
  exists (`bta_runtime.c`), and any compiler-version conditional added here is
  the same shape of risk: the runner is the only GCC 13 this repository has.
- **And so is its GTK, which is the one that actually bit.** The runner is
  Ubuntu 24.04 with GTK **4.14** while this machine has **4.22**, so a name added
  since 4.15 compiles here and is an *undeclared identifier* there:
  `GDK_ACTION_NONE` is an enumerator only since **4.20**
  (`GDK_AVAILABLE_ENUMERATOR_IN_4_20` in `gdk/gdkenums.h`) and `bta_widget.c`
  returned it for a refused drag -- green here, `error: 'GDK_ACTION_NONE'
  undeclared` on the runner, and the floor this runtime declares is 4.10. `0` is
  the zero of the flags type and says it in every version. **A new GTK or GDK
  name is checked against the floor, not against this machine**: grep the header
  for its `GDK_AVAILABLE_IN_*`, and when it is newer, spell the older thing.
- **In an `Overlay` the bottom of the stack is the layer that fills.** The base
  is a GTK *property* (`gtk_overlay_set_child`) and the floaters are a list, so
  `Reorder(child, 0)` swaps the property rather than moving a sibling — both
  widgets referenced across it, since `set_child` refuses a widget that still has
  a parent and unparents whoever was base. That makes `Lower()` on a floater mean
  *become the base*, which is a change in what that verb does in one container
  and is written down in `llm/controls.md` and `widgets.md` for that reason. A
  base swap reparents two widgets (unrealize/realize); a move among floaters is
  one `insert_after` and reparents nothing.
- `GtkTreeListModel`'s child-model callback must never return `NULL`. Returning
  it for a childless node marks that node a leaf permanently, and children
  added later never appear. `bta_tree.c` returns the empty store instead and
  hides the expander reactively.
- `Width`/`Height` are `size_request`, i.e. a **minimum** — *except* on an axis
  whose `HAlign`/`VAlign` is `Fill`, where the size is derived and the request is
  the control's floor (`MinWidth`/`MinHeight`, or its natural minimum) instead.
  A control whose natural size exceeds the request renders larger than the
  `.form` says.
- Callers legitimately pass `w->name` back into `bta_widget_bind`; copy before
  freeing.
- A `RowList` puts every child in a `GtkListBoxRow` of its own, so a child's
  GTK parent is that row and not the slot. `bta_slot_child` looks through it;
  code that walks a slot's children by hand will not.
- **A finalised `BtaWidget` must not still be reachable from GTK.** The
  `GtkWidget` usually outlives it (the container holds the last reference) and
  GTK emits signals *while being destroyed*: a notebook removing a page emits
  `switch-page`, a list box emits `row-selected`. At shutdown that runs with
  siblings already freed. `widget_disconnect_all` unhooks by `data` on
  `gtk`/`inner`/`slot`, on their controllers, and on anything handed to
  `bta_widget_watch` — which is what a module that connects a signal on something
  that is **not** the widget (a `GtkTextBuffer`, a selection model) has to call.
- **Every path that adds a child has to call `bta_widget_adopt`, and every path
  that removes one `bta_widget_release`.** The JS wrapper owns the `BtaWidget`: a
  child only GTK holds gets collected while GTK still shows it, and the next mouse
  motion over it reads freed memory. It bit
  `Notebook.Append`, and went unnoticed while the IDE happened to keep a
  reference to every page of its own. `Notebook.Remove` had the mirror image of it:
  it dropped the page without releasing the reference, so the wrappers piled up.
- **GTK4 keeps an unowned pointer to a window's default widget, and takes a CSS
  class off it when it is replaced.** So deleting the button that is
  `Default` leaves `gtk_window_set_default_widget`'s next call operating on freed
  memory — three GTK-CRITICALs (`remove_css_class`, `queue_draw`,
  `g_object_notify`) at whatever touches the window *after*, which reads like a
  bug in that. `bta_container_detach` clears it for the whole subtree being
  removed, because detaching the panel a default button sits in leaves the
  pointer just as dangling as detaching the button.
- **A window-scoped property cannot be pushed to GTK from its setter, and the
  designer is why.** `Button.Default` is one: the obvious setter calls
  `gtk_window_set_default_widget`, and the designer builds the controls of the
  form it is *drawing* inside the IDE's own window, where `bta_container_attach`
  binds every one of them to `MainForm`. Both cases are then a button whose form
  is a form whose widget is the root window — there is nothing to tell them
  apart, and the drawing would hand the IDE's Enter key to a button on a canvas
  with no test ever noticing. `form_show` resolves it instead: a drawing is never
  shown as a form. The cost is that the declaration is settled at Show and a
  later assignment does not move an open form's default, which is written down
  where the setter is.
- **The suite is headless by default, and that is a mechanism replacing a rule
  that failed five times.** `asan.sh` exported `HEADLESS=${HEADLESS:-1}` first,
  after four sanitizer runs went onto the user's desktop -- each of them the
  whole suite, dozens of windows over whatever he was doing. `run.sh` went on
  needing the prefix by hand for a while longer, and was walked into again; both
  export `HEADLESS=${HEADLESS-1}` now, with `-` so an explicitly empty one still
  reaches a real screen. "Remember to" is not a mechanism. The same goes for a probe of your own under `/tmp` -- `xvfb-run`
  is one word. Even driving one by hand does not need his screen: xvfb is a real
  X server and `xdotool` works against it, so a resize or a click done "for
  real" belongs there too.
- **`HEADLESS=1` is read by `tests/runner`, the suite's own runner. The binary
  does not read it at all.** `HEADLESS=1 ./build/bintana <project>` is a window on the user's desktop,
  and it *looks* exactly like the safe thing right up until it opens -- which is
  how a catalogue probe went onto his screen twice, sixty seconds each. Run an
  ad-hoc project with **`tests/try.sh <dir>`**, which is `xvfb-run` and cannot be
  forgotten; going back to a real screen there is `HEADLESS= tests/try.sh`, and
  it should be a question you can say out loud (an icon, a theme). Debugging
  under `gdb` changes nothing about this: `gdb --args xvfb-run -a ./build/bintana
  <project>` debugs the same binary on a display nobody uses, and a bare
  `gdb ./build/bintana tests/widgets` is a windowed suite on his screen held
  open by a breakpoint.
- **And a real screen is worse than an inconvenience: it fails assertions.** A
  run on the user's desktop put every window *on his screen* — dozens of them,
  taking the focus, and a stray click on one moves the focus and breaks whatever
  was measuring, which is a plausible source of any one-run-in-three failure.
  Measurements differ too: the same `tests/ide` that passes under xvfb failed a
  `Calendar`'s drawn size on his session, because the theme and the font are not
  the ones the numbers were written against. So `HEADLESS=` is for a question
  about the real desktop, never for an ordinary run. The exception is
  the one AGENTS.md already names: icons resolve against Adwaita under xvfb, so a
  run that is about an icon has to be a real one (`tests/ide` answers two
  assertions more on a real theme, which is that difference and not a bug).
- **The platform guards are the Windows port, and nothing here compiles them.**
  `#ifdef G_OS_WIN32` in `bta_sys.c` (`exec_signal_group`, `exec_control_fd`,
  `bta_exe_path`, `env_has_display`, `env_os`), `locale_group_double` in
  `bta_locale.c`, `SetConsoleOutputCP` in `main.c`, and the `GIOUNIX`/`pthread`
  guards in `CMakeLists.txt` -- plus `runtime/src/bta_desktop.c`, which compiles
  there and means nothing there, and `BTA_HAVE_UNIX_PRINT` in
  `runtime/src/bta_printer.c`, which is off there: printing works, and
  `Printer.Names`/`Printer.Default` refuse with a sentence, because GTK
  publishes no list on Windows. **There is no local way to compile any of
  them**: the `windows` job in `.github/workflows/ci.yml` is the compiler, and
  its first runs are the toolchain spike `docs/plans/portability-plan.md` asked for.
  The same job stages the downloadable zip through
  [`tools/windows-portable.sh`](tools/windows-portable.sh) -- DLLs by `ldd`,
  GTK's runtime data by hand, caches rewritten to bare names because an
  absolute path is nobody's on the machine that unzips it. None of that script
  has run on a Windows desktop either; the log, and whoever unzips it, are the
  test.
  Editing one blind and pushing is the loop, so keep each guard as small as it
  can be and put the *why* next to it -- the CI log names a line, not a reason.
  **`windows.h` is a macro minefield and it arrives through GTK**: on Windows
  `gdkwin32.h` includes it, so *every* file that includes `gtk.h` carries its
  macros. `wincrypt.h` defines `PP_NAME` as `4`, which made
  `enum { PP_NAME, PP_DIR, ... }` a syntax error three constants wide -- the
  runtime's own enumerators are `BTA_PATH_*` for that reason. `vfw.h`'s
  `SEARCH_KEY` is *not* reachable this way, so a name being in some Windows
  header is not by itself a collision. And three Unix things compile out:
  `poll.h` does not exist (`bta_debug.c`), `g_subprocess_launcher_set_child_setup`
  is GLib's Unix API (`setsid`, in `bta_sys.c`), and `Exec`'s `Control` stream
  is refused -- the same descriptor-inheritance that the debugger's channel
  needs.
- **When Xvfb is missing, ask for it; another virtual display is a false red
  suite.** `run.sh` exports `HEADLESS=1` and the runner's only way to honour it
  is `xvfb-run`, so a machine without `xorg-x11-server-Xvfb` stops with *no
  display and no xvfb-run* — and the tempting next move is a display that is
  already there. **Measured, on this machine, in one afternoon:** under
  `weston --backend=headless` the windows map and are never allocated, and
  `tests/widgets` came back **3215 passed, 75 failed** — `Bounds()` answering
  0x0, `never became true`, `expected 372x200, got 400x229` — every one of them
  a layout assertion reading as a real bug in code nobody had touched; the same
  weston with Xwayland did not finish a run at all. With `Xvfb` installed the
  same tree is **3263 passed, 0 failed**. The dependencies are in
  [`docs/installing.md`](docs/installing.md#running-the-test-suite), and **when
  one is missing the right move is to ask whoever is at the machine to install
  it** — not to improvise a substitute and not to run on their screen. A
  missing tool is one sentence; the alternatives cost more to disbelieve than
  the install costs to do, and the half hour spent on them is the half hour
  this note exists to save. `sudo dnf install xorg-x11-server-Xvfb xdotool` is
  the whole of it here.
- **A test that walks a focus order has to own every stop in it.** `Fixed1` in
  `tests/widgets` had five children by the time `testTabOrder` ran — a scroller
  another test left in it, focusable — so "past the last one the focus leaves"
  walked into it and read exactly like a broken sort. Add a container of your own
  and put the controls in that.
- **And it has to re-grab the focus in the tail, not only before it.**
  `testTabOrder` grabbed once, synchronously, and walked in the async tail after
  every other test -- where anything shown since may have moved the focus, and
  the walk then fails with the focus sitting on the first control, which reads
  as a broken order. Adding six PDF exports shifted the tail's schedule enough
  to make that deterministic: three green-or-red runs became three red ones, and
  the bisect blamed the exports while the bug was the grab. Every walk in that
  test grabs first now, including the first one.
- **`gtk_widget_child_focus` refuses a widget that is not mapped**, answering
  false and moving nothing, and `Form_Open` runs *before* the window is
  presented. `grab_focus` does not care, so `SetFocus()` works there and every
  walk fails — which looks like the order being wrong rather than the window not
  being up yet.
- **A test that shows a window of its own changes the frame timing of the
  pushed-surface assertions in `testExec`**, which measure a form on the frame it
  settles and read `gap 16` back as `0` about one run in three. Not a new bug:
  `testFileDialog`'s choosers did it first, and the guard there waits for two
  equal readings, which two polls can both satisfy before the second layout pass.
  `DefaultButton`/`ActivatesDefault` are early in `TESTS` for this, and the real
  fix is a stronger guard in that test rather than an ordering that has to be
  remembered.
- A `GtkDragSource` goes in the **capture** phase. A `Button`'s own gesture
  claims the press, so a source in `bubble` never reaches the drag threshold: the
  control would be draggable everywhere except on the controls one drags from.
- **A `Drop`'s point is the accepting widget's, and a scroller's already
  carries its scroll -- so placing a dropped row is a comparison and nobody
  has to measure a layout mid-gesture.** `examples/kanban` appended for its
  first two versions on the belief that it could not be done: `Drop(data, x,
  y)` and `child.Bounds(that widget)` are the *same* space, which is what
  `gtk_widget_compute_point` gives. Measured with a real pointer on a column
  scrolled down -- the drop arrived at `y=168` while the cards above the view
  read `Y: -293, -206, -119, -32` and the ones in it `55, 142, 229` -- so
  adding `ScrollY` is counting the scroll twice. Two more from the same
  sitting, both of which a synthetic `Emit` would have hidden because it only
  asserts our own numbers back: **a hidden child measures 0x0 at the origin**
  rather than keeping its last rectangle, so a walk over children skips what
  is not `Visible`; and **what such a walk must answer is a child's *name* and
  not an index**, since a filter hides rows without taking them out, so the
  third row shown can be the seventh the list holds. Written down in
  `llm/controls.md`'s `Drop` row and in `reference/widgets/Widget.md`, which
  said only `Drop(data, x, y)` while this was being guessed at.
- **No drag starts inside a `RowList`, in either phase.** A `GtkListBox` claims
  the press for its own selection, so a card with `DragData` set selects and
  nothing else -- measured with a one-row probe that printed `SELECTED` and no
  `DROPPED`, while the same gesture from a bare `Button` dropped fine. It is the
  VTE shape above seen from the list side. A column of draggable cards is a
  `Scroller` arranged `Vertical`, which claims nothing, with selection
  (`MouseDown` plus a class), filtering (`Visible`) and editing (double click)
  written by hand -- one `On` each, on the card. Found building
  `examples/kanban`, and written down in `docs/widgets.md` under `RowList`,
  where somebody choosing a container will read it.
- **A `GtkDropTarget`'s `enter`/`motion` carry only the point, and `preload` is
  what puts the string beside it.** The data only exists at `drop` unless the
  target preloads it on hover, so `DragEnter`/`DragOver` read it off the target
  with `gtk_drop_target_get_value` -- same `GValue` the drop arrives with, one
  gesture earlier, and `""` on a very early enter rather than holding the event
  back. The alternative is `gdk_drop_read_value_async` per motion, which is a
  callback to marry back to a position that has already moved.
- **A refusing answer has to be strict, and the reason is what a handler that
  says nothing returns.** `DragOver` refuses on `false`, so the check is
  `JS_IsStrictEqual(r, JS_FALSE)`: `KeyPress`/`MouseWheel` can afford the loose
  `JS_ToBool` because their handlers consume by returning `true`, but here the
  refusing answer is the falsy one and `undefined` -- what every handler that
  shows a line and answers nothing returns -- would refuse every drag anywhere.
- **And the refusal lives in `DragOver` alone, although both events answer
  one.** `on_drag_enter` and `on_drag_motion` go through the same helper and
  return the same *no action*, which is what made *"`DragEnter` refuses
  too"* look true from the code -- and it is not, because GTK's `motion` sets
  the action again a few milliseconds later. Measured three ways with a real
  pointer, dropping on a target that refuses: in `DragEnter` only, the `Drop`
  **arrives**; in `DragOver` only, it does not; in both, it does not. So a
  `false` from `DragEnter` is worth exactly the time until the pointer moves a
  pixel -- and **that time is always zero**, which is what makes it dead rather
  than narrow: GTK raises a `motion` at the *same point* immediately after every
  `enter`, in every gesture measured (`DragEnter card-7 60,0` then
  `DragOver card-7 60,0`), so there is no drop that can land in between. The
  documents said `DragEnter`/`DragOver` in three places and say `DragOver` now,
  and `examples/kanban` had the matching `return false` in its `dragEnter`,
  which is gone for the reason `examples/serve` has no `".."` guard: a refusal
  that cannot fire teaches the next reader the wrong vocabulary. Read from the
  C this is invisible: the two paths are identical and what discards one of the
  answers is in GTK.
- **`drag-end` finishes every drag, so it is the only source-side signal
  connected.** Success and refusal were measured; Escape is GTK's documented
  finish rather than a measured one -- an `xdotool key Escape` mid-drag under
  XTEST did not cancel anything and the drag went on to a `Drop`. Connecting
  `drag-cancel` beside it would answer twice for one failed gesture. And a
  single long `xdotool mousemove` jump made *during* a drag registers nothing
  -- enter/motion only arrived for small stepwise moves, which is also the
  shape of a real hand.
- **A drop is not a leave, and the leave it owes arrives during somebody
  else's drag.** `DragLeave` is documented as *the drag left without dropping*,
  which is true and is half the sentence. Measured with a real pointer: after a
  `Drop` nothing else comes -- five seconds of stillness and no leave -- and
  GTK delivers that target's `leave` at the **next** drag instead, right after
  its `DragBegin` and for a target the new drag never went over:

      Ok Drop card-7 60,60 / Src DragEnd / Src DragBegin / Ok DragLeave /
      No DragEnter card-7

  So a target that lights up in `DragEnter` and puts itself out in `DragLeave`
  **stays lit after a drop**, which is the shape anybody writes first, and a
  program counting enters against leaves is handed one it did not ask for.
  `examples/kanban` is right because `dropOn` calls its own `dragLeave` before
  it moves anything -- a line that looked like belt and braces and is the whole
  of it. Written into the `Drop` and `DragLeave` rows rather than fixed:
  emitting a leave of our own from `on_drop` would make the late one a
  **second** leave for one gesture, and swallowing that late one means keeping
  a flag per target for a tidiness nobody asked for. A drag that leaves without
  dropping, and a drop that was refused, both raise it in their own gesture.
- **A component added from code keeps itself as its event target, and
  `On(event, fn)` is what makes that harmless.** Only the `.form` loader rebinds
  one to its host (`bta_widget_bind` in `build_one`); `Container.Add` adopts it
  through `bta_widget_adopt`, which only binds what has no form yet -- and a
  component's root already answers to itself. So `<name>_<event>` on the host
  never fires for a card built with `new TaskCard()`. Measured both ways with a
  probe: a `.form` component answers on the host, a code-added one answers on
  itself.
  **The binding is unchanged and the reach is what moved.** `emit_on` reads the
  control's own handlers before the named road, and `Emit` is one of its
  callers, so `card.On("Changed", fn)` on the *host* hears a
  `this.Emit("Changed", v)` inside the card -- with nothing rebound, no name
  invented and no change to what `Add` means. **An `Add` that rebinds a
  component was the other half of the issue this answered and is not coming**: it
  would change what an already-built component answers to, for a case the
  dispatch now covers. The closures onto the card (`card[card.Name +
  "_MouseDown"] = …`) are what `On` replaces.
- **A widget event dispatched with `bta_emit_on` skips `On`, silently, and the
  signature will not stop you.** There are two entry points and they are not
  interchangeable. The static `emit_on` takes the `BtaWidget *` and reads its
  handlers note *before* the `<name>_<event>` road; the published
  `bta_emit_on(ctx, form, name, …)` takes no widget and is **the menus' road** --
  a `BtaMenuItem` and a `BtaAction` are not widgets, have no note, and are the
  only two callers left (`bta_menu.c`). Ten sites in five files used to call it
  with `w->form, w->name` because they needed the handler's answer back, and
  every one of them is `bta_emit_answer(w, …, NULL)` now, which is the same
  return value through the widget road. **A new event raised the old way would
  be an event `On` cannot hear**, with nothing failing: the named handler still
  works, so it looks wired. Raise one with `bta_emit`, `bta_emit_ok` or
  `bta_emit_answer`, all of which take the widget.
  Two smaller things settled here. **The note's bag has a null prototype**
  (`JS_NewObjectProto(ctx, JS_NULL)`) -- `JS_GetPropertyStr` walks the chain, and
  this repository has already been bitten by an ordinary bag inheriting
  `Object.prototype`; no event is spelt `constructor` and the bag costs nothing
  to make unable to answer for one. And **a control never has two handlers for
  one event**: the pair is refused where the second one is written, since of two
  answers only one could ever be used -- eight events here are asked a question
  -- and picking one would silence the other in silence.
- **Checking the event name against `EventNames()` found a handler the IDE had
  been installing on controls that cannot raise it**, which is the whole argument
  for checking it in one sentence. `PropertyGrid.bindEditor` wired
  `Prop_<Key>_IconClick` on **every** editor in design mode, and two of the three
  shapes `makeEditor` builds there have no icon in the field to click: the
  `ITEM_OF` drop-down is a `ComboBox`, and a design *number* is a `TextBox`
  deliberately given no sample button. Under dispatch by name those were two
  properties written onto `MainForm` that nothing would ever look up -- no error,
  no warning, and no way to find them short of reading both functions together.
  `On` threw on the first one, naming the fourteen events a `ComboBox` does
  raise. **The guard is asked of the icon** (`editor instanceof TextBox &&
  editor.Icon`) and not by repeating `makeEditor`'s condition, so the two cannot
  drift.
- **What the IDE kept dispatching by name is exactly what is not a widget.**
  Nineteen sites in seven files became `On`; what is left is three, all menu
  items -- `MenuBar`'s leaves and `PropertyGrid`'s sample entries -- because a
  GTK4 menu is a model and an item has no note to carry a handler on. So
  `MenuBar.clear()` still exists and is half of what it was (the `_MouseDown`
  line went with the entries, which are `Label`s), and `bar.owned` now holds menu
  item names only. `tests/ide` still drives one of those by name
  (`ide[`${leaf}_Click`]()`), which is the assertion that the named road is still
  there for the half that needs it.
  **The sample menu could not be converted and had to be fixed in place.**
  `pickSample` rewired nine `PropSample<N>_Click` on every open, each closing
  over that click's editor and key -- so the set left on the form held the editor
  and the control of whichever field was sampled last, for the life of the
  process, with no `delete` anywhere. It is wired **once** now and reads
  `this.sampleKey`. A handler that cannot live on a widget has to be given a
  target it looks up rather than one it closes over.
- **The two-handler refusal has three doors, and the third one is not where you
  would look for it.** The question is the same at all three -- does this control
  carry a handler of its own for an event that a `<name>_<event>` on its form
  would answer too -- and it is asked in `On`, in the **`Name` setter**, and in
  **`bta_widget_adopt_refused`**, which every verb that brings an *unbound*
  control into a container asks before it touches GTK -- through
  **`bta_widget_bring_in`**, which asks the other two questions a child arriving
  has to answer (see *`Add` moves* below).
  **The framing that hid the third one was *refused where the second handler is
  written*.** That reads as a symmetry and is not one: `BtnOk_Click` is a method
  in a class body, so it is never handed to the runtime at all and can never be
  the trigger -- the check can only ever fire on the other side. The framing
  that finds all three is **every act that completes the pair**, and there are
  exactly three, because the first two both ask about `w->form` and a control
  built in code has not got one until it is adopted. Measured, before the third
  existed: `Add` then `On` was refused, `On` then `Name` was refused, and
  **`Name` + `On` then `Add` was not** -- the pair was made in silence and `On`
  won. Narrow (`On` exists so a code-built control needs no name at all) and
  real.
  **It could not go in `bta_widget_bind` and could not go in
  `bta_widget_adopt` either**, which is the part that costs something. Adopt is
  the choke point every container goes through -- *"every path that adds a child
  has to call it"*, above -- but it runs **after** the child is in GTK: after
  `bta_container_attach`, after `gtk_notebook_append_page`, after
  `gtk_stack_add_child`. Refusing there leaves a half-attached control, which is
  the `AddNode` trap. So it is a *question asked first* by five verbs --
  `Container.Add`, `Notebook.Append` (twice: the page and its tab),
  `Notebook.SetAction`, `Notebook.SetTabLabel`, `Switcher.Append` -- and **a
  sixth verb that forgets to ask reopens the hole**, with nothing failing. That
  is the price of adopt not being able to carry it, and it is the thing to check
  when adding a way to put a control in a container. The `.form` loader is
  deliberately not among them: it binds *before* it attaches, and a control it
  has just built carries no handlers.
  **`Add` moves, and a container cannot go inside itself -- and both are the
  same door.** `bta_widget_bring_in` is what the six verbs ask now, and it asks
  three things in the order where a refusal moves nothing: not into itself
  (`a.Add(inner); inner.Add(a)` **hung the process** -- GTK walked the cycle),
  the handler pair, and then -- only then -- out of wherever the control was.
  That last one used to be nobody's: `Add` on a control already in `p1` gave a
  `Gtk-CRITICAL` from `gtk_widget_set_parent`, the control stayed in `p1`, and
  `bta_widget_adopt` still put it in the new container's `__children`, two
  parents holding one control. `Remove()` then `Add()` was the only correct
  spelling and nothing refused the other. A verb that brings **two** controls in
  (`Notebook.Append`) asks both with `move` false and only then moves both, or a
  refused tab would leave the page already taken out. `SetTabLabel` and
  `SetAction` with the control they already hold are no-ops, since asking would
  try to take it out of the very strip -- and `SetTabLabel` now releases the old
  label *after* the swap, as `SetAction` always said. `testAddMoves` hangs on
  the old code.
  **And the check can never be total**, which is a different statement now that
  the omission is gone: a form is an ordinary JavaScript object, so
  `this.Btn_Click = fn` assigned onto it afterwards is invisible -- there is no
  act to hook. That much is inherent. Do not file the adoption under it, which
  is what the documentation did for one commit.
- **A test that called a handler off the form had to start raising the event.**
  `tests/ide/Driver.js` drove the grid with `ide[`Prop_${key}_Activate`]()` and
  `ide.Prop_Icon_IconClick()`; those properties do not exist any more, and the
  replacement is `editor(ide, key).Emit("Activate")` -- which is *better* rather
  than equivalent, because `Emit` goes through the runtime's own dispatch instead
  of reaching for the one name the test happened to know. When a handler moves
  onto its control, the test that drove it by name moves with it.
- **Submitting a modal with an xdotool key can haunt the run.** `key` sends
  down, waits 12 ms, sends up; a dialog that submits and closes inside that gap
  takes the up down with it -- `BadWindow` on the send, the release never
  processed, the key held server-side. What follows is auto-repeat into the
  newly focused window: the opener button re-fires and a phantom dialog sits
  there, one per submit, each invisible to a window capture of the main form.
  A thousand repeats were measured before anybody looked at the log. Submit
  with a mouse click (clean), and read `BadWindow` after a dialog-submit key
  as the signature. Real users cannot hit this: a physical release routes by
  focus instead of at a corpse. Found driving `examples/kanban`.
- An own `-symbolic` icon is drawn with **fills**: GTK's recolouring forces
  `fill`, and a stroke keeps the colour in the file (black on a dark theme).
- **A property declared in a `.form` fires its event while the form is still
  loading**, and `this.<Name>` does not exist yet -- the loader applies properties
  before the control is a property of the form. `Txt_Change` with `this.Txt`
  undefined is not a bug in the control; every control does it (verified with
  `TextBox.Text` and `CheckBox.Value`). A handler that touches its own control has
  to guard.
- **A Pango context holds font sizes in device units, not points.** Reading the
  theme's font from `gtk_widget_get_pango_context()` and showing it reported
  11pt as `14,67px` -- the right font in the wrong unit, and one the user never
  chose. `GtkSettings:gtk-font-name` is the desktop's own spelling, in points.
- **Numbers written into CSS need `g_ascii_formatd`.** GTK calls `setlocale()` at
  startup, so `%g` writes `11,5` on a machine like this one and CSS silently
  ignores the rule. The colours are safe because `gdk_rgba_to_string` is
  locale-independent; anything formatted by hand is not.
- **`AddNode` parents a control before it applies its properties**, so a value the
  runtime refuses throws with the subtree already half built. Anything that
  catches that -- the designer, which stands in for what it could not build --
  has to take the leftovers out first, or the stand-in's node and the controls
  that did get built are both written to the file. The IDE's own `MainForm` went
  through one save and came back with six controls duplicated.
- **...and `AddNode` builds the node *and its whole subtree* in one call, which
  makes a failure land on an ancestor.** The designer caught the throw for a
  component it cannot instantiate while the panel around it was being built, so
  the panel became the stand-in and its siblings were deleted: opening
  `examples/qr/QrForm.form` was a board with one grey `[Panel TextPage]` and
  nothing else on it, and the save was innocent (a stand-in carries its node),
  which is why it read as "the IDE cannot open this form". `buildNode` builds
  one level at a time now -- `parent.AddNode({ ...node, children: [] }, true)`
  and then recurses -- so the stand-in replaces exactly the node that failed.
  `tests/ide`'s `forms` phase has the nested case.
- **A `Width`/`Height` in a box is a *minimum*, not a size.** A `SourceEditor`
  declared 605 tall makes the notebook holding it 605 tall, and a `Scroller`
  declared 520 wide is a canvas the split can no longer squeeze. Everything in a
  box asks for the least it can live with and expands into the rest; the last
  child of a panel whose minimums exceed it hangs out of the bottom edge and
  stays there at every window size.
- **...and the serialiser used to invent one.** `Width`/`Height` fall back to the
  *allocation* when nothing was declared (`w_get_geom`), so saving a form wrote
  down what every control happened to measure -- turning today's measurement into
  tomorrow's floor. One save of the IDE's own window put `Height: 427` on a
  notebook page and 427px of blank under the tab strip. `collectProperties` now
  asks `SizeRequest()` (`-1` = nobody asked) and skips the pair for a box child;
  fixing the file by hand only lasts until the next save.
- **A `ColorButton`/`FontButton` reports its change on GTK's own time.** A
  flag raised around filling the property grid (`PropertyGrid.updating`) is back down by the
  time the signal arrives, so filling the grid arrived in `applyEditor` anyway --
  three entries onto the undo stack and a form marked dirty that nobody touched.
  Invisible for as long as every tab switch rebuilt the surface and threw the
  stacks away. The fix that does not depend on timing: **an edit that changes
  nothing is not an edit**, checked against what the property already is.
- **A widget's state dies when you reassign what it holds.** Moving one
  `SourceEditor` between notebook pages meant `Editor.Text = state.text` on every
  switch, and GtkSourceView drops its undo history when the buffer is replaced:
  the text came back, the history did not. Anything a widget keeps for itself --
  undo, selection, scroll -- is only kept by *not* rebuilding it. Measured before
  deciding: a `SourceEditor` per tab is ~240 KB (small file) to ~550 KB (78 KB
  file) and 2-4 ms, against 113 MB idle. "Costly" was worth checking rather than
  assuming; a design tree is the expensive one, ~1.5 MB per open form.
- **A headless run does not see the desktop's icon theme.** Under `xvfb-run` GTK
  falls back to Adwaita (1520 icons here), while the session runs
  elementary-xfce (2575). So `Application.HasIcon` answers about a theme that is
  not the user's, and `tests/ide`'s walk over every declared `Icon` passes on a
  name that comes out blank on the real screen -- `view-more-symbolic` did.
  **`tests/icons.sh` is how you check one now** -- a console project, so it needs
  no display at all and could not ask GTK even by accident:
  it reads the desktop's theme off the disk, follows what it inherits, adds the
  ~127 symbolic icons GTK4 carries *inside its own library* -- the ones no theme
  directory shows, and the ones easiest to forget -- plus whatever the project
  ships in `icons/`, and reports every `Icon` declared in a `.form` that nothing
  provides. Running the suite on a real display answers the same question by
  putting dozens of windows over whatever the user is doing, which is a bad
  trade and is no longer the advice.
- **A headless run does not see the desktop's *theme* either, and `Style` is the
  half nobody checks.** Which CSS classes exist is the theme's answer, so a class
  the user's theme lacks is accepted, saved into the `.form`, and does nothing --
  the same shape of failure as a missing icon, without even a blank square to see
  it by. `tests/styles.sh` prints what the theme really defines and what each
  class is written for; the node each control is, which decides whether a class
  can match at all, is in [`docs/widgets.md`](docs/widgets.md#styling-the-vocabulary).
  **Moving a widget's CSS node is a breaking change for anyone's `app.css`**:
  this tree moved three of them in one afternoon before anything checked, which is
  why `testCssNode` in `tests/widgets` now writes every node down and fails on a
  type that is not in the table.
- **A hand-written list in a test drifts exactly like a hand-written list in the
  code.** The icon walk was seven form names typed out; by the time anybody
  looked the IDE had eleven forms, and `ColumnForm`, `PoForm`, `ProjectForm` and
  `SearchForm` had never had an icon checked -- `ColumnForm` was declaring
  `view-table-symbolic`, which is in no theme here and not inside GTK either, so
  the dialog came up with no icon and the suite was green. AGENTS.md even
  described the test as walking *every* `.form` under `ide/`, which is what it
  does now: `Directory.List` the directory. A test about files that names its files is
  the same mistake `EventNames()` retired for widget types.
- **A `.form` names one icon; code picks the first of a list that resolves.**
  Moving a control from code into the file quietly drops its fallback — which is
  how the IDE's tab-strip button came out blank, since `view-more-symbolic` is
  not on this desktop and nothing said so. `tests/ide` now walks every `.form`
  under `ide/` and checks each declared `Icon` against `Application.HasIcon`.
  **And the names the IDE's own forms declare are the `-symbolic` spelling**,
  because the full-colour legacy ones are not on every desktop: `edit-find`,
  `go-up`, `document-new` and `applications-development` are Fedora's
  `AdwaitaLegacy` and Ubuntu's Yaru, and the Adwaita a bare runner falls back to
  ships only the symbolic set. Sixteen icons drew blank on the runner and every
  one of them was fine here -- which is what walking every `.form` is for.
- `gtk_icon_theme_has_icon()` promises more than the theme delivers: it can say
  yes and hand back its `image-missing`, or an SVG that renders to nothing (art
  outside the frame, no `viewBox`). `bta_icon_available` renders it at 16x16 and
  looks for ink; on a button with no text the difference is a blank square.
- `Background` on a `Button` needs `background-image: none`: the theme's gradient
  is an image and would cover the colour. `widget_styles_apply` does it.
- **Two stylesheets, and the order between them is the whole design.**
  `<project>/app.css` loads at `PRIORITY_APPLICATION` and carries the classes
  `Style` names; the per-widget `Background`/`Foreground`/`Font` sheet loads one
  above it, so the by-hand exception still wins where it is used. Equal
  priorities would have left the winner to the order the providers happened to be
  added in -- both write single-class selectors, so specificity does not separate
  them. A test that only round-trips the property sees none of this: `testStyleSheet`
  measures a label wearing `.t-big` against a bare one, which is the only thing
  that can tell "the sheet was loaded" from "the property remembered a string".
- **A context menu has to walk outwards to be reachable.** A widget that handles
  its own press keeps the event -- a `Button` does -- so a container's `Menu`
  would open everywhere except over its contents. `popup_nearest` walks from the
  widget that saw the click up to the first one with a menu, translating the
  point as it goes. Popup actions live in a `popup` group on the widget, not the
  window's `form` group, so nothing shadows a menu bar action.
- Whether a popover actually *appeared* is not answerable from JS, so the suite
  covers the spec, the dispatch and the lifetime, and the display is checked by
  hand -- a popover is a separate surface, so it only shows up in a **root**
  capture, never in a window one.
- **A menu built from a spec you did not write lands on *your* form.** The three
  are one mechanism seen three times, and the designer's menu bar preview hit all
  of them: `make_item` does `JS_SetPropertyStr(ctx, form, name, obj)`, so a
  previewed `MnuOpen` **replaces** the IDE's own; the dispatch is
  `bta_emit_on(form, name, "Click")`, an ordinary `<name>_Click` property lookup,
  so clicking the picture would have opened a project; and `set_accels` ends in
  `gtk_application_set_accels_for_action`, which is the **application** -- a
  designed form with `<Control>s` in its menu takes Ctrl+S off the IDE. Rename
  after the path and drop the shortcuts (`Ide.MenuBar.sanitise`). The same lookup
  is what makes it work at all: a handler assigned from code is found like any
  other, which is how a menu built at run time gets one.
- **And that assignment is checked now.** `make_item` and `bta_actions_build`
  both looked away from `JS_SetPropertyStr`, exactly as the control loader did
  before `bta_form.c` was fixed: a menu item or a command named `Actions`,
  `Menus`, `Controls`, `DefaultButton` or `CancelButton` bound to **nothing**,
  `MnuActions_Click` never fired, and the form loaded as if all were well.
  Both refuse the form now, saying which item and why. The rule the fix needed:
  **nothing is wired until the name is ours** -- the `GSimpleAction` is built
  *after* the bind, because a refused bind frees the wrapper and an action
  already in the group would hold a handler pointing at freed memory.
- **`Menu` needs the widget to be in a form's tree already.** It names handlers on
  `w->form`, and a widget that has not been added to anything has none -- the
  property setter says so where it is set. Build, `Add`, *then* assign `Menu`;
  which is the `.form` loader's order too. **"Says so" was not true until the
  audit**: the answer was `cannot set property 'MnuX' of undefined` from inside
  `make_item`, and `HeaderMenu` inherited it. Both setters refuse now with the
  same sentence, before building anything.
- **A menu item's action outlives its wrapper, so the wrapper's finaliser has to
  disconnect it.** `make_item` binds `form[name]` to a fresh wrapper, and the
  wrapper owns `mi`; the `GSimpleAction` is held by the group too. Rebinding the
  name -- which `HeaderMenu` does on *every* right click, and which two menus
  sharing an item name do the first time the second is built -- finalised the
  old wrapper and left its action connected to a freed `mi`: the menu bar's
  `form.MnuCopy`, activated after a heading menu reused the name, ran
  `on_menu_activate` on freed memory. `menuitem_finalizer` and
  `action_finalizer` both `g_signal_handlers_disconnect_by_data` now (the latter
  also dropped a reference it never released). The orphaned action does
  nothing, which is the truth about an item nothing can reach. What is still
  open is the *collision itself*: a heading menu item named like a menu bar
  item takes the name, and `this.MnuCopy` then answers the heading's.
- **A menu bar's label is translated by the process that builds it.**
  `append_item` calls `bta_locale_lookup`, so a menu previewed inside the IDE is
  drawn against the IDE's catalogue. There is no way to opt out from JS. A `Text`
  assigned from code is not affected -- only prose the loader read.
- **`.titlebar` is a class; `menubar` is only a node.** TitleBar's trick -- wear
  the classes GTK styles its own decoration with -- does **not** generalise.
  `menubar`, `menubar > item` are node names, and no widget an application builds
  is named `item`. Check before designing around it: `./tests/styles.sh` lists
  *classes*, and `menubar` is not in it; `gresource extract /usr/lib64/libgtk-4.so.1
  /org/gtk/libgtk/theme/Default/Default-light.css` is where the rules are. Some
  themes add a `.menubar` alias and the one inside libgtk does not, which is the
  wrong way round to build on.
- **A `Button` has a floor and a `Label` does not.** Adwaita gives `button` a
  `min-height: 24px` that applies to its **content**, so with a menu bar's 4px of
  padding above and below plus the border, the shortest button there is comes to
  34 -- against a real menu bar's 27. Measured, which is the only way this shows
  up: `Bounds()` reports the content box, so the button *reads* as 24 tall while
  taking 34. A row of `Label`s with the same padding is 27 exactly.
- **A real menu bar can be measured from Bintana.** The IDE is a form with menus,
  so its window has one; `Bounds()` is in window coordinates and the surface
  starts below the bar, so the Y of the first control **is** the bar's height. 27
  here, against the 28 the IDE's own `.form` was hand-written with -- which is the
  argument for measuring: the hand-written number was already wrong, and on a
  desktop with a larger font it is not one pixel.
- **A test that opens a file chooser breaks the test after it, not itself.** A
  `Dialog.OpenFile`/`SaveFile`/`SelectFolder` is modal and nothing in JS can
  close one, so it stays on top of the form the next test measures: one left open
  turned `testExec`'s pushed-surface assertions red (`gap 16` read back `0`) while
  `testFileDialog` passed on its own, and the failure reads exactly like an anchor
  bug in code nobody touched. `Dialog.Color`'s two get away with it; a file dialog
  does not. Which is why the suite asserts every **refusal** -- those throw before
  the chooser exists, so they show nothing -- and the accepted options are on the
  by-hand list above. Verifying them is one capture: the title on the frame,
  `Name` in the field, `Folder` in the breadcrumb, and a `*.js *.mjs` filter
  listing `MAYUS.JS`, which is what says the pattern became a **suffix** and not a
  glob.
- **Copying a record field by field is a claim that goes stale, and it goes stale
  silently.** `Manifest.apply` named three of `ProjectFile`'s fields one per line
  while `ProjectForm`'s header promised that adding a field to the record was all
  it took -- so `Version` was declared, shown by the dialog, refused by the record
  when too long, and then dropped on the way to the file. Every assertion about
  the other three stayed green. A record discovers its own properties
  (`PropertyNames()`) exactly as a widget does; loop, and name only the deliberate
  exception.
- **Two methods of the same name in one class: the later one wins, silently.**
  `MainForm` had two `renameSelected` four hundred lines apart -- one renaming the
  open file, one renaming the selected control -- so F2 renamed a control and the
  file rename was dead code. Every test about renaming passed, because they all
  called `renameForm` directly and never went through a menu. In a 2000-line class
  this is easy to do and impossible to see; `grep -c "^    <name>("` before adding a
  method, and drive the *menu item* in a test, not only the method under it.
- **Moving a method out of a class is only half done until the old one is gone,**
  and this is the same trap wearing a hat: `MainForm` keeps a one-line delegation
  per method that left (`formOf(f) { return this.classes.formOf(f); }`), so a
  leftover definition of the same name further down would win over the delegation
  and the helper would sit there unused. `grep -n "^    <name>(" ide/*/*.js` should
  answer exactly twice -- once in the helper, once as the delegation.
- **`Form_Close` closes by returning, so the X never reaches `quit()`.** A true
  answer keeps the window open and a falsy one lets it go -- so the path with
  *nothing to ask* closes without calling anything, and anything owed on the way
  out that is only written in `quit()` is owed on the commonest way out and never
  paid. `MainForm.leaving()` is the list both doors pass through (the terminal's
  shell, the session); put new work there and not in `quit()`. Found by reading
  the settings file after a real session and finding nothing in it -- no test
  could have failed, because the test drove `quit()`.
- **Write the thing that cannot fail first, and let the fallible follow-up
  report.** Project settings renamed the metainfo *before* writing
  `project.json`: a metainfo that would not parse threw out of the accept
  callback with the dialog already closed, losing every edit, and a refused
  field left the file renamed to an id the manifest never got. `apply()`
  answers whether it wrote, and the metainfo follows only a written one
  (`Manifest.followIdentity`), carrying `<name>` along with the id -- a renamed
  project used to leave `<name>` behind and `Package.Write` then refused.
- **An operation that renames a file the IDE may have open renames the tab
  too.** `Metainfo.rename` deleted the old file while its tab kept the old
  path, and saving the tab wrote it back beside the new one, old id and all --
  two metainfo files, and `Metainfo.find` free to pick the stale one. `FormFiles`
  already did `renameTab` + `reloadFromDisk`; `Manifest.metainfoMoved` is the
  same pair. A rename onto a file that exists is refused, and only a stock
  `<icon>` is rewritten -- a `remote` or `local` one is the author's.
- **A lint nobody runs over the IDE is a lint about other people's projects.**
  `Ide.Strings` has always warned about a msgid joined from two literals, and
  the IDE had seven -- the id error in New project and Project settings, three
  style-editor sentences, a property-grid hint -- each in `ide.pot` as its first
  half, which no translation can ever match. `tests/ide`'s `strings` phase runs
  the lint over the real `ide/` now and fails on any.
- **`--` is not literal: git still globs what follows it.** Discarding
  `data[1].json` also restored `data1.json`, silently and with no undo.
  `Ide.Git` passes `--literal-pathspecs` on every call; a new git call built
  outside `run`/`remote` has to carry it too. An untracked folder is one
  porcelain row (`?? d/`) and `File.Delete` takes only an empty directory, so
  discarding one threw halfway -- it goes to the trash now, like every other
  delete the IDE makes.
- **`File.Load` cannot say a file was not UTF-8; it answers U+FFFD.** An IDE
  that saved what it read destroyed every Latin-1 accent. The test is
  `Bytes.ToText()` throwing, not a search for U+FFFD (a file may hold one). A tab
  with `state.foreign` is read-only and every writing road refuses it -- save,
  save all, `rewriteSource`, recovery -- so a new road that writes a tab asks
  `state.foreign` first.
- **A handler is `<name>_<one event>`, never `<name>_\w+`.** `\w` takes `_`,
  so renaming `Btn` moved `Btn_Ok`'s `Btn_Ok_Click`, and `Btn` read as taken
  because of it; renaming also clears undo, so it could not be taken back.
  `handlersIn`/`renameHandlers` take `designer.eventsOf(control)`.
- **A design tab behind another has a live designer, and it is what saves.**
  Setting `state.root` alone was invisible: `loadActiveState` loads nothing by
  design, so after a rename or a retype, saving that tab wrote the old `.form`
  back beside the new one. Go through `TabSet.setRoot`, which marks the tab
  `stale` so it reloads when shown -- and never load a background designer
  directly, since it would drive the shared side panel.
- **The suite's temp directory may have no trash, and the old delete hid it.**
  `File.Trash` fails there on this machine, so every *Delete from project* in
  `tests/ide` fell through to a permanent `File.Delete` without a word -- the
  very thing the comment above `deleteFiles` said it never did. It asks now
  (*Delete permanently*), and a test that deletes goes through
  `deleteAnswering()`. Whether a trash exists is the machine's, so a test of the
  no-trash road fakes `File.Trash` rather than relying on it.
- **An unanswered recovery offer outlives its dialog.** Closing it with the X
  means *later*: the tick used to find nothing dirty and forget the snapshot
  while the dialog was still asking. The tick and every door out keep it now,
  and it rides along in every snapshot of that project until Recover or
  Discard -- so a phase that opens a project with a pending snapshot leaves the
  offer held for the phases after it, and one that asserts exact snapshot
  contents calls `ide.recovery.drop()` first.
- **`-z` rename records carry two paths in either column.** Consume the old
  name and still read both letters: filing `R?` as staged-only hid the edit in
  an `RM`, which could then be neither staged nor discarded. And **push asks
  where** when the branch follows nothing and there are several remotes --
  `--set-upstream origin` was a guess that failed on a repository whose only
  remote had another name.
- **A `force` flag on a close is a decision nobody asked about, and five
  roads were taking it.** `closeByName(name, true)` skips the dirty question,
  which is right *after* a question -- and Close all, Close others and
  `openProject` called it with none, so opening a recent project dropped
  unsaved work in this one without a word. The same afternoon found the other
  shape of the same loss: writing a handler, renaming a control and renaming a
  form all rewrote the `.js` **on disk** and then `reloadFromDisk`'d (or
  ignored) the open tab, so text typed there and not saved was replaced, or a
  stale tab saved `class Form1` back over the rename. The rules now:
  **several tabs going is one question** (`TabSet.whenSettled`, which
  `closeMany` and `MainForm.leaveProject` ask); **every door out of a project
  asks before anything moves** (`leaveProject` on Open, Recent, New and Clone
  -- inside `openProject` is too late, since a new project has moved `project`
  to write its first form); and **a change the IDE makes to source goes to both
  copies** (`TabSet.rewriteSource`: the file, and the open editor with its dirty
  state kept) or, for a new handler, into the live editor as one insertion that
  undo takes back. `reloadFromDisk` on a tab is only for a tab known clean.
  `tests/ide`'s `unsaved` phase drives each road; against the old code ten of
  its assertions fail before a missing dialog stops the phase.
  **And the recovery snapshot is an answer too**: it went only in `quit()`, so
  saving and closing with the X within thirty seconds left it behind to offer
  older text back. `leaving()` forgets it when nothing is dirty, and
  `leaveProject` forgets it once the question is settled.
- **A `design` key that is not a property makes `AddNode` throw, and the control
  silently becomes a stand-in.** The designing branch applies the block *over*
  `properties`, so `"design": { "Item": "Chip" }` on a `RowList` does not do
  nothing -- it raises, `Designer.buildNode` catches it, and a real control turns
  into a grey `[RowList]` box. That is why what a list draws is the node's own
  `item` key beside `design` and not inside it. It is also the good case: a typo
  in a design block cannot be a value that quietly never applies.
- **Every `ide/**/*.js` shares one global scope.** They are separate
  `JS_Eval(JS_EVAL_TYPE_GLOBAL)` calls in one context, which is what lets `Runner`
  use `MainForm`'s `SOURCE_LINK` and `Palette` use `Chrome`'s `SELECT_COLOR` -- and
  what makes the *same* top-level `const` in two files a `SyntaxError:
  redeclaration` that stops the IDE at startup. Splitting a file means moving each
  constant, not copying it.
- **`Focusable` reaches `inner` and the editable's delegate, and the *getter* has
  to ask the same three.** A `TextBox`'s focus sits on the `GtkText` *inside* its
  entry and an editor's on the view inside its scroller -- the same *contains*
  rather than *is* that `Focused` reports -- so `gtk_widget_child_focus` walked
  past the unfocusable outside straight into the focusable inside. `w_set_flag`
  reaches `inner` and, for a `GtkEditable`, its delegate. Found by a tab-order
  test expecting Tab to skip a `TextBox`.
  **The getter was left reading `w->gtk` alone, which answered `false` for every
  `TextBox` in the tree** -- in GTK4 the outside of an entry is not focusable at
  all, the `GtkText` inside is -- so a property that read back wrong *worked*, and
  that is a bug only whoever asks it a question can find. The question arrived
  years later: the designer's tab-order dialog lists the children Tab can reach,
  listed the buttons and skipped every field. `widget_focusable` is the three
  widgets the setter writes, asked in one place.
- **An image in memory is a verb, not a property.** `Picture.LoadBytes(bytes)`,
  `Image.LoadBytes(bytes)`, `Painter.Image` taking a string *or* `Bytes`, and
  `DrawingArea.ToPng()` answering `Bytes` -- the circle `Http` (which answers
  `Bytes`) and `File.LoadBytes`/`SaveBytes` left open, which used to be crossed
  with a temporary file. Verbs because a property here promises the designer can
  edit it and the `.form` can carry it, and a megabyte of JPEG is neither; the
  `File` properties stay, and the old rule holds -- last source wins, so bytes
  clear `File` and `Icon`. **The painter's image cache is the path's alone**: a
  freed buffer's address can be handed out again, so a cache keyed on bytes
  would eventually paint the wrong picture. Measured cost of that choice: 2.7 ms
  a call against 0.045 ms cached, for a 640x480 PNG.
- **Clearing `Image.Icon` has to clear `IMG_NAME_KEY` too**, which it did not:
  `bta_image_set_icon` leaves the name on the widget and hooks the icon theme so
  the icon survives a change of theme or scale, and that name outlived the
  `File` that replaced it -- so the next theme change put the old icon back over
  the picture. Invisible until something else was shown.
- **Neither GTK setting answers "is the desktop dark".** `gtk-theme-name` is
  `"Default"` under Adwaita and `gtk-application-prefer-dark-theme` is `false`
  under `GTK_THEME=Adwaita:dark` -- both measured -- so `Widget.Dark` is derived
  from `gtk_widget_get_color()`, the ink really being drawn, which is what
  `Painter.Dark` always did and is now the same function (`bta_widget_dark`).
  Two traps around it: **an unrooted widget has no resolved style** and answers
  white in every theme, so the fallback is the application's first window; and
  the `GtkSettings` the `ThemeChange` handlers hang off outlives every window,
  so they go through `bta_widget_watch` or they fire on a freed form. Inside the
  handler the colours are already the new ones, measured -- no idle hop needed.
- **The IDE copies its dirty tabs aside every thirty seconds, and never writes
  to the project to do it.** `Recovery.js`, into
  `Application.ConfigDirectory/recovery/<digest of the project path>.json`. An
  autosave that saved in place would take away what closing without saving is
  for, so this one cannot: the only thing it can cost is a stale file in the
  config directory. It is read once, when a project opens, and `quit()` deletes
  it on every ordinary way out -- *quit without saving* is an answer, and a
  snapshot that outlived it would offer to undo a decision. `TabSet.contentOf`
  reads the **live** editor or surface rather than `state`, because the active
  tab is the one whose saved state is stalest and the one a crash takes. How
  often is `Settings`' `recovery.seconds` (File > Autosave...), `0` for off, and
  turning it off keeps whatever snapshot exists: it may be the only copy of that
  work.
- **A control that cannot say *nothing* answers something, and that is a data
  bug wearing a widget's clothes.** A `GtkCalendar` always holds a day, so a
  `DatePicker` answered today for a field nobody filled in and an optional
  `Field.Date` -- which spells the empty date `""` and has always let it through
  -- took a date the program never meant, with no error anywhere. The empty
  state is a flag of ours (`bta-date-empty`) with the calendar left holding what
  it had, so the popover opens on a sensible month; choosing a day ends it, a
  page turn does not and raises no `Change`. **`Calendar` refuses `""`** instead
  of sharing it: a month is drawn with a day on it. The one still open is
  `ComboBox`, which has no empty text for the same kind of reason.
- **`Cursor` is the same rule, arrived at from the other side.** A cursor set on
  an ancestor reaches a descendant only while the descendant has none, and the
  ones that matter have one: the `GtkText` inside a `TextBox` and a `SpinBox`
  and the `GtkTextView` inside an `Editor` all carry `text`, a `LinkButton`
  carries `pointer`. So `cursor_apply` walks `gtk`, `inner` and the editable's
  delegate exactly as `w_set_flag` does. Two things follow that are not
  obvious. **`Auto` restores rather than clears** -- each part remembers what it
  had under `bta-cursor-kept` the first time it is touched, or clearing would
  leave a link with no hand for the rest of the run. And **`Form.Cursor` is not
  a busy pointer for the window**: a child with its own wins, GTK has no way
  down, and that is documented rather than worked around.
- **The names `Cursor` takes are ours, and that is deliberate.** The runtime
  passes vocabularies through when they are the platform's -- icon names, font
  families, `Shortcut`'s accelerators -- and this one does not, because it is
  the only one that is closed *and* abbreviated. It also has to be checked here:
  `gdk_cursor_new_from_name` is documented to answer NULL for a name no theme
  knows and **does not** -- it answers a live cursor for `bogus-name-xyz` --
  so an unchecked typo would be a property that reads back correctly and draws
  an arrow. The table in `bta_widget.c` is the single place the CSS spelling
  appears, and `bta_widget_cursor_options()` builds the drop-down out of it so
  the two cannot drift.
- **Tab order cannot ride the child list, because paint order already does.**
  GTK4 walks the focus in child-list order and removed `GtkContainer`'s focus
  chain, so on a `BtaFixed` the drawn order is the tab order -- and that same list
  is what `Raise`/`Lower` reorder. `Widget.TabIndex` is declared per child and
  carried out by `bta_fixed_focus`, the surface's own `focus` vfunc, which is the
  supported place for this and costs nothing elsewhere: a focused editor or
  `Terminal` consumes Tab long before GTK asks a container for the next target, so
  indentation and shell completion need no special case. Sparse and never
  renumbered, for the reason `Button.Default` is resolved at Show -- a control's
  siblings are its *form's*, which on the designer's canvas is `MainForm`.
- **And it happens to methods too, which is worse: the base one stops being
  callable.** `Split.Resize` lasted one test run -- `Widget.Resize(w, h)` is a
  method every control has, so an accessor of that name on a subclass shadowed
  it on the prototype and the designer went down with `cannot read property
  'Children' of null`, four hundred lines from the cause. It is `Grows` now.
  The check is mechanical and worth running before naming anything:

  ```sh
  # every subclass property that shadows a base one, and whether the kinds differ
  grep -n 'JS_C\(GETSET\|FUNC\)' runtime/src/bta_widget.c   # the base table
  ```
- **A subclass property that shadows a base one breaks silently, and only
  sometimes.** `TreeView.Expand(key)` shadowed `Widget.Expand`, the layout
  boolean, on the prototype -- and worked, until a `.form` assigned `Expand:
  true`, which put an own boolean on the instance and made the method vanish.
  Check a new name against `bta_widget_base_props` before using it; the tree's
  is `ExpandNode` for this reason.
- A menu label goes through GTK's mnemonic parser: a `_` eats the letter after it
  and underlines it. `bta_menu.c` doubles it in the labels of a `dynamic` item,
  which are data; any other text that comes from data and ends up in a menu needs
  the same.
- A `Notebook` whose page is empty -- the IDE hides the editor while designing --
  still absorbs height if it expands, and that shows up as a blank band that
  grows with the window. `setMode` turns its `VExpand` off and leaves `HExpand`.
- `.js` load order matters when one project class extends another. `sources` in
  `project.json` fixes it; creating a form from the IDE registers it there,
  and without that entry the class silently never loads.
- **A widget that claims a gesture sequence cancels every other gesture on it,
  in either phase.** Not only the bubble-phase problem the drag source has: VTE
  claims the press for its own text selection, so the `GtkGestureClick` that made
  `Terminal.LinkPattern` work saw `pressed` and then *never* saw `released` — in
  capture too, because claiming is not about ordering. Something that needs both
  halves of a click on a widget that handles its own has to be a
  `GtkEventControllerLegacy`, which has no sequence to lose. It gets surface
  coordinates rather than the widget's, so the point goes through
  `gtk_widget_compute_point`.
- **`gtk_text_view_scroll_to_iter` on a view with no allocation does nothing, and
  says nothing.** A tab that was just opened has not been laid out yet, so
  revealing a match through an iter leaves the selection right and the view
  somewhere else -- which reads as the jump being wrong rather than early.
  `scroll_to_mark` keeps the request and carries it out on the frame there is one,
  so anything that scrolls right after building or switching a view has to go
  through a mark. **`Editor.Select` and `GotoLine` both do, and the second one
  only since somebody called it from a third place.** This entry used to end
  "`GotoLine` predates this and is called where a frame has already passed",
  which was true of the two callers it had -- a traceback clicked in the log and
  the find bar, both inside a tab already on screen -- and false the day the
  events page opened the `.js` and jumped to the handler in the same turn. The
  symptom is the one this whole entry is about and it is easy to misread: the
  cursor is on the right line, the view is at the top of the file, and nothing
  anywhere says so. **The rule has no exceptions worth writing down**: if it
  scrolls, it goes through a mark.

  It was **not assertable** while an `Editor` answered where its *cursor* was
  and never where it was scrolled to; `ScrollY` exists now -- asked for by a
  diff viewer and not by this -- and `tests/widgets` (`EditorScroll`) asserts
  the jump. One thing that test had to learn and anything reading a scroll has
  to know: **the mark is honoured on the next frame**, so `ScrollY` on the line
  after `GotoLine(n)` still answers where the view was. Assigning a scroll is
  immediate; asking to be shown a line is not.
- **`GtkSourceSearchContext`'s `occurrences-count` is filled in by a background
  scan and answers `-1` until it lands.** Same for `get_occurrence_position`. A
  find bar built on either shows "12 matches" some frames after the search, and a
  test can only wait and hope — which is the shape of every flaky test this repo
  has had. `Matches`/`MatchIndex` walk the matches with
  `gtk_source_search_context_forward` instead: synchronous, exact, assertable, and
  unmeasurable on a source file.
- **`gtk_list_box_get_selected_row` answers `NULL` in `SELECTION_MULTIPLE`.** So
  `ListBox.Index` and `.Text` would have gone blank the moment `MultiSelect` was
  turned on, on a list with three rows selected. Both walk the rows looking for
  `row_is_selected` now. GTK also reports the two modes through different signals
  (`row-selected` / `selected-rows-changed`) and emits the second in *both*, so
  the multiple handler has to stay quiet in single mode or every selection arrives
  twice.
- **Re-grouping a check button that is already in the target's group closes the
  chain into a ring.** `gtk_check_button_set_group` moves a button out of its
  list and into the target's, so pointing one at a group it is already in unlinks
  and relinks it inside itself. Nothing complains; the next click walks the group
  to turn the others off and walks forever, and what you see is a test with no
  output and a process that will not end. `bta_radio_regroup` unlinks **every**
  child first and only then rebuilds, which is one pass more and the only shape
  that cannot make a cycle.
- **A radio taken out of a container is still linked into the chain it left.**
  GTK4's group is a linked list, not a name, so `bta_radio_regroup` unlinks the
  child *first* and then rebuilds the slot's chain — otherwise turning that radio
  on later turns something off in a container it is no longer in, which is a bug
  found months later. Every path that adds or removes a child goes through it
  (`bta_container_attach`/`detach`), and it returns at once for anything that is
  not a `CheckButton` -- which is one class now, a tick until it is given a
  `Group` and one of a set afterwards, because GTK4 has no radio widget to
  mirror.
- **A substituted value must never be what gets saved, and this is the
  `Width`/`Height` trap wearing a hat.** The serialiser reads the *current* value of
  every property, so once the `.form` loader started translating prose, a form opened
  in Spanish and saved came back with the Spanish in it and the msgid gone -- exactly
  as saving an allocation turned a measurement into tomorrow's floor. Every
  substitution leaves a note (`__declared[key] = [declared, applied]`) and
  `collectProperties` writes the declared value back **while what was applied is
  still what is there**; anything that assigned since is the newer truth and wins,
  which is what keeps the property grid from having to announce its edits. `Fill()`
  leaves the same note for the same reason -- without it, saving a form whose labels
  had been filled in wrote "1 unsaved of 7" where the template belongs.
- **Putting keywords in a `ComboBox.Items` from a `.form` translates them, and
  then the runtime refuses what the dialog writes.** `Items` is a prose property,
  so the loader puts every entry through the catalogue: the column editor's
  alignment combo declared `["Left","Center","Right"]` in its `.form`, and a
  translator rendering "Right" as "Derecha" would have had it write
  `Alignment: "Derecha"` into a property that accepts three English words. Fill a
  list of *values* from code -- `PropertyOptions` is the runtime's own answer to
  what a property accepts -- and only prose from the file. The extractor is what
  caught it, by collecting three keywords as if a person read them.
- **A declaration may name a member of an object.** `TableView` says
  `"Columns.Text"`, because a column carries a heading, a width and an alignment
  and only the first is prose. The loader copies the object and translates that
  member; the extractor reads the same declaration. Never a rule about the key's
  spelling -- a rule that took every string in an object would put `"Right"` in
  the catalogue, which is the bug above with a different door.
- **Which properties hold prose is declared per class, and the permissive mistake
  is a disaster rather than a bug.** `SourceEditor` declares no `texts`: its `Text` is
  the source file being edited, and a catalogue holding one line of it would rewrite
  the user's code -- silently, and only for whoever runs in that language. Same for
  anything holding a name (`Style`, `Icon`, `Font`, `DatePicker.Format`). This is
  also why translating in the **setter** was refused outright: `Lbl.Text =
  customer.Name` would look a customer's name up, so a client called "Open" comes
  out translated. `Message.Error`'s first argument does go through the catalogue,
  and the difference is the population that flows through the position -- every name
  in the program passes through a Label's Text; only messages pass through
  `Message.Error`.
- **A template literal in a position that holds prose is the failure mode of this
  whole feature.** `Locale.Text(`Saved in ${p}`)` extracts as the *interpolated*
  string, so the msgid changes on every run and no catalogue can ever match it --
  and nothing says so at runtime. It is why the interpolation is `{0}` and lives
  inside the call, and why `ide/modules/Strings.js` lints for it. The lint only fires
  when the literal parts contain letters: `` `${key}: ${e.message}` `` is
  punctuation around two values and warning about it is how a lint gets switched off.
- **A `Plural-Forms` header is a C expression and there is no way around evaluating
  it.** `eval` is not part of this language and a table of known languages would be
  wrong for the next one, so `bta_locale.c` parses it -- and reads its integers
  digit by digit rather than with `strtol`, because GTK has called `setlocale()` by
  then and a catalogue header is not the desktop's to spell.
- **The `design` block is safe because of who reads it, not because of a check.**
  Only `AddNode(node, true)` -- the designing branch -- applies a design value, and
  the C loader has no idea the key exists, so one cannot reach a running application
  even by accident. The same flag is what keeps the designer from translating: a
  designer running in Spanish that resolved prose would bake the translation into
  the next save.
- **A prose position the *runtime* owns cannot be translated at all.** The IDE's
  extractor reads a project's own `.js` and `.form`; a msgid living in C is
  invisible to it. `Message.Info` escapes this because the msgid comes from the
  caller. The completion popover's group title is the first string the runtime
  itself owns, and it is **an open question, not a solved one**: passing NULL to
  own no prose was tried and is suspected of having contributed to a popover with
  no size, so it is a fixed `"Words"` for now. The half that *is* answered is the
  provider fed from JS: `SourceEditor.CompletionTitle` is declared as prose in the
  class row, so the application names its own heading and the catalogue translates
  it. GtkSourceView's own words provider still shows the English word, and that is
  the piece left -- it needs a spelling for a title the runtime owns, which is the
  same question `Message.Info` sidesteps by taking the msgid from the caller.
- **`GtkCalendar` has one date and no notion of the month on screen**, so turning
  the page *is* a change of value: two presses of the next-month arrow moved
  `Value` from `2026-03-08` to `2026-05-08`. Until this was found it raised
  nothing -- `day-selected` does not fire on a page turn, only `notify::month` --
  so a form's date silently went stale, and a `DatePicker`'s button label with it
  (it read March while `Value` answered May). `on_date_page` in `bta_controls.c`
  is all three answers together: the marks in view, the label, and `Change`. Both
  it and `on_date_selected` are blocked while `Value` is assigned, or one
  assignment that lands in another month would raise the event on the way and
  again at the end.
- **A `Calendar`'s mark is a date and GTK's is a day of the month.**
  `gtk_calendar_mark_day` takes 1-31 and marks it in whatever month is displayed,
  so marks would follow the page and land on the wrong days. What the widget keeps
  is the list of dates (sorted, normalised, `MARKS_KEY`); GTK's marks are redrawn
  from the part of it in view every time the month changes.
- **The page-turn path has no suite coverage and cannot have any**, because
  nothing in JS can turn the page: `Value` blocks the handler by design and there
  is no way to press GTK's own arrow. It was measured instead, and this is the
  command that does it again -- an `Xvfb` of its own, because `xvfb-run` owns its
  display for one command and this needs two:

  ```sh
  Xvfb :99 -screen 0 1024x768x24 & sleep 2
  DISPLAY=:99 ./build/bintana <probe-project> &            # a Calendar at 8,60
  W=$(DISPLAY=:99 xdotool search --name CalProbe | tail -1)
  DISPLAY=:99 xdotool mousemove --window $W 133 72 click 1     # the > arrow
  DISPLAY=:99 import -window $W /tmp/turned.png
  ```

  The same shape answered "is a mark drawn at all", which JS also cannot see: four
  renders compared with `tests/probe.sh diff` -- a mark in the month on screen
  changes the picture, one a month away changes **zero pixels**, and turning the
  page to that month brings it out.
- **The palette's completeness is asserted, not maintained.** `PALETTE_TABS` in
  `ide/modules/Palette.js` was six types short -- `TreeView`, `SourceEditor`,
  `Terminal`, `RowList`, `Overlay`, `Flow` -- so the IDE was drawn with controls
  its user could not place, and nothing said so *because the icons were already
  there*: `PALETTE_ICON` is shared with the control tree, which needs an icon for
  whatever a form holds. `tests/ide`'s palette phase now asks `Widget.Types()` and
  fails on anything not offered (`Form` and `Component` excepted), so a widget
  added to the runtime lands in that assertion until it has a tab and an icon.
- **Two palette buttons must not be the same picture, and every other assertion
  passes while they are.** Each button had *an* icon and the icon existed, yet
  `ListBox` and `Separator` both drew `view-list-symbolic` and `Panel`, `Grid` and
  `TableView` all drew `view-grid-symbolic` -- a fallback chain reaching the same
  theme name from two entries is all it takes. There is an assertion for it now,
  and it can only see the theme the suite runs under (Adwaita, under Xvfb); the
  developer's own desktop is answered off the disk the way `tests/icons.sh` does
  it, and what it answered lives in the comments beside the names.
- **`Application.HasIcon` renders and looks for ink**, so it already answers "will
  this draw" and not merely "does the theme have it" -- which is why the palette's
  fallback chains work at all on a desktop whose symbolic icons are positioned
  with a `transform`. What it cannot do is invent a fallback: a name with nothing
  behind it comes back `""` and the button is *empty*. That is what
  `color-select-symbolic` did to the palette's `ColorButton` here -- embedded in
  GTK, overridden by this desktop, blank -- and the fix is a drawn icon behind it,
  not a cleverer lookup.
- **There are two editors now, and which one a name means matters.**
  `SourceEditor` is GtkSourceView (`bta_editor.c`) and `TextEditor` is a plain
  GtkTextView (`bta_text.c`); the shared half -- `Text`, `Line`, `Column`,
  `Offset`, `LineOf`, `OffsetAt`, `Selection`, `Modified`, `ReadOnly`, `Wrap`,
  `CanUndo`/`CanRedo`, `GotoLine`, `Select`, `Insert`, `Append`, `Clear`,
  `Undo`, `Redo`, `Change`, `Cursor` -- is
  an abstract `Editor` both inherit, because a `GtkSourceView` *is* a
  `GtkTextView` and the code was already written against the base class's API.
  The IDE's code tabs are `SourceEditor`s; `PoForm`'s translation boxes are
  `TextEditor`s and used to be the source editor with `Language = ""`,
  `ShowLineNumbers = false` and `Wrap = true` -- which is what the plain one now
  is by default, and the reason it exists.
- **An offset is a character and an index is a JavaScript number, and the
  runtime has a verb for each so no caller crosses them by hand.**
  `Offset`/`OffsetAt(line, [column])` count **characters**, as `Column` and
  `Select` do -- an emoji is one, and `OffsetAt(Line, Column) === Offset`.
  `LineOf(index)` (and `Text.LineOf(text, index)`) receives the **index a search
  returned** -- the number `Regex.Index`, `indexOf` and `slice` speak, which
  counts UTF-16 units and calls that emoji two. **The conversion is a walk and
  not an identity**: on `"🙂\nx"`, index 2 is the `\n` (line 1) while character
  2 is the `x` (line 2), so handing a search's index straight to GTK's
  `get_iter_at_offset` answers the wrong line on any file with an astral
  character before a break -- silently, and correctly on every file without
  one. That is why `LineOf` reads the text and the other two do not: GTK
  answers a character directly. **The separators are GTK's, since the line goes
  to `GotoLine`**: `\n`, `\r\n` as one, a lone `\r` and U+2029 break; U+2028
  does not break a buffer although Pango breaks it, so `Text.Lines` and
  `LineOf` disagree on that one character. Eight crossings in the IDE became
  `Text.LineOf`; `Live.lineAt` was dead and went; `Live.caret` stays hand-rolled
  on purpose, because it compares against a match's `Index` and both sides are
  already JS numbers.
- **`Editor` is abstract for one reason, and it is not tidiness.** `texts`
  accumulates *down* the class chain (`class_list_of`), and there is no way for a
  child to refuse what its parent declared. A plain `TextEditor` should declare
  its `Text` as prose -- a form may put a starting note in one, and it is a
  caption like any other -- while a `SourceEditor` must never, or a `.po` file
  would rewrite somebody's source, silently and only in one language. Siblings can
  disagree about a property; a child cannot disagree with its parent. If either
  class ever needs the *other's* metadata, the answer is not to reparent them:
  it is another sibling.
- **A renamed control fails silently in a `.form`.** `applyNode` assigns what a
  file declares (`widget[key] = value`) and never asks whether the class has that
  property, so a `.form` that still says `TextEditor` where it means the source
  one loads the plain editor and its `Language`, `ShowLineNumbers` and the rest
  become ordinary JavaScript properties on the object -- no error, no
  highlighting, no gutter. Every `.form` in this tree was converted with the
  rename; a project outside it has to be, and there is nothing that will say so.
- **The two defaults the editors disagree about are `Wrap` and the font**, and
  both are deliberate: prose in a narrow box with a horizontal scrollbar is
  unreadable, and code that wraps hides its own indentation. So `Wrap` starts
  `true` on a `TextEditor` and `false` on a `SourceEditor`, and only the source
  one is monospaced. A test asserting a default has to build a **fresh** control
  for it -- `this.Ed` has been through the source editor's own tests by then, one
  of which turns wrapping on, and that is a failure that only appears in a full
  suite run.
- **`tests/api.sh` cannot see a class rename.** It checks that every member has a
  row *somewhere* in `docs/llm/controls.md`, not that the row is under the right
  class -- so moving `Language` from one class to another, or documenting it under
  a name the runtime no longer has, passes. It stayed green through this whole
  rename. What catches that is reading the reference, and the CSS-node table in
  `tests/widgets`, which does force a new class to be written down.
- **What a trip from JS into C costs here, measured**, because more than one
  design decision turns on it and guessing has gone both ways: a trivial getter
  is **290 ns**, a two-argument method **465 ns**, a string setter **505 ns**, and
  a method that returns a fresh object (`Bounds()`) **1,570 ns** -- 200k
  iterations each, QuickJS, no display. So a 16 ms frame holds tens of thousands
  of calls, not hundreds; and **an accessor that allocates an object is 3-5x one
  that returns a number**, which is the argument for `TextWidth(s)` over a
  `TextSize(s)` returning `{Width, Height}` in anything called in a loop.
  The other half of the same measurement: **filling a JS array costs 405 ns per
  element**, so feeding a batched call costs about what making the calls would
  have. QuickJS is an interpreter and the interpreter is the floor -- batching an
  API buys ~2x, never 100x. The table is in
  [`docs/architecture.md`](docs/architecture.md#what-a-call-across-the-boundary-costs),
  and the cairo half of it in
  [`docs/widgets.md`](docs/widgets.md#drawingarea-and-painter).
- **A `Painter` outliving its frame is the one way to crash a drawing**, so it
  refuses instead. The `cairo_t` belongs to GTK's draw function and is destroyed
  when it returns; `painter_of` in `bta_paint.c` is the single door every call
  goes through, and it throws once `cr` is NULL. Keeping the painter in `this` to
  draw from a timer is the natural mistake and the one the refusal catches.
- **`Text` had to clear the path, and `Arc` had to not.** Cairo appends an arc to
  the current path, joining it from wherever the current point was -- which is
  what a pie slice wants (`MoveTo` the centre, `Arc`, `ClosePath`, `Fill`).
  Showing a Pango layout leaves a current point, so the first drawing this
  runtime ever made had a stray diagonal from a label across to an arc. Drawing
  calls leave no path; path calls do.
- **A `Dump()` formatted with `%g` is a `Dump()` that changes with the locale.**
  printf follows `LC_NUMERIC`, so the point `(380, 142.449)` printed as
  `(380,142,449)` here -- a decimal comma inside a comma-separated pair, in the
  one output a test asserts on. `g_ascii_formatd` is the locale-independent one,
  and this is the same trap the JSON patch in `vendor/` exists for. Anything that
  formats a number *for a test to read* has to use it.
- **A `DrawingArea` has no natural size**, because there is nothing inside it to
  measure: one placed with neither a size nor an `Expand` is allocated 0x0, its
  handler is called with a 0x0 frame, and nothing is drawn. A test that asserts
  anything about a real frame has to size the surface first, and the palette gives
  a placed one 240x160.
- **`Save()` is why the drawing tests are not screenshots.** It runs the same
  `Draw` against an image surface, synchronously, so `Dump()` can be asserted
  call by call with no waiting for GTK to paint; the on-screen path is a separate
  claim and is covered once, through `until`, because "the draw function is wired"
  and "the handler works" are different facts. The file it writes is checked by
  loading it into a `Picture` and reading `SourceWidth`/`SourceHeight` -- the
  runtime can read a PNG back, which is cheaper than a pixel probe.
- **A `void` helper that throws is a throw nobody sees.** `paint_frame` refuses a
  `Save()` asked for from inside a `Draw` -- one painter means one frame -- and
  for as long as it returned `void`, `area_save` carried on, wrote the PNG and
  returned success with the exception left pending. The test read `NOT REFUSED`
  against a guard that was firing -- and the *next* two tests failed as well,
  because a pending exception nobody consumed stays on the context and lands on
  whoever asks next (`an uncaught error reaches the application: expected 1, got
  0`, then a crash reading a property of `undefined`). Anything that can throw has
  to be able to say so to its caller, even when one of its two callers -- the draw
  function -- has nobody to tell.
- **A console project could make a widget and dump core.** A project declaring
  `main` never calls `gtk_init`, so `new Panel()` reached
  `gtk_css_static_style_get_default()` with nothing initialised and the process
  died with no message at all -- found while testing something unrelated, and
  costing a `gdb` backtrace to identify because there was nothing to read. It is
  a refusal now (`bta_ctor`): *a project with a `main` has no display, so it
  cannot make widgets*.
- **`MouseWheel` carries the amounts and not the position.** Two arguments,
  which is already in the trap list one way (it was documented as four); the
  consequence for anything that zooms about the pointer is that the position has
  to come from the last `MouseMove`. `Chart` tracks it for the hover anyway. And
  **a chart that pans cannot report `Select` on `MouseDown`**: the press is
  remembered, the movement decides whether it was a drag, and the release reports
  the click -- including suppressing the one that completes a double click, or a
  reset is followed by a selection nobody asked for.
- **The obvious spline lies, and a picture cannot show it.** `Chart.Curved` draws
  a rounded line, and Catmull-Rom -- the five-line answer -- overshoots: two
  rising samples grow a taller peak between them, and a series that never went
  below zero dips under the axis. Monotone tangents (Fritsch-Carlson) cannot leave
  the box two samples make. The reason it is worth knowing here rather than in the
  chart: **a curve that overshoots looks better**, so the test is not a look but a
  read of `DrawingArea.Dump()` -- every `CurveTo`'s control points, checked against
  the data's own range. Any claim about a drawing that a nicer-looking bug would
  satisfy wants that treatment.
- **A test that starts a child with a window steals the focus from the suite
  that started it.** The library test spawns the runtime on a scratch project and
  went on with the rest of the run; the child's window took the focus and turned
  three of `testTabOrder`'s assertions red -- the hazard that test's own comment
  warns about, arriving from a direction it did not expect. The fix is
  `this.Visible = false` in the child's `Form_Open`, which runs *before* `Show()`
  returns, so the window is never mapped at all. A child that needs a widget but
  not a window is the shape to reach for: a console project cannot make one.
- **Several `.po` files make one catalogue, so `po_parse` must not create the
  table.** A library's `po/` is read before the project's and both go into
  `L.entries`; while the parse created a fresh hash table per file, the second
  one silently threw the first away -- and it looked exactly like a catalogue
  that had not been found (the library's own msgids untranslated, the project's
  fine). The order is load order: the last file to mention a msgid answers for
  it, which is why the project's is last.
- **A library is a directory, and the runtime finds it one hop from its own
  binary.** `"uses": ["charts"]` in project.json resolves over the project's
  `lib/`, `$BINTANA_LIB_PATH`, `~/.local/share/bintana/lib`, `<bin>/../lib` (the
  source tree), `<bin>/../share/bintana/lib` (installed) and `/usr/share`. The
  two binary-relative ones are the same hop because `bin/` and `share/bintana/`
  move together under `--prefix` and `DESTDIR` -- the argument `tools/bintana-ide.in`
  already made for the launcher, now inside the runtime. **A library's forms are
  indexed with the project's** (`form_path` in `bta_form.c`), which is the part
  that makes `"type": "Chart"` work in a `.form`; forgetting it would have looked
  like the class loading and the form silently not. The search is published in
  **both directions** and neither belongs anywhere else: `Application.LibraryPath`
  resolves one name, `Application.Libraries` says which names there are, and both
  walk `lib_candidates` in `bta_runtime.c`. The IDE ticks libraries in its project
  dialog off the second; a copy of that path in JavaScript would be the copy that
  goes stale, because the C one is what every program runs.
- **A `MoveTo` in the middle of a shape is a second subpath, and a fill runs the
  winding rule across both.** A ring segment written as `Arc` out, `MoveTo` in,
  and line segments back cut white wedges through the middle of the first doughnut
  `examples/charts` drew -- which looks like a rasteriser bug and is a path with
  two pieces in it. `Painter.ArcNegative` exists for exactly this: out along the
  outer radius, back along the inner one, one path. It is the only primitive the
  chart set asked the surface for -- which is what writing the client first was
  for, and the whole of what it added to the C.
- **In this interpreter, a pass over the data costs more than painting it.**
  Measured while writing `examples/charts`: a 21,600-reading line drew at 35
  frames a second with 21 ms inside the `Draw` handler, of which about *one*
  millisecond was drawing. The rest was two data passes -- decimating on every
  frame, and computing the y range as
  `Series.flatMap(s => s.Values).filter(isFinite)` with `Math.min(0, ...all)`
  over the result. Cached on the array's identity and rewritten as a plain loop,
  the same chart draws at **59 frames a second with 3.5 ms**. So: `Polyline` of a
  thousand points is cheap, `flatMap` of twenty thousand is not, and a spread of
  twenty thousand arguments is a stack overflow waiting for a longer series.
  Anything derived from a large array belongs computed when the array changes, not
  when the frame does.
- **A stopwatch inside a `Draw` measures the recording, not the drawing.** GTK4
  hands the draw function a cairo context over a `GskCairoNode`, so the calls are
  recorded and the rasterising happens later. Measured with the jagged
  5,000-point line of `tests/manual/cairo-cost.c` in an 800x400 area: **8 ms
  inside the handler either way, and 3.9 frames a second antialiased against
  57.7 without**. Through `DrawingArea.Save()` -- an image surface, rasterised
  inside the call -- the same drawing is 283 ms against 28 ms. So: to ask *what
  does this cost*, time a `Save()`; to ask *is this smooth*, count frames over a
  second (`examples/drawing` does both). A stopwatch around the painting is
  neither, and it is the first thing everybody reaches for.
- **And quote the conditions with it, because that number is about covered pixels
  and nothing else.** The first person to run `examples/drawing` reported "always
  about 60 frames a second", and they were right: in its 402x159 sparkline the
  cliff needs **3,240 jagged points to reach 15 fps and 9,720 to reach 3**, while
  1,080 is 51 and anything smooth stays at 60. Stretch that same box to 402x419
  and every figure roughly halves (29, 7, 1.2), which is what "covered pixels"
  means: the height a segment travels counts as much as how many there are. The
  3.9 figure above is 5,000 points in twice the area. Below about a thousand points nothing shows at all --
  which is the practical answer for any real chart, and the reason the cliff has
  to be quoted with its point count, its shape and its box or it reads as a
  warning about work nobody does.
- **It is not the renderer.** Measured at 8.5-8.8 frames a second under all four
  of `GSK_RENDERER=cairo`, `gl`, `ngl` and `vulkan`: a cairo node is rasterised on
  the CPU whichever renderer composites the result, so there is no "it will be
  fine on a real GPU" to hope for -- and no reason to suspect Xvfb either.
- **A value that is not a number is a gap in a line, and it used to be a lost
  frame.** The painter refuses NaN and a throw inside `Draw` ends the frame, so a
  `null` in a Line or Area series -- ordinary in data from a query -- drew
  nothing at all past it. `Chart.numberOf` makes null, `""`, booleans and text
  that is not a number `NaN` (null and `""` used to be 0, silently), and Line and
  Area draw separate runs that stop at a gap, decimation included. Three smaller
  things came with it: **divide before multiplying** when mapping to pixels --
  `(v - lo) * h / (hi - lo)` overflowed near the top of a double where
  `(v - lo) / (hi - lo) * h` does not; **never name a class static `valueOf`**
  or any other `Function.prototype` member, it shadows what coercion calls; and
  **`DrawingArea.Dump()` is capped** (`DUMP_CAP`, ending in `...`), so an
  assertion about the second band of a 4000-sample chart read the first and
  passed against the bug -- save narrow and assert the markers are there.
- **A chart assertion sets every property it depends on.** The *stacked Line
  turned Bar* check passed against the bug in a copy with the section before it
  removed, because `Type` was still the default `Bar` it inherited.
- **`Push`/`Pop` does not save the font.** It saves the colour, the pen, the
  transform and the clip -- cairo's own state -- and the font lives on the
  `PangoLayout` beside it. `lib/report` wrapped every element in a `Push`/`Pop`
  and set `p.Font` only when the element named one, with a comment claiming that
  a font "can never leak into the next": the whole statement of account came out
  in the `Bold 18` its title declared, and the date under the heading was drawn
  at 18 points. The rule for anything that draws text it did not write: **read
  the font once at the top of the `Draw` and assign it for every run**, either
  the element's or that one. Asserted in `tests/report` off two `Text` calls and
  the `Font` lines between them.
- **`Scale` before `Translate` scales the offset.** Cairo post-multiplies, so of
  two transforms the one written *last* is applied *first* to a point: `Scale(s)`
  then `Translate(o)` puts a point at `s * (p + o)` and not at `o + s * p`.
  Measured with a probe -- `Scale(0.5)`, `Translate(100,0)`, a rectangle at the
  origin -- the ink lands at x=50. `lib/report` centred its page that way and the
  preview sat off-centre by `(1 - scale) * offset`, which is nothing in a small
  window and ninety pixels in a maximised one, and **is exactly zero in an
  export**, whose offset is zero -- so every PNG anybody checked was right. To
  place then scale, write `Translate` first.
- **An event emitted while a `.form` is being applied reaches the host's handler
  before the host's other controls exist.** Measured: a `Report` with
  `"Paper": "Letter"` in the form emitted `Prepared` from the setter, the form's
  `Report_Prepared` ran, and `this.Lbl` -- a `Label` two lines further down the
  same file -- was `undefined`. It is not a load-order rule about one component:
  **a property setter must not raise an event**, which is the shape `Chart`
  already has (its `Refresh()` only redraws, and every `Emit` is in a handler).
  Where a component genuinely has to report a computed result, raise it from the
  members a `.form` cannot write -- `Report` emits `Prepared` from `Data`,
  `Sections` and `Refresh()`, and stays silent when the paper or the margins
  change.
- **A throw inside a `Draw` does not reach the handler's caller, and for a long
  time it did not reach the exporter either.** `bta_emit` reports what a handler
  threw and consumes it, which is right for an event and wrong for `Save`: it
  wrote a PNG of whatever had been drawn before the error and returned happily.
  `Report` read `this._sections.PageHeader` and threw on every frame for any
  report whose form had not filled it in yet -- the ordinary case of a preview
  waiting for the user to choose something -- and it was invisible from the
  outside. `bta_emit_ok` is the same emit answering whether the handler threw;
  `paint_frame` turns that into an exception, so **`Save` and `SavePdf` now fail
  and write nothing**, and `on_draw` throws the exception away because on screen
  there is nobody to hand it to -- leaving it pending would surface it at the
  next call into JS, half a program away from the frame that made it. The
  on-screen path still swallows the error, so **to assert that a frame ran to the
  end, read `DrawingArea.Dump()`**: the clip it opens and the `Pop` that closes
  it are in the dump, and a frame that died halfway has neither.
- **Telling a store an item changed costs a tree its selection, and a flat list
  keeps it.** GTK's selection model follows the *item* across an
  `items-changed`, so `SetCell` on a flat `TableView` leaves the highlight where
  it was. Under a `GtkTreeListModel` it cannot: the model answers with fresh
  `GtkTreeListRow` wrappers and the selection was on one of those. So renaming a
  node moved the selection to nowhere -- in `TreeView`'s new `SetText`, in
  `TableView`'s tree mode, and in `SortBy` before them. Every one of those
  remembers the node and puts it back; a caller that changed a cell did not ask
  to move anything. **The general shape: anything that goes through
  `items_changed` on a tree has to restore the selection**, and the reason a flat
  list does not is worth knowing before assuming the two behave alike.
- **Four controls answering the same question four ways is a bug with no failing
  test.** `ListBox`, `RowList`, `TreeView` and `TableView` are all lists, and
  they had drifted: `RowList` published three members and no way to select
  anything from code, `TableView` had `MultiSelect` and `Selection` without the
  four verbs that move a selection, `TreeView` could be emptied but never have
  one node removed, and `RowList` took GTK's `activate-on-single-click` default
  where `ListBox` deliberately sets the other one. None of that fails anything --
  it is only visible when a program moves a list from one control to the next and
  finds half its vocabulary missing. **The check is to read the four surfaces
  side by side**, which is now a table at the top of the list section in
  `controls.md`; the rule that came out of it is that what a row *is* differs
  between them and nothing else may.
- **What a `bind` connects, an `unbind` has to disconnect -- and the bug that
  proves it looks like nothing at all.** Whether a node draws a disclosure arrow
  is decided when its row is bound; a parent is routinely added *before* its
  children (`Add` takes a parent by key), so the row was bound when the answer
  was still "no children" and nothing rebinds it when they arrive. The arrow
  never appears and the folder cannot be opened -- no error, no warning, just a
  tree that does not work. The bound row has to watch its own children store
  (`items-changed`) and let go of it in `unbind`, or the next node recycled into
  that row keeps the previous one's watch. `TreeView` had already learned this;
  `TableView`'s tree mode had to learn it again.
  **And the first probe hid it**: it called `SetIcon` on the parent *after*
  adding the children, which rebinds the row and recomputes the arrow. A check
  written one call later than the bug would not have found it. When a rendered
  thing looks right, ask what else in the probe could have made it right.
- **`bta_widget_watch` holds a reference, so watching a *replacement* keeps the
  original alive.** It refs on purpose -- the pointer has to be valid when the
  handlers are unhooked -- which means a control that swaps its model and watches
  each new one keeps every model it ever made. `TableView` does swap (flat, on
  demand, tree), and a `GtkTreeListModel` that outlived its `Clear()` went on
  asking a now-flat row for its children: `g_object_ref: assertion 'G_IS_OBJECT
  (object)' failed`, a sentence about a NULL store that says nothing about where
  it came from. **Whatever watches a replaceable object has to unwatch the one it
  replaces** -- `g_ptr_array_remove_index_fast` on `w->watched`, which
  `on_form_realized` was already doing for its surface.
- **`Clear()` is the way out of every mode, on-demand included.** It reset a
  tree to flat but left a table answering `Data` with its `Count`, so
  `Add(values, { Key })` refused with *Clear() it first* and `Clear()` could not
  satisfy it. And a `Data` answer whose `Text` or `Icon` failed to convert left
  the exception pending inside a bind -- reported now like a `Data` that throws,
  with `null` meaning no icon rather than the icon named `null`.
- **`CellEdit` read everything after the handler it had just called, and the
  row index was never there.** `on_cell_edited` passed `row->index`, which only
  `bta_table_model_item` ever writes -- so in a flat table built with `Add`
  every real edit reported and redrew **row 0**, and the suite could not see it
  because it only ever raised the event with `Emit("CellEdit", 0, ...)`. And a
  handler that called `Clear`, `RemoveRow` or `SetCell` unbound or rebound the
  label synchronously, freeing the row, `bta-edit-old` and the label's buffer
  the code went on to read. The index is asked of the store now, before and
  after; the row, the label and the table's wrapper are held and both texts
  copied across the emit. **Not assertable from the suite**: a real
  `GtkEditableLabel` edit needs a pointer, so this one is a by-hand check.
- **`GtkColumnView` cannot hide its heading row**, and that fact decides a design
  question rather than being a detail of one. `set_show_row_separators` and
  `set_show_column_separators` are what can be turned off; `set_header_factory`
  is for *section* headings. So a hierarchy with no headings is not expressible
  in a column view, which is why `TreeView` is not "a `TableView` with one
  column" and why the tree mode went into the table rather than columns going
  into the tree. Check what a widget can turn *off* before designing on the
  assumption that it can.
- **`tests/api.sh` matches a member name anywhere in `controls.md`, not under its
  own control** -- deliberately, because inherited members are documented once
  under `Widget` or `Container` and a per-control check would have to know the
  hierarchy. Two consequences, and both have happened. It **misses** a member
  that exists on one control and is documented only for another. And it
  **catches**, by accident, a name that means two things: `AddNode` on a new
  `TableView` came back "documented" because `Container.AddNode(node)` -- *build
  a widget from a `.form` node* -- already had that row. That was the check
  doing the right thing for the wrong reason, and the name was wrong: a
  vocabulary this small is only worth having if a word means one thing. It became
  `Add(values, { Key, Parent })`, which is the options-object shape
  `Directory.Files` and `Exec` already use.
- **`g_base64_decode` ignores what it does not understand.** Hand it `"hello"`
  and it answers three bytes rather than an error, so a value that was meant to
  be text becomes a silent handful of nonsense -- and `Field.Bytes` reads base64
  out of *files*, which is exactly where that lands. The alphabet, the padding
  and the length are all decidable before decoding, so `Bytes.FromBase64` decides
  them. The general shape: a GLib parser that "is lenient" is one whose input has
  to be checked here.
- **`sqlite3_column_blob` before `sqlite3_column_bytes`, always.** That is
  sqlite's own documented ordering: asking for the length first can answer for a
  *converted* value rather than the stored one. The same trap exists for
  `_column_text`.
- **A value handed over by GLib, sqlite or GTK is borrowed.** `bta_bytes_new`
  copies, and every one of its callers is why: `g_file_get_contents` hands over a
  buffer it expects you to free, a sqlite BLOB belongs to the statement until the
  next `step`, and a base64 decode is `g_malloc`'d. A `Bytes` outlives all three.
- **The desktop's file drop is a different *type*, not a different value.**
  `AcceptDrop` registers a `GtkDropTarget` for `G_TYPE_STRING`, which is the
  application's own `DragData`; the file manager offers `GDK_TYPE_FILE_LIST` (or
  a bare `G_TYPE_FILE` for one file), and a target that does not name those types
  never sees the drop at all -- it is refused by GTK before any handler runs, so
  there is nothing to debug and nothing in the log. Hence `AcceptFiles` as a
  second property with a second target rather than a mode on the first, which
  also keeps `AcceptDrop === true` meaning what it has always meant in every
  `.form` already written.
- **A dropped file may have no path.** Something on a remote share is a real
  `GFile` whose `g_file_get_path` is NULL; handing its URI over as if it were a
  path fails one line later, in whatever `File.Load` the handler wrote, and looks
  like a bug in the application. Those are dropped, and a drop with nothing local
  in it is refused rather than delivered as an empty list -- a handler called with
  nothing would have to check for it, and every one of them would forget.
- **A test that throws on purpose must take `Application.OnError` first, and the
  test it breaks is somebody else's.** An uncaught error with no handler set
  opens a modal `GtkAlertDialog`, and `report_error` opens no second one until
  that one is dismissed (`reporting_error`, which is what stops a handler
  throwing on every tick from stacking dialogs forever). Nothing in a test
  dismisses it. So the moment `tests/widgets` grew a `Draw` that throws
  deliberately, the guard stayed up for the rest of the run and `testErrors` --
  three thousand assertions later, and about nothing to do with drawing -- failed
  with `an uncaught error reaches the application: expected 1, got 0`. Assigning
  `Application.OnError` means no dialog, and the message becomes assertable
  besides; put it back to `null` afterwards.
- **An emit the scanner cannot see is an event that stops being checked.**
  `tests/api.sh` finds events by matching `bta_emit(...)` and its arity in the C;
  adding the `bta_emit_ok` variant and using it for `Draw` dropped the event from
  the count -- 30 to 29 -- and with it the check that `Draw(painter, width,
  height)` is what the documentation says. Nothing failed; the total is the only
  place it showed. **The counts a check prints are part of the check**: read them
  when they move.
- **`Text` and `Painter` agree because the resolution is set, not because they
  share a font map.** `pango_cairo_font_map_get_default()` gives a context at
  Pango's own 96 dpi, and a widget's context carries the desktop's `gtk-xft-dpi`
  -- so on a desktop with text scaling the two measurements of the same string in
  the same font differ, silently, by exactly the scale. It is read on every call
  rather than cached, because the scale can change while the program runs.
  Asserted in `tests/widgets` (`Metrics`) against `Painter.TextWidth` rather than
  believed. **One measurement that does not match: a vector surface.** Hinting is
  off for PDF, so a string can lay out a pixel narrower there than the same
  string on an image surface -- which is a property of the surface, not a bug to
  chase.
- **`gdk_texture_download` writes exactly what cairo wants, and cairo has to be
  told.** The pixels land in `CAIRO_FORMAT_ARGB32` with no conversion, which is
  what makes `Painter.Image` a dozen lines -- but they are written behind cairo's
  back, so without `cairo_surface_mark_dirty` the first paint shows the surface's
  allocation, which is nothing at all.
- **A painter primitive must not put anything in the caller's path.** `Image`
  paints with `cairo_paint()` and not a rectangle and a fill: a fill runs over
  whatever path the handler had already started, and a path survives
  `Push`/`Pop` here by design. The source's own extent is what bounds the ink,
  so `paint` is also the right answer and not only the safe one.
- **The pen's width is `LineWidth`, and `p.Width = 8` is a plain JavaScript
  property that the painter never reads.** It does not throw, it does not warn,
  and the line stays one pixel: `examples/gpx` drew its track "wider" through
  three rounds of screenshots before anybody looked at the property table --
  `painter_props` says `LineWidth`, and every other painter in the tree
  (`lib/charts`, `lib/report`, `lib/markdown`, `examples/drawing`) already
  wrote it that way. **`--strict` would not have caught it either**: a
  `Painter` is not a widget, so it is not in the class table strict checks.
  When a drawing property seems to do nothing, read `painter_props` before
  redrawing.
- **A PDF is written as it is drawn.** `cairo_pdf_surface` streams, so a page
  that throws halfway leaves a file on disk that looks like an export that
  worked; `SavePdf` removes it. Anything that writes progressively wants the
  same treatment -- `File.Save` gets it for free by writing a temporary and
  renaming it over.
- **`gtk_source_init()` has to be called, and nothing says so when it is not.**
  It registers GtkSourceView's GResources, and every part of the library that is a
  plain widget works without it -- view, buffer, highlighting, undo, search. Only
  what is built from a template fails, and the completion popover is the one thing
  that is: it appears once, is never dismissed, is left behind as a stray window,
  and then `gdk_popup_present: assertion 'width > 0' failed` forever. It reads as
  a bug in the completion provider and it is not one (gtksourceview#300, closed
  on exactly this). **And it goes in `on_activate`, not before
  `g_application_run`**: what it does is load CSS against the default display, so
  called before GTK is up it is a silent no-op --- `gdk_display_get_default()`
  answers `(nil)` there. `gtk_source_finalize()` runs on the way out, or the
  library's static data is what `tests/asan.sh` reports as ours.
- **A flag surviving is not the effect happening, and a test that asserts the
  flag passes while the feature is dead.** `TableView.Sortable` read back `true`
  and the headers did nothing: a `.form` applies properties in the order the file
  lists them, which is alphabetical, so `Sortable` was set when there were no
  columns and `Columns` then rebuilt them with no sorter. The assertion
  *"re-declaring the columns keeps them sortable"* checked
  `t.Sortable === true` -- the flag -- and stayed green for the whole life of the
  bug. Two rules fall out of it:
  **assert the effect, not the state that was supposed to cause it**; and where
  the effect needs a pointer GTK will not let you fake, add the API that performs
  it (`SortColumn` is the header clicked from code) rather than settling for the
  flag. Reverting the fix and watching the new test go red is how you know it was
  ever a test.
- **Property order in a `.form` is the file's order, which is alphabetical**, so
  a property that configures what another property *creates* will usually be
  applied first. Apply it where the thing is made -- `table_build_columns` sets
  the sorter on every column it builds -- and keep the setter's loop for the
  other order. Both orders happen, so neither may be the one that breaks.
- **A run that produces no criticals has not passed if the feature never ran.**
  The completion bug "did not reproduce" under Xvfb for a day, and the reason was
  that without the resources there is no popover to present and therefore no
  assertion to fail. A negative result is evidence only once the positive one has
  been seen at least once -- assert that the thing *happened*, not that nothing
  complained.
- **A popover built on a widget that is in no window works exactly once.**
  `gtk_source_view_get_completion()` builds the completion object and its popover
  on the spot, so `ed.Completion = true` before `container.Add(ed)` gave it a
  surface with no size: one bad render
  (`Trying to snapshot GtkGizmo without a current allocation`) and then
  `gdk_popup_present: assertion 'width > 0' failed` on every attempt after. A
  `.form` never hits it -- the loader parents before applying properties -- and
  ordinary code does, because build-then-add is the natural order. Anything that
  needs a window is attached on `realize`, not in the setter.
- **`Locale.Text(SOME_CONST)` extracts nothing**, and it looks exactly like doing
  it right. The extractor collects a *literal* heading the call, so a constant
  defeats it as thoroughly as a template literal does -- and a `const` is
  evaluated once at load while the catalogue is chosen per run. `RECENT_EMPTY`
  was that for months: a bare literal in a module constant, and "(none yet)" was
  in no catalogue. Put the literal at the call site.
- **Widget-set-wide answers belong in the runtime, not in a list in the IDE.**
  `TextProperties()` and `Widget.Types()` both exist because the extractor needed
  them and a hand-written list of prose-bearing property names in `ide/` would drift
  from the widget table the first time a control was added. Both are ordinary
  published API, which is the one rule working as intended.
- **A new method on `Widget` goes against every subclass's property names, not just
  `bta_widget_base_props`.** `Fill()` is called `Fill` and not `Format` because
  `Format` is already a `DatePicker` property -- and a method that shadows a
  property works until a `.form` assigns it, which puts an own value on the instance
  and makes the method vanish. That is the `TreeView.Expand`/`ExpandNode` trap, and
  it costs nothing to check first.
- **A `GtkText` claims the key press and lets the key release through**, so
  `KeyPress` and `KeyRelease` are not two views of the same keystroke. Bubble
  phase gives the focused widget first refusal, and for a printable key on a
  `TextBox` the press *is* the typing, so it is claimed; the release is of no use
  to the entry and arrives. Measured: `b` -> release only; `F5` and `Escape` ->
  both. Do not "fix" the missing press, and do not pair the two halves of a key on
  anything that edits text.
- **A window has no `size-allocate`, and the obvious substitute reports the size
  it had a moment ago.** `notify::default-width` fires when GTK updates the size
  the window would *remember*, before it has been laid out at the new one -- so
  `Resize` carried the previous size on every drag and dropped the first one
  entirely, the allocation being 0x0 while the window is coming up. Nothing said
  so: the event arrived, with plausible numbers, one size behind. `Resize` rides
  `GdkSurface::layout` now -- what `GtkWindow` itself allocates on -- connected
  from the form's `realize` so ours runs after GTK's and the allocation is done
  by the time the event is raised. The pair is still packed into `(w<<16)|h` and
  repeats dropped, since `layout` is emitted for relayouts that are not resizes;
  any future geometry event needs the same coalescing.
- **Per widget there is no signal either, and every obvious hook fires too
  early.** `Allocated(box)` -- the first real rectangle, once -- rides the same
  `GdkSurface::layout`, because the alternatives were measured and are all
  either too early or too expensive: `GtkWidget` has **no `width`/`height`
  property** (`g_object_class_find_property(class, "width")` is NULL and
  `notify::width` never fires -- GTK4's allocation is read with
  `gtk_widget_get_width`, and there is no `size-allocate` to hook); `realize`
  and `map` both arrive with the allocation still 0x0, which is the too-early
  moment `Form_Open` already has; and a tick callback works but is a poll that
  **keeps the frame clock running** -- 33 frames in 700 ms measured, which a
  hidden page can hold forever. The event fires **once per widget**, and a
  control already on screen has missed it, so the shape is check `Bounds()`
  first and listen otherwise; a control on a hidden page hears it when the page
  is shown. The hook is armed at `bta_widget_bind` (the named handler, asked of
  the form) and in `w_on` (the `On` half), and it holds no `JSValue` and no
  job -- disconnecting its own handler and dropping the watch is the whole
  cleanup, so it is not a tenth async job shape.
  **And the hook is two handlers on one surface, told apart by function *and*
  data, which cost three rounds of red tests to get right.** A form's `Resize`
  rides the same `GdkSurface::layout` with the same `BtaWidget` as its
  `Allocated`; and every control of a window shares that surface. So:
  connecting guarded by *data* found the form's own `Resize` and never connected
  `Allocated` at all; guarded by *function alone* found the next widget's
  handler and only the first control to realize ever heard one; and the cleanup
  that goes by data (`bta_widget_forget`, right when a whole surface is being
  replaced) unhooked the form's `Resize` along with it, so a window reported its
  first rectangle and went deaf to its own size. `tests/widgets`'s `Allocated`
  and `WindowState` hold all three: a form hears `Allocated` **and** still hears
  `Resize` after it, and two controls on one window both hear theirs.
- **A name freed by deleting a control is not free: the code still answers for
  it.** Deleting leaves the handlers in the `.js` on purpose, and `uniqueName`
  counted up over the live controls only -- so `Button1` deleted and a button
  drawn came back as `Button1` and inherited `Button1_Click` without a word. Both
  halves are defensible alone and are a silent capture together, which is the
  shape to look for: ask what *else* holds the name before handing it out. The
  check is the file and not a counter, because a counter forgets overnight and
  the file does not.
- **And an assertion about the output pane can pass on somebody else's line.**
  The test for the warning above searched the whole scrollback for the handler's
  name -- which `openHandler` had already logged, two steps earlier, naming the
  same method and the same file. It stayed green with the fix reverted. Take the
  length of `LogView.Text` before the gesture and search only what came after,
  and key on a phrase only the new message uses.
- **A completion handler is asked about the word, and `before` stops where the
  word starts.** Both halves were guessed wrong the first time. `_` is a word
  character, so a handler being written arrives *as the word* (`Ok_`, then
  `Ok_Cl`) with `before` holding only the indentation -- code that looked for
  `Ok_` to the left of the word answered for exactly one keystroke and then
  stopped. And after a dot the word is what has been typed since (`Te`), so a
  handler keying off `before` alone keeps working while one keys off the cursor
  position does not. Measured through `ShowCompletion` and pinned in
  `tests/widgets`; do not invent these arguments in a test, which is how the
  broken case passed one.
- **The selection chrome is drawn from an allocation, so selecting something
  just created draws nothing.** The outline reads `Bounds()`; the status bar and
  the property grid read the selection itself -- so a control that GTK has not
  laid out yet is *named* as selected and not *shown* as selected, which reads
  as the selection having failed. `Chrome.position()` used to re-draw once after
  30 ms, which is the counting-frames mistake wearing a hat: it happened to be
  enough for the palette, whose click is followed by a layout pass, and was not
  for a paste, whose control arrives in a clipboard callback. It asks again
  until the selection has a size now, bounded, because a control genuinely can
  be 0x0 -- a page nobody is looking at has no allocation and never will while
  it is hidden.
- **A test that waits must be counted, or it does not fail -- it goes quiet.**
  `tests/widgets`' `until` pushes its failure when it gives up, two seconds
  later, and the run had already reported: the assertions inside it never ran and
  the total was six lower than the day before with nothing red to say why. That is
  how the `Resize` bug above survived having a test written for it. `until` now
  counts what is outstanding and `finish()` refuses to report while anything is,
  so a condition that never comes true is a red line and not a smaller number.
- **`Maximized` and `FullScreen` read `false` on a form that was never shown, and
  that is correct.** They are states of a window, not requests remembered like
  `Modal`: GTK answers about the window that exists. A test asserting `Maximized`
  right after setting it fails for that reason and not because the property is
  broken -- assert after `Show()` and an `until(...)`, and expect nothing at all
  from `Minimize()`, which has no reader.
- **`Resizable: false` does not pin a window's size.** It removes the user's grip;
  the contents still drive the geometry, so a translated caption longer than the
  box it was drawn in opens the window wider anyway -- measured at 930 px on a
  `ConfirmForm` declared 400. Which is the behaviour to keep (the translation trap
  three entries down is *why*), but it means this is not the tool for a layout that
  must not move.
- **Driving the IDE by hand: the click that focuses the window is eaten, and it
  looks exactly like a broken feature.** Selecting a form in the file tree appeared
  to stop opening the designer after a change here -- the tree row highlighted and
  nothing else happened -- and the conclusion "the change broke it" survived two
  more screenshots. It was the focus. `probe.sh shot` activates, but a *sequence* of
  `xdotool` clicks with sleeps between them can still start out unfocused; activate
  immediately before the click that matters, and when a feature looks broken by hand
  while the suite is green, suspect the input before the code.
- A `GtkCalendar` has no whole-date setter below GTK 4.20 (`select_day` is
  deprecated in favour of a `set_date` that raises the floor), so `DatePicker`
  sets year, month and day — day to 1 first, or standing on the 31st and moving to
  February clamps on the way through — with the handler blocked for the three so
  one assignment is one `Change`. **The three setters are 4.14, not "old"**, and
  the floor this tree declares is 4.10: `gtk_calendar_set_day`/`_month`/`_year`
  and `gtk_css_provider_load_from_string` (4.12, the appearance sheet) were the
  only four calls above the floor, and each has a `GTK_CHECK_VERSION` guard now
  falling back to `select_day` and `load_from_data`. CI runs GTK 4.14, so no run
  here could ever have said so; the check is `GDK_AVAILABLE_IN_*` in the header,
  which is the same rule the `GDK_ACTION_NONE` note above states.
  **And a signal is not a call, so that scan did not see it**:
  `GtkSpinButton::activate` is **4.14**, and on 4.10–4.13 the `g_signal_connect`
  was a critical at startup and `SpinBox`'s `Activate` an event that never
  fired -- nothing compiles differently. It is guarded now, with a key
  controller for the older GTK. A signal's `version` is in the GIR
  (`/usr/share/gir-1.0/Gtk-4.0.gir`) or the docs, and a property's is too;
  check both, not only the functions.
- **A leading comment can make a valid SVG unreadable.** gdk-pixbuf decides a
  file is SVG by looking for `<svg` in its first bytes, so a header comment long
  enough to push the element past that window loads as *"Unrecognized image file
  format"* with nothing wrong in the file. `tools/bintana-ide.svg` keeps one line
  above the element and everything else inside it. The renderer under it is
  glycin now, which is also the one that ignores `transform` (see the icon note
  above) and which rejects `--` inside a comment where a browser would not.
- **In a console project, an asynchronous `Exec` says nothing while you poll
  with `Exec.Wait`.** Line and exit callbacks arrive on the default main
  context, and `Exec.Wait` iterates a private one — so a `for` loop that waits
  by blocking never gives the loop a turn, and the handle's `Running` stays
  `true` and its output stays empty however badly the child failed.
  `tests/install` was written that way first: two of its assertions could not
  fail, and an IDE that exited instantly was reported as running and silent. The
  shape that works is `tests/runner`'s — start the child, return, and let a
  `Timer` (or the exit callback) carry the rest.
- **`static get Fields()` on a `Record` declared nothing, in silence.** A
  getter's descriptor has no `value`, so `#fieldsOf`'s merge loop ran over
  `undefined` and the class came out with no fields at all -- no accessors, no
  checks, an empty `Serialize`, and nothing said so. It matters because a getter
  is the *tempting* way to write a shape that contains itself: it defers the
  class body's own name until it is bound. It is refused out loud now, and the
  way to write recursion is the thunk -- `Children: Field.List(() => Node)`,
  since inside a class body `Field.List(Node)` is a `ReferenceError`.
- **A nested record's `def` is constructed inside `freshDefault`, which is why
  the declaration check had to stop asking for it twice.** `#fieldsOf` validated
  a field's starting value in a `try` and then built the error message with a
  second `freshDefault(field)` call -- fine while a default was a copy of a
  scalar, and a throw *inside the catch* once a record field builds its seed
  there. The wrapping was carried away and the raw message came out with no
  class and no field in it: `Street: expected text, got number` for a
  `Field.Record(Address, { def: { Street: 5 } })` declared three classes away.
  Compute it once, name it, and let the catch report what it has.
- **A record field starts at `null`, and the two alternatives are both worse in
  ways that are not obvious.** An empty *instance* cannot be the default: the
  constructor and the declaration check would both build one, so a shape that
  contains itself never finishes -- and `sameValue` falls to identity on records,
  so an untouched child would be written to the file on every save. A *lazy*
  getter that builds on first read looks like it solves both (the serialiser
  reads `#d` directly, so it never fires), and it fails on the question that
  matters: `if (item.Submenu)` becomes always true, so nothing can ask whether a
  node has children -- which is *the* question in a menu and in a `.form`. And
  reading would mutate the record, in a class whose whole promise is that the
  setter is the only way in.
- **`Serialize` used to hand a list of decimals out as decimal objects.** It
  copied a list with `slice()`, so only lists of plain values survived the trip;
  a `Field.List(Field.Decimal())` serialised to `[{}, {}]` through
  `JSON.stringify`. It goes element by element now, through the same conversion a
  single value gets. Nothing in the tree had such a field, which is why nothing
  had failed.
- **`Load` *loads* a child and does not assign it, and the difference is the
  whole point of `Load`.** Assigning goes through the child's setters and stops
  at its first bad member, so one bad price would cost the rest of that line --
  in a method that exists so one bad key does not cost the other twenty. The
  same rule one level down: `Field.Record` and a list of them are loaded
  leniently, and a child keeps its own complaint. `Problems` reaches it through a
  private static, because `#p` is class-scoped -- which is also the reason this
  mapping can never live in `lib/`: nothing outside `Record` can see it.
- **`Problems` is the report of one `Load`, and `Validate()` is the state. It
  used to be `Problems` = both, and that was a bug rather than noise.** The
  duplication was the visible symptom -- `Plain.Load({ Name: "" })` answered
  `["Name is required -- left at \"\"", "Name is required"]`, one problem in two
  sentences, multiplied by nesting into two hundred for a hundred bad rows. The
  actual defect is that **nothing clears the file's half**: not assigning to the
  field, not saving, not saving successfully. Measured -- load a client whose
  file has no name, type the name into the form, and `Validate()` is empty while
  `Problems` still says `Name is required`. A Save button wired to `Problems`
  therefore **refuses to save a record the user has already fixed**, and marks a
  field that has a name in it.
  So they are separate now, and the two halves are genuinely different
  questions: the file's half is the only thing that knows a value was *thrown
  away* (a `-500` refused by `min: 0` leaves a valid `0.00`, so `Validate()` says
  nothing and the next save writes over what the file had). A caller that wants
  both says `rec.Problems.concat(rec.Validate())` -- which is what the two places
  reporting on *opening a file* do, and what `Manifest.report()` in the IDE has
  to do, since `ProjectFile.Validate()` is where "declare a startup or a main"
  lives and no single field is wrong when neither is there.
- **A static field that names a class is a load-order dependency, and it does not
  look like one.** `sources` in `project.json` was documented as mattering "only
  when one class extends another of the same project", and that was one case of
  two: `Lines: Field.List(Line)` in a `Record` runs while `Quote` is being
  declared, so a `Quote.js` listed before `Line`'s file fails with
  `ReferenceError: Line is not defined` — traceback on the declaration, nothing
  anywhere near `sources`. Measured both ways: wrong order throws, and
  `Field.List(() => Line)` in the same wrong order works, because a thunk is not
  looked at until the first value goes through the field. So the thunk is not
  only for a shape that contains itself; it is the escape from file order too.
  `examples/quote` keeps the order instead (`Quote.js` before `QuoteForm.js`,
  `Line` before `Quote` inside it), on the grounds that a dependency written down
  beats one deferred.
- **`key in bag` asks the prototype, and the curation did not take
  `Object.prototype` away.** Every plain object still inherits `toString`,
  `constructor`, `valueOf` and `hasOwnProperty`, so `Settings.Has("toString")`
  answered **true**, `Settings.Get("toString")` answered a **function** for a
  name nothing ever set, and `Record.Load` silently **dropped** an unknown key
  called `toString` or `constructor` -- breaking the documented promise that a
  key the record does not describe survives the round trip, which exists so an
  older program cannot delete a newer one's field by saving the file. A declared
  field whose file key is inherited read the inherited function and complained
  about a key nobody wrote.
  **`for...in` is not the trap** and never was: `Object.prototype`'s members are
  non-enumerable and are never recited. The trap is `in`, and a plain `bag[key]`
  read used as a boolean -- `taken["toString"]` is a function, which is truthy.
  `Dictionary` had it right from the start (`hasOwn.call`, `rad.js:403`) with
  the reasoning written above it; `Settings` and `Record` are the two that did
  not reach for it, and `Settings` disagreed with itself -- `Keys()` used the
  captured `ownKeys` while `Has` and `Get` beside it used `in`. **Own keys or
  the prototype answers: `hasOwn.call(bag, key)`, never `key in bag`.**
  `rad.js` itself had three more, found last: `regexFlags` accepted
  `new Regex("x", { constructor: true })` because `"constructor" in REGEX_FLAGS`
  is true and then appended the inherited *function* to the flags string, so the
  refusal came out as a syntax error about garbage; and `Table.Insert`/`Save`
  asked `k.Column in decided` about a serialised row. **A bag of own values is
  never asked with `in`** -- the class that had it right from the start is the
  one to copy.
- **`g_object_ref(NULL)` is a critical and carries on, which is how a wrong
  branch stays invisible.** `Split.Reorder` ref'd both halves before unparenting
  them, and a split with **one** half is ordinary -- it is what one looks like
  after the first child is dropped, and reordering the remaining half is
  documented API. The reorder itself came out right, so nothing looked broken;
  the price was two `GLib-GObject-CRITICAL`s that the runner prints and does not
  count (`tests/runner/Main.js`'s `NOISE` filters warnings only, and no script
  sets `G_DEBUG=fatal-criticals`), and an abort for anyone who does set it.
  **A green run is not a quiet one — read the output when you touch ref counts.**
- **`JS_ToCString` throws, and a `NULL` you turned into `"?"` is an exception you
  left on the context.** `print({ toString: null })` and `Logger.Info` of the
  same value both wrote `"?"` and walked away, so the failure surfaced later as
  whoever asked next appearing to have thrown. Handling a conversion failure
  means consuming it: `if (!s) JS_FreeValue(ctx, JS_GetException(ctx));`.
  `bta_debug.c:350-355` is the other shape, for when there is a pending
  exception to *preserve* across the work rather than discard.
- **A refusal a C function returns and nothing reads is a feature that quietly
  is not there.** Two of these, both fixed and both worth recognising by shape:
  `JS_DeleteProperty`'s boolean was dropped in `bta_close_hatches`, so an engine
  that made one of those names non-configurable would leave the hatch open with
  nothing said; and `exec_control_fd` returned `-1` for a `pipe()` that failed,
  which is the same `-1` that means *no Control was asked for*, so descriptor
  exhaustion lost the debugger's channel in silence while Windows answered the
  same situation with a real exception. **When a helper's sentinel already means
  "nothing to do", a failure needs a different one.**
- **A verb that takes a path takes a string, and the conversion was the bug.**
  `JS_ToCString` converts anything, so `File.Save(undefined, t)` wrote
  `./undefined`, `File.Delete(undefined)` deleted it, and `File.Save(p, rec)`
  without the `Serialize()` replaced the file with `[object Object]` -- all
  atomically and all silent. `bta_file_path` in `bta_sys.c` is the one door the
  file verbs go through now, and `Save`'s text is checked as text. **"The file
  verbs" was half of them until an audit counted**: the fix went through the
  verbs that write a file and left the rest on `JS_ToCString`, so
  `Directory.Make(cfg.Dir)` with the key missing made a folder called
  `undefined`, `Directory.DeleteTree({})` would remove `./[object Object]`,
  and `Database.Sqlite`, `DrawingArea.Save`/`SavePdf` and `Printer.ToFile`
  created files by that name. Every one of them is on the door now (it is
  exported for the three outside `bta_sys.c`). `Exists`/`IsDir` are the one
  deliberate difference: a question about something that is not a path answers
  `false`, which is what it always answered a missing file. The path-part verbs
  (`File.Name`, `Extension`, `Directory`) still convert -- they never touch the
  disk. The other
  half is the loops: `Exec`'s `Environment`, the client's and `Answer`'s
  `Headers` and the `Query` builder each skipped an entry whose conversion
  failed and left the exception pending, so the child started without the
  variable, the header was not sent, and the error landed on whatever called
  into JS next. **A conversion failure is a refusal from the verb**, not a
  skipped entry; a `Query` value of `undefined`/`null` is not sent; and
  `first` moves only when an entry really went in. The same sweep reached
  `Locale.Text`'s arguments, a list's `Items`, `Add` **with no argument at all**
  (QuickJS pads `argv` to the declared arity, so it appended the text
  "undefined"), a dynamic menu's labels and a switcher's tabs -- and each
  converts everything **before** it touches what it is filling, so a refusal
  leaves the list, the menu or the tab strip exactly as it was. That is the
  `AddNode` rule applied to a conversion: *a value the runtime refuses throws
  with the subtree already half built* is a worse refusal than none.
- **An empty `JS_EXCEPTION` is not a refusal, and in some builds it is a
  crash.** Fifteen methods -- the list and table `Select`/`Deselect`, `Remove`,
  `PickAt`/`ContainerAt`/`LocalPoint`, the editor's `OffsetAt`/`LineOf`/
  `GotoLine`/`Select`/`Mark`/`Unmark`, and `Painter.TextWidth`/`TextHeight` --
  wrote `if (argc < N || JS_ToInt32(...)) return JS_EXCEPTION;`, and the
  short-circuit meant no exception was ever set for a missing argument:
  `lb.Remove()` threw an object with `typeof e === "unknown"` and `e.message
  === undefined`, and a bare C probe against the vendored engine segfaults on
  the uninitialized value. The argc test and the conversion are separate now,
  and the first throws a `TypeError` naming the signature. **QuickJS pads
  `argv` to the declared arity**, so a function that reads `argv[0]` without an
  `argc` check is reading `undefined` -- `TextWidth()` measured the string
  `"undefined"`, which is the `db.Query()` trap one layer down.
- **A NaN in a painter is worse than a refusal.** `arg_num` took whatever
  `JS_ToFloat64` gave it, so `p.LineTo("abc", 5)` recorded a NaN: cairo puts
  the context in an error state and **the rest of the frame draws nothing**,
  with no throw and nothing to see. It refuses non-finite values now, naming
  the call (`LineTo: NaN is not a finite number`) -- and that immediately found
  a test calling `p.Text(10, 20, "sheet")`, text and coordinates the other way
  round, which had been drawing the number 10 at a NaN y for as long as it had
  been there. **The whole frame is the unit of damage**, which is why the check
  belongs at the argument.
- **`bta_to_int` had no range check, and `(int32_t)1e12` is undefined in C.**
  It answered INT32_MIN on this machine, which is a number nobody typed. The
  helper refuses past the range now -- `Columns.Width` was read with a bare
  `JS_ToInt32` and took `"wide"` for `0`, and the two are one rule.
- **`Stop` from inside a handler waits for the handler.** `Answer` fills the
  message in; soup sends it when the handler returns. Disconnecting during the
  dispatch -- `req.Answer(200, "bye"); srv.Stop();`, which is every `/shutdown`
  endpoint -- answered the client with a closed connection. The disconnect is
  an idle now, `Running` stays true until it runs (the port is still held,
  which is the truth about the socket), and the counter is **global** because
  it is decremented after a call that may have freed the server it belongs to.
  **And the finaliser is the second door to the same disconnect.** A handler
  that lets go of the last reference (`srv = null` after the `Answer`) has the
  server finalised inside the dispatch, and `http_server_free` disconnected at
  once -- the same closed connection, and the fix in `Stop` could not see it.
  The finaliser hands the `SoupServer` and its gate to an idle when
  `http_dispatching > 0` (`HttpLateStop`); the struct itself goes at once,
  since nothing after the call reads it. `testHttpServerDropped` is red without
  it. The rule: **a deferral written into a verb is owed by every other road to
  the same effect**, and a finaliser is always one of them.
- **A clipboard read and a file dialog are jobs with a pending operation, and
  teardown has to cancel them.** Both passed a NULL `GCancellable` and were
  freed at cleanup with the operation still armed -- the `ExecJob` crash's
  shape, harmless only because nothing dispatches after teardown. Each job has
  its own cancellable now, cancelled at teardown, and the completion asks
  membership of the list before touching the job: **the pointer is compared,
  never read**. `on_paste`'s comment claimed this while the cancellable was
  NULL, so the branch it described could not happen. The same cleanup leaked
  its own reference on the server's auth domain, which `http_server_free`
  always released.
- **A subclass method that shadows a base one is a verb the base loses, and
  `api.sh` cannot see it.** Six controls -- `ListBox`, `RowList`, `TreeView`,
  `TableView`, `Notebook`, `Switcher` -- answered `Remove(index)`/`Remove(key)`
  while every control's own `Remove()` detaches it from its parent, so a
  `ListBox` could not be taken out of its container by the documented verb, and
  `Remove(key)` and `Remove()` read as one thing. It is the `Expand`/`ExpandNode`
  trap again, and the check was blind for the same reason: the `Remove` row under
  `Widget` in `controls.md` "covered" the six, because `api.sh` asks whether a
  name is documented *somewhere* and not under its own class. The item verbs are
  `RemoveRow`/`RemovePage`/`RemoveNode` now -- one word per meaning, each naming
  its address -- and `Remove()` detaches on all six, which `Removal` asserts.
  **When a subclass needs a member the base already has, the subclass member is
  the one that gets a new name**; check the base table before naming it
  (`grep -n 'JS_C\(GETSET\|FUNC\)' runtime/src/bta_widget.c`). `tests/api`
  checks it now, and is deliberately no wider than the mechanical half: a
  property answered by a method (or the reverse), or two methods declaring a
  different number of parameters, fail the check. A property over a property is
  legitimate -- `Split.Arrangement` narrows its `Fixed` slot on purpose -- and so
  is an override with the same signature (`Form.Show` over `Widget.Show`), which
  is what the five pairs it found are.
- **`git status --porcelain=v1 -z` spells a rename `R  new\0old\0`**, and the
  IDE read it the other way round: the new file was marked `[D]` and the old
  one was the row offered to open, so a renamed file could not be clicked and
  the tree marked the wrong half. Measured with a real `git mv`; `filesIn`
  (`show --name-status -z`, `R100\0old\0new\0`) was already right -- the two
  commands order the pair differently, which is why the wrong one survived.
- **A `GtkColumnView`'s heading is the one surface of a widget here that raises
  no pointer event, and GTK is why.** Its title gesture claims the press
  (`click_pressed_cb` in `gtkcolumnviewtitle.c`) before the bubble phase runs,
  so the `MouseDown` a control reports never arrives on a heading -- measured,
  and the reason `TableView.HeaderClick(column, button, ctrl, shift)` exists.
  The runtime's own gesture is in the **capture** phase (which runs first) and
  **does not claim**, because claiming is what would stop GTK from sorting on
  the primary release and from presenting the column's `header-menu` model on
  the secondary one -- the model is installed at the press, GTK shows it at the
  release. Two facts of GTK's own structure are load-bearing and commented
  where they are read: the heading row is the view's **first child** and its
  titles are children **in column order** (hidden columns are not children), so
  a child's index is the column's -- checked in 4.10 and 4.22, no public
  accessor for either, and `Columns[i].Visible` would invalidate the walk.
  **And the menu is built for each click**, because an item has to know which
  column it was opened over: the wrappers on the form are replaced with it, so
  `this.MnuHide.Enabled = false` set from code does not survive the next right
  click. Context belongs in the event's answer (`{ enabled: … }`), which is the
  same rule `Sort` already states for sorting.

## Xml and Record

**XML is a document and JSON is a value**, and everything else follows from it:
`Xml` is a DOM over libxml2 (optional at build time, `Xml.Available`), and a
record maps onto an element by **declaring** `static Xml` -- the same split
`Table` makes for a row. `ToXml` is `Serialize`, `LoadXml` is `Load`, and
`SaveXml` is neither: it writes into the element it was handed and touches only
what the shape models, which is what an interchange round trip needs. Unknown
elements and attributes are reported in `Problems` and never silently written
back -- an unknown node re-emitted at the end of an `xsd:sequence` is a wrong
answer that looks right, so the lossless road is `SaveXml` and not a raw-node
bag. Five things are worth knowing before touching either half:

- **A `key` is identity and is written whatever it holds, so an XML key at its
  default still matches.** `#xmlKeyText` used to answer `null` for a key equal
  to the field's default -- `Table`'s *an int key of 0 is a row never saved*,
  borrowed into a medium with no INSERT -- and the summary task of every MSPDI
  file (`<UID>0</UID>`) was replaced by a fresh element, taking its unmodelled
  children (`CreateDate`, `ActualStart`) and the `UID` element itself with it.
  Matching compares key text always and both verbs write a scalar `key` even at
  its default -- `#xmlKeyed`, asked by `#xmlWrite` and `#xmlSave`, because two
  answers to *is this a key* is the asymmetry that is found later as a bug --
  while every *other* field back at its start still has its element removed.
  Nothing failed because no test had a key at a default -- `XmlRecord`'s were 1,
  2 and 3 -- and the regression now puts `UID 0` beside a `Milestone: false` and
  asserts `ToXml()` writes it too, so the non-key half of the rule is held.
  `Table` keeps its rule: the two media do not share it.
- **A node from another tree is copied in, and `Add` answers the copy.** So
  `el.Add(Xml.Element("X")).Text = "…"` is right, and writing to the element you
  built is writing to a node that is not in the tree -- `Record`'s
  `#xmlInsert` did exactly that, and the round trip showed empty elements. The
  same rule is why `Record.#xmlSaveList` writes a new item *after* it is placed.
- **A removed node is orphaned and not freed**, because a `Children` array
  somebody is holding has to keep answering; the tree's refcount frees it when
  the last wrapper goes. That is why `Remove()` makes the wrapper throw instead
  of reading freed memory, and why a node wrapper is a reference to a tree and
  not to a document.
  **And wrappers are not unique, so the orphan list is kept by the node.** Two
  `Find`s of one element are two wrappers, and `Remove()` silences only its
  own: the second one's `Remove()` put the node on the list twice, and a child
  kept across a `Text` assignment could be `Add`ed back while still on it --
  both a **double free at teardown**, with every assertion green, because the
  free happens when the tree dies and not when the mistake is made. Measured:
  the regression in `testXmlFiles` reported `attempting double-free` under
  `build-asan/` before the fix and is clean after it. `xml_orphan` and
  `xml_adopt` are the only two doors now -- on the list at most once, and only
  while parentless -- and a same-tree move of a detached tree's root (which can
  only land under one of its own orphans) clears `tree->root` as `Remove()`
  does. **A new verb that detaches or re-parents a node goes through those
  two**, and `tests/asan.sh` is the only thing that will say it did not.
- **A list with no `in` lives in the record's own element, so "append" is the
  wrong default for a new item.** `#xmlPlace` used to `Add` an item past the
  last one there, which put it after every later field and every unmodelled
  element -- `<Line/><Total/><Line/>`, which an `xsd:sequence` refuses. The
  MSPDI tests could not see it because every list there is `in: "Tasks"`. It
  goes after the last item of its name now, and with none there, where
  `#xmlSlot` (the same answer `#xmlInsert` gives a scalar) puts it.
- **`xmlNewNs` answers NULL for a prefix the element already declares, and says
  nothing.** `SetNamespace` returned `JS_EXCEPTION` with no exception set --
  twice on one `Xml.Element` (no document, so the search was skipped), or a new
  URI on a parsed root with a default `xmlns`. It reads the element's own
  `nsDef` first now: the same URI is reused, another is refused naming the one
  there.
- **`xmlHasNsProp` answers a DTD's default too, and what it hands back then is
  not an attribute.** It looks the name up with `xmlCheckDTD` on, and for an
  attribute the element does not carry but the DTD declares a default for, it
  returns the DTD's `xmlAttribute` *declaration* cast to `xmlAttrPtr`.
  `xmlRemoveProp` then walks that thing's "parent" -- the `xmlDtd` -- as if it
  were an element: `RemoveAttrNS` on `<!ATTLIST r xml:lang CDATA "en">` was a
  segfault (exit 139), and not under the sanitizer build, whose layout
  differed. The type is checked (`XML_ATTRIBUTE_NODE`) before removing; a
  default is not on the element to take out. `RemoveAttr` never had it because
  `xmlUnsetProp` does not consult the DTD. Any new call that answers an
  `xmlAttrPtr` from a lookup wants the same check. And `SetAttrNS` returned an
  empty `JS_EXCEPTION` when libxml2 answered NULL; it throws a sentence now.
- **`Field.DateTime` exists because XML's `dateTime` is a date and a time**
  together, which `Date` and `Time` cannot say between them; and the namespace
  on `static Xml` is a **list** because MSPDI's own XSD and its own files
  disagree about the URI (the schema says `/2007`, Project writes without it),
  measured. The first is written, all are accepted on read.
- **The object `LoadXml` builds is keyed by the file's spelling, not by the
  property name** -- `Load` looks a field up by `as`/`Naming`, exactly as it
  does for a JSON file. MSPDI spells every property the same as its element and
  hid this; the first format that says `Naming = "lower"` (`examples/feeds`,
  where RSS hands over `<pubDate>`) found **every field silently at its
  default**. A shape with a naming rule or an `as` needs a test that reads one.

`examples/feeds` is the first real caller: two shapes (RSS 2.0 and Atom 1.0)
over one list, and the four format facts worth knowing -- RSS dates are RFC 822
and stay `Field.Text`, Atom's are ISO and keep their zone, an element's own
text cannot be modelled beside its attributes (`<guid isPermaLink>`), and
`<link>` versus `<atom:link>` is one local name from here.

## Database.Sqlite and Table

- **SQL identifiers are case-insensitive, and that makes a `Naming` rule that is
  nearly right the worst kind of bug.** A record whose column comes out `Code`
  against a table column `code` *writes perfectly* -- sqlite accepts `"Code"` as
  naming the same column -- and *reads empty*: `Record.Load` matches a file's
  keys exactly, so `code` is a key the shape does not describe, goes into the
  unknown-keys bag, is faithfully kept and handed back on the next save. The
  record comes out at every default with the real values hidden inside it,
  nothing throws, and the first thing anybody notices is a form full of blanks.
  Found within minutes of writing the first `Table`, in a test class that had no
  `Naming` line. `Table.#fit` compares the shape against `Columns()` on the first
  statement and refuses; it catches a missing column and an absent table on the
  way.
- **`#fit` runs before the structural check, so the order of the two matters.**
  A shape with a `Field.List` pointed at its master's table reported *"wants a
  column 'lines'"* -- true, and a red herring: the real answer is that a detail
  is a table of its own and is not built. Shape-only facts are checked first, and
  the shape-versus-table comparison second.
- **`Table` lives in `rad.js` and cannot move.** Not only for
  `docs/extending.md`'s *"prefer JS"* rule: a record's values are in a private
  bag scoped to `Record`, so nothing outside that file can read them. The same
  argument rules out a `lib/data` library, and it is why `#o` (change tracking,
  for a partial UPDATE) will have to be written there too.
- **A row is a file, and it is not a coincidence.** `Load` reads an object keyed
  by whatever `Naming` spells and `Serialize` writes one with decimals as text,
  so `Table` converts nothing. `Naming = "snake"` had no user for as long as it
  existed and needed no change to become the SQL spelling; `Field.Bool` already
  took sqlite's `0`/`1` and `Field.Date` already held `YYYY-MM-DD`. Do not add a
  conversion layer -- if a value needs one, the field kind is what is wrong.
- **The doctrine, and it is Matias': a `Table` uses sqlite's standard types and
  invents no format of its own. What sqlite cannot do is sqlite's limitation and
  is said as one; the program filters and orders; and the extension exists,
  opt-in, always warning that it makes the file incompatible.** This was arrived
  at after two wrong turns, and writing down what they were is cheaper than
  taking them again:
    1. **TEXT with a `COLLATE DECIMAL` in the schema.** Correct for us, and
       measured from another client against a file this runtime had written:
       `ORDER BY`, `MIN`, `MAX`, a comparison and `CREATE INDEX` on that column
       all fail with `no such collation sequence`. A `.db` only one program can
       query is not a `.db`.
    2. **An `INTEGER` of the field's units.** Portable and native for every
       aggregate -- and an invented storage format, which is what the doctrine
       refuses. It also cost `Serialize` its best property, that a row *is* a
       file.
  So: `Field.Decimal` -> `TEXT`, the program totals and sorts, and if an
  application's core is money then sqlite is a fair thing to call the wrong
  engine.
- **`NUMERIC` and `DECIMAL(12,2)` are affinities, not types.** Measured:
  `'19.90'` into either comes back as the REAL `19.9`. So an ORM that declares a
  `decimal` column in sqlite is storing a double, which is what `Decimal` exists
  to prevent -- worth knowing when comparing this design against Django's or
  Rails'. `Table` refuses a decimal field over any column whose affinity is not
  TEXT, judged by `sqliteAffinity` in rad.js, which is sqlite's own five rules in
  sqlite's own order.
- **The driver binds a `Decimal` as its own exact text, and what the column does
  with that text is affinity -- which the driver cannot see.** Into TEXT it stays
  exact; into a numeric column sqlite converts it to a REAL and the scale is
  gone. Asserted in the suite, because it is the one way it stays known.
- **The reason to distrust `SUM` on a decimal column is not the obvious one.**
  I first wrote *"it goes through a double"* implying lost cents, then measured
  it: **sqlite has Kahan-Babuska-summed REAL since 3.44**, so small totals come
  out exact. That makes `SUM` *worse* to rely on rather than better -- it looks
  right until it is not. The real costs: the answer is a REAL, so the scale is
  gone (`30`, not `30.00`) and it re-enters the program as a double; and past
  2^53 a double cannot tell whole numbers apart, so
  `9007199254740993.00 + 0.01` comes back `9007199254740992`. `AVG` has no exact
  form at all -- three tenners and a cent average to `10.003333333333332`.
- **A collation has to be a consistent *total* order, because sqlite builds
  indexes with it.** The first version of `decimal_collation` copied the two
  values into 64-byte stack buffers and **truncated**, which would make two long
  strings compare equal and an index built on it able to lose rows. It uses the
  stack buffer only when the bytes fit and `g_strndup` when they do not. For the
  same reason text that is not a decimal is *sorted* (after every decimal, by
  `strcmp`) rather than refused: refusing would be refusing to sort a table
  because one row is wrong.
- **`dec_parse` was split so a sqlite callback could use it.** The scanning half
  is `dec_scan`, which throws nothing and returns *how* it failed; `dec_parse`
  adds the complaining. The reason is that a collation runs in the middle of a
  statement, and that is the last place that may leave a JS exception pending --
  there is nobody to hand it to, and the next thing to touch the context would
  report it instead of its own trouble. `bta_decimal_from_text` and
  `bta_decimal_to_text` are the two exports.
- **`Execute` refuses a second statement, and that is load-bearing.** sqlite
  compiles up to the first `;` and hands back the tail; running only the head and
  reporting success is the bug. `Script()` is the multi-statement one and takes
  no parameters, since a script has no values.
- **Parameters are counted before any are bound.** sqlite binds what it is given
  and leaves the rest NULL, so three values into a statement with four `?` runs
  and answers about a NULL -- a *wrong answer* rather than an error.
- **`api.sh` does not check a global's documentation.** `NOT_A_WIDGET` in
  `tests/api/Check.js` exempts a `*_props` table from the `controls.md`
  completeness check and nothing else asks about it, so `llm/library.md` is
  documented by hand. A new global needs its name in that set *and* its members
  written down, and only the first of those two fails a test.
- **The optional-dependency branch has to be compiled to be known to work.**
  `-DSQLITE3_FOUND=OFF` does nothing -- `pkg_check_modules` overwrites it -- so
  the way to check the `#else` half of `bta_sqlite.c` is to compile that one
  translation unit with the define removed, taking the command out of
  `build/compile_commands.json`. It had a `-Wmissing-field-initializers` warning
  that the ordinary build could not see.
- **QuickJS pads `argv` up to the arity the table declares, so a missing argument
  is `undefined` and not a short `argc`.** `db.Query()` reached sqlite as the
  literal statement `undefined` and came back *"no such column: undefined"* -- a
  real complaint about the wrong thing, which is worse than none. Every C
  function that reads `argv[0]` needs an `argc` check even though the signature
  looks like it guarantees one.
- **`Transaction` finishing on a connection the callback closed was a NULL
  dereference.** `Close()` inside a transaction is odd and reachable, and the
  COMMIT afterwards ran `sqlite3_exec` on a freed handle. There is nothing to
  finish in that case -- `sqlite3_close` rolls an open transaction back itself --
  so it is a sentence now. The general shape: any C function that calls back into
  JS has to re-check whatever the callback could have invalidated.
- **`Connection` is a base class with an empty prototype, and the emptiness is
  the design.** `bta_database.c` owns it and the `Database` object; each driver
  (`bta_sqlite.c`) makes its own `JSClassID` and builds its prototype with
  `JS_NewObjectProto(ctx, bta_connection_proto(ctx))`. That one line is what puts
  `rad.js`'s `Table` in the driver's chain and makes `conn instanceof Connection`
  true. Get it wrong -- a prototype built with `JS_NewObject` instead -- and
  `conn.Table` is simply not there, with nothing to say why. The four invariants
  (`instanceof`, `Table` on the base, `Query` *not* on the base, `Database.Sqlite`
  present) are asserted in `tests/widgets`'s `Database`, because each of them is
  the kind of claim that rots in a comment.
- **The language is curated, so the obvious way to check a prototype chain is not
  there.** `Object.getOwnPropertyNames` does not exist (nor most of `Object` --
  see `llm/issues.md`), and a probe written with it fails as a bare
  *"TypeError: not a function"* pointing at the column, which reads like the
  thing under test being broken. Check a chain with `instanceof`, with
  `typeof X.prototype.Member`, and by comparing `obj.Member ===
  Base.prototype.Member`.
- **Every one of sqlite's own aggregates is a window function, and a custom one
  registered with `sqlite3_create_function` is not.** `pragma_function_list` says
  `type='w'` for all 33 built-ins and said `type='a'` for `decimal_sum`, so
  `decimal_sum(p) OVER (ORDER BY id)` answered *"decimal_sum() may not be used as
  a window function"* -- and a running total down a column of amounts is most of
  what a report is. `sqlite3_create_window_function` takes four callbacks instead
  of two: xStep, xFinal, xValue and **xInverse**, which takes a value back *out*
  of the frame. Two consequences for the accumulator: a flag for "something in
  here was not a decimal" had to become a **count**, since a bad value can leave
  the frame again and a flag could never be put back; and because the
  accumulator's scale only ever widens, a running total can be written with more
  places than the rows currently in the frame have.
- **If a program does opt into the collation, the map of what it fixes and what
  it cannot is much smaller than it looks.** Measured on 3.51.2: `min`/`max` are
  correct through the collation; the whole positional family (`rank`,
  `dense_rank`, `row_number`, `ntile`, `cume_dist`, `percent_rank`, `lag`,
  `lead`, `first_value`, `last_value`, `nth_value`) is correct because an `OVER`
  clause's `ORDER BY` uses the column's collation; `count`, `group_concat`,
  `string_agg` and `json_group_array` are fine, and `group_concat(x ORDER BY x)`
  -- the aggregate's own `ORDER BY`, 3.44 and later -- uses the collation too;
  `median` and the `percentile` family **refuse** a text column (*"input to
  median() is not numeric"*), which is a loud failure rather than a wrong answer.
  Exactly three are wrong and quiet: `sum`, `total`, `avg`.
- **`decimal_avg` and `decimal_total` are absent on purpose.** An exact average
  of decimals is not a decimal at all -- 118.25 over three has no text -- so such
  a function would have to round, and how many places is the caller's decision.
  `total()` is only `sum()` answering 0 instead of NULL. Do not add either
  because the pair looks incomplete without them.

## Two widget limits that leak into a shape

- **A `ComboBox` has no empty text and, with items, no empty state.**
  `cmb.Text = ""` throws `'' is not one of <name>'s items`, and `Index = -1`
  **moves nothing**: GTK's autoselect leaves the first row chosen the moment
  `Items` is assigned, and only `Clear()` leaves none. Measured -- `Items` then
  `Index = -1` still reads the first row, and a sample written to show *nothing
  chosen* came up saying *Low*. So a form whose field can be empty gives the
  combo a placeholder row (`Items = ["—", …]`) and selects that when there is
  no record; `Index = -1` is what an *empty* list reads, not a way to empty
  one.
- **A `DatePicker` has no empty state at all.** Its default is today and there is
  no value meaning *no date*, so an **optional `Field.Date` cannot round-trip
  through one**: showing an empty date puts today in the control, and reading it
  back writes today into the record. `examples/clients` declares `Since` as
  `required` for that reason -- a fact about the control, written into the shape.
  Worth knowing before designing anything that writes a record's value into a
  control, and `docs/plans/data-plan.md` records it as one of the three things
  `examples/clients` changed about the binding's design.
- **A throw inside `Form_Open` becomes a dialog and nothing on the terminal, so
  headless it looks like the program worked.** `examples/clients` seeded its
  database with `Object.assign({ ClientId: c.Id }, o)` -- and **most of `Object`
  is not in this language** (`Object.keys`, `Object.assign` and the rest were
  taken away; `Dictionary` replaced them, see `llm/issues.md`). The `TypeError`
  landed in `Form_Open`'s own `try`, went to `Message.Error`, and a twelve-second
  headless run printed *nothing at all* while the application came up with an
  empty table. Two rules out of it: build an object and then assign to it rather
  than reaching for `Object.*`, and when a headless run of an example is silent,
  check what it *wrote* rather than trusting the silence.
- **`ORDER BY` in sqlite compares bytes, so it is not the language's order
  either.** It puts `Ñanculeo` after `Zapata` and `Álvarez` last -- the mistake
  `examples/contacts` was written about, arriving from the database this time
  instead of from `localeCompare`. The doctrine above answers it the same way it
  answers decimals: **the program orders**, with `Locale.Compare`. A `LOCALE`
  collation would be the first wrong turn again, and there is a measurement
  against it beyond portability -- `g_utf8_collate` is ~1,5 us a comparison, so
  100 000 rows is two seconds unless indexed, and an index built on a custom
  collation is exactly what another client cannot read. It stops being an answer
  at stage 3's cursor, where the rows are not all loaded; `docs/plans/data-plan.md`
  carries that as an open question with two candidates.

## Laying out a form: which of the two models

- **`MinWidth` and `MinHeight` do nothing unless the matching axis is `Fill`.**
  It is documented -- *"only means something on an axis whose `HAlign` is
  `Fill`"* -- and it is still the trap, because a floor that is quietly ignored
  looks exactly like a floor that holds until something squeezes. A `Split` whose
  halves had `MinWidth: 280` and no `HAlign` let the divider be dragged to **46
  pixels** by a window resize; with `HAlign: "Fill"` on both halves it stops at
  280. Anywhere a minimum matters, set the alignment in the same breath.
- **A `Split`'s divider does not spring back.** Once a squeeze has moved it, it
  stays where it was left -- `Position` is where it *starts*, not where it
  returns to. `Grows` decides who takes new room, and neither of them undoes a
  drag.
- **A `Button`'s natural size is its label and nothing else** -- 33x24 for
  `"Save"`, in a box and in a `Fixed` alike, and `GTK_THEME=Adwaita` changes
  nothing. A row of buttons laid out by a box therefore wants a declared `Width`
  or it comes out ragged and cramped. That is a *size* and not a *position*,
  which is the distinction worth keeping: a box layout is there to remove the
  coordinates, not every number.
- **And the rule the documentation was missing, now in
  [`docs/widgets.md`](docs/widgets.md#which-of-the-two-models-a-form-should-use):**
  one dense grid of labelled fields is a `Fixed` or a `Grid`; a window with
  *regions* is boxes with a `Fixed` per region. Measured rather than argued --
  `examples/clients` was drawn both ways, and it is 117 numbers (54 of them a
  coordinate) as a `Fixed` against 17 and no coordinates as boxes. The `Fixed`
  version broke on a resize, and the reason generalises: **N controls is N
  independent anchoring decisions, no default is right, and getting one wrong is
  invisible at the size the form was drawn at.**
- **`tests/api.sh` now covers the globals too, and it did not until a whole global
  family had been added without it.** The old `NOT_A_WIDGET` set exempted a
  table from the `controls.md` check and **nothing asked anything else**, so 46
  members of `Locale`, `Decimal`, `Connection`, `Log` and `Day` were documented by
  hand or not at all -- and `Database`/`Connection`/`Table` were written while
  that was true, with nothing that would have failed had the reference been wrong.
  It now checks 85 members against `llm/library.md`, and it found three real gaps
  the day it was written: `Application.LibraryPath` (which the IDE calls) and
  `Decimal`'s `toString`/`toJSON` (which are why `${d}` and `JSON.stringify(d)`
  are exact).
- **A new global needs a line in *two* hand-kept tables, and only one of them
  fails.** `GLOBAL_TABLES` in `tests/api/Check.js` is what makes the reference's
  completeness checkable; `NOT_A_WIDGET` in `tools/typings/TypingsForm.js` is
  what puts the global in `bintana.d.ts`. A table the generator has never heard
  of is simply not generated, so there is nothing stale for the staleness check
  to catch -- `Lock` was documented, counted and asserted while an editor had
  never heard of it, with `api.sh` green and printing *all declared for an
  editor*. **Add both lines in the same change**, and read the declaration file
  afterwards rather than trusting the total.
- **Adding a global means adding a line to `GLOBAL_TABLES` or `GLOBAL_VARS` in
  `tests/api/Check.js`, and that is deliberate rather than a chore.** The scan
  cannot infer them: the very same
  `JS_SetPropertyStr(ctx, x, "Name", JS_New…)` shape builds half the runtime's
  *return values* -- `Exec`'s handle, `File.Info`'s answer, a table row, a
  `Dialect` -- so guessing would demand a documentation heading for every one of
  them. The explicit line is what makes the reference's completeness checkable.
- **The globals' check is looser than the widgets' on purpose.** `controls.md` is
  all tables so a member must begin a row; `library.md` is a table for `File`, a
  bullet list for `Dialog` and a sentence for `Logger`, each right for what it
  describes. So the rule there is *the name in backticks somewhere under its own
  `##` heading*, bare or qualified (`` `Debug` `` or `` `Logger.Debug` ``) -- its
  own section and not the file, since `Load` belongs to both `File` and `Locale`
  and a file-wide search would let either cover the other.

## `Action`: a command in several places

- **The measurement in `widgets.md` understated the case, and finding out how is
  the whole argument for the feature.** It said nine commands in the IDE were
  reachable from both a menu and a button. What it did not say is that their
  availability was computed in **two files with two different expressions**:
  `Designer.refresh` set the buttons and the context menus from
  `selection.length > 0`, and `MainForm.refresh` set the menu bar's items from
  `design && designer.selected !== null`. Whether those agreed was not a
  question anybody could answer by reading either one. It is three assignments in
  one place now, and the second place cannot come back because a bound control
  **refuses** an `Enabled` of its own.
- **`Action` is applied last by the loader, and that is not tidiness.** A command
  lends its label and its icon to a control that declared neither, so binding
  before the control's own `Icon` had been set gave a 34-pixel flat toolbar
  button the command's *words* as well -- and it grew until it pushed the tab
  strip under half the window. Caught by the IDE's own layout assertion
  (`the tabs still span the width`) the first time three of its buttons were
  converted, because **the serialiser writes properties sorted and `Action` sorts
  before `Icon`**. `apply_properties` does two passes for it, the mirror of
  `Arrangement` going first.
- **An icon suppresses the lent label.** The rule that falls out of the above: a
  control that declared an icon is an icon control and takes no words; one that
  declared neither gets both, which is what a menu-shaped button wants.
- **A bound control writes back neither the lent label nor an `Enabled`.** The
  label uses the loader's own `__declared` note -- declared nothing, applied the
  command's -- so the command stays the one place it lives, and a program that
  assigns its own afterwards makes the note stale and wins. `Enabled` is skipped
  outright in `collectProperties`, because it used to be written: saving a form
  while a command was disabled put `"Enabled": false` on every control naming it
  and **the file would not load again**, since the loader is refused the same
  assignment. Found by serialising the first form that had a command.
- **A menu item that points at a command resolves it in the *form's* group, not
  the menu's.** A popover has its own group under a different prefix for its own
  items, so an `{ "action": … }` there had to be spelled `form.` and looked up on
  the form -- otherwise a context menu naming a command would silently get a
  second, empty one. GTK resolves it by walking up from wherever the popover is
  parented.
  **An item that points at a command refuses an `enabled` of its own**, and that
  is the same rule as the pair above: the command is the object, so an `enabled`
  there is a value nothing reads -- and it would look exactly like the one that
  greys every place the command appears. A plain item's spec *does* take
  `enabled` (the key `actions` already had), which is what lets a menu built for
  the moment say *not now* without leaving the entry out.
- **And the IDE lost six names it only had for want of somewhere to put a
  command.** `MnuCvDel`, `MnuTrDel`, `MnuCvRaise`, `MnuTrRaise`, `MnuCvLower`,
  `MnuTrLower` existed because "a menu item is exposed on the form by name, and
  two widgets cannot both own `MnuDel`" -- its own comment. An item that points
  at an action owns nothing, so it needs no name. Two handlers that delegated to
  a *button's* handler are gone with them, which was the clearest smell there
  was: there had been nowhere to put the command, so one of the four became its
  owner.
- **A `JSValue` in a wrapper's opaque slot wants `gc_mark`, and its finaliser
  wants `JS_FreeValueRT` -- not a `JSContext*` carried beside it.** `Http`'s
  client was built the other way first: the defaults object `Dup`'d into
  `HttpClientData`, the `JSContext*` kept in the struct to free it with, a
  `GList` of every live client, and a sweep in `bta_http_cleanup` -- the
  `ExecJob` mold, applied where it does not belong. `ExecJob` needs all that
  because a job is owned by a list and reachable from nowhere the collector
  looks; a *wrapper's* opaque struct is reachable, and the runtime already
  hands its finaliser the `JSRuntime*`. Two costs to getting this wrong: the
  scaffolding, and the cycle -- `srv.Request = (req) => { ... srv ... }` is
  the shape every server is written in, and without `gc_mark` that pair is a
  listening socket nothing can reach and nothing can free. `bta_menu.c`'s
  `action_gc_mark` was the answer the whole time. What a list is still for is
  a resource outside the process: `http_servers` survives because a held port
  is not the collector's problem.
- **The globals' check needed `http_props` *and* `http_client_props` in
  `tests/api/Check.js`**, since the client's verbs live on its prototype and
  not on `Http`.
- **A chain of callbacks that holds its own list is garbage, and whether it is
  collected before teardown is luck.** `testHttp` kept its steps in an array
  every step closed over, so the finished chain was a cycle nothing referenced
  -- collected only if the collector happened to run before `JS_FreeRuntime`,
  which aborts on whatever is left. Two runs in three aborted with every
  assertion green, and one passed for no reason at all. The last step empties
  the array (`steps.length = 0`); with no cycle the refcounts fall to zero on
  their own and no collection has to happen. Anything that chains callbacks
  through a shared table wants the same last line.
- **And a chain nobody counts ends the run early instead of failing.** The same
  `testHttp` once reported six assertions fewer with nothing red: on a loaded
  machine `Exec`'s tail reached `finish()` mid-chain, and `finish()` only waits
  for `waiting`. The chain is `waiting++` at its start and `waiting--` at its
  end now -- every request in it carries a `Timeout`, so the counter cannot
  stick. An async helper that neither counts nor times out is a hang or a
  silence, and this codebase has had both.
- **libsoup3 has no session `authenticate` signal, and connecting one is a
  `GLib-GObject-CRITICAL`, not a `NULL` or a no-op.** The plan assumed the
  soup2 shape; measured, the signal is in neither `soup-session.h` nor any
  other header (nor on `SoupAuthManager`, per `gi` introspection), and the
  replacement (`use_auth` off a challenge) is a second round trip. So `Auth`
  is Basic preemptive in the header -- the same bytes with no signal -- and a
  401 from anything else is answered. Check a signal exists (`g_signal_lookup`)
  before designing on the assumption that it does.
- **The two famous echo services sit on the Public Suffix List, where no
  cookie may live.** `httpbin.org` and `postman-echo.com` are both in
  `public_suffix_list.dat` (15291, 15294), so soup's jar -- like any
  PSL-respecting client -- refuses their `Set-Cookie`, and it looks exactly
  like a jar that never stores: manual `set_cookie` answers 0 while
  `localhost` answers 1. `examples/session` runs against `httpbingo.org`,
  which is not listed. When cookies vanish only on one domain, read the list
  before reading the code.
- **Soup normalizes a request's dot-segments before the handler runs, so a
  `".."` refusal in a file server is dead code that teaches the wrong
  lesson.** `/a/../../x` arrives as `/x`, encoded or not -- measured with a
  probe echoing `req.Path` -- which means `File.Join` under a root cannot
  escape it, and a test asserting the `400` fails. `examples/serve` relies on
  the normalization and says so, instead of carrying a guard that never fires.
  The reference claimed the opposite for a while (`routing, Bytes, statuses,
  and the ".." refusal`), copied out of the plan that predated the
  measurement: a sentence describing a guard nobody wrote, sitting in the
  file people read to find out what the runtime does.
- **`Stop()` asks, it does not undo, and the answer still arrives.** A
  cancelled request calls back a turn of the loop later -- by which time the
  request that replaced it is already flying. A control that stays enabled
  (`examples/jokes`' category combo; the button cannot do it, since it
  disables itself) is used twice before the first answer lands, and the stale
  `Cancelled` overwrote what the live request was doing: the status read a
  failure with the button re-enabled while a good request was on its way.
  What makes a stale answer droppable is the handle each callback is handed
  as its second argument -- compare it against the one being waited for.
  Reproduced both ways against a 3 s server before it was believed: without
  the check the status showed `Cancelled` twice, with it never.
- **A server lives as long as its object, so an example keeps it at module
  scope.** Dropping a listening server disconnects (a port is not left held
  past whoever held it), which means a `const` inside `Main` dies with the
  return, before the first request ever arrives -- and it looks exactly like
  `Start` never listened. The suite never notices, because its chain closes
  over the server to stop it at the end.
- **One feature instance on two sessions corrupts the heap on the way out.**
  A `SoupCookieJar` added to both of a client's sessions dies twice -- once
  per session finalizer -- and the crash lands in `soup_session_finalize`,
  pages away from the `add_feature` that caused it, with wrong answers (open
  gates, empty parts) as the first symptom. A `Wait` borrows the jar for the
  flight instead, which is exclusive by construction since a `Wait` freezes
  the loop every async flight is parked on.
- **Two argument splits reading the same object with two key lists is one
  call answering two ways.** `Http`'s async spelling decided "body or
  options?" by looking for seven names; the blocking one looked for six, and
  the one it lacked was `FollowRedirects` -- so `PostWait(url, {
  FollowRedirects: false })` serialized its own options and posted them as
  JSON, configuring nothing, with nothing saying so. It is one `static const`
  table now, read by both. Where the same question is answered twice, the
  answer is a table, not a second copy of the list.
- **A `Kind` matched on `err->message` is right only where it was written.**
  Three arms of `http_kind_for` compared English substrings (`"Connection
  refused"`, `"Name or service not known"`), which on a Spanish desktop match
  nothing -- and a `Kind` that is wrong only on some machines is worse than
  `Error`, because it looks reliable. The domain and the code say the same
  thing in every locale. The same function also called every error in soup's
  domain a `Redirect`, `ftp://` included.
- **`GDataInputStream`'s default newline is LF, and HTTP is a CRLF
  protocol.** `Exec` never had to know: a pipe ends its lines with `\n`. A
  conforming server-sent-event stream is allowed `\r\n`, so `Http.Stream`
  read with the default handed every line back with a carriage return still
  on the end of it -- `JSON.parse` failing on the last character, and the
  blank line that separates two events never comparing equal to `""`.
  `g_data_input_stream_set_newline_type(..., G_DATA_STREAM_NEWLINE_TYPE_ANY)`,
  the moment the reader is made. The test that catches it is `/crlf` in
  `testHttpStream`, and it exists because the LF-only feed passed happily.
- **`on_http_stream_line`'s `CANCELLED` branch is *not* `on_exec_line`'s**,
  and the two functions otherwise read as twins. In `Exec` a cancelled read
  means the teardown already freed the job, so the callback returns and says
  nothing. In `Http` only the guard and `Stop()` cancel: the job is alive and
  owes an answer, so that branch *delivers* `Timeout`/`Cancelled` like the
  buffered road. The teardown case is caught by `http_job_alive` instead --
  membership of `http_jobs`, checked first thing in every streaming
  completion, because a stream has a read armed on it for its whole life and
  the teardown frees jobs with those reads outstanding.
- **A stream is routinely stopped from inside its own line callback**, which
  is the `File.Watch` segfault again -- the line that says the turn ended is
  exactly where an application stops following. The `calling`/`dead` pair
  lives **inside `http_job_free`** and not at each caller: there are three
  callers already (both deliverers and the teardown) and a fourth added later
  would reopen it in silence. Coming off `http_jobs` before the mark is what
  keeps the teardown's `while (http_jobs)` terminating.
- **The next read is armed after the JS callback returns, not before**, and
  that is the whole of the back-pressure: one read outstanding at a time, so a
  slow handler slows the feed instead of queueing it. It is also why nothing
  needs a reassembly buffer -- `GDataInputStream` holds the partial line, the
  way it already does for `Exec`.
- **`HTTP_OPT_KEYS` was deliberately not touched.** Streaming is a verb
  (`Stream`) and not an option, so there is no new key to keep in step across
  the two argument splits, no rejection to invent in the seven `*Wait`
  spellings -- and, unlike an option, `tests/api.sh` can *see* it: the check
  reads member tables, so an option would have been the one large capability
  the documentation was not obliged to name.
- **Changing what a list tracks without changing every writer leaves the
  stale one.** `http_servers` went from *running* to *live* when the
  finalizer took over disconnecting, but `Start` kept its own prepend: every
  start registered twice, the finalizer removed once, and teardown walked a
  dangling pointer -- straight into `remove_auth_domain` on garbage, which
  reads as a bug in auth. The one writer nobody re-read is the regression to
  watch for.
- **A playbin3 owns the sink it was given, so unref-ing after the set is a
  double free.** `g_object_set(playbin, "video-sink", sink)` takes the sink
  into one of its own bins, sinking the floating reference the factory gave --
  the `gst_bin_add` ownership, not a `gst_object_replace` one. The tutorial
  pattern of set-then-unref destroys the sink while the playbin still points
  at it, and the playbin's own finalizer then touches freed memory: two
  `GStreamer-CRITICAL`s (`set_state` on a non-element, `unref` past zero) at
  teardown, nothing while playing. Measured with a three-variant C probe
  (`/tmp` never kept it): flags-only finalises clean, flags+fakesink dies,
  and skipping the unref both lives and finalises the sink with the pipeline
  (weak-ref proved, so it is ownership and not a leak wearing a fix).
- **Teardown waits for NULL, capped, before the unref.** The state change is
  async, and finalising a playbin with one still in flight tears its children
  down under it. Two seconds, so a wedged network source cannot hold teardown
  hostage -- the same shape as every other guard here.
- **Length and seekability arrive after the first frame, not with it -- and
  the frame's own size after that.** `Playing` flips true while `Duration`
  still answers -1 and `Seekable` false; the demuxer has not seen the stream
  yet. A test asserting seekability the moment playback starts fails about one
  way in one; `until(Duration > 0)` first, and `until(SourceWidth > 0)` before
  measuring or saving a frame, because the paintable has nothing in it until
  something is decoded. The same async lag is why `Seek(0.2)` reads
  `Position 0` back on the next line.
- **A player that plays must hold its own JS object.** `function ding() {
  const a = new AudioPlayer(); a.Uri = "done.ogg"; a.Play(); }` played
  *nothing*: the local went out of scope, the refcount hit zero, and the
  finalizer stopped the pipeline -- while the reference documentation said a
  player left playing keeps the program alive. The keepalive is taken in
  `Play` and released at the end, at an error, and at `Pause`/`Stop`, and it
  is deliberately absent from `gc_mark`: it is the pipeline's claim on the
  object, and a cycle detector that could see it would collect exactly what it
  protects. It also closed a segfault -- an `OnEnded` that dropped the last
  reference freed the struct under the emit, and the next line read `m->ctx`
  (`list_del` on 0x0, in `bta_drain_jobs`).
  **A `Video` has no keepalive, so it had the same hole left open.** Its
  engine state is the picture's qdata, not a JS reference, and `media_on_eos`
  and `media_on_error` both ended in `media_drop_self(m)` -- written for the
  AudioPlayer, whose `self` keeps `m` alive across the emit. A handler that
  takes the Video out (`Vid_Ended() { this.Vid.Remove(); this.Vid =
  undefined; }`) finalised the widget, the qdata and `m` inside the emit, and
  the drop read freed memory: `heap-use-after-free` under build-asan, on both
  roads. Whether it is a video is read before the event and nothing after it
  touches `m` for one. `testVideoDroppedInHandler` runs the error road as a
  child, which needs no clip.
- **Never ask a pipeline whether it is playing.** `gst_element_get_state`
  with a zero timeout reads not-PLAYING during a flushing seek -- which is
  what `Loop` is -- and while a network stream refills. The console loop asks
  "is anything still owed an answer" 50 times a second, so a looping cue
  ended the program at a loop boundary, at random: a 0.3 s clip exited after
  2.5 s, 4.3 s and 4.6 s in three runs, and a 5.8 s clip once at 11.8 s and
  once not at all in 40 s. `Playing` is now what `Play` asked for, cleared by
  `Pause`, `Stop`, the end and an error -- one flag, and the same answer for
  JS and for the loop.
- **An optional dependency may not break the *designer*.** Without GStreamer
  every `Video` getter threw, which sounds like the sqlite mold and is not:
  the property grid reads every value of the selected control and the
  serialiser reads them all again to save, so a runtime built without
  GStreamer could not draw, save or even *load* a form with a `Video` in it (a
  declared `Uri` is assigned like any other property, and the load died with a
  dialog). The rule the optional-dependency mold actually needs: the verbs
  refuse, the state is kept, the properties answer.
- **One surface, two engines.** `Video` and `AudioPlayer` are the same
  seventeen members over the same struct, so the accessors are written once
  and both `JSCFunctionListEntry` tables point at them -- the resolver answers
  for either (opaque first, then the picture's qdata). What differs by build
  is behind ten `engine_*` functions with a GStreamer version and a version
  that refuses. Written the other way it was 230 lines of accessor said twice
  and a 200-line stub saying it a third time.
- **`gst_init` is 6 ms warm and 573 ms cold**, measured with a three-line
  probe against a thrown-away registry, so it happens on first use and not in
  `bta_media_init`. It was a bill every program in the tree paid, the IDE
  included, for a feature most of them never call.
- **`Buffering` is a percentage of the queue's target, not of the download.**
  Held at PAUSED until it reads 100, a stream served *below* its own bitrate
  never starts at all -- the percentage sat at 1 for as long as it was
  watched. That is not the holding logic being wrong: `gst-launch` on the same
  URL does not reach the end either, because there is nothing there to play
  through. Served just *above* the bitrate, the same clip read 1, 2, 12, 22,
  ..., 81 and then started, and the picture ran to the end. Both measured
  against a local server throttled by hand, which is the only way to see any
  of this -- and worth rebuilding (`python3` + `time.sleep`) before touching
  the buffering path again. Two things that will waste an afternoon there: the
  throttling server must be threaded (a single-threaded one blocks on the
  probe connection souphttpsrc abandons, which looks exactly like a stream
  that never fills), and `pkill -f serve.py` kills the shell that is editing
  `serve.py`.
- **An event dispatched through a variable is an event nothing checks.**
  `media_emit(m, "Ended", ...)` calling `bta_emit(w, event, argc, argv)` was
  invisible to `tests/api/Check.js`, whose regex wants `bta_emit` beside a
  literal name -- so `Error` grew a second argument with nothing to notice
  that three documents said `Error(message)`. Both events are now emitted with
  their names spelled out at the call site.
- **The engine is playbin3 plus the paintable sink, and neither GstPlayer nor
  GtkVideo.** `GstPlayer` (`gstreamer-player-1.0`) is the deprecated API
  `GstPlay` replaces, and neither ships a GTK4 renderer -- both would still be
  handed a `gtk4paintablesink` through an adapter of our own, a dependency for
  no feature this surface uses. `GtkVideo` takes a `GFile` and nothing else:
  no RTSP URI, no digest credentials, no pipeline to tune. What a camera needs
  is `source-setup` into `rtspsrc`'s `user-id`/`user-pw`, which only a pipeline
  of our own has.
- **An optional dependency is not the same question as an optional *widget*, and
  `Widget.Types()` is the wrong list to build a palette from.** `Terminal` on a
  build without VTE is there, constructs, draws, loads out of a `.form` and
  answers every property: the class is not what is missing, the pty is. So the
  class table gained `available` (`BTA_CLASS_OPTIONAL` passes it; every other
  macro defaults it to true), `Widget.Available(type)` reads it for a caller that
  has a name and no control, and the instance publishes `Available` for one that
  has a control. **Offer from `Available`, load from `Types`** -- the IDE's
  palette filters on the first and `Widget.New` still builds the stub, because a
  `.form` that already holds one has to open.
- **...and a build-time flag is a different question from a machine's answer, so
  a class can now answer with a probe.** `Terminal`'s `available` is whether VTE
  was linked in, which is a constant; `Video` needs GStreamer *and* the
  `gtk4paintablesink` element, and a runtime built with GStreamer on a machine
  whose registry lacks gst-plugins-rs is a real shape -- a CI runner.  So
  `BtaClass.probe` is a function the class declares and `bta_class_runnable`
  picks whichever of the two a class has (`Video` is the one row using
  `BTA_CLASS_ENUM_PROBE`, and `AudioPlayer` is deliberately outside it: sound
  needs no sink).  **The probe caches its own answer**, because the first
  question reads the GStreamer registry: 6 ms warm, **573 ms cold** measured,
  and that is why it is asked on the palette's first question rather than at
  start-up.  The palette test already checked both directions generically
  (available must be offered, unavailable must not), so `Video` dropping its
  button on this build was already covered -- what the widgets test adds is that
  `Video.Available` and `Widget.Available("Video")` cannot drift apart.  The
  issue that asked for it, `docs/issues/ISSUE-video-availability.md`, is deleted
  as answered.
- **The IDE's output pane was a `Terminal` for nothing, and the audit is the
  lesson rather than the fix.** Consumer by consumer, everything that used it
  wanted `Run`, `Clear`, `Text`, `Stop` and `Exit` -- and *nothing* used stdin,
  typing, ANSI colour, `Kill`, `ScrollbackLines` or `less`. The one thing VTE
  uniquely gives, an interactive terminal, had no caller. It is `Exec` plus a
  read-only `TextEditor` now, which is what `examples/usage` already documented,
  and the dependency stopped being required in the same change. Before keeping a
  heavy widget because of what it *can* do, list what the callers actually call.
- **A click in a `ReadOnly` `TextEditor` does move the insertion cursor**, so
  `Line`/`Column` say where it landed and `Selection` is `""` -- which is the
  whole of what replaced VTE's `LinkPattern`. Measured with a real pointer
  (`xdotool` on an `Xvfb` of its own, a two-file probe under the scratch
  directory), because none of it is answerable from the suite: there is no
  synthetic pointer here.
- **...and the handler is `MouseUp`, not `Cursor`.** `Cursor` fires on the click
  and looks like the obvious one -- it also fires on every arrow key, so reading
  a log with the keyboard would open a file per keystroke. Same probe, same
  sitting: a plain click gives `Cursor` (at press), `MouseDown`, then `MouseUp`
  with the cursor already there and no selection; a drag gives `Cursor` events
  with a growing `Selection` and, usually, **no `MouseUp` at all** -- GTK's own
  drag gesture claims the sequence, which is the VTE trap above seen from the
  other side. `Selection !== ""` is still the guard, because "usually" is not a
  contract.
- **Gestures coalesce, so a probe that clicks twice in the same place is
  measuring a double click.** Two 0.4 s-apart clicks in that same sitting
  produced three `MouseUp`s for five gestures and one `DblClick` that never
  arrived, which read as `MouseUp` being unreliable -- it is not. Leave more than
  GTK's double-click time (1.2 s was ample) between gestures in a pointer probe,
  or the answer is about the coalescing and not about the widget.
- **`Terminal.Stop()` does not end an interactive shell, and the pty does.**
  Bash ignores SIGTERM when it is interactive, so the IDE's terminal tab still
  reads `Running === true` after `stopShell()` -- which looked like a leak
  waiting to happen. It is not: closing the pty makes the kernel hang up its
  foreground process group, which is what closing a terminal window has always
  meant, and VTE does that when the widget goes. Measured by starting a bash in
  the tab, quitting the IDE and looking for it (`ps`): nothing left behind. So
  the SIGTERM is for everything that *does* honour it, and following it with a
  `Kill()` would be the IDE sending SIGKILL to whatever build or editor somebody
  had running. A test can only assert the first half, so it drives `SHELL` at
  `/bin/cat`; the second half is a by-hand measurement and says so.
- **A throw inside `Form_Open` hangs a phase-limited `tests/run.sh`**, because it
  becomes a dialog and the driver waits for a window that is sitting behind it.
  `Notebook.Append(child, label)` wants a *widget* for the label and threw a
  `TypeError` on a string; the run went to the 120 s timeout with nothing on
  stdout but the traceback. If a `run.sh <project> <phase>` stops producing
  assertions, read the traceback before believing the phase is slow.
- **On `EXPORT` this GTK renders every page whatever range the settings carry.**
  `Printer.ToFile(area, path, { Pages: 5, From: 2, To: 3 })` came back a five-page file with
  `before` called for all of them -- measured first in Bintana, then again in a
  forty-line C probe that set the range and watched `draw-page` fire 0 to 4, so
  it is GTK's and not the plumbing's (the 0-based numbering the probe showed is
  why `before` adds one). A range on the file road is said with the page count
  instead -- the file then holds exactly `From..To` -- while the dialog road
  keeps the whole count (it is what the dialog offers the range within) and the
  settings carry the preset. The `answer` reports the pages actually rendered
  either way, which is what keeps it truthful on both roads.
- **GTK4 has no built-in print preview: `Vista previa` opens Evince or Papers.**
  The button is there and the dialog is GTK's, but the preview itself is a
  temporary PDF handed to an external viewer -- on a machine with neither
  installed the preview fails, and the failed launch takes the run down with a
  cairo assertion in GTK's own cleanup (measured with an empty `Draw`, so it is
  not the drawing). Documented rather than worked around: there is nothing in
  this runtime that shows a PDF. `Cancel`, by contrast, is clean and asserted
  nowhere -- it returns `null` and quits, verified by hand four times because
  no suite can click a dialog.
- **`Container.Spacing` accepted a negative and GTK read it as four billion.**
  The setter cast its `int32_t` to `guint` unchecked while the sibling setters
  (`Flow`'s `RowSpacing`, `Grid`'s spacings) refused negatives with
  `RangeError` -- three implementations of one gap, one without the check.
  `Spacing = -1` is refused now, with `tests/widgets`' `testSpacing` asserting
  the refusal and that nothing stuck. A new numeric setter that ends in an
  unsigned GTK call wants the same line.
- **A failed `sqlite3_bind_*` left its parameter NULL and the statement ran
  anyway.** `bind_one` returned `true` whenever the JS value was convertible,
  so `SQLITE_NOMEM` or `SQLITE_RANGE` became a wrong answer rather than an
  error. Every bind goes through `bind_ok` now, which throws sqlite's own
  message for that parameter; a `Bytes` past `INT_MAX` is refused up front
  rather than truncated into a shorter length.
- **`Exec`'s `Timeout`/`KillAfter` cast a double to `unsigned` unchecked, which
  is undefined past what an unsigned holds -- and 0 means two different
  nothings.** `Timeout: 0` arms no guard while `KillAfter: 0` forces at once
  (no graceful wait), so `Infinity` could not become 0 for both: it is clamped
  to `G_MAXUINT` instead, "effectively forever" for either key, and negatives
  stay 0 as before. The `JS_ToFloat64` beside it is infallible -- its input is
  guarded by `JS_IsNumber` -- and says so where it stands.
- **An option's default was decided by a second reading of the same key, and
  the two readings disagreed about `null`.** `Print`'s reader took `undefined`
  and `null` alike for "not given"; the line that makes `To` default to the
  last page asked again, and asked only about `undefined` -- so
  `{ Pages: 5, To: null }` printed page 1 and said nothing. The reader answers
  whether the key was given now, and the default is decided once, beside the
  others. **A default that depends on another option is the one to look at**:
  it is the only kind that cannot live in the variable's initialiser, and so
  the only kind tempted into a second look.
- **A deleted document leaves its links behind, and the prose around them reads
  as current.** `docs/issues/ISSUE-printing.md` went the day printing arrived;
  `docs/llm/markdown.md` and `docs/reference/globals/Dialog.md` went on pointing
  at it and went on saying there was no printer, while the bookkeeping in
  `docs/issues/README.md` was updated by hand. `tests/api.sh` walks every
  relative link in `docs/` now -- the other three checks ask whether what exists
  is written down, and this one asks whether what is written down still exists.
- **A verb with a key that decides whether there is a dialog is two verbs.**
  `Print(area, { ToFile })` opened the print dialog, or did not, depending on a
  key in its options -- and the give-away was measurable rather than stylistic:
  `Copies: 3` down the file road answered *three copies sent* and wrote the same
  file, byte for byte, as one copy. A file has no copies. Split into
  `Printer.Send` and `Printer.ToFile`, the key that does not apply cannot be
  passed, and the answer cannot claim what did not happen -- the shape
  `Dialog.OpenFile`/`Dialog.SaveFile` already had. **When a key changes what the
  call *is* rather than what it does, it is the name of another call.**
- **A second event beats a fourth argument.** Which page a handler was drawing
  used to travel through a field of the form -- a `before` callback wrote it and
  `Draw` read it back -- because growing `Draw` a fourth argument would have
  changed every handler ever written. `DrawPage(painter, page, width, height)`
  is raised in its place on paper, and a form that declares none still gets
  `Draw`, so nothing had to change when it arrived. `bta_has_handler` is asked
  rather than guessed: "the form did not declare it" and "it declared it and it
  does nothing" are different statements, and only the first may fall back.
- **Two libraries may not declare the same top-level name, and nothing was
  checking.** A project's libraries are evaluated into the one global scope the
  project runs in, so `lib/report` and `lib/markdown` each declaring a top-level
  `const PAPERS` -- the same three paper sizes, written out twice -- meant a
  project naming **both** did not start: `SyntaxError: redeclaration of
  'PAPERS'`, on line 1 of a file its author never wrote, with nothing in the
  message about which two libraries were arguing. The IDE offers libraries as
  ticks, so two ticks was the whole reproduction. **Nothing in the suite could
  have caught it**, because no project in this tree named two libraries: each
  had a test project of its own, so the suite proved all three work and never
  that any two work at once. Both halves exist now -- `tests/api.sh` compares
  the top-level names of every library, and `tests/smoke` names all three --
  and the table itself is `Printer.Papers`, read off GTK.
- **How many pages a document is depends on the paper, and the paper is the
  dialog's answer.** `Printer`'s `Pages` is worked out against the paper the
  *caller* had; a `Markdown` laid out for A4 is six sheets on A5, and the
  operation printed the four that were declared and dropped the rest -- measured
  on a real document, silent. `Paginate(width, height)` is asked in GTK's
  `begin-print`, which is the only place both things are true: the paper is
  resolved and `set_n_pages` may still be called. **A control whose layout does
  not move with the paper must declare none** -- `lib/report` scales a page to
  fit and its count does not move. It declared one for a single commit,
  returning `PageCount`, and the cost was not redundancy: `PageCount` measures
  when it has to, and measuring inside `begin-print` re-enters the drawing the
  operation is in the middle of. **The suite hung.** Measure inside `Paginate`,
  raise no events.
- **`tests/api.sh` scans for `bta_emit*` by name, so a new spelling is a whole
  event nobody checks.** The pattern knew `bta_emit`, `_on` and `_ok`;
  `bta_emit_answer` arrived with `Paginate` and the event was raised by the
  runtime, handled by two libraries, and counted by nothing -- the check went on
  reporting green with one event missing from its own total. It is `bta_emit\w*`
  now. A scanner that lists what it knows about goes stale the first time
  somebody adds to what it scans.
- **An optional dependency that ships inside a required one cannot be left out,
  so its job hides it.** `no-vte` is the honest shape -- libvte is its own
  package, the job does not install it, CMake says so. `gtk4-unix-print` is not:
  its `.pc` is in `libgtk-4-dev`, the same package as `gtk4.pc`, and the
  platforms where it is really absent are Windows and macOS, where the suite
  does not run. So `no-unix-print` puts a pkg-config on `PATH` that answers "no"
  for that one name, and **reads CMake's own line back** to prove the wrapper
  worked -- without that guard a wrapper that stopped working would make the job
  a second copy of the first one, silently, which is the same guard `no-vte`
  carries for the same reason. Measured both ways: with the wrapper the branch
  compiles and `tests/widgets` is 3303, and with the real pkg-config the guard
  fails the job. **`no-libxml` is the third and it is the hidden kind too**:
  libxml2's headers can arrive as some other package's dependency, so the same
  wrapper hides `libxml-2.0` and the same read-back proves it -- measured,
  `tests/widgets` is **99 assertions fewer** in that build than with it
  (measured 3566 against 3665 when the suite was that size; it has grown since),
  and green both ways, because the XML tests fork on `Xml.Available` the way
  `testDatabase` does on sqlite.
- **An optional dependency shipping in the tarball is a promise about somebody
  else's machine.** The `package` job builds for the fewest shared libraries, and
  `libxml2-dev` can be pulled in by `libgtk-4-dev` without anybody asking -- so
  that job hides `libxml-2.0` with the same wrapper and fails if it is found,
  rather than silently making every download need a library the downloader may
  not have.
- **A dialog that blocks the caller is the odd one out here, and blocking never
  meant safe.** `Printer.Send` ran `gtk_print_operation_run` synchronously and
  answered `null` for a cancel, while `Dialog.OpenFile`, `SaveFile` and `Color`
  all take a callback and none of them reports a cancel -- so it was the one
  dialog a program had to treat differently. And the synchrony bought nothing:
  GTK runs a **nested main loop** while a dialog is up, so the program keeps
  going. Measured: during a 484 ms print a `Timer.Every(20)` fired four times,
  and a second print of the same control started from a timer was **not
  refused** and wrote its pages. `set_allow_async` plus the `done` signal is the
  shape now, the callback is required and not called on a cancel, and one
  control prints once at a time. `bta_paint_busy` does not cover that: between
  two sheets there is no frame open, which is why the suite probes it from
  `Paginate` and not from `DrawPage`.
  **Going async moved where the refusals land, and they did not follow.** A
  `Paginate` that throws, a range the new paper leaves empty and a `DrawPage`
  that throws all raise an exception and mark the run failed -- right for
  `ToFile`, whose caller is on the stack and returns `JS_EXCEPTION`. On `Send`
  they run inside GTK's signals of an operation nobody waits on, and
  `on_print_done` dumped only its own errors, so the exception stayed on the
  context for whoever called into JavaScript next. `print_fail` reports it on
  the spot when the run has a callback. Found by reading, since no headless
  run can answer the dialog; `on_draw` had the same shape answered years
  before.

## Task: what a thread costs here

- **A class id crosses runtimes, and a first attempt at this assumed it could
  not.** `JS_NewClassID` allocates out of `rt->js_class_id_alloc` -- per
  runtime -- and `JS_NewClass1` accepts any id under 65536, growing
  `rt->class_array` to fit. So an id the main runtime assigned registers
  verbatim in a worker's. The module-level `static JSClassID` variables are
  process-global C storage, but `install_globals` finishes before any thread
  exists, which makes each of them written once at boot and read-only after.
  The abandoned version spent seven hundred lines on a worker decimal of its
  own for want of that fact, and it rounded differently: `(10/3)*3` answered
  `9.999999999` inside a worker and `10` outside one. **Measure the engine
  before writing a second implementation of something the process already
  has.**
- **The frontier for a worker is callbacks, not writes.** `File.Save` is
  `g_file_set_contents`; it is no less safe from a thread than the `Exec` that
  already writes beside the window. What cannot cross is a `GSource` or a
  `GFileMonitor`, because it fires on the main thread holding the worker's
  context -- which is why `File.Watch` was the genuinely dangerous name on a
  list that called it a write. Measured: every mutable process-global in the
  modules a worker runs is five variables (`watch_jobs`, `exec_jobs`,
  `timers`, `paste_jobs`, `dialog_jobs`, all in bta_sys.c) and the rule takes
  all five. What keeps a global list is what has work in flight, and what has
  work in flight is what has callbacks.
- **A refusal with a trigger can still be wrong, and stating the trigger is
  what makes that findable.** The writes were refused "until there is a lock",
  which is a deadline rather than a doctrine and so survived review -- and the
  deadline was still aimed at a danger that does not exist. `File.Save` is
  `g_file_set_contents`, atomic by temporary-and-rename, so two threads saving
  one path cannot tear it; what concurrency costs here is the **lost update**,
  which is a *sequence* and which no lock the runtime puts on a call could
  ever reach. The writes came back before `Lock` did, and the plan's phase 2
  turned out not to depend on its phase 3 at all. **Before promising a feature
  will lift a refusal, measure whether the refusal is about anything.**
- **A refusal states its expiry or it becomes doctrine.** The writes are
  refused today with *"a task cannot write yet -- two writers need a lock to
  order them, and there is none"*, not with *"a task reads the disk, it never
  writes it"*. The first is a deadline with `docs/plans/task-plan.md` behind
  it; the second is a philosophy nobody agreed to, and it is what got the
  first attempt abandoned.
- **`bta_widgets_init` cannot run twice, and that is what split the prelude.**
  It keeps each class's `proto` and `ctor` in the process-global class table,
  so a second runtime running it would overwrite the main thread's with values
  of its own -- unlike the class *ids*, which are only numbers. rad.js used to
  reach `Widget` at the top level, so it could not be evaluated without one;
  the widget half moved to `runtime/js/forms.js` and the main thread evaluates
  both. `defaultsFor` and `sameValue` stayed behind because `Record` uses them
  and neither is about widgets.
- **`g_main_context_invoke` with no owner dispatches synchronously -- on the
  worker.** A task that finished between `Main` returning and the console loop
  starting had its delivery run on its own thread, which then joined itself and
  hung forever: green in every suite run (the loop is always up there) and a
  hang in the one program that quit early. Delivery goes through `g_idle_add`,
  which never executes in the attacher and waits for a loop that may still
  start; teardown joins what never got delivered. The `task_on_main` check
  stays as the guardrail.
- **One shot and exactly-once are what make cancellation a flag and not a
  protocol.** A stopped or stale answer still arrives, so every run retires by
  generation where the answers land -- `examples/usage` is the shape -- and a
  second `Start` is refused rather than queued, because a queue of stale jobs
  is the thing the generation was built to drop.
- **A task file is found by class name, and only the basename matches.** A
  second class in the same file is invisible to the worker: the index maps
  `<name>.js`, not declarations, so `class Helper extends Task` inside
  `WidgetsForm.js` answers `cannot find task class`. One file per task class,
  named alike -- the `.form` bargain, over `.js`.
- **A cancellation flag and an interrupt handler cannot read the same
  number.** `Stop()` was given a cooperative half -- `this.Stopping`, so a
  worker can report what it has and return -- and it did nothing at first:
  both the flag and QuickJS's interrupt handler were reading `job->stop`, so
  the hard abort always won the race and `Run` never reached the line that
  looked. They had to become separate states (1 asked, 2 timed out, 3 forced)
  with the handler firing only on `>= 2`. **Adding a cooperative path means
  taking the pre-emptive one out of the way first**, and the test for it is
  whether any work survives, not whether the flag reads true.
- **Cancelling a thread is asking, and every runtime that offered to insist
  took it back.** `Thread.Abort`, `Thread.stop` and `pthread_cancel` are all
  withdrawn or poisoned, so `Stop()` asks and `KillAfter` enforces -- `Exec`'s
  two stages, with a flag where that one has a signal -- and teardown waits a
  bounded two seconds and then casts an unresponsive worker adrift with its
  job's **live reference deliberately never dropped** -- the job is refcounted
  now, so the deliberate leak is said in the same vocabulary as everything else
  that holds one. Freeing memory a live thread still writes to is
  worse than leaking it on the last line before exit. `GCancellable` is the
  only thing that reaches a thread blocked in native code, and it was measured
  and deferred: one of the six verbs a worker can block in takes one, and it
  is not the one that hangs. See docs/plans/task-plan.md.
- **`Lock.Hold` releases in C, and that is what makes it correct rather than
  tidy.** A forced `Stop()` ends a worker at an arbitrary opcode, so an
  `Enter`/`Leave` pair written in JavaScript would leave the lock held for the
  life of the process and every other thread asking for that name blocked until
  teardown cast it adrift. With the unlock after the `JS_Call` it runs whether
  the function returned, threw, or was interrupted -- measured by aborting a
  task inside a hold and taking the same lock 0 ms later. **In every other
  language the callback form is a convenience; here the alternative is a bug.**
- **The lock is recursive because the silent failure is the expensive one.**
  `GRecMutex` and not `GMutex`: `lock` is reentrant in .NET, `synchronized` in
  Java, `TCriticalSection` in Delphi. A nested `Hold` of one name -- a function
  that saves something calling another that saves something -- is an instant
  deadlock with a plain mutex, with no error and no output, which is why the
  suite asserts the nesting rather than describing it.
- **Splitting a file by line range moves whatever was sitting in the range.**
  `File.LoadJson` and `File.SaveJson` went to `forms.js` with the widget block
  because they were physically inside it, and they are not about widgets --
  `Settings` in rad.js calls them, and a worker (which runs rad.js and not
  forms.js) lost them silently, since the failure is `not a function` at call
  time and not at load. The cross-reference check that caught `defaultsFor`
  and `sameValue` was run in one direction only: what the block *defines and
  the rest uses*. Run it the other way too -- what the block defines that has
  nothing to do with the block's subject.
- **`JS_SetPropertyStr` does not take ownership of its name.** The abandoned
  version leaked one C string per property of every message it sent, through
  `JS_SetPropertyStr(ctx, out, JS_ToCString(ctx, key), copy)`. Walk properties
  by **atom** (`JS_GetOwnPropertyNames` + `JS_GetProperty`/`JS_SetProperty` +
  `JS_FreePropertyEnum`) and there is no string to forget.
