# The runtime

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

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
code while a plain `TextEditor`'s is prose. See [`docs/resources.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/resources.md).

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
The IDE never loads the project's code, so `Classes` parses the same
declarations out of the source and the designer, the grid, the completion and
the extractor ask it.

A class that declares none must keep answering *nothing* — which is not an empty
list, and the difference is load-bearing on the IDE side: see [`docs/ide-internals.md`](../ide-internals.md).

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
  already lists it, and for a global's verb or a class static above the
  `JS_SetPropertyStr` that installs it (`/* Load(path) */`, owned by whatever
  global the variable is installed as). `tools/extract_signatures.cmake` turns those comments into
  `generated/bta_signatures.h` and the runtime answers with it, so there is no
  second declaration to drift. A JS class states its own as
  `static Signatures`. **`Signature` is the method's and `EventSignature` the
  event's**, because a name can be both — `ListBox.Select` is a method that
  selects a row and the event that says the selection moved — and the walk stops
  at the first class that declares the member, so an override
  (`Form.Serialize`) answers its own. `tests/api` fails on a method or event
  that declares none, and `api.json` carries the answers to `bintana-docs`,
  whose `check.sh` holds its pages to them.
- **And the table parser in `tests/api` was `[^}]*`**, which
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
[`docs/formats.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/formats.md#main-a-project-with-no-window).

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

## Plugins

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

## Events and dispatch

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
- **A property declared in a `.form` fires its event while the form is still
  loading**, and `this.<Name>` does not exist yet -- the loader applies properties
  before the control is a property of the form. `Txt_Change` with `this.Txt`
  undefined is not a bug in the control; every control does it (verified with
  `TextBox.Text` and `CheckBox.Value`). A handler that touches its own control has
  to guard.
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
- **Property order in a `.form` is the file's order, which is alphabetical**, so
  a property that configures what another property *creates* will usually be
  applied first. Apply it where the thing is made -- `table_build_columns` sets
  the sorter on every column it builds -- and keep the setter's loop for the
  other order. Both orders happen, so neither may be the one that breaks.
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
- **A setter that "only clamps" can still raise events through what it calls.**
  `Report`'s `Page` setter emitted `Page`, and so did `remeasure()`, which the
  `Paper`/`Orientation`/`Margins` setters call -- so a `.form` declaring `Paper`
  raised `Page` during load while the docs said those re-measure silently. The
  event lives in `Refresh()` alone now. `Markdown.Scroll` is split the same
  way: `place()` is silent, `moveTo()` is the reader's gesture and emits.
  Before calling a setter silent, read everything it calls.
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

## Conversions and refusals

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
- **`JS_ToCString` throws, and a `NULL` you turned into `"?"` is an exception you
  left on the context.** `print({ toString: null })` and `Logger.Info` of the
  same value both wrote `"?"` and walked away, so the failure surfaced later as
  whoever asked next appearing to have thrown. Handling a conversion failure
  means consuming it: `if (!s) JS_FreeValue(ctx, JS_GetException(ctx));`.
  `render` in `bta_debug.c` is the other shape, for when there is a pending
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
- **`bta_to_int` had no range check, and `(int32_t)1e12` is undefined in C.**
  It answered INT32_MIN with GCC on x86-64, which is a number nobody typed. The
  helper refuses past the range now -- `Columns.Width` was read with a bare
  `JS_ToInt32` and took `"wide"` for `0`, and the two are one rule.
- **`Container.Spacing` accepted a negative and GTK read it as four billion.**
  The setter cast its `int32_t` to `guint` unchecked while the sibling setters
  (`Flow`'s `RowSpacing`, `Grid`'s spacings) refused negatives with
  `RangeError` -- three implementations of one gap, one without the check.
  `Spacing = -1` is refused now, with `tests/widgets`' `testSpacing` asserting
  the refusal and that nothing stuck. A new numeric setter that ends in an
  unsigned GTK call wants the same line.
- **`Exec`'s `Timeout`/`KillAfter` cast a double to `unsigned` unchecked, which
  is undefined past what an unsigned holds -- and 0 means two different
  nothings.** `Timeout: 0` arms no guard while `KillAfter: 0` forces at once
  (no graceful wait), so `Infinity` could not become 0 for both: it is clamped
  to `G_MAXUINT` instead, "effectively forever" for either key, and negatives
  stay 0 as before. The `JS_ToFloat64` beside it is infallible -- its input is
  guarded by `JS_IsNumber` -- and says so where it stands.
- **A blocking call waits half a minute when nobody said, because a default
  that never ends is a hang the program did not choose.** `Exec.Wait` and the
  seven `Http.*Wait` verbs freeze the window while they wait, and an absent
  `Timeout` meant forever (R6 of the October audit) -- a child that never ends
  sat there with nothing said and nothing on screen to close. Both now fall
  back to `BTA_WAIT_DEFAULT` (bta.h, 30000 ms) and **`Timeout: 0` is the
  explicit *wait forever***; the callback spellings are untouched, since
  nothing there is frozen. A client's own `Timeout` still speaks when it is not
  zero, and a per-call `{ Timeout: 0 }` outranks it. `tests/widgets` holds the
  opt-out -- the half minute itself is the constant, and waiting it out in the
  suite would cost more than it says.
- **An option's default was decided by a second reading of the same key, and
  the two readings disagreed about `null`.** `Print`'s reader took `undefined`
  and `null` alike for "not given"; the line that makes `To` default to the
  last page asked again, and asked only about `undefined` -- so
  `{ Pages: 5, To: null }` printed page 1 and said nothing. The reader answers
  whether the key was given now, and the default is decided once, beside the
  others. **A default that depends on another option is the one to look at**:
  it is the only kind that cannot live in the variable's initialiser, and so
  the only kind tempted into a second look.
- **Never quote a GLib message in an error.** `err->message` is translated into
  the desktop's language: on a Spanish desktop a corrupt stream said *Datos
  comprimidos no válidos*, and an error that reads differently per machine cannot
  be matched by a program or pasted into a report -- the `http_kind_for` lesson
  again. The sentence is ours and names the byte where the member starts.
  **And it was never only Gzip** (D5 of the October audit): `File.Load` of a
  missing file answered "No such file or directory" on one desktop and "No
  existe el fichero o el directorio" on another, and the same for `Exec`,
  `Http`, `Picture`, `Printer`, every media failure -- **GStreamer translates
  its messages too, measured**: "Resource not found." against "Recurso no
  encontrado." -- and the `g_strerror` spellings. `bta_gerror_text` builds the
  sentence out of the domain and the code, from the pairs the runtime's verbs
  meet; a pair it does not know is still named by its domain and code, and
  `bta_errno_text` is the same table for `errno`. Two messages deliberately
  stay as they are: the editor's search error and the `Terminal`'s `LinkPattern`
  are pcre2's own text -- English on every desktop, measured -- and libxml2's
  carry the line and the column of the document, which no table can replace.
- **`g_object_ref(NULL)` is a critical and carries on, which is how a wrong
  branch stays invisible.** `Split.Reorder` ref'd both halves before unparenting
  them, and a split with **one** half is ordinary -- it is what one looks like
  after the first child is dropped, and reordering the remaining half is
  documented API. The reorder itself came out right, so nothing looked broken;
  the price was two `GLib-GObject-CRITICAL`s that the runner prints and does not
  count (`tests/runner/Main.js`'s `NOISE` filters warnings only, and no script
  sets `G_DEBUG=fatal-criticals`), and an abort for anyone who does set it.
  **A green run is not a quiet one — read the output when you touch ref counts.**

## Classes, names and loading

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
- **A new method on `Widget` goes against every subclass's property names, not just
  `bta_widget_base_props`.** `Fill()` is called `Fill` and not `Format` because
  `Format` is already a `DatePicker` property -- and a method that shadows a
  property works until a `.form` assigns it, which puts an own value on the instance
  and makes the method vanish. That is the `TreeView.Expand`/`ExpandNode` trap, and
  it costs nothing to check first.
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
- **A console project could make a widget and dump core.** A project declaring
  `main` never calls `gtk_init`, so `new Panel()` reached
  `gtk_css_static_style_get_default()` with nothing initialised and the process
  died with no message at all -- found while testing something unrelated, and
  costing a `gdb` backtrace to identify because there was nothing to read. It is
  a refusal now (`bta_ctor`): *a project with a `main` has no display, so it
  cannot make widgets*.
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
- **In a console project, an asynchronous `Exec` says nothing while you poll
  with `Exec.Wait`.** Line and exit callbacks arrive on the default main
  context, and `Exec.Wait` iterates a private one — so a `for` loop that waits
  by blocking never gives the loop a turn, and the handle's `Running` stays
  `true` and its output stays empty however badly the child failed.
  `tests/install` was written that way first: two of its assertions could not
  fail, and an IDE that exited instantly was reported as running and silent. The
  shape that works is `tests/runner`'s — start the child, return, and let a
  `Timer` (or the exit callback) carry the rest.
- `.js` load order matters when one project class extends another. `sources` in
  `project.json` fixes it; creating a form from the IDE registers it there,
  and without that entry the class silently never loads.
- Callers legitimately pass `w->name` back into `bta_widget_bind`; copy before
  freeing.
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

`bta_lookup_global` -- what `startup`, a `.form`'s `type`, `Task.Start`,
`Widget.New` and the class questions all go through -- read the **global object
first** and fell back to `JS_Eval` only when it had nothing by that name. A
top-level `class` is a lexical binding and not a property of `globalThis`, so
every global the runtime installs beat the project's own declaration, and the
program did not start. Found by adding the global `Probe`, which two
`tests/widgets` fixtures were already called (they are `Showcase` and `Slab`).

**It failed two different ways, and the second one points nowhere near the
cause.** A global written in C (`File`, `Probe`, `Field`) gave `startup class
'File' not found`, for a class that was there, loaded and evaluated. A global
the prelude makes (`Timer`, `Record`) gave `TypeError: not a function` from
inside `Form`, in an error dialog that kept the process waiting -- the lookup
found the runtime's object, and building a form out of it is what failed.

A bare name is now `JS_Eval`'d, which is JavaScript's own order: the lexical
declaration, then the global property, and a `ReferenceError` for a name that is
neither -- the same error the fallback always threw. A qualified name
(`Designer`) is still a walk down properties. **Nothing got slower**: every
caller asks the class table first, so `Button` and `Label` never arrive here,
and the names that do are a project's or a library's, which always went through
`JS_Eval` before. `tests/widgets`' `ClassNamedLikeAGlobal` runs three children
-- a startup class called `Timer`, one called `File`, a `.form` control whose
type is a class called `Probe` -- and is four reds out of five on the old lookup.

**The lesson for adding a global still stands, smaller**: the project's class
wins now, but a name the runtime publishes is a name a program cannot reach
while it declares its own, so `grep` the whole tree -- `examples/`, `tests/`,
`lib/`, not only `runtime/` -- before installing one.
