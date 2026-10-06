# A bitmap a program owns: pixels, and the editor that needs them

**Not started for the bitmap; the vector half is built.** This is the plan for
the smallest runtime object that makes a bitmap editor expressible: an image in
process memory whose pixels a program can read and write, and a way to draw into
it with the `Painter` that already exists. It was asked for by the drawing
example, which turned out to be a vector editor; that half is done — the example
is `examples/vector` and every path is editable — and the name `paint` waits for
the bitmap editor of stage 3.

## What is missing, and who asks

`Painter` exists only inside a `Draw` event. There is no object to draw *into*
and keep, and no way to read or write a pixel anywhere in the runtime:

| The editor needs | Bintana has |
|---|---|
| an image in process memory | **Nothing.** `Image` and `Picture` are controls; a decoded picture lives in the widget's qdata and is never handed out |
| read/write one pixel | **Nothing.** `Probe.Image` reads a header; `Bytes.At` reads a byte of a file |
| draw into it with a painter | `Drawing.ToPng`/`Save` run a draw against a *throwaway* surface — the closest thing there is, and the mechanism this plan reuses |
| composite with alpha, erase | `Painter.Image` paints with cairo's default operator only; there is no `Operator` |
| show it | `Painter.Image` takes a path or `Bytes`; a bitmap would be the third source |
| load/save it | Both halves exist for files (`gdk_texture_new_from_filename`, the PNG writer behind `DrawingArea.Save`) |
| undo | Nothing needed: a bitmap editor's undo is a copy of the bitmap, which is `Copy()` |

Three reports produced this plan, in the order they arrived, and each is the
same missing object seen from a different tool: the bucket cannot flood-fill
because there are no pixel colours; the eraser strokes the paper because it
cannot reveal what is under; and a fill is a property of a shape because there
is no region.

### What a bitmap editor is made of

A short list, and nothing on it is exotic:

- an image in memory with a pixel read and a pixel write;
- a painter that can draw *into* it and keep it;
- compositing, including erase;
- a way to show it in a control, and to load and save it;
- undo, which for a bitmap is a copy.

The painter, the loaders and the writers already exist here; what is missing is
the image.

## The object: `Bitmap`

**The name is `Bitmap`** and not `Image` or `Picture` (both controls), not
`Pixels` (that names the access rather than the thing, and a `Pixels` property
would be its bulk form), not `Surface` (cairo's word for something that is not
only pixels), not `Canvas` (which reads as a widget, and the designer already
calls its drawing board that). `Bitmap` is what it is and the name is free.

```js
b = Bitmap.New(800, 600)        // transparent
b.Width  b.Height               // read-only
b.Get(x, y)                     // 0xRRGGBBAA, or null outside the bitmap
b.Set(x, y, colour)             // the int, or a CSS string parsed once
b.Fill(colour)                  // the whole thing
b.FillRect(x, y, w, h, colour)
b.Clear()                       // back to transparent
b.Copy([x, y, w, h])            // a new Bitmap: the undo step and the selection
b.Paint(draw)                   // draw(painter, width, height): a Painter over it
Bitmap.Load(path)               // PNG/JPEG, the same loaders a Picture uses
b.Save(path)                    // PNG, the same writer DrawingArea.Save uses
p.Image(b, x, y, [w], [h])      // shown, drawn, composited -- the third source
p.Operator = "Erase"            // the eraser: cairo's DestOut (new property)
```

Five decisions, each with the reason it is not the other way:

- **Pixels are integers, `0xRRGGBBAA`.** A flood fill reads and writes
  thousands of them; a CSS string per pixel would parse and format on every
  touch. `Set`/`Fill`/`FillRect` accept a string too, because every other
  colour in the language is one and a literal should not need a conversion —
  parsed once, in C. `Get` answers the integer; `(r << 24) | (g << 16) | (b << 8)
  | a` is a number a double holds exactly, and it is the same shape a bulk
  `Pixels` array would have.
- **`Paint(draw)` is `Drawing.ToPng`'s mechanism with the surface kept.** The
  callback gets the same `Painter` a `Draw` event gets, over a
  `cairo_image_surface`; `Drawing.Save`/`ToPng` already build exactly this and
  throw it away. Nothing about GTK is involved, so **a `main` project can make
  an image** — which `Drawing` alone cannot, since it can only write a PNG
  without ever reading one back.
- **`Painter.Operator` is the one painter addition.** Without it there is no
  eraser: painting transparent *over* pixels leaves them, and a stroke's
  coverage is not computable in JavaScript (that is what antialiasing is).
  Three values to begin with — `"Over"` (the default, what happens today),
  `"Source"` and `"Erase"` — named after what they do rather than after cairo's
  `OPERATOR_DEST_OUT`, which is the same bargain `Cursor` makes.
- **A `Bitmap` is not cached by address.** `Painter.Image` decodes `Bytes` on
  every call *because* a freed buffer's address can be handed out again, and
  the path cache exists because a path is stable. A `Bitmap` is a live object
  the caller owns for the length of the call: it is painted from directly, no
  copy and no cache.
- **A worker gets everything but `Paint`.** `New`, `Get`, `Set`, `Fill`,
  `Copy`, `Load` and `Save` are memory and GIO, which the task plan's frontier
  (callbacks, not I/O) allows; `Paint` is cairo and pango, which a worker does
  not install — the same split `Drawing` already has, and for the same reason.

## What it costs

The call boundary is the number that sizes the editor, and it is already
measured in `docs/architecture.md`: a two-argument method is **465 ns** and a
getter **290 ns**. So a flood fill that touches a 800×600 canvas whole is
~480 000 reads and writes, **≈ 0.4 s** — a one-shot on a click, with the
alternative (`Data`/`SetData` bulk access) listed as stage 2 rather than
designed now, because the number says it is not needed for the first editor and
the number is what would change that. Undo is the other cost: an 800×600
bitmap is 1.9 MB, so one whole copy per step is 90 MB at fifty steps — **the
depth is the application's decision**, and the plan says so instead of picking a
number.

**Stage 0 is measuring, before any of it is written**: the `Get`/`Set` round
trip against the 290/465 ns table, `cairo_image_surface` create/fill/destroy,
and a PNG round trip through the existing helpers. If the round trip is an
order of magnitude worse than the table predicts, stage 2 moves first.

## Stages

1. **The object and the painter.** `runtime/src/bta_bitmap.c`: `New`,
   `Width`/`Height`, `Get`/`Set`, `Fill`, `FillRect`, `Clear`, `Copy`,
   `Paint`, `Load`, `Save`; `Painter.Image` takes a `Bitmap`;
   `Painter.Operator`. Registered the five places a global takes
   (`CMakeLists.txt`, `bta.h`, `bta_runtime.c` and `bta_task.c`). The tests are
   `tests/widgets`: a set/get round trip including outside the bounds, a fill,
   a copy that is independent of its source, a `Paint` that draws and saves, a
   `Load`/`Save` round trip byte for byte, an `Operator` erase that leaves
   alpha 0, and a `testTask` step that does the memory verbs in a worker and
   finds `Paint` refused. `tests/api.sh` holds the members to `api.json`.
2. **Bulk data and transforms, each waiting for its caller.** `Data`/
   `SetData` (the pixels as `Bytes`, RGBA), `Draw(other, x, y, [opacity])` for
   a paste that blends, `Resize`, `Flip`/`Rotate`, the other `Save` formats.
   Nothing here is built until stage 1's example asks, and each says which
   measurement would reopen it.
3. **The example.** `examples/paint` is the bitmap editor, and the name is free
   because the vector one took `examples/vector` first. The mechanisms it needs
   are the ones a bitmap editor always has, and none of them is a runtime
   feature:
   - a stroke paints into a **scratch image** the size of the bitmap while the
     pointer is down, tracking the rectangle it touched, and the document
     changes once, on release, by compositing the scratch into a copy of the
     bitmap — which is also the undo step;
   - the eraser is the same road with the operator set to erase;
   - the bucket is a **scanline flood fill** over `Get`/`Set` with a tolerance,
     and its result can be kept as a rectangular selection rather than applied
     at once;
   - a paste is a floating bitmap placed with `Paint`'s translate/rotate and
     composited on commit;
   - undo is a stack of bitmap copies, and its depth is the application's.
4. **The documentation, in the three repositories.** `api.json` by
   `tools/apijson.sh`; `bintana-docs`' `docs/llm/library.md` and its
   `docs/reference/globals/Bitmap.md`, named in `GLOBAL_SECTIONS` and
   `GLOBAL_PAGE_OWNERS` of its `check/Check.js`; `AGENTS.md` (the five places,
   the integer currency, the worker split); `docs/architecture.md`'s boundary
   table if the stage 0 numbers move it.

## What is deliberately not here

- **No filters or effects.** Colourise, blur, brightness and the rest are
  loops over pixels an application can write; one that is wanted twice becomes
  a library.
- **No change to `Image` or `Picture`.** A `Bitmap` is not a widget and a
  control shows it through `Painter.Image`; `LoadBytes` already covers the
  in-memory picture a control needs.
- **No `Data` pointer.** A raw pointer into a pixel buffer is a promise a
  JavaScript value cannot keep; `Bytes` in and out is the shape that can.
- **No raw RGBA argument to `Painter.Image`.** A `Bitmap` is the object; a
  `Bytes` there is still an *encoded* picture, which is the rule that keeps the
  two from being confused.
- **No SVG, no GPU, no vector target.** What is planned is pixels; a document
  of records already has its own example and needs none of this.
- **No change to how a `DrawingArea` draws.** The editor's control is a
  `DrawingArea` whose `Draw` blits the bitmap; the document is the bitmap, not
  the widget.

## The other example: `vector` (built)

The example is a **vector graphics editor** and is kept as one; what it must
not be is a Paint that looks like it should flood-fill. So, and this half is
done:

- It is renamed **`examples/vector`** (directory, class, title, description and
  the header), and the name `paint` goes back to the bitmap editor of stage 3.
  The header says what the model is and what follows from it — a bucket paints
  a shape, an eraser strokes the paper, `Save` rasterizes once — so the three
  reports that produced this plan cannot happen again.
- **Every path is editable.** An **Edit** tool (arrow, first in the row) makes
  a record an object: a click selects the topmost one under the pointer (by its
  bounding box, so an unfilled shape is selectable), a drag moves it, handles
  edit its geometry — a line's two ends, a rectangle's or ellipse's two
  corners, a stroke's bounding box scaling its points, a picture's size — and
  `Delete` removes it. Undo covers it like a stroke, and a drag of the opacity
  slider is **one** step and not fifty: the first change opens a history entry
  and the rest of the adjustment writes over it until something else commits.
- **A line colour and a fill colour, individually.** Two swatches, so a record
  carries `Color` for its outline and `FillColor` for its interior; the bucket
  fills with the fill colour, and the Edit tool's swatches restyle the selected
  path one side at a time. The `Fill` tick decides whether the next shape — or
  the selected one — has an interior at all.
- **The order is editable too**: the selected path can be raised or lowered one
  place at a time.
- **A polyline** joins the shapes: clicks add points, a click on the first
  point closes it into a polygon, `Return` or a double click ends it and
  `Escape` abandons it. It is a record like the others, so it moves, scales,
  restyles and is deleted the same way.
- What it deliberately does not become: a node editor (dragging one point of a
  thirty-point stroke). The handles are the shape's own control points; a
  stroke's points are edited by scaling its box. If node editing is ever
  wanted, that is a second tool and its own argument.
