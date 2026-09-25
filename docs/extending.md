# Extending the runtime

Before writing C, check whether the thing is a Bintana form. `AskForm`,
`ConfirmForm`, `NewProjectForm` and `AboutForm` are dialogs and not runtime
primitives, and that was the right call for all four -- the about box even though
GTK has one of its own, because an icon, three labels and a button were there
already.

And check whether it is a **component**: the fields a form keeps needing that a
toolkit does not ship -- a combo you can type in, a select whose rows carry a
picture and a second line, a field that holds a set of words -- are one class
each in [`examples/composites`](../examples/composites), built from controls that
already exist. A component is public in the way that matters (it is placed from
the palette, its properties are in the `.form` and its events are
`<name>_<event>`), and it costs the runtime nothing. The one thing it cannot do
is be a single control for a program that never loads the project's sources --
which is the line between a component and the C below.

When it does belong in C, the shape is small. Any C change needs a rebuild
(`cmake --build build -j`); `.js` and `.form` files are data read at run time and
need none.

**And before adding it *here*, check whether it belongs outside the tree.** A
wrapper of a C library that most programs never use — an audio tag parser, a
device, a format — is a **native plugin**: a `<name>.so` inside a library
directory, written against `runtime/include/bta_plugin.h`, compiled by whoever
needs it and loaded by `uses` like the library itself. It reaches JavaScript
through a callback table, so it links neither the runtime nor QuickJS and costs
this tree nothing to keep. [plugins.md](plugins.md) is the contract and the
worked example.

## Adding a widget

Three things in one module, and nothing anywhere else:

**1. A build function** that fills the three GTK slots.

```c
static void build_meter(BtaWidget *w)
{
    w->inner = gtk_level_bar_new();
    w->gtk   = w->inner;        /* no wrapper needed */
    /* w->slot stays NULL: a leaf control */
}
```

Set `slot` only for a container, and to `gtk` itself when the widget *is* its own
slot (a box, an overlay). Wrap in a `GtkScrolledWindow` when scrolling is wanted,
and then `gtk` is the scroller while `inner` is the control.

**2. A properties array.**

```c
static const JSCFunctionListEntry meter_props[] = {
    JS_CGETSET_DEF("Value", meter_get_value, meter_set_value),
    JS_CGETSET_DEF("Max",   meter_get_max,   meter_set_max),
    JS_CFUNC_DEF("Pulse", 0, meter_pulse),
};
```

**3. One row in the module's registrar**, after its parent:

```c
BTA_CLASS("Meter", "Control", build_meter, meter_props, false)
```

That is the whole job. The new class is now constructible from JS, loadable from a
`.form`, serialisable, and present in the designer's palette-able set of types with
its properties editable in the grid — because none of those knows about any control
in particular.

One thing it does *not* do on its own: `testCssNode` in `tests/widgets` will fail
until the new class's CSS node is written into its table. That is deliberate.
`Style` puts a class on `w->gtk`, so that node is what a stylesheet has to name,
and the choice of outer widget is an API decision rather than an implementation
detail — see [widgets.md](widgets.md#styling-the-vocabulary).

Registration order is load-bearing: the loop that builds the prototype chain looks
each parent up by name, so a parent must be registered first.

## Adding a property

A getter and a setter, both going through `bta_this()`:

```c
static JSValue meter_get_value(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewFloat64(ctx, gtk_level_bar_get_value(GTK_LEVEL_BAR(w->inner)));
}

static JSValue meter_set_value(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    double     v;
    if (!w || JS_ToFloat64(ctx, &v, val))
        return JS_EXCEPTION;
    gtk_level_bar_set_value(GTK_LEVEL_BAR(w->inner), v);
    return JS_UNDEFINED;
}
```

Rules that follow from how discovery works:

- **Getter and setter** means designable and serialisable. **Getter only** means
  read-only, and the serialiser skips it automatically — which is correct, since
  the loader could never assign it back.
- **Validate in the setter and throw.** `JS_ThrowRangeError` with the offending
  value is what the property grid shows the user; the loader reports it with the
  file name.
- **Return the same type you accept.** The grid picks its editor from the current
  value's type, and a round trip that changes type (a number read back as a string)
  makes it flip editors mid-edit.
- **Only strings, numbers, booleans and arrays serialise.** A property whose value
  is a widget or an object works from code but will not survive a save.
- **Do not add a property that duplicates another**, or the file gets both.
  `Caption` is excluded by name for exactly this reason.

## A property with a closed set of values

Declare them next to the property, in the class row:

```c
static const char *meter_options(const char *prop)
{
    if (!strcmp(prop, "Style"))
        return "Continuous,Discrete";
    return NULL;
}

BTA_CLASS_ENUM("Meter", "Control", build_meter, meter_props, false, meter_options)
```

`PropertyOptions("Style")` now answers a list, the designer's grid offers a
drop-down, and it is inherited along the prototype chain like the property itself.
The list may be computed — `SourceEditor` asks GtkSourceView which languages it has —
so it cannot drift from what the setter accepts.

## A property that holds text a person reads

Say so in the class row, and three things start working at once:

```c
BTA_CLASS_TEXT("Meter", "Control", build_meter, meter_props, false, "Text")
```

- the `.form` loader looks that string up in `po/<lang>.po`, so the control is
  translated with nothing written in the file;
- the property grid offers a **design value** for it, and a sample to fill it with;
- the IDE's extractor collects it into the `.pot`.

`Widget.TextProperties()` publishes the answer, accumulated along the class chain
— a Button's are its own `Text` plus `Widget`'s `Tooltip` — which is where this
differs from `options`, where the first class that answers wins.

**A declaration may name a member.** `TableView` says `"Columns.Text"`, because a
column is an object carrying a heading, a width and an alignment and only the
first is prose. The loader translates that member and copies the rest untouched;
the IDE's extractor reads the same declaration and collects the same thing. Which
member is the class's to say and never a rule about the key's spelling: a rule
that collected every string in an object would put `"Right"` in the catalogue,
and a translator would then change what a keyword means.

There is a macro for each combination: `BTA_CLASS_TEXT`,
`BTA_CLASS_ENUM_TEXT`, and `BTA_CLASS_FULL` underneath them all. They use
designated initialisers, so a field added to `BtaClass` costs nothing in the
module tables — as long as its sensible default is the zero value. `available`
is the one that is not (see below), which is why `BTA_CLASS_FULL` fills it in
and there is an inner `BTA_CLASS_AT` beneath it.

**Get this wrong in the permissive direction and it is a disaster, not a bug.**
`SourceEditor` declares no `texts` on purpose: its `Text` is the source file being
edited, and a catalogue holding one line of it would rewrite the user's code —
silently, and only for whoever runs in that language. The same goes for anything
holding a name rather than prose (`Style`, `Icon`, `Font`, a `DatePicker`'s
`Format`). If in doubt, leave it out: an untranslated caption is visible, and a
translated identifier is not.

A read-only property needs no thought here — the loader could never assign it, so
`ListBox.Text` and `Terminal.Text` are excluded already.

## Adding a widget whose engine is optional at build time

Four of the runtime's dependencies are optional — sqlite, libsystemd, libsoup,
GStreamer — and a fifth, VTE, is optional *and* a widget's, which is the case
this section is about. `Terminal` is the one, and the mold is worth following
exactly, because getting it wrong is invisible on the machine that has the
dependency.

**The verbs refuse; the state answers.** That is the whole rule, and the reason
is the designer: the property grid reads every value of the selected control and
the serialiser reads them all again to save, so one getter or setter that threw
would make a build without the dependency one that cannot *open* a form holding
that widget. It happened with `Video`: a declared `Uri` is assigned like any
other property, and the load died with a dialog. **Optional at build time was
never meant to cost loading a form.**

So the widget still registers, still builds a GTK shape (`Terminal` without VTE
builds the same `GtkScrolledWindow` with a `GtkTextView` in it, so `CssNode()`
and the designer are unchanged), and every property round-trips. Put the calls
that really need the library behind a handful of static functions with two
implementations — `bta_media.c`'s `engine_*` and `bta_terminal.c`'s `term_*` —
rather than writing the class twice.

**And the class says so in its row**, which is what a palette reads:

```c
BTA_CLASS_OPTIONAL("Terminal", "Control", term_build, terminal_props,
                   false, TERM_AVAILABLE, "Exit,Link")
```

`BtaClass.available` defaults to true through every other macro. From JS it is
`Widget.Available(type)` for a caller that has a name and no control — the IDE's
palette, which filters its buttons on it — and a read-only `Available` on the
instance for a caller that has one. `Widget.Types()` keeps meaning *what classes
there are*, and `Widget.New` keeps building it, because a `.form` that already
holds one has to load.

**A build-time flag is not always the question, so a class can answer with a
probe instead.** `Terminal`'s answer is whether VTE was linked in, which is a
constant; `Video` needs GStreamer *and* the `gtk4paintablesink` element, and a
runtime built with GStreamer on a machine whose registry lacks the sink — a CI
runner — cannot play one. Such a class declares `BtaClass.probe`, a function
`bta_class_runnable` prefers over `available`:

```c
static bool video_available(void) { … }   /* cached: the answer cannot change */

BTA_CLASS_ENUM_PROBE("Video", "Control", build_video, video_props,
                     false, video_options, video_available, "Ended,Error")
```

**Cache the answer inside the probe**, and keep the work out of start-up: the
first `Widget.Available("Video")` reads GStreamer's plugin registry, which is
6 ms with its cache warm and **573 ms cold** (measured), so it is asked on the
palette's first question and never at boot. The class keeps everything else the
same — it constructs, draws, loads out of a `.form` and answers every property
on a machine that answers `false` — and the instance publishes the same answer,
read off the class row rather than recomputed, so the two cannot drift apart.

In CMake, `pkg_check_modules` **without** `REQUIRED`, a `BTA_HAVE_*` definition,
and a `message(STATUS …)` **either way** — the message is what a build reads back
to know which half it got, and the `no-vte`/`no-libxml` CI jobs grep for it so
that a runner which quietly grew the library cannot turn the job into a copy of
the ordinary one. Everything the library's headers bring goes inside the guard, `signal.h` and
`sys/wait.h` included: they do not exist on Windows either, which is the reason
VTE became optional at all.

## Adding an event

Connect a GTK signal and emit by name:

```c
static void on_meter_changed(GtkLevelBar *bar, gpointer user_data)
{
    BtaWidget *w = user_data;
    JSValue arg = JS_NewFloat64(w->ctx, gtk_level_bar_get_value(bar));

    bta_emit(w, "Change", 1, &arg);
    JS_FreeValue(w->ctx, arg);
}
```

`bta_emit` looks up `<Name>_Change` on the widget's form; a missing handler is not
an error. Free every `JSValue` you make.

**And declare it in the class row**, which is the part that is easy to forget and
invisible when it is:

```c
BTA_CLASS_ENUM("Meter", "Control", build_meter, meter_props, false,
               meter_options, "Change")
```

`BtaClass.events` is a comma separated list, **most specific first**, accumulated
along the class chain like `texts` — so a Meter answers `["Change", "MouseDown",
…]` and `EventNames()[0]` is the event the control is about. That head is what the
designer's double click writes and what *Form → Write handler* offers first.

Emitting an event a class does not declare still works — dispatch is by name and
nothing checks — which is exactly why it has to be said here: the event fires and
the IDE simply never offers it. There used to be a table of fifteen types in
`ide/modules/Designer.js` for this, and five controls were missing from it, so
`ColorButton`, `FontButton`, `Notebook`, `Switcher` and `RowList` all
double-clicked into a `MouseDown` nobody wanted.

**A component is extended the same way and says the same three things in the
class**, since this row and the two above it live in the class *table* and a
class of the project is not in it:

```js
class Stepper extends Component {
    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];
}
```

The walks read them at that class's own step, so the ordering and the
accumulate-versus-first-match difference are the same ones described here, and a
component extending a component works out whole. It was the exact failure the
table of fifteen was: a Stepper emitting `Change` on every keystroke published
`MouseDown` as its first event, and the IDE offered it.

Four requirements:

- **Pass the `BtaWidget` as the user data.** The finaliser unhooks handlers by
  data, and a handler that carries anything else survives its widget and reads
  freed memory.
- **If you connect a signal on something that is not `gtk`/`inner`/`slot`** — a
  `GtkTextBuffer`, a selection model — call `bta_widget_watch(w, object)`. The
  finaliser's sweep cannot find those on its own, and a handler that outlives its
  widget fires into freed memory. `bta_editor.c` and `bta_tree.c` are the two
  examples.
- **A handler that can consume** (a key, a close request) needs `bta_emit_on`,
  which returns the handler's value, and the GTK convention for "handled" as the
  return. The same call is how an event can be *asked* rather than raised —
  `TableView.Data` for a cell, `RowList.Filter` for whether a row is shown — where
  what comes back **is** the answer and a form with no handler has to mean the
  old behaviour: `JS_IsUndefined(r)` is "nobody said", not "no". Those run while
  GTK is measuring, so they are a lookup and nothing else.
- **Name it in the class row's `events`**, or the IDE cannot offer it. `tests/widgets`
  asserts that every placeable type answers something, so a control added with no
  events at all fails the suite; one whose *list* is short does not, and nothing
  but reading the row will say so.

## Asking a class instead of a control

A widget added the ways above is answerable **without building one**, which is
what a palette, a property grid and the extractor do:

```js
Widget.PropertyNames("Meter")        // every settable property, its own and inherited
Widget.Methods("Meter")              // its methods, from the prototype
Widget.EventNames("Meter")           // most derived first -- "Change" before Widget's
Widget.TextProperties("Meter")       // the `texts` of the row
Widget.PropertyOptions("Meter", "Style")   // the `options` of the row
Widget.Member("Meter", "Value")      // "Property" | "ReadOnly" | "Method" | ""
Widget.Signature("Meter", "Set")           // "(value)"
Widget.EventSignature("Meter", "Change")   // "(value)"
```

Nothing extra is declared for the first six: each answer is the walk the instance
method runs, started at the class prototype, so a class and a control cannot
disagree. A new method is a method because it is on the prototype; a new event,
prose property or enumerated value is answered because its row says so.
`Widget.Member` is the `in` question with the kind added — `ReadOnly` is the name
a `.form` refuses to load over, which is what `Ide.Check` reads to tell a
shadowed name from a refused one.

**The parameters are the one thing that has to be declared**, because a function
knows how many arguments it takes and not what they are called. It goes on the
line directly above what it documents, in the documentation's own spelling:

```c
/* Set(value) */
JS_CFUNC_DEF("Set", 1, meter_set),

/* Change(value) */
BTA_CLASS_ENUM("Meter", "Control", build_meter, meter_props, false,
               meter_options, "Change")
```

A method's above its entry, an event's above the class row that already lists
it — one line per event, because `events` is a comma separated list and a
parameter list has commas of its own. `tools/extract_signatures.cmake` turns
those comments into the table the runtime publishes, so there is no second
declaration anywhere; `tests/api.sh` fails on a method or an event that declares
none. A class written in JS states its own as `static Signatures`, and
`Widget.Signature` asks about a **method** where `Widget.EventSignature` asks
about an **event** — `ListBox.Select` is both, and only the caller knows which.

The type is resolved the way `Widget.New` resolves it — the runtime's table
first, then the project's own classes and its libraries' — and a name that is no
class, or a class that is not a widget, is refused. Abstract classes answer,
which is the question no control could be made to ask.

## Adding a global

`install_globals()` in `bta_runtime.c` for anything ambient;`bta_sys.c` for the
File/Dir/Exec/Dialog family. Anything held across an async boundary is a strong
reference the collector cannot see: register the job so `bta_sys_cleanup()` can
free it, or `JS_FreeRuntime` will abort on it at exit.

Prefer JS: if it can go in `runtime/js/rad.js`, it should. Serialisation lives
there for that reason, and so does every prototype convenience.

**And add a line to `GLOBAL_TABLES` (or `GLOBAL_VARS`) in `tests/api/Check.js`**,
naming the heading it is documented under in `llm/library.md`. That list is
explicit rather than inferred, because the same `JS_SetPropertyStr` shape builds
half the runtime's *return values* — a `File.Info` answer, an `Exec` handle, a
row. Until the line is there the new global's members are checked against
`controls.md` and reported as undocumented widget methods, which is the check
telling you the truth in the wrong words. `Text` (in `bta_paint.c`, beside the
painter whose measurements it matches) is the most recent one.

## The traps that have cost time

Each of these was a real bug in this repository.

| Trap | What happens |
|---|---|
| Adding a child without `bta_widget_adopt()` | The wrapper is collected while GTK still shows the widget; the next mouse motion reads freed memory |
| Removing a child without `bta_widget_release()` | The parent keeps the reference forever; a long-running application piles wrappers up |
| A signal on an object that is not the widget, without `bta_widget_watch()` | The finaliser's sweep misses it, and it fires after the widget is gone |
| Assuming a child's GTK parent is the slot | A `RowList` puts it in a row, a `Notebook` in a stack of its own (a `Switcher`'s pages *are* children of its stack, which is the slot) |
| A signal handler left connected at finalisation | GTK emits while tearing down (`switch-page`, `row-selected`) and calls into a freed `BtaWidget` |
| A `GtkDragSource` in the bubble phase | A `Button`'s own gesture claims the press, so the drag never starts |
| A `GtkGestureClick` on a widget that claims the sequence | It sees `pressed` and never `released`, in **either** phase — claiming is not about ordering. VTE does this for its text selection; use a `GtkEventControllerLegacy` |
| Trusting a count GTK fills in asynchronously | `GtkSourceSearchContext`'s `occurrences-count` answers `-1` until a background scan lands, so the number arrives frames after the search and only a flaky test can assert it |
| Asking `gtk_list_box_get_selected_row` in multiple mode | It answers `NULL`, so `Index` and `Text` go blank on a list with three rows selected |
| `X`/`Y` applied before the parent | The coordinates never reach a live `GtkFixed` |
| Reading `BTA_IS_FIXED` where the arrangement was meant | The macro says the widget is one of our surfaces; `bta_surface_is_fixed()` says which arrangement it wears. A `Panel` arranged `Horizontal` is still a `BtaFixed` |
| A `-symbolic` icon drawn with strokes | GTK's recolour forces `fill`, so it stays black on a dark theme |
| Trusting `gtk_icon_theme_has_icon()` | It says yes and hands back `image-missing`, or an SVG that renders blank |
| `Background` on a themed `Button` | The theme's gradient is a `background-image` and covers the colour |
| A second style provider at the same priority | Which one wins is the order they were added in, not anything you can read: `app.css` sits at `PRIORITY_APPLICATION` and the per-widget sheet one above it, on purpose |
| A menu label built from data | GTK's mnemonic parser eats the letter after a `_` |
| Returning `NULL` from `GtkTreeListModel`'s child-model callback | That node is a leaf forever, and children added later never appear |
| Measuring in the same frame | `OriginIn`, `PickAt` and an unset `Width` all read an allocation that does not exist yet |
| Keeping something about a widget as an own property of its wrapper | It is not a property of the control, and it is counted as one: `--strict` refuses it, `PropertyNames()` and `in` report it. The six the runtime kept that way are fields on `BtaWidget` now -- add one there, report it in `widget_gc_mark`, free it in the finaliser, and reach it through `bta_widget_note()` |
| A `JSValue` on the struct that `widget_gc_mark` does not report | A cycle that never collects, or -- freed in the finaliser and not marked -- `Assertion list_empty(&rt->gc_obj_list) failed` at teardown. `tests/asan.sh` is what exercises it |
