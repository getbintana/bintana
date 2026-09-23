# Http

A native HTTP client, and a server of its own.

`Http.Client(opts)` holds its own session; `Http.Get/Post/…` are shorthands on a
shared default client. Everything has a **callback** spelling and a **blocking**
one, and which to reach for is the first decision on this page.

```js
const c = Http.Client({ BaseUrl: "https://api.example.com/v1", Timeout: 60000 });
c.Get("/users", {}, (r) => print(r.Body.ToText()), (e) => print(e.Message));

const r = Http.GetWait("https://example.com/", { Timeout: 5000 });
```

## Every member

**Making requests**

| | | |
|---|---|---|
| `Client([opts])` | a client with its own session | [the client](#the-client) |
| `Get(url, [opts], onDone, [onError])` | no body | [the verbs](#the-verbs) |
| `Head(url, [opts], onDone, [onError])` | no body, no answer either | [the verbs](#the-verbs) |
| `Delete(url, [opts], onDone, [onError])` | no body | [the verbs](#the-verbs) |
| `Post(url, body, [opts], onDone, [onError])` | with a body | [the verbs](#the-verbs) |
| `Put(url, body, [opts], onDone, [onError])` | with a body | [the verbs](#the-verbs) |
| `Patch(url, body, [opts], onDone, [onError])` | with a body | [the verbs](#the-verbs) |
| `Request(method, url, [body], [opts], onDone, [onError])` | any of the six | [the verbs](#the-verbs) |
| `Stream(method, url, [body], [opts], onLine, [onDone], [onError])` | the answer as it arrives, a line at a time | [following a stream](#following-a-stream) |
| `GetWait(url, [opts])` | the blocking spelling | [waiting](#waiting) |
| `HeadWait(url, [opts])` | likewise | [waiting](#waiting) |
| `DeleteWait(url, [opts])` | likewise | [waiting](#waiting) |
| `PostWait(url, body, [opts])` | likewise, with a body | [waiting](#waiting) |
| `PutWait(url, body, [opts])` | likewise | [waiting](#waiting) |
| `PatchWait(url, body, [opts])` | likewise | [waiting](#waiting) |
| `RequestWait(method, url, [body], [opts])` | likewise, any verb | [waiting](#waiting) |

**On a client**

| | | |
|---|---|---|
| `Auth` | `{ User, Password }`, Basic and preemptive | [the client](#the-client) |
| `BaseUrl` | what a relative path is relative to | [the client](#the-client) |
| `Cookies` | keep a jar of the session's own | [the client](#the-client) |
| `FollowRedirects` | follow a `3xx`. Default `true` | [the client](#the-client) |
| `Headers` | sent with every request of this client's | [the client](#the-client) |
| `Language` | the `Accept-Language` it asks with | [the client](#the-client) |
| `Proxy` | what to go through | [the client](#the-client) |
| `Timeout` | ms; `0` waits forever | [the client](#the-client) |
| `IdleTimeout` | ms a pooled connection idles | [the client](#the-client) |
| `Log` | send the traffic through [`Logger`](Logger.md) | [the client](#the-client) |
| `MaxConns` | how many connections at once. **Constructor-only** | [the client](#the-client) |
| `MaxPerHost` | and how many to one host. Likewise | [the client](#the-client) |
| `UserAgent` | sent as-is; `""` sends none | [the client](#the-client) |

**Uploads and the server**

| | | |
|---|---|---|
| `new Multipart()` | a file upload as a value | [uploads](#uploads) |
| `Field(name, value)` | one text part | [uploads](#uploads) |
| `File(name, filename, body, [contentType])` | one file part | [uploads](#uploads) |
| `Length` (ro) | how many parts | [uploads](#uploads) |
| `Part(index)` | one part read back | [uploads](#uploads) |
| `Server([opts])` | a listener of its own — see [`HttpServer`](HttpServer.md) | [the server](#the-server) |

## The verbs

| | |
|---|---|
| `Get(url, [opts], onDone, [onError])` | the ordinary read |
| `Head(url, [opts], onDone, [onError])` | the headers and no body, for *is it there* and *has it changed* |
| `Delete(url, [opts], onDone, [onError])` | no body |
| `Post(url, body, [opts], onDone, [onError])` | `body` is text, [`Bytes`](Bytes.md), an object (canonical JSON, `application/json`) or a [`Multipart`](#uploads) |
| `Put(url, body, [opts], onDone, [onError])` | the same, for a replacement |
| `Patch(url, body, [opts], onDone, [onError])` | the same, for part of one |
| `Request(method, url, [body], [opts], onDone, [onError])` | any of those six by name; **anything else is refused**, in the blocking spelling too |

`onDone({ Status, Reason, Headers, Body, Url })` — **`4xx` and `5xx` come here**:
they are answers, not failures. `Headers` keys are lower-cased, and `Body` is
always [`Bytes`](Bytes.md), whose `ToText()` is strict UTF-8.

`onError({ Message, Kind, Status })` — `Kind` is `Timeout`, `Dns`, `Tls`,
`Refused`, `Cancelled`, `Redirect` or `Error`. **The kind is there so a program
can answer differently**: a retry, a *check your connection*, a login.

**Both callbacks are handed the request's own handle as a second argument**, so a
form with more than one request in the air can tell whose answer arrived. The
handle answers `Running`, `TimedOut`, `Url`, `Method` and `Stop()` — and
`Stop()` **asks** rather than undoes: a cancelled request still answers a turn
later, with `Kind: "Cancelled"`.

Per-request `opts` carry `Headers`, `Query: {k: v}` (appended escaped), `Body`,
`ContentType`, `Timeout`, `FollowRedirects` and `Auth` — and **naming any of them
is what makes an object options rather than a JSON body**. A `Query` value of
`undefined` or `null` is not sent — `{ page: undefined }` used to go out as
`page=undefined` — and a header or query value that cannot become text is refused
by the call, not skipped with the conversion's error left pending.

A `Post` body is text, `Bytes`, or an object — which is sent as canonical JSON
with `application/json`.

## Following a stream

| | |
|---|---|
| `Stream(method, url, [body], [opts], onLine, [onDone], [onError])` | `onLine(line, handle)` once per text line **as it arrives**, the newline stripped |

The other verbs answer **once, when the response is complete**. A server-sent
event stream is never complete — so read with `Get` it delivers nothing at all
while the feed is running, and read with `Stream` it delivers a line a second.

```js
this.feed = Http.Stream("GET", `${addr}/event`, { Timeout: 0 },
    (line) => { if (line.startsWith("data: ")) this.event(JSON.parse(line.slice(6))); },
    (res)  => this.ended(res),
    (err)  => this.failed(err));
```

Method-first, like `Request`, because a `POST` whose answer arrives in pieces
is the other half of this — it is how a completions endpoint talks — and one
name covers both rather than a `Stream` per verb.

**The end is the usual `onDone`**, with the usual record and an **empty
`Body`**: what already went out line by line is not sent a second time.
`Status`, `Reason`, `Headers` and `Url` are all there.

**Only a `2xx` streams.** A `4xx` or `5xx` is an answer, and its body *is* the
answer — an API's error JSON. So it is read whole and handed to `onDone` the
way `Get` would have, with `onLine` never called. A line arriving at all
therefore means the status was 2xx.

**`Timeout` is the whole flight, not the gap between lines.** A feed meant to
stay open asks with `Timeout: 0`; a client with a `Timeout` of its own cuts one
at its deadline. What arrived before a deadline or a `Stop()` **stays
arrived** — which is exactly what the buffered verbs cannot do, since a
cancelled one answers with no body at all.

**`Stop()` is safe from inside `onLine`**, which is where an application
usually stops following: the line that says the turn ended. The answer still
comes a turn later, as `Kind: "Cancelled"`.

There is **no `StreamWait`**: a blocking spelling that calls back per line
while the loop is frozen is a contradiction. And there is no framing here —
`data:` is one `startsWith`, and teaching `Http` the SSE grammar would drag in
`event:`, `id:`, `retry:` and reconnection while leaving NDJSON and a log tail
second-class. A body that is not valid UTF-8 ends the flight through `onError`
rather than arriving as mojibake, the same bargain `ToText()` makes.

## Waiting

| | |
|---|---|
| `GetWait(url, [opts])` | the blocking `Get` |
| `HeadWait(url, [opts])` | the blocking `Head` |
| `DeleteWait(url, [opts])` | the blocking `Delete` |
| `PostWait(url, body, [opts])` | the blocking `Post` |
| `PutWait(url, body, [opts])` | the blocking `Put` |
| `PatchWait(url, body, [opts])` | the blocking `Patch` |
| `RequestWait(method, url, [body], [opts])` | the blocking `Request` |

The `…Wait` spelling answers with the record and **throws** on transport failure,
and what it throws carries the same `Kind` and `Status` the callback would have
been handed.

It blocks the main loop, so it is for a console tool, a test, or a check that
decides what the next line does — never for a window, where the answer is the
callback form and a [`Spinner`](../widgets/Spinner.md).

## The client

| | |
|---|---|
| `Client([opts])` | a session of its own. **The options are an object — a bare URL is refused** |
| `BaseUrl` | what a relative path in a call is relative to, so the program's requests are one-liners |
| `Headers` | sent with every request this client makes — an API key, an `Accept` |
| `Timeout` | ms before a request is given up on; `0` waits forever |
| `FollowRedirects` | follow a `3xx`. Default `true` |
| `Language` | the `Accept-Language` it asks with |
| `Proxy` | what to go through |
| `Auth` | `{ User, Password }`: Basic, and preemptive. Reads back `null` when none is set. An explicit `Authorization` header wins over it, and an explicit `Content-Type` wins over the one the body's shape implies |
| `Cookies` | `false` unless told; `true` keeps a jar of the session's own, so a login answers the next request |
| `UserAgent` | sent as-is; `""` sends none — and some servers answer the nameless with an error |
| `Log` | `"none"` unless told: `"minimal"`, `"headers"` or `"body"` sends the traffic through [`Logger`](Logger.md) at `Debug`. A `Wait`'s never reaches a `Handler`, since its context is private and its caller is blocked |
| `IdleTimeout` | ms a pooled connection idles before soup closes it (`0` is soup's own 60 s); soup counts seconds, so anything under one becomes one |
| `MaxConns` | how many connections at once, `10` unless told. **Constructor-only**: soup takes it once, so assigning later throws |
| `MaxPerHost` | how many of those to one host, `2` unless told. Likewise |

A client per service — with its base URL, its headers and its auth — is the shape
that keeps a program's requests one-liners.

## Uploads

| | |
|---|---|
| `new Multipart()` | a file upload as a value |
| `Field(name, value)` | one text part; answers the upload, for chaining |
| `File(name, filename, body, [contentType])` | one file part; `body` is text or [`Bytes`](Bytes.md), `application/octet-stream` unless told |
| `Length` (ro) | how many parts |
| `Part(index)` | one read back: `{ Name, Filename, Type, Data }`, `Data` as `Bytes`. Past the end is refused |

Sent as the body of a `Post`/`Put`/`Patch`, which sets **its own**
`Content-Type` with soup's boundary — an explicit one beside it is refused.

## The server

| | |
|---|---|
| `Server([opts])` | a listener of its own, for a static file server, a local API, a callback endpoint. Everything about it is on [`HttpServer`](HttpServer.md) |

## What goes wrong

- **A 404 did not reach `onError`.** It is an answer: `Status` in `onDone`.
- **An object was sent as JSON when options were meant.** Naming an option key
  is what makes it options.
- **`Stop()` did not stop it.** It asks; the answer arrives a turn later as
  `Cancelled`.
- **The window froze.** A `…Wait` in a form.
- **A login did not stick.** `Cookies: true` on the client.
- **`MaxConns` threw.** Constructor-only.
- **`onLine` never fired.** The status was not `2xx`: an error page is an
  answer, not a feed. It is on `onDone`, whole.
- **A streamed `Body` was empty.** It already went out, line by line.
- **A feed stopped after a minute.** The client's `Timeout`. A feed asks
  `Timeout: 0`.
- **`Http` says a package is missing.** libsoup is optional at build time.

## See also

[`Bytes`](Bytes.md) · [`Logger`](Logger.md) ·
[`examples/http`](../../../examples/http) ·
[`examples/jokes`](../../../examples/jokes) ·
[`examples/session`](../../../examples/session) ·
[`examples/serve`](../../../examples/serve)
