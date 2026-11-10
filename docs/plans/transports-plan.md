# Transports: sockets, serial and IPC beside HTTP

**Status: stages 1 to 6 built (2026-11-10); the rest is staged.** This is the
answer to **R3** of
[the October audit](../audit-2026-10.md): what a program can talk to that is
not an HTTP request and not a child process. The first stage is `Socket` and
`ServerSocket`; `Ipc` comes after, and **`Ipc.DBus` last**, because a Linux-only
global was the wrong shape for a language that already has `Database` and
`Logger`.

`docs/plans/network-plan.md` is a different question: whether the machine has
a network, whether it reaches the internet and when that changed (`Network`).
This plan is about carrying bytes.

## What the application needed

The concrete cases the audit names, and the ones that decided the names:

- a point of sale with a fiscal printer on TCP and a scale on a serial port,
  both of which speak a line protocol and answer slowly;
- a legacy integration that is a TCP socket with a length-prefixed binary
  frame, not HTTP;
- a desktop program that has to be told something by another program on the
  same machine, without opening a port;
- mail: an invoice or a report leaving as an attachment.

The common thread is that the program must keep running while it waits. A
window that freezes on `Connect` or on a scale that is not answering is the
bug this plan exists to prevent.

## What Bintana already has

- `Http`, a full client and server over libsoup: TLS with its own trust,
  streaming, a server with `Request`/`Answer`.
- `Network`, connectivity and `Reach`, which opens a socket only to answer
  *is this host reachable*.
- `Exec` and `Exec.Wait`, `Task`/`Lock` for work that must leave the main
  thread.
- A single-instance mechanism, and `Notification.Send` through the
  application (no click callback yet).
- No TCP/UDP, no serial, no WebSocket, no SMTP, no D-Bus, no named pipe.

## The field

**Gambas `gb.net`** is the closest model, and the one this plan borrows its
names from: `Socket` and `ServerSocket` (TCP and Unix sockets), `UdpSocket`,
`SerialPort`, `DnsClient`; `gb.net.smtp` has `SmtpClient`, and `gb.dbus` is a
component of its own. They are event-driven (`Ready`, `Read`, `Closed`,
`Error`, `Connection`) and inherit from `Stream`, which gives `ReadLine`,
`Write`, blocking or not, and a `Status` integer with negative errors.

**VB6/WinSock** is the form model: a non-visual component dropped on the form,
events by name, one object that is either a client or a listener. **VB.NET and
.NET** split it cleanly: `TcpClient` + `NetworkStream`, `TcpListener`,
`UdpClient`, `SerialPort` + `DataReceived`, `SmtpClient` + `MailMessage`,
`ClientWebSocket`, `Dns`, `NamedPipeServerStream`/`NamedPipeClientStream`. The
names are longer and the classes are blocking or `async`; what is worth taking
is the separation and the option validation, not the spelling.

What Bintana cannot take from any of them is `async`/`await`: this language
has no promises, by decision. The equivalent is events on the main loop, the
same shape `Timer`, `Http.Client` and the parts already use.

## The shape

### `Socket` — a TCP or Unix client

```js
const scale = new Socket({ Host: "192.168.1.50", Port: 9100,
                           Line: true, Timeout: 5000 });

scale.OnConnected = () => scale.Write("P\n");
scale.OnLine      = (line) => print(line);
scale.OnError     = (err) => print(`${err.Kind}: ${err.Message}`);
scale.OnClosed    = () => print("closed");
scale.Connect();
```

- Constructor options: `Host`, `Port`, `Path`, `Timeout`, `Line`,
  `EndOfLine`. An unknown option is refused, as `Http.Client` refuses one.
- `Host`/`Port` for TCP; `Path` for a Unix socket. `Path` on Windows refuses
  with a sentence -- the portable local road is `Ipc.Pipe`.
- `Timeout` is the connect guard in milliseconds, `0` is none, `10000` by
  default.
- `OnData(bytes)` always receives `Bytes`. `Line: true` buffers and raises
  `OnLine(text)` instead, splitting on `EndOfLine` (`"\n"` by default).
  **TCP has no messages**: a handler that treats one `OnData` as one frame is
  wrong, and the reference says so.
- `Write(data)` accepts text (UTF-8) or `Bytes` and never blocks: it queues.
  `OnWritable` is raised when the queue is empty. A write on a closed socket
  throws immediately -- a programming mistake, not an async failure.
- `OnError(err)` gets `{ Message, Kind }` with the same `Kind` vocabulary as
  `Http` (`"Dns"`, `"Refused"`, `"Timeout"`, `"Tls"`, `"Error"`). A failure
  raises `OnError` and then `OnClosed`, so cleanup has one place.
- Read-only: `Connected`, `LocalHost`, `LocalPort`, `RemoteHost`,
  `RemotePort`, and `Server` (the `ServerSocket` that accepted it, or `null`).

### `ServerSocket` — a TCP or Unix listener

```js
const server = new ServerSocket({ Port: 7000, Host: "local" });

server.OnConnection = (client) => {
    print(`${client.RemoteHost}:${client.RemotePort}`);
    client.OnLine = (line) => client.Write(`echo: ${line}\n`);
};
server.OnError = (err) => print(err.Message);
server.Listen();
print(`listening on ${server.Port}`);
```

- `Host` is `"local"` (loopback, the default) or `"any"`, the same two words
  `Http.Server` uses. `Port: 0` asks the system for a free port and `Port`
  reads it back.
- `Path` listens on a Unix socket instead.
- `OnConnection(client)` hands a **connected `Socket`**: it has no
  `OnConnected` to wait for, and its `Server` is this listener.
- `Stop()` stops accepting, closes every connection the server still holds,
  and is idempotent. `Listening` and `Count` are read-only.
- **A connection is a real resource, not a value**: a server that stopped must
  not leave a port or a socket file held, and a client that closed must be
  removed from `Count`.

### `Socket` and `ServerSocket` as parts

The same names are part types in a `.form`, so a form owns them and closes
them on its allowed close:

```json
"components": [
  { "type": "Socket", "name": "Scale",
    "properties": { "Host": "192.168.1.50", "Port": 9100, "Line": true } },
  { "type": "ServerSocket", "name": "Door", "properties": { "Port": 7000 } }
]
```

```js
Form_Open()       { this.Scale.Connect(); this.Door.Listen(); }
Scale_Connected() { this.Scale.Write("P\n"); }
Scale_Line(line)  { this.Lbl.Text = line; }
Scale_Error(err)  { Message.Show(err.Message); }
Door_Connection(client) {
    client.OnLine = (line) => client.Write(line + "\n");
}
```

That is the VB6 half: the form owns the object, the handler is named after
the part, and the designer's tray lists it. `Http`/`HttpClient` is the
precedent.

### `UdpSocket` — datagrams

```js
const udp = new UdpSocket({ Port: 9000, Broadcast: true });

udp.OnData = (bytes, from) => {
    if (bytes.ToText() === "WHO") udp.Send("HERE", from);
};
udp.Bind();
udp.Send("WHO", "255.255.255.255", 9000);
```

`Bind()` fixes the local port; `Send(data, host, port)` or
`Send(data, from)` writes one datagram; `OnData(bytes, from)` hands the
sender as `{ Host, Port, Path }`. Datagram boundaries are preserved, unlike
TCP. Multicast (`Join`/`Leave`, TTL, loop) is a later stage.

### `SerialPort` — RS-232 and USB adapters

```js
const port = new SerialPort({ PortName: "/dev/ttyUSB0", Speed: 9600,
                              Line: true });
port.OnLine = (line) => this.Lbl.Text = line;
port.Open();
port.Write("W\n");
```

Properties: `PortName`, `Speed`, `DataBits`, `Parity`, `StopBits`,
`FlowControl`, `IsOpen`. Methods: `Open`, `Close`, `Write`, `WriteLine`,
`Clear`. Events: `Data`/`Line`, `Error`. The values are strings, checked at
assignment (`"None"`, `"Even"`, `"Odd"`, `"Hardware"`, `"Software"`, ...), not
Gambas' constants -- the same choice `Notification` makes with `Urgency`.

Linux first, over POSIX `termios` (`open`, `tcgetattr`/`tcsetattr`, `read`,
`write`) on a `GSource` of the main loop. **`termios` is the C library's
terminal interface -- `<termios.h>`, the one `stty` and every terminal program
use -- not a library to install or link**: `open()` and `read`/`write` reach the
kernel's tty layer, and only the configuration calls come from it. There is no
`GSerialPort` in GIO -- checked against GLib 2.88's headers and the upstream
tree, where no `gunixserialport.h` exists -- and `libserialport` would be a
second dependency for the same ioctls. Windows needs its own `CreateFile`/`SetCommState`/
overlapped-I/O half, and is a stage of its own. `PinChange` is not here: POSIX
would have to poll `TIOCMGET` and no caller has asked for a pin.

### `WebSocket` — a client, then a server

```js
const ws = new WebSocket({ Url: "wss://example.com/feed" });

ws.OnOpen    = () => ws.Send("subscribe");
ws.OnMessage = (data, isText) => print(isText ? data.ToText() : `${data.Length} bytes`);
ws.OnClosed  = (code, reason) => print(`closed ${code} ${reason}`);
ws.OnError   = (err) => print(err.Message);
ws.Open();
```

`Send(data, [text])`; `OnMessage(data, isText)`; `Close(code, reason)`.
The client is libsoup's `SoupWebsocketConnection`, so it is optional exactly
as `Http` is. The server half hangs off `Http.Server` (an upgrade is an HTTP
request), not off a second port: `Http.Server` gains a `WebSocket` handler,
and a `WebSocket.Server` is sugar over the same thing.

### `SmtpClient`

```js
const smtp = new SmtpClient({ Host: "smtp.example.com", Port: 587,
                              User: "u", Password: "p", Tls: "StartTls" });

smtp.Send({
    From: "app@example.com",
    To: ["client@example.com"],
    Subject: "Invoice 42",
    Body: "Attached.",
    Attachments: [File.Join(Application.Directory, "invoice.pdf")],
}, (err) => print(err ? err.Message : "sent"));
```

The transport holds the server and credentials; the message is a record, as
`Http.Client` holds the base URL and a request holds its own headers.
`Tls` is `"None"`, `"StartTls"`, `"Tls"` or `"Auto"`; `Authentication` is
`"Auto"` by default. Attachments are read into memory for the first version
-- a large file is a `Task` or a later streaming road.

**Credentials are not a `.form` property.** The `SmtpClient` part exposes
`Host`, `Port`, `Tls` and `From`; `User` and `Password` are set in
`Form_Open` from `Settings`/`Keyring`, so they never land in a `.form` in
version control.

## IPC: one name, providers like `Database` and `Logger`

D-Bus is not a top-level global and not the shape of the layer. It is **one
provider of a generic IPC surface**, the way `Database.Postgres` will be one
driver of `Database`, and the way `Logger` has a terminal, a journal and a
file without pretending they are the same thing.

The precedent is in `runtime/src/bta_database.c`:

- `Database` is the extension point; each driver adds its own opener
  (`Database.Sqlite(path)`, a future `Database.Postgres(host, db)`).
- `Connection` is a base class with an empty prototype: common words only,
  and **no `Connection.Open`**, because opening belongs to the driver.
- `Dialect` publishes the three facts that actually differ per engine, so a
  portable caller can see what it is talking to.

`Ipc` is the same shape:

- `Ipc` is the extension point; each provider adds its own opener.
- `Channel` is the base: `Kind`, `Name`, `Backend`, `Connected`, `Close`,
  `OnClose`, `OnError`. It holds no `Send`, because a D-Bus method call and a
  byte stream are not the same verb.
- `Backend` is the `Dialect` of this layer: `"UnixSocket"` or `"NamedPipe"`
  for `Ipc.Pipe`, `"DBus"` for `Ipc.DBus`. A program that must know can ask;
  a program that only streams does not have to.

### `Ipc.Pipe` — the local byte stream

```js
const server = Ipc.PipeServer("myapp");
server.OnConnection = (channel) => {
    channel.OnLine = (line) => channel.Write(line + "\n");
};
server.Listen();

const channel = Ipc.Pipe("myapp");
channel.OnConnected = () => channel.Write("hello\n");
channel.OnLine      = (line) => print(line);
channel.Connect();
```

On Unix this is a Unix domain socket, and the first implementation reuses
`Socket`/`ServerSocket` with `Path`. On Windows it is a named pipe
(`\\.\pipe\myapp`). The caller writes a **name**, not a path; the provider
chooses the platform's spelling and exposes it as `Path`:

| | Unix | Windows |
|---|---|---|
| `Backend` | `"UnixSocket"` | `"NamedPipe"` |
| `Path` | `$XDG_RUNTIME_DIR/myapp.sock`, `$TMPDIR` fallback | `\\.\pipe\myapp` |
| permissions | socket file `0600` | a pipe ACL for the current user |

A name is `[A-Za-z0-9._-]+` (no separators, no `..`); a caller that needs a
specific filesystem path uses `Socket({ Path })` on Unix, which is the
low-level road. A stale socket file is removed only when it is a socket owned
by the user and nothing answers on it; anything else is refused.

`Ipc.Pipe`/`Ipc.PipeServer` are the portable road; `Socket`/`ServerSocket`
remain the TCP and Unix classes. That is why `Socket.Path` is not the
portable API and `Ipc.Pipe` is.

### `Ipc.DBus` — later, and still under `Ipc`

```js
const bus = Ipc.DBus({ Bus: "session" });

bus.Call({ Service: "org.freedesktop.Notifications",
           Path: "/org/freedesktop/Notifications",
           Interface: "org.freedesktop.Notifications",
           Method: "Notify", Args: [...] },
         (result, err) => ...);
bus.OnSignal({ Service, Path, Interface, Signal }, (args) => ...);
```

On a platform without a bus the name exists and refuses with a sentence,
the way `Logger.Target = "Journal"` refuses on a build with no journal. It
is not silently downgraded to something else.

D-Bus is last because a general GVariant-to-JavaScript mapping is a design
of its own, and because the audit's only desktop case -- a clicked
notification reaching the program -- is better served by `Notification`'s
own action than by a general bus. The first application that needs to call a
service is the case to design `Ipc.DBus` from.

## Stages

1. **`Socket` + `ServerSocket`** -- TCP and Unix, async connect/accept/read/
   write, line mode, parts, loopback tests. **Built** (2026-11-08,
   `runtime/src/bta_socket.c`; `tests/widgets`' `testSockets`). This is the
   foundation.
2. **TLS on both** -- `Socket.Tls = true`/`{ Ca, Cert }` and
   `ServerSocket.Tls = { Cert, Key }`, reusing `Http`'s trust type.
   **Built** (2026-11-08, the same file; `tests/widgets`' `testSocketTls`):
   a CA file, a pinned certificate and a self-signed server, each handshaken
   against a real listener. The client's connect timeout covers the handshake.
3. **`UdpSocket`** -- unicast and broadcast first; multicast after.
   **Built** (2026-11-08, the same file; `tests/widgets`' `testUdp`). IPv4 in
   this stage; multicast and IPv6 follow.
4. **`WebSocket` client**, then the server half on `Http.Server`.
   **Built** (2026-11-08, `runtime/src/bta_http.c`; `tests/widgets`'
   `testWebSocket`): the client speaks `ws://`/`wss://`, text and binary
   frames, `Protocols` and `Headers`; `Http.Server.WebSocket` is the upgrade
   handler, and a server with no `Request` is a WebSocket-only listener.
5. **`SmtpClient`** -- over `Socket` + TLS, with `MailMessage`-shaped input.
   **Built** (2026-11-08, `runtime/js/rad.js`): plain or
   implicit TLS, `AUTH LOGIN`, MIME with text/HTML and base64 attachments. A
   `StartTls` is refused until `Socket` can upgrade mid-stream; the part keeps
   `User`/`Password` out of the `.form`.
6. **`SerialPort`** -- Linux over POSIX `termios` on the main loop's
   `GSource`; Windows later. **Built** (2026-11-10,
   `runtime/src/bta_serial.c`; `tests/serial.sh`): open/close/configuration,
   `Data`/`Line`, queued writes, the `FormPart`, and a pseudo-terminal as the
   peer. The Windows half is the only part of the class that refuses.
7. **`Ipc`** -- the base `Channel`, `Ipc.Pipe` on Unix (reusing stage 1),
   then the Windows named-pipe backend.
8. **`Ipc.DBus`** -- last, with a caller.

## What is deliberately not here

- **No blocking `Read`/`Accept` on the main loop.** The event road is the
  only one; `*Wait` verbs, if they come, are for `Task` workers and freeze
  the caller by definition, like `Http.GetWait`.
- **No sockets or serial ports in a `Task` at first.** A worker has no main
  loop, so the names are absent or refuse with a sentence -- the same line
  `Timer` and `Dialog` already take. Blocking `ConnectWait`/`ReadWait`/
  `WriteWait` are a later road.
- **No `Status` integer constants.** `Connected`, `Listening`, `Bound`,
  `IsOpen` and the error's `Kind` answer the questions Gambas' negative
  numbers answer.
- **No `ReadLine` pull API.** `Line: true` pushes complete lines; a binary
  protocol accumulates `Bytes` in the program.
- **No tray, no global hotkeys.** GTK4 has neither; the portals are a
  different plan.
- **No `Dns` global yet.** `Socket.Connect` resolves; a separate lookup is a
  caller-driven addition.
- **No named pipe spelled as a `Socket.Path`.** `Ipc.Pipe` is the portable
  name; the platform spelling is a `Backend`/`Path` detail.

## How it will be tested

The sockets on loopback, in `tests/widgets`, with no external network:

- a `ServerSocket` on `Port: 0` and a `Socket` that connects, writes and
  reads back;
- a line split across two writes, and two lines in one write, to prove the
  `Line` buffer is not a frame reader;
- binary data with a NUL byte, to prove `OnData` is `Bytes` and not text;
- a peer that closes, a refused port, and a connect timeout;
- a Unix socket in a temporary directory on Linux;
- `Stop()` closing a live connection and `Count` going back to zero;
- the part round trip: a `.form` with a `Socket` and a `ServerSocket`, the
  properties read back, and the form's close closing them.

And `SerialPort` has its own door, `tests/serial.sh`: a C helper makes a
pseudo-terminal, the console project writes lines and bytes through it, and
the script's timeout is the assertion the console loop's accounting cannot
make. A pty is a tty, so `tcgetattr`/`tcsetattr` take the same path a USB
adapter does; the modem lines are the by-hand half.

`Ipc.Pipe` gets the same pair on Unix; the Windows named-pipe half runs in
the `windows` job when it exists, because a Linux run cannot prove it.
