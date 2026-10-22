# ISSUE: a table's rows cannot be filtered by a column

## What the application needed

A box above the list that narrows the rows to the ones whose client matches
what is typed in it, and clears when it is emptied. The concrete case was a
warehouse screen with four thousand rows and one field of text: the person
wants the rows of one client, and the list is otherwise a scroll of noise.

## What I wrote instead

The program keeps its own list of what matches and pushes it into the table --
`Clear()` and `Add()` per row -- which costs the selection, the scroll
position and every row's widgets on every keystroke, and is quadratic in the
rows through GTK's item manager (see `docs/agents/tables.md`). Or the table
holds everything and the program draws the rows it wants by hand, which is the
same work with more of it.

## The code I wish I could have written

```js
// the table asks per row, the way a `RowList` asks:
Grid_Filter(row, column) -> boolean   // false hides the row

// and the words that narrow it, beside the list:
{ "type": "TextBox", "name": "Search", "properties": { "Placeholder": "client…" } }
```

## Why the existing words do not cover it

`RowList` has a `Filter` event -- raised per row
(`runtime/src/bta_layout.c:1671-1676`, asked at `:807`) -- but `TableView`
does not, and a table is the widget that holds thousands of rows: the filter
has to be the table's, because the table is what draws them. A `TableView`
holds its rows in a `GListStore` (`runtime/src/bta_table.c`) and draws them
all; there is nothing to ask.

The words that are close are the sort's, and they are the other way round:
`Sortable` and `SortBy` reorder the rows the table holds, and a table that
answers `Data` is refused for sorting outright, because it holds nothing to
sort.

## Prior art

Delphi `TDataSource.Filter` and `TADOQuery`. Lazarus `TDataSet.Filter` and
`TDataSource` with a filter panel. .NET `DataView.RowFilter` and
`BindingSource.Filter`. WinForms `BindingSource.Filter`. Qt
`QSortFilterProxyModel` with a `QSortFilterProxyModel::filterAcceptsRow`
subclass. GTK4 has no filter of its own.

## How much it mattered

It works, but a part of it is noticeably worse: narrowing a list of four
thousand rows is a rebuild of the table on every keystroke.
