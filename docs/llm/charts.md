# Charts — the library that ships with the runtime

`Chart` is not a control. It is a **component** written in Bintana, in the
`charts` library that comes with the runtime, and it is reached the way any
library is: name it in `project.json`, then use its class in a `.form`.

```json
{ "name": "Sales", "startup": "MainForm", "uses": ["charts"] }
```

```json
{
  "type": "Chart", "name": "Sales",
  "properties": { "Type": "Bar", "Title": "By quarter",
                  "Labels": ["Q1", "Q2", "Q3", "Q4"], "Legend": "Bottom" }
}
```

```js
this.Sales.Series = [{ Name: "2026", Values: rows.map((r) => r.Total) }];
```

That division is the whole idea: **what the chart is** goes in the `.form`, where
the designer edits it and the catalogue translates it; **the numbers** come from
code. `uses` finds the library with nothing installed and nothing configured —
where it is looked for is in [the project file's
reference](../formats.md#libraries-uses), and a name that is not found stops the
program printing every path it tried.

The example is `examples/charts`: five shapes, two axes, stacking, curves, and
21,600 readings you can zoom into.

## Chart

One class, and `Type` says which kind. Every property redraws when it is
assigned, and every one of them is designable and serialised, so a form may
declare any of them.

| Member | |
|---|---|
| `Type` | `Bar` `Line` `Area` `Pie` `Doughnut`. `"Bar"` |
| `Series` | the data: `[{ Name, Values, Color, Axis }]` — see below. `[]` |
| `Labels` | the category axis, as strings. As many as there are values is a label per bar; **fewer** is marks spread evenly across the plot; a pie names its slices from them. `[]` |
| `Marks` | `[{ At, Text }]`, `At` being an index into the values — a **real** time axis, where the caller says where each label goes. Replaces `Labels` on the x axis while it is set. `[]` |
| `Legend` | `None` `Top` `Bottom`. It wraps to at most **three** rows and whatever did not fit is not drawn: a legend of thirty series is the wrong control, and eating the plot to hold one is worse. `"Bottom"` |
| `Grid` | the horizontal rules behind the data. `true` |
| `Stacked` | series piled instead of side by side. Applies to `Bar` and `Area`; a line and a pie **ignore** it rather than refusing, so the order of two lines in a `.form` never matters. `false` |
| `ShowValues` | the number on the bar or the percentage in the slice, drawn only where it measures as fitting. `false` |
| `Title` | above the plot. **Translated**. `""` |
| `YMin` | pins the bottom of the axis; `""` (or `null`) works it out from the data. Anything that is not a finite number is **refused** where it is assigned. `""` |
| `YMax` | likewise the top. `""` |
| `Decimals` | how the numbers are written, `0` to `6`; goes through `Locale.Number`, so the separators are the user's. `0` |
| `Antialias` | smooth edges. Off is faster and looks it; `Reduced` is the knob that actually matters. `true` |
| `Curved` | rounded lines for `Line` and `Area`, **monotone**: between two samples the curve stays between their values and flattens at a peak instead of inventing a taller one. Off by default because a curve says something about values nobody measured. `false` |
| `Reduced` | more points than pixel columns are decimated to a min and a max per column, which keeps the envelope — a one-sample spike survives it. `true` |
| `From` | the first value on screen. `0` |
| `Count` | how many are on screen; `0` is all of them. `0` |
| `Zoomable` | lets the wheel zoom and a drag pan. Off, so a chart of four bars never steals a scroll from the `Scroller` around it. `false` |
| `Refresh()` | redraws now. Assigning any property already does |
| `Save(path, width, height)` | the same drawing to a PNG of any size — a chart in a report, or in a bug report |
| **event** `Select(series, at, value)` | a click on a bar, a point or a slice. `at` is the index into that series' `Values` |
| **event** `Hover(series, at, value)` | the pointer passing over one, which is not a selection: a chart that reported a click as a hover could not have a tooltip. On a line or an area it is the first series; on a **stacked** `Area` it is the band the pointer is inside (the top one above them all), `value` is that series' own value, and the mark is drawn at the top of its band |
| **event** `Range(from, count)` | the window changed — the wheel, a drag, or the double click that resets it |

### `Series`

```js
chart.Series = [
    { Name: "2026", Values: [15, 12, 21, 18] },
    { Name: "Margin %", Values: [31, 28, 35, 33], Color: "#e5a50a", Axis: "Right" },
];
```

| | |
|---|---|
| `Name` | what the legend says. **Translated** (`Series.Name`). Defaults to `Series 1`, `Series 2`, … |
| `Values` | the numbers. A number or numeric text is a value; **anything else — `null`, `undefined`, `NaN`, `""`, a word — is a gap**: a line or an area stops there and starts again at the next value, a bar is not drawn, and the pointer over it reports nothing. A gap is never a zero |
| `Color` | any CSS colour; omitted, it takes the next of the library's eight, chosen to hold up on a light theme and a dark one |
| `Axis` | `"Left"` or `"Right"`. `"Right"` gives that series **its own** range, ticks and margin — two series in different units on one scale is the classic chart that lies |

Assigning `Series` replaces the lot; it is a value, not a handle, so mutating the
array you passed changes nothing until you assign again or call `Refresh()`.

A **pie or doughnut reads the first series only** and names its slices from
`Labels`: a pie of two series is two pies, so it draws one. Only positive values
are slices, and **each keeps its own index** — a zero between two slices leaves
its label, its colour and its `Select`/`Hover` index where they were, and the
legend still names it.

## What the pointer does

Nothing until `Zoomable`, and then: the wheel zooms about the pointer, a drag
pans, and a double click goes back to all of it. Each of the three raises
`Range`, and the wheel notch is only consumed when the view actually changed —
zooming out a view that already shows everything answers `false` and raises no
`Range` — so a chart inside a `Scroller` still scrolls it at the ends.

`Select` and `Hover` are raised whether or not the chart is zoomable, and both
carry the index into the *whole* series — never the position on screen.

## The one performance fact

The cost of a frame is in **pixels covered**, not in points, and in an
interpreter the passes over the data cost more than the drawing. Both show up in
the same measurement, on 21,600 readings in an 800-wide plot:

```
decimated      59.0 frames/s    3.5 ms in the handler
every point    13.2 frames/s   46.6 ms
```

`Reduced` is on by default and is why the first line exists. The rest is the
caller's: the first working version of this component drew at 35 frames a second
because it computed the y range with `flatMap` over all 21,600 values **on every
frame**, and neither the values nor the range had changed. If you hand a chart a
long series, do the arithmetic once and keep it.

## What it does not do

No animation, no radar, no candlesticks, no second x axis, no logarithmic scale,
and no tooltip window — `Hover` is there so the form can put the text where it
wants it.

**Three things of Chart.js' are left out on purpose**, since that is the library
this one was measured against: its *plugin system*, because a component's subclass
is the extension point here; its *animation by default*, because `Timer.Every` and
`Refresh()` are enough for the rare case and a chart that animates on every change
of data is one nobody can read a number off; and its *config object*, because a bag
of nested options is the opposite of a designable control — which is the whole
argument of this environment, and the reason `Type`, `Legend` and `Labels` are
properties in a file. `Chart` is a component like any other: it is
[`lib/charts/Chart.js`](../../lib/charts/Chart.js), about a thousand lines of
ordinary Bintana, and a project that needs a shape it has not got can extend it
or copy it into its own `lib/`.
