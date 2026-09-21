# Scroller

Content whose size is not its parent's business.

The view is as big as the room it is given, the content as big as it needs, and
the difference scrolls. A long form, a picture bigger than the window, a column of
results: one control around it and the problem is gone.

**Give it an `Arrangement` and it fills as well**: the content is then the size
of the view while it fits and bigger than the view when it does not, which is
[a section of its own below](#filling-the-room-and-scrolling-when-it-will-not-fit).

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Scrollbars` | `Both` `Horizontal` `Vertical` `None`. Default `"Both"` | [which way it scrolls](#which-way-it-scrolls) |
| `ScrollMaxX` (ro) | the largest `ScrollX` that still shows content | [where it is scrolled to](#where-it-is-scrolled-to) |
| `ScrollMaxY` (ro) | the same downwards | [where it is scrolled to](#where-it-is-scrolled-to) |
| `ScrollX` | how far across it is scrolled, in pixels | [where it is scrolled to](#where-it-is-scrolled-to) |
| `ScrollY` | the same downwards | [where it is scrolled to](#where-it-is-scrolled-to) |
| **event** `Scroll(x, y)` | the position moved | [where it is scrolled to](#where-it-is-scrolled-to) |

## What does not need one

**The lists scroll themselves**: [`ListBox`](ListBox.md),
[`RowList`](RowList.md), [`TreeView`](TreeView.md),
[`TableView`](TableView.md), [`Flow`](Flow.md) and both editors are already
scrolling views of their contents. Putting one inside a `Scroller` gives it
infinite room to grow into and takes the scrollbar away from the rows, which is
the opposite of what was wanted.

What wants one is a **layout** that is bigger than its room: a long form, a
[`Picture`](Picture.md) at a zoom, a panel of controls that does not fit on a
small screen.

## Which way it scrolls

| | |
|---|---|
| `Scrollbars` | `Both` `Horizontal` `Vertical` `None` |

**An axis that may not scroll is not a hidden scrollbar**: GTK gives the child the
width of the *view* instead of the width it asked for, which is what makes a
column of long lines wrap or ellipsize rather than run off the side. So
`Vertical` is the setting for a page of text, and it is doing something more than
hiding a bar.

**The child of a scroller sits on a `Fixed` surface**, which means what is in it
is as big as it asks to be and not as big as the view — a declared `Width` does
not change that on an axis whose `HAlign` is `Fill`, since there the declaration
is the floor and the surface has no design size to stretch against. A drawing
that should be the width of the view either declares a width or draws itself —
see [`DrawingArea`](DrawingArea.md).

## Filling the room, and scrolling when it will not fit

| | |
|---|---|
| `Arrangement` | `Fixed` (default) `Horizontal` `Vertical` — a [`Container`](Container.md) property, and here it decides which of two containers this is |

**Arranged, the slot is a box, and a box stretches an expanding child across
itself.** That is the whole of it: `Arrangement: "Vertical"` plus `HExpand` and
`VExpand` on the content, and the content is the size of the view while it fits
and bigger than the view when it does not — one declaration for both, decided by
how much there is rather than in advance.

```js
const view = new Scroller();
view.Arrangement = "Vertical";
view.Scrollbars  = "Both";

const grid = new Grid();
grid.Columns     = 4;
grid.Homogeneous = true;
grid.HExpand     = true;
grid.VExpand     = true;
view.Add(grid);
```

Measured in a 900x500 view, filling the grid with tiles of a 180x130 floor: one
tile is **898x498**, four are 2x2 at **445x245** with `ScrollMaxY 0`, and twenty
are a **924x538** grid with `ScrollMaxY 38` — the view stays 900x500 throughout.
The same grid in the default slot is **180x130** for one tile and **366x266**
for four, with the rest of the view empty — it is as big as what is in it, which
is what the sentence at the top of this page means and is not always what is
wanted.

This is the pair other toolkits spell as two words — WinForms'
`TableLayoutPanel` with `AutoScroll`, CSS `overflow: auto` around a grid — and
it is worth knowing before reaching for a size read off `Bounds()` on every
resize, which is what it replaces. [`examples/kanban`](../../../examples/kanban)
uses both directions in one window: the board is a `Scroller` arranged
`Horizontal` whose columns are as tall as it is and scroll sideways when there
are more than fit, and each column is a `Scroller` arranged `Vertical` whose
cards are as wide as the column.

**A floor is not what stops a scroller asking its parent for room — `Scrollbars`
is.** An axis that may not scroll has to be given its content's minimum, so the
twenty tiles above under `Scrollbars: "Vertical"` push the window from 900 to
924 wide, with `MinWidth` set or not. Scroll the axis that must not ask.

## Where it is scrolled to

| | |
|---|---|
| `ScrollX` | how far across it is scrolled, in pixels. Assigning **clamps** to `[0, ScrollMaxX]`, so a number past the end means the end |
| `ScrollY` | the same downwards |
| `ScrollMaxX` (ro) | the largest `ScrollX` that still shows content: the content's width minus one view. `0` when there is nothing to scroll |
| `ScrollMaxY` (ro) | the same downwards |
| **event** `Scroll(x, y)` | the position moved — by the user, the wheel, the keyboard, or an assignment. **Both axes are reported together**, so a diagonal move is one event |

**`ScrollY === ScrollMaxY` is the test for *at the bottom***, and that is the
whole of infinite scroll: the maximum is the content minus one view, so it is the
last position that still shows something rather than the content's own height.

**Scrolling to the end of something you just added needs a turn.** A row added in
this turn has no allocation yet, so the maximum is still the old one and
`ScrollY = ScrollMaxY` lands one row short. `Timer.After(0, …)` is where that
belongs — the same rule every measurement here follows.

## What goes wrong

- **The list inside it will not scroll.** It scrolls itself; take the scroller
  away.
- **A jump to the bottom lands one row short.** Do it from `Timer.After(0, …)`.
- **The content is as wide as it likes and there is a horizontal bar nobody
  wants.** `Scrollbars: "Vertical"`, which also makes the child take the view's
  width.
- **Nothing scrolls at all.** The content is smaller than the view, or the child
  was given `Expand` and has grown to exactly the room there is.
- **The content sits in a corner and the rest of the view is empty.** The slot
  is a `Fixed` and `Fill` has nothing to fill; give the scroller an
  [`Arrangement`](#filling-the-room-and-scrolling-when-it-will-not-fit).
- **More content makes the window bigger instead of scrolling.** That axis is
  not one of the `Scrollbars`.

## What it does not do

- **No smooth scroll to a position**, no *scroll into view* for a child: compute
  the position from [`Bounds()`](Widget.md#where-it-is-and-how-big) and assign
  it.
- **No more than one child.**

## See also

[`Container`](Container.md) · [`Picture`](Picture.md) ·
[`DrawingArea`](DrawingArea.md) · [`TableView`](TableView.md)
