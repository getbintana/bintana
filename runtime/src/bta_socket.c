/*
 * Socket and ServerSocket -- TCP and Unix domain sockets on the main loop.
 *
 * The design is docs/plans/transports-plan.md (stage 1), and the shape is
 * Gambas' `Socket`/`ServerSocket` with Bintana's events: no promise, no
 * `await`, no blocking read.  Every wait is a callback on the loop the
 * program already runs, so a scale that is slow to answer does not freeze
 * the window.
 *
 * ## The rules worth writing down
 *
 * **TCP is a stream, not a message.** `OnData` hands the bytes one read
 * returned; two writes can arrive as one chunk and one write as two.  A
 * program that treats a chunk as a frame is wrong, and the reference says
 * so.  `Line: true` is the only framing this file does; it buffers and
 * raises `OnLine` for each complete `EndOfLine`.
 *
 * **A write never blocks.** `Write` queues a `GBytes` and starts one
 * `g_output_stream_write_all_async` at a time; `OnWritable` says the queue
 * is empty.  A write on a closed socket throws now, because that is a
 * programming mistake and not an answer that arrives later.
 *
 * **A connected socket keeps itself alive.** Every async operation holds a
 * `JS_DupValue` of the wrapper in its job -- invisible to the collector and
 * freed on every exit path -- so the C struct cannot be freed under a
 * completion.  Closing cancels the operations and lets their completions
 * free the references; the finalizer therefore runs only when nothing is in
 * flight.
 *
 * **The server owns its connections.** An accepted `Socket` points back at
 * its `ServerSocket` (`Server`), and the server keeps a raw list of the live
 * ones so `Stop` can close them and `Count` can answer.  The list is not a
 * JS reference: a client that the program drops is collected, and its
 * finalizer takes it out of the list.
 *
 * **Unix sockets are Unix.** `Path` on Windows refuses with a sentence and
 * names the portable road (`Ipc.Pipe`, once it exists); the TCP half is the
 * same code on every platform.
 */
#include "bta.h"

#include <gio/gio.h>
#include <glib/gstdio.h>
#include <string.h>

#ifdef G_OS_UNIX
#include <gio/gunixsocketaddress.h>
#endif

/* One read.  Big enough for a socketpair and a serial frame; the kernel
 * gives what it has, and `OnData` is called once per answer. */
#define SOCKET_CHUNK 65536

/* A line that never ends is a peer that is not speaking the protocol.  The
 * cap is the same order as the HTTP client's body guard, and it turns an
 * unbounded `GByteArray` into an error instead of a program that grows until
 * the machine stops. */
#define SOCKET_LINE_MAX (1024 * 1024)

typedef enum {
    SOCKET_CLOSED,
    SOCKET_CONNECTING,
    SOCKET_CONNECTED,
} SocketState;

typedef struct SocketData  SocketData;
typedef struct ServerData  ServerData;

struct SocketData {
    JSContext *ctx;
    JSValue    self;          /* BORROWED: the wrapper owns this struct */
    JSValue    keep;          /* accepted sockets: a strong reference to self */
    JSValue    on_connected;
    JSValue    on_data;
    JSValue    on_line;
    JSValue    on_closed;
    JSValue    on_error;
    JSValue    on_writable;

    char      *host;          /* the configured host, or the peer's for an accepted socket */
    int        port;
    char      *path;          /* Unix socket path; "" for TCP */
    int        timeout;       /* connect guard in ms; 0 is none */
    bool       line;
    char      *eol;

    SocketState state;
    bool        in_live;
    bool        closed_emitted;
    bool        timed_out;
    bool        reading;
    bool        writing;

    GSocketClient     *client;
    GSocketConnection *conn;
    GIOStream         *stream;  /* conn itself, or a TLS wrapper; owned */
    GInputStream      *in;      /* borrowed from stream */
    GOutputStream     *out;     /* borrowed from stream */
    GCancellable      *cancel;
    guint              timeout_id;

    /* `Tls`: the trust the client was configured with, kept across connects
     * and freed by the finalizer, not by Close. */
    bool             tls;
    GTlsDatabase    *tls_db;
    GTlsCertificate *tls_cert;
    char            *tls_ca_path;
    char            *tls_cert_path;

    char      *local_host;
    int        local_port;
    char      *remote_host;
    int        remote_port;

    GQueue    *writes;        /* GBytes *, owned */
    GByteArray *linebuf;

    ServerData *server;       /* BORROWED: the listener that accepted us */
    JSValue     server_val;   /* the listener's wrapper, duplicated */
};

struct ServerData {
    JSContext *ctx;
    JSValue    self;          /* BORROWED */
    JSValue    on_connection;
    JSValue    on_error;

    char      *path;
    bool       local;         /* "local" (loopback) or "any" */
    int        port;
    bool       listening;
    bool       in_live;
    bool       owns_path;     /* the Unix socket file is ours to unlink */
    bool       stopping;      /* Stop is closing connections; Listen waits */

    GSocketListener *listener;
    GCancellable    *cancel;
    GPtrArray       *clients; /* SocketData *, BORROWED; removed by the client */

    /* `Tls`: the certificate every accepted connection is wrapped with. */
    GTlsCertificate *tls_cert;
    char            *tls_cert_path;
    char            *tls_key_path;
};

/* A datagram socket.  It has no connection and no close event: it is a local
 * port that receives datagrams and a call that sends one.  `keep` holds the
 * wrapper while the socket is bound, because the GSource that watches it is C
 * data and the program may drop the last JS reference without meaning to stop
 * receiving. */
typedef struct {
    JSContext *ctx;
    JSValue    self;          /* BORROWED */
    JSValue    keep;          /* bound: a reference to self */
    JSValue    on_data;
    JSValue    on_error;

    char      *host;          /* "local" or "any" */
    int        port;
    bool       broadcast;
    bool       bound;
    bool       in_live;

    GSocket *sock;
    GSource *source;
} UdpData;

typedef enum {
    JOB_CONNECT,
    JOB_READ,
    JOB_WRITE,
    JOB_ACCEPT,
    JOB_TLS_CLIENT,
    JOB_TLS_SERVER,
} JobKind;

/* One async operation.  Every one is on `socket_jobs` so teardown can free
 * what has not answered yet; `ref` is the reason the wrapper is still alive
 * while the completion is possible. */
typedef struct {
    JobKind    kind;
    JSContext *ctx;
    JSValue    ref;
    void      *owner;
    guint8    *buf;           /* read */
    GBytes    *bytes;         /* write */
    GSocketConnection *conn;  /* TLS server: the raw connection */
    GIOStream *stream;        /* TLS: the wrapper, owned */
    bool       is_unix;       /* connect */
} SocketJob;

static GList     *socket_jobs;
static GList     *socket_live;    /* SocketData *, connected or connecting */
static GList     *server_live;    /* ServerData *, listening */
static GList     *udp_live;       /* UdpData *, bound */
static JSClassID  socket_class_id;
static JSClassID  server_class_id;
static JSClassID  udp_class_id;

static void socket_close_full(SocketData *s, bool emit, bool finalizing);
static void server_stop_full(ServerData *s, bool emit, bool finalizing);
static void udp_close_full(UdpData *s, bool finalizing);
static void socket_start_read(SocketData *s);
static void socket_write_start(SocketData *s);
static void server_accept(ServerData *s);
static void on_read(GObject *src, GAsyncResult *res, gpointer data);
static void on_write(GObject *src, GAsyncResult *res, gpointer data);
static void on_accept(GObject *src, GAsyncResult *res, gpointer data);
static gboolean on_udp_ready(GSocket *sock, GIOCondition cond, gpointer data);
static void on_tls_handshake(GObject *src, GAsyncResult *res, gpointer data);
static JSValue socket_from_connection(JSContext *ctx, GSocketConnection *conn,
                                      GIOStream *stream, ServerData *server);

/* --------------------------------------------------------------- utilities */

static gsize find_bytes(const guint8 *hay, gsize n,
                        const guint8 *needle, gsize m)
{
    if (m == 0)
        return 0;
    if (n < m)
        return (gsize)-1;
    for (gsize i = 0; i + m <= n; i++)
        if (hay[i] == needle[0] && memcmp(hay + i, needle, m) == 0)
            return i;
    return (gsize)-1;
}

static char *socket_where(SocketData *s)
{
    if (s->path && *s->path)
        return g_strdup(s->path);
    return g_strdup_printf("%s:%d", s->host && *s->host ? s->host : "?", s->port);
}

static JSValue socket_error(JSContext *ctx, const char *who, const char *kind,
                            const char *detail)
{
    JSValue e = JS_NewObject(ctx);
    char   *msg = g_strdup_printf("%s: %s", who, detail);

    JS_SetPropertyStr(ctx, e, "Message", JS_NewString(ctx, msg));
    JS_SetPropertyStr(ctx, e, "Kind", JS_NewString(ctx, kind));
    g_free(msg);
    return e;
}

static const char *socket_kind_for(const GError *err, bool timed_out)
{
    if (timed_out)
        return "Timeout";
    if (!err)
        return "Error";
    if (err->domain == G_RESOLVER_ERROR)
        return "Dns";
    if (err->domain == G_TLS_ERROR)
        return "Tls";
    if (err->domain == G_IO_ERROR) {
        switch (err->code) {
        case G_IO_ERROR_HOST_NOT_FOUND:
            return "Dns";
        case G_IO_ERROR_CONNECTION_REFUSED:
            return "Refused";
        case G_IO_ERROR_TIMED_OUT:
            return "Timeout";
        case G_IO_ERROR_NETWORK_UNREACHABLE:
        case G_IO_ERROR_HOST_UNREACHABLE:
            return "Unreachable";
        case G_IO_ERROR_PERMISSION_DENIED:
            return "NotAllowed";
        case G_IO_ERROR_CANCELLED:
            return "Cancelled";
        default:
            break;
        }
    }
    return "Error";
}

/* --------------------------------------------------------------- the jobs */

static void job_free(SocketJob *j)
{
    socket_jobs = g_list_remove(socket_jobs, j);
    g_free(j->buf);
    if (j->bytes)
        g_bytes_unref(j->bytes);
    if (j->conn)
        g_object_unref(j->conn);
    if (j->stream)
        g_object_unref(j->stream);
    /* Last: freeing this may finalize the owner, and nothing here reads it
     * after. */
    JS_FreeValue(j->ctx, j->ref);
    g_free(j);
}

static SocketJob *job_new(JobKind kind, JSContext *ctx, JSValue ref, void *owner)
{
    SocketJob *j = g_new0(SocketJob, 1);

    j->kind  = kind;
    j->ctx   = ctx;
    j->ref   = JS_DupValue(ctx, ref);
    j->owner = owner;
    socket_jobs = g_list_prepend(socket_jobs, j);
    return j;
}

static void socket_live_add(SocketData *s)
{
    if (!s->in_live) {
        s->in_live = true;
        socket_live = g_list_prepend(socket_live, s);
    }
}

static void socket_live_remove(SocketData *s)
{
    if (s->in_live) {
        s->in_live = false;
        socket_live = g_list_remove(socket_live, s);
    }
}

static void server_live_add(ServerData *s)
{
    if (!s->in_live) {
        s->in_live = true;
        server_live = g_list_prepend(server_live, s);
    }
}

static void server_live_remove(ServerData *s)
{
    if (s->in_live) {
        s->in_live = false;
        server_live = g_list_remove(server_live, s);
    }
}

static void udp_live_add(UdpData *s)
{
    if (!s->in_live) {
        s->in_live = true;
        udp_live = g_list_prepend(udp_live, s);
    }
}

static void udp_live_remove(UdpData *s)
{
    if (s->in_live) {
        s->in_live = false;
        udp_live = g_list_remove(udp_live, s);
    }
}

/* ------------------------------------------------------------- the events */

/* Hold the wrapper, and the handler, across their own call: a handler may
 * replace itself and drop the last outside reference.  `argv` belongs to the
 * caller. */
static void socket_emit(SocketData *s, JSValueConst fn, int argc,
                        JSValueConst *argv)
{
    if (!JS_IsFunction(s->ctx, fn))
        return;

    JSValue self = JS_DupValue(s->ctx, s->self);
    JSValue call = JS_DupValue(s->ctx, fn);
    JSValue r    = JS_Call(s->ctx, call, self, argc, argv);

    if (JS_IsException(r))
        bta_dump_error(s->ctx);
    JS_FreeValue(s->ctx, r);
    JS_FreeValue(s->ctx, call);
    JS_FreeValue(s->ctx, self);
    bta_drain_jobs(JS_GetRuntime(s->ctx));
}

static void server_emit(ServerData *s, JSValueConst fn, int argc,
                        JSValueConst *argv)
{
    if (!JS_IsFunction(s->ctx, fn))
        return;

    JSValue self = JS_DupValue(s->ctx, s->self);
    JSValue call = JS_DupValue(s->ctx, fn);
    JSValue r    = JS_Call(s->ctx, call, self, argc, argv);

    if (JS_IsException(r))
        bta_dump_error(s->ctx);
    JS_FreeValue(s->ctx, r);
    JS_FreeValue(s->ctx, call);
    JS_FreeValue(s->ctx, self);
    bta_drain_jobs(JS_GetRuntime(s->ctx));
}

/* -------------------------------------------------------------- addresses */

static void address_text(GSocketAddress *a, char **host, int *port)
{
    *host = g_strdup("");
    *port = 0;
    if (!a)
        return;

    if (G_IS_INET_SOCKET_ADDRESS(a)) {
        GInetAddress *ia = g_inet_socket_address_get_address(G_INET_SOCKET_ADDRESS(a));

        g_free(*host);
        *host = g_inet_address_to_string(ia);
        *port = g_inet_socket_address_get_port(G_INET_SOCKET_ADDRESS(a));
        return;
    }

#ifdef G_OS_UNIX
    if (G_IS_UNIX_SOCKET_ADDRESS(a)) {
        g_free(*host);
        *host = g_strdup(g_unix_socket_address_get_path(G_UNIX_SOCKET_ADDRESS(a)));
        return;
    }
#endif
}

static void socket_clear_addresses(SocketData *s)
{
    g_clear_pointer(&s->local_host, g_free);
    g_clear_pointer(&s->remote_host, g_free);
    s->local_port  = 0;
    s->remote_port = 0;
}

static void socket_read_addresses(SocketData *s)
{
    GSocketAddress *a;
    GError         *err = NULL;

    socket_clear_addresses(s);
    if (!s->conn)
        return;

    a = g_socket_connection_get_local_address(s->conn, &err);
    if (a) {
        address_text(a, &s->local_host, &s->local_port);
        g_object_unref(a);
    }
    g_clear_error(&err);

    a = g_socket_connection_get_remote_address(s->conn, &err);
    if (a) {
        address_text(a, &s->remote_host, &s->remote_port);
        g_object_unref(a);
    }
    g_clear_error(&err);
}

/* ---------------------------------------------------------------- closing */

static void socket_close_full(SocketData *s, bool emit, bool finalizing)
{
    if (s->state == SOCKET_CLOSED)
        return;

    s->state = SOCKET_CLOSED;

    if (s->timeout_id) {
        g_source_remove(s->timeout_id);
        s->timeout_id = 0;
    }
    if (s->cancel)
        g_cancellable_cancel(s->cancel);
    g_clear_object(&s->client);
    if (s->stream) {
        g_io_stream_close(s->stream, NULL, NULL);
        g_clear_object(&s->stream);
    }
    g_clear_object(&s->conn);
    s->in = NULL;
    s->out = NULL;
    g_clear_object(&s->cancel);

    if (s->server) {
        ServerData *srv = s->server;

        s->server = NULL;
        if (srv->clients)
            g_ptr_array_remove(srv->clients, s);
    }
    if (!finalizing && !JS_IsUndefined(s->server_val)) {
        JS_FreeValue(s->ctx, s->server_val);
        s->server_val = JS_UNDEFINED;
    }

    socket_live_remove(s);
    while (s->writes && !g_queue_is_empty(s->writes))
        g_bytes_unref(g_queue_pop_head(s->writes));
    s->writing = false;
    s->reading = false;
    if (s->linebuf)
        g_byte_array_set_size(s->linebuf, 0);
    socket_clear_addresses(s);

    if (emit && !finalizing && !s->closed_emitted) {
        s->closed_emitted = true;
        socket_emit(s, s->on_closed, 0, NULL);
    }

    /* The keep of an accepted socket is what makes the server's own list
     * enough to hold it; drop it last, because freeing it can finalize the
     * wrapper this frame has just finished with. */
    if (!finalizing && !JS_IsUndefined(s->keep)) {
        JSValue keep = s->keep;

        s->keep = JS_UNDEFINED;
        /* Last: this can be the reference that finalizes the wrapper, and
         * after it `s` may be gone. */
        JS_FreeValue(s->ctx, keep);
    }
}

static void socket_fail_text(SocketData *s, const char *kind, const char *detail)
{
    JSValue e;
    char   *where;

    if (s->state == SOCKET_CLOSED)
        return;

    where = socket_where(s);
    e = socket_error(s->ctx, where, kind, detail);
    g_free(where);
    socket_emit(s, s->on_error, 1, &e);
    JS_FreeValue(s->ctx, e);
    socket_close_full(s, true, false);
}

static void socket_fail(SocketData *s, const GError *err, bool timed_out)
{
    char *where;
    char *msg;
    JSValue e;

    if (s->state == SOCKET_CLOSED)
        return;

    where = socket_where(s);
    msg = g_strdup_printf("%s: %s", where,
                          timed_out ? "the connection timed out"
                                    : bta_gerror_text(err));
    e = socket_error(s->ctx, "Socket", socket_kind_for(err, timed_out), msg);
    g_free(msg);
    g_free(where);
    socket_emit(s, s->on_error, 1, &e);
    JS_FreeValue(s->ctx, e);
    socket_close_full(s, true, false);
}

/* ------------------------------------------------------------------ reading */

static void socket_deliver(SocketData *s, const guint8 *data, size_t len)
{
    if (!len || s->state != SOCKET_CONNECTED)
        return;

    if (s->line) {
        if (!JS_IsFunction(s->ctx, s->on_line))
            return;

        g_byte_array_append(s->linebuf, data, len);
        if (s->linebuf->len > SOCKET_LINE_MAX) {
            socket_fail_text(s, "Error", "a line is longer than 1 MiB");
            return;
        }

        for (;;) {
            gsize eol_len = strlen(s->eol);
            gsize at = find_bytes(s->linebuf->data, s->linebuf->len,
                                  (const guint8 *)s->eol, eol_len);

            if (at == (gsize)-1)
                break;

            JSValue line = JS_NewStringLen(s->ctx, (const char *)s->linebuf->data, at);

            if (JS_IsException(line)) {
                JS_FreeValue(s->ctx, JS_GetException(s->ctx));
                socket_fail_text(s, "Error", "the peer sent a line that is not UTF-8");
                return;
            }
            socket_emit(s, s->on_line, 1, &line);
            JS_FreeValue(s->ctx, line);

            /* The handler may have closed the socket, or turned line mode
             * off; closing clears the buffer, and the range is only removed
             * while it is still the one we measured. */
            if (s->state != SOCKET_CONNECTED)
                return;
            g_byte_array_remove_range(s->linebuf, 0, at + eol_len);
            if (!s->line)
                return;
        }
        return;
    }

    if (!JS_IsFunction(s->ctx, s->on_data))
        return;

    JSValue bytes = bta_bytes_new(s->ctx, data, len);
    if (JS_IsException(bytes))
        return;
    socket_emit(s, s->on_data, 1, &bytes);
    JS_FreeValue(s->ctx, bytes);
}

static void socket_start_read(SocketData *s)
{
    SocketJob *j;

    if (s->state != SOCKET_CONNECTED || !s->conn || s->reading || !s->cancel)
        return;
    if (!JS_IsFunction(s->ctx, s->on_data) && !JS_IsFunction(s->ctx, s->on_line))
        return;
    if (s->line ? !JS_IsFunction(s->ctx, s->on_line)
                : !JS_IsFunction(s->ctx, s->on_data))
        return;

    s->reading = true;
    j = job_new(JOB_READ, s->ctx, s->self, s);
    j->buf = g_malloc(SOCKET_CHUNK);
    g_input_stream_read_async(s->in, j->buf, SOCKET_CHUNK, G_PRIORITY_DEFAULT,
                              s->cancel, on_read, j);
}

static void on_read(GObject *src, GAsyncResult *res, gpointer data)
{
    SocketJob *j = data;
    SocketData *s = j->owner;
    GError *err = NULL;
    gssize n;

    n = g_input_stream_read_finish(G_INPUT_STREAM(src), res, &err);

    /* A close and a reconnect can have replaced the stream while this read
     * was in flight; the answer belongs to the old one and must not touch the
     * new connection's state. */
    if (G_INPUT_STREAM(src) != s->in) {
        g_clear_error(&err);
        job_free(j);
        return;
    }
    s->reading = false;

    if (s->state != SOCKET_CONNECTED) {
        g_clear_error(&err);
        job_free(j);
        return;
    }
    if (n < 0) {
        if (!g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED))
            socket_fail(s, err, false);
        g_clear_error(&err);
        job_free(j);
        return;
    }
    if (n == 0) {
        /* The peer closed; a close, not an error. */
        g_clear_error(&err);
        socket_close_full(s, true, false);
        job_free(j);
        return;
    }

    socket_deliver(s, j->buf, (size_t)n);
    g_clear_error(&err);

    /* Re-arm *before* dropping this job's reference: the next read holds the
     * object alive, and this frame never touches `s` after the free. */
    if (s->state == SOCKET_CONNECTED)
        socket_start_read(s);
    job_free(j);
}

/* ----------------------------------------------------------------- writing */

static void socket_write_start(SocketData *s)
{
    SocketJob *j;
    GBytes    *bytes;
    gsize      len;
    const void *data;

    if (s->writing || s->state != SOCKET_CONNECTED || !s->conn ||
        !s->writes || g_queue_is_empty(s->writes))
        return;

    bytes = g_queue_pop_head(s->writes);
    data  = g_bytes_get_data(bytes, &len);
    j = job_new(JOB_WRITE, s->ctx, s->self, s);
    j->bytes   = bytes;          /* the job owns it now */
    s->writing = true;
    g_output_stream_write_all_async(s->out, data, len, G_PRIORITY_DEFAULT,
                                    s->cancel, on_write, j);
}

static void on_write(GObject *src, GAsyncResult *res, gpointer data)
{
    SocketJob *j = data;
    SocketData *s = j->owner;
    GError *err = NULL;
    gsize   written = 0;
    gboolean ok;

    ok = g_output_stream_write_all_finish(G_OUTPUT_STREAM(src), res, &written, &err);

    if (G_OUTPUT_STREAM(src) != s->out) {
        g_clear_error(&err);
        job_free(j);
        return;
    }
    s->writing = false;

    if (s->state != SOCKET_CONNECTED) {
        g_clear_error(&err);
        job_free(j);
        return;
    }
    if (!ok) {
        if (!g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED))
            socket_fail(s, err, false);
        g_clear_error(&err);
        job_free(j);
        return;
    }

    /* More queued?  Start it before this job's reference goes. */
    if (!g_queue_is_empty(s->writes)) {
        socket_write_start(s);
        job_free(j);
        return;
    }

    socket_emit(s, s->on_writable, 0, NULL);
    if (s->state == SOCKET_CONNECTED && !g_queue_is_empty(s->writes))
        socket_write_start(s);
    job_free(j);
}

/* --------------------------------------------------------------- connecting */

static gboolean on_connect_timeout(gpointer data)
{
    SocketData *s = data;

    s->timeout_id = 0;
    s->timed_out  = true;
    if (s->cancel)
        g_cancellable_cancel(s->cancel);
    return G_SOURCE_REMOVE;
}

static void on_connect(GObject *src, GAsyncResult *res, gpointer data)
{
    SocketJob *j = data;
    SocketData *s = j->owner;
    GError *err = NULL;
    GSocketConnection *conn;
    bool stale = (G_SOCKET_CLIENT(src) != s->client);

    if (!s->tls && s->timeout_id) {
        g_source_remove(s->timeout_id);
        s->timeout_id = 0;
    }

    if (j->is_unix) {
#ifdef G_OS_UNIX
        conn = g_socket_client_connect_finish(G_SOCKET_CLIENT(src), res, &err);
#else
        conn = NULL;
        g_set_error(&err, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED,
                    "Unix sockets are not available");
#endif
    } else {
        conn = g_socket_client_connect_to_host_finish(G_SOCKET_CLIENT(src), res, &err);
    }

    if (!stale)
        g_clear_object(&s->client);

    if (stale || s->state != SOCKET_CONNECTING) {
        /* Closed, or a newer connect replaced this one: do not resurrect it. */
        if (conn)
            g_object_unref(conn);
        g_clear_error(&err);
        job_free(j);
        return;
    }

    if (!conn) {
        socket_fail(s, err, s->timed_out);
        g_clear_error(&err);
        job_free(j);
        return;
    }
    g_clear_error(&err);

    if (s->tls) {
        GSocketConnectable *identity = NULL;
        GIOStream         *tls;
        SocketJob         *tj;

        if (!s->path || !*s->path)
            identity = G_SOCKET_CONNECTABLE(g_network_address_new(s->host,
                                                                  (guint16)s->port));
        tls = g_tls_client_connection_new(G_IO_STREAM(conn), identity, &err);
        if (identity)
            g_object_unref(identity);
        if (!tls) {
            socket_fail(s, err, false);
            g_clear_error(&err);
            g_object_unref(conn);
            job_free(j);
            return;
        }
        if (s->tls_db)
            g_tls_connection_set_database(G_TLS_CONNECTION(tls), s->tls_db);
        if (s->tls_cert)
            g_object_set(G_OBJECT(tls), "validation-flags",
                         (GTlsCertificateFlags)0, NULL);

        s->conn = conn;              /* the raw connection owns the address */
        tj = job_new(JOB_TLS_CLIENT, s->ctx, s->self, s);
        tj->stream = tls;
        g_tls_connection_handshake_async(G_TLS_CONNECTION(tls), G_PRIORITY_DEFAULT,
                                         s->cancel, on_tls_handshake, tj);
        job_free(j);
        return;
    }

    s->conn   = conn;
    s->stream = g_object_ref(G_IO_STREAM(conn));
    s->in     = g_io_stream_get_input_stream(s->stream);
    s->out    = g_io_stream_get_output_stream(s->stream);
    s->state  = SOCKET_CONNECTED;
    s->timed_out = false;
    socket_read_addresses(s);

    /* An accepted socket uses the peer as its `Host`; a connected one keeps
     * the name it asked for and answers the numeric one through RemoteHost. */
    if (s->path && *s->path) {
        g_free(s->host);
        s->host = g_strdup(s->path);
        s->port = 0;
    }

    socket_emit(s, s->on_connected, 0, NULL);
    if (s->state == SOCKET_CONNECTED)
        socket_start_read(s);
    job_free(j);
}

/* ---------------------------------------------------------------- the server */

static void server_accept(ServerData *s)
{
    SocketJob *j;

    if (!s->listening || !s->listener || !s->cancel)
        return;

    j = job_new(JOB_ACCEPT, s->ctx, s->self, s);
    g_socket_listener_accept_async(s->listener, s->cancel, on_accept, j);
}

static void server_fail(ServerData *s, const GError *err)
{
    JSValue e;
    char   *msg;

    if (!s->listening)
        return;

    msg = g_strdup_printf("%s", bta_gerror_text(err));
    e = socket_error(s->ctx, "ServerSocket", socket_kind_for(err, false), msg);
    g_free(msg);
    server_emit(s, s->on_error, 1, &e);
    JS_FreeValue(s->ctx, e);
}

static void on_tls_handshake(GObject *src, GAsyncResult *res, gpointer data)
{
    SocketJob *j = data;
    GError    *err = NULL;
    gboolean   ok = g_tls_connection_handshake_finish(G_TLS_CONNECTION(src), res, &err);

    if (j->kind == JOB_TLS_CLIENT) {
        SocketData *s = j->owner;

        if (!ok || s->state != SOCKET_CONNECTING) {
            if (s->state == SOCKET_CONNECTING)
                socket_fail(s, err, s->timed_out);
            g_clear_error(&err);
            job_free(j);
            return;
        }
        if (s->timeout_id) {
            g_source_remove(s->timeout_id);
            s->timeout_id = 0;
        }
        if (s->tls_cert) {
            GTlsCertificate *peer = g_tls_connection_get_peer_certificate(G_TLS_CONNECTION(src));

            if (!peer || !g_tls_certificate_is_same(s->tls_cert, peer)) {
                socket_fail_text(s, "Tls", "the peer's certificate is not the pinned one");
                g_clear_error(&err);
                job_free(j);
                return;
            }
        }

        s->stream = j->stream;
        j->stream = NULL;
        s->in     = g_io_stream_get_input_stream(s->stream);
        s->out    = g_io_stream_get_output_stream(s->stream);
        s->state  = SOCKET_CONNECTED;
        s->timed_out = false;
        socket_read_addresses(s);

        socket_emit(s, s->on_connected, 0, NULL);
        if (s->state == SOCKET_CONNECTED)
            socket_start_read(s);
        job_free(j);
        return;
    }

    {
        ServerData *s = j->owner;

        if (!ok) {
            if (s->listening)
                server_fail(s, err);
            g_clear_error(&err);
            job_free(j);
            return;
        }
        if (!s->listening) {
            job_free(j);
            return;
        }

        JSValue client = socket_from_connection(s->ctx, j->conn, j->stream, s);
        if (JS_IsException(client)) {
            job_free(j);
            return;
        }
        j->conn   = NULL;
        j->stream = NULL;
        server_emit(s, s->on_connection, 1, &client);
        JS_FreeValue(s->ctx, client);
        job_free(j);
    }
}

static JSValue socket_from_connection(JSContext *ctx, GSocketConnection *conn,
                                      GIOStream *stream, ServerData *server)
{
    JSValue obj = JS_NewObjectClass(ctx, socket_class_id);
    SocketData *s;

    if (JS_IsException(obj))
        return obj;

    s = g_new0(SocketData, 1);
    s->ctx       = ctx;
    s->self      = obj;
    s->keep      = JS_UNDEFINED;
    s->on_connected = JS_UNDEFINED;
    s->on_data      = JS_UNDEFINED;
    s->on_line      = JS_UNDEFINED;
    s->on_closed    = JS_UNDEFINED;
    s->on_error     = JS_UNDEFINED;
    s->on_writable  = JS_UNDEFINED;
    s->server_val   = JS_UNDEFINED;
    s->timeout      = 10000;
    s->eol          = g_strdup("\n");
    s->writes       = g_queue_new();
    s->linebuf      = g_byte_array_new();
    s->conn         = conn;          /* takes the reference */
    /* The plain road has one object; the TLS road has the raw connection for
     * addresses and the wrapper for I/O, and this takes the wrapper. */
    s->stream       = stream ? stream : g_object_ref(G_IO_STREAM(conn));
    s->in           = g_io_stream_get_input_stream(s->stream);
    s->out          = g_io_stream_get_output_stream(s->stream);
    s->cancel       = g_cancellable_new();
    s->state        = SOCKET_CONNECTED;
    s->server       = server;
    s->server_val   = JS_DupValue(ctx, server->self);
    socket_read_addresses(s);

    /* The peer is what this socket is, so Host/Port answer the remote end. */
    g_free(s->host);
    s->host = g_strdup(s->remote_host ? s->remote_host : "");
    s->port = s->remote_port;

    JS_SetOpaque(obj, s);
    /* An accepted socket is owned by its server, and the server's list is
     * C pointers: without a reference of its own the wrapper would be freed
     * the moment `on_accept` drops the local, closing a connection the
     * program is still using. */
    s->keep = JS_DupValue(ctx, obj);
    g_ptr_array_add(server->clients, s);
    socket_live_add(s);
    return obj;
}

static void on_accept(GObject *src, GAsyncResult *res, gpointer data)
{
    SocketJob *j = data;
    ServerData *s = j->owner;
    GError *err = NULL;
    GSocketConnection *conn;
    JSValue client;
    SocketJob *tj;
    bool stale = (G_SOCKET_LISTENER(src) != s->listener);

    conn = g_socket_listener_accept_finish(G_SOCKET_LISTENER(src), res, NULL, &err);

    if (stale) {
        if (conn)
            g_object_unref(conn);
        g_clear_error(&err);
        job_free(j);
        return;
    }

    if (!conn) {
        if (!(g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED) && !s->listening))
            server_fail(s, err);
        g_clear_error(&err);
        if (s->listening)
            server_accept(s);
        job_free(j);
        return;
    }
    g_clear_error(&err);

    if (s->tls_cert) {
        GError   *terr = NULL;
        GIOStream *tls = g_tls_server_connection_new(G_IO_STREAM(conn), s->tls_cert, &terr);

        if (!tls) {
            server_fail(s, terr);
            g_clear_error(&terr);
            g_object_unref(conn);
            if (s->listening)
                server_accept(s);
            job_free(j);
            return;
        }
        tj = job_new(JOB_TLS_SERVER, s->ctx, s->self, s);
        tj->conn   = conn;
        tj->stream = tls;
        g_tls_connection_handshake_async(G_TLS_CONNECTION(tls), G_PRIORITY_DEFAULT,
                                         s->cancel, on_tls_handshake, tj);
        if (s->listening)
            server_accept(s);
        job_free(j);
        return;
    }

    client = socket_from_connection(s->ctx, conn, NULL, s);
    if (JS_IsException(client)) {
        g_object_unref(conn);
        if (s->listening)
            server_accept(s);
        job_free(j);
        return;
    }

    server_emit(s, s->on_connection, 1, &client);
    JS_FreeValue(s->ctx, client);

    /* Re-arm before dropping the job's reference, exactly as the read loop
     * does; `Stop` from inside the handler has set listening false. */
    if (s->listening)
        server_accept(s);
    job_free(j);
}

static void server_stop_full(ServerData *s, bool emit, bool finalizing)
{
    GPtrArray *copy;

    if (s->stopping)
        return;
    s->stopping  = true;
    s->listening = false;
    if (s->cancel)
        g_cancellable_cancel(s->cancel);
    server_live_remove(s);

    copy = g_ptr_array_new();
    for (guint i = 0; i < s->clients->len; i++)
        g_ptr_array_add(copy, g_ptr_array_index(s->clients, i));
    for (guint i = 0; i < copy->len; i++)
        socket_close_full(g_ptr_array_index(copy, i), emit, finalizing);
    g_ptr_array_free(copy, TRUE);

    /* The accept in flight holds its own reference to the listener, so
     * dropping ours does not release the port; closing it first is what lets
     * a `Listen` right after a `Stop` bind the same port again. */
    if (s->listener)
        g_socket_listener_close(s->listener);
    g_clear_object(&s->listener);
    g_clear_object(&s->cancel);

    if (s->owns_path && s->path && *s->path) {
        g_unlink(s->path);
        s->owns_path = false;
    }
    s->stopping = false;
}

/* -------------------------------------------------------------- datagrams */

static void udp_emit(UdpData *s, JSValueConst fn, int argc, JSValueConst *argv)
{
    if (!JS_IsFunction(s->ctx, fn))
        return;

    JSValue self = JS_DupValue(s->ctx, s->self);
    JSValue call = JS_DupValue(s->ctx, fn);
    JSValue r    = JS_Call(s->ctx, call, self, argc, argv);

    if (JS_IsException(r))
        bta_dump_error(s->ctx);
    JS_FreeValue(s->ctx, r);
    JS_FreeValue(s->ctx, call);
    JS_FreeValue(s->ctx, self);
    bta_drain_jobs(JS_GetRuntime(s->ctx));
}

static void udp_close_full(UdpData *s, bool finalizing)
{
    if (s->source) {
        g_source_destroy(s->source);
        g_source_unref(s->source);
        s->source = NULL;
    }
    if (s->sock) {
        g_socket_close(s->sock, NULL);
        g_clear_object(&s->sock);
    }
    udp_live_remove(s);
    s->bound = false;

    if (!finalizing && !JS_IsUndefined(s->keep)) {
        JSValue keep = s->keep;

        s->keep = JS_UNDEFINED;
        /* Last: this can be the reference that finalizes the wrapper. */
        JS_FreeValue(s->ctx, keep);
    }
}

static JSValue udp_from_object(JSContext *ctx, GSocketAddress *a)
{
    char   *host = NULL;
    int     port = 0;
    JSValue o = JS_NewObject(ctx);

    address_text(a, &host, &port);
    JS_SetPropertyStr(ctx, o, "Host", JS_NewString(ctx, host ? host : ""));
    JS_SetPropertyStr(ctx, o, "Port", JS_NewInt32(ctx, port));
    g_free(host);
    return o;
}

static gboolean on_udp_ready(GSocket *sock, GIOCondition cond, gpointer data)
{
    UdpData *s = data;
    JSValue  hold;

    if (!s->bound || s->sock != sock)
        return G_SOURCE_REMOVE;

    /* The handler may close the socket, and the close drops `keep` -- the
     * reference that was holding this wrapper.  This one is the frame's own
     * until the last line, so `s` and its `bound` are still readable when
     * the callback decides whether to continue. */
    hold = JS_DupValue(s->ctx, s->self);

    if (cond & G_IO_IN) {
        guint8          buf[65536];
        GSocketAddress *from = NULL;
        GError         *err = NULL;
        gssize          n;

        n = g_socket_receive_from(sock, &from, (gchar *)buf, sizeof buf, NULL, &err);
        if (n < 0) {
            if (s->bound && !g_error_matches(err, G_IO_ERROR, G_IO_ERROR_WOULD_BLOCK)) {
                JSValue e = socket_error(s->ctx, "UdpSocket",
                                         socket_kind_for(err, false),
                                         bta_gerror_text(err));
                udp_emit(s, s->on_error, 1, &e);
                JS_FreeValue(s->ctx, e);
            }
            g_clear_error(&err);
        } else if (n >= 0) {
            JSValue bytes = bta_bytes_new(s->ctx, buf, (size_t)n);

            if (!JS_IsException(bytes)) {
                JSValue fromobj = udp_from_object(s->ctx, from);
                JSValue argv[2] = { bytes, fromobj };

                udp_emit(s, s->on_data, 2, argv);
                JS_FreeValue(s->ctx, bytes);
                JS_FreeValue(s->ctx, fromobj);
            }
        }
        if (from)
            g_object_unref(from);
        g_clear_error(&err);
    }

    gboolean again = s->bound;

    JS_FreeValue(s->ctx, hold);
    return again ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE;
}

static bool udp_bind_internal(JSContext *ctx, UdpData *s)
{
    GError         *err = NULL;
    GInetAddress   *ia;
    GSocketAddress *addr;
    GSocketAddress *local = NULL;

    if (s->bound)
        return true;

    s->sock = g_socket_new(G_SOCKET_FAMILY_IPV4, G_SOCKET_TYPE_DATAGRAM,
                           G_SOCKET_PROTOCOL_UDP, &err);
    if (!s->sock) {
        JS_ThrowPlainError(ctx, "UdpSocket.Bind: %s", bta_gerror_text(err));
        g_clear_error(&err);
        return false;
    }
    g_socket_set_blocking(s->sock, FALSE);
    g_socket_set_broadcast(s->sock, s->broadcast);

    ia = (!s->host || strcmp(s->host, "any") != 0)
        ? g_inet_address_new_loopback(G_SOCKET_FAMILY_IPV4)
        : g_inet_address_new_any(G_SOCKET_FAMILY_IPV4);
    addr = g_inet_socket_address_new(ia, (guint16)s->port);
    if (!g_socket_bind(s->sock, addr, FALSE, &err)) {
        JS_ThrowPlainError(ctx, "UdpSocket.Bind: %s", bta_gerror_text(err));
        g_clear_error(&err);
        g_object_unref(addr);
        g_object_unref(ia);
        g_clear_object(&s->sock);
        return false;
    }
    g_object_unref(addr);
    g_object_unref(ia);

    local = g_socket_get_local_address(s->sock, &err);
    if (local) {
        if (G_IS_INET_SOCKET_ADDRESS(local))
            s->port = g_inet_socket_address_get_port(G_INET_SOCKET_ADDRESS(local));
        g_object_unref(local);
    }
    g_clear_error(&err);

    s->source = g_socket_create_source(s->sock, G_IO_IN | G_IO_ERR | G_IO_HUP, NULL);
    if (!s->source) {
        g_clear_object(&s->sock);
        JS_ThrowPlainError(ctx, "UdpSocket.Bind: cannot watch the socket");
        return false;
    }
    g_source_set_callback(s->source, G_SOURCE_FUNC(on_udp_ready), s, NULL);
    g_source_attach(s->source, NULL);

    s->bound = true;
    udp_live_add(s);
    s->keep = JS_DupValue(ctx, s->self);
    return true;
}

/* `Send(data, host, port)` or `Send(data, from)`; host is an address.  A name
 * here would need a resolver, and a resolver on the loop is the freeze this
 * whole file exists to avoid -- `Socket` resolves because GSocketClient does
 * it asynchronously. */
static bool udp_destination(JSContext *ctx, int argc, JSValueConst *argv,
                            GInetAddress **out, int *out_port)
{
    const char *host = NULL;
    int32_t     port = 0;
    JSValue     h = JS_UNDEFINED, p = JS_UNDEFINED;

    *out = NULL;
    *out_port = 0;

    if (argc >= 3 && JS_IsString(argv[1])) {
        host = JS_ToCString(ctx, argv[1]);
        if (!host)
            return false;
        if (!bta_to_int(ctx, argv[2], "UdpSocket.Send", &port)) {
            JS_FreeCString(ctx, host);
            return false;
        }
        if (port < 1 || port > 65535) {
            JS_FreeCString(ctx, host);
            JS_ThrowRangeError(ctx, "UdpSocket.Send: port is 1 to 65535, got %d", port);
            return false;
        }
        *out = g_inet_address_new_from_string(host);
        if (!*out) {
            JS_ThrowTypeError(ctx, "UdpSocket.Send: host is an IP address "
                                   "(127.0.0.1, ::1, ...), not a name");
            JS_FreeCString(ctx, host);
            return false;
        }
        *out_port = port;
        JS_FreeCString(ctx, host);
        return true;
    }

    if (argc >= 2 && JS_IsObject(argv[1])) {
        h = JS_GetPropertyStr(ctx, argv[1], "Host");
        p = JS_GetPropertyStr(ctx, argv[1], "Port");
        if (JS_IsException(h) || JS_IsException(p)) {
            JS_FreeValue(ctx, h);
            JS_FreeValue(ctx, p);
            return false;
        }
        if (!JS_IsString(h)) {
            JS_FreeValue(ctx, h);
            JS_FreeValue(ctx, p);
            return JS_ThrowTypeError(ctx, "UdpSocket.Send: the target needs a Host"), false;
        }
        if (!bta_to_int(ctx, p, "UdpSocket.Send Port", &port)) {
            JS_FreeValue(ctx, h);
            JS_FreeValue(ctx, p);
            return false;
        }
        if (port < 1 || port > 65535) {
            JS_FreeValue(ctx, h);
            JS_FreeValue(ctx, p);
            return JS_ThrowRangeError(ctx, "UdpSocket.Send: port is 1 to 65535, got %d", port), false;
        }
        host = JS_ToCString(ctx, h);
        JS_FreeValue(ctx, h);
        JS_FreeValue(ctx, p);
        if (!host)
            return false;
        *out = g_inet_address_new_from_string(host);
        if (!*out) {
            JS_ThrowTypeError(ctx, "UdpSocket.Send: host is an IP address "
                                   "(127.0.0.1, ::1, ...), not a name");
            JS_FreeCString(ctx, host);
            return false;
        }
        *out_port = port;
        JS_FreeCString(ctx, host);
        return true;
    }

    return JS_ThrowTypeError(ctx, "UdpSocket.Send(data, host, port) or "
                                  "Send(data, from): needs a destination"), false;
}

static UdpData *udp_data(JSValueConst v)
{
    return JS_GetOpaque(v, udp_class_id);
}

static GBytes *udp_data_bytes(JSContext *ctx, JSValueConst v)
{
    if (JS_IsString(v)) {
        size_t      len = 0;
        const char *text = JS_ToCStringLen(ctx, &len, v);
        GBytes     *b;

        if (!text)
            return NULL;
        b = g_bytes_new(text, len);
        JS_FreeCString(ctx, text);
        return b;
    }

    size_t         len = 0;
    const uint8_t *data = bta_bytes_get(v, &len);

    if (!data) {
        JS_ThrowTypeError(ctx, "UdpSocket.Send: expected text or Bytes");
        return NULL;
    }
    return g_bytes_new(data, len);
}

static bool udp_set_option(JSContext *ctx, UdpData *s,
                           const char *key, JSValueConst value)
{
    if (!strcmp(key, "Host")) {
        const char *text;

        if (s->bound)
            return JS_ThrowTypeError(ctx, "UdpSocket.Host: cannot change while bound"), false;
        if (!JS_IsString(value))
            return JS_ThrowTypeError(ctx, "UdpSocket.Host: expected \"local\" or \"any\""), false;
        text = JS_ToCString(ctx, value);
        if (!text)
            return false;
        if (strcmp(text, "local") && strcmp(text, "any")) {
            JS_FreeCString(ctx, text);
            return JS_ThrowTypeError(ctx, "UdpSocket.Host: expected \"local\" or \"any\""), false;
        }
        g_free(s->host);
        s->host = g_strdup(text);
        JS_FreeCString(ctx, text);
        return true;
    }
    if (!strcmp(key, "Port")) {
        int32_t port;

        if (s->bound)
            return JS_ThrowTypeError(ctx, "UdpSocket.Port: cannot change while bound"), false;
        if (!bta_to_int(ctx, value, "UdpSocket.Port", &port))
            return false;
        if (port < 0 || port > 65535)
            return JS_ThrowRangeError(ctx, "UdpSocket.Port: 0 to 65535, got %d", port), false;
        s->port = port;
        return true;
    }
    if (!strcmp(key, "Broadcast")) {
        s->broadcast = JS_ToBool(ctx, value);
        if (s->sock)
            g_socket_set_broadcast(s->sock, s->broadcast);
        return true;
    }
    return JS_ThrowTypeError(ctx, "UdpSocket: no option called '%s'; the options "
                             "are Host, Port and Broadcast", key), false;
}

static bool udp_apply_options(JSContext *ctx, UdpData *s, JSValueConst opts)
{
    JSPropertyEnum *props = NULL;
    uint32_t        n = 0;
    bool            ok = true;

    if (!JS_IsObject(opts))
        return JS_ThrowTypeError(ctx, "UdpSocket: the options are an object"), false;
    if (JS_GetOwnPropertyNames(ctx, &props, &n, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;

    for (uint32_t i = 0; i < n && ok; i++) {
        const char *key = JS_AtomToCString(ctx, props[i].atom);
        JSValue     v;

        if (!key) {
            ok = false;
            break;
        }
        v = JS_GetPropertyStr(ctx, opts, key);
        if (JS_IsException(v))
            ok = false;
        else {
            ok = udp_set_option(ctx, s, key, v);
            JS_FreeValue(ctx, v);
        }
        JS_FreeCString(ctx, key);
    }
    JS_FreePropertyEnum(ctx, props, n);
    return ok;
}

static JSValue udp_send(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    UdpData *s = udp_data(this_val);
    GBytes  *bytes;
    GInetAddress *ia = NULL;
    int      port = 0;
    GSocketAddress *addr;
    GError *err = NULL;
    gsize   len = 0;
    const void *data;
    gssize  n;

    if (!s)
        return JS_ThrowTypeError(ctx, "Send: not a UdpSocket");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "UdpSocket.Send(data, host, port): needs the data");

    bytes = udp_data_bytes(ctx, argv[0]);
    if (!bytes)
        return JS_EXCEPTION;
    if (!udp_destination(ctx, argc, argv, &ia, &port)) {
        g_bytes_unref(bytes);
        return JS_EXCEPTION;
    }
    if (!udp_bind_internal(ctx, s)) {
        g_bytes_unref(bytes);
        g_object_unref(ia);
        return JS_EXCEPTION;
    }

    addr = g_inet_socket_address_new(ia, (guint16)port);
    data = g_bytes_get_data(bytes, &len);
    n = g_socket_send_to(s->sock, addr, data, len, NULL, &err);
    g_object_unref(addr);
    g_object_unref(ia);

    if (n < 0) {
        JS_ThrowPlainError(ctx, "UdpSocket.Send: %s", bta_gerror_text(err));
        g_clear_error(&err);
        g_bytes_unref(bytes);
        return JS_EXCEPTION;
    }
    if ((gsize)n != len) {
        JS_ThrowPlainError(ctx, "UdpSocket.Send: the datagram was cut at %" G_GSIZE_FORMAT
                                 " of %" G_GSIZE_FORMAT " bytes", (gsize)n, len);
        g_bytes_unref(bytes);
        return JS_EXCEPTION;
    }
    g_bytes_unref(bytes);
    return JS_DupValue(ctx, this_val);
}

static JSValue udp_bind_method(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    UdpData *s = udp_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Bind: not a UdpSocket");
    if (s->bound)
        return JS_ThrowPlainError(ctx, "UdpSocket.Bind: it is already bound");
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!udp_set_option(ctx, s, "Port", argv[0]))
            return JS_EXCEPTION;
    }
    if (!udp_bind_internal(ctx, s))
        return JS_EXCEPTION;
    return JS_DupValue(ctx, this_val);
}

static JSValue udp_close_method(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    UdpData *s = udp_data(this_val);
    JSValue  out;

    if (!s)
        return JS_ThrowTypeError(ctx, "Close: not a UdpSocket");
    out = JS_DupValue(ctx, this_val);
    udp_close_full(s, false);
    return out;
}

/* --------------------------------------------------------------- properties */

static SocketData *socket_data(JSValueConst v)
{
    return JS_GetOpaque(v, socket_class_id);
}

static ServerData *server_data(JSValueConst v)
{
    return JS_GetOpaque(v, server_class_id);
}

static bool socket_set_tls(JSContext *ctx, SocketData *s, JSValueConst value)
{
    bool on = false;
    GTlsDatabase *db = NULL;
    GTlsCertificate *cert = NULL;
    char *ca_path = NULL, *cert_path = NULL;
    GError *err = NULL;

    if (JS_IsNull(value) || JS_IsUndefined(value) || JS_IsBool(value)) {
        on = JS_ToBool(ctx, value);
    } else if (JS_IsObject(value)) {
        JSPropertyEnum *props = NULL;
        uint32_t        n = 0;

        if (JS_GetOwnPropertyNames(ctx, &props, &n, value,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
            return false;
        on = true;
        for (uint32_t i = 0; i < n; i++) {
            const char *key = JS_AtomToCString(ctx, props[i].atom);
            JSValue     v;
            const char *path;

            if (!key) {
                JS_FreePropertyEnum(ctx, props, n);
                goto failed;
            }
            if (strcmp(key, "Ca") && strcmp(key, "Cert")) {
                JS_ThrowTypeError(ctx, "Socket.Tls: no option called '%s'; the options "
                                       "are Ca and Cert", key);
                JS_FreeCString(ctx, key);
                JS_FreePropertyEnum(ctx, props, n);
                goto failed;
            }
            v = JS_GetPropertyStr(ctx, value, key);
            if (JS_IsException(v)) {
                JS_FreeCString(ctx, key);
                JS_FreePropertyEnum(ctx, props, n);
                goto failed;
            }
            if (!JS_IsString(v)) {
                JS_ThrowTypeError(ctx, "Socket.Tls: %s is a file path", key);
                JS_FreeValue(ctx, v);
                JS_FreeCString(ctx, key);
                JS_FreePropertyEnum(ctx, props, n);
                goto failed;
            }
            path = JS_ToCString(ctx, v);
            JS_FreeValue(ctx, v);
            if (!path) {
                JS_FreeCString(ctx, key);
                JS_FreePropertyEnum(ctx, props, n);
                goto failed;
            }
            if (!strcmp(key, "Ca")) {
                db = g_tls_file_database_new(path, &err);
                if (!db) {
                    JS_ThrowTypeError(ctx, "Socket.Tls: cannot read the certificate '%s': %s",
                                      path, bta_gerror_text(err));
                    g_clear_error(&err);
                    JS_FreeCString(ctx, path);
                    JS_FreeCString(ctx, key);
                    JS_FreePropertyEnum(ctx, props, n);
                    goto failed;
                }
                g_free(ca_path);
                ca_path = g_strdup(path);
            } else {
                cert = g_tls_certificate_new_from_file(path, &err);
                if (!cert) {
                    JS_ThrowTypeError(ctx, "Socket.Tls: cannot read the certificate '%s': %s",
                                      path, bta_gerror_text(err));
                    g_clear_error(&err);
                    JS_FreeCString(ctx, path);
                    JS_FreeCString(ctx, key);
                    JS_FreePropertyEnum(ctx, props, n);
                    goto failed;
                }
                g_free(cert_path);
                cert_path = g_strdup(path);
            }
            JS_FreeCString(ctx, path);
            JS_FreeCString(ctx, key);
        }
        JS_FreePropertyEnum(ctx, props, n);
    } else {
        return JS_ThrowTypeError(ctx, "Socket.Tls: true, { Ca, Cert }, or null"), false;
    }

    g_clear_object(&s->tls_db);
    g_clear_object(&s->tls_cert);
    g_free(s->tls_ca_path);
    g_free(s->tls_cert_path);
    s->tls           = on;
    s->tls_db        = db;
    s->tls_cert      = cert;
    s->tls_ca_path   = ca_path;
    s->tls_cert_path = cert_path;
    return true;

failed:
    g_clear_object(&db);
    g_clear_object(&cert);
    g_free(ca_path);
    g_free(cert_path);
    return false;
}

static bool socket_set_option(JSContext *ctx, SocketData *s,
                              const char *key, JSValueConst value)
{
    if (!strcmp(key, "Host") || !strcmp(key, "Path")) {
        const char *text;
        char      **field;

        if (s->state != SOCKET_CLOSED)
            return JS_ThrowTypeError(ctx, "Socket.%s: cannot change while connected", key), false;
        if (!JS_IsString(value))
            return JS_ThrowTypeError(ctx, "Socket.%s: expected text", key), false;
        text = JS_ToCString(ctx, value);
        if (!text)
            return false;
        field = !strcmp(key, "Host") ? &s->host : &s->path;
        g_free(*field);
        *field = g_strdup(text);
        JS_FreeCString(ctx, text);
        return true;
    }
    if (!strcmp(key, "Port")) {
        int32_t port;

        if (s->state != SOCKET_CLOSED)
            return JS_ThrowTypeError(ctx, "Socket.Port: cannot change while connected"), false;
        if (!bta_to_int(ctx, value, "Socket.Port", &port))
            return false;
        if (port < 0 || port > 65535)
            return JS_ThrowRangeError(ctx, "Socket.Port: 0 to 65535, got %d", port), false;
        s->port = port;
        return true;
    }
    if (!strcmp(key, "Timeout")) {
        int32_t ms;

        if (s->state != SOCKET_CLOSED)
            return JS_ThrowTypeError(ctx, "Socket.Timeout: cannot change while connected"), false;
        if (!bta_to_int(ctx, value, "Socket.Timeout", &ms))
            return false;
        if (ms < 0)
            return JS_ThrowRangeError(ctx, "Socket.Timeout: milliseconds, 0 or more"), false;
        s->timeout = ms;
        return true;
    }
    if (!strcmp(key, "Line")) {
        s->line = JS_ToBool(ctx, value);
        if (s->state == SOCKET_CONNECTED)
            socket_start_read(s);
        return true;
    }
    if (!strcmp(key, "EndOfLine")) {
        const char *text;

        if (!JS_IsString(value))
            return JS_ThrowTypeError(ctx, "Socket.EndOfLine: expected text"), false;
        text = JS_ToCString(ctx, value);
        if (!text)
            return false;
        if (!*text) {
            JS_FreeCString(ctx, text);
            return JS_ThrowRangeError(ctx, "Socket.EndOfLine: it cannot be empty"), false;
        }
        g_free(s->eol);
        s->eol = g_strdup(text);
        JS_FreeCString(ctx, text);
        return true;
    }

    if (!strcmp(key, "Tls")) {
        if (s->state != SOCKET_CLOSED)
            return JS_ThrowTypeError(ctx, "Socket.Tls: cannot change while connected"), false;
        return socket_set_tls(ctx, s, value);
    }

    return JS_ThrowTypeError(ctx, "Socket: no option called '%s'; the options are "
                             "Host, Port, Path, Timeout, Line, EndOfLine and Tls", key), false;
}

static bool socket_apply_options(JSContext *ctx, SocketData *s, JSValueConst opts)
{
    JSPropertyEnum *props = NULL;
    uint32_t        n = 0;
    bool            ok = true;

    if (!JS_IsObject(opts))
        return JS_ThrowTypeError(ctx, "Socket: the options are an object"), false;
    if (JS_GetOwnPropertyNames(ctx, &props, &n, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;

    for (uint32_t i = 0; i < n && ok; i++) {
        const char *key = JS_AtomToCString(ctx, props[i].atom);
        JSValue     v;

        if (!key) {
            ok = false;
            break;
        }
        v = JS_GetPropertyStr(ctx, opts, key);
        if (JS_IsException(v))
            ok = false;
        else {
            ok = socket_set_option(ctx, s, key, v);
            JS_FreeValue(ctx, v);
        }
        JS_FreeCString(ctx, key);
    }
    JS_FreePropertyEnum(ctx, props, n);
    return ok;
}

static JSValue socket_construct(JSContext *ctx, JSValueConst new_target,
                                int argc, JSValueConst *argv)
{
    JSValue obj = JS_NewObjectClass(ctx, socket_class_id);
    SocketData *s;

    if (JS_IsException(obj))
        return obj;

    s = g_new0(SocketData, 1);
    s->ctx          = ctx;
    s->self         = obj;
    s->keep         = JS_UNDEFINED;
    s->on_connected = JS_UNDEFINED;
    s->on_data      = JS_UNDEFINED;
    s->on_line      = JS_UNDEFINED;
    s->on_closed    = JS_UNDEFINED;
    s->on_error     = JS_UNDEFINED;
    s->on_writable  = JS_UNDEFINED;
    s->server_val   = JS_UNDEFINED;
    s->timeout      = 10000;
    s->eol          = g_strdup("\n");
    s->writes       = g_queue_new();
    s->linebuf      = g_byte_array_new();
    JS_SetOpaque(obj, s);

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!socket_apply_options(ctx, s, argv[0])) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
    }
    return obj;
}

static JSValue socket_get_host(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewString(ctx, s && s->host ? s->host : "");
}

static JSValue socket_set_host(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    SocketData *s = socket_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Host: not a Socket");
    return socket_set_option(ctx, s, "Host", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue socket_get_port(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewInt32(ctx, s ? s->port : 0);
}

static JSValue socket_set_port(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    SocketData *s = socket_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Port: not a Socket");
    return socket_set_option(ctx, s, "Port", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue socket_get_path(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewString(ctx, s && s->path ? s->path : "");
}

static JSValue socket_set_path(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    SocketData *s = socket_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Path: not a Socket");
    return socket_set_option(ctx, s, "Path", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue socket_get_tls(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    JSValue     o;

    if (!s || !s->tls)
        return JS_NULL;
    if (!s->tls_ca_path && !s->tls_cert_path)
        return JS_TRUE;
    o = JS_NewObject(ctx);
    if (s->tls_ca_path)
        JS_SetPropertyStr(ctx, o, "Ca", JS_NewString(ctx, s->tls_ca_path));
    if (s->tls_cert_path)
        JS_SetPropertyStr(ctx, o, "Cert", JS_NewString(ctx, s->tls_cert_path));
    return o;
}

static JSValue socket_set_tls_property(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    SocketData *s = socket_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Tls: not a Socket");
    return socket_set_option(ctx, s, "Tls", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue socket_get_timeout(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewInt32(ctx, s ? s->timeout : 0);
}

static JSValue socket_set_timeout(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    SocketData *s = socket_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Timeout: not a Socket");
    return socket_set_option(ctx, s, "Timeout", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue socket_get_line(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewBool(ctx, s && s->line);
}

static JSValue socket_set_line(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    SocketData *s = socket_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Line: not a Socket");
    return socket_set_option(ctx, s, "Line", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue socket_get_eol(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewString(ctx, s && s->eol ? s->eol : "\n");
}

static JSValue socket_set_eol(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    SocketData *s = socket_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "EndOfLine: not a Socket");
    return socket_set_option(ctx, s, "EndOfLine", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue socket_get_connected(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewBool(ctx, s && s->state == SOCKET_CONNECTED);
}

static JSValue socket_get_local_host(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewString(ctx, s && s->local_host ? s->local_host : "");
}

static JSValue socket_get_local_port(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewInt32(ctx, s ? s->local_port : 0);
}

static JSValue socket_get_remote_host(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewString(ctx, s && s->remote_host ? s->remote_host : "");
}

static JSValue socket_get_remote_port(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    return JS_NewInt32(ctx, s ? s->remote_port : 0);
}

static JSValue socket_get_server(JSContext *ctx, JSValueConst this_val)
{
    SocketData *s = socket_data(this_val);
    if (!s || JS_IsUndefined(s->server_val) || JS_IsNull(s->server_val))
        return JS_NULL;
    return JS_DupValue(ctx, s->server_val);
}

static JSValue socket_get_handler(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst *slot)
{
    (void)this_val;
    return JS_DupValue(ctx, *slot);
}

static JSValue socket_set_handler(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst v, JSValue *slot, const char *who)
{
    (void)this_val;
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "%s: expected a function, or null", who);
    JS_FreeValue(ctx, *slot);
    *slot = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;

    /* Assigning a read handler is how a socket starts reading; a server's
     * accepted client does it inside OnConnection. */
    SocketData *s = socket_data(this_val);
    if (s && (slot == &s->on_data || slot == &s->on_line))
        socket_start_read(s);
    return JS_UNDEFINED;
}

#define SOCKET_HANDLER(name, field, who)                                      \
    static JSValue socket_get_##name(JSContext *ctx, JSValueConst this_val)   \
    {                                                                         \
        SocketData *s = socket_data(this_val);                                \
        return s ? socket_get_handler(ctx, this_val, &s->field) : JS_NULL;    \
    }                                                                         \
    static JSValue socket_set_##name(JSContext *ctx, JSValueConst this_val,   \
                                     JSValueConst v)                          \
    {                                                                         \
        SocketData *s = socket_data(this_val);                                \
        if (!s)                                                               \
            return JS_ThrowTypeError(ctx, "%s: not a Socket", who);           \
        return socket_set_handler(ctx, this_val, v, &s->field, who);          \
    }

SOCKET_HANDLER(on_connected, on_connected, "Socket.OnConnected")
SOCKET_HANDLER(on_data,      on_data,      "Socket.OnData")
SOCKET_HANDLER(on_line,      on_line,      "Socket.OnLine")
SOCKET_HANDLER(on_closed,    on_closed,    "Socket.OnClosed")
SOCKET_HANDLER(on_error,     on_error,     "Socket.OnError")
SOCKET_HANDLER(on_writable,  on_writable,  "Socket.OnWritable")

static JSValue socket_connect(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    SocketData *s = socket_data(this_val);
    SocketJob  *j;

    if (!s)
        return JS_ThrowTypeError(ctx, "Connect: not a Socket");
    if (s->state != SOCKET_CLOSED)
        return JS_ThrowPlainError(ctx, "Socket.Connect: it is already connected");

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (s->path && *s->path)
            return JS_ThrowTypeError(ctx, "Socket.Connect(host, port): this socket "
                                          "has a Path; clear it first");
        if (!socket_set_option(ctx, s, "Host", argv[0]))
            return JS_EXCEPTION;
    }
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        if (!socket_set_option(ctx, s, "Port", argv[1]))
            return JS_EXCEPTION;
    }

    if (s->path && *s->path) {
        /* Unix socket; the path is the address. */
    } else {
        if (!s->host || !*s->host)
            return JS_ThrowPlainError(ctx, "Socket.Connect: Host is empty");
        if (s->port < 1 || s->port > 65535)
            return JS_ThrowRangeError(ctx, "Socket.Connect: Port is 1 to 65535, got %d", s->port);
    }

    s->closed_emitted = false;
    s->timed_out      = false;
    s->state          = SOCKET_CONNECTING;
    s->cancel         = g_cancellable_new();
    s->client         = g_socket_client_new();
    socket_live_add(s);

    if (s->timeout > 0)
        s->timeout_id = g_timeout_add(s->timeout, on_connect_timeout, s);

    j = job_new(JOB_CONNECT, ctx, s->self, s);
    if (s->path && *s->path) {
#ifdef G_OS_UNIX
        GSocketAddress *addr = g_unix_socket_address_new(s->path);
        j->is_unix = true;
        g_socket_client_connect_async(s->client, G_SOCKET_CONNECTABLE(addr),
                                      s->cancel, on_connect, j);
        g_object_unref(addr);
#else
        job_free(j);
        socket_close_full(s, false, false);
        return JS_ThrowPlainError(ctx, "Socket.Connect: Unix sockets are not "
                                       "available on this platform; use a TCP port");
#endif
    } else {
        g_socket_client_connect_to_host_async(s->client, s->host,
                                              (guint16)s->port, s->cancel, on_connect, j);
    }
    return JS_DupValue(ctx, this_val);
}

static JSValue socket_write(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    SocketData *s = socket_data(this_val);
    GBytes *bytes = NULL;

    if (!s)
        return JS_ThrowTypeError(ctx, "Write: not a Socket");
    if (s->state != SOCKET_CONNECTED)
        return JS_ThrowPlainError(ctx, "Socket.Write: it is not connected");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Socket.Write(data): needs the data");

    if (JS_IsString(argv[0])) {
        size_t len = 0;
        const char *text = JS_ToCStringLen(ctx, &len, argv[0]);

        if (!text)
            return JS_EXCEPTION;
        bytes = g_bytes_new(text, len);
        JS_FreeCString(ctx, text);
    } else {
        size_t len = 0;
        const uint8_t *data = bta_bytes_get(argv[0], &len);

        if (!data)
            return JS_ThrowTypeError(ctx, "Socket.Write: expected text or Bytes");
        bytes = g_bytes_new(data, len);
    }

    if (g_bytes_get_size(bytes) == 0) {
        g_bytes_unref(bytes);
        return JS_DupValue(ctx, this_val);
    }
    g_queue_push_tail(s->writes, bytes);
    socket_write_start(s);
    return JS_DupValue(ctx, this_val);
}

static JSValue socket_close_method(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    SocketData *s = socket_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Close: not a Socket");
    socket_close_full(s, true, false);
    return JS_DupValue(ctx, this_val);
}

/* type Socket */
static const JSCFunctionListEntry socket_props[] = {
    /* Host
     *   the name or address to connect to. Set before `Connect`; a Unix
     *   socket uses `Path` instead
     */
    JS_CGETSET_DEF("Host", socket_get_host, socket_set_host),
    /* Port
     *   the TCP port to connect to, 1 to 65535. `0` is refused by `Connect`
     */
    JS_CGETSET_DEF("Port", socket_get_port, socket_set_port),
    /* Path
     *   a Unix domain socket path, instead of Host/Port. On Windows it makes
     *   `Connect` refuse; the portable local road is `Ipc.Pipe`
     */
    JS_CGETSET_DEF("Path", socket_get_path, socket_set_path),
    /* Tls
     *   `true` trusts the system's store; `{ Ca, Cert }` names a CA file
     *   and/or a certificate to pin; `null` (the default) is a plain socket.
     *   Read back as what was set
     */
    JS_CGETSET_DEF("Tls", socket_get_tls, socket_set_tls_property),
    /* Timeout
     *   how long `Connect` may take, in milliseconds; `0` is none. The
     *   read side waits as long as the peer takes, which is what a scale or a
     *   printer does
     */
    JS_CGETSET_DEF("Timeout", socket_get_timeout, socket_set_timeout),
    /* Line
     *   `true`: buffer and raise `OnLine` for each complete `EndOfLine`;
     *   `false` (the default): `OnData` with the bytes one read returned.
     *   **TCP has no messages**, so a chunk is not a frame
     */
    JS_CGETSET_DEF("Line", socket_get_line, socket_set_line),
    /* EndOfLine
     *   the line separator `Line` uses, `"\n"` by default: `"\r\n"` for
     *   many devices
     */
    JS_CGETSET_DEF("EndOfLine", socket_get_eol, socket_set_eol),
    /* Connected
     *   whether the connection is up now
     */
    JS_CGETSET_DEF("Connected", socket_get_connected, NULL),
    /* LocalHost
     *   the local address once connected, `""` before
     */
    JS_CGETSET_DEF("LocalHost", socket_get_local_host, NULL),
    /* LocalPort
     *   the local port once connected, `0` before
     */
    JS_CGETSET_DEF("LocalPort", socket_get_local_port, NULL),
    /* RemoteHost
     *   the peer's numeric address (or Unix path) once connected
     */
    JS_CGETSET_DEF("RemoteHost", socket_get_remote_host, NULL),
    /* RemotePort
     *   the peer's port once connected, `0` for a Unix socket
     */
    JS_CGETSET_DEF("RemotePort", socket_get_remote_port, NULL),
    /* Server
     *   the `ServerSocket` that accepted this socket, or `null` for one the
     *   program connected itself
     */
    JS_CGETSET_DEF("Server", socket_get_server, NULL),
    /* OnConnected
     *   assign `() => …`: the connection is ready, and the first `Write`
     *   belongs here. `null` takes it off
     */
    JS_CGETSET_DEF("OnConnected", socket_get_on_connected, socket_set_on_connected),
    /* OnData
     *   assign `(bytes) => …`: bytes arrived, **not** a message. `Line: true`
     *   uses `OnLine` instead
     */
    JS_CGETSET_DEF("OnData", socket_get_on_data, socket_set_on_data),
    /* OnLine
     *   assign `(line) => …`: one complete line, without the separator, in
     *   `Line: true` mode
     */
    JS_CGETSET_DEF("OnLine", socket_get_on_line, socket_set_on_line),
    /* OnClosed
     *   assign `() => …`: the connection ended, by the peer, by `Close`, or
     *   after `OnError`. It is raised once per connection
     */
    JS_CGETSET_DEF("OnClosed", socket_get_on_closed, socket_set_on_closed),
    /* OnError
     *   assign `(err) => …` with `{ Message, Kind }`, `Kind` one of `"Dns"`,
     *   `"Refused"`, `"Unreachable"`, `"Timeout"`, `"Tls"`, `"NotAllowed"`,
     *   `"Cancelled"` or `"Error"`. `OnClosed` follows
     */
    JS_CGETSET_DEF("OnError", socket_get_on_error, socket_set_on_error),
    /* OnWritable
     *   assign `() => …`: the write queue is empty and the socket can take
     *   more. `Write` never blocks, so this is the flow-control answer
     */
    JS_CGETSET_DEF("OnWritable", socket_get_on_writable, socket_set_on_writable),
    /* Connect([host], [port])
     *   start connecting; the optional arguments are a TCP shorthand for the
     *   properties. Answers the socket
     */
    JS_CFUNC_DEF("Connect", 2, socket_connect),
    /* Write(data)
     *   queue text (UTF-8) or `Bytes`; answers the socket. It throws when the
     *   socket is not connected, which is a mistake and not a late answer
     */
    JS_CFUNC_DEF("Write", 1, socket_write),
    /* Close()
     *   close now; `OnClosed` is raised once. Answers the socket
     */
    JS_CFUNC_DEF("Close", 0, socket_close_method),
};

/* ---------------------------------------------------------- server properties */

static bool server_set_option(JSContext *ctx, ServerData *s,
                              const char *key, JSValueConst value)
{
    if (!strcmp(key, "Host")) {
        const char *text;

        if (s->listening)
            return JS_ThrowTypeError(ctx, "ServerSocket.Host: cannot change while listening"), false;
        if (!JS_IsString(value))
            return JS_ThrowTypeError(ctx, "ServerSocket.Host: expected \"local\" or \"any\""), false;
        text = JS_ToCString(ctx, value);
        if (!text)
            return false;
        if (!strcmp(text, "local"))
            s->local = true;
        else if (!strcmp(text, "any"))
            s->local = false;
        else {
            JS_FreeCString(ctx, text);
            return JS_ThrowTypeError(ctx, "ServerSocket.Host: expected \"local\" or \"any\""), false;
        }
        JS_FreeCString(ctx, text);
        return true;
    }
    if (!strcmp(key, "Port")) {
        int32_t port;

        if (s->listening)
            return JS_ThrowTypeError(ctx, "ServerSocket.Port: cannot change while listening"), false;
        if (!bta_to_int(ctx, value, "ServerSocket.Port", &port))
            return false;
        if (port < 0 || port > 65535)
            return JS_ThrowRangeError(ctx, "ServerSocket.Port: 0 to 65535, got %d", port), false;
        s->port = port;
        return true;
    }
    if (!strcmp(key, "Path")) {
        const char *text;

        if (s->listening)
            return JS_ThrowTypeError(ctx, "ServerSocket.Path: cannot change while listening"), false;
        if (!JS_IsString(value))
            return JS_ThrowTypeError(ctx, "ServerSocket.Path: expected text"), false;
        text = JS_ToCString(ctx, value);
        if (!text)
            return false;
        g_free(s->path);
        s->path = g_strdup(text);
        JS_FreeCString(ctx, text);
        return true;
    }
    if (!strcmp(key, "Tls")) {
        GTlsCertificate *cert;
        char *c = NULL, *k = NULL;
        GError *err = NULL;

        if (s->listening)
            return JS_ThrowTypeError(ctx, "ServerSocket.Tls: cannot change while listening"), false;
        if (JS_IsNull(value) || JS_IsUndefined(value) || JS_IsBool(value)) {
            if (JS_ToBool(ctx, value)) {
                return JS_ThrowTypeError(ctx, "ServerSocket.Tls: expects { Cert, Key }"), false;
            }
            g_clear_object(&s->tls_cert);
            g_clear_pointer(&s->tls_cert_path, g_free);
            g_clear_pointer(&s->tls_key_path, g_free);
            return true;
        }
        if (!JS_IsObject(value))
            return JS_ThrowTypeError(ctx, "ServerSocket.Tls: expects { Cert, Key }"), false;

        JSPropertyEnum *props = NULL;
        uint32_t        n = 0;

        if (JS_GetOwnPropertyNames(ctx, &props, &n, value,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
            return false;
        for (uint32_t i = 0; i < n; i++) {
            const char *name = JS_AtomToCString(ctx, props[i].atom);
            bool        bad = !name || (strcmp(name, "Cert") && strcmp(name, "Key"));

            if (bad && name)
                JS_ThrowTypeError(ctx, "ServerSocket.Tls: no option called '%s'; "
                                       "the options are Cert and Key", name);
            JS_FreeCString(ctx, name);
            if (bad) {
                JS_FreePropertyEnum(ctx, props, n);
                return false;
            }
        }
        JS_FreePropertyEnum(ctx, props, n);

        JSValue cv = JS_GetPropertyStr(ctx, value, "Cert");
        JSValue kv = JS_GetPropertyStr(ctx, value, "Key");
        if (JS_IsException(cv) || JS_IsException(kv)) {
            JS_FreeValue(ctx, cv);
            JS_FreeValue(ctx, kv);
            return false;
        }
        if (!JS_IsString(cv) || !JS_IsString(kv)) {
            JS_FreeValue(ctx, cv);
            JS_FreeValue(ctx, kv);
            return JS_ThrowTypeError(ctx, "ServerSocket.Tls: Cert and Key are file paths"), false;
        }
        c = (char *)JS_ToCString(ctx, cv);
        k = (char *)JS_ToCString(ctx, kv);
        JS_FreeValue(ctx, cv);
        JS_FreeValue(ctx, kv);
        if (!c || !k) {
            JS_FreeCString(ctx, c);
            JS_FreeCString(ctx, k);
            return false;
        }
        cert = g_tls_certificate_new_from_files(c, k, &err);
        if (!cert) {
            JS_ThrowTypeError(ctx, "ServerSocket.Tls: cannot read the certificate '%s': %s",
                              c, bta_gerror_text(err));
            g_clear_error(&err);
            JS_FreeCString(ctx, c);
            JS_FreeCString(ctx, k);
            return false;
        }
        g_clear_object(&s->tls_cert);
        g_clear_pointer(&s->tls_cert_path, g_free);
        g_clear_pointer(&s->tls_key_path, g_free);
        s->tls_cert = cert;
        s->tls_cert_path = g_strdup(c);
        s->tls_key_path = g_strdup(k);
        JS_FreeCString(ctx, c);
        JS_FreeCString(ctx, k);
        return true;
    }
    return JS_ThrowTypeError(ctx, "ServerSocket: no option called '%s'; the options "
                             "are Host, Port, Path and Tls", key), false;
}

static bool server_apply_options(JSContext *ctx, ServerData *s, JSValueConst opts)
{
    JSPropertyEnum *props = NULL;
    uint32_t        n = 0;
    bool            ok = true;

    if (!JS_IsObject(opts))
        return JS_ThrowTypeError(ctx, "ServerSocket: the options are an object"), false;
    if (JS_GetOwnPropertyNames(ctx, &props, &n, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;

    for (uint32_t i = 0; i < n && ok; i++) {
        const char *key = JS_AtomToCString(ctx, props[i].atom);
        JSValue     v;

        if (!key) {
            ok = false;
            break;
        }
        v = JS_GetPropertyStr(ctx, opts, key);
        if (JS_IsException(v))
            ok = false;
        else {
            ok = server_set_option(ctx, s, key, v);
            JS_FreeValue(ctx, v);
        }
        JS_FreeCString(ctx, key);
    }
    JS_FreePropertyEnum(ctx, props, n);
    return ok;
}

static JSValue server_construct(JSContext *ctx, JSValueConst new_target,
                                int argc, JSValueConst *argv)
{
    JSValue obj = JS_NewObjectClass(ctx, server_class_id);
    ServerData *s;

    if (JS_IsException(obj))
        return obj;

    s = g_new0(ServerData, 1);
    s->ctx           = ctx;
    s->self          = obj;
    s->on_connection = JS_UNDEFINED;
    s->on_error      = JS_UNDEFINED;
    s->local         = true;
    s->clients       = g_ptr_array_new();
    JS_SetOpaque(obj, s);

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!server_apply_options(ctx, s, argv[0])) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
    }
    return obj;
}

static JSValue server_get_host(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    return JS_NewString(ctx, s && !s->local ? "any" : "local");
}

static JSValue server_set_host(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    ServerData *s = server_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Host: not a ServerSocket");
    return server_set_option(ctx, s, "Host", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue server_get_port(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    return JS_NewInt32(ctx, s ? s->port : 0);
}

static JSValue server_set_port(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    ServerData *s = server_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Port: not a ServerSocket");
    return server_set_option(ctx, s, "Port", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue server_get_path(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    return JS_NewString(ctx, s && s->path ? s->path : "");
}

static JSValue server_set_path(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    ServerData *s = server_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Path: not a ServerSocket");
    return server_set_option(ctx, s, "Path", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue server_get_tls(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    JSValue     o;

    if (!s || !s->tls_cert)
        return JS_NULL;
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "Cert", JS_NewString(ctx, s->tls_cert_path ? s->tls_cert_path : ""));
    JS_SetPropertyStr(ctx, o, "Key", JS_NewString(ctx, s->tls_key_path ? s->tls_key_path : ""));
    return o;
}

static JSValue server_set_tls(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    ServerData *s = server_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Tls: not a ServerSocket");
    return server_set_option(ctx, s, "Tls", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue server_get_listening(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    return JS_NewBool(ctx, s && s->listening);
}

static JSValue server_get_count(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    return JS_NewInt32(ctx, s && s->clients ? (int)s->clients->len : 0);
}

static JSValue server_get_on_connection(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    return s ? JS_DupValue(ctx, s->on_connection) : JS_NULL;
}

static JSValue server_set_on_connection(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    ServerData *s = server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "OnConnection: not a ServerSocket");
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "ServerSocket.OnConnection: expected a function, or null");
    JS_FreeValue(ctx, s->on_connection);
    s->on_connection = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

static JSValue server_get_on_error(JSContext *ctx, JSValueConst this_val)
{
    ServerData *s = server_data(this_val);
    return s ? JS_DupValue(ctx, s->on_error) : JS_NULL;
}

static JSValue server_set_on_error(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    ServerData *s = server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "OnError: not a ServerSocket");
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "ServerSocket.OnError: expected a function, or null");
    JS_FreeValue(ctx, s->on_error);
    s->on_error = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

static JSValue server_listen(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    ServerData *s = server_data(this_val);
    GError *err = NULL;

    if (!s)
        return JS_ThrowTypeError(ctx, "Listen: not a ServerSocket");
    if (s->stopping)
        return JS_ThrowPlainError(ctx, "ServerSocket.Listen: Stop is still closing "
                                       "the connections it held");
    if (s->listening)
        return JS_ThrowPlainError(ctx, "ServerSocket.Listen: it is already listening");
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!server_set_option(ctx, s, "Port", argv[0]))
            return JS_EXCEPTION;
    }

    s->listener = g_socket_listener_new();
    s->cancel   = g_cancellable_new();

    if (s->path && *s->path) {
#ifdef G_OS_UNIX
        GSocketAddress *addr = g_unix_socket_address_new(s->path);

        if (!g_socket_listener_add_address(s->listener, G_SOCKET_ADDRESS(addr),
                                           G_SOCKET_TYPE_STREAM,
                                           G_SOCKET_PROTOCOL_DEFAULT,
                                           NULL, NULL, &err)) {
            g_object_unref(addr);
            goto failed;
        }
        g_object_unref(addr);
        s->owns_path = true;
#else
        g_clear_object(&s->listener);
        g_clear_object(&s->cancel);
        return JS_ThrowPlainError(ctx, "ServerSocket.Listen: Unix sockets are not "
                                       "available on this platform; use a TCP port");
#endif
    } else if (s->local) {
        GInetAddress  *ia = g_inet_address_new_loopback(G_SOCKET_FAMILY_IPV4);
        GSocketAddress *addr = g_inet_socket_address_new(ia, (guint16)s->port);
        GSocketAddress *effective = NULL;

        if (!g_socket_listener_add_address(s->listener, addr,
                                           G_SOCKET_TYPE_STREAM,
                                           G_SOCKET_PROTOCOL_DEFAULT,
                                           NULL, &effective, &err)) {
            g_object_unref(addr);
            g_object_unref(ia);
            goto failed;
        }
        if (effective) {
            s->port = g_inet_socket_address_get_port(G_INET_SOCKET_ADDRESS(effective));
            g_object_unref(effective);
        }
        g_object_unref(addr);
        g_object_unref(ia);
    } else if (s->port == 0) {
        guint16 chosen = g_socket_listener_add_any_inet_port(s->listener, NULL, &err);

        if (!chosen)
            goto failed;
        s->port = chosen;
    } else if (!g_socket_listener_add_inet_port(s->listener, (guint16)s->port,
                                                NULL, &err)) {
        goto failed;
    }

    s->listening = true;
    server_live_add(s);
    server_accept(s);
    return JS_DupValue(ctx, this_val);

failed:
    {
        JSValue e = JS_ThrowPlainError(ctx, "ServerSocket.Listen: %s",
                                       bta_gerror_text(err));
        g_clear_error(&err);
        g_clear_object(&s->listener);
        g_clear_object(&s->cancel);
        return e;
    }
}

static JSValue server_stop_method(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    ServerData *s = server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Stop: not a ServerSocket");
    server_stop_full(s, true, false);
    return JS_DupValue(ctx, this_val);
}

/* type ServerSocket */
static const JSCFunctionListEntry server_props[] = {
    /* Host
     *   `"local"` (loopback, the default) or `"any"`, the same two words
     *   `Http.Server` uses
     */
    JS_CGETSET_DEF("Host", server_get_host, server_set_host),
    /* Port
     *   the TCP port to listen on, 0 to 65535. `0` asks the system for one;
     *   read it back after `Listen`
     */
    JS_CGETSET_DEF("Port", server_get_port, server_set_port),
    /* Path
     *   a Unix domain socket path, instead of Host/Port
     */
    JS_CGETSET_DEF("Path", server_get_path, server_set_path),
    /* Tls
     *   `{ Cert, Key }`: the PEM files every accepted connection is wrapped
     *   with, or nothing for a plain listener. A file that cannot be read is
     *   refused where it is written
     */
    JS_CGETSET_DEF("Tls", server_get_tls, server_set_tls),
    /* Listening
     *   whether it is accepting now
     */
    JS_CGETSET_DEF("Listening", server_get_listening, NULL),
    /* Count
     *   the connections that are alive now
     */
    JS_CGETSET_DEF("Count", server_get_count, NULL),
    /* OnConnection
     *   assign `(client) => …`: a `Socket` already connected. Set its
     *   handlers here; `client.Server` is this listener
     */
    JS_CGETSET_DEF("OnConnection", server_get_on_connection, server_set_on_connection),
    /* OnError
     *   assign `(err) => …` with `{ Message, Kind }`; an accept error does not
     *   stop the listener
     */
    JS_CGETSET_DEF("OnError", server_get_on_error, server_set_on_error),
    /* Listen([port])
     *   start accepting; the optional port is shorthand for the property.
     *   Answers the server
     */
    JS_CFUNC_DEF("Listen", 1, server_listen),
    /* Stop()
     *   stop accepting and close every connection the server still holds.
     *   Answers the server
     */
    JS_CFUNC_DEF("Stop", 0, server_stop_method),
};

static JSValue udp_construct(JSContext *ctx, JSValueConst new_target,
                             int argc, JSValueConst *argv)
{
    JSValue obj = JS_NewObjectClass(ctx, udp_class_id);
    UdpData *s;

    if (JS_IsException(obj))
        return obj;

    s = g_new0(UdpData, 1);
    s->ctx      = ctx;
    s->self     = obj;
    s->keep     = JS_UNDEFINED;
    s->on_data  = JS_UNDEFINED;
    s->on_error = JS_UNDEFINED;
    s->host     = g_strdup("local");
    JS_SetOpaque(obj, s);

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!udp_apply_options(ctx, s, argv[0])) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
    }
    return obj;
}

static JSValue udp_get_host(JSContext *ctx, JSValueConst this_val)
{
    UdpData *s = udp_data(this_val);
    return JS_NewString(ctx, s && s->host ? s->host : "local");
}

static JSValue udp_set_host(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    UdpData *s = udp_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Host: not a UdpSocket");
    return udp_set_option(ctx, s, "Host", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue udp_get_port(JSContext *ctx, JSValueConst this_val)
{
    UdpData *s = udp_data(this_val);
    return JS_NewInt32(ctx, s ? s->port : 0);
}

static JSValue udp_set_port(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    UdpData *s = udp_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Port: not a UdpSocket");
    return udp_set_option(ctx, s, "Port", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue udp_get_broadcast(JSContext *ctx, JSValueConst this_val)
{
    UdpData *s = udp_data(this_val);
    return JS_NewBool(ctx, s && s->broadcast);
}

static JSValue udp_set_broadcast(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    UdpData *s = udp_data(this_val);
    if (!s)
        return JS_ThrowTypeError(ctx, "Broadcast: not a UdpSocket");
    return udp_set_option(ctx, s, "Broadcast", v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue udp_get_bound(JSContext *ctx, JSValueConst this_val)
{
    UdpData *s = udp_data(this_val);
    return JS_NewBool(ctx, s && s->bound);
}

static JSValue udp_get_on_data(JSContext *ctx, JSValueConst this_val)
{
    UdpData *s = udp_data(this_val);
    return s ? JS_DupValue(ctx, s->on_data) : JS_NULL;
}

static JSValue udp_set_on_data(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    UdpData *s = udp_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "OnData: not a UdpSocket");
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "UdpSocket.OnData: expected a function, or null");
    JS_FreeValue(ctx, s->on_data);
    s->on_data = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

static JSValue udp_get_on_error(JSContext *ctx, JSValueConst this_val)
{
    UdpData *s = udp_data(this_val);
    return s ? JS_DupValue(ctx, s->on_error) : JS_NULL;
}

static JSValue udp_set_on_error(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    UdpData *s = udp_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "OnError: not a UdpSocket");
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "UdpSocket.OnError: expected a function, or null");
    JS_FreeValue(ctx, s->on_error);
    s->on_error = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

/* type UdpSocket */
static const JSCFunctionListEntry udp_props[] = {
    /* Host
     *   `"local"` (loopback, the default) or `"any"`, the interface the
     *   socket binds to. This stage binds IPv4
     */
    JS_CGETSET_DEF("Host", udp_get_host, udp_set_host),
    /* Port
     *   the local port, 0 to 65535. `0` asks the system for one; after
     *   `Bind` this is the port really held
     */
    JS_CGETSET_DEF("Port", udp_get_port, udp_set_port),
    /* Broadcast
     *   whether `Send` may reach a broadcast address. Set it before `Bind`
     *   (or later; the socket takes it while it is open)
     */
    JS_CGETSET_DEF("Broadcast", udp_get_broadcast, udp_set_broadcast),
    /* Bound
     *   whether it holds a local port now
     */
    JS_CGETSET_DEF("Bound", udp_get_bound, NULL),
    /* OnData
     *   assign `(bytes, from) => …`: one datagram and its sender as
     *   `{ Host, Port }`. Datagram boundaries are the kernel's, not this
     *   file's: one `Send` is one `OnData`
     */
    JS_CGETSET_DEF("OnData", udp_get_on_data, udp_set_on_data),
    /* OnError
     *   assign `(err) => …` with `{ Message, Kind }`; a receive error does
     *   not close the socket
     */
    JS_CGETSET_DEF("OnError", udp_get_on_error, udp_set_on_error),
    /* Bind([port])
     *   hold a local port and start receiving; the optional port is
     *   shorthand for the property. Answers the socket
     */
    JS_CFUNC_DEF("Bind", 1, udp_bind_method),
    /* Send(data, host, port)
     *   send one datagram of text (UTF-8) or `Bytes`. `host` is an IP
     *   address, not a name; `from` is a record an `OnData` was handed, and
     *   `Send(data, from)` is the same call with its two fields. Sending
     *   before `Bind` binds an ephemeral port first
     */
    JS_CFUNC_DEF("Send", 3, udp_send),
    /* Close()
     *   release the port; answers the socket
     */
    JS_CFUNC_DEF("Close", 0, udp_close_method),
};

/* --------------------------------------------------------------- finalizers */

static void socket_finalizer(JSRuntime *rt, JSValue v)
{
    SocketData *s = JS_GetOpaque(v, socket_class_id);

    if (!s)
        return;

    socket_close_full(s, false, true);
    JS_FreeValueRT(rt, s->keep);
    JS_FreeValueRT(rt, s->on_connected);
    JS_FreeValueRT(rt, s->on_data);
    JS_FreeValueRT(rt, s->on_line);
    JS_FreeValueRT(rt, s->on_closed);
    JS_FreeValueRT(rt, s->on_error);
    JS_FreeValueRT(rt, s->on_writable);
    JS_FreeValueRT(rt, s->server_val);
    g_clear_object(&s->tls_db);
    g_clear_object(&s->tls_cert);
    g_free(s->tls_ca_path);
    g_free(s->tls_cert_path);
    g_free(s->host);
    g_free(s->path);
    g_free(s->eol);
    g_free(s->local_host);
    g_free(s->remote_host);
    if (s->writes)
        g_queue_free_full(s->writes, (GDestroyNotify)g_bytes_unref);
    if (s->linebuf)
        g_byte_array_unref(s->linebuf);
    g_free(s);
}

static void socket_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    SocketData *s = JS_GetOpaque(v, socket_class_id);

    if (!s)
        return;
    JS_MarkValue(rt, s->keep, mark);
    JS_MarkValue(rt, s->on_connected, mark);
    JS_MarkValue(rt, s->on_data, mark);
    JS_MarkValue(rt, s->on_line, mark);
    JS_MarkValue(rt, s->on_closed, mark);
    JS_MarkValue(rt, s->on_error, mark);
    JS_MarkValue(rt, s->on_writable, mark);
    JS_MarkValue(rt, s->server_val, mark);
}

static void server_finalizer(JSRuntime *rt, JSValue v)
{
    ServerData *s = JS_GetOpaque(v, server_class_id);

    if (!s)
        return;

    server_stop_full(s, false, true);
    JS_FreeValueRT(rt, s->on_connection);
    JS_FreeValueRT(rt, s->on_error);
    g_clear_object(&s->tls_cert);
    g_free(s->tls_cert_path);
    g_free(s->tls_key_path);
    g_free(s->path);
    if (s->clients)
        g_ptr_array_free(s->clients, TRUE);
    g_free(s);
}

static void server_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    ServerData *s = JS_GetOpaque(v, server_class_id);

    if (!s)
        return;
    JS_MarkValue(rt, s->on_connection, mark);
    JS_MarkValue(rt, s->on_error, mark);
    /* The server owns its connections.  The list is `SocketData *` and not
     * `JSValue`, but a wrapper only in it must still be reachable: without
     * this mark the collector is free to take an accepted client between
     * `OnConnection` and the handler that would have kept it, close it in its
     * finalizer, and leave `Count` at zero while the program still talks to
     * it. */
    for (guint i = 0; s->clients && i < s->clients->len; i++) {
        SocketData *c = g_ptr_array_index(s->clients, i);

        if (c)
            JS_MarkValue(rt, c->self, mark);
    }
}

static const JSClassDef socket_def = {
    "Socket",
    .finalizer = socket_finalizer,
    .gc_mark   = socket_gc_mark,
};

static const JSClassDef server_def = {
    "ServerSocket",
    .finalizer = server_finalizer,
    .gc_mark   = server_gc_mark,
};

static void udp_finalizer(JSRuntime *rt, JSValue v)
{
    UdpData *s = JS_GetOpaque(v, udp_class_id);

    if (!s)
        return;

    udp_close_full(s, true);
    JS_FreeValueRT(rt, s->keep);
    JS_FreeValueRT(rt, s->on_data);
    JS_FreeValueRT(rt, s->on_error);
    g_free(s->host);
    g_free(s);
}

static void udp_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    UdpData *s = JS_GetOpaque(v, udp_class_id);

    if (!s)
        return;
    JS_MarkValue(rt, s->keep, mark);
    JS_MarkValue(rt, s->on_data, mark);
    JS_MarkValue(rt, s->on_error, mark);
}

static const JSClassDef udp_def = {
    "UdpSocket",
    .finalizer = udp_finalizer,
    .gc_mark   = udp_gc_mark,
};

/* ------------------------------------------------------------------- init */

static JSValue socket_worker_construct(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
    return JS_ThrowPlainError(ctx, "Socket: a Task worker has no main loop, so "
                                   "there is nothing to deliver the bytes to. "
                                   "Keep the socket on the window's thread");
}

static JSValue server_worker_construct(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
    return JS_ThrowPlainError(ctx, "ServerSocket: a Task worker has no main loop "
                                   "and cannot accept connections");
}

static JSValue udp_worker_construct(JSContext *ctx, JSValueConst new_target,
                                    int argc, JSValueConst *argv)
{
    return JS_ThrowPlainError(ctx, "UdpSocket: a Task worker has no main loop, "
                                   "so there is nothing to deliver the datagrams to");
}

void bta_socket_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSValue    sock_proto, sock_ctor, server_proto, server_ctor;
    JSValue    udp_proto, udp_ctor;

    JS_NewClassID(rt, &socket_class_id);
    JS_NewClass(rt, socket_class_id, &socket_def);
    sock_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, sock_proto, socket_props, G_N_ELEMENTS(socket_props));
    JS_SetClassProto(ctx, socket_class_id, sock_proto);
    sock_ctor = JS_NewCFunction2(ctx, socket_construct, "Socket", 0,
                                 JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, sock_ctor, sock_proto);
    JS_SetPropertyStr(ctx, global, "Socket", sock_ctor);

    JS_NewClassID(rt, &server_class_id);
    JS_NewClass(rt, server_class_id, &server_def);
    server_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, server_proto, server_props, G_N_ELEMENTS(server_props));
    JS_SetClassProto(ctx, server_class_id, server_proto);
    server_ctor = JS_NewCFunction2(ctx, server_construct, "ServerSocket", 0,
                                   JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, server_ctor, server_proto);
    JS_SetPropertyStr(ctx, global, "ServerSocket", server_ctor);

    JS_NewClassID(rt, &udp_class_id);
    JS_NewClass(rt, udp_class_id, &udp_def);
    udp_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, udp_proto, udp_props, G_N_ELEMENTS(udp_props));
    JS_SetClassProto(ctx, udp_class_id, udp_proto);
    udp_ctor = JS_NewCFunction2(ctx, udp_construct, "UdpSocket", 0,
                                JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, udp_ctor, udp_proto);
    JS_SetPropertyStr(ctx, global, "UdpSocket", udp_ctor);
}

void bta_socket_init_worker(JSContext *ctx, JSValue global)
{
    JSValue ctor;

    ctor = JS_NewCFunction2(ctx, socket_worker_construct, "Socket", 0,
                            JS_CFUNC_constructor, 0);
    JS_SetPropertyStr(ctx, global, "Socket", ctor);
    ctor = JS_NewCFunction2(ctx, server_worker_construct, "ServerSocket", 0,
                            JS_CFUNC_constructor, 0);
    JS_SetPropertyStr(ctx, global, "ServerSocket", ctor);
    ctor = JS_NewCFunction2(ctx, udp_worker_construct, "UdpSocket", 0,
                            JS_CFUNC_constructor, 0);
    JS_SetPropertyStr(ctx, global, "UdpSocket", ctor);
}

guint bta_socket_pending(void)
{
    return g_list_length(socket_live) + g_list_length(server_live) +
           g_list_length(udp_live);
}

void bta_socket_cleanup(void)
{
    while (socket_live) {
        SocketData *s = socket_live->data;

        socket_close_full(s, false, false);
    }
    while (server_live) {
        ServerData *s = server_live->data;

        server_stop_full(s, false, false);
    }
    while (udp_live) {
        UdpData *s = udp_live->data;

        udp_close_full(s, false);
    }
    while (socket_jobs) {
        SocketJob *j = socket_jobs->data;

        job_free(j);
    }
}
