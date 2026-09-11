# ISSUE: a `Fixed` container does not stretch a `Fill` child when it grows

## What the application needed

A wall of live cameras: a `Component` of its own per camera -- a frame with the
camera's name, a `Video` inside -- put in a `Grid` where every cell shares the
stage. The tile's frame is declared `HAlign: "Fill"`, `VAlign: "Fill"`, exactly
as a control on a drawing surface is supposed to follow the room it is given.

## What I wrote instead

Changed the component's `Arrangement` from the default `Fixed` to `Vertical`
and gave the frame `HExpand`/`VExpand`. The tile fills its cell now, and the
cost is that a reusable component is a different shape from every other `.form`
in the tree for a reason it cannot state: nothing said the arrangement was the
thing to change, and `HAlign`/`VAlign` read back correct the whole time.

## The code I wish I could have written

The declaration that was already written, with the component's default
arrangement and no extra `HExpand`/`VExpand`:

```json
{ "type": "Panel", "name": "Box",
  "properties": { "X": 0, "Y": 0, "Width": 180, "Height": 130,
                  "HAlign": "Fill", "VAlign": "Fill" } }
```

inside a `Component` declaring `HAlign: "Fill"`, `VAlign: "Fill"`,
`HExpand: true`, `VExpand: true`. `Fill` keeps both gaps, and a frame drawn at
180x130 with no gap should be 438x189 when the component is.

## Why the existing words do not cover it

Measured on one form, three containers in the same expanded grid:

```
FixedThing  FixedThing 438x189     (Component, arrangement Fixed)
  Box  Panel 178x128
BoxThing    BoxThing   438x189     (Component, arrangement Vertical)
  Box  Panel 436x187
FixedPanel  Panel      438x189     (a plain Panel, arrangement Fixed)
  FixedPanelBox  Panel 180x130
```

`HAlign`/`VAlign: Fill` on a child of a `Fixed` surface is documented as
keeping both gaps and stretching; here the child keeps its declared size, on a
`Component` and on a plain `Panel` alike. `Arrangement` is the way around it,
which makes the arrangement of a reusable component a decision its host cannot
make and its author has to know.

## Prior art

VB6 `Align = vbClient`, Delphi `TPanel.Align = alClient` and WinForms
`Dock = Fill` all let the parent decide and the child follow. Qt layouts and
GTK4's own `halign`/`valign` apply to the child whatever kind of container
holds it.

## How much it mattered

It works, and a part of it is noticeably worse: the fix is one property, but a
component that has to be a box to stretch cannot also be the fixed drawing
surface a designer laid out.
