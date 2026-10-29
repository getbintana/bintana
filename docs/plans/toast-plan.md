# A message over the window that asks nothing

**Not started; a plan to discuss.** A first version was written as
`lib/dialog/Toast.js` over `Popover` and taken out before landing, because the
question below -- *where does the message live* -- deserves to be decided
before code, not inside it.

## What the applications needed

Five copies of the same thing in the tree, which is the ticket
[`notes/library-promotion.md`](../notes/library-promotion.md) asks for:

- `examples/notify` builds one out of an `Overlay` declared in its `.form`: a
  base layer, a spinner layer and a toast layer, shown and hidden by hand with
  its own `hider` timer.
- `examples/contacts`, `kanban`, `gpx` and `vector` write a sentence into a
  status label and put the old text back with `Timer.After(3000, …)`. All four
  share one bug: a second message within three seconds is taken away early by
  the first one's timer.

What they want: `"Saved"`, `"Copied 555-0134"`, `"Card deleted -- Undo"`. A
message that takes no focus, blocks nothing, takes no room, goes by itself, and
sometimes carries one action.

## The question: where does it live

### A. A `Popover` anchored to the form (what was written)

`Popover.Show(content, form, { Rect, Position: "Top", Arrow: false,
Autohide: false })`, with the rect at the bottom middle of the window.

- **For:** nothing new in C; no form declares anything; works on any form,
  library dialogs included.
- **Against:**
  - A popover is **a surface of its own** (an `xdg_popup` on Wayland). The point
    is taken once (`Popover.Show`'s own doc), so **resizing the window leaves the
    toast where it opened** -- it does not follow the bottom edge.
  - `Autohide: false` popovers are still popups to the compositor: their
    stacking against other popovers (a menu, a combo's list) and against a
    modal dialog opened over the window has not been measured.
  - A popover draws the theme's popover frame and shadow, not
    `.app-notification`'s look; styling it as a toast fights the theme.
  - It cannot be seen in the designer and cannot be tested for layout with
    `Bounds()` the way a control can.

### B. An overlay in every window (the runtime's)

`build_form` puts a `GtkOverlay` between the window and the surface, and the
toast is a child of that overlay: `Form.Toast(text, …)` or a library over a
published hook.

- **For:** it is GTK's own answer (`AdwToastOverlay` is exactly this); the toast
  follows the window's edge on resize, wears `.app-notification`, stacks under
  menus and dialogs the way content does, and `Bounds()` measures it.
- **Against:**
  - **Every form pays for it**, used or not: one more widget per window, and the
    window's child is no longer the surface. `docs/agents/layout.md` and the
    `DragToMove` comment in `bta_controls.c` both lean on *the window's child is
    the surface and nothing in between*; the menu bar, the designer's input
    layer and `Arrangement` all know that shape. Each would have to be read
    again.
  - The designer draws forms that are not windows; what the overlay is there has
    to be decided.
  - A new primitive in C for something a Bintana form can almost express is the
    thing the project's rule asks to justify.

### C. Lazily: the overlay inserted the first time a toast is shown

The runtime re-parents the surface into an overlay on first use. Nothing paid by
forms that never toast, but a live re-parent of the surface under a running form
is the riskiest of the three (focus, allocation, `Allocated`/`Resize` events,
the anchors' drawn size).

### D. Declared: the form says it has one

`Overlay` exists already. A component `ToastHost` (or a property on `Overlay`)
that a form drops where it wants messages, and `Toast.Show(this, …)` finds it.
`examples/notify` is this, minus the bookkeeping.

- **For:** no C, no cost for forms that do not use it, visible in the designer.
- **Against:** a form has to be arranged around an `Overlay` to toast at all,
  which is the step the four status-label examples did not take; and a library
  dialog has no host.

## What has to be decided

1. A or B (C and D are variants). The honest comparison is measurement: a
   popover toast on a window resized while it shows, and over an open menu and
   a modal, on Wayland and X11.
2. Whether `Form` grows a member (`Form.Toast`) or it stays a library verb
   (`Toast.Show(form, …)`). A member is discoverable in completion; a library
   keeps the runtime's surface where it is.
3. The behaviour already settled by the copies and kept whichever way it goes:
   one per window, the newest replaces words and timer, 3 s (6 s for an error,
   0 = until closed), the action runs on its button and on nothing else, a click
   elsewhere does not dismiss it.

## What would make it done

The five copies replaced by one call each, `examples/notify` kept as the
`Overlay` example it also is, and a test that shows one, replaces it, presses
its action and lets one expire.
