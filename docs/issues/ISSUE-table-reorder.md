# ISSUE: a table's columns cannot be reordered by the user

## What the application needed

A screen where the person moves "Cost" in front of "SKU" with the mouse and
keeps it there. The concrete case was a warehouse list: the store manager
wants the quantity first, the office wants the price first, and neither of them
wants the columns to be in whatever order the form was drawn.

## What I wrote instead

The program rebuilds the table with the columns in the order it wants --
`table.Columns = [ ... ]` -- which costs the selection, the scroll position and
every row's widgets, and the order is then a property of the program rather
than of the person. Or the order is fixed and the program offers no way to
change it at all.

## The code I wish I could have written

```js
// a table whose columns can be dragged into another order:
{
  "type": "TableView",
  "name": "Grid",
  "properties": {
    "Reorderable": true,
    "Columns": [
      { "Text": "SKU" },
      { "Text": "Cost" }
    ]
  }
}
// and the program told when it happened, to remember the order:
Grid_Reordered(from, to)
```

## Why the existing words do not cover it

The runtime calls `gtk_column_view_set_reorderable(..., FALSE)`
(`runtime/src/bta_table.c:3972`) and nothing turns it back on. Turning it on is
**not enough**, and that was measured before this was written: on GTK 4.22.5
GTK's own reorder is a `GtkGestureDrag` in the capture phase on the header row,
claimed only once the pointer passes a threshold, and the title's own click
gesture (`click_pressed_cb` in `gtkcolumnviewtitle.c`) claims the sequence on
the press -- which cancels that drag first. Checked with a bare `GtkColumnView`
(reorderable TRUE) outside this runtime, on a real desktop and under Xvfb: the
heading does not move. What does work, tried in plain GTK: a capture-phase
`EventControllerMotion` (never claims) to notice the drag, plus a
capture-phase `EventControllerLegacy` to see the button release -- a
`GtkGestureClick` gets no `released` once the pointer has moved -- and then
`gtk_column_view_insert_column` at the column under the release. Whether the
title's sort on release also fires after such a drag is not checked.

The runtime has no way to say a column's *place* either: `Columns` is an
array of plain objects -- the runtime refuses anything else with "Columns is a
list of { Text, Width, Alignment }" (`runtime/src/bta_table.c:4095`) -- and the
order it is in is the order the columns were declared in.

## Prior art

Delphi and Lazarus `TColumn.Index` and a draggable header. WinForms
`DataGridView` with column header drag. Qt `QHeaderView.setSectionsMovable`.
GTK4's `GtkColumnView` has `gtk_column_view_set_reorderable`, but its gesture
is defeated by the title's own click.

## How much it mattered

It works, but a part of it is noticeably worse: the order of the columns is
the program's to decide, and a person who wants another one has nothing to
say about it.
