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
        JS_ThrowTypeError(ctx, "%s: the options are an object (Id, Urgency, Icon)", who);
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
            JS_ThrowTypeError(ctx, "%s: '%s' is not an option (Id, Urgency, Icon)",
                              who, name ? name : "?");
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

static JSValue notification_send(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    static const char *const known[] = { "Id", "Urgency", "Icon", NULL };
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
        return JS_ThrowInternalError(ctx, "%s: a project with a main has no display "
                                          "and no application to send from -- say it "
                                          "on stdout", who);

    /* **A notification belongs to an application id, and a project without one
     * has none.** GLib's answer is an assertion (`g_application_get_application_id
     * (application) != NULL`) and a notification that never arrives -- measured,
     * five calls and zero on the bus, with the program told nothing. The `id` is
     * the project's own key, and it is also what a desktop groups the
     * notifications of one program under, so it is asked for by name. */
    if (!g_application_get_application_id(G_APPLICATION(app->gapp)))
        return JS_ThrowInternalError(ctx, "%s: this project declares no `id` in "
                                          "project.json, and a desktop notification "
                                          "is sent in the name of one (for example "
                                          "\"org.example.MyApp\")", who);

    bool        bad = false;
    const char *id  = notification_text(ctx, opts, "Id", who, &bad);
    const char *urg = bad ? NULL : notification_text(ctx, opts, "Urgency", who, &bad);
    const char *icn = bad ? NULL : notification_text(ctx, opts, "Icon", who, &bad);
    JSValue     ret = JS_EXCEPTION;

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
            g_application_send_notification(G_APPLICATION(app->gapp),
                                            id ? id : made, n);
            ret = JS_NewString(ctx, id ? id : made);
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
        return JS_ThrowInternalError(ctx, "Notification.Withdraw: a project with a "
                                          "main has no application to withdraw from");

    if (!g_application_get_application_id(G_APPLICATION(app->gapp)))
        return JS_ThrowInternalError(ctx, "Notification.Withdraw: this project "
                                          "declares no `id`, so it has sent nothing");

    const char *id = JS_ToCString(ctx, argv[0]);
    if (!id)
        return JS_EXCEPTION;
    g_application_withdraw_notification(G_APPLICATION(app->gapp), id);
    JS_FreeCString(ctx, id);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry notification_props[] = {
    /* Send(title, [body], [options]) -> string
     *   shows a desktop notification and answers its id. With no body, the
     *   second argument may be the options: `{ Id, Urgency, Icon }`. `Urgency`
     *   is `"Low"`, `"Normal"` (the default), `"High"` or `"Urgent"`; `Icon` is a
     *   theme icon name; sending again with the same `Id` **replaces** what is
     *   showing. The title and body are not looked up in a catalogue -- wrap
     *   them in `Locale.Text`. Refused in a project with a `main`, which has no
     *   application to send from
     */
    JS_CFUNC_DEF("Send", 3, notification_send),
    /* Withdraw(id)
     *   takes a notification back, by the id `Send` answered or was given. An id
     *   nothing is showing under is not an error
     */
    JS_CFUNC_DEF("Withdraw", 1, notification_withdraw),
};

void bta_notification_init(JSContext *ctx, JSValue global)
{
    JSValue n = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, n, notification_props, G_N_ELEMENTS(notification_props));
    JS_SetPropertyStr(ctx, global, "Notification", n);
}
