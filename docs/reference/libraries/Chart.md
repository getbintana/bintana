# Chart

A chart, as a component: one class, and `Type` says which kind.

Bars, lines, areas, pies and doughnuts over a category axis, with two axes,
stacking, monotone curves and a window into a series too long to draw whole. It
is **not a control of the runtime**: it ships in the `charts` library, is reached
with `uses`, and is about a thousand lines of ordinary Bintana over a
[`DrawingArea`](../widgets/DrawingArea.md).

```json
{ "name": "Sales", "startup": "SalesForm", "uses": ["charts"] }
```

```json
{ "type": "Chart", "name": "Monthly",
  "properties": { "Expand": true, "Type": "Bar", "Title": "Sales",
                  "Legend": "Bottom", "Labels": ["Jan", "Feb", "Mar"] } }
```

```js
this.Monthly.Series = [{ Name: "2026", Values: rows.map((r) => r.Total) }];
```

**The declaration is in the `.form` and only the numbers come from code.** That
is the whole argument of this environment applied to charts: `Type`, `Labels`,
`Legend`, `Grid`, `Title` and the y range are ordinary properties, so the
designer edits them, the serialiser keeps them and the catalogue translates the
prose.

It is a [`Component`](../widgets/Component.md), so everything on
[`Widget`](../widgets/Widget.md) is on it too.

## Every member

**The shape of it**

| | | |
|---|---|---|
| `Type` | `Bar` `Line` `Area` `Pie` `Doughnut` | [the kinds](#the-kinds) |
| `Curved` | rounded lines for `Line` and `Area`, **monotone**: between two samples the curve stays between their values and flattens at a peak instead of inventing a taller one | [the kinds](#the-kinds) |
| `Stacked` | series piled instead of side by side | [the kinds](#the-kinds) |

**The data**

| | | |
|---|---|---|
| `Series` | the data | [the data](#the-data) |
| `Labels` | the category axis, as strings | [the axes](#the-axes) |
| `Marks` | `[{ At, Text }]`, `At` being an index into the values — a **real** time axis, where the caller says where each label goes | [the axes](#the-axes) |

**The axes and what is written on them**

| | | |
|---|---|---|
| `Decimals` | how the numbers are written, `0` to `6`; goes through `Locale.Number`, so the separators are the user's | [the axes](#the-axes) |
| `Grid` | the horizontal rules behind the data | [the axes](#the-axes) |
| `Legend` | `None` `Top` `Bottom` | [the axes](#the-axes) |
| `ShowValues` | the number on the bar or the percentage in the slice, drawn only where it measures as fitting | [the axes](#the-axes) |
| `Title` | above the plot | [the axes](#the-axes) |
| `YMax` | likewise the top | [the axes](#the-axes) |
| `YMin` | pins the bottom of the y axis | [the axes](#the-axes) |

**A long series**

| | | |
|---|---|---|
| `Antialias` | smooth edges | [a long series](#a-long-series) |
| `Count` | how many are on screen | [a long series](#a-long-series) |
| `From` | the first value on screen | [a long series](#a-long-series) |
| `Reduced` | more points than pixel columns are decimated to a min and a max per column, which keeps the envelope — a one-sample spike survives it | [a long series](#a-long-series) |
| `Zoomable` | lets the wheel zoom and a drag pan — see [what the pointer does](#what-the-pointer-does) | [what the pointer does](#what-the-pointer-does) |

**Verbs and events**

| | | |
|---|---|---|
| `Refresh()` | redraws now | [the data](#the-data) |
| `Save(path, width, height)` | the same drawing to a PNG of any size — a chart in a report, or in a bug report | [off the screen](#off-the-screen) |
| **event** `Select(series, at, value)` | a click on a bar, a point or a slice | [what the pointer does](#what-the-pointer-does) |
| **event** `Hover(series, at, value)` | the pointer passing over one, **which is not a selection**: a chart that reported a click as a hover could not have a tooltip | [what the pointer does](#what-the-pointer-does) |
| **event** `Range(from, count)` | the window changed — the wheel, a drag, or the double click that resets it | [what the pointer does](#what-the-pointer-does) |

## The kinds

| | |
|---|---|
| `Type` | `Bar` `Line` `Area` `Pie` `Doughnut`. Defaults to `"Bar"`. |
| `Stacked` | series piled instead of side by side. Applies to `Bar` and `Area`; a line and a pie **ignore** it rather than refusing, so the order of two lines in a `.form` never matters. Defaults to `false`. |
| `Curved` | rounded lines for `Line` and `Area`, **monotone**: between two samples the curve stays between their values and flattens at a peak instead of inventing a taller one. Off by default because a curve says something about values nobody measured. Defaults to `false`. |

## The data

| | |
|---|---|
| `Series` | the data: `[{ Name, Values, Color, Axis }]` — see below. Defaults to `[]`. Assigning it redraws |
| `Refresh()` | redraws now. **Assigning any property already does**, so this is for the case where the numbers changed **in place** |

| On a series | |
|---|---|
| `Name` | how the form reaches it — `this.BtnSave` — and the prefix its handlers carry: `BtnSave_Click`. A valid JavaScript identifier, unique on the form |
| `Values` | the numbers. A number or numeric text is a value; **anything else — `null`, `undefined`, `NaN`, `""`, a word — is a gap**: a line or an area stops there and starts again at the next value, a bar is not drawn, and the pointer over it reports nothing. A gap is never a zero |
| `Color` | any CSS colour; omitted, it takes the next of the library's eight, chosen to hold up on a light theme and a dark one |
| `Axis` | `"Left"` or `"Right"`. **`"Right"` gives that series its own range, ticks and margin** — two series in different units on one scale is the classic chart that lies |

## The axes

| | |
|---|---|
| `Labels` | the category axis, as strings. As many as there are values is a label per bar; **fewer** is marks spread evenly across the plot; a pie names its slices from them. Defaults to `[]`. |
| `Marks` | `[{ At, Text }]`, `At` being an index into the values — a **real** time axis, where the caller says where each label goes. Replaces `Labels` on the x axis while it is set. Defaults to `[]`. |
| `YMin` | pins the bottom of the y axis; `""` (or `null`) works it out from the data, on *nice* numbers rather than on the data's own extremes. A value that is not a finite number is refused where it is assigned — stored, it left the axis with no ticks and every frame threw. Defaults to `""`. |
| `YMax` | likewise the top. Defaults to `""`. |
| `Grid` | the horizontal rules behind the data. Defaults to `true`. |
| `Legend` | `None` `Top` `Bottom`. It wraps to at most **three** rows and whatever did not fit is not drawn: a legend of thirty series is the wrong control, and eating the plot to hold one is worse. Defaults to `"Bottom"`. |
| `Title` | above the plot. **Translated**. Defaults to `""`. |
| `ShowValues` | the number on the bar or the percentage in the slice, drawn only where it measures as fitting. Defaults to `false`. |
| `Decimals` | how the numbers are written, `0` to `6`; goes through `Locale.Number`, so the separators are the user's. Defaults to `0`. |

## A long series

| | |
|---|---|
| `Reduced` | more points than pixel columns are decimated to a min and a max per column, which keeps the envelope — a one-sample spike survives it. Defaults to `true`. On by default |
| `From` | the first value on screen. Defaults to `0`. |
| `Count` | how many are on screen; `0` is all of them. Defaults to `0`. |
| `Antialias` | smooth edges. Off is faster and looks it; `Reduced` is the knob that actually matters. Defaults to `true`. |
| `Zoomable` | lets the wheel zoom and a drag pan — see [what the pointer does](#what-the-pointer-does). Off by default, so a chart of four bars never steals a scroll from the `Scroller` around it. Defaults to `false`. |

**The cost of a frame is in pixels covered, not in points**, and in an
interpreter the passes over the data cost more than the drawing. Measured on
21,600 readings in an 800-wide plot:

```
decimated      59.0 frames/s    3.5 ms in the handler
every point    13.2 frames/s   46.6 ms
```

`Reduced` is why the first line exists. The rest is the caller's: the first
working version of this component drew at 35 frames a second because it computed
the y range with `flatMap` over all 21,600 values **on every frame**, and neither
the values nor the range had changed. **Hand a chart a long series and do the
arithmetic once.**

## What the pointer does

Nothing until `Zoomable`, and then: the wheel zooms about the pointer, a drag
pans, and a double click goes back to all of it. Each raises `Range`, and **the
wheel notch is only consumed when the view actually changed** — zooming out a
view that already shows everything answers `false` and raises no `Range` — so a
chart inside a [`Scroller`](../widgets/Scroller.md) still scrolls it at the ends.

| | |
|---|---|
| **event** `Select(series, at, value)` | a click on a bar, a point or a slice. `at` is the index into that series' `Values` |
| **event** `Hover(series, at, value)` | the pointer passing over one, **which is not a selection**: a chart that reported a click as a hover could not have a tooltip. On a line or an area it is the first series; on a **stacked** `Area` it is the band the pointer is inside (the top one above them all), `value` is that series' own value, and the mark is drawn at the top of its band |
| **event** `Range(from, count)` | the window changed — the wheel, a drag, or the double click that resets it |

`Select` and `Hover` are raised whether or not the chart is zoomable, and both
carry the index into the **whole** series — never the position on screen.

## Off the screen

| | |
|---|---|
| `Save(path, width, height)` | the same drawing to a PNG of any size — a chart in a report, or in a bug report |

## What it does not do

No animation, no radar, no candlesticks, no second x axis, no logarithmic scale,
and **no tooltip window** — `Hover` is there so the form can put the text where
it wants it.

Three of Chart.js' are left out on purpose, that being the library this one was
measured against: its **plugin system**, because a component's subclass is the
extension point here; its **animation by default**, because a chart that animates
on every change of data is one nobody can read a number off; and its **config
object**, because a bag of nested options is the opposite of a designable
control — which is the whole argument of this environment, and the reason `Type`,
`Legend` and `Labels` are properties in a file.

## See also

[`Report`](Report.md) · [`Markdown`](Markdown.md) ·
[`DrawingArea`](../widgets/DrawingArea.md) ·
[`examples/charts`](../../../examples/charts) ·
[llm/charts.md](../../llm/charts.md), the short form
