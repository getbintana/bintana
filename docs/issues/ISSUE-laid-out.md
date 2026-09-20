# ISSUE: nothing says *I have been laid out*

## What the application needed

To do something with a control's real rectangle as soon as there is one:
centre a window on the monitor it opened on, fit an image to the box it landed
in, measure whether a translated label still fits its panel.

## What I wrote instead

A bounded retry on a timer, five times:

```js
fit(tries = 25) {
    const box = this.Pic.Bounds();
    if (box.Width < 2) { if (tries > 0) Timer.After(20, () => this.fit(tries - 1)); return; }
    /* ... the actual work ... */
}
```

`Ide.Chrome.position(tries)` (`Chrome.js:154`), `ImageForm.fit(tries = 25)`
(`:95`), `examples/viewer/Viewer.js:142` -- which is that method copied -- and
`whenLaidOut(then, tries)` in both `examples/i18n/Anchors.js:43` and
`Layouts.js:53`. Each bounded, each asking again, each having picked its own
number of tries and its own interval.

## The code I wish I could have written

```js
this.Pic.WhenLaidOut(() => this.fitTo(this.Pic.Bounds()));
// or an event, which is the same fact said the other way:
Pic_Allocated(box) { this.fitTo(box); }
```

## Why the existing words do not cover it

`Bounds()` answers zero until GTK has allocated, and `Form_Open` runs **before**
the window is presented, so the one moment an application is given is
reliably too early. `Timer.After(0)` is documented as *let GTK draw a frame*,
which is one frame and not *the* frame -- a window that has not been mapped yet
needs more than one, and how many is the machine's business rather than the
program's, which is why every one of those five sites has a retry count in it.

The suite has `until(cond)` and `settled(ide)`, and they are deliberately **not**
the answer: `plans/async-plan.md` argues that a harness is allowed machinery a
front page is not, and a generator that yields frames is exactly that machinery.

GTK knows the moment exactly -- it is the `size-allocate` it has already
emitted, and the runtime is already listening to it for other reasons.

## Prior art

.NET raises `Layout` and `Resize`, and `Shown` fires after the form is visible
rather than before. Delphi has `OnResize` and a `HandleAllocated` to ask.
GTK itself has `size-allocate` and `map`. Nothing else asks an application to
poll for its own geometry.

## How much it mattered

Five copies, none of them hard, all of them wrong in the same small way: a
bounded retry either gives up too early on a slow machine or waits longer than
it needs to on a fast one, and it is the shape `AGENTS.md` already warns about
under *a frame is not a promise*. Two of those five are in `examples/`, which
means it is the first thing somebody writing a real application meets.
