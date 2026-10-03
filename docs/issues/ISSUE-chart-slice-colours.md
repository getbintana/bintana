# ISSUE: a pie cannot say what colour a slice is

## What the application needed

A doughnut of problems by severity, in `bintana-zabbix`, beside a table whose
rows carry each severity's colour -- the colours Zabbix's own front-end uses,
which every reader of the report already knows: *Disaster* red, *High* orange,
*Warning* yellow. The table can do it now (`lib/report`'s `Color: { Field }`).
The chart beside it cannot.

## What I wrote instead

Nothing: the doughnut keeps `lib/charts`' palette, so *Disaster* is blue and
*High* is green, on the same page as a table where they are red and orange.
Sorting the labels so the palette happens to land well is not an answer -- the
palette is fixed and has no red first.

## The code I wish I could have written

```js
chart.Type   = "Doughnut";
chart.Labels = ["Disaster", "High", "Average", "Warning", "Information", "Not classified"];
chart.Series = [{ Name: "Problems", Values: [3, 5, 8, 13, 2, 0],
                  Colors: ["#e45959", "#e97659", "#ffa059", "#ffc859", "#7499ff", "#97aab3"] }];
```

`Colors` per value, read by a pie and a doughnut for their slices and by a bar
chart of one series for its bars, and by the legend in either case.

## Why the existing words do not cover it

`Series[].Color` is one colour for a whole series, and a pie reads one series
and paints each slice with `this.colour({ Color: "" }, i)` -- the palette by
index, with nothing for the caller to say. The legend reads the same function,
so even drawing the slices by hand would leave the legend disagreeing.

## Prior art

Chart.js takes `backgroundColor` as an array, one per data point; matplotlib's
`pie(colors=[...])`; Excel colours each point of a series on its own.

## How much it mattered

Small, and it is the one place a report's colours contradict each other: the
table says red for *Disaster* and the chart beside it says blue.
