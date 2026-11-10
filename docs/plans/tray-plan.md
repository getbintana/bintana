# Tray: a status icon on three native backends

**Status: planned, not started (2026-11-10).** This is the systray half of
**R3** of [the October audit](../audit-2026-10.md), and the piece the PZEM
monitor needs: a program that can be put away and still be one click from its
window. It is deliberately **not** built on `Ipc.DBus`; see
[why](#why-not-ipcdbus).

A tray icon is not a control and not a `FormPart`. It outlives the window, it
belongs to the application, and every platform gives it a different native
object. The API is one; the implementations are three.

## What the application needed

A monitoring tool reads a PZEM-016 over a serial port, shows the values in a
window and keeps polling when the window is not in front. Closing the window
must leave the program running, and the icon must say how to bring it back,
start or stop the polling and quit. On Windows the same tool must sit beside the
clock in the notification area; on macOS in the menu bar; on Linux in whatever
the desktop uses for status notifiers.

The generic part is the menu and the click. The platform part is everything
else: registering the icon, drawing the native menu, and surviving an Explorer
restart.

## What already exists

- `Notification` sends through the application and already knows the platform
  split: freedesktop/portal on Linux, Cocoa on macOS, `Shell_NotifyIcon` on
  Windows (where actions are unsupported).
- `Application` owns the `GtkApplication`, its id, and `Quit`.
- `Form.Hide`/`Show` and `Application.Quit` are what a tray action calls.
- GTK4 has **no** tray API. `GtkStatusIcon` is GTK3 and gone; `libayatana-
  appindicator` is GTK3 and would put a second toolkit in a GTK4 process.
- `Ipc.DBus`, as planned in [transports-plan.md](transports-plan.md), is a
  **client**: `Call` and `OnSignal`. The tray is a D-Bus **server** plus two
  native backends.

## Why not `Ipc.DBus`

The tray and `Ipc.DBus` use D-Bus, but in opposite directions:

| the tray needs | `Ipc.DBus` as planned |
|---|---|
| register a bus name | no |
| export `/StatusNotifierItem` | no |
| answer `Activate`, `ContextMenu` | no |
| implement `com.canonical.dbusmenu` | no |
| expose properties and emit signals | listens to signals |
| call `RegisterStatusNotifierItem` | `Call`, yes |

Making `Ipc.DBus` a server framework -- objects, interfaces, properties,
introspection, method dispatch and signals -- is larger than the tray and has no
application caller yet. The three backends are native C/Cocoa code; using GDBus
inside the Linux one is an implementation detail, not a public JavaScript API.

`Ipc.DBus` stays in the transports plan, waiting for a caller that **calls** a
service. The tray is not that caller.

## The API

One tray per application. A second `new Tray()` is refused rather than
silently replacing the first.

```js
const tray = new Tray({
    Icon: "org.example.Monitor-symbolic",
    Tooltip: Locale.Text("Monitor PZEM"),
});

tray.Menu = [
    { Text: Locale.Text("Abrir"), Action: "show" },
    { Text: Locale.Text("Sondeo"), Action: "poll", Checked: true },
    { Separator: true },
    { Text: Locale.Text("Salir"), Action: "quit" },
];

tray.OnClick = () => this.Show();
tray.OnMenu  = (action) => {
    if (action === "show") this.Show();
    if (action === "poll") this.TogglePolling();
    if (action === "quit") Application.Quit();
};

tray.Show();
```

### Members

| | |
|---|---|
| `Tray.Available` (static, ro) | whether this platform can show a tray icon *now*: Linux needs a `StatusNotifierWatcher`; Windows and macOS answer `true` when built |
| `Tray.CanMenu` (static, ro) | whether the platform can show the menu; `false` is a documented limitation |
| `Tray(Icon, Tooltip, Menu)` | the constructor; `Available` is checked by `Show`, not by the constructor, so a program can create it and decide later |
| `Icon` | a theme name or a file path. Linux: theme name, or a path through `IconThemePath`; Windows: `.ico` (or the executable's icon when empty); macOS: an image path, or a template image |
| `Tooltip` | text shown by the platform's hover |
| `Menu` | an array of items, rebuilt on assignment |
| `Visible` (ro) | whether the icon is shown |
| `Show()` / `Hide()` | add or remove the icon; answers the tray |
| `OnClick` | assign `() => …`: the primary click. On macOS with a `Menu`, the click opens the menu and this is not called |
| `OnMenu` | assign `(action) => …`: a menu item was chosen; `action` is the item's `Action` |

A menu item is data, not a control:

```js
{ Text: "…", Action: "key", Enabled: true, Checked: false,
  Separator: false, Items: [ … ] }
```

- `Text` is prose; wrap it in `Locale.Text`. `Action` is a short key, not
  translated.
- `Separator: true` ignores the other fields.
- `Items` makes a submenu.
- `Checked` draws a check; the platform does not own the state. The handler
  changes the application's state and assigns `tray.Menu` again.
- The runtime validates the tree before touching the platform: an unknown
  field, a missing `Text`/`Action`, a duplicate `Action`, or a separator with
  children is refused with a sentence. The menu is built completely before the
  old one is replaced.

The menu is **data and actions**, never callbacks: a tray menu can be kept by
the desktop for the life of the icon, and a JavaScript function must not be held
by something that outlives its window. This is the `Notification.OnActivate`
rule again.

## The three backends

### Linux: `StatusNotifierItem` and `dbusmenu`

There is no GTK4 tray and no portal for one. The desktop-native road is the
freedesktop `org.kde.StatusNotifierItem` spec:

- own a bus name `org.kde.StatusNotifierItem-<pid>-<n>`;
- export `/StatusNotifierItem` with `Category`, `Id`, `Title`, `Status`,
  `IconName`/`IconPixmap`, `IconThemePath`, `ToolTip`, `ItemIsMenu` and `Menu`;
- answer `Activate`, `SecondaryActivate`, `ContextMenu` and `Scroll`;
- emit `NewIcon`, `NewToolTip`, `NewTitle`, `NewStatus`;
- call `org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem` on the session
  bus.

The menu is a second exported object, `/MenuBar`, with
`com.canonical.dbusmenu`. The subset the tray uses is small but not trivial:
`GetLayout`, `GetGroupProperties`, `GetProperty`, `Event`, `AboutToShow`,
`AboutToShowGroup`, plus `LayoutUpdated` and `ItemsPropertiesUpdated`. The
layout is the recursive `(ia{sv}av)` tree; the item properties are `label`,
`enabled`, `visible`, `type` (`standard`/`separator`), `children-display`
(`submenu`), `toggle-type` (`check`/`radio`), `toggle-state`, `icon-name` and
`shortcut`.

**No new dependency.** GDBus is already GLib. `libayatana-appindicator` is
rejected (GTK3); `libdbusmenu-glib` is rejected for now (another dependency for
the subset above). If the dbusmenu protocol grows beyond this subset, the plan
reopens that decision with a measurement.

**`Available`** is true only when `org.kde.StatusNotifierWatcher` is on the
session bus. It is false on GNOME without the AppIndicator extension, and the
program falls back to its window. KDE, XFCE with its status-notifier plugin,
Cinnamon and MATE answer. Flatpak needs
`--talk-name=org.kde.StatusNotifierWatcher`; `lib/package` can add it only for a
project that names a tray, or the application passes `FinishArgs`.

### Windows: `Shell_NotifyIcon`

- A hidden window and a message-only loop, on the thread that owns it; the
  GTK/GLib loop must still run. The window proc handles the tray message,
  `WM_COMMAND` and `TaskbarCreated`.
- `NOTIFYICONDATA` with `NIF_MESSAGE | NIF_ICON | NIF_TIP`, `NIM_ADD`,
  `NIM_SETVERSION` (`NOTIFYICON_VERSION_4`), and `NIM_DELETE`.
- Left click/double click and `NIN_SELECT`/`NIN_KEYSELECT` for `OnClick`; right
  click for the menu.
- `CreatePopupMenu` + `AppendMenuW` (`MF_STRING`, `MF_CHECKED`, `MF_GRAYED`,
  `MF_SEPARATOR`, `MF_POPUP`) and `TrackPopupMenu` with
  `TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY`. `SetForegroundWindow`
  before it and `PostMessage(WM_NULL)` after it are the two lines Windows
  requires.
- `TaskbarCreated` re-adds the icon after an Explorer restart; `NIM_DELETE` at
  teardown.
- Icon: a `.ico` path (the packaging already writes one); empty means the
  executable's icon, then `IDI_APPLICATION`. A PNG may be converted, but `.ico`
  is the documented road.
- No new library: `shell32`.
- **The tray and `GNotification` both use `Shell_NotifyIcon`.** GLib's
  notification backend creates its own icon; a visible tray plus a notification
  can leave two icons. This is a known follow-up: either notifications go
  through the tray's icon or the duplication is documented.

### macOS: `NSStatusBar`

- `NSStatusBar.system.statusItemWithLength(NSVariableStatusItemLength)`.
- `NSStatusItem.button.image` from a file or a named image, `template` for a
  monochrome image; `toolTip`; `visible`.
- `NSMenu` + `NSMenuItem` (`state` for a check, `enabled`, submenu,
  `separatorItem`), with `target`/`action` to an Objective-C delegate that calls
  the common C dispatcher.
- With a menu, a click opens it; without one, the button's action raises
  `OnClick`.
- The item must be created and changed on the main thread. No extra framework
  beyond Cocoa.
- The macOS plan is still not started; this backend is written blind, compiled
  by the macOS job when it exists, and tested by an external tester.

## The common part

One `Tray` JavaScript class, one validated menu tree, one dispatcher:

```
bta_tray.c        the JS class, menu validation, OnClick/OnMenu, lifecycle
bta_tray_linux.c  GDBus + StatusNotifierItem + dbusmenu
bta_tray_win32.c  Shell_NotifyIcon + HMENU
bta_tray_cocoa.m  NSStatusItem + NSMenu
bta_tray.h        the small platform interface the three implement
```

The platform interface is the same for all three:

```
available()                 can an icon be shown now?
can_menu()                  can the menu be shown?
create(tray)                register the icon
destroy(tray)               remove it
set_icon(tray, text)        a theme name or a path
set_tooltip(tray, text)
set_menu(tray, menu)        a validated C tree
show(tray) / hide(tray)
```

`bta_tray.c` owns the `JSValue`s and calls the platform only on the main
thread. Windows marshals a tray message from its message loop to the main loop;
macOS is already on the main thread; Linux is GDBus callbacks on the main
context.

## The lifecycle

- `new Tray` checks `Tray.Available` only when `Show` is called: a program can
  construct it before the window exists.
- `Show` registers the icon and menu; `Hide` removes the icon but keeps the
  object, so `Show` again is cheap.
- `Application.Quit`/`bta_tray_cleanup` destroys the icon, the D-Bus
  registration and the native window; no `JSValue` survives the context.
- A click or a menu action while a form is being destroyed is dispatched on the
  main loop with the wrapper held, the same `JS_DupValue` rule as a socket.

## How it will be tested

- **Linux, headless:** a private session bus; `Tray.Available` is `false` with
  no `StatusNotifierWatcher`, and `Show` says so. A mock watcher and a
  `dbus-monitor` observe `RegisterStatusNotifierItem`; a mock host calls
  `Activate` and reads `GetLayout`. The real icon and menu are a by-hand check
  on XFCE, KDE and GNOME-with-extension.
- **Windows:** the `windows` CI job compiles it; a real desktop checks the
  icon, the menu, DPI, an Explorer restart and a notification beside it.
- **macOS:** compile when the macOS job exists; the external tester checks the
  menu bar, a template icon and a click.

The suite's tests only assert what is synchronous: capability flags, menu
validation, the second `new Tray` refusal, and the no-watcher sentence. An icon
on the developer's desktop is never opened by `tests/widgets`.

## Stages

0. **This plan.** **Done.**
1. **The common API and menu model**, with a stub backend whose `Available` is
   `false`; the JS class, validation, `api.json`, docs, and the tests that do
   not need a desktop. **Not started.**
2. **Windows**, because `Shell_NotifyIcon` is the most deterministic backend and
   the CI can at least compile it. **Not started.**
3. **Linux**, the SNI object and the dbusmenu subset; the one testable on this
   machine. **Not started.**
4. **macOS**, blind, with the external tester. **Not started.**
5. **The docs, `CHANGELOG`, audit R3 and the by-hand checks.** **Not started.**

## What is deliberately not here

- **Multiple tray icons per application.** One per app; a second `new Tray` is a
  sentence.
- **Notifications via the tray.** `Notification` is its own object; the Windows
  icon duplication is noted above and decided separately.
- **A tray in a `Task`.** No main loop, no icon.
- **Global hotkeys, a tray on GNOME without the extension, a portal for a
  tray.** The first is GTK4's absence; the second and third are the desktop's.
- **Animated icons, progress bars in the icon, scroll events as a value.** The
  spec has some; no caller yet.
- **`Ipc.DBus`.** A client is not a server; the tray uses GDBus directly.

## What was rejected, and why

- **Building `Ipc.DBus` first.** It would be a generic D-Bus server framework,
  larger than the tray and without a caller; the tray is three native backends
  and would be delayed for an API nobody uses yet.
- **`libayatana-appindicator`.** It is GTK3; a GTK4 runtime would carry two
  toolkits and two themes.
- **`libdbusmenu-glib`.** It is the right library if the dbusmenu subset grows;
  for the small tree a tray needs, a local implementation keeps the runtime
  dependency-free. The plan states the trigger to reopen this.
- **`GtkStatusIcon`.** GTK3, and gone from GTK4.
- **A `FormPart`.** A tray belongs to the application; a form that closes would
  take it away.
- **A callback per menu item.** The desktop can keep the menu past the window;
  actions are strings and `OnMenu` is looked up when one arrives.
