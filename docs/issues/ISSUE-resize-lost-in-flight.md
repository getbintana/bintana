# ISSUE: a form's `Resize` is lost when an earlier size change is still in flight

## What the application needed

To size a form that is already on screen and have the window take that size:
`win.Resize(648, 160)` right after `Show()`, or two `Resize` calls a frame
apart, or a `Resize` while the form is still growing to fit what it holds.

## What I wrote instead

Nothing: the call returns, and the window stays at whatever size the earlier
change settled on. `tests/widgets`' `testAnchorsPushed` met it. Its form is
pushed wider by a long caption, which the runtime lays out in two passes: the
first at 558 wide, and a second, once the design size is latched, at 574. On
CI's runners, and in their image on two CPUs (GTK 4.14.5, 4 runs in 26), the
test read the first pass, asked for `Resize(558 + 90)`, and the window stayed
at 574 for the 1.5 s it was watched; the 648 never arrived. The test now waits
for the second pass (a steady width and the pusher's far margin) before it
resizes, which keeps it out of the window where the call is lost. A program has
no such signal.

## The code I wish I could have written

```js
win.Show();
win.Resize(648, 160);       // and the window is 648 wide, whatever was pending
```

## Why the existing words do not cover it

On Linux a shown form's `Resize` is `gtk_window_set_default_size`
(`bta_widget_relayout`), which GTK honours on the next layout. But GTK also
writes the window's *actual* size back into the default size on every configure
the display server sends (`surface_size_changed`, `gtkwindow.c:4700` in
4.14.5), so a user's resize is remembered. A configure that answers an earlier
request -- here the second pass's 574 -- and lands after the `Resize` overwrites
the 648 with 574, and the next layout computes 574 from it. GTK has no
`gtk_window_resize` in GTK 4 to ask again with. Windows takes another road
(`win32_resize_shown`, `SetWindowPos`) and was not measured.

## Prior art

GTK 3's `gtk_window_resize` was the request this needs, and GTK 4 removed it on
purpose. A fix in the runtime would keep the program's last requested size
beside the window and ask for it again when a configure overwrites the default
before the window has reached it -- bounded, so it never fights a person
resizing by hand.

## How much it mattered

A narrow window -- milliseconds between a size change and its configure -- but a
silent one: the program asked for a size and got another, with nothing to read.
Found as a test that failed about one run in seven on a busy machine.
