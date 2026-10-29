/*
 * Network -- whether there is a network, whether it reaches the internet,
 * whether it is metered, and when that changed.
 *
 * The design is docs/plans/network-plan.md, and its stage 0 is the reason for
 * every rule below: on a network whose DNS was half broken, **every
 * GNetworkMonitor backend said FULL**, and only a per-host question said the
 * truth. So the global properties say only what the backend can know, and
 * `Reach` is the honest answer for one host.
 *
 * - **"Unknown" until the first answer.** The portal backend (inside a
 *   sandbox) starts at *unavailable, LOCAL* and fills itself asynchronously; a
 *   program reading `Online` in `Form_Open` would otherwise be told *offline*.
 * - **"Routed" instead of a FULL nobody checked.** netlink, the Win32 and base
 *   backends know only that a default route exists and answer FULL; so does
 *   NetworkManager when its connectivity check is off (`ConnectivityCheckEnabled`,
 *   read here from NM itself). A captive portal is visible only through NM
 *   with its check on.
 * - **"Local" only where it can be told from "None"**: NM's `State`
 *   (`CONNECTED_LOCAL`). GLib folds both into *unavailable*.
 * - Inside a sandbox the host decides: the portal's FULL is taken as it comes,
 *   since NM's own settings are not reachable from there.
 *
 * The monitor is made on first use, not at startup: `g_network_monitor_get_default`
 * asks NetworkManager over the system bus, and a program that never asks about
 * the network should not pay for it.
 */
#include "bta.h"

#include <gio/gio.h>
#include <string.h>

/* NetworkManager's NMState values this file reads. */
#define NM_STATE_CONNECTED_LOCAL 50

static GNetworkMonitor *net_monitor;
static GDBusProxy      *net_nm;          /* NetworkManager, when it is the backend */
static bool             net_answered;    /* the portal backend has spoken once */
static bool             net_portal;
static bool             net_sandbox_offline;
static JSContext       *net_ctx;
static JSValue          net_onchange = JS_UNDEFINED;
static guint            net_idle;
static char            *net_last;        /* the connectivity last reported */
static int              net_last_metered = -1;

/* --------------------------------------------------------------- the levels */

/* Whether a Flatpak was started without the network: GLib's own test
 * (`glib_network_available_in_sandbox`) is private, so the same file is read. */
static bool sandbox_without_network(void)
{
    GKeyFile *kf = g_key_file_new();
    bool      offline = false;

    if (g_key_file_load_from_file(kf, "/.flatpak-info", G_KEY_FILE_NONE, NULL)) {
        char **shared = g_key_file_get_string_list(kf, "Context", "shared", NULL, NULL);
        offline = true;
        for (int i = 0; shared && shared[i]; i++)
            if (g_str_equal(shared[i], "network"))
                offline = false;
        g_strfreev(shared);
    }
    g_key_file_unref(kf);
    return offline;
}

static int nm_uint(const char *name, int fallback)
{
    if (!net_nm)
        return fallback;
    GVariant *v = g_dbus_proxy_get_cached_property(net_nm, name);
    int       n = fallback;
    if (v && g_variant_is_of_type(v, G_VARIANT_TYPE_UINT32))
        n = (int)g_variant_get_uint32(v);
    else if (v && g_variant_is_of_type(v, G_VARIANT_TYPE_BOOLEAN))
        n = g_variant_get_boolean(v);
    if (v)
        g_variant_unref(v);
    return n;
}

/* The level, as one of the seven words. Static strings: nothing to free. */
static const char *net_connectivity(void)
{
    if (net_sandbox_offline)
        return "None";
    if (net_portal && !net_answered)
        return "Unknown";

    bool avail = g_network_monitor_get_network_available(net_monitor);
    if (!avail)
        return nm_uint("State", 0) == NM_STATE_CONNECTED_LOCAL ? "Local" : "None";

    switch (g_network_monitor_get_connectivity(net_monitor)) {
    case G_NETWORK_CONNECTIVITY_LIMITED: return "Limited";
    case G_NETWORK_CONNECTIVITY_PORTAL:  return "Portal";
    case G_NETWORK_CONNECTIVITY_LOCAL:   return "Routed";  /* NM's UNKNOWN with a route */
    case G_NETWORK_CONNECTIVITY_FULL:
        if (net_portal)
            return "Full";
        if (net_nm)
            return nm_uint("ConnectivityCheckEnabled", 0) ? "Full" : "Routed";
        return "Routed";
    }
    return "Unknown";
}

/* ---------------------------------------------------------------- the event */

static gboolean net_report(gpointer data)
{
    net_idle = 0;
    if (!net_ctx)
        return G_SOURCE_REMOVE;

    const char *now     = net_connectivity();
    int         metered = g_network_monitor_get_network_metered(net_monitor);

    if (net_last && g_str_equal(net_last, now) && metered == net_last_metered)
        return G_SOURCE_REMOVE;
    g_free(net_last);
    net_last         = g_strdup(now);
    net_last_metered = metered;

    if (!JS_IsFunction(net_ctx, net_onchange))
        return G_SOURCE_REMOVE;

    /* Held across its own call: the handler may assign another one. */
    JSValue fn = JS_DupValue(net_ctx, net_onchange);
    JSValue r  = JS_Call(net_ctx, fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(r))
        bta_dump_error(net_ctx);
    JS_FreeValue(net_ctx, r);
    JS_FreeValue(net_ctx, fn);
    bta_drain_jobs(JS_GetRuntime(net_ctx));
    return G_SOURCE_REMOVE;
}

/* Every road a change arrives by comes here, and they arrive in bursts -- a
 * network coming up is several notifies -- so the report is one idle later
 * and says something only when the answer moved. */
static void net_changed(void)
{
    net_answered = true;
    if (!net_idle)
        net_idle = g_idle_add(net_report, NULL);
}

static void on_net_notify(GObject *o, GParamSpec *p, gpointer d)          { net_changed(); }
static void on_net_changed(GNetworkMonitor *m, gboolean a, gpointer d)     { net_changed(); }
static void on_nm_props(GDBusProxy *p, GVariant *c, GStrv i, gpointer d)   { net_changed(); }

static GNetworkMonitor *net_ensure(void)
{
    if (net_monitor)
        return net_monitor;

    net_monitor = g_object_ref(g_network_monitor_get_default());
    const char *type = G_OBJECT_TYPE_NAME(net_monitor);
    net_portal = g_str_equal(type, "GNetworkMonitorPortal");
    net_sandbox_offline = net_portal && sandbox_without_network();

    g_signal_connect(net_monitor, "network-changed", G_CALLBACK(on_net_changed), NULL);
    g_signal_connect(net_monitor, "notify::connectivity", G_CALLBACK(on_net_notify), NULL);
    g_signal_connect(net_monitor, "notify::network-metered", G_CALLBACK(on_net_notify), NULL);

    /* NetworkManager's own word on whether FULL was checked, and on the one
     * level GLib folds away. Only when NM is the backend: under netlink there
     * is no NM to ask, and in a sandbox it is not reachable. */
    if (g_str_equal(type, "GNetworkMonitorNM")) {
        net_nm = g_dbus_proxy_new_for_bus_sync(G_BUS_TYPE_SYSTEM,
                                               G_DBUS_PROXY_FLAGS_DO_NOT_AUTO_START,
                                               NULL, "org.freedesktop.NetworkManager",
                                               "/org/freedesktop/NetworkManager",
                                               "org.freedesktop.NetworkManager",
                                               NULL, NULL);
        if (net_nm)
            g_signal_connect(net_nm, "g-properties-changed", G_CALLBACK(on_nm_props), NULL);
    }

    net_last         = g_strdup(net_connectivity());
    net_last_metered = g_network_monitor_get_network_metered(net_monitor);
    return net_monitor;
}

static JSValue net_get_connectivity(JSContext *ctx, JSValueConst this_val)
{
    net_ensure();
    return JS_NewString(ctx, net_connectivity());
}

static JSValue net_get_online(JSContext *ctx, JSValueConst this_val)
{
    net_ensure();
    return JS_NewBool(ctx, g_str_equal(net_connectivity(), "Full"));
}

static JSValue net_get_metered(JSContext *ctx, JSValueConst this_val)
{
    net_ensure();
    return JS_NewBool(ctx, g_network_monitor_get_network_metered(net_monitor));
}

static JSValue net_get_onchange(JSContext *ctx, JSValueConst this_val)
{
    return JS_DupValue(ctx, net_onchange);
}

static JSValue net_set_onchange(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    if (!JS_IsNull(val) && !JS_IsUndefined(val) && !JS_IsFunction(ctx, val))
        return JS_ThrowTypeError(ctx, "Network.OnChange: expected a function, or null");
    net_ensure();
    JS_FreeValue(ctx, net_onchange);
    net_onchange = JS_IsFunction(ctx, val) ? JS_DupValue(ctx, val) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

/* -------------------------------------------------------------------- Reach */

/* One question in flight. The callback is a strong reference the collector
 * cannot see, so every exit frees it: the answer, the timeout, teardown. */
typedef struct {
    JSContext    *ctx;
    JSValue       cb;
    GCancellable *cancel;
    guint         timer;
    bool          timed_out;
} ReachJob;

static GList *reach_jobs;

static void reach_free(ReachJob *job)
{
    reach_jobs = g_list_remove(reach_jobs, job);
    if (job->timer)
        g_source_remove(job->timer);
    JS_FreeValue(job->ctx, job->cb);
    g_clear_object(&job->cancel);
    g_free(job);
}

/* The error as a word a program can branch on -- never GLib's message, which
 * is translated. */
static const char *reach_why(const GError *err, bool timed_out)
{
    if (timed_out)
        return "Timeout";
    if (!err)
        return "Unreachable";
    if (err->domain == G_RESOLVER_ERROR)
        return "NotFound";
    if (err->domain == G_IO_ERROR) {
        switch (err->code) {
        case G_IO_ERROR_CONNECTION_REFUSED:  return "Refused";
        case G_IO_ERROR_TIMED_OUT:           return "Timeout";
        case G_IO_ERROR_NETWORK_UNREACHABLE:
        case G_IO_ERROR_HOST_UNREACHABLE:    return "Unreachable";
        case G_IO_ERROR_PERMISSION_DENIED:   return "NotAllowed";
        case G_IO_ERROR_CANCELLED:           return "Timeout";
        default: break;
        }
    }
    if (g_dbus_error_is_remote_error(err)) {
        char *name = g_dbus_error_get_remote_error(err);
        bool  denied = name && strstr(name, "NotAllowed");
        g_free(name);
        if (denied)
            return "NotAllowed";
    }
    return "Error";
}

static void reach_answer(ReachJob *job, bool ok, const GError *err)
{
    JSContext *ctx = job->ctx;
    JSValue    argv[2] = { JS_NewBool(ctx, ok),
                           JS_NewString(ctx, ok ? "" : reach_why(err, job->timed_out)) };
    JSValue    r = JS_Call(ctx, job->cb, JS_UNDEFINED, 2, argv);

    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
    bta_drain_jobs(JS_GetRuntime(ctx));
    reach_free(job);
}

static gboolean on_reach_timeout(gpointer data)
{
    ReachJob *job = data;
    job->timer     = 0;
    job->timed_out = true;
    g_cancellable_cancel(job->cancel);   /* the completion answers */
    return G_SOURCE_REMOVE;
}

static void on_reach_connected(GObject *src, GAsyncResult *res, gpointer data)
{
    ReachJob          *job  = data;
    GError            *err  = NULL;
    GSocketConnection *conn = g_socket_client_connect_to_host_finish(G_SOCKET_CLIENT(src),
                                                                     res, &err);
    if (conn) {
        g_io_stream_close(G_IO_STREAM(conn), NULL, NULL);
        g_object_unref(conn);
    }
    /* Teardown dropped it; the pointer is only compared. */
    if (g_list_find(reach_jobs, job))
        reach_answer(job, conn != NULL, err);
    g_clear_error(&err);
}

static void on_reach_portal(GObject *src, GAsyncResult *res, gpointer data)
{
    ReachJob *job = data;
    GError   *err = NULL;
    gboolean  ok  = g_network_monitor_can_reach_finish(G_NETWORK_MONITOR(src), res, &err);

    if (g_list_find(reach_jobs, job))
        reach_answer(job, ok, err);
    g_clear_error(&err);
}

static JSValue net_reach(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    if (argc < 3 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Network.Reach(host, port, callback, [options]): host is a name or an address");

    int32_t port = 0;
    if (!bta_to_int(ctx, argv[1], "Network.Reach", &port))
        return JS_EXCEPTION;
    if (port < 1 || port > 65535)
        return JS_ThrowRangeError(ctx, "Network.Reach: port is 1 to 65535, got %d", port);
    if (!JS_IsFunction(ctx, argv[2]))
        return JS_ThrowTypeError(ctx, "Network.Reach(host, port, callback): callback is a function");

    int32_t timeout = 5000;
    if (argc > 3 && !JS_IsUndefined(argv[3])) {
        if (!JS_IsObject(argv[3]))
            return JS_ThrowTypeError(ctx, "Network.Reach: options is an object, { Timeout }");
        JSPropertyEnum *props = NULL;
        uint32_t        n = 0;
        if (JS_GetOwnPropertyNames(ctx, &props, &n, argv[3], JS_GPN_STRING_MASK) < 0)
            return JS_EXCEPTION;
        bool bad = false;
        for (uint32_t i = 0; i < n && !bad; i++) {
            const char *k = JS_AtomToCString(ctx, props[i].atom);
            bad = !k || strcmp(k, "Timeout") != 0;
            if (bad && k)
                JS_ThrowTypeError(ctx, "Network.Reach: no option called '%s'; the one there is is Timeout", k);
            JS_FreeCString(ctx, k);
        }
        JS_FreePropertyEnum(ctx, props, n);
        if (bad)
            return JS_EXCEPTION;
        JSValue t = JS_GetPropertyStr(ctx, argv[3], "Timeout");
        bool    ok = JS_IsUndefined(t) || bta_to_int(ctx, t, "Network.Reach Timeout", &timeout);
        JS_FreeValue(ctx, t);
        if (!ok)
            return JS_EXCEPTION;
        if (timeout < 1)
            return JS_ThrowRangeError(ctx, "Network.Reach: Timeout is milliseconds, 1 or more");
    }

    const char *host = JS_ToCString(ctx, argv[0]);
    if (!host)
        return JS_EXCEPTION;
    if (!*host) {
        JS_FreeCString(ctx, host);
        return JS_ThrowTypeError(ctx, "Network.Reach: host is empty");
    }

    ReachJob *job = g_new0(ReachJob, 1);
    job->ctx    = ctx;
    job->cb     = JS_DupValue(ctx, argv[2]);
    job->cancel = g_cancellable_new();
    job->timer  = g_timeout_add(timeout, on_reach_timeout, job);
    reach_jobs  = g_list_prepend(reach_jobs, job);

    /* Inside a sandbox the portal answers -- it is the one road out that asks
     * about a host, and a plain connection may not be allowed. Elsewhere a real
     * connection, closed at once: a route lookup said yes to a host whose name
     * did not resolve. */
    net_ensure();
    if (net_portal) {
        GSocketConnectable *addr = g_network_address_new(host, (guint16)port);
        g_network_monitor_can_reach_async(net_monitor, addr, job->cancel, on_reach_portal, job);
        g_object_unref(addr);
    } else {
        GSocketClient *client = g_socket_client_new();
        g_socket_client_set_timeout(client, (guint)((timeout + 999) / 1000));
        g_socket_client_connect_to_host_async(client, host, (guint16)port, job->cancel,
                                              on_reach_connected, job);
        g_object_unref(client);
    }
    JS_FreeCString(ctx, host);
    return JS_UNDEFINED;
}

/* ---------------------------------------------------------------- the table */

static const JSCFunctionListEntry network_props[] = {
    /* Connectivity
     *   what the network reaches, as far as this machine can know:
     *   `"Unknown"` (not answered yet), `"None"`, `"Local"` (a network with no
     *   way out), `"Routed"` (a way out that nobody checked reaches the
     *   internet -- what most backends can honestly say), `"Limited"`,
     *   `"Portal"` (a captive portal: a sign-in page first) or `"Full"` (the
     *   internet, checked). Advice, not a guarantee: whether a server answers
     *   is a request to it, or `Reach`
     */
    JS_CGETSET_DEF("Connectivity", net_get_connectivity, NULL),
    /* Online
     *   `Connectivity` is `"Full"`, and nothing weaker -- never *an interface
     *   is up*
     */
    JS_CGETSET_DEF("Online", net_get_online, NULL),
    /* Metered
     *   the connection costs by the byte or is capped -- a phone's hotspot --
     *   so a large upload can wait. `false` where the system cannot tell
     */
    JS_CGETSET_DEF("Metered", net_get_metered, NULL),
    /* OnChange
     *   assign `() => …`: called when `Connectivity` or `Metered` changed,
     *   once per change however many notices it took. Read them again inside;
     *   `null` takes it off
     */
    JS_CGETSET_DEF("OnChange", net_get_onchange, net_set_onchange),
    /* Reach(host, port, callback, [options])
     *   whether `host` answers on `port`, which no global property can say:
     *   calls `callback(ok, why)` with `why` `""`, `"NotFound"` (the name did
     *   not resolve), `"Refused"`, `"Unreachable"`, `"Timeout"`,
     *   `"NotAllowed"` or `"Error"`. A real connection, closed at once --
     *   inside a sandbox the desktop portal asks instead. `{ Timeout }` in ms,
     *   default `5000`
     */
    JS_CFUNC_DEF("Reach", 3, net_reach),
};

guint bta_network_pending(void)
{
    return g_list_length(reach_jobs);
}

void bta_network_cleanup(void)
{
    while (reach_jobs) {
        ReachJob *job = reach_jobs->data;
        g_cancellable_cancel(job->cancel);
        reach_free(job);
    }
    if (net_idle) {
        g_source_remove(net_idle);
        net_idle = 0;
    }
    if (net_ctx)
        JS_FreeValue(net_ctx, net_onchange);
    net_onchange = JS_UNDEFINED;
    net_ctx      = NULL;
    if (net_monitor) {
        g_signal_handlers_disconnect_by_func(net_monitor, on_net_changed, NULL);
        g_signal_handlers_disconnect_by_func(net_monitor, on_net_notify, NULL);
        g_clear_object(&net_monitor);
    }
    if (net_nm) {
        g_signal_handlers_disconnect_by_func(net_nm, on_nm_props, NULL);
        g_clear_object(&net_nm);
    }
    g_clear_pointer(&net_last, g_free);
    net_last_metered = -1;
    net_answered = net_portal = net_sandbox_offline = false;
}

void bta_network_init(JSContext *ctx, JSValue global)
{
    JSValue network = JS_NewObject(ctx);

    net_ctx = ctx;
    JS_SetPropertyFunctionList(ctx, network, network_props, G_N_ELEMENTS(network_props));
    JS_SetPropertyStr(ctx, global, "Network", network);
}
