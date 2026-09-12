# Flow

A gallery: children wrap into as many columns as fit.

Thumbnails, swatches, a palette of tools, the covers of things. As the window
widens more fit on a line; as it narrows they re-flow. It scrolls itself.

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `ColumnSpacing` | pixels between children on a line | [spacing](#spacing) |
| `Homogeneous` | every child the same size | [spacing](#spacing) |
| `MaxPerLine` | at most this many. Default `100` | [how many fit](#how-many-fit) |
| `MinPerLine` | at least this many children per line | [how many fit](#how-many-fit) |
| `RowSpacing` | pixels between lines | [spacing](#spacing) |

## How many fit

| | |
|---|---|
| `MinPerLine` | at least this many, even when they have to be squeezed |
| `MaxPerLine` | at most this many, even when there is room for more. Default `100`, which is *as many as fit* in practice |

The pair is how a gallery is kept sensible at both ends: `MinPerLine: 2` stops a
narrow window from showing one enormous thumbnail per line, and a `MaxPerLine` of
6 stops a wide one from drawing forty tiny ones.

## Spacing

| | |
|---|---|
| `RowSpacing` | pixels between lines |
| `ColumnSpacing` | pixels between children on a line |
| `Homogeneous` | every child the same size, which is what a grid of thumbnails wants |

## Which container is this one

| | reach for it when |
|---|---|
| **`Flow`** | **the children are all the same kind of thing and how many fit on a line is the window's business** |
| [`Grid`](Grid.md) | the columns mean something — captions beside fields |
| [`RowList`](RowList.md) | one per line, selectable, filterable |
| [`TableView`](TableView.md) | rows of fields, with headings |

**It scrolls itself**, like the lists, so it does not want a
[`Scroller`](Scroller.md) around it.

## What goes wrong

- **Everything is on one line.** The flow has no width to wrap at: it needs
  `HExpand`, or a width from the layout.
- **The thumbnails are different sizes and it looks ragged.** `Homogeneous`, or
  give the children a size.
- **It will not scroll.** It scrolls itself; a scroller around it gives it
  infinite room instead.

## What it does not do

- **No selection.** It is a container, not a list: the children are controls and
  a click is theirs. For a gallery with a selection, make each child a
  [`ToggleButton`](ToggleButton.md) or handle `MouseDown` on it.
- **No ordering by itself.** The order is the child order.

## See also

[`Grid`](Grid.md) · [`RowList`](RowList.md) · [`Scroller`](Scroller.md)
