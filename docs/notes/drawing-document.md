# `Drawing`: a document with no display

**Every way out of a `Painter` went through a `DrawingArea`**, and a control
needs a display: `Save`, `ToPng`, `SavePdf` and `Printer` all take the control
and run its handler. So a `main` project -- which never initialises GTK and
refuses to make a widget -- could measure a report (`Text`), paginate it, and
then had nothing to draw it with. `bintana-zabbix`'s batch mode died with
`Failed to open display` from exactly there, and the workaround on offer was
`xvfb-run`: a window nobody sees on a display nobody has, to write a file from
a timer.

`Drawing.Save(path, w, h, draw)`, `Drawing.ToPng(w, h, draw)` and
`Drawing.SavePdf(path, w, h, pages, draw)` are `DrawingArea`'s three verbs with
**the drawing passed where the control was** -- same names, same arguments,
same refusals, and `draw` is handed `Draw`'s or `DrawPage`'s own arguments, so
a drawing written for one is the drawing for the other. The writers are one
function each underneath (`image_frame`, `pdf_write` in `bta_paint.c`, taking a
`BtaFrameFn`), so the control and `Drawing` cannot drift in what they refuse.
Four things that are the design rather than detail:
- **A painter with no control draws black, in `Text`'s font, at `Text`'s
  resolution.** `painter_ink` already answered black with no widget; the font
  is the part that had to be written, because a report measured by `Text` and
  drawn by a painter in another size is the overlapping-rows bug again.
  `metrics_resolution` is shared for that reason.
- **The drawing's throw is the call's throw**, where a control's handler is an
  event and is reported and consumed. The caller passed the function and is on
  the stack; and a PDF that threw leaves no file, as the control's does.
- **Not in a `Task`.** A worker installs no `Painter` (cairo and pango are
  drawing, `docs/plans/task-plan.md`), so it has no `Drawing` either.
- **`Text` with no font kept the last one.** `metrics_prepare` set a font only
  when one was given, on a layout shared by every call -- with a desktop the
  fallback is `gtk-font-name` and it never showed, and in a console project
  `Text.Height("x")` after `Text.Height("x", "Bold 18")` measured in Bold 18.
  Found by the first console drawing; the layout's font is cleared now.
- **And no desktop is not no font.** `Text.Font` answered `""` in a console
  project, and an empty font is Pango's default, which is a serif: the first
  chart drawn through `Drawing` came out in Times beside a report in a sans,
  because the report names its fonts and the chart does not. With no desktop
  to ask it is GTK's own default for `gtk-font-name`, `"Sans 10"` --
  `BTA_FALLBACK_FONT` -- which is what a window would have had.

**And the libraries split, because a control is still a widget.** `lib/report`
is `ReportDocument` -- the paper, the bands, the rows, the measure and the
drawing, no widget -- and the `Report` control, which holds one as
`Report.Document` and delegates every property to it; `lib/charts` is
`ChartDocument` and `Chart` the same way, with the pointer, the wheel, the
drag and their events left on the control and the hit-test state (`bars`,
`slices`, `lastBox`, `hover`) on the document, because it is the drawing that
knows where things went. Three things worth knowing before touching either:
- **The control's own exports still run through its `Canvas`**, not through
  `Drawing`: the same frame the screen gets, so `Canvas.Dump()` after a `Save`
  is what was written -- which is how `tests/report` reads a page, and the
  first version that routed the control through `Drawing` turned 35 of its
  assertions red for that reason alone. The document's `Save`/`SavePdf` are the
  ones with no control, and `tests/report` holds the two together: `Paint`
  draws, call for call, what the control exports for that page.
- **The language has no descriptor copying**, so the delegation is one written
  accessor per property, each with its own JSDoc -- the check reads a
  declaration, and a loop over names would document nothing.
- **A component's field initialisers run after the `.form` loaded it**, so the
  document is made lazily in the `Document` getter and the `_doc` field is
  declared without a value -- the trap *a field initialiser does not beat the
  `.form` load* above.

`tests/report`'s `testDocument` runs a real `main` project as a child, with
`uses: ["report", "charts"]`, and asks `pdfinfo` and `pdftotext` about what it
wrote: the page count it said, the paper it was told, and its words as text.
