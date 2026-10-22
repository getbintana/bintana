# ISSUE: a grid takes its children's order and gives them no cell of their own

## What the application needed

A settings dialog laid out as a table: a label on the left, its field on the
right, a third column that only one row uses, and a note that runs under the
first two columns. The concrete case was a form with a name and an address in
two columns, a "phone" row whose field is wider than the rest, and a caption
at the bottom spanning the whole width. Written as a flow, the note lands in
column one of the next row and pushes everything after it one cell to the
right.

## What I wrote instead

Nested `Grid`s and `Panel`s arranged "Horizontal", one box per row, so that a
cell can be filled by giving the row its own grid. It costs a container per
row, and the widths stop agreeing: each inner grid sizes its own columns, so
the fields of two rows no longer line up unless the widths are written twice
and kept in step by hand.

## The code I wish I could have written

```js
// a grid whose children say which cell they are in:
{
  "type": "Grid",
  "name": "Grid",
  "properties": { "Columns": 3 },
  "children": [
    { "type": "Label",   "name": "LblName", "properties": { "Row": 0, "Column": 0 } },
    { "type": "TextBox", "name": "TxtName", "properties": { "Row": 0, "Column": 1 } },
    { "type": "TextBox", "name": "TxtPhone", "properties": { "Row": 1, "Column": 1,
                                                             "ColumnSpan": 2 } },
    { "type": "Label",   "name": "LblNote", "properties": { "Row": 2, "Column": 0,
                                                            "ColumnSpan": 3 } }
  ]
}
```

## Why the existing words do not cover it

`Grid` says so itself, in the comment above its own registration
(`runtime/src/bta_layout.c:1447-1462`): "**Children flow into it in order**,
left to right, wrapping at `Columns`. There is no per-child row and column to
fill in: a grid's order *is* its layout", and `ColumnSpan` is "the one
exception, for the note that runs the width of the form and the row of buttons
that sits under both columns". That exception is the only span there is:
`ColumnSpan` is declared at `runtime/src/bta_widget.c:7343-7346` and set at
`:6759-6762`, and there is no `Row`, no `Column` and no `RowSpan` beside it —
so a child cannot say which row it is in, and a cell that should span
vertically cannot be written down at all. The widget underneath already has
all of it: the grid is a `GtkGrid`, and `grid_place`
(`runtime/src/bta_layout.c:1470-1482`) writes the column, the row and the
column span onto the `GtkGridLayoutChild` itself — it just works them out
from the children's order instead of reading them off the child, and never
touches `gtk_grid_layout_child_set_row_span` at all.

## Prior art

WPF `Grid.Row`, `Grid.Column`, `Grid.RowSpan` and `Grid.ColumnSpan`, in XAML.
WinForms `TableLayoutPanel`. Qt `QGridLayout`, whose `addWidget(widget, row,
col, rowSpan, colSpan)` takes all four numbers. Lazarus `TGridLayout`.

## How much it mattered

It works, but a form that wants a real table-like layout has to nest boxes.
