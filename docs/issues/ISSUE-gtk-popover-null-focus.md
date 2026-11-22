# ISSUE: GTK's popover focus passes a NULL focus widget to `gtk_widget_is_ancestor`

## What the application needed

A window with a popover -- a menu, a `Popover`, any autohide one -- that loses
the keyboard focus while the popover is visible must not print a `Gtk-CRITICAL`.
The suite met it once per `tests/widgets` run on CI's GTK 4.14, and a program
run with `G_DEBUG=fatal-criticals` is aborted by it.

## What I wrote instead

Nothing in the runtime: the call is GTK's own focus vfunc, and every frame
between the warning and the event that caused it is GTK's.

## The code I wish I could have written

```c
GtkWidget *p = gtk_root_get_focus (gtk_widget_get_root (widget));
if (p && !gtk_widget_is_ancestor (p, widget) && p != widget)
  return TRUE;
```

`gtk_widget_is_ancestor` is `g_return_val_if_fail (GTK_IS_WIDGET (widget),
FALSE)`, so a NULL focus is a critical; the expression beside it (`p != widget`)
already treats NULL as "not inside the popover", which is the answer GTK means.

## Why the existing words do not cover it

`gtk_popover_focus` (`gtk/gtkpopover.c`, 4.14.5 line 1073 and 4.22.5 line
1126 -- **the code is the same in both**):

```c
if (gtk_popover_get_autohide (GTK_POPOVER (widget)))
  {
    GtkWidget *p = gtk_root_get_focus (gtk_widget_get_root (widget));
    if (!gtk_widget_is_ancestor (p, widget) && p != widget)
      return TRUE;
```

when the window has no focus widget at that moment. Reproduced in an
`ubuntu:24.04` container (GTK 4.14.2, then 4.14.5, no `xdotool`, which is CI's
shape) once per `tests/widgets` run, both times inside the `Exec` chain; on the
runner's own log the same line appears at 11:42:19.474. gdb with the
distribution's debug symbols:

    #1 g_return_if_fail_warning   "gtk_widget_is_ancestor" "GTK_IS_WIDGET (widget)"
    #2 gtk_widget_is_ancestor     widget=0x0, ancestor=0x55d6aefce020
    #3 gtk_popover_focus          gtkpopover.c:1056
    #4 gtk_widget_focus_move
    #5 gtk_window_focus
    #6 maybe_unset_focus_and_default   gtkwindow.c:4741
    #7 after_paint                     gtkwindow.c:4765
    #8 g_closure_invoke ... g_signal_emit (the frame clock's after-paint)

So the path is: a window loses its focus and default widget on an after-paint
(`maybe_unset_focus_and_default`), focus traversal enters a visible autohide
popover, nothing in it takes the focus, and GTK asks whether the root's focus --
which is now NULL -- is inside it. `widget=0x0` is the whole bug.

## Prior art

Upstream GTK: not reported from here. The same two lines are in 4.22.5 as well,
so it is not a 4.14-only defect; our own 4.22 runs simply do not reach the state
(a popover with focusable children, focus traversal failing, and the root's
focus unset in the same after-paint).

**No workaround that is ours to make.** The call is inside the popover's focus
vfunc; not using autohide popovers would change every program's menus and
combo boxes to silence one warning whose answer GTK already computes correctly.

## How much it mattered

One line of noise per window focus change in that state, once per
`tests/widgets` run on 4.14; an abort under `G_DEBUG=fatal-criticals`. The
popover behaves as GTK intends (the expression returns TRUE, "the focus is not
inside me"), so nothing is wrong on screen and no test fails because of it. The
file stays until the GTK floor passes a version with the NULL check.
