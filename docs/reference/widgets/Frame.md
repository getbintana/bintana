# Frame

A [`Panel`](Panel.md) with a title.

A group of controls with a line around them and a caption on that line: *Filters*,
*Connection*, *Options*. Everything a `Panel` does, it does — the title is all it
adds.

It is a [`Container`](Container.md), so everything there is here too.

## Every member

| | | |
|---|---|---|
| `Text` | the title drawn in its border. **Translated** | [the title](#the-title) |

## The title

| | |
|---|---|
| `Text` | the caption drawn in the frame's own border. **Translated** — a group's name is prose |

With an empty `Text` a frame is a bare box, which is a thing the theme also draws
with `Style: "frame"` on a plain panel; reach for this control when the group has
a **name**, and for the style class when it needs only an edge.

**One group, one frame.** Nesting frames two deep is a form asking for a
[`Notebook`](Notebook.md) or an [`Expander`](Expander.md) instead: at the second
level the lines stop grouping and start decorating.

## What goes wrong

- **The frame is bigger than what is in it.** It is a container: it is as big as
  its child plus its border, and a child with `Expand` in a box is what makes it
  fill.
- **The title is in the wrong language.** It is prose and goes through the
  catalogue like any caption.

## What it does not do

- **No folding.** [`Expander`](Expander.md).
- **No arrangement of its own** beyond [`Container`](Container.md)'s.

## See also

[`Panel`](Panel.md) · [`Expander`](Expander.md) · [`Container`](Container.md)
