/*
 * Popover -- a control that floats over another, opened by a verb.
 *
 *     Popover.Show(content, anchor, [{ Rect, Position, Arrow, Autohide, Closed }])
 *     Popover.Close(content)
 *     Popover.IsOpen(content)
 *
 * ## Why a verb and not a control
 *
 * There used to be a `Popover` *control*: a container with one child that sat in
 * a form's tree and was opened with `Popup(anchor)`. Everything wrong with it
 * came from living in the tree -- it takes no room, so the designer could not
 * draw, pick or drop into it; it could only live in a container that lays its
 * children out through a layout manager; it could not be shown before its window
 * existed; and `Visible` had to be read-only. The same shape as `MenuButton`,
 * which was refused for the same reason: it is something the runtime does, and a
 * widget of its own bought nothing but a place for those problems to live.
 *
 * So the *content* is an ordinary control -- a component with a `.form` of its
 * own, drawn in its own tab like any other, or a `Label` built in code -- and
 * opening it is a verb with the control and the anchor as arguments. Nothing in
 * the form being drawn mentions it.
 *
 * ## Where the GtkPopover is parented, and why it is not the anchor
 *
 * To **the window's own content** -- the surface of the form the anchor is on
 * (or the column that holds its menu bar). Measured with a probe under
 * AddressSanitizer, one anchor at a time:
 *
 *  - parented to the anchor, a `Button`, `Entry`, `Scroller` or `SpinButton`
 *    works and warns *Finalizing GtkButton, but it still has children left*
 *    unless somebody unparents on `destroy`;
 *  - parented to a `ListBox` or a `TextView` it **hangs the process** at full
 *    CPU: both manage their children themselves and take the popover for a row
 *    or an embedded widget. Those two are the likeliest anchors there are -- an
 *    editor for a hint, a list for its menu;
 *  - parented to the `GtkWindow` itself it opens, and warns *Finalizing
 *    GtkWindow ... children left*;
 *  - parented to the window's content it is clean with every anchor, because
 *    `GtkBox` and `BtaFixed` both unparent their children when they go.
 *
 * The rectangle is worked out in that widget's own coordinates with
 * `gtk_widget_compute_bounds`, which answers for any descendant.
 *
 * ## The lifetime
 *
 * A job per open content: it holds the control and the `Closed` function
 * strongly -- invisible to the collector on purpose, the `form_hold` bargain --
 * from `Show` until the popover is down, and then lets go on an idle. Four roads
 * end it and all of them release both values: the popover closing (`Close`,
 * Escape, a click outside), the window closing under it (`unmap`: GTK pops
 * nothing down and says nothing, and the window is *not* finalised -- its form
 * is held by the program -- so a weak reference would never fire), the window
 * being finalised (that weak reference, for the one that is), and teardown
 * (`bta_popover_cleanup`, which runs before the context goes or
 * `JS_FreeRuntime` aborts). A control taken out or put elsewhere while it is
 * shown ends it too: `bta_popover_take`, asked by `bta_container_detach`.
 *
 * **The release is on an idle and not inside the signal**: dropping the last
 * reference to a control from within the `closed` emission, or from inside a
 * widget being disposed, is the hazard `widget_disconnect_tree` was written for.
 * The idle holds a reference on the job and not a pointer to it, because a freed
 * job's address can be handed to the next one.
 */

#include "bta.h"

#include <string.h>

typedef struct {
    int        refs;
    bool       dead;        /* disposed: the struct is waiting for its last ref */
    bool       open;        /* shown, and the program has not been told it closed */
    bool       owes_closed; /* the popover went away without saying so */
    bool       queued;      /* a settle is on the loop */

    JSContext *ctx;
    JSValue    content;     /* owned */
    JSValue    closed;      /* owned, or undefined */
    BtaWidget *cw;          /* borrowed: `content` owns it */

    GtkWidget *pop;         /* NULL once GTK finalised it */
    GtkWidget *host;        /* what it is parented to, borrowed */
    GtkWidget *anchor;      /* what it points at; nulled by GTK when it goes */
} PopJob;

static GList *pop_jobs = NULL;

static PopJob *job_ref(PopJob *job)
{
    job->refs++;
    return job;
}

static void job_unref(PopJob *job)
{
    if (--job->refs == 0)
        g_free(job);
}

static PopJob *job_for(BtaWidget *cw)
{
    for (GList *l = pop_jobs; l; l = l->next) {
        PopJob *job = l->data;

        if (job->cw == cw)
            return job;
    }
    return NULL;
}

static void on_pop_gone(gpointer data, GObject *where);

static void pop_unhook(PopJob *job)
{
    GtkWidget *pop = job->pop;

    if (!pop)
        return;
    job->pop = NULL;

    g_object_weak_unref(G_OBJECT(pop), on_pop_gone, job);
    g_signal_handlers_disconnect_by_data(pop, job);

    /* The control has to outlive the popover: its wrapper holds a reference of
     * its own, so taking it out only makes it a free-standing widget again. */
    gtk_popover_set_child(GTK_POPOVER(pop), NULL);
    if (gtk_widget_get_parent(pop))
        gtk_widget_unparent(pop);
}

static void on_anchor_unmap(GtkWidget *anchor, gpointer data)
{
    PopJob *job = data;

    /* The anchor left the screen -- deleted, hidden, its page turned away --
     * and a popover pointing at nothing is worse than none: closed, it also
     * keeps GTK's own focus walk out of it with a window that has lost the
     * widget the focus was on. */
    if (!job->dead && job->open && job->pop)
        gtk_popover_popdown(GTK_POPOVER(job->pop));
}

static void set_anchor(PopJob *job, GtkWidget *anchor)
{
    if (job->anchor == anchor)
        return;
    if (job->anchor) {
        g_signal_handlers_disconnect_by_data(job->anchor, job);
        g_object_remove_weak_pointer(G_OBJECT(job->anchor), (gpointer *)&job->anchor);
    }
    job->anchor = anchor;
    if (anchor) {
        g_object_add_weak_pointer(G_OBJECT(anchor), (gpointer *)&job->anchor);
        g_signal_connect(anchor, "unmap", G_CALLBACK(on_anchor_unmap), job);
    }
}

static void job_release(PopJob *job)
{
    if (job->dead)
        return;
    job->dead = true;
    job->open = false;
    pop_jobs  = g_list_remove(pop_jobs, job);

    set_anchor(job, NULL);
    pop_unhook(job);

    JSValue content = job->content, closed = job->closed;

    job->content = JS_UNDEFINED;
    job->closed  = JS_UNDEFINED;
    job->cw      = NULL;
    JS_FreeValue(job->ctx, closed);
    JS_FreeValue(job->ctx, content);

    job_unref(job);                     /* the list's reference */
}

/* Tell the program it closed -- the function it handed over, once. */
static void job_tell(PopJob *job)
{
    if (JS_IsUndefined(job->closed) || !JS_IsFunction(job->ctx, job->closed))
        return;

    JSContext *ctx = job->ctx;
    JSValue    fn  = JS_DupValue(ctx, job->closed);
    JSValue    r   = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);

    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, fn);
    bta_drain_jobs(JS_GetRuntime(ctx));
}

/*
 * After the signal, on the loop.  What it does depends on whether the program
 * opened the popover again from inside its own `Closed`: then there is nothing
 * to take down, and the job goes on.
 */
static gboolean job_settle(gpointer data)
{
    PopJob *job = data;

    job->queued = false;
    if (!job->dead) {
        if (job->owes_closed) {
            job->owes_closed = false;
            job_tell(job);
        }
        if (!job->dead && !job->open)
            job_release(job);
    }
    job_unref(job);
    return G_SOURCE_REMOVE;
}

static void job_queue(PopJob *job)
{
    if (job->queued)
        return;
    job->queued = true;
    g_idle_add(job_settle, job_ref(job));
}

static void on_pop_closed(GtkWidget *pop, gpointer data)
{
    PopJob *job = data;

    (void)pop;
    if (job->dead || !job->open)
        return;

    /* Told on the loop and not here: this is a signal GTK emits from inside
     * hiding a window, or an anchor being disposed, and a program's function
     * has no business running there -- it may delete the very thing being
     * taken down. */
    job->open        = false;
    job->owes_closed = true;
    job_queue(job);
}

/* GTK finalised the popover under us: the window it hung from went. Nothing
 * may be called into JavaScript from here -- this is a dispose -- so the
 * program is told on the next turn. */
static void on_pop_gone(gpointer data, GObject *where)
{
    PopJob *job = data;

    (void)where;
    job->pop = NULL;
    if (job->open) {
        job->open        = false;
        job->owes_closed = true;
    }
    job_queue(job);
}

/*
 * A control that is being put somewhere else, or taken out, while a popover
 * still holds it -- open, or closed and waiting for its idle.  The popover is
 * not a container the program ever saw, so `bta_container_detach` has no branch
 * for it and would answer *cannot remove from this container*: it asks here
 * first, and what this does is the whole of the answer -- the popover comes
 * down (and the program is told, if it had not been), and the control is
 * free-standing when this returns.  True when there was a popover to take it
 * from.
 */
bool bta_popover_take(BtaWidget *cw)
{
    PopJob *job = job_for(cw);

    if (!job)
        return false;

    bool owed = job->open || job->owes_closed;

    job->open        = false;
    job->owes_closed = false;
    if (owed)
        job_tell(job);
    job_release(job);
    return true;
}

/* Before the context goes: let go of every control and function still held,
 * and tell nobody -- the program is ending. */
void bta_popover_cleanup(void)
{
    while (pop_jobs) {
        PopJob *job = pop_jobs->data;

        job->owes_closed = false;
        job_release(job);
    }
}

/* ------------------------------------------------------------------------- */

typedef struct {
    bool           rect;
    int32_t        v[4];        /* X, Y, Width, Height */
    bool           has[4];      /* ...and which of them were given */
    GtkPositionType position;
    bool           arrow;
    bool           autohide;
    JSValue        closed;      /* borrowed from the options object */
} PopOptions;

static bool read_options(JSContext *ctx, JSValueConst opts, PopOptions *o)
{
    o->rect     = false;
    o->position = GTK_POS_BOTTOM;
    o->arrow    = true;
    o->autohide = true;
    o->closed   = JS_UNDEFINED;

    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;
    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "Popover.Show: the options are an object "
                               "{ Rect, Position, Arrow, Autohide, Closed }");
        return false;
    }

    /* A misspelt option is refused rather than ignored: `Autohid: false` that
     * quietly leaves the popover closing on a click is the bug a caller reads
     * as the feature not working. */
    JSPropertyEnum *tab;
    uint32_t        n;

    if (JS_GetOwnPropertyNames(ctx, &tab, &n, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;
    for (uint32_t i = 0; i < n; i++) {
        const char *k = JS_AtomToCString(ctx, tab[i].atom);
        bool known = k && (g_str_equal(k, "Rect") || g_str_equal(k, "Position") ||
                           g_str_equal(k, "Arrow") || g_str_equal(k, "Autohide") ||
                           g_str_equal(k, "Closed"));

        if (!known)
            JS_ThrowTypeError(ctx, "Popover.Show: '%s' is not an option "
                "(Rect, Position, Arrow, Autohide, Closed)", k ? k : "?");
        if (k)
            JS_FreeCString(ctx, k);
        if (!known) {
            JS_FreePropertyEnum(ctx, tab, n);
            return false;
        }
    }
    JS_FreePropertyEnum(ctx, tab, n);

    JSValue f = JS_GetPropertyStr(ctx, opts, "Position");

    if (JS_IsException(f))
        return false;
    if (!JS_IsUndefined(f)) {
        const char *s = JS_ToCString(ctx, f);

        JS_FreeValue(ctx, f);
        if (!s)
            return false;
        if (g_str_equal(s, "Top"))         o->position = GTK_POS_TOP;
        else if (g_str_equal(s, "Bottom")) o->position = GTK_POS_BOTTOM;
        else if (g_str_equal(s, "Left"))   o->position = GTK_POS_LEFT;
        else if (g_str_equal(s, "Right"))  o->position = GTK_POS_RIGHT;
        else {
            JS_ThrowRangeError(ctx,
                "'%s' is not a Position: Top, Bottom, Left or Right", s);
            JS_FreeCString(ctx, s);
            return false;
        }
        JS_FreeCString(ctx, s);
    }

    f = JS_GetPropertyStr(ctx, opts, "Arrow");
    if (!JS_IsUndefined(f))
        o->arrow = JS_ToBool(ctx, f) > 0;
    JS_FreeValue(ctx, f);

    f = JS_GetPropertyStr(ctx, opts, "Autohide");
    if (!JS_IsUndefined(f))
        o->autohide = JS_ToBool(ctx, f) > 0;
    JS_FreeValue(ctx, f);

    f = JS_GetPropertyStr(ctx, opts, "Closed");
    if (!JS_IsUndefined(f) && !JS_IsNull(f)) {
        if (!JS_IsFunction(ctx, f)) {
            JS_FreeValue(ctx, f);
            JS_ThrowTypeError(ctx, "Popover.Show: Closed is a function");
            return false;
        }
        o->closed = f;      /* kept alive by the options object */
    }
    JS_FreeValue(ctx, f);

    f = JS_GetPropertyStr(ctx, opts, "Rect");
    if (JS_IsException(f))
        return false;
    if (!JS_IsUndefined(f) && !JS_IsNull(f)) {
        static const char *keys[] = { "X", "Y", "Width", "Height" };

        if (!JS_IsObject(f)) {
            JS_FreeValue(ctx, f);
            JS_ThrowTypeError(ctx,
                "Popover.Show: Rect is { X, Y, Width, Height }");
            return false;
        }
        o->rect = true;
        for (int k = 0; k < 4; k++) {
            JSValue c = JS_GetPropertyStr(ctx, f, keys[k]);

            o->has[k] = false;                  /* the anchor's own */
            if (JS_IsException(c)) {
                JS_FreeValue(ctx, f);
                return false;
            }
            if (!JS_IsUndefined(c)) {
                if (!bta_to_int(ctx, c, "Popover.Show", &o->v[k])) {
                    JS_FreeValue(ctx, c);
                    JS_FreeValue(ctx, f);
                    return false;
                }
                o->has[k] = true;
            }
            JS_FreeValue(ctx, c);
        }
    }
    JS_FreeValue(ctx, f);
    return true;
}

static JSValue popover_show(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2)
        return JS_ThrowTypeError(ctx,
            "Popover.Show(content, anchor) needs the control to show and the one "
            "it points at");

    BtaWidget *cw = bta_widget_of(argv[0]);
    BtaWidget *aw = bta_widget_of(argv[1]);

    if (!cw || !cw->gtk || cw->is_form)
        return JS_ThrowTypeError(ctx,
            "Popover.Show: the content is a control or a component, not a form");
    if (!aw || !aw->gtk)
        return JS_ThrowTypeError(ctx, "Popover.Show: the anchor is a control");

    PopOptions o;

    if (!read_options(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, &o))
        return JS_EXCEPTION;

    /*
     * Everything that can refuse comes before anything moves.  The content is
     * taken out of wherever it was, and a refusal after that leaves a control
     * with no parent that its program did not ask to lose.
     */
    const char *me = cw->name ? cw->name : "the content";
    const char *to = aw->name ? aw->name : "the anchor";

    GtkRoot *root = gtk_widget_get_root(aw->gtk);

    if (!root || !GTK_IS_WINDOW(root))
        return JS_ThrowTypeError(ctx,
            "Popover.Show: %s is not on screen -- before the window is shown, "
            "or inside a collapsed Expander or a hidden page", to);
    if (!gtk_widget_get_mapped(aw->gtk))
        return JS_ThrowTypeError(ctx, "Popover.Show: %s is not on screen", to);

    GtkWidget *host = gtk_window_get_child(GTK_WINDOW(root));

    if (!host)
        return JS_ThrowTypeError(ctx, "Popover.Show: %s is not in a window", to);

    if (cw->gtk == aw->gtk || gtk_widget_is_ancestor(aw->gtk, cw->gtk))
        return JS_ThrowTypeError(ctx,
            "Popover.Show: %s is what it would point at, or holds it", me);

    JSValueConst fv = aw->is_form ? aw->self : aw->form;

    if (JS_IsUndefined(fv))
        return JS_ThrowTypeError(ctx, "Popover.Show: %s is not in a form", to);
    BtaWidget *formw = bta_widget_of(fv);

    PopJob *job = job_for(cw);

    /* Open somewhere else -- another window -- is a new popover; the same
     * window is the same one, moved. */
    if (job && (job->host != host || !job->pop)) {
        if (job->owes_closed) {
            job->owes_closed = false;
            job_tell(job);
        }
        job_release(job);
        job = NULL;
    }

    if (!job) {
        /* A control that is somewhere already moves, as `Add` does -- and is
         * asked the same questions: not into itself, and no second handler
         * for an event the form answers. */
        if (!bta_widget_bring_in(ctx, fv, formw, cw, true))
            return JS_EXCEPTION;
    }

    /* The anchor's rectangle in the host's own coordinates. */
    graphene_rect_t r;

    if (!gtk_widget_compute_bounds(aw->gtk, host, &r))
        return JS_ThrowTypeError(ctx, "Popover.Show: %s is not in this window", to);

    GdkRectangle at = {
        (int)r.origin.x, (int)r.origin.y,
        MAX(1, (int)r.size.width), MAX(1, (int)r.size.height)
    };

    if (o.rect) {
        int32_t v[4] = { 0, 0, at.width, at.height };

        for (int k = 0; k < 4; k++)
            if (o.has[k])
                v[k] = o.v[k];
        graphene_point_t from = GRAPHENE_POINT_INIT((float)v[0], (float)v[1]), to_pt;

        if (!gtk_widget_compute_point(aw->gtk, host, &from, &to_pt))
            return JS_ThrowTypeError(ctx, "Popover.Show: %s is not in this window", to);
        at.x      = (int)to_pt.x;
        at.y      = (int)to_pt.y;
        at.width  = MAX(1, v[2]);
        at.height = MAX(1, v[3]);
    }

    if (!job) {
        job          = g_new0(PopJob, 1);
        job->refs    = 1;
        job->ctx     = ctx;
        job->content = JS_DupValue(ctx, argv[0]);
        job->closed  = JS_UNDEFINED;
        job->cw      = cw;
        job->host    = host;
        pop_jobs     = g_list_prepend(pop_jobs, job);

        /* A control built in code answers to the form it is shown from. */
        if (JS_IsUndefined(cw->form))
            bta_widget_bind(cw, fv, cw->name);
        bta_widget_bind_tree(cw, fv);

        GtkWidget *pop = gtk_popover_new();

        job->pop = pop;
        gtk_popover_set_child(GTK_POPOVER(pop), cw->gtk);
        gtk_widget_set_parent(pop, host);
        g_object_weak_ref(G_OBJECT(pop), on_pop_gone, job);
        g_signal_connect(pop, "closed", G_CALLBACK(on_pop_closed), job);
        /* A window that closes while it is up takes the popover down with it
         * and says nothing: `closed` is for a popover that is *popped down*, and
         * the window's own hiding only unmaps it. The window is still alive --
         * its form is held by the program -- so the popover is not finalised
         * either, and neither signal nor weak reference would ever tell. */
        g_signal_connect(pop, "unmap",  G_CALLBACK(on_pop_closed), job);
    }

    /* Said again on every call, so a second `Show` is the whole answer and not
     * the first one's leftovers. */
    JSValue old = job->closed;

    job->closed = JS_IsUndefined(o.closed) ? JS_UNDEFINED : JS_DupValue(ctx, o.closed);
    JS_FreeValue(ctx, old);

    set_anchor(job, aw->gtk);

    GtkPopover *pop = GTK_POPOVER(job->pop);

    gtk_popover_set_position(pop, o.position);
    gtk_popover_set_has_arrow(pop, o.arrow);
    gtk_popover_set_autohide(pop, o.autohide);
    gtk_popover_set_pointing_to(pop, &at);

    /*
     * **GTK reads the window's focus while it shows an autohide popover**, and
     * asserts when there is none: `gtk_popover_focus` asks whether the root's
     * focus widget is an ancestor, with a `NULL` that is not a widget. A window
     * whose focus was lost plus content with nothing focusable is one critical
     * per open. So the window gets a focus on the way in, and the anchor is
     * first -- it is where the interaction came from, and a field that opens a
     * list of suggestions should go on having the keyboard.
     */
    if (!gtk_root_get_focus(root)) {
        gtk_widget_grab_focus(aw->gtk);
        if (!gtk_root_get_focus(root))
            gtk_widget_child_focus(GTK_WIDGET(root), GTK_DIR_TAB_FORWARD);

        /* A window that has not been through its first paint takes neither: it
         * has no focus to move, and GTK's own first-paint focus walk then goes
         * into this open popover and asserts, with the same `NULL`. Setting it
         * outright needs no mapped window. */
        if (!gtk_root_get_focus(root)) {
            GtkWidget *f = aw->inner && gtk_widget_get_focusable(aw->inner)
                               ? aw->inner : aw->gtk;

            if (gtk_widget_get_focusable(f))
                gtk_window_set_focus(GTK_WINDOW(root), f);
        }
    }

    job->open = true;
    gtk_popover_popup(pop);
    return JS_UNDEFINED;
}

static JSValue popover_close(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Popover.Close(content) needs the control it showed");

    BtaWidget *cw = bta_widget_of(argv[0]);

    if (!cw)
        return JS_ThrowTypeError(ctx, "Popover.Close: the content is a control");

    PopJob *job = job_for(cw);

    if (job && job->open && job->pop)
        gtk_popover_popdown(GTK_POPOVER(job->pop));
    return JS_UNDEFINED;
}

static JSValue popover_is_open(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Popover.IsOpen(content) needs a control");

    BtaWidget *cw  = bta_widget_of(argv[0]);
    PopJob    *job = cw ? job_for(cw) : NULL;

    return JS_NewBool(ctx, job && job->open);
}

static const JSCFunctionListEntry popover_props[] = {
    /* Show(content, anchor, [{ Rect, Position, Arrow, Autohide, Closed }])
     *   opens `content` — any control, usually a component with a `.form` of
     *   its own — floating over `anchor`. **Not in the form's tree**: it takes
     *   no room, appears in no `Children`, and nothing in the form being
     *   drawn mentions it. A control that is in a container is taken out of
     *   it, as `Add` would; it comes back out, free-standing, when the
     *   popover closes, and can be shown again. The options: `Rect`
     *   (`{ X, Y, Width, Height }` in the anchor's own coordinates — what
     *   `Editor.CursorBounds()` answers — points at a place in it instead of
     *   the whole of it), `Position` (`Top`, `Bottom`, `Left` or `Right`, the
     *   side it **prefers**; default `"Bottom"`), `Arrow` (the tail pointing
     *   back at the anchor, default `true`; `false` for a list flush against a
     *   field), `Autohide` (a click outside or Escape closes
     *   it, default `true`) and `Closed` (a function called once when it went
     *   down, **by any road**, the window going included). A misspelt option
     *   is refused. Showing a control that is already open moves it, with the
     *   options given this time. The anchor must be on screen, which it
     *   cannot be before the window is shown. The point is taken once: an
     *   anchor that moves afterwards leaves the popover where it opened
     */
    JS_CFUNC_DEF("Show", 2, popover_show),
    /* Close(content)
     *   closes it. Nothing happens when it is not open; `Closed` is called
     *   once it is down
     */
    JS_CFUNC_DEF("Close", 1, popover_close),
    /* IsOpen(content) -> boolean
     *   whether `Show` opened it and it has not closed since
     */
    JS_CFUNC_DEF("IsOpen", 1, popover_is_open),
};

void bta_popover_init(JSContext *ctx, JSValue global)
{
    JSValue popover = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, popover, popover_props,
                               G_N_ELEMENTS(popover_props));
    JS_SetPropertyStr(ctx, global, "Popover", popover);
}
