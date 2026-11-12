# HTTP Server: what is still not built

`Http.Server` is built, documented under `runtime-api.md`'s `## Http Server`
and `llm/library.md`'s, tested by `tests/widgets`' `testHttpServer` and shown
by `examples/serve`. What that leaves is this file: the one thing the design
deliberately reserved, with the argument written down so that picking it up
does not mean having the conversation again.

Two of the three are built since: a deferred answer is `req.Hold()`, and
WebSocket is `Http.Server.WebSocket` with the `WebSocket` client and
server-side connection (see [`transports-plan.md`](transports-plan.md)).

The stance is the client's, and does not move: callbacks stay canonical, and
there is no `Promise`, `async` or `fetch` to seat anything on. A request
arrives as an event with a handler.

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
