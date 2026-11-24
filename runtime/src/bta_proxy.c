/*
 * The proxy an `Http` request goes through when the program did not name one.
 *
 * **One resolver for every session that asks the system**: `Http.Get` and the
 * other shorthands, every `Http.Client` whose `Proxy` is `"default"`, the
 * blocking calls of a `Task`, and a `WebSocket`. Two things it does that GIO's
 * default resolver did not:
 *
 * - **The machine's own addresses are always direct**, on every platform:
 *   `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`. No proxy serves the
 *   machine it runs on, and asking cost the walkthrough's local API its first
 *   three seconds.
 *
 * - **On Windows the answer is Windows'.** MSYS2's GIO ships two proxy
 *   modules, `libproxy` and `gnome`, and both run WPAD discovery of their own
 *   when *Automatically detect settings* is on -- Windows' default -- which on
 *   a network without a `wpad` server is a lookup that waits to time out:
 *   2.4 to 3 s before the first request of every process, measured
 *   2026-11-24 (glib-networking 2.90.1, libproxy 0.5.12). Windows answers the
 *   same question from its own cache, through WinHTTP, which is what browsers
 *   and .NET ask. So here: the `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and
 *   `NO_PROXY` variables first (libproxy honoured them, and curl and Python do
 *   on Windows), then the user's settings -- a fixed proxy with its bypass
 *   list, or a configuration script and automatic detection, which WinHTTP
 *   evaluates -- and otherwise direct. `docs/issues/UPSTREAM-windows-proxy-wpad.md`
 *   is the upstream half.
 *
 * Elsewhere every other address goes to GIO's default resolver, as before.
 * The lookup runs on a worker thread: WinHTTP may block on the network, and
 * libsoup asks from the main loop.
 */
#include "bta.h"

#include <string.h>

#ifdef G_OS_WIN32
#include <windows.h>
#include <winhttp.h>
#endif

#define BTA_TYPE_PROXY_RESOLVER (bta_proxy_resolver_get_type())
G_DECLARE_FINAL_TYPE(BtaProxyResolver, bta_proxy_resolver, BTA, PROXY_RESOLVER, GObject)

struct _BtaProxyResolver {
    GObject         parent;
    GProxyResolver *fallback;   /* GIO's default, for what is not ours to answer */
};

static void bta_proxy_resolver_iface_init(GProxyResolverInterface *iface);

G_DEFINE_TYPE_WITH_CODE(BtaProxyResolver, bta_proxy_resolver, G_TYPE_OBJECT,
                        G_IMPLEMENT_INTERFACE(G_TYPE_PROXY_RESOLVER,
                                              bta_proxy_resolver_iface_init))

static void bta_proxy_resolver_finalize(GObject *object)
{
    BtaProxyResolver *self = BTA_PROXY_RESOLVER(object);

    g_clear_object(&self->fallback);
    G_OBJECT_CLASS(bta_proxy_resolver_parent_class)->finalize(object);
}

static void bta_proxy_resolver_class_init(BtaProxyResolverClass *klass)
{
    G_OBJECT_CLASS(klass)->finalize = bta_proxy_resolver_finalize;
}

static void bta_proxy_resolver_init(BtaProxyResolver *self)
{
    GProxyResolver *def = g_proxy_resolver_get_default();

    self->fallback = def ? g_object_ref(def) : NULL;
}

/* ----------------------------------------------------------- the answers */

static gchar **proxy_answer(const char *proxy)
{
    gchar **out = g_new0(gchar *, 2);

    out[0] = g_strdup(proxy ? proxy : "direct://");
    return out;
}

/*
 * Whether a host is this machine: a name `localhost` answers for, or a
 * loopback address. `GUri` hands an IPv6 literal back without its brackets,
 * and a hand-written URL may still carry them.
 */
static bool bta_proxy_host_is_local(const char *host)
{
    if (!host || !*host)
        return false;

    char *h   = g_ascii_strdown(host, -1);
    size_t n  = strlen(h);
    bool local = false;

    if (n >= 2 && h[0] == '[' && h[n - 1] == ']') {
        memmove(h, h + 1, n - 2);
        h[n - 2] = '\0';
    }
    if (!strcmp(h, "localhost") || g_str_has_suffix(h, ".localhost")) {
        local = true;
    } else {
        GInetAddress *addr = g_inet_address_new_from_string(h);

        if (addr) {
            local = g_inet_address_get_is_loopback(addr);
            g_object_unref(addr);
        }
    }
    g_free(h);
    return local;
}

#ifdef G_OS_WIN32

/* --------------------------------------------- Windows: the environment */

/* A proxy written without a scheme is an HTTP one, as curl reads it. */
static char *proxy_with_scheme(const char *value)
{
    if (strstr(value, "://"))
        return g_strdup(value);
    return g_strconcat("http://", value, NULL);
}

static const char *env_first(const char *const *names)
{
    for (; *names; names++) {
        const char *v = g_getenv(*names);

        if (v && *v)
            return v;
    }
    return NULL;
}

/*
 * `NO_PROXY`: names separated by commas (or spaces), each one a host or a
 * domain -- `example.com` and `.example.com` both cover `api.example.com` --
 * and `*` alone covers everything. The spelling curl settled on.
 */
static bool env_no_proxy(const char *host)
{
    static const char *const names[] = { "NO_PROXY", "no_proxy", NULL };
    const char *list = env_first(names);

    if (!list || !host)
        return false;

    char  *h     = g_ascii_strdown(host, -1);
    char **parts = g_strsplit_set(list, ", \t", -1);
    bool   hit   = false;

    for (char **p = parts; *p && !hit; p++) {
        char *e = g_ascii_strdown(g_strstrip(*p), -1);
        const char *d = e;

        if (!strcmp(d, "*"))
            hit = true;
        else {
            if (g_str_has_prefix(d, "*."))
                d += 2;
            else if (*d == '.')
                d += 1;
            if (*d) {
                size_t hl = strlen(h), dl = strlen(d);

                hit = !strcmp(h, d) ||
                      (hl > dl && h[hl - dl - 1] == '.' && !strcmp(h + hl - dl, d));
            }
        }
        g_free(e);
    }
    g_strfreev(parts);
    g_free(h);
    return hit;
}

/* The variable for this scheme, or NULL when the environment says nothing. */
static char *env_proxy(const char *scheme)
{
    static const char *const https[] = { "HTTPS_PROXY", "https_proxy", NULL };
    static const char *const http[]  = { "HTTP_PROXY", "http_proxy", NULL };
    static const char *const all[]   = { "ALL_PROXY", "all_proxy", NULL };
    const char *v = NULL;

    if (!g_ascii_strcasecmp(scheme, "https") || !g_ascii_strcasecmp(scheme, "wss"))
        v = env_first(https);
    else if (!g_ascii_strcasecmp(scheme, "http") || !g_ascii_strcasecmp(scheme, "ws"))
        v = env_first(http);
    if (!v)
        v = env_first(all);
    return v ? proxy_with_scheme(v) : NULL;
}

/* ------------------------------------------- Windows: the user's settings */

static char *utf8_of(const wchar_t *w)
{
    return w ? g_utf16_to_utf8((const gunichar2 *)w, -1, NULL, NULL, NULL) : NULL;
}

/*
 * A Windows proxy list, as the settings and WinHTTP write it: entries
 * separated by `;` or spaces, each `host:port` (every scheme) or
 * `scheme=host:port` (that scheme only). A `ws`/`wss` request is the
 * `http`/`https` one; `socks=` serves a scheme with no entry of its own.
 * NULL when the list names nothing for this scheme -- which Windows reads as
 * direct.
 */
static char *bta_proxy_pick(const char *list, const char *scheme)
{
    if (!list || !*list)
        return NULL;

    const char *want = (!g_ascii_strcasecmp(scheme, "wss") ||
                        !g_ascii_strcasecmp(scheme, "https")) ? "https" : "http";
    char **parts = g_strsplit_set(list, "; \t", -1);
    char  *plain = NULL, *mine = NULL, *socks = NULL;

    for (char **p = parts; *p; p++) {
        char *e  = *p;
        char *eq = strchr(e, '=');

        if (!*e)
            continue;
        if (!eq) {
            if (!plain)
                plain = proxy_with_scheme(e);
            continue;
        }
        *eq = '\0';
        if (!g_ascii_strcasecmp(e, want) && !mine && eq[1])
            mine = proxy_with_scheme(eq + 1);
        else if (!g_ascii_strcasecmp(e, "socks") && !socks && eq[1])
            socks = g_strconcat("socks://", eq + 1, NULL);
    }
    g_strfreev(parts);

    char *out = mine ? mine : plain ? plain : socks;
    if (out != mine)  g_free(mine);
    if (out != plain) g_free(plain);
    if (out != socks) g_free(socks);
    return out;
}

/*
 * A Windows bypass list: entries separated by `;` or spaces, each a host
 * pattern with `*` wildcards (`*.corp.example`, `10.*`), and `<local>`, which
 * is every name without a dot in it.
 */
static bool bta_proxy_bypassed(const char *list, const char *host)
{
    if (!list || !*list || !host || !*host)
        return false;

    char  *h     = g_ascii_strdown(host, -1);
    char **parts = g_strsplit_set(list, "; \t", -1);
    bool   hit   = false;

    for (char **p = parts; *p && !hit; p++) {
        char *e = g_ascii_strdown(*p, -1);

        if (!*e) {
            /* nothing */
        } else if (!strcmp(e, "<local>")) {
            hit = strchr(h, '.') == NULL && strchr(h, ':') == NULL;
        } else {
            /* A pattern may carry a scheme or a port the host does not. */
            const char *pat = strstr(e, "://") ? strstr(e, "://") + 3 : e;
            char *colon = strrchr((char *)pat, ':');

            if (colon && !strchr(pat, ']') && strchr(pat, ':') == colon)
                *colon = '\0';
            hit = g_pattern_match_simple(pat, h);
        }
        g_free(e);
    }
    g_strfreev(parts);
    g_free(h);
    return hit;
}

/* One WinHTTP session for the process, opened on the first question. */
static HINTERNET win_session(void)
{
    static gsize     once = 0;
    static HINTERNET session = NULL;

    if (g_once_init_enter(&once)) {
        session = WinHttpOpen(L"Bintana", WINHTTP_ACCESS_TYPE_NO_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        g_once_init_leave(&once, 1);
    }
    return session;
}

/*
 * A configuration script or automatic detection, evaluated by WinHTTP --
 * which asks the WinHTTP Auto-Proxy service first, and that service keeps
 * what detection found. TRUE with `*out` set when it answered (NULL is
 * direct); FALSE when it could not, and the fixed settings decide.
 */
static bool win_auto(const char *uri, const char *scheme, const char *host,
                     const WINHTTP_CURRENT_USER_IE_PROXY_CONFIG *ie, char **out)
{
    HINTERNET session = win_session();
    if (!session)
        return false;

    WINHTTP_AUTOPROXY_OPTIONS opts;
    memset(&opts, 0, sizeof opts);
    if (ie->fAutoDetect) {
        opts.dwFlags          |= WINHTTP_AUTOPROXY_AUTO_DETECT;
        opts.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP |
                                 WINHTTP_AUTO_DETECT_TYPE_DNS_A;
    }
    if (ie->lpszAutoConfigUrl) {
        opts.dwFlags          |= WINHTTP_AUTOPROXY_CONFIG_URL;
        opts.lpszAutoConfigUrl = ie->lpszAutoConfigUrl;
    }
    opts.fAutoLogonIfChallenged = TRUE;

    gunichar2 *wuri = g_utf8_to_utf16(uri, -1, NULL, NULL, NULL);
    if (!wuri)
        return false;

    WINHTTP_PROXY_INFO info;
    memset(&info, 0, sizeof info);
    BOOL ok = WinHttpGetProxyForUrl(session, (LPCWSTR)wuri, &opts, &info);
    g_free(wuri);
    if (!ok)
        return false;

    *out = NULL;
    if (info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY && info.lpszProxy) {
        char *list   = utf8_of(info.lpszProxy);
        char *bypass = utf8_of(info.lpszProxyBypass);

        if (!bta_proxy_bypassed(bypass, host))
            *out = bta_proxy_pick(list, scheme);
        g_free(list);
        g_free(bypass);
    }
    if (info.lpszProxy)
        GlobalFree(info.lpszProxy);
    if (info.lpszProxyBypass)
        GlobalFree(info.lpszProxyBypass);
    return true;
}

/* The answer on Windows for an address that is not this machine's. */
static gchar **win_lookup(const char *uri, const char *scheme, const char *host)
{
    char *proxy = NULL;

    if (env_no_proxy(host))
        return proxy_answer(NULL);
    proxy = env_proxy(scheme);
    if (proxy) {
        gchar **out = proxy_answer(proxy);
        g_free(proxy);
        return out;
    }

    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG ie;
    memset(&ie, 0, sizeof ie);
    if (!WinHttpGetIEProxyConfigForCurrentUser(&ie))
        return proxy_answer(NULL);

    bool answered = false;
    if (ie.fAutoDetect || ie.lpszAutoConfigUrl)
        answered = win_auto(uri, scheme, host, &ie, &proxy);

    if (!answered && ie.lpszProxy) {
        char *list   = utf8_of(ie.lpszProxy);
        char *bypass = utf8_of(ie.lpszProxyBypass);

        if (!bta_proxy_bypassed(bypass, host))
            proxy = bta_proxy_pick(list, scheme);
        g_free(list);
        g_free(bypass);
    }

    if (ie.lpszAutoConfigUrl)
        GlobalFree(ie.lpszAutoConfigUrl);
    if (ie.lpszProxy)
        GlobalFree(ie.lpszProxy);
    if (ie.lpszProxyBypass)
        GlobalFree(ie.lpszProxyBypass);

    gchar **out = proxy_answer(proxy);
    g_free(proxy);
    return out;
}

#endif /* G_OS_WIN32 */

/* ------------------------------------------------------------ the lookup */

/* NULL with `*mine` false: not ours to answer, ask the fallback. */
static gchar **proxy_lookup_here(const char *uri, bool *mine)
{
    GUri       *u      = g_uri_parse(uri, G_URI_FLAGS_NONE, NULL);
    const char *host   = u ? g_uri_get_host(u) : NULL;
    const char *scheme = u ? g_uri_get_scheme(u) : NULL;
    gchar     **out    = NULL;

    *mine = true;
    if (host && bta_proxy_host_is_local(host)) {
        out = proxy_answer(NULL);
    } else {
#ifdef G_OS_WIN32
        out = win_lookup(uri, scheme ? scheme : "http", host ? host : "");
#else
        (void)scheme;
        *mine = false;
#endif
    }
    if (u)
        g_uri_unref(u);
    return out;
}

static gboolean bta_proxy_is_supported(GProxyResolver *resolver)
{
    (void)resolver;
    return TRUE;
}

static gchar **bta_proxy_lookup(GProxyResolver *resolver, const gchar *uri,
                                GCancellable *cancellable, GError **error)
{
    BtaProxyResolver *self = BTA_PROXY_RESOLVER(resolver);
    bool              mine;
    gchar           **out = proxy_lookup_here(uri, &mine);

    if (mine)
        return out;
    if (self->fallback)
        return g_proxy_resolver_lookup(self->fallback, uri, cancellable, error);
    return proxy_answer(NULL);
}

#ifdef G_OS_WIN32
static void proxy_lookup_thread(GTask *task, gpointer source, gpointer data,
                                GCancellable *cancellable)
{
    GError *error = NULL;
    gchar **out   = bta_proxy_lookup(G_PROXY_RESOLVER(source), data, cancellable, &error);

    if (out)
        g_task_return_pointer(task, out, (GDestroyNotify)g_strfreev);
    else
        g_task_return_error(task, error);
}
#endif

static void bta_proxy_lookup_async(GProxyResolver *resolver, const gchar *uri,
                                   GCancellable *cancellable,
                                   GAsyncReadyCallback callback, gpointer user_data)
{
    BtaProxyResolver *self = BTA_PROXY_RESOLVER(resolver);

#ifndef G_OS_WIN32
    /* Elsewhere only the machine's own addresses are ours, and that answer
     * needs no thread; the rest is the fallback's own asynchronous lookup,
     * which `finish` hands back to it. */
    bool    mine;
    gchar **out = proxy_lookup_here(uri, &mine);

    if (!mine && self->fallback) {
        g_proxy_resolver_lookup_async(self->fallback, uri, cancellable, callback, user_data);
        return;
    }
    GTask *task = g_task_new(resolver, cancellable, callback, user_data);
    g_task_set_source_tag(task, bta_proxy_lookup_async);
    g_task_return_pointer(task, out ? out : proxy_answer(NULL), (GDestroyNotify)g_strfreev);
    g_object_unref(task);
#else
    (void)self;
    GTask *task = g_task_new(resolver, cancellable, callback, user_data);
    g_task_set_source_tag(task, bta_proxy_lookup_async);
    g_task_set_task_data(task, g_strdup(uri), g_free);
    g_task_run_in_thread(task, proxy_lookup_thread);
    g_object_unref(task);
#endif
}

static gchar **bta_proxy_lookup_finish(GProxyResolver *resolver, GAsyncResult *result,
                                       GError **error)
{
    BtaProxyResolver *self = BTA_PROXY_RESOLVER(resolver);

    if (g_task_is_valid(result, resolver))
        return g_task_propagate_pointer(G_TASK(result), error);
    return g_proxy_resolver_lookup_finish(self->fallback, result, error);
}

static void bta_proxy_resolver_iface_init(GProxyResolverInterface *iface)
{
    iface->is_supported  = bta_proxy_is_supported;
    iface->lookup        = bta_proxy_lookup;
    iface->lookup_async  = bta_proxy_lookup_async;
    iface->lookup_finish = bta_proxy_lookup_finish;
}

/*
 * The resolver every session that asks the system is given, shared by the
 * process and made on the first question. A new reference.
 */
GProxyResolver *bta_system_proxy_resolver(void)
{
    static gsize           once = 0;
    static GProxyResolver *shared = NULL;

    if (g_once_init_enter(&once)) {
        shared = G_PROXY_RESOLVER(g_object_new(BTA_TYPE_PROXY_RESOLVER, NULL));
        g_once_init_leave(&once, 1);
    }
    return g_object_ref(shared);
}
