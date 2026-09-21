# Text

What a string measures, asked where there is no painter.

Everywhere a layout is **decided** rather than drawn: how tall a band of a report
will be, how wide a column of a table should be, where a click landed in a
paragraph. A [`Painter`](../../llm/controls.md#painter) can answer these too, but
only inside a `Draw`; this object answers with no frame open, which is what makes
the answer available when the layout is being worked out.

## Every member

| | | |
|---|---|---|
| `Bounds(text, from, to, [font], [options])` | → the rectangles covering those characters | [where a character is](#where-a-character-is) |
| `Escape(text)` | → the text as markup that says exactly it | [markup](#markup) |
| `Font` (ro) | the desktop's UI font | [the font](#the-font) |
| `Height(text, [font], [options])` | → how tall it lays out | [measuring](#measuring) |
| `IndexAt(text, x, y, [font], [options])` | → which character is at that point | [where a character is](#where-a-character-is) |
| `LineOf(text, index)` | → the line a search's index falls on | [where a character is](#where-a-character-is) |
| `Lines(text, [font], [options])` | → the lines it breaks into | [measuring](#measuring) |
| `OffsetAt(text, line, [column])` | → the character offset of that position | [where a character is](#where-a-character-is) |
| `Size(text, [font], [options])` | → `{ Width, Height, Lines }` in one measurement | [measuring](#measuring) |
| `Width(text, [font], [options])` | → how wide it lays out, in pixels | [measuring](#measuring) |

`font` is a Pango description (`"Cantarell Bold 10"`); `""` or nothing means
`Font`. `options` is `{ Width, Markup, Align }` — the same three
[`Painter`](../../llm/controls.md#painter) draws with.

## Measuring

| | |
|---|---|
| `Width(text, [font], [options])` | how wide it lays out, in pixels |
| `Height(text, [font], [options])` | how tall: one line's height, or the whole block's when it wraps |
| `Size(text, [font], [options])` | `{ Width, Height, Lines }` in **one** measurement, which is one layout instead of three |
| `Lines(text, [font], [options])` | the lines it breaks into, as an array — for a caller that will draw them one by one |

```js
Text.Width("Statement of account", "Bold 18")     // 178
Text.Size(description, "", { Width: 300 })        // { Width, Height, Lines }
```

**The numbers are the ones a `Painter` gives**: the same fonts and the same
desktop resolution, so `Text.Width(s, f)` equals `p.TextWidth(s)` with
`p.Font = f` — asserted in `tests/widgets` rather than trusted. Two caveats: a
**vector** surface (`SavePdf`) can differ by a pixel, because hinting is off
there; and a drawing whose font an `app.css` changed is measured here in the
desktop's, so pass the font you set.

**Measure with the call you will draw with.** A band that grows to fit its text
and the lines that land in it both come from here in `lib/report`, and that is
not tidiness: two different ways of breaking the same string agree until the day
they do not, and then the text is a line taller than the box measured for it.

A word wider than the box is **broken** rather than left to overflow, so a
measurement never promises a width the text will not keep.

## Markup

| | |
|---|---|
| `Escape(text)` | the text as markup that says exactly it: `&`, `<` and `>` escaped |

`Markup: true` in the options says the string is **Pango markup** — `<b>`,
`<i>`, `<tt>`, `<span foreground=…>` — which is how a paragraph whose font
changes halfway is measured and drawn at all: the break belongs to whatever knows
how wide each piece is, and that is Pango.

**`Lines` refuses `Markup`**, and that is not a gap: the lines of a styled
paragraph are runs and not strings, so drawing them one by one would draw a
paragraph that had lost its bold. Measure it here and draw it with
`Painter.Text(markup, x, y, { Width, Markup: true })`, which is one layout for
both.

Markup that does not parse **throws where it was written**, rather than laying
out nothing and warning on the console — which is what a
[`Label`](../widgets/Label.md#markup) does, and the difference is worth knowing.

## Where a character is

| | |
|---|---|
| `IndexAt(text, x, y, [font], [options])` | which character is at that point, as an index into the text **as it was laid out** — a markup run's tags already consumed. Above the text is `0` and below it is the end |
| `Bounds(text, from, to, [font], [options])` | the rectangles covering those characters: one per line the range crosses, and more than one on a line that changes direction |
| `LineOf(text, index)` | the line an index falls on, 1-based and clamped — `index` is the number a **search** gave, so it is counted in UTF-16 units |
| `OffsetAt(text, line, [column])` | the **character** offset of that line and column, clamped the way an editor's `Select` clamps |

The two questions a **selection** asks, and neither can be worked out by a
caller: where the lines broke, which run is in which font and which way the text
runs are all the layout's. A pointer becomes an offset with the first and an
offset becomes the rectangles to paint with the second.

**The offsets `IndexAt`/`Bounds` answer are JS string indices**, so
`plain.slice(from, to)` is the text and a document with an emoji in it still
slices where it was clicked. Pass the same `font` and `options` the text was
measured and drawn with, or the answer is about a layout nobody can see.

`LineOf` and `OffsetAt` are the same pair an [`Editor`](../../llm/controls.md#editor--inherited-by-both-editors)
has, for a string with no control around it — what a scanner turns a match into
a line with. **The two units are not the same and are not meant to be**:
`LineOf` is handed the index a search returned (an emoji is two UTF-16 units),
`OffsetAt` a column in characters (an emoji is one), and each converts exactly.
`OffsetAt(editor.Line, editor.Column)` is the cursor's `Offset` to the letter,
and `LineOf(m.Index)` is the line the match was on.

**The lines are the editor's and not this object's.** `Text.Lines` lays the
string out and answers Pango's lines, which break U+2028 and wrap at a width;
`LineOf` answers the lines GTK draws — `\n`, `\r\n` as one break, a lone `\r`
and U+2029 — because the number is usually on its way to a `GotoLine`. On a
paragraph with a U+2028 in it the two disagree, and the one that matches the
view is this one.

## The font

| | |
|---|---|
| `Font` (ro) | the desktop's UI font, which is what a control draws with unless CSS says otherwise. `""` where there is no display to ask |

## What goes wrong

- **The measurement and the drawing disagreed.** Different fonts, different
  options, or one of them was a hand-rolled break.
- **`Lines` threw on markup.** By design; see above.
- **A PDF's text is a pixel off what was measured.** Hinting is off on a vector
  surface.
- **Everything measured as 0.** There is no display — in a console project
  `Font` is `""` and there is nothing to lay out against.

## See also

[`Painter`](../../llm/controls.md#painter) ·
[`DrawingArea`](../widgets/DrawingArea.md) ·
[`markdown`](../../llm/markdown.md), the library these two calls were added for
