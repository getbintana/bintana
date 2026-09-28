# Slider

The same four words a [`SpinBox`](SpinBox.md) uses, asked with the mouse.

A volume, a zoom, an opacity, a position in a clip: a number the user chooses by
feel, where the exact digits matter less than where it sits between two ends.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Decimals` | how many places the number it draws has — it does not change what `Value` holds | [the number](#the-number) |
| `Inverted` | put the high end where the low one was | [how it is drawn](#how-it-is-drawn) |
| `Max` | the ceiling | [the range](#the-range) |
| `Min` | the floor | [the range](#the-range) |
| `Orientation` | `Horizontal` or `Vertical` | [how it is drawn](#how-it-is-drawn) |
| `ShowValue` | draw the number beside the rail — worth it when the number means something to the user, and noise when it does not | [how it is drawn](#how-it-is-drawn) |
| `Step` | what an arrow key moves | [the range](#the-range) |
| `Value` | where it sits | [the number](#the-number) |
| `ValuePosition` | which side that number sits on | [how it is drawn](#how-it-is-drawn) |
| `ClearMarks()` | takes them all off | [marks](#marks) |
| `Mark(value, [text])` | a tick at that value, with an optional label under it | [marks](#marks) |
| **event** `Change()` | the value changed — dragged, keyed, or **assigned from code** | [the number](#the-number) |

## The number

| | |
|---|---|
| `Value` | where it sits |
| `Decimals` | how many places the number it draws has — it does not change what `Value` holds |
| **event** `Change()` | the value changed — dragged, keyed, or **assigned from code**. It fires **while dragging**, once per step, which is what makes a live preview possible and what makes an expensive handler feel heavy |

**A handler that costs something wants a guard.** Redrawing a chart on every step
of a drag is fine; re-reading a file is not. The cheap shape is to do the light
work in `Change` and the heavy work once, from a `Timer.After` that the handler
restarts.

## The range

| | |
|---|---|
| `Min` | the floor. **Declare it before `Value`**, as in a `SpinBox` |
| `Max` | the ceiling. Default `100`, which is what a percentage wants |
| `Step` | what an arrow key moves; Page moves ten of them. Default `1` |

## How it is drawn

| | |
|---|---|
| `Orientation` | `Horizontal` or `Vertical`. A vertical slider reads bottom to top. Default `"Horizontal"` |
| `ShowValue` | draw the number beside the rail — worth it when the number means something to the user, and noise when it does not |
| `ValuePosition` | which side that number sits on: `Top` `Bottom` `Left` `Right`. Default `"Top"` |
| `Inverted` | put the high end where the low one was |

## Marks

| | |
|---|---|
| `Mark(value, [text])` | a tick at that value, with an optional label under it |
| `ClearMarks()` | takes them all off |

Marks are what turn a rail into a scale: the default in the middle, the 1× on a
zoom, the ends of the useful range. A label on every mark makes a crowded rail;
two or three is the usual number.

## What goes wrong

- **The value came out clamped.** `Min`/`Max` were applied after `Value`.
- **The handler ran a hundred times during one drag.** `Change` fires per step;
  see [the number](#the-number).
- **The number beside it has too many places.** `Decimals`.
- **It reads backwards.** `Inverted`, or a vertical one where a horizontal was
  meant.

## What it does not do

- **No range selection**, no second handle: one value.
- **No formatting.** The number it draws is the number; a unit goes in a
  [`Label`](Label.md).

## See also

[`SpinBox`](SpinBox.md) · [`LevelBar`](LevelBar.md) ·
[`ProgressBar`](ProgressBar.md)
