# ProgressBar

Work with an end in sight.

Use it whenever the end **is** in sight: files copied of files to copy, bytes
downloaded of bytes expected, rows written of rows. *87%* is worth far more to
somebody waiting than a turning circle, and the circle is what to fall back to
when the number cannot be known.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` | [how it is drawn](#how-it-is-drawn) |
| `ShowText` | draw `Text` inside the bar | [how it is drawn](#how-it-is-drawn) |
| `Text` | what it reads, if `ShowText`. **Translated** | [how it is drawn](#how-it-is-drawn) |
| `Value` | `0` to `100` | [the reading](#the-reading) |
| `Pulse()` | one step of the indeterminate animation | [when the end is not known](#when-the-end-is-not-known) |

## The reading

| | |
|---|---|
| `Value` | `0` to `100`, **clamped rather than refused**: a number outside it lands on the nearest end instead of throwing, because a progress that is 103% is an arithmetic slip and not a reason to stop the work |

```js
onCopied(done, total) { this.Bar.Value = 100 * done / total; }
```

## How it is drawn

| | |
|---|---|
| `ShowText` | draw `Text` inside the bar |
| `Text` | what it reads. **Translated** — and `Fill` is how the numbers stay out of the catalogue: declare `"{0} of {1} files"` and fill it |
| `Orientation` | `Horizontal` or `Vertical` |

## When the end is not known

| | |
|---|---|
| `Pulse()` | one step of the indeterminate animation — the block that slides back and forth |

**A [`Spinner`](Spinner.md) says it better.** `Pulse` exists because GTK has it,
and it needs a timer of your own to look like anything; a spinner says *working*
with no arithmetic and no animation to drive. Reach for `Pulse` only where the
bar must stay in place because it will become determinate in a moment.

## What goes wrong

- **The bar is full and the work is not done.** `Value` is a percentage, not a
  count.
- **It never moves.** The work is on the main loop and nothing is being
  repainted: the shape that works here is a callback per step —
  [`Exec`](../../llm/library.md#exec) streaming, `Http` answering, a
  `Timer` — and not a loop that computes for four seconds.
- **The text is not shown.** `ShowText`.

## What it does not do

- **No estimate, no remaining time.** Those are your arithmetic, in `Text`.
- **No cancel.** A [`Button`](Button.md) beside it.

## See also

[`Spinner`](Spinner.md) · [`LevelBar`](LevelBar.md) ·
[`examples/usage`](../../../examples/usage)
