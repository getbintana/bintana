# Separator

A rule.

A line between two groups of controls, or between the items of a toolbar. It is
the cheapest way to say *these belong together and those do not*.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` | [the line](#the-line) |

## The line

| | |
|---|---|
| `Orientation` | which way it runs. A `Horizontal` separator is a line across, between two rows of things; a `Vertical` one divides a toolbar |

**The thickness is the line**: a separator paints its whole allocation, so one
given a `Height` of 12 is a line twelve pixels thick and not a hairline with room
around it. Room around it is [`Margin`](Widget.md#how-it-is-placed), which is
what was wanted.

## When it is not a `Separator`

- **The two halves should be resizable** — [`Split`](Split.md), whose divider is
  draggable.
- **The group needs a name** — [`Frame`](Frame.md), which has a caption and a
  line around the whole of it.
- **It is a menu separator** — that is `{ "separator": true }` in the menu's own
  array, not this control.

## What goes wrong

- **It came out as a thick band.** It was given a height; see above.
- **It is invisible.** In a box with no size, a separator across the axis has no
  length to draw along — an `HExpand` is what gives it one.

## What it does not do

- **No colour, no style of its own** beyond what
  [`Widget`](Widget.md#how-it-looks)'s `Background` and `Style` give it.

## See also

[`Frame`](Frame.md) · [`Split`](Split.md) · [`Panel`](Panel.md)
