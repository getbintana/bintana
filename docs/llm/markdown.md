# Markdown — the document viewer library

`Markdown` is not a control. It is a **component** written in Bintana, in the
`markdown` library that ships with the runtime, and it is reached the way any
library is: name it in `project.json`, then use its class in a `.form`.

```json
{ "name": "Guide", "startup": "GuideForm", "uses": ["markdown"] }
```

```json
{ "type": "Markdown", "name": "Doc", "properties": { "Expand": true, "MaxWidth": 720 } }
```

```js
this.Doc.Load(File.Join(Application.Directory, "Guide.md"));
for (const h of this.Doc.Headings) this.Contents.Add(h.Text);
```

It is the same engine as [`report`](report.md) pointed at a different problem: a
**measure** pass turns the source into a flat list of items with an absolute `Y`,
and a **draw** pass paints the ones the viewport is standing over. What a report
measures against a sheet of paper, this measures against the width of the
control, which is the whole difference — and it is why `SavePdf` is here too: a
document that has been laid out is a document that can be paginated.

The example is `examples/markdown`: a file on the left as a table of contents,
the document on the right, drag a `.md` onto it, and the whole thing out as one
PDF.

## Markdown

One class. Every property redraws when it is assigned, and every one is
designable and serialised.

| Member | |
|---|---|
| `Text` | the document, as Markdown. **Not translated** — a whole document does not belong in a `.po` file, the same line [`SourceEditor`](controls.md#sourceeditor) draws. `""` |
| `Path` | the file it came from, `""` for text set by hand. What a relative image resolves against; without one they resolve against the project |
| `BaseFont` | the body font, a Pango description. Everything else is this in proportion — a heading is it scaled and emboldened. `""` is the desktop's |
| `CodeFont` | what a code span and a code block are set in. `""` is the monospace at the body's size |
| `MaxWidth` | the measure of the text column, in pixels. Past that the column keeps this width and is **centred**: a document pinned to the left of a maximised window is a line of ninety words. `0` is the whole width |
| `Margins` | the gutter around the document, in pixels: one number for all four edges, or `{ Top, Right, Bottom, Left }`. `24` |
| `Paper` | `A4` `Letter` `A5` — what `SavePdf` uses when it is not told one. `"A4"` |
| `Scroll` | how far down it is scrolled, in pixels. Assigning **clamps** to `[0, ScrollMax]`, so a number past the end is the end |
| `ScrollMax` (ro) | the largest `Scroll` that still shows text: the document's height minus one view. `0` when it all fits |
| `ContentHeight` (ro) | how tall the whole document is. Measures lazily, so it is answerable in `Form_Open` before anything has drawn |
| `Headings` (ro) | every heading in order: `{ Level, Text, Id, Y }`. What a table of contents is built from. `Text` is the words without their emphasis, `Id` the anchor GitHub would give them |
| `Selection` (ro) | what the reader has selected, as text. Runs are joined with a newline, so three paragraphs paste as three paragraphs. `""` when nothing is |
| `SelectAll()` | every word in the document — what Ctrl+A does; → whether there was anything |
| `Deselect()` | nothing selected — what Escape does; → whether there had been something |
| `Copy()` | `Selection` onto the clipboard — what Ctrl+C does; → whether there was anything to copy |
| `Load(path)` | the file into `Text`, remembering `Path` so its pictures resolve |
| `Refresh()` | measure again and repaint. Nothing needs it — every property does it already — except a document whose **pictures** changed on disk |
| `ScrollTo(id)` | put a heading at the top of the view. Takes an `Id`, a `#anchor` or the heading's own words; → whether one was found |
| `Save(path, [width], [scale])` | the **whole document** as one PNG — not the view. `width` is the column it is laid out at and defaults to the one on screen; `scale` is `2`, so the text is sharp |
| `SavePdf(path, [paper])` | every page, one file; → how many. Vector, so the text in it is text. The cut is **pulled up to the top of whatever block straddles it**, so a heading, a row or a picture is never sliced across a page |
| **event** `Scroll(y)` | the view moved — by the wheel, a key, the indicator, or an assignment. `y` is the new offset |
| **event** `Link(href, text)` | a link was clicked. `href` is the address exactly as the document wrote it and `text` the words that were clicked. **Answer `true` and it is dealt with**; otherwise a `#anchor` scrolls the document and anything else is left alone |
| **event** `Select(text)` | the selection settled: a drag that ended, a double click, `SelectAll()`, `Deselect()`. `text` is `Selection`, `""` when it was cleared. **Not raised while the pointer is still moving** — a host enabling a *Copy* button does not want sixty of these a second |

## What it reads

CommonMark, in the useful subset. What is in:

| | |
|---|---|
| headings | `# ` through `###### `, and the underlined (`===`, `---`) kind. The top two levels get a rule under them |
| paragraphs | wrapped at the column; a line ending in two spaces is a hard break, any other newline is a space |
| emphasis | `*italic*`, `**bold**`, `~~struck~~`. An `_` only opens emphasis at the edge of a word, so `snake_case` stays one word |
| code | `` `spans` `` and fenced blocks (``` or `~~~`), and four-space indented blocks. The language on a fence is read and **not** used: see below |
| lists | `-` `*` `+` and `1.` `1)`, nested, tight or loose. An ordered list starts at the number it says |
| quotes | `>`, nested, with their lazy continuation lines |
| tables | the GitHub kind, with `:---:` alignment. Columns take what their widest cell needs and are shrunk in proportion when the row does not fit |
| rules | `---`, `***`, `___` |
| links | `[text](href)` and `<https://…>` autolinks. Clicked, they raise `Link` — see below |
| images | `![alt](file.png)` on a line of its own. Relative to `Path`'s folder, or to the project |
| escapes | `\*` and the rest of the punctuation Markdown uses |

What is not: reference links (`[a][b]` and their definitions), HTML blocks and
inline HTML, footnotes, task lists, and the emphasis edge cases that make
CommonMark's own test suite three hundred pages.

## What it does not do

These are decisions, filed here rather than discovered:

- **A link is an address and not an action.** What opens `https://…` or
  `../other.md` is the application's decision, so the component reports and does
  not act — except for a `#anchor`, which is the one address it can honour on its
  own. Reference links (`[a][b]`) are not read at all.
- **No syntax highlighting in a code block**, and this one is settled rather than
  pending: it is a [`SourceEditor`](controls.md#sourceeditor) that knows how to
  colour code, a viewer that shipped half a highlighter would be wrong in a
  different language every week, and a document is read for its prose. The
  fence's language is parsed and kept, so a host that disagrees has it.
- **An inline image is its alt text.** Pango markup has no picture in it, so a
  picture is a block: a paragraph holding nothing but an image is drawn as one,
  and an image in the middle of a sentence reads as the words in its brackets.
- **A missing image is a dashed box with its alt text in it**, and not a throw —
  which is where this parts company with [`report`](report.md), whose missing
  masthead ends the frame. A report that cannot print its letterhead must not
  print; a broken image in somebody's notes is Tuesday.
- **A picture is never enlarged**, only fitted: a 40px icon in a 700px column is
  a 40px icon.
- **There is no search**, and no caret: what is here is a selection made with the
  pointer and copied. Finding a word would want the same two calls pointed at
  every block instead of the one under the pointer, which is a feature and not a
  gap in the surface.
- **A drag that leaves the view does not scroll it.** Select what is on screen,
  scroll, then extend with the pointer — or take the whole document with Ctrl+A.
- **There is still no printer.** `SavePdf` writes the document as a file;
  choosing a printer, a tray and a number of copies is
  [ISSUE-printing](../issues/ISSUE-printing.md).

## The two passes

The measure walks the blocks and produces the display items — a run of markup, a
rule, a panel, a picture — each with an absolute `Y`. It runs when the text, the
width, the theme or a font changes, and **not when the view is scrolled**:
scrolling is a `Translate` and a filter, so a document of four hundred blocks
scrolls at the cost of the dozen on screen. It never touches a `Painter`, which
is what lets `ContentHeight` and `Headings` be read before anything has drawn.

**A paragraph is one string of Pango markup.** That is the whole of why this
library exists in the shape it does: a line with a bold word and a code span in
it cannot be broken by measuring strings, so the runs go into markup and the
breaking belongs to Pango — `Text.Size(markup, font, { Width, Markup: true })` to
measure, `Painter.Text(markup, x, y, { Width, Markup: true })` to draw, one
layout for both. See [`Text`](library.md#text) and
[`Painter`](controls.md#painter); `Text.Escape` is what keeps a `<` somebody
wrote from becoming half a tag.

## What the page looks like

The document follows the **theme**, unlike a report, which is black on white
because it is paper. The palette is chosen by `Painter.Dark` and the measure is
redone when that answer changes, because the markup carries the colours it was
built with.

An **export** is the same `Draw`: `Save` paints the whole document into one PNG
and `SavePdf` paints one band of it per page. The ground is painted there and
not on screen — a PNG with nothing behind the letters is transparent and a PDF
is paper, while a frame should let the application's own window through.

## Selecting

Drag to select, double click for a word, Ctrl+A for the document, Ctrl+C to copy,
Escape to clear. The pointer is a text cursor over text, a hand over a link and
an arrow elsewhere.

**A selection is a pair of offsets into runs of text** — the Nth run and the
character in it — and not a pair of points. That is what lets it survive a
resize: the words are the same after one and the rectangles are not. A run is a
heading, a paragraph, a code block or a table cell; a list's bullets and a
table's rules are not runs and do not come out, exactly as they would not from a
web page.

It is drawn with [`Text.Bounds`](library.md#text) and hit-tested with
[`Text.IndexAt`](library.md#text) — the same layout, the same font and the same
options the text was measured and drawn with, which is why the highlight ends
where the line ends and lands correctly in a right-aligned cell. An **export
carries no selection**: a PDF with three words highlighted in it is a picture of
somebody's pointer.

## Links

A click on a link raises `Link(href, text)`, with the address as the document
wrote it — relative stays relative, and [`Path`](#markdown) is what it is
relative *to*. The pointer is a hand over one.

**The host gets first refusal**, the way a key does: a handler that answers
`true` has dealt with it. What is left over and points inside the document —
`#a-heading`, the anchors [`Headings`](#markdown) gives — scrolls, so
cross-references work with no handler at all. Everything else is left alone:
where a web address or another file should open is a decision about the
application.

```js
Doc_Link(href, text) {
    if (href.endsWith(".md")) { this.show(File.Join(File.Directory(this.Doc.Path), href)); return true; }
    if (File.Exists(href))    { File.Open(href); return true; }
    return false;                       /* #anchors scroll; the rest is nobody's */
}
```

**A click is a drag that selected nothing.** Following a link on the way *down*
would take the document out from under a reader selecting its words, so it
happens on the mouse-up and only when the drag came to nothing. The link is
tested against the rectangles its words really occupy — the same
[`Text.Bounds`](library.md#text) the selection is painted with — so a click in
the empty part of a line that ends in a link follows nothing.

## Scrolling

The component scrolls itself: the wheel, `Up` `Down` `Page_Up` `Page_Down`
`Home` `End` and the space bar, and an overlay indicator that can be dragged.
There is no `Scroller` around it and there cannot usefully be one — a `Scroller`
puts its child on a fixed surface at the size the child asks for, and a drawing
has no size of its own to ask with. Put it on a form with `Expand` and it fills
what it is given.
