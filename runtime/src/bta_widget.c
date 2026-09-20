/*
 * The widget <-> JS bridge.
 *
 * All widget classes share one JSClassID and one finalizer; what makes a
 * Button a Button is its prototype, which bta_widgets_init() chains from the
 * class table.  Every JS widget object keeps a BtaWidget in its opaque slot.
 */
#include "bta.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

JSClassID bta_widget_class_id;

/* ------------------------------------------------------------- unwrapping */

BtaWidget *bta_widget_of(JSValueConst v)
{
    return JS_GetOpaque(v, bta_widget_class_id);
}

BtaWidget *bta_this(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = JS_GetOpaque(this_val, bta_widget_class_id);
    if (!w)
        JS_ThrowTypeError(ctx, "not a widget");
    return w;
}

/*
 * A number, or a refusal that names what arrived.
 *
 * `JS_ToInt32` is why `Margin = "0 0 0 12"` was a silent zero. ToNumber on a
 * string that is not a number answers NaN, ToInt32(NaN) is 0, and nothing along
 * that road fails -- so every numeric property in this runtime took whatever it
 * was handed, and a gap that never appeared was the only symptom. Found in a
 * delivered application whose month label asked for a margin the way `Padding`
 * is written, four sizes in a string.
 *
 * Every other setter here refuses what it cannot use and says what the value
 * was. This is that, once, for all of them -- the alternative being the same
 * check written twenty-eight times, which is twenty-eight chances to leave one
 * out.
 *
 * `""` and `null` are 0 and not a refusal: that is what ToNumber says they are,
 * and a property grid clearing a field means nothing-was-asked-for. What is
 * refused is a value with no numeric reading at all.
 */
bool bta_to_number(JSContext *ctx, JSValueConst val, const char *name, double *out)
{
    double n;

    if (JS_ToFloat64(ctx, &n, val))
        return false;                      /* it threw on the way; that stands */
    if (isnan(n)) {
        const char *had = JS_ToCString(ctx, val);

        JS_ThrowTypeError(ctx, "%s: %s%s%s is not a number", name,
                          JS_IsString(val) ? "\"" : "", had ? had : "?",
                          JS_IsString(val) ? "\"" : "");
        if (had)
            JS_FreeCString(ctx, had);
        return false;
    }
    *out = n;
    return true;
}

bool bta_to_int(JSContext *ctx, JSValueConst val, const char *name, int32_t *out)
{
    double n;

    if (!bta_to_number(ctx, val, name, &n))
        return false;

    /* Truncated the way ToInt32 truncates, so a value that was already legal
     * stays legal: 8.7 is 8 here as it was before. */
    *out = (int32_t)n;
    return true;
}

void bta_widget_bind(BtaWidget *w, JSValueConst form, const char *name)
{
    if (!w)
        return;
    JS_FreeValue(w->ctx, w->form);
    w->form = JS_DupValue(w->ctx, form);

    /* Copy before freeing: callers legitimately pass w->name itself, to rebind
     * a control to a different form without renaming it. */
    char *copy = g_strdup(name);
    g_free(w->name);
    w->name = copy;
}

/*
 * What every way of adding a child has to do, whatever the container: keep a
 * JS reference to the child, and bind it to the form.
 *
 * Neither is bookkeeping.  The wrapper *owns* the BtaWidget, so a child that
 * only GTK holds gets collected while GTK still shows it -- and the next mouse
 * motion over it reads freed memory.  The binding is what makes its events
 * dispatch as Name_Click at all.
 */
/* Below, with HAlign: where a control sits is one subject, and this is the half
 * of it that only GTK can carry out. */
static void widget_apply_align(BtaWidget *w);

void bta_widget_adopt(JSContext *ctx, JSValueConst parent_val, BtaWidget *parent,
                      JSValueConst child_val, BtaWidget *child)
{
    if (!parent || !child)
        return;

    JSValue *slot = bta_widget_note(parent, BTA_NOTE_CHILDREN);
    if (!JS_IsArray(*slot)) {
        JS_FreeValue(ctx, *slot);
        *slot = JS_NewArray(ctx);
    }
    JSValue kids = *slot;

    JSValue  lenv = JS_GetPropertyStr(ctx, kids, "length");
    uint32_t len  = 0;
    JS_ToUint32(ctx, &len, lenv);
    JS_FreeValue(ctx, lenv);

    JS_SetPropertyUint32(ctx, kids, len, JS_DupValue(ctx, child_val));

    JSValueConst form = parent->is_form ? parent_val : parent->form;
    if (JS_IsUndefined(child->form))
        bta_widget_bind(child, form, child->name);
    bta_widget_bind_tree(child, form);

    /* It has a parent now, and what HAlign/VAlign do depends on which kind it
     * is. Said here because this is the one place every way of adding a child
     * goes through -- a page appended to a notebook never sees relayout. */
    widget_apply_align(child);
}

/*
 * The inverse of adopting: drop the parent's reference to a child.
 *
 * Every way of *removing* a child has to do this, or a designer that creates and
 * deletes controls -- or an IDE that opens and closes tabs -- piles wrappers up
 * forever.  Silent, since a child that was never adopted is not an error.
 */
void bta_widget_release(JSContext *ctx, JSValueConst parent_val,
                        JSValueConst child_val)
{
    JSValue kids = JS_GetPropertyStr(ctx, parent_val, "__children");
    if (!JS_IsArray(kids)) {
        JS_FreeValue(ctx, kids);
        return;
    }

    JSValue fn  = JS_GetPropertyStr(ctx, kids, "indexOf");
    JSValue arg = JS_DupValue(ctx, child_val);
    JSValue at  = JS_Call(ctx, fn, kids, 1, (JSValueConst *)&arg);
    int32_t idx = -1;

    JS_ToInt32(ctx, &idx, at);

    if (idx >= 0) {
        JSValue splice  = JS_GetPropertyStr(ctx, kids, "splice");
        JSValue args[2] = { JS_NewInt32(ctx, idx), JS_NewInt32(ctx, 1) };

        JS_FreeValue(ctx, JS_Call(ctx, splice, kids, 2, (JSValueConst *)args));
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
        JS_FreeValue(ctx, splice);
    }

    JS_FreeValue(ctx, at);
    JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, kids);
}

/*
 * Binding cascades down a subtree that was built before it was attached: a row
 * assembled out of controls and only then added to a list has children whose
 * form is still unset, and an unbound control dispatches no events at all.
 * Controls that already belong to a form keep it -- this only fills in blanks.
 */
void bta_widget_bind_tree(BtaWidget *w, JSValueConst form)
{
    if (!w || !w->slot)
        return;

    for (GtkWidget *c = gtk_widget_get_first_child(w->slot);
         c; c = gtk_widget_get_next_sibling(c)) {

        BtaWidget *cw = bta_slot_child(c);
        if (!cw)
            continue;
        if (JS_IsUndefined(cw->form))
            bta_widget_bind(cw, form, cw->name);
        bta_widget_bind_tree(cw, form);
    }
}

/*
 * The first control under `w` carrying `Default` or `Cancel`, depth first.
 *
 * Depth first and not the slot's own children only: a dialog's buttons are as
 * likely to be in a row inside a panel as loose on the surface, and *which
 * container they happen to be in* is not what the declaration is about. Tree
 * order is what makes two of them a decidable question -- see `form_show`.
 */
BtaWidget *bta_widget_flagged(BtaWidget *w, bool cancel)
{
    if (!w || !w->slot)
        return NULL;

    for (GtkWidget *c = gtk_widget_get_first_child(w->slot);
         c; c = gtk_widget_get_next_sibling(c)) {

        BtaWidget *cw = bta_slot_child(c);
        if (!cw)
            continue;
        if (cancel ? cw->is_cancel : cw->is_default)
            return cw;

        BtaWidget *deeper = bta_widget_flagged(cw, cancel);
        if (deeper)
            return deeper;
    }
    return NULL;
}

/* --------------------------------------------------------------- geometry */

void bta_widget_relayout(BtaWidget *w)
{
    if (!w || !w->gtk)
        return;

    if (w->is_form) {
        /* A form's box is the window itself, not a slot in some parent. */
        if (w->w > 0 || w->h > 0)
            gtk_window_set_default_size(GTK_WINDOW(w->gtk),
                                        w->w > 0 ? w->w : -1,
                                        w->h > 0 ? w->h : -1);
        return;
    }

    /*
     * A stretched control asks GTK for its *floor*, not for the size it was
     * drawn at: its width is derived from the container's, so the number in
     * the .form is where the anchor's gaps were measured from and not a
     * minimum. Requesting the drawn size instead is what stopped a window
     * from ever being made smaller than the form was designed.
     *
     * On an axis that is not stretched the two are the same thing, and the
     * request is the drawn size as it always was.
     */
    int req_w = w->halign == BTA_ALIGN_FILL ? w->min_w : w->w;
    int req_h = w->valign == BTA_ALIGN_FILL ? w->min_h : w->h;


    gtk_widget_set_size_request(w->gtk, req_w > 0 ? req_w : -1,
                                        req_h > 0 ? req_h : -1);

    /* Which of the two placings applies is the parent's to say, and a control
     * changes parents: re-asked here, where every move already lands. */
    widget_apply_align(w);

    /* The surface reads x/y off the widget itself, so moving one is only a
     * matter of telling it to lay out again. */
    GtkWidget *parent = gtk_widget_get_parent(w->gtk);
    if (parent && BTA_IS_FIXED(parent))
        gtk_widget_queue_allocate(parent);
}

/* ---------------------------------------------------------------- events */

static JSValue emit_on(JSContext *ctx, JSValueConst form, const char *name,
                       const char *event, int argc, JSValueConst *argv, bool *threw)
{
    if (threw)
        *threw = false;
    if (!name || JS_IsUndefined(form))
        return JS_UNDEFINED;

    char   *key = g_strdup_printf("%s_%s", name, event);
    JSValue fn  = JS_GetPropertyStr(ctx, form, key);
    g_free(key);

    JSValue result = JS_UNDEFINED;
    if (JS_IsFunction(ctx, fn)) {
        result = JS_Call(ctx, fn, form, argc, argv);
        if (JS_IsException(result)) {
            bta_dump_error(ctx);
            JS_FreeValue(ctx, result);
            result = JS_UNDEFINED;
            if (threw)
                *threw = true;
        }
        bta_drain_jobs(JS_GetRuntime(ctx));
    }
    JS_FreeValue(ctx, fn);
    return result;
}

JSValue bta_emit_on(JSContext *ctx, JSValueConst form, const char *name,
                    const char *event, int argc, JSValueConst *argv)
{
    return emit_on(ctx, form, name, event, argc, argv, NULL);
}

/*
 * The same emit, and whether the handler threw.
 *
 * Every other caller is right to ignore it: an event is a notification, the
 * throw has already been reported, and there is nobody to hand it to. An
 * **exporter** is the exception -- `Save` and `SavePdf` write a file out of a
 * frame, and a frame whose handler died halfway is a file of whatever had been
 * drawn by then, reported as a success. That was true here until this existed.
 */
bool bta_emit_ok(BtaWidget *w, const char *event, int argc, JSValueConst *argv)
{
    if (!w)
        return true;

    bool threw = false;
    JS_FreeValue(w->ctx,
                 emit_on(w->ctx, w->form, w->name, event, argc, argv, &threw));
    return !threw;
}

/*
 * An event that is **asked a question**, rather than told something.
 *
 * Almost every event here is a notification: the handler's answer is nothing
 * and its throw has already been reported, which is what `bta_emit` and
 * `bta_emit_ok` are for. `Paginate` is not one -- the runtime needs the number
 * back, and a handler that failed to work it out must stop the print rather
 * than let it go out short. So this hands back both: the value, owned by the
 * caller, and whether the handler threw.
 *
 * The exception has been reported and consumed by then, the same as every other
 * event; `threw` is what lets the caller raise one of its own to fail with,
 * which is the bargain `bta_emit_ok` already makes for an exporter.
 */
JSValue bta_emit_answer(BtaWidget *w, const char *event, int argc,
                        JSValueConst *argv, bool *threw)
{
    if (!w) {
        if (threw)
            *threw = false;
        return JS_UNDEFINED;
    }
    return emit_on(w->ctx, w->form, w->name, event, argc, argv, threw);
}

/*
 * **Is there a handler for this event at all?**
 *
 * Asked by the one caller that has a *second* event to fall back on: a page
 * being drawn onto paper raises `DrawPage`, and a control whose form never
 * declared one raises `Draw` instead -- the screen's handler, which is the
 * right answer for a drawing that is one page. Every other event is a
 * notification and a form that ignores it is simply a form that ignores it,
 * which is why this is not a general question.
 */
bool bta_has_handler(BtaWidget *w, const char *event)
{
    if (!w || !w->name || JS_IsUndefined(w->form))
        return false;

    char   *key = g_strdup_printf("%s_%s", w->name, event);
    JSValue fn  = JS_GetPropertyStr(w->ctx, w->form, key);
    bool    has = JS_IsFunction(w->ctx, fn);

    g_free(key);
    JS_FreeValue(w->ctx, fn);
    return has;
}

void bta_emit(BtaWidget *w, const char *event, int argc, JSValueConst *argv)
{
    if (!w)
        return;
    JS_FreeValue(w->ctx, bta_emit_on(w->ctx, w->form, w->name, event, argc, argv));
}

/* ------------------------------------------------- base Widget properties */

static JSValue w_get_name(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return w->name ? JS_NewString(ctx, w->name) : JS_NewString(ctx, "");
}

static JSValue w_set_name(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    g_free(w->name);
    w->name = g_strdup(s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* X/Y/Width/Height share one accessor pair, selected by magic. */
enum { GEOM_X, GEOM_Y, GEOM_W, GEOM_H, GEOM_MIN_W, GEOM_MIN_H };

static JSValue w_get_geom(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    switch (magic) {
    case GEOM_X:     return JS_NewInt32(ctx, w->x);
    case GEOM_Y:     return JS_NewInt32(ctx, w->y);
    case GEOM_MIN_W: return JS_NewInt32(ctx, w->min_w);
    case GEOM_MIN_H: return JS_NewInt32(ctx, w->min_h);
    case GEOM_W: return JS_NewInt32(ctx, w->w > 0 ? w->w : gtk_widget_get_width(w->gtk));
    default:     return JS_NewInt32(ctx, w->h > 0 ? w->h : gtk_widget_get_height(w->gtk));
    }
}

static JSValue w_set_geom(JSContext *ctx, JSValueConst this_val,
                          JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* In the order the enum above declares them, so the message names the
     * property the caller wrote. */
    static const char *const NAMES[] = { "X", "Y", "Width", "Height",
                                         "MinWidth", "MinHeight" };
    int32_t n;
    if (!bta_to_int(ctx, val,
                    magic >= 0 && magic < (int)G_N_ELEMENTS(NAMES) ? NAMES[magic]
                                                                   : "geometry",
                    &n))
        return JS_EXCEPTION;

    switch (magic) {
    case GEOM_X:     w->x = n;     break;
    case GEOM_Y:     w->y = n;     break;
    case GEOM_W:     w->w = n;     break;
    case GEOM_MIN_W: w->min_w = n; break;
    case GEOM_MIN_H: w->min_h = n; break;
    default:         w->h = n;     break;
    }
    bta_widget_relayout(w);
    return JS_UNDEFINED;
}

enum { FLAG_VISIBLE, FLAG_ENABLED, FLAG_FOCUSABLE };

static JSValue w_get_flag(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    switch (magic) {
    case FLAG_VISIBLE:   return JS_NewBool(ctx, gtk_widget_get_visible(w->gtk));
    case FLAG_ENABLED:   return JS_NewBool(ctx, gtk_widget_get_sensitive(w->gtk));
    default:             return JS_NewBool(ctx, gtk_widget_get_focusable(w->gtk));
    }
}

/*
 * `Action` -- the command this control points at, or `""`.
 *
 * Binding is GTK's own: a `GtkActionable` control given an action name follows
 * that action's enabled state without anything of ours propagating it, which is
 * the whole reason this is one property and not a subscription. What the runtime
 * adds is the two refusals -- a name that is not a command of this form, and a
 * control that cannot be actionable at all -- because both are mistakes that
 * would otherwise turn into a control that quietly does nothing when pressed.
 *
 * `Text` and `Icon` come from the action **only when the control declared
 * neither**, so a toolbar button stays icon-only while the menu shows the
 * label, and so a form written before this existed binds without being
 * relaid-out.
 */
static JSValue w_get_action(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* The name and not the path: `form.` is how GTK spells it and not something
     * a program said. */
    const char *dot = w->action ? strchr(w->action, '.') : NULL;
    return JS_NewString(ctx, dot ? dot + 1 : (w->action ? w->action : ""));
}

static JSValue w_set_action(JSContext *ctx, JSValueConst this_val,
                            JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;

    if (!GTK_IS_ACTIONABLE(w->gtk)) {
        JSValue e = JS_ThrowTypeError(ctx, "%s cannot point at a command: only "
                                           "a control that is pressed can",
                                      w->name ? w->name : "this control");
        JS_FreeCString(ctx, name);
        return e;
    }

    /* "" unbinds, which is what a designer clearing the row means. */
    if (!*name) {
        gtk_actionable_set_action_name(GTK_ACTIONABLE(w->gtk), NULL);
        g_free(w->action);
        w->action = NULL;
        JS_FreeCString(ctx, name);
        return JS_UNDEFINED;
    }

    BtaWidget *form = bta_widget_of(w->form);

    if (!bta_action_exists(form, name)) {
        JSValue e = JS_ThrowRangeError(ctx, "'%s' is not one of this form's "
                                            "actions -- a control bound to a "
                                            "command that is not there does "
                                            "nothing when it is pressed", name);
        JS_FreeCString(ctx, name);
        return e;
    }

    g_free(w->action);
    w->action = g_strdup_printf("%s.%s", BTA_ACTION_GROUP, name);
    gtk_actionable_set_action_name(GTK_ACTIONABLE(w->gtk), w->action);

    bta_action_dress(ctx, form, name, this_val);
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue w_set_flag(JSContext *ctx, JSValueConst this_val,
                          JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    switch (magic) {
    case FLAG_VISIBLE: gtk_widget_set_visible(w->gtk, b);   break;
    case FLAG_ENABLED:
        /*
         * **Refused when a command governs it.** The bug an `Action` exists to
         * prevent is two places computing whether one command is available, and
         * this is where that would be written: a bound control that still took
         * an `Enabled` would let the divergence back in, silently. Reading still
         * works and answers what the action says.
         */
        if (w->action) {
            /* Named the way the program spells it: `form.` is GTK's and not
             * something anybody wrote. */
            const char *dot = strchr(w->action, '.');

            return JS_ThrowTypeError(ctx, "%s takes its Enabled from the "
                                          "command %s; set it there",
                                     w->name ? w->name : "this control",
                                     dot ? dot + 1 : w->action);
        }
        gtk_widget_set_sensitive(w->gtk, b);
        break;
    default:
        /*
         * **The focus of a control is not always on the widget the parent lays
         * out**, which is the same fact `Focused` reports by asking *contains*
         * rather than `has_focus`: a TextBox's focus sits on the `GtkText` inside
         * its entry and an editor's on the view inside its scroller. So
         * setting this on `gtk` alone did nothing at all on either --
         * `gtk_widget_child_focus` walked straight past the unfocusable outside
         * and into the focusable inside, and `Focusable = false` on the commonest
         * control in the widget set was a property that read back correctly and
         * meant nothing. Found by a tab-order test expecting Tab to skip a
         * TextBox.
         */
        gtk_widget_set_focusable(w->gtk, b);
        if (w->inner && w->inner != w->gtk)
            gtk_widget_set_focusable(w->inner, b);
        /* An entry keeps its text widget as an internal child rather than as
         * ours, and `GtkEditable` is how GTK hands it over. */
        if (GTK_IS_EDITABLE(w->gtk)) {
            GtkEditable *d = gtk_editable_get_delegate(GTK_EDITABLE(w->gtk));
            if (d)
                gtk_widget_set_focusable(GTK_WIDGET(d), b);
        }
        break;
    }
    return JS_UNDEFINED;
}

/*
 * Expand decides who absorbs the slack when an elastic container is resized.
 * It is meaningless on a fixed surface, where there are no cells to share out
 * -- that is what HAlign/VAlign below are for. Each kind of container has the
 * one that means something in it.
 */
enum { EXPAND_BOTH, EXPAND_H, EXPAND_V };

static JSValue w_get_expand(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    bool h = gtk_widget_get_hexpand(w->gtk);
    bool v = gtk_widget_get_vexpand(w->gtk);
    return JS_NewBool(ctx, magic == EXPAND_H ? h : (magic == EXPAND_V ? v : (h && v)));
}

static JSValue w_set_expand(JSContext *ctx, JSValueConst this_val,
                            JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    if (magic != EXPAND_V)
        gtk_widget_set_hexpand(w->gtk, b);
    if (magic != EXPAND_H)
        gtk_widget_set_vexpand(w->gtk, b);
    return JS_UNDEFINED;
}

/*
 * HAlign/VAlign: where a control sits, and what it does with the room it did
 * not ask for.
 *
 * On a drawing surface that is the anchor rule -- what happens to the control
 * when the surface is resized. In a box it is where the child sits in its cell,
 * which is what GTK's own halign/valign say. The four values are GTK's for
 * exactly that reason: one vocabulary for elastic containers and RAD ones
 * instead of two, and the same four cases WinForms writes as a combination of
 * Anchor edges -- kept as a single value on purpose, since a property with one
 * value out of a list is already a drop-down in the designer's grid and a flag
 * set would not be.
 *
 * `Auto` is the default and the fifth word, because the two containers disagree
 * about what "nothing was asked for" means: a drawn control stays where it was
 * drawn, and a child of a box fills its cell. Naming the disagreement is what
 * lets the other four mean the same thing in both -- and what keeps every form
 * that predates this from moving or from serialising an answer it never gave.
 */
static const char *const ALIGN_NAMES[] = { "Auto", "Start", "End", "Center", "Fill" };

/* GTK's word for ours, for a child of anything that is not a drawing surface. */
static GtkAlign align_gtk(BtaAlign a)
{
    switch (a) {
    case BTA_ALIGN_START:  return GTK_ALIGN_START;
    case BTA_ALIGN_END:    return GTK_ALIGN_END;
    case BTA_ALIGN_CENTER: return GTK_ALIGN_CENTER;
    case BTA_ALIGN_FILL:   return GTK_ALIGN_FILL;
    case BTA_ALIGN_AUTO:   break;
    }
    /* What a box does with a child that never said: give it the whole cell. */
    return GTK_ALIGN_FILL;
}

/*
 * Hands the alignment to GTK -- but only where GTK is the one placing the
 * child.
 *
 * A `BtaFixed` allocates an exact rectangle it worked out itself, and GTK would
 * then align the widget *inside* that rectangle: a control drawn 200 wide with
 * HAlign Start would come back its natural width, which is neither what the
 * .form says nor what the anchor means. So a child of a surface is left FILL and
 * the surface goes on doing the arithmetic; everywhere else -- a box, a split, a
 * page -- the four words are handed straight to GTK, which is what makes them
 * mean anything there at all.
 */
static void widget_apply_align(BtaWidget *w)
{
    if (!w || !w->gtk || w->is_form)
        return;

    GtkWidget *parent = gtk_widget_get_parent(w->gtk);
    /* Asked of the arrangement and not of the widget's type: a Panel arranged
     * Horizontal is the same BtaFixed it was, and reading the type here would
     * force FILL on every child of every box -- which is to say, take HAlign and
     * VAlign away from the containers where they are the only way to place a
     * control at all. */
    bool       drawn  = parent && bta_surface_is_fixed(parent);

    gtk_widget_set_halign(w->gtk, drawn ? GTK_ALIGN_FILL : align_gtk(w->halign));
    gtk_widget_set_valign(w->gtk, drawn ? GTK_ALIGN_FILL : align_gtk(w->valign));

    /*
     * ...and the **parent** has to lay out again, because the parent's layout is
     * what carries an alignment out -- ours reads it off the child's `BtaWidget`
     * and a `GtkOverlay` reads GTK's own. `gtk_widget_set_halign` queues an
     * allocate on the *child*, which only re-allocates it into the rectangle it
     * already had, so the new alignment is stored and never applied.
     *
     * Measured, on a layer of an overlay: told `Center` in the `.form` and then
     * `Start` from code, it stayed at (185, 91) until something else made the
     * overlay lay out -- hiding it and showing it again, which is how it was
     * found, moved it to (0, 0). Anything a person changes in the property grid
     * is exactly this sequence.
     */
    if (parent)
        gtk_widget_queue_allocate(parent);
}

/* ------------------------------------------------------------------ Shortcut
 *
 * The keys that press this control, declared where the control is.
 *
 *     { "type": "Button", "name": "Btn7",
 *       "properties": { "Text": "7", "Shortcut": ["7", "KP_7"] } }
 *
 * A menu item has had `shortcut` since menus existed, and this is the same word
 * one widget further out -- because the question is the same one: **which key
 * means this command**.  Without it, a window whose buttons are also keys has to
 * carry a table of key names and a `KeyPress` that dispatches it, which is the
 * command written twice in two vocabularies.  The calculator example was thirty
 * lines of exactly that.
 *
 * A list because one accelerator is routinely not enough: a keypad `7` and a
 * row `7` are two keys meaning one thing, and desktops grab bare function keys
 * out from under an application.  Same reason a menu item takes a list.
 *
 * **It activates the control**, which is what each kind already means by being
 * pressed: a `Button` clicks, a `CheckButton` and a `ToggleButton` toggle, a
 * `TextBox` reports its `Activate`.  A control with nothing to activate -- a
 * `Label` -- accepts the property and does nothing with it, the same way
 * `Focusable` does.
 *
 * The action is GTK's own `activate`, deliberately, and not a callback of ours:
 * a callback would be a pointer to this wrapper held by a controller that
 * outlives it, which is the second crash class in architecture.md.  Activating
 * goes through the widget's existing "clicked" handler, which the finaliser's
 * sweep already disconnects.
 */
static void widget_clear_shortcuts(BtaWidget *w)
{
    if (w->shortcut_ctl) {
        gtk_widget_remove_controller(w->gtk, w->shortcut_ctl);
        w->shortcut_ctl = NULL;
    }
    g_clear_pointer(&w->shortcuts, g_strfreev);
}

static JSValue w_get_shortcut(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    guint n = w->shortcuts ? g_strv_length(w->shortcuts) : 0;

    /* What was written comes back in the shape it was written in, so a `.form`
     * round-trips: `""` for none, one accelerator as text, several as a list. */
    if (n == 0)
        return JS_NewString(ctx, "");
    if (n == 1)
        return JS_NewString(ctx, w->shortcuts[0]);

    JSValue out = JS_NewArray(ctx);
    for (guint i = 0; i < n; i++)
        JS_SetPropertyUint32(ctx, out, i, JS_NewString(ctx, w->shortcuts[i]));
    return out;
}

static JSValue w_set_shortcut(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GPtrArray *want = g_ptr_array_new_with_free_func(g_free);

    if (JS_IsString(val)) {
        const char *s = JS_ToCString(ctx, val);
        if (s && *s)
            g_ptr_array_add(want, g_strdup(s));
        JS_FreeCString(ctx, s);
    } else if (JS_IsArray(val)) {
        JSValue  lenv = JS_GetPropertyStr(ctx, val, "length");
        uint32_t n    = 0;
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);

        for (uint32_t i = 0; i < n; i++) {
            JSValue     e = JS_GetPropertyUint32(ctx, val, i);
            const char *s = JS_ToCString(ctx, e);
            if (s && *s)
                g_ptr_array_add(want, g_strdup(s));
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, e);
        }
    } else if (!JS_IsNull(val) && !JS_IsUndefined(val)) {
        g_ptr_array_unref(want);
        return JS_ThrowTypeError(ctx,
            "Shortcut takes an accelerator or a list of them");
    }

    /* Parsed before anything is torn down, so a bad one leaves the control with
     * the keys it had rather than with none -- the same bargain every setter
     * here makes about refusing before acting. */
    GPtrArray *keys = g_ptr_array_new();
    for (guint i = 0; i < want->len; i++) {
        guint           keyval = 0;
        GdkModifierType mods   = 0;

        if (!gtk_accelerator_parse(want->pdata[i], &keyval, &mods) || keyval == 0) {
            JSValue e = JS_ThrowRangeError(ctx,
                "Shortcut: '%s' is not an accelerator -- \"7\", \"KP_7\" and "
                "\"<Control>s\" are", (char *)want->pdata[i]);
            g_ptr_array_unref(keys);
            g_ptr_array_unref(want);
            return e;
        }
        g_ptr_array_add(keys, GUINT_TO_POINTER(keyval));
        g_ptr_array_add(keys, GUINT_TO_POINTER((guint)mods));
    }

    widget_clear_shortcuts(w);

    if (want->len > 0) {
        /*
         * Global scope, which is what makes a key work while the focus is
         * somewhere else entirely: GTK hands a global shortcut to the root and
         * the root offers it to every controller under it.  A local one would
         * only fire while this very widget had the focus, which for a button
         * nobody focuses is never.
         */
        GtkShortcutController *c =
            GTK_SHORTCUT_CONTROLLER(gtk_shortcut_controller_new());

        gtk_shortcut_controller_set_scope(c, GTK_SHORTCUT_SCOPE_GLOBAL);
        for (guint i = 0; i < keys->len; i += 2) {
            gtk_shortcut_controller_add_shortcut(c, gtk_shortcut_new(
                gtk_keyval_trigger_new(GPOINTER_TO_UINT(keys->pdata[i]),
                                       GPOINTER_TO_UINT(keys->pdata[i + 1])),
                g_object_ref(gtk_activate_action_get())));
        }
        w->shortcut_ctl = GTK_EVENT_CONTROLLER(c);
        gtk_widget_add_controller(w->gtk, w->shortcut_ctl);

        g_ptr_array_add(want, NULL);
        w->shortcuts = (char **)g_ptr_array_free(want, FALSE);
        want = NULL;
    }
    g_ptr_array_unref(keys);
    if (want)
        g_ptr_array_unref(want);
    return JS_UNDEFINED;
}

enum { ALIGN_H, ALIGN_V };

static JSValue w_get_align(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, ALIGN_NAMES[magic == ALIGN_H ? w->halign : w->valign]);
}

static JSValue w_set_align(JSContext *ctx, JSValueConst this_val,
                           JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    BtaAlign chosen = BTA_ALIGN_AUTO;
    bool     found  = false;
    for (unsigned i = 0; i < G_N_ELEMENTS(ALIGN_NAMES) && !found; i++)
        if (!g_ascii_strcasecmp(s, ALIGN_NAMES[i])) {
            chosen = (BtaAlign)i;
            found  = true;
        }

    if (!found) {
        JSValue e = JS_ThrowRangeError(ctx,
            "%s must be Auto, Start, End, Center or Fill, not '%s'",
            magic == ALIGN_H ? "HAlign" : "VAlign", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    if (magic == ALIGN_H)
        w->halign = chosen;
    else
        w->valign = chosen;

    bta_widget_relayout(w);
    return JS_UNDEFINED;
}

/*
 * Menu: this widget's context menu, declared exactly as a form's menu bar is.
 *
 *   Canvas.Menu = [{ name: "MnuDel", text: "Delete" },
 *                  { separator: true },
 *                  { name: "MnuTop", text: "Bring to front" }];
 *
 * The items are exposed on the form by name and dispatch as MnuDel_Click(),
 * so a handler cannot tell whether it was chosen from a bar or from a right
 * click -- and a `.form` can declare one as an ordinary property, because the
 * loader applies properties as plain assignments.
 *
 * The spec is kept as written: a GMenu cannot be walked back into one, and
 * without it the serialiser would drop a menu it could not reconstruct. That
 * is the same reason a form keeps __menus.
 */
static JSValue w_get_menu(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_DupValue(ctx, w->menu);
}

static JSValue w_set_menu(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (!JS_IsArray(val) && !JS_IsNull(val) && !JS_IsUndefined(val))
        return JS_ThrowTypeError(ctx, "Menu takes an array of items, or null");

    /* The items name handlers on the form, so a widget with no form yet has
     * nowhere to dispatch to -- which is the .form loader's order of business,
     * not an error: it binds the control and then applies the properties. */
    if (bta_menu_popup_build(ctx, w->form, w, val) < 0)
        return JS_EXCEPTION;

    JS_FreeValue(ctx, w->menu);
    w->menu = JS_IsArray(val) ? JS_DupValue(ctx, val) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

/* Defined with the mouse handlers, which is the other caller. */
static void popup_nearest(BtaWidget *w, double x, double y);

static JSValue w_popup_menu(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    double x = 0, y = 0;
    if (argc > 0) JS_ToFloat64(ctx, &x, argv[0]);
    if (argc > 1) JS_ToFloat64(ctx, &y, argv[1]);

    /* The same walk a right click does, so "open the menu for this point"
     * means one thing however it was asked for. */
    popup_nearest(w, x, y);
    return JS_UNDEFINED;
}

/*
 * Which widget a margin goes on -- and on a **form** it is the surface and not
 * the window.
 *
 * A margin on a toplevel insets the window's *content* inside its own surface,
 * and the window's background is painted on the content: what is left is a band
 * of the window that nothing draws at all. On a compositor that band is
 * **transparent** -- the desktop shows through the right and bottom edges of the
 * window -- and it looked, reasonably enough, like a bug in whatever the form
 * happened to contain. Two examples here declared `Margin: 8` on the form and
 * both showed it; measured, a 300x200 window came out with its content 284x184
 * and sixteen pixels of nothing.
 *
 * `Margin` on a form now means *inset what is inside it*, which is what anybody
 * writing it meant, and the window paints its whole self. It lands on the
 * surface, so a menu bar -- which is a sibling of the surface and not inside it
 * -- keeps spanning the window, which is also right.
 */
static GtkWidget *margin_target(BtaWidget *w)
{
    return w->is_form && w->slot ? w->slot : w->gtk;
}

static JSValue w_get_margin(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gtk_widget_get_margin_start(margin_target(w)));
}

static JSValue w_set_margin(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Margin", &n))
        return JS_EXCEPTION;

    GtkWidget *on = margin_target(w);

    gtk_widget_set_margin_start(on, n);
    gtk_widget_set_margin_end(on, n);
    gtk_widget_set_margin_top(on, n);
    gtk_widget_set_margin_bottom(on, n);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------- Style, and colours
 *
 * How an application is dressed, in the order the cascade reads it:
 *
 *   the desktop's theme                    what a control looks like by default
 *   <project>/app.css      APPLICATION     the application's own classes
 *   Background/Font/...    APPLICATION+1   this one control, this once
 *
 * `Style` names classes from the middle layer -- the application's, or one of
 * the theme's own (`suggested-action`, `title-1`, `dim-label`) -- and is the
 * normal way to say what a control should look like: written once in the
 * stylesheet, worn by every control that needs it.  The three properties below
 * dress one control by hand, and sit above the sheet so that they still win
 * where they are used; they are meant for what a class cannot say, which is a
 * colour computed while the program runs.  The designer's own selection bars
 * are exactly that case.
 */

/*
 * A class name, as CSS spells one: letters, digits, '-' and '_', not starting
 * with a digit.  Anything else is refused rather than kept -- unlike a font
 * family or an icon name, nothing downstream could ever resolve it, so a typo
 * is only ever a typo, and one that shows up as "the style did nothing".
 */
static bool style_name_ok(const char *s)
{
    if (!*s || g_ascii_isdigit(*s))
        return false;
    for (const char *p = s; *p; p++)
        if (!g_ascii_isalnum(*p) && *p != '-' && *p != '_')
            return false;
    return true;
}

/* The names in a Style string, empties dropped.  Commas are accepted beside
 * spaces because both readings are natural and neither can mean anything else. */
static char **style_split(const char *s)
{
    char **all = g_strsplit_set(s, " \t\r\n,", -1);
    char **out = g_new0(char *, g_strv_length(all) + 1);
    int    n   = 0;

    for (char **p = all; *p; p++)
        if (**p)
            out[n++] = g_strdup(*p);
    g_strfreev(all);
    return out;
}

static JSValue w_get_style(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, w->style ? w->style : "");
}

static JSValue w_set_style(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    char **names = style_split(s);
    JS_FreeCString(ctx, s);

    /* Checked before anything is touched: half an assignment would leave the
     * control wearing the classes up to the bad one and reporting all of them. */
    for (char **p = names; *p; p++) {
        if (!style_name_ok(*p)) {
            JSValue e = JS_ThrowRangeError(ctx, "'%s' is not a style class name", *p);
            g_strfreev(names);
            return e;
        }
    }

    /* Only what Style put there comes off: a control's own classes are GTK's
     * (a Button is `button`), and the per-widget colour class is ours. */
    if (w->style) {
        char **had = style_split(w->style);
        for (char **p = had; *p; p++)
            gtk_widget_remove_css_class(w->gtk, *p);
        g_strfreev(had);
        g_clear_pointer(&w->style, g_free);
    }

    for (char **p = names; *p; p++)
        gtk_widget_add_css_class(w->gtk, *p);

    if (*names)
        w->style = g_strjoinv(" ", names);
    g_strfreev(names);
    return JS_UNDEFINED;
}

/*
 * Background/Foreground go through one display-wide stylesheet, with a CSS
 * class per widget that uses them.  Colours are parsed and re-serialised
 * rather than pasted in, so a value can never escape into the stylesheet as
 * extra rules.
 */
static GtkCssProvider *style_provider;
static GHashTable     *style_rules;    /* class name -> rule body */
static guint           style_serial;

static void styles_rebuild(void)
{
    GString       *css = g_string_new(NULL);
    GHashTableIter it;
    gpointer       key, value;

    g_hash_table_iter_init(&it, style_rules);
    while (g_hash_table_iter_next(&it, &key, &value))
        g_string_append_printf(css, ".%s { %s }\n", (char *)key, (char *)value);

    gtk_css_provider_load_from_string(style_provider, css->str);
    g_string_free(css, TRUE);
}

/*
 * **One rebuild per form, not one per property -- and only while a form is
 * being built.**
 *
 * The sheet is every styled widget's rule in one string, so loading it is
 * O(rules), and doing that after each assignment made loading a form O(rules²).
 * Measured on a `.form` of plain `Label`s with two appearance properties each:
 * **50 controls 112 ms, 100 controls 667 ms, 200 controls 2392 ms**, against
 * 5 ms for the same form with no appearance at all. Two seconds to open a
 * window is not a cost to weigh against something, it is a form that looks
 * broken.
 *
 * **Coalescing on an idle was tried first and is wrong**, which is worth
 * writing down because it reads as obviously safe: the sheet *is* read back.
 * A `DrawingArea` takes its ink from its control's style context, and `Save()`
 * draws **synchronously** -- so a program that sets `Foreground` and saves a
 * PNG in the same turn got the theme's colour instead of its own, and
 * `tests/widgets` says so (*a drawing takes its ink from the control's
 * Foreground*). Two of `tests/ide`'s designer assertions went the same way.
 *
 * So the hold is scoped to the one place the quadratic actually happens --
 * `bta_form_build`, which raises it around a whole tree and drops it once --
 * and every other path rebuilds when it writes, exactly as before. A hold that
 * is open when something asks to draw is not a case that exists: nothing runs
 * JavaScript between the loader's first node and its last.
 */
static int  style_hold;            /* >0 while a form is being built */
static bool style_dirty;

static void styles_touch(void)
{
    if (style_hold > 0) {
        style_dirty = true;
        return;
    }
    styles_rebuild();
}

void bta_widget_styles_hold(void)
{
    style_hold++;
}

void bta_widget_styles_release(void)
{
    if (style_hold > 0 && --style_hold == 0 && style_dirty) {
        style_dirty = false;
        styles_rebuild();
    }
}

static void widget_style_write(BtaWidget *w, GString *body);

/*
 * The CSS this widget's own appearance comes to.
 *
 * Split out of `widget_styles_apply` so it can be *asked for* as well as
 * applied: the IDE's class editor sets these same properties on a control and
 * writes what comes back into the project's `app.css`, which means the units,
 * the colour normalising and Pango's three traps are written in one place and
 * read from it -- rather than a second, JavaScript, spelling of the same rules
 * that would drift the first time one of them was fixed.
 */
static char *widget_style_body(BtaWidget *w)
{
    GString *body = g_string_new(NULL);

    widget_style_write(w, body);
    return g_string_free(body, FALSE);
}

static void widget_styles_apply(BtaWidget *w)
{
    if (!style_provider) {
        style_provider = gtk_css_provider_new();
        style_rules    = g_hash_table_new_full(g_str_hash, g_str_equal,
                                               g_free, g_free);
        /* One above the application's stylesheet, which is loaded at
         * PRIORITY_APPLICATION: a colour set on a control by hand is the
         * exception, and an exception that lost to the sheet would be no use. */
        gtk_style_context_add_provider_for_display(
            gdk_display_get_default(), GTK_STYLE_PROVIDER(style_provider),
            GTK_STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
    }

    if (!w->style_class) {
        w->style_class = g_strdup_printf("bta-s%u", ++style_serial);
        gtk_widget_add_css_class(w->gtk, w->style_class);
    }

    GString *body = g_string_new(NULL);
    widget_style_write(w, body);

    g_hash_table_insert(style_rules, g_strdup(w->style_class),
                        g_string_free(body, FALSE));
    styles_touch();
}

static void widget_style_write(BtaWidget *w, GString *body)
{
    if (w->background) {
        /* A theme paints a button with a gradient, which is a background-image
         * and would sit on top of any colour set here: asking for a solid
         * colour has to mean the colour is what shows. */
        g_string_append_printf(body, "background-color: %s; background-image: none; ",
                               w->background);
    }
    if (w->foreground)
        g_string_append_printf(body, "color: %s; ", w->foreground);

    if (w->radius) {
        /* Built here from integers, so the units are added on the way out and
         * what is stored stays the plain list the property reports. */
        char **parts = g_strsplit(w->radius, " ", -1);

        g_string_append(body, "border-radius:");
        for (char **p = parts; *p; p++)
            g_string_append_printf(body, " %spx", *p);
        g_string_append(body, "; ");
        g_strfreev(parts);
    }

    if (w->padding) {
        char **parts = g_strsplit(w->padding, " ", -1);

        g_string_append(body, "padding:");
        for (char **p = parts; *p; p++)
            g_string_append_printf(body, " %spx", *p);
        g_string_append(body, "; ");
        g_strfreev(parts);
    }

    if (w->shadow) {
        /* Four sizes and a colour, in that order and nothing else: built here,
         * so the units go on the way out like the radius's do. */
        char **parts = g_strsplit(w->shadow, " ", 5);

        if (g_strv_length(parts) == 5)
            g_string_append_printf(body, "box-shadow: %spx %spx %spx %spx %s; ",
                                   parts[0], parts[1], parts[2], parts[3], parts[4]);
        g_strfreev(parts);
    }

    if (w->border) {
        char **parts = g_strsplit(w->border, " ", 3);

        if (g_strv_length(parts) == 3)
            g_string_append_printf(body, "border: %spx %s %s; ",
                                   parts[0], parts[1], parts[2]);
        g_strfreev(parts);
    }

    if (w->font_scale != 1.0) {
        /*
         * Per cent, so it is a factor of whatever font is in force -- the
         * desktop's, or the one a class further up asked for. The locale writes
         * a comma for a decimal point and CSS does not parse one.
         *
         * **1 writes nothing**, and that is not only tidiness: `font-size: 100%`
         * is a declaration like any other, so on a control also wearing
         * `.title-1` it would win and undo it. The same reason `font-weight: 400`
         * is not written.
         */
        char buf[G_ASCII_DTOSTR_BUF_SIZE];

        g_ascii_formatd(buf, sizeof buf, "%g", w->font_scale * 100.0);
        g_string_append_printf(body, "font-size: %s%%; ", buf);
    }

    if (w->opacity < 1.0) {
        char buf[G_ASCII_DTOSTR_BUF_SIZE];

        g_ascii_formatd(buf, sizeof buf, "%g", w->opacity);
        g_string_append_printf(body, "opacity: %s; ", buf);
    }

    if (w->font) {
        /*
         * Written out property by property rather than as a shorthand: every
         * piece comes from the parsed description, so nothing of what was
         * assigned reaches the stylesheet as text -- the same care the colours
         * take, and for the same reason.
         */
        PangoFontDescription *d = pango_font_description_from_string(w->font);
        PangoFontMask         have = pango_font_description_get_set_fields(d);

        if ((have & PANGO_FONT_MASK_FAMILY) && pango_font_description_get_family(d))
            g_string_append_printf(body, "font-family: \"%s\"; ",
                                   pango_font_description_get_family(d));
        if (have & PANGO_FONT_MASK_SIZE) {
            /*
             * Three things this has to get right, and each was wrong once:
             *
             *  - the size is fractional. Integer division made "Cantarell 11.5"
             *    draw at 11 while the property still said 11.5.
             *  - a description can be *absolute*, and then the number is device
             *    units, not points. "Cantarell 12px" written out as 12pt draws
             *    a third too large.
             *  - the decimal separator is the locale's, and GTK calls
             *    setlocale() at startup. On this machine %g writes "11,5",
             *    which CSS does not parse. g_ascii_formatd always writes ".".
             */
            double size = pango_font_description_get_size(d) / (double)PANGO_SCALE;
            char   buf[G_ASCII_DTOSTR_BUF_SIZE];

            g_ascii_formatd(buf, sizeof buf, "%g", size);
            g_string_append_printf(body, "font-size: %s%s; ", buf,
                pango_font_description_get_size_is_absolute(d) ? "px" : "pt");
        }
        /*
         * **Only when they are not the default**, and that is not tidiness.
         *
         * `pango_font_description_from_string` marks weight and style as *set*
         * whatever the text said, so `Font = "12"` came out as
         * `font-size: 12pt; font-weight: 400; font-style: normal` -- two
         * declarations nobody asked for, and in a class they are worse than
         * noise: they override whatever the theme or another class said. GTK's
         * own headings are `font-weight: 800; font-size: 200%` and nothing else,
         * which is exactly why they compose.
         *
         * What is lost is saying *regular* over something bold, which reads the
         * same as saying nothing and is a rule to write by hand.
         */
        int weight = (int)pango_font_description_get_weight(d);
        if ((have & PANGO_FONT_MASK_WEIGHT) && weight != PANGO_WEIGHT_NORMAL)
            g_string_append_printf(body, "font-weight: %d; ", weight);

        if ((have & PANGO_FONT_MASK_STYLE) &&
            pango_font_description_get_style(d) != PANGO_STYLE_NORMAL)
            g_string_append(body, "font-style: italic; ");

        pango_font_description_free(d);
    }
}

/*
 * Font: the same bargain the colours make, in Pango's spelling.
 *
 * "Cantarell Bold 12" -- a family, an optional size and whatever else Pango
 * understands. It is parsed and written back out, so what is stored is Pango's
 * own spelling of it and never the string as typed: a .form cannot smuggle
 * anything into the stylesheet through here.
 *
 * What it does *not* do is judge. Pango takes almost anything -- "," comes back
 * as "Normal" -- so a family nobody has is kept and falls back at render time,
 * exactly as an unknown Icon name is kept. `""`, or a run of spaces, is none:
 * whatever the theme says.
 */
static JSValue w_get_font(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, w->font ? w->font : "");
}

static JSValue w_set_font(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    /* Blank means none, the same as "": a run of spaces describes no font, and
     * treating it as an error would be pedantry rather than help. */
    const char *trimmed = s;
    while (*trimmed == ' ' || *trimmed == '\t') trimmed++;

    char *parsed = NULL;
    if (*trimmed) {
        PangoFontDescription *d = pango_font_description_from_string(trimmed);
        if (d) {
            parsed = pango_font_description_to_string(d);
            pango_font_description_free(d);
        }
    }
    JS_FreeCString(ctx, s);

    g_free(w->font);
    w->font = parsed;

    widget_styles_apply(w);
    return JS_UNDEFINED;
}

/*
 * One to four sizes in pixels, in CSS's order and with CSS's meaning: the shape
 * `Radius` and `Padding` both take.
 *
 * Numbers and nothing else, parsed and written back out, so a value can no more
 * escape into the stylesheet here than a colour can. Nothing at all -- `""`, or a
 * run of spaces -- is NULL, which is the property saying nothing and leaving the
 * theme to.
 *
 * Returns false and leaves *out untouched when the text is not that, so the
 * caller can refuse without having changed anything.
 */
static bool sizes_parse(JSContext *ctx, JSValueConst val, char **out)
{
    /* A number is the ordinary case and reads as one from JS, so it is taken
     * without a detour through text. */
    char *text = NULL;
    if (JS_IsNumber(val)) {
        double n = 0;
        if (JS_ToFloat64(ctx, &n, val) < 0)
            return false;
        text = g_strdup_printf("%d", (int)n);
    } else {
        const char *s = JS_ToCString(ctx, val);
        if (!s)
            return false;
        text = g_strdup(s);
        JS_FreeCString(ctx, s);
    }

    char **parts = g_strsplit_set(text, " \t", -1);
    g_free(text);

    int  size[4] = { 0, 0, 0, 0 };
    int  n       = 0;
    bool ok      = true;

    for (char **p = parts; *p && ok; p++) {
        if (!**p)
            continue;                   /* a run of spaces is not a value */
        if (n == 4) { ok = false; break; }

        char *end = NULL;
        long  v   = strtol(*p, &end, 10);

        /* "8px" is how CSS spells it and how anyone would write it; the unit is
         * the only one there is here, so it is accepted and dropped. */
        if (end == *p || (*end && g_strcmp0(end, "px")) || v < 0 || v > 1000)
            ok = false;
        else
            size[n++] = (int)v;
    }
    g_strfreev(parts);

    if (!ok)
        return false;

    if (n == 0)      *out = NULL;
    else if (n == 1) *out = g_strdup_printf("%d", size[0]);
    else if (n == 2) *out = g_strdup_printf("%d %d", size[0], size[1]);
    else if (n == 3) *out = g_strdup_printf("%d %d %d", size[0], size[1], size[2]);
    else             *out = g_strdup_printf("%d %d %d %d",
                                            size[0], size[1], size[2], size[3]);
    return true;
}

/*
 * Radius: rounded corners, through the same per-widget stylesheet as the
 * colours and the font, and for the same reason -- there is no class in a theme
 * for "this rectangle is rounded by this much".
 *
 * One number rounds all four corners, four round them one at a time in CSS's
 * order (top-left, top-right, bottom-right, bottom-left); two and three follow
 * CSS as well. That is what a window wants: its top corners are rounded and its
 * bottom ones are not, which one number cannot say.
 *
 * `""` is square again, and so is a radius of zero -- there is only one way for
 * a corner to be square, so neither is worth writing to a .form.
 */
static JSValue w_get_radius(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, w->radius ? w->radius : "");
}

static JSValue w_set_radius(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    char *radius = NULL;
    if (!sizes_parse(ctx, val, &radius))
        return JS_ThrowRangeError(ctx, "Radius takes one to four sizes in pixels");

    /* Every corner zero is the same as no radius at all. */
    if (radius && !strpbrk(radius, "123456789"))
        g_clear_pointer(&radius, g_free);

    g_free(w->radius);
    w->radius = radius;

    widget_styles_apply(w);
    return JS_UNDEFINED;
}

/*
 * Padding: the room a control keeps *inside* its own edge, which is the half of
 * spacing `Margin` does not cover -- margin pushes the neighbours away, padding
 * pushes the contents in.
 *
 * GTK has no widget-level padding at all: it is a CSS property and nothing else,
 * so this goes through the per-widget stylesheet like the colours. That is also
 * what makes it the answer to a theme one cannot select into. GTK's own window
 * buttons are `padding: 0` inside a `windowcontrols` node, and nothing an
 * application builds is that node -- so a title bar drawn by hand comes out
 * taller than the desktop's until it can say the same thing.
 *
 * **Zero is not nothing here**, unlike `Radius`: `0` is a control asking for no
 * padding *against* a theme that gives it some, and `""` is the control saying
 * nothing and taking whatever the theme says.
 */
static JSValue w_get_padding(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, w->padding ? w->padding : "");
}

static JSValue w_set_padding(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    char *padding = NULL;
    if (!sizes_parse(ctx, val, &padding))
        return JS_ThrowRangeError(ctx, "Padding takes one to four sizes in pixels");

    g_free(w->padding);
    w->padding = padding;

    widget_styles_apply(w);
    return JS_UNDEFINED;
}

/*
 * Shadow: what the control casts on whatever is behind it.
 *
 * CSS's own shorthand, minus what nobody needs here: `"x y blur spread colour"`,
 * where the offsets may be negative, the blur and the spread may not, and the
 * colour is optional and defaults to a translucent black. One shadow, not a
 * list, and never `inset` -- a control that is lit from inside is a border.
 *
 * The colour goes through GdkRGBA exactly as `Background` does and is written
 * back out from the parsed value, so nothing reaches the stylesheet as text.
 *
 * What asked for it is a window that is not one: the designer draws a form with
 * the decoration it will be shown with, and a window on a desk is *above* the
 * desk. GTK says so in `window.csd { box-shadow: 0 3px 9px 1px rgba(0,0,0,0.5) }`
 * -- a rule on a node no application can build, which is the same corner
 * `Radius` and `Padding` are here to get out of.
 */
static JSValue w_get_shadow(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, w->shadow ? w->shadow : "");
}

static JSValue w_set_shadow(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    char **parts = g_strsplit_set(s, " \t", -1);
    JS_FreeCString(ctx, s);

    int      offset[4] = { 0, 0, 0, 0 };   /* x, y, blur, spread */
    int      n         = 0;
    bool     ok        = true;
    GdkRGBA  colour    = { 0, 0, 0, 0.5 }; /* what a shadow is, unless it is told */
    GString *rest      = g_string_new(NULL);

    for (char **p = parts; *p && ok; p++) {
        if (!**p)
            continue;                      /* a run of spaces is not a value */

        char *end = NULL;
        long  v   = strtol(*p, &end, 10);
        bool  num = end != *p && (!*end || !g_strcmp0(end, "px"));

        /* Numbers first and the colour after, which is the order CSS writes
         * them in: once something is not a number, the rest is the colour. */
        if (num && !rest->len) {
            if (n == 4 || (n >= 2 && v < 0))
                ok = false;                /* a blur cannot be negative */
            else
                offset[n++] = (int)v;
        } else {
            if (rest->len)
                g_string_append_c(rest, ' ');
            g_string_append(rest, *p);
        }
    }
    g_strfreev(parts);

    bool tinted = rest->len > 0;
    if (ok && tinted)
        ok = gdk_rgba_parse(&colour, rest->str);
    g_string_free(rest, TRUE);

    /* A shadow falls somewhere, so it needs at least where: a colour on its own
     * is not one, and neither is a single number.  Nothing at all is none. */
    if (ok && (n || tinted) && n < 2)
        ok = false;

    if (!ok)
        return JS_ThrowRangeError(ctx,
                                  "Shadow takes 'x y blur spread' and a colour");

    g_clear_pointer(&w->shadow, g_free);
    if (n) {
        char *rgba = gdk_rgba_to_string(&colour);

        w->shadow = g_strdup_printf("%d %d %d %d %s",
                                    offset[0], offset[1], offset[2], offset[3],
                                    rgba);
        g_free(rgba);
    }

    widget_styles_apply(w);
    return JS_UNDEFINED;
}

enum { COLOR_BG, COLOR_FG };

static JSValue w_get_color(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *c = magic == COLOR_BG ? w->background : w->foreground;
    return JS_NewString(ctx, c ? c : "");
}

static JSValue w_set_color(JSContext *ctx, JSValueConst this_val,
                           JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    char *parsed = NULL;
    if (*s) {
        GdkRGBA rgba;
        if (!gdk_rgba_parse(&rgba, s)) {
            JSValue e = JS_ThrowRangeError(ctx, "'%s' is not a colour", s);
            JS_FreeCString(ctx, s);
            return e;
        }
        parsed = gdk_rgba_to_string(&rgba);
    }
    JS_FreeCString(ctx, s);

    char **slot = magic == COLOR_BG ? &w->background : &w->foreground;
    g_free(*slot);
    *slot = parsed;

    widget_styles_apply(w);
    return JS_UNDEFINED;
}

/*
 * What was asked for, as opposed to what GTK gave: -1 on an axis nobody
 * declared, which is GTK's own word for "whatever it comes to naturally" and
 * the value the widget starts life with.
 *
 * `Width` and `Height` cannot answer this. They fall back to the allocation when
 * nothing was declared, which is what makes them worth reading and useless to
 * write down: inside a box a size is a *request*, i.e. a floor, so saving what a
 * control happened to measure today is saving a minimum it can never go under
 * tomorrow. The serialiser asks here instead. See collectProperties in rad.js.
 */
static JSValue w_size_request(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue out = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, out, 0, JS_NewInt32(ctx, w->w));
    JS_SetPropertyUint32(ctx, out, 1, JS_NewInt32(ctx, w->h));
    return out;
}

/* ---------------------------------------------------- base Widget methods */

static JSValue w_show(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    gtk_widget_set_visible(w->gtk, TRUE);
    return JS_UNDEFINED;
}

static JSValue w_hide(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    gtk_widget_set_visible(w->gtk, FALSE);
    return JS_UNDEFINED;
}

static JSValue w_move(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t x = w->x, y = w->y;
    if (argc > 0 && JS_ToInt32(ctx, &x, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && JS_ToInt32(ctx, &y, argv[1]))
        return JS_EXCEPTION;

    w->x = x;
    w->y = y;
    bta_widget_relayout(w);
    return JS_UNDEFINED;
}

static JSValue w_resize(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t width = w->w, height = w->h;
    if (argc > 0 && JS_ToInt32(ctx, &width, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && JS_ToInt32(ctx, &height, argv[1]))
        return JS_EXCEPTION;

    w->w = width;
    w->h = height;
    bta_widget_relayout(w);
    return JS_UNDEFINED;
}

static JSValue w_set_focus(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    gtk_widget_grab_focus(w->inner ? w->inner : w->gtk);
    return JS_UNDEFINED;
}

/* The controller behind `Focused` and the two focus events, kept on the widget so
 * either can reach it. */
#define FOCUS_KEY "bta-focus-controller"

/*
 * Whether the focus is in this control.  Read-only: where the focus is is a fact
 * about the moment and not part of a design, and a setter would have the
 * serialiser write it into the `.form` -- `SetFocus()` is how it moves.
 *
 * Asked of the controller and not of `gtk_widget_has_focus`, which answers about
 * the widget itself: a TextBox's focus sits on the GtkText inside its entry, so
 * the honest answer to "does this control have the focus" is *contains*.
 */
static JSValue w_get_focused(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkEventControllerFocus *focus = g_object_get_data(G_OBJECT(w->gtk), FOCUS_KEY);
    return JS_NewBool(ctx, focus &&
                           gtk_event_controller_focus_contains_focus(focus));
}

/*
 * Stacking order.  Children paint in list order, so a control dragged under
 * another one simply disappears -- unacceptable in a designer.
 *
 * On a fixed surface it is a bare sibling reorder: the surface keeps no
 * per-child layout data to lose, so nothing has to be taken out and put back
 * the way GtkFixed once forced.
 *
 * **A slot that keeps bookkeeping of its own goes through `Reorder` instead**,
 * with the index worked out here, because a sibling move there is not the whole
 * of the order and saying it twice is how the two drift apart. Three of them:
 * an `Overlay`, whose bottom layer is a property and not merely a position --
 * `Raise` on the base used to leave it filling while painting over its own
 * floaters -- and a `Flow` and a `RowList`, whose wrappers GTK keeps in a
 * sequence the sibling list does not move. In a stack the bottom is the layer
 * that fills, so `Lower` there means *become the base*.
 */
enum { STACK_RAISE, STACK_LOWER };

static JSValue w_restack(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkWidget *slot = gtk_widget_get_parent(bta_child_holder(w->gtk));
    if (!slot)
        return JS_UNDEFINED;

    if (GTK_IS_OVERLAY(slot) || GTK_IS_FLOW_BOX(slot) || GTK_IS_LIST_BOX(slot)) {
        BtaWidget *own = g_object_get_data(G_OBJECT(slot), BTA_WIDGET_QUARK);
        int        n   = bta_container_count(slot);

        if (!own || n < 2)
            return JS_UNDEFINED;

        return bta_container_reorder(ctx, own, w,
                                     magic == STACK_RAISE ? n - 1 : 0)
             ? JS_UNDEFINED : JS_EXCEPTION;
    }

    if (magic == STACK_RAISE) {
        GtkWidget *last = gtk_widget_get_last_child(slot);
        if (last && last != w->gtk)
            gtk_widget_insert_after(w->gtk, slot, last);
    } else {
        GtkWidget *first = gtk_widget_get_first_child(slot);
        if (first && first != w->gtk)
            gtk_widget_insert_before(w->gtk, slot, first);
    }
    return JS_UNDEFINED;
}

/*
 * Where this widget's top-left sits inside `container`, as [x, y].
 *
 * X/Y are relative to the immediate parent, so a control nested two levels
 * down cannot be drawn on an overlay without asking the layout where it
 * actually ended up. Null when the two are not in the same window.
 */
static JSValue w_origin_in(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    BtaWidget *ref = argc > 0 ? bta_widget_of(argv[0]) : NULL;
    if (!ref)
        return JS_ThrowTypeError(ctx, "OriginIn(container) expects a widget");

    graphene_point_t out;
    if (!gtk_widget_compute_point(w->gtk, ref->gtk,
                                  &GRAPHENE_POINT_INIT(0.0f, 0.0f), &out))
        return JS_NULL;

    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, (int)out.x));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, (int)out.y));
    return arr;
}

static JSValue w_delete(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (w->is_form)
        return JS_ThrowTypeError(ctx, "use Close() on a form, not Delete()");

    return bta_container_detach(ctx, w) ? JS_UNDEFINED : JS_EXCEPTION;
}

/* Detach from the current parent without destroying the widget. Needed
 * for re-parenting in GTK 4, where a container refuses
 * a widget that already has a parent. */
static JSValue w_remove(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return bta_container_detach(ctx, w) ? JS_UNDEFINED : JS_EXCEPTION;
}

/* ------------------------------------------------------------------------
 * What a class written in JS declares about itself.
 *
 * The three walks below look a prototype up in the class table, and a class of
 * the *project* is not in it -- it is a `class Stepper extends Component`, built
 * at load time by the loader.  Its properties were discoverable anyway, because
 * an accessor is a thing that is *there*: `settableProperties` in rad.js walks
 * the same chain and finds them.  Its events, the values its properties accept
 * and which of its strings hold prose are **declarations**, and it had nowhere
 * to put them: a Stepper answered with Widget's mouse events however much it
 * emitted, and `EventNames()[0]` -- which is the event a double click writes --
 * was `MouseDown` for every component ever written.
 *
 * So the class states them, where `Record` already states its `Fields`:
 *
 *     class Stepper extends Component {
 *         static Events         = ["Change"];
 *         static Options        = { Step: ["1", "5", "10"] };
 *         static TextProperties = ["Caption"];
 *     }
 *
 * Read inside the walk that is already happening rather than bolted onto the
 * answer afterwards, which is what keeps three things true for free: the order
 * (a class's own before what it inherits, which is the whole of why
 * `EventNames()[0]` means anything), the difference between accumulating and
 * first-match, and a JS class that extends another JS class -- which a walk
 * starting again from the top would have to rediscover.
 * ---------------------------------------------------------------------- */

/*
 * An **own** property, or undefined.
 *
 * Own, because a class constructor inherits its parent's statics: reading
 * through would have `class Chip extends Stepper {}` report Stepper's `Change`
 * at Chip's step of the walk, and again at Stepper's.  The same reason
 * `Widget.TypeName` reads `__type` as an own property.
 *
 * An absent property and an object that will not answer for one are the same
 * answer here, so both come back undefined.
 */
static JSValue own_property(JSContext *ctx, JSValueConst obj, const char *name)
{
    JSAtom               atom = JS_NewAtom(ctx, name);
    JSPropertyDescriptor desc;
    int                  found = JS_GetOwnProperty(ctx, &desc, obj, atom);
    JS_FreeAtom(ctx, atom);

    if (found != 1)
        return JS_UNDEFINED;

    /* A declaration is a value and never an accessor: reading one would mean
     * running the project's code to answer a question about its shape. */
    JS_FreeValue(ctx, desc.getter);
    JS_FreeValue(ctx, desc.setter);
    return desc.value;
}

/* The class this prototype belongs to, or undefined for one that has none. */
static JSValue class_of_proto(JSContext *ctx, JSValueConst proto)
{
    return own_property(ctx, proto, "constructor");
}

/*
 * A name goes in once: a subclass may name what its parent already did, and the
 * answer is a set rather than a tally.  Takes ownership of `name`.
 */
static void list_add(GPtrArray **out, char *name)
{
    if (!*out)
        *out = g_ptr_array_new();

    for (guint k = 0; k < (*out)->len; k++) {
        if (g_str_equal((*out)->pdata[k], name)) {
            g_free(name);
            return;
        }
    }
    g_ptr_array_add(*out, name);
}

/*
 * The strings of a `static <name> = [...]` on this prototype's class, appended.
 *
 * Only strings, and only from a real array: a list a class computes is not a
 * declaration, and a half-read one would be published as if it were whole.
 */
static void class_static_list(JSContext *ctx, JSValueConst proto,
                              const char *name, GPtrArray **out)
{
    JSValue ctor = class_of_proto(ctx, proto);
    if (!JS_IsObject(ctor)) {
        JS_FreeValue(ctx, ctor);
        return;
    }

    JSValue declared = own_property(ctx, ctor, name);
    JS_FreeValue(ctx, ctor);

    int64_t len = 0;
    if (JS_IsArray(declared) && JS_GetLength(ctx, declared, &len) == 0) {
        for (int64_t i = 0; i < len; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, declared, (uint32_t)i);

            if (JS_IsString(item)) {
                const char *text = JS_ToCString(ctx, item);
                if (text && *text)
                    list_add(out, g_strdup(text));
                JS_FreeCString(ctx, text);
            }
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, declared);
}

/*
 * The values this prototype's class declares for one property -- `static
 * Options = { Step: ["1", "5", "10"] }` -- or null where it declares none,
 * which is what lets the walk go on to the parent.
 *
 * Copied rather than handed back, for the reason the C side returns a literal:
 * what a class declares is not something a property editor should be able to
 * edit out from under it.
 */
static JSValue class_static_options(JSContext *ctx, JSValueConst proto,
                                    const char *prop)
{
    JSValue ctor = class_of_proto(ctx, proto);
    if (!JS_IsObject(ctor)) {
        JS_FreeValue(ctx, ctor);
        return JS_NULL;
    }

    JSValue options = own_property(ctx, ctor, "Options");
    JS_FreeValue(ctx, ctor);

    if (!JS_IsObject(options) || JS_IsArray(options)) {
        JS_FreeValue(ctx, options);
        return JS_NULL;
    }

    /* Own again, so `PropertyOptions("constructor")` cannot come back with
     * Object.prototype's. */
    JSValue values = own_property(ctx, options, prop);
    JS_FreeValue(ctx, options);

    int64_t len = 0;
    if (!JS_IsArray(values) || JS_GetLength(ctx, values, &len) != 0) {
        JS_FreeValue(ctx, values);
        return JS_NULL;
    }

    JSValue  out = JS_NewArray(ctx);
    uint32_t k   = 0;
    for (int64_t i = 0; i < len; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, values, (uint32_t)i);

        if (JS_IsString(item))
            JS_SetPropertyUint32(ctx, out, k++, item);
        else
            JS_FreeValue(ctx, item);
    }
    JS_FreeValue(ctx, values);

    /* A list nothing can be picked from is not an answer: an empty drop-down is
     * worse than the text field it would replace. */
    if (k == 0) {
        JS_FreeValue(ctx, out);
        return JS_NULL;
    }
    return out;
}

/*
 * The values a property accepts, or null when it is free-form.
 *
 * The list is declared in C next to the property (BtaClass.options), which is
 * what lets a property editor offer a drop-down without knowing that
 * Alignment or Arrangement exist -- the same bargain as PropertyNames().
 * Looked up along the prototype chain, so a subclass inherits its parent's --
 * and a class the table does not hold is asked for its own `static Options`.
 */
static JSValue w_property_options(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    const char *prop = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!prop)
        return JS_ThrowTypeError(ctx, "PropertyOptions(name) expects a name");

    int       n;
    BtaClass *table  = bta_class_table(&n);
    JSValue   result = JS_NULL;

    JSValue proto = JS_GetPrototype(ctx, this_val);
    while (JS_IsObject(proto) && JS_IsNull(result)) {
        /* Whether the table speaks for this class at all, which is a different
         * question from whether it had anything to say about `prop`: a Button
         * is in the table and enumerates nothing, and it is not for that reason
         * a class of the project. */
        bool known = false;

        for (int i = 0; i < n; i++) {
            if (!JS_IsStrictEqual(ctx, table[i].proto, proto))
                continue;

            known = true;
            const char *values = table[i].options ? table[i].options(prop) : NULL;
            if (values) {
                char **parts = g_strsplit(values, ",", -1);
                result = JS_NewArray(ctx);
                for (uint32_t k = 0; parts[k]; k++)
                    JS_SetPropertyUint32(ctx, result, k, JS_NewString(ctx, parts[k]));
                g_strfreev(parts);
            }
            break;
        }

        if (!known)
            result = class_static_options(ctx, proto, prop);

        JSValue parent = JS_GetPrototype(ctx, proto);
        JS_FreeValue(ctx, proto);
        proto = parent;
    }
    JS_FreeValue(ctx, proto);
    JS_FreeCString(ctx, prop);
    return result;
}

/*
 * The properties of this object's class, and of every class it inherits from,
 * that hold text a person reads.  NULL when there are none.
 *
 * Accumulated along the chain rather than stopping at the first class that
 * answers, which is where this differs from PropertyOptions: a Button's are its
 * own `Text` *plus* Widget's `Tooltip`, and both have to come back.
 */
/*
 * The comma separated list a class declares, gathered along the prototype chain
 * and de-duplicated: `texts` and `events` are the same walk over two fields, and
 * the accumulating part is why they cannot be first-match like `options`.
 *
 * Order is **most derived first**, which is what makes `EventNames()[0]` the
 * event a control is really about: a Button's own `Click` comes before the
 * `MouseDown` it inherits from Widget.
 */
typedef enum { CLASS_LIST_TEXTS, CLASS_LIST_EVENTS } ClassList;

static char **class_list_of(JSContext *ctx, JSValueConst obj, ClassList which)
{
    int       n;
    BtaClass *table = bta_class_table(&n);
    GPtrArray *out  = NULL;

    /* The static that says the same thing, for a class the table cannot hold. */
    const char *declares = which == CLASS_LIST_TEXTS ? "TextProperties" : "Events";

    JSValue proto = JS_GetPrototype(ctx, obj);
    while (JS_IsObject(proto)) {
        bool known = false;

        for (int i = 0; i < n; i++) {
            if (!JS_IsStrictEqual(ctx, table[i].proto, proto))
                continue;

            known = true;
            const char *declared = which == CLASS_LIST_TEXTS
                                       ? table[i].texts : table[i].events;
            if (!declared)
                break;

            char **parts = g_strsplit(declared, ",", -1);
            for (uint32_t j = 0; parts[j]; j++)
                list_add(&out, parts[j]);
            g_free(parts);          /* the strings themselves are kept or freed above */
            break;
        }

        /* A class of the project, at its own step of the walk -- so what it
         * declares lands ahead of everything it inherits, which is the order
         * this whole answer is for. */
        if (!known)
            class_static_list(ctx, proto, declares, &out);

        JSValue parent = JS_GetPrototype(ctx, proto);
        JS_FreeValue(ctx, proto);
        proto = parent;
    }
    JS_FreeValue(ctx, proto);

    if (!out)
        return NULL;
    g_ptr_array_add(out, NULL);
    return (char **)g_ptr_array_free(out, FALSE);
}

static char **text_props_of(JSContext *ctx, JSValueConst obj)
{
    return class_list_of(ctx, obj, CLASS_LIST_TEXTS);
}

/*
 * Whether `prop` holds prose, and *where* in it.
 *
 * A declaration is usually a bare property name (`"Text"`, `"Items"`). It may
 * also name a member: `TableView` declares `"Columns.Text"`, because a column
 * carries a heading, a width and an alignment and only the first is prose.
 * Translating `Right` would be the permissive mistake this whole declaration
 * exists to prevent, and the only way to avoid it is for the class to say which
 * member -- never to guess from the name, which is the rule that keeps
 * `SourceEditor.Text` out of the catalogue.
 *
 * `field` comes back newly allocated, or NULL when the property is prose whole.
 */
bool bta_widget_text_prop_field(JSContext *ctx, JSValueConst obj,
                                const char *prop, char **field)
{
    if (field)
        *field = NULL;

    char **names = text_props_of(ctx, obj);
    if (!names)
        return false;

    bool hit = false;
    for (uint32_t i = 0; names[i] && !hit; i++) {
        const char *dot = strchr(names[i], '.');

        if (!dot) {
            hit = g_str_equal(names[i], prop);
        } else if (!strncmp(names[i], prop, dot - names[i]) &&
                   prop[dot - names[i]] == '\0') {
            hit = true;
            if (field)
                *field = g_strdup(dot + 1);
        }
    }

    g_strfreev(names);
    return hit;
}

bool bta_widget_text_prop(JSContext *ctx, JSValueConst obj, const char *prop)
{
    return bta_widget_text_prop_field(ctx, obj, prop, NULL);
}

/*
 * TextProperties(): which of this control's properties hold prose.
 *
 * Declared in C next to the property (BtaClass.texts), so the three things that
 * need the answer -- the .form loader looking a string up in the catalogue, a
 * property editor offering a sample value for it, an extractor collecting it --
 * all ask instead of keeping a list of their own that can drift from the widget
 * set.  The same bargain as PropertyNames() and PropertyOptions().
 *
 * Not every string is prose, which is why this cannot be a rule about the name:
 * `SourceEditor.Text` is source code and `Terminal.Text` is a screen of output.
 *
 * A class of the project says it as `static TextProperties = [...]`, which is
 * the same declaration on the side of the line where there is no C to put it.
 */
static JSValue w_text_properties(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    char  **names = text_props_of(ctx, this_val);
    JSValue out   = JS_NewArray(ctx);

    for (uint32_t i = 0; names && names[i]; i++)
        JS_SetPropertyUint32(ctx, out, i, JS_NewString(ctx, names[i]));

    g_strfreev(names);
    return out;
}

/*
 * EventNames(): which events this control raises, most derived first.
 *
 * The runtime dispatches by name -- `bta_emit(w, "Click", ...)` looks up
 * `<name>_Click` on the form -- so which events exist was knowable only by
 * reading the C. Which meant the IDE kept its own list: `DEFAULT_EVENT`, fifteen
 * types by hand, with `|| "MouseDown"` for whatever was not in it. Five controls
 * were not.
 *
 * **The first is the default**, because a class declares its own before it
 * inherits Widget's: a Button answers `["Click", "MouseDown", ...]`, and the one
 * a double click should write is the one at the front. That ordering is the
 * whole reason this can replace a table rather than merely supplement it.
 *
 * The same bargain as `PropertyNames()` and `TextProperties()`: one declaration
 * next to the class, and whoever needs the answer asks.
 *
 * A component written in JS declares its own as `static Events = [...]`, and it
 * lands ahead of what it inherits for the same reason a C class's does -- the
 * static is read at that class's step of the same walk. Before it could, a
 * component answered `MouseDown` first however much it emitted, which is the
 * one thing this function exists to prevent.
 */
/*
 * CssNode(): the CSS node a stylesheet has to name to reach this control.
 *
 * `Style` puts a class on `w->gtk`, and **that node decides which of the theme's
 * rules can match it at all**: `button.suggested-action` reaches a `Button` and
 * never a `ColorButton`, whose node is `colorbutton`; `.boxed-list > row` reaches
 * neither, because a `RowList` is a `scrolledwindow` with the list three nodes
 * further in. A class whose node does not match is accepted, saved into the
 * `.form` and does nothing, which is the quietest failure this runtime has.
 *
 * Asked of GTK rather than declared, so it cannot drift from what the widget is:
 * a build function that swaps the outer widget changes this answer, and that is
 * a **breaking change for anyone's `app.css`** with nothing else to notice it.
 * `tests/widgets` asserts the whole table for exactly that reason -- three of
 * these moved in one afternoon (`Panel` from `box` to `fixed`, `ColorButton` from
 * `box` to `colorbutton`) while every test stayed green.
 *
 * A method and not a property, like `EventNames` and `TextProperties`: it is a
 * fact about the class rather than a value of the instance, and nothing can
 * assign it.
 */
static JSValue w_css_node(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *name = gtk_widget_class_get_css_name(GTK_WIDGET_GET_CLASS(w->gtk));
    return JS_NewString(ctx, name ? name : "");
}

static JSValue w_event_names(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    char  **names = class_list_of(ctx, this_val, CLASS_LIST_EVENTS);
    JSValue out   = JS_NewArray(ctx);

    for (uint32_t i = 0; names && names[i]; i++)
        JS_SetPropertyUint32(ctx, out, i, JS_NewString(ctx, names[i]));

    g_strfreev(names);
    return out;
}

/*
 * What GTK actually gave the widget, as opposed to what it was asked for.
 *
 * Width and Height report the *request*, which is a minimum -- so a control
 * whose text does not fit renders wider and nothing says so.  That difference
 * has been invisible from JS, and the only way to catch it was to look at a
 * screenshot; this makes it a number, which a test can assert.
 *
 * Bounds() answers in the window's coordinates, which is also what a click
 * driven from outside needs; Bounds(container) answers in that container's.
 */
static JSValue w_bounds(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkWidget *ref = NULL;
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        BtaWidget *r = bta_widget_of(argv[0]);
        if (!r)
            return JS_ThrowTypeError(ctx, "Bounds(container) expects a widget");
        ref = r->gtk;
    } else {
        GtkRoot *root = gtk_widget_get_root(w->gtk);
        ref = root ? GTK_WIDGET(root) : NULL;
    }

    graphene_point_t out = GRAPHENE_POINT_INIT(0.0f, 0.0f);

    /* Unrelated widgets have no common point; (0,0) is the honest answer, and
     * the size below is still real. */
    if (ref && !gtk_widget_compute_point(w->gtk, ref,
                                         &GRAPHENE_POINT_INIT(0.0f, 0.0f), &out)) {
        out.x = out.y = 0.0f;
    }

    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "X",      JS_NewInt32(ctx, (int)out.x));
    JS_SetPropertyStr(ctx, o, "Y",      JS_NewInt32(ctx, (int)out.y));
    JS_SetPropertyStr(ctx, o, "Width",  JS_NewInt32(ctx, gtk_widget_get_width(w->gtk)));
    JS_SetPropertyStr(ctx, o, "Height", JS_NewInt32(ctx, gtk_widget_get_height(w->gtk)));
    return o;
}

/*
 * Emit("Changed", ...): raise an event as if the widget itself had done it.
 *
 * It is what a component says to whoever is holding it -- `this.Emit("Changed",
 * value)` inside the component arrives as `Thing1_Changed(value)` on the form,
 * exactly like a Button's Click.  Named Emit and not Raise because Raise is
 * already the z-order one.
 */
static JSValue w_emit(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *event = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!event)
        return JS_ThrowTypeError(ctx, "Emit(event, ...) expects an event name");

    JSValue r = bta_emit_on(ctx, w->form, w->name, event,
                            argc - 1, argc > 1 ? argv + 1 : NULL);
    JS_FreeCString(ctx, event);
    return r;
}

/* ---------------------------------------------------------------- tooltip */

static JSValue w_get_tooltip(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *text = gtk_widget_get_tooltip_text(w->gtk);
    return JS_NewString(ctx, text ? text : "");
}

static JSValue w_set_tooltip(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *text = JS_ToCString(ctx, val);
    if (!text)
        return JS_EXCEPTION;

    /* Empty means none, not an empty tooltip: an always-blank popup would be
     * worse than no popup. */
    gtk_widget_set_tooltip_text(w->gtk, *text ? text : NULL);
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------------- cursor
 *
 * What the pointer looks like over this widget.
 *
 * **It cannot go through the stylesheet**, which is where `Opacity`, `Radius`
 * and the colours go: GTK's CSS has no `cursor` property -- `button { cursor:
 * pointer }` is answered with *No property named "cursor"* -- so a widget
 * property is the only road. The mirror of `Opacity`, which is in CSS
 * precisely because CSS has it.
 *
 * **The list is closed and checked here, because nothing downstream ever
 * checks it.** `gdk_cursor_new_from_name` is documented to answer NULL for a
 * name no theme knows and does not: it hands back a live cursor carrying the
 * name, which is resolved -- or quietly replaced by the arrow -- when it
 * reaches a surface. So a typo would be a property that reads back correctly
 * and does nothing, which is the failure `Style` refuses a non-identifier to
 * avoid.
 *
 * The names are ours rather than CSS's, which is the one place this runtime
 * translates a vocabulary it could have passed through. The reason is that
 * this one is closed *and* abbreviated -- `ew-resize`, `nesw-resize` -- unlike
 * an icon name, a font family or a `Shortcut`, which are open and readable and
 * do pass through. Two of the rows are what the translation is worth:
 *
 * - **`Move` is `all-resize` and not `move`**, because Adwaita links `move` to
 *   `default`: the value that says "this can be dragged" would have drawn a
 *   plain arrow.
 * - **`ResizeColumn` is `col-resize`**, CSS's own meaning-based name. The
 *   toolkits that name it by orientation disagree with each other about which
 *   one it is: Delphi's `crHSplit` and WinForms' `HSplit` are opposite things.
 *
 * The eight one-headed arrows (`n-resize`, `se-resize`, …) are deliberately
 * not offered. They are X11's vocabulary for a window manager resizing a
 * window by an edge; not one of VB6, Delphi, WinForms, WPF or Qt has them, and
 * what an application resizes -- a splitter, a corner, a designer's handle --
 * is two-headed. Leaving them out is also what frees `ResizeTopLeft` to be a
 * corner rather than a pair of axes spelled out.
 */
static const struct { const char *name; const char *css; } CURSOR_NAMES[] = {
    /* Nothing said: the widget inherits whatever its parent has, which is what
     * every widget starts with. First, so it is the head of the drop-down. */
    { "Auto",             NULL },
    /* And not `Default`, which beside `Auto` reads as the same answer. Qt's
     * word for the same thing, and the arrow really is a decision: a widget
     * inside one that set a cursor may want the plain pointer back. */
    { "Arrow",            "default" },
    { "Hand",             "pointer" },
    { "Grab",             "grab" },
    { "Grabbing",         "grabbing" },
    { "Text",             "text" },
    { "VerticalText",     "vertical-text" },
    /* The pair every toolkit has: blocked, against working but usable. */
    { "Wait",             "wait" },
    { "Progress",         "progress" },
    { "Help",             "help" },
    { "Crosshair",        "crosshair" },
    { "Cell",             "cell" },
    { "ContextMenu",      "context-menu" },
    { "Move",             "all-resize" },
    { "Scroll",           "all-scroll" },
    { "Copy",             "copy" },
    { "Link",             "alias" },
    { "NoDrop",           "no-drop" },
    { "NotAllowed",       "not-allowed" },
    { "ZoomIn",           "zoom-in" },
    { "ZoomOut",          "zoom-out" },
    { "None",             "none" },
    /* An edge is an axis and a corner is a corner. The same arrow serves the
     * opposite corner, which is why there are two and not four. */
    { "ResizeHorizontal", "ew-resize" },
    { "ResizeVertical",   "ns-resize" },
    { "ResizeTopLeft",    "nwse-resize" },
    { "ResizeTopRight",   "nesw-resize" },
    { "ResizeColumn",     "col-resize" },
    { "ResizeRow",        "row-resize" },
};

/*
 * The names, comma separated, for the class row's `options`.
 *
 * Built from the table rather than written beside it, so the drop-down and
 * what the setter accepts cannot drift -- the same bargain `SourceEditor`
 * makes by asking GtkSourceView which languages it has.
 */
const char *bta_widget_cursor_options(void)
{
    static char *list = NULL;

    if (!list) {
        GString *s = g_string_new(NULL);
        for (unsigned i = 0; i < G_N_ELEMENTS(CURSOR_NAMES); i++)
            g_string_append_printf(s, i ? ",%s" : "%s", CURSOR_NAMES[i].name);
        list = g_string_free(s, FALSE);
    }
    return list;
}

/*
 * The cursor a part had before this property ever touched it, put back when
 * the property returns to `Auto`.
 *
 * Without it `Auto` would mean *no cursor at all* rather than *nothing said*,
 * and the difference is visible: a `LinkButton` carries `pointer` from GTK and
 * the `GtkText` inside a `TextBox` carries `text`, so setting a cursor and
 * clearing it again would leave a link with no hand and an entry with no
 * I-beam -- permanently, and only for whoever touched the property.
 *
 * Two keys because NULL is a real answer: most widgets had no cursor, and
 * "had none" has to be told apart from "never asked".
 */
#define CURSOR_KEPT "bta-cursor-kept"
#define CURSOR_HELD "bta-cursor-held"

static void cursor_apply_part(GtkWidget *part, const char *css)
{
    if (!part)
        return;

    if (!g_object_get_data(G_OBJECT(part), CURSOR_HELD)) {
        GdkCursor *had = gtk_widget_get_cursor(part);
        if (had)
            g_object_set_data_full(G_OBJECT(part), CURSOR_KEPT,
                                   g_object_ref(had), g_object_unref);
        g_object_set_data(G_OBJECT(part), CURSOR_HELD, GINT_TO_POINTER(1));
    }

    if (css)
        gtk_widget_set_cursor_from_name(part, css);
    else
        gtk_widget_set_cursor(part, g_object_get_data(G_OBJECT(part), CURSOR_KEPT));
}

/*
 * On `gtk`, on `inner`, and on the entry's delegate -- which is `Focusable`'s
 * rule, and for the same reason turned around.
 *
 * A cursor set on an ancestor reaches a descendant only while the descendant
 * has none of its own, and the commonest controls have one: the `GtkText`
 * inside a `TextBox` and a `SpinBox` and the `GtkTextView` inside an `Editor`
 * all carry `text`. Set on `gtk` alone, `TextBox.Cursor = "Wait"` would read
 * back correctly and never be seen over the text -- exactly the shape of the
 * bug a tab-order test found in `Focusable`.
 */
static void cursor_apply(BtaWidget *w, const char *css)
{
    cursor_apply_part(w->gtk, css);
    if (w->inner && w->inner != w->gtk)
        cursor_apply_part(w->inner, css);
    if (GTK_IS_EDITABLE(w->gtk)) {
        GtkEditable *d = gtk_editable_get_delegate(GTK_EDITABLE(w->gtk));
        if (d)
            cursor_apply_part(GTK_WIDGET(d), css);
    }
}

static JSValue w_get_cursor(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GdkCursor  *cursor = gtk_widget_get_cursor(w->gtk);
    const char *css    = cursor ? gdk_cursor_get_name(cursor) : NULL;

    /*
     * A name this table does not hold answers `Auto`, and not the name itself:
     * a widget can only have got one from GTK, and handing it back would put a
     * value in the `.form` that the loader's own setter refuses.
     */
    if (css)
        for (unsigned i = 1; i < G_N_ELEMENTS(CURSOR_NAMES); i++)
            if (!strcmp(css, CURSOR_NAMES[i].css))
                return JS_NewString(ctx, CURSOR_NAMES[i].name);

    return JS_NewString(ctx, CURSOR_NAMES[0].name);
}

static JSValue w_set_cursor(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;

    int found = -1;
    for (unsigned i = 0; i < G_N_ELEMENTS(CURSOR_NAMES); i++)
        if (!g_ascii_strcasecmp(name, CURSOR_NAMES[i].name))
            found = (int)i;

    if (found < 0) {
        /* The list is twenty-eight names long, so the message points at it
         * rather than reciting it: a RangeError nobody can read is what the
         * property grid would show the user. */
        JSValue e = JS_ThrowRangeError(ctx,
            "Cursor: '%s' is not a cursor name -- PropertyOptions(\"Cursor\") lists them",
            name);
        JS_FreeCString(ctx, name);
        return e;
    }
    JS_FreeCString(ctx, name);

    cursor_apply(w, CURSOR_NAMES[found].css);
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------- drag and drop
 *
 * Two properties and one event.  A widget with DragData can be dragged and
 * hands that string over; a widget with AcceptDrop receives it as
 * Name_Drop(data, x, y), with x and y relative to itself -- the same
 * coordinates MouseDown reports, so a drop can land where the pointer is.
 *
 * A string is the whole payload on purpose.  It is what crosses the gap
 * between two widgets that know nothing about each other -- the IDE's palette
 * hands the designer the name of a class -- and it needs no type registered
 * anywhere.
 */
#define DRAG_DATA_KEY   "bta-drag-data"
#define DRAG_SOURCE_KEY "bta-drag-source"
#define DROP_TARGET_KEY "bta-drop-target"

static GdkContentProvider *on_drag_prepare(GtkDragSource *src, double x, double y,
                                           gpointer user_data)
{
    BtaWidget  *w    = user_data;
    const char *data = g_object_get_data(G_OBJECT(w->gtk), DRAG_DATA_KEY);

    /* Returning NULL is what cancels a drag, so clearing DragData really does
     * turn dragging off again. */
    if (!data || !*data)
        return NULL;
    return gdk_content_provider_new_typed(G_TYPE_STRING, data);
}

/* The drag carries a picture of the widget itself, held where it was grabbed:
 * what is being dragged is then never in doubt. */
static void on_drag_begin(GtkDragSource *src, GdkDrag *drag, gpointer user_data)
{
    BtaWidget    *w     = user_data;
    GdkPaintable *ghost = gtk_widget_paintable_new(w->gtk);

    gtk_drag_source_set_icon(src, ghost,
                             gtk_widget_get_width(w->gtk) / 2,
                             gtk_widget_get_height(w->gtk) / 2);
    g_object_unref(ghost);
}

static JSValue w_get_drag_data(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *data = g_object_get_data(G_OBJECT(w->gtk), DRAG_DATA_KEY);
    return JS_NewString(ctx, data ? data : "");
}

static JSValue w_set_drag_data(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *data = JS_ToCString(ctx, val);
    if (!data)
        return JS_EXCEPTION;

    g_object_set_data_full(G_OBJECT(w->gtk), DRAG_DATA_KEY, g_strdup(data), g_free);
    JS_FreeCString(ctx, data);

    /* The source asks for the payload when the drag starts, so re-assigning
     * DragData -- a palette that changes what it offers -- rebuilds nothing.
     * One source per widget, installed the first time. */
    if (!g_object_get_data(G_OBJECT(w->gtk), DRAG_SOURCE_KEY)) {
        GtkDragSource *src = gtk_drag_source_new();

        gtk_drag_source_set_actions(src, GDK_ACTION_COPY);
        /* Capture, not bubble: a Button's own gesture claims the press, and a
         * source that only sees what is left over never reaches the drag
         * threshold -- the control would be draggable everywhere except on the
         * controls one actually drags from.  Claiming the sequence here is also
         * what stops the click from firing at the end of a drag. */
        gtk_event_controller_set_propagation_phase(GTK_EVENT_CONTROLLER(src),
                                                   GTK_PHASE_CAPTURE);
        g_signal_connect(src, "prepare",    G_CALLBACK(on_drag_prepare), w);
        g_signal_connect(src, "drag-begin", G_CALLBACK(on_drag_begin),   w);

        /* The controller owns itself once added; this is only a marker. */
        gtk_widget_add_controller(w->gtk, GTK_EVENT_CONTROLLER(src));
        g_object_set_data(G_OBJECT(w->gtk), DRAG_SOURCE_KEY, src);
    }
    return JS_UNDEFINED;
}

static gboolean on_drop(GtkDropTarget *target, const GValue *value,
                        double x, double y, gpointer user_data)
{
    BtaWidget  *w   = user_data;
    JSContext  *ctx = w->ctx;

    if (!G_VALUE_HOLDS_STRING(value))
        return FALSE;

    const char *data = g_value_get_string(value);
    JSValue     argv[3] = {
        JS_NewString(ctx, data ? data : ""),
        JS_NewFloat64(ctx, x),
        JS_NewFloat64(ctx, y),
    };

    bta_emit(w, "Drop", 3, argv);

    for (int i = 0; i < 3; i++)
        JS_FreeValue(ctx, argv[i]);
    return TRUE;
}

/* ------------------------------------------------------- files from outside
 *
 * The gesture every user tries first: a file dragged off the desktop or the file
 * manager onto the window. `AcceptDrop` never saw it -- it carries the
 * application's own `DragData` string, and the desktop offers `text/uri-list` --
 * so the drop bounced and the only road in was `Dialog.OpenFile`.
 *
 * **A second property rather than a mode on the first.** `AcceptDrop` is a
 * boolean in every form and every serialised file already; turning it into an
 * enumeration would change what `AcceptDrop === true` means for the sake of a
 * different kind of drop. They are also genuinely independent: a palette accepts
 * its own drags and no files, an attachment list accepts files and no drags, and
 * a canvas may want both.
 */
#define DROP_FILES_KEY "bta-drop-files"

static gboolean on_file_drop(GtkDropTarget *target, const GValue *value,
                             double x, double y, gpointer user_data)
{
    BtaWidget *w   = user_data;
    JSContext *ctx = w->ctx;
    GSList    *files = NULL;
    GSList     one  = { NULL, NULL };

    if (G_VALUE_HOLDS(value, GDK_TYPE_FILE_LIST)) {
        files = g_value_get_boxed(value);
    } else if (G_VALUE_HOLDS(value, G_TYPE_FILE)) {
        /* One file arrives as itself rather than as a list of one. */
        one.data = g_value_get_object(value);
        files    = &one;
    } else {
        return FALSE;
    }

    JSValue paths = JS_NewArray(ctx);
    uint32_t n    = 0;

    for (GSList *l = files; l; l = l->next) {
        /*
         * **Only what has a path arrives.** A file on a remote share
         * (`sftp://`, a phone over MTP) is a real `GFile` with no local path,
         * and handing its URI over as if it were one would fail in whatever
         * `File.Load` the handler wrote -- one line later, and looking like a
         * bug in the program. It is dropped here and said out loud in the
         * documentation instead.
         */
        char *path = l->data ? g_file_get_path(G_FILE(l->data)) : NULL;
        if (!path)
            continue;

        JS_SetPropertyUint32(ctx, paths, n++, JS_NewString(ctx, path));
        g_free(path);
    }

    /* Nothing local in the drop is not a drop: a handler called with an empty
     * list would have to check for it, and every one of them would forget. */
    if (n == 0) {
        JS_FreeValue(ctx, paths);
        return FALSE;
    }

    JSValueConst argv[3] = { paths, JS_NewFloat64(ctx, x), JS_NewFloat64(ctx, y) };
    bta_emit(w, "FileDrop", 3, argv);
    JS_FreeValue(ctx, paths);
    return TRUE;
}

static JSValue w_get_accept_files(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, g_object_get_data(G_OBJECT(w->gtk), DROP_FILES_KEY) != NULL);
}

static JSValue w_set_accept_files(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int on = JS_ToBool(ctx, val);
    if (on < 0)
        return JS_EXCEPTION;

    GtkDropTarget *target = g_object_get_data(G_OBJECT(w->gtk), DROP_FILES_KEY);

    if (on && !target) {
        target = gtk_drop_target_new(G_TYPE_INVALID, GDK_ACTION_COPY);

        /* Both, because the desktop offers whichever it feels like: several
         * files come as a list, one file often comes as itself. */
        GType types[] = { GDK_TYPE_FILE_LIST, G_TYPE_FILE };
        gtk_drop_target_set_gtypes(target, types, G_N_ELEMENTS(types));

        g_signal_connect(target, "drop", G_CALLBACK(on_file_drop), w);
        gtk_widget_add_controller(w->gtk, GTK_EVENT_CONTROLLER(target));
        g_object_set_data(G_OBJECT(w->gtk), DROP_FILES_KEY, target);
    } else if (!on && target) {
        gtk_widget_remove_controller(w->gtk, GTK_EVENT_CONTROLLER(target));
        g_object_set_data(G_OBJECT(w->gtk), DROP_FILES_KEY, NULL);
    }
    return JS_UNDEFINED;
}

static JSValue w_get_accept_drop(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, g_object_get_data(G_OBJECT(w->gtk), DROP_TARGET_KEY) != NULL);
}

static JSValue w_set_accept_drop(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int on = JS_ToBool(ctx, val);
    if (on < 0)
        return JS_EXCEPTION;

    GtkDropTarget *target = g_object_get_data(G_OBJECT(w->gtk), DROP_TARGET_KEY);

    if (on && !target) {
        target = gtk_drop_target_new(G_TYPE_STRING, GDK_ACTION_COPY);
        g_signal_connect(target, "drop", G_CALLBACK(on_drop), w);
        gtk_widget_add_controller(w->gtk, GTK_EVENT_CONTROLLER(target));
        g_object_set_data(G_OBJECT(w->gtk), DROP_TARGET_KEY, target);
    } else if (!on && target) {
        gtk_widget_remove_controller(w->gtk, GTK_EVENT_CONTROLLER(target));
        g_object_set_data(G_OBJECT(w->gtk), DROP_TARGET_KEY, NULL);
    }
    return JS_UNDEFINED;
}

/*
 * How many of a Grid's columns this control takes.
 *
 * On the widget and not on the grid, which is the same choice `X`/`Y` are: where
 * a control goes is a fact about the control, so it is designable, serialisable
 * and editable in the grid's own property editor with nothing added anywhere.
 * And meaningless in any other container, exactly as `X` is outside a `Fixed` --
 * ignored there rather than refused, because a control changes containers and a
 * value it kept from its old one is not an error.
 */
static JSValue w_get_span(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, w->span > 0 ? w->span : 1);
}

static JSValue w_set_span(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "ColumnSpan", &n))
        return JS_EXCEPTION;
    if (n < 1)
        return JS_ThrowRangeError(ctx, "ColumnSpan: %d is not a number of columns", n);

    w->span = n;
    /* The children after it move, so the whole grid is re-flowed rather than
     * this one re-placed. */
    bta_grid_reflow(gtk_widget_get_parent(w->gtk));
    return JS_UNDEFINED;
}

/*
 * TabIndex -- where Tab stops on this control, among the children of a `Fixed`.
 *
 * **There is no `TabStop` beside it, and that is not an omission**: `Focusable`
 * already is one. A control Tab must skip is a control that cannot take the
 * focus, which is the same sentence, and two words for it would be two states
 * to keep in step.
 *
 * Sparse and never renumbered. VB and Delphi keep a dense sequence by shuffling
 * every sibling whenever one is set, which is both the fiddly part of using them
 * and something this runtime must not do: a control's siblings are its *form's*,
 * and on the designer's canvas that form is the IDE. Ties go to the order the
 * children are in, so declaring nothing is the order things were drawn in.
 */
static JSValue w_get_tab_index(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, w->tab_index);
}

static JSValue w_set_tab_index(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "TabIndex", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "TabIndex: %d is not a place in an order", n);

    /* Nothing to tell GTK: the order is read when Tab is pressed, by the
     * surface these children are on. */
    w->tab_index = n;
    return JS_UNDEFINED;
}

/*
 * Border: "width style colour", the way `Shadow` is a list of plain numbers and
 * a colour -- positional, no units, and normalised on the way in so what the
 * property reports is what the `.form` will carry.
 *
 * It is here because a class wants one and nothing else could give it: the
 * appearance a control can be given by hand covers colours, radius, padding,
 * shadow and font, and a border was the hole in that list. **Which is not an
 * invitation to dress controls one at a time** -- see `Style`, and the note
 * under Colour in docs/widgets.md.
 */
static const char *const BORDER_STYLES[] = {
    "none", "solid", "dashed", "dotted", "double", "groove", "ridge", NULL
};

static JSValue w_get_border(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, w->border ? w->border : "");
}

static JSValue w_set_border(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    char **parts = g_strsplit_set(s, " \t", -1);
    JS_FreeCString(ctx, s);

    long        width  = -1;
    const char *style  = NULL;
    GString    *rest   = g_string_new(NULL);
    bool        ok     = true;

    for (char **p = parts; *p && ok; p++) {
        if (!**p)
            continue;                       /* a run of spaces is not a value */

        char *end = NULL;
        long  v   = strtol(*p, &end, 10);

        if (end != *p && (!*end || !g_strcmp0(end, "px"))) {
            if (width >= 0 || v < 0) ok = false;
            else                     width = v;
            continue;
        }

        /* A word that is a border style is one; anything else is the colour,
         * which is what CSS writes last and what a person types last. */
        bool named = false;
        for (const char *const *k = BORDER_STYLES; *k && !named; k++)
            if (!g_ascii_strcasecmp(*p, *k)) { style = *k; named = true; }

        if (named)
            continue;

        if (rest->len)
            g_string_append_c(rest, ' ');
        g_string_append(rest, *p);
    }
    g_strfreev(parts);

    GdkRGBA colour = { 0, 0, 0, 1 };
    bool    tinted = rest->len > 0;

    if (ok && tinted)
        ok = gdk_rgba_parse(&colour, rest->str);
    g_string_free(rest, TRUE);

    /* A border is a width: a colour on its own is not one, and a style on its
     * own is not either. Nothing at all is none. */
    bool any = width >= 0 || style || tinted;
    if (ok && any && width < 0)
        ok = false;

    if (!ok) {
        return JS_ThrowRangeError(ctx,
            "Border takes a width, a style (solid, dashed, dotted) and a colour");
    }

    g_clear_pointer(&w->border, g_free);
    if (width > 0) {
        char *rgba = gdk_rgba_to_string(&colour);

        w->border = g_strdup_printf("%d %s %s", (int)width,
                                    style ? style : "solid", rgba);
        g_free(rgba);
    }

    widget_styles_apply(w);
    return JS_UNDEFINED;
}

/*
 * StyleRule(): the CSS body this control's own appearance comes to.
 *
 * `Background`, `Foreground`, `Font`, `Radius`, `Padding`, `Shadow` and `Border`
 * are the exception to dressing a control -- the rule is a class in `app.css` --
 * and this is what turns one into the other: the IDE's class editor sets them on
 * a control nobody sees, asks for this, and writes `.name { ... }` into the
 * project's stylesheet. So the units, the colour normalising and the three ways
 * a font size reaches CSS wrong are written once, in the code that already had
 * to get them right, and never again in JavaScript.
 *
 * Empty when nothing was set, which is a class with nothing in it and worth
 * saying so rather than writing `{ }` into somebody's file.
 */
static JSValue w_style_rule(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    char   *body = widget_style_body(w);
    JSValue out  = JS_NewString(ctx, body ? g_strstrip(body) : "");

    g_free(body);
    return out;
}

/*
 * FontScale and Opacity: the two things the desktop's own type classes are made
 * of, and the two this could not say.
 *
 * Read GTK's Adwaita and every heading is the same shape --
 * `.title-1 { font-weight: 800; font-size: 200% }`, `.heading` 700 and 110%,
 * `.caption` 400 and 90% -- **a weight and a size in per cent, and never a
 * family**. That is what makes them compose and what makes them follow the
 * desktop: a class that named a family would freeze it, and one that named
 * 20pt would ignore whoever runs at a different text scale. `.dim-label` is not
 * even a colour: it is `opacity: 0.55`.
 *
 * `Font` cannot say either of those. A Pango description has no notion of "one
 * and a half times whatever is in force", and no notion of dimming at all -- so
 * a class built here could only ever be a *whole font*, which is the thing the
 * theme carefully does not do.
 *
 * Numbers rather than strings, being numbers: `FontScale = 1.1` is 110%, and
 * `Opacity = 0.55` is what dim is. `0` and `1` are "nothing said", so neither
 * reaches the stylesheet until it is asked for.
 */
static JSValue w_get_scale(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewFloat64(ctx, w->font_scale);
}

static JSValue w_set_scale(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    double     v;

    if (!w || !bta_to_number(ctx, val, "FontScale", &v))
        return JS_EXCEPTION;

    /* A scale of nothing is not a size, and one of twenty is a mistake with a
     * number in it: the theme's largest is 2.4. **1 is the way back** -- the
     * same size as whatever is in force, which is what "nothing said" means
     * here and is why it is the default.
     *
     * The range check is not the type check: NaN fails both comparisons, so
     * before `bta_to_number` a scale of "abc" arrived here and got through. */
    if (v <= 0 || v > 10)
        return JS_ThrowRangeError(ctx,
            "FontScale: %g is not a factor -- 1 is the size in force", v);

    w->font_scale = v;
    widget_styles_apply(w);
    return JS_UNDEFINED;
}

static JSValue w_get_opacity(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewFloat64(ctx, w->opacity);
}

static JSValue w_set_opacity(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    double     v;

    if (!w || !bta_to_number(ctx, val, "Opacity", &v))
        return JS_EXCEPTION;

    if (v < 0 || v > 1)
        return JS_ThrowRangeError(ctx, "Opacity: %g is not between 0 and 1", v);

    /*
     * Through the stylesheet and not `gtk_widget_set_opacity`, which is the
     * other way GTK offers: what this is *for* is a class -- `.dim-label` is
     * `opacity: 0.55` and nothing else -- and a class is CSS. A widget property
     * could not be composed into one.
     */
    w->opacity = v;
    widget_styles_apply(w);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------------- theme
 *
 * Light or dark, which GTK will not answer directly.
 *
 * **The two settings that look like the answer are not.** `gtk-theme-name`
 * reads `"Default"` on a desktop running Adwaita, and
 * `gtk-application-prefer-dark-theme` is `false` under `GTK_THEME=Adwaita:dark`
 * -- both measured here -- so either of them as the source of truth is a
 * property that answers *light* on a dark screen. What is true is what is being
 * drawn: `gtk_widget_get_color()` is the ink this widget's text really uses, and
 * if the ink is light the ground is dark. The same derivation `Painter.Dark`
 * has always made, and the same function now, because two spellings of one
 * derivation is one that drifts.
 *
 * **A widget that is in no window has no resolved style**, and answers white in
 * every theme -- so it would report *dark* on the lightest desktop there is.
 * Measured, and the reason for the fallback: a control that has not been added
 * to anything yet asks the application's first window instead, which is the
 * answer it will have the moment it is added. A form is always its own root, so
 * `this.Dark` in `Form_Open` needs none of this -- nor does a control on it,
 * even before the window is presented (also measured).
 */
bool bta_widget_dark(GtkWidget *at)
{
    if (at && !gtk_widget_get_root(at)) {
        BtaApp *app  = bta_current_app();
        GList  *wins = app && app->gapp ? gtk_application_get_windows(app->gapp)
                                        : NULL;
        if (wins)
            at = GTK_WIDGET(wins->data);
    }
    if (!at)
        return false;

    GdkRGBA ink = { 0, 0, 0, 1 };
    gtk_widget_get_color(at, &ink);

    /* Rec. 601 luma, which is what everything else uses for this question. */
    return 0.299 * ink.red + 0.587 * ink.green + 0.114 * ink.blue > 0.5;
}

static JSValue w_get_dark(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, bta_widget_dark(w->gtk));
}

/* ------------------------------------------------- the runtime's own notes
 *
 * Six things the runtime knows about a widget that the application does not:
 * what the `.form` declared before a translation stood in for it, what a
 * container holds, a form's menus and commands as they were read, a table's
 * declared columns, and a drawing area's painter.
 *
 * **They used to be own properties of the wrapper** -- `__declared`,
 * `__children`, `__menus`, `__actions`, `__columns`, `__painter` -- each defined
 * with the enumerable bit off so that `Dictionary.Keys`, `for...in` and the
 * serialiser would not report them. That was enough for everything that looks
 * and not enough for the thing that does not: a widget's own properties are
 * supposed to *be* its properties, and a mode that refuses a name the class does
 * not have cannot tell one of these from a misspelling. Most of them are created
 * later than the widget besides -- `__columns` when an application assigns
 * `Columns`, `__painter` on the first frame -- so pre-creating them is not open
 * either. The whole argument is `docs/plans/strict-plan.md`.
 *
 * So they live on the struct, reported by `widget_gc_mark` and released by the
 * finalizer, which is what `w->form` and `w->menu` have always done. The four
 * that JavaScript reads keep their old names as **accessors on
 * `Widget.prototype`**, defined below rather than in `widget_props`: an accessor
 * on the prototype is not an own property of anything, so nothing about the
 * widget has changed except where the value sits -- and `rad.js` goes on writing
 * `widget.__declared` exactly as it did.
 */
JSValue *bta_widget_note(BtaWidget *w, BtaNote which)
{
    switch (which) {
    case BTA_NOTE_DECLARED: return &w->declared;
    case BTA_NOTE_CHILDREN: return &w->children;
    case BTA_NOTE_MENUS:    return &w->menus;
    case BTA_NOTE_ACTIONS:  return &w->actions_spec;
    case BTA_NOTE_COLUMNS:  return &w->columns;
    case BTA_NOTE_PAINTER:  return &w->painter;
    }
    g_assert_not_reached();
}

/*
 * `JS_GetOpaque` and not `bta_this`, which throws: these answer for the runtime
 * and not for an application, and the callers read them the way the own
 * properties they replace were read -- `if (!JS_IsArray(kids)) return`. A throw
 * there would be a pending exception nobody looks at, surfacing somewhere else.
 * Nothing is not a widget here, and if something ever is, the answer is that it
 * has no notes.
 */
static JSValue note_get(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = JS_GetOpaque(this_val, bta_widget_class_id);
    if (!w)
        return JS_UNDEFINED;

    return JS_DupValue(ctx, *bta_widget_note(w, (BtaNote)magic));
}

static JSValue note_set(JSContext *ctx, JSValueConst this_val, JSValueConst val,
                        int magic)
{
    BtaWidget *w = JS_GetOpaque(this_val, bta_widget_class_id);
    if (!w)
        return JS_UNDEFINED;

    JSValue *slot = bta_widget_note(w, (BtaNote)magic);

    JS_FreeValue(ctx, *slot);
    *slot = JS_DupValue(ctx, val);
    return JS_UNDEFINED;
}

/*
 * The four names JavaScript still knows, put on the root prototype.
 *
 * **This table is not published surface**, which is the one thing to know about
 * it: `tests/api.sh` reads every `JSCFunctionListEntry` in this tree and demands
 * a documented row for each entry, and `tools/typings` writes each into
 * `bintana.d.ts`. Both of them skip this one by name, and say so where they do
 * -- an exception written down twice rather than a table hidden from a scanner.
 *
 * `__declared` is the only one with a setter, because `rad.js` leaves the same
 * note the loader does -- a filled-in template, a design value -- and both sides
 * have to reach the same bag. The other three are read from JavaScript and
 * written only here: `Form.Menus`, `Form.Actions` and what `tests/widgets`
 * counts to prove a container really let go of a child.
 */
static const JSCFunctionListEntry widget_notes[] = {
    JS_CGETSET_MAGIC_DEF("__declared", note_get, note_set, BTA_NOTE_DECLARED),
    JS_CGETSET_MAGIC_DEF("__children", note_get, NULL,     BTA_NOTE_CHILDREN),
    JS_CGETSET_MAGIC_DEF("__menus",    note_get, NULL,     BTA_NOTE_MENUS),
    JS_CGETSET_MAGIC_DEF("__actions",  note_get, NULL,     BTA_NOTE_ACTIONS),
};

/* ------------------------------------------------------------ strict checks
 *
 * The flag, and the one line that carries it out. See `bta.h` for what it is
 * for and `docs/plans/strict-plan.md` for why it took the cleanup above to
 * become possible: until those six notes moved onto the struct, sealing a
 * widget would have broken the runtime before it caught anybody's typo.
 */
static bool strict_checks = false;

void bta_strict_want(void) { strict_checks = true; }
bool bta_strict(void)      { return strict_checks; }

void bta_strict_seal(JSContext *ctx, JSValueConst obj)
{
    if (strict_checks)
        JS_PreventExtensions(ctx, obj);
}

static const JSCFunctionListEntry widget_props[] = {
    JS_CGETSET_DEF("Name",    w_get_name, w_set_name),
    JS_CGETSET_MAGIC_DEF("X",       w_get_geom, w_set_geom, GEOM_X),
    JS_CGETSET_MAGIC_DEF("Y",       w_get_geom, w_set_geom, GEOM_Y),
    JS_CGETSET_MAGIC_DEF("Width",   w_get_geom, w_set_geom, GEOM_W),
    JS_CGETSET_MAGIC_DEF("Height",  w_get_geom, w_set_geom, GEOM_H),
    /* The floor a stretched control may not be squeezed below. Only means
     * something on an axis whose HAlign/VAlign is "Fill" -- on any other the
     * drawn size is already the minimum. */
    JS_CGETSET_MAGIC_DEF("MinWidth",  w_get_geom, w_set_geom, GEOM_MIN_W),
    JS_CGETSET_MAGIC_DEF("MinHeight", w_get_geom, w_set_geom, GEOM_MIN_H),
    JS_CGETSET_MAGIC_DEF("Visible", w_get_flag, w_set_flag, FLAG_VISIBLE),
    JS_CGETSET_MAGIC_DEF("Enabled", w_get_flag, w_set_flag, FLAG_ENABLED),
    JS_CGETSET_DEF("Action", w_get_action, w_set_action),
    JS_CGETSET_MAGIC_DEF("Focusable", w_get_flag, w_set_flag, FLAG_FOCUSABLE),
    JS_CGETSET_DEF("Focused", w_get_focused, NULL),
    JS_CGETSET_MAGIC_DEF("Expand",  w_get_expand, w_set_expand, EXPAND_BOTH),
    JS_CGETSET_MAGIC_DEF("HExpand", w_get_expand, w_set_expand, EXPAND_H),
    JS_CGETSET_MAGIC_DEF("VExpand", w_get_expand, w_set_expand, EXPAND_V),
    JS_CGETSET_MAGIC_DEF("HAlign",  w_get_align,  w_set_align,  ALIGN_H),
    JS_CGETSET_MAGIC_DEF("VAlign",  w_get_align,  w_set_align,  ALIGN_V),
    JS_CGETSET_DEF("ColumnSpan", w_get_span, w_set_span),
    JS_CGETSET_DEF("TabIndex", w_get_tab_index, w_set_tab_index),
    JS_CGETSET_DEF("Margin", w_get_margin, w_set_margin),
    JS_CGETSET_DEF("Style", w_get_style, w_set_style),
    JS_CGETSET_MAGIC_DEF("Background", w_get_color, w_set_color, COLOR_BG),
    JS_CGETSET_MAGIC_DEF("Foreground", w_get_color, w_set_color, COLOR_FG),
    JS_CGETSET_DEF("Font", w_get_font, w_set_font),
    JS_CGETSET_DEF("Radius", w_get_radius, w_set_radius),
    JS_CGETSET_DEF("Padding", w_get_padding, w_set_padding),
    JS_CGETSET_DEF("Shortcut", w_get_shortcut, w_set_shortcut),
    JS_CGETSET_DEF("Shadow", w_get_shadow, w_set_shadow),
    JS_CGETSET_DEF("Border", w_get_border, w_set_border),
    JS_CGETSET_DEF("FontScale", w_get_scale, w_set_scale),
    JS_CGETSET_DEF("Opacity", w_get_opacity, w_set_opacity),
    /* Read-only, so the serialiser skips it: it is the desktop's answer and
     * never a form's declaration. */
    JS_CGETSET_DEF("Dark", w_get_dark, NULL),
    JS_CGETSET_DEF("Tooltip",    w_get_tooltip,     w_set_tooltip),
    JS_CGETSET_DEF("Cursor",     w_get_cursor,      w_set_cursor),
    JS_CGETSET_DEF("DragData",   w_get_drag_data,   w_set_drag_data),
    JS_CGETSET_DEF("AcceptDrop", w_get_accept_drop, w_set_accept_drop),
    JS_CGETSET_DEF("AcceptFiles", w_get_accept_files, w_set_accept_files),
    JS_CGETSET_DEF("Menu",       w_get_menu,        w_set_menu),
    JS_CFUNC_DEF("PopupMenu", 2, w_popup_menu),
    JS_CFUNC_DEF("Show",     0, w_show),
    JS_CFUNC_DEF("Hide",     0, w_hide),
    JS_CFUNC_DEF("Move",     2, w_move),
    JS_CFUNC_DEF("Resize",   2, w_resize),
    JS_CFUNC_DEF("SizeRequest", 0, w_size_request),
    JS_CFUNC_DEF("SetFocus", 0, w_set_focus),
    JS_CFUNC_DEF("Delete",   0, w_delete),
    JS_CFUNC_DEF("Emit",     1, w_emit),
    JS_CFUNC_DEF("OriginIn", 1, w_origin_in),
    JS_CFUNC_DEF("Bounds",   1, w_bounds),
    JS_CFUNC_DEF("PropertyOptions", 1, w_property_options),
    JS_CFUNC_DEF("TextProperties", 0, w_text_properties),
    JS_CFUNC_DEF("EventNames",     0, w_event_names),
    JS_CFUNC_DEF("StyleRule",      0, w_style_rule),
    JS_CFUNC_DEF("CssNode",        0, w_css_node),
    /* Detach from the current parent without destroying the widget. Needed
     * for re-parenting in GTK 4, where a container refuses
     * a widget that already has a parent. */
    JS_CFUNC_DEF("Remove",   0, w_remove),
    JS_CFUNC_MAGIC_DEF("Raise", 0, w_restack, STACK_RAISE),
    JS_CFUNC_MAGIC_DEF("Lower", 0, w_restack, STACK_LOWER),
};

const JSCFunctionListEntry *bta_widget_base_props(int *count)
{
    *count = (int)G_N_ELEMENTS(widget_props);
    return widget_props;
}

/* ---------------------------------------------------------------- mouse */

/*
 * Every widget reports MouseDown/MouseUp/MouseMove with coordinates relative
 * to itself.  The controllers sit in the bubble phase, so a control's own
 * behaviour (a Button's click) still happens first and these are additive.
 */
static void emit_mouse(BtaWidget *w, const char *event, double x, double y,
                       int button, GdkModifierType state)
{
    JSContext *ctx = w->ctx;
    JSValue    argv[5] = {
        JS_NewFloat64(ctx, x),
        JS_NewFloat64(ctx, y),
        JS_NewInt32(ctx, button),
        JS_NewBool(ctx, (state & GDK_CONTROL_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_SHIFT_MASK) != 0),
    };

    bta_emit(w, event, 5, argv);

    for (int i = 0; i < 5; i++)
        JS_FreeValue(ctx, argv[i]);
}

/*
 * The menu of the nearest widget that has one, starting here and walking out.
 *
 * A control that handles the press keeps it -- a Button does -- so the event
 * never reaches the container it sits in, and a container's context menu would
 * work everywhere except over its own contents. Walking up from the widget
 * that *did* see the click is what makes "right click anything inside this
 * panel" mean what it says, while a control with a menu of its own still
 * answers first.
 *
 * The point comes along, translated into whichever widget ends up showing the
 * menu, so it still opens where the pointer is.
 */
static void popup_nearest(BtaWidget *w, double x, double y)
{
    if (!w)
        return;

    for (GtkWidget *at = w->gtk; at; at = gtk_widget_get_parent(at)) {
        BtaWidget *cw = g_object_get_data(G_OBJECT(at), BTA_WIDGET_QUARK);
        if (!cw || !cw->popup)
            continue;

        graphene_point_t p = GRAPHENE_POINT_INIT((float)x, (float)y);
        if (cw != w &&
            !gtk_widget_compute_point(w->gtk, cw->gtk,
                                      &GRAPHENE_POINT_INIT((float)x, (float)y), &p))
            continue;

        bta_menu_popup_show(cw, p.x, p.y);
        return;
    }
}

static void on_mouse_pressed(GtkGestureClick *g, int n_press,
                             double x, double y, gpointer user_data)
{
    int button = (int)gtk_gesture_single_get_current_button(GTK_GESTURE_SINGLE(g));
    GdkModifierType state =
        gtk_event_controller_get_current_event_state(GTK_EVENT_CONTROLLER(g));

    emit_mouse(user_data, "MouseDown", x, y, button, state);

    /* GTK reports the first press too, so MouseDown always fires before
     * DblClick -- a handler for both sees the press then the double. */
    if (n_press == 2)
        emit_mouse(user_data, "DblClick", x, y, button, state);

    /* The right button opens the context menu if there is one, *after* the
     * event was reported: additive like the rest, so an application that would
     * rather answer the click itself simply declares no menu. */
    if (button == GDK_BUTTON_SECONDARY)
        popup_nearest(user_data, x, y);
}

static void on_mouse_released(GtkGestureClick *g, int n_press,
                              double x, double y, gpointer user_data)
{
    emit_mouse(user_data, "MouseUp", x, y,
               (int)gtk_gesture_single_get_current_button(GTK_GESTURE_SINGLE(g)),
               gtk_event_controller_get_current_event_state(GTK_EVENT_CONTROLLER(g)));
}

static void on_mouse_motion(GtkEventControllerMotion *c,
                            double x, double y, gpointer user_data)
{
    emit_mouse(user_data, "MouseMove", x, y, 0,
               gtk_event_controller_get_current_event_state(GTK_EVENT_CONTROLLER(c)));
}

/*
 * KeyPress(key, ctrl, shift, alt).  `key` is a name like "Delete", "Left" or
 * "s" -- what a shortcut is written in terms of, not a raw keycode.  A handler
 * that returns true consumes the key, which is how the designer can use the
 * arrows without the focus walking away.
 */
static gboolean on_key_pressed(GtkEventControllerKey *c, guint keyval,
                               guint keycode, GdkModifierType state,
                               gpointer user_data)
{
    BtaWidget *w   = user_data;
    JSContext *ctx = w->ctx;

    const char *name = gdk_keyval_name(keyval);
    JSValue argv[4] = {
        JS_NewString(ctx, name ? name : ""),
        JS_NewBool(ctx, (state & GDK_CONTROL_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_SHIFT_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_ALT_MASK) != 0),
    };

    JSValue r = bta_emit_on(ctx, w->form, w->name, "KeyPress", 4, argv);
    gboolean handled = JS_ToBool(ctx, r) > 0;

    JS_FreeValue(ctx, r);
    for (int i = 0; i < 4; i++)
        JS_FreeValue(ctx, argv[i]);

    /*
     * Escape presses the form's Cancel button -- **after** the handler, and only
     * if nothing consumed the key. A `Form_KeyPress` that returns true wins,
     * because code written for this form beats a declaration made about it.
     *
     * Nothing happens without a Cancel button, and that is the whole answer:
     * Qt and GTK3 close a dialog on Escape whether it asked to or not, and this
     * runtime deliberately does not -- a window that discards work on a stray
     * keystroke is a decision that has to be made out loud.  What the Cancel
     * button does then goes through `Close()` like any other close, so a
     * `Form_Close` that vetoes (see `on_close_request`) governs Escape too.
     */
    if (!handled && w->is_form && keyval == GDK_KEY_Escape) {
        BtaWidget *btn = bta_widget_flagged(w, true);

        /* Insensitive means the form is saying no right now, and Escape is not
         * a way around what a disabled button already refuses. */
        if (btn && btn->gtk && gtk_widget_get_sensitive(btn->gtk)) {
            g_signal_emit_by_name(btn->gtk, "clicked");
            handled = TRUE;
        }
    }

    return handled ? GDK_EVENT_STOP : GDK_EVENT_PROPAGATE;
}

/*
 * Focus, which an application has to be able to see.
 *
 * A field that checks what was typed does it when the control is *done* being
 * edited, and done is either Enter or the focus moving on -- so without this,
 * "when the user leaves this box" cannot be said at all.  (It is also the one
 * prerequisite docs/plans/data-plan.md names for binding a record to a form.)
 *
 * `enter`/`leave` and not `notify::is-focus`, because the question is about the
 * *control* and not the widget: a TextBox's focus really sits on the GtkText
 * inside the entry, and an editor's on the view inside its scroller.  The
 * controller on the outer widget reports focus arriving at it *or any descendant*,
 * which is what a form is asking about.
 */
static void on_focus_enter(GtkEventControllerFocus *c, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "GotFocus", 0, NULL);
}

static void on_focus_leave(GtkEventControllerFocus *c, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "LostFocus", 0, NULL);
}

/*
 * The pointer arriving and leaving.
 *
 * `MouseMove` says where the pointer is; these say *whether* it is here at all,
 * which is the question a control that highlights itself is asking and cannot
 * answer from motion alone -- there is no motion event for having left.
 */
static void on_mouse_enter(GtkEventControllerMotion *c, double x, double y,
                           gpointer user_data)
{
    BtaWidget *w   = user_data;
    JSValue    argv[2] = { JS_NewFloat64(w->ctx, x), JS_NewFloat64(w->ctx, y) };
    JSValue    r   = bta_emit_on(w->ctx, w->form, w->name, "MouseEnter", 2, argv);

    JS_FreeValue(w->ctx, r);
    JS_FreeValue(w->ctx, argv[0]);
    JS_FreeValue(w->ctx, argv[1]);
}

static void on_mouse_leave(GtkEventControllerMotion *c, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "MouseLeave", 0, NULL);
}

/*
 * The wheel. `dx`/`dy` are how far it turned, in the units GTK reports -- one
 * notch is 1.0 on a wheel and a fraction on a touchpad, which is the difference
 * a handler is entitled to see rather than have rounded away for it.
 *
 * Returning true consumes it, as `KeyPress` does: a control that scrolls itself
 * has to be able to stop the scroller it sits in from scrolling too.
 */
static gboolean on_mouse_scroll(GtkEventControllerScroll *c, double dx, double dy,
                                gpointer user_data)
{
    BtaWidget *w = user_data;
    JSValue argv[2] = { JS_NewFloat64(w->ctx, dx), JS_NewFloat64(w->ctx, dy) };
    JSValue r = bta_emit_on(w->ctx, w->form, w->name, "MouseWheel", 2, argv);

    gboolean handled = JS_ToBool(w->ctx, r) > 0;
    JS_FreeValue(w->ctx, r);
    JS_FreeValue(w->ctx, argv[0]);
    JS_FreeValue(w->ctx, argv[1]);
    return handled ? GDK_EVENT_STOP : GDK_EVENT_PROPAGATE;
}

/*
 * The key going up.
 *
 * The other half of `KeyPress`, and the half a control that does something *for
 * as long as a key is held* needs -- the arrows nudging a selection, a modifier
 * changing what a drag means. Nothing is consumable here: a release that could
 * be swallowed would leave whoever was watching for it holding a key forever.
 */
static void on_key_released(GtkEventControllerKey *c, guint keyval, guint keycode,
                            GdkModifierType state, gpointer user_data)
{
    BtaWidget  *w    = user_data;
    JSContext  *ctx  = w->ctx;
    const char *name = gdk_keyval_name(keyval);

    JSValue argv[4] = {
        JS_NewString(ctx, name ? name : ""),
        JS_NewBool(ctx, (state & GDK_CONTROL_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_SHIFT_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_ALT_MASK) != 0),
    };
    JSValue r = bta_emit_on(ctx, w->form, w->name, "KeyRelease", 4, argv);

    JS_FreeValue(ctx, r);
    for (int i = 0; i < 4; i++)
        JS_FreeValue(ctx, argv[i]);
}

/* Named for the mouse and long since about more than it: this is where every
 * controller a widget gets by default is installed. */
static void attach_mouse(BtaWidget *w)
{
    GtkGesture *click = gtk_gesture_click_new();
    gtk_gesture_single_set_button(GTK_GESTURE_SINGLE(click), 0);   /* any button */
    gtk_event_controller_set_propagation_phase(GTK_EVENT_CONTROLLER(click),
                                               GTK_PHASE_BUBBLE);
    g_signal_connect(click, "pressed",  G_CALLBACK(on_mouse_pressed),  w);
    g_signal_connect(click, "released", G_CALLBACK(on_mouse_released), w);
    gtk_widget_add_controller(w->gtk, GTK_EVENT_CONTROLLER(click));

    GtkEventController *motion = gtk_event_controller_motion_new();
    gtk_event_controller_set_propagation_phase(motion, GTK_PHASE_BUBBLE);
    g_signal_connect(motion, "motion", G_CALLBACK(on_mouse_motion), w);
    g_signal_connect(motion, "enter",  G_CALLBACK(on_mouse_enter),  w);
    g_signal_connect(motion, "leave",  G_CALLBACK(on_mouse_leave),  w);
    gtk_widget_add_controller(w->gtk, motion);

    /* Both axes, because a touchpad reports both and a handler that only ever
     * hears about one would be a scroll that works on a mouse. */
    GtkEventController *scroll =
        gtk_event_controller_scroll_new(GTK_EVENT_CONTROLLER_SCROLL_BOTH_AXES);
    gtk_event_controller_set_propagation_phase(scroll, GTK_PHASE_BUBBLE);
    g_signal_connect(scroll, "scroll", G_CALLBACK(on_mouse_scroll), w);
    gtk_widget_add_controller(w->gtk, scroll);

    /* Bubble, so whatever has focus gets first refusal: typing in a text box
     * must not reach the form's shortcuts. */
    GtkEventController *keys = gtk_event_controller_key_new();
    gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_BUBBLE);
    g_signal_connect(keys, "key-pressed",  G_CALLBACK(on_key_pressed),  w);
    g_signal_connect(keys, "key-released", G_CALLBACK(on_key_released), w);
    gtk_widget_add_controller(w->gtk, keys);

    /* Held as well as added, because `Focused` asks the controller: whether the
     * focus is *within* a widget is a question only it can answer, and GTK's
     * has_focus() is about the widget itself -- which for a TextBox is never the
     * one holding it. */
    GtkEventController *focus = gtk_event_controller_focus_new();
    g_signal_connect(focus, "enter", G_CALLBACK(on_focus_enter), w);
    g_signal_connect(focus, "leave", G_CALLBACK(on_focus_leave), w);
    gtk_widget_add_controller(w->gtk, focus);
    g_object_set_data(G_OBJECT(w->gtk), FOCUS_KEY, focus);
}

/* -------------------------------------------------------------- packing */

BtaWidget *bta_slot_child(GtkWidget *child)
{
    BtaWidget *w = g_object_get_data(G_OBJECT(child), BTA_WIDGET_QUARK);
    if (w)
        return w;

    /* GtkListBox and GtkFlowBox both wrap whatever is appended in a holder of
     * their own, so what the slot reports is that holder and the widget is its
     * child. */
    if (GTK_IS_LIST_BOX_ROW(child)) {
        GtkWidget *inner = gtk_list_box_row_get_child(GTK_LIST_BOX_ROW(child));
        if (inner)
            return g_object_get_data(G_OBJECT(inner), BTA_WIDGET_QUARK);
    }
    if (GTK_IS_FLOW_BOX_CHILD(child)) {
        GtkWidget *inner = gtk_flow_box_child_get_child(GTK_FLOW_BOX_CHILD(child));
        if (inner)
            return g_object_get_data(G_OBJECT(inner), BTA_WIDGET_QUARK);
    }
    return NULL;
}

GtkWidget *bta_child_holder(GtkWidget *child)
{
    GtkWidget *p = child ? gtk_widget_get_parent(child) : NULL;

    return (p && (GTK_IS_LIST_BOX_ROW(p) || GTK_IS_FLOW_BOX_CHILD(p))) ? p : child;
}

int bta_container_count(GtkWidget *slot)
{
    int n = 0;

    for (GtkWidget *c = gtk_widget_get_first_child(slot); c;
         c = gtk_widget_get_next_sibling(c))
        if (bta_slot_child(c))
            n++;
    return n;
}

bool bta_container_attach(JSContext *ctx, BtaWidget *parent, BtaWidget *child)
{
    GtkWidget *slot = parent->slot;

    if (!slot) {
        JS_ThrowTypeError(ctx, "%s is not a container",
                          parent->name ? parent->name : "widget");
        return false;
    }
    if (child->is_form) {
        JS_ThrowTypeError(ctx, "a form cannot be added to a container");
        return false;
    }

    /*
     * **The `GTK_IS_BOX` and `GTK_IS_FRAME` arms here and in detach are ahead of
     * the program**, and a reader should know it rather than go looking for the
     * container that uses them: no container assigns such a slot today. A
     * `Panel`, `Form`, `Frame`, `Expander` or `Scroller` slot is a `BtaFixed`,
     * and everything else is its own GTK type with an arm of its own. Left as
     * they are -- the day one is used the branch is already right -- but they
     * are unreached, so a change to them is untested by construction.
     */
    if (BTA_IS_FIXED(slot)) {
        /* No coordinates to hand over: the surface reads them off the child. */
        gtk_widget_set_parent(child->gtk, slot);
    } else if (GTK_IS_BOX(slot)) {
        gtk_box_append(GTK_BOX(slot), child->gtk);
    } else if (GTK_IS_PANED(slot)) {
        GtkPaned *p = GTK_PANED(slot);
        if (!gtk_paned_get_start_child(p))
            gtk_paned_set_start_child(p, child->gtk);
        else if (!gtk_paned_get_end_child(p))
            gtk_paned_set_end_child(p, child->gtk);
        else {
            JS_ThrowRangeError(ctx, "%s holds exactly two children",
                               parent->name ? parent->name : "a split");
            return false;
        }
    } else if (GTK_IS_OVERLAY(slot)) {
        /* First child is the base layer, the rest stack on top of it. */
        if (!gtk_overlay_get_child(GTK_OVERLAY(slot)))
            gtk_overlay_set_child(GTK_OVERLAY(slot), child->gtk);
        else
            gtk_overlay_add_overlay(GTK_OVERLAY(slot), child->gtk);
    } else if (GTK_IS_ASPECT_FRAME(slot)) {
        /* One child, which is given the whole rectangle the proportion works
         * out -- so an `Overlay` in here is the picture's rectangle and nothing
         * inside it has to be measured. A second child is refused where it is
         * asked for, the way a split refuses a third: the alternative is GTK
         * dropping the first one without a word. */
        if (gtk_aspect_frame_get_child(GTK_ASPECT_FRAME(slot))) {
            JS_ThrowRangeError(ctx, "%s holds one child",
                               parent->name ? parent->name : "an aspect frame");
            return false;
        }
        gtk_aspect_frame_set_child(GTK_ASPECT_FRAME(slot), child->gtk);
    } else if (GTK_IS_LIST_BOX(slot)) {
        /* Appended, not put: GTK wraps it in a row, which is what gives the
         * highlight and the keyboard navigation. */
        gtk_list_box_append(GTK_LIST_BOX(slot), child->gtk);
    } else if (GTK_IS_GRID(slot)) {
        /* Placed at the end and then re-flowed: a grid's order *is* its layout,
         * so where a child goes follows from how many came before it. */
        gtk_grid_attach(GTK_GRID(slot), child->gtk, 0, 0, 1, 1);
    } else if (GTK_IS_FLOW_BOX(slot)) {
        /* Same bargain, and the wrapper is what lets the flow measure a child
         * without the child knowing it is in one. */
        gtk_flow_box_append(GTK_FLOW_BOX(slot), child->gtk);
    } else if (GTK_IS_NOTEBOOK(slot)) {
        /* Pages added by the .form loader (a child widget, not a JS call)
         * are appended without a tab label: it can be set later via
         * SetTabLabel, or the default label can be used. */
        gtk_notebook_append_page(GTK_NOTEBOOK(slot), child->gtk, NULL);
        bta_notebook_page_added(slot, child->gtk);
    } else if (GTK_IS_STACK(slot)) {
        /* A Switcher's pages, same as the notebook's above: what the loader
         * hands over is a page, and the name on its button comes from the Tabs
         * the .form promised -- or a default, so no button comes out blank. */
        gtk_stack_add_child(GTK_STACK(slot), child->gtk);
        bta_switcher_page_added(slot, child->gtk);
    } else {
        JS_ThrowInternalError(ctx, "unsupported container slot");
        return false;
    }

    /* A radio's set is its container, so arriving in one joins it. */
    bta_radio_regroup(slot, child->gtk);
    bta_grid_reflow(slot);
    return true;
}

bool bta_container_detach(JSContext *ctx, BtaWidget *child)
{
    GtkWidget *slot = gtk_widget_get_parent(child->gtk);
    if (!slot)
        return true;   /* already detached */

    /*
     * **A widget on its way out must not still be the window's default button.**
     * GTK4 keeps an unowned pointer to it and takes the `.default` CSS class off
     * it when it is replaced -- so once the widget is freed that is a
     * `gtk_widget_remove_css_class` on memory nobody owns. It shows up as three
     * GTK-CRITICALs at the *next* thing that touches the window, which reads
     * like a bug in whatever that was.
     *
     * The whole subtree and not just this widget: detaching the panel a default
     * button sits in leaves the pointer exactly as dangling as detaching the
     * button. Said here because this is the one place every removal goes
     * through, which is the same reason `widget_apply_align` is said in attach.
     */
    GtkRoot *root = gtk_widget_get_root(child->gtk);
    if (root && GTK_IS_WINDOW(root)) {
        GtkWidget *def = gtk_window_get_default_widget(GTK_WINDOW(root));
        if (def && (def == child->gtk || gtk_widget_is_ancestor(def, child->gtk)))
            gtk_window_set_default_widget(GTK_WINDOW(root), NULL);
    }

    /* Is it a notebook page?  Asked before anything else, because a page's GTK
     * parent is an internal stack and none of the branches below would match it.
     * The page_num check is what tells a page from something merely inside one. */
    GtkWidget *page_of    = gtk_widget_get_ancestor(child->gtk, GTK_TYPE_NOTEBOOK);
    gint       page_index = page_of
        ? gtk_notebook_page_num(GTK_NOTEBOOK(page_of), child->gtk) : -1;

    /* In a RowList the child sits in a row of its own, and the row is what the
     * list box holds: taking the child out has to take its row with it, or the
     * list keeps an empty row where the control used to be.  Our own reference
     * is what keeps the child alive once the row lets go of it. */
    if (GTK_IS_LIST_BOX_ROW(slot)) {
        GtkWidget *row = slot;
        slot = gtk_widget_get_parent(row);

        gtk_list_box_row_set_child(GTK_LIST_BOX_ROW(row), NULL);
        if (GTK_IS_LIST_BOX(slot))
            gtk_list_box_remove(GTK_LIST_BOX(slot), row);
    } else if (GTK_IS_FLOW_BOX_CHILD(slot)) {
        /* The same as a RowList's row: taking the child out has to take its
         * wrapper with it, or the flow keeps a hole where the control was. */
        GtkWidget *cell = slot;
        slot = gtk_widget_get_parent(cell);

        gtk_flow_box_child_set_child(GTK_FLOW_BOX_CHILD(cell), NULL);
        if (GTK_IS_FLOW_BOX(slot))
            gtk_flow_box_remove(GTK_FLOW_BOX(slot), cell);
    } else if (BTA_IS_FIXED(slot))
        gtk_widget_unparent(child->gtk);
    else if (GTK_IS_BOX(slot))
        gtk_box_remove(GTK_BOX(slot), child->gtk);
    else if (page_of && page_index >= 0) {
        /* Not the notebook's own child: GTK keeps pages in a stack of its own, so
         * the parent above is that stack and the notebook is further up. */
        slot = page_of;
        gtk_notebook_remove_page(GTK_NOTEBOOK(page_of), page_index);
    }
    else if (GTK_IS_STACK(slot))
        /* Unparenting would leave the GtkStackPage behind, and with it a button
         * on the strip for a page that is no longer there. */
        gtk_stack_remove(GTK_STACK(slot), child->gtk);
    else if (GTK_IS_GRID(slot))
        /* A grid holds a position per child, so unparenting would leave the
         * attach behind; `bta_grid_reflow` below then re-places everyone that
         * stayed, which is what makes a hole close up rather than persist.
         *
         * Missing until an application went looking for it: without this branch
         * `Grid.Clear()`, a grid child's `Delete()` and `Remove()` all fell
         * through to the refusal below, so a grid could be filled once and never
         * rebuilt -- and a month view, a schedule and a timetable are exactly
         * the shapes that rebuild one. */
        gtk_grid_remove(GTK_GRID(slot), child->gtk);
    else if (GTK_IS_PANED(slot)) {
        /*
         * Cleared through the half that named it, and **not** unparented. GTK
         * keeps a pointer per half, and unparenting the widget leaves that
         * pointer set -- so the paned went on believing it was full and the next
         * `Add` was refused with *holds exactly two children*, on a split whose
         * `Children` read empty. It mirrors the attach above, which is the only
         * shape that cannot drift from it.
         *
         * Latent for as long as nothing refilled a cleared split, which is why
         * fixing `bta_container_clear` is what found it.
         */
        GtkPaned *p = GTK_PANED(slot);

        if (gtk_paned_get_start_child(p) == child->gtk)
            gtk_paned_set_start_child(p, NULL);
        else if (gtk_paned_get_end_child(p) == child->gtk)
            gtk_paned_set_end_child(p, NULL);
        else
            gtk_widget_unparent(child->gtk);
    }
    else if (GTK_IS_OVERLAY(slot)) {
        /* The same, and the same reason: the base layer is a property and the
         * ones above it are a list, so which call takes a child out depends on
         * which of the two it was. Unparenting the base left `overlay->child`
         * pointing at it, and the next `Add` tripped
         * `gtk_overlay_add_overlay: assertion 'widget != overlay->child'`. */
        GtkOverlay *o = GTK_OVERLAY(slot);

        if (gtk_overlay_get_child(o) == child->gtk) {
            gtk_overlay_set_child(o, NULL);

            /*
             * ...and the layer above it becomes the base, because attach makes
             * the first child one: an overlay left with floaters and no base has
             * nothing that fills, and `Children[0]` stops being the base --
             * which is the whole of what an index means in a stack.
             *
             * Not while the overlay itself is going: GTK unparents everything in
             * dispose, and promoting a child in the middle of that would hand
             * `set_child` a widget on its way out.
             */
            GtkWidget *next = gtk_widget_get_first_child(slot);

            if (next && !gtk_widget_in_destruction(slot)) {
                g_object_ref(next);
                gtk_overlay_remove_overlay(o, next);
                gtk_overlay_set_child(o, next);
                g_object_unref(next);
            }
        } else
            gtk_overlay_remove_overlay(o, child->gtk);
    }
    else if (GTK_IS_ASPECT_FRAME(slot))
        /* Through the property, not unparented: GTK keeps its own pointer, and
         * the container would go on believing it was full -- the fault a cleared
         * `Split` and a cleared `Overlay` both had, and the reason every branch
         * here mirrors its attach exactly. */
        gtk_aspect_frame_set_child(GTK_ASPECT_FRAME(slot), NULL);
    else if (GTK_IS_FRAME(slot))
        gtk_widget_unparent(child->gtk);
    else {
        JS_ThrowInternalError(ctx, "cannot remove from this container");
        return false;
    }

    /* ...and leaving one leaves its set, which the ones staying have to be told
     * about: GTK's group is a chain, and the link that left was in it. */
    bta_radio_regroup(slot, child->gtk);
    bta_grid_reflow(slot);

    BtaWidget *parent = g_object_get_data(G_OBJECT(slot), BTA_WIDGET_QUARK);
    if (parent)
        bta_widget_release(ctx, parent->self, child->self);
    return true;
}

/* ----------------------------------------------------------- the order */

bool bta_container_order(GtkWidget *slot)
{
    return slot && (bta_surface_is_box(slot) || GTK_IS_NOTEBOOK(slot) ||
                    GTK_IS_PANED(slot)       || GTK_IS_STACK(slot)    ||
                    GTK_IS_GRID(slot)        || GTK_IS_OVERLAY(slot)  ||
                    GTK_IS_FLOW_BOX(slot)    || GTK_IS_LIST_BOX(slot));
}

/*
 * Moving a child among its siblings, per kind of slot -- the mirror of the
 * attach and detach above, and here for the same reason: this is where the
 * knowledge of what a slot does with a child already lives.
 *
 * Three callers: `Reorder(child, index)`, `Raise`/`Lower` (which are this with
 * the index worked out), and the designer's drag. Written once because an index
 * has to mean the same thing whichever of the three asked -- `Raise` on an
 * overlay's base used to move it to last sibling while `overlay->child` still
 * pointed at it, so it went on filling and painted over its own floaters.
 *
 * `index` counts the siblings **without** the one being moved, which is what
 * makes "put it back where it was" the index it came from.
 */
bool bta_container_reorder(JSContext *ctx, BtaWidget *parent, BtaWidget *child,
                           int index)
{
    GtkWidget *slot = parent->slot;

    if (!bta_container_order(slot)) {
        JS_ThrowTypeError(ctx, "this container has no order to give");
        return false;
    }

    /* A notebook keeps its pages in a stack of its own, so a page's parent is
     * not the notebook -- ask the notebook instead. */
    if (GTK_IS_NOTEBOOK(slot)) {
        GtkNotebook *nb   = GTK_NOTEBOOK(slot);
        gint         page = gtk_notebook_page_num(nb, child->gtk);

        if (page < 0) {
            JS_ThrowTypeError(ctx, "%s is not a page of this notebook",
                              child->name ? child->name : "the widget");
            return false;
        }
        gtk_notebook_reorder_child(nb, child->gtk, index);
        return true;
    }

    /* Asked through the holder: in a Flow or a RowList the child's GTK parent
     * is the cell or row GTK wrapped it in, and the slot holds that. */
    GtkWidget *holder = bta_child_holder(child->gtk);

    if (!holder || gtk_widget_get_parent(holder) != slot) {
        JS_ThrowTypeError(ctx, "%s is not a child of this container",
                          child->name ? child->name : "the widget");
        return false;
    }

    /* A stack cannot be reordered in place -- GTK offers nothing to say it --
     * so the switcher takes its pages out and puts them back. */
    if (GTK_IS_STACK(slot)) {
        if (!bta_switcher_reorder(parent, child->gtk, index)) {
            JS_ThrowTypeError(ctx, "%s is not a page of this switcher",
                              child->name ? child->name : "the widget");
            return false;
        }
        return true;
    }

    /*
     * A split has two halves and no third place to go: ordering one is putting
     * it in the half the index names, and whatever was there takes the other.
     */
    if (GTK_IS_PANED(slot)) {
        GtkPaned  *paned = GTK_PANED(slot);
        GtkWidget *start = gtk_paned_get_start_child(paned);
        GtkWidget *end   = gtk_paned_get_end_child(paned);
        bool       first = index <= 0;

        if ((first && child->gtk == start) || (!first && child->gtk == end))
            return true;                            /* already there */

        /*
         * Both are unparented before either is re-parented: GTK 4 refuses a
         * widget that still has one.
         *
         * **Guarded, because a split with one half is ordinary** -- it is what
         * a Split looks like after the first child is dropped, and reordering
         * the remaining one is documented API.  `g_object_ref(NULL)` is two
         * GLib-GObject-CRITICALs and carries on, so the move came out right and
         * nothing said anything; under `G_DEBUG=fatal-criticals` it aborts.
         */
        if (start)
            g_object_ref(start);
        if (end)
            g_object_ref(end);
        gtk_paned_set_start_child(paned, NULL);
        gtk_paned_set_end_child(paned, NULL);
        gtk_paned_set_start_child(paned, first ? child->gtk : (start == child->gtk ? end : start));
        gtk_paned_set_end_child(paned, first ? (start == child->gtk ? end : start) : child->gtk);
        if (start)
            g_object_unref(start);
        if (end)
            g_object_unref(end);
        return true;
    }

    /*
     * A Flow and a RowList wrap every child in a cell of its own and keep those
     * wrappers in a sequence of GTK's, so the sibling order is **not** the
     * order: moving one with gtk_widget_insert_after would leave that sequence
     * -- indices, the keyboard walk, headers, the filter -- pointing at the old
     * places. It goes out through the box's own remove and back in at the
     * position asked for, which is the one call that keeps both in step.
     */
    if (GTK_IS_LIST_BOX(slot) || GTK_IS_FLOW_BOX(slot)) {
        int        n   = bta_container_count(slot);
        BtaWidget *own = g_object_get_data(G_OBJECT(slot), BTA_WIDGET_QUARK);
        bool       was = GTK_IS_LIST_BOX_ROW(holder) &&
                         gtk_list_box_row_is_selected(GTK_LIST_BOX_ROW(holder));

        if (index < 0)
            index = 0;
        if (index >= n)
            index = n - 1;                          /* the last place there is */

        /* Blocked for the duration: the remove says the selection is gone and
         * the insert says a row arrived, so a move that ends where it began
         * would report a `Select` nobody made. The bargain
         * `bta_switcher_reorder` makes, one level down. */
        if (own)
            g_signal_handlers_block_matched(slot, G_SIGNAL_MATCH_DATA,
                                            0, 0, NULL, NULL, own);

        /* The wrapper is referenced across the two calls because the box holds
         * the only reference to it: gtk_list_box_remove ends in
         * gtk_widget_unparent(row), and a row finalised between them would take
         * the control's parent with it -- a control that still exists, still
         * answers, and is in no list. */
        g_object_ref(holder);

        if (GTK_IS_LIST_BOX(slot)) {
            /*
             * Unselected **before** the remove. `gtk_list_box_remove` clears the
             * box's own pointer but leaves the row's `selected` flag set, and
             * `gtk_list_box_select_row` returns early on a row that already
             * claims to be selected -- so the row would come back drawing
             * selected while `Index` answered -1, with nothing but a click to
             * get out of it.
             */
            if (was)
                gtk_list_box_unselect_row(GTK_LIST_BOX(slot),
                                          GTK_LIST_BOX_ROW(holder));

            gtk_list_box_remove(GTK_LIST_BOX(slot), holder);
            gtk_list_box_insert(GTK_LIST_BOX(slot), holder, index);

            if (was)
                gtk_list_box_select_row(GTK_LIST_BOX(slot),
                                        GTK_LIST_BOX_ROW(holder));
        } else {
            /* A Flow selects nothing (`GTK_SELECTION_NONE` at build), so there
             * is no selection to put back -- the shape is the same anyway, or
             * the two would drift. */
            gtk_flow_box_remove(GTK_FLOW_BOX(slot), holder);
            gtk_flow_box_insert(GTK_FLOW_BOX(slot), holder, index);
        }

        g_object_unref(holder);

        if (own)
            g_signal_handlers_unblock_matched(slot, G_SIGNAL_MATCH_DATA,
                                              0, 0, NULL, NULL, own);
        return true;
    }

    /*
     * An Overlay is a stack and index 0 is the bottom of it -- which is the
     * **base layer**, the child GTK hands the whole allocation to. So ordering a
     * child to 0 says *be the one that fills*, the same bargain the split above
     * makes with its halves, and `Children[0]` is the base at every moment.
     *
     * Only that question is settled here. GTK keeps no positional bookkeeping
     * for an overlay -- its layout tells the base apart by comparing against
     * `gtk_overlay_get_child()` and by nothing else -- so the paint order is the
     * ordinary sibling reorder at the end of this function.
     */
    if (GTK_IS_OVERLAY(slot)) {
        GtkOverlay *o    = GTK_OVERLAY(slot);
        GtkWidget  *base = gtk_overlay_get_child(o);

        if (index <= 0 && child->gtk != base) {
            /* Both referenced across the swap: `set_child` refuses a widget
             * that still has a parent, and it unparents whoever was base --
             * which is the last reference GTK holds on it. */
            g_object_ref(child->gtk);
            if (base)
                g_object_ref(base);

            gtk_overlay_remove_overlay(o, child->gtk);
            gtk_overlay_set_child(o, child->gtk);   /* GTK puts a base first */

            if (base) {
                gtk_overlay_add_overlay(o, base);   /* appended, then placed */
                gtk_widget_insert_after(base, slot, child->gtk);
                g_object_unref(base);
            }
            g_object_unref(child->gtk);
            return true;
        }

        if (index > 0 && child->gtk == base) {
            /* Leaving the bottom: the layer above becomes the base, because a
             * stack holding anything has exactly one child that fills. */
            GtkWidget *next = gtk_widget_get_next_sibling(child->gtk);

            if (!next)
                return true;                  /* the only child: nowhere to go */

            g_object_ref(child->gtk);
            g_object_ref(next);
            gtk_overlay_remove_overlay(o, next);
            gtk_overlay_set_child(o, next);          /* unparents the old base */
            gtk_overlay_add_overlay(o, child->gtk);
            g_object_unref(next);
            g_object_unref(child->gtk);
            /* ...and on to the walk below, which puts it where it was asked
             * for: `after` has to be read off the list as it is now. */
        }
    }

    /* The sibling to sit after: index 0 is "first", i.e. after nobody. */
    GtkWidget *after = NULL;
    int        at    = 0;

    for (GtkWidget *c = gtk_widget_get_first_child(slot); c && at < index;
         c = gtk_widget_get_next_sibling(c)) {
        if (c == child->gtk)
            continue;           /* it is moving: it does not count on the way */
        after = c;
        at++;
    }

    /*
     * A grid's order *is* its layout, so moving one child moves every child
     * after it -- which is what re-flowing does. The sibling order is GTK's own
     * and moving it there is one call; where each one then sits follows.
     */
    if (GTK_IS_GRID(slot)) {
        gtk_widget_insert_after(child->gtk, slot, after);
        bta_grid_reflow(slot);
        return true;
    }

    /* One call, and the box layout reads the sibling order it finds. */
    gtk_widget_insert_after(child->gtk, slot, after);
    return true;
}

/* --------------------------------------------------------- class table */

static GArray *class_rows;   /* BtaClass, in registration order */

void bta_register_classes(const BtaClass *rows, int n)
{
    g_array_append_vals(class_rows, rows, n);
}

BtaClass *bta_class_table(int *count)
{
    if (!class_rows) {
        class_rows = g_array_new(FALSE, FALSE, sizeof(BtaClass));

        /* Order is load-bearing: every parent must already be registered. */
        bta_core_register();
        bta_layout_register();
        bta_notebook_register();
        bta_switcher_register();
        bta_paint_register();
        /* Before the source editor, which extends its `Editor`. */
        bta_text_register();
        bta_editor_register();
        bta_terminal_register();
        bta_tree_register();
        bta_table_register();
        bta_media_register();
    }
    *count = (int)class_rows->len;
    return (BtaClass *)class_rows->data;
}

BtaClass *bta_class_find(const char *name)
{
    int       n;
    BtaClass *table = bta_class_table(&n);

    for (int i = 0; i < n; i++)
        if (!strcmp(table[i].name, name))
            return &table[i];
    return NULL;
}

/*
 * What a palette has to have in order to offer a control: the class's own
 * answer, which is a constant of the build for most of them and a question put
 * to the machine for the few that declare a probe.  One function so the class
 * table, the instance accessor and any future caller cannot disagree about
 * which of the two it is.
 */
bool bta_class_runnable(const BtaClass *cls)
{
    if (!cls)
        return false;
    return cls->probe ? cls->probe() : cls->available;
}

/* ------------------------------------------------------- class lifecycle */

/*
 * Nothing on the GTK side may still be able to call into a widget the
 * interpreter has finalised.
 *
 * A container routinely holds the last reference to the GtkWidget, so the
 * widget outlives its wrapper -- and GTK emits signals while tearing *itself*
 * down: a notebook removing a page emits switch-page, a list box emits
 * row-selected.  At shutdown that happens with siblings already freed, and the
 * handler reads a BtaWidget that is gone.  (It is why closing the IDE from its
 * window crashed while quitting from the menu did not: only the window's
 * destruction runs that dispose chain.)
 *
 * Every handler installed here carries the BtaWidget as its data, so unhooking
 * by data covers them all: on the three widgets a control can be made of, plus
 * their event controllers, where the mouse, the keyboard and drag and drop are.
 */
void bta_widget_watch(BtaWidget *w, gpointer object)
{
    if (!w || !object)
        return;

    if (!w->watched)
        w->watched = g_ptr_array_new_with_free_func(g_object_unref);

    /* Held, so the pointer is certainly still valid when we unhook it. */
    g_ptr_array_add(w->watched, g_object_ref(object));
}

static void widget_disconnect_all(BtaWidget *w)
{
    GtkWidget *parts[] = { w->gtk, w->inner, w->slot };

    for (guint i = 0; w->watched && i < w->watched->len; i++)
        g_signal_handlers_disconnect_by_data(w->watched->pdata[i], w);

    for (int i = 0; i < 3; i++) {
        GtkWidget *part = parts[i];
        if (!part)
            continue;
        /* The three are often the same widget; unhooking twice is harmless but
         * observing controllers twice is pointless work. */
        if ((i > 0 && part == parts[0]) || (i > 1 && part == parts[1]))
            continue;

        g_signal_handlers_disconnect_by_data(part, w);

        GListModel *controllers = gtk_widget_observe_controllers(part);
        guint       n           = g_list_model_get_n_items(controllers);

        for (guint k = 0; k < n; k++) {
            GObject *controller = g_list_model_get_item(controllers, k);
            g_signal_handlers_disconnect_by_data(controller, w);
            g_object_unref(controller);
        }
        g_object_unref(controllers);
    }
}

/*
 * ...and neither may anything *under* it.
 *
 * Unhooking a widget as it is finalised is only half of the promise above: the
 * one reference that keeps a window alive is the wrapper's, so disposing it
 * from here tears the whole tree down -- and GTK dispatches while it does.
 * `gtk_window_dispose` moves the focus off whatever had it, which synthesises a
 * crossing event, which emits `focus-leave` on a child that is still hooked up
 * and whose wrapper has not been finalised yet.  That handler then looks
 * `BtnClose_LostFocus` up on `w->form` -- the object the collector is freeing in
 * this very cycle -- and reads a shape that is already gone.
 *
 * A cycle is freed in no particular order, so it cannot be arranged for the
 * children to go first; what can be arranged is that none of them can still
 * speak.  A child's wrapper holds a strong reference to its form, so a form
 * being freed means every control on it is being freed in the same cycle: there
 * is no live subscriber left to protect, only handlers that have to be quiet
 * while GTK takes the tree apart.
 *
 * Found by an About dialog, which is the smallest thing that has a button with
 * the focus and outlives everything else: the IDE kept it to be able to reach
 * it, so it was still there at teardown and the crash was in `JS_FreeRuntime`.
 */
static void widget_disconnect_tree(GtkWidget *root)
{
    for (GtkWidget *child = gtk_widget_get_first_child(root); child;
         child = gtk_widget_get_next_sibling(child)) {
        BtaWidget *cw = g_object_get_data(G_OBJECT(child), BTA_WIDGET_QUARK);

        if (cw)
            widget_disconnect_all(cw);
        widget_disconnect_tree(child);
    }
}

static void widget_finalizer(JSRuntime *rt, JSValue val)
{
    BtaWidget *w = JS_GetOpaque(val, bta_widget_class_id);
    if (!w)
        return;

    if (w->gtk)
        widget_disconnect_all(w);

    JS_FreeValueRT(rt, w->form);

    if (w->style_class) {
        if (style_rules)
            g_hash_table_remove(style_rules, w->style_class);
        g_free(w->style_class);
    }
    g_free(w->style);
    g_free(w->background);
    g_free(w->foreground);
    g_free(w->font);
    g_free(w->radius);
    g_free(w->padding);
    g_free(w->shadow);
    g_free(w->border);
    /* The controller belongs to the widget and goes with it; these are ours. */
    g_strfreev(w->shortcuts);

    if (w->watched)
        g_ptr_array_unref(w->watched);

    /* The popover is a child of w->gtk that nothing else will unparent, and
     * GTK complains loudly about finalising a widget that still has one. */
    bta_menu_popup_free(w);
    JS_FreeValueRT(rt, w->menu);

    /* The six notes; every one of them is marked above. */
    JS_FreeValueRT(rt, w->declared);
    JS_FreeValueRT(rt, w->children);
    JS_FreeValueRT(rt, w->menus);
    JS_FreeValueRT(rt, w->actions_spec);
    JS_FreeValueRT(rt, w->columns);
    JS_FreeValueRT(rt, w->painter);

    if (w->gtk) {
        /*
         * The container may still hold a ref: leave no dangling back-pointer.
         * On the slot too, which carries the same tag -- a child's GTK parent
         * is its owner's slot -- and which outlives this wrapper exactly as
         * `w->gtk` does.  Anything walking the GTK tree afterwards, this
         * finalizer included, would otherwise find a pointer to freed memory
         * and have no way of telling.
         */
        g_object_set_data(G_OBJECT(w->gtk), BTA_WIDGET_QUARK, NULL);
        if (w->slot && w->slot != w->gtk)
            g_object_set_data(G_OBJECT(w->slot), BTA_WIDGET_QUARK, NULL);

        /* This unref is what disposes a window, and a dispose dispatches: see
         * widget_disconnect_tree. */
        widget_disconnect_tree(w->gtk);
        g_object_unref(w->gtk);
    }
    /* The action group holds every action of the form, and every action holds a
     * reference to the form's JS object -- so this is the unref that lets the
     * whole command graph go. */
    if (w->actions)
        g_object_unref(w->actions);
    g_free(w->action);
    g_free(w->name);
    g_free(w);
}

/* Controls point back at their form, so the graph has cycles; reporting the
 * edge lets QuickJS's cycle collector free forms that go out of scope. */
/*
 * Every JSValue this struct holds, reported to the collector.
 *
 * This is the line the `bta_table.c` comment did not know about, and the reason
 * six notes could come off the wrapper and onto the struct: a value held in C is
 * a strong reference the collector cannot see *unless something says so*, and
 * this is where it is said. Anything added above and forgotten here is a cycle
 * that never collects; anything freed in the finalizer and not marked here is
 * `Assertion list_empty(&rt->gc_obj_list) failed` at teardown, which
 * `tests/asan.sh` runs on every project.
 */
static void widget_gc_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    BtaWidget *w = JS_GetOpaque(val, bta_widget_class_id);
    if (w) {
        JS_MarkValue(rt, w->form, mark_func);
        JS_MarkValue(rt, w->menu, mark_func);
        JS_MarkValue(rt, w->declared, mark_func);
        JS_MarkValue(rt, w->children, mark_func);
        JS_MarkValue(rt, w->menus, mark_func);
        JS_MarkValue(rt, w->actions_spec, mark_func);
        JS_MarkValue(rt, w->columns, mark_func);
        JS_MarkValue(rt, w->painter, mark_func);
    }
}

static const JSClassDef widget_class_def = {
    "Widget",
    .finalizer = widget_finalizer,
    .gc_mark   = widget_gc_mark,
};

/*
 * The name this class goes by, which is what locates its .form: qualified when
 * it lives in a namespace, bare when it does not.
 *
 * A constructor cannot answer this itself -- `Widgets.Stepper = class Stepper`
 * has a .name of "Stepper", the assignment came after the class expression was
 * named -- so rad.js works it out from the namespaces it registered.  A runtime
 * whose rad.js has not been evaluated yet falls back to the bare name, which is
 * what every project without namespaces gets anyway.
 *
 * Returns NULL only with an exception pending; an unnamed class gives "".
 */
static char *class_name_of(JSContext *ctx, JSValueConst ctor)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue widget = JS_GetPropertyStr(ctx, global, "Widget");
    JS_FreeValue(ctx, global);

    JSValue fn  = JS_GetPropertyStr(ctx, widget, "TypeName");
    char   *out = NULL;
    bool    bad = false;

    if (JS_IsFunction(ctx, fn)) {
        JSValue r = JS_Call(ctx, fn, widget, 1, &ctor);
        if (JS_IsException(r)) {
            bad = true;
        } else {
            const char *s = JS_ToCString(ctx, r);
            if (s)
                out = g_strdup(s);
            else
                bad = true;
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, r);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, widget);

    if (bad)
        return NULL;
    if (out)
        return out;

    JSValue     nv = JS_GetPropertyStr(ctx, ctor, "name");
    const char *s  = JS_ToCString(ctx, nv);
    out = g_strdup(s ? s : "");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, nv);
    return out;
}

static JSValue bta_ctor(JSContext *ctx, JSValueConst new_target,
                        int argc, JSValueConst *argv, int magic)
{
    int       n;
    BtaClass *table = bta_class_table(&n);
    BtaClass *cls   = &table[magic];

    if (!cls->build)
        return JS_ThrowTypeError(ctx, "%s is abstract and cannot be instantiated",
                                 cls->name);

    /*
     * **A console project has no GTK, and a widget without GTK is a core dump.**
     * A project declaring `main` never calls `gtk_init`, so the first
     * `new Panel()` reaches `gtk_css_static_style_get_default()` with nothing
     * initialised and the process dies with no message at all -- which is how
     * this was found, while testing something else entirely.
     *
     * A console project is the shape `tests/api`, `tests/icons` and
     * `tests/styles` are, and it is exactly the shape that has no business making
     * widgets. So it is told, with the name of the class it asked for.
     */
    if (!gtk_is_initialized())
        return JS_ThrowTypeError(ctx, "%s: a project with a `main` has no "
                                      "display, so it cannot make widgets",
                                 cls->name);

    /*
     * **A worker thread has GTK initialised and still cannot make widgets.**
     * `gtk_is_initialized` is process-wide, so the check above passes there.
     *
     * Today nothing reaches this line from a worker -- `bta_widgets_init`
     * does not run in one (it keeps each class's proto and ctor in a
     * process-global table the main thread owns) and `forms.js` is not
     * evaluated there either, so `Button` is not a name a worker has.  This
     * stays as the *last* guard rather than the only one: the day a class is
     * registered per runtime, the failure it prevents is a crash in GTK from
     * the wrong thread, which is not the kind of thing to find out then.
     * A task computes and answers; what is drawn stays on the main thread,
     * where the answer arrives as `Done`.
     */
    if (bta_task_is_worker(ctx))
        return JS_ThrowTypeError(ctx, "%s: a task runs off the main thread, "
                                      "so it cannot make widgets",
                                 cls->name);

    /* Honour subclassing: `class Form1 extends Form` must get Form1.prototype. */
    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto))
        return proto;

    JSValue obj = JS_NewObjectProtoClass(ctx, proto, bta_widget_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;

    BtaWidget *w = g_new0(BtaWidget, 1);
    w->ctx     = ctx;
    w->form    = JS_UNDEFINED;
    w->self    = obj;          /* borrowed; see the note in bta.h */
    w->is_form = cls->is_form;
    w->w = w->h = -1;
    w->anchored = true;        /* g_new0 would have said otherwise */
    /* 1 is "nothing said" for both: the size in force, and no dimming. Said
     * here because g_new0 would have made them 0, which for a scale is not a
     * size and for an opacity is invisible. */
    w->opacity    = 1.0;
    w->font_scale = 1.0;
    w->span     = 1;           /* one column, likewise */
    w->menu     = JS_UNDEFINED;
    /* The runtime's notes about this widget: nothing said yet, and `g_new0`
     * does not spell that -- JS_UNDEFINED is not all-zero on every build. */
    w->declared = JS_UNDEFINED;
    w->children = JS_UNDEFINED;
    w->menus    = JS_UNDEFINED;
    w->actions_spec = JS_UNDEFINED;
    w->columns  = JS_UNDEFINED;
    w->painter  = JS_UNDEFINED;
    JS_SetOpaque(obj, w);

    cls->build(w);
    if (!w->gtk) {
        JS_FreeValue(ctx, obj);
        return JS_ThrowInternalError(ctx, "%s: build produced no widget", cls->name);
    }
    if (!w->inner)
        w->inner = w->gtk;
    g_object_ref_sink(w->gtk);

    g_object_set_data(G_OBJECT(w->gtk), BTA_WIDGET_QUARK, w);
    /* Also tag the slot: a child's GTK parent is its owner's slot, not the
     * owner's own widget, and Delete() has to find its way back up. */
    if (w->slot && w->slot != w->gtk)
        g_object_set_data(G_OBJECT(w->slot), BTA_WIDGET_QUARK, w);

    attach_mouse(w);

    /*
     * A form loads its own .form, and so does a component -- which is what makes
     * a component a form that is not a window.  The base Component itself has no
     * file of its own; only a subclass named after one does.
     */
    bool component = !strcmp(cls->name, "Component");

    if (cls->is_form || component) {
        /* Its own children dispatch to it: it is their event target.  A host
         * that later adds it renames and rebinds it, which is what makes its
         * *own* events arrive as Thing1_Click on the host. */
        w->form = JS_DupValue(ctx, obj);

        char *cn = class_name_of(ctx, new_target);
        if (!cn) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }

        /* Gambas dispatches a form's own events as Form_Open, Form_Close, ...
         * whatever the class is called; the class name only locates the
         * .form file. */
        w->name = g_strdup("Form");

        /* `new Component()` on its own is an empty container, not an error: it
         * is the base, and there is no Component.form to look for. */
        if (component && !strcmp(cn, "Component")) {
            g_free(cn);
            return obj;
        }

        if (*cn) {
            int rc = bta_form_build(ctx, obj, cn);
            g_free(cn);
            if (rc < 0) {
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
        } else {
            g_free(cn);
        }
    }
    return obj;
}

/*
 * Widget.Types(): every class the runtime offers, in registration order.
 *
 * `Widget.New(type)` answers about a name one already has in mind; this is the
 * other question -- what is there at all -- which is the same pair
 * `Application.HasIcon` and `Application.Icons` are.  Anything that has to reason
 * about the whole widget set rather than one control needs it: the IDE's
 * extractor asks each class which of its properties hold prose, and could not
 * otherwise know which names to look for in a line of code.
 *
 * Registration order and not sorted: it is the order the table declares, which
 * runs from the root class outwards, and a caller that wants them alphabetical
 * can say so.
 */
static JSValue w_types(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    int       n;
    BtaClass *table = bta_class_table(&n);
    JSValue   out   = JS_NewArray(ctx);

    for (int i = 0; i < n; i++)
        JS_SetPropertyUint32(ctx, out, (uint32_t)i, JS_NewString(ctx, table[i].name));

    return out;
}

/*
 * Widget.Available(type): whether this machine can run one.
 *
 * The third of the questions a palette asks about a class it has only the name
 * of.  `Widget.Types()` says what classes there are and `Widget.New` makes one;
 * neither answers the one that matters before a control is offered, which is
 * whether the engine behind it is there.  `Terminal` without VTE is the case
 * the class table's `available` was added for: the class exists, a `.form`
 * naming one loads, every property answers -- and `Run` refuses, which is far
 * too late for a palette.  `Video` is the case that showed a build-time flag is
 * not always the question, since GStreamer can be linked in and the machine's
 * registry still lack the sink: a class may declare a `probe` instead, and
 * `bta_class_runnable` is what answers with whichever of the two it has.
 *
 * A name the table does not have is one of the project's own classes, and there
 * the question is only whether it resolves: a component is JavaScript, and
 * JavaScript this runtime can always run. A name that is nothing at all is
 * false rather than a throw -- what a caller does with the answer is skip the
 * button, and having to wrap that in a try is the wrong shape.
 */
static JSValue w_available(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    const char *type = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!type)
        return JS_ThrowTypeError(ctx, "Widget.Available(type) expects a type name");

    BtaClass *cls = bta_class_find(type);
    if (cls) {
        JS_FreeCString(ctx, type);
        return JS_NewBool(ctx, bta_class_runnable(cls));
    }

    JSValue klass = bta_lookup_global(ctx, type);
    JS_FreeCString(ctx, type);

    /* A lookup that threw is not a question anybody asked: swallow it, the way
     * the answer swallows a name that is simply not there. */
    if (JS_IsException(klass)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_FALSE;
    }

    bool is_class = JS_IsFunction(ctx, klass);
    JS_FreeValue(ctx, klass);
    return JS_NewBool(ctx, is_class);
}

static JSValue w_new_by_type(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *type = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!type)
        return JS_ThrowTypeError(ctx, "Widget.New(type) expects a type name");

    JSValue obj = bta_widget_new(ctx, type);
    JS_FreeCString(ctx, type);
    return obj;
}

JSValue bta_widget_new(JSContext *ctx, const char *type)
{
    BtaClass *cls = bta_class_find(type);

    /*
     * Not a class of the runtime's: it may be one of the project's, which is
     * how a component appears in a .form as an ordinary "type".  Anything that
     * constructs into a widget will do -- what it has to be is checked by the
     * caller, which knows whether it wanted a container or a control.
     */
    if (!cls) {
        JSValue klass = bta_lookup_global(ctx, type);
        if (JS_IsException(klass))
            return klass;
        if (!JS_IsFunction(ctx, klass)) {
            JS_FreeValue(ctx, klass);
            return JS_ThrowReferenceError(ctx, "unknown widget type '%s'", type);
        }

        JSValue obj = JS_CallConstructor(ctx, klass, 0, NULL);
        JS_FreeValue(ctx, klass);

        if (!JS_IsException(obj) && !bta_widget_of(obj)) {
            JS_FreeValue(ctx, obj);
            return JS_ThrowTypeError(ctx, "'%s' is not a widget", type);
        }
        return obj;
    }

    if (JS_IsUndefined(cls->ctor))
        return JS_ThrowInternalError(ctx, "widget class '%s' not initialised", type);
    return JS_CallConstructor(ctx, cls->ctor, 0, NULL);
}

void bta_widgets_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_widget_class_id);
    JS_NewClass(rt, bta_widget_class_id, &widget_class_def);

    int       n;
    BtaClass *table = bta_class_table(&n);

    for (int i = 0; i < n; i++) {
        BtaClass *cls = &table[i];

        JSValue proto;
        if (cls->parent) {
            BtaClass *parent = bta_class_find(cls->parent);
            g_assert(parent && !JS_IsUndefined(parent->proto));
            proto = JS_NewObjectProto(ctx, parent->proto);
        } else {
            proto = JS_NewObject(ctx);
        }
        if (cls->props)
            JS_SetPropertyFunctionList(ctx, proto, cls->props, cls->nprops);

        JSValue ctor = JS_NewCFunctionMagic(ctx, bta_ctor, cls->name, 0,
                                            JS_CFUNC_constructor_magic, i);
        JS_SetConstructor(ctx, ctor, proto);

        cls->proto = proto;
        cls->ctor  = ctor;

        /*
         * Widget.New(type): what the .form loader does to turn a "type" into a
         * widget -- the runtime's classes first, then the project's own, which
         * live in the global lexical scope and are invisible to globalThis.
         * Container.AddNode needs the same resolution, and a component is only
         * usable from a .form because both agree on it.
         */
        if (!cls->parent) {
            JS_SetPropertyStr(ctx, ctor, "New",
                              JS_NewCFunction(ctx, w_new_by_type, "New", 1));
            /* ...and what there is to make one of. */
            JS_SetPropertyStr(ctx, ctor, "Types",
                              JS_NewCFunction(ctx, w_types, "Types", 0));
            /* ...and which of those this build can actually run. */
            JS_SetPropertyStr(ctx, ctor, "Available",
                              JS_NewCFunction(ctx, w_available, "Available", 1));

            /* The runtime's own notes, reachable by the names they had when
             * they were own properties. */
            JS_SetPropertyFunctionList(ctx, proto, widget_notes,
                                       G_N_ELEMENTS(widget_notes));
        }

        JS_SetPropertyStr(ctx, global, cls->name, JS_DupValue(ctx, ctor));
    }
}

void bta_widgets_cleanup(JSContext *ctx)
{
    int       n;
    BtaClass *table = bta_class_table(&n);


    /* The table is static, so these references outlive the context unless we
     * drop them here; JS_FreeRuntime asserts on anything left alive. */
    for (int i = 0; i < n; i++) {
        JS_FreeValue(ctx, table[i].proto);
        JS_FreeValue(ctx, table[i].ctor);
        table[i].proto = JS_UNDEFINED;
        table[i].ctor  = JS_UNDEFINED;
    }
}
