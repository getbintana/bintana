# ISSUE: no container that fills the room it is given and scrolls when it cannot

## What the application needed

A wall of live cameras whose count changes at run time: one camera takes the
whole stage, four come out 2x2, and a location with twenty should scroll rather
than force the window to grow. One container has to do both, because how many
cameras there are is only known after the server answers.

## What I wrote instead

A `Grid` with `Homogeneous` and `HExpand`/`VExpand` on every tile, and the
column count computed in code (`Math.ceil(Math.sqrt(n))`). It fills exactly as
wanted, but it cannot scroll: the grid's minimum is the sum of its columns, so
more cameras mean a bigger window minimum instead of more rows to move through.
A `Flow` was the first attempt and it scrolls, but every tile keeps the size it
was declared at and the rest of the stage stays empty. The natural composition
-- a `Grid` inside a `Scroller` -- does not fill: measured, a four-cell grid was
360x260 inside a 900x298 view, and the difference is not scrollable because
there is nothing beyond it.

## The code I wish I could have written

One declaration saying both halves:

```json
{ "type": "Grid", "name": "Tiles",
  "properties": { "Columns": 2, "Homogeneous": true,
                  "Fill": true, "Scroll": true } }
```

The children share the room the container has, and once a child can no longer be
given its minimum the container scrolls instead of asking its parent for more.
The same two words on a `Flow` would answer it as well: what is missing is the
pair, so that the choice between filling and scrolling does not have to be made
before the count is known.

## Why the existing words do not cover it

`Grid` fills with `HExpand`/`VExpand` children and has no scrolling. `Flow`
scrolls itself and does not stretch what is in it. `Scroller` wraps an ordinary
fixed slot, so its content is as big as it needs and a view bigger than that
content leaves the difference empty -- the grid cannot be told to be the size of
the view, and the fixed slot gives it nothing to negotiate with.

## Prior art

WinForms `TableLayoutPanel` with `AutoScroll`, and `FlowLayoutPanel` with
`AutoScroll`; CSS `grid-template-columns: repeat(auto-fill, …)` inside
`overflow: auto`; Android's `GridLayout` inside a `ScrollView`; GTK4's own
`GtkFlowBox` in a `GtkScrolledWindow` -- which is what `Flow` already is, and it
does not stretch either.

## How much it mattered

It works, and a part of it is noticeably worse: one to four cameras are exactly
right, and a location with many more grows the window instead of scrolling.
