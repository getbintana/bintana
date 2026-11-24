# UPSTREAM: on Windows, GIO's proxy resolver costs every process its first 2.4-3 s

## What the application needed

To make an HTTP request on Windows without waiting. A program's first request
-- `Http.Get`, an `Http.Client`, a `WebSocket` -- waited 2.4 to 3 s before
connecting, and only the first: the next took 1 ms. A request to `127.0.0.1`
waited the same. The walkthrough of 2026-11-24 met it as a table that stayed
on *Consultando...* for three seconds against a server in the same machine.

## What I wrote instead

`bta_proxy.c`: a `GProxyResolver` of the runtime's own, given to every
session that asks the system.

- The machine's own addresses (`localhost`, `*.localhost`, loopback) are
  direct, on every platform.
- On Windows the answer is Windows': `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and
  `NO_PROXY` first (libproxy honoured them), then the user's settings through
  `WinHttpGetIEProxyConfigForCurrentUser` -- a fixed proxy with its bypass
  list, or a configuration script and automatic detection evaluated by
  `WinHttpGetProxyForUrl`, which asks the WinHTTP Auto-Proxy service and its
  cache -- and otherwise direct.
- Elsewhere GIO's default resolver answers the rest, as before.

Measured on the same machine, the same project, before and after:

| request | GIO's resolver | `bta_proxy.c` |
|---|---|---|
| first, to the machine's LAN address | 3133 ms | 8 ms |
| first, to `127.0.0.1` | 2377 ms | 7 ms |
| first, to a refused `127.0.0.1:1` | 4811 ms | 2017 ms (Windows' own SYN retries) |

## The code I wish I could have written

```c
SoupSession *sess = soup_session_new();   /* and the first request is fast */
```

## Why the existing words do not cover it

Nothing in the runtime is missing; GIO's resolver is slow there. Measured
2026-11-24 on Windows 11 with MSYS2 UCRT64's glib2 2.90.1, glib-networking
2.90.1, libproxy 0.5.12 and libsoup3 3.8.1:

- The user's settings say *direct, and automatically detect* --
  `DefaultConnectionSettings` flags `0x09`, `ProxyEnable` 0, no
  `AutoConfigURL`: Windows' default.
- `GIO_USE_PROXY_RESOLVER=libproxy`: 2774 ms for the first request to
  `127.0.0.1`. `=gnome`: 2415 ms. `=dummy` (always direct): 14 ms. Every
  request after the first: 1 ms in all three.
- `WinHttpGetProxyForUrl` with `WINHTTP_AUTOPROXY_AUTO_DETECT`, asked for the
  same kind of address: 8 ms in a fresh process.

So the time is the resolver finding out, on its own, what Windows already
knows -- most likely WPAD discovery waiting for a `wpad` host that this network
does not have, which is the common case at home and in small offices. GIO has
no proxy resolver that asks Windows (it has a network monitor that does), and
the modules MSYS2 ships do their own discovery.

## Prior art

Not reported yet. Two places could close it:

- **GLib**: a Windows `GProxyResolver` in GIO over WinHTTP, the way
  `GWin32NetworkMonitor` already asks the system for connectivity. Every GIO
  program on Windows would get the system's proxy, fast.
- **libproxy**: on Windows, ask WinHTTP (`WinHttpGetProxyForUrl`, which uses the
  Auto-Proxy service and its cache) for automatic detection instead of running
  WPAD in process.

A draft report, for GLib's tracker (gitlab.gnome.org/GNOME/glib):

> **GIO on Windows: the first proxy lookup of a process takes 2.4-3 s with
> "Automatically detect settings" on**
>
> On Windows 11, with the default Internet settings (direct, with *Automatically
> detect settings* on; `DefaultConnectionSettings` flags `0x09`), the first
> `g_proxy_resolver_lookup` of a process takes 2.4-3 s, even for
> `http://127.0.0.1:port/`. Later lookups take ~1 ms. Measured with MSYS2
> UCRT64's glib2 2.90.1, glib-networking 2.90.1, libproxy 0.5.12, through
> libsoup3 3.8.1:
>
> - `GIO_USE_PROXY_RESOLVER=libproxy`: 2774 ms; `=gnome`: 2415 ms;
>   `=dummy`: 14 ms.
> - `WinHttpGetProxyForUrl` with `WINHTTP_AUTOPROXY_AUTO_DETECT` for the same
>   URL, in a fresh process: 8 ms.
>
> Every GIO/libsoup program on Windows pays this before its first connection,
> including connections to localhost. GIO has `GWin32NetworkMonitor` but no
> proxy resolver that asks Windows; a `GProxyResolver` over WinHTTP (the
> current user's configuration from `WinHttpGetIEProxyConfigForCurrentUser`,
> and `WinHttpGetProxyForUrl` for automatic detection and PAC) would answer
> from the system's own cache. Loopback addresses could also be answered
> `direct://` without asking anyone.
>
> We carry such a resolver in our project (a few hundred lines of C, MIT
> licensed) and would be glad to adapt it for GIO if that is wanted.

## How much it mattered

It works, but a part of it is noticeably worse: every program's first request
on Windows, which is the one a person is watching -- a window that opens and
fills from an API showed nothing for three seconds. With the workaround in
place the question is no longer ours, but the file stays until GIO or the
modules answer it, because deleting it would hide why `bta_proxy.c` exists.
