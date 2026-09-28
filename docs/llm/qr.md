# QR — the library that ships with the runtime

Two classes, and the split is the whole idea: **`QrCode` is the encoder**, a
value with no widget in it, and **`QrView` is the component that shows one**. It
is reached the way any library is: name it in `project.json`, then use its class
in a `.form`, or call the encoder from code.

```json
{ "name": "Cards", "startup": "MainForm", "uses": ["qr"] }
```

```json
{ "type": "QrView", "name": "Card",
  "properties": { "Ecc": "M", "Width": 180, "Height": 180 } }
```

```js
this.Card.Text = "https://example.com/c/" + id;
```

The example is `examples/qr`: any text, the version, mode and mask the encoder
chose, and the symbol out as a PNG or an SVG document.

Nothing here is native. The encoder is arithmetic over a table of modules and
the view paints it with `Painter`, so a QR works where no widget can be made —
a console project, a `Task`, a `Report`'s `DrawPage` — which is why the two are
separate classes and not one.

## QrCode

One static verb builds it; everything else is reading what it built.

| Member | |
|---|---|
| `Encode(text, [options])` | the whole encoder. `text` is a string or `Bytes`; a string is encoded in the narrowest mode that holds all of it, as UTF-8 when that is byte mode, and `Bytes` is byte mode as it stands. Answers a `QrCode` |
| `Version` | 1 to 40, the smallest that held the text at the level asked. Read-only |
| `Ecc` | error correction: `L` (7 % recoverable), `M` (15 %), `Q` (25 %) or `H` (30 %). `"M"`. A code at `H` survives more damage and holds less. Defaults to `"M"`. |
| `Mode` | `Numeric`, `Alphanumeric` or `Byte`: what the text was encoded as |
| `Mask` | 0-7 forces that mask instead of scoring all eight. For a test, or a scanner that likes one particular pattern |
| `Size` | modules a side, without the quiet zone. A version 1 code is 21, a version 40 code is 177 |
| `Dark(x, y)` | one module, `true` for dark, `(0, 0)` being the top left. **Outside the symbol is light**, so drawing a border needs no edge test first |
| `Paint(p, x, y, side, [options])` | the symbol onto any [`Painter`](controls.md#painter) — a `DrawingArea`'s frame, a PNG through `Save`, a PDF page. `side` is the whole square **including the quiet zone**, and the modules are laid out inside it |
| `ToSvg([options])` | the symbol as an SVG document, one module to a unit of the view box, `shape-rendering="crispEdges"` so no viewer blurs it. Same `QuietZone`, `Ink` and `Paper` options as `Paint` |
| `ToText([options])` | two rows of modules per line in `█ ▀ ▄` — a console program, and what `tests/qr` reads. `QuietZone`, and `Invert` (`true` draws dark as ink, which is the spelling that scans on a terminal with a dark ground) |

`Encode`'s options:

| Option | |
|---|---|
| `Ecc` | error correction: `L` (7 % recoverable), `M` (15 %), `Q` (25 %) or `H` (30 %). `"M"`. A code at `H` survives more damage and holds less. Defaults to `"M"`. |
| `MinVersion` / `MaxVersion` | 1 to 40. `1` / `40`. The version is the smallest in range that holds the text; text that fits none is refused, saying how much room there was |
| `Mask` | 0-7 forces that mask instead of scoring all eight. For a test, or a scanner that likes one particular pattern |

`Paint`'s and `ToSvg`'s options: `QuietZone` (light modules around the symbol,
`4`, the standard's minimum), `Ink` and `Paper` (`"#000000"` on `"#ffffff"`).
`ToText` takes `QuietZone` and `Invert` (`true` draws dark as ink, which is the
spelling that scans on a terminal with a dark ground).

**The module rectangles are one path and one fill.** Filled one by one, the
antialiased edge of two neighbours each leaves a sliver of the ground between
them — a grey hairline grid over the code, which a reader tolerates and a person
sees.

### What it does not do, each for a reason

- **Kanji mode** — Shift JIS, which nothing in this runtime speaks. Japanese
  text encodes in byte mode as UTF-8 and every reader takes it.
- **ECI** — a byte segment is UTF-8 and readers assume so; declaring it breaks
  old readers rather than helping new ones.
- **Mixed modes** — one segment for the whole text. A URL is lower case and so
  is byte mode from the first character; the optimal split saves a version on
  text nobody here writes.
- **Micro QR and rMQR** — other symbologies sharing the name.

## QrView

A `Component` around a `DrawingArea`, so everything on `Widget` is on it too.

| Member | |
|---|---|
| `Text` | what is encoded, a string. **Data, not prose**: the class declares no text property, so no catalogue ever translates a URL into something else. Defaults to `""`. Set it and the symbol is made on the spot, so `Code` answers on the next line. `null` and `undefined` are `""` |
| `Ecc` | `L` `M` `Q` `H`, an error correction level. `"M"`. Higher survives more damage and holds less: the same text can need a higher version, and past the text's limit it stops fitting at all. Defaults to `"M"`. |
| `QuietZone` | the light margin around the symbol, in modules, 0 to 16. `4`, which is the standard's minimum. A code on a form that already has white around it can take fewer; a code printed on a coloured ticket wants more. Defaults to `4`. |
| `Ink` | the colour of the dark modules. Defaults to `"#000000"`. |
| `Paper` | the colour of the ground. Defaults to `"#ffffff"`. |
| `Code` | the encoded [`QrCode`](../reference/libraries/QrCode.md), or `null` when there is nothing to show. Read-only |
| `Problem` | why there is no symbol, or `""`: text too long for version 40 at this level is the one way an assignment can fail. Read-only |
| `Refresh()` | redraws. It exists for a property changed **in place**, which is not possible here — assigning anything already redraws. Assigning any property already does |
| `Save(path, [side])` | a PNG of `side` pixels square, or of the view's own allocation. The file goes through [`DrawingArea.Save`](../reference/widgets/DrawingArea.md), so the same `Canvas_Draw` runs against an image surface, synchronously |
| `ToPng([side])` | the same PNG answered as [`Bytes`](../reference/globals/Bytes.md), for an upload or a database column, with no file in between |
| `ToSvg()` | the symbol as an SVG document, in this view's `Ink`, `Paper` and `QuietZone`. It **refuses** when there is no symbol rather than writing an empty file. Ask `Code` first, as the example does |

Three decisions that are easy to get the other way round:

- **Black on white by default, not the theme's colours.** A QR drawn light on a
  dark ground is an inverted code, which plenty of readers refuse, and a code
  that scans on one desktop and not on another is the worst kind of bug to
  report.
- **A module is a whole number of pixels on screen**, and the symbol is centred
  in what is left over. A module of 3.4 pixels antialiases every edge into grey,
  which is what makes a code on a screen hard to scan from a phone. A view with
  less than a pixel a module still draws, blurred, rather than nothing.
- **No event.** The text is encoded in the setter, so `Problem` answers on the
  next line — and a setter raises nothing, because a `.form` assigns it before
  the host's controls exist.

`Text` clears `Code` and sets `Problem` rather than throwing: text that does not
fit is a fact about the form's input, not a bug in it. `ToSvg()` — and only it —
refuses when there is no symbol, because there is nothing to answer with.
