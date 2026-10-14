# Drawing and printing

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Painter and DrawingArea

- **A NaN in a painter is worse than a refusal.** `arg_num` took whatever
  `JS_ToFloat64` gave it, so `p.LineTo("abc", 5)` recorded a NaN: cairo puts
  the context in an error state and **the rest of the frame draws nothing**,
  with no throw and nothing to see. It refuses non-finite values now, naming
  the call (`LineTo: NaN is not a finite number`) -- and that immediately found
  a test calling `p.Text(10, 20, "sheet")`, text and coordinates the other way
  round, which had been drawing the number 10 at a NaN y for as long as it had
  been there. **The whole frame is the unit of damage**, which is why the check
  belongs at the argument.
- **A `Painter` outliving its frame is the one way to crash a drawing**, so it
  refuses instead. The `cairo_t` belongs to GTK's draw function and is destroyed
  when it returns; `painter_of` in `bta_paint.c` is the single door every call
  goes through, and it throws once `cr` is NULL. Keeping the painter in `this` to
  draw from a timer is the natural mistake and the one the refusal catches.
- **`Text` had to clear the path, and `Arc` had to not.** Cairo appends an arc to
  the current path, joining it from wherever the current point was -- which is
  what a pie slice wants (`MoveTo` the centre, `Arc`, `ClosePath`, `Fill`).
  Showing a Pango layout leaves a current point, so the first drawing this
  runtime ever made had a stray diagonal from a label across to an arc. Drawing
  calls leave no path; path calls do.
- **A `Dump()` formatted with `%g` is a `Dump()` that changes with the locale.**
  printf follows `LC_NUMERIC`, so the point `(380, 142.449)` printed as
  `(380,142,449)` here -- a decimal comma inside a comma-separated pair, in the
  one output a test asserts on. `g_ascii_formatd` is the locale-independent one,
  and this is the same trap the JSON patch in `vendor/` exists for. Anything that
  formats a number *for a test to read* has to use it.
- **A `DrawingArea` has no natural size**, because there is nothing inside it to
  measure: one placed with neither a size nor an `Expand` is allocated 0x0, its
  handler is called with a 0x0 frame, and nothing is drawn. A test that asserts
  anything about a real frame has to size the surface first, and the palette gives
  a placed one 240x160.
- **`Save()` is why the drawing tests are not screenshots.** It runs the same
  `Draw` against an image surface, synchronously, so `Dump()` can be asserted
  call by call with no waiting for GTK to paint; the on-screen path is a separate
  claim and is covered once, through `until`, because "the draw function is wired"
  and "the handler works" are different facts. The file it writes is checked by
  loading it into a `Picture` and reading `SourceWidth`/`SourceHeight` -- the
  runtime can read a PNG back, which is cheaper than a pixel probe.
- **A `void` helper that throws is a throw nobody sees.** `paint_frame` refuses a
  `Save()` asked for from inside a `Draw` -- one painter means one frame -- and
  for as long as it returned `void`, `area_save` carried on, wrote the PNG and
  returned success with the exception left pending. The test read `NOT REFUSED`
  against a guard that was firing -- and the *next* two tests failed as well,
  because a pending exception nobody consumed stays on the context and lands on
  whoever asks next (`an uncaught error reaches the application: expected 1, got
  0`, then a crash reading a property of `undefined`). Anything that can throw has
  to be able to say so to its caller, even when one of its two callers -- the draw
  function -- has nobody to tell.
- **`MouseWheel` carries the amounts and not the position.** Two arguments,
  which is already in the trap list one way (it was documented as four); the
  consequence for anything that zooms about the pointer is that the position has
  to come from the last `MouseMove`. `Chart` tracks it for the hover anyway. And
  **a chart that pans cannot report `Select` on `MouseDown`**: the press is
  remembered, the movement decides whether it was a drag, and the release reports
  the click -- including suppressing the one that completes a double click, or a
  reset is followed by a selection nobody asked for.
- **The obvious spline lies, and a picture cannot show it.** `Chart.Curved` draws
  a rounded line, and Catmull-Rom -- the five-line answer -- overshoots: two
  rising samples grow a taller peak between them, and a series that never went
  below zero dips under the axis. Monotone tangents (Fritsch-Carlson) cannot leave
  the box two samples make. The reason it is worth knowing here rather than in the
  chart: **a curve that overshoots looks better**, so the test is not a look but a
  read of `DrawingArea.Dump()` -- every `CurveTo`'s control points, checked against
  the data's own range. Any claim about a drawing that a nicer-looking bug would
  satisfy wants that treatment.
- **A `MoveTo` in the middle of a shape is a second subpath, and a fill runs the
  winding rule across both.** A ring segment written as `Arc` out, `MoveTo` in,
  and line segments back cut white wedges through the middle of the first doughnut
  `examples/charts` drew -- which looks like a rasteriser bug and is a path with
  two pieces in it. `Painter.ArcNegative` exists for exactly this: out along the
  outer radius, back along the inner one, one path. It is the only primitive the
  chart set asked the surface for -- which is what writing the client first was
  for, and the whole of what it added to the C.
- **In this interpreter, a pass over the data costs more than painting it.**
  Measured while writing `examples/charts`: a 21,600-reading line drew at 35
  frames a second with 21 ms inside the `Draw` handler, of which about *one*
  millisecond was drawing. The rest was two data passes -- decimating on every
  frame, and computing the y range as
  `Series.flatMap(s => s.Values).filter(isFinite)` with `Math.min(0, ...all)`
  over the result. Cached on the array's identity and rewritten as a plain loop,
  the same chart draws at **59 frames a second with 3.5 ms**. So: `Polyline` of a
  thousand points is cheap, `flatMap` of twenty thousand is not, and a spread of
  twenty thousand arguments is a stack overflow waiting for a longer series.
  Anything derived from a large array belongs computed when the array changes, not
  when the frame does.
- **A stopwatch inside a `Draw` measures the recording, not the drawing.** GTK4
  hands the draw function a cairo context over a `GskCairoNode`, so the calls are
  recorded and the rasterising happens later. Measured with the jagged
  5,000-point line of `tests/manual/cairo-cost.c` in an 800x400 area: **8 ms
  inside the handler either way, and 3.9 frames a second antialiased against
  57.7 without**. Through `DrawingArea.Save()` -- an image surface, rasterised
  inside the call -- the same drawing is 283 ms against 28 ms. So: to ask *what
  does this cost*, time a `Save()`; to ask *is this smooth*, count frames over a
  second (`examples/drawing` does both). A stopwatch around the painting is
  neither, and it is the first thing everybody reaches for.
- **And quote the conditions with it, because that number is about covered pixels
  and nothing else.** The first person to run `examples/drawing` reported "always
  about 60 frames a second", and they were right: in its 402x159 sparkline the
  cliff needs **3,240 jagged points to reach 15 fps and 9,720 to reach 3**, while
  1,080 is 51 and anything smooth stays at 60. Stretch that same box to 402x419
  and every figure roughly halves (29, 7, 1.2), which is what "covered pixels"
  means: the height a segment travels counts as much as how many there are. The
  3.9 figure above is 5,000 points in twice the area. Below about a thousand points nothing shows at all --
  which is the practical answer for any real chart, and the reason the cliff has
  to be quoted with its point count, its shape and its box or it reads as a
  warning about work nobody does.
- **It is not the renderer.** Measured at 8.5-8.8 frames a second under all four
  of `GSK_RENDERER=cairo`, `gl`, `ngl` and `vulkan`: a cairo node is rasterised on
  the CPU whichever renderer composites the result, so there is no "it will be
  fine on a real GPU" to hope for -- and no reason to suspect Xvfb either.
- **A value that is not a number is a gap in a line, and it used to be a lost
  frame.** The painter refuses NaN and a throw inside `Draw` ends the frame, so a
  `null` in a Line or Area series -- ordinary in data from a query -- drew
  nothing at all past it. `Chart.numberOf` makes null, `""`, booleans and text
  that is not a number `NaN` (null and `""` used to be 0, silently), and Line and
  Area draw separate runs that stop at a gap, decimation included. Three smaller
  things came with it: **divide before multiplying** when mapping to pixels --
  `(v - lo) * h / (hi - lo)` overflowed near the top of a double where
  `(v - lo) / (hi - lo) * h` does not; **never name a class static `valueOf`**
  or any other `Function.prototype` member, it shadows what coercion calls; and
  **`DrawingArea.Dump()` is capped** (`DUMP_CAP`, ending in `...`), so an
  assertion about the second band of a 4000-sample chart read the first and
  passed against the bug -- save narrow and assert the markers are there.
- **`\w` is ASCII, and in a slug it deletes whole headings.** `Введение`
  slugged to `""`, so every Cyrillic heading shared one anchor.
  `/[\p{L}\p{M}\p{N}_]/u` keeps exactly what `\w` kept, so no ASCII anchor
  moved, and anchors are numbered on repeat (`setup`, `setup-1`) or `ScrollTo`
  only ever reached the first. And **tabs are indentation except inside a
  fence**: expanding them before parsing is right for a list and wrong for a
  Makefile in a code block, which is why `untabbed()` tracks fences.
- **A chart assertion sets every property it depends on.** The *stacked Line
  turned Bar* check passed against the bug in a copy with the section before it
  removed, because `Type` was still the default `Bar` it inherited.
- **`Push`/`Pop` does not save the font.** It saves the colour, the pen, the
  transform and the clip -- cairo's own state -- and the font lives on the
  `PangoLayout` beside it. `lib/report` wrapped every element in a `Push`/`Pop`
  and set `p.Font` only when the element named one, with a comment claiming that
  a font "can never leak into the next": the whole statement of account came out
  in the `Bold 18` its title declared, and the date under the heading was drawn
  at 18 points. The rule for anything that draws text it did not write: **read
  the font once at the top of the `Draw` and assign it for every run**, either
  the element's or that one. Asserted in `tests/report` off two `Text` calls and
  the `Font` lines between them.
- **Reading the font "once at the top of the `Draw`" is not enough, because
  there is one painter per control and it outlives the frame.** `paint_frame`
  says so in its own comment -- "one frame at a time, because there is one
  painter" -- so `p.Font` at the top of the *next* frame is whatever the *last*
  element of the previous one assigned. `lib/report` measured each band with
  `Text.Font` (the measure pass has no painter, which is what lets pagination
  run in a console program) and drew it with `p.Font`, and the two are only the
  same value until anything sets a font: one element naming one made every
  element that named none on the next page and the next export draw in it. A
  report whose text was measured in `Sans 10` and drawn in `Normal 12` wrapped
  into five lines into a band measured for four, **with the row below drawn
  underneath the row above**. `base` is `Text.Font` now, and the report's
  invariant -- what the measure decided is what the drawing makes -- is true by
  construction rather than by there happening to be no font in the report. The
  general shape: **a value read "once per frame" is only per frame if it is
  reset per frame**, and the reset belongs where the other reading is, not at the
  read. Found by a new test for conditional row styling, which is the argument
  for writing the test before believing the comment: the old one named this
  exact case and called it "a drawing whose font an `app.css` has changed".
- **`Scale` before `Translate` scales the offset.** Cairo post-multiplies, so of
  two transforms the one written *last* is applied *first* to a point: `Scale(s)`
  then `Translate(o)` puts a point at `s * (p + o)` and not at `o + s * p`.
  Measured with a probe -- `Scale(0.5)`, `Translate(100,0)`, a rectangle at the
  origin -- the ink lands at x=50. `lib/report` centred its page that way and the
  preview sat off-centre by `(1 - scale) * offset`, which is nothing in a small
  window and ninety pixels in a maximised one, and **is exactly zero in an
  export**, whose offset is zero -- so every PNG anybody checked was right. To
  place then scale, write `Translate` first.
- **A throw inside a `Draw` does not reach the handler's caller, and for a long
  time it did not reach the exporter either.** `bta_emit` reports what a handler
  threw and consumes it, which is right for an event and wrong for `Save`: it
  wrote a PNG of whatever had been drawn before the error and returned happily.
  `Report` read `this._sections.PageHeader` and threw on every frame for any
  report whose form had not filled it in yet -- the ordinary case of a preview
  waiting for the user to choose something -- and it was invisible from the
  outside. `bta_emit_ok` is the same emit answering whether the handler threw;
  `paint_frame` turns that into an exception, so **`Save` and `SavePdf` now fail
  and write nothing**, and `on_draw` throws the exception away because on screen
  there is nobody to hand it to -- leaving it pending would surface it at the
  next call into JS, half a program away from the frame that made it. The
  on-screen path still swallows the error, so **to assert that a frame ran to the
  end, read `DrawingArea.Dump()`**: the clip it opens and the `Pop` that closes
  it are in the dump, and a frame that died halfway has neither.
- **`Text` and `Painter` agree because the resolution is set, not because they
  share a font map.** `pango_cairo_font_map_get_default()` gives a context at
  Pango's own 96 dpi, and a widget's context carries the desktop's `gtk-xft-dpi`
  -- so on a desktop with text scaling the two measurements of the same string in
  the same font differ, silently, by exactly the scale. It is read on every call
  rather than cached, because the scale can change while the program runs.
  Asserted in `tests/widgets` (`Metrics`) against `Painter.TextWidth` rather than
  believed. **One measurement that does not match: a vector surface.** Hinting is
  off for PDF, so a string can lay out a pixel narrower there than the same
  string on an image surface -- which is a property of the surface, not a bug to
  chase.
- **`gdk_texture_download` writes exactly what cairo wants, and cairo has to be
  told.** The pixels land in `CAIRO_FORMAT_ARGB32` with no conversion, which is
  what makes `Painter.Image` a dozen lines -- but they are written behind cairo's
  back, so without `cairo_surface_mark_dirty` the first paint shows the surface's
  allocation, which is nothing at all.
- **A painter primitive must not put anything in the caller's path.** `Image`
  paints with `cairo_paint()` and not a rectangle and a fill: a fill runs over
  whatever path the handler had already started, and a path survives
  `Push`/`Pop` here by design. The source's own extent is what bounds the ink,
  so `paint` is also the right answer and not only the safe one.
- **The pen's width is `LineWidth`, and `p.Width = 8` is a plain JavaScript
  property that the painter never reads.** It does not throw, it does not warn,
  and the line stays one pixel: `examples/gpx` drew its track "wider" through
  three rounds of screenshots before anybody looked at the property table --
  `painter_props` says `LineWidth`, and every other painter in the tree
  (`lib/charts`, `lib/report`, `lib/markdown`, `examples/drawing`) already
  wrote it that way. **`--strict` would not have caught it either**: a
  `Painter` is not a widget, so it is not in the class table strict checks.
  When a drawing property seems to do nothing, read `painter_props` before
  redrawing.
- **A PDF is written as it is drawn.** `cairo_pdf_surface` streams, so a page
  that throws halfway leaves a file on disk that looks like an export that
  worked; `SavePdf` removes it. Anything that writes progressively wants the
  same treatment -- `File.Save` gets it for free by writing a temporary and
  renaming it over.
- **A margin that uses up the paper is a loop that never ends.** `lib/markdown`'s
  `pageBreaks` advanced by the printable height, and `Margins = 421` on A4
  leaves none: `SavePdf` and `Send` hung the program. It refuses before the
  loop and throws if a page ever fails to advance; the object form of `Margins`
  refuses a side that is not a finite number in both `markdown` and `report`,
  which the number form always had.
- **`printf("%g")` writes the locale's decimal separator, and this machine writes
  a comma.** `Ratio = 1.5` came back `"1,5"`, which is what the `.form` would
  then carry and what `JSON.parse` would read as **nothing** -- the same fault
  the QuickJS number patch exists for, one layer up, and it was caught by a test
  asserting the round trip rather than by anybody reading the code.
  `g_ascii_dtostr` on the way out, `g_ascii_strtod` on the way in, for any
  property that keeps a number as text. **`Painter.Foreground` was the third
  one**, and it is the one that threw: `rgba(%d,%d,%d,%.3g)` read
  `rgba(32,64,96,0,5)` here, `lib/charts` assigned it straight to `p.Color`, and
  `gdk_rgba_parse` refused it from inside a `Draw`. The alpha goes through
  `g_ascii_formatd`, and `tests/widgets` matches the **whole** string now -- the
  prefix test it had accepted the comma.

## Printing

- **On `EXPORT` this GTK renders every page whatever range the settings carry.**
  `Printer.ToFile(area, path, { Pages: 5, From: 2, To: 3 })` came back a five-page file with
  `before` called for all of them -- measured first in Bintana, then again in a
  forty-line C probe that set the range and watched `draw-page` fire 0 to 4, so
  it is GTK's and not the plumbing's (the 0-based numbering the probe showed is
  why `before` adds one). A range on the file road is said with the page count
  instead -- the file then holds exactly `From..To` -- while the dialog road
  keeps the whole count (it is what the dialog offers the range within) and the
  settings carry the preset. The `answer` reports the pages actually rendered
  either way, which is what keeps it truthful on both roads.
- **GTK4 has no built-in print preview: `Vista previa` opens Evince or Papers.**
  The button is there and the dialog is GTK's, but the preview itself is a
  temporary PDF handed to an external viewer -- on a machine with neither
  installed the preview fails, and the failed launch takes the run down with a
  cairo assertion in GTK's own cleanup (measured with an empty `Draw`, so it is
  not the drawing). Documented rather than worked around: there is nothing in
  this runtime that shows a PDF. `Cancel`, by contrast, is clean and asserted
  nowhere -- it returns `null` and quits, verified by hand four times because
  no suite can click a dialog.
- **A verb with a key that decides whether there is a dialog is two verbs.**
  `Print(area, { ToFile })` opened the print dialog, or did not, depending on a
  key in its options -- and the give-away was measurable rather than stylistic:
  `Copies: 3` down the file road answered *three copies sent* and wrote the same
  file, byte for byte, as one copy. A file has no copies. Split into
  `Printer.Send` and `Printer.ToFile`, the key that does not apply cannot be
  passed, and the answer cannot claim what did not happen -- the shape
  `Dialog.OpenFile`/`Dialog.SaveFile` already had. **When a key changes what the
  call *is* rather than what it does, it is the name of another call.**
- **A second event beats a fourth argument.** Which page a handler was drawing
  used to travel through a field of the form -- a `before` callback wrote it and
  `Draw` read it back -- because growing `Draw` a fourth argument would have
  changed every handler ever written. `DrawPage(painter, page, width, height)`
  is raised in its place on paper, and a form that declares none still gets
  `Draw`, so nothing had to change when it arrived. `bta_has_handler` is asked
  rather than guessed: "the form did not declare it" and "it declared it and it
  does nothing" are different statements, and only the first may fall back.
- **Two libraries may not declare the same top-level name, and nothing was
  checking.** A project's libraries are evaluated into the one global scope the
  project runs in, so `lib/report` and `lib/markdown` each declaring a top-level
  `const PAPERS` -- the same three paper sizes, written out twice -- meant a
  project naming **both** did not start: `SyntaxError: redeclaration of
  'PAPERS'`, on line 1 of a file its author never wrote, with nothing in the
  message about which two libraries were arguing. The IDE offers libraries as
  ticks, so two ticks was the whole reproduction. **Nothing in the suite could
  have caught it**, because no project in this tree named two libraries: each
  had a test project of its own, so the suite proved all three work and never
  that any two work at once. Both halves exist now -- `tests/api.sh` compares
  the top-level names of every library, and `tests/smoke` names all three --
  and the table itself is `Printer.Papers`, read off GTK.
- **How many pages a document is depends on the paper, and the paper is the
  dialog's answer.** `Printer`'s `Pages` is worked out against the paper the
  *caller* had; a `Markdown` laid out for A4 is six sheets on A5, and the
  operation printed the four that were declared and dropped the rest -- measured
  on a real document, silent. `Paginate(width, height)` is asked in GTK's
  `begin-print`, which is the only place both things are true: the paper is
  resolved and `set_n_pages` may still be called. **A control whose layout does
  not move with the paper must declare none** -- `lib/report` scales a page to
  fit and its count does not move. It declared one for a single commit,
  returning `PageCount`, and the cost was not redundancy: `PageCount` measures
  when it has to, and measuring inside `begin-print` re-enters the drawing the
  operation is in the middle of. **The suite hung.** Measure inside `Paginate`,
  raise no events.
- **A dialog that blocks the caller is the odd one out here, and blocking never
  meant safe.** `Printer.Send` ran `gtk_print_operation_run` synchronously and
  answered `null` for a cancel, while `Dialog.OpenFile`, `SaveFile` and `Color`
  all take a callback and none of them reports a cancel -- so it was the one
  dialog a program had to treat differently. And the synchrony bought nothing:
  GTK runs a **nested main loop** while a dialog is up, so the program keeps
  going. Measured: during a 484 ms print a `Timer.Every(20)` fired four times,
  and a second print of the same control started from a timer was **not
  refused** and wrote its pages. `set_allow_async` plus the `done` signal is the
  shape now, the callback is required and not called on a cancel, and one
  control prints once at a time. `bta_paint_busy` does not cover that: between
  two sheets there is no frame open, which is why the suite probes it from
  `Paginate` and not from `DrawPage`.
  **Going async moved where the refusals land, and they did not follow.** A
  `Paginate` that throws, a range the new paper leaves empty and a `DrawPage`
  that throws all raise an exception and mark the run failed -- right for
  `ToFile`, whose caller is on the stack and returns `JS_EXCEPTION`. On `Send`
  they run inside GTK's signals of an operation nobody waits on, and
  `on_print_done` dumped only its own errors, so the exception stayed on the
  context for whoever called into JavaScript next. `print_fail` reports it on
  the spot when the run has a callback. Found by reading, since no headless
  run can answer the dialog; `on_draw` had the same shape answered years
  before.
