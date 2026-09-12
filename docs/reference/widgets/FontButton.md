# FontButton

The font, shown in itself.

For letting the user choose a font: an editor's face, a document's body text, the
font a drawing is labelled in. The button draws its own name in the font it
names, which is the whole of why it exists.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Value` | a Pango description, `""` for none | [the font](#the-font) |
| **event** `Change()` | the value changed, **including from code** | [the font](#the-font) |

## The font

| | |
|---|---|
| `Value` | a Pango description — `"Cantarell Bold 12"` — which is **what [`Font`](Widget.md#how-it-looks) takes on every control**, what `Painter.Font` takes, and what [`Text`](../../llm/library.md#text) measures with. `""` is no font, meaning *the theme's* |
| **event** `Change()` | the font changed — chosen or **assigned from code** |

```js
FntBody_Change() { this.Doc.BaseFont = this.FntBody.Value; }
```

`Text.Font` is the desktop's own UI font, which is the sensible starting value
for a control like this and the thing `""` falls back to.

## What goes wrong

- **The chosen font did nothing.** `Value` has to be assigned somewhere: this
  control chooses, it does not apply.
- **A size was expected and a description came back.** It is one string —
  family, style and size — which is what everything here takes; parsing it apart
  is the caller's, and rarely needed.
- **Assigning `Value` ran the handler.** It does.

## What it does not do

- **No filtering**, no *monospace only*, no preview text of your own: the chooser
  is the desktop's.

## See also

[`ColorButton`](ColorButton.md) · [`Widget`](Widget.md#how-it-looks) ·
[`Text`](../../llm/library.md#text)
