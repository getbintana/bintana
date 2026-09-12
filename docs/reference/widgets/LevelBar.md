# LevelBar

A reading, not a progress.

A battery, a signal, a disk that is getting full, a score: something that is
*at* a level rather than something that is *getting* somewhere. The difference
matters to a reader — a progress bar that goes down is alarming, a level that
goes down is Tuesday.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Max` | the top. Default `1` | [the scale](#the-scale) |
| `Min` | the bottom of the scale | [the scale](#the-scale) |
| `Mode` | `Continuous` `Discrete` — a bar, or blocks. Default `"Continuous"` | [how it is drawn](#how-it-is-drawn) |
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` | [how it is drawn](#how-it-is-drawn) |
| `Value` | the reading | [the scale](#the-scale) |

## The scale

| | |
|---|---|
| `Value` | where the reading sits |
| `Min` | the bottom of the scale |
| `Max` | the top. **Default `1`**, which is GTK's own convention for this control: a fraction, where `0.75` is three quarters. Give it `100` if a percentage reads better in your arithmetic |

## How it is drawn

| | |
|---|---|
| `Mode` | `Continuous` is a bar that fills; `Discrete` is blocks — five bars of signal, four blocks of battery — which is what to use when the underlying reading has steps |
| `Orientation` | `Horizontal` or `Vertical` |

The theme may colour a level bar by how full it is; that is the theme's business
and not a property here.

## When it is not a `LevelBar`

- **Something is being done and will finish** — [`ProgressBar`](ProgressBar.md).
- **The user sets it** — [`Slider`](Slider.md).
- **The number is what matters** — a [`Label`](Label.md), which is often the
  better control and always the cheaper one.

## What goes wrong

- **It is full at 1.** `Max` is `1` by default.
- **It looks like progress.** It is a level; if the thing really is progress, use
  the other control, because the reader tells them apart by shape.

## What it does not do

- **No text, no marks, no thresholds of your own.**

## See also

[`ProgressBar`](ProgressBar.md) · [`Slider`](Slider.md) · [`Label`](Label.md)
