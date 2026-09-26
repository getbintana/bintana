# ISSUE: a `Popover` cannot be seen or picked on the design canvas

## What the application needed

A field with a list of suggestions under it -- the shape `controls.md` teaches
for `Popover`: a `TextBox`, and beside it in the same `Panel` a `Popover`
holding a `RowList`. Drawn in the IDE, with the palette's `Popover` button, and
then filled: the list dropped into it, its size set, its `Position` chosen.

## What I wrote instead

Dropped the popover on the canvas, where it vanished. Found it again in the
control tree, selected it there, and set its properties in the grid blind.
The list inside it could not be dropped at all -- there was no rectangle on the
board to drop onto -- so the `RowList` went in by editing the `.form` by hand.

## The code I wish I could have written

None: this is the designer, and the `.form` that comes out is already right.
What was missing is being able to *see* the popover while drawing it -- click
it, drop a control into it, drag its content -- the way every other container
on the palette can be.

## Why the existing words do not cover it

A popover contributes no measure on purpose (`widgets.md`, *Popover*): the box
holding it asks for the anchor's size whether it is open or closed, which is
what makes it safe in a `.form` at all. And it is not open while the form is
being drawn: `Visible` is read-only on a `Popover` and `Show()` refuses, because
opening one before its window exists crashes GTK. So on the board it is a
control with no rectangle:

- the selection chrome waits for the first rectangle (`Allocated`), which a
  closed popover never gets, so nothing is drawn around it;
- `PickAt` under the pointer finds its container, never it;
- a drop aimed at it lands in the container beside it.

The control tree reaches it, which is the only road there is -- and a road
that cannot take a child dropped onto it.

## Prior art

Qt Designer shows a `QMenu` open under its menu bar while it is being edited,
and a `QDockWidget` as a floating frame. Glade lists a `GtkPopover` as a
toplevel of its own in the project and draws it in its own area of the
workspace. Delphi's non-visual components (`TPopupMenu`, `TImageList`) are an
icon on the form at design time and nothing at runtime. Android's layout editor
previews a `PopupWindow`'s layout as its own file.

## How much it mattered

Medium. Nothing is lost -- the file is right and the application runs -- but
the one container whose content is its whole point is the one whose content
cannot be drawn, and the first thing a newcomer does with the palette button
(drop it, then drop something into it) does not work.
