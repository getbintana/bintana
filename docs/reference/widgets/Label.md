# Label

Text the user reads and cannot edit.

The commonest control there is, and most of what there is to know about it is
what happens when the words do not fit the room: a label grows, wraps, gives up
its tail or is cut off, and which of those it does is this page.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Alignment` | `Left` `Center` `Right`, default `"Left"` | [fitting the room](#fitting-the-room) |
| `Ellipsize` | end a line that does not fit with `…` | [fitting the room](#fitting-the-room) |
| `Lines` | at most this many lines, `0` for no limit | [fitting the room](#fitting-the-room) |
| `Markup` | read `Text` as Pango markup | [markup](#markup) |
| `Selectable` | the user may select and copy it | [selectable](#selectable) |
| `Text` | the words. **Translated** | [the words](#the-words) |
| `Wrap` | wrap long text over several lines | [fitting the room](#fitting-the-room) |

No methods and no events of its own: a label says something and that is all it
does. `Caption` is an alias of `Text`, so a form may declare either.

## When it is not a `Label`

- **The user has to be able to copy it** — an id, a path, an error to paste into a
  bug report: a label with `Selectable`, or a read-only [`TextBox`](TextBox.md)
  when it should look like a field.
- **The text is long and scrolls** — a paragraph, a log: a
  [`TextEditor`](TextEditor.md) with `ReadOnly`, which scrolls and wraps and does
  not push the window wider.
- **It is a heading** — still a `Label`, with `Style: "title-1"`…`"title-4"` or
  `"heading"`, which is the theme's own size and weight rather than a font
  chosen here.
- **It names the control beside it** — still a `Label`, and the pair is a row in a
  `Grid` or a box; there is no *label-for* relationship to declare.
- **It is a picture or an icon** — [`Image`](Image.md) for an icon from the
  theme, [`Picture`](Picture.md) for a photograph.

## On a form

```json
{ "type": "Label", "name": "LblStatus",
  "properties": { "X": 8, "Y": 8, "Width": 300,
                  "Text": "{0} files", "Style": "dim-label",
                  "Ellipsize": true } }
```

```js
show(n) { this.LblStatus.Fill(n); }
```

`Fill` puts the value into the **declared** text, so the sentence stays one
translatable string and the number stays out of the catalogue —
see [Widget](Widget.md#words-on-it).

## The words

| | |
|---|---|
| `Text` | what it says. **Translated**: a label declared in a `.form` goes through the catalogue, and what is filled in from code does not |

**A label is as wide as its words** unless something stops it: a declared `Width`
is a floor, not a cage ([Widget](Widget.md#where-it-is-and-how-big)), so a long
sentence widens the label — and, in a box, the window. Nothing about that is a
bug; what it means is that a label showing text you did not write (a file name, a
user's input, an error from elsewhere) needs to be told how to give way, which is
the next section.

## Fitting the room

| | |
|---|---|
| `Wrap` | wrap long text over as many lines as it takes. The label then wants a width to wrap *at* — in a box, that is what `HExpand` gives it |
| `Ellipsize` | keep one line and end it with `…` when it does not fit. What a file name in a row wants: it gives up its tail rather than the row's shape |
| `Lines` | at most this many lines while wrapping; `0` is no limit. Beyond it the text is cut |
| `Alignment` | `Left` `Center` `Right` — where the text sits **within the label**, which is only visible once the label is wider than its words. Default `"Left"` |

**`Wrap` and `Ellipsize` are exclusive, and the last one set wins.** Measured:
turning `Ellipsize` on turns `Wrap` off, and turning `Wrap` on turns `Ellipsize`
off. That is GTK's model and not a rule invented here — a line that ends in `…`
is the opposite of a line that continues below — so a label that should wrap *and*
stop at three lines is `Wrap` plus `Lines: 3`, never both flags.

**`Alignment` is not `HAlign`.** `Alignment` is where the words sit inside the
label; [`HAlign`](Widget.md#how-it-is-placed) is where the label sits inside its
room. A centred label whose width is exactly its text looks identical either way,
which is why this is worth saying once: if centring did nothing, the label is not
wider than its words and it is `HAlign` you wanted.

## Markup

| | |
|---|---|
| `Markup` | read `Text` as **Pango markup** — `<b>`, `<i>`, `<tt>`, `<s>`, `<span foreground="…">` — instead of as plain words |

```js
this.Lbl.Markup = true;
this.Lbl.Text   = `<b>${Text.Escape(name)}</b> — ${count} files`;
```

**Escape everything that came from outside.** A name with an `&` or a `<` in it
is not markup, and this is the one place in the set where getting it wrong is
quiet: a label given markup it cannot parse **leaves the old text alone and
writes a warning on the console** — no exception, no blank label, nothing a test
would see. `Text.Escape` is the answer, and it is the same call
[`lib/markdown`](../../llm/markdown.md) builds every paragraph with.

Markup is also why `Text` stays prose for the catalogue: the tags travel with the
sentence, and a translator sees them.

## Selectable

| | |
|---|---|
| `Selectable` | the user may select the text with the pointer and copy it |

For the things people need to paste somewhere else: a path, an id, a licence key,
the text of an error.

**Not in a list row.** A selectable label swallows the click that was choosing the
row, so the item somebody wanted to copy is the one that never gets selected. In a
[`RowList`](RowList.md) or a [`TableView`](TableView.md), copying belongs to a
button or a context menu, which has the other advantage of copying the *value*
rather than what happens to be drawn.

## What goes wrong

- **The window got wider when the text changed.** A label is as wide as its
  words. `Ellipsize` for one line, `Wrap` for several, and `HExpand` so it has a
  width to work against.
- **`Wrap` did nothing.** The label has no width to wrap at — in a box it needs
  `HExpand`, on a surface a declared `Width`.
- **Everything came out as `…`.** `Ellipsize` collapses the label's width request
  to one character, which GTK clamps back up to a declared `Width` — so a label
  given no width (a `Grid` cell, a `Fixed` with none) has nothing to be
  ellipsized into and a table of values comes out as a column of `...`. `Wrap`
  needs the width for the same reason; there the symptom is a column one
  character wide instead.
- **Turning on `Ellipsize` turned off `Wrap`.** They are exclusive; see above.
- **Centring did nothing.** `Alignment` centres the words inside the label;
  `HAlign` centres the label. The label is probably exactly as wide as its words.
- **The markup came out as tags, or the text did not change at all.** `Markup` is
  off in the first case; in the second the markup did not parse and GTK kept the
  old text — look in the console, and escape what came from outside.
- **A click on a row did nothing.** A `Selectable` label in the row is eating it.

## What it does not do

- **No editing.** That is a [`TextBox`](TextBox.md), or a
  [`TextEditor`](TextEditor.md) for more than a line.
- **No scrolling.** A label is as big as it is; put it in a
  [`Scroller`](Scroller.md), or use an editor.
- **No `Click`.** A label is not a control the user acts on. For something that
  looks like text and can be pressed, a [`Button`](Button.md) with
  `Style: "flat"`, or a [`LinkButton`](LinkButton.md) for an address.
- **No icon.** [`Image`](Image.md) beside it in a box, which is what every icon
  and caption pair in this tree is.

## See also

[`TextBox`](TextBox.md) · [`TextEditor`](TextEditor.md) · [`Image`](Image.md) ·
[`Button`](Button.md) · [Widget](Widget.md#words-on-it), for `Fill` and the
catalogue
