/*
 * Notification -- telling the user something when the window is not what they
 * are looking at.
 *
 *     Notification.Send("Backup finished", "412 files, 1.8 GB")
 *     const id = Notification.Send("Disk almost full", "3% left",
 *                                  { Urgency: "High", Icon: "drive-harddisk-symbolic" })
 *     Notification.Withdraw(id)
 *
 * `Message` is the other way to say something, and it is modal: it takes the
 * window. This is for the case where that is the wrong thing -- a long job that
 * ended while the user was somewhere else.
 *
 * ## Through the application, and not the bus
 *
 * It is `g_application_send_notification`, which goes by whatever route the
 * platform has: the freedesktop daemon on a desktop, **the notification portal
 * inside a Flatpak** -- which is how this project's packages run -- and the
 * native service elsewhere. A direct call to `org.freedesktop.Notifications`
 * would be the shorter code and would need a hole in every package's sandbox.
 * The price is that it needs the application to exist: **a project with a `main`
 * has none** (no display, no `GtkApplication`), so it refuses with a sentence
 * rather than shelling out to `notify-send`, and a tool that wants to say it is
 * done says it on stdout.
 *
 * ## What is not here, with the trigger
 *
 * **A click that calls back.** A notification's action is an action of the
 * application, and a callback held by a notification the desktop owns is a tenth
 * hand-rolled async job shape with the usual question of which exit forgets to
 * release (see *the nine* in AGENTS.md) -- and the daemon may keep the
 * notification for days, past the window that sent it. Nothing in the tree needs
 * it; the first application that does is the case to design it from.
 * **Buttons, sound, a progress bar and an image** are the same: the freedesktop
 * spec has them, and the portal supports fewer.
 *
 * ## Prose
 *
 * The title and body are text the user reads and are **not** looked up in a
 * catalogue here -- they go through `Locale.Text`, at the call site, which is
 * where the extractor looks and where `{0}` interpolates:
 * `Notification.Send(Locale.Text("Copied {0} files", n))`.
 */

#include "bta.h"

#include <string.h>

/*
 * What a notification can do beyond showing text.
 *
 * **Linux and macOS deliver a click**, through the application action
 * `app.notification`: the freedesktop backend turns the daemon's
 * `ActionInvoked` back into that action, and the Cocoa backend does the same
 * with `NSUserNotification`. **Windows shows the notification but cannot
 * deliver an action**: `gwin32notificationbackend.c` uses
 * `Shell_NotifyIcon(NIF_INFO)` and says so -- "Notification actions are
 * unsupported by this Windows backend". It also warns when an action is set, so
 * the runtime does not set one there.
 *
 * The numbers of buttons are the backend's, not a guess: the Cocoa backend
 * handles `button0` only, the freedesktop/portal road draws a short row, and
 * the Windows backend draws none. `MaxButtons` publishes that; a caller that
 * sends more has the extra ones ignored, which is a documented limitation and
 * not a throw -- the notification itself still arrives.
 */
#ifdef G_OS_WIN32
#define BTA_NOTIFICATION_CAN_ACTIVATE false
#define BTA_NOTIFICATION_MAX_BUTTONS  0
#elif defined(__APPLE__)
#define BTA_NOTIFICATION_CAN_ACTIVATE true
#define BTA_NOTIFICATION_MAX_BUTTONS  1
#else
#define BTA_NOTIFICATION_CAN_ACTIVATE true
#define BTA_NOTIFICATION_MAX_BUTTONS  3
#endif

typedef struct {
    char *label;
    char *action;
} NotificationButton;

static void notification_button_free(gpointer p)
{
    NotificationButton *b = p;

    if (!b)
        return;
    g_free(b->label);
    g_free(b->action);
    g_free(b);
}

/* The options a call accepts. One that is not named is refused, so `{ Urgancy:
 * "High" }` is an error and not a quiet normal notification. */
static bool notification_options(JSContext *ctx, JSValueConst opts, const char *who,
                                 const char *const *known)
{
    JSPropertyEnum *tab;
    uint32_t        len;

    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;
    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "%s: the options are an object (Id, Urgency, "
                           "Icon, Buttons)", who);
        return false;
    }
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;

    for (uint32_t i = 0; i < len; i++) {
        const char *name = JS_AtomToCString(ctx, tab[i].atom);
        bool        ok = false;

        for (const char *const *k = known; name && *k; k++)
            ok = ok || strcmp(name, *k) == 0;
        if (!ok) {
            JS_ThrowTypeError(ctx, "%s: '%s' is not an option (Id, Urgency, "
                              "Icon, Buttons)", who, name ? name : "?");
            if (name)
                JS_FreeCString(ctx, name);
            JS_FreePropertyEnum(ctx, tab, len);
            return false;
        }
        JS_FreeCString(ctx, name);
    }
    JS_FreePropertyEnum(ctx, tab, len);
    return true;
}

/* An option that is text, or NULL when it was not given. `*bad` when it was and
 * is not text: a refusal, not "none". The result is for JS_FreeCString. */
static const char *notification_text(JSContext *ctx, JSValueConst opts,
                                     const char *key, const char *who, bool *bad)
{
    JSValue v = JS_IsObject(opts) ? JS_GetPropertyStr(ctx, opts, key) : JS_UNDEFINED;

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return NULL;
    }
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "%s: %s is text", who, key);
        *bad = true;
        return NULL;
    }
    const char *s = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    if (!s)
        *bad = true;
    return s;
}

/* One text field of a button, refused by name when it is not non-empty text. */
static bool notification_button_text(JSContext *ctx, JSValueConst item,
                                     const char *key, const char *who, char **out)
{
    JSValue v = JS_GetPropertyStr(ctx, item, key);

    if (JS_IsException(v))
        return false;
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "%s: a button's %s is text", who, key);
        return false;
    }
    const char *s = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    if (!s)
        return false;
    if (!*s) {
        JS_FreeCString(ctx, s);
        JS_ThrowRangeError(ctx, "%s: a button's %s is not empty text", who, key);
        return false;
    }
    *out = g_strdup(s);
    JS_FreeCString(ctx, s);
    return true;
}

/*
 * `Buttons: [{ Label, Action }, …]`. The labels are prose and are translated
 * by the caller; `Action` is a short key the program dispatches on. The array
 * is validated whole before anything is sent, and the extra ones beyond
 * `MaxButtons` are ignored by the send, not refused: the notification still
 * arrives on a platform that shows fewer.
 */
static bool notification_buttons(JSContext *ctx, JSValueConst opts,
                                 const char *who, GPtrArray *out)
{
    if (!JS_IsObject(opts))
        return true;

    JSValue v = JS_GetPropertyStr(ctx, opts, "Buttons");
    if (JS_IsException(v))
        return false;
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }
    if (!JS_IsArray(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "%s: Buttons is a list of { Label, Action }", who);
        return false;
    }

    JSValue  lenv = JS_GetPropertyStr(ctx, v, "length");
    uint32_t n    = 0;

    if (JS_IsException(lenv) || JS_ToUint32(ctx, &n, lenv) < 0) {
        JS_FreeValue(ctx, lenv);
        JS_FreeValue(ctx, v);
        return false;
    }
    JS_FreeValue(ctx, lenv);

    bool ok = true;

    for (uint32_t i = 0; i < n && ok; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, v, i);

        if (JS_IsException(item)) {
            ok = false;
            break;
        }
        if (!JS_IsObject(item)) {
            JS_ThrowTypeError(ctx, "%s: Buttons[%u] is an object with Label "
                                   "and Action", who, i);
            JS_FreeValue(ctx, item);
            ok = false;
            break;
        }

        /* No third key: a misspelt `Aktion` is a mistake, not a button with
         * no action. */
        JSPropertyEnum *props = NULL;
        uint32_t        pn    = 0;

        if (JS_GetOwnPropertyNames(ctx, &props, &pn, item,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
            JS_FreeValue(ctx, item);
            ok = false;
            break;
        }
        for (uint32_t p = 0; p < pn; p++) {
            const char *key = JS_AtomToCString(ctx, props[p].atom);

            if (!key) {
                ok = false;
                break;
            }
            if (strcmp(key, "Label") != 0 && strcmp(key, "Action") != 0) {
                JS_ThrowTypeError(ctx, "%s: a button has no option called '%s'; "
                                       "it has Label and Action", who, key);
                ok = false;
            }
            JS_FreeCString(ctx, key);
        }
        JS_FreePropertyEnum(ctx, props, pn);
        if (!ok) {
            JS_FreeValue(ctx, item);
            break;
        }

        NotificationButton *b = g_new0(NotificationButton, 1);

        if (!notification_button_text(ctx, item, "Label", who, &b->label) ||
            !notification_button_text(ctx, item, "Action", who, &b->action)) {
            notification_button_free(b);
            JS_FreeValue(ctx, item);
            ok = false;
            break;
        }
        JS_FreeValue(ctx, item);

        for (guint j = 0; j < out->len; j++) {
            NotificationButton *other = g_ptr_array_index(out, j);

            if (strcmp(other->action, b->action) == 0) {
                JS_ThrowTypeError(ctx, "%s: two buttons share the action '%s'",
                                  who, b->action);
                notification_button_free(b);
                ok = false;
                break;
            }
        }
        if (ok)
            g_ptr_array_add(out, b);
    }

    JS_FreeValue(ctx, v);
    return ok;
}

/*
 * The one action a notification can call: `app.notification` with `(id, key)`.
 * A body click is key "", a button its `Action`. The handler is
 * `Notification.OnActivate`, looked up at click time -- not held by the
 * notification, which the desktop may keep for days.
 */
static void on_notification_action(GSimpleAction *action, GVariant *parameter,
                                   gpointer user_data)
{
    (void)action;
    (void)user_data;

    BtaApp *app = bta_current_app();
    if (!app || !app->ctx || !parameter)
        return;

    const char *id  = NULL;
    const char *key = NULL;

    g_variant_get(parameter, "(&s&s)", &id, &key);
    if (!id)
        return;

    JSContext *ctx    = app->ctx;
    JSValue    global = JS_GetGlobalObject(ctx);
    JSValue    notif  = JS_GetPropertyStr(ctx, global, "Notification");
    JSValue    fn     = JS_GetPropertyStr(ctx, notif, "OnActivate");

    if (JS_IsFunction(ctx, fn)) {
        JSValue args[2];

        args[0] = JS_NewString(ctx, id);
        args[1] = (key && *key) ? JS_NewString(ctx, key) : JS_NULL;

        JSValue r = JS_Call(ctx, fn, notif, 2, args);

        if (JS_IsException(r))
            bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
        bta_drain_jobs(JS_GetRuntime(ctx));
    }

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, notif);
    JS_FreeValue(ctx, global);
}

static void notification_ensure_action(BtaApp *app)
{
    if (!app || !app->gapp)
        return;
    if (g_object_get_data(G_OBJECT(app->gapp), "bta-notification-action"))
        return;

    GSimpleAction *a = g_simple_action_new("notification", G_VARIANT_TYPE("(ss)"));

    g_signal_connect(a, "activate", G_CALLBACK(on_notification_action), NULL);
    g_action_map_add_action(G_ACTION_MAP(app->gapp), G_ACTION(a));
    g_object_unref(a);

    g_object_set_data(G_OBJECT(app->gapp), "bta-notification-action",
                      GINT_TO_POINTER(1));
}

static JSValue notification_send(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    static const char *const known[] = { "Id", "Urgency", "Icon", "Buttons", NULL };
    const char *who = "Notification.Send";

    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Notification.Send(title, [body], [options]) "
                                      "needs the title, as text");

    /* The second argument is the body, or -- when there is no body to give --
     * the options. Telling them apart by type is the whole of the rule, and the
     * alternative was `Send(title, "", { ... })`. */
    JSValueConst body = JS_UNDEFINED, opts = JS_UNDEFINED;

    if (argc > 1) {
        if (JS_IsString(argv[1]))
            body = argv[1];
        else
            opts = argv[1];
    }
    if (argc > 2) {
        if (JS_IsObject(opts))
            return JS_ThrowTypeError(ctx, "%s: two sets of options", who);
        opts = argv[2];
    }
    if (!JS_IsUndefined(body) && !JS_IsString(body))
        return JS_ThrowTypeError(ctx, "%s: the body is text", who);
    if (!notification_options(ctx, opts, who, known))
        return JS_EXCEPTION;

    BtaApp *app = bta_current_app();
    if (!app || !app->gapp)
        return JS_ThrowPlainError(ctx, "%s: a project with a main has no display "
                                       "and no application to send from -- say it "
                                       "on stdout", who);

    /* **A notification belongs to an application id, and a project without one
     * has none.** GLib's answer is an assertion (`g_application_get_application_id
     * (application) != NULL`) and a notification that never arrives -- measured,
     * five calls and zero on the bus, with the program told nothing. The `id` is
     * the project's own key, and it is also what a desktop groups the
     * notifications of one program under, so it is asked for by name. */
    if (!g_application_get_application_id(G_APPLICATION(app->gapp)))
        return JS_ThrowPlainError(ctx, "%s: this project declares no `id` in "
                                       "project.btp, and a desktop notification "
                                       "is sent in the name of one (for example "
                                       "\"org.example.MyApp\")", who);

    bool        bad = false;
    const char *id  = notification_text(ctx, opts, "Id", who, &bad);
    const char *urg = bad ? NULL : notification_text(ctx, opts, "Urgency", who, &bad);
    const char *icn = bad ? NULL : notification_text(ctx, opts, "Icon", who, &bad);
    GPtrArray  *buttons = g_ptr_array_new_with_free_func(notification_button_free);
    JSValue     ret = JS_EXCEPTION;

    if (!bad && !notification_buttons(ctx, opts, who, buttons))
        bad = true;

    GNotificationPriority prio = G_NOTIFICATION_PRIORITY_NORMAL;

    if (!bad && urg) {
        if      (g_ascii_strcasecmp(urg, "Low") == 0)    prio = G_NOTIFICATION_PRIORITY_LOW;
        else if (g_ascii_strcasecmp(urg, "Normal") == 0) prio = G_NOTIFICATION_PRIORITY_NORMAL;
        else if (g_ascii_strcasecmp(urg, "High") == 0)   prio = G_NOTIFICATION_PRIORITY_HIGH;
        else if (g_ascii_strcasecmp(urg, "Urgent") == 0) prio = G_NOTIFICATION_PRIORITY_URGENT;
        else {
            JS_ThrowRangeError(ctx, "%s: Urgency '%s' is not one of Low, Normal, "
                                    "High, Urgent", who, urg);
            bad = true;
        }
    }
    if (!bad && id && !*id) {
        JS_ThrowRangeError(ctx, "%s: Id is not empty text", who);
        bad = true;
    }

    if (!bad) {
        const char *title = JS_ToCString(ctx, argv[0]);
        const char *text  = JS_IsUndefined(body) ? NULL : JS_ToCString(ctx, body);

        if (title && (text || JS_IsUndefined(body))) {
            /* The id is the caller's -- sending with the same one replaces what
             * is showing -- or ours, so that every `Send` has something to
             * `Withdraw`. GLib would make one and not say what it was. */
            char          *made = id ? NULL : g_uuid_string_random();
            GNotification *n    = g_notification_new(title);

            if (text && *text)
                g_notification_set_body(n, text);
            g_notification_set_priority(n, prio);
            if (icn && *icn) {
                GIcon *icon = g_themed_icon_new(icn);
                g_notification_set_icon(n, icon);
                g_object_unref(icon);
            }

            /* The click is the application's action, not a callback the
             * notification owns: the daemon may keep it, and the callback
             * waits on the `Notification` object. The action carries the id
             * and, for a button, its key; a body click carries "". */
            const char *nid = id ? id : made;

            if (BTA_NOTIFICATION_CAN_ACTIVATE) {
                notification_ensure_action(app);
                g_notification_set_default_action_and_target_value(
                    n, "app.notification", g_variant_new("(ss)", nid, ""));

                for (guint i = 0; i < buttons->len &&
                                 i < BTA_NOTIFICATION_MAX_BUTTONS; i++) {
                    NotificationButton *b = g_ptr_array_index(buttons, i);

                    g_notification_add_button_with_target_value(
                        n, b->label, "app.notification",
                        g_variant_new("(ss)", nid, b->action));
                }
            }

            g_application_send_notification(G_APPLICATION(app->gapp), nid, n);
            ret = JS_NewString(ctx, nid);
            g_object_unref(n);
            g_free(made);
        }
        if (title)
            JS_FreeCString(ctx, title);
        if (text)
            JS_FreeCString(ctx, text);
    }

    if (id)
        JS_FreeCString(ctx, id);
    if (urg)
        JS_FreeCString(ctx, urg);
    if (icn)
        JS_FreeCString(ctx, icn);
    g_ptr_array_unref(buttons);
    return ret;
}

static JSValue notification_withdraw(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Notification.Withdraw(id) needs the id "
                                      "Send answered, as text");

    BtaApp *app = bta_current_app();
    if (!app || !app->gapp)
        return JS_ThrowPlainError(ctx, "Notification.Withdraw: a project with a "
                                       "main has no application to withdraw from");

    if (!g_application_get_application_id(G_APPLICATION(app->gapp)))
        return JS_ThrowPlainError(ctx, "Notification.Withdraw: this project "
                                       "declares no `id`, so it has sent nothing");

    const char *id = JS_ToCString(ctx, argv[0]);
    if (!id)
        return JS_EXCEPTION;
    g_application_withdraw_notification(G_APPLICATION(app->gapp), id);
    JS_FreeCString(ctx, id);
    return JS_UNDEFINED;
}

static JSValue notification_get_on_activate(JSContext *ctx,
                                            JSValueConst this_val)
{
    return JS_GetPropertyStr(ctx, this_val, "__bta_on_activate");
}

static JSValue notification_set_on_activate(JSContext *ctx,
                                            JSValueConst this_val,
                                            JSValueConst v)
{
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "Notification.OnActivate: expected a "
                                      "function, or null");
    JS_SetPropertyStr(ctx, this_val, "__bta_on_activate",
                      JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED);
    return JS_UNDEFINED;
}

static JSValue notification_get_can_activate(JSContext *ctx,
                                             JSValueConst this_val)
{
    (void)this_val;
    return JS_NewBool(ctx, BTA_NOTIFICATION_CAN_ACTIVATE);
}

static JSValue notification_get_max_buttons(JSContext *ctx,
                                            JSValueConst this_val)
{
    (void)this_val;
    return JS_NewInt32(ctx, BTA_NOTIFICATION_MAX_BUTTONS);
}

static const JSCFunctionListEntry notification_props[] = {
    /* Send(title, [body], [options]) -> string
     *   shows a desktop notification and answers its id. With no body, the
     *   second argument may be the options: `{ Id, Urgency, Icon, Buttons }`.
     *   `Urgency` is `"Low"`, `"Normal"` (the default), `"High"` or `"Urgent"`;
     *   `Icon` is a theme icon name; `Buttons` is `[{ Label, Action }]`, where
     *   `Label` is prose and `Action` is the key `OnActivate` is handed.
     *   Sending again with the same `Id` **replaces** what is showing. The
     *   title, body and labels are not looked up in a catalogue -- wrap them
     *   in `Locale.Text`. Refused in a project with a `main`, which has no
     *   application to send from
     */
    JS_CFUNC_DEF("Send", 3, notification_send),
    /* Withdraw(id)
     *   takes a notification back, by the id `Send` answered or was given. An id
     *   nothing is showing under is not an error. On Windows this is a no-op:
     *   the GLib backend has no withdraw
     */
    JS_CFUNC_DEF("Withdraw", 1, notification_withdraw),
    /* OnActivate
     *   assign `(id, action) => …`: a notification was clicked. `id` is the one
     *   `Send` answered; `action` is `null` for the notification itself or the
     *   `Action` of the button. `null` takes it off. The handler is looked up
     *   when the click arrives, and not called on Windows, where the backend
     *   has no actions
     */
    JS_CGETSET_DEF("OnActivate", notification_get_on_activate,
                   notification_set_on_activate),
    /* CanActivate
     *   whether this platform delivers a click: `true` on Linux (the daemon or
     *   the portal) and macOS, `false` on Windows
     */
    JS_CGETSET_DEF("CanActivate", notification_get_can_activate, NULL),
    /* MaxButtons
     *   how many `Buttons` the platform shows: 3 on Linux, 1 on macOS and 0
     *   on Windows. Extra buttons are ignored; the notification still arrives
     */
    JS_CGETSET_DEF("MaxButtons", notification_get_max_buttons, NULL),
};

void bta_notification_cleanup(void)
{
    BtaApp *app = bta_current_app();

    if (app && app->gapp)
        g_action_map_remove_action(G_ACTION_MAP(app->gapp), "notification");
}

void bta_notification_init(JSContext *ctx, JSValue global)
{
    JSValue n = JS_NewObject(ctx);

    JS_DefinePropertyValueStr(ctx, n, "__bta_on_activate", JS_UNDEFINED,
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_SetPropertyFunctionList(ctx, n, notification_props, G_N_ELEMENTS(notification_props));
    JS_SetPropertyStr(ctx, global, "Notification", n);
}
