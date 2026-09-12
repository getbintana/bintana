# Scroller

Content whose size is not its parent's business.

The view is as big as the room it is given, the content as big as it needs, and
the difference scrolls. A long form, a picture bigger than the window, a column of
results: one control around it and the problem is gone.

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

**The child of a scroller sits on a `Fixed` surface**, which means a child with no
declared size is as big as it asks to be and not as big as the view. A drawing
that should be the width of the view either declares a width or draws itself —
see [`DrawingArea`](DrawingArea.md).

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

## What it does not do

- **No smooth scroll to a position**, no *scroll into view* for a child: compute
  the position from [`Bounds()`](Widget.md#where-it-is-and-how-big) and assign
  it.
- **No more than one child.**

## See also

[`Container`](Container.md) · [`Picture`](Picture.md) ·
[`DrawingArea`](DrawingArea.md) · [`TableView`](TableView.md)
