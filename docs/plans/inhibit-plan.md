# Keeping the machine awake, on every desktop

**Not started; a plan to discuss.** Asked for by the owner on 2026-10-28, with
the condition that it be argued across desktops the way
[keyring-plan.md](keyring-plan.md) argues a store: *what the application
needed* is one verb, and *who answers it* is different on every platform.

## What the application needed

A backup, an export, a long download, a presentation: **while it runs, the
machine must not suspend**, and sometimes the screen must not blank or the
session must not log out under it. Nothing in the runtime can say that today,
and a program that does not say it is a backup that stops at 40% when the lid
timer fires.

## What GTK does, read in its source (main, 2026-10-28)

`gtk_application_inhibit(app, window, flags, reason)` with four flags
(`LOGOUT`, `SWITCH`, `SUSPEND`, `IDLE`), answering a cookie or `0`:

| backend | what it does | flags honoured |
|---|---|---|
| base (no impl) | nothing, answers `0` | none |
| Linux, D-Bus impl | `org.freedesktop.portal.Inhibit` **only**, and only when `gdk_display_should_use_portal()` says so and the portal has an owner; otherwise `0` | whatever the portal backend honours |
| Windows (`gtkapplication-win32.c`, 2025-26) | `PowerCreateRequest` + `PowerSetRequest`: `SystemRequired` for `SUSPEND`, `DisplayRequired` for `IDLE`; `LOGOUT` through the window's surface | `SUSPEND`, `IDLE`, `LOGOUT` (application windows only); not `SWITCH` |
| macOS (`gtkapplication-quartz.c`) | counts `LOGOUT` and cancels `applicationShouldTerminate` while it is held; **no power assertion** | `LOGOUT` only — `SUSPEND` and `IDLE` are stored and do nothing, and it answers a cookie anyway |

Three things follow, and they are the reason this is a plan:

1. **The answer depends on the GTK version, not only on the platform.** The
   floor is 4.10 ([AGENTS.md](../../AGENTS.md)); the Windows implementation is
   from 2025-26, so a Windows build against an older GTK answers `0` to
   everything. The Linux path also changed: older GTK 4 called
   `org.gnome.SessionManager.Inhibit` and fell back to the portal; main uses the
   portal alone. **Stage 0 measures what 4.10, 4.14 (CI) and 4.22 (this
   machine) actually do**, outside a sandbox and inside Flatpak.
2. **macOS answers a cookie for a suspend it does not prevent.** A caller that
   trusts the cookie believes the backup is protected. That is the silent wrong
   answer the audit ranks *High*.
3. **On Linux the portal backend decides, and backends differ.** The GTK
   portal backend forwards to `org.gnome.SessionManager` and
   `org.freedesktop.ScreenSaver`; on Sway neither exists and the Inhibit
   portal does nothing (Arch's `sway` packaging issue #2). KDE's portal backend
   implements Inhibit through its own power management. XFCE has
   `xfce4-power-manager` behind `org.freedesktop.PowerManagement.Inhibit`.

## The other roads, per platform

| platform | road | covers | note |
|---|---|---|---|
| Linux, any desktop | **systemd-logind** `org.freedesktop.login1.Manager.Inhibit("sleep:idle", who, why, "block")` | suspend, idle, shutdown | answers a file descriptor; the inhibitor lives while it is open. Works with no session manager and no portal. Missing on non-systemd systems; blocked sleep may need polkit on some distributions |
| Linux, any desktop | `org.freedesktop.ScreenSaver.Inhibit` | screen blanking (idle) | KDE, XFCE, GNOME all own it |
| Linux, Wayland | `zwp_idle_inhibit_manager_v1` | idle, per surface | needs a visible surface; GTK does not expose it |
| Linux, Flatpak | the Inhibit portal | per backend | the only road inside the sandbox; logind is not reachable |
| Windows | `PowerCreateRequest`/`PowerSetRequest` | suspend, display | what GTK main uses; shows up in `powercfg /requests` with the reason. `SetThreadExecutionState` is the older call and has to be repeated |
| Windows | `ShutdownBlockReasonCreate` + `WM_QUERYENDSESSION` | logout/shutdown | needs a window |
| macOS | `IOPMAssertionCreateWithName` (`PreventUserIdleSystemSleep`, `PreventUserIdleDisplaySleep`) | suspend, display | what `caffeinate` uses; not in GTK |

## What other runtimes offer

- **Electron**: `powerSaveBlocker.start("prevent-app-suspension" |
  "prevent-display-sleep")` answers an id, `stop(id)`, `isStarted(id)`. Two
  intents, not four flags, and nothing about logout.
- **The web**: the Screen Wake Lock API, `navigator.wakeLock.request("screen")`
  — the display only, released when the page is hidden.
- **Python**: nothing in the standard library; `wakepy` is the cross-platform
  answer, with two modes (`keep.running`, `keep.presenting`) and a list of
  methods tried per platform (logind, GNOME, freedesktop, Windows
  `SetThreadExecutionState`, macOS `caffeinate`) — and it says which one took.
- **Qt**: nothing in Qt itself; KDE's Solid has `PowerManagement`
  (`beginSuppressingSleep`). **.NET** and **Java**: nothing; P/Invoke or JNI.
- **Flutter**: `wakelock_plus`, the display only.

The pattern: **two intents** (keep running / keep the screen on) rather than
GTK's four flags, an **id to release**, and the honest ones say **whether and
how** it took.

## A shape to argue about

**Where: `System.Inhibit`**, the owner's choice of 2026-10-28 — `System` is
the machine and the session as they are now, and requests to them (see
[network-plan.md](network-plan.md#the-shape-as-the-owner-chose-it-2026-10-28)),
not `Application`, which is facts about the program.

```js
const awake = System.Inhibit("Backing up 3 GB", { Display: false });
// awake.Active   -- whether anything on this machine agreed
// awake.By       -- "Portal", "Logind", "PowerRequest", "IOKit", ""
// ...
awake.Release();
```

- **An object, not a cookie.** `Release()` cannot be called with somebody
  else's number, and `Active`/`By` say what the platform agreed to — the
  `Keyring.Provider` lesson: what a careful caller decides with is *who*.
- **Two intents.** Suspend is always asked; `Display: true` adds idle/screen.
  `LOGOUT` and `SWITCH` are left out until an application asks: GTK honours
  them unevenly, and *don't let the user log out* is a different question
  (it is a form's `Form_Close` veto, which exists).
- **`Active: false` is an answer, never a throw.** A backup that cannot keep the
  machine awake still runs; it may want to say so.
- Released on exit, as every platform does anyway.

## Decisions for the owner

1. **GTK first, or our own roads first?** GTK alone is one call and wrong on
   macOS and old GTK; our own is logind + ScreenSaver on Linux (portal inside
   Flatpak), `PowerSetRequest` on Windows, IOKit on macOS — the same per-platform
   C that `Keyring` already plans.
2. **The two intents**, or GTK's four flags.
3. **An object or a cookie.**
4. ~~Where~~: decided, `System.Inhibit`.

## Stage 0, before any code

Measure `gtk_application_inhibit` with `SUSPEND` and with `IDLE` on this
machine (GTK 4.22, the user's desktop, said out loud first since it touches
the real session), under the CI image (4.14), inside the Flatpak runtime, and
read the answer back with `systemd-inhibit --list` and
`gnome-session-inhibit --list`. The table above is source code; this is what
it does.
