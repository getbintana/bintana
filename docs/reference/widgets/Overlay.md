# Overlay

Stacked: the first child fills, the rest float on top.

A spinner over a list that is loading, a banner over a page, a caption on a
video, a badge on a picture. It adds **no member of its own** to
[`Container`](Container.md) — what it does is give three of `Container`'s and
`Widget`'s a meaning of their own.

## Every member

None of its own. What matters is what these mean **here**:

| | |
|---|---|
| `Children[0]` | its real children, one level deep, in the order they are in |
| `Reorder(child, 0)` | moves a child among its siblings. The index counts them *without* the one being moved. **Every container with an order answers it**: a box, a `Grid`, a `Flow`, a `RowList`, a `Notebook`, a `Switcher`, a `Split` (the index names the half) and an `Overlay` (index `0` is the base layer, the one that fills). A `Fixed` refuses — there the order is the painting order, which is `Raise`/`Lower` |
| `Raise()` / `Lower()` | to the top of the painting order, among its siblings on a surface |
| `HAlign` / `VAlign` | `Auto` `Start` `End` `Center` `Fill` — what becomes of it when the container is not the size the coordinates were drawn for |

**`X`/`Y` mean nothing in an overlay and are not saved.** A stack is not a drawing
surface: there is no coordinate to give a layer, so a hand-written `.form`
carrying `X`/`Y` on one loses those two numbers the first time it is saved.

## On a form

A message over the content rather than in front of it:

```json
{ "type": "Overlay", "name": "Stage",
  "children": [
    { "type": "ListBox", "name": "List" },
    { "type": "Panel", "name": "Toast",
      "properties": { "HAlign": "Center", "VAlign": "End", "Margin": 16,
                      "Style": "osd", "Visible": false } } ] }
```

The list is the base because it is first; the panel floats at the bottom centre
and is shown when there is something to say. That is
[`examples/notify`](../../../examples/notify).

## What goes wrong

- **The floating layer fills the whole stack.** It said nothing about where it
  sits: `HAlign`/`VAlign`.
- **The base layer is the wrong one.** It is `Children[0]`;
  `Reorder(child, 0)` or `Lower()` on the one that should fill.
- **The coordinates in the file disappeared.** They mean nothing here and are not
  written.
- **Something on top swallows the clicks.** A floating layer that is
  [`Visible`](Widget.md#shown-enabled-focused) is a widget: hide it, or make it
  smaller than the whole stack.

## What it does not do

- **No opacity animation, no transitions.** `Opacity` is
  [`Widget`](Widget.md#how-it-looks)'s and is a number, not a fade.
- **No modality.** A layer over a form does not stop the form underneath from
  being used; a modal window is [`Form`](Form.md)'s `Modal`.

## See also

[`Container`](Container.md) · [`AspectFrame`](AspectFrame.md) ·
[`Spinner`](Spinner.md) · [`examples/notify`](../../../examples/notify)
