# UPSTREAM: GTK 4.22.5 warns twice when a scrolled window that is animating is unmapped

## What the application needed

An application whose text view scrolls itself -- the IDE's log pane appends a
line per `print` and follows its tail, which GTK implements as an *animated*
scroll -- must be able to switch a notebook page or hide that view without GTK
printing criticals, and with `G_DEBUG=fatal-criticals` without GTK aborting the
program.

## What I wrote instead

Nothing in the runtime: both criticals are emitted inside GTK's own code, with
no frame of ours between the emission and the function that gets it wrong. The
IDE's page switch (`Notebook.Current`, and a tab click the same way) is only the
occasion.

## The code I wish I could have written

Nothing -- the sequence is `gtk_adjustment_enable_animation`'s and
`gdk_frame_clock_end_updating`'s. A `GtkAdjustment` should survive a
`value-changed` handler that sets its value back while an animation is running,
because that is exactly what `GtkTextView`'s own handler does.

## Why the existing words do not cover it

`gtk_scrolled_window_unmap` (4.22.5) finishes an animation by setting the
adjustment to its target, *after* the widget is already unmapped, and that
emission reaches `gtk_text_view_value_changed`; its own comment says validation
"could invoke this function recursively, by scrolling to maintain first_para".
The animation ends from inside `gtk_adjustment_enable_animation`, which then
does

```c
adjustment_set_value (adjustment, priv->target);
g_signal_handler_disconnect (priv->clock, priv->tick_id);   /* tick_id is 0 now */
priv->tick_id = 0;
gdk_frame_clock_end_updating (priv->clock);                 /* already ended */
```

and GTK prints, once per IDE run each, 12-30 s apart:

    GLib-GObject-CRITICAL: g_signal_handler_disconnect: assertion 'handler_id > 0' failed
    Gdk-CRITICAL: gdk_frame_clock_idle_end_updating: assertion 'priv->updating_count > 0' failed

gdb on `g_log`, in `tests/ide` on Fedora 44 (GTK 4.22.5, GLib 2.86):

    #0 g_log
    #1 gtk_adjustment_enable_animation
    #2 gtk_scrolled_window_unmap
    #3 gtk_widget_unmap
    #4 gtk_widget_set_child_visible
    #5 gtk_stack_progress_updated
    #6 gtk_notebook_real_switch_page
    ...
    #15 notebook_set_current            (bta_notebook.c, the runtime's setter)

    #0 g_log
    #1 gtk_css_node_validate_internal
    #2 gtk_css_node_validate
    #3 g_closure_invoke / signal_emit
    #4 gdk_frame_clock_paint_idle
    #5 g_timeout_dispatch
    #6 g_main_context_dispatch / iterate
    #7 g_application_run

That the re-entrant change is GTK's and not a program's was measured: with
`on_scroller_moved` instrumented, the emission in the first stack arrived with
the scrolled window already unmapped, the runtime's handler returned without
running JavaScript, and `bta_scroll_set` was never called; yet `tick_id` was 0
by the time `enable_animation` looked. The second stack has no Bintana frame at
all -- it is the frame's CSS validation, and the unbalanced clock is the state
the first one left (the animation's update was ended twice).

**The workaround that looks obvious does not work.** A handler on the scrolled
window's `unmap` that sets each adjustment to the value it already has ends an
animation in GTK and emits nothing -- but `unmap` is `G_SIGNAL_RUN_FIRST`
(`gtkwidget.c:1763`), so the class handler (`gtk_scrolled_window_unmap`) has
already run before any handler of ours. Measured: two criticals in the run with
it. The other road, not asking GTK to animate at all, means computing the target
and setting the adjustment ourselves in `Append`/`GotoLine`/`Select` -- losing
smooth scrolling for every application, and the layout may still clamp the value
back on the frame the text grows -- for two warnings that change no behaviour.

Upstream GTK's `gtk_adjustment_enable_animation` now clears the id with
`g_clear_signal_handler (&priv->tick_id, priv->clock)`, which is silent at 0, so
the `handler_id > 0` half is gone after 4.22.5; the `gdk_frame_clock_end_updating`
call beside it is unchanged, so the unbalanced update is not, as far as this
reading of `main` goes.

## Prior art

Upstream GTK: not reported from here. `GtkTextView` animating a programme's
scroll (`gtk_text_view_scroll_to_mark`, which the runtime uses in `Append`,
`GotoLine` and `Select`) is enough; a plain GTK application with a text view in
a notebook should do the same.

## How much it mattered

Two lines of noise per IDE run, and an abort for anybody who runs the suite with
`G_DEBUG=fatal-criticals` -- which is why the suite does not. No wrong behaviour
was measured: `tests/ide` passes 3888 assertions with them, and the scroll
positions are right. The file stays until the GTK floor (4.10 today) passes a
version that ends the update once.
