# Image

An icon or a small picture, drawn at a size.

The icon beside a caption, the symbol in a row, the logo on an about box. It
draws **either** a name from the desktop's icon theme **or** a file — one at a
time — and it scales what it draws to a size you give.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `File` | a path. Setting it clears `Icon` | [what it draws](#what-it-draws) |
| `Icon` | a theme icon name. Setting it clears `File` | [what it draws](#what-it-draws) |
| `Size` | pixels; `-1` is the icon's natural size. Default `-1` | [how big](#how-big) |
| `LoadBytes(bytes)` | an image already in memory | [what it draws](#what-it-draws) |

## When it is not an `Image`

- **It is a photograph** — [`Picture`](Picture.md), which has `Fit`, `Zoom` and
  the source's own size, and is the control a viewer is built from.
- **It is on a button** — a [`Button`](Button.md) has an `Icon` of its own, and
  builds the box with the caption itself.
- **It is drawn by code** — [`DrawingArea`](DrawingArea.md).

## What it draws

| | |
|---|---|
| `Icon` | a name from the desktop's icon theme — `"document-save-symbolic"`, `"folder"`. **A name the theme lacks is not drawn and is kept**, so a form round-trips; `Application.HasIcon(name)` is how to ask first, and a list of candidates with a shipped one last is the pattern this tree uses |
| `File` | a path to an image, which is what a project's own artwork is. Setting it clears `Icon`, and setting `Icon` clears it: the control draws one thing |
| `LoadBytes(bytes)` | an image already in memory — what [`Http`](../../llm/library.md#http) answers with and `File.LoadBytes` reads. Clears both names, since neither is what is drawn any more. **A verb and not a property**: a `.form` could not carry a megabyte of JPEG |

**Prefer the theme's icon to one of your own.** It follows the desktop into dark
mode and into whatever icon set the user has chosen, and it is the picture they
already recognise. Ship one only for what the desktop has no name for.

## How big

| | |
|---|---|
| `Size` | the pixels it is drawn at; `-1` is the icon's natural size. Default `-1` |

Icon sizes are conventional: 16 in a row or a tree, 24 in a toolbar, 32 or 48 on
a page about something. An SVG icon scales to any of them; a PNG from the theme
picks the nearest size it has.

## What goes wrong

- **Nothing is drawn and nothing said so.** The theme has no such icon. Ask
  `Application.HasIcon`, and keep a fallback.
- **It came out huge, or a dot.** `Size` is `-1` and the file's natural size is
  what you see.
- **An SVG did not load from `File`.** `Picture` reads what `GdkTexture` reads
  and SVG is not among them; an SVG **icon** works through `Icon`, which is the
  theme's road.
- **The icon changed and the old one is still there.** Setting `File` clears
  `Icon` and the other way round — assigning both is the last one winning.

## What it does not do

- **No `Fit`, no `Zoom`, no scrolling.** [`Picture`](Picture.md).
- **No `Click`.** Put it on a [`Button`](Button.md) with `Style: "flat"`.

## See also

[`Picture`](Picture.md) · [`Button`](Button.md) ·
[`DrawingArea`](DrawingArea.md) · [`examples/files`](../../../examples/files)
