# Spinner

Work with no end in sight, which is most work.

The turning circle that says *something is happening*. It says nothing about how
much is left, which is the honest thing to say about a request that has been
sent, a folder that is being read, a child process that is running.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Active` | whether it spins | [spinning](#spinning) |

## Spinning

| | |
|---|---|
| `Active` | whether it spins. A spinner that is not spinning is invisible in most themes, so this is the whole of turning it on and off |

```js
BtnFetch_Click() { this.Spin.Active = true;  Http.Get(url, (answer) => this.done(answer)); }
done(answer)     { this.Spin.Active = false; this.show(answer); }
```

**Turn it off in every path, including the failing one.** A spinner left turning
after an error is a program that looks like it is still trying.

**Over the thing that is loading, not beside it**, is usually the right place: an
[`Overlay`](Overlay.md) with the spinner as its second layer, which is what
[`examples/notify`](../../../examples/notify) shows.

## When it is not a `Spinner`

- **The end is known** — [`ProgressBar`](ProgressBar.md), which says how much is
  left. Use it whenever you can: *87%* is worth far more than a circle.
- **It is a reading rather than work** — [`LevelBar`](LevelBar.md).

## What goes wrong

- **It never stops.** A path that returns without turning it off — an error, a
  cancel, an empty answer.
- **Nothing is visible.** `Active` is off, or the spinner has no size in the
  layout it is in.

## What it does not do

- **No text.** A [`Label`](Label.md) beside it says what is happening.
- **No percentage.** [`ProgressBar`](ProgressBar.md).

## See also

[`ProgressBar`](ProgressBar.md) · [`Overlay`](Overlay.md) ·
[`examples/notify`](../../../examples/notify)
