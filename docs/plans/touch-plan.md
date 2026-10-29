# Touch: what a finger can do in a Bintana window

**Not started, measured, with the first stage argued for.** Written on
2026-10-29 after the same touches were played at plain GTK and at the runtime on
two platforms (Linux with a virtual touch screen, a Windows 11 guest with
injected touch). The decision is *a few high-level gestures, opt-in per widget,
and the platform's limit stated in the docs* -- not a general touch API.

## What is wanted

An application on a tablet or a touch laptop should be usable with a finger,
and today it is, but only as a mouse: a tap is a click and nothing else. The
three things a person expects and cannot do:

- **open a context menu** -- `PopupMenu` opens on the secondary button only, and
  a finger has none; a menu that is the only road to a command is out of reach;
- **scroll, flick and drag a surface** with kinetic feel -- `MouseWheel` is the
  one road and a finger drag is a mouse drag;
- **pinch, rotate and two-finger pan** on a map, a chart, a drawing: nothing
  here sees a second finger. `examples/gpx` is the one program that wanted it
  (it listens to `MouseWheel` to zoom).

## What was measured

`tests/manual/touch/` holds the instruments; none of this was guessed.

- **GTK on Linux (X11, GTK 4.22) delivers everything.** A virtual touch screen
  (`touchsim.c`, uinput) played at `gtkprobe.c` -- plain GTK, every gesture
  grouped on one area -- arrived as native `TOUCH_BEGIN`/`TOUCH_END`:

  | gesture | GTK |
  |---|---|
  | tap | delivered |
  | long press | delivered, 500 ms after the press (`GtkGestureLongPress`'s default) |
  | swipe | delivered, with velocity (`vx=2265` for 300 px in 120 ms) |
  | one-finger drag | delivered |
  | pinch | delivered, **exact** (`scale=3.500` for 40 -> 140 px) |
  | rotate | delivered, but see below |
  | two-finger drag | **not** delivered inside the group |

- **Two traps in GTK's own numbers.** `GtkGestureRotate`'s angle started near
  **90 deg** (60 asked, 150 read), and in a two-finger pan with parallel fingers
  the first sample was `angle=90 scale=0.95`: the baseline is taken before the
  second finger's position is known. **A consumer must use the change between
  two updates, not the absolute value.** And a `GtkGestureDrag` with two points
  begins and ends in the same instant when it shares a group with zoom and
  rotate, which claim the sequence -- so a two-finger *pan* cannot be its own
  gesture beside them; it has to be read from the same stream (below).
- **The runtime sees none of it.** The same touches, through the TouchProbe
  project (`area` listening to `MouseDown/Up/Move`): a tap is `down=1 up=1`; a
  long press is `down=1 up=1 button3=0` -- no secondary button, though GTK had
  already recognised it; a one-finger swipe is 19 `move`s; a pinch and a pan are
  `down=1`, 44 `move`s and **`up=0`**.
- **That last row is a bug of its own, with or without gestures.** When the
  second finger arrives GTK cancels the first's click (`cancel`, by design) and
  `MouseUp` never comes: a program that drags something with the mouse is left
  holding it.
- **GTK on Windows 11 (the Win32 backend) delivers a mouse.** In a QEMU guest
  with injected touch (`inject.ps1`): a tap is a click, a long press is a held
  button (no `button=3`: Windows makes the right click from `WM_CONTEXTMENU`,
  which GTK does not translate), a one-finger drag in a scrolling widget is
  `wheel dy=+-1` in bursts (Windows' own panning) and pinch and two-finger pan
  produced **no event at all**. **Not yet checked on a real tablet**, whose
  controller may differ from the injector's; that check gates stage 3.

So the hole is in the runtime on Linux, and in the toolkit on Windows. What can
be built portably is what GTK builds from a held pointer -- the long press, and
a one-finger swipe from the drag -- both of which `GtkGestureLongPress` and
`GtkGestureSwipe` take from pointer events, not only from touches.

## What others do (from memory, not re-verified)

Qt (`grabGesture`, Pointer Handlers), Flutter (one `onScale` for pan, zoom and
rotate; a null callback means the gesture is not recognised), Android and iOS
(recognisers attached per view), the web's Pointer Events, WPF's Manipulation
and Delphi's `TGestureManager`. Three lessons, all of them what the measurement
above asks for: **few gestures of a high level**, **recognised only where
someone listens**, and **pan, zoom and rotate as one stream**, because they are
one gesture of two fingers read three ways.

## Design

Events, named like the others (`Widget_Event`, or `On`), raised only on a widget
that has a handler -- the controller is attached when a handler exists, the way
`attach_mouse` is not free today (five controllers on every widget).

| event | arguments | from |
|---|---|---|
| `LongPress` | `x, y` | `GtkGestureLongPress` |
| `Swipe` | `vx, vy` (px/s) | `GtkGestureSwipe` |
| `Transform` | `phase, dx, dy, scale, angle, x, y` | zoom + rotate + drag of two points, **grouped, one handler** |

- **`Transform`'s `phase` is `"Begin"`, `"Update"`, `"End"`**, and the numbers
  are **deltas since `Begin`**, with the angle taken **from the second update**
  so the 90 deg baseline never reaches a program. `x, y` is the centre between
  the fingers. A program that only wants a pan reads `dx, dy`; one that wants a
  map reads all three.
- **Platform honesty.** On a platform whose toolkit delivers no second finger
  the event is never raised; `Screen.Touch` says whether a touch screen is
  there, and the docs say per event what each backend delivers. A pinch handler
  must keep its wheel road (`gpx` does).
- **The context menu.** A long press from a touch or a pen (not a mouse, which
  has its button) opens the control's `PopupMenu` at the point. No new property:
  a program that has a menu gets it with a finger.
- **Pen** (`GtkGestureStylus`, pressure, the eraser end) is a separate surface
  and not in this plan.

## Stages

Each is shippable alone.

1. **`MouseCancel(x, y)` -- built, and verified with two fingers (`cancel=1`; a second finger ends the click gesture with `end`, not `cancel`, so the runtime listens to both).** `attach_mouse` connects only `pressed` and
   `released`; GTK's `GtkGestureClick` handles one point at a time and **by
   design** cancels its sequence when a second arrives (or a parent claims it),
   emitting `cancel` and no `released` -- documented, and no report of it as a
   bug was found on gitlab.gnome.org. The runtime connects `cancel` and raises
   `MouseCancel` with the last point. **A new event and not a `MouseUp`**: a
   program that confirms a drag in `MouseUp` (drops a card, closes a stroke,
   applies a crop) would confirm what was abandoned. It does not touch the
   ordinary road (a button's `Click` never sees it), so nothing that works today
   changes; a program that drags adopts it, and the ones here that do
   (`vector`, `gpx`; not `kanban`, which drags with `DragData`) are updated in the same change. A `tests/widgets`
   assertion `Emit`s the path; the two-finger round trip is the manual run.
   Argued for on its own: **it is wrong today for any touch screen**.
2. **`LongPress` and the touch context menu -- built.** `LongPress(x, y)` is
   raised for **any** pointer (a program that listens asked for it) from a
   `GtkGestureLongPress` every widget carries; the **menu** opens only when the
   press began as a touch or with a pen's tool, claims the sequence (so the click
   that would follow is cancelled: `MouseCancel`), and walks outward to the
   nearest `PopupMenu` as the secondary button does. `Screen.Touch` says whether
   the seat has a touch device. Tested with a real mouse (a held press raises it
   once, a click and a drag raise none, nothing is cancelled); the half a mouse
   cannot reach is `tests/manual/touch/run.sh`, whose probe now carries a menu
   and logs `longpress` and `cancel`. **Unverified on Windows**: the guest
   delivered the finger as a mouse, so the event arrives there but the menu does
   not open from it, and nothing in the toolkit says the press was a touch;
   a real tablet is the measurement. The cost is one more controller per widget
   (six), which is what the plan's *opt-in by handler* would have saved --
   not worth a per-widget switch until a measurement of the IDE says so.
3. **`Transform` and `Swipe` -- built, and verified with a touchpad (Linux, X11); the touchscreen half awaits its first run.**
   awaits its first run.** `Gestures = true` on a control attaches a grouped
   zoom and rotate (the centre between the fingers gives the pan, read from the
   gesture's `update` so a pan with constant distance still raises it) and a
   swipe. `Transform(phase, dx, dy, scale, angle, x, y)` is deltas since `Begin`,
   the baseline taken from the **first update** and the angle unwrapped, because
   GTK's own start values are wrong (about 90 deg, 0.95); it claims the two
   fingers. A property and not a controller on every widget: three more would
   be nine. `Swipe` is tested with a real mouse flick; `Transform` cannot be
   played on an `Xvfb`, so its round trip is `tests/manual/touch/run.sh`, whose
   probe has `Gestures` on and prints the Begin/End and the last update of a
   pinch (expect scale 3.5), a rotate (60 deg) and a pan (dx 200). **Windows
   stays as measured**: one finger as a mouse, so `Transform` is never raised
   there until a real tablet says otherwise. **`examples/gpx` is its first
   consumer**: the centre drags the map, the distance zooms it by whole levels
   (the tiles exist at whole levels; twice as far is one) about that centre, the
   wheel is kept, and `Area_MouseCancel` lets go of a mouse drag when a second
   finger arrives. Driven with `Emit` in a scratch copy (levels, pan sign and
   magnitude, `End` ending it); the real pinch is for a person with a touchpad.
   **A touchpad measured it** (FTCS0038 on Xorg 21.1, libinput 1.31, GTK 4.22): a
   pinch raises `Begin`, about 15 `Update`s and `End`, the scale running from 1 to
   2.04 and back to 0.57, a rotation reaching 45 deg with the scale near 1, and
   `dx`/`dy` following the fingers' drift. A touchpad does not move the pointer,
   so `x`/`y` start at it and drift with the fingers: the pivot to zoom about, which
   **`Swipe` carries the finger count** (`Swipe(vx, vy, fingers)`): `1`, `3` or
   `4`. A touchpad's three- and four-finger swipe is the same event, its velocity
   made from the last 100 ms of the pad's deltas, which carry none; a touchscreen's
   three or four fingers are a `GtkGestureSwipe` per count. **Two fingers are not
   one**: two fingers moving are `Transform`'s pan and cannot be both. **A
   long press with several fingers is not built**: the touchpad on X11 has no hold
   gesture (XI 2.4 does not define one -- measured, three fingers held still
   raise nothing; Wayland's does, from GTK 4.6, unmeasured), and two fingers on
   glass would compete with `Transform`, which claims them at the first update.
4. **Documentation**, in the same change as each stage: the description beside
   each event in C, `api.json`, `bintana-docs`, and a paragraph in
   `docs/testing.md` on what is manual.

GTK floor: `GtkGestureLongPress`, `Swipe`, `Zoom`, `Rotate`, `Drag` (with
`n-points`) and `GdkSeat`'s capabilities are all 4.0; nothing here needs more
than the 4.10 floor, but each is to be re-read in the headers when it is
written, since the rule is the oldest library and not this machine's.

## How it is tested

- **Automatic**: the declaration (a widget accepts `LongPress`/`Swipe`/
  `Transform` as events, `PropertyOptions`-style), `Emit` through `On`, and the
  cancel path of stage 1. That is all `Xvfb` can prove: it has no touch.
- **Round trip**: `tests/manual/touch/run.sh` on a person's X11 session, with a
  virtual touch screen (`sudo` only for `/dev/uinput`); extended to assert on
  the runtime's events once they exist. The Windows half is `inject.ps1` in a
  guest, and a real tablet for the check that gates stage 3.
- **Put the bug back**: stage 1's test must go red with the cancel removed.

## Rejected

- **A raw touch API** (every contact, id, pressure). A program would have to
  reassemble the gestures GTK already recognises, and would on Windows get
  nothing. Reopen if a caller needs a signature or a multi-user surface.
- **Gestures on every widget, automatically.** Five controllers per widget are
  already the cost of `attach_mouse`; a gesture claims the sequence from the
  click and makes a button's tap ambiguous. Opt-in by handler.
- **Emulating a second finger** (ctrl-wheel as pinch) in the runtime. A program
  with a wheel road already has it; faking contacts hides the platform's limit.
- **Waiting for Windows**: the long press and the context menu are portable and
  need nothing from the Win32 backend.

## What would change this

- If a real Windows tablet delivers multi-touch to GTK, stage 3 stops being a
  platform footnote.
- If stage 1 cannot be told from the toolkit that the click was cancelled, the
  fix moves to a flag on the sequence and the stage grows.
- If a caller needs the pen, `GtkGestureStylus` gets its own plan.
