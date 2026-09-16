# Strict checks: what has to move first is the runtime's own bookkeeping

**Nothing in this document is implemented, and one thing it used to propose no
longer needs to be** -- see the note under *the obstacle*. The idea is one line
-- *make a widget refuse a property it does not have, so a misspelt name fails
where it is written instead of doing nothing forever* -- and measuring it turned
a one-line feature into a small cleanup with the check as its proof.

It is the runtime's half of the answer
[`Ide.Live` and `Ide.Check`](ide.md#the-names-a-file-uses-checked-while-it-is-written)
give statically. Those read what the `.form` describes; this catches what no file
describes, in the act, with a traceback naming the line.

## Not `Object.freeze`, and not only because it is gone

`Object` is empty in this runtime and every static was removed on purpose -- see
[`llm/language.md`](llm/language.md). Putting `freeze` back would reverse a
decision that is written down.

It is also the wrong tool. `freeze` makes existing own properties
**non-writable**; what is wanted is `preventExtensions`, which refuses *new*
names and touches nothing else. A widget's properties are accessors on its
prototype, so `this.Lbl.Text = "x"` goes through a setter and creates nothing,
while `this.Lbl.Txt = "x"` is an attempt to add an own property -- which is
exactly the one to refuse.

And it belongs in **C**, where widgets are built: no `Object` static is needed,
every widget gets it with nobody writing a line, and it can be a mode that is off
by default. QuickJS publishes `JS_PreventExtensions`.

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

## The obstacle, measured: the runtime writes on the widgets too

Preventing extensions at construction breaks the runtime before it catches
anybody's typo, because the runtime leaves its own notes on a widget as ordinary
own properties -- and most are created **late**. `__columns` is written when an
application assigns `Columns`, which is application code at any moment.

| note | who writes it | where it is read | when |
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
  matters most to the staging below: it is created *on the first frame a
  `DrawingArea` paints*, later than `__columns`, so stage 3's *once it is built*
  is not late enough and the mode would throw on the first repaint.
- **`__declared` is not `rad.js`'s alone.** C defines and writes it too, so a
  `WeakMap` private to `rad.js` would make those writes invisible to the readers
  next to it. It cannot move in stage 1.
- **`__field` was in this table and is not a note on a widget at all** -- it is
  the flag on the plain descriptor `makeField` returns, read as a type test for
  `Field.List` and `Field.Record`. It never touches a widget and never goes
  through `hiddenBag`, so `preventExtensions` does not affect it and a WeakMap
  keyed by a widget has no widget to key on. (`__type` is rightly absent for a
  different reason: it lives on the constructor.)

They are **invisible today by arrangement**: a `__` name, the enumerable bit
left off, and -- as `bta_table.c` puts it -- *invisible to the serialiser
besides, which discovers accessors and not own properties*. The proposal here is
to stop arranging it and make it true.

> **One of the seven silences left this plan while it was being written.** A
> control whose name is a *read-only* member of `Form` was lost without a word,
> and the reason was not the language: `bta_form.c` bound it with
> `JS_SetPropertyStr` and did not look at the answer, a hundred lines under a
> loop that checks its own. It looks now, and the form refuses to load, saying
> which control and why. That was **one line** and it needed none of what is
> below -- which is worth knowing before starting: not every silence here wants
> the cleanup.

### Why they live on the object, and why that argument has moved

The reason is written at `bta_table.c`, and it is a good one:

> keeping a `JSValue` in C is a strong reference the collector cannot see, and
> `JS_FreeRuntime` aborts on anything still alive
> (`Assertion list_empty(&rt->gc_obj_list) failed`, which is how this was found)

True for a value **nobody marks** -- and the widget class has a mark function.
`widget_gc_mark` already reports two C-held `JSValue`s, `w->form` and `w->menu`,
and has since controls needed to point back at their form. So the pattern that
comment rules out is already in the tree, working, in the same struct. What it
rules out is holding a value *without* marking it, which is a different thing.

## Where they would go

| | to |
|---|---|
| the six C writes -- `__columns`, `__painter`, `__children`, `__menus`, `__actions`, `__declared` | a field on the struct, reported in `gc_mark` and released in the finalizer -- `w->form` and `w->menu` are the shape |
| the two that are `rad.js`'s alone -- `__design`, `__item` | a `WeakMap` in the module's own scope, keyed by the widget |

`WeakMap` was checked and is there (`Map` and `Set` too; `Symbol` and `eval` are
not). A `WeakMap` is private to the file that declares it, invisible to
`for...in`, to `Dictionary.Keys`, to the serialiser and to `preventExtensions`,
and it lets the widget go when the widget goes.

**No caller changes.** The methods that reach these notes already exist --
`Declared()`, `SetDesign()`, `DesignValue()`, `Item`, `SetItem` -- and `hiddenBag`
becomes their storage rather than their pattern. `Declared()` is the one with two
sides to satisfy, since C writes what it reads. What moves is where the value
sits, not how anybody asks for it.

## What it buys beyond the check

**A widget's own properties become exactly its properties.** That is worth more
than the strict mode itself, and it is the reason to do this even if the flag is
never built:

- `preventExtensions` then needs nothing pre-created; it simply works.
- the introspection that answers *what does this control really have* -- the `in`
  operator and `PropertyNames()`, which is what the completion and both name
  checks read -- describes the widget and nothing else. See
  [completion-plan.md](completion-plan.md).
- and the invisibility stops depending on three separate arrangements holding.

Which turns the feature around: **the strict mode is not the point, it is the
test.** If anything internal is still hanging off the object, the first run with
the flag on says so.

## Staging

1. **Move the two notes that are `rad.js`'s alone -- `__design` and `__item` --
   to a `WeakMap`.** No C, no flag, no behaviour change: `hiddenBag` is the only
   thing that knows, and the suite is the proof. **Two and not four**: `__field`
   is not a widget note, and `__declared` is shared with C.
2. **Move the six that C writes onto their structs** -- `__columns`, `__painter`,
   `__children`, `__menus`, `__actions` and `__declared` -- reported in `gc_mark`
   and released in the finalizer. `__declared` lands here rather than in stage 1
   because both sides write it, and whatever holds it has to be reachable from
   both. The table's is the one with plumbing (below).
3. **Then `JS_PreventExtensions` on a widget once it is built**, behind the
   switch. Nothing to pre-create if 1 and 2 are done, which is how they are
   checked -- and *once it is built* has to mean after the first frame, or it has
   to mean nothing at all for a `DrawingArea`, because `__painter` arrives then.
   That is the one place the moment is not obvious.
4. **A test that writes a name wrong and demands the exception**, in
   `tests/widgets`, and one that writes it *right* beside it -- the second is
   what says the setters still work.
5. **The IDE passes the switch from Run**, with a setting for it.

## Where the switch lives

Not `project.json`: it is a property of the **run**, not of the project. An
environment variable or a flag on the command line, off unless asked for --
`bintana` is what the IDE spawns, so it is one argument.

Which makes it the first real caller for **launch configurations**, where the
IDE's Run is `Exec([Application.Executable, ide.project], { Directory: … })` and
nothing else: no arguments, no environment, no choice of what to start.

## What it catches, and what it does not

The two halves are complementary, and the table is the argument for building
both:

| | the static checks | this |
|---|---|---|
| `this.Lbl.Txt = "x"` | yes | yes, **and in the act, with the line** |
| a control reached by name (`this[which].Txt`) | no | yes |
| a control named `Actions` | no | **already done, and not by this**: the loader checks the answer now and refuses the form. Only the read-only members land there -- a *method* like `Close` is shadowed rather than refused, and stays the static check's |
| a property of a component of the project | no -- the IDE never loads its code | yes |
| a `.form` the IDE has never opened | no | yes |
| `Btn_Clik()`, the handler nobody calls | **yes** | no: nothing is assigned |

What this adds is the half a lint cannot give: **the moment and the place.** What
it cannot give is the half that needs no execution at all.

## Risks

- **The table's state is not on the struct the mark walks.** It hangs off the
  GObject under `TABLE_STATE_KEY`, so the columns have to be reachable from
  `gc_mark`. That is the one piece of plumbing, and its failure mode is the
  assertion the comment above names -- an abort on `JS_FreeRuntime`, loud, at
  teardown, which `tests/asan.sh` exercises on every project.
- **A widget that legitimately wants a note of its own.** Nothing in this tree
  does one today -- the eight in the table are all of them, and that count was
  wrong once already, which is the reason to re-read it rather than trust it --
  but an
  application storing state on a control is ordinary JavaScript, and under this
  mode it would start throwing. That is the mode doing its job, and it is also
  the reason it is off by default and named for development.
- **A component of the project.** Its class is the project's, and its own fields
  are set in its constructor like any class's. Preventing extensions has to come
  **after** that, or every component breaks; *once it is built* is the moment, and
  getting it wrong is loud.

## What would make it worth doing

Not this document's argument; a caller -- the same test every other deferral in
this tree is held to. Here it has one already: **stage 1 and stage 2 pay for
themselves without the flag**, because they are what makes a widget's introspected
surface honest, and that surface is what the completion and both name checks read.
The flag is what proves the cleanup landed.
