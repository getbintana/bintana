# HttpServer

Serving over the same transport, on the loop the application already runs.

A static file server, a local API, an endpoint something else calls back — with
no second process and no framework.

```js
const srv = Http.Server({ Port: 0 });   // 0 is ephemeral: read it back
srv.Request = (req) => {
    if (req.Path === "/hi") req.Answer(200, "hola");
    else req.Answer(404, "nope");
};
srv.Start();
```

## Every member

**The server**

| | | |
|---|---|---|
| `Allow` | a list of exact IPs, or nothing | [who may reach it](#who-may-reach-it) |
| `Auth` | `{ Realm, Users }`: Basic over the whole server | [who may reach it](#who-may-reach-it) |
| `Host` | `"local"` or `"any"` | [listening](#listening) |
| `Port` | declared until `Start`, actual after | [listening](#listening) |
| `Request` | assign `(req) => …`; **required before `Start`** | [answering](#answering) |
| `Running` | whether it is listening | [listening](#listening) |
| `ServerName` | the `Server:` header | [listening](#listening) |
| `Start()` | listens | [listening](#listening) |
| `Stop()` | stops | [listening](#listening) |
| `Tls` | `{ Cert, Key }` files, or nothing | [listening](#listening) |
| `Url` | `""` until `Start`, and empty again after `Stop` | [listening](#listening) |

**The request**

| | | |
|---|---|---|
| `Answer(status, [body], [opts])` | the answer, **before the handler returns** | [answering](#answering) |
| `Body` | always [`Bytes`](Bytes.md) | [what arrived](#what-arrived) |
| `Headers` | lower-cased | [what arrived](#what-arrived) |
| `Method` | `GET`, `POST`, … | [what arrived](#what-arrived) |
| `Multipart()` | → the upload parsed | [what arrived](#what-arrived) |
| `Path` | the path, dot-segments already normalised | [what arrived](#what-arrived) |
| `Query` | the query string as an object | [what arrived](#what-arrived) |
| `Remote` | the caller's IP | [what arrived](#what-arrived) |

## Listening

| | |
|---|---|
| `Port` | `8080` unless told; **`0` is ephemeral** — read it back after `Start` to learn which one it got, which is how a test or a one-off tool avoids fighting for a number |
| `Host` | `"local"` is loopback only and the default; **`"any"` is an explicit word**, because opening a port to the network should be something somebody typed |
| `ServerName` | the `Server:` header; `""` for soup's own |
| `Tls` | `{ Cert, Key }` files, or nothing: `https` when set, `null` when not. **Missing files fail at `Start`, naming them** |
| `Start()` | listens; throws naming the reason — a busy port says which one. A second `Start` is refused |
| `Stop()` | `true` while something was listening, `false` after — like signalling a reaped child |
| `Running` | whether it is |
| `Url` | `""` until `Start`, the real one after, and empty again after `Stop` |

A listening server **counts like a watch**: a console project that returned from
`main` with one running stays alive for its requests. Dropping it without
`Stop()` disconnects.

## Who may reach it

| | |
|---|---|
| `Allow` | a list of **exact** IPs, or nothing (open). A refused remote gets `403` before the handler runs. Exact means exact: on a dual-stack `"any"` server, `::1` is not `127.0.0.1` |
| `Auth` | `{ Realm, Users }`: Basic over the whole server, `401` with the realm until the right password. Nothing set is open, and it reads back `null`. Like `Allow`, it takes effect at once |

## Answering

| | |
|---|---|
| `Request` | assign `(req) => …`. **Required before `Start`**, and replaceable while running — even from inside the handler: the running one finishes its request and the next goes to the new one |
| `Answer(status, [body], [opts])` | `body` follows the client's rules — an object serialises as canonical JSON — and `opts` carries `Headers` and `ContentType`. **The second argument is always the body and the third always the options** |

**The handler answers before it returns.** There is no deferred answer, so a
route that must ask a database or another server first has nowhere to wait: a
`…Wait` inside the handler freezes the loop the server answers on, and returning
to answer later gets the `500`. A second `Answer`, or a late one, is refused —
the request was already answered, or already ended.

Why that is so, and what else was deliberately left out — WebSocket, CGI shapes
— is in [../../plans/http-server-plan.md](../../plans/http-server-plan.md), with the argument for
each.

## What arrived

| | |
|---|---|
| `Method` | `GET`, `POST`, … |
| `Path` | the path — **dot-segments are already normalised by soup**, which is why a ten-line static server needs no `".."` refusal of its own |
| `Query` | the query string as an object; a repeated key keeps one |
| `Headers` | lower-cased, like the client's answers |
| `Body` | always [`Bytes`](Bytes.md) |
| `Remote` | the caller's IP — what `Allow` compares against |
| `Multipart()` | the upload parsed: a `Multipart` to read with `Part(index)`, or to re-post. **Refused on a plain body** |

## What goes wrong

- **`Start` threw.** The port is busy — it says which — or a TLS file is missing.
- **Every request got a `500`.** A handler that returned without answering.
- **A `…Wait` inside the handler froze everything.** The server answers on the
  same loop.
- **`Url` was empty.** Before `Start`, or after `Stop`.
- **`Allow` let nobody in on a dual-stack server.** `::1` and `127.0.0.1` are
  different addresses.
- **A console tool exited immediately.** It does not, while a server is
  listening — but it also never returns on its own.

## See also

[`Http`](Http.md) · [`Bytes`](Bytes.md) ·
[`examples/serve`](../../../examples/serve) ·
[../../plans/http-server-plan.md](../../plans/http-server-plan.md)
