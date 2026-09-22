/*
 * Notebook -- a tabbed container.
 *
 * Each page has a child widget and a tab label.  The child is what the
 * notebook shows when that page is current; the label is what the user
 * clicks on.  In the IDE the children are 0x0 dummies (the editor and
 * designer live below the strip) and the labels are the visible tabs.
 *
 * GtkNotebook already handles scrolling, drag-to-reorder, and Ctrl+Tab
 * for switching, so the widget exposes just the operations the IDE needs.
 */
#include "bta.h"

static void on_switch_page(GtkNotebook *nb, GtkWidget *page, guint index,
                           gpointer user_data)
{
    (void)nb; (void)page;
    BtaWidget *w   = user_data;
    JSContext *ctx = w->ctx;
    JSValue    arg = JS_NewInt32(ctx, (int32_t)index);
    bta_emit(w, "Switch", 1, &arg);
    JS_FreeValue(ctx, arg);
}

static void build_notebook(BtaWidget *w)
{
    w->gtk = gtk_notebook_new();
    /* The notebook accepts pages via gtk_notebook_append_page; the slot
     * must be the GtkNotebook itself so bta_container_attach works when
     * the .form loader hands us children. */
    w->slot = w->gtk;
    /* A project routinely holds more tabs than fit: scrolling is required,
     * and it also gives Ctrl+Tab a way to move between them. */
    gtk_notebook_set_scrollable(GTK_NOTEBOOK(w->gtk), TRUE);
    g_signal_connect(w->gtk, "switch-page",
                     G_CALLBACK(on_switch_page), w);
}

static JSValue notebook_append(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Append(child, [label])");

    BtaWidget *child = bta_widget_of(argv[0]);
    if (!child || !child->gtk)
        return JS_ThrowTypeError(ctx, "Append: child is not a widget");

    BtaWidget *labelw = NULL;
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        labelw = bta_widget_of(argv[1]);
        if (!labelw || !labelw->gtk)
            return JS_ThrowTypeError(ctx, "Append: label is not a widget");
    }

    /* Both, and before the page is in GTK: see bta_widget_adopt_refused. */
    if (bta_widget_adopt_refused(ctx, this_val, w, child) ||
        (labelw && bta_widget_adopt_refused(ctx, this_val, w, labelw)))
        return JS_EXCEPTION;

    gint index = gtk_notebook_append_page(GTK_NOTEBOOK(w->gtk), child->gtk,
                                         labelw ? labelw->gtk : NULL);

    /* A page goes through GtkNotebook and not through the slot, so the adoption
     * that Add() does has to happen here too -- otherwise the page and its tab
     * are alive for GTK and collectable for the interpreter. */
    bta_widget_adopt(ctx, this_val, w, argv[0], child);
    if (labelw)
        bta_widget_adopt(ctx, this_val, w, argv[1], labelw);

    return JS_NewInt32(ctx, index);
}

static JSValue notebook_remove(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Remove(index)");

    int32_t index;
    if (JS_ToInt32(ctx, &index, argv[0]))
        return JS_EXCEPTION;

    /* Let go of the page and its tab before GTK drops them, or the wrappers stay
     * referenced for the life of the notebook -- an IDE closes tabs all day. */
    GtkWidget *page = gtk_notebook_get_nth_page(GTK_NOTEBOOK(w->gtk), index);
    if (page) {
        BtaWidget *child = g_object_get_data(G_OBJECT(page), BTA_WIDGET_QUARK);
        GtkWidget *label = gtk_notebook_get_tab_label(GTK_NOTEBOOK(w->gtk), page);
        BtaWidget *tab   = label ? g_object_get_data(G_OBJECT(label), BTA_WIDGET_QUARK)
                                 : NULL;

        if (child)
            bta_widget_release(ctx, this_val, child->self);
        if (tab)
            bta_widget_release(ctx, this_val, tab->self);
    }

    gtk_notebook_remove_page(GTK_NOTEBOOK(w->gtk), index);
    return JS_UNDEFINED;
}

/*
 * SetAction(control, ["Start" | "End"]) -- a widget in the tab strip itself.
 *
 * The strip has room at either end that nothing else can reach: a "new tab"
 * button, a menu of what to do with the whole set.  GTK has always offered it;
 * a page is not that, so nothing here could say it.
 *
 * It is emphatically **not a page**: Count and Children go on counting pages,
 * which is what they mean.  What it does need is the same adoption a page gets
 * -- the JS wrapper owns the BtaWidget, so a control only GTK holds is
 * collected while GTK still shows it, and the next motion over it reads freed
 * memory.  Passing null takes it out again.
 */
/* Which end an argument names, or -1. Shared by the setter and the getter. */
static int action_pack(JSContext *ctx, JSValueConst val, GtkPackType *out)
{
    if (!JS_IsString(val)) {
        *out = GTK_PACK_END;
        return 0;
    }

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return -1;

    bool start = !g_ascii_strcasecmp(s, "Start");
    bool end   = !g_ascii_strcasecmp(s, "End");
    JS_FreeCString(ctx, s);

    if (!start && !end)
        return -1;

    *out = start ? GTK_PACK_START : GTK_PACK_END;
    return 0;
}

/*
 * GetAction(["Start" | "End"]) -- what is in the strip, or null.
 *
 * Without it a strip widget could be put there and never found again: it is not
 * a page, so nothing that walks pages sees it, and the serialiser would drop it
 * on the first save.  This is what lets the JS half write it back -- the same
 * job Tabs does for the tab names, which the generic walk cannot see either.
 */
static JSValue notebook_get_action(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkPackType pack;
    if (argc > 0 && action_pack(ctx, argv[0], &pack) < 0)
        return JS_ThrowRangeError(ctx, "GetAction(where) takes Start or End");
    if (argc == 0)
        pack = GTK_PACK_END;

    GtkWidget *at = gtk_notebook_get_action_widget(GTK_NOTEBOOK(w->slot), pack);
    BtaWidget *cw = at ? g_object_get_data(G_OBJECT(at), BTA_WIDGET_QUARK) : NULL;

    return cw ? JS_DupValue(ctx, cw->self) : JS_NULL;
}

static JSValue notebook_set_action(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkPackType pack = GTK_PACK_END;
    if (argc > 1 && action_pack(ctx, argv[1], &pack) < 0)
        return JS_ThrowRangeError(ctx,
            "SetAction(control, where) puts it at the Start or the End");

    /* Validated before anything is taken out, so a bad call leaves the strip
     * as it was rather than half changed. */
    bool       clearing = argc < 1 || JS_IsNull(argv[0]) || JS_IsUndefined(argv[0]);
    BtaWidget *child    = clearing ? NULL : bta_widget_of(argv[0]);

    if (!clearing && !child)
        return JS_ThrowTypeError(ctx, "SetAction(control) expects a widget");
    if (child && child->is_form)
        return JS_ThrowTypeError(ctx, "a form cannot go in a tab strip");

    GtkNotebook *nb  = GTK_NOTEBOOK(w->slot);
    GtkWidget   *old = gtk_notebook_get_action_widget(nb, pack);

    if (child && bta_widget_adopt_refused(ctx, this_val, w, child))
        return JS_EXCEPTION;

    gtk_notebook_set_action_widget(nb, child ? child->gtk : NULL, pack);

    /* Let go after the swap: until GTK has dropped it, releasing our reference
     * could collect a wrapper the notebook is still showing. */
    if (old) {
        BtaWidget *ow = g_object_get_data(G_OBJECT(old), BTA_WIDGET_QUARK);
        if (ow)
            bta_widget_release(ctx, this_val, ow->self);
    }
    if (child)
        bta_widget_adopt(ctx, this_val, w, argv[0], child);

    return JS_UNDEFINED;
}

static JSValue notebook_get_count(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gtk_notebook_get_n_pages(GTK_NOTEBOOK(w->gtk)));
}

static JSValue notebook_get_current(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gtk_notebook_get_current_page(GTK_NOTEBOOK(w->gtk)));
}

static JSValue notebook_set_current(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    int32_t index;
    if (!bta_to_int(ctx, val, "Current", &index))
        return JS_EXCEPTION;
    gtk_notebook_set_current_page(GTK_NOTEBOOK(w->gtk), index);
    return JS_UNDEFINED;
}

static JSValue notebook_set_tab_label(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "SetTabLabel(index, label)");

    int32_t index;
    if (JS_ToInt32(ctx, &index, argv[0]))
        return JS_EXCEPTION;

    BtaWidget *labelw = bta_widget_of(argv[1]);
    if (!labelw || !labelw->gtk)
        return JS_ThrowTypeError(ctx, "SetTabLabel: label is not a widget");

    GtkWidget *page = gtk_notebook_get_nth_page(GTK_NOTEBOOK(w->gtk), index);
    if (!page)
        return JS_ThrowRangeError(ctx, "no page at index %d", index);

    /* Whatever was there stops being ours to keep alive. */
    GtkWidget *old = gtk_notebook_get_tab_label(GTK_NOTEBOOK(w->gtk), page);
    BtaWidget *prev = old ? g_object_get_data(G_OBJECT(old), BTA_WIDGET_QUARK) : NULL;
    if (prev && prev != labelw)
        bta_widget_release(ctx, this_val, prev->self);

    if (bta_widget_adopt_refused(ctx, this_val, w, labelw))
        return JS_EXCEPTION;

    gtk_notebook_set_tab_label(GTK_NOTEBOOK(w->gtk), page, labelw->gtk);
    bta_widget_adopt(ctx, this_val, w, argv[1], labelw);
    return JS_UNDEFINED;
}

/*
 * Tabs: the strip as an array of strings.
 *
 * SetTabLabel takes a widget, which is what the IDE needs to colour its tabs --
 * but a widget is not something a .form can carry, so a designed notebook had
 * nameless tabs and no way to name them.  As an array of plain strings this is
 * an ordinary property: it round-trips through the file and the designer's grid
 * edits it like any other list.
 *
 * Reading answers what the labels say, whatever they are made of; writing
 * replaces them with plain labels, which is the only thing a string can mean.
 *
 * The list is also *remembered*, because the .form loader applies properties
 * before it builds children: a notebook is told its tab names while it still has
 * no pages.  Each page then takes its name as it arrives, which is what makes
 * the file order-independent.
 */
#define TABS_PENDING_KEY "bta-notebook-tabs"

/* The name page `index` was promised, if any. */
static const char *tab_pending(GtkWidget *notebook, int index)
{
    char **names = g_object_get_data(G_OBJECT(notebook), TABS_PENDING_KEY);
    if (!names)
        return NULL;

    for (int i = 0; names[i]; i++)
        if (i == index)
            return names[i];
    return NULL;
}

void bta_notebook_page_added(GtkWidget *notebook, GtkWidget *page)
{
    GtkNotebook *nb    = GTK_NOTEBOOK(notebook);
    gint         index = gtk_notebook_page_num(nb, page);
    const char  *name  = index >= 0 ? tab_pending(notebook, index) : NULL;

    if (name)
        gtk_notebook_set_tab_label(nb, page, gtk_label_new(name));
}
static JSValue notebook_get_tabs(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkNotebook *nb  = GTK_NOTEBOOK(w->gtk);
    JSValue      arr = JS_NewArray(ctx);
    int          n   = gtk_notebook_get_n_pages(nb);

    for (int i = 0; i < n; i++) {
        GtkWidget  *page  = gtk_notebook_get_nth_page(nb, i);
        GtkWidget  *label = gtk_notebook_get_tab_label(nb, page);
        const char *text  = label && GTK_IS_LABEL(label)
                                ? gtk_label_get_text(GTK_LABEL(label)) : "";

        JS_SetPropertyUint32(ctx, arr, (uint32_t)i, JS_NewString(ctx, text));
    }
    return arr;
}

static JSValue notebook_set_tabs(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!JS_IsArray(val))
        return JS_ThrowTypeError(ctx, "Tabs expects an array of labels");

    JSValue  lenv = JS_GetPropertyStr(ctx, val, "length");
    uint32_t n    = 0;
    int      rc   = JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);
    if (rc < 0)
        return JS_EXCEPTION;

    GtkNotebook *nb    = GTK_NOTEBOOK(w->gtk);
    int          pages = gtk_notebook_get_n_pages(nb);

    /* Kept for the pages that do not exist yet. */
    GPtrArray *keep = g_ptr_array_new();
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, val, i);
        const char *s = JS_ToCString(ctx, e);
        g_ptr_array_add(keep, g_strdup(s ? s : ""));
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
    }
    g_ptr_array_add(keep, NULL);
    g_object_set_data_full(G_OBJECT(w->gtk), TABS_PENDING_KEY,
                           g_ptr_array_free(keep, FALSE), (GDestroyNotify)g_strfreev);

    for (uint32_t i = 0; i < n && (int)i < pages; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, val, i);
        const char *s = JS_ToCString(ctx, e);
        JS_FreeValue(ctx, e);

        GtkWidget *page = gtk_notebook_get_nth_page(nb, (int)i);
        GtkWidget *old  = gtk_notebook_get_tab_label(nb, page);
        BtaWidget *prev = old ? g_object_get_data(G_OBJECT(old), BTA_WIDGET_QUARK) : NULL;

        /* A label of ours stops being ours to keep alive. */
        if (prev)
            bta_widget_release(ctx, this_val, prev->self);

        gtk_notebook_set_tab_label(nb, page, gtk_label_new(s ? s : ""));
        JS_FreeCString(ctx, s);
    }
    return JS_UNDEFINED;
}

/*
 * Where the tabs are, or "None" for a notebook with none showing.
 *
 * **`Strip`, which is what a `Switcher` calls it** -- the same question about
 * the same thing, and the two would otherwise answer to `Strip` and
 * `TabPosition`, which is one concept with two names and a coin flip every time
 * one writes it. `Start` and `End` rather than Left and Right for the same
 * reason the switcher uses them: which side that is depends on the language the
 * program is being read in.
 *
 * `None` is the notebook driven from somewhere else -- a wizard whose Next
 * button turns the page, a set of views a menu picks -- and it is `show-tabs`
 * and not a hidden strip, so the pages get the room back.
 */
static JSValue notebook_get_strip(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkNotebook *nb = GTK_NOTEBOOK(w->inner);
    if (!gtk_notebook_get_show_tabs(nb))
        return JS_NewString(ctx, "None");

    switch (gtk_notebook_get_tab_pos(nb)) {
    case GTK_POS_BOTTOM: return JS_NewString(ctx, "Bottom");
    case GTK_POS_LEFT:   return JS_NewString(ctx, "Start");
    case GTK_POS_RIGHT:  return JS_NewString(ctx, "End");
    default:             return JS_NewString(ctx, "Top");
    }
}

static JSValue notebook_set_strip(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkNotebook *nb = GTK_NOTEBOOK(w->inner);
    GtkPositionType at = GTK_POS_TOP;
    bool show = true;

    if      (!g_ascii_strcasecmp(s, "Top"))    at = GTK_POS_TOP;
    else if (!g_ascii_strcasecmp(s, "Bottom")) at = GTK_POS_BOTTOM;
    else if (!g_ascii_strcasecmp(s, "Start"))  at = GTK_POS_LEFT;
    else if (!g_ascii_strcasecmp(s, "End"))    at = GTK_POS_RIGHT;
    else if (!g_ascii_strcasecmp(s, "None"))   show = false;
    else {
        JSValue e = JS_ThrowRangeError(ctx,
            "a strip goes Top, Bottom, Start or End, or None at all, not '%s'", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    /* The side is remembered even while nothing is shown, so turning the strip
     * back on puts it where it was rather than at the top. */
    if (show)
        gtk_notebook_set_tab_pos(nb, at);
    gtk_notebook_set_show_tabs(nb, show);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry notebook_props[] = {
    JS_CGETSET_DEF("Strip", notebook_get_strip, notebook_set_strip),
    JS_CGETSET_DEF("Tabs",    notebook_get_tabs,    notebook_set_tabs),
    JS_CGETSET_DEF("Count",   notebook_get_count,   NULL),
    JS_CGETSET_DEF("Current", notebook_get_current, notebook_set_current),
    /* Append(child, [label]) */
    JS_CFUNC_DEF ("Append",     2, notebook_append),
    /* Remove(index) */
    JS_CFUNC_DEF ("Remove",     1, notebook_remove),
    /* SetTabLabel(index, label) */
    JS_CFUNC_DEF ("SetTabLabel", 2, notebook_set_tab_label),
    /* SetAction(control, [where]) */
    JS_CFUNC_DEF ("SetAction",   2, notebook_set_action),
    /* GetAction(where) */
    JS_CFUNC_DEF ("GetAction",   1, notebook_get_action),
};

/* What Strip accepts -- the same five a Switcher's does. */
static const char *notebook_options(const char *prop)
{
    return !strcmp(prop, "Strip") ? "Top,Bottom,Start,End,None" : NULL;
}

void bta_notebook_register(void)
{
    const BtaClass rows[] = {
        /* The tab labels: a list of strings a person reads. */
        /* Switch(index) */
        BTA_CLASS_ENUM_TEXT("Notebook", "Container", build_notebook, notebook_props,
                       false, notebook_options, "Tabs", "Switch"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
