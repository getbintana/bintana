# QrCode

A QR code, as data: the encoder, and the modules it produced. Nothing about how
they are shown.

It is **not a control**. It is a class in the `qr` library that ships with the
runtime, reached with `uses`, and it is arithmetic over a table of booleans — no
widget, no display, nothing native. That is what lets one symbol be painted on a
[`DrawingArea`](../widgets/DrawingArea.md), drawn into a PDF page, printed on a
receipt or written out as an SVG document, and it is why
[`QrView`](QrView.md) is a separate class that wraps it.

```json
{ "name": "Cards", "startup": "MainForm", "uses": ["qr"] }
```

```js
const qr = QrCode.Encode("https://example.com/c/" + id, { Ecc: "M" });

qr.Size                                  // 45: modules a side, no quiet zone
qr.Dark(0, 0)                            // one module
qr.Paint(painter, 20, 20, 120);          // onto any Painter
File.Save("card.svg", qr.ToSvg());
```

It implements ISO/IEC 18004 model 2: versions 1 to 40, the four error correction
levels, and the numeric, alphanumeric and byte modes.

## Every member

**The encoder**

| | | |
|---|---|---|
| `Encode(text, [options])` | text in, a `QrCode` out. The whole encoder | [encoding](#encoding) |
| `Version` | 1 to 40, the smallest that holds the text. `1`…`40` | [the version](#the-version) |
| `Ecc` | `L` `M` `Q` `H`, as asked. `"M"` | [the level](#the-level) |
| `Mode` | `Numeric` `Alphanumeric` `Byte`, what the text was encoded as | [the modes](#the-modes) |
| `Mask` | 0-7, the one the penalty rules chose | [the mask](#the-mask) |

**The symbol**

| | | |
|---|---|---|
| `Size` | modules a side, **without** the quiet zone | [the grid](#the-grid) |
| `Dark(x, y)` | one module, `true` for dark; outside the symbol is light | [the grid](#the-grid) |

**Drawing it**

| | | |
|---|---|---|
| `Paint(p, x, y, side, [options])` | onto any `Painter`, quiet zone included | [painting](#painting) |
| `ToSvg([options])` | an SVG document, one module to a unit | [off the screen](#off-the-screen) |
| `ToText([options])` | block characters, two rows a line | [off the screen](#off-the-screen) |

## Encoding

| | |
|---|---|
| `Encode(text, [options])` | the whole encoder. `text` is a string or `Bytes`; a string is encoded in the narrowest mode that holds all of it, as UTF-8 when that is byte mode, and `Bytes` is byte mode as it stands |

| Option | |
|---|---|
| `Ecc` | error correction: `L` (7 % recoverable), `M` (15 %), `Q` (25 %) or `H` (30 %). `"M"` |
| `MinVersion` | the smallest version that may be used, 1 to 40. `1` |
| `MaxVersion` | the largest. `40`. The version chosen is the **smallest in range that holds the text**; text that fits none is refused, and the sentence says at which version and level and how many bits of room there were |
| `Mask` | 0-7 forces that mask instead of scoring all eight. For a test, or a scanner that likes one particular pattern |

The text is one segment. There is no mode switching inside it: a URL is lower
case and so is byte mode from its first character, and the optimal split would
save a version on text nobody writes here.

### The modes

| | |
|---|---|
| `Mode` | `Numeric`, `Alphanumeric` or `Byte`: what the text was encoded as |

| Mode | Holds | Bits a character |
|---|---|---|
| `Numeric` | `0-9` | 3⅓ |
| `Alphanumeric` | `0-9`, `A-Z`, space and `$%*+-./:` | 5½ |
| `Byte` | anything, as UTF-8 | 8 |

The mode is chosen, never declared, and `Bytes` is always byte mode even when
its contents are digits — bytes are bytes.

### The version

| | |
|---|---|
| `Version` | 1 to 40, the smallest that held the text at the level asked. Read-only |

`Version` is a consequence of the text and the level, not a request:
`QrCode.Encode("a".repeat(18))` answers version 2 where 17 bytes still fit
version 1. `MinVersion` and `MaxVersion` are how a caller bounds it — one
version for a sheet of labels, or a floor so a short code is not drawn tiny
beside a long one.

`Size` follows from it: **17 + 4 × Version** modules a side, plus what the quiet
zone adds. Version 40 is 177 modules a side.

### The level

The level trades capacity for damage tolerance, and the penalty is real: 2953
bytes fit version 40 at `L`, 2334 at `M`, 1666 at `Q` and 1276 at `H`. A code
that is going to be printed small, or stuck on something that gets dirty, wants
a higher level; a code with a URL that barely fits wants `L`.

### The mask

The standard's section 7.8.3 scores eight masks by four penalty rules and the
encoder applies the cheapest. `Mask` reports which one, and forcing one is only
for a test or an unusual scanner.

**Two correct encoders can disagree here, and both symbols are readable.** The
third rule penalises a `1:1:3:1:1` finder-like pattern "preceded or followed by
light area 4 modules wide", and implementations differ about whether the
**quiet zone** is that light area. Measured against `qrcode` for Node: of six
inputs the two agree on four, and the two they differ on are exactly where the
four light modules fall outside the symbol. This library follows Project
Nayuki's reference, which counts the border the way ZXing does, and
`tests/qr` pins the masks it chooses so a rewrite of the rules has to agree.

In other words: a mask difference is not a scanning bug to chase, because every
mask produces a well-formed code. What is worth chasing is the *content*.

## The grid

| | |
|---|---|
| `Size` | modules a side, without the quiet zone. A version 1 code is 21, a version 40 code is 177 |
| `Dark(x, y)` | one module, `true` for dark, `(0, 0)` being the top left. **Outside the symbol is light**, so drawing a border needs no edge test first |

The three finders, the timing patterns, the alignment patterns, the format
information and the version information are all in there: `Dark` answers about
the finished symbol, masks and all.

## Painting

| | |
|---|---|
| `Paint(p, x, y, side, [options])` | the symbol onto any [`Painter`](../../llm/controls.md#painter) — a `DrawingArea`'s frame, a PNG through `Save`, a PDF page. `side` is the whole square **including the quiet zone**, and the modules are laid out inside it |

| Option | |
|---|---|
| `QuietZone` | light modules around the symbol. `4`, which is the standard's minimum |
| `Ink` | the dark modules. `"#000000"` |
| `Paper` | the ground. `"#ffffff"` |

The dark modules are drawn as **one path and one fill**, with a run of dark
modules in a row as a single rectangle. That is not only fewer calls: filled one
by one, the antialiased edge of two neighbours each leaves a sliver of the
ground showing between them — a grey hairline grid over the code, which a reader
tolerates and a person sees.

## Off the screen

| | |
|---|---|
| `ToSvg([options])` | the symbol as an SVG document, one module to a unit of the view box, `shape-rendering="crispEdges"` so no viewer blurs it. Same `QuietZone`, `Ink` and `Paper` options as `Paint` |
| `ToText([options])` | two rows of modules per line in `█ ▀ ▄` — a console program, and what `tests/qr` reads. `QuietZone`, and `Invert` (`true` draws dark as ink, which is the spelling that scans on a terminal with a dark ground) |

## What goes wrong

| Symptom | |
|---|---|
| `text ... do not fit version 40 at level H (2334 bits of data)` | the text is past what the level can hold at the largest version. Lower `Ecc`, shorten the text, or `MinVersion` cannot help — the ceiling is the version |
| `Ecc 'X' is not one of L, M, Q, H` | a level that is not one of the four |
| `versions 5 to 4 are not a range within 1-40` | `MinVersion` above `MaxVersion`, or either outside 1-40 |
| `Mask 8 is not 0-7` | a forced mask outside the eight |
| `expected text or Bytes, got number` | something that is not a string and not `Bytes` |

A `TypeError` is a bad argument and a `RangeError` is a value out of range; both
name `QrCode.Encode` and what was wrong with it.

## What it does not do

- **Kanji mode.** Shift JIS, which nothing in this runtime speaks; Japanese text
  encodes in byte mode as UTF-8 and every reader takes it.
- **ECI.** A byte segment is UTF-8 and readers assume so; declaring it breaks
  old readers rather than helping new ones.
- **Mixed modes.** One segment for the whole text, as above.
- **Micro QR and rMQR**, and no other symbology.
- **Decoding.** It reads nothing; there is no camera and no reader here.

## See also

[`QrView`](QrView.md) · [`DrawingArea`](../widgets/DrawingArea.md) ·
[`Painter`](../../llm/controls.md#painter) · [`Bytes`](../globals/Bytes.md) ·
[`examples/qr`](../../../examples/qr) · [llm/qr.md](../../llm/qr.md), the short
form
