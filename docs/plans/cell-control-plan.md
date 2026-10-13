# Any control as a cell's editor

**Not started.** This is the plan for the one `Editor` kind the first round left
out on purpose: `Kind: "Control"`, which opens a control of the runtime -- or a
component of the project -- in a table cell, so the kinds stop being a closed
list. The six that exist (`Text`, `Number`, `Date`, `Check`, `Combo`, `Custom`)
are in `runtime/src/bta_table.c` and *A table cell's editors* in `AGENTS.md`;
read that first, because every rule this plan leans on was measured there.

## What is missing, and who asks

A kind is a row in `ED_KINDS` plus two cases in C. That is cheap for the runtime
and closed for everybody else: a program that wants a cell edited with something
the six do not draw -- a colour, a time of day, a duration typed as `2d 4h`
with its own parser, the type *and* the date of a constraint side by side -- has
two roads today, and neither is the cell:

| It wants | It has |
|---|---|
| a control in the cell | **Nothing.** `Custom` opens a dialog; the grid is left for a window |
| a component of its own there | **Nothing.** A component is a `.form` and a class, and a cell takes neither |
| the same gestures as the other kinds | A dialog has its own: OK, Cancel, the window's X |

The caller in sight is `bintana-project`'s constraint column -- a type of eight
and, for six of them, a date -- which `Custom` answers with a dialog and MS
Project answers in the cell. That is the trigger this plan waits for: **one
application that ships a `Custom` it would rather have inline.**

## Prior art

Every grid in the comparison that settled the first round has this door, and
they split two ways:

- **A control per cell, declared**: WPF's `DataGridTemplateColumn` with a
  `CellEditingTemplate`, Gambas' `GridView.EditWith(control)`, Xojo's cell
  types. The column names what to build; the grid builds and owns it.
- **A protocol the program implements**: Qt's `QStyledItemDelegate`
  (`createEditor`, `setEditorData`, `setModelData`), WinForms'
  `IDataGridViewEditingControl`, AG Grid's cell editor components
  (`getValue`, `isCancelBeforeStart`). The program writes the editor; the grid
  calls it.

The second is more powerful and is three functions a program has to get right.
The first is a declaration, and a declaration is what a `.form` can carry and
the designer can edit -- which is the property every other column option has.
**This plan takes the first**, with one convention standing in for the protocol.

## The design

```js
{ Text: "Colour", Editor: { Kind: "Control", Type: "ColorButton" } }
{ Text: "Duration", Editor: { Kind: "Control", Type: "DurationBox",   // a component
                              Properties: { Unit: "h" }, Value: "Text" } }
```

- **`Type`** is a class name, resolved the way a `.form`'s `type` is: the
  runtime's table first, then `bta_lookup_global` for the project's and its
  libraries'. A name that resolves to nothing is refused **at declaration**,
  as every other option is -- not when the first cell opens.
- **`Properties`** are assigned once the control is built, through its setters,
  exactly as the loader applies a node's. A misspelt one is the setter's
  refusal (and `--strict`'s), reported by `CellEditor`'s road.
- **`Value`** names the property that carries the cell's text in and out --
  `"Text"` by default. A cell is still text: the property is assigned the
  cell's text when the editor opens and read back when it commits, and a
  control whose value is not text (`ColorButton.Color`, `SpinBox.Value`) is
  converted by the setter it already has.
- **The gestures are the other kinds'**: Enter commits, Escape gives up, the
  focus leaving commits, all through the same `cell_settle`. A control that
  ends its own edit -- a component with an OK of its own -- calls the table's
  `EndEdit()`, which exists; **no new event**.
- **`CellEditor` keeps its two answers**: `false` refuses, and an object may
  name another `Type` or other `Properties` for this edit. It also gets the
  built control, as a third argument, so a row can fill a list the control
  holds without a declaration for it.

## The hard part is lifetime, and it is all in AGENTS.md already

A cell editor today is a GTK widget the cell owns and nothing in JavaScript can
reach. A control is a `BtaWidget` with a wrapper, a form it binds to, handlers,
and a place in `__children` -- and every one of those has a trap written down:

- **Adoption.** It is not a container's child, so `bta_widget_adopt` and
  `bta_widget_release` have no parent to file it under. The editor needs a
  foster form -- the table's -- and the table's wrapper must hold the
  control's for the length of the edit (the `form_hold` bargain, absent from
  `gc_mark` for the same reason).
- **Handlers.** A component built here binds to itself, as one built with
  `new` does (*A component added from code keeps itself as its event target*),
  which is right: its handlers are its own. The table's form must not gain a
  `<name>_<event>` road into it, so the control is not named on the form.
- **Teardown.** The cell is recycled, scrolled away and unbound. Every road out
  of an edit already goes through `cell_take_editor`; that one place has to
  release the wrapper, disconnect the tree (`widget_disconnect_tree`) and
  unparent, in that order, and a row scrolled away must still commit first.
- **Focus and popovers.** A control with a popover of its own (`DatePicker`,
  `ColorButton`) moves the focus into another surface. `SETTLE_BLUR` already
  asks whether the focus is still inside the editor; a popover parented to the
  window's content, as `Popover.Show` does, is not, so the question has to
  learn that a surface opened *from* the editor is part of it.
- **Size.** A control asks for its natural size, and a column that sizes itself
  widens the moment the cell opens -- the reason the field kinds set a width of
  one character. A control has no such knob in general; the cell clamps it.

## Stages

0. **Spike, measured before anything is designed further.** `Widget.New`'d
   `SpinBox` and a two-control component into a cell by hand, opened and closed
   a thousand times, scrolled away mid-edit, the table deleted mid-edit -- under
   `tests/asan.sh` and with the resident size watched. Gate: no report, no
   growth. If the foster form cannot be made clean, the design falls back to the
   protocol shape (a program that builds and destroys its own editor), and this
   plan is rewritten before stage 1.
1. **The runtime half**: `Kind: "Control"` with `Type`, `Properties` and
   `Value`, the three refusals at declaration, the third argument to
   `CellEditor`, and `TableEditors` driven through `EditCell`/`EndEdit` like the
   six. The popover question answered with a real pointer.
2. **The designer**: the column dialog offers `Control` with a `Type` drop-down
   (`Widget.Types()` and the project's classes, which `Classes` already knows)
   and the property grid of that type for `Properties`.
3. **The example**: `examples/plan`'s `Notes` stays `Custom`; a constraint
   column -- type and date in one cell, a component -- shows the new kind.

## What is deliberately not here

- **A function as the editor** (`Make: () => new SpinBox()`): it cannot be in
  a `.form`, so the designer could not show it and a declaration would have two
  spellings. `CellEditor`'s third argument covers what a function would add.
- **A control drawn in every cell** (a `Switch` per row, a progress bar): that
  is a *display* kind, not an editor, and it costs a widget per visible cell
  with handlers on each. `Check` is the one display kind, built in C, for that
  reason. A request for another is a separate plan.
