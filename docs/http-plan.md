# HTTP: a plan, not a feature

**Nothing in this document is implemented.** It is the design for a native HTTP
client over `libsoup3`, written down so that picking it up does not mean having
the conversation again. The stance is the same as `data-plan.md` (deferred with
foundations named) and `async-plan.md` (one decision, one deferral): callbacks
stay canonical, no `Promise`/`async`/`fetch`.

Status today, triple-affirmed: `llm/library.md#others` (*no HTTP client, use
`Exec(["curl",…])` and say so out loud*), `llm/issues.md` (*No network client
of any kind* — an open gap, not a refusal), `async-plan.md` (*Network is by far
the most likely trigger to reopen asynchrony*). There is no `fetch`, no socket,
no `require` in the language (`runtime-api.md`, `llm/language.md`).

## Why libsoup3, and what was rejected

`vendor/quickjs` (quickjs-ng) carries **no network**: the only `fetch` in the
tree is `atomic_fetch_*` (C atomics). It is a JS engine, not a platform. Any
"native but wrapped" fetch still needs a C transport plus reintroducing
`Promise`, microtasks (`bta_runtime.c` does not even pump them), `Response` /
`Request` / `Headers` / body streams / `AbortController` — four concepts for
~eleven single-callback call sites, against the measured argument in
`async-plan.md`. It also hides the seam `Exporter` relies on to stay testable.

| Option | Verdict |
|---|---|
| WHATWG `fetch` in JS over QuickJS | Rejected. Spec weight + `Promise` + streams + abort. Breaks the callback preference and the testable-seam argument. |
| Third-party QuickJS http module | Rejected, same reason by another door. |
| `Exec(["curl",…])` (today's workaround) | Kept as today, insufficient as API: UTF-8 lines only (`communicate_utf8` + `DataInputStream`), no status/headers/binary, one process per request, poor error mapping. |
| `libcurl` | Rejected. Synchronous core + threads of our own, certs/proxy outside GIO, clumsier main-loop integration. |
| Raw `GSocketClient` + hand HTTP | Rejected. Reinventing soup. |
| **`libsoup3` (measured 3.6.6, glib 2.88.3)** | **Chosen.** GIO async fits the callback model, `GCancellable` maps to `Stop()`, TLS/proxy/auth from GNOME, streaming to `Bytes`, no `Promise`. New optional `pkg_check_modules` like `SQLITE3`/`SYSTEMD`, both installed here (`libsoup-3.0 3.6.6`, `libcurl 8.18.0` present but unused). |

## The name: `Http`, with `Client` inside it

`Http` as a bare singleton doing `Get/Post` would waste the generic and block
`Server`, isolated sessions, and per-client jars. The runtime already answers
this shape twice: `Database` (always present, `Database.Sqlite(path)` makes a
connection) and `Timer.After` beside `new Timer` (shorthand beside the class;
the future `Process` proposal follows it).

```js
Http                         // namespace, always present (without libsoup it throws when called)
Http.Client(opts)            // -> client holding its own SoupSession
Http.Get/Post(...)           // shorthands on a shared default client
// tomorrow: Http.Server(...) hangs beside Client, like Database.Sqlite never spent Database
```

Phase 1 may ship only the shorthands, documented from day one as *the shared
client*, so `Http.Client()` later is no breaking change.

## Surface (closed)

```js
const c = Http.Client({ BaseUrl: "https://api.example.com/v1",
  Headers: { Accept: "application/json" }, Timeout: 60000,
  IdleTimeout: 60000, UserAgent: "Bintana/1.0", Language: "es",
  Proxy: "default", Auth: { User, Password },
  FollowRedirects: true, MaxConns: 10, MaxPerHost: 2 });

c.Request("GET", "/users", [opts], onDone, [onError]);
c.Get("/users", [opts], onDone, [onError]);
c.Post("/users", body, [opts], onDone, [onError]);
c.Put/Patch/Delete/Head(...)                  // same shape (phase 1: Get+Post+Request suffice)
c.GetWait(url, [opts]); c.PostWait(url, body, [opts]); c.RequestWait(...);

Http.Get(url, [opts], onDone, [onError]);     // default shared client
Http.GetWait(url, [opts]);
```

Two callbacks, `Exec`-style (recommended over Node `(err,res)`): `4xx/5xx` go
to `onDone` (it is an answer), transport/DNS/TLS/timeout go to `onError`.

```js
onDone({ Status: 200, Reason: "OK",
         Headers: { "content-type": "..." },  // lower-cased keys, soup is case-insensitive
         Body: Bytes,                          // always Bytes
         Url: "final URL after redirects" });
onError({ Message: "Http.Get: cannot reach '...': timeout after 5000ms",
          Kind: "Timeout|Dns|Tls|Refused|Cancelled|Redirect", Status: 0 });
h = c.Get(...); h.Running; h.TimedOut; h.Url; h.Method; h.Stop(); // -> bool
```

`Body` is always `Bytes`: text via `Body.ToText()` (strict UTF-8, throws, never
replacement char), JSON via `JSON.parse` + `Record.Load`, binary via
`File.SaveBytes` / `Hash.Sha256(Bytes)`. No dual `Body/Text`. An object passed
as `body` serialises canonical (`JSON.stringify(v,null,2)+"\n"`, the
`File.SaveJson` shape) with `application/json`. Defaults otherwise:
text → `text/plain;charset=utf-8`, `Bytes` → `application/octet-stream`.

### Client vs. request: where each knob lives

Measured in `libsoup/soup-session.h` + live instance: `timeout 60`,
`idle-timeout 60`, `max-conns 10`, `max-conns-per-host 2`, `user-agent None`,
`accept-language None/auto False`, `proxy-resolver GLibproxyResolver`,
`tls-database GTlsDatabaseGnutls`, `AuthManager + ContentDecoder` on.
`soup-message.h:76-101` flags: `NO_REDIRECT, NEW_CONNECTION, IDEMPOTENT,
DO_NOT_USE_AUTH_CACHE, COLLECT_METRICS`.

| Level | Knobs |
|---|---|
| `Http.Client(opts)` (session) | `BaseUrl` (ours; absolute URL wins; `/a/`+`/b`=`/a/b`), `Headers` (defaults, request merges and wins), `Timeout` ms (our guard+cancel; soup `timeout` stays 60s for new conns), `IdleTimeout`, `UserAgent`, `Language` (→ `Accept-Language`), `Proxy: "default"` (system resolver) `\| null` (off; URL string → phase 2 via `GSimpleProxyResolver`), `Auth {User,Password}`, `FollowRedirects: true` (→ inverted `NO_REDIRECT`), `MaxConns/MaxPerHost` (**constructor-only**, soup construct-only; assigning later throws), `Cookies: false` (phase 2 → per-client `CookieJar`), `Log: "none"` (phase 3 → `SoupLogger`) |
| Per request `opts` | `Headers` (merge), `Query: {k:v}` (appended escaped to `?url`), `Body`, `ContentType`, `Timeout` (our guard only, does not retune the session), `Auth`, `FollowRedirects` (request wins via flag) |
| Deliberately session-only | `Proxy`, `MaxConns`, `Cookies` — exposing them per request would lie (same reason merged output never invents `"out"`) |
| Phase 2/3 | `multipart` (`soup_message_new_from_multipart` exists), `NEW_CONNECTION` debug flag, auth-cache opt-out, metrics, `Server` |

Mutable after creation: `BaseUrl, Headers, Timeout, IdleTimeout, UserAgent,
Language, Proxy, Auth, FollowRedirects`. Construct-only: `MaxConns,
MaxPerHost`. Credentials come from code/`Settings`, never `.form` (the
`data-plan.md` rule: a password in the tree is a password in version control).
TLS stays strict system (`tls-database`); no insecure flag in phase 1 —
verification failures name the certificate via
`tls-peer-certificate-errors`. Redirect overflow
(`TOO_MANY_REDIRECTS/NO_LOCATION/BAD_URI`) maps to `onError Kind:"Redirect"`.

### Rules copied from `Exec`/`Dialog`

* Callback required, refused before anything starts (`a callback is required:
  http is async`), like `Dialog`. Every refusal names the offender
  (`'GETT' is not one of GET, POST, ...`, `Headers must be an object`).
* Cancel calls `onError Kind:"Cancelled"`, never silence — like `Exec` still
  calls exit with `-1` after `Stop`. `Wait` throws on transport failure and
  returns the record on `404/500`, like `File.Load` throws when unreadable.
* `argv never a shell string` → URL is a string, query an object; values are
  bound/escaped, never interpolated (the `Table.Where("name = ?",…)` rule).

### Cancellation: a form cancelling a slow call

Yes — through the handle, not by passing a raw `GCancellable` to JS.

* Each request owns one `GCancellable`, passed to
  `soup_session_send_and_read_async` (`g_cancellable_cancel` is thread-safe).
  Nothing raw crosses the boundary, same as `Exec` never hands out a pid to
  signal: `h.Stop()` (→ bool) is the verb, `Kill` needs no twin (no process
  group to reach).
* `Stop()` cancels one live request → `Running=false`, `TimedOut` stays
  `false`, `onError {Kind:"Cancelled"}`. The guard path instead sets
  `TimedOut=true` + `onError {Kind:"Timeout"}` — so user-cancel and timeout
  are distinguishable, the `Exec` mold (`Stop` leaves `TimedOut` false).
  `Stop()` on a finished job answers `false`, like signalling a reaped child.
* A form keeps the handle and stops it, from a button or from `Form_Close`
  (jobs are global like `Exec`/`Watch`, not auto-cancelled with the form, and
  the callbacks close over `this`):

```js
Form_Open() {
    this._req = this._api.Get("/slow-report", {}, (r) => this.show(r), (e) => this.showError(e));
}
BtnCancel_Click() { if (this._req) this._req.Stop(); }
Form_Close() {
    if (this._req && this._req.Running) this._req.Stop();
}
```

* Cancelling N requests needs no new C for the common case: keep the handles
  and loop `Stop()`. A shared cancel scope (one token cancelling a group
  atomically) is phase 2 **waiting for a caller** — the `data-plan.md`
  doctrine: `Watch`/`Exec` already prove one handle per job is enough until a
  screen fires list+detail together and wants one button for both.
* `Wait` has no `Stop`: nothing runs inside the block (the `Exec.Wait` honesty
  — no nested loop, no handler closing the form under the caller), so the
  only ending the caller controls is `Timeout`.

## C implementation

* `CMakeLists.txt`: `pkg_check_modules(SOUP IMPORTED_TARGET libsoup-3.0)` +
  `target_link_libraries PRIVATE PkgConfig::SOUP` + `BTA_HAVE_SOUP=1`,
  messaging `libsoup X: Http is available / no libsoup: Http will say so when
  called` — the `SQLITE3`/`SYSTEMD` pattern.
* New `runtime/src/bta_http.c` (`bta.h`: `bta_http_init/cleanup/pending`),
  wired in `install_globals` beside `bta_sys_init`. No `rad.js` facade —
  members must be literal for `tests/api/Check.js` (no generated loops).
* `HttpJob {ctx, on_done, on_error, handle, msg, cancellable, guard, id,
  timed_out}` in a `GList`. Copy `exec_job_free` order (sources →
  `FreeValue` → unref), `JS_DupValue` at creation, `bta_dump_error` +
  `bta_drain_jobs` after every `JS_Call`, `Stop()` by internal `id` (never a
  reusable URL/pid — `exec_signal` mold; soup `cancellable` is per job, so no
  `KillAfter`/process-group stage).
* Sessions: one shared default + one `SoupSession` per `Client`
  (`soup_session_new()`; settable props above; `abort()` only at cleanup).
  Request: `soup_message_new(method, url+?Query)` (`SOUP_METHOD_*` + free
  string), request headers `append/replace` from `Dictionary`, body
  `set_request_body_from_bytes(content_type, GBytes)` built from
  `bta_bytes_get` / UTF-8 text / canonical JSON.
* Async: `soup_session_send_and_read_async(sess,msg,PRIORITY_DEFAULT,
  cancellable,cb,job)` — fires on the thread-default context (GIR doc), the
  same loop as `Exec`/`Dialog`, no private context. Finish:
  `send_and_read_finish()->GBytes` → `bta_bytes_new` (copies);
  `get_status/get_reason_phrase`; response headers `foreach` → object.
* Guard: `g_timeout_add(Timeout)` → `TimedOut=true` on handle +
  `g_cancellable_cancel()`.
* `Wait`: like `Exec.Wait` — own `GMainContext`, `push_thread_default`
  **before** `send`, synchronous `send_and_read`, `late→cancel` loop. Takes no
  callbacks (`Http.GetWait takes no callbacks...`).
* `#else` without `BTA_HAVE_SOUP`: register `Http` anyway, throw `built
  without libsoup... install libsoup3 devel and build again` — the
  `bta_sqlite.c`/`bta_journal.c` mold. Account in `bta_sys_pending`-style
  pending so a `main` project waits for in-flight requests; cancel all in
  cleanup (early-return on `CANCELLED`, teardown already freed).

## Docs, checks, tests, examples

* `docs/runtime-api.md ## Http` (long: example, options table, handle,
  honest limits: `404 goes to onDone`, `Wait freezes`, `cancel calls onError
  Cancelled`, `credentials never in .form`) + `docs/llm/library.md ## Http`
  (short table). Remove `no HTTP client...curl` in both `Others`.
  `language.md` unchanged (still no `Promise/fetch`). `AGENTS.md`: one measured
  trap + globals-table row. `docs/testing.md`: counts.
* `tests/api/Check.js`: `http_props:"Http"` in `GLOBAL_TABLES` (or `http:"Http"`
  in `VARS` by shape) — without the line the check deliberately sees nothing.
  `tests/api.sh` must stay green.
* Tests against `127.0.0.1` only (`python3 -m http.server` via `Exec`, zero
  external net): `testHttpWait` sync early like `ExecWait` (status/headers/
  `Bytes`/`ToText`/JSON→`Record`, `404→onDone`, refusals, `Timeout` with
  `Date.now`, `Query`, `Auth`); `testHttp` async via `until/waiting`
  (`Running`, `Stop true/false`, `Cancel→onError`, binary `Sha256`,
  redirect). Obey `Form_Open try/catch`, `Application.OnError` around
  deliberate throws, `Visible=false` for windowed children.
* `examples/http`: `GET json → TableView` + `POST` (showing the `show/read`
  guards, `Validate` vs `Problems` discipline).

## Staging

1. `Client + Request/Get/Post + GetWait + Timeout/Stop`. 2. Remaining verbs,
   `BaseUrl/Language/Proxy-null/Auth`. 3. Cookies, multipart, logger,
   `Server` reserved. The other half (if the network ever forces sequencing:
   login→list→detail, parallel, progress+sequence — `async-plan.md` triggers)
   goes **on top** as a `Done(cb)` protocol over the job (the 30-line
   generator prototype already proven), with `Wait` covering tools. `Promise`
   stays uninstalled; any future wrapper promisifies `Done`, never replaces
   the callbacks.
