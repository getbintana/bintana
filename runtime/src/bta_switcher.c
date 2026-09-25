/*
 * Switcher -- pages picked from a strip of linked buttons.
 *
 * The same shape as a Notebook and a different bargain.  A notebook's strip
 * grows with its pages and scrolls when they stop fitting, which is what a set
 * that changes while the program runs needs -- one tab per open file.  A
 * switcher's is one segmented control, every button the same size, and it says
 * "these are the two or three views of this panel" the way a notebook's row of
 * tabs never quite does.  That set is part of the design: named once in the
 * .form, and not added to afterwards.
 *
 * The IDE's side panel is the case that asked for it: the property grid on one
 * page, the palette and the control tree on the other, in a column too narrow
 * to hold both at once.
 *
 * It is a GtkStackSwitcher over a GtkStack, in a box.  The **stack** is the
 * slot, so a child put in by the loader, by Add(), or by the designer is a page
 * like any other, and the strip follows along because GTK builds the strip from
 * the stack rather than from anything said here.
 */
#include "bta.h"

/* ------------------------------------------------------------ the stack */

/*
 * A page's index is its position among the stack's children.  GtkStack has no
 * index of its own -- it addresses pages by name, and a name is one more thing
 * a .form would have to carry and keep in step with the titles -- so the walk
 * below is what "the third page" means here, exactly as it does for a Notebook.
 */
static int stack_count(GtkWidget *stack)
{
    int n = 0;
    for (GtkWidget *c = gtk_widget_get_first_child(stack); c;
         c = gtk_widget_get_next_sibling(c))
        n++;
    return n;
}

static GtkWidget *stack_nth(GtkWidget *stack, int index)
{
    if (index < 0)
        return NULL;

    int i = 0;
    for (GtkWidget *c = gtk_widget_get_first_child(stack); c;
         c = gtk_widget_get_next_sibling(c), i++)
        if (i == index)
            return c;
    return NULL;
}

static int stack_index(GtkWidget *stack, GtkWidget *child)
{
    int i = 0;
    for (GtkWidget *c = gtk_widget_get_first_child(stack); c;
         c = gtk_widget_get_next_sibling(c), i++)
        if (c == child)
            return i;
    return -1;
}

/* What the strip writes on a page's button. */
static void page_set_title(GtkWidget *stack, GtkWidget *child, const char *title)
{
    GtkStackPage *page = gtk_stack_get_page(GTK_STACK(stack), child);
    if (page)
        gtk_stack_page_set_title(page, title);
}

static const char *page_title(GtkWidget *stack, GtkWidget *child)
{
    GtkStackPage *page = gtk_stack_get_page(GTK_STACK(stack), child);
    const char   *t    = page ? gtk_stack_page_get_title(page) : NULL;
    return t ? t : "";
}

static void on_visible_child(GObject *stack, GParamSpec *spec, gpointer user_data)
{
    (void)spec;
    BtaWidget *w   = user_data;
    JSContext *ctx = w->ctx;

    GtkWidget *shown = gtk_stack_get_visible_child(GTK_STACK(stack));
    JSValue    arg   = JS_NewInt32(ctx,
        shown ? stack_index(GTK_WIDGET(stack), shown) : -1);

    bta_emit(w, "Switch", 1, &arg);
    JS_FreeValue(ctx, arg);
}

static void build_switcher(BtaWidget *w)
{
    w->gtk   = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    w->inner = gtk_stack_new();
    w->slot  = w->inner;

    GtkWidget *strip = gtk_stack_switcher_new();
    gtk_stack_switcher_set_stack(GTK_STACK_SWITCHER(strip), GTK_STACK(w->inner));

    gtk_box_append(GTK_BOX(w->gtk), strip);
    gtk_box_append(GTK_BOX(w->gtk), w->inner);

    /*
     * Two questions that look like one, and answering only the second is what
     * left a switcher's pages at their natural size inside a switcher that had
     * been given the whole window.
     *
     *  - How the box divides the room it *has*: the strip is worth its own
     *    height and the pages are worth all the rest, which is what the stack
     *    expanding says. Without it a GtkBox hands a child its natural size and
     *    the leftover is a band of nothing under the page.
     *  - Whether the switcher claims room from the container *around* it: that
     *    stays its parent's business, so the holder's expand is explicitly off.
     *    GTK propagates a child's expand upwards, and without saying otherwise
     *    every switcher would be greedy in an elastic parent -- the same bargain
     *    a Panel makes with its slot, and for the same reason.
     */
    gtk_widget_set_hexpand(w->inner, TRUE);
    gtk_widget_set_vexpand(w->inner, TRUE);
    gtk_widget_set_hexpand(w->gtk, FALSE);
    gtk_widget_set_vexpand(w->gtk, FALSE);

    g_signal_connect(w->inner, "notify::visible-child",
                     G_CALLBACK(on_visible_child), w);
}

/* ----------------------------------------------------------------- Strip */

/*
 * Strip: where the buttons are, or "None" for a bare stack.
 *
 * The switcher is a GtkStackSwitcher over a GtkStack, and the stack is the part
 * that does the work: one child on screen at a time, sized so that swapping does
 * not resize anything around it.  That is worth having on its own -- a welcome
 * screen swapped for the workspace behind it, a "no results" page, a wizard --
 * and asking for it should not mean a second class with the same Tabs, the same
 * Current, the same everything.  So the strip is a *property*: `None` and the
 * pages are changed by code alone.
 *
 * Nothing is remembered: the answer is read back off the widgets themselves --
 * which way the box runs, which child comes first, whether the strip is shown --
 * so it cannot drift from what is on screen.
 */
static GtkWidget *switcher_strip(BtaWidget *w)
{
    for (GtkWidget *c = gtk_widget_get_first_child(w->gtk); c;
         c = gtk_widget_get_next_sibling(c))
        if (GTK_IS_STACK_SWITCHER(c))
            return c;
    return NULL;
}

static JSValue switcher_get_strip(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkWidget *strip = switcher_strip(w);
    if (!strip || !gtk_widget_get_visible(strip))
        return JS_NewString(ctx, "None");

    bool column = gtk_orientable_get_orientation(GTK_ORIENTABLE(w->gtk))
                      == GTK_ORIENTATION_VERTICAL;
    bool first  = gtk_widget_get_first_child(w->gtk) == strip;

    if (column)
        return JS_NewString(ctx, first ? "Top" : "Bottom");
    return JS_NewString(ctx, first ? "Start" : "End");
}

static JSValue switcher_set_strip(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    bool top    = !g_ascii_strcasecmp(s, "Top");
    bool bottom = !g_ascii_strcasecmp(s, "Bottom");
    bool start  = !g_ascii_strcasecmp(s, "Start");
    bool end    = !g_ascii_strcasecmp(s, "End");
    bool none   = !g_ascii_strcasecmp(s, "None");

    if (!top && !bottom && !start && !end && !none) {
        JSValue e = JS_ThrowRangeError(ctx,
            "a strip goes Top, Bottom, Start or End, or None at all, not '%s'", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    GtkWidget *strip = switcher_strip(w);
    if (!strip)
        return JS_UNDEFINED;

    gtk_widget_set_visible(strip, !none);
    if (none)
        return JS_UNDEFINED;   /* where it would have gone is kept, not lost */

    /* The strip runs across the box and the box across the strip: buttons in a
     * row above the pages, or in a column beside them. */
    GtkOrientation box = (top || bottom) ? GTK_ORIENTATION_VERTICAL
                                         : GTK_ORIENTATION_HORIZONTAL;

    gtk_orientable_set_orientation(GTK_ORIENTABLE(w->gtk), box);
    gtk_orientable_set_orientation(GTK_ORIENTABLE(strip),
        box == GTK_ORIENTATION_VERTICAL ? GTK_ORIENTATION_HORIZONTAL
                                        : GTK_ORIENTATION_VERTICAL);

    /* Which of the two comes first is the whole of Top-against-Bottom; passing
     * NULL as the sibling means "at the front". */
    gtk_box_reorder_child_after(GTK_BOX(w->gtk),
                                (top || start) ? strip : w->slot, NULL);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------------ Tabs */

/*
 * Tabs: the strip as an array of strings, and remembered.
 *
 * The .form loader applies properties before it builds children, so a switcher
 * is told its page names while it still has no pages.  The list is kept and
 * each page takes its name as it arrives, which is what makes the order of the
 * file not matter -- the same bargain Notebook.Tabs makes, for the same reason.
 */
#define TABS_PENDING_KEY "bta-switcher-tabs"

static const char *tab_pending(GtkWidget *stack, int index)
{
    char **names = g_object_get_data(G_OBJECT(stack), TABS_PENDING_KEY);
    if (!names || index < 0)
        return NULL;

    for (int i = 0; names[i]; i++)
        if (i == index)
            return names[i];
    return NULL;
}

void bta_switcher_page_added(GtkWidget *stack, GtkWidget *page)
{
    int index = stack_index(stack, page);
    if (index < 0)
        return;

    const char *promised = tab_pending(stack, index);
    if (promised && *promised) {
        page_set_title(stack, page, promised);
        return;
    }

    /*
     * A page with no title is a blank button on the strip: something the user
     * can see, can press, and cannot tell from the one beside it.  So it gets
     * the name it would have been given anyway, and whoever cares says better.
     */
    char *fallback = g_strdup_printf("Page %d", index + 1);
    page_set_title(stack, page, fallback);
    g_free(fallback);
}

static JSValue switcher_get_tabs(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue arr = JS_NewArray(ctx);
    uint32_t i  = 0;

    for (GtkWidget *c = gtk_widget_get_first_child(w->slot); c;
         c = gtk_widget_get_next_sibling(c))
        JS_SetPropertyUint32(ctx, arr, i++,
                             JS_NewString(ctx, page_title(w->slot, c)));
    return arr;
}

static JSValue switcher_set_tabs(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!JS_IsArray(val))
        return JS_ThrowTypeError(ctx, "Tabs expects an array of names");

    JSValue  lenv = JS_GetPropertyStr(ctx, val, "length");
    uint32_t n    = 0;
    int      rc   = JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);
    if (rc < 0)
        return JS_EXCEPTION;

    /* Read once -- and converted before anything is touched: a value that
     * cannot become text is a refusal, not a page with no title. */
    GPtrArray *keep = g_ptr_array_new();
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, val, i);
        const char *s = JS_ToCString(ctx, e);

        if (!s) {
            JS_FreeValue(ctx, e);
            g_ptr_array_free(keep, TRUE);
            return JS_EXCEPTION;   /* it threw on the way; that stands */
        }
        g_ptr_array_add(keep, g_strdup(s));
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
    }
    g_ptr_array_add(keep, NULL);

    char **names = (char **)g_ptr_array_free(keep, FALSE);
    g_object_set_data_full(G_OBJECT(w->slot), TABS_PENDING_KEY,
                           names, (GDestroyNotify)g_strfreev);

    for (uint32_t i = 0; i < n; i++) {
        GtkWidget *page = stack_nth(w->slot, (int)i);
        if (!page)
            break;
        page_set_title(w->slot, page, names[i]);
    }
    return JS_UNDEFINED;
}

/* -------------------------------------------------------- which is shown */

static JSValue switcher_get_count(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, stack_count(w->slot));
}

static JSValue switcher_get_current(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkWidget *shown = gtk_stack_get_visible_child(GTK_STACK(w->slot));
    return JS_NewInt32(ctx, shown ? stack_index(w->slot, shown) : -1);
}

static JSValue switcher_set_current(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t index;
    if (!bta_to_int(ctx, val, "Current", &index))
        return JS_EXCEPTION;

    /* An index nothing answers to leaves the strip as it was: a switcher shown
     * before its pages were built would otherwise blank itself. */
    GtkWidget *page = stack_nth(w->slot, index);
    if (page)
        gtk_stack_set_visible_child(GTK_STACK(w->slot), page);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------ the pages */

/*
 * Append(child, [name]) -- a page, with what its button says.
 *
 * Add() puts a page in too; this is the same thing with the name in the same
 * call, which is what code building a switcher out of controls wants.  The name
 * is a string and not a widget, because a stack page's title is one: the strip
 * is a segmented control, and there is nowhere for a widget to go.
 */
static JSValue switcher_append(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Append(child, [name])");

    BtaWidget *child = bta_widget_of(argv[0]);
    if (!child || !child->gtk)
        return JS_ThrowTypeError(ctx, "Append: child is not a widget");
    if (child->is_form)
        return JS_ThrowTypeError(ctx, "a form cannot be a page");

    /* The name is read before anything is added: a value whose conversion
     * throws would otherwise leave a page in the stack that nothing on the JS
     * side owns -- which is the shape of a wrapper collected under GTK's feet. */
    const char *name = NULL;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        name = JS_ToCString(ctx, argv[1]);
        if (!name)
            return JS_EXCEPTION;
    }

    /* Before the page is in the stack, for the reason the name above is read
     * before it: a refusal must leave nothing behind. */
    if (!bta_widget_bring_in(ctx, this_val, w, child, true)) {
        if (name)
            JS_FreeCString(ctx, name);
        return JS_EXCEPTION;
    }

    gtk_stack_add_child(GTK_STACK(w->slot), child->gtk);

    /* Named before it is adopted, so a Switch handler that reads Tabs sees the
     * page the way the rest of the program will. */
    if (name) {
        page_set_title(w->slot, child->gtk, name);
        JS_FreeCString(ctx, name);
    } else {
        bta_switcher_page_added(w->slot, child->gtk);
    }

    /* The wrapper owns the BtaWidget: a page only GTK holds is collected while
     * GTK still shows it. */
    bta_widget_adopt(ctx, this_val, w, argv[0], child);
    return JS_NewInt32(ctx, stack_index(w->slot, child->gtk));
}

static JSValue switcher_remove(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "RemovePage(index) needs a page index");

    int32_t index;
    if (!bta_to_int(ctx, argv[0], "RemovePage", &index))
        return JS_EXCEPTION;

    GtkWidget *page = stack_nth(w->slot, index);
    if (!page)
        return JS_ThrowRangeError(ctx, "RemovePage: there is no page %d", index);

    /* Through the container: taking a child out is where the parent's reference
     * to it is dropped, and doing it by hand here is how they pile up. */
    BtaWidget *cw = bta_slot_child(page);
    if (cw && !bta_container_detach(ctx, cw))
        return JS_EXCEPTION;
    if (!cw)
        gtk_stack_remove(GTK_STACK(w->slot), page);

    return JS_UNDEFINED;
}

/*
 * Reorder(page, index) -- moving a page among its siblings.
 *
 * GTK gives a stack no way to say it: pages go in at the end and stay in that
 * order, which is why this takes them all out and puts them back.  Everything a
 * page has that GTK keeps for it -- its title, above all -- lives on a
 * GtkStackPage that goes away with it, so both are carried across by hand.
 *
 * Every page is referenced first, because removing one drops the last reference
 * GTK holds and the widget would be finalised between the two loops.  Ours is
 * the same trick Arrangement plays when it swaps a slot out from under its
 * children, and for the same reason.
 */
bool bta_switcher_reorder(BtaWidget *w, GtkWidget *child, int index)
{
    GtkStack *st   = GTK_STACK(w->slot);
    int       from = stack_index(w->slot, child);
    int       n    = stack_count(w->slot);

    if (from < 0)
        return false;
    if (index < 0)     index = 0;
    if (index >= n)    index = n - 1;
    if (index == from) return true;

    GtkWidget *shown  = gtk_stack_get_visible_child(st);
    GPtrArray *kids   = g_ptr_array_new();
    GPtrArray *titles = g_ptr_array_new_with_free_func(g_free);

    for (GtkWidget *c = gtk_widget_get_first_child(w->slot); c;
         c = gtk_widget_get_next_sibling(c)) {
        g_ptr_array_add(kids, g_object_ref(c));
        g_ptr_array_add(titles, g_strdup(page_title(w->slot, c)));
    }

    gpointer moved = g_ptr_array_steal_index(kids, from);
    gpointer title = g_ptr_array_steal_index(titles, from);
    g_ptr_array_insert(kids,   index, moved);
    g_ptr_array_insert(titles, index, title);

    /*
     * The rebuild is not a switch: it passes through every page on the way to
     * putting the same one back on screen, and a form that listens would see a
     * fistful of Switch events for something the user did not do.
     */
    g_signal_handlers_block_matched(w->slot, G_SIGNAL_MATCH_DATA,
                                    0, 0, NULL, NULL, w);

    for (guint i = 0; i < kids->len; i++)
        gtk_stack_remove(st, kids->pdata[i]);
    for (guint i = 0; i < kids->len; i++) {
        gtk_stack_add_child(st, kids->pdata[i]);
        page_set_title(w->slot, kids->pdata[i], titles->pdata[i]);
    }
    if (shown)
        gtk_stack_set_visible_child(st, shown);

    g_signal_handlers_unblock_matched(w->slot, G_SIGNAL_MATCH_DATA,
                                      0, 0, NULL, NULL, w);

    for (guint i = 0; i < kids->len; i++)
        g_object_unref(kids->pdata[i]);
    g_ptr_array_free(kids, TRUE);
    g_ptr_array_free(titles, TRUE);
    return true;
}

static const JSCFunctionListEntry switcher_props[] = {
    JS_CGETSET_DEF("Strip",   switcher_get_strip,   switcher_set_strip),
    JS_CGETSET_DEF("Tabs",    switcher_get_tabs,    switcher_set_tabs),
    JS_CGETSET_DEF("Count",   switcher_get_count,   NULL),
    JS_CGETSET_DEF("Current", switcher_get_current, switcher_set_current),
    /* Append(child, [name]) */
    JS_CFUNC_DEF("Append", 2, switcher_append),
    /* RemovePage(index) */
    JS_CFUNC_DEF("RemovePage", 1, switcher_remove),
};

/* What Strip accepts, so a property grid offers the five and not a text field. */
static const char *switcher_options(const char *prop)
{
    return !strcmp(prop, "Strip") ? "Top,Bottom,Start,End,None" : NULL;
}

void bta_switcher_register(void)
{
    const BtaClass rows[] = {
        /* Its strip is a segmented control and `Tabs` is the whole of what can
         * be in it: a list of strings a person reads. */
        /* Switch(index) */
        BTA_CLASS_ENUM_TEXT("Switcher", "Container", build_switcher, switcher_props,
                       false, switcher_options, "Tabs", "Switch"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
