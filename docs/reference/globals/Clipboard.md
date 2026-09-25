# Clipboard

Copy and paste, which are not symmetrical.

## Every member

| | | |
|---|---|---|
| `Copy(text)` | put it on the clipboard, now | [copying](#copying) |
| `Paste(cb)` | ask for what is on it | [pasting](#pasting) |
| `CopyImage(bytes)` | put a picture on it, now | [pictures](#pictures) |
| `PasteImage(cb)` | ask for the picture on it | [pictures](#pictures) |

## Copying

| | |
|---|---|
| `Copy(text)` | **immediate**: the text is on the clipboard when the call returns |

What a *Copy* button, a context menu and Ctrl+C all end up in. Copy the **value**
and not what is drawn: the id rather than the truncated label, the amount rather
than the formatted one — unless the formatted one is what somebody would paste
into a message, which is a decision worth making on purpose.

## Pasting

| | |
|---|---|
| `Paste(cb)` | `cb(text)` — **a callback, and it has to be** |

**The clipboard belongs to whoever owns the selection**, which is another
application: its contents arrive when that program answers, and it may be busy,
slow, or gone. `""` arrives when there is nothing to paste — not an error, since
an empty clipboard is an ordinary state of the world, and so is a clipboard
holding a picture.

```js
BtnPaste_Click() { Clipboard.Paste((text) => { if (text) this.Txt.Text = text; }); }
```

## Pictures

| | |
|---|---|
| `CopyImage(bytes)` | **immediate**: the image is on the clipboard when the call returns. `bytes` is an image GDK decodes — a PNG, a JPEG — and `QrView.ToPng()` and `DrawingArea.ToPng()` answer with exactly that |
| `PasteImage(cb)` | `cb(bytes)` with a PNG as [`Bytes`](Bytes.md), or `null` when the clipboard holds no image |

An image is [`Bytes`](Bytes.md) and not a control, the same line
`Picture.LoadBytes` draws: what goes on the clipboard is a **value**, and the
same one can be written to a file or posted somewhere without a copy. GDK sniffs
the format, so an application never names one.

```js
BtnCopy_Click() {
    const area = new DrawingArea();
    /* …draw… */
    Clipboard.CopyImage(area.ToPng(600, 600));
}

Clipboard.PasteImage((png) => {
    if (png) this.Pic.LoadBytes(png);      /* or File.SaveBytes("shot.png", png) */
});
```

**The two pairs do not interchange, and that is the platform's doing.** A
clipboard holding text answers `null` to `PasteImage`, and one holding an image
answers `""` to `Paste`: a selection is whatever the application copied, and
*nothing* is the honest answer when it copied something else.

## What goes wrong

- **The pasted value was used before it arrived.** It is a callback; the line
  after the call runs first.
- **Nothing was pasted.** `""` for text, `null` for an image — the clipboard is
  empty, or what is on it is the other kind.
- **`CopyImage` refused the bytes.** `cannot read 12 bytes: …` names how many
  there were and what GDK made of them; the ordinary cause is bytes that are
  not an image at all, an error page instead of a picture. Read the bytes from
  the image — `File.LoadBytes`, `Http`, `ToPng` — and not from the thing that
  mentioned it.

## What it does not do

- **No files, no HTML, no rich text**, and no *primary selection* (the
  middle-click one): what a control does with the middle button is the
  toolkit's.
- **No ownership**, no *paste requested* callback, and no way to ask what
  formats the clipboard offers — a program asks for the one it wants and learns
  from the answer.
- **No image formats of its own**: `GdkTexture` reads PNG, JPEG and TIFF, and
  anything else is the pixbuf loaders' business — an SVG is not one of them
  here, the same bargain [`Picture`](../widgets/Picture.md) makes.

## See also

[`TextBox`](../widgets/TextBox.md) · [`Picture`](../widgets/Picture.md) ·
[`QrView`](../libraries/QrView.md) · [`Bytes`](Bytes.md) ·
[`markdown`](../../llm/markdown.md), whose `Copy()` is this call
