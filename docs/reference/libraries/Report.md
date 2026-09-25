# Report

A banded report, as a component.

What Crystal Reports calls a *report definition*: content arranged in **bands** —
page header and footer, nested group headers and footers, a detail band that
repeats once per row, and the report's own header and footer — laid out over
**pages** of a fixed paper size, and out as one PDF.

It ships in the `report` library, is reached with `uses`, and draws with the same
[`Painter`](../../llm/controls.md#painter) every other drawing here uses.

```json
{ "name": "Statement", "startup": "ReportForm", "uses": ["report"] }
```

```json
{ "type": "Report", "name": "Report", "properties": { "Expand": true } }
```

```js
this.Report.Sections = this.sections();   // the shape, declared in code
this.Report.Data     = rows;              // the numbers, handed over
```

**There is no designer for a report**: the bands, their heights and what sits in
each are *written down*, which is why they can be version-controlled and why the
totals cannot drift from the data.

It is a [`Component`](../widgets/Component.md), so everything on
[`Widget`](../widgets/Widget.md) is on it too.

## Every member

| | | |
|---|---|---|
| `Data` | the rows: an array of plain objects. `[]` | [the data](#the-data) |
| `Margins` | the gutter around the content, in points. `40` | [the paper](#the-paper) |
| `Orientation` | `Portrait` `Landscape`. `"Portrait"` | [the paper](#the-paper) |
| `Page` | the current page, **one-based** | [turning the pages](#turning-the-pages) |
| `PageCount` (ro) | how many pages the data and the sections make | [turning the pages](#turning-the-pages) |
| `Paper` | `A4` `Letter` `A5`, in points. `"A4"` | [the paper](#the-paper) |
| `Sections` | the band definitions | [the bands](#the-bands) |
| `Refresh()` | re-measures, redraws and emits `Prepared` | [the data](#the-data) |
| `Save(path, [page], [scale])` | one page to a PNG | [off the screen](#off-the-screen) |
| `SavePdf(path)` | **every page, one file** | [off the screen](#off-the-screen) |
| `Send([setup], cb)` | **every page, to paper** | [off the screen](#off-the-screen) |
| **event** `Page(page)` | the current page moved | [turning the pages](#turning-the-pages) |
| **event** `Prepared(count)` | the pages were computed | [the data](#the-data) |

## The paper

| | |
|---|---|
| `Paper` | `A4`, `Letter` or `A5`, in **points** — 72 to the inch, so A4 is 595×842 |
| `Orientation` | `Portrait` or `Landscape` |
| `Margins` | the gutter, in points: one number for all four edges, or `{ Top, Right, Bottom, Left }`, each side a finite number or refused |

Changing any of these **re-measures silently** — read `PageCount` back on the
next line — because they can be written in a `.form`, and an event raised while a
form is loading arrives before the form's other controls exist.

## The data

| | |
|---|---|
| `Data` | the rows, as plain objects. `Field` elements read a key off the current row, and the group bands read the keys each group's `.On` names |
| `Refresh()` | re-measures, redraws and emits `Prepared`. For when the rows changed **in place**; assigning `Data` or `Sections` already does it |
| **event** `Prepared(count)` | the pages were computed, and `count` is the new `PageCount` |

**Sort before handing the rows over.** Grouping is *consecutive equal values* —
Crystal's model, which never reorders the data, because reordering is a second
opinion about what the user meant. [`Locale.Compare`](../globals/Locale.md) is
the comparison that puts `Ñanculeo` between `Núñez` and `Ortiz`.

## The bands

| | |
|---|---|
| `Sections` | an object keyed by band name; each band is `{ Height, Elements }` |

The five fixed bands are `ReportHeader` (once, at the top), `PageHeader` (the top
of every page), `Detail` (once per row), `PageFooter` and `ReportFooter`. The page
header and footer sit at fixed positions and the rest **flow** between them,
starting a new page when the next band does not fit.

**`Height: "Auto"` is the band that grows** — as tall as the lowest bottom its
elements reach, plus `Padding`. That is what a detail row with a description in
it wants. It is **refused on `PageHeader` and `PageFooter`**: they are what the
flow is measured *between*, so their height has to be known before any row is.

**Grouping is `Groups`, an ordered list, outermost first** — each entry
`{ On, Header, Footer }` — and they nest, exactly as a spreadsheet's subtotal
ladder does. **An open group's headers repeat at the top of every page its rows
run onto**, so a detail row that lands alone on page 2 still says whose it is.
A group turns when its key changes **by value** — two `Decimal`s of the same
number are one group, not two objects.

`Min` and `Max` compare numerically and exactly when every value of the field
is a number, numeric text or a `Decimal`, and as text with `Locale.Compare`
otherwise.

An element is `{ X, Y, Kind, … }`: `Text` (fixed words), `Field` (a value off the
row, or `@Page`/`@Pages`), `Total` (`Sum` `Count` `Min` `Max` `Avg`), `Line`,
`Box` or `Image`. **A `Total` has no scope of its own**: the band it sits in is
the scope, which is why there is nothing to disagree with it. The whole grammar
is in [llm/report.md](../../llm/report.md).

## Turning the pages

| | |
|---|---|
| `Page` | the current page, **one-based**. Assigning **clamps** to `[1, PageCount]`, so a page past the end is the last one and not a blank |
| `PageCount` (ro) | how many pages there are. **Measures lazily**, so it is answerable in `Form_Open` before anything has drawn. An empty report is one blank page, not none |
| **event** `Page(page)` | the current page moved — including when data that shrank pulled it back inside the new count |

**Turning a page redraws and does not re-measure.** That is what the two passes
buy: the pages were worked out when the data arrived, and `Page` only chooses
which of them to paint.

## Off the screen

| | |
|---|---|
| `SavePdf(path)` | **every page, one file.** Vector, at the paper's exact size, so the text in it is text. This is what a report is for |
| `Send([setup], cb)` | **every page, to paper** through [`Printer`](../globals/Printer.md). How many pages and what paper are the report's; `{ Copies, From, To }` say the job. A paper chosen in the dialog **scales** the page and the count does not move, so this declares no `Paginate` — the bands are declared in the report's own points. **Async**: `cb({ Copies, From, To })` is what was actually sent, and is not called when the dialog was cancelled. To a file it is `SavePdf` |
| `Save(path, [page], [scale])` | one page to a PNG. `page` defaults to the current one and `scale` to `2` — 144 dpi, so an A4 page is a 1190px-wide PNG. It **does not move the report** |

The canvas always shows the **whole page, scaled to fit, centred**, on white
paper with a thin outline that the export does not carry. There is no `Zoom` and
no `Fit`: a preview that fits is the one state that is never clipped.

**The page is white and the ink is black, not the theme's** — a report is a
document that will be printed, and the theme's ink on white paper is the
invisible drawing.

## What it does not do

- **No sorting.** See [the data](#the-data).
- **A declared height does not grow.** `Wrap` re-flows within it and cuts what is
  left over; the band that grows is the one that says `Height: "Auto"`.

## See also

[`Chart`](Chart.md) · [`Markdown`](Markdown.md) ·
[`DrawingArea`](../widgets/DrawingArea.md) ·
[`examples/report`](../../../examples/report) ·
[llm/report.md](../../llm/report.md), the short form and the full element grammar
