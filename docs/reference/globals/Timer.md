# Timer

Doing something later, or repeatedly.

```js
Timer.After(250, () => this.LblStatus.Text = "");     // once
const clock = Timer.Every(1000, () => this.tick());   // repeat
clock.Stop();
```

**This is scheduling here**: `setTimeout` and `setInterval` are not part of the
language, and a timer that can be stopped by name is why.

## Every member

| | | |
|---|---|---|
| `Timer.After(delay, tick)` | once, after that many milliseconds | [the two shapes](#the-two-shapes) |
| `Timer.Every(delay, tick)` | again and again | [the two shapes](#the-two-shapes) |
| `new Timer(delay, tick)` | one that is not started yet | [the object](#the-object) |
| `Delay` | the milliseconds | [the object](#the-object) |
| `Enabled` | whether it is running | [the object](#the-object) |
| `Once([delay])` | fire once more | [the object](#the-object) |
| `Start([delay])` | start it | [the object](#the-object) |
| `Stop()` | stop it | [the object](#the-object) |
| `Tick` | the function it calls | [the object](#the-object) |

## The two shapes

Both hand the `Timer` back, so **what was started can be stopped** — which is the
whole reason they are objects and not numbers.

`Timer.After(0, …)` is the one worth knowing by heart: it lets GTK have a frame
before anything measures. Nothing has a size until the window has been laid out,
so a measurement in `Form_Open` measures nothing, and this is where it belongs.

## The object

| | |
|---|---|
| `new Timer(delay, tick)` | made, not started — for one a form owns and starts later |
| `Delay`, `Tick` | the milliseconds and the function, both settable while it runs |
| `Enabled` | whether it is running; assigning starts or stops it |
| `Start([delay])`, `Stop()` | the verbs |
| `Once([delay])` | fire one more time and stop |

## What a tick is for

**A tick decides *when* to repaint; what is painted comes from the data.** A
clock that adds 100 per 100 ms tick falls behind and never catches up — the
elapsed time comes from a [`Stopwatch`](Stopwatch.md), and the timer only says
when to look at it. The same rule makes a video's position bar right: poll
`Position`, do not count ticks.

A timer that restarts on every keystroke is the other everyday shape — a search
that runs when typing stops, a preview that redraws when a slider settles.

## What goes wrong

- **It kept firing after the window closed.** Nothing stops a timer for you: keep
  it and `Stop()` it in `Form_Close`.
- **The clock drifted.** Ticks were counted instead of a clock being read.
- **A measurement in `Form_Open` answered zero.** `Timer.After(0, …)`.
- **Nothing ever happened.** The arguments were the wrong way round —
  `Timer.After(fn, 300)` — which is refused now, as is a delay that is not a
  number: both used to be taken, and ran nothing, or ran on every turn of the
  loop.
- **Two timers for one thing.** `Start()` on a running timer restarts it, which
  is usually what a debounce wants.

## See also

[`Stopwatch`](Stopwatch.md) · [`Exec`](Exec.md) ·
[`Form`](../widgets/Form.md)
