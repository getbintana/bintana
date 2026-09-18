# HTTP Server: what is still not built

`Http.Server` is built, documented under `runtime-api.md`'s `## Http Server`
and `llm/library.md`'s, tested by `tests/widgets`' `testHttpServer` and shown
by `examples/serve`. What that leaves is this file: three things the design
deliberately reserved, with the argument for each written down so that
picking one up does not mean having the conversation again.

The stance is the client's, and does not move: callbacks stay canonical, and
there is no `Promise`, `async` or `fetch` to seat anything on. A request
arrives as an event with a handler.

## Deferred answers — the one that is felt

A handler answers before it returns. `on_server_request` gives a `500` to a
handler that returns without answering, and drops its hold on the message
right after, so a later `Answer` throws rather than writing into memory that
is gone.

That is a real limit and the reference says so: a route that must ask a
database, or another server, before it can answer has nowhere to wait. A
`Wait` inside the handler freezes the loop the server itself answers on --
the deadlock `testHttpServer` is written around -- and there is no other way
to spend a turn of the loop and come back.

What it would take: `soup_server_message_pause` / `unpause` exist and were
read. The cost is the one that deferred it: answering later means the request
object outlives the handler, its lifetime owned from C across turns like an
`ExecJob`, and every handler that forgets to answer leaks a connection rather
than logging a `500`. A deadline per request is probably the price of
admission -- the same guard the client's `Timeout` already is.

What it would look like, and what it must not become: an `Answer` that may
arrive later is still one `Answer`, not a promise. `req.Hold()` returning
something the handler stores and answers through later is the shape that
keeps the vocabulary; a handler that returns a value the runtime waits on is
the shape that quietly asks for `Promise` back.

## WebSocket

Reserved, not rejected. `soup_server_add_websocket_handler` exists.

Frames are a second protocol with their own lifetime -- a connection that
outlives every request -- so it is a feature of its own rather than a flag on
this one. It would want its own object, its own events, and its own answer to
what happens when the form that opened it closes. Nothing in the current
surface is in its way.

## CGI/WSGI shapes

Rejected, and the reason is worth keeping: a process per request is `Exec`'s
shape, not this one's. Anybody who wants it can already write it, in the
handler, with the tools that are here.

## What was rejected while building, kept so it is not re-proposed

| Option | Verdict |
|---|---|
| `GSocketService` + hand-rolled HTTP | Rejected. Reinventing soup, the same reason the client did not hand-roll over `GSocketClient`. Parsing, framing, keep-alive and chunked would be ours to get wrong. |
| A QuickJS third-party server module | Rejected. The client's door: a second vocabulary plus `Promise` seating. |
| `Exec(["python3", "-m", "http.server", …])` | Was the workaround, insufficient as API: no routing, no verbs answered on purpose, no status or headers chosen, a process per server. |
| Per-path `Add(path, handler)` registrations | Rejected. Two registration vocabularies for one dispatch: soup paths would live in C while the decision context lives in JS. One door — a single `Request` handler dispatching on `req.Path`, the way events dispatch by name. |

`Server` never spends `Client`'s names, and `Client` never spends its.
