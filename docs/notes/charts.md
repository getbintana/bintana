# ChartDocument.HitTest: a click for a drawing that holds the document

`Chart` turns the pointer into `Select` through `ChartDocument.at(x, y)`, which
is lower-case and so the class talking to itself. A program that paints several
documents on one `DrawingArea` (Zabbix Reports' dashboards) needs the same
answer and had no public way to ask, so `HitTest(x, y)` wraps it, in the
coordinates `Paint` drew in, against the **last** `Paint`. Its test is in
`tests/report/ReportTest.js`, beside `ChartDocument.Paint`'s.
# lib/charts: Scatter, Heatmap, Gauge, and bars with a line

Three kinds that are not a category plot, and a series that says how it is
drawn (`Series[].Type`). What to know before touching them:
- **`Gauge` and `Heatmap` lay themselves out** (`drawGauge`, `drawHeat`) and
  return from `Paint` before `plot()`: no y axis, no window. A `Heatmap`'s
  `lastBox` has no `view` and a `Gauge` sets it to `null`, so the control's
  wheel and drag check `lastBox.view` before zooming or panning; without that
  check a zoomable heatmap threw on the first notch.
- **A scatter's x axis does not go through zero** and is padded a twentieth
  at each end. Nice ticks may still reach zero for a cloud close to it (200 to
  900 rounds to 0 to 1000); the test uses a cloud far from zero for that.
- **Per-series `Type` partitions the plot**: `drawBars` draws only bar-kind
  series and groups them among themselves, `drawLines` the rest, and a stacked
  axis stacks only the series drawn as the chart's own type. `at()` tries the
  bars, then the first line.
- **The docs generator owns any table row whose first cell is a member's name
  in backticks.** A row about a series' field of the same name (`Type`) has to
  be labelled otherwise ("the series' `Type`"), or `tools/docs.sh` rewrites it
  into the chart's own `Type`.
# lib/charts: the format, the threshold and the window on the document

Three more, all of them about a drawing that is not a `Chart` control:
`Series[].Format`/`Unit`/`Mirror`, `ChartDocument.Lines`, and the window and
pointer verbs the document owns. What bit, in the order it was found:
- **`text(v, [serie])` is the one formatter, and the axis passes the series.**
  Every number the chart writes goes through it, and the series says how: the
  five formats are the application's own words (`""`, `Number`, `Percent`,
  `Duration`, `Bits`), and `Duration`/`Bits` are the arithmetic the app's
  `Dashboards.Format` already had — written twice in one tree until this, and
  they would have drifted the first time one changed. The axis of a side takes
  its format from **its first series** (`axisSeries`), which is why the left
  margin is measured with that series: a GB axis is wider than its bare
  numbers, and measuring without it drew the labels over the plot.
- **A `Mirror` series is negated once, at assignment, and the labels are
  absolute.** The negation lives in the `Series` setter, so range, bars, lines
  and the hit test all measure one shape — and `text()` writes the absolute
  value, so the axis of a butterfly says `1,80` on both sides. The app used to
  negate in `compute` and the axis repeated the minus back; `Dashboards.Mirror`
  is gone. A mirrored bar's `y` is the zero line and its height runs down:
  `b.y >= yOf(0)` is the assertion, not `b.y + b.h <= yOf(0)`.
- **`Lines` is a threshold and `Marks` is not.** One horizontal line per
  `Value` at `yOf(Value)` across the plot, text at the right edge, drawn over
  the data and under the value labels; a value the axis does not reach is
  **omitted** — a line clamped to the border says the opposite of a pinned
  axis. `Bands` stays a gauge's ranges and a *rule* stays the application's
  colour. A gauge, a heatmap and a pie have no plot to cross and ignore it.
- **The wheel, the drag and the click are the document's now**
  (`Zoomable`, `ZoomAt`, `PanBy`, `Press`/`Move`/`Release`), because a drawing
  that paints documents itself — a dashboard of several on one `DrawingArea` —
  forwards the pointer to the chart under it and wants exactly what the control
  does. `Move` answers `"pan"`/`"hover"`/`""` and `Release` answers whether the
  gesture was a click, which is what keeps a drag from also being a `Select`.
  The control's `Canvas_MouseWheel` is four lines that call it.
- **`Tooltip` measures with the font the last frame drew with** (`_font`, kept
  at `Paint`) and **draws nothing**: `{ Text, X, Y, Width, Height }` is a card
  for whoever owns the document. Measuring with any other font is how the text
  overflows the box the same call returned.
- **`LegendHit` is recorded while the legend is drawn**, not recomputed from
  the layout — the picture is the answer. It answers `{ Series, At }`, where a
  plot's `At` is the series and a pie's is the slice, because `Series[].Hidden`
  takes out a series and a slice is not one.
- **A hidden series needs `Refresh()`, and the app must keep it by name.** It
  is a plain field of the normalised series, so assigning `Hidden` changes no
  property and nothing invalidates the cached range; `ChartDocument.Refresh()`
  clears `_range`/`_reduction` and redraws. The application reassigns
  `doc.Series` on every compute, so its painter re-applies the flag by series
  `Name` — the flag would otherwise vanish on the next frame.
