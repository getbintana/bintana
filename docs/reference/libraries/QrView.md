# QrView

A QR code on a form: text in, the symbol drawn, as big as the room allows.

It is a [`Component`](../widgets/Component.md) from the `qr` library — a
[`DrawingArea`](../widgets/DrawingArea.md) with the encoder behind it — so it is
placed in a `.form` like any control and everything on
[`Widget`](../widgets/Widget.md) is on it too. The encoder it wraps is
[`QrCode`](QrCode.md), and everything a view can do is reachable without a form
from the code the `Code` property answers.

```json
{ "name": "Cards", "startup": "MainForm", "uses": ["qr"] }
```

```json
{ "type": "QrView", "name": "Card",
  "properties": { "Ecc": "M", "Width": 180, "Height": 180 } }
```

```js
this.Card.Text = "https://example.com/c/" + id;

if (!this.Card.Code) this.LblProblem.Text = this.Card.Problem;
```

The example is `examples/qr`: any text, what the encoder decided, and the
symbol out as a PNG or an SVG document.

## Every member

**What it shows**

| | | |
|---|---|---|
| `Text` | what is encoded. **Data, not prose** — no catalogue ever translates it. `""` | [what it shows](#what-it-shows) |
| `Code` | the encoded symbol, or `null`. Read-only | [what it shows](#what-it-shows) |
| `Problem` | why there is no symbol, or `""`. Read-only | [what it shows](#what-it-shows) |

**How it looks**

| | | |
|---|---|---|
| `Ecc` | `L` `M` `Q` `H`. `"M"` | [how it looks](#how-it-looks) |
| `QuietZone` | light modules around the symbol, 0 to 16. `4` | [how it looks](#how-it-looks) |
| `Ink` | the dark modules. `"#000000"` | [how it looks](#how-it-looks) |
| `Paper` | the ground. `"#ffffff"` | [how it looks](#how-it-looks) |
| `Refresh()` | redraws now. Assigning any property already does | [how it looks](#how-it-looks) |

**Off the form**

| | | |
|---|---|---|
| `Save(path, [side])` | a PNG, `side` pixels square or the view's own size | [off the form](#off-the-form) |
| `ToPng([side])` | the same, answered as [`Bytes`](../globals/Bytes.md) | [off the form](#off-the-form) |
| `ToSvg()` | an SVG document, in this view's colours and quiet zone | [off the form](#off-the-form) |

## Which one is this

| | |
|---|---|
| **`QrCode`** | the encoder, with no widget in it. Reach for it when the symbol is not going on a form: a PDF page, a `Task`, a console program |
| **`QrView`** | the component. It owns a `QrCode` and shows it, and its `Code` hands the one it made back |
| [`Picture`](../widgets/Picture.md) / [`Image`](../widgets/Image.md) | show a picture that already exists. A `QrView` **makes** one from text |
| [`DrawingArea`](../widgets/DrawingArea.md) | a surface to draw on. A `QrView` is a `DrawingArea` plus the encoder, and the painting is done for you |

## What it shows

| | |
|---|---|
| `Text` | what is encoded. Set it and the symbol is made on the spot, so `Code` answers on the next line. `null` and `undefined` are `""` |
| `Code` | the encoded [`QrCode`](QrCode.md), or `null` when there is nothing to show. Read-only |
| `Problem` | why there is no symbol, or `""` when there is one. Read-only |

**`Text` is data and not prose.** The class declares no text property on
purpose: a URL, a code, an identifier — the things a QR holds — must never go
through a catalogue, or an application running in Spanish would encode a
translated URL and nobody would see it happen. That is also why nothing is
translated back: `Problem` is the encoder's own sentence, in English, and an
application that shows it to a user can put its own words around it.

Text that does not fit does not throw. `Text` is an ordinary form field and the
user can paste a novel into it; the setter clears `Code`, fills `Problem`, and
the view stays on screen. `ToSvg()` is the one verb that **refuses** when there
is no symbol, because it has nothing to answer with.

```js
this.Card.Text = this.Input.Text;
this.LblInfo.Text = this.Card.Code ? "Ready" : this.Card.Problem;
```

## How it looks

| | |
|---|---|
| `Ecc` | `L` `M` `Q` `H`, an error correction level. `"M"`. Higher survives more damage and holds less: the same text can need a higher version, and past the text's limit it stops fitting at all |
| `QuietZone` | the light margin around the symbol, in modules, 0 to 16. `4`, which is the standard's minimum. A code on a form that already has white around it can take fewer; a code printed on a coloured ticket wants more |
| `Ink` | the colour of the dark modules. `"#000000"` |
| `Paper` | the colour behind them. `"#ffffff"` |
| `Refresh()` | redraws. It exists for a property changed **in place**, which is not possible here — assigning anything already redraws |

**Black on white by default, and not the theme's colours.** A QR drawn light on
a dark ground is an inverted code, which plenty of readers refuse, and a code
that scans on one desktop and not on another is the worst kind of bug to report.
`Ink` and `Paper` are there for paper that is not white, and they are a
deliberate choice rather than a follow-the-theme default.

**A module is a whole number of pixels**, and the symbol is centred in what is
left over. The view measures itself, divides by the modules (quiet zone
included) and floors: at 300 pixels for a 29-module code each module is 10
pixels and the 290 drawn leaves 5 on each side. A fractional module antialiases
every edge into grey, which is what makes a code on a screen hard to scan from a
phone. A view smaller than a pixel a module **still draws**, blurred, rather
than nothing — a small code on screen is better than a blank square.

**And `Expand` goes at every level that should give way.** The view's declared
`Width`/`Height` are a *minimum* like any box child's, so a form that wants the
code to take the room puts `Expand: true` on the view **and on each panel
between it and the window**: one level that does not claim the slack leaves the
code its declared size and the rest of the row dead against the far edge. That
is what put a 160-pixel code in a 760-pixel window in this example's first
version — the inner view expanded, the panel holding it did not.

## Off the form

| | |
|---|---|
| `Save(path, [side])` | a PNG of `side` pixels square, or of the view's own allocation. The file goes through [`DrawingArea.Save`](../widgets/DrawingArea.md), so the same `Canvas_Draw` runs against an image surface, synchronously |
| `ToPng([side])` | the same PNG answered as [`Bytes`](../globals/Bytes.md), for an upload or a database column, with no file in between |
| `ToSvg()` | the symbol as an SVG document, in this view's `Ink`, `Paper` and `QuietZone`. It **refuses** when there is no symbol rather than writing an empty file |

An SVG is usually the better one for print: it is resolution independent, it is
text and it is small. A PNG is for wherever a picture is expected — an e-mail, a
chat, a document that embeds images — and for a chat the picture can go
straight to the clipboard: `Clipboard.CopyImage(this.Card.ToPng(600))`, with
[`Clipboard.PasteImage`](../globals/Clipboard.md) to read one back.

Both roads ask the encoder, not the screen, so a view that has never been shown
still saves: the symbol comes from `Text`, and the size from the argument or the
view's own. When the size comes from the view, the view has to have been laid
out — `Bounds()` is the allocation and nothing else.

## What goes wrong

| Symptom | |
|---|---|
| The code is blank and `Code` is `null` | `Text` is empty, or it does not fit. `Problem` says which |
| `Text` set and the symbol is the old one | Assignment re-encodes; if the view is not on screen yet there is no frame to redraw, and the symbol appears when it is shown |
| The code does not scan off a screenshot | The screen draws whole pixels per module, but a scaled screenshot may not. Save the PNG and try that |
| `ToSvg` throws *there is no symbol* | Nothing to write. Ask `Code` first, as the example does |

## What it does not do

- **It does not decode.** It draws codes; nothing here reads one. There is no
  camera and no decoder in the runtime.
- **It raises no event.** The text is encoded in the setter, so the answer is
  on the next line — and a setter raises nothing, because a `.form` assigns it
  before the host's controls exist. A form that needs to react to a new symbol
  reacts where it assigned the text.
- **It does not translate its text.** See above; that is the point.
- **It does not pick a quiet zone for the surroundings.** Four modules is the
  standard's answer; a form with white around the code is the caller's decision.

## See also

[`QrCode`](QrCode.md) · [`DrawingArea`](../widgets/DrawingArea.md) ·
[`Picture`](../widgets/Picture.md) · [`Bytes`](../globals/Bytes.md) ·
[`examples/qr`](../../../examples/qr) · [llm/qr.md](../../llm/qr.md), the short
form
