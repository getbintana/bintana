/*
 * Tray -- the public object, the menu tree and the dispatcher.
 *
 * The platform files implement `BtaTrayBackend`; this file never knows which
 * one is compiled.  The menu is validated into a C tree here, so a bad menu is
 * refused before the native icon is touched, and both the Linux `dbusmenu`
 * layout and the Windows `HMENU` are built from the same data.
 */
#include "bta_tray.h"

#include <string.h>

#define TRAY_MENU_DEPTH 8
#define TRAY_MENU_ITEMS 128

static JSClassID tray_class_id;
static BtaTray   *tray_current;

/* --------------------------------------------------------------- the menu */

void bta_tray_item_free(gpointer p)
{
    BtaTrayItem *item = p;

    if (!item)
        return;
    g_free(item->text);
    g_free(item->action);
    if (item->children)
        g_ptr_array_unref(item->children);
    g_free(item);
}

static BtaTrayItem *tray_item_new(void)
{
    BtaTrayItem *item = g_new0(BtaTrayItem, 1);

    item->enabled  = true;
    item->children = g_ptr_array_new_with_free_func(bta_tray_item_free);
    return item;
}

static bool tray_item_text(JSContext *ctx, JSValueConst v, const char *who,
                           const char *key, char **out)
{
    JSValue p = JS_GetPropertyStr(ctx, v, key);

    if (JS_IsException(p))
        return false;
    if (JS_IsUndefined(p) || JS_IsNull(p)) {
        JS_FreeValue(ctx, p);
        JS_ThrowTypeError(ctx, "%s: %s is needed", who, key);
        return false;
    }
    if (!JS_IsString(p)) {
        JS_FreeValue(ctx, p);
        JS_ThrowTypeError(ctx, "%s: %s is text", who, key);
        return false;
    }
    const char *s = JS_ToCString(ctx, p);
    JS_FreeValue(ctx, p);
    if (!s)
        return false;
    if (!*s) {
        JS_FreeCString(ctx, s);
        JS_ThrowRangeError(ctx, "%s: %s is not empty text", who, key);
        return false;
    }
    *out = g_strdup(s);
    JS_FreeCString(ctx, s);
    return true;
}

static bool tray_item_parse(JSContext *ctx, JSValueConst v, int depth,
                            GHashTable *actions, int *count, BtaTrayItem **out)
{
    const char *who = "Tray.Menu";
    BtaTrayItem *item;
    JSValue      sep = JS_UNDEFINED, en = JS_UNDEFINED, chk = JS_UNDEFINED;
    JSValue      items = JS_UNDEFINED;
    bool         ok = true;

    *out = NULL;
    if (!JS_IsObject(v)) {
        JS_ThrowTypeError(ctx, "%s: an item is an object with Text and Action", who);
        return false;
    }
    if (depth > TRAY_MENU_DEPTH) {
        JS_ThrowRangeError(ctx, "%s: submenus nest at most %d deep", who,
                           TRAY_MENU_DEPTH);
        return false;
    }
    if (++*count > TRAY_MENU_ITEMS) {
        JS_ThrowRangeError(ctx, "%s: at most %d items", who, TRAY_MENU_ITEMS);
        return false;
    }

    /* No third key: a misspelt `Textt` is a mistake, not an empty item. */
    JSPropertyEnum *props = NULL;
    uint32_t        pn    = 0;

    if (JS_GetOwnPropertyNames(ctx, &props, &pn, v,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;
    for (uint32_t i = 0; i < pn && ok; i++) {
        const char *key = JS_AtomToCString(ctx, props[i].atom);

        if (!key) {
            ok = false;
            break;
        }
        if (strcmp(key, "Text") != 0 && strcmp(key, "Action") != 0 &&
            strcmp(key, "Enabled") != 0 && strcmp(key, "Checked") != 0 &&
            strcmp(key, "Separator") != 0 && strcmp(key, "Items") != 0) {
            JS_ThrowTypeError(ctx, "%s: no item option called '%s'; an item has "
                                   "Text, Action, Enabled, Checked, Separator "
                                   "and Items", who, key);
            ok = false;
        }
        JS_FreeCString(ctx, key);
    }
    JS_FreePropertyEnum(ctx, props, pn);
    if (!ok)
        return false;

    item = tray_item_new();
    sep = JS_GetPropertyStr(ctx, v, "Separator");
    en  = JS_GetPropertyStr(ctx, v, "Enabled");
    chk = JS_GetPropertyStr(ctx, v, "Checked");
    items = JS_GetPropertyStr(ctx, v, "Items");
    if (JS_IsException(sep) || JS_IsException(en) ||
        JS_IsException(chk) || JS_IsException(items)) {
        ok = false;
        goto done;
    }
    if ((!JS_IsUndefined(sep) && !JS_IsBool(sep)) ||
        (!JS_IsUndefined(en)  && !JS_IsBool(en))  ||
        (!JS_IsUndefined(chk) && !JS_IsBool(chk))) {
        JS_ThrowTypeError(ctx, "%s: Separator, Enabled and Checked are true or "
                               "false", who);
        ok = false;
        goto done;
    }

    if (!JS_IsUndefined(en))
        item->enabled = JS_ToBool(ctx, en);
    if (!JS_IsUndefined(sep) && JS_ToBool(ctx, sep)) {
        item->separator = true;
        /* A separator is only a separator; a Text or an Action beside it is a
         * mistake the layout would silently drop. */
        JSValue text = JS_GetPropertyStr(ctx, v, "Text");
        JSValue act  = JS_GetPropertyStr(ctx, v, "Action");
        if ((!JS_IsUndefined(text) && !JS_IsNull(text)) ||
            (!JS_IsUndefined(act) && !JS_IsNull(act)) ||
            (!JS_IsUndefined(items) && !JS_IsNull(items)) ||
            !JS_IsUndefined(chk)) {
            JS_ThrowTypeError(ctx, "%s: Separator takes no Text, Action, "
                                   "Checked or Items", who);
            ok = false;
        }
        JS_FreeValue(ctx, text);
        JS_FreeValue(ctx, act);
        if (!ok)
            goto done;
    } else {
        if (!tray_item_text(ctx, v, who, "Text", &item->text)) {
            ok = false;
            goto done;
        }

        JSValue act = JS_GetPropertyStr(ctx, v, "Action");

        if (!JS_IsUndefined(act) && !JS_IsNull(act)) {
            if (!JS_IsString(act)) {
                JS_ThrowTypeError(ctx, "%s: Action is text", who);
                ok = false;
            } else {
                const char *s = JS_ToCString(ctx, act);

                if (!s)
                    ok = false;
                else if (!*s) {
                    JS_FreeCString(ctx, s);
                    JS_ThrowRangeError(ctx, "%s: Action is not empty text", who);
                    ok = false;
                } else if (g_hash_table_contains(actions, s)) {
                    JS_ThrowTypeError(ctx, "%s: two items share the action '%s'",
                                      who, s);
                    JS_FreeCString(ctx, s);
                    ok = false;
                } else {
                    item->action = g_strdup(s);
                    g_hash_table_add(actions, g_strdup(s));
                    JS_FreeCString(ctx, s);
                }
            }
        }
        JS_FreeValue(ctx, act);
        if (!ok)
            goto done;

        if (!JS_IsUndefined(chk)) {
            item->checkable = true;
            item->checked   = JS_ToBool(ctx, chk);
        }

        if (!JS_IsUndefined(items) && !JS_IsNull(items)) {
            if (!JS_IsArray(items)) {
                JS_ThrowTypeError(ctx, "%s: Items is a list", who);
                ok = false;
                goto done;
            }
            if (item->checkable) {
                JS_ThrowTypeError(ctx, "%s: a submenu is not a check item", who);
                ok = false;
                goto done;
            }
            JSValue  lenv = JS_GetPropertyStr(ctx, items, "length");
            uint32_t n    = 0;

            if (JS_IsException(lenv) || JS_ToUint32(ctx, &n, lenv) < 0) {
                JS_FreeValue(ctx, lenv);
                ok = false;
                goto done;
            }
            JS_FreeValue(ctx, lenv);
            for (uint32_t i = 0; i < n && ok; i++) {
                JSValue      child = JS_GetPropertyUint32(ctx, items, i);
                BtaTrayItem *sub   = NULL;

                if (JS_IsException(child)) {
                    ok = false;
                    break;
                }
                if (!tray_item_parse(ctx, child, depth + 1, actions, count, &sub)) {
                    JS_FreeValue(ctx, child);
                    ok = false;
                    break;
                }
                g_ptr_array_add(item->children, sub);
                JS_FreeValue(ctx, child);
            }
            if (!ok)
                goto done;
        }

        /* An item that neither does anything nor opens anything is a label
         * that looks like a button; it is a mistake. */
        if (item->children->len == 0 &&
            (!item->action || !*item->action)) {
            JS_ThrowTypeError(ctx, "%s: '%s' has no Action and no Items", who,
                              item->text);
            ok = false;
            goto done;
        }
    }

done:
    JS_FreeValue(ctx, sep);
    JS_FreeValue(ctx, en);
    JS_FreeValue(ctx, chk);
    JS_FreeValue(ctx, items);
    if (!ok) {
        bta_tray_item_free(item);
        return false;
    }
    *out = item;
    return true;
}

static bool tray_menu_parse(JSContext *ctx, JSValueConst value, GPtrArray **out)
{
    if (!JS_IsArray(value)) {
        JS_ThrowTypeError(ctx, "Tray.Menu: a list of items");
        return false;
    }

    GPtrArray  *items = g_ptr_array_new_with_free_func(bta_tray_item_free);
    GHashTable *seen  = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    JSValue     lenv  = JS_GetPropertyStr(ctx, value, "length");
    uint32_t    n     = 0;
    int         count = 0;
    bool        ok    = true;

    if (JS_IsException(lenv) || JS_ToUint32(ctx, &n, lenv) < 0) {
        JS_FreeValue(ctx, lenv);
        g_hash_table_unref(seen);
        g_ptr_array_unref(items);
        return false;
    }
    JS_FreeValue(ctx, lenv);

    for (uint32_t i = 0; i < n && ok; i++) {
        JSValue      v   = JS_GetPropertyUint32(ctx, value, i);
        BtaTrayItem *one = NULL;

        if (JS_IsException(v)) {
            ok = false;
            break;
        }
        if (!tray_item_parse(ctx, v, 0, seen, &count, &one))
            ok = false;
        else
            g_ptr_array_add(items, one);
        JS_FreeValue(ctx, v);
    }

    g_hash_table_unref(seen);
    if (!ok) {
        g_ptr_array_unref(items);
        return false;
    }
    *out = items;
    return true;
}

/* --------------------------------------------------------------- the object */

static BtaTray *tray_of(JSContext *ctx, JSValueConst v)
{
    return JS_GetOpaque2(ctx, v, tray_class_id);
}

static void tray_emit(BtaTray *tray, JSValueConst fn, int argc,
                      JSValueConst *argv)
{
    if (!JS_IsFunction(tray->ctx, fn))
        return;

    JSValue self = JS_DupValue(tray->ctx, tray->self);
    JSValue call = JS_DupValue(tray->ctx, fn);
    JSValue r    = JS_Call(tray->ctx, call, self, argc, argv);

    if (JS_IsException(r))
        bta_dump_error(tray->ctx);
    JS_FreeValue(tray->ctx, r);
    JS_FreeValue(tray->ctx, call);
    JS_FreeValue(tray->ctx, self);
    bta_drain_jobs(JS_GetRuntime(tray->ctx));
}

void bta_tray_emit_click(BtaTray *tray)
{
    if (tray)
        tray_emit(tray, tray->on_click, 0, NULL);
}

void bta_tray_emit_menu(BtaTray *tray, const char *action)
{
    if (!tray || !action)
        return;
    JSValue a = JS_NewString(tray->ctx, action);

    if (JS_IsException(a))
        return;
    tray_emit(tray, tray->on_menu, 1, &a);
    JS_FreeValue(tray->ctx, a);
}

static void tray_free_menu(BtaTray *tray)
{
    if (tray->menu) {
        g_ptr_array_unref(tray->menu);
        tray->menu = NULL;
    }
}

static bool tray_set_menu_value(JSContext *ctx, BtaTray *tray, JSValueConst v)
{
    GPtrArray *parsed = NULL;

    if (!tray_menu_parse(ctx, v, &parsed))
        return false;

    tray_free_menu(tray);
    tray->menu = parsed;
    JS_FreeValue(ctx, tray->menu_src);
    tray->menu_src = JS_DupValue(ctx, v);
    if (tray->visible)
        bta_tray_backend.set_menu(tray);
    return true;
}

static bool tray_set_icon_value(JSContext *ctx, BtaTray *tray, JSValueConst v)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "Tray.Icon: expected text");
        return false;
    }
    const char *s = JS_ToCString(ctx, v);
    if (!s)
        return false;
    g_free(tray->icon);
    tray->icon = g_strdup(s);
    JS_FreeCString(ctx, s);
    if (tray->visible)
        bta_tray_backend.set_icon(tray, tray->icon);
    return true;
}

static bool tray_set_tooltip_value(JSContext *ctx, BtaTray *tray, JSValueConst v)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "Tray.Tooltip: expected text");
        return false;
    }
    const char *s = JS_ToCString(ctx, v);
    if (!s)
        return false;
    g_free(tray->tooltip);
    tray->tooltip = g_strdup(s);
    JS_FreeCString(ctx, s);
    if (tray->visible)
        bta_tray_backend.set_tooltip(tray, tray->tooltip);
    return true;
}

static JSValue tray_construct(JSContext *ctx, JSValueConst new_target,
                              int argc, JSValueConst *argv)
{
    if (tray_current)
        return JS_ThrowPlainError(ctx, "Tray: an application has one tray icon; "
                                       "this one is already made");

    JSValue obj = JS_NewObjectClass(ctx, tray_class_id);
    if (JS_IsException(obj))
        return obj;

    BtaTray *tray = g_new0(BtaTray, 1);

    tray->ctx       = ctx;
    tray->self      = obj;
    tray->on_click  = JS_UNDEFINED;
    tray->on_menu   = JS_UNDEFINED;
    tray->menu_src  = JS_NewArray(ctx);
    tray->icon      = g_strdup("");
    tray->tooltip   = g_strdup("");
    tray->menu      = g_ptr_array_new_with_free_func(bta_tray_item_free);
    JS_SetOpaque(obj, tray);
    tray_current = tray;

    if (argc > 0 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
        if (!JS_IsObject(argv[0])) {
            JS_FreeValue(ctx, obj);
            return JS_ThrowTypeError(ctx, "Tray: the options are an object "
                                          "(Icon, Tooltip, Menu)");
        }

        JSPropertyEnum *props = NULL;
        uint32_t        pn    = 0;
        bool            ok    = true;

        if (JS_GetOwnPropertyNames(ctx, &props, &pn, argv[0],
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
        for (uint32_t i = 0; i < pn && ok; i++) {
            const char *key = JS_AtomToCString(ctx, props[i].atom);
            JSValue     v   = JS_UNDEFINED;

            if (!key) {
                ok = false;
                break;
            }
            v = JS_GetPropertyStr(ctx, argv[0], key);
            if (JS_IsException(v)) {
                JS_FreeCString(ctx, key);
                ok = false;
                break;
            }
            if (strcmp(key, "Icon") == 0)
                ok = tray_set_icon_value(ctx, tray, v);
            else if (strcmp(key, "Tooltip") == 0)
                ok = tray_set_tooltip_value(ctx, tray, v);
            else if (strcmp(key, "Menu") == 0)
                ok = tray_set_menu_value(ctx, tray, v);
            else {
                JS_ThrowTypeError(ctx, "Tray: no option called '%s'; the "
                                       "options are Icon, Tooltip and Menu", key);
                ok = false;
            }
            JS_FreeValue(ctx, v);
            JS_FreeCString(ctx, key);
        }
        JS_FreePropertyEnum(ctx, props, pn);
        if (!ok) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
    }
    return obj;
}

static void tray_finalizer(JSRuntime *rt, JSValue v)
{
    BtaTray *tray = JS_GetOpaque(v, tray_class_id);

    if (!tray)
        return;

    if (tray->visible) {
        BtaApp *app = bta_current_app();

        bta_tray_backend.destroy(tray);
        if (app && app->gapp)
            g_application_release(G_APPLICATION(app->gapp));
        tray->visible = false;
    }
    JS_FreeValueRT(rt, tray->on_click);
    JS_FreeValueRT(rt, tray->on_menu);
    JS_FreeValueRT(rt, tray->menu_src);
    g_free(tray->icon);
    g_free(tray->tooltip);
    tray_free_menu(tray);
    if (tray_current == tray)
        tray_current = NULL;
    g_free(tray);
}

static void tray_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    BtaTray *tray = JS_GetOpaque(v, tray_class_id);

    if (!tray)
        return;
    JS_MarkValue(rt, tray->on_click, mark);
    JS_MarkValue(rt, tray->on_menu, mark);
    JS_MarkValue(rt, tray->menu_src, mark);
}

static const JSClassDef tray_def = {
    "Tray",
    .finalizer = tray_finalizer,
    .gc_mark   = tray_gc_mark,
};

/* ------------------------------------------------------------- properties */

static JSValue tray_get_icon(JSContext *ctx, JSValueConst this_val)
{
    BtaTray *tray = JS_GetOpaque(this_val, tray_class_id);
    return tray ? JS_NewString(ctx, tray->icon) : JS_NULL;
}

static JSValue tray_set_icon(JSContext *ctx, JSValueConst this_val,
                             JSValueConst v)
{
    BtaTray *tray = tray_of(ctx, this_val);
    if (!tray)
        return JS_EXCEPTION;
    return tray_set_icon_value(ctx, tray, v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue tray_get_tooltip(JSContext *ctx, JSValueConst this_val)
{
    BtaTray *tray = JS_GetOpaque(this_val, tray_class_id);
    return tray ? JS_NewString(ctx, tray->tooltip) : JS_NULL;
}

static JSValue tray_set_tooltip(JSContext *ctx, JSValueConst this_val,
                                JSValueConst v)
{
    BtaTray *tray = tray_of(ctx, this_val);
    if (!tray)
        return JS_EXCEPTION;
    return tray_set_tooltip_value(ctx, tray, v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue tray_get_menu(JSContext *ctx, JSValueConst this_val)
{
    BtaTray *tray = JS_GetOpaque(this_val, tray_class_id);
    return tray ? JS_DupValue(ctx, tray->menu_src) : JS_NULL;
}

static JSValue tray_set_menu(JSContext *ctx, JSValueConst this_val,
                             JSValueConst v)
{
    BtaTray *tray = tray_of(ctx, this_val);
    if (!tray)
        return JS_EXCEPTION;
    return tray_set_menu_value(ctx, tray, v) ? JS_UNDEFINED : JS_EXCEPTION;
}

static JSValue tray_get_visible(JSContext *ctx, JSValueConst this_val)
{
    BtaTray *tray = JS_GetOpaque(this_val, tray_class_id);
    return tray ? JS_NewBool(ctx, tray->visible) : JS_NULL;
}

static JSValue tray_get_on_click(JSContext *ctx, JSValueConst this_val)
{
    BtaTray *tray = JS_GetOpaque(this_val, tray_class_id);
    return tray ? JS_DupValue(ctx, tray->on_click) : JS_NULL;
}

static JSValue tray_set_on_click(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst v)
{
    BtaTray *tray = tray_of(ctx, this_val);
    if (!tray)
        return JS_EXCEPTION;
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "Tray.OnClick: expected a function, or null");
    JS_FreeValue(ctx, tray->on_click);
    tray->on_click = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

static JSValue tray_get_on_menu(JSContext *ctx, JSValueConst this_val)
{
    BtaTray *tray = JS_GetOpaque(this_val, tray_class_id);
    return tray ? JS_DupValue(ctx, tray->on_menu) : JS_NULL;
}

static JSValue tray_set_on_menu(JSContext *ctx, JSValueConst this_val,
                                JSValueConst v)
{
    BtaTray *tray = tray_of(ctx, this_val);
    if (!tray)
        return JS_EXCEPTION;
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "Tray.OnMenu: expected a function, or null");
    JS_FreeValue(ctx, tray->on_menu);
    tray->on_menu = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

static JSValue tray_show(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaTray *tray = tray_of(ctx, this_val);

    if (!tray)
        return JS_EXCEPTION;
    if (tray->visible)
        return JS_DupValue(ctx, this_val);

    BtaApp *app = bta_current_app();
    if (!app || !app->gapp)
        return JS_ThrowPlainError(ctx, "Tray.Show: a project with a main has no "
                                       "display and no application to own a tray");
    if (!bta_tray_backend.available())
        return JS_ThrowPlainError(ctx, "Tray.Show: %s",
                                  bta_tray_backend.reason
                                      ? bta_tray_backend.reason()
                                      : "no tray icon is available on this platform");
    if (!bta_tray_backend.create(tray))
        return JS_ThrowPlainError(ctx, "Tray.Show: the platform could not create "
                                       "the icon");
    bta_tray_backend.set_icon(tray, tray->icon);
    bta_tray_backend.set_tooltip(tray, tray->tooltip);
    if (tray->menu->len)
        bta_tray_backend.set_menu(tray);
    tray->visible = true;
    bta_tray_backend.show(tray);
    g_application_hold(G_APPLICATION(app->gapp));
    return JS_DupValue(ctx, this_val);
}

static JSValue tray_hide(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaTray *tray = tray_of(ctx, this_val);

    if (!tray)
        return JS_EXCEPTION;
    if (tray->visible) {
        BtaApp *app = bta_current_app();

        tray->visible = false;
        bta_tray_backend.hide(tray);
        bta_tray_backend.destroy(tray);
        if (app && app->gapp)
            g_application_release(G_APPLICATION(app->gapp));
    }
    return JS_DupValue(ctx, this_val);
}

/* type Tray */
static const JSCFunctionListEntry tray_props[] = {
    /* Icon
     *   a theme name, or a `.ico`/image path. On Windows the theme name is
     *   resolved through the icon theme and a `.ico`/PNG/SVG path is loaded
     *   directly; an empty value falls back to the executable's icon. Set
     *   before or after `Show`
     */
    JS_CGETSET_DEF("Icon", tray_get_icon, tray_set_icon),
    /* Menu
     *   an array of `{ Text, Action, Enabled, Checked, Separator, Items }`;
     *   assigning it validates the whole tree and rebuilds the native menu.
     *   `Text` and button labels are prose -- wrap them in `Locale.Text`
     */
    JS_CGETSET_DEF("Menu", tray_get_menu, tray_set_menu),
    /* OnClick
     *   assign `() => …`: the primary click. On macOS with a `Menu`, the click
     *   opens the menu and this is not called
     */
    JS_CGETSET_DEF("OnClick", tray_get_on_click, tray_set_on_click),
    /* OnMenu
     *   assign `(action) => …`: a menu item was chosen; `action` is its
     *   `Action`. The menu is data and actions, never callbacks
     */
    JS_CGETSET_DEF("OnMenu", tray_get_on_menu, tray_set_on_menu),
    /* Tooltip
     *   the text the platform shows on hover
     */
    JS_CGETSET_DEF("Tooltip", tray_get_tooltip, tray_set_tooltip),
    /* Visible
     *   whether the icon is shown now
     */
    JS_CGETSET_DEF("Visible", tray_get_visible, NULL),
    /* Show()
     *   add the icon and its menu; answers the tray. Refused with no
     *   application, or with no status-notifier host on the desktop
     */
    JS_CFUNC_DEF("Show", 0, tray_show),
    /* Hide()
     *   remove the icon but keep the object, so `Show` is cheap. Answers the
     *   tray
     */
    JS_CFUNC_DEF("Hide", 0, tray_hide),
};

static JSValue tray_worker_construct(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv)
{
    return JS_ThrowPlainError(ctx, "Tray: a Task worker has no main loop and no "
                                   "application to own a tray icon");
}

void bta_tray_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSValue    proto, ctor;

    JS_NewClassID(rt, &tray_class_id);
    JS_NewClass(rt, tray_class_id, &tray_def);

    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, tray_props, G_N_ELEMENTS(tray_props));
    JS_SetClassProto(ctx, tray_class_id, proto);

    ctor = JS_NewCFunction2(ctx, tray_construct, "Tray", 1,
                            JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);
    /* Available
     *   whether this platform can show a tray icon now: Linux needs a
     *   StatusNotifierWatcher; Windows and macOS answer true when built
     */
    JS_SetPropertyStr(ctx, ctor, "Available",
                      JS_NewBool(ctx, bta_tray_backend.available()));
    /* CanMenu
     *   whether the platform can show the menu; false is a documented limit
     */
    JS_SetPropertyStr(ctx, ctor, "CanMenu",
                      JS_NewBool(ctx, bta_tray_backend.can_menu()));
    JS_SetPropertyStr(ctx, global, "Tray", ctor);
}

void bta_tray_init_worker(JSContext *ctx, JSValue global)
{
    JSValue ctor = JS_NewCFunction2(ctx, tray_worker_construct, "Tray", 1,
                                    JS_CFUNC_constructor, 0);

    JS_SetPropertyStr(ctx, global, "Tray", ctor);
}

void bta_tray_cleanup(void)
{
    if (!tray_current || !tray_current->visible)
        return;

    BtaApp *app = bta_current_app();

    bta_tray_backend.destroy(tray_current);
    tray_current->visible = false;
    if (app && app->gapp)
        g_application_release(G_APPLICATION(app->gapp));
}
