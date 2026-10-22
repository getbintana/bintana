# ISSUE: no image object to scale, crop or rotate

## What the application needed

A catalogue of 400 products whose photographs arrive at odd sizes, and a form
where the user picks one, crops it to a square and scales it to the 120×120 box
the catalogue shows. The concrete case was a screen with a picture beside the
fields, where the picture has to end up the same size as every other one.

## What I wrote instead

A `DrawingArea` and a `Painter` that draws the file by hand: `Painter.Image`
puts a picture on the canvas at a rectangle the handler computes, so every
scale is arithmetic in the application and every crop a rectangle it works out.
Nothing that is not drawn on that canvas can be scaled at all.

## The code I wish I could have written

```js
// a picture as a value, with the transforms on it:
const img = Bitmap.Load(path)
img.Scaled(120, 120)                // a new picture, 120 wide
img.Crop(10, 20, 300, 300)          // a new picture, the box kept
img.Rotated(90)                     // a new picture, turned
this.Pic.Source = img               // and the control that shows it
```

## Why the existing words do not cover it

`Probe.Image(path)` reads a picture's header and answers `{ Width, Height }` and
nothing else; docs/notes/probe.md says why it is not a verb on `File` — it is the
measurement, and there is no image object behind it. `Picture` shows a file and
`Image` is a widget; neither transforms, and `Painter.Image` draws rather than
transforming.

## Prior art

GdkPixbuf, already linked with GTK4: `gdk_pixbuf_scale_simple`,
`gdk_pixbuf_rotate_simple`, `gdk_pixbuf_new_subpixbuf`. Qt `QImage::scaled`,
`::copy` and `::transformed`. .NET `System.Drawing.Bitmap`. Delphi `TBitmap`.
VB6 `Image` and `PictureBox` with `PaintPicture`.

## How much it mattered

It works, but a part of it is noticeably worse: an image the user resizes or
crops is redrawn by hand, and the arithmetic is written again for every form
that wants it.
