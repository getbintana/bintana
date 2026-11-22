# UPSTREAM: GTK 4.14 crashes opening an address when there is no session bus

## What the application needed

`Desktop.OpenUri("https://...")` from a program running where there is no D-Bus
session bus: a CI runner, a container, a session started without one, a
machine where `dbus-launch` is not installed. The request should go to the
program the desktop associates with the scheme, or fail with a line in the log
-- never take the program down.

## What I wrote instead

`desktop_open_uri` in `bta_desktop.c` asks `g_bus_get_sync` for the session bus
first (Unix only: on Windows GTK never uses a portal for this). With no bus
there is no portal to go through, so the address goes to
`g_app_info_launch_default_for_uri_async` directly, with the display's launch
context -- which is what a GTK that does not crash does in that case. With a
bus, `GtkUriLauncher` as before, so a sandbox still goes through the portal.

It works, but it is a second road: the GIO branch is the one the suite
round-trips (its child has no bus, so no portal on the shared session bus can
draw on the person's own display), and the `GtkUriLauncher` branch is not
round-tripped at all.

## The code I wish I could have written

```c
gtk_uri_launcher_launch(launcher, parent, NULL, on_uri_launched, g_strdup(uri));
// and nothing else: no bus is GTK's business.
```

## Why the existing words do not cover it

Nothing in the runtime is missing. GTK 4.14.5's `gtk_uri_launcher_launch`
calls `gtk_show_uri_full`, which warns

    Cannot connect to session bus when initializing OpenURI portal

and then dereferences what that failed to make: SIGSEGV inside `libgtk-4`, under
`gtk_show_uri_full`. `GDK_DEBUG=no-portals` does not keep it off that road.
Measured in an `ubuntu:24.04` container with the CI `no-libxml` job's packages
(GTK 4.14.5, GLib 2.80.0) under gdb, with `DBUS_SESSION_BUS_ADDRESS` at a
socket that is not there and with it unset (no `dbus-launch`): both crash. GTK
4.22.5 on Fedora 44, in the same situation, warns and falls back to GIO by
itself.

## Prior art

Upstream GTK: not reported from here. The version that stopped crashing is
somewhere between 4.14.5 and 4.22.5 and was not bisected. `GtkLinkButton`
opens its `Uri` through the same launcher, so clicking one in that situation is
likely the same crash; that was not measured.

## How much it mattered

A crash, on the LTS distribution CI runs and many users have, in a situation a
desktop session rarely is in and a container or a CI runner usually is. The
workaround keeps it a request that works; the file stays until the GTK floor
(4.10 today) passes the fixed version.
