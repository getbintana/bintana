# Grid

Rows and columns whose sizes come from what is in them.

**The answer to a caption that grows in translation.** A row of labelled fields
drawn in coordinates is right in one language: the Spanish *Apellido* is not the
English *Surname* and the German is neither, so the column of fields either moves
or the captions are clipped. In a grid the column is as wide as its widest
caption, whatever language it is in, and nothing in the file is a number about
where anything sits.

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `ColumnSpacing` | pixels between the columns | [spacing](#spacing) |
| `Columns` | how many columns children wrap at. Default `2` | [how children fall into it](#how-children-fall-into-it) |
| `Homogeneous` | every cell the same size | [spacing](#spacing) |
| `RowSpacing` | pixels between the rows | [spacing](#spacing) |

No methods and no events of its own. Children go in with
[`Add`](Container.md#putting-children-in) and a child's place is decided by the
order it went in.

## Which container is this one

| | reach for it when |
|---|---|
| **`Grid`** | **labelled fields, a keypad, anything in rows and columns whose sizes should follow their contents** |
| [`Panel`](Panel.md) | a row, a column, or a surface to draw on |
| [`Flow`](Flow.md) | as many across as fit, wrapping when the window narrows |
| [`TableView`](TableView.md) | **data**, not controls: rows of fields, with headings and a selection |

The last line is the one worth reading twice: a `Grid` is a *layout* for controls
you place, and a `TableView` is a *list* of rows your program holds. A grid with
forty rows in it is forty times as many controls as a table with forty rows.

## How children fall into it

| | |
|---|---|
| `Columns` | how many columns children wrap at. Default `2`, which is a grid of labels and fields |

**Children flow in order**, left to right, wrapping at `Columns`: with `Columns:
2`, the first child is the caption of the first row and the second is its field.
There is no *row* and *column* to declare per child — the order is the layout,
which is what makes a grid something a designer can fill by dragging and a
translator cannot break.

A column is **as wide as its widest child** and a row as tall as its tallest. A
child that should take the slack of its row says
[`HExpand`](Widget.md#how-it-is-placed); one that should run under several
columns says [`ColumnSpan`](Widget.md#how-it-is-placed) — which is how a field
that spans the whole dialog, or a separator between sections, is written.

## Spacing

| | |
|---|---|
| `RowSpacing` | pixels between the rows |
| `ColumnSpacing` | pixels between the columns |
| `Homogeneous` | every cell the same size, which is what a keypad wants and a form of fields does not |

[`examples/calculator`](../../../examples/calculator) is the homogeneous case:
every key the same size, four across. A dialog of labelled fields is the other —
the caption column is as narrow as the captions and the field column takes the
rest.

## What goes wrong

- **The fields are not lined up.** Something went in in the wrong order, or a
  child that should span two columns did not say `ColumnSpan`.
- **The caption column is enormous.** One caption in it is long — a sentence
  rather than a label — and a column is as wide as its widest child. Wrap that
  one, or give it a row of its own with a `ColumnSpan`.
- **Nothing stretches when the window grows.** No child says `HExpand`, so there
  is nobody to give the slack to.
- **A hole appeared after removing a child.** It does not: a grid **re-flows**
  what stayed, so the children after it move up a place. That is usually what is
  wanted, and it is why a grid is filled and refilled rather than patched.
- **The translation broke the layout anyway.** The captions are in a
  `Fixed` region inside the grid, not in the grid itself.

## What it does not do

- **No per-child row and column.** The order is the place; `ColumnSpan` is the
  only escape, and a layout that needs more than that is two grids or a grid of
  panels.
- **No row headings, no selection, no data.** [`TableView`](TableView.md).
- **No coordinates.** A grid refuses `Arrangement`, which is what
  [`Placement`](Container.md#not-every-container-arranges) answers for.

## See also

[`Container`](Container.md) · [`Panel`](Panel.md) · [`Flow`](Flow.md) ·
[`TableView`](TableView.md) ·
[`examples/calculator`](../../../examples/calculator)
