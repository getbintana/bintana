# Screen

How big the desktop is, and how many pieces it is in.

```js
Screen.Width                    // the monitor the window is on, in pixels
Screen.Monitors()               // [{ X, Y, Width, Height, Scale, Name }, …]
```

## Every member

| | | |
|---|---|---|
| `Height` (ro) | the monitor's height | [the monitor in front of you](#the-monitor-in-front-of-you) |
| `Monitors()` (ro) | → every monitor | [all of them](#all-of-them) |
| `Scale` (ro) | that monitor's scale factor | [the monitor in front of you](#the-monitor-in-front-of-you) |
| `Width` (ro) | the monitor's width | [the monitor in front of you](#the-monitor-in-front-of-you) |

## The monitor in front of you

| | |
|---|---|
| `Width` (ro) | the width of the monitor the application's **active window** is on — the first one the display lists before any window is shown, and `0` with no display at all |
| `Height` (ro) | its height, likewise |
| `Scale` (ro) | that monitor's scale factor, `1` unless the panel is HiDPI |

**The numbers are the same pixels a form's `Width` is** — logical ones, with the
scale answered separately — so `Screen.Width / 2` is a window width and not a
surprise on a HiDPI panel.

## All of them

| | |
|---|---|
| `Monitors()` (ro) | every monitor: `X`/`Y` are where it sits in the desktop's coordinates, `Width`/`Height`/`Scale` are its own, and `Name` is the connector — `"HDMI-1"`, `"eDP-1"` — **a key to remember a choice by, not prose to show** |

## What this is not for

**Not for placing a window.** On Wayland the compositor places windows and there
is nothing to ask for; [`Form.Center()`](../widgets/Form.md) is a no-op there for
the same reason. What this answers is *how much room is there* — a default window
size, whether a sidebar is worth opening, how big a preview can be.

**There is no primary monitor and no work area**: GTK4 stopped answering both,
and a number this could only guess at is worse than one it does not offer.

## What goes wrong

- **A window was positioned and did not move.** The compositor decides.
- **Everything was half size on a HiDPI screen.** The numbers here are logical
  pixels already; `Scale` is separate on purpose.
- **`Width` was 0.** No display — a console project.

## See also

[`Form`](../widgets/Form.md) · [`Settings`](Settings.md), for remembering the
size the user chose
