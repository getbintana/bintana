# ISSUE: a table cannot hide, reorder or filter its columns

## What the application needed

A stock list where the user chooses the columns they want to see, drags
"Cost" in front of "SKU", and types into a box that narrows the rows to the
ones whose client matches. The concrete case was a warehouse screen: the
owner wants "SKU" and "Price" and no "Cost", the accountant wants the
opposite, and the same table serves both.

## What I wrote instead

Two `TableView`s, one with every column and one with the visible ones, and a
`Grid` of `CheckButton`s that decides which is on screen. It costs a second
copy of the rows, a rebuild of the table on every change (which loses the
selection and the scroll position), and a filter that has to re-query and
re-add the rows by hand. The heading menu is the program's own, so "hide this
column" is a `HeaderMenu` item whose handler rebuilds the table.

## The code I wish I could have written

```js
// a table whose columns say whether they are shown:
{
  "type": "TableView",
  "name": "Grid",
  "properties": {
    "Reorderable": true,
    "Columns": [
      { "Text": "Client", "Width": 180, "Visible": true },
      { "Text": "Cost",   "Width": 90,  "Visible": false }
    ]
  }
}
// and the filter asked per row, the way a `RowList` asks:
//   Grid_Filter(row, column) -> boolean   // false hides the row
```

## Why the existing words do not cover it

`TableView.Columns` is an array of plain objects, not a class: the runtime
refuses anything else with "Columns is a list of { Text, Width, Alignment }"
(`runtime/src/bta_table.c:4095`) and reads only `Text` (:4120) and `Width`
(:4129), so a `Visible` key has nowhere to go. Reordering is off by
construction, the view being built with
`gtk_column_view_set_reorderable(..., FALSE)` (:3972) and nothing turning it
back on. `HeaderMenu` (:6078-6084) and `HeaderClick` (:3862) are the
program's own, so a menu item can be declared and nothing behind it hides a
column. `RowList` does have a `Filter` (`runtime/src/bta_layout.c:1671-1676`,
asked at :807), but it is another widget and it hides a row, not a column.
The runtime says as much itself: the day `Columns[i].Visible` exists, the
walk over the headings has to change (:3804-3807). There is no grouping, no
totals row and no clipboard in `bta_table.c` at all.

## Prior art

Delphi and Lazarus `TColumn` with `ColVisible`. WinForms
`DataGridViewColumn.Visible`. Qt `QTableView.setColumnHidden` and
`moveSection`. GTK4's `GtkColumnView` has `gtk_column_view_set_reorderable`
but nothing for hiding a column or filtering rows.

## How much it mattered

It works, but a part of it is noticeably worse: the IDE's own property grid
and its Columns dialog (`ide/forms/ColumnForm.js`,
`ide/modules/PropertyGrid.js:1339`) rebuild the list by hand.
