# Http and Tls

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Http

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
