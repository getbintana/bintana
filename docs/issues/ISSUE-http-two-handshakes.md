# ISSUE: a second TLS handshake in one process corrupts the heap

Found while building `Http.Client`'s `Tls` (`ISSUE-http-tls-trust.md`, answered).
**It is not about `Tls`**: it reproduces with a bare `Http.Client()` that was told
nothing at all, and it reproduces in a forty-line project with no test harness.

## What I need

An https **client** and an https **server** in the same process, more than one
connection between them. That is what testing `Tls` requires — a client that can
be told to trust a certificate needs a server presenting one that the system
store does not have — and until a client could be told what to trust, the only
https client this suite had was a `python3` subprocess.

## What happens

The process aborts with

```
malloc(): unaligned tcache chunk detected
```

and the allocation that trips it is the source GLib builds for the **second**
connection's I/O — from a backtrace under gdb:

```
#5  calloc
#6  g_malloc0
#7  g_source_new
#8  g_cancellable_source_new
#9  g_tls_connection_base_create_source      (libgiognutls)
#10 g_tls_input_stream_pollable_create_source
#11 soup_filter_input_stream_create_source   (libsoup-3.0)
#12 soup_message_io_data_get_source
#13 io_run_until_read_async
```

So the corruption is already there and the second handshake is where glibc's
allocator notices. **AddressSanitizer reports nothing**, on the same run that
aborts: `build-asan` green, ordinary build dead.

There is a second, quieter half. Quitting with **one** pooled TLS connection
still open is enough:

```
GLib-CRITICAL **: g_atomic_rc_box_release_full:
                 assertion 'real_box->magic == G_BOX_MAGIC' failed
```

A refcount box released twice, at teardown, on the same shape.

**And `Http.Server.Stop()` is a second road to the same place**, which is
worse: it needs no second connection, only **one accepted** one.

```js
c.Get(url, {}, (r) => {          /* https, answers 200 */
    srv.Stop();                  /* the connection is still pooled on the client */
    srv.Tls = null;
    srv.Start();                 /* -> corrupted double-linked list */
});
```

So both halves of the lifecycle are wrong, and it is not only "many
connections": one connection plus one `Stop()` is enough. That is what keeps
`tests/widgets`' `HttpServer` from asserting the `Tls` feature at all — the step
runs its checks and no request, and the file says which five assertions are
waiting on this.

## The reproducer

`/tmp`-free and dependency-free: a `startup` project, a certificate made with
`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext
subjectAltName=IP:127.0.0.1,DNS:localhost`, and:

```js
class MainForm extends Form {
    Form_Open() {
        const srv = Http.Server({ Port: 0 });
        srv.Request = (req) => req.Answer(200, "hola");
        srv.Start();                                  /* plain http */
        const plain = srv.Url + "hi";

        Http.Client().Get(plain, {}, (r) => {
            srv.Stop();
            srv.Tls = { Cert: "s.crt", Key: "s.key" };
            srv.Start();
            const url = srv.Url + "hi";
            const one = (n, next) => Http.Client().Get(url, {}, () => next(),
                                                         () => next());
            one(1, () => one(2, () => Application.Quit(0)));
        }, () => Application.Quit(1));
    }
}
```

Both requests are **refused** — no `Tls`, no accepted handshake, nothing of the
feature — and it aborts on the second.

Two facts worth keeping, both measured:

- **Two accepted requests on one client do not abort**, because the second reuses
  the pooled connection and never handshakes again. It is a second *handshake*,
  not a second request.
- **An `Http.Server` whose `Tls` is set before `Start()` answers "Connection
  refused"** and serves nothing; the same server serves https after a
  `Stop()`/`Start()` cycle. So the server half has its own bug, or the listener
  is not where `Url` says it is, and it is worth naming separately.

## Why it matters

It is the reason the `Tls` feature's test cannot run on an ordinary build. The
feature itself is **measured working** — its assertions are green under
`build-asan`, and the mechanism was measured end to end in C before it was
written: `SoupMessage::accept-certificate` fires, `g_tls_certificate_verify`
accepts a self-signed certificate the system store rejects, and the request goes
through. What is missing is a heap that survives the second connection.

Everything a real caller does is inside this: a client talking to several
internal servers, or one server with a redirect and two certificates, handshakes
twice.

## Prior art

Nothing to go on. This is not a known GLib or libsoup bug as far as the
distributions' trackers go, and both the `G_BOX_MAGIC` critical and the abort
happen on the way out of a *server* connection, which suggests the session or the
connection is torn down twice rather than freed early. What it looks like from
here: `Http.Client`'s finalizer unrefs two `SoupSession`s, a pooled TLS
connection is still open on one of them, and libsoup's connection teardown runs
under a half-freed refcount. `Http.Server.Stop()` is the other road to the same
place.
