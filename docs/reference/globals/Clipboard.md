# Clipboard

Copy and paste, which are not symmetrical.

## Every member

| | | |
|---|---|---|
| `Copy(text)` | put it on the clipboard, now | [copying](#copying) |
| `Paste(cb)` | ask for what is on it | [pasting](#pasting) |

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
an empty clipboard is an ordinary state of the world.

```js
BtnPaste_Click() { Clipboard.Paste((text) => { if (text) this.Txt.Text = text; }); }
```

## What goes wrong

- **The pasted value was used before it arrived.** It is a callback; the line
  after the call runs first.
- **Nothing was pasted.** `""` — the clipboard is empty, or what is on it is not
  text.
- **A picture would not paste.** Text only.

## What it does not do

- **No images, no files, no HTML**, and no *primary selection* (the middle-click
  one): what a control does with the middle button is the toolkit's.
- **No ownership**, no *paste requested* callback.

## See also

[`TextBox`](../widgets/TextBox.md) · [`TableView`](../widgets/TableView.md) ·
[`markdown`](../../llm/markdown.md), whose `Copy()` is this call
