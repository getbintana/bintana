# Stopwatch

How long something took.

**The one question a `Date` cannot answer**: a wall clock is a setting, and NTP
stepping it mid-measurement makes the answer wrong or negative.

```js
const w = new Stopwatch().Start();
doTheWork();
print(`${w.Elapsed} ms`);
```

## Every member

| | | |
|---|---|---|
| `new Stopwatch()` | one, not started | [the watch](#the-watch) |
| `Elapsed` | milliseconds, with the fraction, running or not | [the watch](#the-watch) |
| `Reset()` | back to zero | [the watch](#the-watch) |
| `Running` | whether it is going | [the watch](#the-watch) |
| `Start()` | start it | [the watch](#the-watch) |
| `Stop()` | stop it | [the watch](#the-watch) |

## The watch

| | |
|---|---|
| `Elapsed` | milliseconds, **with the fraction**, running or not |
| `Running` | whether it is going |
| `Start()`, `Stop()`, `Reset()` | the three verbs. **All of them answer the watch**, so `new Stopwatch().Start()` is one line |

## A tick is not a measurement

**A tick decides when to repaint; what is painted comes from `Elapsed`.** Adding
100 per 100 ms [`Timer`](Timer.md) tick falls behind and never catches up — a
timer fires when the main loop gets to it, which is *at least* the delay and
often more. Every clock, every progress estimate and every *elapsed* label in
this tree reads a stopwatch on each tick rather than counting the ticks.

## What goes wrong

- **A duration came out negative.** Two `Date`s were subtracted across an NTP
  step.
- **A clock drifted a second a minute.** Ticks counted.
- **`Elapsed` was zero.** It was never `Start()`ed — the constructor does not,
  which is why the one-liner chains.

## See also

[`Timer`](Timer.md) · [`Time`](Time.md) ·
[`examples/stopwatch`](../../../examples/stopwatch)
