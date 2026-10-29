# Whether there is a network, and what kind

**Not started; stage 0 measured, the API to discuss.** Asked for by the owner
on 2026-10-28 with the condition that the shape be compared with what other
languages offer before anything is built, and that **discovering captive
portals** be treated as part of it. The first caller is the owner's
`eneverre-btn` (a viewer for RTSP cameras): each tile retries with
exponential backoff and says *No signal (Unreachable)* without knowing whether
the camera or the network is gone, and nothing tells it the network came back.

## What the application needed

A program that syncs, sends or downloads wants three answers, and they are
different questions:

1. **Is there a network at all?** — grey out *Sync now*, say *offline* in the
   status bar, queue instead of failing.
2. **Does it reach the internet, or only the room?** — a Wi-Fi with no uplink,
   or a hotel's sign-in page, answers 1 with *yes* and every request with a
   failure (or with somebody else's HTML).
3. **Is it metered?** — a phone's hotspot: do not upload 3 GB of backups now.

And a fourth that is not a question but an event: **it changed** — the network
came back, so retry what was queued.

Nothing in the runtime answers any of them. What exists is the failure after
the fact: an `Http` error's `kind` is `Unreachable` (see `HttpClient`).

## What other languages and platforms offer

| platform / runtime | "is there a network" | internet vs local | captive portal | metered | change event |
|---|---|---|---|---|---|
| **GLib `GNetworkMonitor`** | `network-available` | `connectivity`: `LOCAL`, `LIMITED`, `PORTAL`, `FULL` | `PORTAL` | `network-metered` | `network-changed` + notify |
| **Qt `QNetworkInformation`** (6.1-6.3) | `reachability` | `Disconnected`, `Local`, `Site`, `Online`, `Unknown` | `isBehindCaptivePortal` | `isMetered` | a signal per property; plus `transportMedium` (Ethernet, WiFi, Cellular, Bluetooth). Backends are plugins, loaded by feature |
| **Apple `NWPathMonitor`** | `status`: `satisfied`, `unsatisfied`, `requiresConnection` | — | — | `isExpensive`, `isConstrained` (Low Data Mode) | `pathUpdateHandler` |
| **Windows** Network List Manager / WinRT `ConnectionProfile` | `NLM_CONNECTIVITY` | IPv4/IPv6 *Internet* vs *LocalNetwork* vs *Subnet* | via NCSI | `NetworkCostType`: `Unrestricted`, `Fixed`, `Variable` | `NetworkStatusChanged` |
| **Android** `ConnectivityManager` | an active network | `NET_CAPABILITY_VALIDATED` | `CAPTIVE_PORTAL` | `NOT_METERED` | callbacks |
| **.NET** | `NetworkInterface.GetIsNetworkAvailable()` | — | — | — | `NetworkAvailabilityChanged` — *some interface is up*, the weakest answer of all |
| **The web** | `navigator.onLine` | — | — | `navigator.connection.saveData` (Chromium) | `online`/`offline` events |
| **Electron** | `net.isOnline()` | — | — | — | — (the web's events) |
| **Flutter** `connectivity_plus` | a list of `wifi`, `mobile`, `ethernet`, `none`… | — | — | — | a stream; its README warns it says nothing about internet access |
| **Python, Java** | nothing in the standard library | | | | |
| **Gambas, Lazarus, Delphi** | nothing built in that this plan found | | | | |

What the comparison says:

- **The weak answer is a trap everybody documents.** .NET's, the web's and
  Flutter's *online* mean *an interface is up*, and each of their docs warns
  that it does not mean the internet is reachable. A Bintana `Online` that means
  that would be the same trap with a better name.
- **The serious ones agree on three levels**: nothing, local only, the
  internet — plus *behind a portal* — and on **metered** as a separate fact.
  Qt's `Site` (an intranet but not the internet) is the one level GLib does not
  have; GLib's `LIMITED` is close.
- **Transport medium** (Wi-Fi, cellular) is offered by Qt and Flutter and asked
  for by almost nobody; *metered* is the question it is usually a proxy for.

## What GLib gives on each platform

`GNetworkMonitor` picks a backend at run time by priority: the portal inside a
sandbox, NetworkManager, netlink (or systemd-networkd's), the Win32 one, and
the base implementation elsewhere. **Only the portal and NetworkManager can
ever say anything but FULL or LOCAL, or metered** — stage 0 below has the
table, read from source and measured here.

## Stage 0: what was measured (2026-10-28)

On this machine (Fedora, GLib 2.88.4, NetworkManager, KDE's portal
configuration with `xdg-desktop-portal-gtk` answering), with a probe that
prints `GNetworkMonitor`'s three properties and `can_reach`, each backend forced
with **`GIO_USE_NETWORK_MONITOR`** (`networkmanager`, `netlink`, `base`;
`portal` is refused outside a sandbox and falls back), and the portal asked
directly over D-Bus and from inside a Flatpak (`org.freedesktop.Platform//25.08`).

**The network was partly broken, which made it the right test.** DNS has two
servers (the router and Tailscale's `100.100.100.100`); `github.com` resolved,
`example.com` did not, and the GNOME and Microsoft check hosts took 5 s to
resolve through the fallback.

| asked | NetworkManager | netlink | base | portal (host D-Bus) | portal backend in Flatpak |
|---|---|---|---|---|---|
| available | true | true | true | true | **false, then true** a moment later |
| connectivity | FULL | FULL | FULL | 4 (FULL) | **LOCAL, then FULL** |
| metered | false (`Metered` = 4, guess-no) | false | false | false | false |
| can_reach example.com:443 | false (DNS) | false (DNS) | false (DNS) | **false** | — |
| can_reach github.com:443 | — | — | — | **true** | true |

Without `--share=network` the Flatpak stays at false/LOCAL and `CanReach`
answers `NotAllowed`.

### What the source says each backend can know (GLib main, read 2026-10-28)

| backend (priority) | where it runs | available | connectivity | metered | can_reach |
|---|---|---|---|---|---|
| portal (40) | inside a sandbox only | from the portal, **asynchronously**: starts false/LOCAL | from the portal | from the portal | the portal's `CanReach(host, port)` — resolves and checks that host |
| networkmanager (30) | NM running | NM `State` | NM `Connectivity`: **only as good as NM's own check**; `UNKNOWN` with a global state gives *available* + LOCAL | NM `Metered` (yes / guess-yes) | inherited: resolve + route lookup, **no connection** |
| netlink (20) | Linux without NM or networkd | a default route exists | FULL or LOCAL, nothing else | always false | per-destination route lookup, no connection |
| win32 (20) | Windows | a default route exists (`NotifyRouteChange2`) | FULL or LOCAL, nothing else | always false | route-table match, no connection |
| base (0) | everything else — **macOS** by inference | always true | always FULL | always false | resolve; true when there is a default route |

### What it means

1. **Captive portals are only discoverable through NetworkManager, and only
   when NM's connectivity check is on.** Here it is off
   (`ConnectivityCheckEnabled false`, no URI): Fedora enables it with the
   `NetworkManager-config-connectivity-fedora` package, which is not installed,
   and NM then reports **FULL** for any connection with a default route. netlink,
   Windows and the base backend cannot say PORTAL or LIMITED at all. So
   *Connectivity* from GLib is a real answer on a GNOME/Fedora desktop with the
   check on, and a guess everywhere else — including on Windows and macOS.
2. **The honest answer is a per-host one.** The portal's `CanReach` and a real
   request are the only things that said `example.com` was unreachable; every
   global property said FULL.
3. **Inside Flatpak the first read lies.** A program reading `Online` in
   `Form_Open` gets *offline* until the portal's first answer lands. Whatever is
   built has to either wait for it or expose *unknown*.
4. **The other way to discover a portal is to do what NM does**: fetch a known
   URL over plain HTTP and compare the answer. All six common checks answered
   here (`connectivitycheck.gstatic.com/generate_204`: 204 in 0.41 s;
   `connectivity-check.ubuntu.com`: 204; `captive.apple.com`: *Success*;
   `fedoraproject.org/static/hotspot.txt`: OK; `nmcheck.gnome.org` and
   `msftconnecttest.com`: right, but 5 s because of the DNS fallback). A portal
   answers them with a redirect or its own page. This needs `Http` (libsoup,
   optional), costs a request, and asks a third party — it is a verb a program
   calls, never something done behind its back.

## A shape to argue about

```js
Network.Connectivity   // "None", "Local", "Limited", "Portal", "Full"
Network.Online         // Connectivity === "Full", and nothing weaker
Network.Metered        // true on a hotspot or a metered Wi-Fi
Network.OnChange = () => { if (Network.Online) this.retryQueued(); };
```

- **`Online` means the internet**, never *an interface is up*; the weaker
  levels are spelled out in `Connectivity` for the program that wants them.
- **One event, not one per property**, as GLib's `network-changed`: what a
  program does on a change is look again.
- **A new global `Network`**, not members of `Http`: `Http` is optional
  (libsoup) and this is GIO, always there; and a program that talks to a
  serial port or a database server over the LAN asks the same question.
- **It is advice, not a guarantee**, and the page says so in its first line:
  the answer to *can I reach my server* is a request to it. `Online` decides
  whether to try and what to show, never whether a request will succeed.

## Decisions for the owner

1. **The levels**: GLib's four plus `None`, or Qt's (`Disconnected`, `Local`,
   `Site`, `Online`)?
2. **`Online` as *Full* only**, or as *anything but None* like the web?
3. **Transport medium**: leave out until asked (the plan's view), or include?
4. **Where**: a global `Network`, or `Desktop.Network`, or under `Http`?
5. **macOS**: accept GLib's base answer, or `NWPathMonitor` from the start?

## Still to measure

- **Behind a real captive portal**, with NM's check on and off, and with an HTTP
  probe — a phone hotspot with its data plan exhausted is one.
- **Windows and macOS**, on a real desktop: what the win32 and base backends
  answer is read from source, not run.
- **A change**: the time from unplugging (or Wi-Fi off) to `network-changed`,
  per backend — what `eneverre-btn` would wait before it stops retrying.
