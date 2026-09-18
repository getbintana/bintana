# Markdown

A Markdown document, as a component.

A README, a guide, a note: drawn as the document it is — headings, lists, tables,
code blocks, pictures — scrolling itself, selectable, with its links reported and
the whole thing out as a PDF. It ships in the `markdown` library and is reached
with `uses`.

```json
{ "name": "Guide", "startup": "GuideForm", "uses": ["markdown"] }
```

```json
{ "type": "Markdown", "name": "Doc",
  "properties": { "Expand": true, "MaxWidth": 720, "Margins": 28 } }
```

```js
this.Doc.Load(File.Join(Application.Directory, "Guide.md"));
for (const h of this.Doc.Headings) this.Contents.Add(h.Text);
```

It is the same engine as [`Report`](Report.md) pointed at a different problem: a
**measure** pass turns the source into a flat list of items with an absolute `Y`,
and a **draw** pass paints the ones the viewport is standing over. What a report
measures against a sheet of paper, this measures against the width of the
control.

It is a [`Component`](../widgets/Component.md), so everything on
[`Widget`](../widgets/Widget.md) is on it too.

## Every member

**The document**

| | | |
|---|---|---|
| `ContentHeight` (ro) | how tall the whole document is | [the document](#the-document) |
| `Headings` (ro) | every heading: `{ Level, Text, Id, Y }` | [finding your way](#finding-your-way) |
| `Path` | the file it came from | [the document](#the-document) |
| `Text` | the document, as Markdown. **Not translated** | [the document](#the-document) |
| `Load(path)` | the file into `Text`, remembering `Path` | [the document](#the-document) |
| `Refresh()` | measure again and repaint | [the document](#the-document) |

**How it is laid out**

| | | |
|---|---|---|
| `BaseFont` | the body font; everything else is this in proportion | [how it is laid out](#how-it-is-laid-out) |
| `CodeFont` | what a code span and a code block are set in | [how it is laid out](#how-it-is-laid-out) |
| `Margins` | the gutter, in pixels. `24` | [how it is laid out](#how-it-is-laid-out) |
| `MaxWidth` | the measure of the text column; `0` is the whole width | [how it is laid out](#how-it-is-laid-out) |

**Reading it**

| | | |
|---|---|---|
| `Scroll` | how far down it is scrolled, in pixels | [scrolling](#scrolling) |
| `ScrollMax` (ro) | the largest `Scroll` that still shows text | [scrolling](#scrolling) |
| `Find(text)` | the first run holding that text: select it and show it | [finding your way](#finding-your-way) |
| `FindNext()` | the next one, wrapping | [finding your way](#finding-your-way) |
| `ScrollTo(id)` | put a heading at the top of the view | [finding your way](#finding-your-way) |
| `Selection` (ro) | what the reader has selected, as text | [selecting](#selecting) |
| `SelectAll()` | every word — what Ctrl+A does | [selecting](#selecting) |
| `Deselect()` | nothing selected — what Escape does | [selecting](#selecting) |
| `Copy()` | `Selection` onto the clipboard — what Ctrl+C does | [selecting](#selecting) |

**Out of the window**

| | | |
|---|---|---|
| `Paper` | `A4` `Letter` `A5` — what `SavePdf` uses. `"A4"` | [off the screen](#off-the-screen) |
| `Save(path, [width], [scale])` | the **whole document** as one PNG | [off the screen](#off-the-screen) |
| `SavePdf(path, [paper])` | every page, one file; → how many | [off the screen](#off-the-screen) |
| `Send([setup], cb)` | **every page, to paper** | [off the screen](#off-the-screen) |

**Events**

| | | |
|---|---|---|
| **event** `Link(href, text)` | a link was clicked | [links](#links) |
| **event** `Scroll(y)` | the view moved | [scrolling](#scrolling) |
| **event** `Select(text)` | the selection settled | [selecting](#selecting) |

## The document

| | |
|---|---|
| `Text` | the document, as Markdown. **Not a translated property** — a whole document in a `.po` file is not a caption somebody will translate, the same line [`SourceEditor`](../widgets/SourceEditor.md) draws |
| `Path` | where it came from, which is what a relative image resolves against. Setting `Text` by hand leaves it empty and pictures then resolve against the project |
| `Load(path)` | the file into `Text`, remembering `Path` |
| `ContentHeight` (ro) | how tall the whole document is. **Measures lazily**, so it is answerable in `Form_Open` before anything has drawn |
| `Refresh()` | measure again and repaint. Nothing needs it — every property does it already — **except a document whose pictures changed on disk** |

What it reads is CommonMark in the useful subset; what is in and what is not is
listed in [llm/markdown.md](../../llm/markdown.md).

## How it is laid out

| | |
|---|---|
| `MaxWidth` | the measure of the text column, in pixels. Past that the column keeps this width and is **centred**: a document pinned to the left of a maximised window is a line of ninety words |
| `Margins` | the gutter around it: one number, or `{ Top, Right, Bottom, Left }` |
| `BaseFont` | the body font. Everything else is it in proportion — a heading is it scaled and emboldened — so a document set larger is *entirely* larger |
| `CodeFont` | what a code span and a code block are set in. `""` is the desktop's monospace at the body's size |

## Scrolling

| | |
|---|---|
| `Scroll` | the offset in pixels. Assigning **clamps** to `[0, ScrollMax]` |
| `ScrollMax` (ro) | the document's height minus one view |
| **event** `Scroll(y)` | the view moved — by the wheel, a key, the indicator, or an assignment |

The component scrolls itself: the wheel, `Up` `Down` `Page_Up` `Page_Down`
`Home` `End` and the space bar, and a drawn overlay indicator that can be
dragged. **There is no `Scroller` around it and there cannot usefully be one** — a
scroller puts its child on a fixed surface at the size the child asks for, and a
drawing has no size of its own to ask with.

## Finding your way

| | |
|---|---|
| `Headings` (ro) | every heading in order: `{ Level, Text, Id, Y }`. `Text` is the words without their emphasis and `Id` the anchor GitHub would give them |
| `ScrollTo(id)` | put a heading at the top of the view. Takes an `Id`, a `#anchor` or the heading's own words; → whether one was found |
| `Find(text)` | the first run holding that text: **selects it and scrolls it into view**; → whether there was one. Case is folded and nothing else is |
| `FindNext()` | the next one after the selection, **wrapping** round to the top |

Those first two are a table of contents: fill a [`ListBox`](../widgets/ListBox.md) from
the first and call the second on `Select`.

## Selecting

| | |
|---|---|
| `Selection` (ro) | what is selected, as text. Runs are joined with a newline, so three paragraphs paste as three paragraphs |
| `SelectAll()` | every word; → whether there was anything |
| `Deselect()` | nothing; → whether there had been something |
| `Copy()` | `Selection` onto the clipboard; → whether there was anything to copy |
| **event** `Select(text)` | the selection settled. **Not raised while the pointer is still moving** — a host enabling a *Copy* button does not want sixty a second |

**`Find` is a search with a selection on the end of it**, which is what the IDE
opens a page *at a member* with: an anchor is no use there, since the finest one a
heading gives is the class.

Drag to select, double click for a word, Ctrl+A, Ctrl+C, Escape. **A selection is
a pair of offsets into runs of text and not a pair of points**, which is what
lets it survive a resize: the words are the same afterwards and the rectangles
are not.

## Links

| | |
|---|---|
| **event** `Link(href, text)` | a link was clicked, with the address **as the document wrote it**. **Answer `true` and it is dealt with**; otherwise a `#anchor` scrolls the document and anything else is left alone |

**The host gets first refusal**, the way a key does. A `#anchor` nobody claims
scrolls, so cross-references in a README work with no handler at all; where a web
address or another file should open is a decision about the application.

**A click is a drag that selected nothing**, resolved on the mouse-up: following
a link on the way down would take the document out from under a reader selecting
its words.

## Off the screen

| | |
|---|---|
| `SavePdf(path, [paper])` | every page, one file; → how many. Vector, so the text in it is text. **The cut is pulled up to the top of whatever block straddles it**, so a heading, a row or a picture is never sliced across a page |
| `Send([setup], cb)` | **every page, to paper** through [`Printer`](../globals/Printer.md). `setup` is `{ Paper, Copies, From, To }`; `Paper` is what the dialog opens on, and the pagination is `SavePdf`'s. A paper chosen in the dialog **re-flows** the document — this declares `Paginate`, so the sheet count follows the paper that really comes out, which is more sheets on a smaller one. **Async**: `cb({ Copies, From, To })` is what was actually sent, and is not called when the dialog was cancelled. To a file it is `SavePdf` |
| `Save(path, [width], [scale])` | the **whole document** as one PNG — not the view. `width` is the column it is laid out at; `scale` is `2` |
| `Paper` | `A4`, `Letter` or `A5` — what `SavePdf` uses when it is not told one |

An export carries **no selection**: a PDF with three words highlighted in it is a
picture of somebody's pointer.

## What it does not do

- **No syntax highlighting in a code block**, settled rather than pending: it is
  a [`SourceEditor`](../widgets/SourceEditor.md) that knows how to colour code.
- **An inline image is its alt text.** Markup holds no picture, so a picture is a
  block.
- **A missing image is a dashed box with its alt text in it, not a throw** —
  where this parts company with [`Report`](Report.md), whose missing masthead
  must stop the page.
- **No caret**, and a drag that leaves the view does not scroll it. The search is
  `Find`/`FindNext` and nothing more: no regular expressions, no whole-word, no
  accent folding — an editor has those and this is not one.

## See also

[`Report`](Report.md) · [`Chart`](Chart.md) ·
[`Text`](../globals/Text.md), whose markup and hit-testing calls this library
asked for · [`examples/markdown`](../../../examples/markdown) ·
[llm/markdown.md](../../llm/markdown.md), the short form
