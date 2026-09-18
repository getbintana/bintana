# Strict checks: what had to move first was the runtime's own bookkeeping

**Built, all five stages.** `bintana --strict` makes a control refuse a property
its class does not have, so a misspelt name throws where it is written instead of
doing nothing forever; the IDE offers it as *Project → Strict checks while
running*. The idea was one line, and measuring it turned a one-line feature into
a small cleanup with the check as its proof -- which is what this document is
mostly about, because the cleanup is worth more than the flag.

It is the runtime's half of the answer
[`Ide.Live` and `Ide.Check`](../ide.md#the-names-a-file-uses-checked-while-it-is-written)
give statically. Those read what the `.form` describes; this catches what no file
describes, in the act, with a traceback naming the line.

## Not `Object.freeze`, and not only because it is gone

`Object` is empty in this runtime and every static was removed on purpose -- see
[`llm/language.md`](../llm/language.md). Putting `freeze` back would reverse a
decision that is written down.

It is also the wrong tool. `freeze` makes existing own properties
**non-writable**; what is wanted is `preventExtensions`, which refuses *new*
names and touches nothing else. A widget's properties are accessors on its
prototype, so `this.Lbl.Text = "x"` goes through a setter and creates nothing,
while `this.Lbl.Txt = "x"` is an attempt to add an own property -- which is
exactly the one to refuse.

And it belongs in **C**, where widgets are built: no `Object` static is needed,
every widget gets it with nobody writing a line, and it is a mode that is off by
default. QuickJS publishes `JS_PreventExtensions`.

## What makes it work: strict mode is already forced

In sloppy mode an assignment to a non-extensible object fails **silently**, which
would make the whole thing pointless for any file without the pragma. It is not
sloppy. Measured, with a `.js` carrying no `"use strict"` at all and assigning to
an undeclared name:

```
MODO ESTRICTO FORZADO -> noDeclarada is not defined
```

Every project source is evaluated with `JS_EVAL_FLAG_STRICT`
(`bta_runtime.c`, both the debug and the ordinary branch), so the refusal
**throws**, for every project, pragma or not.

> `llm/language.md` said *"`use strict` at the top of a `.js` is the habit in
> this repository. Nothing requires it."* The second sentence was wrong and is
> corrected with this document: the runtime requires it, and the pragma is
> redundant.

## The obstacle, measured: the runtime wrote on the widgets too

Preventing extensions at construction would have broken the runtime before it
caught anybody's typo, because the runtime left its own notes on a widget as
ordinary own properties -- and most were created **late**. `__columns` was
written when an application assigned `Columns`, which is application code at any
moment.

| note | who wrote it | where it is read | when |
|---|---|---|---|
| `__columns` | `bta_table.c`, on `Columns =` | four places in the same file | whenever `Columns` is assigned |
| `__painter` | `bta_paint.c`, `PAINTER_PROP` | the paint path | **on the first frame**, later than any of the others |
| `__children` | C, `JS_DefinePropertyValueStr` | `bta_widget.c` | at build |
| `__menus`, `__actions` | `bta_menu.c` | the serialiser, `Form.Menus` | at build |
| `__declared` | **both**: `bta_form.c` defines and writes it, `rad.js` writes it too | `rad.js` | at build, and on every `Fill()` |
| `__design`, `__item` | `rad.js`, through `hiddenBag` | `rad.js` | designer only |

**Five in C, two in `rad.js`, one shared** -- which is not how this table read
when it was written, and the three corrections are worth keeping rather than
quietly fixing:

- **`__painter` was missing entirely** (`bta_paint.c`), and it is the one that
  mattered most to the staging: it was created *on the first frame a
  `DrawingArea` paints*, later than `__columns`, so stage 3's *once it is built*
  would not have been late enough and the mode would have thrown on the first
  repaint.
- **`__declared` is not `rad.js`'s alone.** C defines and writes it too, so a
  `WeakMap` private to `rad.js` would have made those writes invisible to the
  readers next to it. It could not move in stage 1.
- **`__field` was in this table and is not a note on a widget at all** -- it is
  the flag on the plain descriptor `makeField` returns, read as a type test for
  `Field.List` and `Field.Record`. It never touches a widget and never went
  through `hiddenBag`, so `preventExtensions` does not affect it and a WeakMap
  keyed by a widget would have had no widget to key on. (`__type` is rightly
  absent for a different reason: it lives on the constructor.)

They were **invisible by arrangement**: a `__` name, the enumerable bit left off,
and -- as `bta_table.c` put it -- *invisible to the serialiser besides, which
discovers accessors and not own properties*. What this did was stop arranging it
and make it true.

> **One of the seven silences left this plan while it was being written, and it
> turned out to be three.** A control whose name is a *read-only* member of
> `Form` was lost without a word, and the reason was not the language:
> `bta_form.c` bound it with `JS_SetPropertyStr` and did not look at the answer,
> a hundred lines under a loop that checks its own. It looks now, and the form
> refuses to load, saying which control and why.
>
> Then closing the [menu gap](completion-plan.md#stage-1----the-lookups-this-ide-does-without-any-of-it-built)
> in the IDE's checks made the same question worth asking of the other two
> blocks a `.form` binds by name -- and `bta_menu.c` had the identical line
> twice, for a menu item and for a command, neither of them looking either. A
> menu item called `Actions` bound to nothing, `MnuActions_Click` never fired,
> and `this.MnuActions` answered the *form's* action list. Both look now.
>
> Each was **one line** and none of them needed what is below -- which is worth
> knowing: not every silence here wants the cleanup. What the fix did need was
> an ordering: **nothing is wired until the name is ours.** A refused bind frees
> the wrapper, the wrapper owns the item, and an action already added to the
> group would be left holding a handler pointing at freed memory -- so the
> action is built *after* the bind rather than undone on failure.

### Why they lived on the object, and why that argument had moved

The reason was written at `bta_table.c`, and it is a good one:

> keeping a `JSValue` in C is a strong reference the collector cannot see, and
> `JS_FreeRuntime` aborts on anything still alive
> (`Assertion list_empty(&rt->gc_obj_list) failed`, which is how this was found)

True for a value **nobody marks** -- and the widget class has a mark function.
`widget_gc_mark` already reported two C-held `JSValue`s, `w->form` and `w->menu`,
and had since controls needed to point back at their form. So the pattern that
comment ruled out was already in the tree, working, in the same struct. What it
rules out is holding a value *without* marking it, which is a different thing.

## Where they went

| | to |
|---|---|
| the six C writes -- `__columns`, `__painter`, `__children`, `__menus`, `__actions`, `__declared` | a field on the struct, reported in `gc_mark` and released in the finalizer -- `w->form` and `w->menu` are the shape |
| the two that are `rad.js`'s alone -- `__design`, `__item` | a `WeakMap` in the module's own scope, keyed by the widget |

`WeakMap` was checked and is there (`Map` and `Set` too; `Symbol` and `eval` are
not). A `WeakMap` is private to the file that declares it, invisible to
`for...in`, to `Dictionary.Keys`, to the serialiser and to `preventExtensions`,
and it lets the widget go when the widget goes.

**No caller changed**, which is what made it a cleanup rather than a rewrite. The
methods that reach these notes already existed -- `Declared()`, `SetDesign()`,
`DesignValue()`, `Item`, `SetItem` -- and the four names JavaScript still reads
(`__declared`, `__children`, `__menus`, `__actions`) are now **accessors on
`Widget.prototype`**, answering from the struct. An accessor on a prototype is
not an own property of anything, so `rad.js` goes on writing `widget.__declared`
exactly as it did and `Form.Menus` reads `this.__menus` exactly as it did. What
moved is where the value sits, not how anybody asks for it.

Those accessors are in a `JSCFunctionListEntry` table of their own,
`widget_notes`, and **it is the one table in the tree that is not published
surface**. `tests/api.sh` reads every such table and demands a documented row for
each entry; `tools/typings` writes every entry into `bintana.d.ts`. Both skip
this one by name and say so where they do -- an exception written down twice
rather than a table hidden from a scanner.

## What it bought beyond the check

**A widget's own properties are now exactly its properties.** That is worth more
than the strict mode itself, and it was the reason to do this even if the flag
had never been built:

- `preventExtensions` needs nothing pre-created; it simply works.
- the introspection that answers *what does this control really have* -- the `in`
  operator and `PropertyNames()`, which is what the completion and both name
  checks read -- describes the widget and nothing else. See
  [completion-plan.md](completion-plan.md).
- and the invisibility stopped depending on three separate arrangements holding.

Which turns the feature around: **the strict mode is not the point, it is the
test.** If anything internal is still hanging off the object, the first run with
the flag on says so -- which is what `tests/widgets` now does on every run.

## What was done

1. **`__design` and `__item` moved to a `WeakMap`** in `rad.js`. No C, no flag,
   no behaviour change; the suite is the proof. **Two and not four**: `__field`
   is not a widget note, and `__declared` is shared with C.
2. **The six that C writes moved onto the struct** -- `__columns`, `__painter`,
   `__children`, `__menus`, `__actions` and `__declared` -- reported in
   `widget_gc_mark` and released in the finalizer. `__declared` landed here
   rather than in stage 1 because both sides write it, and whatever holds it has
   to be reachable from both.
3. **`JS_PreventExtensions` on a control once it is built**, behind `--strict`.

   **And *once it is built* turned out to be a simple moment, because stage 2
   made it one.** This document said it would have to mean *after the first
   frame*, since `__painter` arrived then; with the painter on the struct, no
   note arrives late any more. The moment is the end of the loader's work on a
   node -- after the class is built, its own `.form` has loaded, its properties
   are applied and its children are in, which is after a component's constructor
   body has run.

   **A form is never sealed**, which is the one line of judgement here and is not
   in the original staging. A control is a leaf the application configures by
   property; a form is the application's own object, and `Form_Open` assigning
   `this.anything` is what every program in this tree does. Menu items and
   commands are sealed with the controls.
4. **A test that writes a name wrong and demands the exception**, in
   `tests/widgets`, and one that writes it *right* beside it -- the second is
   what says the setters still work. It drives a child process, because the
   switch is a property of the run. It also assigns a table's `Columns` and
   forces a drawing area to paint, which are the two notes that used to arrive
   after the control was built: if either ever comes back as an own property,
   this is what says so.
5. **The IDE passes the switch from Run**, as a tick in the Project menu,
   remembered in `Settings`.

### And QuickJS was taught to name the property

`preventExtensions` bought the refusal; it did not buy a useful message.
Measured, before:

```
TypeError: object is not extensible
```

The whole reason to seal a control is to be told that `Txt` is not a property of
a `Label`, and the name is in hand at every site that refuses an addition -- so
it is said. Two lines of helper and three call sites in
`vendor/quickjs/quickjs.c`, the same shape `JS_ThrowTypeErrorReadOnly` two lines
above has always had. It is the **fourth** Bintana patch in the vendor, and the
only one whose loss costs nothing but a worse sentence: `AGENTS.md` lists it with
the other three.

```
TypeError: no 'Txt' to assign: the object is not extensible
    at Form_Open (/tmp/strict/Strict.js:9:14)
```

## Where the switch lives

Not `project.json`: it is a property of the **run**, not of the project. A flag
on the command line, off unless asked for -- `bintana` is what the IDE spawns, so
it is one argument.

Which made it the first real caller for **launch configurations** -- and they
exist now, because a second one turned up: the arguments a project needs in order
to start, which the IDE had no way to pass at all. A configuration can say a run
is strict, and that half is the project's and versioned; the tick stays yours and
only ever adds. [`ide.md`](../ide.md#run-configurations) has the three places and
why the switches are **copied** into a new configuration rather than inherited
from anywhere.

## What it catches, and what it does not

The two halves are complementary, and the table is the argument for having built
both:

| | the static checks | this |
|---|---|---|
| `this.Lbl.Txt = "x"` | yes | yes, **and in the act, with the line** |
| a control reached by name (`this[which].Txt`) | no | yes |
| a control, a menu item or a command named `Actions` | yes, as an **error** | **done, and by neither of them**: all three loaders look at the answer now and refuse the form. Only the read-only members land there -- a *method* like `Close` is shadowed rather than refused, the form still runs, and that one is the static check's alone |
| a property of a component of the project | no -- the IDE never loads its code | yes |
| a `.form` the IDE has never opened | no | yes |
| `Btn_Clik()`, the handler nobody calls | **yes** | no: nothing is assigned |
| `this.state = …` on a **form** | no | no, and on purpose: a form is the application's own object |

What this adds is the half a lint cannot give: **the moment and the place.** What
it cannot give is the half that needs no execution at all.

## Risks, and what became of them

- **The table's state is not on the struct the mark walks.** It hangs off the
  GObject under `TABLE_STATE_KEY` -- but the *columns* never did: they were an
  own property of the wrapper, and that is what moved. The state stayed where it
  was. No plumbing was needed, and the failure mode named here -- an abort on
  `JS_FreeRuntime` -- is what `tests/asan.sh` exercises on every project.
- **A widget that legitimately wants a note of its own.** Nothing in this tree
  does one -- the eight in the table were all of them, and that count was wrong
  once already, which is the reason to re-read it rather than trust it -- but an
  application storing state on a control is ordinary JavaScript, and under this
  mode it starts throwing. That is the mode doing its job, and it is also why it
  is off by default and named for development.
- **A component of the project.** Its class is the project's, and its own fields
  are set in its constructor like any class's. Preventing extensions comes
  **after** that, which is why the seal is at the end of the loader's work on a
  node and not in the widget constructor: a subclass body runs after `super()`.

## What made it worth doing

Not this document's argument; a caller -- the same test every other deferral in
this tree is held to. Here it had one before the flag existed: **the two moves
paid for themselves without it**, because they are what makes a widget's
introspected surface honest, and that surface is what the completion and both
name checks read. The flag is what proves the cleanup landed.
