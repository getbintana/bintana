# Architecture

## The pieces

```
main.c            argv -> project directory
bta_runtime.c     interpreter setup, globals, project loading, the GTK main loop
                  -- and the console one, for a project that declares `main`
bta_widget.c      the base Widget: geometry, Style and colours, events, drag and
                  drop, the class table machinery, lifetimes
bta_controls.c    Form, Container, Panel, Label, Button, Image, TextBox,
                  CheckButton, ToggleButton, Switch, ListBox, ComboBox,
                  SpinBox, Slider, ProgressBar, DatePicker, Calendar,
                  ColorButton, FontButton
bta_layout.c      Split, Frame, Overlay, RowList, Scroller, Flow
bta_notebook.c    Notebook
bta_switcher.c    Switcher (GtkStackSwitcher over a GtkStack)
bta_paint.c       DrawingArea (GtkDrawingArea) and Painter (cairo)
                  ...and in bta_runtime.c: `uses`, the library search path
bta_text.c        Editor (abstract) and TextEditor (GtkTextView)
bta_editor.c      SourceEditor (GtkSourceView), on top of Editor
bta_terminal.c    Terminal (VTE, optional: BTA_HAVE_VTE)
bta_tree.c        TreeView (GtkListView + GtkTreeListModel)
bta_menu.c        menus, as GMenu models wired to actions
bta_locale.c      po/*.po, Locale, the plural-form expression evaluator, and how
                  the desktop spells a number, a date and an amount of money
bta_decimal.c     Decimal: exact base-10 arithmetic, with the operators
bta_form.c        the .form loader
bta_sys.c         File, Dir, Exec, Dialog, timers
bta_plugin.c      native plugins: the host table a library's `.so` is handed,
                  and the loader that finds one in a library directory
                  (runtime/include/bta_plugin.h is the whole contract)
runtime/js/rad.js the JS half, baked into the binary
```

`vendor/quickjs` is quickjs-ng v0.16.1, built as a static library, and it
carries **four local patches**: the arithmetic hook that gives `Decimal` its
operators, `js_atod` so `JSON.parse` does not read the locale's decimal comma,
the refusal message that names the property it would not add, and the
debugger's hook with its six readers. All four are in
[`AGENTS.md`](../AGENTS.md#the-four-patches-in-vendor), each with what dropping
it costs. GTK4 (4.10 or newer) and GtkSourceView 5 come from pkg-config and are
required; sqlite3, libsystemd, libsoup-3.0, gstreamer-1.0 and VTE come from
pkg-config and are not.

`rad.js` is turned into a C string at build time (`tools/embed_text.cmake`
produces `bta_prelude.h`) and evaluated once, after the native classes are
installed as globals. The rule for what goes where: **anything expressible in JS
belongs in `rad.js`**, and today that means serialisation, the `Caption` aliases,
`Form.Controls`, `PropertyNames()`, `Record`/`Field`, `Dictionary`, `Regex`,
`Declared`/`Fill`/`SetDesign`, and building a tree from a `.form` node.

### What rad.js keeps for itself

`rad.js` runs **before** `close_hatches()`, and it holds on to the reflection that
is about to be taken away:

```js
const defineProperty = Object.defineProperty;
const prototypeOf    = Object.getPrototypeOf;
const ownNames       = Object.getOwnPropertyNames;
const ownDescriptor  = Object.getOwnPropertyDescriptor;
```

That is not a loophole, it is the arrangement: **discovering what an object can be
asked for is the runtime's job, and the answer it publishes is
`PropertyNames()`.** The poking underneath is an implementation detail, and the
names for it go with the rest of the curated surface.

Two things depend on it. The serialiser walks prototype chains, which needs
`prototypeOf`/`ownNames`/`ownDescriptor`. And `Record` *writes* accessors with
`defineProperty`, which is what lets a field be declared in one line and still be
an ordinary property — an application cannot do that for itself, and does not need
to.

`Regex` and `Dictionary` hold what they are built out of the same way, and for
the same kind of reason:

```js
const RegularExpression = RegExp;
const ownKeys           = Object.keys;
const objectProto       = Object.prototype;
const hasOwn            = objectProto.hasOwnProperty;
```

For `Dictionary` this is already load-bearing: **`Object` is empty** after
`close_hatches()` — every static taken, and the four `__*__` accessor hatches off
the prototype with them — so `ownKeys` is the only road left to the keys of a
plain object, and it is in here. `Object.prototype` cannot be deleted, being
non-configurable, and the serialiser walks up to it; that one is a capture for
tidiness rather than survival.

`RegExp` is the one still installed, and taking its name would buy little: `/x/g`
is syntax and produces one regardless, so only `new RegExp(…)` would go. The
capture is what makes that a one-line change in `close_hatches()` if it is ever
worth making — exactly as capturing `setInterval` was for `Timer`.

It is also what makes a record's values unreachable. They live in a `#private` bag
declared inside `Record`'s own class body, so the accessors `rad.js` generates can
read it (a private name is lexically scoped to the class body, not to an instance)
while nothing outside can — there is no `_Name` to assign around the setter, and
no way to replace the accessor either. That second half was not true for a while:
`defineProperties` and `__defineSetter__` both survived the first pass at
`Object`, and either could put a setter that validates nothing where a field's own
had been. The
one door past the setters is `Record.Load`, which a file needs: a row that no
longer satisfies today's rules has to be readable, or it can never be corrected.
That door is a static **private** method's worth of access, published as `Load`
alone.

## Boot sequence

```
main()                       first bare argument is the project directory
  bta_app_new(dir)           build_context(): chosen intrinsics only
                             reads project.json: name, startup, sources
  bta_app_run()
    gtk_application_new(NON_UNIQUE)
    g_application_run()
      on_activate()
        register_app_icons()   <project>/icons into the icon search path
        install_globals()      print, console, Application, Message, the
                               libraries' plugins (<name>/<name>.so), widget
                               classes, menus, sys, then rad.js, then
                               close_hatches()
        eval each source       in the order sources gives, else every *.js
                               under the project, sorted by path
        bta_lookup_global(startup)   a bare name from the global lexical
                               scope, a qualified one by walking properties
        new <startup>()        the constructor asks Widget.TypeName for the
                               name the class goes by, and loads <Class>.form,
                               found by that name anywhere in the tree
        .Show()                fires Form_Open, then presents the window
    bta_sys_cleanup()
    bta_widgets_cleanup()
    JS_FreeContext / JS_FreeRuntime
```

`G_APPLICATION_NON_UNIQUE` is deliberate: two `bintana` processes are two
applications, so the IDE can run a project without the child attaching itself to
the IDE's own instance.

A project that declares `main` instead of `startup` takes the other branch out of
`bta_app_run()`, and it is a short one:

```
  bta_app_run()
    run_console()            no GtkApplication, no activate, no GTK at all
      install_globals()      the same globals: a console project is not a
                             smaller language, only one with no display
      eval each source
      <main>()               called with no arguments
      g_main_loop_run()      only while bta_sys_pending() > 0 -- children
                             running, timers armed, files watched
```

**The display is what the branch is about.** `install_globals` reads
`gtk-decoration-layout` from `GtkSettings` and `register_app_icons` registers the
project's icons against the default display, and both answer nothing when there is
no display rather than failing — so the only thing a console project is missing is
the ability to build a widget. That it never initialises GTK is the point rather
than an economy: a runner that decides whether the suite needs a virtual display
cannot be a program that needs one to start.

Class declarations at the top level of a `.js` file land in the **global lexical
scope**, not on `globalThis`, so a plain property read misses them.
`bta_lookup_global()` falls back to evaluating the bare identifier, which is what
makes "every class is visible everywhere, no imports" work.

## One JSClassID, a prototype chain

Every widget object shares a single `JSClassID` (`bta_widget_class_id`). What
makes a `Button` a `Button` is its **prototype**, not its native class. The
hierarchy is assembled in one loop in `bta_widgets_init()` from a table that each
module contributes rows to via `bta_register_classes()`:

```c
BTA_CLASS("Button", "Control", build_button, button_props, false)
/*         name      parent     build fn      properties   is_form */
```

Registration order is load-bearing: a parent must be registered before its
children, because the loop looks the parent's prototype up by name.

```
Widget ├── Control ── Label Button Image TextBox CheckButton
       │              ToggleButton Switch ListBox ComboBox SpinBox Slider
       │              ProgressBar DatePicker Calendar ColorButton FontButton
       │              TreeView TableView Terminal DrawingArea
       │              Editor ── TextEditor SourceEditor
       └── Container ── Form Component Panel Frame Split
                        Notebook Switcher Overlay RowList Scroller Flow
```

`Form` and `Component` are the two classes whose *subclass* loads a `.form` of
its own -- that is what a component is: a form that is not a window. Its children
are bound to it, so their events are its own; the host that adds it renames and
rebinds the component itself, which is what makes its `Emit` arrive as
`Name_Event` on the host.

`Widget` and `Control` and `Container` are real, instantiable-by-inheritance
classes with no `build` function of their own; constructing one throws
("abstract"). Subclassing works because the constructor honours `new_target`:
`class Form1 extends Form` gets `Form1.prototype`, which is what allows a user's
form class to hold the handlers.

## The object model

Each JS wrapper carries a `BtaWidget` in its opaque slot:

```c
struct BtaWidget {
    GtkWidget *gtk;    /* outermost: what the parent lays out */
    GtkWidget *inner;  /* the control proper (differs when wrapped in a scroller) */
    GtkWidget *slot;   /* containers: where children go. NULL for a leaf */

    JSContext *ctx;
    JSValue    form;   /* owning Form, duplicated -- reported via gc_mark */
    JSValue    self;   /* own wrapper, BORROWED */
    char      *name;   /* the "Button1" in Button1_Click */

    int x, y, w, h;    /* what the .form asked for, before GTK rounds it */
    ...
};
```

Three widgets and not one, because a `RowList` is a `GtkScrolledWindow`
(`gtk`) wrapping a `GtkListBox` (`inner`, and also `slot`). The parent lays out
`gtk`, properties usually act on `inner`, children go into `slot`.

**A `Panel` is one widget**: `gtk`, `inner` and `slot` are the same `BtaFixed`,
and `Arrangement` swaps its **layout manager** rather than the widget. It was two
boxes once -- an outer one that stayed put and an inner slot that got replaced --
because `gtk` is what the parent lays out and something had to survive the swap.
GTK4 separates widget from layout, which is the thing that made the holder
unnecessary; and the holder was not free, because a `Style` class landed on it
while the children were one box further in, so every theme rule written against a
direct child silently missed (`Style = "linked"` rendered identical to no class at
all).

The back-pointer runs the other way through `g_object_set_data(gtk,
BTA_WIDGET_QUARK, w)`, so any GTK child can be mapped back to its wrapper. The
slot is tagged too: a child's GTK parent is its owner's *slot*, not the owner's
own widget, and `Delete()` has to find its way back up.

`Children` walks `slot`'s GTK children and maps each back to its wrapper.
`bta_slot_child()` looks *through* a `GtkListBoxRow`, because a `RowList` puts
every child in a row of its own.

## Events dispatch by name

```c
bta_emit(w, "Click", argc, argv);
```

looks up `<w->name>_Click` on `w->form` and calls it. Nothing is registered
anywhere: a handler added to the class at any point is found the next time the
event fires, and a missing handler is not an error. A form's own events use the
literal name `Form` (`Form_Open`, `Form_Close`) whatever the class is called.

`bta_emit_on()` is the same for event sources that are not widgets — menu items.

Every widget gets mouse, motion and key controllers in the **bubble** phase, so a
control's own behaviour happens first and these are additive: a `Button` still
clicks while also reporting `MouseDown`. `KeyPress` is the exception that can
consume: returning `true` stops propagation, which is how the designer uses the
arrow keys without the focus walking away.

The drag source is the one controller in the **capture** phase, and it has to be:
a `Button`'s own gesture claims the press, so a source that only sees what is left
over never reaches the drag threshold.

## What a call across the boundary costs

Measured through the existing API, 200,000 iterations each, QuickJS, no display.
It is here rather than in a plan because every batching decision in this runtime
turns on it, and the answer is not the one people expect:

| | per call | in a 16 ms frame |
|---|---|---|
| a trivial getter (`Focused`) | 290 ns | ~55,000 |
| a two-argument method (`Move`) | 465 ns | ~34,000 |
| a setter taking a string (`Text`) | 505 ns | ~32,000 |
| a method returning a fresh object (`Bounds`) | 1,570 ns | ~10,000 |
| **pure JS: filling an array of two numbers** | 405 ns/element | ~39,000 |

The last row is the one that decides API shapes. **Filling an array to hand to a
batched call costs almost what making the calls would have**: QuickJS is an
interpreter, so writing two array slots is the same order as a trip into C.
`Painter.Polyline(points)` is worth about **2x** over a loop of `LineTo`, not the
hundredfold one imagines, and the honest budget either way is *tens of thousands*
of primitives a frame — far more than any drawing a person can read.

The other row that shapes an API is `Bounds()`: a call that allocates a fresh
object is three to five times the rest. That is why `Painter.TextWidth` returns a
number, why the `Draw` event **carries** the surface size instead of making the
handler ask for it, and why `OriginIn` returns two numbers rather than a point.

## Properties, discovered and never listed

A property is a `JS_CGETSET_DEF` on a class's props array. Nothing else knows it
exists — not the loader, not the serialiser, not the designer:

- **The loader** applies `properties` from a `.form` as ordinary JS assignments,
  so the value goes through the real setter and gets the real validation.
- **The serialiser** (`rad.js`) walks the prototype chain for accessors that have
  **both** a getter and a setter, and writes those whose value differs from a
  freshly constructed control's. A read-only accessor is excluded automatically,
  because the loader could never assign it back.
- **The designer** asks `PropertyNames()` — the same discovery — and picks an
  editor per row from the value's type.
- **A property with a closed set of values** declares them in its class row
  (`BTA_CLASS_ENUM` plus a one-line `options` function), and
  `PropertyOptions(name)` hands the list to whoever is editing. The list may be
  computed: `SourceEditor` asks GtkSourceView which languages it has, so it cannot
  drift from what the setter accepts.

Hence the invariant the whole design rests on: **add a property in C and it is
designable, serialisable and editable, with no other change anywhere.**

## Lifetimes

The JS wrapper **owns** the `BtaWidget`. GTK holds its own reference to the
`GtkWidget` (`g_object_ref_sink` at construction), so the two lifetimes are not
the same, and that asymmetry is the source of the only two crash classes this
codebase has had:

**1. A child only GTK holds gets collected.** Every path that adds a child must
call `bta_widget_adopt()`, which does the two things that matter: appends the
child to the parent's `__children` array (so JS keeps it alive) and binds
it to the form (so its events dispatch).

That array, and five more notes the runtime keeps about a widget, live on the
`BtaWidget` struct and are reported by `widget_gc_mark`. They used to be own
properties of the wrapper with the enumerable bit off -- invisible to everything
that *looked*, and not invisible to the count of what the widget has, which is
what honest introspection and `--strict` both read. `__declared`, `__children`,
`__menus` and `__actions` are still readable from JavaScript under those names,
as accessors on `Widget.prototype`; see [`strict-plan.md`](strict-plan.md).

`Container.Add()` adopts; `Notebook.Append()` and `SetTabLabel()` did not, and a
garbage-collected page left a dangling pointer behind that the next mouse motion
read.

Removing a child has to do the inverse: `bta_widget_release()` drops the parent's
reference. `Container.Delete()`/`Remove()` go through it, and so does
`Notebook.Remove()` -- which for a while did not, so an IDE that opens and closes
tabs kept every wrapper it had ever shown.

**2. A finalised widget is still reachable from GTK.** The container usually holds
the last reference, so the `GtkWidget` outlives its wrapper — and GTK emits
signals *while being torn down*: a notebook removing a page emits `switch-page`,
a list box emits `row-selected`. At shutdown that runs with siblings already
freed. `widget_disconnect_all()` in the finaliser unhooks every handler by `data`
on `gtk`/`inner`/`slot`, on their event controllers, and on anything the module
registered with `bta_widget_watch()` — a `GtkTextBuffer`, a selection model: the
objects that carry handlers of ours without being the widget.

**...and so is everything under it.** Unhooking a widget as it is finalised is
only half of that: the wrapper's reference is the one that keeps a window alive,
so dropping it disposes the whole tree — and `gtk_window_dispose` moves the focus
off whatever had it, which emits `focus-leave` on a child that is still hooked
up, whose own wrapper has not been finalised yet, and whose `w->form` is the
object being freed in this very cycle. A cycle is freed in no order anyone
chooses, so the children cannot be made to go first; what can be arranged is that
none of them is still able to speak. `widget_disconnect_tree()` walks the GTK
tree and unhooks every wrapper under it before the unref, and the finaliser
clears the `BTA_WIDGET_QUARK` back-pointer on the **slot** as well as on `gtk` —
the slot outlives the wrapper exactly as `gtk` does, and a walk that found a
stale one there would read freed memory. Found by the IDE's About dialog, which
is the smallest thing that has a focused button and outlives everything else.

Two more rules, both in `AGENTS.md` because they are easy to break:

- Controls point back at their form, so the object graph has cycles. Report the
  edge in `gc_mark` or forms never get collected.
- `JSValue`s held from C across an async boundary (`Exec`, `Dialog`, timers, menu
  actions) are strong references the collector cannot see. Free them on **every**
  exit path, including runtime teardown while a child still runs —
  `JS_FreeRuntime` aborts on anything left alive. See `bta_sys_cleanup()`.

## Layout: two models in one tree

`Arrangement` decides how a container places its children:

- `"Fixed"` — the slot is a `BtaFixed`, and `X`/`Y` are literal pixels. This is
  the RAD model, and what a form a user draws wants.
- `"Horizontal"` / `"Vertical"` — the slot is a `GtkBox`, children follow the
  window, and `X`/`Y` stop meaning anything (the serialiser omits them for a
  child of a non-fixed parent).

Setting it swaps the **layout manager** of one and the same widget, so the
children never move and it can be set at any time, as often as you like: a
container that already holds a form's worth of controls turns into a row and back,
which is the one thing the property exists for. Containers that are not one of our
surfaces (`Split`, `Grid`, `Flow`, `Overlay`, `RowList`, …) already are their
arrangement and refuse the change outright.

### Anchoring: what a fixed surface does with the slack

`GtkFixed` places its children once and stops there, so a form drawn at 420×260
kept every control where it was put when the window grew. `BtaFixed`
(`runtime/src/bta_fixed.c`) is a `GtkWidget` of our own with a `measure()` and a
`size_allocate()`, which is the supported way for a GTK4 widget to say what
"resize" means — and it lets each child declare the answer with `HAlign`/`VAlign`:

| | on the surface being resized |
|---|---|
| `Auto` (default) | stays put, the same as `Start` |
| `Start` | keeps the distance to the left/top edge — stays put |
| `End` | keeps the distance to the right/bottom edge — slides |
| `Fill` | keeps both — stretches |
| `Center` | keeps the proportion — moves half the slack |

Those are GTK's four words on purpose: they mean the same thing here that they
mean in a box, so there is one vocabulary and not two. They are also the four
cases WinForms spells as combinations of `Anchor` edges — kept as a **single
value** rather than a flag set, because a property with one value out of a list
is already a drop-down in the designer's grid and a flag set would have needed
an editor of its own.

The reference size is the surface's **first real allocation**: at that moment
nothing has moved yet, so it is the origin every anchor is measured from.

Everywhere else the same property is handed straight to GTK's `halign`/`valign`,
which is where the four words come from -- but never on a surface, where GTK
would align the widget *inside* the rectangle `BtaFixed` just worked out and a
control drawn 200 wide would come back its natural width. `widget_apply_align()`
picks which of the two applies, and is re-asked on every adoption and every
relayout because a control changes containers: `Arrangement` alone turns the row
under it into a surface.

### The design size and the floor are two different numbers

On a stretched axis, `Width` is **not** a minimum. Its size is derived from the
container's, so the number in the `.form` is where the anchor's gaps were
measured from and nothing else — `bta_widget_relayout` requests the control's
*floor* on that axis rather than its drawn size, and requests the drawn size as
before on an axis that does not stretch. Everything downstream follows from
that one asymmetry: `measure()` adds up floors without having to know which
child is which, and a window stops having the size its form was drawn at as a
hard minimum.

The floor is `MinWidth`/`MinHeight` when the control declares one, and what GTK
says the control needs when it does not. Getting the natural minimum is *why*
the request is not the drawn size: `gtk_widget_measure` always folds the size
request in, so a control that requested its design size could never report
anything smaller.

Declaring one is how a window says how small is too small — the IDE's own
`Split` carries `MinWidth`/`MinHeight`, and that is what stops `MainForm` from
being dragged down to nothing.

### A surface that does not anchor

`Container.Anchored` is on by default and off for a **drawing board**: a surface
whose size is not anybody's design size. Off, the slack is taken to be zero, so
no anchor does anything and every child sits exactly where it was drawn.

The designer's canvas is the case it exists for. `Surface` is reused across
every form opened, so the size it latched is whoever was drawn on it first —
anchoring it would show the next form resized to that.

### Not enough room: `Scroller`

Every other container answers "there is not enough room" by making its parent
bigger. That is right for a window and wrong for a view onto something whose
size is not the window's business, and getting it wrong is loud: a `GtkPaned`
that cannot give a child its minimum **hands it the space anyway**. The
designer's canvas demanded the full width of the form being drawn, so dragging
the divider to widen the property panel pushed the canvas 120px *outside* its
own half of the split and over that panel.

`Scroller` is the other answer — a `GtkScrolledWindow` around an ordinary fixed
slot, so `X`/`Y` mean there what they mean everywhere. What the split holds is
the **view**, whose size is the room there is; the **board** inside it is as big
as what is on it, and the difference scrolls. That is what makes the IDE's own
1100-wide `MainForm` editable in a 520-wide canvas: cutting it off at the edge
would have left most of it unreachable, and the runtime had no third option
until this existed.

The designer's canvas is the case it exists for. `Surface` and `Glass` are
stretched to whatever room the IDE has — 520 wide for a form drawn 320 wide —
so anchoring them showed each control resized to *that*: a `TextBox` declaring
380 drawn at 504, on a canvas whose whole job is to agree with the coordinates
being edited.

It is kept on the container's `BtaWidget` as well as in the layout manager,
because a manager that has just been swapped in has nowhere to read it from —
including on the way back from a box, which cannot hold it at all.
`cont_set_arrangement` carries it over.

Positions come from each child's `BtaWidget` — already the authority, since
`GtkFixed`'s per-child layout data only mirrored it. Not keeping that second
copy is why `Raise`/`Lower` is an ordinary sibling reorder *here* rather than
taking every child out and putting it back, and why attaching is a bare
`gtk_widget_set_parent()` with no coordinates to hand over.

### Three functions, one per question a container is asked

`bta_container_attach`, `bta_container_detach` and `bta_container_reorder` live
side by side in `bta_widget.c`, each a branch per kind of slot and each the
inverse or the sibling of the others. That is not tidiness: every defect this
area has had came from one of them knowing something the other two did not. A
`GtkGrid` with no detach branch could be filled once and never rebuilt; a
`GtkOverlay` unparented rather than cleared through the property holding it left
GTK believing the container was full; `Raise`/`Lower` moving a sibling directly
left an overlay's base filling while painting over its own floaters. So the three
questions — put a child in, take it out, move it among the others — are answered
in one place and by one vocabulary, and `Raise`/`Lower` and the designer's drag
are callers of the third rather than implementations of it.

**`Container.Placement` is that same knowledge published**: `Coordinates`,
`Order`, `Layers`, `Pages`, `Halves`. Only the runtime knows what a slot is, and
an editor that keeps its own table of which class is which will drift from it —
the IDE's did, which is how three containers reached its palette classified as
rows. Read-only, so nothing serialises it: it is a fact about the class and its
arrangement, not a property of the file.

`Width`/`Height` are `gtk_widget_set_size_request`, i.e. a **minimum**. `w->w` and
`w->h` remember what was asked for, so the getters report the request rather than
GTK's rounding; with nothing requested they fall back to the real allocation —
which is why anything that measures needs a frame to have passed first.

## The two things GTK4 removed that had to be rebuilt

- **Menus are not widgets.** A GTK4 menu is a `GMenu` model wired to actions, so a
  menu item is its own small object (`BtaMenuItem`) rather than a `BtaWidget`.
  That is also what makes an accelerator work and show up beside the label, and
  what makes `Enabled = false` kill the shortcut along with the item.
- **`GtkFileChooserButton` is gone**, so `TextBox.Icon` plus `IconClick` covers it:
  a field that shows the path and an icon that opens the dialog says the same
  thing and also lets the path be typed.
