# DrawingArea

A surface to draw on.

**Nothing else in this widget set puts ink on the screen.** A chart, a gauge, a
banded report, a rendered document, a sparkline in a row: each of them is this
control and a `Draw` handler. The two libraries that ship with the runtime —
[`charts`](../../llm/charts.md) and [`report`](../../llm/report.md) — are a
`DrawingArea` and a thousand lines of painting, and so is
[`markdown`](../../llm/markdown.md).

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Dump()` | → the last frame as text, one call per line | [testing a drawing](#testing-a-drawing) |
| `Redraw()` | the drawing may have changed: ask again | [when it draws](#when-it-draws) |
| `Save(path, [width], [height])` | the same `Draw` into a PNG | [off the screen](#off-the-screen) |
| `SavePdf(path, width, height, [pages], [before])` | the same `Draw`, once per page, into one PDF | [off the screen](#off-the-screen) |
| `ToPng([width], [height])` | the same frame as `Bytes` | [off the screen](#off-the-screen) |
| **event** `Draw(painter, width, height)` | paint it | [the Draw handler](#the-draw-handler) |
| **event** `DrawPage(painter, page, width, height)` | paint one sheet of paper | [the Draw handler](#the-draw-handler) |
| **event** `Paginate(width, height)` | how many sheets it is at that size | [the Draw handler](#the-draw-handler) |

## The `Draw` handler

| | |
|---|---|
| **event** `Draw(painter, width, height)` | paint it. The size is the frame's, in logical pixels |
| **event** `Paginate(width, height)` | **how many sheets this document is at that size**, answered back. [`Printer`](../globals/Printer.md) asks it once the dialog has settled the paper, and prints that many instead of the `Pages` it was given. The size is the printable area in points — the sheet less the printer's own margins. Declare none and the given count stands, which is right for a drawing whose layout does not move with the paper. It runs inside the print operation: measuring is fine, raising events of your own is not |
| **event** `DrawPage(painter, page, width, height)` | paint one **sheet of paper**: raised by [`Printer`](../globals/Printer.md) and by `SavePdf` instead of `Draw`, with the page said out loud. 1-based, and the size is the printable area in **points**. A form that declares none gets `Draw`, which is right for a drawing that is one page |

```js
Plot_Draw(p, width, height) {
    p.Color = p.Dark ? "#78aeed" : "#1c71d8";
    p.LineWidth = 2;
    p.Polyline(points);
    p.Stroke();
}
```

What `painter` is, in full, is
[`Painter`](../../llm/controls.md#painter): colours, the pen, paths, arcs, text
with `Width`/`Markup`/`Align`, images, transforms and a push/pop of state. Two
things about it are worth knowing before anything else:

- **It is valid only inside the `Draw` it came from.** Keeping one and drawing
  from a timer later is a write into memory GTK has freed, and every call on a
  painter whose frame is over throws.
- **It arrives with the theme's ink, the widget's font and a line one wide.**
  `Dark` is how a drawing chooses a palette that works either way round, and
  `Foreground` is the one fact a drawing cannot work out for itself.

**A drawing area has no natural size.** There is nothing inside it to measure, so
one placed with neither a size nor an `Expand` is allocated 0×0 and its handler
is called with a 0×0 frame: nothing draws and the control reads as broken. Give
it a size, or put it in a box and let it expand.

## When it draws

| | |
|---|---|
| `Redraw()` | the data changed: ask for another frame |

**Nothing is drawn twice unless you ask.** GTK paints when it needs to — the
window appearing, a resize, another window moving away — and `Redraw()` is how a
change in *your* data becomes a frame. A drawing that animates is
`Timer.Every` plus `Redraw()`.

## Off the screen

| | |
|---|---|
| `Save(path, [width], [height])` | runs the same `Draw` against an image surface and writes a PNG. Without a size it uses the widget's own — and a surface that has never been allocated has none, so pass one. Refused from inside a `Draw` (one painter, one frame at a time) and above 16384 a side. **A `Draw` that throws writes no file**, and the throw reaches the caller |
| `ToPng([width], [height])` | the same frame as [`Bytes`](../../llm/library.md#bytes) instead of a file: a chart to be posted, attached or put in a reply, with nothing on disk |
| `SavePdf(path, width, height, [pages], [before])` | the same `Draw`, once per page, into one **PDF**. The size is in **points** (72 to the inch; A4 is 595×842), the surface is vector, so text stays text. `before(page)` is called before each page — that is how the handler knows which one it is drawing. A page that throws leaves **no file** |

`Save()` is the same `Draw`, synchronously, which is both how a chart reaches a
report and how a drawing is tested without a screen. `SavePdf()` is what makes a
document leave the application as one file rather than as fourteen PNGs somebody
has to keep together. **Paper is [`Printer`](../globals/Printer.md)'s and not this control's** -- a
printer is a thing outside the program, with a name, a default and a dialog, so
the verbs live on a theme of their own: `Printer.Send(area)` opens the dialog
and `Printer.ToFile(area, path)` writes a PDF without one. What the handler
paints is the same either way, and on paper it is `DrawPage` that paints it.

## Testing a drawing

| | |
|---|---|
| `Dump()` | → the last frame as text, one call per line. Empty until something has been drawn |

**This is how a drawing is asserted**, and it is why every drawing in this tree
has tests at all: `Save()` runs the handler synchronously, so `Dump()` on the
next line is *that frame's* calls — the colours, the fonts, the coordinates, the
text and its options. `tests/report` and `tests/markdown` are both written that
way, and it beats a screenshot for the same reason a number beats a picture.

It also answers *did the frame run to the end*: a handler that threw halfway
leaves a dump with no closing `Pop`.

## What goes wrong

- **Nothing is drawn.** The control is 0×0 — no size and no `Expand` — or the
  handler's name does not match the control's.
- **The drawing is stale.** Something changed the data and nothing called
  `Redraw()`.
- **A painter call threw "the frame is over".** The painter was kept past its
  `Draw`.
- **`Save` wrote nothing.** The handler threw; the exception reaches the caller.
- **`Save` with no size wrote nothing useful.** The widget has never been
  allocated: pass a size.
- **The drawing is invisible on a dark theme.** It is painting the theme's ink on
  the theme's ground, or a colour chosen for one of them: ask `Dark`.

## What it does not do

- **No scene, no shapes to keep.** Every frame is drawn from your data; there is
  nothing to add to and nothing to move.
- **No hit testing.** What is under the pointer is arithmetic you do in
  `MouseDown`, against the same numbers you drew with.
- **No text selection.** Where a character is comes from
  [`Text.IndexAt`/`Text.Bounds`](../../llm/library.md#text), which is what
  `lib/markdown` selects with.

## See also

[`Painter`](../../llm/controls.md#painter) · [`charts`](../../llm/charts.md) ·
[`report`](../../llm/report.md) · [`markdown`](../../llm/markdown.md) ·
[`examples/drawing`](../../../examples/drawing)
