/*
 * Menus.
 *
 * GTK4 menus are built from a GMenu model wired to actions, not from widgets,
 * so a menu item is not a BtaWidget -- it is its own small object.  What makes
 * that worth it: registering the action with the application is also what
 * gives the item a real accelerator, and what makes the shortcut show up
 * beside the label.
 *
 * A form declares its menus in the .form file:
 *
 *   "menus": [
 *     { "name": "MnuFile", "text": "Archivo", "children": [
 *       { "name": "MnuSave", "text": "Guardar", "shortcut": "<Control>s" },
 *       { "separator": true },
 *       { "name": "MnuQuit", "text": "Salir" }
 *     ]}
 *   ]
 *
 * and handles them as MnuSave_Click(), like any other event.
 *
 * An item declared "dynamic" is a submenu whose entries are not in the .form
 * file -- the application assigns them at runtime:
 *
 *   { "name": "MnuRecent", "text": "Recientes", "dynamic": true }
 *
 *   this.MnuRecent.Items = ["uno", "dos"];   // MnuRecent_Click(index, text)
 *
 * A list of files opened recently, of open windows, of connected devices: what
 * they have in common is that the item count is data, so it cannot be declared.
 *
 * An item can also carry a state, which is what a tick in a menu is:
 *
 *   { "name": "MnuGrid", "text": "Show grid", "check": true }
 *
 *   this.MnuGrid.Value               // whether it is ticked
 *   MnuGrid_Click(on)                // ...and what it just became
 *
 * and a dynamic item declared "radio" marks the entry that was chosen and
 * remembers it, which is the one-of-several version of the same thing:
 *
 *   { "name": "MnuTheme", "text": "Theme", "dynamic": true, "radio": true }
 *
 *   this.MnuTheme.Items = ["Light", "Dark"];
 *   this.MnuTheme.Value = 1;         // Dark, ticked in the menu
 *   MnuTheme_Click(index, text)      // as any dynamic item's
 */
#include "bta.h"


/* Actions live in a per-window group so two forms can use the same names.
 * A context menu gets a group of its own, inserted on the widget rather than
 * on the window: nothing it declares can then shadow a menu bar action, and
 * two widgets may offer items of the same name. */
/* The one group a form's commands live in. Spelled once, in bta.h, because
 * a control binding to one has to name the same group the menu does. */
#define MENU_GROUP  BTA_ACTION_GROUP
#define POPUP_GROUP "popup"
/* A table's heading menu: its own group, inserted on the column view, because
 * the popover GTK builds lives on the column's title and resolves `header.` by
 * walking up from there. */
#define HEADER_GROUP "header"

JSClassID bta_menuitem_class_id;

/*
 * What kind of item it is, which is the whole of what differs between them: the
 * action's parameter type, whether it carries a state, and what a Click reports.
 * Everything else -- the name on the form, the dispatch, the accelerator -- is
 * the same for all four.
 */
typedef enum {
    ITEM_PLAIN,     /* a command */
    ITEM_CHECK,     /* a command that is on or off: boolean state, no parameter */
    ITEM_DYNAMIC,   /* many commands: the entry index is the parameter */
    ITEM_RADIO,     /* many, one of which is chosen: index parameter *and* state */
} BtaItemKind;

typedef struct {
    JSContext     *ctx;
    JSValue        form;      /* duplicated; reported via gc_mark */
    char          *name;
    GSimpleAction *action;
    char          *path;      /* "form.MnuSave": how a menu item names the action */
    BtaItemKind    kind;

    /*
     * The heading this item was built for, or -1 for every menu that is not a
     * table's heading menu.  A heading menu is built for each click, so the
     * value is the column that click was over and the handler's trailing
     * argument -- see `bta_menu_header_build`.
     */
    int            column;

    /* Which menu built it: the widget whose `Menu`/`HeaderMenu` this is, or the
     * form for its menu bar -- with `path`'s prefix, what tells rebuilding the
     * same menu from a second menu taking the name. Compared, never read. */
    const void    *owner;

    /* Dynamic items only: the submenu their entries are appended to, and the
     * labels last assigned, which is also what a Click reports back. */
    GMenu         *sub;
    JSValue        items;     /* array; duplicated, reported via gc_mark */
} BtaMenuItem;

/* ---------------------------------------------------- the form's commands */

/*
 * One action group per form, shared by its menu items, its `actions` and every
 * control bound to one.
 *
 * Shared because a command has one name: an accelerator, a menu item and a
 * button all resolve `form.ActDelete` in the same place, and GTK's own
 * `GtkActionable` is what makes a bound button follow the action's enabled
 * state without anything of ours propagating it. It used to be created here by
 * the menu builder and unreffed immediately -- fine while menus were the only
 * thing that needed one, and wrong the moment a form could have actions and no
 * menus at all.
 */
GSimpleActionGroup *bta_form_actions(BtaWidget *form)
{
    if (!form)
        return NULL;
    if (!form->actions) {
        form->actions = g_simple_action_group_new();
        gtk_widget_insert_action_group(form->gtk, MENU_GROUP,
                                       G_ACTION_GROUP(form->actions));
    }
    return form->actions;
}

bool bta_action_exists(BtaWidget *form, const char *name)
{
    if (!form || !form->actions || !name)
        return false;
    return g_action_map_lookup_action(G_ACTION_MAP(form->actions), name) != NULL;
}

/*
 * An `Action`: a named command with a label, an icon, a key and an enabled
 * state, that a button and a menu item both point at.
 *
 * It is a menu item's action **without the menu item**, which is why it lives
 * here: the plumbing is the same `GSimpleAction` in the same group, and the only
 * thing it does not have is a place in a `GMenu`.
 *
 * `Text`, `Icon` and `Shortcut` are **read-only**: they are what the `.form`
 * declared, applied to a control when it binds, and the catalogue translates the
 * label once. Nothing needs to relabel a command at run time -- the IDE's
 * Run and Stop are two commands and not one that renames itself -- so a live
 * `Text` would be machinery with no caller, and a settable one that did nothing
 * after the build would be a trap.
 *
 * `Enabled` is the opposite, and is the whole reason this exists: it is live,
 * and every control bound to the action follows it because GTK's own
 * `GtkActionable` says so.
 */
typedef struct {
    JSContext     *ctx;
    JSValue        form;      /* duplicated; reported via gc_mark */
    char          *name;
    GSimpleAction *action;    /* owned by the group, not by this */
    char          *path;      /* "form.ActDelete" */
    char          *text;
    char          *icon;
} BtaAction;

static JSClassID bta_action_class_id;

static void action_finalizer(JSRuntime *rt, JSValue val)
{
    BtaAction *a = JS_GetOpaque(val, bta_action_class_id);

    if (!a)
        return;
    /* The group holds the action too and outlives this wrapper whenever the
     * form's name is rebound, so its `activate` must stop pointing at `a`. */
    if (a->action) {
        g_signal_handlers_disconnect_by_data(a->action, a);
        g_clear_object(&a->action);
    }
    JS_FreeValueRT(rt, a->form);
    g_free(a->icon);
    g_free(a->text);
    g_free(a->path);
    g_free(a->name);
    g_free(a);
}

static void action_gc_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark)
{
    BtaAction *a = JS_GetOpaque(val, bta_action_class_id);

    if (a)
        JS_MarkValue(rt, a->form, mark);
}

static const JSClassDef action_class_def = {
    "Action",
    .finalizer = action_finalizer,
    .gc_mark   = action_gc_mark,
};

/*
 * The label and the icon of a command, onto the control that just bound to it.
 *
 * **Only where the control declared neither**, which is what lets the IDE's
 * toolbar stay icons and its Edit menu stay words while both name one command --
 * and what lets a form written before actions existed bind without being
 * relaid-out. Assigned through the ordinary setters, so a control that has no
 * `Icon` says so itself rather than this having to know which do.
 */
void bta_action_dress(JSContext *ctx, BtaWidget *form, const char *name,
                      JSValueConst control)
{
    if (!form || !form->actions)
        return;

    JSValue held = JS_GetPropertyStr(ctx, form->self, name);
    BtaAction *a = JS_GetOpaque(held, bta_action_class_id);

    if (a) {
        /*
         * **A control that declared an icon is an icon control, and stays
         * one.** A toolbar button is 34 pixels of `Style: "flat"` with a
         * picture in it; handing it the command's label as well would make it
         * as wide as the words and take the toolbar apart. So an icon
         * suppresses the label, and a control that declared *neither* gets
         * both -- which is what a menu-shaped button wants.
         */
        JSValue  had  = JS_GetPropertyStr(ctx, control, "Icon");
        const char *s = JS_IsString(had) ? JS_ToCString(ctx, had) : NULL;
        bool  iconic  = s && *s;

        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, had);

        for (int i = 0; i < 2; i++) {
            const char *key  = i ? "Icon" : "Text";
            const char *want = i ? a->icon : a->text;

            if (!want || !*want)
                continue;
            if (!i && iconic)
                continue;

            JSValue has = JS_GetPropertyStr(ctx, control, key);
            const char *now = JS_IsString(has) ? JS_ToCString(ctx, has) : NULL;
            bool empty = now && !*now;

            JS_FreeCString(ctx, now);
            JS_FreeValue(ctx, has);

            if (empty) {
                JSValue given = JS_NewString(ctx, want);

                JS_SetPropertyStr(ctx, control, key, JS_DupValue(ctx, given));
                /* Declared nothing, applied the command's -- so the serialiser
                 * writes nothing back and the command stays the one place the
                 * label lives. A program that assigns its own afterwards makes
                 * the note stale and wins, which is what makes this
                 * self-correcting. */
                JSValue none = JS_NewString(ctx, "");
                bta_note_declared(ctx, control, key, none, given);
                JS_FreeValue(ctx, none);
                JS_FreeValue(ctx, given);
            }
        }
    }
    JS_FreeValue(ctx, held);
}

static BtaAction *action_this(JSContext *ctx, JSValueConst this_val)
{
    BtaAction *a = JS_GetOpaque2(ctx, this_val, bta_action_class_id);

    if (!a)
        JS_ThrowTypeError(ctx, "not an Action");
    return a;
}

static JSValue action_get_name(JSContext *ctx, JSValueConst this_val)
{
    BtaAction *a = action_this(ctx, this_val);
    return a ? JS_NewString(ctx, a->name) : JS_EXCEPTION;
}

static JSValue action_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaAction *a = action_this(ctx, this_val);
    return a ? JS_NewString(ctx, a->text ? a->text : "") : JS_EXCEPTION;
}

static JSValue action_get_icon(JSContext *ctx, JSValueConst this_val)
{
    BtaAction *a = action_this(ctx, this_val);
    return a ? JS_NewString(ctx, a->icon ? a->icon : "") : JS_EXCEPTION;
}

static JSValue action_get_enabled(JSContext *ctx, JSValueConst this_val)
{
    BtaAction *a = action_this(ctx, this_val);
    if (!a)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, g_action_get_enabled(G_ACTION(a->action)));
}

static JSValue action_set_enabled(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaAction *a = action_this(ctx, this_val);
    if (!a)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    /* One assignment, and every button, menu item and accelerator naming this
     * command follows -- a disabled action loses its accelerator too, which is
     * the same fact a disabled menu item already relied on. */
    g_simple_action_set_enabled(a->action, b);
    return JS_UNDEFINED;
}

/* Pressed from code, so a test can invoke a command without a pointer -- the
 * same thing `MenuItem.Click()` is for. */
static JSValue action_click(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaAction *a = action_this(ctx, this_val);
    if (!a)
        return JS_EXCEPTION;

    if (!g_action_get_enabled(G_ACTION(a->action)))
        return JS_ThrowTypeError(ctx, "%s is disabled", a->name);

    g_action_activate(G_ACTION(a->action), NULL);
    return JS_UNDEFINED;
}

/* ------------------------------------------------- what these two classes have
 *
 * A menu item and a command are not widgets, so `Widget.New` cannot make one to
 * ask and neither can anything else: the only way to get one is to declare it in
 * a `.form`.  That left the IDE with nothing to look up -- `this.MnuSave.`
 * proposed nothing and `MnuSave_Clik()` went unremarked -- while every control
 * beside them answered for itself.
 *
 * So they answer the two questions a control answers, and **out of the tables
 * below rather than out of a second list**: the names come from the
 * `JSCFunctionListEntry` array that defines them, so a property added there is
 * one this reports with nothing else touched.  Settable ones only, which is what
 * `Widget.PropertyNames()` means by the word -- `Name` is read-only and a
 * property grid could do nothing with it.
 */
static JSValue members_of(JSContext *ctx, const JSCFunctionListEntry *tab, int n)
{
    JSValue  out = JS_NewArray(ctx);
    uint32_t k   = 0;

    for (int i = 0; i < n; i++) {
        if (tab[i].def_type != JS_DEF_CGETSET)
            continue;
        if (!tab[i].u.getset.set.setter)
            continue;                      /* read-only: nothing can assign it */
        JS_SetPropertyUint32(ctx, out, k++, JS_NewString(ctx, tab[i].name));
    }
    return out;
}

/* One event, and it is the one every item and every command raises: choosing
 * it.  Written here because it is emitted here -- `on_menu_activate` and
 * `on_action_activate` are the two calls, and both say "Click". */
static JSValue click_only(JSContext *ctx)
{
    JSValue out = JS_NewArray(ctx);

    JS_SetPropertyUint32(ctx, out, 0, JS_NewString(ctx, "Click"));
    return out;
}

static JSValue menuitem_property_names(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv);
static JSValue menuitem_event_names(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);
static JSValue action_property_names(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv);
static JSValue action_event_names(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv);

static const JSCFunctionListEntry action_props[] = {
    JS_CGETSET_DEF("Name",    action_get_name,    NULL),
    JS_CGETSET_DEF("Text",    action_get_text,    NULL),
    JS_CGETSET_DEF("Icon",    action_get_icon,    NULL),
    JS_CGETSET_DEF("Enabled", action_get_enabled, action_set_enabled),
    JS_CFUNC_DEF("Click", 0, action_click),
    JS_CFUNC_DEF("PropertyNames", 0, action_property_names),
    JS_CFUNC_DEF("EventNames",    0, action_event_names),
};

static JSValue action_property_names(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    return members_of(ctx, action_props, (int)G_N_ELEMENTS(action_props));
}

static JSValue action_event_names(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    return click_only(ctx);
}

static void on_action_activate(GSimpleAction *action, GVariant *param,
                               gpointer user_data)
{
    BtaAction *a = user_data;

    JS_FreeValue(a->ctx, bta_emit_on(a->ctx, a->form, a->name, "Click", 0, NULL));
}

/* ------------------------------------------------------------- JS class */

static void menuitem_finalizer(JSRuntime *rt, JSValue val)
{
    BtaMenuItem *mi = JS_GetOpaque(val, bta_menuitem_class_id);
    if (!mi)
        return;

    JS_FreeValueRT(rt, mi->form);
    JS_FreeValueRT(rt, mi->items);

    /*
     * **The action outlives this wrapper**: the popup's or the bar's group
     * holds it, and the wrapper goes as soon as the form's name is bound to
     * another -- which a heading menu does on every right click, and two menus
     * sharing an item name do the first time the second is built. Leaving the
     * handler connected left the menu bar's `form.MnuCopy` activating a freed
     * `mi`. Disconnected, the orphaned action does nothing, which is the truth
     * about an item nothing can reach any more.
     */
    if (mi->action)
        g_signal_handlers_disconnect_by_data(mi->action, mi);
    g_clear_object(&mi->action);
    g_clear_object(&mi->sub);
    g_free(mi->path);
    g_free(mi->name);
    g_free(mi);
}

static void menuitem_gc_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    BtaMenuItem *mi = JS_GetOpaque(val, bta_menuitem_class_id);
    if (mi) {
        JS_MarkValue(rt, mi->form, mark_func);
        JS_MarkValue(rt, mi->items, mark_func);
    }
}

static const JSClassDef menuitem_class_def = {
    "MenuItem",
    .finalizer = menuitem_finalizer,
    .gc_mark   = menuitem_gc_mark,
};

static BtaMenuItem *menuitem_this(JSContext *ctx, JSValueConst this_val)
{
    BtaMenuItem *mi = JS_GetOpaque(this_val, bta_menuitem_class_id);
    if (!mi)
        JS_ThrowTypeError(ctx, "not a menu item");
    return mi;
}

static JSValue menuitem_get_name(JSContext *ctx, JSValueConst this_val)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    return mi ? JS_NewString(ctx, mi->name) : JS_EXCEPTION;
}

static JSValue menuitem_get_enabled(JSContext *ctx, JSValueConst this_val)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    if (!mi)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, g_action_get_enabled(G_ACTION(mi->action)));
}

static JSValue menuitem_set_enabled(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    if (!mi)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    /* Disabling the action greys the item out *and* kills its accelerator, so
     * a shortcut can never reach a command the UI says is unavailable. */
    g_simple_action_set_enabled(mi->action, b);
    return JS_UNDEFINED;
}

static JSValue menuitem_get_items(JSContext *ctx, JSValueConst this_val)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    if (!mi)
        return JS_EXCEPTION;
    return JS_DupValue(ctx, mi->items);
}

/*
 * GTK reads "_" in a menu label as the mnemonic marker, and a doubled one as a
 * literal underscore.  A declared label wants that ("_Archivo"), but a dynamic
 * entry's label is *data* -- a file name, a project directory -- and a project
 * called foo_bar has to read as foo_bar and not as foobar.
 */
static char *escape_mnemonics(const char *s)
{
    GString *out = g_string_new(NULL);

    for (const char *p = s; *p; p++) {
        if (*p == '_')
            g_string_append_c(out, '_');
        g_string_append_c(out, *p);
    }
    return g_string_free_and_steal(out);
}

/*
 * Rebuilds the submenu from an array of labels.  Every entry activates the same
 * action, told apart by its target value -- the index -- which is what the
 * Click handler receives.  So the entries need no names of their own, and the
 * list can change size without anything being declared anywhere.
 */
static JSValue menuitem_set_items(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    if (!mi)
        return JS_EXCEPTION;
    if (!mi->sub)
        return JS_ThrowTypeError(ctx, "%s has no Items: declare it \"dynamic\": true",
                                 mi->name);
    if (!JS_IsArray(val))
        return JS_ThrowTypeError(ctx, "%s.Items expects an array of labels", mi->name);

    JSValue  lenv = JS_GetPropertyStr(ctx, val, "length");
    uint32_t n    = 0;
    int      rc   = JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);
    if (rc < 0)
        return JS_EXCEPTION;

    /*
     * Converted before the menu is touched: a label that cannot become text is
     * a refusal, and refusing after `g_menu_remove_all` would leave a menu
     * half rebuilt -- the `AddNode` trap, on a menu.
     */
    char **labels = g_new0(char *, n + 1);
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, val, i);
        const char *s = JS_ToCString(ctx, e);

        if (!s) {
            JS_FreeValue(ctx, e);
            g_strfreev(labels);        /* zeroed, so it stops at the first NULL */
            return JS_EXCEPTION;       /* it threw on the way; that stands */
        }
        labels[i] = escape_mnemonics(s);
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
    }

    g_menu_remove_all(mi->sub);

    for (uint32_t i = 0; i < n; i++) {
        GMenuItem *item = g_menu_item_new(labels[i], NULL);

        g_menu_item_set_action_and_target_value(item, mi->path,
                                                g_variant_new_int32((gint32)i));
        g_menu_append_item(mi->sub, item);
        g_object_unref(item);
    }
    g_strfreev(labels);

    JS_FreeValue(ctx, mi->items);
    mi->items = JS_DupValue(ctx, val);
    return JS_UNDEFINED;
}

/* Presses the item from code, exactly as choosing it would. */
static JSValue menuitem_click(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    if (!mi)
        return JS_EXCEPTION;

    if (!g_action_get_enabled(G_ACTION(mi->action)))
        return JS_UNDEFINED;

    /* A dynamic item is not one command but many, so which entry has to be
     * said: Click(index), the same index the handler would be given. */
    GVariant *param = NULL;
    if (mi->sub) {
        int32_t i = 0;
        if (argc > 0 && JS_ToInt32(ctx, &i, argv[0]))
            return JS_EXCEPTION;
        param = g_variant_new_int32(i);
    }

    g_action_activate(G_ACTION(mi->action), param);
    return JS_UNDEFINED;
}

/*
 * The tick, or which entry is ticked.  Boolean for a check item and the entry
 * index for a radio one -- the same word for the same question, "which of the
 * choices is it on", where a check item's choices are two.
 *
 * Assigning it does not fire Click: restoring a setting at startup would run the
 * command it stands for, and nobody chose anything.  Click() is how a program
 * chooses on purpose.
 */
/*
 * **`Value` here and `Active` on a widget**, and the difference is not an
 * oversight: on a `CheckButton` the property is a boolean and nothing else, so
 * it is called what GTK calls it. On a menu item it is a boolean for a tick and
 * the *chosen index* for a set of radio entries -- one name over two types,
 * which is what `Value` has always meant here. Splitting it into an `Active` for
 * the one and a `Chosen` for the other is a coherent thing to want and a change
 * to the menu model rather than to the widget vocabulary, so it is not made in
 * passing.
 */
static JSValue menuitem_get_value(JSContext *ctx, JSValueConst this_val)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    if (!mi)
        return JS_EXCEPTION;

    GVariant *state = g_action_get_state(G_ACTION(mi->action));
    if (!state)
        return JS_ThrowTypeError(ctx, "%s has no Value: declare it "
                                      "\"check\": true, or \"radio\": true "
                                      "if it is dynamic", mi->name);

    JSValue out = mi->kind == ITEM_CHECK
                      ? JS_NewBool(ctx, g_variant_get_boolean(state))
                      : JS_NewInt32(ctx, g_variant_get_int32(state));
    g_variant_unref(state);
    return out;
}

static JSValue menuitem_set_value(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaMenuItem *mi = menuitem_this(ctx, this_val);
    if (!mi)
        return JS_EXCEPTION;

    if (mi->kind == ITEM_CHECK) {
        int b = JS_ToBool(ctx, val);
        if (b < 0)
            return JS_EXCEPTION;
        g_simple_action_set_state(mi->action, g_variant_new_boolean(b));
        return JS_UNDEFINED;
    }

    if (mi->kind == ITEM_RADIO) {
        int32_t i;
        if (!bta_to_int(ctx, val, "Value", &i))
            return JS_EXCEPTION;
        /* Out of range is how "none of them" is said: no entry carries it, so
         * nothing is ticked, which is what an empty choice looks like. */
        g_simple_action_set_state(mi->action, g_variant_new_int32(i));
        return JS_UNDEFINED;
    }

    return JS_ThrowTypeError(ctx, "%s has no Value: declare it \"check\": true, "
                                  "or \"radio\": true if it is dynamic", mi->name);
}

static const JSCFunctionListEntry menuitem_props[] = {
    JS_CGETSET_DEF("Name",    menuitem_get_name,    NULL),
    JS_CGETSET_DEF("Enabled", menuitem_get_enabled, menuitem_set_enabled),
    JS_CGETSET_DEF("Items",   menuitem_get_items,   menuitem_set_items),
    JS_CGETSET_DEF("Value",   menuitem_get_value,   menuitem_set_value),
    JS_CFUNC_DEF("Click", 1, menuitem_click),
    JS_CFUNC_DEF("PropertyNames", 0, menuitem_property_names),
    JS_CFUNC_DEF("EventNames",    0, menuitem_event_names),
};

static JSValue menuitem_property_names(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    return members_of(ctx, menuitem_props, (int)G_N_ELEMENTS(menuitem_props));
}

static JSValue menuitem_event_names(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    return click_only(ctx);
}

/* ---------------------------------------------------------------- build */

static void on_menu_activate(GSimpleAction *action, GVariant *param, gpointer user_data)
{
    BtaMenuItem *mi   = user_data;
    JSContext   *ctx  = mi->ctx;
    JSValue      argv[3];
    int          argc = 0;

    /*
     * A stateful action does not change its own state once something handles
     * `activate`: GLib hands the decision to the handler, which is this.  So the
     * tick is moved here -- before the handler runs, so a handler that reads
     * `this.MnuGrid.Value` sees what the user just chose and not what it was.
     */
    if (mi->kind == ITEM_CHECK) {
        GVariant *was = g_action_get_state(G_ACTION(action));
        gboolean  now = !g_variant_get_boolean(was);

        g_variant_unref(was);
        g_simple_action_set_state(action, g_variant_new_boolean(now));

        argv[0] = JS_NewBool(ctx, now);
        argc    = 1;
    }
    /* Dynamic entries carry their index; the label goes along with it, so a
     * handler that only cares what was chosen does not have to index back. */
    else if (param && g_variant_is_of_type(param, G_VARIANT_TYPE_INT32)) {
        int32_t i = g_variant_get_int32(param);

        if (mi->kind == ITEM_RADIO)
            g_simple_action_set_state(action, g_variant_new_int32(i));

        argv[0] = JS_NewInt32(ctx, i);
        argv[1] = JS_GetPropertyUint32(ctx, mi->items, (uint32_t)i);
        argc    = 2;
    }

    /*
     * A heading menu's item is told which column it was opened over, last and
     * after whatever its kind already carries: `Click(column)`, `Click(on,
     * column)`, `Click(index, text, column)`.
     */
    if (mi->column >= 0)
        argv[argc++] = JS_NewInt32(ctx, mi->column);

    JS_FreeValue(ctx, bta_emit_on(ctx, mi->form, mi->name, "Click", argc, argv));

    for (int i = 0; i < argc; i++)
        JS_FreeValue(ctx, argv[i]);
}

static bool spec_bool(JSContext *ctx, JSValueConst spec, const char *key)
{
    JSValue v = JS_GetPropertyStr(ctx, spec, key);
    bool    b = JS_ToBool(ctx, v) > 0;
    JS_FreeValue(ctx, v);
    return b;
}

static char *spec_str(JSContext *ctx, JSValueConst spec, const char *key)
{
    JSValue v   = JS_GetPropertyStr(ctx, spec, key);
    char   *out = NULL;

    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        out = g_strdup(s);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, v);
    return out;
}

/*
 * "shortcut" may be one accelerator or a list of them.  More than one is
 * routinely necessary: desktops grab bare function keys (Xfce takes F2 for its
 * application finder), so a command needs an alternative that survives.
 */
static void set_accels(const char *action, JSContext *ctx, JSValueConst spec)
{
    BtaApp *app = bta_current_app();
    if (!app || !app->gapp)
        return;

    JSValue value = JS_GetPropertyStr(ctx, spec, "shortcut");
    GPtrArray *accels = g_ptr_array_new_with_free_func(g_free);

    if (JS_IsString(value)) {
        const char *s = JS_ToCString(ctx, value);
        if (s && *s)
            g_ptr_array_add(accels, g_strdup(s));
        JS_FreeCString(ctx, s);
    } else if (JS_IsArray(value)) {
        JSValue  lenv = JS_GetPropertyStr(ctx, value, "length");
        uint32_t n    = 0;
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);

        for (uint32_t i = 0; i < n; i++) {
            JSValue     e = JS_GetPropertyUint32(ctx, value, i);
            const char *s = JS_ToCString(ctx, e);
            if (s && *s)
                g_ptr_array_add(accels, g_strdup(s));
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, e);
        }
    }
    JS_FreeValue(ctx, value);

    if (accels->len > 0) {
        g_ptr_array_add(accels, NULL);
        gtk_application_set_accels_for_action(app->gapp, action,
                                              (const char * const *)accels->pdata);
    }
    g_ptr_array_unref(accels);
}

/*
 * Creates the action behind an item and exposes it on the form by name.  A
 * dynamic item's action takes the entry index as its parameter; a plain one
 * takes none, which is also the only kind an accelerator can name.
 */
/*
 * The `actions` block: one command per entry, exposed on the form by name.
 *
 * Before the menus and before the children, because both may name one -- and a
 * name that is not there is refused where it is written rather than doing
 * nothing when it is pressed.
 */
int bta_actions_build(JSContext *ctx, JSValueConst form_obj, BtaWidget *w,
                      JSValueConst actions)
{
    if (!JS_IsArray(actions))
        return 0;

    /*
     * Kept as it was read, for the same reason the menus are: a `GSimpleAction`
     * cannot be walked back into a declaration, so without this the serialiser
     * would drop a form's commands on the first save.
     */
    JSValue *held = bta_widget_note(w, BTA_NOTE_ACTIONS);
    JS_FreeValue(ctx, *held);
    *held = JS_DupValue(ctx, actions);

    GSimpleActionGroup *group = bta_form_actions(w);
    JSValue             lenv  = JS_GetPropertyStr(ctx, actions, "length");
    uint32_t            n     = 0;

    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    for (uint32_t i = 0; i < n; i++) {
        JSValue spec = JS_GetPropertyUint32(ctx, actions, i);
        char   *name = spec_str(ctx, spec, "name");

        if (!name || !*name) {
            g_free(name);
            JS_FreeValue(ctx, spec);
            return JS_ThrowTypeError(ctx, "actions[%u] has no name: a command is "
                                          "named so a control can point at it", i),
                   -1;
        }

        /* `g_strdup` and not the pointer itself: a bind that is refused frees
         * the wrapper, the wrapper owns `a`, and `a` would take this name with
         * it -- leaving nothing to say in the message. The loop owns `name`
         * and frees it on every way out. */
        BtaAction *a = g_new0(BtaAction, 1);
        a->ctx   = ctx;
        a->form  = JS_DupValue(ctx, form_obj);
        a->name  = g_strdup(name);
        a->path  = g_strdup_printf("%s.%s", MENU_GROUP, name);
        a->text  = spec_str(ctx, spec, "text");
        a->icon  = spec_str(ctx, spec, "icon");

        /* Prose, so the catalogue translates a command's label **once** however
         * many places show it -- which is half of what this is for. */
        if (a->text) {
            const char *said = bta_locale_lookup(NULL, a->text);
            if (said) {
                g_free(a->text);
                a->text = g_strdup(said);
            }
        }

        JSValue obj = JS_NewObjectClass(ctx, bta_action_class_id);
        if (JS_IsException(obj)) {
            JS_FreeValue(ctx, a->form);
            g_free(a->icon); g_free(a->text); g_free(a->path); g_free(a->name);
            g_free(a);
            g_free(name);
            JS_FreeValue(ctx, spec);
            return -1;
        }
        JS_SetPropertyFunctionList(ctx, obj, action_props,
                                   (int)G_N_ELEMENTS(action_props));
        JS_SetOpaque(obj, a);
        /* Built: under `--strict` a command refuses a name it does not have,
         * the same as a control. */
        bta_strict_seal(ctx, obj);

        /*
         * form.ActDelete = <command>, **and the answer is looked at.**
         *
         * The same silence a control had until `bta_form.c` started checking
         * this line, and for the same reason: `Actions`, `Menus`, `Controls`,
         * `DefaultButton` and `CancelButton` are getters on `Form` with no
         * setter, so the assignment fails and the command binds to nothing --
         * `ActDelete_Click` never fires, `this.ActDelete.Enabled` reaches the
         * wrong object, and the form loads as if all were well. A menu item and
         * a command are bound on the form by name exactly as a control is, so
         * they were exactly as quiet about it.
         *
         * **Nothing is wired until the name is ours**, which is why the action
         * is built below this and not above it: a refused bind frees the
         * wrapper, and a wrapper freed after `g_action_map_add_action` would
         * leave the group holding a handler that points at freed memory. The
         * order is what makes that impossible rather than something to undo.
         */
        if (JS_SetPropertyStr(ctx, form_obj, name, obj) < 0) {
            fprintf(stderr, "bintana: action '%s': a Form already has a member "
                            "of that name, so nothing can reach this command\n",
                    name);
            g_free(name);
            JS_FreeValue(ctx, spec);
            return -1;
        }

        a->action = g_simple_action_new(name, NULL);
        g_signal_connect(a->action, "activate",
                         G_CALLBACK(on_action_activate), a);
        g_action_map_add_action(G_ACTION_MAP(group), G_ACTION(a->action));

        set_accels(a->path, ctx, spec);

        /* Declared disabled is a real state: a command that needs a selection
         * has none when the window opens. */
        JSValue on = JS_GetPropertyStr(ctx, spec, "enabled");
        if (!JS_IsUndefined(on))
            g_simple_action_set_enabled(a->action, JS_ToBool(ctx, on));
        JS_FreeValue(ctx, on);

        g_free(name);
        JS_FreeValue(ctx, spec);
    }
    return 0;
}

/* The menu being built right now. Set by the three entry points around their
 * `build_items`, which never nests one of them inside another. */
static const void *building_owner;

static BtaMenuItem *make_item(JSContext *ctx, JSValueConst form, const char *name,
                              JSValueConst spec, GSimpleActionGroup *group,
                              const char *prefix, BtaItemKind kind, int column)
{
    bool many = kind == ITEM_DYNAMIC || kind == ITEM_RADIO;

    BtaMenuItem *mi = g_new0(BtaMenuItem, 1);
    mi->ctx    = ctx;
    mi->form   = JS_DupValue(ctx, form);
    mi->items  = JS_NewArray(ctx);
    mi->name   = g_strdup(name);
    mi->path   = g_strdup_printf("%s.%s", prefix, name);
    mi->kind   = kind;
    mi->column = column;
    mi->owner  = building_owner;

    /*
     * **A name on the form belongs to one thing.** An item is published as
     * `form[name]`, so a second menu declaring the same name *replaced* the
     * first menu's wrapper: that item went dead (and, until its finaliser
     * disconnected the action, ran its handler on freed memory), and
     * `this.MnuCopy` answered for whichever menu was built last. The same
     * assignment would overwrite a control, a command or a method. So it is
     * refused, and the refusal says what sharing is for: one command declared
     * in `actions`, and an item in each menu pointing at it. Rebuilding the
     * *same* menu -- a heading menu on every right click, `Menu` assigned
     * again -- is its own name coming back, and passes.
     */
    JSValue cur = JS_GetPropertyStr(ctx, form, name);
    if (JS_IsException(cur)) {
        g_free(mi->path); g_free(mi->name);
        JS_FreeValue(ctx, mi->form); JS_FreeValue(ctx, mi->items);
        g_free(mi);
        return NULL;
    }
    if (!JS_IsUndefined(cur)) {
        BtaMenuItem *old  = JS_GetOpaque(cur, bta_menuitem_class_id);
        const char  *dot  = old ? strrchr(old->path, '.') : NULL;
        bool         same = old && old->owner == building_owner && dot &&
                            (size_t)(dot - old->path) == strlen(prefix) &&
                            !strncmp(old->path, prefix, strlen(prefix));

        JS_FreeValue(ctx, cur);
        if (!same) {
            JS_ThrowTypeError(ctx,
                "menu item '%s': the form already has %s of that name -- a name "
                "on the form belongs to one thing. To offer one command in "
                "several menus, declare it once in `actions` and point each "
                "item at it with { \"action\": \"...\" }",
                name, old ? "an item in another menu" : "a member");
            g_free(mi->path); g_free(mi->name);
            JS_FreeValue(ctx, mi->form); JS_FreeValue(ctx, mi->items);
            g_free(mi);
            return NULL;
        }
    }

    /*
     * The parameter type says how many commands the item is, and the state says
     * whether it remembers an answer.  Which of the two GTK reads to decide
     * between a tick, a radio mark and nothing at all -- so declaring the action
     * correctly is the whole of drawing it correctly.
     */
    const GVariantType *takes = many ? G_VARIANT_TYPE_INT32 : NULL;

    JSValue obj = JS_NewObjectClass(ctx, bta_menuitem_class_id);
    if (JS_IsException(obj)) {
        JS_FreeValue(ctx, mi->form);
        JS_FreeValue(ctx, mi->items);
        g_free(mi->path);
        g_free(mi->name);
        g_free(mi);
        return NULL;
    }
    JS_SetPropertyFunctionList(ctx, obj, menuitem_props,
                               (int)G_N_ELEMENTS(menuitem_props));
    JS_SetOpaque(obj, mi);
    bta_strict_seal(ctx, obj);

    /*
     * form.MnuSave, so handlers can enable and disable it -- **and the answer
     * is looked at.**
     *
     * The same silence a control had until `bta_form.c` started checking this
     * line, and this is the same line: an item named `Actions`, `Menus`,
     * `Controls`, `DefaultButton` or `CancelButton` lands on a getter of `Form`
     * that has no setter, the assignment fails, and the item binds to nothing.
     * `MnuActions_Click` never fires and `this.MnuActions` answers the *form's*
     * action list. A menu item is bound on the form by name exactly as a
     * control is, so it was exactly as quiet about it.
     *
     * **Nothing is wired until the name is ours**, which is why the action is
     * built below this and not above it: a refused bind frees the wrapper, the
     * wrapper owns `mi`, and an action already in the group would be left
     * holding a handler that points at freed memory. The order is what makes
     * that impossible rather than something to undo. `name` is the caller's, so
     * it outlives the wrapper and there is still something to say.
     */
    if (JS_SetPropertyStr(ctx, form, name, obj) < 0) {
        fprintf(stderr, "bintana: menu item '%s': a Form already has a member "
                        "of that name, so nothing can reach this item\n", name);
        return NULL;
    }

    if (kind == ITEM_CHECK) {
        mi->action = g_simple_action_new_stateful(name, takes,
                                                 g_variant_new_boolean(FALSE));
    } else if (kind == ITEM_RADIO) {
        /* -1 is an index no entry has, so nothing is ticked until something is
         * chosen -- a list of themes with none of them on yet. */
        mi->action = g_simple_action_new_stateful(name, takes,
                                                 g_variant_new_int32(-1));
    } else {
        mi->action = g_simple_action_new(name, takes);
    }

    g_signal_connect(mi->action, "activate", G_CALLBACK(on_menu_activate), mi);
    g_action_map_add_action(G_ACTION_MAP(group), G_ACTION(mi->action));

    /*
     * A spec may declare the item disabled, which is the state a command's
     * `enabled` already is (`bta_actions_build`) -- and it is what lets a menu
     * built for the moment say *this cannot be done now* without leaving the
     * entry out: the last column of a table cannot be hidden, and a menu that
     * loses a row as the state changes is a menu the eye has to re-read.
     */
    JSValue on = JS_GetPropertyStr(ctx, spec, "enabled");
    if (!JS_IsUndefined(on))
        g_simple_action_set_enabled(mi->action, JS_ToBool(ctx, on));
    JS_FreeValue(ctx, on);

    /* An accelerator can only name a command that takes no argument, so the two
     * that are many commands have none: which entry would it press? */
    if (!many)
        set_accels(mi->path, ctx, spec);
    return mi;
}

static GMenu *build_items(JSContext *ctx, JSValueConst form, JSValueConst arr,
                          GSimpleActionGroup *group, const char *prefix,
                          int column);

static bool append_item(JSContext *ctx, JSValueConst form, GMenu *section,
                        JSValueConst spec, GSimpleActionGroup *group,
                        const char *prefix, int column)
{
    char *text = spec_str(ctx, spec, "text");
    char *name = spec_str(ctx, spec, "name");
    bool  ok   = false;

    /*
     * A menu label is prose declared in the .form, so it goes through the
     * catalogue like a control's Text -- which cannot be said with
     * BtaClass.texts, because a menu item is not a widget and has no class.
     *
     * The mnemonic survives on purpose: a `_` in a label marks the letter GTK
     * underlines, and the translation carries its own -- which letter to
     * underline in "_Archivo" is the translator's decision and not this
     * runtime's.  (The labels of a `dynamic` item are data and are doubled
     * elsewhere for exactly the opposite reason.)
     */
    if (text) {
        const char *found = bta_locale_lookup(NULL, text);
        if (found) {
            g_free(text);
            text = g_strdup(found);
        }
    }

    JSValue kids = JS_GetPropertyStr(ctx, spec, "children");
    if (JS_IsArray(kids)) {
        GMenu *sub = build_items(ctx, form, kids, group, prefix, column);
        if (sub) {
            g_menu_append_submenu(section, text ? text : "", G_MENU_MODEL(sub));
            g_object_unref(sub);
            ok = true;
        }
        JS_FreeValue(ctx, kids);
        goto out;
    }
    JS_FreeValue(ctx, kids);

    /*
     * An item that names an **action** is a place a command appears, and not a
     * command of its own: no `GSimpleAction`, no name on the form, nothing to
     * enable. The command is the object, and one assignment to its `Enabled`
     * greys out the toolbar button, the Edit menu and both context menus at
     * once.
     *
     * It is also what makes the second and third copy of a command *nameless*.
     * The IDE has `MnuDel`, `MnuCvDel` and `MnuTrDel` because "two widgets
     * cannot both own MnuDel" -- its own comment -- and pointing at an action
     * removes the reason for the second and third name entirely.
     *
     * The label is the action's unless the item gives its own, which is the same
     * rule a bound control follows.
     */
    char *points_at = spec_str(ctx, spec, "action");

    if (points_at) {
        if (name) {
            JS_ThrowTypeError(ctx, "menu: %s has both a \"name\" and an "
                                   "\"action\" -- an item that points at a "
                                   "command is not one, so it needs no name of "
                                   "its own", name);
            g_free(points_at);
            goto out;
        }
        /* And it takes the command's `Enabled`, so an `enabled` of its own
         * would be a value nothing reads: the item has no action to disable. */
        JSValue off = JS_GetPropertyStr(ctx, spec, "enabled");
        bool    has = !JS_IsUndefined(off);
        JS_FreeValue(ctx, off);

        if (has) {
            JS_ThrowTypeError(ctx, "menu: '%s' has both an \"action\" and an "
                                   "\"enabled\" -- the command is the object, "
                                   "and one assignment to its Enabled greys "
                                   "every place it appears", points_at);
            g_free(points_at);
            goto out;
        }
        /*
         * **Looked up in the form's group and not in this menu's**, and named
         * with the form's prefix whatever menu it appears in: a command belongs
         * to the form, so `{ "action": "ActDelete" }` in a context menu means
         * *that* command and not a second one of the same name. A popover has
         * its own group for its own items, and GTK resolves `form.` by walking
         * up from wherever the popover is parented.
         */
        BtaWidget *owner = bta_widget_of(form);

        if (!bta_action_exists(owner, points_at)) {
            JS_ThrowRangeError(ctx, "menu: '%s' is not one of this form's "
                                    "actions", points_at);
            g_free(points_at);
            goto out;
        }

        char      *path = g_strdup_printf("%s.%s", BTA_ACTION_GROUP, points_at);
        GMenuItem *item = g_menu_item_new(text ? text : "", path);

        /* No label of its own: take the command's, translated once where the
         * command was declared. */
        if (!text) {
            JSValue    held = JS_GetPropertyStr(ctx, form, points_at);
            BtaAction *a    = JS_GetOpaque(held, bta_action_class_id);

            if (a && a->text)
                g_menu_item_set_label(item, a->text);
            JS_FreeValue(ctx, held);
        }
        g_menu_append_item(section, item);
        g_object_unref(item);
        g_free(path);
        g_free(points_at);
        ok = true;
        goto out;
    }

    if (!name) {
        JS_ThrowTypeError(ctx, "menu: an item needs a \"name\", an \"action\" "
                               "or \"children\"");
        goto out;
    }

    /*
     * "radio" only means something on a dynamic item: the entries it marks are
     * the entries it was given, and a lone item with a mark of its own is what
     * "check" already is.  Saying so beats a mark that silently never appears.
     */
    bool dynamic = spec_bool(ctx, spec, "dynamic");
    bool radio   = spec_bool(ctx, spec, "radio");
    bool check   = spec_bool(ctx, spec, "check");

    if (radio && !dynamic) {
        JS_ThrowTypeError(ctx, "menu: %s is \"radio\" without \"dynamic\" -- a "
                               "radio marks one of an item's entries, and a "
                               "single item that ticks is \"check\"", name);
        goto out;
    }
    if (check && dynamic) {
        JS_ThrowTypeError(ctx, "menu: %s is both \"check\" and \"dynamic\" -- "
                               "a dynamic item that remembers a choice is "
                               "\"radio\"", name);
        goto out;
    }

    BtaItemKind kind = radio   ? ITEM_RADIO
                     : dynamic ? ITEM_DYNAMIC
                     : check   ? ITEM_CHECK
                               : ITEM_PLAIN;

    BtaMenuItem *mi = make_item(ctx, form, name, spec, group, prefix, kind, column);
    if (!mi)
        goto out;

    if (dynamic) {
        /* Empty until the application assigns Items.  The submenu is held so
         * it can be refilled later; appending it only adds GTK's reference. */
        mi->sub = g_menu_new();
        g_menu_append_submenu(section, text ? text : name, G_MENU_MODEL(mi->sub));
    } else {
        g_menu_append(section, text ? text : name, mi->path);
    }
    ok = true;

out:
    g_free(text);
    g_free(name);
    return ok;
}

/*
 * GMenu has no separator item: a separator is the boundary between sections.
 * So each run of items between separators becomes one section.
 */
static GMenu *build_items(JSContext *ctx, JSValueConst form, JSValueConst arr,
                          GSimpleActionGroup *group, const char *prefix,
                          int column)
{
    JSValue  lenv = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    GMenu *menu    = g_menu_new();
    GMenu *section = g_menu_new();
    bool   ok      = true;

    for (uint32_t i = 0; i < n && ok; i++) {
        JSValue spec = JS_GetPropertyUint32(ctx, arr, i);
        if (!JS_IsObject(spec)) {
            JS_FreeValue(ctx, spec);
            continue;
        }

        if (spec_bool(ctx, spec, "separator")) {
            g_menu_append_section(menu, NULL, G_MENU_MODEL(section));
            g_object_unref(section);
            section = g_menu_new();
        } else {
            ok = append_item(ctx, form, section, spec, group, prefix, column);
        }
        JS_FreeValue(ctx, spec);
    }

    g_menu_append_section(menu, NULL, G_MENU_MODEL(section));
    g_object_unref(section);

    if (!ok) {
        g_object_unref(menu);
        return NULL;
    }
    return menu;
}

int bta_menus_build(JSContext *ctx, JSValueConst form_obj, BtaWidget *w,
                    JSValueConst menus)
{
    if (!JS_IsArray(menus))
        return 0;

    /*
     * Keep the spec as it was read.  A GMenu cannot be walked back into one --
     * items are actions by then, separators are section boundaries, and the
     * nesting is gone -- so without this the serialiser would have nothing to
     * write and saving a form would silently drop its menus.  On the form's own
     * struct: it is the form's design, not one of its properties, and
     * `Form.Menus` in rad.js reads it back through the accessor.
     */
    JSValue *held = bta_widget_note(w, BTA_NOTE_MENUS);
    JS_FreeValue(ctx, *held);
    *held = JS_DupValue(ctx, menus);

    /* The form's own group, shared with its `actions` and with every control
     * bound to one: a command has one name, so it resolves in one place. */
    GSimpleActionGroup *group = bta_form_actions(w);
    building_owner = w;
    GMenu              *model = build_items(ctx, form_obj, menus, group,
                                            MENU_GROUP, -1);
    building_owner = NULL;

    if (!model)
        return -1;

    GtkWidget *bar = gtk_popover_menu_bar_new_from_model(G_MENU_MODEL(model));

    /*
     * The column the bar sits in, made here because here is where it starts
     * doing something: a window's child is its surface, and a form with no menus
     * -- thirty-six of the thirty-nine in this tree -- carries no box for one.
     *
     * The surface is held across the move: `gtk_window_set_child` drops the
     * window's reference to what was there, and that is the only one it has.
     */
    GtkWidget *holder = gtk_widget_get_parent(w->slot);

    if (!GTK_IS_BOX(holder)) {
        GtkWidget *column = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
        GtkWidget *slot   = g_object_ref(w->slot);

        gtk_window_set_child(GTK_WINDOW(w->gtk), NULL);
        gtk_box_append(GTK_BOX(column), slot);
        gtk_window_set_child(GTK_WINDOW(w->gtk), column);
        g_object_unref(slot);

        holder = column;
    }

    gtk_box_prepend(GTK_BOX(holder), bar);

    g_object_unref(model);
    return 0;
}

/* ------------------------------------------------------- context menus */

/*
 * The same spec, on one widget instead of on the window.
 *
 * Nothing here is a second kind of menu: the items are built by the same
 * walker, exposed on the form by name, and dispatched as Name_Click like any
 * other -- so a context menu is written exactly as a menu bar is, and a
 * handler cannot tell which one it was chosen from.
 *
 * The popover is parented to the widget, which in GTK4 makes it a child that
 * nobody else will unparent: it is ours to drop, and bta_menu_popup_free is
 * what the widget finaliser calls to do it.
 */
void bta_menu_popup_free(BtaWidget *w)
{
    if (!w || !w->popup)
        return;

    gtk_widget_unparent(w->popup);
    w->popup = NULL;
}

int bta_menu_popup_build(JSContext *ctx, JSValueConst form_obj, BtaWidget *w,
                         JSValueConst menus)
{
    bta_menu_popup_free(w);

    if (!JS_IsArray(menus))
        return 0;                      /* clearing it is not an error */

    GSimpleActionGroup *group = g_simple_action_group_new();
    building_owner = w;
    GMenu              *model = build_items(ctx, form_obj, menus, group, POPUP_GROUP, -1);
    building_owner = NULL;

    if (!model) {
        g_object_unref(group);
        return -1;
    }

    gtk_widget_insert_action_group(w->gtk, POPUP_GROUP, G_ACTION_GROUP(group));
    g_object_unref(group);

    w->popup = gtk_popover_menu_new_from_model(G_MENU_MODEL(model));
    g_object_unref(model);

    /* A menu that came from the pointer belongs at the pointer, with no tail
     * pointing back at a widget the size of a window. */
    gtk_popover_set_has_arrow(GTK_POPOVER(w->popup), FALSE);
    gtk_widget_set_halign(w->popup, GTK_ALIGN_START);
    gtk_widget_set_parent(w->popup, w->gtk);
    return 0;
}

void bta_menu_popup_show(BtaWidget *w, double x, double y)
{
    if (!w || !w->popup)
        return;

    /* A zero-sized rectangle at the point: the popover is placed against it,
     * so the menu opens where the click was and not where the widget is. */
    GdkRectangle at = { (int)x, (int)y, 1, 1 };
    gtk_popover_set_pointing_to(GTK_POPOVER(w->popup), &at);
    gtk_popover_popup(GTK_POPOVER(w->popup));
}

/*
 * ------------------------------------------------------ heading menus
 *
 * The same walker, one more time, for a column's heading.  What is different
 * is only where it is shown and what the items are told: GTK owns the popover
 * here (`GtkColumnViewColumn:header-menu`, which it presents on the heading's
 * own secondary click), so this returns the model for the caller to set, and
 * every item carries the column it was built for.
 *
 * Built per click and not kept: a menu whose items act on "this column" has to
 * be instantiated for the column that was clicked, and the alternative -- one
 * model whose items are annotated just before the popover opens -- has to know
 * which wrappers the installed model still owns after another one replaced it.
 * The cost is that item state a program sets from code does not survive the
 * next click; a menu that depends on context answers it from the event.
 */
GMenu *bta_menu_header_build(JSContext *ctx, JSValueConst form_obj,
                             BtaWidget *w, JSValueConst menus, int column)
{
    if (!w || !w->inner || !JS_IsArray(menus))
        return NULL;

    GSimpleActionGroup *group = g_simple_action_group_new();
    building_owner = w;
    GMenu              *model = build_items(ctx, form_obj, menus, group,
                                            HEADER_GROUP, column);
    building_owner = NULL;

    if (!model) {
        g_object_unref(group);
        return NULL;
    }

    /* Inserted rather than only returned: the popover GTK builds is parented
     * to the column's title, inside the view, and resolves `header.MnuX` by
     * walking up from there. */
    gtk_widget_insert_action_group(w->inner, HEADER_GROUP, G_ACTION_GROUP(group));
    g_object_unref(group);
    return model;
}

void bta_menu_init(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_menuitem_class_id);
    JS_NewClass(rt, bta_menuitem_class_id, &menuitem_class_def);

    JS_NewClassID(rt, &bta_action_class_id);
    JS_NewClass(rt, bta_action_class_id, &action_class_def);
}
