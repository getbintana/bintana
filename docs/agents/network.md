# Http, TLS and sockets

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Http

- **On Windows a closing WebSocket often ends in a reset, not an EOF.** After a
  client's own `Close()` and after a server's `Stop()`, libsoup raised
  "Error receiving data: Se ha anulado una conexión..." into `OnError`;
  `testWebSocket` was red four runs in four there and green on Linux. An I/O
  error once a close frame has gone or come is the close and is not raised
  (`on_ws_error`); a protocol error still is. Windows also takes ~2 s to
  report a refused connect to a closed `127.0.0.1` port (it retries the SYN):
  a test that wants `Refused` gives it more than 2000 ms.
- **A port `Port: 0` gave is not yours after `Stop()`.** It is ephemeral, and
  on Windows every outgoing connection draws from the same range: inside the
  suite a restart on it was refused "already in use" now and then. Alone it
  never was -- straight away, a second later, after a 200, a 401 or a 403
  (2026-11-12) -- so it is not the runtime holding the port. **Do not "fix"
  `testHttpServer`'s TLS step with `srv.Port = 0`**: the steps after it ask
  the old port through `api`'s `BaseUrl`, and the step itself runs `python3`
  with no `Timeout` -- on Windows that can be the Store's stub, and the path
  had never run there because the restart always threw first. Tried, and the
  suite hung. `testNetwork`'s probe of a stopped
  server once answered `Error` instead of `Refused` in the suite and never in
  six runs alone, which may be the same port taken by another server; not
  proven.
- **A request body with no limit is a hole, and the declared length is the
  cheap half of the answer.** `Http.Server` flattened whatever arrived, so a
  body grew until the process died (R4 of the October audit). `MaxBody` is a
  property now -- 1 MiB when nothing is said, `0` for the explicit *no limit* --
  and both refusal points answer `413` with the limit in the body. **The check
  cannot live in the handler**: soup calls `soup_server_add_handler`'s callback
  only once the whole body is in memory, so the first version refused a 4 GB
  upload after holding it (twice, with the flatten). It is an *early* handler
  (`soup_server_add_early_handler`), which runs on the headers: a declared
  `Content-Length` past the limit gets its status there and soup then skips the
  body and sends no `100 Continue`; a chunked body is counted in `got-chunk`
  and, once past the limit, `soup_message_body_set_accumulate(FALSE)` stops it
  being kept -- the bytes are read and dropped, the handler answers `413` on the
  mark. Measured with `curl` against `MaxBody: 16` (RelWithDebInfo build): a
  300 MB chunked body took the process's peak to 621 MB before and leaves it at
  31 MB now, and `Content-Length: 4000000000` with `Expect: 100-continue` was
  told `100` before and `413` now. The handler never runs for either.
  `tests/widgets`' `HttpServer` holds
  the refusal and the property, and the check was taken out to watch it go
  red.
- **libsoup3 has no session `authenticate` signal, and connecting one is a
  `GLib-GObject-CRITICAL`, not a `NULL` or a no-op.** The plan assumed the
  soup2 shape; measured, the signal is in neither `soup-session.h` nor any
  other header (nor on `SoupAuthManager`, per `gi` introspection), and the
  replacement (`use_auth` off a challenge) is a second round trip. So `Auth`
  is Basic preemptive in the header -- the same bytes with no signal -- and a
  401 from anything else is answered. Check a signal exists (`g_signal_lookup`)
  before designing on the assumption that it does.
- **The two famous echo services sit on the Public Suffix List, where no
  cookie may live.** `httpbin.org` and `postman-echo.com` are both in
  `public_suffix_list.dat` (15291, 15294), so soup's jar -- like any
  PSL-respecting client -- refuses their `Set-Cookie`, and it looks exactly
  like a jar that never stores: manual `set_cookie` answers 0 while
  `localhost` answers 1. `examples/session` runs against `httpbingo.org`,
  which is not listed. When cookies vanish only on one domain, read the list
  before reading the code.
- **Soup normalizes a request's dot-segments before the handler runs, so a
  `".."` refusal in a file server is dead code that teaches the wrong
  lesson.** `/a/../../x` arrives as `/x`, encoded or not -- measured with a
  probe echoing `req.Path` -- which means `File.Join` under a root cannot
  escape it, and a test asserting the `400` fails. `examples/serve` relies on
  the normalization and says so, instead of carrying a guard that never fires.
  The reference claimed the opposite for a while (`routing, Bytes, statuses,
  and the ".." refusal`), copied out of the plan that predated the
  measurement: a sentence describing a guard nobody wrote, sitting in the
  file people read to find out what the runtime does.
- **`Stop()` asks, it does not undo, and the answer still arrives.** A
  cancelled request calls back a turn of the loop later -- by which time the
  request that replaced it is already flying. A control that stays enabled
  (`examples/jokes`' category combo; the button cannot do it, since it
  disables itself) is used twice before the first answer lands, and the stale
  `Cancelled` overwrote what the live request was doing: the status read a
  failure with the button re-enabled while a good request was on its way.
  What makes a stale answer droppable is the handle each callback is handed
  as its second argument -- compare it against the one being waited for.
  Reproduced both ways against a 3 s server before it was believed: without
  the check the status showed `Cancelled` twice, with it never.
- **A server lives as long as its object, so an example keeps it at module
  scope.** Dropping a listening server disconnects (a port is not left held
  past whoever held it), which means a `const` inside `Main` dies with the
  return, before the first request ever arrives -- and it looks exactly like
  `Start` never listened. The suite never notices, because its chain closes
  over the server to stop it at the end.
- **One feature instance on two sessions corrupts the heap on the way out.**
  A `SoupCookieJar` added to both of a client's sessions dies twice -- once
  per session finalizer -- and the crash lands in `soup_session_finalize`,
  pages away from the `add_feature` that caused it, with wrong answers (open
  gates, empty parts) as the first symptom. A `Wait` borrows the jar for the
  flight instead, which is exclusive by construction since a `Wait` freezes
  the loop every async flight is parked on.
- **Two argument splits reading the same object with two key lists is one
  call answering two ways.** `Http`'s async spelling decided "body or
  options?" by looking for seven names; the blocking one looked for six, and
  the one it lacked was `FollowRedirects` -- so `PostWait(url, {
  FollowRedirects: false })` serialized its own options and posted them as
  JSON, configuring nothing, with nothing saying so. It is one `static const`
  table now, read by both. Where the same question is answered twice, the
  answer is a table, not a second copy of the list.
- **A `Kind` matched on `err->message` is right only where it was written.**
  Three arms of `http_kind_for` compared English substrings (`"Connection
  refused"`, `"Name or service not known"`), which on a Spanish desktop match
  nothing -- and a `Kind` that is wrong only on some machines is worse than
  `Error`, because it looks reliable. The domain and the code say the same
  thing in every locale. The same function also called every error in soup's
  domain a `Redirect`, `ftp://` included.
- **`GDataInputStream`'s default newline is LF, and HTTP is a CRLF
  protocol.** `Exec` never had to know: a pipe ends its lines with `\n`. A
  conforming server-sent-event stream is allowed `\r\n`, so `Http.Stream`
  read with the default handed every line back with a carriage return still
  on the end of it -- `JSON.parse` failing on the last character, and the
  blank line that separates two events never comparing equal to `""`.
  `g_data_input_stream_set_newline_type(..., G_DATA_STREAM_NEWLINE_TYPE_ANY)`,
  the moment the reader is made. The test that catches it is `/crlf` in
  `testHttpStream`, and it exists because the LF-only feed passed happily.
- **`on_http_stream_line`'s `CANCELLED` branch is *not* `on_exec_line`'s**,
  and the two functions otherwise read as twins. In `Exec` a cancelled read
  means the teardown already freed the job, so the callback returns and says
  nothing. In `Http` only the guard and `Stop()` cancel: the job is alive and
  owes an answer, so that branch *delivers* `Timeout`/`Cancelled` like the
  buffered road. The teardown case is caught by `http_job_alive` instead --
  membership of `http_jobs`, checked first thing in every streaming
  completion, because a stream has a read armed on it for its whole life and
  the teardown frees jobs with those reads outstanding.
- **A stream is routinely stopped from inside its own line callback**, which
  is the `File.Watch` segfault again -- the line that says the turn ended is
  exactly where an application stops following. The `calling`/`dead` pair
  lives **inside `http_job_free`** and not at each caller: there are three
  callers already (both deliverers and the teardown) and a fourth added later
  would reopen it in silence. Coming off `http_jobs` before the mark is what
  keeps the teardown's `while (http_jobs)` terminating.
- **The next read is armed after the JS callback returns, not before**, and
  that is the whole of the back-pressure: one read outstanding at a time, so a
  slow handler slows the feed instead of queueing it. It is also why nothing
  needs a reassembly buffer -- `GDataInputStream` holds the partial line, the
  way it already does for `Exec`.
- **`HTTP_OPT_KEYS` was deliberately not touched.** Streaming is a verb
  (`Stream`) and not an option, so there is no new key to keep in step across
  the two argument splits, no rejection to invent in the seven `*Wait`
  spellings -- and, unlike an option, `tests/api.sh` can *see* it: the check
  reads member tables, so an option would have been the one large capability
  the documentation was not obliged to name.
- **`Stop` from inside a handler waits for the handler.** `Answer` fills the
  message in; soup sends it when the handler returns. Disconnecting during the
  dispatch -- `req.Answer(200, "bye"); srv.Stop();`, which is every `/shutdown`
  endpoint -- answered the client with a closed connection. The disconnect is
  an idle now, `Running` stays true until it runs (the port is still held,
  which is the truth about the socket), and the counter is **global** because
  it is decremented after a call that may have freed the server it belongs to.
  **And the finaliser is the second door to the same disconnect.** A handler
  that lets go of the last reference (`srv = null` after the `Answer`) has the
  server finalised inside the dispatch, and `http_server_free` disconnected at
  once -- the same closed connection, and the fix in `Stop` could not see it.
  The finaliser hands the `SoupServer` and its gate to an idle when
  `http_dispatching > 0` (`HttpLateStop`); the struct itself goes at once,
  since nothing after the call reads it. `testHttpServerDropped` is red without
  it. The rule: **a deferral written into a verb is owed by every other road to
  the same effect**, and a finaliser is always one of them.

## A held request: `Hold`, and what a paused message cannot see

`req.Hold([timeout])` lets a handler return without the `500` and answer from
a callback later (audit R4). The message is paused with
`soup_server_message_pause` (libsoup 3.2; CI has 3.4) when the handler
returns unanswered -- **not at `Hold`**, so a `Hold` and an `Answer` in the
same handler need no pause at all -- and `HttpReqData` keeps our reference,
the deadline timer and a `disconnected` handler until `http_req_release`, the
one exit every ending goes through.

- **A paused message reads nothing, so a client that closes its end is not
  seen.** Measured: a client with a 150 ms `Timeout` gave up, and the late
  `Answer` still answered `true` -- soup notices only when it writes. What
  does end a held request is the deadline (`503`, *no answer within N ms*),
  the server stopping (`disconnected` fires for a paused message on
  `soup_server_disconnect`, measured), and the wrapper's finaliser (`500`).
  `Answer` says `false` for those, and `true` means *handed to the
  connection*.
- **A `Stop` after a late `Answer` waits for it**, the way it waits for a
  handler on the stack: `http_late_inflight` counts unpaused messages until
  `finished` or `disconnected`, and the stop idle looks again every 10 ms.
  Without it the `/shutdown`-answered-later case got *connection refused*
  (`HttpServerHold` goes red that way).
- **A test whose callback throws hangs instead of failing**: the chain ends
  with `waiting` owed. The first `HttpServerHold` hung the suite for ten
  minutes on an `until` whose condition threw on its second call; its
  callbacks catch and call `done` now.

## Tls on a client: the abort was ours, and the hole was the cache

`Http.Client`'s `Tls: { Ca, Cert }` shipped believing that **a second TLS
handshake in one process corrupts the heap** -- `malloc(): unaligned tcache chunk
detected`, `G_BOX_MAGIC` at teardown, `corrupted double-linked list` after a
`Stop()` -- "pre-existing, reproduced with a bare `Http.Client()`", and the suite
asserted no handshake at all because of it. All three were one line of the new
code: `http_on_accept_certificate` called `g_uri_unref` on what
`soup_message_get_uri` returns, which is **transfer none** -- the message's own
`GUri`, freed while soup still used it. A `GUri` is an atomic rc box, which is
the `G_BOX_MAGIC`. It only ran on the `Ca` road (a `Cert` pin returns before
reading the URI), which is why "twelve pinned handshakes" was always clean and
one `Ca` handshake against an *external* server was enough to abort.
**AddressSanitizer saw nothing** for the reason the arena note above gives for
`JSValue`s: glib's rc boxes recycle. Read the transfer annotation of every GLib
or soup getter you free; `get` usually lends.

**The reproducer's "Connection refused" was not TLS either.** Its server was a
`const` the remaining callbacks did not mention, so it was collected, and a
collected server disconnects -- the documented "a server lives as long as its
object", seen with gdb on `close()`: the listening descriptors closed from
`http_server_finalizer`. Held, every combination of plain and https, before and
after a `Stop()`/`Start()`, answers. Before believing a listener died, ask
whether its object did.

**And a review found the real hole: a resumed session is never verified.**
glib-networking caches the TLS sessions of a process by server, and a resumed
handshake presents no certificate, so `accept-certificate` never fires. A server
one client accepted with its `Ca` or `Cert` was then reachable by **every other
client in the process** -- a bare `Http.Client()` included, and one with a wrong
CA -- which is precisely the "accept-anything" this feature promises not to be.
Measured against Python's `ssl` (TLS 1.3 tickets by default), and gone against
the same server with `num_tickets = 0`. `http_tls_no_resume` turns
`session-resumption-enabled` off on the connections of a client that set `Tls`,
from `SoupMessage::network-event` at `TLS_HANDSHAKING`; the property is
glib-networking's (2.72+) and not in GIO's headers, so it is looked up first.
**`Http.Server` issues no tickets**, so the suite's own server cannot show this:
`tests/widgets`' `HttpServer` starts a `python3` https child for the one
assertion that can, and it is red with the call removed. The step now does
every handshake the feature needs -- a bare client refused, `Ca` and `Cert`
accepted, a wrong `Ca` and a wrong `Cert` refused, and a bare client after an
acceptance still refused.

## Network: what the monitor knows, measured

`Network` (`runtime/src/bta_network.c`) sits on `GNetworkMonitor`, and stage 0
of [docs/plans/network-plan.md](../plans/network-plan.md) is the evidence for
each rule below; read it before changing a level.

- **Every backend said FULL on a half-broken network** (one DNS server dead:
  `github.com` resolved, `example.com` did not). So `"Full"` is reported only
  where somebody checked: NetworkManager with `ConnectivityCheckEnabled`
  (read from NM itself over the system bus), or the portal inside a sandbox.
  Everything else with a route is `"Routed"`, and `Online` is `false` there.
- **Force a backend with `GIO_USE_NETWORK_MONITOR`** (`networkmanager`,
  `netlink`, `base`) to see what each answers on the same machine. `portal` is
  refused outside a sandbox and falls back silently.
- **The portal backend's first read is false/LOCAL**, filled by an async
  `GetStatus` a few milliseconds later: `"Unknown"` until the first notify. A
  Flatpak without `--share=network` never gets an answer (GLib ignores the
  portal's signals then), so `/.flatpak-info` is read for `shared=network`, as
  GLib's private `glib_network_available_in_sandbox` does, and the answer is
  `"None"`.
- **Running a build inside Flatpak to check this**: the host binary needs the
  libraries of `io.github.getbintana.Hello`'s sandbox, which has no VTE and
  another libxml2 soname. A scratch build with both hidden (the `pkg-config`
  wrapper of [build-and-tools.md](build-and-tools.md)) runs there with
  `flatpak run --filesystem=<dir> --command=<binary> io.github.getbintana.Hello <project>`.
- **`Reach` is a real connection**, because the inherited `can_reach` (netlink
  and NM) is a route lookup that said yes to a host whose name did not
  resolve. Inside the sandbox the portal's `CanReach` is the road, and it
  answers *unreachable* for a name that does not exist.
- **`Probe` must not follow redirects**: the redirect is the answer. Put
  `FollowRedirects: true` back in it and `testNetwork` goes red on the portal
  rows.
- **A `Task` worker runs `rad.js` and has no `Network`**, and only the blocking
  `Http.*Wait` verbs -- each on a `SoupSession` of that thread; handed
  `this.Cancellable` last, `Stop` cancels the flight. The first
  `Network.Probe = …` stopped every worker at load, and the xlsx and task tests
  went red with *Network is not defined*; the asynchronous `Http` is not there
  because its source belongs to the main loop. Anything `rad.js` hangs on a C
  global is guarded with `typeof … !== "undefined"`.
- **Over HTTP/2 a cancel is seen only when the stream next has traffic.**
  libsoup's `soup_client_message_io_http2_run_until_read_async` (3.6.6, and
  still in 3.8.1) puts the `GCancellable` in a `GTask` and never connects to
  it; `soup_http2_message_data_check_status` asks `is_cancelled` only when a
  frame arrives for that stream. HTTP/1.1 polls with sources made on the
  cancellable and answers at once. Measured against
  `https://httpbin.org/delay/6`, cancelled at 1.5 s: HTTP/2 answers at 7.1 s,
  HTTP/1.1 at 1.5 s -- in a 20-line C program on libsoup alone, in `Http.GetWait`
  on the main thread and in a task, and in the callback `Http.Get` with `Stop()`
  or `{ Timeout }`. So every way of cancelling a flight (`Stop`, `Timeout`,
  a `Cancellable` argument, a task's `Stop`/`Timeout`/shared token) reports the right
  ending late, and a server that never answers is never left. **It is not ours
  to fix and we do not force HTTP/1.1**: the application opts in per request
  or per client with `Http1` (`soup_message_set_force_http1`), measured the
  same way -- a task stopped at 1.5 s ends at 1502 ms with it and 6889 ms
  without. The process-wide road is `SOUP_FORCE_HTTP1`, which libsoup reads
  once (`soup-connection-manager.c`, a `static`) at the first connection, so
  `Environment.Set` before the first request covers worker threads too.
  `bintana-docs` documents both in `Http.md#cancelling-over-http2`;
  `examples/downloads` uses `Http1`. The suite cannot assert the timing: its
  servers are local and speak HTTP/1.1. `soup_message_set_force_http1` is
  `SOUP_AVAILABLE_IN_3_4` and the build asks for no minimum, so it is behind
  `SOUP_CHECK_VERSION(3, 4, 0)`; below that, a request asking for `Http1` is
  refused naming `SOUP_FORCE_HTTP1` (exercised by forcing the check). Searched on
  2026-11-02: no libsoup issue or MR covers it; the nearest is #367 (*HTTP/2:
  Socket I/O timeout not reported to app*), the same `check_status` not being
  called. When an upstream report exists, link it here and in `Http.md`.
- **A timeout in a `tests/widgets` test is measured against the whole suite's
  blocking calls.** Tests run in order but their waits overlap, and later tests
  hold the main loop for seconds in `*Wait`; a connection that completed and a
  timeout that expired during the block are both ready afterwards, and the
  timeout was dispatched first. `testNetwork` passed alone and read `Timeout`
  on every row in the full run until its timeouts became a minute.

## SerialPort

- **`GSerialPort` does not exist.** The transports plan named it as if it were
  a GIO class; GLib 2.88's headers and the upstream tree have no
  `gunixserialport.h`, and `docs.gtk.org/gio` has no `SerialPort`. A serial
  port on Unix is a tty, and the interface is the C library's `<termios.h>` --
  the one `stty` uses -- not a library to install. `libserialport` (sigrok)
  exists and wraps the same ioctls; it is a dependency this runtime did not
  need.
- **A serial read is not a message.** `OnData` hands the bytes one `read`
  returned; `Line: true` is the same buffer-and-split the socket does, with
  the same 1 MiB cap. A chunk is not a frame.
- **`O_NONBLOCK`, a write queue and `G_IO_OUT`.** A serial port can take fewer
  bytes than `write` was given, and `EAGAIN` is normal when the kernel buffer
  is full. `Write` queues a `GBytes`; the fd is drained by a second
  `GUnixFDSource` that exists only while the queue is non-empty. It is removed
  when the queue empties, or the level-triggered `G_IO_OUT` would spin.
- **The source holds the wrapper, as `UdpSocket` does.** The `GSource` is C
  data and holds no `JSValue`; `keep` is a strong reference while the port is
  open, and the source callback takes another for the length of a delivery (a
  handler may `Close`). `Close` removes the sources, closes the fd, and drops
  `keep` last -- freeing it can finalize the wrapper, and nothing reads the
  struct after it.
- **`tcgetattr` is the "is this a serial port" question.** `open` succeeds on
  `/dev/null`; `tcgetattr` answers `ENOTTY`, and `Open` says so. It is also why
  a pty is a real test of this code: it is a tty, and the same
  `tcgetattr`/`tcsetattr` path runs. The modem lines are what a pty cannot
  prove, and they are the by-hand half.
- **Mark/space parity and hardware flow control are compile-time.**
  `CMSPAR` and `CRTSCTS` are not on every Unix; `Open` refuses with a sentence
  when the platform's headers do not offer the bit, rather than opening with a
  different parity and no warning.
- **The Windows half is a different API.** `CreateFile`/`SetCommState`/
  overlapped I/O; the class exists there, its properties answer and a form
  loads, and `Open` says the half is not written. `Terminal` without VTE is
  the precedent.

## Sockets and ServerSocket

- **A TCP read is not a message.** `OnData` hands the bytes one `read`
  returned: two writes can arrive as one chunk and one write as two. The
  reference says so, and `Line: true` is the only framing the runtime does --
  it buffers and raises `OnLine` per `EndOfLine`. `socket_start_read` chooses
  the handler from `Line`: with line mode on, `OnData` alone never starts a
  read.
- **Every async operation owns a `JS_DupValue` of the wrapper.** The job is on
  `socket_jobs`, the reference is invisible to the collector, and it is freed
  on every exit -- the answer, the cancellation, the teardown. That is what
  makes the C struct safe under a completion; the finalizer runs only when
  nothing is in flight. A connected socket therefore keeps itself alive, and
  dropping the last JS reference is not what closes it -- `Close` is.
- **Closing from inside `OnLine` clears the line buffer.** The first version
  removed the measured range *after* the handler, and a handler that closed
  the socket made `socket_close_full` clear the `GByteArray` first, so
  `g_byte_array_remove_range` asserted (`index_ + length <= array->len`).
  Remove the range only while `state == SOCKET_CONNECTED`, re-checked after
  the call.
- **The server owns its connections, but not as JS references.** `clients` is
  a `GPtrArray` of `SocketData *`; a client that the program drops is
  collected and its finalizer removes it, and `Stop` closes the copy of the
  list. The client's `Server` property is the only JS reference, held by the
  client, so the server cannot be finalized while one of its connections is
  alive.
- **A Unix `Socket` connects through `g_socket_client_connect_async` and
  answers with `g_socket_client_connect_finish`.** There is no
  `connect_to_socket_address_async` in `GSocketClient` (the compiler said so);
  `connect_to_host_async`/`_finish` is the TCP road. `g_socket_listener_accept_finish`
  takes `(listener, result, source_object, error)`, not the other way round.
- **`Host: "local"` binds IPv4 loopback only**, through a
  `GInetSocketAddress` for `127.0.0.1`; `"any"` uses
  `g_socket_listener_add_inet_port`, or `add_any_inet_port` when the port is
  `0`. The chosen port is read back into `Port`.
- **A Unix socket file is ours to unlink.** `Stop` and the finalizer remove
  the path a `ServerSocket` created; a path that already exists is refused,
  not removed, because a live server's socket looks exactly like a stale one.
- **A timeout in `tests/widgets` is measured against the whole suite's
  blocking calls.** The socket test passed alone with `Timeout: 3000` and
  connected into its own timeout in the full run: the test loop runs every
  synchronous test inside one `Form_Open` before the loop is back, so the
  completion and the guard were both ready and the guard was dispatched
  first. `testSockets` uses a minute, exactly as `testNetwork` does.
- **An accepted client needs a reference of its own, not only the server's
  list.** The list is `SocketData *` and `OnConnection` frees the local
  `JSValue` when it returns; the first version therefore finalized the client,
  which removed it from `Count`, and the program was left with a connection the
  server had already closed. Each accepted socket holds `keep`, a strong
  reference to its own wrapper, and the server's `gc_mark` marks it; `Close`
  and `Stop` drop it last. Freeing that reference can be what finalizes the
  wrapper, so `socket_close_full` clears `keep` **before** `JS_FreeValue` and
  touches nothing after it.
- **`g_socket_listener_close` before dropping the listener.** The accept in
  flight holds its own reference to the listener, so `g_clear_object` alone
  leaves the port bound until the cancellation is dispatched -- a `Listen`
  right after a `Stop` answered `address already in use`. Closing the listener
  releases the port at once; the completion then sees `s->listener` changed and
  ignores its connection.
- **`Stop` is re-entrant.** Closing a connection raises `OnClosed`, and that
  handler may call `Stop` or `Listen` again. `stopping` makes the nested `Stop`
  a no-op and refuses `Listen` with a sentence until the close sweep is done;
  without it the nested `Listen` started a new listener that the outer sweep
  then cleared, leaving `Listening` true with no socket behind it.
- **A bound `UdpSocket` holds itself alive, for the same reason a server does.**
  The `GSource` that watches the socket is C data and holds no `JSValue`; the
  first version let the wrapper be finalized while the port was still open, and
  the source then fired into freed memory. `keep` is a reference to the wrapper
  while `bound`, the source callback takes another for the length of the
  delivery (a handler may `Close`), and the close drops `keep` **after** the
  source and the socket are gone.
- **`Send` takes an IP address, not a name.** A resolver call on the loop is
  the freeze this file exists to avoid; `Socket` resolves because
  `GSocketClient` does it asynchronously. `UdpSocket.Send("x", "localhost", 1)`
  refuses with that sentence. A caller with a name resolves it where it can
  wait, or uses `Socket` for a stream.
- **A datagram is one `OnData`.** Unlike `Socket`, there is no line mode and no
  chunk arithmetic: `g_socket_receive_from` answers one datagram and `from` is
  its sender as `{ Host, Port }`; `Send(data, from)` is the reply. The local
  port is the one `Bind` read back, which is also what the peer sees as the
  source.
- **`GSocketClient`'s TLS is the system's store and nothing else.** It has
  `set_tls` and deprecated validation flags, but no database and no pinned
  certificate. The client therefore connects plain, wraps the
  `GSocketConnection` with `g_tls_client_connection_new`, sets the CA database
  there, and handshakes before `OnConnected` -- the same shape the server uses.
  A pinned certificate is accepted by setting validation flags to zero and
  comparing `g_tls_connection_get_peer_certificate` with
  `g_tls_certificate_is_same` after the handshake; the CA road leaves the
  library's own chain check on.
- **The connect timeout has to outlive the TCP connection.** It used to be
  removed in `on_connect`, before a TLS handshake could start, so a peer that
  accepted the socket and then said nothing left `Connect` waiting forever. It
  stays armed through the handshake and is removed when that finishes.
- **A TLS connection is two objects.** `SocketData` keeps the raw
  `GSocketConnection` for `LocalHost`/`RemoteHost` and a `GIOStream` for
  reading and writing; a plain socket has both pointing at the same connection
  (two references), a TLS one has the `GTlsClientConnection` or
  `GTlsServerConnection` on top. Closing closes and drops the stream, then the
  raw connection; the read and write jobs compare `src` against the streams,
  so a reconnect cannot accept an old completion.
- **`ServerSocket.Tls` wraps every accepted connection, not the listener.** The
  listener has no TLS of its own: `g_tls_server_connection_new` takes the
  accepted connection and a `GTlsCertificate`, the handshake is asynchronous,
  and the accept loop is re-armed before it finishes so one slow handshake does
  not stop the next client. `Stop` cancels the handshakes through the server's
  cancellable; their completions see `listening` false and drop the connection.
- **`g_tls_file_database_new` takes two arguments**, the file and the error --
  not the `(path, NULL, &err)` shape the other constructors have. And the
  deprecated validation setter is reached with `g_object_set(tls,
  "validation-flags", 0, NULL)` so the build does not warn.
- **`Http.Server` can be a WebSocket-only listener.** `Start` requires
  `Request` **or** `WebSocket`; the early body guard and the HTTP handler are
  added only when `Request` is a function, so a WebSocket server has no HTTP
  route at all. `WebSocket` is the upgrade handler at `/`; the handler itself
  is the open event, and the socket it is handed already has `State: "Open"`.
- **The server holds its WebSocket wrappers in a `GPtrArray` of `JSValue *`,
  not `JSValue`.** A `JSValue` is a struct, which `g_ptr_array_add` cannot
  take; the slot is allocated, duplicated, marked in `gc_mark`, and freed when
  the wrapper closes or the server stops. `http_server_free` and
  `http_server_finish_stop` both call `websocket_server_close_all`; without it
  a `Stop` left the connections open and the wrappers' references behind.
- **libsoup's WebSocket signals are not uniform.** `"message"` is
  `(gint type, GBytes *message)`, `"error"` is `(GError *)`, and `"closed"`
  has **no parameters** -- the close code and reason are read with
  `soup_websocket_connection_get_close_code/data` inside it. A handler that
  assumed a `code, data` signature would take the user data as the code.
- **A client connection keeps itself alive while it is connecting or open, and
  is counted in `bta_http_pending`.** `websocket_live` is what
  `bta_http_cleanup` closes at teardown, since a self-reference is invisible to
  the collector; a console `main` with an open WebSocket does not exit before
  the messages arrive. `Send` queues through
  `soup_websocket_connection_send_message`, whose `GBytes` is transfer none:
  the caller unrefs its own.
- **`Close` starts the close handshake and does not free the connection.** The
  `"closed"` signal is what releases `keep`, the connection and the server's
  array slot; freeing at `Close` would cut the frame that is still queued.
- **SMTP is a line protocol, so the client is JavaScript over `Socket`.**
  `SmtpClient` sets `Line: true`, `EndOfLine: "\r\n"`, walks greeting/EHLO/
  AUTH LOGIN/MAIL/RCPT/DATA/QUIT, and builds the MIME body itself. The DATA
  body is dot-stuffed (`.line` -> `..line`) and ends with `\r\n.\r\n`; a
  message with attachments is `multipart/mixed`, base64 wrapped at 76
  columns. A subject that is not printable ASCII is RFC 2047 encoded, in
  UTF-8 chunks of 45 bytes so no word passes 75 characters and no character
  is split. A reply timeout is armed on every line, so a server that accepts
  the socket and then says nothing is an error rather than a hang.
- **STARTTLS is refused, not half-done.** `Socket` is TLS from the first byte
  or plain; upgrading a live connection mid-stream is a different mechanism.
  `SmtpClient.Tls` accepts `"None"` and `"Tls"` (implicit, port 465) and
  refuses `"StartTls"` with a sentence until that road exists.
- **Credentials are not a `.form` property.** The `SmtpClient` part serialises
  `Host`, `Port`, `Tls`, `From` and `Timeout`; `User` and `Password` are
  getters/setters outside `static Properties`, set in `Form_Open` from
  `Settings` or `Keyring`. The fake server in `testSmtp` is a `ServerSocket`
  with the same line mode, plain and wrapped in `ServerSocket.Tls`.
