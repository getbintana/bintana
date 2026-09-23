# Container

What holds other controls.

A `Panel`, a `Form`, a `Grid`, a `Split`, a `Notebook`, a `RowList` and a
component of your own are all containers, and they share this page: putting
children in, taking them out, what order they are in, and — for the ones that
lay out by coordinate or as a box — how they are arranged.

**You never make one**: `Container` is a class in the middle of the hierarchy,
between [`Widget`](Widget.md) and the containers themselves. Everything on
`Widget` is here too, and everything here is on all of them.

## Every member

**Properties**

| | | |
|---|---|---|
| `Anchored` | children follow the container when it grows | [the two layout models](#the-two-layout-models) |
| `Arrangement` | `Fixed` `Horizontal` `Vertical` — coordinates, a row, a column | [the two layout models](#the-two-layout-models) |
| `Children` (ro) | its real children, one level deep, in order | [putting children in](#putting-children-in) |
| `Homogeneous` | every child the same size along the axis | [rows and columns](#rows-and-columns) |
| `Placement` (ro) | how **this** container places a child | [not every container arranges](#not-every-container-arranges) |
| `Spacing` | pixels between children, in a row or a column | [rows and columns](#rows-and-columns) |

**Methods**

| | | |
|---|---|---|
| `Add(widget)` | puts a widget in, at the end | [putting children in](#putting-children-in) |
| `Clear()` | removes and destroys every child | [putting children in](#putting-children-in) |
| `ContainerAt(x, y, [ignore])` | → the innermost container that could take a drop there | [finding what is where](#finding-what-is-where) |
| `FocusNext()` | → whether the focus moved: Tab, kept inside this container | [the focus](#the-focus) |
| `FocusPrevious()` | → the same, backwards | [the focus](#the-focus) |
| `LocalPoint(x, y, from)` | → `[x, y]`: a point of another widget's, in this one's | [finding what is where](#finding-what-is-where) |
| `PickAt(x, y)` | → the topmost child at that point, or `null` | [finding what is where](#finding-what-is-where) |
| `Reorder(child, index)` | moves a child among its siblings | [the order they are in](#the-order-they-are-in) |

**And what `rad.js` adds** — `AddNode(node)`, which builds a live widget from a
`.form` node and adds it, and `BuildChildren(node)`, which replaces the contents
with that node's children. They are how a form is built, and how a program builds
part of one at run time from a file.

## The two layout models

| | |
|---|---|
| `Arrangement` | `Fixed` (the default) lays children out by `X`/`Y` and `Width`/`Height`; `Horizontal` is a row and `Vertical` a column, where coordinates mean nothing and `Spacing` and `Homogeneous` do |
| `Anchored` | with it off, children stay exactly where they were drawn however big the container gets — a drawing board rather than a window. Default `true` |

**There is no box class.** A container arranged as a row *is* one, and the
arrangement may be changed at any time: the children keep their order, and going
back to `Fixed` restores their coordinates.

### Which model a form should use

This was settled by measuring rather than by taste:
[`examples/clients`](../../../examples/clients) was drawn both ways.

**In coordinates** it is 27 controls and **117 numbers, 54 of them an X or a Y**
— and it broke on a resize, because on a drawing surface the default is *stay
where you were drawn*, so two tables given `Fill` grew straight over the
twenty-five controls that had been given nothing. The failure is invisible at the
size the form was drawn at.

**As boxes** the same window is **17 numbers and not one coordinate**: a column
holding a filter row, a split and a status line, with the split's right half a
column of a grid of fields, the orders and the buttons. Nothing anchors because
nothing is positioned, the divider comes free, and Tab follows the child order
instead of needing one.

So the line is not about how many controls there are:

| | |
|---|---|
| **One dense grid of labelled fields** — a dialog, a properties panel, a login box | a `Fixed`, or a [`Grid`](Grid.md) when a caption may grow in translation. Dragging is the right way to build it, and anchoring is a handful of decisions |
| **A window with regions** — a list beside a detail, a toolbar over a body, anything with a status line | boxes for the skeleton, with a `Fixed` or a `Grid` **inside** each region |

That is what every RAD toolkit converged on — Delphi's `TPanel` with `Align`,
WinForms' docking with anchoring inside it — and both halves are here: an
`Arrangement` on a container, coordinates inside it.

**Two things that bit while measuring it**, and they bite everybody once:
`MinWidth` only means something on an axis whose `HAlign` is `Fill`, so a split's
halves with a `MinWidth` and no `HAlign` let the divider be dragged down to 46
pixels instead of stopping at 280; and a `Button`'s natural width is its label
and nothing else, so a row of them wants a declared `Width` even in a box — which
is a size and not a position, and that is the distinction that matters.

## Putting children in

| | |
|---|---|
| `Add(widget)` | puts a widget in, at the end. A control already somewhere is **moved** here; one that contains this container is refused. A [`Split`](Split.md) refuses a third |
| `Clear()` | removes **and destroys** every child, and the container can be refilled afterwards |
| `Children` (ro) | its real children, one level deep, in the order they are in |

**`Add` moves.** A control that is already in a container comes out of it and
goes into this one — `Remove()` then `Add()` in one step, which is what a
`Parent` assignment means in VB or Delphi. It used to be attached a second time:
GTK refused with a critical, the control stayed where it was, and the new
container held it anyway. Putting a container inside something it contains is
refused before anything moves; it used to hang the program. `Notebook.Append`,
`Switcher.Append` and a tab strip's `SetAction`/`SetTabLabel` follow the same
rule.

A child is taken out with its own [`Delete()`](Widget.md#shown-enabled-focused),
which destroys it, or its own `Remove()`, which detaches it and keeps it alive
for somewhere else.

**Rebuilding a container's contents is the ordinary thing to write**, and every
container takes children again after a `Clear()`:

```js
this.Box.Clear();
for (const one of rows) this.Box.Add(this.rowFor(one));
```

**A [`Grid`](Grid.md) re-flows what stayed**, so a hole closes up rather than
persisting. The one rule that is not uniform is `Split`, which holds exactly two
halves and refuses a third — clearing it and refilling it is fine.

## Rows and columns

| | |
|---|---|
| `Spacing` | pixels between children, in a row or a column |
| `Homogeneous` | every child the same size along the axis — what a row of buttons that must all match wants |

Room *around* one child is its own `Margin`; `Spacing` is the gap between all of
them. Which child absorbs the slack is that child's `Expand`/`HExpand`/`VExpand`,
and what it does with the room it gets is its `HAlign`/`VAlign` — both on
[`Widget`](Widget.md#how-it-is-placed), because they are answers a *child* gives.

## The order they are in

| | |
|---|---|
| `Reorder(child, index)` | moves a child among its siblings. **The index counts them without the one being moved** |

Every container with an order answers it: a box, a [`Grid`](Grid.md), a `Flow`, a
[`RowList`](RowList.md), a [`Notebook`](Notebook.md), a `Switcher`, a
[`Split`](Split.md) (where the index names the half) and an `Overlay` (where
index `0` is the base layer, the one that fills). **A `Fixed` refuses**: there the
order is the painting order, and that is
[`Raise()`/`Lower()`](Widget.md#how-it-is-placed).

In a box the order is the visual order, so `Reorder` moves a control up or down
the column; in a `Notebook` it moves a page along the strip.

## Not every container arranges

| | |
|---|---|
| `Placement` (ro) | how this container places a child: `Coordinates` `Order` `Layers` `Pages` `Halves`. **Every container answers**, including the ones that refuse `Arrangement` |

A [`Grid`](Grid.md), a `Flow`, a [`RowList`](RowList.md), an `Overlay`, a
[`Notebook`](Notebook.md), a `Switcher` and an `AspectFrame` arrange by their own
nature and refuse `Arrangement` — a grid is a grid. `Placement` is what to ask
when the question is *what would happen if I dropped a control in here*, which is
what an editor asks, and it is why the IDE needs no table of container kinds.

## The focus

| | |
|---|---|
| `FocusNext()` | → whether the focus moved: what Tab does, kept **inside this container** |
| `FocusPrevious()` | → the same, backwards |

Tab already walks a form; these are for the case where a region has to keep it —
a dialog inside a page, a panel that traps the keyboard while it is open.

Where Tab goes on a surface laid out by coordinate is each control's
[`TabIndex`](Widget.md#how-it-is-placed); in a box it is the child order, which
is one of the things boxes give you for nothing.

## Finding what is where

| | |
|---|---|
| `PickAt(x, y)` | → the topmost child at that point, or `null`. **At any depth**: what comes back may be a label inside a panel inside a row |
| `ContainerAt(x, y, [ignore])` | → the innermost container that could take a drop there. `ignore` excludes the widget being dragged, which would otherwise always answer |
| `LocalPoint(x, y, from)` | → `[x, y]`: a point in another widget's coordinates, expressed in this container's |

These three are what a designer, a drag and drop and a context menu are built
from, and they are in the runtime rather than in the IDE because every one of
them is a question about the widget tree that no program can answer for itself.

## What goes wrong

- **Controls piled up in a corner.** The container is a row or a column, where
  `X`/`Y` mean nothing.
- **A control did not move when the window grew.** On coordinates the default is
  *stay where you were drawn*: `HAlign`/`VAlign` are what a control does with the
  slack, and `Fill` is what makes it stretch.
- **Two controls grew over each other.** The same thing, from the other side: on
  a drawing surface, giving `Fill` to something with neighbours that were given
  nothing is how a form that looked right at its drawn size comes apart.
- **The divider can be dragged to nothing.** `MinWidth` only means something on
  an axis whose `HAlign` is `Fill`.
- **A row of buttons came out ragged.** A button's natural width is its label:
  declare a `Width` on each, or turn on `Homogeneous`.
- **`Arrangement` was refused.** That container places children by its own nature;
  ask `Placement`.
- **A third `Add` threw.** A `Split` has two halves.
- **`Clear()` destroyed something that was wanted afterwards.** It destroys;
  `Remove()` on the child detaches it and keeps it.

## What it does not do

- **No `Parent`.** A widget does not publish what holds it — see
  [Widget](Widget.md#what-it-does-not-do).
- **No layout beyond the two models and the containers that have their own.**
  There is no constraint solver, no flex grammar, no anchors-with-percentages: a
  region is a box, and what is inside a region is coordinates or a grid.
- **No scrolling.** A container is as big as it is;
  [`Scroller`](Scroller.md) is the one that scrolls.

## See also

[`Widget`](Widget.md) · [`Grid`](Grid.md) · [`Split`](Split.md) ·
[`Notebook`](Notebook.md) · [`Scroller`](Scroller.md) ·
[`examples/clients`](../../../examples/clients), the window that was drawn both
ways · [forms.md](../../llm/forms.md), for what a `.form` declares
