# Control

The branch of the hierarchy for everything that is not a container.

A [`Label`](Label.md), a [`Button`](Button.md), a [`TextBox`](TextBox.md), a
[`Slider`](Slider.md) and the rest all have `Control` as their parent, and
`Control` has [`Widget`](Widget.md) as its own. **It adds nothing**: it exists so
that the hierarchy says out loud which classes hold other controls and which do
not.

## Every member

None. Everything is [`Widget`](Widget.md)'s.

## What it is for

Two questions are answered by a class being under this one rather than under
[`Container`](Container.md):

- **whether a control can be dropped into it** — the designer asks
  [`Placement`](Container.md#not-every-container-arranges), and a control is not
  a place;
- **what a `.form` may nest** — a node with `children` under a control is a file
  the loader will refuse.

`Widget.Types()` lists every class this build has, and a class's parent is part of
what it answers; `Widget.Available(name)` says whether this build can really make
one, which is a different question — see
[`Terminal`](Terminal.md), the one control that may be missing.

## See also

[`Widget`](Widget.md) · [`Container`](Container.md)
