# ISSUE: on Windows, a window maximized by the system title bar shrinks when a menu opens

## What the application needed

To maximize the window with the system title bar -- the one the runtime asks
for on Windows (`GTK_CSD=0`) -- and then open any menu, and have the window
stay the size the desktop gave it. It is every application and the IDE, and it
is the first thing a reader does: maximize, open **File**, and the window is
no longer full screen even though Windows still draws it as maximized.

## What I wrote instead

`bta_controls.c`'s `form_sync_maximized` writes the state back through
`gtk_window_maximize`/`unmaximize` from `notify::maximized`. That call is what
updates the `GdkToplevelLayout` GDK consults when a restyle asks for a layout.
A key on the window remembers which bit that layout carries, so a program's own
`Maximized` (`form_set_state`) does not present the window a second time; full
screen clears the key because it owns the layout.

The restore has to be synced too, or the layout keeps saying maximized and the
next menu grows the restored window to the work area. And GDK's present issues
`SW_RESTORE` unconditionally, which throws a window Win+Left has just snapped
back to its pre-maximize rectangle; the runtime reads the window's rectangle
before the call and puts it back afterwards.

It works, but it is a workaround: a maximize or restore from the title bar
goes through an extra present, a snapped restore is moved twice, and the
runtime has to keep its copy of the state in step with the desktop's by hand.

## The code I wish I could have written

```js
// None. The window would keep the size the desktop gave it.
```

## Why the existing words do not cover it

Nothing in the runtime is missing. GTK 4.24.1's Win32
`compute_toplevel_size()` chooses the maximized branch from
`impl->toplevel_layout`, and that layout is only set by a
`gdk_toplevel_present()` -- which a native maximize never reaches. GTK keeps
saying *restored* while the window is maximized.

Opening a menu marks its item `SELECTED` in `GtkPopoverMenuBar`, the restyle
asks GDK for a layout, and `compute_toplevel_size()` is called with no desired
size: it lays the window out at its natural size. Measured on Windows 11 with
GTK 4.24.1: the window went from `1936x1001` to `1585x759` while `IsZoomed`
stayed true.

## Prior art

Upstream GTK: not reported yet. The fix is one condition in
`compute_toplevel_size()`: take the maximized branch when
`surface->state & GDK_TOPLEVEL_STATE_MAXIMIZED`, not only when the stored layout
says so. That would keep a native maximize at the monitor's size without the
runtime's re-assertion. A second one would make the workaround's restore
harmless on its own: `gdk_win32_surface_unmaximize` calls
`ShowWindow(SW_RESTORE)` without asking whether the window is maximized.

## How much it mattered

It works, but a part of it is visibly worse: any menu after maximizing shrinks
the window, in every application on Windows, and the IDE is the first one a
reader sees. The runtime workaround keeps it correct until GTK is fixed.
