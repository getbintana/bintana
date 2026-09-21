# ISSUE: a drop target hears nothing until the drop, so a drag has no feedback

## What the application needed

A kanban board where a card is dropped *between* two others. Placing it is
done and needed nothing new — `Drop(data, x, y)` carries the point in the
target's own coordinates and `Bounds(target)` answers in the same space, so
the row a drop is over is a comparison. What is missing is everything before
that: while the card is travelling, the column it is over should say so, and a
line should sit where the card would land.

## What I wrote instead

Nothing, because there is nothing to write. The card is placed exactly where
it is dropped and the user finds that out **after letting go**: no column
lights up, no gap opens, no line is drawn. A gesture whose result is only
visible once it is over has to be learned by trial, and on a column with more
cards than fit on screen there is no way to aim at all.

Measured with a two-control probe — a `Button` with `DragData`, a `Panel` with
`AcceptDrop` and handlers for `MouseMove`, `MouseEnter` and `MouseLeave` — a
full drag across the target and a drop on it delivered:

```
during the drag the target heard: {"Drop":1}
and the drop itself arrived at 130,120
```

So not one event before the drop, and the mouse events are not a way round it:
the pointer belongs to the drag, so ordinary motion does not arrive either.

## The code I wish I could have written

The same point `Drop` already carries, delivered while the pointer is over the
target, plus a way to know the drag has gone:

```js
list.On("DragOver", (data, x, y) => {
    const before = this.landingBefore(v, y, Number(data));
    this.showLine(v, before);          /* a 2px panel between two cards */
});
list.On("DragLeave", () => this.hideLine(v));
```

And, on the side that is dragged, something that says *this one is travelling*
so the card can be greyed while it is in the air and put back if the drop is
refused.

## Why the existing words do not cover it

`Drop` is the whole of what a target hears, and it arrives once, at the end.
`AcceptDrop` and `AcceptFiles` turn the target on and off; `DragData` says what
travels and turns dragging on. There is no event for the drag entering, moving
over or leaving a target, and none on the source for the drag beginning or
ending — so a program cannot know a drag is happening at all until it lands.
`MouseMove`/`MouseEnter`/`MouseLeave` look like the way out and are not: the
measurement above is what they answer during a drag, which is nothing.

## Prior art

HTML's `dragenter`/`dragover`/`dragleave`, where the position comes off the
event and the insertion line is what every board on the web draws with it;
WinForms `DragEnter`/`DragOver`/`DragLeave` with `DragEventArgs.X/Y`; Qt's
`dragMoveEvent`; Delphi's `OnDragOver`, which is asked *whether* it accepts on
every move; and GTK4's own drop target, which reports the pointer while it is
over a widget — this runtime already stands on it and passes on only the drop.

## How much it mattered

It works, and a part of it is noticeably worse: the placement is exact and
invisible until the button comes up. [`examples/kanban`](../../examples/kanban)
ships that way and says so in its header — the board that motivated it is also
the one that cannot show what it is about to do.
