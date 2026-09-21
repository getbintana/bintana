/*
 * The widget class table and the GTK4 side of each control.
 *
 * Adding a control means: a build function, a props array, and one row at the
 * bottom of bta_classes[] (parents must appear before their children).
 */
#include "bta.h"

#include <math.h>
#include <string.h>

/* Every control lands in a GtkFixed, so RAD coordinates are literal. */
#define FIXED_SLOT(w) ((w)->slot)

/* ------------------------------------------------------------------ Form */

/*
 * A form is *asked* whether it is closing, and answers by returning.
 *
 * The convention is `KeyPress`'s, for the same reason: **returning true from
 * `Form_Close` keeps the window open**, and returning nothing at all -- which is
 * what every handler written before this did -- lets it go.  So the default is
 * the old behaviour and the veto is a thing one says out loud.
 *
 * It exists because the alternative is losing work.  A window's X is the one
 * path an application cannot govern, so a form with unsaved changes had to
 * choose between saving behind the user's back and dropping what they typed --
 * `PoForm` picked the first for exactly this reason, and both are surprises.
 * With a veto, "there are three unsaved files, really quit?" is an ordinary
 * dialog: veto now, and quit from the answer.
 *
 * The handler runs while GTK is delivering `close-request`, so what it must not
 * do is close the window again from inside itself; `Application.Quit` and a
 * later `Close()` from the dialog's answer are both fine, being a return to the
 * main loop away.
 */
static gboolean on_close_request(GtkWindow *win, gpointer user_data)
{
    BtaWidget *w   = user_data;
    JSContext *ctx = w->ctx;

    JSValue  r    = bta_emit_answer(w, "Close", 0, NULL, NULL);
    gboolean stay = JS_ToBool(ctx, r) > 0;
    JS_FreeValue(ctx, r);

    return stay;   /* TRUE = keep it open, FALSE = let the window close */
}

/* Below, with the window state: GTK4 has no size-allocate signal, so a resize is
 * heard from the window's own GdkSurface -- which exists from `realize` on. */
static void on_form_realized(GtkWidget *win, gpointer user_data);

/*
 * The desktop changed the theme under a running window.
 *
 * Raised on the form and on nothing else: what a change of theme costs is the
 * icons and colours an application chose for itself, and that is a decision a
 * *form* made -- one handler that walks its own controls, rather than the same
 * event delivered to forty of them. `Form_Resize` is the same shape for the
 * same reason.
 *
 * **The colours are already the new ones inside the handler** (measured: the
 * ink goes 0.20 to 0.93 between the two sides of this call), so `Dark` read
 * from here is the answer to the change that caused it, and no idle hop is
 * needed to wait for GTK to catch up.
 *
 * Two properties, because a desktop can move either one, so **one change may
 * raise it twice**. That is deliberate rather than debounced: the event carries
 * nothing, a handler re-reads state and restyles, and doing that twice is the
 * same picture. A handler that is not idempotent is a handler that was already
 * wrong.
 */
static void on_theme_change(GObject *settings, GParamSpec *spec, gpointer data)
{
    bta_emit(data, "ThemeChange", 0, NULL);
}

static void build_form(BtaWidget *w)
{
    w->gtk = gtk_window_new();

    g_signal_connect(w->gtk, "realize", G_CALLBACK(on_form_realized), w);

    /*
     * The settings object belongs to the display and outlives every window on
     * it, so this is exactly the case `bta_widget_watch` exists for: a handler
     * left on it after the form is gone would fire on freed memory the next
     * time somebody switched themes.
     */
    GtkSettings *settings = gtk_settings_get_default();
    if (settings) {
        g_signal_connect(settings, "notify::gtk-application-prefer-dark-theme",
                         G_CALLBACK(on_theme_change), w);
        g_signal_connect(settings, "notify::gtk-theme-name",
                         G_CALLBACK(on_theme_change), w);
        bta_widget_watch(w, settings);
    }

    /*
     * The window's child is the surface, and nothing in between.
     *
     * It used to be a column with the surface inside it, for two reasons that
     * are both gone: `Arrangement` needed something that survived the slot being
     * replaced, and it swaps a layout manager now; and a menu bar has to go above
     * the surface, which is true of the three forms in this tree that have one
     * and of thirty-six that do not. `bta_menus_build` puts the column in when
     * there is a bar to put in it, which is the only moment it is a widget doing
     * anything.
     */
    w->slot = bta_fixed_new();
    gtk_widget_set_hexpand(w->slot, TRUE);
    gtk_widget_set_vexpand(w->slot, TRUE);
    gtk_window_set_child(GTK_WINDOW(w->gtk), w->slot);

    w->w = 400;
    w->h = 300;
    gtk_window_set_default_size(GTK_WINDOW(w->gtk), w->w, w->h);

    g_signal_connect(w->gtk, "close-request", G_CALLBACK(on_close_request), w);
}

/*
 * The window's icon: what the desktop shows for it in a task list, a switcher
 * or a dock.  A name from the icon search path, like Button.Icon -- and since
 * <project>/icons is in that path, an application's own icon is a file it
 * ships rather than anything the runtime has to be told about.
 *
 * Stored as it was given and only *applied* when the desktop really has it, the
 * same as a Button's: whoever picked the name is the only one who can pick a
 * fallback, and a .form must round-trip what it declared even on a machine
 * whose theme is missing it.
 */
#define FORM_ICON_KEY "bta-form-icon"

static JSValue form_get_icon(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = g_object_get_data(G_OBJECT(w->gtk), FORM_ICON_KEY);
    return JS_NewString(ctx, s ? s : "");
}

static JSValue form_set_icon(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    g_object_set_data_full(G_OBJECT(w->gtk), FORM_ICON_KEY, g_strdup(s), g_free);
    gtk_window_set_icon_name(GTK_WINDOW(w->gtk),
                             *s && bta_icon_available(w->gtk, s) ? s : NULL);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue form_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    const char *t = gtk_window_get_title(GTK_WINDOW(w->gtk));
    return JS_NewString(ctx, t ? t : "");
}

static JSValue form_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    gtk_window_set_title(GTK_WINDOW(w->gtk), s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue form_get_modal(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_window_get_modal(GTK_WINDOW(w->gtk)));
}

static JSValue form_set_modal(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_window_set_modal(GTK_WINDOW(w->gtk), b);
    return JS_UNDEFINED;
}

/*
 * Clears `Default` or `Cancel` everywhere under `w` except on `keep`.
 *
 * Two buttons declaring the same one is a form in the wrong order rather than an
 * error -- so the first in tree order wins and the losers are *cleared* rather
 * than left standing. Otherwise the property grid would show two defaults and
 * the serialiser would write two, while only one of them ever did anything.
 */
static void form_keep_one(BtaWidget *w, bool cancel, BtaWidget *keep)
{
    if (!w || !w->slot)
        return;

    for (GtkWidget *c = gtk_widget_get_first_child(w->slot);
         c; c = gtk_widget_get_next_sibling(c)) {

        BtaWidget *cw = bta_slot_child(c);
        if (!cw)
            continue;
        if (cw != keep) {
            if (cancel) cw->is_cancel  = false;
            else        cw->is_default = false;
        }
        form_keep_one(cw, cancel, keep);
    }
}

/*
 * What Enter and Escape do, settled once the form is a real window.
 *
 * **This is the only place a button reaches `gtk_window_set_default_widget`,
 * and that is the point.** A window has one default widget, so the obvious
 * design is a setter that calls it -- and the designer builds the controls of
 * the form it is drawing inside the IDE's own window, where `bta_container_attach`
 * binds every one of them to `MainForm`. A setter cannot tell that drawing from
 * an application: both are buttons whose form is a form whose widget is the root
 * window. It would hand the IDE's Enter key to a button on a canvas.
 *
 * Resolving at Show is what closes that: a drawing is never shown as a form.
 * The flags are ordinary widget state until then, which is also what makes them
 * serialisable, designable and true before the window exists.
 *
 * Escape does its own walk when it is pressed (`bta_widget_flagged`), so the
 * cancel button is settled here only to keep the declaration honest.
 */
static void form_resolve_buttons(BtaWidget *w)
{
    if (!w || !w->is_form || !GTK_IS_WINDOW(w->gtk))
        return;

    BtaWidget *def = bta_widget_flagged(w, false);
    form_keep_one(w, false, def);
    form_keep_one(w, true, bta_widget_flagged(w, true));

    gtk_window_set_default_widget(GTK_WINDOW(w->gtk), def ? def->gtk : NULL);
}

static JSValue form_show(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    BtaApp    *app    = bta_current_app();
    GtkWindow *window = GTK_WINDOW(w->gtk);

    /* Read the active window before adding ourselves, or a modal dialog would
     * end up transient for itself. */
    GtkWindow *parent = app && app->gapp
                            ? gtk_application_get_active_window(app->gapp) : NULL;

    if (app && app->gapp && !gtk_window_get_application(window))
        gtk_application_add_window(app->gapp, window);

    if (gtk_window_get_modal(window) && parent && parent != window &&
        !gtk_window_get_transient_for(window))
        gtk_window_set_transient_for(window, parent);

    if (!w->opened) {
        w->opened = true;
        bta_emit(w, "Open", 0, NULL);
    }

    /* After the Open handler, not before: a form that builds its own buttons
     * there is as ordinary as one that declared them in its .form. */
    form_resolve_buttons(w);

    gtk_window_present(GTK_WINDOW(w->gtk));
    return JS_UNDEFINED;
}

static JSValue form_close(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    gtk_window_close(GTK_WINDOW(w->gtk));
    return JS_UNDEFINED;
}

static JSValue form_center(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    /* Wayland leaves window placement to the compositor; this is a no-op there
     * on purpose rather than a lie. */
    return JS_UNDEFINED;
}

/*
 * DefaultButton / CancelButton -- the form's answer to *who answers Enter, and
 * who answers Escape*.
 *
 * WinForms' spelling, kept as a **read**: the declaration is on the button and
 * this is the resolved result. Read-only, so the serialiser and the property
 * grid both skip it on their own -- a form writing a control's name into its
 * `.form` would be a second place the same answer lives, and the two would
 * eventually disagree.
 *
 * `DefaultButton` asks the *window*, not the flag, which is the point of it: it
 * is the only thing that can say `form_show` really reached GTK. Nothing else
 * about Enter is observable from JS -- a key event is not something the suite
 * can make -- so without this the whole feature would be by-hand only.
 */
static JSValue form_get_default_button(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkWidget *def = GTK_IS_WINDOW(w->gtk)
                         ? gtk_window_get_default_widget(GTK_WINDOW(w->gtk))
                         : NULL;
    BtaWidget *cw = def ? bta_slot_child(def) : NULL;

    /* null and not undefined: "there is none" is an answer, and a form with no
     * default button is the ordinary case rather than a missing property. */
    return cw ? JS_DupValue(ctx, cw->self) : JS_NULL;
}

static JSValue form_get_cancel_button(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* The same walk Escape does, so what this reports and what Escape presses
     * cannot come apart. */
    BtaWidget *cw = bta_widget_flagged(w, true);
    return cw ? JS_DupValue(ctx, cw->self) : JS_NULL;
}

/* ------------------------------------------------------- window state */

/*
 * `Resizable` and `Maximized`, and the difference between them is the whole of
 * why there are two accessors here and not one pattern.
 *
 * **`Resizable` is a request GTK remembers**, like `Modal`: set it and it reads
 * back, window or no window. It is also the one this pair exists for -- a dialog
 * that asks for a name has nothing to gain from being dragged bigger, and
 * nothing at all from being maximised, and until now every one of them could be.
 *
 * **`Maximized` is a state, and a state is not true until there is a window to be
 * true of.** Declaring it in a `.form` works -- the request is honoured when the
 * form is shown -- but reading it back the instant it is set answers what GTK
 * knows, which before mapping is `false`. That is the honest answer rather than a
 * second stored truth, and it is what `Focused` already does: report reality, not
 * intent.
 *
 * There is no `Minimized` to read. GTK4 can ask for it and cannot answer about
 * it -- a minimised window is the compositor's business on Wayland -- so what is
 * here is `Minimize()`, a verb, which is what a thing you can request and not
 * observe should be.
 */
enum { WIN_RESIZABLE, WIN_MAXIMIZED, WIN_FULLSCREEN, WIN_HIDEONCLOSE };

static JSValue form_get_state(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkWindow *win = GTK_WINDOW(w->gtk);
    switch (magic) {
    case WIN_RESIZABLE:   return JS_NewBool(ctx, gtk_window_get_resizable(win));
    case WIN_FULLSCREEN:  return JS_NewBool(ctx, gtk_window_is_fullscreen(win));
    case WIN_HIDEONCLOSE: return JS_NewBool(ctx, gtk_window_get_hide_on_close(win));
    default:             return JS_NewBool(ctx, gtk_window_is_maximized(win));
    }
}

static JSValue form_set_state(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    GtkWindow *win = GTK_WINDOW(w->gtk);
    switch (magic) {
    case WIN_RESIZABLE:
        gtk_window_set_resizable(win, b);
        break;
    case WIN_FULLSCREEN:
        if (b) gtk_window_fullscreen(win); else gtk_window_unfullscreen(win);
        break;
    case WIN_HIDEONCLOSE:
        gtk_window_set_hide_on_close(win, b);
        break;
    default:
        if (b) gtk_window_maximize(win);   else gtk_window_unmaximize(win);
        break;
    }
    return JS_UNDEFINED;
}

static JSValue form_minimize(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    gtk_window_minimize(GTK_WINDOW(w->gtk));
    return JS_UNDEFINED;
}

/*
 * `Resize(width, height)` -- the window changed size.
 *
 * GTK4 removed the `size-allocate` *signal*, so what reports a resize is the
 * window's `GdkSurface::layout` -- see `on_surface_size` for why it is that and
 * not the `default-width`/`default-height` pair it used to be. That pair was
 * "verified rather than assumed" here, and the verification was wrong: the note
 * this replaces claimed `gtk_widget_get_width` already answered the new size
 * when the notification arrived, and measuring it properly -- a real window
 * dragged from 400x300 to 640x500 -- showed it answering the old one.
 *
 * **One resize is one event.** The last size emitted is kept and compared,
 * which swallows the layouts that report no change -- a form that relaid itself
 * twice per drag step would be this event's whole cost.
 */
#define LAST_SIZE_KEY "bta-last-size"

/*
 * A window's size, told by the thing that has it.
 *
 * **`notify::default-width` looked like the way to hear about a resize and was
 * not.** It fires when GTK updates the size the window would *remember*, which
 * happens before the new size has been laid out -- so the handler read
 * `gtk_widget_get_width()` and got the size the window had *before* the change,
 * every time, and the size it was being told about never arrived at all.
 * Measured on a real display: a window dragged from 400x300 to 640x500 raised
 * one `Resize` saying `400x300`, with `Bounds()` already answering 640x500. And
 * on the way up the notification comes while there is no allocation at all, so
 * the 0x0 guard dropped it and **no window was ever told the size it opened
 * at** -- which is what this event's own documentation promised. A secondary
 * window was hit hardest, since a form that is never resized by hand got no
 * `Resize` in its whole life.
 *
 * `GdkSurface::layout` is the one that means it: GTK4 has no `size-allocate`,
 * and this is the signal `GtkWindow` itself lays the window out on. Hooking it
 * from our own `realize` handler is what puts ours *after* GTK's -- the class
 * closure for `realize` runs before any user handler, so `gtk_window_realize`
 * has already connected by the time this does, and same-signal handlers run in
 * connection order. The allocation is therefore done when the event is raised,
 * which is what makes the pair it carries agree with `Bounds()`. Measured, not
 * assumed: hearing the surface's `notify::width` instead gives the right numbers
 * a frame *before* the layout that carries them out, and every `Bounds()` read
 * inside such a handler answers about the previous size.
 *
 * `layout` is also emitted for a relayout that is not a resize, and the pair is
 * still packed into one value with repeats dropped -- a form relaid out twice
 * per drag step is what that would cost.
 */
static void on_surface_size(GdkSurface *surface, int cw, int ch, gpointer user_data)
{
    BtaWidget *w = user_data;

    /* 0x0 is not a size anybody asked to hear about. */
    if (cw <= 0 || ch <= 0)
        return;

    gpointer was = g_object_get_data(G_OBJECT(w->gtk), LAST_SIZE_KEY);
    guint    now = ((guint)cw << 16) | (guint)ch;
    if (was && GPOINTER_TO_UINT(was) == now)
        return;
    g_object_set_data(G_OBJECT(w->gtk), LAST_SIZE_KEY, GUINT_TO_POINTER(now));

    JSValue argv[2] = { JS_NewInt32(w->ctx, cw), JS_NewInt32(w->ctx, ch) };
    JSValue r = bta_emit_answer(w, "Resize", 2, argv, NULL);

    JS_FreeValue(w->ctx, r);
    JS_FreeValue(w->ctx, argv[0]);
    JS_FreeValue(w->ctx, argv[1]);
}

/*
 * The surface is made at realize and destroyed at unrealize, so this is the one
 * place it can be hooked -- and it can happen twice, which would connect a
 * second handler and report every resize twice.  Asking GTK whether this widget
 * is already listening to that surface is the check; a flag of our own would be
 * a second bookkeeping to keep in step with GTK's own lifetime.
 *
 * `bta_widget_watch` is what unhooks it: the surface is not the widget, so the
 * finaliser's sweep over gtk/inner/slot cannot find it on its own.
 */
static void on_form_realized(GtkWidget *win, gpointer user_data)
{
    BtaWidget  *w       = user_data;
    GdkSurface *surface = gtk_native_get_surface(GTK_NATIVE(win));

    if (!surface ||
        g_signal_handler_find(surface, G_SIGNAL_MATCH_DATA,
                              0, 0, NULL, NULL, w) != 0)
        return;

    /*
     * A window that is closed and shown again is unrealized and realized again,
     * and GTK gives it a **new** surface each time -- so the one before it would
     * sit in the watch list until the form itself was collected, one dead
     * surface per opening. A window has exactly one, so the previous one goes.
     */
    for (guint i = 0; w->watched && i < w->watched->len; i++) {
        if (GDK_IS_SURFACE(w->watched->pdata[i])) {
            g_signal_handlers_disconnect_by_data(w->watched->pdata[i], w);
            g_ptr_array_remove_index_fast(w->watched, i);
            break;
        }
    }

    g_signal_connect(surface, "layout", G_CALLBACK(on_surface_size), w);
    bta_widget_watch(w, surface);
}

static const JSCFunctionListEntry form_props[] = {
    JS_CGETSET_DEF("Text",  form_get_text,  form_set_text),
    JS_CGETSET_DEF("Icon",  form_get_icon,  form_set_icon),
    JS_CGETSET_DEF("Modal", form_get_modal, form_set_modal),
    JS_CGETSET_DEF("DefaultButton", form_get_default_button, NULL),
    JS_CGETSET_DEF("CancelButton",  form_get_cancel_button,  NULL),
    JS_CFUNC_DEF("Show",   0, form_show),
    JS_CFUNC_DEF("Close",  0, form_close),
    JS_CFUNC_DEF("Center", 0, form_center),
    JS_CGETSET_MAGIC_DEF("Resizable",  form_get_state, form_set_state, WIN_RESIZABLE),
    JS_CGETSET_MAGIC_DEF("Maximized",  form_get_state, form_set_state, WIN_MAXIMIZED),
    JS_CGETSET_MAGIC_DEF("FullScreen", form_get_state, form_set_state, WIN_FULLSCREEN),
    /*
     * Closed, or put away?
     *
     * A window that is *the* something -- the find bar's own window, a palette,
     * a log -- is opened and closed over and over, and each time it comes back
     * it should be where it was, with what was typed in it.
     *
     * **And without this it does not come back at all.** GTK takes the window
     * apart on close, and this runtime builds a form's window once, when the
     * form is constructed: `Show` on a closed one is not an error and not a
     * window either -- measured, it stays 0x0 forever. So a form meant to be
     * reopened either says this, or is constructed again every time (which is
     * what the IDE's dialogs do). Hidden, `Show` brings it back with its size
     * and everything in it.
     *
     * `Form_Close` still runs and can still veto: what is being chosen here is
     * what happens once the close is allowed, not whether it is.
     */
    JS_CGETSET_MAGIC_DEF("HideOnClose", form_get_state, form_set_state, WIN_HIDEONCLOSE),
    JS_CFUNC_DEF("Minimize", 0, form_minimize),
};

/* ------------------------------------------------------------- Container */

static JSValue container_add(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaWidget *p = bta_this(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    BtaWidget *c = argc > 0 ? bta_widget_of(argv[0]) : NULL;
    if (!c)
        return JS_ThrowTypeError(ctx, "Add() expects a widget");

    /* Before GTK holds it: adopt binds the form and runs after the attach, so
     * this is the only point a refused pair leaves nothing behind. */
    if (bta_widget_adopt_refused(ctx, this_val, p, c))
        return JS_EXCEPTION;

    if (!bta_container_attach(ctx, p, c))
        return JS_EXCEPTION;
    bta_widget_relayout(c);

    /* Hold a JS reference so the wrapper (and its event bindings) outlive the
     * caller's expression, and bind the child to the form. */
    bta_widget_adopt(ctx, this_val, p, argv[0], c);
    return JS_UNDEFINED;
}

/*
 * Arrangement picks how a container lays its children out: "Fixed" keeps the
 * RAD x/y model, "Horizontal"/"Vertical" swap in a box so the contents follow
 * the window when it is resized.  Containers whose slot *is* their own widget
 * (HBox, HSplit, ...) already are their arrangement and reject the change.
 */
/*
 * Anchored: whether this container's children follow it when it is resized.
 *
 * On by default, which is what a window wants. Off is for a surface that is a
 * drawing board and not a running form -- the designer's canvas, above all,
 * which is stretched to whatever room the IDE has and must still show every
 * control at the size and place the .form says. Anchoring it would show the
 * form as if it had been designed at the canvas's size, which is nothing
 * anybody drew.
 *
 * Meaningless on a container that is not Fixed, the way Expand is meaningless
 * on one that is; it is ignored there rather than refused.
 */
static JSValue cont_get_anchored(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!w->slot)
        return JS_ThrowTypeError(ctx, "not a container");
    return JS_NewBool(ctx, w->anchored);
}

static JSValue cont_set_anchored(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!w->slot)
        return JS_ThrowTypeError(ctx, "not a container");

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    w->anchored = b;
    bta_fixed_set_anchored(w->slot, b);
    return JS_UNDEFINED;
}

/*
 * Spacing and Homogeneous belong to the box a container *is arranged as*, not
 * to a class of its own -- which is why they live here now.  On a container
 * that is not arranged as a box they read 0 and false and assigning is ignored,
 * the same bargain Expand makes inside a Fixed: meaningless, not an error.
 */
static JSValue cont_get_spacing(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (bta_surface_is_box(w->slot))
        return JS_NewInt32(ctx, gtk_box_layout_get_spacing(
            GTK_BOX_LAYOUT(gtk_widget_get_layout_manager(w->slot))));
    if (w->slot && GTK_IS_GRID(w->slot))
        return JS_NewInt32(ctx, (int)gtk_grid_get_column_spacing(GTK_GRID(w->slot)));
    /* A flow spaces in two directions and is asked for one number, so it is
     * kept square: two properties for one gap nobody wants apart. */
    if (w->slot && GTK_IS_FLOW_BOX(w->slot))
        return JS_NewInt32(ctx,
            (int)gtk_flow_box_get_column_spacing(GTK_FLOW_BOX(w->slot)));
    return JS_NewInt32(ctx, 0);
}

static JSValue cont_set_spacing(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Spacing", &n))
        return JS_EXCEPTION;
    /* Refused, like RowSpacing/ColumnSpacing are: a negative gap would reach
     * GTK as a guint of four billion and more. */
    if (n < 0)
        return JS_ThrowRangeError(ctx, "Spacing cannot be negative");
    if (bta_surface_is_box(w->slot))
        gtk_box_layout_set_spacing(
            GTK_BOX_LAYOUT(gtk_widget_get_layout_manager(w->slot)), (guint)n);
    else if (w->slot && GTK_IS_GRID(w->slot)) {
        gtk_grid_set_row_spacing(GTK_GRID(w->slot), (guint)n);
        gtk_grid_set_column_spacing(GTK_GRID(w->slot), (guint)n);
    } else if (w->slot && GTK_IS_FLOW_BOX(w->slot)) {
        gtk_flow_box_set_column_spacing(GTK_FLOW_BOX(w->slot), (guint)n);
        gtk_flow_box_set_row_spacing(GTK_FLOW_BOX(w->slot), (guint)n);
    }
    return JS_UNDEFINED;
}

static JSValue cont_get_homogeneous(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (w->slot && GTK_IS_FLOW_BOX(w->slot))
        return JS_NewBool(ctx, gtk_flow_box_get_homogeneous(GTK_FLOW_BOX(w->slot)));
    return JS_NewBool(ctx, bta_surface_is_box(w->slot) &&
        gtk_box_layout_get_homogeneous(
            GTK_BOX_LAYOUT(gtk_widget_get_layout_manager(w->slot))));
}

static JSValue cont_set_homogeneous(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    if (bta_surface_is_box(w->slot))
        gtk_box_layout_set_homogeneous(
            GTK_BOX_LAYOUT(gtk_widget_get_layout_manager(w->slot)), b);
    else if (w->slot && GTK_IS_GRID(w->slot)) {
        /* Both axes: a homogeneous grid is a chessboard, and one axis of it is
         * a thing nobody has ever asked for by that name. */
        gtk_grid_set_row_homogeneous(GTK_GRID(w->slot), b);
        gtk_grid_set_column_homogeneous(GTK_GRID(w->slot), b);
    } else if (w->slot && GTK_IS_FLOW_BOX(w->slot))
        gtk_flow_box_set_homogeneous(GTK_FLOW_BOX(w->slot), b);
    return JS_UNDEFINED;
}

static JSValue cont_get_arrangement(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!w->slot)
        return JS_ThrowTypeError(ctx, "not a container");

    /*
     * A container that is not one of our surfaces has no arrangement to report:
     * what it does with its children is its nature -- a Split is two halves, a
     * Grid is a table, a RowList is rows. Answering "Horizontal" for one of those
     * would put a second, unsettable spelling of the same fact in the .form, and
     * loading it back would throw.
     *
     * **Asked of the surface and not of the slot's type**, which is the change
     * the layout manager brought: a `Panel` arranged `Horizontal` is the same
     * `BtaFixed` widget it was when it was arranged `Fixed`, so the type cannot
     * answer this and the manager has to.
     */
    if (!BTA_IS_FIXED(w->slot))
        return JS_NewString(ctx, "");
    if (bta_surface_is_fixed(w->slot))
        return JS_NewString(ctx, "Fixed");

    return JS_NewString(ctx,
        gtk_orientable_get_orientation(
            GTK_ORIENTABLE(gtk_widget_get_layout_manager(w->slot)))
            == GTK_ORIENTATION_HORIZONTAL ? "Horizontal" : "Vertical");
}

/*
 * Placement: how this container decides where a child goes.
 *
 * `Arrangement` is what a person may *choose* and reads `""` on a container
 * whose nature settles it; this is the answer for every container, which is a
 * different question and the one an editor has to ask. Six words, because
 * there are six kinds of answer a gesture has to be written against:
 *
 *   Coordinates  a drawing surface: X/Y mean something, dragging moves
 *   Order        a box, a grid, a flow, a list of rows: the place in the line
 *   Layers       a stack: the order is the z-order, index 0 is what fills
 *   Pages        one at a time behind a strip: there is no "where the pointer is"
 *   Halves       a split: two places, and the index names which
 *   Single       one child and one place: an `AspectFrame`, which gives it the
 *                whole rectangle its proportion works out
 *
 * It exists because the designer was deciding this by class name -- a table of
 * six names in JavaScript, which is how `Overlay`, `Flow` and `RowList` came to
 * be on its palette while every gesture treated them as boxes and raised *this
 * container has no order to give*. The runtime is the only thing that knows what
 * its slot is; asking it is one sentence instead of a second list to keep in
 * step. The same trade `Widget.Available` made.
 *
 * Read-only, so the serialiser passes over it: it is not a property of the file,
 * it is a fact about the class and its arrangement.
 */
static JSValue cont_get_placement(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!w->slot)
        return JS_ThrowTypeError(ctx, "not a container");

    if (BTA_IS_FIXED(w->slot) && bta_surface_is_fixed(w->slot))
        return JS_NewString(ctx, "Coordinates");
    if (GTK_IS_OVERLAY(w->slot))
        return JS_NewString(ctx, "Layers");
    if (GTK_IS_NOTEBOOK(w->slot) || GTK_IS_STACK(w->slot))
        return JS_NewString(ctx, "Pages");
    if (GTK_IS_PANED(w->slot))
        return JS_NewString(ctx, "Halves");
    if (bta_container_order(w->slot))
        return JS_NewString(ctx, "Order");

    /* One child, and one place to put it: there is no coordinate to give it, no
     * order to put it in and nothing to choose -- an `AspectFrame` hands its
     * child the whole rectangle the proportion works out. A gesture there is
     * *land*, which is why it needs a word of its own: told `Coordinates` an
     * editor offers X/Y that do nothing, told `Order` it asks for an order the
     * container has not got. */
    if (GTK_IS_ASPECT_FRAME(w->slot))
        return JS_NewString(ctx, "Single");

    /* Nothing answers this today -- every container the runtime has is one of
     * the six above. It stays as the answer for a slot nobody has classified,
     * because a guess would be worse than a blank. */
    return JS_NewString(ctx, "");
}

static JSValue cont_set_arrangement(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!w->slot)
        return JS_ThrowTypeError(ctx, "not a container");

    /* Only a surface of ours can be re-arranged. Every other container's
     * arrangement is its nature: a Split is two halves, a Grid is a table, a
     * RowList is rows, and a Switcher's pages are a stack the strip points at. */
    if (!BTA_IS_FIXED(w->slot))
        return JS_ThrowTypeError(ctx,
            "%s arranges its children by its own nature",
            w->name ? w->name : "this container");

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    bool           fixed = !g_ascii_strcasecmp(s, "Fixed");
    bool           row   = !g_ascii_strcasecmp(s, "Horizontal");
    bool           col   = !g_ascii_strcasecmp(s, "Vertical");

    if (!fixed && !row && !col) {
        JSValue e = JS_ThrowRangeError(ctx,
            "Arrangement must be Fixed, Horizontal or Vertical, not '%s'", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    /*
     * **The children do not move.** They are children of the same widget, and
     * what changes is who lays them out -- so there is nothing to unparent, no
     * order to rebuild, no reference to hold across the swap, and no holder to
     * put a new slot into.
     *
     * This is what the two-box `Panel` bought at the cost of a CSS bug, and it
     * used to be thirty-one lines of it here: every child taken off, the old slot
     * removed from whichever of four kinds of holder it sat in, the new one put
     * back, and every child re-parented in order. Their `x`/`y` were never touched
     * then either, which is why `Fixed` -> `Horizontal` -> `Fixed` put every
     * control back where it was; now nothing is touched at all.
     */
    GtkLayoutManager *had = gtk_widget_get_layout_manager(w->slot);

    if (fixed) {
        if (!bta_surface_is_fixed(w->slot))
            gtk_widget_set_layout_manager(w->slot, bta_fixed_layout_new());
    } else if (GTK_IS_BOX_LAYOUT(had)) {
        /*
         * Already a box: turn it, and keep it. `Spacing` and `Homogeneous`
         * belong to the box a container is arranged as, and building a fresh one
         * to go from a row to a column would silently drop both -- which the
         * version that replaced the whole slot did.
         */
        gtk_orientable_set_orientation(GTK_ORIENTABLE(had),
            row ? GTK_ORIENTATION_HORIZONTAL : GTK_ORIENTATION_VERTICAL);
    } else {
        gtk_widget_set_layout_manager(w->slot,
            gtk_box_layout_new(row ? GTK_ORIENTATION_HORIZONTAL
                                   : GTK_ORIENTATION_VERTICAL));
    }

    /*
     * The classes GTK's own boxes carry, because a theme reads them: Adwaita's
     * `linked` is `.linked:not(.vertical) > button`, so a vertical strip has to
     * say so and a horizontal one has to not. A `GtkBox` adds these from its
     * orientation; a widget wearing a box layout has to be told.
     */
    gtk_widget_remove_css_class(w->slot, "horizontal");
    gtk_widget_remove_css_class(w->slot, "vertical");
    if (row) gtk_widget_add_css_class(w->slot, "horizontal");
    if (col) gtk_widget_add_css_class(w->slot, "vertical");

    /* What kind of container a child is in is exactly what HAlign/VAlign are
     * carried out by, and it has just changed: a control that was centred in a
     * row must not stay GTK-centred inside a rectangle a surface works out for
     * itself. */
    for (GtkWidget *c = gtk_widget_get_first_child(w->slot); c;
         c = gtk_widget_get_next_sibling(c)) {
        BtaWidget *cw = g_object_get_data(G_OBJECT(c), BTA_WIDGET_QUARK);
        if (cw)
            bta_widget_relayout(cw);
    }

    /* Anchoring is the container's answer and the manager is where it lives, so
     * a new one has to be told -- including coming back from a box, which had
     * nowhere to keep it. */
    bta_fixed_set_anchored(w->slot, w->anchored);
    return JS_UNDEFINED;
}

/*
 * The children actually in this container, in layout order.  Read from GTK
 * rather than from a JS-side list, so it stays true no matter how a child got
 * there -- .form loading, Add(), or anything that reparents later.
 */
static JSValue cont_get_children(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *p = bta_this(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    JSValue  arr = JS_NewArray(ctx);
    uint32_t i   = 0;

    if (!p->slot)
        return arr;

    /*
     * A notebook's GTK children are its header and its stack, not its pages, so
     * walking them would answer nothing at all.  The pages are what a page is a
     * child of the notebook means.
     */
    if (GTK_IS_NOTEBOOK(p->slot)) {
        GtkNotebook *nb = GTK_NOTEBOOK(p->slot);
        int          n  = gtk_notebook_get_n_pages(nb);

        for (int k = 0; k < n; k++) {
            BtaWidget *cw = bta_slot_child(gtk_notebook_get_nth_page(nb, k));
            if (cw)
                JS_SetPropertyUint32(ctx, arr, i++, JS_DupValue(ctx, cw->self));
        }
        return arr;
    }

    for (GtkWidget *c = gtk_widget_get_first_child(p->slot);
         c; c = gtk_widget_get_next_sibling(c)) {

        BtaWidget *cw = bta_slot_child(c);
        if (cw)
            JS_SetPropertyUint32(ctx, arr, i++, JS_DupValue(ctx, cw->self));
    }
    return arr;
}

JSValue bta_container_clear(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *p = bta_this(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (!p->slot)
        return JS_ThrowTypeError(ctx, "not a container");

    /*
     * A notebook first: its children are pages, kept in a stack of GTK's own,
     * and what the generic walk below would find is the tab bar -- unparenting
     * that leaves a notebook that can no longer hold a page.
     */
    if (GTK_IS_NOTEBOOK(p->slot)) {
        GtkWidget *page;
        while ((page = gtk_notebook_get_nth_page(GTK_NOTEBOOK(p->slot), 0))) {
            BtaWidget *pw = bta_slot_child(page);
            if (pw) {
                if (!bta_container_detach(ctx, pw))
                    return JS_EXCEPTION;
            } else {
                gtk_notebook_remove_page(GTK_NOTEBOOK(p->slot), 0);
            }
        }
        return JS_UNDEFINED;
    }

    /*
     * Two passes, and both halves matter.
     *
     * **Collected first**, because detaching moves the sibling list underneath a
     * walk: `gtk_widget_get_first_child` in a loop only works while every child
     * is going, and the moment one stays it hands back the same widget forever.
     *
     * **And only what is ours**, because a container's internal children sit
     * among its contents -- a `GtkPaned`'s drag handle, a scroller's bars -- and
     * they are not what `Clear()` was asked about. The old walk had a
     * `gtk_widget_unparent(c)` fallback for "not ours", which is how clearing a
     * `Split` came to unparent the handle and then read a widget that was no
     * longer there: three
     * `Gtk-CRITICAL gtk_widget_unparent: assertion 'GTK_IS_WIDGET (widget)'
     * failed` per call for a paned, one for an overlay, and success reported
     * either way, which is why it sat unnoticed. A container empties of its
     * children and keeps its own machinery.
     *
     * A ref each, so a pointer stays a pointer across the detach that frees it;
     * the wrapper holds one of its own (`g_object_ref_sink` at construction), so
     * this only has to outlive the loop.
     */
    GPtrArray *ours = g_ptr_array_new_with_free_func(g_object_unref);

    for (GtkWidget *c = gtk_widget_get_first_child(p->slot); c;
         c = gtk_widget_get_next_sibling(c)) {
        /* A ListBox's rows are text and have no wrapper, and they *are* its
         * contents -- the one kind of child that is ours without being one of
         * ours. */
        if (bta_slot_child(c) || GTK_IS_LIST_BOX(p->slot))
            g_ptr_array_add(ours, g_object_ref(c));
    }

    JSValue ret = JS_UNDEFINED;

    for (guint i = 0; i < ours->len; i++) {
        GtkWidget *c  = ours->pdata[i];
        BtaWidget *cw = bta_slot_child(c);

        if (cw) {
            if (!bta_container_detach(ctx, cw)) {
                ret = JS_EXCEPTION;
                break;
            }
        } else if (gtk_widget_get_parent(c) == p->slot) {
            gtk_list_box_remove(GTK_LIST_BOX(p->slot), c);   /* a text row */
        }
    }

    g_ptr_array_free(ours, TRUE);
    return ret;
}

static JSValue container_clear(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    return bta_container_clear(ctx, this_val);
}

/*
 * The deepest Bintana widget under a point, or null for empty space.
 *
 * The designer needs this to select a control nested inside a container, and
 * asking GTK is the only way to get it right: a Frame insets its contents by a
 * border and a label whose sizes are the theme's business, so redoing the
 * arithmetic in JS would mis-hit by a few pixels on exactly the containers
 * that make nesting worth having.
 */
static JSValue cont_pick_at(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *p = bta_this(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    double x, y;
    if (argc < 2 || JS_ToFloat64(ctx, &x, argv[0]) || JS_ToFloat64(ctx, &y, argv[1]))
        return JS_EXCEPTION;

    /* Insensitive and non-targetable widgets are pickable here on purpose: a
     * disabled Button still has to be selectable in the designer. */
    GtkWidget *root = p->slot ? p->slot : p->gtk;
    GtkWidget *hit  = gtk_widget_pick(root, x, y,
                                      GTK_PICK_NON_TARGETABLE | GTK_PICK_INSENSITIVE);

    for (GtkWidget *c = hit; c; c = gtk_widget_get_parent(c)) {
        BtaWidget *cw = g_object_get_data(G_OBJECT(c), BTA_WIDGET_QUARK);
        if (cw && cw != p)
            return JS_DupValue(ctx, cw->self);
        if (c == root || c == p->gtk)
            break;          /* reached ourselves: the point is on empty space */
    }
    return JS_NULL;
}

static bool widget_is_within(BtaWidget *w, BtaWidget *ancestor)
{
    if (!ancestor)
        return false;
    for (GtkWidget *c = w->gtk; c; c = gtk_widget_get_parent(c))
        if (c == ancestor->gtk)
            return true;
    return false;
}

/*
 * The innermost container that could accept a drop at this point.
 *
 * `ignore` is the widget being dragged, and it matters: it sits under the
 * pointer for the whole gesture, so without excluding it the answer would
 * always be "its own parent". GTK has no ignore-list for picking, so it is
 * made untargetable for the duration of the call.
 */
static JSValue cont_container_at(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    BtaWidget *p = bta_this(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    double x, y;
    if (argc < 2 || JS_ToFloat64(ctx, &x, argv[0]) || JS_ToFloat64(ctx, &y, argv[1]))
        return JS_EXCEPTION;

    BtaWidget *ignore = argc > 2 ? bta_widget_of(argv[2]) : NULL;
    bool       could  = ignore && gtk_widget_get_can_target(ignore->gtk);
    if (could)
        gtk_widget_set_can_target(ignore->gtk, FALSE);

    GtkWidget *root = p->slot ? p->slot : p->gtk;
    GtkWidget *hit  = gtk_widget_pick(root, x, y, GTK_PICK_INSENSITIVE);

    if (could)
        gtk_widget_set_can_target(ignore->gtk, TRUE);

    for (GtkWidget *c = hit; c; c = gtk_widget_get_parent(c)) {
        BtaWidget *cw = g_object_get_data(G_OBJECT(c), BTA_WIDGET_QUARK);
        if (cw && cw->slot && !widget_is_within(cw, ignore))
            return JS_DupValue(ctx, cw->self);
        if (c == root || c == p->gtk)
            break;
    }
    /* Nothing else claimed it, so it lands here. */
    return JS_DupValue(ctx, p->self);
}

/*
 * Converts a point given in `from`'s coordinates into this container's content
 * coordinates -- the space its children's X/Y live in.  Needed to reparent a
 * control without teleporting it: X/Y are relative to the container, and a
 * Frame's content starts inside its border and label.
 */
static JSValue cont_local_point(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *p = bta_this(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    double x, y;
    if (argc < 2 || JS_ToFloat64(ctx, &x, argv[0]) || JS_ToFloat64(ctx, &y, argv[1]))
        return JS_EXCEPTION;

    BtaWidget *from = argc > 2 ? bta_widget_of(argv[2]) : NULL;
    if (!from)
        return JS_ThrowTypeError(ctx, "LocalPoint(x, y, from) expects a widget");

    graphene_point_t out;
    if (!gtk_widget_compute_point(from->gtk, p->slot ? p->slot : p->gtk,
                                  &GRAPHENE_POINT_INIT((float)x, (float)y), &out))
        return JS_NULL;

    JSValue arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, (int)out.x));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, (int)out.y));
    return arr;
}

/*
 * Reorder(child, index): move a child to that position among its siblings.
 *
 * In a box, order *is* position -- there are no coordinates to move a control
 * by, so this is what dragging one has to do.  A notebook orders its pages the
 * same way, a split has exactly two halves, a flow and a list of rows are
 * sequences, and in an `Overlay` the order is the stack: index 0 is the base
 * layer, the child that fills.
 *
 * In a Fixed the order is the painting order and Raise/Lower already say it, so
 * this refuses: silently doing something else would be worse than saying no.
 *
 * The work is `bta_container_reorder`, beside the attach and detach it mirrors,
 * because `Raise`/`Lower` and the designer's drag ask the same question and an
 * index has to mean the same thing to all three.
 */
static JSValue cont_reorder(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *p = bta_this(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (!bta_container_order(p->slot))
        return JS_ThrowTypeError(ctx, "this container has no order to give");

    BtaWidget *child = argc > 0 ? bta_widget_of(argv[0]) : NULL;
    if (!child)
        return JS_ThrowTypeError(ctx, "Reorder(child, index) expects a widget");

    int32_t index = 0;
    if (argc < 2 || JS_ToInt32(ctx, &index, argv[1]))
        return JS_ThrowTypeError(ctx, "Reorder(child, index) expects an index");

    return bta_container_reorder(ctx, p, child, index)
         ? JS_UNDEFINED : JS_EXCEPTION;
}

/*
 * FocusNext / FocusPrevious -- move the focus one place along the tab order.
 *
 * What Tab does, said from code, and the prior art has it: WinForms spells it
 * `SelectNextControl` and Delphi `SelectNext`. It earns its place here without
 * the tests: `TxtName_Activate() { this.TxtDesc.SetFocus(); }` -- Enter walking
 * to the next field -- is in two of this IDE's dialogs, and naming the next
 * control writes the order down a second time, in the one place that will not be
 * updated when the form is redrawn.
 *
 * The answer is whether the focus moved: false is nothing focusable left in that
 * direction, which the caller is entitled to know rather than guess from what it
 * can see.
 *
 * On `Container` and not on `Form`, so the walk can be confined to the panel that
 * holds the fields rather than always crossing the whole window -- a form is a
 * container, so `this.FocusNext()` in a dialog means what it did.
 */
static JSValue cont_focus_step(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* Asked of this container, so it walks in from wherever the focus is now --
     * which is what makes a surface's own `focus` (the tab order) the thing that
     * answers, rather than this deciding anything itself. */
    return JS_NewBool(ctx, gtk_widget_child_focus(w->gtk, magic
                               ? GTK_DIR_TAB_BACKWARD : GTK_DIR_TAB_FORWARD));
}

static const JSCFunctionListEntry container_props[] = {
    JS_CFUNC_MAGIC_DEF("FocusNext",     0, cont_focus_step, 0),
    JS_CFUNC_MAGIC_DEF("FocusPrevious", 0, cont_focus_step, 1),
    JS_CGETSET_DEF("Arrangement", cont_get_arrangement, cont_set_arrangement),
    JS_CGETSET_DEF("Placement",   cont_get_placement,   NULL),
    JS_CGETSET_DEF("Spacing",     cont_get_spacing,     cont_set_spacing),
    JS_CGETSET_DEF("Homogeneous", cont_get_homogeneous, cont_set_homogeneous),
    JS_CGETSET_DEF("Anchored",    cont_get_anchored,    cont_set_anchored),
    JS_CGETSET_DEF("Children",    cont_get_children,    NULL),
    JS_CFUNC_DEF("Reorder",     2, cont_reorder),
    JS_CFUNC_DEF("PickAt",      2, cont_pick_at),
    JS_CFUNC_DEF("ContainerAt", 3, cont_container_at),
    JS_CFUNC_DEF("LocalPoint",  3, cont_local_point),
    JS_CFUNC_DEF("Add",   1, container_add),
    JS_CFUNC_DEF("Clear", 0, container_clear),
};

/* ----------------------------------------------------------------- Panel */

/* The outer box is a holder so the inner slot can be swapped by Arrangement. */
/*
 * **One widget: the surface *is* the panel.**
 *
 * It used to be two boxes -- an outer one that stayed put and an inner slot that
 * `Arrangement` replaced -- and the outer one was there for exactly one reason:
 * something had to survive the swap, because `w->gtk` is what the parent lays
 * out. Now the swap is a layout manager (see `bta_fixed.c`), so nothing is
 * replaced and there is nothing to hold.
 *
 * What that cost while it lasted was not academic. A theme class went on the
 * outer box while the children were in the inner one, so every rule written
 * against a direct child missed: `Style = "linked"` on a row of buttons rendered
 * identical, pixel for pixel, to no class at all, because Adwaita's rule is
 * `.linked:not(.vertical) > button` -- and the outer box was vertical besides.
 */
static void build_panel(BtaWidget *w)
{
    w->gtk  = bta_fixed_new();
    w->slot = w->gtk;

    /*
     * Said explicitly, and false is not the same as unset: GTK propagates a
     * child's expand upwards, so a container holding one greedy control would
     * become greedy itself -- a row of buttons taking half the window. An
     * explicit value is what stops the propagation, and `Expand` overrides it
     * from the .form like any other property.
     */
    gtk_widget_set_hexpand(w->gtk, FALSE);
    gtk_widget_set_vexpand(w->gtk, FALSE);
}

/* ------------------------------------------------------------- Component */

/*
 * A component is a form that is not a window: its own .form file, its own class
 * with its own handlers, dropped inside another form as if it were a control.
 *
 * The widget is a Panel's -- coordinates by default, Arrangement to change that
 * -- because a component is laid out like any other form.  What makes it a
 * component is the constructor: a subclass of Component loads <Class>.form into
 * itself, exactly as a Form does.
 */
static void build_component(BtaWidget *w)
{
    /* A Panel's widget, for the reason above: one surface, and `Arrangement`
     * swaps its layout manager. */
    w->gtk  = bta_fixed_new();
    w->slot = w->gtk;

    gtk_widget_set_hexpand(w->gtk, FALSE);
    gtk_widget_set_vexpand(w->gtk, FALSE);
}

/* ----------------------------------------------------------------- Label */

static void build_label(BtaWidget *w)
{
    w->gtk = gtk_label_new("");
    gtk_label_set_xalign(GTK_LABEL(w->gtk), 0.0f);   /* left, like VB */
    gtk_label_set_yalign(GTK_LABEL(w->gtk), 0.5f);
}

static JSValue label_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* What was written, and not what Pango drew: with `Markup` on those differ
     * by the tags, and a label that lost them the first time its form was saved
     * would be a label that changed by being saved. */
    GtkLabel *label = GTK_LABEL(w->gtk);
    return JS_NewString(ctx, gtk_label_get_use_markup(label)
                                 ? gtk_label_get_label(label)
                                 : gtk_label_get_text(label));
}

static JSValue label_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    /* One call or the other, and the flag decides which: `set_text` escapes
     * what it is given and `set_markup` parses it, so a label whose Markup was
     * turned on after its Text has to be told again -- which is what
     * `label_set_markup` below does. */
    if (gtk_label_get_use_markup(GTK_LABEL(w->gtk)))
        gtk_label_set_markup(GTK_LABEL(w->gtk), s);
    else
        gtk_label_set_text(GTK_LABEL(w->gtk), s);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/*
 * Whether `Text` is Pango markup -- `<b>`, `<i>`, `<span foreground=...>`.
 *
 * The alternative was a second property holding the marked-up string, and two
 * places for one sentence is how they end up disagreeing: `Text` stays the one
 * thing a label says, and this says how to read it. It is also what keeps
 * translation working -- the catalogue collects `Text`, markup and all, which is
 * what every gettext project has always done with it.
 *
 * `Text` reads back **what was written**, tags included, and not what Pango drew:
 * a round trip through a `.form` that lost the tags would be a label that
 * changed the first time it was saved.
 */
static JSValue label_get_markup(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_label_get_use_markup(GTK_LABEL(w->gtk)));
}

static JSValue label_set_markup(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    GtkLabel *label = GTK_LABEL(w->gtk);
    if (b == gtk_label_get_use_markup(label))
        return JS_UNDEFINED;

    /* What it is holding, said again the other way: the string it was given is
     * `get_label`, which is the source and not the drawn text. */
    char *had = g_strdup(gtk_label_get_label(label));

    gtk_label_set_use_markup(label, b);
    if (b) gtk_label_set_markup(label, had ? had : "");
    else   gtk_label_set_text(label, had ? had : "");

    g_free(had);
    return JS_UNDEFINED;
}

/*
 * How many lines it may take before it stops -- 0 for as many as it needs.
 *
 * Only means anything with `Wrap` on, since a label that does not wrap has one
 * line by construction, and it is at its most useful with `Ellipsize` too: three
 * lines and an ellipsis is what a description in a list looks like when the text
 * is somebody else's and could be a paragraph.
 */
static JSValue label_get_lines(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int n = gtk_label_get_lines(GTK_LABEL(w->gtk));
    return JS_NewInt32(ctx, n < 0 ? 0 : n);
}

static JSValue label_set_lines(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Lines", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "Lines: %d is not a number of lines", n);

    gtk_label_set_lines(GTK_LABEL(w->gtk), n == 0 ? -1 : n);
    return JS_UNDEFINED;
}

/*
 * Whether the words can be picked up.
 *
 * The case is always the same one: something the program is *telling* you -- a
 * path, an error, a version -- that you then need somewhere else. A label one
 * cannot copy from turns that into retyping.
 */
static JSValue label_get_selectable(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_label_get_selectable(GTK_LABEL(w->gtk)));
}

static JSValue label_set_selectable(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    gtk_label_set_selectable(GTK_LABEL(w->gtk), b);
    return JS_UNDEFINED;
}

static JSValue label_get_align(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    float x = gtk_label_get_xalign(GTK_LABEL(w->gtk));
    return JS_NewString(ctx, x < 0.25f ? "Left" : (x > 0.75f ? "Right" : "Center"));
}

static JSValue label_set_align(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    float x = 0.0f;
    if (!g_ascii_strcasecmp(s, "Center"))     x = 0.5f;
    else if (!g_ascii_strcasecmp(s, "Right")) x = 1.0f;
    gtk_label_set_xalign(GTK_LABEL(w->gtk), x);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/*
 * What stops a long line from stretching whatever holds it, and it is the same
 * measure for both answers to it: a label that neither wraps nor ellipsizes asks
 * for the natural width of its whole text, so capping max-width-chars is what
 * collapses that request.  GTK then clamps it back up to the requested Width and
 * the text is laid out inside exactly the box that was asked for.
 */
static void label_fit(GtkLabel *label)
{
    gboolean bounded = gtk_label_get_wrap(label) ||
                       gtk_label_get_ellipsize(label) != PANGO_ELLIPSIZE_NONE;

    gtk_label_set_max_width_chars(label, bounded ? 1 : -1);
}

/*
 * Wrap: a paragraph instead of one long line.
 */
static JSValue label_get_wrap(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_label_get_wrap(GTK_LABEL(w->gtk)));
}

static JSValue label_set_wrap(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int on = JS_ToBool(ctx, val);
    if (on < 0)
        return JS_EXCEPTION;

    GtkLabel *label = GTK_LABEL(w->gtk);

    gtk_label_set_wrap(label, on);
    gtk_label_set_wrap_mode(label, PANGO_WRAP_WORD_CHAR);

    /* The other answer to the same question, and a label cannot give both: text
     * that wraps has no end to put the ellipsis at. */
    if (on)
        gtk_label_set_ellipsize(label, PANGO_ELLIPSIZE_NONE);
    label_fit(label);

    /* Wrapped text reads from the top of its box, not from the middle of it. */
    gtk_label_set_yalign(label, on ? 0.0f : 0.5f);
    return JS_UNDEFINED;
}

/*
 * Ellipsize: one line still, and what does not fit ends in a "...".
 *
 * `Wrap` gives the text more lines; this keeps the one and gives up the tail of
 * it, which is what a caption on a fixed strip wants -- a window title over a
 * form, a path in a status bar.  Both cap the natural width, so either stops a
 * long string from stretching its container; the difference is only what happens
 * to the text that does not fit.
 */
static JSValue label_get_ellipsize(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx,
                      gtk_label_get_ellipsize(GTK_LABEL(w->gtk)) != PANGO_ELLIPSIZE_NONE);
}

static JSValue label_set_ellipsize(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int on = JS_ToBool(ctx, val);
    if (on < 0)
        return JS_EXCEPTION;

    GtkLabel *label = GTK_LABEL(w->gtk);

    gtk_label_set_ellipsize(label, on ? PANGO_ELLIPSIZE_END : PANGO_ELLIPSIZE_NONE);
    if (on) {
        gtk_label_set_wrap(label, FALSE);
        gtk_label_set_yalign(label, 0.5f);
    }
    label_fit(label);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry label_props[] = {
    JS_CGETSET_DEF("Text",      label_get_text,  label_set_text),
    JS_CGETSET_DEF("Alignment", label_get_align, label_set_align),
    JS_CGETSET_DEF("Wrap",      label_get_wrap,  label_set_wrap),
    JS_CGETSET_DEF("Ellipsize", label_get_ellipsize, label_set_ellipsize),
    JS_CGETSET_DEF("Lines",      label_get_lines,      label_set_lines),
    JS_CGETSET_DEF("Markup",     label_get_markup,     label_set_markup),
    JS_CGETSET_DEF("Selectable", label_get_selectable, label_set_selectable),
};

/* ---------------------------------------------------------------- Button */

static void on_button_clicked(GtkButton *b, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Click", 0, NULL);
}

static void build_button(BtaWidget *w)
{
    w->gtk = gtk_button_new_with_label("");
    g_signal_connect(w->gtk, "clicked", G_CALLBACK(on_button_clicked), w);
}

/*
 * A GtkButton shows either a label or one custom child, never both, so "icon
 * beside text" means building that row ourselves.  Both values are kept on the
 * widget and the child is rebuilt whenever either changes -- otherwise setting
 * Text after Icon would silently throw the icon away.
 */
#define BTN_TEXT_KEY "bta-button-text"
#define BTN_ICON_KEY "bta-button-icon"

static const char *button_stored(BtaWidget *w, const char *key)
{
    const char *s = g_object_get_data(G_OBJECT(w->gtk), key);
    return s ? s : "";
}

/* Read back what was set, not gtk_button_get_label(): with an icon the button
 * carries a custom child and GTK reports no label at all. */
static JSValue button_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, button_stored(w, BTN_TEXT_KEY));
}

/*
 * An icon name the theme does not have would render as a broken-image glyph;
 * dropping it leaves the button readable on a system without that icon.
 *
 * Also asked from JS as Application.HasIcon(): whoever *picks* the name is the
 * only one who can choose a fallback, and silently dropping it is what makes
 * an icon-only button come out empty.  `widget` may be NULL for the default
 * display.
 */
/* Does the icon put any ink on a 16x16 square?  Drawing it is the only honest
 * answer: an icon theme in the wild ships SVGs that render to nothing (art
 * placed far outside the frame by a translate, with no viewBox to bring it
 * back), and those are indistinguishable from a good one until rendered. */
static bool icon_has_ink(GtkIconPaintable *icon)
{
    GtkSnapshot *snapshot = gtk_snapshot_new();
    gdk_paintable_snapshot(GDK_PAINTABLE(icon), snapshot, 16, 16);

    GskRenderNode *node = gtk_snapshot_free_to_node(snapshot);
    if (!node)
        return false;

    cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 16, 16);
    cairo_t         *cr      = cairo_create(surface);

    gsk_render_node_draw(node, cr);
    cairo_destroy(cr);
    cairo_surface_flush(surface);

    const uint32_t *pixels = (const uint32_t *)cairo_image_surface_get_data(surface);
    int             stride = cairo_image_surface_get_stride(surface) / 4;
    bool            ink    = false;

    for (int y = 0; y < 16 && !ink; y++)
        for (int x = 0; x < 16; x++)
            if (pixels[y * stride + x] >> 24) {     /* any alpha at all */
                ink = true;
                break;
            }

    cairo_surface_destroy(surface);
    gsk_render_node_unref(node);
    return ink;
}

/*
 * An icon resolved here rather than by name, which is the whole of the
 * difference: `gtk_image_set_from_icon_name` looks the icon up with
 * `GTK_ICON_LOOKUP_PRELOAD` and GTK rasterises it on a thread pool, and an SVG
 * containing text is laid out there with pango -- which builds its per-font
 * caches lazily and unlocked, so two such icons rasterised at once race and one
 * thread finds the other's half-built cache.  A SIGSEGV in
 * `_pango_cairo_font_private_get_scaled_font`, under a stack that is entirely
 * GTK's, on GTK 4.22.4 with pango 1.57.1; forty lines of plain GTK reproduce it,
 * and `elementary-xfce` ships two window buttons that trip it -- their SVGs
 * carry an editor's leftover empty `<text>` nodes, drawing nothing at all.
 *
 * Looked up without that flag, the SVG is rasterised where it is drawn, on this
 * thread, and there is nothing to race with.  Nothing else changes: it is the
 * desktop's own icon, symbolic recolouring and all.
 *
 * What a paintable does not do is follow the theme and the scale by itself, the
 * way a name does -- so `bta_image_set_icon` asks again when either moves.
 */
GtkIconPaintable *bta_icon_paintable(GtkWidget *widget, const char *name, int size)
{
    if (!name || !*name)
        return NULL;

    GdkDisplay *display = widget ? gtk_widget_get_display(widget)
                                 : gdk_display_get_default();
    GtkIconTheme *theme = display ? gtk_icon_theme_get_for_display(display) : NULL;
    if (!theme)
        return NULL;

    int scale = widget ? gtk_widget_get_scale_factor(widget) : 1;

    return gtk_icon_theme_lookup_icon(theme, name, NULL, size > 0 ? size : 16,
                                      scale > 0 ? scale : 1, GTK_TEXT_DIR_LTR, 0);
}

#define IMG_NAME_KEY "bta-icon-name"

static void image_apply_icon(GtkWidget *image)
{
    const char *name = g_object_get_data(G_OBJECT(image), IMG_NAME_KEY);

    if (!name || !*name) {
        gtk_image_clear(GTK_IMAGE(image));
        return;
    }

    GtkIconPaintable *icon =
        bta_icon_paintable(image, name, gtk_image_get_pixel_size(GTK_IMAGE(image)));

    gtk_image_set_from_paintable(GTK_IMAGE(image), GDK_PAINTABLE(icon));
    g_clear_object(&icon);
}

static void image_icon_again(GObject *from, GParamSpec *pspec, gpointer image)
{
    image_apply_icon(image);
}

/*
 * Show a named icon on a GtkImage.  Every icon the runtime draws goes through
 * here, so no application can put one on GTK's icon thread by accident.
 *
 * A paintable is resolved once, at one size and one scale, where a name is
 * re-resolved by GTK whenever either changes -- so the name is kept on the
 * widget and asked for again when the scale factor moves (a window dragged to
 * another monitor) or the desktop changes its icon theme.  Without that, this
 * would trade a crash for icons that quietly go blurry.
 */
void bta_image_set_icon(GtkWidget *image, const char *name)
{
    g_object_set_data_full(G_OBJECT(image), IMG_NAME_KEY,
                           g_strdup(name ? name : ""), g_free);

    if (!g_object_get_data(G_OBJECT(image), "bta-icon-watched")) {
        GdkDisplay   *display = gtk_widget_get_display(image);
        GtkIconTheme *theme   = display ? gtk_icon_theme_get_for_display(display)
                                        : NULL;

        g_object_set_data(G_OBJECT(image), "bta-icon-watched", GINT_TO_POINTER(1));
        g_signal_connect(image, "notify::scale-factor",
                         G_CALLBACK(image_icon_again), image);
        if (theme)
            g_signal_connect_object(theme, "changed",
                                    G_CALLBACK(image_apply_icon), image,
                                    G_CONNECT_SWAPPED);
    }

    image_apply_icon(image);
}

bool bta_icon_available(GtkWidget *widget, const char *name)
{
    if (!name || !*name)
        return false;

    GdkDisplay *display = widget ? gtk_widget_get_display(widget)
                                 : gdk_display_get_default();
    GtkIconTheme *theme = display ? gtk_icon_theme_get_for_display(display) : NULL;
    if (!theme)
        return false;

    GtkIconPaintable *icon = gtk_icon_theme_lookup_icon(theme, name, NULL, 16, 1,
                                                        GTK_TEXT_DIR_LTR, 0);
    if (!icon)
        return false;

    /* Lookup never fails: a name the theme's index claims but does not ship
     * comes back as the theme's own image-missing. */
    GFile *file = gtk_icon_paintable_get_file(icon);
    char  *base = file ? g_file_get_basename(file) : NULL;
    bool   real = base && !g_str_has_prefix(base, "image-missing")
                       && icon_has_ink(icon);

    g_free(base);
    g_object_unref(icon);
    return real;
}

static void button_rebuild(BtaWidget *w)
{
    const char *text = button_stored(w, BTN_TEXT_KEY);
    const char *icon = button_stored(w, BTN_ICON_KEY);
    bool        show = bta_icon_available(w->gtk, icon);

    if (show && *text) {
        GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
        GtkWidget *img = gtk_image_new();

        bta_image_set_icon(img, icon);
        gtk_widget_set_halign(box, GTK_ALIGN_CENTER);
        gtk_box_append(GTK_BOX(box), img);
        gtk_box_append(GTK_BOX(box), gtk_label_new(text));
        gtk_button_set_child(GTK_BUTTON(w->gtk), box);
    } else if (show) {
        /* What gtk_button_set_icon_name does, minus the icon name: the same
         * child and the same class, with the icon taken by the safe route. */
        GtkWidget *img = gtk_image_new();

        bta_image_set_icon(img, icon);
        gtk_button_set_child(GTK_BUTTON(w->gtk), img);
        gtk_widget_add_css_class(w->gtk, "image-button");
    } else {
        gtk_button_set_label(GTK_BUTTON(w->gtk), text);
    }
}

static JSValue button_store(JSContext *ctx, JSValueConst this_val,
                            JSValueConst val, const char *key)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    g_object_set_data_full(G_OBJECT(w->gtk), key, g_strdup(s), g_free);
    JS_FreeCString(ctx, s);

    button_rebuild(w);
    return JS_UNDEFINED;
}

static JSValue button_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    return button_store(ctx, this_val, val, BTN_TEXT_KEY);
}

static JSValue button_get_icon(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, button_stored(w, BTN_ICON_KEY));
}

static JSValue button_set_icon(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    return button_store(ctx, this_val, val, BTN_ICON_KEY);
}

/* Presses the button from code: same signal, same handler, same as a user
 * click.  Needed for default buttons and keyboard shortcuts, and it is what
 * lets a UI be driven by a test. */
static JSValue button_click(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (gtk_widget_get_sensitive(w->gtk))
        g_signal_emit_by_name(w->gtk, "clicked");
    return JS_UNDEFINED;
}

/*
 * Default / Cancel -- what Enter and Escape do on the form this button is on.
 *
 * On the button and not on the form, which is where VB6, Delphi and Gambas put
 * it and where WinForms moved it away from. Both spellings work; this one is
 * the only one that works *here*. A `Form.DefaultButton = "BtnOk"` naming a
 * control cannot be applied from a `.form` at all: `bta_form_build` applies the
 * form's own properties before `build_children`, so the name would point at
 * nothing yet and would have to be stored and resolved later -- a hole where a
 * typo does nothing in silence, and a reference the IDE's rename would have to
 * chase through a `.form` for the first time.
 *
 * Setting one tells GTK nothing; see the note on `is_default` in bta.h for why
 * that matters, and `form_show` for where it lands.
 */
enum { BTN_DEFAULT, BTN_CANCEL };

static JSValue button_get_flag(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, magic == BTN_DEFAULT ? w->is_default : w->is_cancel);
}

static JSValue button_set_flag(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    if (magic == BTN_DEFAULT) w->is_default = b;
    else                      w->is_cancel  = b;

    /*
     * And that is all it does. **The tempting version -- push it to the window
     * now, so a form already on screen follows -- cannot be written safely.**
     * Making an assignment win over an earlier declaration means clearing the
     * flag on its siblings, and the siblings a button can reach are its *form's*
     * -- which in the designer is `MainForm`, whose controls are the IDE's own.
     * A drawing would be clearing the IDE's declarations and handing the IDE's
     * Enter key to a button on a canvas, and no test of a drawn form would ever
     * notice.
     *
     * So the window learns at Show, where a drawing never goes. `Cancel` needs
     * nothing either way: Escape walks for it at the moment it is pressed.
     */
    return JS_UNDEFINED;
}

/* Icon is a property, not a SetIcon() method: only properties are discovered
 * by the serialiser and the designer's grid, so a method would be invisible to
 * both -- and the .form files already write it as one. */
static const JSCFunctionListEntry button_props[] = {
    JS_CGETSET_DEF("Text", button_get_text, button_set_text),
    JS_CGETSET_DEF("Icon", button_get_icon, button_set_icon),
    JS_CGETSET_MAGIC_DEF("Default", button_get_flag, button_set_flag, BTN_DEFAULT),
    JS_CGETSET_MAGIC_DEF("Cancel",  button_get_flag, button_set_flag, BTN_CANCEL),
    JS_CFUNC_DEF("Click", 0, button_click),
};

/* --------------------------------------------------------------- TextBox */

static void on_entry_changed(GtkEditable *e, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Change", 0, NULL);
}

static void on_entry_activate(GtkEntry *e, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Activate", 0, NULL);
}

/*
 * The icon sits inside the field, on the right, and is clickable.  It replaces
 * the old GtkFileChooserButton that GTK4 removed: a field showing the path plus
 * an icon that opens the dialog says the same thing and also lets one type it.
 */
static void on_entry_icon(GtkEntry *e, GtkEntryIconPosition pos, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "IconClick", 0, NULL);
}

static void build_textbox(BtaWidget *w)
{
    w->gtk = gtk_entry_new();
    g_signal_connect(w->gtk, "changed",  G_CALLBACK(on_entry_changed),  w);
    g_signal_connect(w->gtk, "activate", G_CALLBACK(on_entry_activate), w);
    g_signal_connect(w->gtk, "icon-press", G_CALLBACK(on_entry_icon),   w);
}

static JSValue textbox_get_icon(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *name = gtk_entry_get_icon_name(GTK_ENTRY(w->gtk),
                                               GTK_ENTRY_ICON_SECONDARY);
    return JS_NewString(ctx, name ? name : "");
}

static JSValue textbox_set_icon(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;

    /* An icon the theme does not have is dropped, the same as in Button: better
     * a field with no icon than the broken-image glyph. */
    bool show = bta_icon_available(w->gtk, name);
    gtk_entry_set_icon_from_icon_name(GTK_ENTRY(w->gtk), GTK_ENTRY_ICON_SECONDARY,
                                      show ? name : NULL);
    gtk_entry_set_icon_activatable(GTK_ENTRY(w->gtk), GTK_ENTRY_ICON_SECONDARY, TRUE);

    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue textbox_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, gtk_editable_get_text(GTK_EDITABLE(w->gtk)));
}

static JSValue textbox_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    gtk_editable_set_text(GTK_EDITABLE(w->gtk), s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/*
 * The hint drawn in an empty field.
 *
 * Worth having on its own account -- it is the standard way to say what a field
 * is for without a label beside it -- and it is what makes an *empty* editor
 * mean something: the property grid's design mode shows the real value here
 * behind a blank field, so "no design value" and "a design value of nothing"
 * stop looking the same.
 */
static JSValue textbox_get_placeholder(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = gtk_entry_get_placeholder_text(GTK_ENTRY(w->gtk));
    return JS_NewString(ctx, s ? s : "");
}

static JSValue textbox_set_placeholder(JSContext *ctx, JSValueConst this_val,
                                       JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    /* GTK draws nothing for "", which is also what it does for NULL; passing
     * the empty string through keeps the round trip exact. */
    gtk_entry_set_placeholder_text(GTK_ENTRY(w->gtk), s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/*
 * `ActivatesDefault` -- Enter in this field presses the form's default button
 * instead of raising `Activate`.
 *
 * **It is one or the other, which is GTK's own bargain and worth stating**: with
 * this on, the entry does not emit `activate` at all. That is not a limitation to
 * work around, it is the question being asked -- Enter in a field means one of
 * two things and only the form knows which. Both are in this IDE today, written
 * by hand: `TxtDesc_Activate() { this.accept(); }` is this property, and
 * `TxtPrName_Activate() { this.TxtPrDesc.SetFocus(); }` is Enter walking to the
 * next field, which is a tab order and not a default button.
 *
 * Off by default, so nothing that already handles `Activate` changes meaning.
 */
enum { TB_READONLY, TB_PASSWORD, TB_ACTIVATES };

static JSValue textbox_get_flag(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    switch (magic) {
    case TB_READONLY:
        return JS_NewBool(ctx, !gtk_editable_get_editable(GTK_EDITABLE(w->gtk)));
    case TB_ACTIVATES:
        return JS_NewBool(ctx, gtk_entry_get_activates_default(GTK_ENTRY(w->gtk)));
    default:
        return JS_NewBool(ctx, !gtk_entry_get_visibility(GTK_ENTRY(w->gtk)));
    }
}

static JSValue textbox_set_flag(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    switch (magic) {
    case TB_READONLY:
        gtk_editable_set_editable(GTK_EDITABLE(w->gtk), !b);
        break;
    case TB_ACTIVATES:
        gtk_entry_set_activates_default(GTK_ENTRY(w->gtk), b);
        break;
    default:
        gtk_entry_set_visibility(GTK_ENTRY(w->gtk), !b);
        break;
    }
    return JS_UNDEFINED;
}

/*
 * How many characters it will take, 0 for as many as one types.
 *
 * The field stops accepting them rather than complaining afterwards, which is
 * the point: a code that is six long is six long, and a form that says so while
 * it is being filled in never has to say it again in a dialog.
 */
static JSValue textbox_get_maxlength(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gtk_entry_get_max_length(GTK_ENTRY(w->gtk)));
}

static JSValue textbox_set_maxlength(JSContext *ctx, JSValueConst this_val,
                                     JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "MaxLength", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "MaxLength: %d is not a length", n);

    gtk_entry_set_max_length(GTK_ENTRY(w->gtk), n);
    return JS_UNDEFINED;
}

/*
 * What kind of thing goes in it.
 *
 * Not validation -- nothing here refuses an address that is not one -- but a
 * *declaration*, which is what a phone with an on-screen keyboard reads to open
 * the number pad instead of the alphabet, and what a input method reads to stop
 * autocapitalising a URL. On a desktop it costs nothing and on a tablet it is
 * the difference between a form one can fill in and one one cannot.
 *
 * A curated list and not GTK's eleven: `Password` and `Pin` are left out because
 * this class already has a `Password` flag, and two ways to say one thing is how
 * they end up disagreeing.
 */
static JSValue textbox_get_purpose(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    switch (gtk_entry_get_input_purpose(GTK_ENTRY(w->gtk))) {
    case GTK_INPUT_PURPOSE_DIGITS: return JS_NewString(ctx, "Digits");
    case GTK_INPUT_PURPOSE_NUMBER: return JS_NewString(ctx, "Number");
    case GTK_INPUT_PURPOSE_PHONE:  return JS_NewString(ctx, "Phone");
    case GTK_INPUT_PURPOSE_URL:    return JS_NewString(ctx, "Url");
    case GTK_INPUT_PURPOSE_EMAIL:  return JS_NewString(ctx, "Email");
    case GTK_INPUT_PURPOSE_NAME:   return JS_NewString(ctx, "Name");
    default:                       return JS_NewString(ctx, "Text");
    }
}

static JSValue textbox_set_purpose(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkInputPurpose p;
    if      (!strcmp(s, "Text"))   p = GTK_INPUT_PURPOSE_FREE_FORM;
    else if (!strcmp(s, "Digits")) p = GTK_INPUT_PURPOSE_DIGITS;
    else if (!strcmp(s, "Number")) p = GTK_INPUT_PURPOSE_NUMBER;
    else if (!strcmp(s, "Phone"))  p = GTK_INPUT_PURPOSE_PHONE;
    else if (!strcmp(s, "Url"))    p = GTK_INPUT_PURPOSE_URL;
    else if (!strcmp(s, "Email"))  p = GTK_INPUT_PURPOSE_EMAIL;
    else if (!strcmp(s, "Name"))   p = GTK_INPUT_PURPOSE_NAME;
    else {
        JSValue e = JS_ThrowRangeError(ctx, "Purpose: '%s' is not Text, Digits, "
                                            "Number, Phone, Url, Email or Name", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    gtk_entry_set_input_purpose(GTK_ENTRY(w->gtk), p);
    return JS_UNDEFINED;
}

/* Which end the text sits at -- the same word a Label uses for the same
 * question, because a right-aligned column of numbers is made of both. */
static JSValue textbox_get_alignment(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    float x = gtk_entry_get_alignment(GTK_ENTRY(w->gtk));
    return JS_NewString(ctx, x > 0.75f ? "Right" : x > 0.25f ? "Center" : "Left");
}

static JSValue textbox_set_alignment(JSContext *ctx, JSValueConst this_val,
                                     JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    float x;
    if      (!strcmp(s, "Left"))   x = 0.0f;
    else if (!strcmp(s, "Center")) x = 0.5f;
    else if (!strcmp(s, "Right"))  x = 1.0f;
    else {
        JSValue e = JS_ThrowRangeError(ctx, "Alignment: '%s' is not Left, "
                                            "Center or Right", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    gtk_entry_set_alignment(GTK_ENTRY(w->gtk), x);
    return JS_UNDEFINED;
}

/*
 * The selection: what is highlighted, and putting it where one wants.
 *
 * `Select(0)` with no length is a cursor and not a selection, which is how one
 * puts the caret somewhere; `SelectAll()` is the one every field that opens with
 * a value in it wants on focus, so that typing replaces it.
 *
 * A length past the end is the end, rather than an error: the caller counting
 * characters is usually a search that just found one, and clamping is what it
 * would have written itself.
 */
static JSValue textbox_select(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t start = 0, len = 0;
    if (argc > 0 && JS_ToInt32(ctx, &start, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && JS_ToInt32(ctx, &len, argv[1]))
        return JS_EXCEPTION;

    if (start < 0 || len < 0)
        return JS_ThrowRangeError(ctx, "Select(start, length): a position is "
                                       "not negative");

    gtk_editable_select_region(GTK_EDITABLE(w->gtk), start, start + len);
    return JS_UNDEFINED;
}

static JSValue textbox_select_all(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    gtk_editable_select_region(GTK_EDITABLE(w->gtk), 0, -1);
    return JS_UNDEFINED;
}

/* What is highlighted right now, "" for nothing -- which is what a *Copy* or a
 * *Replace* over a field has to ask before it can do anything. */
static JSValue textbox_get_selected(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int start, end;
    if (!gtk_editable_get_selection_bounds(GTK_EDITABLE(w->gtk), &start, &end))
        return JS_NewString(ctx, "");

    char *text = gtk_editable_get_chars(GTK_EDITABLE(w->gtk), start, end);
    JSValue out = JS_NewString(ctx, text ? text : "");
    g_free(text);
    return out;
}

static const JSCFunctionListEntry textbox_props[] = {
    JS_CGETSET_DEF("Text", textbox_get_text, textbox_set_text),
    JS_CGETSET_DEF("MaxLength", textbox_get_maxlength, textbox_set_maxlength),
    JS_CGETSET_DEF("Purpose",   textbox_get_purpose,   textbox_set_purpose),
    JS_CGETSET_DEF("Alignment", textbox_get_alignment, textbox_set_alignment),
    JS_CGETSET_DEF("SelectedText", textbox_get_selected, NULL),
    JS_CFUNC_DEF("Select",    2, textbox_select),
    JS_CFUNC_DEF("SelectAll", 0, textbox_select_all),
    JS_CGETSET_DEF("Placeholder", textbox_get_placeholder, textbox_set_placeholder),
    JS_CGETSET_DEF("Icon", textbox_get_icon, textbox_set_icon),
    JS_CGETSET_MAGIC_DEF("ReadOnly", textbox_get_flag, textbox_set_flag, TB_READONLY),
    JS_CGETSET_MAGIC_DEF("Password", textbox_get_flag, textbox_set_flag, TB_PASSWORD),
    JS_CGETSET_MAGIC_DEF("ActivatesDefault", textbox_get_flag, textbox_set_flag,
                         TB_ACTIVATES),
};

static const char *textbox_options(const char *prop)
{
    if (!strcmp(prop, "Purpose"))
        return "Text,Digits,Number,Phone,Url,Email,Name";
    if (!strcmp(prop, "Alignment"))
        return "Left,Center,Right";
    return NULL;
}

/* ----------------------------------------------------------- CheckButton */

static void on_check_toggled(GtkCheckButton *b, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Click", 0, NULL);
}

/* ------------------------------------------------------------- grouping */

/*
 * What makes a `CheckButton` one of a set: a name.
 *
 * **This is the one thing unifying the two controls cost, and it is worth
 * stating plainly.** There used to be a `RadioButton` class, and what made a set
 * was the *container*: the radios of one Panel were one group, nothing had to be
 * declared, and `Group` existed only for two sets that had to share a container.
 * That rule cannot survive one class -- a check box and a radio are the same
 * widget now, so "everything in this Panel is one exclusive set" would turn every
 * row of tick boxes into a set of choices. The class cannot guess whether a tick
 * or a choice was meant, so it is said: an empty `Group` is a check box, a name
 * makes it one of that set.
 *
 * The container still *scopes* the name, which is the half worth keeping: the
 * same `Group` in two Panels is two sets, so a form can hold as many as it has
 * containers without inventing unique names for each.
 *
 * The chain is rebuilt whenever the set can have changed -- one added to a
 * container, taken out of one, or given another `Group` -- because GTK's group
 * is a linked list and not a name: each member joins the first one it finds.
 */
#define RADIO_GROUP_KEY  "bta-radio-group"
#define RADIO_ANCHOR_KEY "bta-radio-anchor"

/*
 * Whether this widget is a `CheckButton` at all -- only they are given the key,
 * and every one of them has it from the moment it is built. Asked apart from
 * *which group it is in*, because those are two questions now: an empty name is
 * a perfectly ordinary check button and still has to be unlinked from whatever
 * set it used to be in.
 */
static bool is_checkbutton(GtkWidget *widget)
{
    return widget && g_object_get_data(G_OBJECT(widget), RADIO_GROUP_KEY) != NULL;
}

/*
 * The set it belongs to, or nothing.
 *
 * **The empty name is not a set.** It is what a check button says when nobody
 * asked it to be one of several -- a box one ticks, on or off, alone. A name is
 * what makes it one of that set among its siblings, and GTK draws it round and
 * exclusive because of the grouping rather than because of anything we say.
 */
static const char *radio_group_of(GtkWidget *widget)
{
    const char *group = widget
        ? g_object_get_data(G_OBJECT(widget), RADIO_GROUP_KEY) : NULL;

    return group && *group ? group : NULL;
}

/*
 * A group of one is still a group, and GTK4 has to be told so.
 *
 * There is no radio button in GTK4: `GtkRadioButton` was removed, and what a
 * radio *is* now is a `GtkCheckButton` that belongs to a group. Grouping is what
 * makes the indicator a circle instead of a square, and it is also what makes a
 * second click leave it on instead of turning it off -- so an ungrouped one is a
 * check box in both halves, not merely in appearance. Measured, both ways: a
 * lone one drew a rounded square and answered `false` after two clicks, while
 * one with a neighbour drew a circle and answered `true`.
 *
 * The runtime used to leave the head of every group ungrouped, which is harmless
 * while somebody else is chained to it and is the whole story when nobody is --
 * the first one dropped on a form, which is exactly when one looks at it.
 *
 * So the first member of a named set gets a companion: an ordinary
 * `GtkCheckButton` that is never parented, never drawn and never read, whose
 * only job is to be somebody to be grouped *with*. GTK offers no other lever --
 * no property, no CSS name -- and a widget nobody shows costs a GObject.
 *
 * Only for a *named* set: a check button with no group is meant to be square,
 * and giving that one a companion would draw every check box in the language as
 * a radio.
 *
 * Sunk on creation, because a `GtkWidget` arrives with a floating reference and
 * this one never gets a parent to claim it; freed with the radio it belongs to.
 */
static GtkWidget *radio_anchor(GtkWidget *radio)
{
    GtkWidget *anchor = g_object_get_data(G_OBJECT(radio), RADIO_ANCHOR_KEY);
    if (anchor)
        return anchor;

    anchor = gtk_check_button_new();
    g_object_ref_sink(anchor);
    g_object_set_data_full(G_OBJECT(radio), RADIO_ANCHOR_KEY, anchor, g_object_unref);
    return anchor;
}

/* Alone in a group of its own: what a radio is when nothing else shares its
 * name, and what the head of a group was given instead of `NULL`. */
static void radio_stand_alone(GtkWidget *radio)
{
    gtk_check_button_set_group(GTK_CHECK_BUTTON(radio),
                               GTK_CHECK_BUTTON(radio_anchor(radio)));
}

void bta_radio_regroup(GtkWidget *slot, GtkWidget *child)
{
    /* Nothing to do for the other thousand things that get added to a container,
     * which is why this can sit in the middle of attach and detach. */
    if (!slot || !child || !is_checkbutton(child))
        return;

    /*
     * Out of whatever chain it was in, before anything else.  On the way out that
     * is the whole job -- one that left still points into the set it left, and
     * toggling it later would turn something off in a container it is no longer
     * in.  On the way in, the two passes below put it back.
     */
    gtk_check_button_set_group(GTK_CHECK_BUTTON(child), NULL);

    /*
     * **Everything out, and then everything in.  Two passes, and the first one
     * is not optional.**
     *
     * `gtk_check_button_set_group` moves a button from the list it is in into
     * the target's -- so re-grouping one that is *already* in that list unlinks
     * and relinks it inside itself, and the list closes into a cycle. Nothing
     * complains: the damage shows up on the next click, when GTK walks the group
     * to turn the others off and walks forever. It took a hang with no output to
     * find, and it is reachable in the ordinary way -- this runs on every child
     * added to a container, so the second radio dropped on a form re-groups the
     * first one, which by then is already leading its own anchor.
     */
    for (GtkWidget *c = gtk_widget_get_first_child(slot); c;
         c = gtk_widget_get_next_sibling(c)) {
        /* A RowList puts each child in a row of its own, so it can be one level
         * below what the slot reports. */
        BtaWidget *cw = bta_slot_child(c);
        if (cw && is_checkbutton(cw->gtk))
            gtk_check_button_set_group(GTK_CHECK_BUTTON(cw->gtk), NULL);
    }

    GHashTable *heads = g_hash_table_new(g_str_hash, g_str_equal);

    for (GtkWidget *c = gtk_widget_get_first_child(slot); c;
         c = gtk_widget_get_next_sibling(c)) {
        BtaWidget *cw = bta_slot_child(c);
        if (!cw)
            continue;

        const char *group = radio_group_of(cw->gtk);
        if (!group)
            continue;

        GtkWidget *head = g_hash_table_lookup(heads, group);
        if (head) {
            gtk_check_button_set_group(GTK_CHECK_BUTTON(cw->gtk),
                                       GTK_CHECK_BUTTON(head));
        } else {
            /* The first of its name leads it: into a group of its own, which is
             * what keeps it round while it is the only one. */
            radio_stand_alone(cw->gtk);
            g_hash_table_insert(heads, (gpointer)group, cw->gtk);
        }
    }
    g_hash_table_destroy(heads);
}

static JSValue radio_get_group(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *group = radio_group_of(w->gtk);
    return JS_NewString(ctx, group ? group : "");
}

static JSValue radio_set_group(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *group = JS_ToCString(ctx, val);
    if (!group)
        return JS_EXCEPTION;

    g_object_set_data_full(G_OBJECT(w->gtk), RADIO_GROUP_KEY,
                           g_strdup(group), g_free);
    JS_FreeCString(ctx, group);

    /* Changing the name changes two sets: the one left and the one joined. */
    bta_radio_regroup(gtk_widget_get_parent(w->gtk), w->gtk);
    return JS_UNDEFINED;
}

/*
 * CheckButton: a box one ticks, or one of a set -- and which of the two it is
 * comes from `Group`, exactly as it does in GTK4.
 *
 * **There is no separate radio button here, because there is none in GTK4.**
 * `GtkRadioButton` was removed: what a radio *is* now is a `GtkCheckButton` that
 * belongs to a group, and belonging is what draws the indicator round, makes the
 * set exclusive and makes a second click leave it on. Two classes over one
 * widget, differing only in whether a property is set, is the `ListBox`/`ListView`
 * confusion this project already refused once.
 *
 * **It is not what other RAD tools do**, and that is worth saying rather than
 * hiding: VB, Delphi and Gambas all have two controls, and somebody arriving
 * from those will look for a RadioButton and not find one. What they get instead
 * is one control whose `.form` says which it is -- and no `RadioButton` that
 * silently behaves like a check box because it happened to be the only one, which
 * is what the two-class version did here.
 */
static void build_checkbutton(BtaWidget *w)
{
    w->gtk = gtk_check_button_new_with_label("");
    g_object_set_data_full(G_OBJECT(w->gtk), RADIO_GROUP_KEY, g_strdup(""), g_free);
    g_signal_connect(w->gtk, "toggled", G_CALLBACK(on_check_toggled), w);
}

static JSValue check_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    const char *t = gtk_check_button_get_label(GTK_CHECK_BUTTON(w->gtk));
    return JS_NewString(ctx, t ? t : "");
}

static JSValue check_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    gtk_check_button_set_label(GTK_CHECK_BUTTON(w->gtk), s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue check_get_active(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_check_button_get_active(GTK_CHECK_BUTTON(w->gtk)));
}

static JSValue check_set_active(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_check_button_set_active(GTK_CHECK_BUTTON(w->gtk), b);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry checkbutton_props[] = {
    JS_CGETSET_DEF("Text",  check_get_text,  check_set_text),
    JS_CGETSET_DEF("Active", check_get_active, check_set_active),
    JS_CGETSET_DEF("Group", radio_get_group, radio_set_group),
};

/* ---------------------------------------------------------------- Switch */

/*
 * A `GtkSwitch`: the same question a CheckButton asks, drawn the way the desktop
 * draws a setting that takes effect the moment it is flipped.  So it is the
 * CheckButton's `Value` and its `Click`, and nothing else -- a switch
 * carries no caption of its own, and the label beside it is a Label.
 *
 * `notify::active` and not `state-set`: the second is the hook for a setting
 * that takes a while to apply and may refuse, and what a handler there returns
 * decides whether the switch moves at all.  There is nothing here to refuse, and
 * `active` is the property both the pointer and an assignment from JS go through
 * -- which is what makes the round trip a real signal rather than an echo.
 */
static void on_switch_active(GObject *sw, GParamSpec *pspec, gpointer user_data)
{
    (void)sw;
    (void)pspec;
    bta_emit((BtaWidget *)user_data, "Click", 0, NULL);
}

static void build_switch(BtaWidget *w)
{
    w->gtk = gtk_switch_new();
    g_signal_connect(w->gtk, "notify::active", G_CALLBACK(on_switch_active), w);
}

static JSValue switch_get_active(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_switch_get_active(GTK_SWITCH(w->gtk)));
}

static JSValue switch_set_active(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_switch_set_active(GTK_SWITCH(w->gtk), b);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry switch_props[] = {
    JS_CGETSET_DEF("Active", switch_get_active, switch_set_active),
};

/* --------------------------------------------------------------- ListBox */

static void on_row_selected(GtkListBox *lb, GtkListBoxRow *row, gpointer user_data)
{
    if (row)
        bta_emit((BtaWidget *)user_data, "Select", 0, NULL);
}

/*
 * Selecting more than one row is a different signal: GtkListBox reports a single
 * selection through `row-selected` and a multiple one through
 * `selected-rows-changed`, and it emits the second in both modes -- so this has
 * to stay quiet while the first is doing the talking, or every single selection
 * would arrive twice.
 *
 * Emitted only when something is selected, which is what `Select` has always
 * meant here: a list that just went empty did not select anything.
 */
static void on_rows_changed(GtkListBox *lb, gpointer user_data)
{
    BtaWidget *w = user_data;

    if (gtk_list_box_get_selection_mode(lb) != GTK_SELECTION_MULTIPLE)
        return;

    GList *rows = gtk_list_box_get_selected_rows(lb);
    if (rows)
        bta_emit(w, "Select", 0, NULL);
    g_list_free(rows);
}

/*
 * Choosing a row, which is not the same as landing on one.
 *
 * `Select` is where the highlight is -- it fires on every arrow key -- and
 * `Activate` is the user saying *this one*: a double click, or Enter. Every
 * other list in this runtime already told the two apart (`TreeView` and
 * `TableView` both raise `Activate`), and a `ListBox` raising only `Select` made
 * "open what I picked" impossible to write without watching for double clicks by
 * hand.
 */
static void on_row_activated(GtkListBox *box, GtkListBoxRow *row,
                             gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Activate", 0, NULL);
}

static void build_listbox(BtaWidget *w)
{
    w->inner = gtk_list_box_new();
    gtk_list_box_set_selection_mode(GTK_LIST_BOX(w->inner), GTK_SELECTION_SINGLE);
    /* A double click, like every other list here: one click is where the
     * highlight goes and two are a decision. */
    gtk_list_box_set_activate_on_single_click(GTK_LIST_BOX(w->inner), FALSE);

    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->inner);

    g_signal_connect(w->inner, "row-selected", G_CALLBACK(on_row_selected), w);
    g_signal_connect(w->inner, "selected-rows-changed",
                     G_CALLBACK(on_rows_changed), w);
    g_signal_connect(w->inner, "row-activated", G_CALLBACK(on_row_activated), w);
}

/*
 * ...or one click, for a list that *is* the choice -- a palette, a picker in a
 * popover, anywhere the row is not something one browses before deciding.
 */
static JSValue listbox_get_single(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx,
        gtk_list_box_get_activate_on_single_click(GTK_LIST_BOX(w->inner)));
}

static JSValue listbox_set_single(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    gtk_list_box_set_activate_on_single_click(GTK_LIST_BOX(w->inner), b);
    return JS_UNDEFINED;
}

static int listbox_count(BtaWidget *w)
{
    int n = 0;
    while (gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), n))
        n++;
    return n;
}

static const char *row_text(GtkListBoxRow *row)
{
    if (!row)
        return NULL;
    GtkWidget *child = gtk_list_box_row_get_child(row);
    return GTK_IS_LABEL(child) ? gtk_label_get_text(GTK_LABEL(child)) : NULL;
}

static void listbox_append(BtaWidget *w, const char *text)
{
    GtkWidget *label = gtk_label_new(text);
    gtk_label_set_xalign(GTK_LABEL(label), 0.0f);
    gtk_widget_set_margin_start(label, 4);
    gtk_widget_set_margin_end(label, 4);
    gtk_list_box_append(GTK_LIST_BOX(w->inner), label);
}

static void listbox_clear(BtaWidget *w)
{
    GtkListBoxRow *row;
    while ((row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), 0)))
        gtk_list_box_remove(GTK_LIST_BOX(w->inner), GTK_WIDGET(row));
}

static JSValue listbox_get_items(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue arr = JS_NewArray(ctx);
    int     n   = listbox_count(w);
    for (int i = 0; i < n; i++) {
        const char *t = row_text(gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), i));
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, t ? t : ""));
    }
    return arr;
}

static JSValue listbox_set_items(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!JS_IsArray(val))
        return JS_ThrowTypeError(ctx, "Items expects an array");

    JSValue  lenv = JS_GetPropertyStr(ctx, val, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    listbox_clear(w);
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, val, i);
        const char *s = JS_ToCString(ctx, e);
        listbox_append(w, s ? s : "");
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
    }
    return JS_UNDEFINED;
}

/*
 * The first selected row, whatever the selection mode.  Walked by index rather
 * than asked of GTK, because `gtk_list_box_get_selected_row` answers NULL in
 * multiple mode -- so `Index` and `Text` would have gone blank the moment
 * MultiSelect was turned on, on a list with three rows selected.
 */
static GtkListBoxRow *listbox_first_selected(BtaWidget *w)
{
    int n = listbox_count(w);

    for (int i = 0; i < n; i++) {
        GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), i);
        if (row && gtk_list_box_row_is_selected(row))
            return row;
    }
    return NULL;
}

static JSValue listbox_get_index(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkListBoxRow *row = listbox_first_selected(w);
    return JS_NewInt32(ctx, row ? gtk_list_box_row_get_index(row) : -1);
}

static JSValue listbox_set_index(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (!bta_to_int(ctx, val, "Index", &i))
        return JS_EXCEPTION;

    if (i < 0) {
        gtk_list_box_unselect_all(GTK_LIST_BOX(w->inner));
    } else {
        GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), i);
        if (row)
            gtk_list_box_select_row(GTK_LIST_BOX(w->inner), row);
    }
    return JS_UNDEFINED;
}

static JSValue listbox_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *t = row_text(listbox_first_selected(w));
    return JS_NewString(ctx, t ? t : "");
}

/* ------------------------------------------------- ListBox: more than one */

static JSValue listbox_get_multi(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    return JS_NewBool(ctx, gtk_list_box_get_selection_mode(GTK_LIST_BOX(w->inner))
                               == GTK_SELECTION_MULTIPLE);
}

static JSValue listbox_set_multi(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    /* Not NONE for the off case: a list nobody can select in is a different
     * control, and Index would stop answering. */
    gtk_list_box_set_selection_mode(GTK_LIST_BOX(w->inner),
                                   b ? GTK_SELECTION_MULTIPLE
                                     : GTK_SELECTION_SINGLE);
    return JS_UNDEFINED;
}

/*
 * Which rows are selected, ascending.  Read-only on purpose: what is selected is
 * a fact about the moment and not part of the design, and a setter would have the
 * serialiser write it into the `.form`.  `Select` and `Deselect` are how it
 * changes -- one row at a time, the way a user changes it.
 */
static JSValue listbox_get_selection(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue arr = JS_NewArray(ctx);
    int     n   = listbox_count(w);
    uint32_t k  = 0;

    for (int i = 0; i < n; i++) {
        GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), i);
        if (row && gtk_list_box_row_is_selected(row))
            JS_SetPropertyUint32(ctx, arr, k++, JS_NewInt32(ctx, i));
    }
    return arr;
}

enum { LB_SELECT, LB_DESELECT };

static JSValue listbox_select_one(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (argc < 1 || JS_ToInt32(ctx, &i, argv[0]))
        return JS_EXCEPTION;

    GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), i);
    if (!row)
        return JS_NewBool(ctx, false);      /* no such row: not an error */

    if (magic == LB_SELECT)
        gtk_list_box_select_row(GTK_LIST_BOX(w->inner), row);
    else
        gtk_list_box_unselect_row(GTK_LIST_BOX(w->inner), row);
    return JS_NewBool(ctx, true);
}

/* Everything, or nothing.  Selecting all of a single-selection list would be one
 * row, so it says so instead of doing something surprising. */
static JSValue listbox_select_all(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkListBox *lb = GTK_LIST_BOX(w->inner);
    if (gtk_list_box_get_selection_mode(lb) != GTK_SELECTION_MULTIPLE)
        return JS_ThrowTypeError(ctx, "SelectAll needs MultiSelect");

    gtk_list_box_select_all(lb);
    return JS_UNDEFINED;
}

static JSValue listbox_deselect_all(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    gtk_list_box_unselect_all(GTK_LIST_BOX(w->inner));
    return JS_UNDEFINED;
}

static JSValue listbox_get_count(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, listbox_count(w));
}

static JSValue listbox_add(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    listbox_append(w, s ? s : "");
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue listbox_clear_js(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    listbox_clear(w);
    return JS_UNDEFINED;
}

static JSValue listbox_remove(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (argc < 1 || JS_ToInt32(ctx, &i, argv[0]))
        return JS_EXCEPTION;

    GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), i);
    if (row)
        gtk_list_box_remove(GTK_LIST_BOX(w->inner), GTK_WIDGET(row));
    return JS_UNDEFINED;
}

/*
 * Choosing a row from code, the way `Button.Click()` presses a button: what the
 * user's double click does, without one. A program that has just written the row
 * it wants selected should be able to say "and this is the one" in the same
 * sentence -- and it is what lets the event be tested at all, since a signal
 * nothing can raise is a signal nothing can check.
 *
 * Without an argument it is the row that is already current, which is what Enter
 * does on a list somebody has arrowed down.
 */
static JSValue listbox_activate(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int index;
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (JS_ToInt32(ctx, &index, argv[0]))
            return JS_EXCEPTION;
    } else {
        GtkListBoxRow *at = gtk_list_box_get_selected_row(GTK_LIST_BOX(w->inner));
        index = at ? gtk_list_box_row_get_index(at) : -1;
    }

    GtkListBoxRow *row = index >= 0
        ? gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->inner), index) : NULL;

    /* Nothing there is nothing to choose, and not an error: a list one has not
     * selected in yet is an ordinary state. */
    if (!row)
        return JS_UNDEFINED;

    /*
     * Selected first, because that is what the double click did: `Activate`
     * carries no row of its own -- `TreeView`'s does not either -- so the
     * handler asks the list which one, and the list has to already know.
     */
    gtk_list_box_select_row(GTK_LIST_BOX(w->inner), row);
    g_signal_emit_by_name(w->inner, "row-activated", row);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry listbox_props[] = {
    JS_CGETSET_DEF("Items", listbox_get_items, listbox_set_items),
    JS_CGETSET_DEF("Index", listbox_get_index, listbox_set_index),
    JS_CGETSET_DEF("Text",  listbox_get_text,  NULL),
    JS_CGETSET_DEF("Count", listbox_get_count, NULL),
    JS_CGETSET_DEF("MultiSelect", listbox_get_multi,     listbox_set_multi),
    JS_CGETSET_DEF("Selection",   listbox_get_selection, NULL),
    JS_CGETSET_DEF("ActivateOnSingleClick",
                   listbox_get_single, listbox_set_single),
    JS_CFUNC_DEF("Add",    1, listbox_add),
    JS_CFUNC_DEF("Clear",  0, listbox_clear_js),
    JS_CFUNC_DEF("Remove", 1, listbox_remove),
    JS_CFUNC_MAGIC_DEF("Select",   1, listbox_select_one, LB_SELECT),
    JS_CFUNC_MAGIC_DEF("Deselect", 1, listbox_select_one, LB_DESELECT),
    JS_CFUNC_DEF("Activate", 1, listbox_activate),
    JS_CFUNC_DEF("SelectAll",   0, listbox_select_all),
    JS_CFUNC_DEF("DeselectAll", 0, listbox_deselect_all),
};

/* -------------------------------------------------------------- ComboBox */

/*
 * A GtkDropDown over a GtkStringList: one choice out of a closed list.  The
 * list is the model, so Items is the whole state and Index/Text are views over
 * the selection -- the same shape as ListBox, which is what makes the two
 * interchangeable in a form.
 *
 * Unlike a ListBox it is never left showing nothing: GTK keeps one item
 * selected as long as there is one, so Index is -1 only while the list is
 * empty, and Text refuses a value the list does not have instead of quietly
 * showing a different one.
 */
static void on_combo_selected(GObject *obj, GParamSpec *pspec, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Select", 0, NULL);
}

static void build_combobox(BtaWidget *w)
{
    /* gtk_drop_down_new() takes the model; with a GtkStringList and no factory
     * of our own it installs the default one, which renders the strings. */
    w->gtk = gtk_drop_down_new(G_LIST_MODEL(gtk_string_list_new(NULL)), NULL);
    g_signal_connect(w->gtk, "notify::selected", G_CALLBACK(on_combo_selected), w);
}

static GtkStringList *combo_model(BtaWidget *w)
{
    return GTK_STRING_LIST(gtk_drop_down_get_model(GTK_DROP_DOWN(w->gtk)));
}

static guint combo_count(BtaWidget *w)
{
    return g_list_model_get_n_items(G_LIST_MODEL(combo_model(w)));
}

static JSValue combo_get_items(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue arr = JS_NewArray(ctx);
    guint   n   = combo_count(w);
    for (guint i = 0; i < n; i++) {
        const char *s = gtk_string_list_get_string(combo_model(w), i);
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, s ? s : ""));
    }
    return arr;
}

static JSValue combo_set_items(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!JS_IsArray(val))
        return JS_ThrowTypeError(ctx, "Items expects an array");

    JSValue  lenv = JS_GetPropertyStr(ctx, val, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    /* Build the whole strv first: splicing it in one call means one selection
     * change, so a handler never sees a half-filled list. */
    char **strv = g_new0(char *, n + 1);
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, val, i);
        const char *s = JS_ToCString(ctx, e);
        strv[i] = g_strdup(s ? s : "");
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
    }

    /* One splice, not a clear plus n appends: the selection then moves once,
     * so a Select handler never sees a half-filled list. */
    gtk_string_list_splice(combo_model(w), 0, combo_count(w), (const char *const *)strv);
    g_strfreev(strv);
    return JS_UNDEFINED;
}

static JSValue combo_get_index(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    guint sel = gtk_drop_down_get_selected(GTK_DROP_DOWN(w->gtk));
    return JS_NewInt32(ctx, sel == GTK_INVALID_LIST_POSITION ? -1 : (int)sel);
}

static JSValue combo_set_index(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (!bta_to_int(ctx, val, "Index", &i))
        return JS_EXCEPTION;

    /* Out of range leaves the selection alone, as it does on a ListBox. */
    if (i >= 0 && (guint)i < combo_count(w))
        gtk_drop_down_set_selected(GTK_DROP_DOWN(w->gtk), (guint)i);
    return JS_UNDEFINED;
}

static JSValue combo_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    guint sel = gtk_drop_down_get_selected(GTK_DROP_DOWN(w->gtk));
    if (sel == GTK_INVALID_LIST_POSITION)
        return JS_NewString(ctx, "");

    const char *s = gtk_string_list_get_string(combo_model(w), sel);
    return JS_NewString(ctx, s ? s : "");
}

/*
 * Setting Text picks the matching item.  A value that is not in the list is an
 * error rather than a no-op, because the alternative is a control that reads
 * back something other than what was just assigned to it.  In a .form the
 * items have to come first; the serialiser writes them in that order.
 */
static JSValue combo_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    guint found = GTK_INVALID_LIST_POSITION;
    guint n     = combo_count(w);
    for (guint i = 0; i < n && found == GTK_INVALID_LIST_POSITION; i++) {
        const char *item = gtk_string_list_get_string(combo_model(w), i);
        if (item && !strcmp(item, s))
            found = i;
    }

    if (found == GTK_INVALID_LIST_POSITION && (n > 0 || *s)) {
        JSValue e = JS_ThrowRangeError(ctx, "'%s' is not one of %s's items", s,
                                       w->name ? w->name : "the combo");
        JS_FreeCString(ctx, s);
        return e;
    }
    if (found != GTK_INVALID_LIST_POSITION)
        gtk_drop_down_set_selected(GTK_DROP_DOWN(w->gtk), found);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue combo_get_count(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, (int)combo_count(w));
}

static JSValue combo_add(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    gtk_string_list_append(combo_model(w), s ? s : "");
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue combo_clear(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    gtk_string_list_splice(combo_model(w), 0, combo_count(w), NULL);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry combobox_props[] = {
    JS_CGETSET_DEF("Items", combo_get_items, combo_set_items),
    JS_CGETSET_DEF("Index", combo_get_index, combo_set_index),
    JS_CGETSET_DEF("Text",  combo_get_text,  combo_set_text),
    JS_CGETSET_DEF("Count", combo_get_count, NULL),
    JS_CFUNC_DEF("Add",   1, combo_add),
    JS_CFUNC_DEF("Clear", 0, combo_clear),
};

/* --------------------------------------------------------------- SpinBox */

static void on_spin_changed(GtkSpinButton *b, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Change", 0, NULL);
}

static void on_spin_activate(GtkSpinButton *b, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Activate", 0, NULL);
}

/*
 * The range is wide by default on purpose: properties are applied in whatever
 * order they appear in the .form, so a narrow starting range would silently
 * clamp a Value set before its Max.  Width comes from width-chars instead of
 * from the range, or a spin that accepts six digits would be drawn six digits
 * wide even when it holds 8.
 */
static void build_spinbox(BtaWidget *w)
{
    w->gtk = gtk_spin_button_new_with_range(-1000000, 1000000, 1);
    gtk_spin_button_set_numeric(GTK_SPIN_BUTTON(w->gtk), TRUE);
    gtk_spin_button_set_value(GTK_SPIN_BUTTON(w->gtk), 0);
    gtk_editable_set_width_chars(GTK_EDITABLE(w->gtk), 6);
    gtk_editable_set_max_width_chars(GTK_EDITABLE(w->gtk), 6);

    g_signal_connect(w->gtk, "value-changed", G_CALLBACK(on_spin_changed),  w);
    g_signal_connect(w->gtk, "activate",      G_CALLBACK(on_spin_activate), w);
}

enum { SPIN_VALUE, SPIN_MIN, SPIN_MAX, SPIN_STEP, SPIN_DECIMALS };

static JSValue spin_get(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSpinButton *sb = GTK_SPIN_BUTTON(w->gtk);
    double lo, hi, step;

    switch (magic) {
    case SPIN_VALUE: {
        /* Rounded to the digits it displays: GTK snaps the value that way when
         * the user types one, so reading back a value set from code has to
         * agree with reading back the same value typed into the box. */
        double f = pow(10, gtk_spin_button_get_digits(sb));
        return JS_NewFloat64(ctx, round(gtk_spin_button_get_value(sb) * f) / f);
    }
    case SPIN_DECIMALS:
        return JS_NewInt32(ctx, (int)gtk_spin_button_get_digits(sb));
    case SPIN_STEP:
        gtk_spin_button_get_increments(sb, &step, NULL);
        return JS_NewFloat64(ctx, step);
    default:
        gtk_spin_button_get_range(sb, &lo, &hi);
        return JS_NewFloat64(ctx, magic == SPIN_MIN ? lo : hi);
    }
}

static JSValue spin_set(JSContext *ctx, JSValueConst this_val,
                        JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    static const char *const NAMES[] = { "Value", "Min", "Max", "Step",
                                         "Decimals" };
    double v;
    if (!bta_to_number(ctx, val,
                       magic >= 0 && magic < (int)G_N_ELEMENTS(NAMES)
                           ? NAMES[magic] : "SpinBox", &v))
        return JS_EXCEPTION;

    GtkSpinButton *sb = GTK_SPIN_BUTTON(w->gtk);
    double lo, hi;

    switch (magic) {
    case SPIN_VALUE:
        gtk_spin_button_set_value(sb, v);
        break;
    case SPIN_DECIMALS:
        gtk_spin_button_set_digits(sb, (guint)(v < 0 ? 0 : v));
        break;
    case SPIN_STEP:
        /* Page is what PageUp moves by; ten steps is the usual feel. */
        gtk_spin_button_set_increments(sb, v, v * 10);
        break;
    default:
        gtk_spin_button_get_range(sb, &lo, &hi);
        if (magic == SPIN_MIN) lo = v;
        else                   hi = v;
        gtk_spin_button_set_range(sb, lo, hi);
        break;
    }
    return JS_UNDEFINED;
}

/*
 * Two habits a spin box can have, and both are about what the *box* does rather
 * than what it holds.
 *
 * `Wrap` is the hour that goes 23 -> 00: a field whose range is a circle, which
 * is a property of the quantity and not of the widget style.
 *
 * `Numeric` is the box refusing letters as they are typed, and it is **on**:
 * `gtk_spin_button_new_with_range` turns it on and this runtime keeps it that
 * way, because a box with arrows on it that accepts "hola" is a surprise. What
 * turning it off is for is the box that also takes a word -- a page number that
 * accepts `end`, a size that accepts `auto` -- where the program parses what was
 * typed itself.
 *
 * There is deliberately no `Page`: `Step` already sets what PageUp moves by --
 * ten steps -- and a `Page` that the next assignment to `Step` quietly undid
 * would be worse than not having one.
 */
enum { SPIN_WRAP, SPIN_NUMERIC };

static JSValue spin_get_flag(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSpinButton *sb = GTK_SPIN_BUTTON(w->gtk);
    return JS_NewBool(ctx, magic == SPIN_WRAP ? gtk_spin_button_get_wrap(sb)
                                              : gtk_spin_button_get_numeric(sb));
}

static JSValue spin_set_flag(JSContext *ctx, JSValueConst this_val,
                             JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    GtkSpinButton *sb = GTK_SPIN_BUTTON(w->gtk);
    if (magic == SPIN_WRAP) gtk_spin_button_set_wrap(sb, b);
    else                    gtk_spin_button_set_numeric(sb, b);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry spinbox_props[] = {
    JS_CGETSET_MAGIC_DEF("Value",    spin_get, spin_set, SPIN_VALUE),
    JS_CGETSET_MAGIC_DEF("Min",      spin_get, spin_set, SPIN_MIN),
    JS_CGETSET_MAGIC_DEF("Max",      spin_get, spin_set, SPIN_MAX),
    JS_CGETSET_MAGIC_DEF("Step",     spin_get, spin_set, SPIN_STEP),
    JS_CGETSET_MAGIC_DEF("Decimals", spin_get, spin_set, SPIN_DECIMALS),
    JS_CGETSET_MAGIC_DEF("Wrap",     spin_get_flag, spin_set_flag, SPIN_WRAP),
    JS_CGETSET_MAGIC_DEF("Numeric",  spin_get_flag, spin_set_flag, SPIN_NUMERIC),
};

/* ---------------------------------------------------------- ToggleButton */

/*
 * A button that stays in.  It is a GtkButton, so Text and Icon are the button's
 * own accessors -- what it adds is a Value that can be read and written, and a
 * Click that reports the new state rather than the press.
 */
static void on_toggle_toggled(GtkToggleButton *b, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Click", 0, NULL);
}

static void build_togglebutton(BtaWidget *w)
{
    w->gtk = gtk_toggle_button_new();
    g_signal_connect(w->gtk, "toggled", G_CALLBACK(on_toggle_toggled), w);
}

static JSValue toggle_get_active(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(w->gtk)));
}

static JSValue toggle_set_active(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(w->gtk), b);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry togglebutton_props[] = {
    JS_CGETSET_DEF("Text",  button_get_text, button_set_text),
    JS_CGETSET_DEF("Icon",  button_get_icon, button_set_icon),
    JS_CGETSET_DEF("Active", toggle_get_active, toggle_set_active),
    JS_CFUNC_DEF("Click", 0, button_click),
};

/* ----------------------------------------------------------- Orientation */

/*
 * Which way a control that can go either way goes.  One accessor for all of
 * them, because GtkOrientable is exactly what they have in common -- and the
 * word is not `Arrangement`: that one says what a *container* does with its
 * children, and these have none.
 */
static JSValue orient_get(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkOrientation o = gtk_orientable_get_orientation(GTK_ORIENTABLE(w->gtk));
    return JS_NewString(ctx, o == GTK_ORIENTATION_VERTICAL ? "Vertical"
                                                           : "Horizontal");
}

static JSValue orient_set(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkOrientation o;
    if (!strcmp(s, "Horizontal"))    o = GTK_ORIENTATION_HORIZONTAL;
    else if (!strcmp(s, "Vertical")) o = GTK_ORIENTATION_VERTICAL;
    else {
        JSValue e = JS_ThrowRangeError(ctx, "Orientation: '%s' is not "
                                           "Horizontal or Vertical", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    gtk_orientable_set_orientation(GTK_ORIENTABLE(w->gtk), o);
    return JS_UNDEFINED;
}

static const char *orient_options(const char *prop)
{
    return !strcmp(prop, "Orientation") ? "Horizontal,Vertical" : NULL;
}

/* ---------------------------------------------------------------- Picture
 *
 * An image that fills the room it is given, which is the one thing `Image`
 * deliberately does not do.
 *
 * **They are two controls because they answer two questions.** `Image` is a
 * `GtkImage`: it draws an *icon* -- a name from the desktop's theme, or a small
 * file standing in for one -- at its natural size, and refusing to scale is
 * exactly what one wants there, since an icon blown up to 300px is a blurry
 * mistake and the theme has a proper 48px file for the asking. `Picture` is a
 * `GtkPicture`: it draws a *photograph*, and a photograph that is not scaled to
 * the space it was given is not being shown.
 *
 * `Fit` is the whole of the difference between showing one and showing it well,
 * and the four words are GTK's own: `Contain` (all of it, letterboxed -- the
 * default and what a viewer wants), `Cover` (fills the frame, cropping what does
 * not fit -- what a thumbnail wants), `Fill` (stretched, distorted, and
 * occasionally what is meant), `ScaleDown` (natural size, shrunk only if it does
 * not fit -- which is `Image`'s behaviour, available here for the case that
 * wants both).
 *
 * **What it cannot do is SVG.** `GdkTexture` reads PNG, JPEG and TIFF; anything
 * else is the pixbuf loaders' business, which is how `Image` gets scalable icons
 * and this does not. Said out loud in the error rather than left as a file that
 * silently shows nothing.
 *
 * `Zoom` is the other half of showing an image: `Fit` says what to do with the
 * room there is, and `Zoom` says to ignore the room and draw at a size of one's
 * own -- which inside a `Scroller` is what panning around a photograph means.
 * Zero, the default, leaves it to `Fit`.
 *
 * **What is deliberately not here is rotation and the scaling filter**, and it
 * is worth writing down why rather than discovering it twice. GTK's own
 * `image_scaling` demo does both, and to do them it does *not* use a
 * `GtkPicture`: it writes a widget of its own with a `snapshot` that appends the
 * texture scaled and transformed, because a `GdkPaintable` in a `GtkPicture` is
 * drawn the way GTK decides. Adding them here means the same custom widget --
 * `bta_fixed.c` is the precedent that this codebase can write one -- and it is a
 * piece of work with a design of its own, not a property.
 *
 * The same demo shows the other thing this does not do: it decodes in a thread,
 * with a wait cursor and a cancellable, because a large photograph takes long
 * enough to freeze a window. `File` here is synchronous and honest about it.
 */
/*
 * A texture out of bytes in memory, which is the half of showing a picture this
 * runtime could not do.
 *
 * `Http` answers a body as `Bytes` and `File.LoadBytes` reads one, and the only
 * thing that could *show* an image wanted a path -- so the whole of "download it
 * and show it" was a temporary file, written and deleted around a control that
 * would rather have been handed the bytes. GDK decodes from memory as readily as
 * from a file (`gdk_texture_new_from_bytes`, which sniffs the format the way the
 * filename version does), so the gap was never GTK's.
 *
 * The complaint is the setter's, and it names what it got rather than what it
 * wanted: `Bytes` that are not an image is the ordinary failure here -- an HTTP
 * error page answered with 200, most often -- and *cannot show 1.2 kB: unknown
 * image format* is the sentence that ends that hunt.
 */
GdkTexture *bta_texture_from_bytes(JSContext *ctx, JSValueConst val,
                                   const char *who)
{
    size_t         len  = 0;
    const uint8_t *data = bta_bytes_get(val, &len);

    if (!data) {
        JS_ThrowTypeError(ctx, "%s expects Bytes -- what Http answers with and "
                               "File.LoadBytes reads", who);
        return NULL;
    }
    if (!len) {
        JS_ThrowRangeError(ctx, "%s: no bytes at all", who);
        return NULL;
    }

    GBytes     *held    = g_bytes_new(data, len);
    GError     *error   = NULL;
    GdkTexture *texture = gdk_texture_new_from_bytes(held, &error);

    g_bytes_unref(held);
    if (!texture) {
        JS_ThrowTypeError(ctx, "%s: cannot show %zu bytes: %s", who, len,
                          error ? error->message : "not an image");
        g_clear_error(&error);
        return NULL;
    }
    return texture;
}

#define PIC_FILE_KEY "bta-picture-file"
#define PIC_ZOOM_KEY "bta-picture-zoom"

/*
 * A texture that reports a different size than it has.
 *
 * **Zooming cannot be done with `gtk_widget_set_size_request`**, which was the
 * first attempt and lasted until a picture was moved between containers: that
 * call is the *runtime's* own channel -- `widget_apply_align` re-applies the
 * declared `Width`/`Height` on every adoption and every relayout, so a request
 * made behind its back is wiped the next time anything moves. Writing the zoom
 * into `w->w`/`w->h` instead would have been worse: those are what the
 * serialiser saves, so the zoom would have ended up in the `.form` as a size
 * nobody drew.
 *
 * What a widget's natural size actually comes from, for a `GtkPicture`, is the
 * paintable -- so the zoom belongs there. This wraps the texture and answers a
 * scaled intrinsic size, drawing it into whatever room it is given; GTK's own
 * `image_scaling` demo does the same arithmetic by hand in a custom widget's
 * `snapshot`, which is the same idea one level lower.
 */
#define BTA_TYPE_ZOOMED (bta_zoomed_get_type())
G_DECLARE_FINAL_TYPE(BtaZoomed, bta_zoomed, BTA, ZOOMED, GObject)

struct _BtaZoomed {
    GObject       parent_instance;
    GdkPaintable *source;
    double        zoom;
};

static void bta_zoomed_snapshot(GdkPaintable *paintable, GdkSnapshot *snapshot,
                                double width, double height)
{
    BtaZoomed *self = BTA_ZOOMED(paintable);
    if (self->source)
        gdk_paintable_snapshot(self->source, snapshot, width, height);
}

static int bta_zoomed_get_width(GdkPaintable *paintable)
{
    BtaZoomed *self = BTA_ZOOMED(paintable);
    return self->source
        ? (int)(gdk_paintable_get_intrinsic_width(self->source) * self->zoom) : 0;
}

static int bta_zoomed_get_height(GdkPaintable *paintable)
{
    BtaZoomed *self = BTA_ZOOMED(paintable);
    return self->source
        ? (int)(gdk_paintable_get_intrinsic_height(self->source) * self->zoom) : 0;
}

static double bta_zoomed_get_ratio(GdkPaintable *paintable)
{
    BtaZoomed *self = BTA_ZOOMED(paintable);
    return self->source ? gdk_paintable_get_intrinsic_aspect_ratio(self->source) : 0;
}

static void zoomed_iface_init(GdkPaintableInterface *iface)
{
    iface->snapshot              = bta_zoomed_snapshot;
    iface->get_intrinsic_width   = bta_zoomed_get_width;
    iface->get_intrinsic_height  = bta_zoomed_get_height;
    iface->get_intrinsic_aspect_ratio = bta_zoomed_get_ratio;
}

G_DEFINE_TYPE_WITH_CODE(BtaZoomed, bta_zoomed, G_TYPE_OBJECT,
    G_IMPLEMENT_INTERFACE(GDK_TYPE_PAINTABLE, zoomed_iface_init))

static void bta_zoomed_finalize(GObject *object)
{
    g_clear_object(&BTA_ZOOMED(object)->source);
    G_OBJECT_CLASS(bta_zoomed_parent_class)->finalize(object);
}

static void bta_zoomed_class_init(BtaZoomedClass *klass)
{
    G_OBJECT_CLASS(klass)->finalize = bta_zoomed_finalize;
}

static void bta_zoomed_init(BtaZoomed *self) { self->zoom = 1.0; }

static void build_picture(BtaWidget *w)
{
    w->gtk = gtk_picture_new();

    /* A picture with nothing in it asks for no room at all, which inside a
     * `Fixed` is a control one cannot select or drop anything on. The floor
     * lasts exactly as long as it is empty -- see `picture_apply_zoom`. */
    gtk_widget_set_size_request(w->gtk, 32, 32);
}

/*
 * The size a zoomed picture asks for, worked out from the file it is showing --
 * so it has to be redone when the file changes as well as when the zoom does,
 * or the second image in a viewer would be drawn at the first one's size.
 */
#define PIC_TEXTURE_KEY "bta-picture-texture"

static void picture_apply_zoom(BtaWidget *w)
{
    gpointer  stored  = g_object_get_data(G_OBJECT(w->gtk), PIC_ZOOM_KEY);
    double    zoom    = stored ? *(double *)stored : 0.0;
    GdkTexture *texture = g_object_get_data(G_OBJECT(w->gtk), PIC_TEXTURE_KEY);

    if (!texture) {
        gtk_picture_set_paintable(GTK_PICTURE(w->gtk), NULL);
        return;
    }

    if (zoom <= 0) {
        /* The room's business again: the texture at its own intrinsic size,
         * shrinkable, and `Fit` deciding what to do with the space. */
        gtk_picture_set_can_shrink(GTK_PICTURE(w->gtk), TRUE);
        gtk_picture_set_paintable(GTK_PICTURE(w->gtk), GDK_PAINTABLE(texture));
        return;
    }

    BtaZoomed *zoomed = g_object_new(BTA_TYPE_ZOOMED, NULL);
    zoomed->source = GDK_PAINTABLE(g_object_ref(texture));
    zoomed->zoom   = zoom;

    /*
     * Filled and not shrinkable: at a size one asked for, letterboxing would be
     * the picture refusing it -- and a `Scroller` hands its child the *minimum*,
     * so a shrinkable one there is drawn at nothing at all.
     */
    gtk_picture_set_content_fit(GTK_PICTURE(w->gtk), GTK_CONTENT_FIT_FILL);
    gtk_picture_set_can_shrink(GTK_PICTURE(w->gtk), FALSE);
    gtk_picture_set_paintable(GTK_PICTURE(w->gtk), GDK_PAINTABLE(zoomed));
    g_object_unref(zoomed);
}

static JSValue picture_get_file(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = g_object_get_data(G_OBJECT(w->gtk), PIC_FILE_KEY);
    return JS_NewString(ctx, s ? s : "");
}

/*
 * Loaded through a texture rather than handed to `gtk_picture_set_filename`,
 * which reports nothing: a path that is missing, unreadable or not an image at
 * all would leave an empty frame and no way to tell which. A setter that throws
 * is the same bargain `Language` and `Theme` make.
 */
static JSValue picture_set_file(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *path = JS_ToCString(ctx, val);
    if (!path)
        return JS_EXCEPTION;

    if (!*path) {
        g_object_set_data(G_OBJECT(w->gtk), PIC_TEXTURE_KEY, NULL);
        g_object_set_data(G_OBJECT(w->gtk), PIC_FILE_KEY, NULL);
        picture_apply_zoom(w);
        JS_FreeCString(ctx, path);
        return JS_UNDEFINED;
    }

    GError    *error   = NULL;
    GdkTexture *texture = gdk_texture_new_from_filename(path, &error);

    if (!texture) {
        JSValue e = JS_ThrowTypeError(ctx, "cannot show %s: %s", path,
                                      error ? error->message : "not an image");
        g_clear_error(&error);
        JS_FreeCString(ctx, path);
        return e;
    }

    g_object_set_data_full(G_OBJECT(w->gtk), PIC_TEXTURE_KEY, texture, g_object_unref);
    g_object_set_data_full(G_OBJECT(w->gtk), PIC_FILE_KEY, g_strdup(path), g_free);
    picture_apply_zoom(w);      /* the new file's size, not the old one's */
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

/*
 * The same picture, out of memory instead of off the disk.
 *
 * A verb and not a property, which is the decision worth writing down: a
 * property in this runtime is a promise that the designer can edit it and the
 * `.form` can carry it, and a megabyte of JPEG is neither. `File` stays the
 * property -- it is a name, it round-trips, a form can declare one -- and what
 * arrives at run time arrives through a call.
 *
 * **One source at a time, the last one wins**, which is the rule `Image` already
 * had: bytes clear `File`, so reading it back says `""` rather than naming a
 * file that is not what is on screen.
 */
static JSValue picture_load_bytes(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "LoadBytes expects (bytes)");

    GdkTexture *texture = bta_texture_from_bytes(ctx, argv[0], "LoadBytes");
    if (!texture)
        return JS_EXCEPTION;

    g_object_set_data_full(G_OBJECT(w->gtk), PIC_TEXTURE_KEY, texture, g_object_unref);
    g_object_set_data(G_OBJECT(w->gtk), PIC_FILE_KEY, NULL);
    picture_apply_zoom(w);      /* these bytes' size, not the last file's */
    return JS_UNDEFINED;
}

static const char *const PIC_FIT[] = { "Fill", "Contain", "Cover", "ScaleDown" };

static JSValue picture_get_fit(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkContentFit fit = gtk_picture_get_content_fit(GTK_PICTURE(w->gtk));
    return JS_NewString(ctx, PIC_FIT[fit]);
}

static JSValue picture_set_fit(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;

    int which = -1;
    for (int i = 0; i < 4; i++)
        if (!g_ascii_strcasecmp(name, PIC_FIT[i]))
            which = i;

    if (which < 0) {
        JSValue e = JS_ThrowRangeError(ctx,
            "Fit: '%s' is not Fill, Contain, Cover or ScaleDown", name);
        JS_FreeCString(ctx, name);
        return e;
    }
    JS_FreeCString(ctx, name);

    gtk_picture_set_content_fit(GTK_PICTURE(w->gtk), (GtkContentFit)which);
    return JS_UNDEFINED;
}

/*
 * How big the picture really is, which is not how big the control is.
 *
 * A viewer needs both: the control's `Bounds()` to know the room, and this to
 * say "1920 x 1080" and to decide whether showing it at natural size is worth
 * offering. Read-only, so it stays out of the `.form` -- it is a fact about the
 * file and not a design decision.
 */
enum { PIC_SOURCE_W, PIC_SOURCE_H };

static JSValue picture_get_source(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* The file's own size, which is why it reads the texture and not the
     * paintable: a zoomed one reports the size it is being drawn at, and what a
     * viewer wants to put in its title bar is what the file really is. */
    GdkTexture *texture = g_object_get_data(G_OBJECT(w->gtk), PIC_TEXTURE_KEY);
    if (!texture)
        return JS_NewInt32(ctx, 0);

    return JS_NewInt32(ctx, magic == PIC_SOURCE_W
        ? gdk_texture_get_width(texture) : gdk_texture_get_height(texture));
}

/*
 * Drawn at its own size rather than at the room's.
 *
 * `Fit` answers "what do I do with the space I was given"; this answers "give me
 * the space I want" -- the size request becomes the natural size times the zoom,
 * so a `Scroller` around it gets something to scroll. Zero puts it back under
 * `Fit`'s control, which is what a picture on an ordinary form wants.
 */
static JSValue picture_get_zoom(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    gpointer stored = g_object_get_data(G_OBJECT(w->gtk), PIC_ZOOM_KEY);
    return JS_NewFloat64(ctx, stored ? *(double *)stored : 0.0);
}

static JSValue picture_set_zoom(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    double zoom;
    if (!bta_to_number(ctx, val, "Zoom", &zoom))
        return JS_EXCEPTION;
    if (zoom < 0)
        return JS_ThrowRangeError(ctx, "Zoom cannot be negative");

    double *kept = g_new(double, 1);
    *kept = zoom;
    g_object_set_data_full(G_OBJECT(w->gtk), PIC_ZOOM_KEY, kept, g_free);

    picture_apply_zoom(w);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry picture_props[] = {
    JS_CGETSET_DEF("File", picture_get_file, picture_set_file),
    JS_CFUNC_DEF("LoadBytes", 1, picture_load_bytes),
    JS_CGETSET_DEF("Fit",  picture_get_fit,  picture_set_fit),
    JS_CGETSET_DEF("Zoom", picture_get_zoom, picture_set_zoom),
    JS_CGETSET_MAGIC_DEF("SourceWidth",  picture_get_source, NULL, PIC_SOURCE_W),
    JS_CGETSET_MAGIC_DEF("SourceHeight", picture_get_source, NULL, PIC_SOURCE_H),
};

static const char *picture_options(const char *prop)
{
    return !strcmp(prop, "Fit") ? "Fill,Contain,Cover,ScaleDown" : NULL;
}

/* ---------------------------------------------------------------- Spinner
 *
 * The one thing missing from the vocabulary of "the program is doing
 * something": a `ProgressBar` says *how far along*, and most work does not know.
 * A spinner says only that there is work, which is the honest answer while a
 * child process runs or a file is read.
 *
 * `Active` and not GTK's own `spinning`, which is the one place the naming rule
 * beats mirroring the toolkit: everything here that is on or off says `Active`,
 * and a second word for the same question would be a thing to look up.
 */
static void build_spinner(BtaWidget *w)
{
    w->gtk = gtk_spinner_new();
}

static JSValue spinner_get_active(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_spinner_get_spinning(GTK_SPINNER(w->gtk)));
}

static JSValue spinner_set_active(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_spinner_set_spinning(GTK_SPINNER(w->gtk), b);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry spinner_props[] = {
    JS_CGETSET_DEF("Active", spinner_get_active, spinner_set_active),
};

/* ------------------------------------------------------------- LinkButton
 *
 * A button that is an address. Pressed, it hands the URI to the desktop --
 * which is the whole of it, and the reason it is not a `Button` with a
 * `Click` handler calling `Exec`: what opens a link is the user's browser and
 * the desktop knows which that is.
 */
static void build_linkbutton(BtaWidget *w)
{
    w->gtk = gtk_link_button_new_with_label("", "");
    g_signal_connect(w->gtk, "clicked", G_CALLBACK(on_button_clicked), w);
}

enum { LINK_TEXT, LINK_URI };

static JSValue link_get(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = magic == LINK_TEXT
        ? gtk_button_get_label(GTK_BUTTON(w->gtk))
        : gtk_link_button_get_uri(GTK_LINK_BUTTON(w->gtk));
    return JS_NewString(ctx, s ? s : "");
}

static JSValue link_set(JSContext *ctx, JSValueConst this_val,
                        JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    if (magic == LINK_TEXT) gtk_button_set_label(GTK_BUTTON(w->gtk), s);
    else                    gtk_link_button_set_uri(GTK_LINK_BUTTON(w->gtk), s);

    /* A link with no words shows the address, which is what one wants from a
     * link somebody only gave an address to. */
    if (magic == LINK_URI && !*gtk_button_get_label(GTK_BUTTON(w->gtk)))
        gtk_button_set_label(GTK_BUTTON(w->gtk), s);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry linkbutton_props[] = {
    JS_CGETSET_MAGIC_DEF("Text", link_get, link_set, LINK_TEXT),
    JS_CGETSET_MAGIC_DEF("Uri",  link_get, link_set, LINK_URI),
};

/* --------------------------------------------------------------- LevelBar
 *
 * A meter, which is not a progress bar and is drawn as one only by accident of
 * both being a filled strip: a progress bar says how far along a piece of work
 * is and ends; a level says how full something *is* -- a battery, a signal, a
 * disk -- and has no end. `Mode` is the difference the theme draws: continuous
 * fills, discrete shows blocks.
 */
static void build_levelbar(BtaWidget *w)
{
    w->gtk = gtk_level_bar_new();
}

enum { LEVEL_VALUE, LEVEL_MIN, LEVEL_MAX };

static JSValue level_get(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkLevelBar *bar = GTK_LEVEL_BAR(w->gtk);
    switch (magic) {
    case LEVEL_VALUE: return JS_NewFloat64(ctx, gtk_level_bar_get_value(bar));
    case LEVEL_MIN:   return JS_NewFloat64(ctx, gtk_level_bar_get_min_value(bar));
    default:          return JS_NewFloat64(ctx, gtk_level_bar_get_max_value(bar));
    }
}

static JSValue level_set(JSContext *ctx, JSValueConst this_val,
                         JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    static const char *const NAMES[] = { "Value", "Min", "Max" };
    double v;
    if (!bta_to_number(ctx, val,
                       magic >= 0 && magic < (int)G_N_ELEMENTS(NAMES)
                           ? NAMES[magic] : "LevelBar", &v))
        return JS_EXCEPTION;

    GtkLevelBar *bar = GTK_LEVEL_BAR(w->gtk);
    switch (magic) {
    case LEVEL_VALUE:
        /* Clamped rather than refused, the way a ProgressBar's is: a reading
         * out of range is a reading, and a meter that threw would take the
         * program down for a disk that filled up. */
        gtk_level_bar_set_value(bar, CLAMP(v, gtk_level_bar_get_min_value(bar),
                                              gtk_level_bar_get_max_value(bar)));
        break;
    case LEVEL_MIN: gtk_level_bar_set_min_value(bar, v); break;
    default:        gtk_level_bar_set_max_value(bar, v); break;
    }
    return JS_UNDEFINED;
}

static JSValue level_get_mode(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    return JS_NewString(ctx,
        gtk_level_bar_get_mode(GTK_LEVEL_BAR(w->gtk)) == GTK_LEVEL_BAR_MODE_DISCRETE
            ? "Discrete" : "Continuous");
}

static JSValue level_set_mode(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkLevelBarMode mode;
    if (!g_ascii_strcasecmp(s, "Continuous"))    mode = GTK_LEVEL_BAR_MODE_CONTINUOUS;
    else if (!g_ascii_strcasecmp(s, "Discrete")) mode = GTK_LEVEL_BAR_MODE_DISCRETE;
    else {
        JSValue e = JS_ThrowRangeError(ctx,
            "Mode: '%s' is not Continuous or Discrete", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    gtk_level_bar_set_mode(GTK_LEVEL_BAR(w->gtk), mode);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry levelbar_props[] = {
    JS_CGETSET_MAGIC_DEF("Value", level_get, level_set, LEVEL_VALUE),
    JS_CGETSET_MAGIC_DEF("Min",   level_get, level_set, LEVEL_MIN),
    JS_CGETSET_MAGIC_DEF("Max",   level_get, level_set, LEVEL_MAX),
    JS_CGETSET_DEF("Mode",        level_get_mode, level_set_mode),
    JS_CGETSET_DEF("Orientation", orient_get, orient_set),
};

static const char *level_options(const char *prop)
{
    if (!strcmp(prop, "Mode"))        return "Continuous,Discrete";
    if (!strcmp(prop, "Orientation")) return "Horizontal,Vertical";
    return NULL;
}


/* ------------------------------------------------------------- Separator */

/*
 * A rule: the line between one group of things and the next.
 *
 * The last of the plain controls to be missing, and it is missing because it is
 * the one nobody notices until a dialog has three groups of fields and nothing
 * between them. It uses less than it used to -- space and a heading say the same
 * thing more quietly -- and that is an argument about taste, not about whether a
 * widget set should have one.
 *
 * `Orientation` is the same word `Slider` and `ProgressBar` answer to, through
 * the same accessor: `GtkOrientable` is what the three have in common. Nothing
 * else, which is the point of it -- a separator that needed configuring would be
 * a `Frame`.
 *
 * **Its thickness is the line, not the room around it.** A `GtkSeparator` paints
 * its whole allocation, so a separator 12 high is a line 12 thick rather than a
 * line with space above and below. The room goes on `Margin`, which is the same
 * answer this runtime already gives for a form whose contents sit against the
 * frame.
 */
static void build_separator(BtaWidget *w)
{
    w->gtk = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
}

static const JSCFunctionListEntry separator_props[] = {
    JS_CGETSET_DEF("Orientation", orient_get, orient_set),
};

/* ----------------------------------------------------------- ProgressBar */

/*
 * How far along something is, as a percentage.
 *
 * 0 to 100 and not GTK's 0.0 to 1.0: a progress bar is filled in by a loop that
 * counted something, and `done / total * 100` is what that loop has.  Out of
 * range is clamped rather than refused -- a rounding error at the end of a long
 * job is not a bug in the program's arithmetic worth stopping it for.
 */
static void build_progressbar(BtaWidget *w)
{
    w->gtk = gtk_progress_bar_new();
}

enum { PROG_VALUE, PROG_SHOWTEXT };

static JSValue prog_get(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkProgressBar *pb = GTK_PROGRESS_BAR(w->gtk);
    if (magic == PROG_SHOWTEXT)
        return JS_NewBool(ctx, gtk_progress_bar_get_show_text(pb));

    /* Rounded, because what GTK keeps is the percentage divided by a hundred and
     * multiplying it back does not always land where it started: 42 comes back
     * as 42.000000000000006, and a property that will not round-trip is one a
     * property grid flickers on and a .form grows a decimal tail in. */
    double pct = gtk_progress_bar_get_fraction(pb) * 100.0;
    return JS_NewFloat64(ctx, round(pct * 10000.0) / 10000.0);
}

static JSValue prog_set(JSContext *ctx, JSValueConst this_val,
                        JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkProgressBar *pb = GTK_PROGRESS_BAR(w->gtk);

    if (magic == PROG_SHOWTEXT) {
        int b = JS_ToBool(ctx, val);
        if (b < 0)
            return JS_EXCEPTION;
        gtk_progress_bar_set_show_text(pb, b);
        return JS_UNDEFINED;
    }

    double v;
    if (!bta_to_number(ctx, val, "Value", &v))
        return JS_EXCEPTION;
    gtk_progress_bar_set_fraction(pb, CLAMP(v, 0.0, 100.0) / 100.0);
    return JS_UNDEFINED;
}

static JSValue prog_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *t = gtk_progress_bar_get_text(GTK_PROGRESS_BAR(w->gtk));
    return JS_NewString(ctx, t ? t : "");
}

/*
 * The text drawn over the bar.  Empty puts GTK's own percentage back, which is
 * what a bar with ShowText and nothing to say should read -- and NULL is how GTK
 * spells that, so an empty string cannot be stored as one.
 */
static JSValue prog_set_text(JSContext *ctx, JSValueConst this_val,
                             JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *t = JS_ToCString(ctx, val);
    if (!t)
        return JS_EXCEPTION;

    gtk_progress_bar_set_text(GTK_PROGRESS_BAR(w->gtk), *t ? t : NULL);
    JS_FreeCString(ctx, t);
    return JS_UNDEFINED;
}

/* For a job whose length nobody knows: the bar says "still working" instead of
 * pretending to a number it does not have. */
static JSValue prog_pulse(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    gtk_progress_bar_pulse(GTK_PROGRESS_BAR(w->gtk));
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry progressbar_props[] = {
    JS_CGETSET_MAGIC_DEF("Value",    prog_get, prog_set, PROG_VALUE),
    JS_CGETSET_MAGIC_DEF("ShowText", prog_get, prog_set, PROG_SHOWTEXT),
    JS_CGETSET_DEF("Text", prog_get_text, prog_set_text),
    JS_CGETSET_DEF("Orientation", orient_get, orient_set),
    JS_CFUNC_DEF("Pulse", 0, prog_pulse),
};

/* ---------------------------------------------------------------- Slider */

/*
 * A value picked by dragging.  The same four words a SpinBox uses for the same
 * four things -- Value, Min, Max, Step -- because they are the same question
 * asked with the mouse instead of the keyboard.
 */
static void on_slider_changed(GtkRange *r, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Change", 0, NULL);
}

static void build_slider(BtaWidget *w)
{
    w->gtk = gtk_scale_new_with_range(GTK_ORIENTATION_HORIZONTAL, 0, 100, 1);
    gtk_scale_set_draw_value(GTK_SCALE(w->gtk), FALSE);
    g_signal_connect(w->gtk, "value-changed", G_CALLBACK(on_slider_changed), w);
}

enum { SLIDE_VALUE, SLIDE_MIN, SLIDE_MAX, SLIDE_STEP, SLIDE_SHOWVALUE };

static JSValue slider_get(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkRange *r = GTK_RANGE(w->gtk);

    switch (magic) {
    case SLIDE_VALUE: {
        /* Rounded to the decimals it works in, the way a SpinBox reads back:
         * GTK snaps a *dragged* value to them, so a value set from code has to
         * come back the same as the one the user could have landed on. */
        double f = pow(10, gtk_scale_get_digits(GTK_SCALE(w->gtk)));
        return JS_NewFloat64(ctx, round(gtk_range_get_value(r) * f) / f);
    }
    case SLIDE_SHOWVALUE:
        return JS_NewBool(ctx, gtk_scale_get_draw_value(GTK_SCALE(w->gtk)));
    case SLIDE_STEP: {
        GtkAdjustment *a = gtk_range_get_adjustment(r);
        return JS_NewFloat64(ctx, gtk_adjustment_get_step_increment(a));
    }
    default: {
        GtkAdjustment *a = gtk_range_get_adjustment(r);
        return JS_NewFloat64(ctx, magic == SLIDE_MIN
                                      ? gtk_adjustment_get_lower(a)
                                      : gtk_adjustment_get_upper(a));
    }
    }
}

static JSValue slider_set(JSContext *ctx, JSValueConst this_val,
                          JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (magic == SLIDE_SHOWVALUE) {
        int b = JS_ToBool(ctx, val);
        if (b < 0)
            return JS_EXCEPTION;
        gtk_scale_set_draw_value(GTK_SCALE(w->gtk), b);
        return JS_UNDEFINED;
    }

    static const char *const NAMES[] = { "Value", "Min", "Max", "Step",
                                         "ShowValue" };
    double v;
    if (!bta_to_number(ctx, val,
                       magic >= 0 && magic < (int)G_N_ELEMENTS(NAMES)
                           ? NAMES[magic] : "Slider", &v))
        return JS_EXCEPTION;

    GtkRange      *r = GTK_RANGE(w->gtk);
    GtkAdjustment *a = gtk_range_get_adjustment(r);

    switch (magic) {
    case SLIDE_VALUE:
        gtk_range_set_value(r, v);
        break;
    case SLIDE_STEP:
        /* Page is what PageUp moves by; ten steps, as the SpinBox does. */
        gtk_adjustment_set_step_increment(a, v);
        gtk_adjustment_set_page_increment(a, v * 10);
        break;
    case SLIDE_MIN:
        gtk_adjustment_set_lower(a, v);
        break;
    default:
        gtk_adjustment_set_upper(a, v);
        break;
    }
    return JS_UNDEFINED;
}

/*
 * How many decimals the slider works in.
 *
 * `Decimals` and not GTK's `digits`, because a `SpinBox` already calls this
 * `Decimals` and it is the same question asked of the same kind of number. It is
 * a rounding and not only a label: the value the slider reports is snapped to
 * it, so a slider of whole numbers cannot hand a program 7.0000001.
 */
static JSValue slider_get_decimals(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gtk_scale_get_digits(GTK_SCALE(w->gtk)));
}

static JSValue slider_set_decimals(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Decimals", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "Decimals: %d is not a number of "
                                       "decimals", n);

    gtk_scale_set_digits(GTK_SCALE(w->gtk), n);
    return JS_UNDEFINED;
}

/* Which end the low values are at.  A volume that fills upwards and a vertical
 * slider that starts at the top are the same widget with this turned over. */
static JSValue slider_get_inverted(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_range_get_inverted(GTK_RANGE(w->gtk)));
}

static JSValue slider_set_inverted(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    gtk_range_set_inverted(GTK_RANGE(w->gtk), b);
    return JS_UNDEFINED;
}

/* Where the number shows, for the sliders that show one (`ShowValue`). */
static JSValue slider_get_valuepos(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    switch (gtk_scale_get_value_pos(GTK_SCALE(w->gtk))) {
    case GTK_POS_LEFT:   return JS_NewString(ctx, "Left");
    case GTK_POS_RIGHT:  return JS_NewString(ctx, "Right");
    case GTK_POS_BOTTOM: return JS_NewString(ctx, "Bottom");
    default:             return JS_NewString(ctx, "Top");
    }
}

static JSValue slider_set_valuepos(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkPositionType p;
    if      (!strcmp(s, "Top"))    p = GTK_POS_TOP;
    else if (!strcmp(s, "Bottom")) p = GTK_POS_BOTTOM;
    else if (!strcmp(s, "Left"))   p = GTK_POS_LEFT;
    else if (!strcmp(s, "Right"))  p = GTK_POS_RIGHT;
    else {
        JSValue e = JS_ThrowRangeError(ctx, "ValuePosition: '%s' is not Top, "
                                            "Bottom, Left or Right", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    gtk_scale_set_value_pos(GTK_SCALE(w->gtk), p);
    return JS_UNDEFINED;
}

/*
 * A tick on the rail, with a word under it if one is given.
 *
 * `Mark` and `ClearMarks`, which is what a `SourceEditor` calls the same idea --
 * something put *at* a place rather than a property of the whole. It is the
 * difference between a slider one drags blind and one that says where *Normal*
 * is; and the value the drag settles on snaps to a mark when it lands near it,
 * which is GTK's doing and the reason a mark is worth more than a label beside
 * the widget.
 */
static JSValue slider_mark(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    double at;
    if (argc < 1 || JS_ToFloat64(ctx, &at, argv[0]))
        return JS_ThrowTypeError(ctx, "Mark(value, text) needs a value");

    const char *text = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        text = JS_ToCString(ctx, argv[1]);
        if (!text)
            return JS_EXCEPTION;
    }

    /* Under a horizontal rail and beside a vertical one, which is where a
     * reading goes on each: the caller is saying what, not where. */
    GtkPositionType where =
        gtk_orientable_get_orientation(GTK_ORIENTABLE(w->gtk)) ==
            GTK_ORIENTATION_VERTICAL ? GTK_POS_RIGHT : GTK_POS_BOTTOM;

    gtk_scale_add_mark(GTK_SCALE(w->gtk), at, where, text);
    if (text)
        JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

static JSValue slider_clear_marks(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    gtk_scale_clear_marks(GTK_SCALE(w->gtk));
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry slider_props[] = {
    JS_CGETSET_MAGIC_DEF("Value",     slider_get, slider_set, SLIDE_VALUE),
    JS_CGETSET_MAGIC_DEF("Min",       slider_get, slider_set, SLIDE_MIN),
    JS_CGETSET_MAGIC_DEF("Max",       slider_get, slider_set, SLIDE_MAX),
    JS_CGETSET_MAGIC_DEF("Step",      slider_get, slider_set, SLIDE_STEP),
    JS_CGETSET_MAGIC_DEF("ShowValue", slider_get, slider_set, SLIDE_SHOWVALUE),
    JS_CGETSET_DEF("Decimals",      slider_get_decimals, slider_set_decimals),
    JS_CGETSET_DEF("Inverted",      slider_get_inverted, slider_set_inverted),
    JS_CGETSET_DEF("ValuePosition", slider_get_valuepos, slider_set_valuepos),
    JS_CGETSET_DEF("Orientation", orient_get, orient_set),
    JS_CFUNC_DEF("Mark",       2, slider_mark),
    JS_CFUNC_DEF("ClearMarks", 0, slider_clear_marks),
};

static const char *slider_options(const char *prop)
{
    if (!strcmp(prop, "ValuePosition")) return "Top,Bottom,Left,Right";
    return orient_options(prop);
}

/* --------------------------------------------- DatePicker and Calendar */

/*
 * Two controls over one GtkCalendar: a date on one line, and the month itself.
 *
 * GTK has a calendar and no date field, so the field is made here: a menu button
 * that reads as the date it holds, with the calendar in its popover.  What that
 * buys over a bare calendar is room -- a calendar is the size of a month, and a
 * form asking for a birthday has a line for it.  `Calendar` is the other answer
 * to the same question, for the form that has the room and wants the month
 * visible; it comes after the picker in this file and shares everything above
 * `build_datepicker` with it.
 *
 * `Value` is an ISO date ("2026-08-11") and not a Date object, because a `.form`
 * is JSON: a value that cannot be written down is one the designer cannot edit
 * and the serialiser would drop.  `Format` is what the button *reads* (strftime),
 * so the string a program compares and the text a person recognises do not have
 * to be the same one.
 *
 * The shared part is bigger than it looks, and it is why the two live together:
 * one parser, one complaint, one relabel that knows it has nothing to say
 * without a button, and one page-turn handler -- which is the thing neither
 * control could get right alone (see `on_date_page`).
 */
#define CAL_KEY    "bta-calendar"
#define FORMAT_KEY "bta-date-format"
#define DATE_ISO   "%Y-%m-%d"

/*
 * No date at all, which is a state GTK does not have.
 *
 * A `GtkCalendar` always holds a day -- there is no null in it and nowhere to
 * put one -- so a picker that starts on today answered *today* for a field
 * nobody filled in, and an optional date could not come back empty from the
 * screen it was edited on. That is not a missing convenience: `Field.Date`
 * already spells the empty one `""` and lets it through when the field is not
 * required, so the control was writing a date the program never meant, silently
 * and into the record. Found by `data-plan.md`, which wrote it down as the limit
 * that keeps an optional date from making the round trip.
 *
 * So the flag is ours and the calendar underneath is left holding whatever it
 * held: that is what the popover opens on, and it is why browsing months in an
 * empty picker does not fill it in. The empty state ends when a day is chosen,
 * which is the one gesture that means *this date*.
 *
 * **It is the field's and not the month's.** A `Calendar` is a drawing of a
 * month with a day on it, and there is no way to draw one with none -- so it
 * refuses `""` rather than accepting it and lying, which is the same call
 * `Style` makes about a class name it could never resolve.
 */
#define EMPTY_KEY  "bta-date-empty"
/* What the button reads with no date in it. An em dash and not a blank, which
 * is a button the size of its own padding and reads as broken; `Placeholder`
 * is there for the form that wants to say it in words, and is prose like a
 * `TextBox`'s. */
#define HOLDER_KEY "bta-date-placeholder"
#define DATE_NONE  "\u2014"

/* A DatePicker is a menu button with a calendar in its popover; a Calendar is
 * the calendar. Only the first can be empty, and this is the question the rest
 * of the file already asks to tell them apart. */
static gboolean date_is_picker(BtaWidget *w)
{
    return GTK_IS_MENU_BUTTON(w->gtk);
}

static gboolean date_empty(BtaWidget *w)
{
    return g_object_get_data(G_OBJECT(w->gtk), EMPTY_KEY) != NULL;
}

static void date_set_empty(BtaWidget *w, gboolean empty)
{
    g_object_set_data(G_OBJECT(w->gtk), EMPTY_KEY,
                      empty ? GINT_TO_POINTER(1) : NULL);
}

static const char *date_placeholder(BtaWidget *w)
{
    const char *t = g_object_get_data(G_OBJECT(w->gtk), HOLDER_KEY);
    return t && *t ? t : DATE_NONE;
}

/* A `Calendar` *is* the calendar; a `DatePicker` keeps one in its popover.  That
 * is the whole difference between the two controls, so it is the only thing the
 * code below asks about. */
static GtkCalendar *date_calendar(BtaWidget *w)
{
    if (GTK_IS_CALENDAR(w->gtk))
        return GTK_CALENDAR(w->gtk);
    return GTK_CALENDAR(g_object_get_data(G_OBJECT(w->gtk), CAL_KEY));
}

static const char *date_format(BtaWidget *w)
{
    const char *f = g_object_get_data(G_OBJECT(w->gtk), FORMAT_KEY);
    return f && *f ? f : DATE_ISO;
}

/*
 * "YYYY-MM-DD" and nothing else.  Refused and not guessed: a date the program
 * did not mean is worse than being told the string was not one.  `%n` is what
 * rejects a tail, and `g_date_valid_dmy` is what rejects the 30th of February.
 */
static gboolean date_parse(const char *s, int *y, int *m, int *d)
{
    int end = 0;

    if (sscanf(s, "%4d-%2d-%2d%n", y, m, d, &end) != 3 || s[end] != '\0')
        return FALSE;
    return g_date_valid_dmy((GDateDay)*d, (GDateMonth)*m, (GDateYear)*y);
}

/* Named by the member that was given the string, since `Value`, `Mark` and
 * `Unmark` all take one and the complaint has to say which. */
static JSValue date_refuse(JSContext *ctx, const char *what, const char *s)
{
    return JS_ThrowRangeError(ctx, "%s: '%s' is not a date "
                                   "(expected YYYY-MM-DD)", what, s);
}

/* The button says what the calendar holds, in whatever Format asked for -- and
 * a `Calendar` has no button, so there is nothing to say. */
static void date_relabel(BtaWidget *w)
{
    if (!GTK_IS_MENU_BUTTON(w->gtk))
        return;

    if (date_empty(w)) {
        gtk_menu_button_set_label(GTK_MENU_BUTTON(w->gtk), date_placeholder(w));
        return;
    }

    GDateTime *when = gtk_calendar_get_date(date_calendar(w));
    char      *text = g_date_time_format(when, date_format(w));

    gtk_menu_button_set_label(GTK_MENU_BUTTON(w->gtk), text ? text : "");
    g_free(text);
    g_date_time_unref(when);
}

/* Choosing a day is the gesture that means *this date*, so it is what ends the
 * empty state -- and the only thing that does. */
static void on_date_selected(GtkCalendar *cal, gpointer user_data)
{
    BtaWidget *w = user_data;

    date_set_empty(w, FALSE);
    date_relabel(w);
    bta_emit(w, "Change", 0, NULL);
}

#define MARKS_KEY "bta-calendar-marks"

/* The dates marked, earliest first -- ISO text sorts chronologically, which is
 * the one thing the format was designed for.  NULL until something is marked:
 * most calendars never are, and an empty array on every one of them is a cost
 * for nothing. */
static GPtrArray *cal_marks(BtaWidget *w, gboolean create)
{
    GPtrArray *marks = g_object_get_data(G_OBJECT(w->gtk), MARKS_KEY);

    if (!marks && create) {
        marks = g_ptr_array_new_with_free_func(g_free);
        g_object_set_data_full(G_OBJECT(w->gtk), MARKS_KEY, marks,
                               (GDestroyNotify)g_ptr_array_unref);
    }
    return marks;
}

/* Where a date is, or where it would go: the index, and whether it is there. */
static guint cal_marks_find(GPtrArray *marks, const char *iso, gboolean *found)
{
    guint i = 0;

    *found = FALSE;
    if (!marks)
        return 0;

    for (; i < marks->len; i++) {
        int cmp = strcmp(g_ptr_array_index(marks, i), iso);
        if (cmp == 0) { *found = TRUE; return i; }
        if (cmp > 0)                   return i;
    }
    return i;
}

static void cal_apply_marks(BtaWidget *w)
{
    GtkCalendar *cal   = date_calendar(w);
    GPtrArray   *marks = cal_marks(w, FALSE);

    gtk_calendar_clear_marks(cal);
    if (!marks || !marks->len)
        return;

    GDateTime *when  = gtk_calendar_get_date(cal);
    int        year  = g_date_time_get_year(when);
    int        month = g_date_time_get_month(when);
    g_date_time_unref(when);

    for (guint i = 0; i < marks->len; i++) {
        int y = 0, m = 0, d = 0;
        if (date_parse(g_ptr_array_index(marks, i), &y, &m, &d) &&
            y == year && m == month)
            gtk_calendar_mark_day(cal, (guint)d);
    }
}

/*
 * Turning the page, by hand or by an assignment that lands in another month.
 *
 * **This is a change of value and not a change of view**, which is the whole
 * reason it is connected: GTK has one date and no separate notion of the month on
 * screen, so `Value` follows the page.  Measured before it was believed -- two
 * presses of the calendar's next-month arrow moved `Value` from 2026-03-08 to
 * 2026-05-08 and raised nothing at all, and a `DatePicker` did the same behind a
 * button whose label still read March.  So all three answers are brought back
 * together here: the marks in view, the button's label, and the event.
 */
static void on_date_page(GObject *cal, GParamSpec *spec, gpointer user_data)
{
    BtaWidget *w = user_data;

    cal_apply_marks(w);
    date_relabel(w);

    /* Unless there is no date: then the page is a page and nothing else --
     * looking through the months of an empty picker for the one wanted must not
     * fill it in on the way, and `Value` did not change, so neither did
     * anything to raise `Change` about. */
    if (!date_empty(w))
        bta_emit(w, "Change", 0, NULL);
}

static void build_datepicker(BtaWidget *w)
{
    GtkWidget *cal = gtk_calendar_new();
    GtkWidget *pop = gtk_popover_new();

    gtk_popover_set_child(GTK_POPOVER(pop), cal);

    w->gtk = gtk_menu_button_new();
    gtk_menu_button_set_popover(GTK_MENU_BUTTON(w->gtk), pop);
    g_object_set_data(G_OBJECT(w->gtk), CAL_KEY, cal);

    /* The calendar is not the widget and lives in a surface of its own, so the
     * finaliser's sweep cannot find this handler: it has to be told. */
    g_signal_connect(cal, "day-selected", G_CALLBACK(on_date_selected), w);
    g_signal_connect(cal, "notify::month", G_CALLBACK(on_date_page), w);
    g_signal_connect(cal, "notify::year",  G_CALLBACK(on_date_page), w);
    bta_widget_watch(w, cal);

    date_relabel(w);            /* today, until someone says otherwise */
}

static JSValue date_get_value(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* `""` and not null: it is what `Field.Date` calls an empty date, what a
     * `.form` can write down, and what a `TextBox` answers when it holds
     * nothing. One spelling for the whole road. */
    if (date_empty(w))
        return JS_NewString(ctx, "");

    GDateTime *when = gtk_calendar_get_date(date_calendar(w));
    char      *iso  = g_date_time_format(when, DATE_ISO);
    JSValue    out  = JS_NewString(ctx, iso ? iso : "");

    g_free(iso);
    g_date_time_unref(when);
    return out;
}

static JSValue date_set_value(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    if (!*s) {
        JS_FreeCString(ctx, s);

        if (!date_is_picker(w))
            return JS_ThrowRangeError(ctx, "Value: a Calendar always has a day "
                                           "on it and cannot be empty -- the "
                                           "empty date is a DatePicker's");

        /* The calendar keeps the date it had: it is what the popover opens on,
         * and picking a day out of the month one was already looking at is the
         * ordinary way back out of empty. */
        date_set_empty(w, TRUE);
        date_relabel(w);
        bta_emit(w, "Change", 0, NULL);
        return JS_UNDEFINED;
    }

    int y = 0, m = 0, d = 0;
    if (!date_parse(s, &y, &m, &d)) {
        JSValue e = date_refuse(ctx, "Value", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    date_set_empty(w, FALSE);

    GtkCalendar *cal = date_calendar(w);

    /*
     * Three setters and one event.  GTK has no way to set a whole date that does
     * not raise the floor to 4.20, so the day goes first to 1 -- otherwise
     * standing on the 31st and moving to February would clamp on the way through
     * -- and **both** handlers are blocked so one assignment is one Change and
     * not four: `notify::month` is a change of value too (see `on_date_page`), so
     * an assignment that lands in another month would otherwise raise it on the
     * way and again at the end.  The same bargain Switcher.Reorder makes.
     */
    g_signal_handlers_block_by_func(cal, G_CALLBACK(on_date_selected), w);
    g_signal_handlers_block_by_func(cal, G_CALLBACK(on_date_page), w);
    gtk_calendar_set_day(cal, 1);
    gtk_calendar_set_year(cal, y);
    gtk_calendar_set_month(cal, m - 1);        /* GTK counts months from zero */
    gtk_calendar_set_day(cal, d);
    g_signal_handlers_unblock_by_func(cal, G_CALLBACK(on_date_page), w);
    g_signal_handlers_unblock_by_func(cal, G_CALLBACK(on_date_selected), w);

    cal_apply_marks(w);            /* the month on screen may be another one */
    date_relabel(w);
    bta_emit(w, "Change", 0, NULL);
    return JS_UNDEFINED;
}

static JSValue date_get_format(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, date_format(w));
}

static JSValue date_set_format(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *f = JS_ToCString(ctx, val);
    if (!f)
        return JS_EXCEPTION;

    g_object_set_data_full(G_OBJECT(w->gtk), FORMAT_KEY, g_strdup(f), g_free);
    JS_FreeCString(ctx, f);

    date_relabel(w);
    return JS_UNDEFINED;
}

static JSValue date_get_placeholder(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, date_placeholder(w));
}

static JSValue date_set_placeholder(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *t = JS_ToCString(ctx, val);
    if (!t)
        return JS_EXCEPTION;

    /* `""` restores the em dash rather than blanking the button, the way `""`
     * on a colour restores the theme's: nothing said is not the same as *say
     * nothing*, and a button with no label at all is the size of its padding. */
    g_object_set_data_full(G_OBJECT(w->gtk), HOLDER_KEY, g_strdup(t), g_free);
    JS_FreeCString(ctx, t);

    date_relabel(w);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry datepicker_props[] = {
    JS_CGETSET_DEF("Value",  date_get_value,  date_set_value),
    JS_CGETSET_DEF("Format", date_get_format, date_set_format),
    JS_CGETSET_DEF("Placeholder", date_get_placeholder, date_set_placeholder),
};

/* ------------------------------------------- Calendar: the month itself */

/*
 * The month itself, on the form.
 *
 * `DatePicker` is this control behind a button, and the two are a build function
 * apart: there the calendar lives in a popover, here it *is* the widget.  Which
 * one a form wants is a question of room -- a field asking for a birthday has a
 * line for it, and an agenda showing which days are taken has a month -- so both
 * exist over the same `Value`, the same ISO text and the same `Change`.  Nothing
 * below is a second spelling of anything above: the value, the parsing and the
 * complaint are the ones `DatePicker` already had.
 *
 * What only this one can do is **mark** days, which is why it is worth having and
 * not just a popover pinned open: a month with the taken days marked is what a
 * calendar is for, and a popover has nowhere to say it.
 *
 * **A mark here is a date and GTK's is a day of the month.**
 * `gtk_calendar_mark_day` takes a number from 1 to 31 and puts the mark on
 * whatever month is on screen, so marking the 4th and turning the page shows the
 * 4th of the next month marked as well.  That is never what an application
 * means, so what is kept is the list of dates and the marks in view are
 * re-applied whenever the month changes.  The list is the truth and GTK's marks
 * are a drawing of the part of it that is visible.
 */
static void build_calendar(BtaWidget *w)
{
    w->gtk = gtk_calendar_new();

    g_signal_connect(w->gtk, "day-selected", G_CALLBACK(on_date_selected), w);
    g_signal_connect(w->gtk, "notify::month", G_CALLBACK(on_date_page), w);
    g_signal_connect(w->gtk, "notify::year",  G_CALLBACK(on_date_page), w);
}

/* The three parts of a month GTK can leave off, so a calendar can be the whole
 * page of a wall calendar or the bare grid under a heading the form drew. */
enum { CAL_HEADING, CAL_DAYNAMES, CAL_WEEKS };

static JSValue cal_get_shows(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkCalendar *cal = date_calendar(w);
    gboolean     on  = magic == CAL_HEADING  ? gtk_calendar_get_show_heading(cal)
                     : magic == CAL_DAYNAMES ? gtk_calendar_get_show_day_names(cal)
                                             : gtk_calendar_get_show_week_numbers(cal);
    return JS_NewBool(ctx, on);
}

static JSValue cal_set_shows(JSContext *ctx, JSValueConst this_val,
                             JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    GtkCalendar *cal = date_calendar(w);
    switch (magic) {
    case CAL_HEADING:  gtk_calendar_set_show_heading(cal, b);      break;
    case CAL_DAYNAMES: gtk_calendar_set_show_day_names(cal, b);    break;
    default:           gtk_calendar_set_show_week_numbers(cal, b); break;
    }
    return JS_UNDEFINED;
}

static JSValue cal_get_marks(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue    arr   = JS_NewArray(ctx);
    GPtrArray *marks = cal_marks(w, FALSE);

    for (guint i = 0; marks && i < marks->len; i++)
        JS_SetPropertyUint32(ctx, arr, i,
                             JS_NewString(ctx, g_ptr_array_index(marks, i)));
    return arr;
}

/* Mark and Unmark take the argument the same way and differ in what they do
 * with the answer, so the reading and the complaint are written once. */
static JSValue cal_mark_arg(JSContext *ctx, JSValueConst this_val,
                            JSValueConst val, const char *what,
                            BtaWidget **out, char **iso)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    int y = 0, m = 0, d = 0;
    if (!date_parse(s, &y, &m, &d)) {
        JSValue e = date_refuse(ctx, what, s);
        JS_FreeCString(ctx, s);
        return e;
    }

    /* Normalised, so "2026-9-4" and "2026-09-04" are one mark and not two, and
     * so the list sorts by strcmp. */
    *iso = g_strdup_printf("%04d-%02d-%02d", y, m, d);
    JS_FreeCString(ctx, s);
    *out = w;
    return JS_UNDEFINED;
}

static JSValue cal_mark(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w   = NULL;
    char      *iso = NULL;
    JSValue    bad = cal_mark_arg(ctx, this_val, argc > 0 ? argv[0] : JS_UNDEFINED,
                                  "Mark", &w, &iso);
    if (JS_IsException(bad))
        return bad;

    GPtrArray *marks = cal_marks(w, TRUE);
    gboolean   found = FALSE;
    guint      at    = cal_marks_find(marks, iso, &found);

    if (found) g_free(iso);                       /* marked twice is marked once */
    else       g_ptr_array_insert(marks, (int)at, iso);

    cal_apply_marks(w);
    return JS_UNDEFINED;
}

static JSValue cal_unmark(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w   = NULL;
    char      *iso = NULL;
    JSValue    bad = cal_mark_arg(ctx, this_val, argc > 0 ? argv[0] : JS_UNDEFINED,
                                  "Unmark", &w, &iso);
    if (JS_IsException(bad))
        return bad;

    GPtrArray *marks = cal_marks(w, FALSE);
    gboolean   found = FALSE;
    guint      at    = cal_marks_find(marks, iso, &found);

    g_free(iso);
    if (found)
        g_ptr_array_remove_index(marks, at);      /* unmarking what is not marked
                                                   * is not an error: it is the
                                                   * state the caller asked for */
    cal_apply_marks(w);
    return JS_UNDEFINED;
}

static JSValue cal_clear_marks(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GPtrArray *marks = cal_marks(w, FALSE);
    if (marks && marks->len)
        g_ptr_array_remove_range(marks, 0, marks->len);

    cal_apply_marks(w);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry calendar_props[] = {
    JS_CGETSET_DEF("Value", date_get_value, date_set_value),
    JS_CGETSET_MAGIC_DEF("ShowHeading",     cal_get_shows, cal_set_shows, CAL_HEADING),
    JS_CGETSET_MAGIC_DEF("ShowDayNames",    cal_get_shows, cal_set_shows, CAL_DAYNAMES),
    JS_CGETSET_MAGIC_DEF("ShowWeekNumbers", cal_get_shows, cal_set_shows, CAL_WEEKS),
    JS_CGETSET_DEF("Marks", cal_get_marks, NULL),
    JS_CFUNC_DEF("Mark",       1, cal_mark),
    JS_CFUNC_DEF("Unmark",     1, cal_unmark),
    JS_CFUNC_DEF("ClearMarks", 0, cal_clear_marks),
};

/* ------------------------------------------------------------ ColorButton */

/*
 * A swatch that opens the desktop's colour chooser. **One widget: the swatch.**
 *
 * GtkColorDialogButton is the swatch; what it has no idea of is *no colour*, and
 * here that is a real value: `Background = ""` means "whatever the theme says",
 * which is the state most controls are in and the one a person needs a way back
 * to. `Value = ""` is that way back, and it is the whole of it.
 *
 * There was a clear button beside it, in a box that this file made, and the
 * affordance had exactly one user: the IDE's property grid, a program that
 * builds rows of controls for a living. It puts its own clear beside the swatch
 * now, and a widget that is a swatch is a swatch.
 *
 * **It does not make `Style = "flat"` work, and that was measured.** The class
 * lands on this widget now rather than on a box of ours, but a
 * GtkColorDialogButton is itself a composite -- its CSS node is `colorbutton`
 * with a `button` inside -- and Adwaita writes `button.flat`. So the rule still
 * cannot reach it, and there is nothing left here to remove that would change
 * that: the remaining nesting is GTK's own. What the project's own stylesheet
 * can now say is `colorbutton.mine`, which before went to a box.
 *
 * Value is the colour as a CSS string, `""` for none -- exactly what Background
 * and Foreground take, so this control edits them without anything in between.
 */
#define COLORBTN_VALUE_KEY "bta-colorbutton-value"
#define COLORBTN_MUTE_KEY  "bta-colorbutton-mute"

static const char *colorbtn_stored(BtaWidget *w)
{
    const char *s = g_object_get_data(G_OBJECT(w->gtk), COLORBTN_VALUE_KEY);
    return s ? s : "";
}

static void colorbtn_store(BtaWidget *w, const char *css)
{
    g_object_set_data_full(G_OBJECT(w->gtk), COLORBTN_VALUE_KEY,
                           g_strdup(css ? css : ""), g_free);
}

/* Assigning the swatch makes GTK notify, and that notification is our own
 * doing rather than the user's -- muted so Change means "it changed", not
 * "something wrote to it". */
static void colorbtn_show(BtaWidget *w, const GdkRGBA *rgba)
{
    g_object_set_data(G_OBJECT(w->gtk), COLORBTN_MUTE_KEY, GINT_TO_POINTER(1));
    gtk_color_dialog_button_set_rgba(GTK_COLOR_DIALOG_BUTTON(w->inner), rgba);
    g_object_set_data(G_OBJECT(w->gtk), COLORBTN_MUTE_KEY, NULL);
}

static void on_colorbtn_rgba(GObject *src, GParamSpec *spec, gpointer user_data)
{
    BtaWidget *w = user_data;

    if (g_object_get_data(G_OBJECT(w->gtk), COLORBTN_MUTE_KEY))
        return;

    const GdkRGBA *rgba = gtk_color_dialog_button_get_rgba(
        GTK_COLOR_DIALOG_BUTTON(w->inner));
    char *css = rgba ? gdk_rgba_to_string(rgba) : NULL;

    colorbtn_store(w, css);
    g_free(css);

    bta_emit(w, "Change", 0, NULL);
}

static void build_colorbutton(BtaWidget *w)
{
    GtkColorDialog *dialog = gtk_color_dialog_new();

    w->gtk   = gtk_color_dialog_button_new(dialog);   /* takes the dialog */
    w->inner = w->gtk;

    colorbtn_store(w, "");
    /* Transparent is what "none" looks like on a swatch: GTK draws the
     * chequerboard, which reads as nothing rather than as black. */
    colorbtn_show(w, &(GdkRGBA){ 0, 0, 0, 0 });

    /* On `gtk` itself now, so the finaliser's own sweep finds it and there is
     * nothing to `bta_widget_watch`. */
    g_signal_connect(w->gtk, "notify::rgba", G_CALLBACK(on_colorbtn_rgba), w);
}

static JSValue colorbtn_get_value(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, colorbtn_stored(w));
}

static JSValue colorbtn_set_value(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GdkRGBA rgba = { 0, 0, 0, 0 };
    bool    some = *s && gdk_rgba_parse(&rgba, s);

    colorbtn_show(w, &rgba);
    colorbtn_store(w, some ? s : "");

    JS_FreeCString(ctx, s);

    /* Like a TextBox's Text: assigning it goes out to GTK and comes back as a
     * real change, which is the round trip worth having. */
    bta_emit(w, "Change", 0, NULL);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry colorbutton_props[] = {
    JS_CGETSET_DEF("Value", colorbtn_get_value, colorbtn_set_value),
};

/* ------------------------------------------------------------- FontButton */

/*
 * The same shape as ColorButton, for the other thing a person picks rather than
 * spells: GtkFontDialogButton shows the font and opens the desktop's chooser,
 * and `Value = ""` gets back to the theme's, which is what every control starts
 * out with.
 *
 * One widget, and for the same reason -- see ColorButton above.
 *
 * Value is a Pango description ("Cantarell Bold 12"), which is exactly what
 * Widget.Font takes.
 */
#define FONTBTN_VALUE_KEY "bta-fontbutton-value"
#define FONTBTN_MUTE_KEY  "bta-fontbutton-mute"

static const char *fontbtn_stored(BtaWidget *w)
{
    const char *s = g_object_get_data(G_OBJECT(w->gtk), FONTBTN_VALUE_KEY);
    return s ? s : "";
}

static void fontbtn_store(BtaWidget *w, const char *desc)
{
    g_object_set_data_full(G_OBJECT(w->gtk), FONTBTN_VALUE_KEY,
                           g_strdup(desc ? desc : ""), g_free);
}

/*
 * A font button always shows *some* font -- GtkFontDialogButton has no idea of
 * none and asserts on a NULL description -- so "none" is drawn as the one the
 * theme would use anyway, which is exactly what Font = "" means.
 *
 * Taken from GtkSettings and not from the widget's Pango context, which is the
 * whole point: the context's description is in *device units*, so an empty
 * button reported the desktop's 11pt as a pixel count -- a different number
 * from the one the very same button shows once a font is chosen, and a unit
 * nobody selected. gtk-font-name is the setting as the desktop states it, in
 * points, which is what every other size here is in.
 */
static void fontbtn_show(BtaWidget *w, const PangoFontDescription *d)
{
    PangoFontDescription *theme = NULL;
    const PangoFontDescription *shown = d;

    if (!shown) {
        GtkSettings *settings = gtk_settings_get_default();
        char        *name     = NULL;

        if (settings)
            g_object_get(settings, "gtk-font-name", &name, NULL);
        if (name && *name)
            theme = pango_font_description_from_string(name);
        g_free(name);

        shown = theme;
    }
    if (!shown) {
        pango_font_description_free(theme);
        return;                 /* nothing to show it as; leave it alone */
    }

    g_object_set_data(G_OBJECT(w->gtk), FONTBTN_MUTE_KEY, GINT_TO_POINTER(1));
    gtk_font_dialog_button_set_font_desc(GTK_FONT_DIALOG_BUTTON(w->inner), shown);
    g_object_set_data(G_OBJECT(w->gtk), FONTBTN_MUTE_KEY, NULL);

    pango_font_description_free(theme);
}

/*
 * What a string describes, or NULL for nothing.
 *
 * Only blank is nothing: Pango takes almost anything else -- "," comes back as
 * "Normal" -- and judging it here would be inventing a rule Widget.Font does
 * not have either.
 */
static PangoFontDescription *font_desc_of(const char *s)
{
    if (!s) return NULL;

    while (*s == ' ' || *s == '\t') s++;
    if (!*s) return NULL;

    return pango_font_description_from_string(s);
}

static void on_fontbtn_changed(GObject *src, GParamSpec *spec, gpointer user_data)
{
    BtaWidget *w = user_data;

    if (g_object_get_data(G_OBJECT(w->gtk), FONTBTN_MUTE_KEY))
        return;

    PangoFontDescription *d = gtk_font_dialog_button_get_font_desc(
        GTK_FONT_DIALOG_BUTTON(w->inner));
    char *desc = d ? pango_font_description_to_string(d) : NULL;

    fontbtn_store(w, desc);
    g_free(desc);

    bta_emit(w, "Change", 0, NULL);
}

static void build_fontbutton(BtaWidget *w)
{
    GtkFontDialog *dialog = gtk_font_dialog_new();

    w->gtk   = gtk_font_dialog_button_new(dialog);    /* takes the dialog */
    w->inner = w->gtk;

    fontbtn_store(w, "");
    /* Left alone, GtkFontDialogButton shows a default of its own -- 12 here,
     * where the desktop's is 11.  An empty button has to say the same thing
     * whether it was never set or was cleared. */
    fontbtn_show(w, NULL);

    g_signal_connect(w->gtk, "notify::font-desc",
                     G_CALLBACK(on_fontbtn_changed), w);
}

static JSValue fontbtn_get_value(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, fontbtn_stored(w));
}

static JSValue fontbtn_set_value(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    PangoFontDescription *d    = font_desc_of(s);
    char                 *desc = d ? pango_font_description_to_string(d) : NULL;
    fontbtn_show(w, d);
    fontbtn_store(w, desc);

    g_free(desc);
    if (d) pango_font_description_free(d);
    JS_FreeCString(ctx, s);

    bta_emit(w, "Change", 0, NULL);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry fontbutton_props[] = {
    JS_CGETSET_DEF("Value", fontbtn_get_value, fontbtn_set_value),
};

/* ---------------------------------------------------------- registration */

/* The values a container's or a label's enumerated properties accept. Declared
 * beside the property, so a property editor never has to know these names. */
static const char *widget_options(const char *prop)
{
    if (!strcmp(prop, "HAlign") || !strcmp(prop, "VAlign"))
        return "Auto,Start,End,Center,Fill";
    /* Built in bta_widget.c out of the same table the setter checks, which is
     * what keeps a list of twenty-eight names honest. */
    if (!strcmp(prop, "Cursor"))
        return bta_widget_cursor_options();
    return NULL;
}

static const char *container_options(const char *prop)
{
    return !strcmp(prop, "Arrangement") ? "Fixed,Horizontal,Vertical" : NULL;
}

static const char *label_options(const char *prop)
{
    return !strcmp(prop, "Alignment") ? "Left,Center,Right" : NULL;
}

/* ----------------------------------------------------------------- Image */

/*
 * A picture: an icon out of the theme, or a file.
 *
 * A `Button` could always show an icon and nothing else could, which made the
 * one place an application most wants a picture -- the empty state, the thing a
 * window shows before there is anything to show -- a button pretending not to be
 * one. The IDE's own welcome page is the case that asked for it.
 *
 * Both sources are one property each and the last one set wins, because that is
 * what a GtkImage is: it holds one thing at a time, and asking it to remember
 * the other would be inventing state GTK does not have. Reading gives back what
 * was assigned, so a `.form` round-trips either way.
 *
 * `Size` is the side in pixels. GTK sizes an icon by its own scale otherwise,
 * which is right for a toolbar and much too small for a page about nothing.
 */
#define IMG_ICON_KEY "bta-image-icon"
#define IMG_FILE_KEY "bta-image-file"

static void build_image(BtaWidget *w)
{
    w->gtk = gtk_image_new();
}

static const char *image_stored(BtaWidget *w, const char *key)
{
    const char *s = g_object_get_data(G_OBJECT(w->gtk), key);
    return s ? s : "";
}

/* One source at a time: setting either clears the other, so what is drawn and
 * what is written back cannot disagree. */
static JSValue image_store(JSContext *ctx, JSValueConst this_val,
                           JSValueConst val, const char *key)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    const char *other = !strcmp(key, IMG_ICON_KEY) ? IMG_FILE_KEY : IMG_ICON_KEY;
    g_object_set_data(G_OBJECT(w->gtk), other, NULL);
    g_object_set_data_full(G_OBJECT(w->gtk), key, g_strdup(s), g_free);

    /*
     * **And the icon the widget was told to *keep* re-resolving**, which is a
     * second thing and was the bug: `bta_image_set_icon` leaves the name on the
     * widget and hooks the icon theme, so that an icon follows a change of theme
     * or of scale. Clearing `Icon` here left that name behind -- and the next
     * theme change put the old icon back over the file (or the bytes) that had
     * replaced it. Nothing showed it until something else was shown.
     */
    if (strcmp(key, IMG_ICON_KEY))
        g_object_set_data(G_OBJECT(w->gtk), IMG_NAME_KEY, NULL);

    if (!*s)
        gtk_image_clear(GTK_IMAGE(w->gtk));
    else if (!strcmp(key, IMG_ICON_KEY))
        /* Dropped when the desktop has no such icon, exactly as a Button drops
         * one: an icon-only Image showing the broken-image glyph is worse than
         * one showing nothing.  The name is still what reads back -- what was
         * assigned round-trips whether or not this machine can draw it. */
        bta_image_set_icon(w->gtk, bta_icon_available(w->gtk, s) ? s : NULL);
    else
        gtk_image_set_from_file(GTK_IMAGE(w->gtk), s);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue image_get_icon(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, image_stored(w, IMG_ICON_KEY));
}

static JSValue image_set_icon(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    return image_store(ctx, this_val, val, IMG_ICON_KEY);
}

static JSValue image_get_file(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, image_stored(w, IMG_FILE_KEY));
}

static JSValue image_set_file(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    return image_store(ctx, this_val, val, IMG_FILE_KEY);
}

static JSValue image_get_size(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gtk_image_get_pixel_size(GTK_IMAGE(w->gtk)));
}

static JSValue image_set_size(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Size", &n))
        return JS_EXCEPTION;
    /* -1 is GTK's own "whatever the icon size says", which is what an image
     * that never asked for a size has. */
    gtk_image_set_pixel_size(GTK_IMAGE(w->gtk), n > 0 ? n : -1);

    /* An icon taken by the safe route is a paintable, and a paintable is
     * resolved at one size: the size having changed, it has to be asked for
     * again.  Setting it by name would have followed on its own, which is why
     * this was not needed before and is easy to forget now. */
    const char *icon = image_stored(w, IMG_ICON_KEY);
    if (*icon)
        bta_image_set_icon(w->gtk, icon);

    return JS_UNDEFINED;
}

/*
 * The third source, and the only one that is a verb: an image already in memory.
 *
 * `Icon` and `File` are names -- a `.form` can declare either and the designer
 * can edit both -- and bytes are neither, so they arrive through a call. The
 * rule above holds all the same: the last source wins, so `Icon` and `File` both
 * read `""` afterwards and cannot name something that is not what is drawn.
 *
 * `Size` still applies, because it is the widget's and not the image's: GTK
 * scales a paintable into the pixel size the image was given.
 */
static JSValue image_load_bytes(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "LoadBytes expects (bytes)");

    GdkTexture *texture = bta_texture_from_bytes(ctx, argv[0], "LoadBytes");
    if (!texture)
        return JS_EXCEPTION;

    g_object_set_data(G_OBJECT(w->gtk), IMG_ICON_KEY, NULL);
    g_object_set_data(G_OBJECT(w->gtk), IMG_FILE_KEY, NULL);
    g_object_set_data(G_OBJECT(w->gtk), IMG_NAME_KEY, NULL);

    gtk_image_set_from_paintable(GTK_IMAGE(w->gtk), GDK_PAINTABLE(texture));
    g_object_unref(texture);    /* the image holds its own reference now */
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry image_props[] = {
    JS_CGETSET_DEF("Icon", image_get_icon, image_set_icon),
    JS_CGETSET_DEF("File", image_get_file, image_set_file),
    JS_CFUNC_DEF("LoadBytes", 1, image_load_bytes),
    JS_CGETSET_DEF("Size", image_get_size, image_set_size),
};

void bta_core_register(void)
{
    /* Widget's own accessors live in bta_widget.c. */
    int nbase;
    const JSCFunctionListEntry *base = bta_widget_base_props(&nbase);

    const BtaClass rows[] = {
        /*
         * `Tooltip` on the root, so every control in the set has one property
         * holding prose whether or not it has a `Text`.  Its `texts` is
         * inherited by all of them, which is what makes the accumulating walk
         * in text_props_of() necessary rather than convenient.
         */
        BTA_CLASS_FULL("Widget", NULL, NULL, base, nbase, false,
                       widget_options, "Tooltip", "MouseDown,MouseUp,MouseMove,MouseEnter,MouseLeave,MouseWheel,DblClick,KeyPress,KeyRelease,GotFocus,LostFocus,Drop,FileDrop"),
        BTA_CLASS_ENUM("Container", "Widget",  NULL, container_props, false, container_options, NULL),
        BTA_CLASS_BARE("Control",   "Widget",    NULL,                            false, NULL),
        /* A window's title is prose; so is the caption of everything below. */
        BTA_CLASS_TEXT("Form",      "Container", build_form,     form_props,      true, "Text",
                       "Open,Close,Resize,ThemeChange"),
        BTA_CLASS_BARE("Panel",     "Container", build_panel,                     false, NULL),
        BTA_CLASS_BARE("Component", "Container", build_component,                 false, NULL),
        BTA_CLASS_ENUM_TEXT("Label", "Control",  build_label,    label_props, false,
                       label_options, "Text", NULL),
        BTA_CLASS_TEXT("Button",    "Control",   build_button,   button_props,    false, "Text", "Click"),
        BTA_CLASS     ("Image",     "Control",   build_image,    image_props,     false, NULL),
        /* No `texts`: a rule has nothing to read. No events of its own either --
         * it cannot be clicked on purpose, and what it inherits from Widget is
         * what a mouse passing over it would report. */
        BTA_CLASS_ENUM("Separator", "Control",   build_separator, separator_props, false,
                       orient_options, NULL),
        /* A TextBox's Text is what it starts with -- prose -- and Placeholder is
         * the hint behind it, which is prose that is only ever read. */
        BTA_CLASS_ENUM_TEXT("TextBox", "Control", build_textbox, textbox_props, false,
                       textbox_options, "Text,Placeholder", "Change,Activate,IconClick"),
        /* One control, and `Group` says which of the two it is: see
         * build_checkbutton for why there is no RadioButton beside it. */
        BTA_CLASS_TEXT("CheckButton", "Control", build_checkbutton,
                       checkbutton_props, false, "Text", "Click"),
        /* No `texts`: a switch has no caption to translate.  The Label beside
         * it is where the prose is, and that one is already a Label. */
        BTA_CLASS     ("Switch",    "Control",   build_switch,   switch_props,    false, "Click"),
        /* `Items` is a list of strings a person reads, so each entry goes
         * through the catalogue.  ListBox.Text is read-only (it reports the
         * selection) and so is not one of these. */
        BTA_CLASS_TEXT("ListBox",   "Control",   build_listbox,  listbox_props,   false, "Items",
                       "Select,Activate"),
        BTA_CLASS_TEXT("ComboBox",  "Control",   build_combobox, combobox_props,  false,
                       "Items,Text", "Select"),
        BTA_CLASS     ("SpinBox",   "Control",   build_spinbox,  spinbox_props,   false, "Change,Activate"),
        /* Three small ones, each a word the vocabulary was missing: work with no
         * end in sight, an address, and a reading. */
        BTA_CLASS_ENUM("Picture",    "Control", build_picture,    picture_props,
                       false, picture_options, NULL),
        BTA_CLASS     ("Spinner",    "Control", build_spinner,    spinner_props,
                       false, NULL),
        BTA_CLASS_TEXT("LinkButton", "Control", build_linkbutton, linkbutton_props,
                       false, "Text", "Click"),
        BTA_CLASS_ENUM("LevelBar",   "Control", build_levelbar,   levelbar_props,
                       false, level_options, NULL),
        BTA_CLASS_TEXT("ToggleButton", "Control", build_togglebutton,
                       togglebutton_props, false, "Text", "Click"),
        BTA_CLASS_ENUM_TEXT("ProgressBar", "Control", build_progressbar,
                       progressbar_props, false, orient_options, "Text", NULL),
        BTA_CLASS_ENUM("Slider",       "Control", build_slider,
                       slider_props, false, slider_options, "Change"),
        /* `Placeholder` is prose and `Format` is not, which is the same line
         * `TextBox` draws: one is read by a person, the other is a strftime
         * pattern that a catalogue would turn into a different date. */
        BTA_CLASS_TEXT("DatePicker",   "Control", build_datepicker,
                       datepicker_props, false, "Placeholder", "Change"),
        BTA_CLASS     ("Calendar",     "Control", build_calendar,
                       calendar_props, false, "Change"),
        BTA_CLASS     ("ColorButton", "Control",  build_colorbutton,
                       colorbutton_props, false, "Change"),
        BTA_CLASS     ("FontButton",  "Control",  build_fontbutton,
                       fontbutton_props, false, "Change"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
