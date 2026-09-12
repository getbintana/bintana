# Panel

The plain container: a box, a group, a toolbar, a region of a window.

A `Panel` has **nothing of its own** — everything it can do is
[`Container`](Container.md)'s and [`Widget`](Widget.md)'s — and that is what
makes it the one to reach for by default. It is a surface you draw controls on
(`Arrangement: "Fixed"`, which is the default), or a row, or a column; a
`Panel` arranged as a row with `Style: "toolbar"` holding `flat` buttons **is**
the toolbar this widget set has, and one with a `Style: "card"` is the card.

## Every member

None of its own. What it has is
[`Container`](Container.md) — `Arrangement`, `Spacing`, `Homogeneous`,
`Anchored`, `Children`, `Placement`, `Add`, `Clear`, `Reorder`, `PickAt`,
`ContainerAt`, `LocalPoint`, `FocusNext`, `FocusPrevious` — and
[`Widget`](Widget.md), which is where `Style`, `Background`, `Margin`,
`Padding`, `Radius`, `Border` and the mouse and key events are.

**That is the point rather than an omission.** A container that added words of its
own would be a second way to say what `Arrangement` already says.

## Which container is this one

| | reach for it when |
|---|---|
| **`Panel`** | **a box, a row, a column, or a surface to draw controls on — the default** |
| [`Frame`](Frame.md) | the group needs a caption and a line around it |
| [`Grid`](Grid.md) | labelled fields whose captions may grow in translation |
| [`Split`](Split.md) | two regions the user may resize, with a divider |
| [`Notebook`](Notebook.md) | pages the user chooses between, with a strip of tabs |
| [`Switcher`](Switcher.md) | pages the **program** chooses between, with no strip |
| [`Scroller`](Scroller.md) | the content is bigger than the room |
| [`Overlay`](Overlay.md) | something on top of something else — a spinner over a list |
| [`AspectFrame`](AspectFrame.md) | a rectangle that must keep its proportion |
| [`Flow`](Flow.md) | as many across as fit, wrapping — a gallery |

**A `Panel` inside a `Panel` is the ordinary way to build a window**: a column
holding a toolbar, a body and a status line, where the body is another panel —
see [Container](Container.md#which-model-a-form-should-use), which is the same
question answered with a measurement.

## On a form

A toolbar, a body and a status line, which is most windows:

```json
{ "type": "Panel", "name": "Root",
  "properties": { "Arrangement": "Vertical", "Spacing": 8, "Margin": 8 },
  "children": [
    { "type": "Panel", "name": "ToolBar",
      "properties": { "Arrangement": "Horizontal", "Spacing": 6, "Height": 34,
                      "Style": "toolbar" } },
    { "type": "Panel", "name": "Body",
      "properties": { "Expand": true } },
    { "type": "Label", "name": "LblStatus",
      "properties": { "Style": "dim-label", "Alignment": "Start" } } ] }
```

`Body` is a `Fixed` surface inside a column: **boxes for the skeleton,
coordinates inside a region**. `Expand` on it is what gives the middle the room
left over, and nothing else in the file is a number about where anything is.

## What goes wrong

- **The controls piled up in a corner.** The panel is a row or a column, where
  `X`/`Y` mean nothing. Give it `Arrangement: "Fixed"`, or place the children
  with `Expand`/`HAlign` instead.
- **Nothing grew when the window did.** In a box, the child that takes the slack
  says so with `Expand`; on a surface, a control that stretches says
  `HAlign: "Fill"`.
- **The panel has no size.** A `Panel` is as big as what is in it, and an empty
  one is nothing at all. A region that must keep a size says so with `Height` or
  `MinHeight`.
- **The background colour did nothing visible.** An empty panel has no ink of its
  own; what paints is `Background`, and a `Style` class is the better answer —
  `card`, `toolbar`, `view`.

## What it does not do

- **No caption, no border of its own.** [`Frame`](Frame.md) has the caption;
  `Border`, `Radius` and `Style` are `Widget`'s.
- **No scrolling.** [`Scroller`](Scroller.md).
- **No pages, no halves, no layers.** Those are containers of their own, which is
  why this one stays empty.

## See also

[`Container`](Container.md) · [`Frame`](Frame.md) · [`Grid`](Grid.md) ·
[`Split`](Split.md) · [`Scroller`](Scroller.md)
