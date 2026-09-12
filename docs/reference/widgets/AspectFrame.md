# AspectFrame

A rectangle of a given proportion, centred in the room there is.

One child, and it gets the whole of that rectangle. A 16:9 tile in a wall of
tiles, a square avatar, a preview that must keep the shape of the paper it
stands for.

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Ratio` | the proportion to keep, as `"16:9"`. `0` or `""` is the child's own | [the proportion](#the-proportion) |

## The proportion

| | |
|---|---|
| `Ratio` | `"16:9"`, `"16/9"` or a number. **`0` or `""` is the child's own**, which is the default. It is **kept as written**, so the `.form` and the property grid answer `"16:9"` and not `1.7778`, and it is settable while the program runs — which is when a stream's real shape arrives |

**What it is for is not the picture but the rectangle the picture occupies.**
[`Picture`](Picture.md) and [`Video`](Video.md) already letterbox inside
themselves with `Fit: "Contain"`; what they cannot do is tell anything else
*where* the image ended up, so a caption in the corner of a 16:9 stream lands out
on the black. Put the picture in an aspect frame with an
[`Overlay`](Overlay.md) over it and `HAlign`/`VAlign` mean the image's corners.

**Its minimum is its child's**, which is what makes it usable in a wall of them: a
frame over a child that asks for nothing asks for nothing. Measured: a child
requesting 200x100 under `Ratio: "16:9"` gives the frame a minimum of 200x113 —
the child's own on one axis and the proportion on the other.

## What goes wrong

- **It ignores the ratio.** `Ratio` is `0` or `""`, which means *the child's
  own*.
- **The tile is enormous.** An aspect frame takes the room it is given and keeps
  the shape; the size comes from the layout around it.
- **The caption is still on the black.** It is inside the picture rather than in
  an overlay over the frame.

## What it does not do

- **No second child**, no arrangement: one child, one rectangle.
- **No cropping.** The child decides what to do inside the rectangle — `Fit` on
  a picture, a drawing's own maths on a
  [`DrawingArea`](DrawingArea.md).

## See also

[`Overlay`](Overlay.md) · [`Picture`](Picture.md) · [`Video`](Video.md)
