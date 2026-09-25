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
| `Type` | `Bar` `Line` `Area` `Pie` `Doughnut`. `"Bar"` | [the kinds](#the-kinds) |
| `Curved` | rounded lines, **monotone**. `false` | [the kinds](#the-kinds) |
| `Stacked` | series piled instead of side by side. `false` | [the kinds](#the-kinds) |

**The data**

| | | |
|---|---|---|
| `Series` | the numbers: `[{ Name, Values, Color, Axis }]`. `[]` | [the data](#the-data) |
| `Labels` | the category axis, as strings. `[]` | [the axes](#the-axes) |
| `Marks` | `[{ At, Text }]` — a **real** time axis. `[]` | [the axes](#the-axes) |

**The axes and what is written on them**

| | | |
|---|---|---|
| `Decimals` | how the numbers are written, `0` to `6`. `0` | [the axes](#the-axes) |
| `Grid` | the horizontal rules behind the data. `true` | [the axes](#the-axes) |
| `Legend` | `None` `Top` `Bottom`. `"Bottom"` | [the axes](#the-axes) |
| `ShowValues` | the number on the bar or the percentage in the slice. `false` | [the axes](#the-axes) |
| `Title` | above the plot. **Translated**. `""` | [the axes](#the-axes) |
| `YMax` | pins the top; `""` works it out from the data. `""` | [the axes](#the-axes) |
| `YMin` | likewise the bottom. `""` | [the axes](#the-axes) |

**A long series**

| | | |
|---|---|---|
| `Antialias` | smooth edges. `true` | [a long series](#a-long-series) |
| `Count` | how many values are on screen; `0` is all. `0` | [a long series](#a-long-series) |
| `From` | the first value on screen. `0` | [a long series](#a-long-series) |
| `Reduced` | decimate to a min and a max per pixel column. `true` | [a long series](#a-long-series) |
| `Zoomable` | the wheel zooms and a drag pans. `false` | [what the pointer does](#what-the-pointer-does) |

**Verbs and events**

| | | |
|---|---|---|
| `Refresh()` | redraws now | [the data](#the-data) |
| `Save(path, width, height)` | the same drawing to a PNG of any size | [off the screen](#off-the-screen) |
| **event** `Select(series, at, value)` | a click on a bar, a point or a slice | [what the pointer does](#what-the-pointer-does) |
| **event** `Hover(series, at, value)` | the pointer passing over one | [what the pointer does](#what-the-pointer-does) |
| **event** `Range(from, count)` | the window changed | [what the pointer does](#what-the-pointer-does) |

## The kinds

| | |
|---|---|
| `Type` | `Bar`, `Line`, `Area`, `Pie` or `Doughnut` |
| `Stacked` | series piled instead of side by side. Applies to `Bar` and `Area`; a line and a pie **ignore** it rather than refusing, so the order of two lines in a `.form` never matters |
| `Curved` | rounded lines for `Line` and `Area`, and **monotone**: between two samples the curve stays between their values and flattens at a peak instead of inventing a taller one. Off by default, because a curve says something about values nobody measured |

## The data

| | |
|---|---|
| `Series` | `[{ Name, Values, Color, Axis }]` — see below. Assigning it redraws |
| `Refresh()` | redraws now. **Assigning any property already does**, so this is for the case where the numbers changed **in place** |

| On a series | |
|---|---|
| `Name` | what the legend says. **Translated** (`Series.Name`). Defaults to `Series 1`, `Series 2`, … |
| `Values` | the numbers. A number or numeric text is a value; **anything else — `null`, `undefined`, `NaN`, `""`, a word — is a gap**: a line or an area stops there and starts again at the next value, a bar is not drawn, and the pointer over it reports nothing. A gap is never a zero |
| `Color` | any CSS colour; omitted, it takes the next of the library's eight, chosen to hold up on a light theme and a dark one |
| `Axis` | `"Left"` or `"Right"`. **`"Right"` gives that series its own range, ticks and margin** — two series in different units on one scale is the classic chart that lies |

## The axes

| | |
|---|---|
| `Labels` | the category axis, as strings. As many as there are values is a label per bar; **fewer** is marks spread evenly across the plot; a pie names its slices from them |
| `Marks` | `[{ At, Text }]`, `At` being an index into the values — a **real** time axis, where the caller says where each label goes. Replaces `Labels` on the x axis while it is set |
| `YMin` | pins the bottom of the y axis; `""` (or `null`) works it out from the data, on *nice* numbers rather than on the data's own extremes. A value that is not a finite number is refused where it is assigned — stored, it left the axis with no ticks and every frame threw |
| `YMax` | likewise the top |
| `Grid` | the horizontal rules behind the data |
| `Legend` | `None`, `Top` or `Bottom`. It wraps to at most **three** rows and whatever did not fit is not drawn: a legend of thirty series is the wrong control, and eating the plot to hold one is worse |
| `Title` | above the plot. **Translated** |
| `ShowValues` | the number on the bar or the percentage in the slice, **drawn only where it measures as fitting** |
| `Decimals` | how those numbers are written, `0` to `6`. It goes through [`Locale.Number`](../globals/Locale.md), so the separators are the user's |

## A long series

| | |
|---|---|
| `Reduced` | more points than pixel columns are decimated to a min and a max per column, which keeps the envelope — **a one-sample spike survives it**. On by default |
| `From` | the first value on screen |
| `Count` | how many are on screen; `0` is all of them |
| `Antialias` | smooth edges. Off is faster and looks it |
| `Zoomable` | lets the wheel zoom and a drag pan — see [what the pointer does](#what-the-pointer-does). Off by default, so a chart of four bars never steals a scroll from the `Scroller` around it |

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
| **event** `Range(from, count)` | the window changed |

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
