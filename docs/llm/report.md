# Report — the banded report library

`Report` is not a control. It is a **component** written in Bintana, in the
`report` library that ships with the runtime, and it is reached the way any
library is: name it in `project.json`, then use its class in a `.form`.

```json
{ "name": "Statement", "startup": "ReportForm", "uses": ["report"] }
```

```json
{ "type": "Report", "name": "Report", "properties": { "Expand": true } }
```

The division is the same one `charts` argues for, applied to a document instead
of a plot: **the shape of the report — its bands, their heights, what sits in
each — is declared in code**, and **the numbers are handed over** as plain rows.
There is no designer; the layout is written down, which is why it is
version-controlled and why the totals cannot drift from the data. The example is
`examples/report`: a statement of account with every band, two nested group
levels, exact totals, a logo, rows that grow to fit their description, and the
whole thing out as one PDF.

## Report

One class. A report is a stack of **bands** laid out over **pages** of a fixed
paper size. Every property redraws when it is assigned, and every one is
designable and serialised.

| Member | |
|---|---|
| `Paper` | `A4` `Letter` `A5`, the sheet in points (72 to the inch). `"A4"` |
| `Orientation` | `Portrait` `Landscape`. `"Portrait"` |
| `Margins` | the gutter around the content, in points: one number for all four edges, or `{ Top, Right, Bottom, Left }`. `40` |
| `Page` | the current page, **one-based**. Assigning clamps to `[1, PageCount]`, so a page past the end is the last one, not a blank. Turning a page **redraws and does not re-measure**. `1` |
| `PageCount` (ro) | how many pages the data and the sections make. Measures lazily, so it is answerable in `Form_Open` before anything has drawn. An empty report is one blank page, not none |
| `Data` | the rows: an array of plain objects. `Field` elements read a key off the current row; the group bands read the keys named by each group's `.On`. `[]` |
| `Sections` | the band definitions — the whole of what a report is besides the numbers. See below. `{}` |
| `Refresh()` | re-measures, redraws and emits `Prepared`. Call it when you changed the rows **in place**; assigning `Data` or `Sections` already does |
| `SavePdf(path)` | **every page, one file**. Vector, at the paper's exact size, so the text in it is text; the pages are the ones the last measure worked out. This is what a report is for — `Save` is for when one page is going into something else |
| `Send([setup], cb)` | **every page, to paper**, through [`Printer`](library.md#printer): this fills in how many pages there are and the paper and orientation the report was laid out for, and `{ Copies, From, To }` say the job. **A paper chosen in the dialog scales the page rather than re-flowing it**, and the page count does not move — a report's bands are declared in its own points, so it declares no `Paginate` (a `Markdown` does). **Async**, like every dialog here: `cb({ Copies, From, To })` is what was actually sent, and is **not called** when the dialog was cancelled. **To a file it is `SavePdf`**: a PDF is not a printer with a `Copies` of 3 |
| `Save(path, [page], [scale])` | one page to a PNG. `page` defaults to the current one, `scale` to `2` (144 dpi — an A4 page is a 1190px-wide PNG). The export runs the same `Draw` at the exact paper size, clamps the page the way `Page` does, and **does not move the report** |
| **event** `Prepared(count)` | the pages were computed: `Data`, `Sections` or `Refresh()`. `count` is the new `PageCount`. Changing the paper, the orientation or the margins re-measures **silently** — read `PageCount` back on the next line — because those can be written in a `.form`, and an event raised while a form is loading arrives before the form's other controls exist |
| **event** `Page(page)` | the current page moved. `page` is one-based. It also fires when data that shrank pulled the current page back inside the new count |

### `Sections`

An object keyed by band name; each band is `{ Height, Elements }`. `Height` is
in points, and it is what pagination adds up. The five fixed bands:

| Band | emitted |
|---|---|
| `ReportHeader` | once, at the very top |
| `PageHeader` | the top of every page |
| `Detail` | once per row |
| `PageFooter` | the bottom of every page |
| `ReportFooter` | once, at the very end |

The page header and footer sit at fixed positions; the other bands **flow**
between them and start a new page when the next band does not fit. A band taller
than the whole content area is placed anyway — that is the author's error, not
the engine's.

**`Height: "Auto"` is the band that grows.** Instead of a number, a band may say
`Auto`: it is then as tall as the lowest bottom its elements reach, plus
`Padding` (default `0`). That is what a detail row with a description in it
wants — the order whose text takes three lines is three lines tall and the rest
are one, where a declared height would have to be the tallest of them everywhere
or cut the long one off. A wrapped run is measured at its `Width`, with the same
call that breaks the lines when it is drawn, so the two cannot disagree.

A `Box` or an `Image` counts as the `Height` it was given — what a picture would
be at its natural size cannot be known without reading the file, and the measure
pass reads nothing. `Auto` is **refused on `PageHeader` and `PageFooter`**: they
are what the flow is measured *between*, so their height has to be known before
any row is.

**The page header and the page footer belong to the sheet, not to the data.**
They are handed the page number and the count and **no row**, so `"@Page"` and
`"@Pages"` resolve there and a `Field` naming a data key is blank. Put a value
off the data in a group header instead — that is what one is for.

**Grouping is `Groups`, an ordered list, outermost first.** Each entry is
`{ On, Header, Footer }` — `On` is the key it groups by, and `Header`/`Footer`
are bands like any other. They nest: a report grouped by `Category` then
`Client` opens the category header, the client header, then each detail row,
and closes the client footer before the category footer when the category turns
over — the same ladder a spreadsheet's subtotals are. `Groups: []` is a report
with no grouping.

Grouping is **consecutive equal** values — the Crystal Reports model, which never
reorders the data, because reordering is a second opinion about what the user
meant. Sort first; the example sorts with `Locale.Compare`.

**An open group's headers repeat at the top of every page its rows run onto.**
A group that breaks across a page boundary puts its `Header` — and every header
still open outside it — at the top of the next page, so a detail row that lands
alone on page 2 still says whose it is. A group with no `Header` has nothing to
repeat. A `Footer` pushed onto a page of its own arrives under the same
headings, so a lone subtotal is never anonymous either.

### Elements

`Elements` is a list, each with `X`, `Y` (in points, relative to the band's
top-left) and a `Kind`:

| Kind | what it is |
|---|---|
| `Text` | fixed words. `Text` is the string |
| `Field` | a value off the current row. `Field` names the key; in a group band, naming that group's `On` resolves to the group's value. `"@Page"` and `"@Pages"` name the page number and the page count |
| `Total` | an aggregate the engine computed. `Field` names the key, `Op` the operation (`Sum` `Count` `Min` `Max` `Avg`) |
| `Line` | a rule. `X1` `Y1` `X2` `Y2`, `Thickness` (default 1) and `Color`. It is drawn from the band's own corner, so `X`/`Y` mean nothing to it |
| `Box` | a rectangle. `X` `Y` `Width` `Height`, `Fill` for a filled one, `Color` for its colour |
| `Image` | a picture. `File` is the path — **relative to the project** (`Application.Directory`), or absolute — and `X` `Y` place it. One of `Width`/`Height` is enough: the other follows the file's proportions. A file that is missing or is not an image throws where it is drawn, rather than leaving a blank where a masthead goes |

Shared by `Text`, `Field` and `Total`: `Width` (what `Align` and `Wrap` measure
against), `Align` (`Left` `Center` `Right`), `Font` (a Pango description),
`Color` (a CSS colour; default black), and `Wrap` — reflow onto as many lines as
`Width` allows, breaking on spaces and, for a word too long for the box, inside
the word. A wrapped run that outgrows a band's **declared** height is cut off
there; under `Height: "Auto"` the band is as tall as the run instead.
`Field` and `Total` add
`Format` — `""` (as it stands), `Number`, `Money`, `Date`, `Percent` — and
`Decimals` (defaulting to `2` for money, `0` for numbers, `1` for per cent).
Formatting goes through `Locale`, so the separators and the date are the user's.

**`Width` is what `Align` measures against and not a box the text is kept
inside.** A right-aligned run wider than its `Width` grows to the *left*, over
whatever is there — which is how a grand total in a larger font ends up on top
of its own label. Nothing warns about it: give the widest value the room it
needs, or `Wrap` it.

**A `Total` has no scope of its own.** The band it sits in is the scope: in a
`Footer` it totals that group's rows, in the `ReportFooter` the whole report —
which is why there is nothing to disagree with it. The operations:

- `Count` counts non-empty values — of the field it names. There is no count of
  *rows*: a `Total` always names a `Field`, so counting rows means naming a
  column every row fills.
- `Sum` keeps a `Decimal` exact — money that goes in as `Decimal` comes out as
  `Decimal`, summed with its own arithmetic — and only falls back to the double
  when the values are plain numbers or strings.
- `Min` and `Max` compare the raw values, so a date column's `Min` is the
  earliest date (`"YYYY-MM-DD"` orders lexically) and a name's `Min` is the
  first alphabetically.
- `Avg` is always a plain number: an average has no exact decimal text, and how
  many places to round it to is the caller's decision.

## The two passes

A report is drawn twice. The **measure** pass walks the rows and produces a list
of pages, each a list of band instances with a `y` and a context (`{ row }` for
a detail band, `{ totals }` for a footer); the **draw** pass reads that list and
paints the one page it was asked for. This is what makes `PageCount` answerable
before anything draws and what makes `Page` a number instead of a re-run of the
whole data. The measure runs when the data, the sections or the paper change —
**not when a page is turned**, and never on a frame — and a report is hundreds of
rows, so there is no decimation, no caching by array identity, none of what
`Chart` had to do. The measure never touches a `Painter` — a declared height is a
number and an `Auto` one is `Text.Size`, which answers with no frame open — and
that is what lets it run before anything has drawn.

## What the page looks like

The canvas always shows the **whole page, scaled to fit, centred**, on a white
sheet with a thin outline (the outline is screen-only; an export is clean
paper). There is no `Zoom` and no `Fit`: a preview that fits is the one state
that is never clipped and never needs a scrollbar, and a host that wants a
larger one enlarges the component or calls `Save` at a bigger scale. The page is
white and the ink is black, *not* the theme's — a report is a document that will
be printed, and the theme's ink on white paper is the invisible drawing.

## What it does not do

These are runtime gaps, filed and linked rather than hidden:

- **Sorting** — grouping is consecutive and never reorders the data.
- **A declared height still does not grow.** `Wrap` re-flows within it and cuts
  what is left over; the band that grows is the one that says
  `Height: "Auto"`.
