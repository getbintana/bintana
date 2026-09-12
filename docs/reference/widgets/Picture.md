# Picture

A photograph, which is not an icon.

Reach for it whenever the thing being shown is an image in its own right — a
photo, a screenshot, a scan, a downloaded picture — rather than a symbol at a
size. What it adds over [`Image`](Image.md) is the two questions a viewer has to
answer: **what to do with the room there is**, and **how big to be whatever the
room is**.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `File` | the photograph's path | [what it shows](#what-it-shows) |
| `Fit` | `Fill` `Contain` `Cover` `ScaleDown`. Default `"Contain"` | [fit and zoom](#fit-and-zoom) |
| `SourceHeight` (ro) | the file's own height | [fit and zoom](#fit-and-zoom) |
| `SourceWidth` (ro) | the file's own width, `0` with no file | [fit and zoom](#fit-and-zoom) |
| `Zoom` | a factor, for when `Fit` is not what is wanted | [fit and zoom](#fit-and-zoom) |
| `LoadBytes(bytes)` | the photograph out of memory instead | [what it shows](#what-it-shows) |

## What it shows

| | |
|---|---|
| `File` | the path. What `GdkTexture` reads: PNG, JPEG, WebP, TIFF, BMP. **SVG is not among them** — a scalable icon is the pixbuf loaders' business, which is why an [`Image`](Image.md) draws one and this does not |
| `LoadBytes(bytes)` | the photograph out of memory — a download shown without a temporary file. Clears `File`, and `SourceWidth`/`SourceHeight` measure it the same way |

## Fit and zoom

| | |
|---|---|
| `Fit` | what to do with the room there is: `Contain` (the whole picture, letterboxed), `Cover` (fill the room, cropping), `Fill` (stretch, distorting) or `ScaleDown` (never enlarge). Default `"Contain"` |
| `Zoom` | how big to be, whatever the room is: a factor, where `1` is one image pixel to one screen pixel. `0` means *let `Fit` decide* |
| `SourceWidth` (ro) | what is really in the file, which is the number a zoom is computed from and the one a title bar shows. `0` when nothing is loaded |
| `SourceHeight` (ro) | the same, downwards |

**`Fit` and `Zoom` answer two different questions**, and which one a program wants
says what kind of program it is:

- a picture **on a form** — a thumbnail, an avatar, an illustration — wants
  `Fit`, and the room is whatever the layout gives it;
- a picture **in a viewer** wants `Zoom`, inside a [`Scroller`](Scroller.md),
  because scrolling around a photograph means the picture is bigger than the
  window.

*Fit to window* in a viewer is therefore not a mode this control has: it is a
zoom worked out from the room — `SourceWidth` and the scroller's size — which is
what [`examples/viewer`](../../../examples/viewer) does and why `SourceWidth` is
published at all.

## What goes wrong

- **An SVG shows nothing.** Not a texture format; use [`Image`](Image.md) with
  `Icon`, or convert it.
- **The picture is distorted.** `Fit: "Fill"` stretches; `Contain` is the one
  that keeps the proportion.
- **Zooming does nothing.** `Fit` is deciding: set `Zoom` to a factor, and the
  control stops fitting.
- **The picture is enormous in a form.** A `Picture` with no room to fit into is
  as big as the file; give it a size, an `Expand`, or `ScaleDown`.
- **`SourceWidth` is 0.** Nothing is loaded, or the file is not an image.

## What it does not do

- **No scrolling of its own.** A [`Scroller`](Scroller.md) around it, which is
  what makes the pair a viewer.
- **No rotation, no cropping, no editing.**
- **No animation.** A video is [`Video`](Video.md).

## See also

[`Image`](Image.md) · [`Scroller`](Scroller.md) · [`Video`](Video.md) ·
[`examples/viewer`](../../../examples/viewer)
