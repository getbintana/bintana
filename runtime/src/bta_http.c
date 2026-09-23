/*
 * Http -- a native HTTP client over libsoup3.
 *
 * Phase 1: `Http.Client({BaseUrl, Headers, Timeout, FollowRedirects})` holding
 * its own SoupSession, plus `Request/Get/Post` (async, two callbacks) and
 * `RequestWait/GetWait/PostWait` (blocking, answering with a record).
 * `Http.Get/...` are shorthands on a shared default client.
 * Phase 2: the remaining verbs, `Auth` (Basic, preemptive -- libsoup3 has no
 * session authenticate signal and its replacement wants a challenge round
 * trip), `Language` (Accept-Language) and `Proxy` off.
 *
 * Two callbacks, Exec-style: 4xx/5xx go to onDone (it is an answer),
 * transport/DNS/TLS/timeout go to onError. Body is always Bytes.
 *
 * Optional at build time (BTA_HAVE_SOUP); without it Http exists and says
 * which package is missing -- the bta_sqlite.c mold.
 */
#include "bta.h"

#include <string.h>

#ifdef BTA_HAVE_SOUP
#include <libsoup/soup.h>

static SoupSession *http_default_session = NULL;
static SoupSession *http_default_sync_session = NULL;

/* One client, two sessions. A pooled connection answers on the context it
 * was made under: the async one's is the default loop, which outlives every
 * request, while each Wait runs on a context of its own that is gone before
 * the next call. Sharing one session between the two poisons the pool in both
 * directions -- a Wait borrowing an async connection, or async borrowing a
 * Wait's, wedges instead of answering -- so each family pools with its own
 * and a Wait takes a fresh connection on top (`NEW_CONNECTION`, never
 * borrowing at all). Measured against https, where reuse is real; over plain
 * HTTP/1.0 the pool never fills and none of this shows. */
typedef struct {
    SoupSession *sess;       /* async flights, on the default context */
    SoupSession *sess_sync;  /* blocking Waits, on contexts of their own */
    char        *base_url;   /* NULL for none */
    JSValue      headers;    /* defaults object, duplicated -- reported via gc_mark */
    int          timeout_ms; /* our guard; 0 waits forever */
    bool         follow;     /* true by default */
    char        *language;   /* Accept-Language; NULL sends none */
    char        *user_agent; /* User-Agent; NULL sends none (and some servers
                              * refuse the nameless, with a 402 and no body) */
    bool         proxy_off;  /* true: direct, no system proxy */
    char        *proxy_url;   /* a proxy of our own; NULL is system or off */
    char        *auth_user;  /* client credentials; NULL asks for none */
    char        *auth_pass;
    bool         cookies;    /* true: a jar shared by both sessions */
    SoupCookieJar *jar;      /* owned while cookies are on */
    int           log_level; /* SoupLoggerLogLevel; NONE is off */
    int           idle_ms;   /* 0 is soup's own default (60 s) */
    int           max_conns;     /* constructor-only: soup takes them once */
    int           max_per_host;
} HttpClientData;

static JSClassID http_client_class_id;

typedef struct {
    JSContext    *ctx;
    JSValue       on_line;   /* Stream's per-line callback; UNDEFINED on the rest */
    JSValue       on_done;
    JSValue       on_error;
    JSValue       handle;
    SoupSession  *sess;      /* referenced for the flight */
    SoupMessage  *msg;
    GCancellable *cancellable;
    /* A streamed 2xx is read line by line off this; a streamed anything-else
     * is spliced whole into `sink` instead, because an error page is an
     * answer and not a feed. Both NULL on the buffered road. */
    GDataInputStream *lines;
    GOutputStream    *sink;
    guint         guard;
    int           id;
    bool          timed_out;
    /* Answered already: the callbacks run before the job is freed (so a
     * handler asking the handle what happened is answered), and a Stop from
     * inside one must find nothing left to signal -- the reaped mold. */
    bool          finished;
    /*
     * Whether this job is inside its own line callback, and whether it was
     * freed while it was.
     *
     * **A stream is routinely stopped from within its own callback**: the
     * line that says the turn ended is exactly where an application stops
     * following. `File.Watch` learned this the hard way and the comment at
     * `bta_sys.c:420` is the long version -- the job was freed and then read
     * back by the lines after the call. So a free in here only *marks*, and
     * the frame that owns the job does it once it is finished with it.
     */
    bool          calling;
    bool          dead;
    char         *who;       /* the caller's name, for the error text */
    char         *url;       /* what was asked, for the same */
} HttpJob;

static GList *http_jobs;
static int    http_next_id = 1;

/* ------------------------------------------------------------------ jobs */

static void http_job_free(HttpJob *job)
{
    http_jobs = g_list_remove(http_jobs, job);

    /*
     * Freed from inside its own line callback: mark, and let the reading frame
     * do it. The mark lives here rather than at each caller because there are
     * three of them already -- the two deliverers and the teardown -- and a
     * fourth added later would reopen the segfault in silence. Coming off
     * `http_jobs` first is what makes that safe: the teardown's `while
     * (http_jobs)` still terminates, and a second `Stop()` answers false.
     */
    if (job->calling) {
        job->dead = true;
        return;
    }

    /* Before anything else: a guard firing on a freed job is the UAF. */
    if (job->guard)
        g_source_remove(job->guard);

    /* The line reader first: it holds a ref of its own on soup's stream, and
     * a GFilterInputStream closes its base, which is what drops a feed that
     * is still talking instead of leaving the socket held. */
    g_clear_object(&job->lines);
    g_clear_object(&job->sink);

    JS_FreeValue(job->ctx, job->on_line);
    JS_FreeValue(job->ctx, job->on_done);
    JS_FreeValue(job->ctx, job->on_error);
    JS_FreeValue(job->ctx, job->handle);
    g_clear_object(&job->msg);
    g_clear_object(&job->cancellable);
    if (job->sess)
        g_object_unref(job->sess);
    g_free(job->who);
    g_free(job->url);
    g_free(job);
}

/* Still ours? A stream has a read armed on it for its whole life, and the
 * teardown frees jobs with those reads outstanding -- the completion still
 * fires, with `data` pointing at freed memory. Every live job is on
 * `http_jobs` and a freed one is off it before anything else happens, so
 * membership is the liveness test; the list is one request deep in practice.
 * (`on_exec_line` gets away without this by returning on CANCELLED, which
 * works only because its teardown cancels first.) */
static bool http_job_alive(HttpJob *job)
{
    return g_list_find(http_jobs, job) != NULL;
}

static HttpClientData *http_client_data(JSValueConst v)
{
    return JS_GetOpaque(v, http_client_class_id);
}

static void http_client_finalizer(JSRuntime *rt, JSValue v)
{
    HttpClientData *c = JS_GetOpaque(v, http_client_class_id);

    if (!c)
        return;
    if (c->sess)
        g_object_unref(c->sess);
    if (c->sess_sync)
        g_object_unref(c->sess_sync);
    if (c->jar)
        g_object_unref(c->jar);
    g_free(c->proxy_url);
    g_free(c->base_url);
    /* The runtime is what a finalizer is handed, and freeing against it is
     * what the value wants -- no context has to be kept beside it. */
    JS_FreeValueRT(rt, c->headers);
    g_free(c->language);
    g_free(c->user_agent);
    g_free(c->auth_user);
    g_free(c->auth_pass);
    g_free(c);
}

/* The defaults object is a strong reference living in an opaque slot, so the
 * collector is told about it: without this a `Headers` object that reaches
 * back to its own client is a cycle nothing can see, and the pair leaks for
 * the life of the program. The Action/MenuItem mold. */
static void http_client_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    HttpClientData *c = JS_GetOpaque(v, http_client_class_id);

    if (c)
        JS_MarkValue(rt, c->headers, mark);
}

/* Basic credentials as the wire wants them. libsoup3 removed the session's
 * `authenticate` signal (it errors when connected), and its replacement --
 * recording an auth built from a challenge -- is a second round trip driven
 * from here for a scheme almost no JSON API speaks. A 401/407 from anything
 * else is answered, like any other status. */
static void http_apply_auth(SoupMessage *msg, const char *user, const char *pass)
{
    char *joined;
    char *coded;
    char *value;

    if (!user)
        return;
    joined = g_strconcat(user, ":", pass ? pass : "", NULL);
    coded = g_base64_encode((const guchar *)joined, strlen(joined));
    value = g_strconcat("Basic ", coded, NULL);
    /* Before the declared headers, so an explicit Authorization wins: the
     * specific spelling beats the general one. */
    soup_message_headers_replace(soup_message_get_request_headers(msg),
                                 "Authorization", value);
    g_free(joined);
    g_free(coded);
    g_free(value);
}

/* Soup's lines end where they started: async traffic may call home (the
 * loop is the application's own), while a Wait's must never run JS -- its
 * context is private and its caller is blocked mid-call. */
static void http_log_strip(char *line)
{
    size_t n = strlen(line);

    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r'))
        line[--n] = '\0';
}

static void http_log_async(SoupLogger *logger, SoupLoggerLogLevel level, char direction,
                           const char *data, gpointer user_data)
{
    BtaApp *app = bta_current_app();
    char   *line = g_strdup(data ? data : "");

    (void)logger;
    (void)level;
    (void)direction;
    (void)user_data;
    http_log_strip(line);
    if (app && app->ctx)
        bta_log_debug(app->ctx, line);
    else
        bta_log_debug_plain(line);
    g_free(line);
}

static void http_log_sync(SoupLogger *logger, SoupLoggerLogLevel level, char direction,
                          const char *data, gpointer user_data)
{
    char *line = g_strdup(data ? data : "");

    (void)logger;
    (void)level;
    (void)direction;
    (void)user_data;
    http_log_strip(line);
    bta_log_debug_plain(line);
    g_free(line);
}

/* A session with the constructor-only knobs baked in: soup takes max-conns
 * once and never again, so both of a client's sessions are born with them. */
static SoupSession *http_session_new(int max_conns, int max_per_host)
{
    return soup_session_new_with_options("max-conns", (guint)max_conns,
                                         "max-conns-per-host", (guint)max_per_host,
                                         NULL);
}

/* Language, proxy, cookies and log live on the sessions; called at creation
 * and from the setters, since all four are mutable after it. Both sessions
 * are told alike, so a login through one is visible from the other -- except
 * the traffic log's printer, which is per family for the reason above.
 *
 * The jar lives on the async session and only visits the sync one: one
 * feature instance on two sessions at once corrupts the heap on the way out
 * (both session finalizers walk it), so a Wait borrows it for the flight
 * instead -- exclusive by construction, since a Wait freezes the loop every
 * async flight is parked on. */
static void http_client_apply_session(HttpClientData *c)
{
    GProxyResolver *resolver;
    SoupSession    *pair[2];
    int             n = 0;

    if (!c)
        return;
    if (c->sess)
        pair[n++] = c->sess;
    if (c->sess_sync)
        pair[n++] = c->sess_sync;
    if (!c->cookies && c->jar) {
        g_clear_object(&c->jar);
    } else if (c->cookies && !c->jar) {
        c->jar = soup_cookie_jar_new();
    }
    for (int i = 0; i < n; i++) {
        soup_session_set_accept_language(pair[i], c->language);
        soup_session_set_user_agent(pair[i], c->user_agent);
        /* Soup counts seconds where we count milliseconds; 0 leaves its own
         * default alone. */
        if (c->idle_ms > 0)
            soup_session_set_idle_timeout(pair[i], (guint)((c->idle_ms + 999) / 1000));
        if (c->proxy_url) {
            /* Ours, for every URI: a proxy of our own beats the system's. */
            resolver = G_PROXY_RESOLVER(g_simple_proxy_resolver_new(c->proxy_url, NULL));
            soup_session_set_proxy_resolver(pair[i], resolver);
            g_object_unref(resolver);
        } else if (c->proxy_off) {
            /* A resolver with nowhere to resolve to: direct, always. NULL
             * would ask for the system one back, which is the opposite. */
            resolver = G_PROXY_RESOLVER(g_simple_proxy_resolver_new(NULL, NULL));
            soup_session_set_proxy_resolver(pair[i], resolver);
            g_object_unref(resolver);
        } else {
            soup_session_set_proxy_resolver(pair[i], NULL);
        }
        /* One jar at most, and only on the async session: taking it off and
         * putting it back on keeps a toggled flag from stacking. */
        soup_session_remove_feature_by_type(pair[i], SOUP_TYPE_COOKIE_JAR);
        if (c->jar && pair[i] == c->sess)
            soup_session_add_feature(pair[i], SOUP_SESSION_FEATURE(c->jar));
        /* Same for the traffic log -- except the printer, which follows the
         * family: async lines may reach the Handler, sync ones never do. */
        soup_session_remove_feature_by_type(pair[i], SOUP_TYPE_LOGGER);
        if (c->log_level != SOUP_LOGGER_LOG_NONE) {
            SoupLogger *logger = soup_logger_new((SoupLoggerLogLevel)c->log_level);

            soup_logger_set_printer(logger,
                                    pair[i] == c->sess ? http_log_async : http_log_sync,
                                    NULL, NULL);
            soup_session_add_feature(pair[i], SOUP_SESSION_FEATURE(logger));
            g_object_unref(logger);
        }
    }
}

/* ---------------------------------------------------------------- helpers */

static bool http_is_absolute(const char *url)
{
    return url && (g_str_has_prefix(url, "http://") || g_str_has_prefix(url, "https://"));
}

/* An int option off an object; fallback when absent. Garbage is refused via
 * bta_to_int -- a bare ToInt32 would silently read 0, the Margin trap -- so
 * this answers success and the caller unwinds on false. Negative refused by
 * the caller, which knows whether it means anything. */
static bool http_int_opt(JSContext *ctx, JSValueConst opts, const char *key,
                         int fallback, int *out)
{
    JSValue v;

    *out = fallback;
    if (!JS_IsObject(opts))
        return true;
    v = JS_GetPropertyStr(ctx, opts, key);
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }
    int32_t n = 0;

    if (!bta_to_int(ctx, v, key, &n)) {
        JS_FreeValue(ctx, v);
        return false;
    }
    JS_FreeValue(ctx, v);
    *out = (int)n;
    return true;
}

static bool http_bool_opt(JSContext *ctx, JSValueConst opts, const char *key,
                          bool fallback, bool *present)
{
    if (!JS_IsObject(opts)) {
        if (present)
            *present = false;
        return fallback;
    }
    JSValue v = JS_GetPropertyStr(ctx, opts, key);
    bool out = fallback;

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        if (present)
            *present = false;
    } else {
        if (present)
            *present = true;
        out = JS_ToBool(ctx, v) > 0;
    }
    JS_FreeValue(ctx, v);
    return out;
}

/* What an options object may name. One table, because the two argument
 * splits below both have to answer "body or options?" about the same object,
 * and a key added to one list and not the other is a request that quietly
 * posts its own options as JSON -- which is what `FollowRedirects` did while
 * it was only in the async list. */
static const char *const HTTP_OPT_KEYS[] = {
    "Query", "Headers", "Timeout", "FollowRedirects", "ContentType", "Body", "Auth",
};

/* True when the object names any of them: then it is options, not a body. */
static bool http_looks_like_opts(JSContext *ctx, JSValueConst v)
{
    if (!JS_IsObject(v) || JS_IsArray(v) || JS_IsFunction(ctx, v))
        return false;
    for (unsigned i = 0; i < G_N_ELEMENTS(HTTP_OPT_KEYS); i++) {
        JSValue k = JS_GetPropertyStr(ctx, v, HTTP_OPT_KEYS[i]);
        bool    named = !JS_IsUndefined(k);

        JS_FreeValue(ctx, k);
        if (named)
            return true;
    }
    return false;
}

/* opts.Query ({k:v}) appended escaped. Never interpolates. */
static char *http_with_query(JSContext *ctx, const char *url, JSValueConst opts)
{
    if (!JS_IsObject(opts))
        return g_strdup(url);
    JSValue q = JS_GetPropertyStr(ctx, opts, "Query");

    if (!JS_IsObject(q) || JS_IsArray(q) || JS_IsFunction(ctx, q)) {
        JS_FreeValue(ctx, q);
        return g_strdup(url);
    }

    JSPropertyEnum *tab = NULL;
    uint32_t        len = 0;
    GString        *out = g_string_new(url);
    bool            first = (strchr(url, '?') == NULL);

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, (JSValue)q,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
        for (uint32_t i = 0; i < len; i++) {
            const char *k = JS_AtomToCString(ctx, tab[i].atom);
            JSValue     v = JS_GetProperty(ctx, q, tab[i].atom);
            const char *vs = JS_ToCString(ctx, v);
            char       *ek = k ? g_uri_escape_string(k, NULL, TRUE) : NULL;
            char       *ev = vs ? g_uri_escape_string(vs, NULL, TRUE) : NULL;

            if (ek && ev)
                g_string_append_printf(out, "%c%s=%s", first ? '?' : '&', ek, ev);
            first = false;
            if (k)
                JS_FreeCString(ctx, k);
            if (vs)
                JS_FreeCString(ctx, vs);
            g_free(ek);
            g_free(ev);
            JS_FreeValue(ctx, v);
        }
            JS_FreePropertyEnum(ctx, tab, len);
    }
    JS_FreeValue(ctx, q);
    return g_string_free(out, FALSE);
}

static char *http_resolve_url(HttpClientData *c, const char *url)
{
    if (http_is_absolute(url) || !c || !c->base_url || !c->base_url[0])
        return g_strdup(url);

    /* /a/ + /b = /a/b : one slash between them, never two or none. */
    bool base_slash = g_str_has_suffix(c->base_url, "/");
    bool path_slash = url[0] == '/';

    if (base_slash && path_slash)
        return g_strconcat(c->base_url, url + 1, NULL);
    if (!base_slash && !path_slash)
        return g_strconcat(c->base_url, "/", url, NULL);
    return g_strconcat(c->base_url, url, NULL);
}

/* Auth is { User, Password } or nothing: dups on success, throws naming the
 * offender. Missing either half is a refusal rather than an empty password. */
static bool http_parse_auth(JSContext *ctx, JSValueConst v, const char *who,
                            char **user, char **pass)
{
    JSValue     u;
    JSValue     p;
    const char *us;
    const char *ps;

    *user = NULL;
    *pass = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v))
        return true;
    if (!JS_IsObject(v) || JS_IsArray(v) || JS_IsFunction(ctx, v)) {
        JS_ThrowTypeError(ctx, "%s: Auth must be an object with User and Password", who);
        return false;
    }
    u = JS_GetPropertyStr(ctx, v, "User");
    p = JS_GetPropertyStr(ctx, v, "Password");
    us = (JS_IsUndefined(u) || JS_IsNull(u)) ? NULL : JS_ToCString(ctx, u);
    ps = (JS_IsUndefined(p) || JS_IsNull(p)) ? NULL : JS_ToCString(ctx, p);
    if ((!JS_IsUndefined(u) && !JS_IsNull(u) && !us) ||
        (!JS_IsUndefined(p) && !JS_IsNull(p) && !ps)) {
        JS_FreeValue(ctx, u);
        JS_FreeValue(ctx, p);
        return false;
    }
    if (!us || !ps) {
        JS_ThrowTypeError(ctx, "%s: Auth needs a User and a Password", who);
        if (us)
            JS_FreeCString(ctx, us);
        if (ps)
            JS_FreeCString(ctx, ps);
        JS_FreeValue(ctx, u);
        JS_FreeValue(ctx, p);
        return false;
    }
    *user = g_strdup(us);
    *pass = g_strdup(ps);
    JS_FreeCString(ctx, us);
    JS_FreeCString(ctx, ps);
    JS_FreeValue(ctx, u);
    JS_FreeValue(ctx, p);
    if (!*user || !*pass) {
        g_free(*user);
        g_free(*pass);
        *user = *pass = NULL;
        JS_ThrowInternalError(ctx, "%s: out of memory", who);
        return false;
    }
    return true;
}

/* Whose credentials a flight answers with: the request's own when it names
 * any, else the client's. Copied, so neither outlives this call by reference. */
static bool http_resolve_auth(JSContext *ctx, HttpClientData *c, JSValueConst opts,
                              const char *who, char **user, char **pass)
{
    *user = NULL;
    *pass = NULL;
    if (JS_IsObject(opts)) {
        JSValue a = JS_GetPropertyStr(ctx, opts, "Auth");
        bool    named = !JS_IsUndefined(a) && !JS_IsNull(a);
        bool    ok = named ? http_parse_auth(ctx, a, who, user, pass) : true;

        JS_FreeValue(ctx, a);
        if (!ok)
            return false;
        if (named)
            return true;
    }
    if (c && c->auth_user) {
        *user = g_strdup(c->auth_user);
        *pass = g_strdup(c->auth_pass ? c->auth_pass : "");
        if (!*user || !*pass) {
            g_free(*user);
            g_free(*pass);
            *user = *pass = NULL;
            JS_ThrowInternalError(ctx, "%s: out of memory", who);
            return false;
        }
    }
    return true;
}

/* ------------------------------------------------------- Multipart */

/* A file upload as a value: fields and files appended in code, sent as the
 * body of a POST/PUT/PATCH. The boundary is soup's, made when the message is
 * built -- so one Multipart posts twice, and an explicit ContentType beside
 * one is refused rather than breaking the framing silently. */
typedef struct {
    SoupMultipart *mp;
    /* A parsed upload borrows nothing: when the parts came out of a request
     * body, whatever they were read from rides along until this does. */
    GBytes        *flat;
} HttpMultipart;

static JSClassID http_multipart_class_id;

static HttpMultipart *http_multipart_data(JSValueConst v)
{
    return JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT
        ? JS_GetOpaque(v, http_multipart_class_id) : NULL;
}

static bool http_is_multipart(JSValueConst v)
{
    return http_multipart_data(v) != NULL;
}

static void http_multipart_finalizer(JSRuntime *rt, JSValue v)
{
    HttpMultipart *m = JS_GetOpaque(v, http_multipart_class_id);

    (void)rt;
    if (!m)
        return;
    soup_multipart_free(m->mp);
    if (m->flat)
        g_bytes_unref(m->flat);
    g_free(m);
}

static JSValue http_multipart_construct(JSContext *ctx, JSValueConst new_target,
                                        int argc, JSValueConst *argv)
{
    JSValue proto;
    JSValue obj;
    HttpMultipart *m;

    (void)new_target;
    if (argc > 0)
        return JS_ThrowTypeError(ctx, "Multipart takes no arguments");
    proto = JS_GetClassProto(ctx, http_multipart_class_id);
    obj = JS_NewObjectProtoClass(ctx, proto, http_multipart_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;
    m = g_new0(HttpMultipart, 1);
    m->mp = soup_multipart_new("multipart/form-data");
    if (!m->mp) {
        JS_FreeValue(ctx, obj);
        g_free(m);
        return JS_ThrowInternalError(ctx, "Multipart: out of memory");
    }
    JS_SetOpaque(obj, m);
    return obj;
}

static JSValue http_multipart_field(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    HttpMultipart *m = http_multipart_data(this_val);
    const char    *name;
    const char    *value;

    if (!m)
        return JS_ThrowTypeError(ctx, "Field: not a Multipart");
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Field(name, value) needs both");
    name = JS_ToCString(ctx, argv[0]);
    value = JS_ToCString(ctx, argv[1]);
    if (!name || !value) {
        if (name)
            JS_FreeCString(ctx, name);
        if (value)
            JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }
    soup_multipart_append_form_string(m->mp, name, value);
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, value);
    return JS_DupValue(ctx, this_val);
}

static JSValue http_multipart_file(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    HttpMultipart *m = http_multipart_data(this_val);
    const char    *name = NULL;
    const char    *filename = NULL;
    const char    *ctype = NULL;
    char          *ctype_free = NULL;
    const uint8_t *data = NULL;
    size_t         len = 0;
    const char    *text = NULL;
    size_t         text_len = 0;
    GBytes        *bytes;

    if (!m)
        return JS_ThrowTypeError(ctx, "File: not a Multipart");
    if (argc < 3)
        return JS_ThrowTypeError(ctx, "File(name, filename, body, [contentType]) needs three");
    name = JS_ToCString(ctx, argv[0]);
    filename = JS_ToCString(ctx, argv[1]);
    if (!name || !filename) {
        if (name)
            JS_FreeCString(ctx, name);
        if (filename)
            JS_FreeCString(ctx, filename);
        return JS_EXCEPTION;
    }
    data = bta_bytes_get(argv[2], &len);
    if (!data) {
        if (!JS_IsString(argv[2])) {
            JS_FreeCString(ctx, name);
            JS_FreeCString(ctx, filename);
            return JS_ThrowTypeError(ctx, "File: body must be text or Bytes");
        }
        text = JS_ToCStringLen(ctx, &text_len, argv[2]);
        if (!text) {
            JS_FreeCString(ctx, name);
            JS_FreeCString(ctx, filename);
            return JS_EXCEPTION;
        }
        data = (const uint8_t *)text;
        len = text_len;
    }
    if (argc > 3 && !JS_IsUndefined(argv[3]) && !JS_IsNull(argv[3])) {
        const char *cs = JS_ToCString(ctx, argv[3]);

        /* A failed conversion leaves its exception pending: report that. */
        if (!cs) {
            JS_FreeCString(ctx, name);
            JS_FreeCString(ctx, filename);
            if (text)
                JS_FreeCString(ctx, text);
            return JS_EXCEPTION;
        }
        ctype_free = g_strdup(cs);
        ctype = ctype_free;
        JS_FreeCString(ctx, cs);
    }
    if (!ctype)
        ctype = "application/octet-stream";
    bytes = g_bytes_new(data, len);
    soup_multipart_append_form_file(m->mp, name, filename, ctype, bytes);
    g_bytes_unref(bytes);
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, filename);
    if (text)
        JS_FreeCString(ctx, text);
    g_free(ctype_free);
    return JS_DupValue(ctx, this_val);
}

static JSValue http_multipart_get_length(JSContext *ctx, JSValueConst this_val)
{
    HttpMultipart *m = http_multipart_data(this_val);

    if (!m)
        return JS_ThrowTypeError(ctx, "Length: not a Multipart");
    return JS_NewInt32(ctx, soup_multipart_get_length(m->mp));
}

/* One part read back: name, filename and type as text, the bytes as Bytes. */
static JSValue http_multipart_part(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    HttpMultipart      *m = http_multipart_data(this_val);
    int32_t             idx = 0;
    int                 n;
    SoupMessageHeaders *ph = NULL;
    GBytes             *pb = NULL;
    char               *dispo = NULL;
    GHashTable         *params = NULL;
    const char         *name;
    const char         *filename;
    const char         *ctype;
    gsize               blen = 0;
    const void         *bdata;
    JSValue             o;

    if (!m)
        return JS_ThrowTypeError(ctx, "Part: not a Multipart");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Part(index) needs an index");
    if (!bta_to_int(ctx, argv[0], "Part", &idx))
        return JS_EXCEPTION;
    n = soup_multipart_get_length(m->mp);
    if (idx < 0 || idx >= n)
        return JS_ThrowRangeError(ctx, "Part: index %d is beyond %d parts", idx, n);
    if (!soup_multipart_get_part(m->mp, idx, &ph, &pb))
        return JS_ThrowInternalError(ctx, "Part: cannot read part %d", idx);
    soup_message_headers_get_content_disposition(ph, &dispo, &params);
    name = (params && g_hash_table_lookup(params, "name"))
        ? (const char *)g_hash_table_lookup(params, "name") : "";
    filename = (params && g_hash_table_lookup(params, "filename"))
        ? (const char *)g_hash_table_lookup(params, "filename") : "";
    ctype = soup_message_headers_get_content_type(ph, NULL);
    bdata = pb ? g_bytes_get_data(pb, &blen) : NULL;

    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "Name", JS_NewString(ctx, name));
    JS_SetPropertyStr(ctx, o, "Filename", JS_NewString(ctx, filename));
    JS_SetPropertyStr(ctx, o, "Type", JS_NewString(ctx, ctype ? ctype : ""));
    JS_SetPropertyStr(ctx, o, "Data", bta_bytes_new(ctx, bdata, blen ? blen : 0));
    g_free(dispo);
    if (params)
        g_hash_table_unref(params);
    return o;
}

static const JSCFunctionListEntry multipart_props[] = {
    JS_CFUNC_DEF("Field", 2, http_multipart_field),
    JS_CFUNC_DEF("File",  4, http_multipart_file),
    JS_CFUNC_DEF("Part",  1, http_multipart_part),
    JS_CGETSET_DEF("Length", http_multipart_get_length, NULL),
};

static const JSClassDef multipart_def = {
    "Multipart",
    .finalizer = http_multipart_finalizer,
};

static void http_multipart_init(JSContext *ctx, JSValue global)
{
    JS_NewClassID(JS_GetRuntime(ctx), &http_multipart_class_id);
    JS_NewClass(JS_GetRuntime(ctx), http_multipart_class_id, &multipart_def);

    JSValue proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, proto, multipart_props, G_N_ELEMENTS(multipart_props));
    JS_SetClassProto(ctx, http_multipart_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, http_multipart_construct, "Multipart", 0,
                                    JS_CFUNC_constructor, 0);

    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Multipart", ctor);
}

/* Headers must be an object when present; request wins over client defaults. */
static bool http_apply_headers(JSContext *ctx, SoupMessage *msg, HttpClientData *c,
                               JSValueConst opts, const char *who)
{
    SoupMessageHeaders *hdrs = soup_message_get_request_headers(msg);

    /* Client defaults first, so the request overwrites them. */
    const JSValueConst layers[2] = {
        (c && !JS_IsUndefined(c->headers)) ? c->headers : JS_UNDEFINED,
        JS_IsObject(opts) ? JS_GetPropertyStr(ctx, opts, "Headers") : JS_UNDEFINED,
    };

    for (int l = 0; l < 2; l++) {
        JSValueConst h = layers[l];
        bool owned = (l == 1);

        if (JS_IsUndefined(h) || JS_IsNull(h)) {
            if (owned)
                JS_FreeValue(ctx, h);
            continue;
        }
        if (!JS_IsObject(h) || JS_IsArray(h) || JS_IsFunction(ctx, h)) {
            if (owned)
                JS_FreeValue(ctx, h);
            /* The first layer may already be on the message; the caller
             * discards it rather than unwinding header by header. */
            JS_ThrowTypeError(ctx, "%s: Headers must be an object", who);
            return false;
        }

        JSPropertyEnum *tab = NULL;
        uint32_t        len = 0;

        if (JS_GetOwnPropertyNames(ctx, &tab, &len, (JSValue)h,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
            for (uint32_t i = 0; i < len; i++) {
                const char *k = JS_AtomToCString(ctx, tab[i].atom);
                JSValue     v = JS_GetProperty(ctx, h, tab[i].atom);
                const char *vs = JS_ToCString(ctx, v);

                if (k && vs)
                    soup_message_headers_replace(hdrs, k, vs);
                if (k)
                    JS_FreeCString(ctx, k);
                if (vs)
                    JS_FreeCString(ctx, vs);
                JS_FreeValue(ctx, v);
            }
            JS_FreePropertyEnum(ctx, tab, len);
        }
        if (owned)
            JS_FreeValue(ctx, h);
    }
    return true;
}

/* Body + content type. Answers false with an exception pending; on true
 * `*out` is a referenced GBytes, or NULL when there is no body -- the house
 * shape (`bind_one` in bta_sqlite.c), rather than a pointer value that is
 * neither a buffer nor nothing. */
static bool http_body_bytes(JSContext *ctx, JSValueConst body, JSValueConst opts,
                            const char **ctype_out, char **ctype_free, const char *who,
                            GBytes **out)
{
    *ctype_out = NULL;
    *ctype_free = NULL;
    *out = NULL;

    const char *opt_ct = NULL;
    char       *opt_ct_free = NULL;

    if (JS_IsObject(opts)) {
        JSValue cv = JS_GetPropertyStr(ctx, opts, "ContentType");

        if (!JS_IsUndefined(cv) && !JS_IsNull(cv)) {
            const char *cs = JS_ToCString(ctx, cv);

            /* A failed conversion leaves its exception pending: report that. */
            if (!cs) {
                JS_FreeValue(ctx, cv);
                return false;
            }
            opt_ct_free = g_strdup(cs);
            opt_ct = opt_ct_free;
            JS_FreeCString(ctx, cs);
        }
        JS_FreeValue(ctx, cv);
    }

    if (JS_IsUndefined(body) || JS_IsNull(body)) {
        g_free(opt_ct_free);
        return true;
    }

    size_t blen = 0;
    const uint8_t *bdata = bta_bytes_get(body, &blen);

    if (bdata) {
        *ctype_out = opt_ct ? opt_ct : "application/octet-stream";
        *ctype_free = opt_ct_free;
        *out = g_bytes_new(bdata, blen);
        return true;
    }

    if (JS_IsString(body)) {
        size_t len = 0;
        const char *s = JS_ToCStringLen(ctx, &len, body);

        if (!s) {
            g_free(opt_ct_free);
            return false;
        }
        *ctype_out = opt_ct ? opt_ct : "text/plain;charset=utf-8";
        *ctype_free = opt_ct_free;
        *out = g_bytes_new(s, len);
        JS_FreeCString(ctx, s);
        return true;
    }

    if (JS_IsObject(body)) {
        /* Canonical JSON, the File.SaveJson shape: indented by two, trailing \n. */
        JSValue space = JS_NewInt32(ctx, 2);
        JSValue js = JS_JSONStringify(ctx, body, JS_NULL, space);

        JS_FreeValue(ctx, space);
        if (JS_IsException(js)) {
            g_free(opt_ct_free);
            return false;
        }
        size_t len = 0;
        const char *s = JS_ToCStringLen(ctx, &len, js);

        JS_FreeValue(ctx, js);
        if (!s) {
            g_free(opt_ct_free);
            return false;
        }
        *ctype_out = opt_ct ? opt_ct : "application/json";
        *ctype_free = opt_ct_free;
        GString *g = g_string_new_len(s, (gssize)len);

        g_string_append_c(g, '\n');
        JS_FreeCString(ctx, s);
        *out = g_bytes_new(g->str, g->len);
        g_string_free(g, TRUE);
        return true;
    }

    g_free(opt_ct_free);
    JS_ThrowTypeError(ctx, "%s: body must be text, Bytes or an object", who);
    return false;
}

/* Soup writes the Content-Type when the body is set, which happens after the
 * declared headers are on the message -- so a `Content-Type` written by hand
 * would be silently replaced by the one the body's shape implies. This puts
 * the specific spelling back on top, the rule `Authorization` already
 * follows: what was named beats what was inferred. */
static void http_keep_declared_type(SoupMessageHeaders *hdrs, const char *declared)
{
    if (declared)
        soup_message_headers_replace(hdrs, "Content-Type", declared);
}

/* What the header layers said the type was, copied before the body overwrites
 * it. NULL when nobody named one. */
static char *http_declared_type(SoupMessageHeaders *hdrs)
{
    const char *ct = soup_message_headers_get_content_type(hdrs, NULL);

    return ct ? g_strdup(ct) : NULL;
}

typedef struct {
    JSContext *ctx;
    JSValue    obj;
} HttpHeadersWalk;

static void http_header_foreach(const char *name, const char *value, gpointer data)
{
    HttpHeadersWalk *w = data;
    char            *lower = g_ascii_strdown(name, -1);

    JS_SetPropertyStr(w->ctx, w->obj, lower, JS_NewString(w->ctx, value ? value : ""));
    g_free(lower);
}

static JSValue http_response_object(JSContext *ctx, SoupMessage *msg, GBytes *bytes)
{
    JSValue res = JS_NewObject(ctx);
    int status = (int)soup_message_get_status(msg);
    const char *reason = soup_message_get_reason_phrase(msg);

    JS_SetPropertyStr(ctx, res, "Status", JS_NewInt32(ctx, status));
    JS_SetPropertyStr(ctx, res, "Reason", JS_NewString(ctx, reason ? reason : ""));

    JSValue hobj = JS_NewObject(ctx);
    HttpHeadersWalk w = { ctx, hobj };

    soup_message_headers_foreach(soup_message_get_response_headers(msg),
                                 http_header_foreach, &w);
    JS_SetPropertyStr(ctx, res, "Headers", hobj);

    gsize len = 0;
    const void *data = bytes ? g_bytes_get_data(bytes, &len) : NULL;

    JS_SetPropertyStr(ctx, res, "Body", bta_bytes_new(ctx, data, len ? len : 0));

    GUri *uri = soup_message_get_uri(msg);
    char *ustr = uri ? g_uri_to_string(uri) : NULL;

    JS_SetPropertyStr(ctx, res, "Url", JS_NewString(ctx, ustr ? ustr : ""));
    g_free(ustr);
    return res;
}

/* Which of the seven words a failure gets. Read off the domain and the code:
 * matching on `err->message` instead would be reading the system's language
 * back, and on a Spanish desktop the English needle is never in the haystack
 * -- a Kind that is right only where it was written is worse than `Error`,
 * because it looks reliable. */
static const char *http_kind_for(GError *err)
{
    if (!err)
        return "Error";
    /* The soup domain is not only redirects: BAD_URI, PARSING and
     * UNSUPPORTED_URI_SCHEME live in it too, and calling `ftp://` a redirect
     * is a wrong answer rather than a vague one. */
    if (err->domain == soup_session_error_quark())
        return err->code == SOUP_SESSION_ERROR_TOO_MANY_REDIRECTS
            ? "Redirect" : "Error";
    if (err->domain == g_tls_error_quark())
        return "Tls";
    if (err->domain == G_IO_ERROR) {
        switch (err->code) {
        case G_IO_ERROR_HOST_NOT_FOUND:
        case G_IO_ERROR_HOST_UNREACHABLE:
        case G_IO_ERROR_PROXY_NOT_ALLOWED:
        case G_IO_ERROR_PROXY_AUTH_FAILED:
        case G_IO_ERROR_PROXY_NEED_AUTH:
        case G_IO_ERROR_PROXY_FAILED:
            return "Dns";
        case G_IO_ERROR_CONNECTION_REFUSED:
            return "Refused";
        case G_IO_ERROR_TIMED_OUT:
            return "Timeout";
        default:
            break;
        }
    }
    return "Error";
}

/* The one sentence a failure gets, in either spelling. */
static char *http_error_text(const char *who, const char *url, const char *detail)
{
    return g_strdup_printf("%s: cannot reach '%s': %s", who, url, detail);
}

static JSValue http_error_object(JSContext *ctx, const char *who, const char *url,
                                 const char *kind, const char *detail, int status)
{
    JSValue e = JS_NewObject(ctx);
    char    *msg = http_error_text(who, url, detail);

    JS_SetPropertyStr(ctx, e, "Message", JS_NewString(ctx, msg));
    JS_SetPropertyStr(ctx, e, "Kind", JS_NewString(ctx, kind));
    JS_SetPropertyStr(ctx, e, "Status", JS_NewInt32(ctx, status));
    g_free(msg);
    return e;
}

/* The blocking twin: a Wait throws where the callbacks would have been handed
 * the record, the File.Load mold. `Kind` and `Status` ride on what is thrown
 * for the same reason they ride on the record -- a caller that catches has to
 * be able to tell a timeout from a name that does not resolve without reading
 * the prose back. */
static JSValue http_throw_error(JSContext *ctx, const char *who, const char *url,
                                const char *kind, const char *detail, int status)
{
    char   *msg = http_error_text(who, url, detail);
    JSValue ex;

    JS_ThrowInternalError(ctx, "%s", msg);
    g_free(msg);
    ex = JS_GetException(ctx);
    if (JS_IsObject(ex)) {
        JS_SetPropertyStr(ctx, ex, "Kind", JS_NewString(ctx, kind));
        JS_SetPropertyStr(ctx, ex, "Status", JS_NewInt32(ctx, status));
    }
    return JS_Throw(ctx, ex);
}

/* ------------------------------------------------------- async delivery */

/* The handle rides along as the second argument, in both callbacks: a form
 * with a button that can be pressed twice has more than one request in the
 * air, and `Stop()` asks rather than undoes -- the cancelled one still
 * answers, a turn later. Without something to compare, a handler cannot tell
 * the answer it is waiting for from the one it gave up on. */
static void http_deliver_done(HttpJob *job, GBytes *bytes)
{
    JSValue args[2];

    args[0] = http_response_object(job->ctx, job->msg, bytes);
    args[1] = job->handle;
    job->finished = true;
    if (JS_IsObject(job->handle)) {
        JS_SetPropertyStr(job->ctx, job->handle, "Running", JS_FALSE);
    }
    if (JS_IsFunction(job->ctx, job->on_done)) {
        JSValue r = JS_Call(job->ctx, job->on_done, JS_UNDEFINED, 2, args);

        if (JS_IsException(r))
            bta_dump_error(job->ctx);
        JS_FreeValue(job->ctx, r);
        bta_drain_jobs(JS_GetRuntime(job->ctx));
    }
    JS_FreeValue(job->ctx, args[0]);
    http_job_free(job);
}

static void http_deliver_error(HttpJob *job, const char *kind, const char *detail)
{
    JSValue args[2];

    args[0] = http_error_object(job->ctx, job->who, job->url, kind, detail, 0);
    args[1] = job->handle;
    job->finished = true;
    if (JS_IsObject(job->handle)) {
        JS_SetPropertyStr(job->ctx, job->handle, "Running", JS_FALSE);
        if (job->timed_out)
            JS_SetPropertyStr(job->ctx, job->handle, "TimedOut", JS_TRUE);
    }
    if (JS_IsFunction(job->ctx, job->on_error)) {
        JSValue r = JS_Call(job->ctx, job->on_error, JS_UNDEFINED, 2, args);

        if (JS_IsException(r))
            bta_dump_error(job->ctx);
        JS_FreeValue(job->ctx, r);
        bta_drain_jobs(JS_GetRuntime(job->ctx));
    } else if (JS_IsFunction(job->ctx, job->on_done) && !strcmp(kind, "Cancelled")) {
        /* A cancel with no onError is silence the caller asked for: drop it. */
    }
    JS_FreeValue(job->ctx, args[0]);
    http_job_free(job);
}

/* A failed read, in the words the caller gets. One place, because four
 * transports now end here -- the buffered read, the streamed send, each line
 * of a stream and the splice of an error page -- and a decision copied four
 * times is the drift `HTTP_OPT_KEYS` already has a paragraph about. A
 * cancelled flight is a Timeout or a Cancel depending on who asked, which is
 * the only thing the GError cannot say on its own. */
static void http_deliver_send_error(HttpJob *job, GError *err)
{
    const char *kind = NULL;
    char       *detail = NULL;

    if (g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
        if (job->timed_out) {
            kind = "Timeout";
            detail = g_strdup("timeout");
        } else {
            kind = "Cancelled";
            detail = g_strdup("cancelled");
        }
    } else {
        kind = http_kind_for(err);
        detail = g_strdup(err ? err->message : "unknown error");
    }
    http_deliver_error(job, kind, detail);
    g_free(detail);
}

static void on_http_done(GObject *src, GAsyncResult *res, gpointer data)
{
    HttpJob *job = data;
    GError  *err = NULL;
    GBytes  *bytes = soup_session_send_and_read_finish(job->sess, res, &err);

    if (!bytes) {
        http_deliver_send_error(job, err);
        g_clear_error(&err);
        return;
    }

    http_deliver_done(job, bytes);
    g_bytes_unref(bytes);
}

/* ------------------------------------------------------------- streaming */

static void http_stream_read_next(HttpJob *job);

/*
 * One line, the `Exec` mold (`bta_sys.c:on_exec_line`) -- with two differences
 * that are worth the words, since the two functions otherwise read as twins.
 *
 * **CANCELLED does not return silently here.** In `Exec` a cancelled read
 * means the teardown already freed the job; in `Http` only the guard and
 * `Stop()` cancel, the job is alive and owes an answer, so a cancel goes
 * through the funnel and comes out as `Timeout` or `Cancelled` exactly as the
 * buffered road answers it. The teardown case is caught by `http_job_alive`
 * instead, one line up.
 *
 * **And a body that is not UTF-8 ends the flight** rather than being read as
 * EOF: this is the streamed twin of `Bytes.ToText()`, which refuses what is
 * not text instead of handing back mojibake.
 */
static void on_http_stream_line(GObject *src, GAsyncResult *res, gpointer data)
{
    HttpJob *job = data;
    GError  *err = NULL;
    gsize    len = 0;
    char    *line;

    if (!http_job_alive(job))
        return;

    line = g_data_input_stream_read_line_finish_utf8(G_DATA_INPUT_STREAM(src),
                                                     res, &len, &err);
    if (err) {
        g_free(line);
        http_deliver_send_error(job, err);
        g_clear_error(&err);
        return;
    }
    if (!line) {
        /* EOF. The record as always, and an empty `Body`: what already went
         * out line by line is not sent a second time. */
        http_deliver_done(job, NULL);
        return;
    }

    if (JS_IsFunction(job->ctx, job->on_line)) {
        JSContext *ctx = job->ctx;   /* read before the call: the job may not survive it */
        JSValue    argv[2] = { JS_NewString(ctx, line), job->handle };

        job->calling = true;

        JSValue r = JS_Call(ctx, job->on_line, JS_UNDEFINED, 2, (JSValueConst *)argv);

        if (JS_IsException(r))
            bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[0]);
        bta_drain_jobs(JS_GetRuntime(ctx));   /* which can also stop this stream */
        job->calling = false;
        if (job->dead) {   /* freed while we were in there: now it is ours to do */
            http_job_free(job);
            g_free(line);
            return;
        }
    }
    g_free(line);

    /*
     * Re-armed last, and that is the back-pressure: there is never more than
     * one read outstanding, so a slow handler slows the feed instead of
     * queueing it. A `Stop()` from inside the callback leaves the cancellable
     * cancelled, so this read completes CANCELLED on the next turn of the loop
     * and *that* frame answers -- which keeps the published promise that a
     * cancelled request still answers a turn later.
     */
    http_stream_read_next(job);
}

static void http_stream_read_next(HttpJob *job)
{
    g_data_input_stream_read_line_async(job->lines, G_PRIORITY_DEFAULT,
                                        job->cancellable, on_http_stream_line, job);
}

/* The non-2xx body, read whole. */
static void on_http_stream_spliced(GObject *src, GAsyncResult *res, gpointer data)
{
    HttpJob *job = data;
    GError  *err = NULL;
    GBytes  *bytes;

    if (!http_job_alive(job)) {
        g_output_stream_splice_finish(G_OUTPUT_STREAM(src), res, NULL);
        return;
    }
    if (g_output_stream_splice_finish(G_OUTPUT_STREAM(src), res, &err) < 0) {
        http_deliver_send_error(job, err);
        g_clear_error(&err);
        return;
    }

    bytes = g_memory_output_stream_steal_as_bytes(G_MEMORY_OUTPUT_STREAM(job->sink));
    g_clear_object(&job->sink);   /* before delivering: delivering frees the job */
    http_deliver_done(job, bytes);
    g_bytes_unref(bytes);
}

/*
 * The headers are in, and the body has not been read yet -- which is the one
 * moment at which the destination of those bytes can still be chosen.
 *
 * A 2xx is the feed the caller asked to follow. Anything else is an answer:
 * a 404's JSON, a 500's page. Shredding that into the line callback would put
 * the status in one callback and the explanation in the other, in pieces, with
 * nothing to tell those pieces from feed data -- so it is read whole and
 * delivered the way `Get` would have delivered it, with `onLine` never called.
 * The caller gets a fact for free: a line arriving at all means a 2xx.
 */
static void on_http_stream_headers(GObject *src, GAsyncResult *res, gpointer data)
{
    HttpJob      *job = data;
    GError       *err = NULL;
    GInputStream *in;

    if (!http_job_alive(job)) {
        in = soup_session_send_finish(SOUP_SESSION(src), res, NULL);
        g_clear_object(&in);
        return;
    }

    in = soup_session_send_finish(job->sess, res, &err);
    if (!in) {
        http_deliver_send_error(job, err);
        g_clear_error(&err);
        return;
    }

    if (SOUP_STATUS_IS_SUCCESSFUL(soup_message_get_status(job->msg))) {
        job->lines = g_data_input_stream_new(in);
        /*
         * **HTTP is a CRLF protocol and GLib's default newline is LF.** `Exec`
         * never had to know, because a pipe ends its lines with `\n`; a
         * conforming SSE server is allowed `\r\n`, and with the default every
         * line would arrive with a carriage return still on the end of it --
         * `JSON.parse` failing on the last character, and the blank line that
         * separates two events never comparing equal to "".
         */
        g_data_input_stream_set_newline_type(job->lines,
                                             G_DATA_STREAM_NEWLINE_TYPE_ANY);
        g_object_unref(in);
        http_stream_read_next(job);
        return;
    }

    job->sink = g_memory_output_stream_new_resizable();
    g_output_stream_splice_async(job->sink, in,
                                 G_OUTPUT_STREAM_SPLICE_CLOSE_SOURCE |
                                 G_OUTPUT_STREAM_SPLICE_CLOSE_TARGET,
                                 G_PRIORITY_DEFAULT, job->cancellable,
                                 on_http_stream_spliced, job);
    g_object_unref(in);
}

static gboolean on_http_guard(gpointer data)
{
    HttpJob *job = data;

    job->guard = 0;
    job->timed_out = true;
    if (JS_IsObject(job->handle))
        JS_SetPropertyStr(job->ctx, job->handle, "TimedOut", JS_TRUE);
    g_cancellable_cancel(job->cancellable);
    return G_SOURCE_REMOVE;
}

/* Stop by id, Exec mold: never a reusable URL, answers whether live. */
static JSValue http_stop_by_id(JSContext *ctx, JSValueConst func_obj,
                               int argc, JSValueConst *argv, int magic, JSValueConst *func_data)
{
    int32_t id = 0;

    if (JS_ToInt32(ctx, &id, func_data[0]))
        return JS_EXCEPTION;
    for (GList *l = http_jobs; l; l = l->next) {
        HttpJob *job = l->data;

        if (job->id == id) {
            /* Answered already, or never started: nothing left to signal,
             * like signalling a reaped child. */
            if (job->finished || !job->msg)
                return JS_FALSE;
            g_cancellable_cancel(job->cancellable);
            return JS_TRUE;
        }
    }
    return JS_FALSE;
}

/* ------------------------------------------------------- client props */

static JSValue http_client_get_baseurl(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "BaseUrl: not an Http client");
    return JS_NewString(ctx, c->base_url ? c->base_url : "");
}

static JSValue http_client_set_baseurl(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "BaseUrl: not an Http client");
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        g_free(c->base_url);
        c->base_url = NULL;
        return JS_UNDEFINED;
    }
    const char *s = JS_ToCString(ctx, v);

    if (!s)
        return JS_EXCEPTION;
    if (!s[0]) {
        g_free(c->base_url);
        c->base_url = NULL;
        JS_FreeCString(ctx, s);
        return JS_UNDEFINED;
    }
    g_free(c->base_url);
    c->base_url = g_strdup(s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue http_client_get_headers(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Headers: not an Http client");
    if (JS_IsUndefined(c->headers))
        return JS_NewObject(ctx);
    return JS_DupValue(ctx, c->headers);
}

static JSValue http_client_set_headers(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Headers: not an Http client");
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        JS_FreeValue(ctx, c->headers);
        c->headers = JS_UNDEFINED;
        return JS_UNDEFINED;
    }
    if (!JS_IsObject(v) || JS_IsArray(v) || JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "Headers must be an object");
    JS_FreeValue(ctx, c->headers);
    c->headers = JS_DupValue(ctx, v);
    return JS_UNDEFINED;
}

static JSValue http_client_get_timeout(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Timeout: not an Http client");
    return JS_NewInt32(ctx, c->timeout_ms);
}

static JSValue http_client_set_timeout(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);
    int32_t n = 0;

    if (!c)
        return JS_ThrowTypeError(ctx, "Timeout: not an Http client");
    if (!bta_to_int(ctx, v, "Timeout", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "Timeout: %d is negative", n);
    c->timeout_ms = n;
    return JS_UNDEFINED;
}

static JSValue http_client_get_follow(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "FollowRedirects: not an Http client");
    return JS_NewBool(ctx, c->follow);
}

static JSValue http_client_set_follow(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "FollowRedirects: not an Http client");
    c->follow = JS_ToBool(ctx, v) > 0;
    return JS_UNDEFINED;
}

static JSValue http_client_get_language(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Language: not an Http client");
    return JS_NewString(ctx, c->language ? c->language : "");
}

static JSValue http_client_set_language(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);
    const char     *s;

    if (!c)
        return JS_ThrowTypeError(ctx, "Language: not an Http client");
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        g_free(c->language);
        c->language = NULL;
        http_client_apply_session(c);
        return JS_UNDEFINED;
    }
    s = JS_ToCString(ctx, v);
    if (!s)
        return JS_EXCEPTION;
    g_free(c->language);
    c->language = s[0] ? g_strdup(s) : NULL;
    JS_FreeCString(ctx, s);
    http_client_apply_session(c);
    return JS_UNDEFINED;
}

static JSValue http_client_get_proxy(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Proxy: not an Http client");
    if (c->proxy_url)
        return JS_NewString(ctx, c->proxy_url);
    if (c->proxy_off)
        return JS_NULL;
    return JS_NewString(ctx, "default");
}

/* "default" (system), null (direct) or an http(s) URL of our own. */
static bool http_proxy_value(JSContext *ctx, JSValueConst v, const char *who,
                             bool *off, char **url)
{
    const char *s;
    GUri       *uri;
    const char *scheme;

    *off = false;
    *url = NULL;
    /* Absent is the system resolver, like never having said anything. */
    if (JS_IsUndefined(v))
        return true;
    if (JS_IsNull(v)) {
        *off = true;
        return true;
    }
    s = JS_ToCString(ctx, v);
    if (!s)
        return false;
    if (!strcmp(s, "default")) {
        JS_FreeCString(ctx, s);
        return true;
    }
    uri = g_uri_parse(s, G_URI_FLAGS_NONE, NULL);
    scheme = uri ? g_uri_get_scheme(uri) : NULL;
    if (!uri || (strcmp(scheme, "http") && strcmp(scheme, "https"))) {
        if (uri)
            g_uri_unref(uri);
        JS_FreeCString(ctx, s);
        JS_ThrowTypeError(ctx, "%s: Proxy must be \"default\", null, or an http(s) URL", who);
        return false;
    }
    g_uri_unref(uri);
    *url = g_strdup(s);
    JS_FreeCString(ctx, s);
    if (!*url) {
        JS_ThrowInternalError(ctx, "%s: out of memory", who);
        return false;
    }
    return true;
}

static JSValue http_client_set_proxy(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);
    bool            off = false;
    char           *url = NULL;

    if (!c)
        return JS_ThrowTypeError(ctx, "Proxy: not an Http client");
    if (!http_proxy_value(ctx, v, "Proxy", &off, &url))
        return JS_EXCEPTION;
    c->proxy_off = off;
    g_free(c->proxy_url);
    c->proxy_url = url;
    http_client_apply_session(c);
    return JS_UNDEFINED;
}

static JSValue http_client_get_auth(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);
    JSValue          o;

    if (!c)
        return JS_ThrowTypeError(ctx, "Auth: not an Http client");
    /* Nothing, not a pair of empty strings: a client with no credentials
     * reads back the way `Proxy` reads back when it is off, and an empty
     * User is a user whose name is empty. */
    if (!c->auth_user)
        return JS_NULL;
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "User", JS_NewString(ctx, c->auth_user));
    JS_SetPropertyStr(ctx, o, "Password",
                      JS_NewString(ctx, c->auth_pass ? c->auth_pass : ""));
    return o;
}

static JSValue http_client_set_auth(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);
    char           *user = NULL;
    char           *pass = NULL;

    if (!c)
        return JS_ThrowTypeError(ctx, "Auth: not an Http client");
    if (!http_parse_auth(ctx, v, "Auth", &user, &pass))
        return JS_EXCEPTION;
    g_free(c->auth_user);
    g_free(c->auth_pass);
    c->auth_user = user;
    c->auth_pass = pass;
    return JS_UNDEFINED;
}

static JSValue http_client_get_user_agent(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "UserAgent: not an Http client");
    return JS_NewString(ctx, c->user_agent ? c->user_agent : "");
}

static JSValue http_client_set_user_agent(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);
    const char     *s;

    if (!c)
        return JS_ThrowTypeError(ctx, "UserAgent: not an Http client");
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        g_free(c->user_agent);
        c->user_agent = NULL;
        http_client_apply_session(c);
        return JS_UNDEFINED;
    }
    s = JS_ToCString(ctx, v);
    if (!s)
        return JS_EXCEPTION;
    g_free(c->user_agent);
    c->user_agent = s[0] ? g_strdup(s) : NULL;
    JS_FreeCString(ctx, s);
    http_client_apply_session(c);
    return JS_UNDEFINED;
}

static const char *http_log_name(int level)
{
    switch (level) {
    case SOUP_LOGGER_LOG_MINIMAL: return "minimal";
    case SOUP_LOGGER_LOG_HEADERS: return "headers";
    case SOUP_LOGGER_LOG_BODY:    return "body";
    default:                      return "none";
    }
}

static bool http_log_value(JSContext *ctx, JSValueConst v, const char *who, int *level)
{
    const char *s;

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        *level = SOUP_LOGGER_LOG_NONE;
        return true;
    }
    s = JS_ToCString(ctx, v);
    if (!s)
        return false;
    if (!strcmp(s, "none"))         *level = SOUP_LOGGER_LOG_NONE;
    else if (!strcmp(s, "minimal")) *level = SOUP_LOGGER_LOG_MINIMAL;
    else if (!strcmp(s, "headers")) *level = SOUP_LOGGER_LOG_HEADERS;
    else if (!strcmp(s, "body"))    *level = SOUP_LOGGER_LOG_BODY;
    else {
        JS_FreeCString(ctx, s);
        JS_ThrowTypeError(ctx, "%s: Log must be one of \"none\", \"minimal\", \"headers\", \"body\"",
                          who);
        return false;
    }
    JS_FreeCString(ctx, s);
    return true;
}

static JSValue http_client_get_log(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Log: not an Http client");
    return JS_NewString(ctx, http_log_name(c->log_level));
}

static JSValue http_client_set_log(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);
    int             level = SOUP_LOGGER_LOG_NONE;

    if (!c)
        return JS_ThrowTypeError(ctx, "Log: not an Http client");
    if (!http_log_value(ctx, v, "Log", &level))
        return JS_EXCEPTION;
    c->log_level = level;
    http_client_apply_session(c);
    return JS_UNDEFINED;
}

static JSValue http_client_get_idle(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "IdleTimeout: not an Http client");
    return JS_NewInt32(ctx, c->idle_ms);
}

static JSValue http_client_set_idle(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);
    int32_t n = 0;

    if (!c)
        return JS_ThrowTypeError(ctx, "IdleTimeout: not an Http client");
    if (!bta_to_int(ctx, v, "IdleTimeout", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "IdleTimeout: %d is negative", n);
    c->idle_ms = n;
    http_client_apply_session(c);
    return JS_UNDEFINED;
}

static JSValue http_client_get_maxconns(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "MaxConns: not an Http client");
    return JS_NewInt32(ctx, c->max_conns);
}

static JSValue http_client_get_maxperhost(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "MaxPerHost: not an Http client");
    return JS_NewInt32(ctx, c->max_per_host);
}

/* Constructor-only, like soup's own: assigning later throws rather than
 * pretending to retune sessions that cannot be retuned. */
static JSValue http_client_set_const(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "not an Http client");
    return JS_ThrowTypeError(ctx, "MaxConns and MaxPerHost are constructor-only");
}

static JSValue http_client_get_cookies(JSContext *ctx, JSValueConst this_val)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Cookies: not an Http client");
    return JS_NewBool(ctx, c->cookies);
}

static JSValue http_client_set_cookies(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpClientData *c = http_client_data(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Cookies: not an Http client");
    c->cookies = JS_ToBool(ctx, v) > 0;
    http_client_apply_session(c);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------- building */

/* The message both spellings send, built once. Everything about a request
 * except who is told about the answer lives here: the URL joined and
 * queried, the credentials, the body and its type, the headers and which of
 * them wins. It was written twice -- once per spelling -- and the copies
 * drifted the way copies do: a key added to one option list and not the
 * other sent a request's options out as its body.
 *
 * Answers false with an exception pending. On true, `*out_msg` is a message
 * to unref and `*out_url` the URL it went to, kept because the error text
 * names it. `fresh` is the blocking caller's: a Wait borrows no pooled
 * connection, since one made under an earlier call's private context is not
 * dispatchable from this one's. */
static bool http_build(JSContext *ctx, HttpClientData *c, const char *method,
                       const char *url, JSValueConst body, JSValueConst opts,
                       const char *who, bool fresh,
                       SoupMessage **out_msg, char **out_url)
{
    *out_msg = NULL;
    *out_url = NULL;

    char *joined = http_resolve_url(c, url);
    char *full = http_with_query(ctx, joined, opts);

    g_free(joined);
    if (!full) {
        JS_ThrowInternalError(ctx, "%s: out of memory", who);
        return false;
    }
    /* Relative with no BaseUrl is refused where it is asked. */
    if (!http_is_absolute(full) && (!c || !c->base_url || !c->base_url[0])) {
        JS_ThrowTypeError(ctx, "%s: '%s' is not absolute and no BaseUrl was set", who, full);
        g_free(full);
        return false;
    }

    /* A Query that is not an object would be silently dropped by the builder
     * below -- a request going out without the query it was asked for, and
     * nothing saying so. */
    if (JS_IsObject(opts)) {
        JSValue qv = JS_GetPropertyStr(ctx, opts, "Query");
        bool    bad = !JS_IsUndefined(qv) && !JS_IsNull(qv) &&
                      (!JS_IsObject(qv) || JS_IsArray(qv) || JS_IsFunction(ctx, qv));

        JS_FreeValue(ctx, qv);
        if (bad) {
            g_free(full);
            JS_ThrowTypeError(ctx, "%s: Query must be an object", who);
            return false;
        }
    }

    char *auth_user = NULL;
    char *auth_pass = NULL;

    if (!http_resolve_auth(ctx, c, opts, who, &auth_user, &auth_pass)) {
        g_free(full);
        return false;
    }

    /* The body, if any: an explicit one, else Body inside opts. A Multipart
     * builds the message instead of filling it. */
    JSValue      eff_opts_body = JS_UNDEFINED;
    JSValueConst eff_body = body;

    if (JS_IsUndefined(eff_body) && JS_IsObject(opts)) {
        eff_opts_body = JS_GetPropertyStr(ctx, opts, "Body");
        if (!JS_IsUndefined(eff_opts_body) && !JS_IsNull(eff_opts_body))
            eff_body = eff_opts_body;
    }
    bool is_mp = http_is_multipart(eff_body);

    /* opts.ContentType never reaches a header on this road (the body block
     * below is skipped), so without this it would be silently ignored. */
    if (is_mp && JS_IsObject(opts)) {
        JSValue ctv = JS_GetPropertyStr(ctx, opts, "ContentType");
        bool    named = !JS_IsUndefined(ctv) && !JS_IsNull(ctv);

        JS_FreeValue(ctx, ctv);
        if (named) {
            JS_FreeValue(ctx, eff_opts_body);
            g_free(full);
            g_free(auth_user);
            g_free(auth_pass);
            JS_ThrowTypeError(ctx, "%s: a multipart sets its own Content-Type", who);
            return false;
        }
    }

    SoupMessage *msg;

    if (is_mp) {
        /* The framing is serialized into the message here, so the upload
         * stays ours: one Multipart posts twice, and the finalizer still
         * frees it. The constructor always posts; the verb is the caller's. */
        msg = soup_message_new_from_multipart(full, http_multipart_data(eff_body)->mp);
        if (msg)
            soup_message_set_method(msg, method);
    } else {
        msg = soup_message_new(method, full);
    }
    if (!msg) {
        JS_ThrowTypeError(ctx, "%s: cannot make a request for '%s'", who, url);
        g_free(full);
        g_free(auth_user);
        g_free(auth_pass);
        JS_FreeValue(ctx, eff_opts_body);
        return false;
    }

    bool present = false;

    if (!http_bool_opt(ctx, opts, "FollowRedirects", c ? c->follow : true, &present))
        soup_message_add_flags(msg, SOUP_MESSAGE_NO_REDIRECT);
    if (fresh)
        soup_message_add_flags(msg, SOUP_MESSAGE_NEW_CONNECTION);

    http_apply_auth(msg, auth_user, auth_pass);
    g_free(auth_user);
    g_free(auth_pass);

    if (!http_apply_headers(ctx, msg, c, opts, who)) {
        g_object_unref(msg);
        g_free(full);
        JS_FreeValue(ctx, eff_opts_body);
        return false;
    }

    char *declared_ct = http_declared_type(soup_message_get_request_headers(msg));

    if (is_mp) {
        /* The boundary is soup's: a Content-Type of our own anywhere --
         * opts, client defaults, an explicit header -- would break the
         * framing, so one that is not soup's is refused rather than sent. */
        const char *mct = soup_message_headers_get_content_type(
            soup_message_get_request_headers(msg), NULL);

        if (!mct || strncmp(mct, "multipart/", 10)) {
            g_object_unref(msg);
            g_free(full);
            g_free(declared_ct);
            JS_FreeValue(ctx, eff_opts_body);
            JS_ThrowTypeError(ctx, "%s: a multipart sets its own Content-Type", who);
            return false;
        }
    }

    const char *ctype = NULL;
    char       *ctype_free = NULL;
    GBytes     *b = NULL;

    if (!is_mp && !JS_IsUndefined(eff_body) &&
        !http_body_bytes(ctx, eff_body, opts, &ctype, &ctype_free, who, &b)) {
        g_object_unref(msg);
        g_free(full);
        g_free(ctype_free);
        g_free(declared_ct);
        JS_FreeValue(ctx, eff_opts_body);
        return false;
    }
    if (b) {
        soup_message_set_request_body_from_bytes(msg, ctype ? ctype : "application/octet-stream", b);
        g_bytes_unref(b);
        /* opts.ContentType asked for this one by name; a header did too, and
         * that one is the more specific of the two. */
        if (!ctype_free)
            http_keep_declared_type(soup_message_get_request_headers(msg), declared_ct);
    }
    g_free(ctype_free);
    g_free(declared_ct);
    JS_FreeValue(ctx, eff_opts_body);

    *out_msg = msg;
    *out_url = full;
    return true;
}

/* ------------------------------------------------------- core start */

/* Shared request starter for async. Returns the handle or exception. */
static JSValue http_start(JSContext *ctx, HttpClientData *c, SoupSession *sess,
                          const char *method, const char *url,
                          JSValueConst body, JSValueConst opts,
                          JSValueConst on_line,
                          JSValueConst on_done, JSValueConst on_error,
                          const char *who)
{
    SoupMessage *msg;
    char        *full;
    bool         streaming = JS_IsFunction(ctx, on_line);

    if (!streaming && !JS_IsFunction(ctx, on_done) && !JS_IsFunction(ctx, on_error))
        return JS_ThrowTypeError(ctx, "%s: a callback is required: http is async", who);
    if (!http_build(ctx, c, method, url, body, opts, who, false, &msg, &full))
        return JS_EXCEPTION;

    HttpJob *job = g_new0(HttpJob, 1);

    job->ctx = ctx;
    job->on_line = JS_DupValue(ctx, on_line);
    job->on_done = JS_DupValue(ctx, on_done);
    job->on_error = JS_DupValue(ctx, on_error);
    job->sess = sess ? g_object_ref(sess) : NULL;
    job->msg = g_object_ref(msg);
    job->cancellable = g_cancellable_new();
    job->id = http_next_id++;
    job->who = g_strdup(who);
    job->url = full; /* kept for the error text */
    g_object_unref(msg);

    http_jobs = g_list_prepend(http_jobs, job);

    JSValue idv = JS_NewInt32(ctx, job->id);
    JSValue handle = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, handle, "Running", JS_TRUE);
    JS_SetPropertyStr(ctx, handle, "TimedOut", JS_FALSE);
    JS_SetPropertyStr(ctx, handle, "Url", JS_NewString(ctx, job->url));
    JS_SetPropertyStr(ctx, handle, "Method", JS_NewString(ctx, method));
    JS_SetPropertyStr(ctx, handle, "Stop",
                      JS_NewCFunctionData(ctx, http_stop_by_id, 0, 0, 1, &idv));
    JS_FreeValue(ctx, idv);
    job->handle = JS_DupValue(ctx, handle);

    int timeout = 0;

    if (!http_int_opt(ctx, opts, "Timeout", c ? c->timeout_ms : 0, &timeout)) {
        JS_FreeValue(ctx, handle);
        http_job_free(job);
        return JS_EXCEPTION;
    }
    if (timeout < 0) {
        JS_FreeValue(ctx, handle);
        http_job_free(job);
        return JS_ThrowRangeError(ctx, "%s: Timeout %d is negative", who, timeout);
    }
    if (timeout > 0)
        job->guard = g_timeout_add((guint)timeout, on_http_guard, job);

    /* Only a streamed request changes road: everything else keeps the one
     * call it has always made, so redirects, auth, cookies, the logger and
     * the multipart bodies carry no regression risk -- and the stream gets
     * all of them for free, since `http_build` above is the same. */
    if (streaming)
        soup_session_send_async(job->sess, job->msg, G_PRIORITY_DEFAULT,
                                job->cancellable, on_http_stream_headers, job);
    else
        soup_session_send_and_read_async(job->sess, job->msg, G_PRIORITY_DEFAULT,
                                         job->cancellable, on_http_done, job);
    return handle;
}

/*
 * Split (url, [body], [opts], onDone, [onError]) for Request/Get/Post -- and
 * (url, [body], [opts], onLine, [onDone], [onError]) when `stream` is set, one
 * callback further along. One splitter and not two, so that the
 * body-or-options rule, the Multipart refusal and the too-many-arguments
 * answer cannot drift between `Stream` and `Post`.
 */
static JSValue http_call(JSContext *ctx, HttpClientData *c, SoupSession *sess,
                         const char *method, bool takes_body, bool stream,
                         int argc, JSValueConst *argv, const char *who)
{
    int at = 0;
    const char *url = NULL;
    char       *url_free = NULL;
    JSValueConst body = JS_UNDEFINED;
    JSValueConst opts = JS_UNDEFINED;
    JSValueConst on_line = JS_UNDEFINED;
    JSValueConst on_done = JS_UNDEFINED;
    JSValueConst on_error = JS_UNDEFINED;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, stream
            ? "%s(url, [body], [opts], onLine, [onDone], [onError]): needs a URL"
            : "%s(url, [body], [opts], onDone, [onError]): needs a URL", who);
    {
        const char *s = JS_ToCString(ctx, argv[0]);

        if (!s)
            return JS_EXCEPTION;
        url_free = g_strdup(s);
        JS_FreeCString(ctx, s);
        if (!url_free)
            return JS_ThrowInternalError(ctx, "%s: out of memory", who);
    }
    url = url_free;
    at = 1;

    /* A Multipart is a body, so where no body goes it cannot be options. */
    if (!takes_body && at < argc && http_is_multipart(argv[at])) {
        g_free(url_free);
        return JS_ThrowTypeError(ctx, "%s carries no body", who);
    }

    if (takes_body && at < argc && !JS_IsFunction(ctx, argv[at])) {
        /* Ambiguous: a plain object could be a JSON body or opts. If it
         * names an opts key it is opts, else it is the body. */
        if (JS_IsObject(argv[at]) && !JS_IsArray(argv[at])) {
            if (http_looks_like_opts(ctx, argv[at]))
                opts = argv[at++];
            else
                body = argv[at++];
        } else {
            body = argv[at++];
        }
    }

    if (at < argc && (JS_IsUndefined(argv[at]) || JS_IsNull(argv[at]))) {
        /* An explicit nothing where opts would go: forgiven, like Exec.Wait. */
        at++;
    } else if (at < argc && JS_IsObject(argv[at]) && !JS_IsFunction(ctx, argv[at]) &&
        !JS_IsArray(argv[at])) {
        opts = argv[at++];
    }
    /* The streamed spelling puts the per-line callback first, and the two
     * that every verb has shift one along behind it. */
    if (stream) {
        if (at < argc && (JS_IsUndefined(argv[at]) || JS_IsNull(argv[at])))
            at++;
        else if (at < argc && JS_IsFunction(ctx, argv[at]))
            on_line = argv[at++];
    }
    if (at < argc && (JS_IsUndefined(argv[at]) || JS_IsNull(argv[at])))
        at++;
    else if (at < argc && JS_IsFunction(ctx, argv[at]))
        on_done = argv[at++];
    if (at < argc && (JS_IsUndefined(argv[at]) || JS_IsNull(argv[at])))
        at++;
    else if (at < argc && JS_IsFunction(ctx, argv[at]))
        on_error = argv[at++];

    if (at < argc) {
        g_free(url_free);
        return JS_ThrowTypeError(ctx, "%s: too many arguments", who);
    }
    if (stream && !JS_IsFunction(ctx, on_line)) {
        g_free(url_free);
        return JS_ThrowTypeError(ctx,
            "%s(method, url, [body], [opts], onLine, [onDone], [onError]): "
            "the line callback is what streaming is for", who);
    }

    JSValue r = http_start(ctx, c, sess, method, url, body, opts,
                           on_line, on_done, on_error, who);

    g_free(url_free);
    return r;
}

/* The verbs a request may name. `Request` and `RequestWait` both take one as
 * text, so both ask here: a spelling refused in one and passed straight to
 * soup in the other is the same call answering two ways. Returns the upper
 * case name to free, or NULL with an exception pending. */
static char *http_verb_arg(JSContext *ctx, JSValueConst v, const char *who)
{
    const char *m = JS_ToCString(ctx, v);
    char       *method;

    if (!m)
        return NULL;
    method = g_ascii_strup(m, -1);
    JS_FreeCString(ctx, m);
    if (strcmp(method, "GET") && strcmp(method, "POST") && strcmp(method, "PUT") &&
        strcmp(method, "PATCH") && strcmp(method, "DELETE") && strcmp(method, "HEAD")) {
        JS_ThrowTypeError(ctx, "%s: '%s' is not one of GET, POST, PUT, PATCH, DELETE, HEAD",
                          who, method);
        g_free(method);
        return NULL;
    }
    return method;
}

static HttpClientData *http_client_or_null(JSContext *ctx, JSValueConst this_val)
{
    if (JS_IsObject(this_val))
        return http_client_data(this_val);
    return NULL;
}

/* Client methods: this is the client. */
static JSValue http_client_request(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Request: not an Http client");
    if (argc < 1)
        return JS_ThrowTypeError(ctx,
            "Request(method, url, [body], [opts], onDone, [onError]): needs a method");
    char *method = http_verb_arg(ctx, argv[0], "Http.Request");

    if (!method)
        return JS_EXCEPTION;
    /* Shift method off and delegate. */
    JSValue r = http_call(ctx, c, c->sess, method, true, false, argc - 1, argv + 1, "Http.Request");

    g_free(method);
    return r;
}

/* The streamed twin of Request, and method-first for the same reason: a POST
 * whose answer arrives in pieces is how a completions endpoint talks, and one
 * name covers it rather than a Stream per verb. */
static JSValue http_client_stream(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Stream: not an Http client");
    if (argc < 1)
        return JS_ThrowTypeError(ctx,
            "Stream(method, url, [body], [opts], onLine, [onDone], [onError]): "
            "needs a method");
    char *method = http_verb_arg(ctx, argv[0], "Http.Stream");

    if (!method)
        return JS_EXCEPTION;

    JSValue r = http_call(ctx, c, c->sess, method, true, true,
                          argc - 1, argv + 1, "Http.Stream");

    g_free(method);
    return r;
}

static JSValue http_client_get(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Get: not an Http client");
    return http_call(ctx, c, c->sess, "GET", false, false, argc, argv, "Http.Get");
}

static JSValue http_client_post(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Post: not an Http client");
    return http_call(ctx, c, c->sess, "POST", true, false, argc, argv, "Http.Post");
}

/* ------------------------------------------------------- sync Wait */

typedef struct {
    bool         done;
    GBytes      *bytes;
    GError      *err;
    SoupMessage *msg;
} HttpWaitState;

static void on_http_wait_done(GObject *src, GAsyncResult *res, gpointer data)
{
    HttpWaitState *w = data;
    SoupSession   *sess = SOUP_SESSION(src);

    w->bytes = soup_session_send_and_read_finish(sess, res, &w->err);
    w->done = true;
}

static gboolean on_http_wait_late(gpointer data)
{
    bool *late = data;

    *late = true;
    return G_SOURCE_REMOVE;
}

/* Blocking sibling: the same message, sent with nobody to call back. */
static JSValue http_wait(JSContext *ctx, HttpClientData *c, SoupSession *sess,
                         const char *method, const char *url,
                         JSValueConst body, JSValueConst opts, const char *who)
{
    SoupMessage *msg;
    char        *full;

    /* Fresh connection: a Wait borrows no pooled one, since one made under an
     * earlier call's private context is not dispatchable from this one's, and
     * a reused TLS connection wedges past the guard instead of answering. */
    if (!http_build(ctx, c, method, url, body, opts, who, true, &msg, &full))
        return JS_EXCEPTION;
    g_free(full);

    int timeout = 0;

    if (!http_int_opt(ctx, opts, "Timeout", c ? c->timeout_ms : 0, &timeout)) {
        g_object_unref(msg);
        return JS_EXCEPTION;
    }
    if (timeout < 0) {
        g_object_unref(msg);
        return JS_ThrowRangeError(ctx, "%s: Timeout %d is negative", who, timeout);
    }

    /* A context of this call's own: iterating the default one would run the
     * application's handlers inside the wait (DoEvents). Pushed before the
     * send -- the task takes the thread-default when it is made. */
    GMainContext *priv = g_main_context_new();

    g_main_context_push_thread_default(priv);

    GCancellable *canc = g_cancellable_new();
    HttpWaitState w = { false, NULL, NULL, NULL };
    bool jar_borrowed = false;

    /* The jar visits for the flight: one feature instance on two sessions at
     * once corrupts the heap on the way out, so it lives on the async
     * session and is only ever borrowed here -- exclusive by construction,
     * since a Wait freezes the loop every async flight is parked on. */
    if (c && c->jar) {
        soup_session_add_feature(sess, SOUP_SESSION_FEATURE(c->jar));
        jar_borrowed = true;
    }

    w.msg = msg;
    soup_session_send_and_read_async(sess, msg, G_PRIORITY_DEFAULT, canc,
                                     on_http_wait_done, &w);

    bool late = false;
    GSource *guard = NULL;

    if (timeout > 0) {
        guard = g_timeout_source_new((guint)timeout);
        g_source_set_callback(guard, on_http_wait_late, &late, NULL);
        g_source_attach(guard, priv);
    }

    while (!w.done && !late)
        g_main_context_iteration(priv, TRUE);

    if (late) {
        g_cancellable_cancel(canc);
        while (!w.done)
            g_main_context_iteration(priv, TRUE);
    }

    if (guard) {
        g_source_destroy(guard);
        g_source_unref(guard);
    }
    g_main_context_pop_thread_default(priv);
    g_main_context_unref(priv);
    g_object_unref(canc);
    if (jar_borrowed && c->jar)
        soup_session_remove_feature(sess, SOUP_SESSION_FEATURE(c->jar));

    if (w.err) {
        const char *kind = late ? "Timeout" :
            (g_error_matches(w.err, G_IO_ERROR, G_IO_ERROR_CANCELLED) ? "Cancelled" :
             http_kind_for(w.err));
        char *detail = g_strdup(w.err->message);

        g_clear_error(&w.err);
        if (w.bytes)
            g_bytes_unref(w.bytes);
        g_object_unref(msg);

        JSValue ex = http_throw_error(ctx, who, url, kind, detail, 0);

        g_free(detail);
        return ex;
    }

    JSValue res = http_response_object(ctx, msg, w.bytes);

    if (late)
        JS_SetPropertyStr(ctx, res, "TimedOut", JS_TRUE);
    if (w.bytes)
        g_bytes_unref(w.bytes);
    g_object_unref(msg);
    return res;
}

/* Wait argument split: (url, [body], [opts]) and no callbacks allowed. */
static JSValue http_wait_call(JSContext *ctx, HttpClientData *c, SoupSession *sess,
                              const char *method, bool takes_body,
                              int argc, JSValueConst *argv, const char *who)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "%s(url, [body], [opts]): needs a URL", who);
    for (int i = 0; i < argc; i++) {
        if (JS_IsFunction(ctx, argv[i]))
            return JS_ThrowTypeError(ctx,
                "%s takes no callbacks -- Wait answers with a record", who);
    }
    const char *s = JS_ToCString(ctx, argv[0]);

    if (!s)
        return JS_EXCEPTION;
    char *url = g_strdup(s);

    JS_FreeCString(ctx, s);

    JSValueConst body = JS_UNDEFINED;
    JSValueConst opts = JS_UNDEFINED;
    int at = 1;

    if (!takes_body && at < argc && http_is_multipart(argv[at])) {
        g_free(url);
        return JS_ThrowTypeError(ctx, "%s carries no body", who);
    }

    if (takes_body && at < argc && !JS_IsObject(argv[at])) {
        body = argv[at++];
    } else if (takes_body && at < argc && JS_IsObject(argv[at])) {
        /* Object here: body unless it names an opts key -- the same table the
         * async split reads, so the two cannot drift apart again. */
        if (!http_looks_like_opts(ctx, argv[at]))
            body = argv[at++];
    }
    if (at < argc && (JS_IsUndefined(argv[at]) || JS_IsNull(argv[at]))) {
        at++;
    } else if (at < argc) {
        if (!JS_IsObject(argv[at]) || JS_IsArray(argv[at]) || JS_IsFunction(ctx, argv[at])) {
            g_free(url);
            return JS_ThrowTypeError(ctx, "%s: the second argument is the options object", who);
        }
        opts = argv[at++];
    }
    if (at < argc) {
        g_free(url);
        return JS_ThrowTypeError(ctx, "%s: too many arguments", who);
    }

    JSValue r = http_wait(ctx, c, sess, method, url, body, opts, who);

    g_free(url);
    return r;
}

static JSValue http_client_getwait(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "GetWait: not an Http client");
    return http_wait_call(ctx, c, c->sess_sync, "GET", false, argc, argv, "Http.GetWait");
}

static JSValue http_client_postwait(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "PostWait: not an Http client");
    return http_wait_call(ctx, c, c->sess_sync, "POST", true, argc, argv, "Http.PostWait");
}

static JSValue http_client_verb(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv,
                                const char *method, bool takes_body, const char *who)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "%s: not an Http client", method);
    return http_call(ctx, c, c->sess, method, takes_body, false, argc, argv, who);
}

static JSValue http_client_put(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    return http_client_verb(ctx, this_val, argc, argv, "PUT", true, "Http.Put");
}

static JSValue http_client_patch(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    return http_client_verb(ctx, this_val, argc, argv, "PATCH", true, "Http.Patch");
}

static JSValue http_client_delete(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    return http_client_verb(ctx, this_val, argc, argv, "DELETE", false, "Http.Delete");
}

static JSValue http_client_head(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    return http_client_verb(ctx, this_val, argc, argv, "HEAD", false, "Http.Head");
}

static JSValue http_client_verbwait(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv,
                                    const char *method, bool takes_body, const char *who)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "%s: not an Http client", method);
    return http_wait_call(ctx, c, c->sess_sync, method, takes_body, argc, argv, who);
}

static JSValue http_client_putwait(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    return http_client_verbwait(ctx, this_val, argc, argv, "PUT", true, "Http.PutWait");
}

static JSValue http_client_patchwait(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    return http_client_verbwait(ctx, this_val, argc, argv, "PATCH", true, "Http.PatchWait");
}

static JSValue http_client_deletewait(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    return http_client_verbwait(ctx, this_val, argc, argv, "DELETE", false, "Http.DeleteWait");
}

static JSValue http_client_headwait(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    return http_client_verbwait(ctx, this_val, argc, argv, "HEAD", false, "Http.HeadWait");
}

static JSValue http_client_requestwait(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    HttpClientData *c = http_client_or_null(ctx, this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "RequestWait: not an Http client");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "RequestWait(method, url, [body], [opts]): needs a method");
    char *method = http_verb_arg(ctx, argv[0], "Http.RequestWait");

    if (!method)
        return JS_EXCEPTION;
    JSValue r = http_wait_call(ctx, c, c->sess_sync, method, true, argc - 1, argv + 1,
                               "Http.RequestWait");

    g_free(method);
    return r;
}

static const JSCFunctionListEntry http_client_props[] = {
    JS_CGETSET_DEF("BaseUrl",         http_client_get_baseurl, http_client_set_baseurl),
    JS_CGETSET_DEF("Headers",         http_client_get_headers, http_client_set_headers),
    JS_CGETSET_DEF("Timeout",         http_client_get_timeout, http_client_set_timeout),
    JS_CGETSET_DEF("FollowRedirects", http_client_get_follow,  http_client_set_follow),
    JS_CGETSET_DEF("Language",        http_client_get_language, http_client_set_language),
    JS_CGETSET_DEF("Proxy",           http_client_get_proxy, http_client_set_proxy),
    JS_CGETSET_DEF("Auth",            http_client_get_auth, http_client_set_auth),
    JS_CGETSET_DEF("Cookies",         http_client_get_cookies, http_client_set_cookies),
    JS_CGETSET_DEF("UserAgent",       http_client_get_user_agent, http_client_set_user_agent),
    JS_CGETSET_DEF("Log",             http_client_get_log, http_client_set_log),
    JS_CGETSET_DEF("IdleTimeout",     http_client_get_idle, http_client_set_idle),
    JS_CGETSET_DEF("MaxConns",        http_client_get_maxconns, http_client_set_const),
    JS_CGETSET_DEF("MaxPerHost",      http_client_get_maxperhost, http_client_set_const),
    /* Arities match the shorthands on `Http` for the same verbs: the same
     * call written two ways reports the same `length`. */
    JS_CFUNC_DEF("Request",     5, http_client_request),
    JS_CFUNC_DEF("Get",         4, http_client_get),
    JS_CFUNC_DEF("Post",        5, http_client_post),
    JS_CFUNC_DEF("Put",         5, http_client_put),
    JS_CFUNC_DEF("Patch",       5, http_client_patch),
    JS_CFUNC_DEF("Delete",      4, http_client_delete),
    JS_CFUNC_DEF("Head",        4, http_client_head),
    JS_CFUNC_DEF("Stream",      6, http_client_stream),
    JS_CFUNC_DEF("RequestWait", 4, http_client_requestwait),
    JS_CFUNC_DEF("GetWait",     2, http_client_getwait),
    JS_CFUNC_DEF("PostWait",    3, http_client_postwait),
    JS_CFUNC_DEF("PutWait",     3, http_client_putwait),
    JS_CFUNC_DEF("PatchWait",   3, http_client_patchwait),
    JS_CFUNC_DEF("DeleteWait",  2, http_client_deletewait),
    JS_CFUNC_DEF("HeadWait",    2, http_client_headwait),
};

/* ------------------------------------------------------- Http global */

static JSValue http_client_new(JSContext *ctx, int max_conns, int max_per_host)
{
    JSValue proto = JS_GetClassProto(ctx, http_client_class_id);
    JSValue obj = JS_NewObjectProtoClass(ctx, proto, http_client_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;
    HttpClientData *c = g_new0(HttpClientData, 1);

    c->sess = http_session_new(max_conns, max_per_host);
    if (!c->sess) {
        JS_FreeValue(ctx, obj);
        g_free(c);
        return JS_EXCEPTION;
    }
    /* The blocking twin: same settings, separate pool (see the struct). */
    c->sess_sync = http_session_new(max_conns, max_per_host);
    if (!c->sess_sync) {
        g_object_unref(c->sess);
        JS_FreeValue(ctx, obj);
        g_free(c);
        return JS_EXCEPTION;
    }
    c->headers = JS_UNDEFINED;
    c->timeout_ms = 0;
    c->follow = true;
    c->max_conns = max_conns;
    c->max_per_host = max_per_host;
    JS_SetOpaque(obj, c);
    return obj;
}

/* A text option out of the constructor's object: NULL and nothing set when
 * absent, NULL with an exception pending when it cannot be read. Reading it
 * inline and carrying on with `if (s)` left the exception pending and the
 * option unset, where the matching setters refuse -- one object, two answers
 * for the same bad value. Empty text means "send none", which is what the
 * setters mean by it too. */
static bool http_text_opt(JSContext *ctx, JSValueConst opts, const char *key, char **out)
{
    JSValue v;
    const char *cs;

    if (!JS_IsObject(opts))
        return true;
    v = JS_GetPropertyStr(ctx, opts, key);
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }
    cs = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    if (!cs)
        return false;
    g_free(*out);
    *out = cs[0] ? g_strdup(cs) : NULL;
    JS_FreeCString(ctx, cs);
    return true;
}

static JSValue js_http_client(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    JSValueConst opts = JS_UNDEFINED;
    int max_conns = 10;
    int max_per_host = 2;

    /* A URL where the options go is what somebody coming from `fetch` writes,
     * and reading it as "no options given" configures nothing while looking
     * like it worked. */
    if (argc > 0 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
        if (!JS_IsObject(argv[0]) || JS_IsArray(argv[0]) || JS_IsFunction(ctx, argv[0]))
            return JS_ThrowTypeError(ctx,
                "Http.Client([options]): the options are an object -- "
                "a BaseUrl goes in one, as { BaseUrl: \"...\" }");
        opts = argv[0];
    }

    if (JS_IsObject(opts)) {
        /* Constructor-only, like soup's own: read before either session
         * exists, since afterwards there is nothing to set them on. */
        if (!http_int_opt(ctx, opts, "MaxConns", 10, &max_conns) ||
            !http_int_opt(ctx, opts, "MaxPerHost", 2, &max_per_host)) {
            return JS_EXCEPTION;
        }
        if (max_conns < 1 || max_per_host < 1) {
            return JS_ThrowRangeError(ctx,
                "Http.Client: MaxConns and MaxPerHost count connections, so 1 at least");
        }
    }
    JSValue obj = http_client_new(ctx, max_conns, max_per_host);

    if (JS_IsException(obj))
        return obj;
    HttpClientData *c = http_client_data(obj);

    if (JS_IsObject(opts)) {
        if (!http_text_opt(ctx, opts, "BaseUrl", &c->base_url)) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }

        JSValue h = JS_GetPropertyStr(ctx, opts, "Headers");

        if (!JS_IsUndefined(h) && !JS_IsNull(h)) {
            if (!JS_IsObject(h) || JS_IsArray(h) || JS_IsFunction(ctx, h)) {
                JS_FreeValue(ctx, h);
                JS_FreeValue(ctx, obj);
                return JS_ThrowTypeError(ctx, "Http.Client: Headers must be an object");
            }
            c->headers = JS_DupValue(ctx, h);
        }
        JS_FreeValue(ctx, h);

        if (!http_int_opt(ctx, opts, "Timeout", 0, &c->timeout_ms)) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
        if (c->timeout_ms < 0) {
            JS_FreeValue(ctx, obj);
            return JS_ThrowRangeError(ctx, "Http.Client: Timeout is negative");
        }
        bool present = false;

        c->follow = http_bool_opt(ctx, opts, "FollowRedirects", true, &present);

        if (!http_text_opt(ctx, opts, "Language", &c->language)) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }

        JSValue px = JS_GetPropertyStr(ctx, opts, "Proxy");

        if (!JS_IsUndefined(px)) {
            bool off = false;
            char *url = NULL;

            if (!http_proxy_value(ctx, px, "Http.Client", &off, &url)) {
                JS_FreeValue(ctx, px);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
            c->proxy_off = off;
            g_free(c->proxy_url);
            c->proxy_url = url;
        }
        JS_FreeValue(ctx, px);

        JSValue au = JS_GetPropertyStr(ctx, opts, "Auth");

        if (!JS_IsUndefined(au) && !JS_IsNull(au)) {
            if (!http_parse_auth(ctx, au, "Http.Client", &c->auth_user, &c->auth_pass)) {
                JS_FreeValue(ctx, au);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
        }
        JS_FreeValue(ctx, au);

        JSValue ck = JS_GetPropertyStr(ctx, opts, "Cookies");

        if (!JS_IsUndefined(ck) && !JS_IsNull(ck))
            c->cookies = JS_ToBool(ctx, ck) > 0;
        JS_FreeValue(ctx, ck);

        JSValue lv = JS_GetPropertyStr(ctx, opts, "Log");

        if (!JS_IsUndefined(lv) && !JS_IsNull(lv)) {
            int level = SOUP_LOGGER_LOG_NONE;

            if (!http_log_value(ctx, lv, "Http.Client", &level)) {
                JS_FreeValue(ctx, lv);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
            c->log_level = level;
        }
        JS_FreeValue(ctx, lv);

        if (!http_text_opt(ctx, opts, "UserAgent", &c->user_agent)) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }

        if (!http_int_opt(ctx, opts, "IdleTimeout", 0, &c->idle_ms)) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
        if (c->idle_ms < 0) {
            JS_FreeValue(ctx, obj);
            return JS_ThrowRangeError(ctx, "Http.Client: IdleTimeout is negative");
        }

        http_client_apply_session(c);
    }
    return obj;
}

static JSValue js_http_request(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx,
            "Http.Request(method, url, [body], [opts], onDone, [onError]): needs a method");
    char *method = http_verb_arg(ctx, argv[0], "Http.Request");

    if (!method)
        return JS_EXCEPTION;
    JSValue r = http_call(ctx, NULL, http_default_session, method, true, false,
                          argc - 1, argv + 1, "Http.Request");

    g_free(method);
    return r;
}

static JSValue js_http_stream(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx,
            "Http.Stream(method, url, [body], [opts], onLine, [onDone], [onError]): "
            "needs a method");
    char *method = http_verb_arg(ctx, argv[0], "Http.Stream");

    if (!method)
        return JS_EXCEPTION;
    JSValue r = http_call(ctx, NULL, http_default_session, method, true, true,
                          argc - 1, argv + 1, "Http.Stream");

    g_free(method);
    return r;
}

static JSValue js_http_get(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    return http_call(ctx, NULL, http_default_session, "GET", false, false, argc, argv, "Http.Get");
}

static JSValue js_http_post(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    return http_call(ctx, NULL, http_default_session, "POST", true, false, argc, argv, "Http.Post");
}

static JSValue js_http_requestwait(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Http.RequestWait(method, url, [body], [opts]): needs a method");
    char *method = http_verb_arg(ctx, argv[0], "Http.RequestWait");

    if (!method)
        return JS_EXCEPTION;
    JSValue r = http_wait_call(ctx, NULL, http_default_sync_session, method, true,
                               argc - 1, argv + 1, "Http.RequestWait");

    g_free(method);
    return r;
}

static JSValue js_http_getwait(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    return http_wait_call(ctx, NULL, http_default_sync_session, "GET", false,
                          argc, argv, "Http.GetWait");
}

static JSValue js_http_postwait(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    return http_wait_call(ctx, NULL, http_default_sync_session, "POST", true,
                          argc, argv, "Http.PostWait");
}

static JSValue js_http_verb(JSContext *ctx, int argc, JSValueConst *argv,
                            const char *method, bool takes_body, const char *who)
{
    return http_call(ctx, NULL, http_default_session, method, takes_body, false,
                     argc, argv, who);
}

static JSValue js_http_put(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    return js_http_verb(ctx, argc, argv, "PUT", true, "Http.Put");
}

static JSValue js_http_patch(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    return js_http_verb(ctx, argc, argv, "PATCH", true, "Http.Patch");
}

static JSValue js_http_delete(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    return js_http_verb(ctx, argc, argv, "DELETE", false, "Http.Delete");
}

static JSValue js_http_head(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    return js_http_verb(ctx, argc, argv, "HEAD", false, "Http.Head");
}

static JSValue js_http_verbwait(JSContext *ctx, int argc, JSValueConst *argv,
                                const char *method, bool takes_body, const char *who)
{
    return http_wait_call(ctx, NULL, http_default_sync_session, method, takes_body,
                          argc, argv, who);
}

static JSValue js_http_putwait(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    return js_http_verbwait(ctx, argc, argv, "PUT", true, "Http.PutWait");
}

static JSValue js_http_patchwait(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    return js_http_verbwait(ctx, argc, argv, "PATCH", true, "Http.PatchWait");
}

static JSValue js_http_deletewait(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    return js_http_verbwait(ctx, argc, argv, "DELETE", false, "Http.DeleteWait");
}

static JSValue js_http_headwait(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    return js_http_verbwait(ctx, argc, argv, "HEAD", false, "Http.HeadWait");
}

static JSValue js_http_server(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv);

static const JSCFunctionListEntry http_props[] = {
    JS_CFUNC_DEF("Client",      1, js_http_client),
    JS_CFUNC_DEF("Server",      1, js_http_server),
    JS_CFUNC_DEF("Request",     5, js_http_request),
    JS_CFUNC_DEF("Get",         4, js_http_get),
    JS_CFUNC_DEF("Post",        5, js_http_post),
    JS_CFUNC_DEF("Put",         5, js_http_put),
    JS_CFUNC_DEF("Patch",       5, js_http_patch),
    JS_CFUNC_DEF("Delete",      4, js_http_delete),
    JS_CFUNC_DEF("Head",        4, js_http_head),
    JS_CFUNC_DEF("Stream",      6, js_http_stream),
    JS_CFUNC_DEF("RequestWait", 4, js_http_requestwait),
    JS_CFUNC_DEF("GetWait",     2, js_http_getwait),
    JS_CFUNC_DEF("PostWait",    3, js_http_postwait),
    JS_CFUNC_DEF("PutWait",     3, js_http_putwait),
    JS_CFUNC_DEF("PatchWait",   3, js_http_patchwait),
    JS_CFUNC_DEF("DeleteWait",  2, js_http_deletewait),
    JS_CFUNC_DEF("HeadWait",    2, js_http_headwait),
};

/* ------------------------------------------------------- Server */

/* One listening socket set, answered on the loop that runs the application:
 * a server belongs to the loop the way a watch does, so creation and
 * dispatch share the default context by construction -- the affinity question
 * that made Wait need two sessions never arises here. Running servers are
 * counted in pending (a console server that returned from main with nothing
 * owed would exit before its first request) and disconnected on the way out,
 * or the port stays held past the program. */
typedef struct {
    JSContext   *ctx;       /* the loop's, for building a request object */
    SoupServer  *server;    /* NULL until Start, and after Stop */
    JSValue      handler;   /* Request fn, duplicated -- reported via gc_mark */
    bool         running;
    int          port;       /* declared until Start, actual after */
    char        *url;        /* actual base URL after Start */
    bool         local;      /* loopback only (default) vs all interfaces */
    char        *server_name;
    char        *tls_cert;   /* files; NULL is plain HTTP */
    char        *tls_key;
    char       **allow;      /* NULL is open; else exact IPs, NULL-terminated */
    char        *auth_realm;
    GHashTable  *auth_users; /* user -> pass; NULL is open */
    SoupAuthDomain *auth_domain; /* live while running with Auth (server-owned) */
} HttpServerData;

static JSClassID http_server_class_id;
/* Every live server: what teardown disconnects the listening ones from. A
 * finalizer is too late for that -- the port would outlive the program by
 * however long the wrappers take to die. A client needs no such list, since
 * nothing it holds is owed to anybody outside the process. */
static GList *http_servers;

typedef struct {
    SoupServerMessage *msg;  /* our ref while the handler runs; NULL after */
    bool               answered;
} HttpReqData;

static JSClassID http_request_class_id;

static HttpServerData *http_server_data(JSValueConst v)
{
    return JS_GetOpaque(v, http_server_class_id);
}

static HttpReqData *http_req_data(JSValueConst v)
{
    return JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT
        ? JS_GetOpaque(v, http_request_class_id) : NULL;
}

/* `rt` is the runtime to free the handler against, or NULL when the caller
 * has already dropped it (teardown, which runs before the wrappers die). */
static void http_server_free(JSRuntime *rt, HttpServerData *s)
{
    if (!s)
        return;
    http_servers = g_list_remove(http_servers, s);
    if (s->auth_domain) {
        if (s->server && s->running)
            soup_server_remove_auth_domain(s->server, s->auth_domain);
        g_object_unref(s->auth_domain);
        s->auth_domain = NULL;
    }
    if (s->server) {
        if (s->running)
            soup_server_disconnect(s->server);
        g_object_unref(s->server);
    }
    if (rt)
        JS_FreeValueRT(rt, s->handler);
    g_free(s->url);
    g_free(s->server_name);
    g_free(s->tls_cert);
    g_free(s->tls_key);
    if (s->allow)
        g_strfreev(s->allow);
    g_free(s->auth_realm);
    if (s->auth_users)
        g_hash_table_unref(s->auth_users);
    g_free(s);
}

/* The gate's answer: the Users table rides with the domain and dies with it. */
static gboolean on_server_auth(SoupAuthDomain *domain, SoupServerMessage *msg,
                               const char *username, const char *password, gpointer data)
{
    GHashTable *users = data;
    const char *want = (username && users) ? g_hash_table_lookup(users, username) : NULL;

    (void)domain;
    (void)msg;
    return want && !strcmp(want, password ? password : "");
}

/* (Re)builds the live gate from the current config: called at Start and
 * whenever Auth is assigned while running, so a gate always answers for
 * what the object holds now. A stopped server keeps no domain. */
static void http_server_apply_auth(HttpServerData *s)
{
    if (s->auth_domain) {
        if (s->server)
            soup_server_remove_auth_domain(s->server, s->auth_domain);
        g_object_unref(s->auth_domain);
        s->auth_domain = NULL;
    }
    if (s->server && s->running && s->auth_realm && s->auth_users) {
        SoupAuthDomain *domain =
            soup_auth_domain_basic_new("realm", s->auth_realm, NULL);

        /* A domain covers no path until told: the gate is the whole server. */
        soup_auth_domain_add_path(domain, "/");
        soup_auth_domain_basic_set_auth_callback(
            domain, on_server_auth,
            g_hash_table_ref(s->auth_users), (GDestroyNotify)g_hash_table_unref);
        soup_server_add_auth_domain(s->server, domain);
        /* Ours to keep whether or not the server takes its own: dropping it
         * here would leave the gate on borrowed memory under one convention
         * and leak it under the other. */
        s->auth_domain = g_object_ref(domain);
        g_object_unref(domain);
    }
}

static void http_server_finalizer(JSRuntime *rt, JSValue v)
{
    HttpServerData *s = JS_GetOpaque(v, http_server_class_id);

    /* Dropping a listening server stops it: the alternative is a port held
     * past the program by an object nobody references. */
    http_server_free(rt, s);
}

/* The handler is a strong reference in an opaque slot, and the shape every
 * server is written in closes over the server itself (`srv.Request = (req)
 * => { ... srv ... }`). Without this that pair is an uncollectable cycle --
 * a listening socket nothing can reach and nothing can free. */
static void http_server_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    HttpServerData *s = JS_GetOpaque(v, http_server_class_id);

    if (s)
        JS_MarkValue(rt, s->handler, mark);
}

static void http_req_finalizer(JSRuntime *rt, JSValue v)
{
    HttpReqData *r = JS_GetOpaque(v, http_request_class_id);

    (void)rt;
    if (!r)
        return;
    if (r->msg)
        g_object_unref(r->msg);
    g_free(r);
}

typedef struct {
    JSContext *ctx;
    JSValue    obj;
} HttpServerHeadersWalk;

static void http_server_header_foreach(const char *name, const char *value, gpointer data)
{
    HttpServerHeadersWalk *w = data;
    char                  *lower = g_ascii_strdown(name, -1);

    JS_SetPropertyStr(w->ctx, w->obj, lower, JS_NewString(w->ctx, value ? value : ""));
    g_free(lower);
}

static void http_server_query_foreach(gpointer key, gpointer value, gpointer data)
{
    HttpServerHeadersWalk *w = data;

    JS_SetPropertyStr(w->ctx, w->obj, (const char *)key,
                      JS_NewString(w->ctx, value ? (const char *)value : ""));
}

/* The client's body rules, both directions: text, Bytes, or an object that
 * serialises canonical with application/json. */
static bool http_answer_bytes(JSContext *ctx, JSValueConst body, JSValueConst opts,
                              const char **ctype_out, char **ctype_free, const char *who,
                              GBytes **out)
{
    *ctype_out = NULL;
    *ctype_free = NULL;
    *out = NULL;

    if (JS_IsUndefined(body) || JS_IsNull(body))
        return true;
    return http_body_bytes(ctx, body, opts, ctype_out, ctype_free, who, out);
}

static JSValue http_request_answer(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    HttpReqData *r = http_req_data(this_val);
    int32_t      status = 0;
    JSValueConst body = JS_UNDEFINED;
    JSValueConst opts = JS_UNDEFINED;
    const char  *ctype = NULL;
    char        *ctype_free = NULL;
    GBytes      *b = NULL;

    if (!r || !r->msg)
        return JS_ThrowTypeError(ctx, "Answer: the request already ended");
    if (r->answered)
        return JS_ThrowTypeError(ctx, "Answer: the request was already answered");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Answer(status, [body], [opts]): needs a status");
    if (!bta_to_int(ctx, argv[0], "Answer", &status))
        return JS_EXCEPTION;
    if (status < 100 || status > 599)
        return JS_ThrowRangeError(ctx, "Answer: %d is not a status", status);
    /* Positional, so a JSON body never reads as options: the second argument
     * is always the body, the third always the options (explicit undefined
     * for headers without a body, forgiven like everywhere else). */
    if (argc > 1)
        body = argv[1];
    if (argc > 2) {
        if (JS_IsUndefined(argv[2]) || JS_IsNull(argv[2])) {
            /* headers without a body */
        } else if (JS_IsObject(argv[2]) && !JS_IsArray(argv[2]) &&
                   !JS_IsFunction(ctx, argv[2])) {
            opts = argv[2];
        } else {
            return JS_ThrowTypeError(ctx,
                "Answer: the third argument is the options object");
        }
    }
    if (argc > 3)
        return JS_ThrowTypeError(ctx, "Answer: too many arguments");

    if (!http_answer_bytes(ctx, body, opts, &ctype, &ctype_free, "Answer", &b))
        return JS_EXCEPTION;

    if (JS_IsObject(opts)) {
        JSValue hv = JS_GetPropertyStr(ctx, opts, "Headers");

        if (!JS_IsUndefined(hv) && !JS_IsNull(hv)) {
            if (!JS_IsObject(hv) || JS_IsArray(hv) || JS_IsFunction(ctx, hv)) {
                JS_FreeValue(ctx, hv);
                if (b)
                    g_bytes_unref(b);
                g_free(ctype_free);
                return JS_ThrowTypeError(ctx, "Answer: Headers must be an object");
            }
            SoupMessageHeaders *rh =
                soup_server_message_get_response_headers(r->msg);
            JSPropertyEnum *tab = NULL;
            uint32_t        len = 0;

            if (JS_GetOwnPropertyNames(ctx, &tab, &len, (JSValue)hv,
                                       JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
                for (uint32_t i = 0; i < len; i++) {
                    const char *k = JS_AtomToCString(ctx, tab[i].atom);
                    JSValue     vv = JS_GetProperty(ctx, hv, tab[i].atom);
                    const char *vs = JS_ToCString(ctx, vv);

                    if (k && vs)
                        soup_message_headers_replace(rh, k, vs);
                    if (k)
                        JS_FreeCString(ctx, k);
                    if (vs)
                        JS_FreeCString(ctx, vs);
                    JS_FreeValue(ctx, vv);
                }
                JS_FreePropertyEnum(ctx, tab, len);
            }
        }
        JS_FreeValue(ctx, hv);
    }

    /* Read after the headers went on and before the body overwrites it: the
     * answer follows the request's rule, a named type beating an inferred
     * one. */
    char *declared_ct = http_declared_type(soup_server_message_get_response_headers(r->msg));

    soup_server_message_set_status(r->msg, (guint)status, NULL);
    if (b) {
        gsize        blen = 0;
        const void  *bdata = g_bytes_get_data(b, &blen);

        soup_server_message_set_response(r->msg,
                                         ctype ? ctype : "application/octet-stream",
                                         SOUP_MEMORY_COPY, bdata, blen);
        g_bytes_unref(b);
        if (!ctype_free)
            http_keep_declared_type(
                soup_server_message_get_response_headers(r->msg), declared_ct);
    }
    g_free(ctype_free);
    g_free(declared_ct);
    r->answered = true;
    return JS_UNDEFINED;
}

static JSValue http_request_multipart(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    HttpReqData        *r = http_req_data(this_val);
    SoupMessageHeaders *hds;
    SoupMessageBody    *bd;
    GBytes             *flat = NULL;
    GBytes             *input;
    SoupMultipart      *parsed;
    JSValue             proto;
    JSValue             obj;
    HttpMultipart      *m;

    if (!r || !r->msg)
        return JS_ThrowTypeError(ctx, "Multipart: the request already ended");
    hds = soup_server_message_get_request_headers(r->msg);
    bd = soup_server_message_get_request_body(r->msg);
    if (bd)
        flat = soup_message_body_flatten(bd);
    /* new_from_message wants bytes even when there are none to parse. */
    input = flat ? flat : g_bytes_new("", 0);
    parsed = soup_multipart_new_from_message(hds, input);
    if (!parsed) {
        g_bytes_unref(input);
        return JS_ThrowTypeError(ctx, "Multipart: not a multipart request");
    }
    proto = JS_GetClassProto(ctx, http_multipart_class_id);
    obj = JS_NewObjectProtoClass(ctx, proto, http_multipart_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        soup_multipart_free(parsed);
        g_bytes_unref(input);
        return obj;
    }
    m = g_new0(HttpMultipart, 1);
    m->mp = parsed;
    m->flat = input;
    JS_SetOpaque(obj, m);
    return obj;
}

static const JSCFunctionListEntry http_request_props[] = {
    JS_CFUNC_DEF("Answer", 3, http_request_answer),
    JS_CFUNC_DEF("Multipart", 0, http_request_multipart),
};

static void on_server_request(SoupServer *server, SoupServerMessage *msg,
                              const char *path, GHashTable *query, gpointer data)
{
    HttpServerData *s = data;

    (void)server;
    (void)path;
    /* The gate runs before anything is built: a refused remote never reaches
     * the handler, and answering it is soup's shape, not the handler's. */
    if (s->allow) {
        const char *remote = soup_server_message_get_remote_host(msg);
        bool        ok = false;

        for (char **a = s->allow; *a; a++) {
            if (!strcmp(*a, remote ? remote : "")) {
                ok = true;
                break;
            }
        }
        if (!ok) {
            soup_server_message_set_status(msg, 403, NULL);
            soup_server_message_set_response(msg, "text/plain", SOUP_MEMORY_STATIC,
                                             "forbidden", 9);
            return;
        }
    }

    GUri           *uri = soup_server_message_get_uri(msg);
    const char     *upath = uri ? g_uri_get_path(uri) : NULL;
    JSValue         proto = JS_GetClassProto(s->ctx, http_request_class_id);
    JSValue         req = JS_NewObjectProtoClass(s->ctx, proto, http_request_class_id);
    HttpReqData    *r;

    JS_FreeValue(s->ctx, proto);
    if (JS_IsException(req))
        return;
    r = g_new0(HttpReqData, 1);
    r->msg = g_object_ref(msg);
    JS_SetOpaque(req, r);

    JS_SetPropertyStr(s->ctx, req, "Method",
                      JS_NewString(s->ctx, soup_server_message_get_method(msg)));
    JS_SetPropertyStr(s->ctx, req, "Path",
                      JS_NewString(s->ctx, upath && upath[0] ? upath : "/"));
    JSValue q = JS_NewObject(s->ctx);
    if (query) {
        HttpServerHeadersWalk w = { s->ctx, q };

        g_hash_table_foreach(query, http_server_query_foreach, &w);
    }
    JS_SetPropertyStr(s->ctx, req, "Query", q);

    JSValue hobj = JS_NewObject(s->ctx);
    HttpServerHeadersWalk w = { s->ctx, hobj };

    soup_message_headers_foreach(soup_server_message_get_request_headers(msg),
                                 http_server_header_foreach, &w);
    JS_SetPropertyStr(s->ctx, req, "Headers", hobj);

    SoupMessageBody *rbody = soup_server_message_get_request_body(msg);
    GBytes          *flat = rbody ? soup_message_body_flatten(rbody) : NULL;
    gsize            flen = 0;
    const void      *fdata = flat ? g_bytes_get_data(flat, &flen) : NULL;

    JS_SetPropertyStr(s->ctx, req, "Body", bta_bytes_new(s->ctx, fdata, flen ? flen : 0));
    if (flat)
        g_bytes_unref(flat);

    const char *remote = soup_server_message_get_remote_host(msg);

    JS_SetPropertyStr(s->ctx, req, "Remote", JS_NewString(s->ctx, remote ? remote : ""));

    /*
     * **The handler is held for the length of its own call.** The reference is
     * documented as replaceable while running, and a handler that installs its
     * successor (`srv.Request = next`) freed the closure it was executing in:
     * `http_server_set_request` drops the old value at once, and the next
     * allocation inside the running function was a heap-use-after-free --
     * ASan's report on the first request. And nothing after the call reads the
     * server: a handler that let go of the last reference to it may have had it
     * finalised, so the context is taken first, as `on_file_changed` does.
     */
    JSContext *ctx = s->ctx;

    if (JS_IsFunction(ctx, s->handler)) {
        JSValue fn  = JS_DupValue(ctx, s->handler);
        JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, 1, &req);

        if (JS_IsException(ret))
            bta_dump_error(ctx);
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, fn);
        bta_drain_jobs(JS_GetRuntime(ctx));
    }
    /* A handler that returns without answering gets a 500: hanging the
     * connection instead would fail silently and forever. */
    if (!r->answered)
        soup_server_message_set_status(msg, 500, NULL);
    /* The message outlives nothing here: a later Answer throws instead of
     * writing into freed memory. */
    g_clear_object(&r->msg);
    JS_FreeValue(ctx, req);
}

static JSValue http_server_get_running(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Running: not an Http server");
    return JS_NewBool(ctx, s->running);
}

static JSValue http_server_get_port(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Port: not an Http server");
    return JS_NewInt32(ctx, s->port);
}

static JSValue http_server_set_port(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpServerData *s = http_server_data(this_val);
    int32_t         n = 0;

    if (!s)
        return JS_ThrowTypeError(ctx, "Port: not an Http server");
    if (!bta_to_int(ctx, v, "Port", &n))
        return JS_EXCEPTION;
    if (n < 0 || n > 65535)
        return JS_ThrowRangeError(ctx, "Port: %d is not a port", n);
    s->port = n;
    return JS_UNDEFINED;
}

static JSValue http_server_get_url(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Url: not an Http server");
    return JS_NewString(ctx, s->url ? s->url : "");
}

static JSValue http_server_get_host(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Host: not an Http server");
    return JS_NewString(ctx, s->local ? "local" : "any");
}

static JSValue http_server_set_host(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpServerData *s = http_server_data(this_val);
    const char     *h;

    if (!s)
        return JS_ThrowTypeError(ctx, "Host: not an Http server");
    h = JS_ToCString(ctx, v);
    if (!h)
        return JS_EXCEPTION;
    if (!strcmp(h, "local")) {
        s->local = true;
    } else if (!strcmp(h, "any")) {
        s->local = false;
    } else {
        JS_FreeCString(ctx, h);
        return JS_ThrowTypeError(ctx, "Host must be \"local\" or \"any\"");
    }
    JS_FreeCString(ctx, h);
    return JS_UNDEFINED;
}

static JSValue http_server_get_name(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "ServerName: not an Http server");
    return JS_NewString(ctx, s->server_name ? s->server_name : "");
}

static JSValue http_server_set_name(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpServerData *s = http_server_data(this_val);
    const char     *n;

    if (!s)
        return JS_ThrowTypeError(ctx, "ServerName: not an Http server");
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        g_free(s->server_name);
        s->server_name = NULL;
        return JS_UNDEFINED;
    }
    n = JS_ToCString(ctx, v);
    if (!n)
        return JS_EXCEPTION;
    g_free(s->server_name);
    s->server_name = g_strdup(n);
    JS_FreeCString(ctx, n);
    return JS_UNDEFINED;
}

/* Tls is { Cert, Key } files, or nothing: dups on success. */
static bool http_server_parse_tls(JSContext *ctx, JSValueConst v, const char *who,
                                  char **cert, char **key)
{
    JSValue     cv;
    JSValue     kv;
    const char *cs;
    const char *ks;

    *cert = NULL;
    *key = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v))
        return true;
    if (!JS_IsObject(v) || JS_IsArray(v) || JS_IsFunction(ctx, v)) {
        JS_ThrowTypeError(ctx, "%s: Tls must be an object with Cert and Key", who);
        return false;
    }
    cv = JS_GetPropertyStr(ctx, v, "Cert");
    kv = JS_GetPropertyStr(ctx, v, "Key");
    cs = (JS_IsUndefined(cv) || JS_IsNull(cv)) ? NULL : JS_ToCString(ctx, cv);
    ks = (JS_IsUndefined(kv) || JS_IsNull(kv)) ? NULL : JS_ToCString(ctx, kv);
    if ((!JS_IsUndefined(cv) && !JS_IsNull(cv) && !cs) ||
        (!JS_IsUndefined(kv) && !JS_IsNull(kv) && !ks)) {
        JS_FreeValue(ctx, cv);
        JS_FreeValue(ctx, kv);
        return false;
    }
    if (!cs || !ks) {
        JS_ThrowTypeError(ctx, "%s: Tls needs a Cert and a Key", who);
        if (cs)
            JS_FreeCString(ctx, cs);
        if (ks)
            JS_FreeCString(ctx, ks);
        JS_FreeValue(ctx, cv);
        JS_FreeValue(ctx, kv);
        return false;
    }
    *cert = g_strdup(cs);
    *key = g_strdup(ks);
    JS_FreeCString(ctx, cs);
    JS_FreeCString(ctx, ks);
    JS_FreeValue(ctx, cv);
    JS_FreeValue(ctx, kv);
    if (!*cert || !*key) {
        g_free(*cert);
        g_free(*key);
        *cert = *key = NULL;
        JS_ThrowInternalError(ctx, "%s: out of memory", who);
        return false;
    }
    return true;
}

/* Allow is a list of exact IPs, or nothing (open). */
static bool http_server_parse_allow(JSContext *ctx, JSValueConst v, const char *who,
                                    char ***out)
{
    uint32_t n = 0;
    char   **list;

    *out = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v))
        return true;
    if (!JS_IsArray(v)) {
        JS_ThrowTypeError(ctx, "%s: Allow must be a list of addresses", who);
        return false;
    }
    JSValue lenv = JS_GetPropertyStr(ctx, v, "length");

    if (JS_ToUint32(ctx, &n, lenv)) {
        JS_FreeValue(ctx, lenv);
        return false;
    }
    JS_FreeValue(ctx, lenv);
    list = g_new0(char *, n + 1);
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, v, i);
        const char *s = JS_ToCString(ctx, e);

        JS_FreeValue(ctx, e);
        if (!s) {
            g_strfreev(list);
            return false;
        }
        list[i] = g_strdup(s);
        JS_FreeCString(ctx, s);
        if (!list[i]) {
            g_strfreev(list);
            return false;
        }
    }
    *out = list;
    return true;
}

/* Auth is { Realm, Users } or nothing: realm plus a user->pass table. */
static bool http_server_parse_auth(JSContext *ctx, JSValueConst v, const char *who,
                                   char **realm, GHashTable **users)
{
    JSValue     rv;
    JSValue     uv;
    const char *rs;

    *realm = NULL;
    *users = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v))
        return true;
    if (!JS_IsObject(v) || JS_IsArray(v) || JS_IsFunction(ctx, v)) {
        JS_ThrowTypeError(ctx, "%s: Auth must be an object with Realm and Users", who);
        return false;
    }
    rv = JS_GetPropertyStr(ctx, v, "Realm");
    uv = JS_GetPropertyStr(ctx, v, "Users");
    if (JS_IsUndefined(rv) || JS_IsNull(rv) ||
        !JS_IsObject(uv) || JS_IsArray(uv) || JS_IsFunction(ctx, uv)) {
        JS_ThrowTypeError(ctx, "%s: Auth needs a Realm and Users", who);
        JS_FreeValue(ctx, rv);
        JS_FreeValue(ctx, uv);
        return false;
    }
    rs = JS_ToCString(ctx, rv);
    JS_FreeValue(ctx, rv);
    if (!rs) {
        JS_FreeValue(ctx, uv);
        return false;
    }
    *realm = g_strdup(rs);
    JS_FreeCString(ctx, rs);
    if (!*realm) {
        JS_FreeValue(ctx, uv);
        return false;
    }
    *users = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
    JSPropertyEnum *tab = NULL;
    uint32_t        len = 0;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, (JSValue)uv,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
        for (uint32_t i = 0; i < len; i++) {
            const char *k = JS_AtomToCString(ctx, tab[i].atom);
            JSValue     vv = JS_GetProperty(ctx, uv, tab[i].atom);
            const char *vs = JS_ToCString(ctx, vv);

            if (k && vs)
                g_hash_table_insert(*users, g_strdup(k), g_strdup(vs));
            if (k)
                JS_FreeCString(ctx, k);
            if (vs)
                JS_FreeCString(ctx, vs);
            JS_FreeValue(ctx, vv);
        }
        JS_FreePropertyEnum(ctx, tab, len);
    }
    JS_FreeValue(ctx, uv);
    return true;
}

static JSValue http_server_get_tls(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);
    JSValue         o;

    if (!s)
        return JS_ThrowTypeError(ctx, "Tls: not an Http server");
    if (!s->tls_cert)
        return JS_NULL;
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "Cert", JS_NewString(ctx, s->tls_cert));
    JS_SetPropertyStr(ctx, o, "Key", JS_NewString(ctx, s->tls_key ? s->tls_key : ""));
    return o;
}

static JSValue http_server_set_tls(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpServerData *s = http_server_data(this_val);
    char           *cert = NULL;
    char           *key = NULL;

    if (!s)
        return JS_ThrowTypeError(ctx, "Tls: not an Http server");
    if (!http_server_parse_tls(ctx, v, "Tls", &cert, &key))
        return JS_EXCEPTION;
    g_free(s->tls_cert);
    g_free(s->tls_key);
    s->tls_cert = cert;
    s->tls_key = key;
    return JS_UNDEFINED;
}

static JSValue http_server_get_allow(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);
    JSValue         out;

    if (!s)
        return JS_ThrowTypeError(ctx, "Allow: not an Http server");
    out = JS_NewArray(ctx);
    if (s->allow) {
        uint32_t i = 0;

        for (char **a = s->allow; *a; a++, i++)
            JS_SetPropertyUint32(ctx, out, i, JS_NewString(ctx, *a));
    }
    return out;
}

static JSValue http_server_set_allow(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpServerData *s = http_server_data(this_val);
    char         **allow = NULL;

    if (!s)
        return JS_ThrowTypeError(ctx, "Allow: not an Http server");
    if (!http_server_parse_allow(ctx, v, "Allow", &allow))
        return JS_EXCEPTION;
    if (s->allow)
        g_strfreev(s->allow);
    s->allow = allow;
    return JS_UNDEFINED;
}

static JSValue http_server_get_auth(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);
    JSValue         o;
    JSValue         users;

    if (!s)
        return JS_ThrowTypeError(ctx, "Auth: not an Http server");
    /* An open server reads back as nothing, like a client with no
     * credentials -- a realm named "" is not what "open" means. */
    if (!s->auth_realm)
        return JS_NULL;
    o = JS_NewObject(ctx);
    users = JS_NewObject(ctx);
    if (s->auth_users) {
        GHashTableIter it;
        gpointer       k;
        gpointer       val;

        g_hash_table_iter_init(&it, s->auth_users);
        while (g_hash_table_iter_next(&it, &k, &val))
            JS_SetPropertyStr(ctx, users, (const char *)k,
                              JS_NewString(ctx, (const char *)val));
    }
    JS_SetPropertyStr(ctx, o, "Realm", JS_NewString(ctx, s->auth_realm));
    JS_SetPropertyStr(ctx, o, "Users", users);
    return o;
}

static JSValue http_server_set_auth(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpServerData *s = http_server_data(this_val);
    char           *realm = NULL;
    GHashTable     *users = NULL;

    if (!s)
        return JS_ThrowTypeError(ctx, "Auth: not an Http server");
    if (!http_server_parse_auth(ctx, v, "Auth", &realm, &users))
        return JS_EXCEPTION;
    g_free(s->auth_realm);
    if (s->auth_users)
        g_hash_table_unref(s->auth_users);
    s->auth_realm = realm;
    s->auth_users = users;
    /* Live when running (a gate answers for what the object holds now),
     * built at Start otherwise. */
    http_server_apply_auth(s);
    return JS_UNDEFINED;
}

static JSValue http_server_get_request(JSContext *ctx, JSValueConst this_val)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Request: not an Http server");
    if (JS_IsUndefined(s->handler))
        return JS_UNDEFINED;
    return JS_DupValue(ctx, s->handler);
}

static JSValue http_server_set_request(JSContext *ctx, JSValueConst this_val, JSValueConst v)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Request: not an Http server");
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        JS_FreeValue(ctx, s->handler);
        s->handler = JS_UNDEFINED;
        return JS_UNDEFINED;
    }
    if (!JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "Request must be a function");
    JS_FreeValue(ctx, s->handler);
    s->handler = JS_DupValue(ctx, v);
    return JS_UNDEFINED;
}

static JSValue http_server_start(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    HttpServerData *s = http_server_data(this_val);
    GError         *err = NULL;
    bool            ok;

    if (!s)
        return JS_ThrowTypeError(ctx, "Start: not an Http server");
    if (s->running)
        return JS_ThrowTypeError(ctx, "Http.Server.Start: already running");
    if (!JS_IsFunction(ctx, s->handler))
        return JS_ThrowTypeError(ctx,
            "Http.Server.Start: Request is required: a server with nothing to answer with");
    if (s->server_name && s->server_name[0])
        s->server = soup_server_new("server-header", s->server_name, NULL);
    else
        s->server = soup_server_new(NULL, NULL);
    if (!s->server)
        return JS_ThrowInternalError(ctx, "Http.Server.Start: cannot make a server");
    if (s->tls_cert) {
        GTlsCertificate *cert =
            g_tls_certificate_new_from_files(s->tls_cert, s->tls_key, &err);

        if (!cert) {
            char *detail = g_strdup_printf("Http.Server.Start: cannot read a certificate: %s",
                                           err ? err->message : "unknown error");

            g_clear_error(&err);
            g_object_unref(s->server);
            s->server = NULL;
            JSValue e = JS_ThrowInternalError(ctx, "%s", detail);

            g_free(detail);
            return e;
        }
        soup_server_set_tls_certificate(s->server, cert);
        g_object_unref(cert);
    }
    SoupServerListenOptions flags = s->tls_cert ? SOUP_SERVER_LISTEN_HTTPS : 0;

    if (s->local)
        ok = soup_server_listen_local(s->server, (guint)s->port, flags, &err);
    else
        ok = soup_server_listen_all(s->server, (guint)s->port, flags, &err);
    if (!ok) {
        char *detail = g_strdup_printf("Http.Server.Start: cannot listen on %d: %s",
                                       s->port, err ? err->message : "unknown error");

        g_clear_error(&err);
        g_object_unref(s->server);
        s->server = NULL;
        JSValue e = JS_ThrowInternalError(ctx, "%s", detail);

        g_free(detail);
        return e;
    }
    soup_server_add_handler(s->server, "/", on_server_request, s, NULL);
    s->running = true;
    http_server_apply_auth(s);

    GSList *uris = soup_server_get_uris(s->server);

    if (uris && uris->data) {
        GUri *uri = uris->data;

        if (g_uri_get_port(uri) > 0)
            s->port = g_uri_get_port(uri);
        g_free(s->url);
        s->url = g_uri_to_string(uri);
    }
    if (uris)
        g_slist_free_full(uris, (GDestroyNotify)g_uri_unref);
    return JS_UNDEFINED;
}

static JSValue http_server_stop(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    HttpServerData *s = http_server_data(this_val);

    if (!s)
        return JS_ThrowTypeError(ctx, "Stop: not an Http server");
    if (!s->running)
        return JS_FALSE;
    s->running = false;
    http_server_apply_auth(s);
    soup_server_disconnect(s->server);
    g_object_unref(s->server);
    s->server = NULL;
    /* Empty again, as before the first Start: a URL nothing is listening on
     * is the answer to a question nobody asked. */
    g_free(s->url);
    s->url = NULL;
    return JS_TRUE;
}

static const JSCFunctionListEntry http_server_props[] = {
    JS_CGETSET_DEF("Request",    http_server_get_request, http_server_set_request),
    JS_CGETSET_DEF("Port",       http_server_get_port, http_server_set_port),
    JS_CGETSET_DEF("Host",       http_server_get_host, http_server_set_host),
    JS_CGETSET_DEF("ServerName", http_server_get_name, http_server_set_name),
    JS_CGETSET_DEF("Tls",        http_server_get_tls, http_server_set_tls),
    JS_CGETSET_DEF("Allow",      http_server_get_allow, http_server_set_allow),
    JS_CGETSET_DEF("Auth",       http_server_get_auth, http_server_set_auth),
    JS_CGETSET_DEF("Running",    http_server_get_running, NULL),
    JS_CGETSET_DEF("Url",        http_server_get_url, NULL),
    JS_CFUNC_DEF("Start", 0, http_server_start),
    JS_CFUNC_DEF("Stop",  0, http_server_stop),
};

static JSValue js_http_server(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    JSValueConst opts = JS_UNDEFINED;
    JSValue proto;
    JSValue obj;
    HttpServerData *s;

    /* A bare port reads as "no options given" and listens on 8080: the same
     * trap as the client's, and worth naming rather than guessing. */
    if (argc > 0 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
        if (!JS_IsObject(argv[0]) || JS_IsArray(argv[0]) || JS_IsFunction(ctx, argv[0]))
            return JS_ThrowTypeError(ctx,
                "Http.Server([options]): the options are an object -- "
                "a port goes in one, as { Port: 8080 }");
        opts = argv[0];
    }
    proto = JS_GetClassProto(ctx, http_server_class_id);
    obj = JS_NewObjectProtoClass(ctx, proto, http_server_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;
    s = g_new0(HttpServerData, 1);
    s->ctx = ctx;
    s->handler = JS_UNDEFINED;
    s->port = 8080;
    s->local = true;
    JS_SetOpaque(obj, s);
    http_servers = g_list_prepend(http_servers, s);

    if (JS_IsObject(opts)) {
        JSValue pv = JS_GetPropertyStr(ctx, opts, "Port");

        if (!JS_IsUndefined(pv) && !JS_IsNull(pv)) {
            int32_t n = 0;

            if (!bta_to_int(ctx, pv, "Port", &n)) {
                JS_FreeValue(ctx, pv);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
            if (n < 0 || n > 65535) {
                JS_FreeValue(ctx, pv);
                JS_FreeValue(ctx, obj);
                return JS_ThrowRangeError(ctx, "Http.Server: Port %d is not a port", n);
            }
            s->port = n;
        }
        JS_FreeValue(ctx, pv);

        JSValue hv = JS_GetPropertyStr(ctx, opts, "Host");

        if (!JS_IsUndefined(hv) && !JS_IsNull(hv)) {
            const char *h = JS_ToCString(ctx, hv);
            bool        ok = h && (!strcmp(h, "local") || !strcmp(h, "any"));

            if (ok)
                s->local = !strcmp(h, "local");
            if (h)
                JS_FreeCString(ctx, h);
            if (!ok) {
                JS_FreeValue(ctx, hv);
                JS_FreeValue(ctx, obj);
                return JS_ThrowTypeError(ctx, "Http.Server: Host must be \"local\" or \"any\"");
            }
        }
        JS_FreeValue(ctx, hv);

        if (!http_text_opt(ctx, opts, "ServerName", &s->server_name)) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }

        JSValue tv = JS_GetPropertyStr(ctx, opts, "Tls");

        if (!JS_IsUndefined(tv) && !JS_IsNull(tv)) {
            if (!http_server_parse_tls(ctx, tv, "Http.Server", &s->tls_cert, &s->tls_key)) {
                JS_FreeValue(ctx, tv);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
        }
        JS_FreeValue(ctx, tv);

        JSValue av = JS_GetPropertyStr(ctx, opts, "Allow");

        if (!JS_IsUndefined(av) && !JS_IsNull(av)) {
            if (!http_server_parse_allow(ctx, av, "Http.Server", &s->allow)) {
                JS_FreeValue(ctx, av);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
        }
        JS_FreeValue(ctx, av);

        JSValue au = JS_GetPropertyStr(ctx, opts, "Auth");

        if (!JS_IsUndefined(au) && !JS_IsNull(au)) {
            if (!http_server_parse_auth(ctx, au, "Http.Server",
                                        &s->auth_realm, &s->auth_users)) {
                JS_FreeValue(ctx, au);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
        }
        JS_FreeValue(ctx, au);
    }
    return obj;
}

static const JSClassDef client_def = {
    "HttpClient",
    .finalizer = http_client_finalizer,
    .gc_mark   = http_client_gc_mark,
};

static const JSClassDef server_def = {
    "HttpServer",
    .finalizer = http_server_finalizer,
    .gc_mark   = http_server_gc_mark,
};

static const JSClassDef request_def = {
    "HttpServerRequest",
    .finalizer = http_req_finalizer,
};

void bta_http_init(JSContext *ctx, JSValue global)
{
    JS_NewClassID(JS_GetRuntime(ctx), &http_client_class_id);
    JS_NewClass(JS_GetRuntime(ctx), http_client_class_id, &client_def);

    JSValue proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, proto, http_client_props, G_N_ELEMENTS(http_client_props));
    JS_SetClassProto(ctx, http_client_class_id, proto);

    JS_NewClassID(JS_GetRuntime(ctx), &http_server_class_id);
    JS_NewClass(JS_GetRuntime(ctx), http_server_class_id, &server_def);

    JSValue sproto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, sproto, http_server_props, G_N_ELEMENTS(http_server_props));
    JS_SetClassProto(ctx, http_server_class_id, sproto);

    JS_NewClassID(JS_GetRuntime(ctx), &http_request_class_id);
    JS_NewClass(JS_GetRuntime(ctx), http_request_class_id, &request_def);

    JSValue rproto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, rproto, http_request_props, G_N_ELEMENTS(http_request_props));
    JS_SetClassProto(ctx, http_request_class_id, rproto);

    if (!http_default_session)
        http_default_session = soup_session_new();
    if (!http_default_sync_session)
        http_default_sync_session = soup_session_new();

    http_multipart_init(ctx, global);

    JSValue http = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, http, http_props, G_N_ELEMENTS(http_props));
    JS_SetPropertyStr(ctx, global, "Http", http);
}

guint bta_http_pending(void)
{
    guint n = g_list_length(http_jobs);

    for (GList *l = http_servers; l; l = l->next) {
        if (((HttpServerData *)l->data)->running)
            n++;
    }
    return n;
}

void bta_http_cleanup(void)
{
    while (http_jobs) {
        HttpJob *job = http_jobs->data;

        g_cancellable_cancel(job->cancellable);
        http_job_free(job);
    }
    /* A client needs nothing here: its defaults object is reported to the
     * collector and freed by the finalizer against the runtime, so the
     * ordinary teardown frees it. A listening server does, because a port
     * held past the program is not the collector's problem. */
    for (GList *l = http_servers; l; l = l->next) {
        HttpServerData *s = l->data;

        if (s->running && s->server) {
            if (s->auth_domain) {
                soup_server_remove_auth_domain(s->server, s->auth_domain);
                s->auth_domain = NULL;
            }
            soup_server_disconnect(s->server);
            g_object_unref(s->server);
            s->server = NULL;
            s->running = false;
        }
    }
    g_clear_object(&http_default_session);
    g_clear_object(&http_default_sync_session);
}

#else /* no libsoup at build time */

/* No tables here: tests/api/Check.js reads them out of the branch above, and
 * tables nothing registers would only warn. The surface it checks is the same
 * either way, since every verb below keeps its name. */
static JSValue http_missing(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    return JS_ThrowInternalError(ctx,
        "this runtime was built without libsoup, so there is no HTTP client. "
        "Install libsoup3's development package and build again -- CMake "
        "finds it with pkg-config and prints which it found");
}

/* Same refusal through `new`: a constructor is a different call shape, not a
 * different answer. */
static JSValue http_missing_construct(JSContext *ctx, JSValueConst new_target,
                                      int argc, JSValueConst *argv)
{
    return http_missing(ctx, JS_UNDEFINED, argc, argv);
}

/* Every name the built branch registers, so a project written against a
 * runtime with libsoup fails where it calls rather than where it looks --
 * `tests/api/Check.js` reads the real tables out of that branch, and a table
 * here would only be a second list to keep in step. */
static const struct { const char *name; int arity; } http_missing_names[] = {
    { "Client",      1 }, { "Server",      1 },
    { "Request",     5 }, { "Get",         4 }, { "Post",        5 },
    { "Put",         5 }, { "Patch",       5 }, { "Delete",      4 },
    { "Head",        4 }, { "Stream",      6 },
    { "RequestWait", 4 }, { "GetWait",     2 }, { "PostWait",    3 },
    { "PutWait",     3 }, { "PatchWait",   3 }, { "DeleteWait",  2 },
    { "HeadWait",    2 },
};

void bta_http_init(JSContext *ctx, JSValue global)
{
    JSValue http = JS_NewObject(ctx);

    for (unsigned i = 0; i < G_N_ELEMENTS(http_missing_names); i++) {
        JS_SetPropertyStr(ctx, http, http_missing_names[i].name,
                          JS_NewCFunction(ctx, http_missing,
                                          http_missing_names[i].name,
                                          http_missing_names[i].arity));
    }
    JS_SetPropertyStr(ctx, global, "Http", http);

    JS_SetPropertyStr(ctx, global, "Multipart",
                      JS_NewCFunction2(ctx, http_missing_construct, "Multipart", 0,
                                       JS_CFUNC_constructor, 0));
}

guint bta_http_pending(void)
{
    return 0;
}

void bta_http_cleanup(void)
{
}

#endif
