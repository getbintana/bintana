/*
 * Terminal -- VTE 2.91 for GTK4.
 *
 * A real terminal, not a text pane pretending to be one: the child gets a pty,
 * so colours, progress output and interactive prompts behave.  This is what
 * the IDE runs projects in.
 */
#include "bta.h"

#include <vte/vte.h>

#include <signal.h>
#include <sys/wait.h>

#define PID_KEY "bta-child-pid"

/*
 * The pattern behind LinkPattern, the tag VTE gave it, and what was under the
 * button when it went down.
 */
#define PATTERN_KEY "bta-link-pattern"
#define TAG_KEY     "bta-link-tag"
#define PRESSED_KEY "bta-link-pressed"

/*
 * PCRE2_MULTILINE.  VTE requires a match regex to carry it -- a terminal is a
 * grid of lines and a pattern that could run across the end of one would match
 * text nobody wrote -- and it neither re-exports the constant nor pulls pcre2
 * into its own pkg-config.  Depending on pcre2's headers for one number would
 * add a build dependency to say what a comment says as well; the value is part
 * of pcre2's ABI and cannot move.
 */
#define BTA_PCRE2_MULTILINE 0x00000400u

static GPid terminal_pid(BtaWidget *w)
{
    return (GPid)GPOINTER_TO_INT(g_object_get_data(G_OBJECT(w->inner), PID_KEY));
}

static void terminal_set_pid(BtaWidget *w, GPid pid)
{
    g_object_set_data(G_OBJECT(w->inner), PID_KEY, GINT_TO_POINTER(pid));
}

/* ----------------------------------------------------------------- build */

static void on_child_exited(VteTerminal *term, int status, gpointer user_data)
{
    BtaWidget *w = user_data;
    terminal_set_pid(w, 0);

    /* Report the exit code a shell would report. */
    int code = WIFEXITED(status)   ? WEXITSTATUS(status)
             : WIFSIGNALED(status) ? 128 + WTERMSIG(status)
                                   : -1;

    JSValue arg = JS_NewInt32(w->ctx, code);
    bta_emit(w, "Exit", 1, &arg);
    JS_FreeValue(w->ctx, arg);
}

/* Declared here, defined with the rest of LinkPattern: the controller that reads
 * what is under the pointer is installed with the terminal. */
static gboolean on_link_event(GtkEventControllerLegacy *c, GdkEvent *event,
                              gpointer user_data);

static void build_terminal(BtaWidget *w)
{
    w->inner = vte_terminal_new();
    VteTerminal *t = VTE_TERMINAL(w->inner);

    vte_terminal_set_scrollback_lines(t, 10000);
    vte_terminal_set_mouse_autohide(t, TRUE);
    vte_terminal_set_scroll_on_output(t, TRUE);
    vte_terminal_set_scroll_on_keystroke(t, TRUE);

    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->inner);

    g_signal_connect(t, "child-exited", G_CALLBACK(on_child_exited), w);

    /*
     * On the terminal and not on `gtk`: what VTE checks a match at are its own
     * coordinates, and the widget the parent lays out is the scroller around it.
     *
     * A raw event controller and not a GtkGestureClick, which is what this was
     * first and what does not work here: VTE has a gesture of its own for
     * selecting text and it *claims* the press, and claiming a sequence cancels
     * every other gesture on it -- so the click gesture saw the press and then
     * never saw the release, in either phase.  A legacy controller has no
     * sequence to lose.  Capture, so the release arrives whatever VTE does with
     * it, and FALSE always: this only reads what is under the pointer, so
     * selecting, scrolling and VTE's own menu go on working.
     *
     * The finaliser's sweep unhooks it with the rest: it carries `w` and hangs
     * off `inner`.
     */
    GtkEventController *clicks = gtk_event_controller_legacy_new();
    gtk_event_controller_set_propagation_phase(clicks, GTK_PHASE_CAPTURE);
    g_signal_connect(clicks, "event", G_CALLBACK(on_link_event), w);
    gtk_widget_add_controller(w->inner, clicks);
}

/* ------------------------------------------------------------------- Run */

static void on_spawned(VteTerminal *term, GPid pid, GError *error, gpointer user_data)
{
    BtaWidget *w = user_data;

    if (error) {
        char *msg = g_strdup_printf("\r\n[no se pudo ejecutar: %s]\r\n", error->message);
        vte_terminal_feed(term, msg, -1);
        g_free(msg);

        JSValue arg = JS_NewInt32(w->ctx, -1);
        bta_emit(w, "Exit", 1, &arg);
        JS_FreeValue(w->ctx, arg);
        return;
    }
    terminal_set_pid(w, pid);
}

static JSValue term_run(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (argc < 1 || !JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx, "Run(argv, [workdir]): argv must be an array");

    JSValue  lenv = JS_GetPropertyStr(ctx, argv[0], "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    if (n == 0)
        return JS_ThrowTypeError(ctx, "Run: argv is empty");

    GPtrArray *args = g_ptr_array_new_with_free_func(g_free);
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, argv[0], i);
        const char *s = JS_ToCString(ctx, e);
        JS_FreeValue(ctx, e);
        if (!s) {
            g_ptr_array_unref(args);
            return JS_EXCEPTION;
        }
        g_ptr_array_add(args, g_strdup(s));
        JS_FreeCString(ctx, s);
    }
    g_ptr_array_add(args, NULL);

    const char *cwd = argc > 1 && JS_IsString(argv[1])
                          ? JS_ToCString(ctx, argv[1]) : NULL;

    vte_terminal_spawn_async(VTE_TERMINAL(w->inner), VTE_PTY_DEFAULT, cwd,
                             (char **)args->pdata, NULL,
                             G_SPAWN_SEARCH_PATH, NULL, NULL, NULL,
                             -1, NULL, on_spawned, w);

    JS_FreeCString(ctx, cwd);
    g_ptr_array_unref(args);   /* VTE duplicates argv */
    return JS_UNDEFINED;
}

/*
 * `Stop()` asks the child to end and `Kill()` makes it -- the same two verbs, in
 * the same order, that an `Exec` handle takes, because they are the same act on
 * the same kind of thing.  `Kill` alone used to mean SIGTERM here, which left
 * one word meaning *ask* on a terminal and *make* on a child process.
 *
 * Both answer whether there was a child to signal at all.
 */
static JSValue term_signal(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GPid pid = terminal_pid(w);
    if (pid > 0)
        kill(pid, magic ? SIGKILL : SIGTERM);
    return JS_NewBool(ctx, pid > 0);
}

/* --------------------------------------------------------------- content */

static JSValue term_feed(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    size_t      len = 0;
    const char *s   = argc > 0 ? JS_ToCStringLen(ctx, &len, argv[0]) : NULL;
    if (s)
        vte_terminal_feed(VTE_TERMINAL(w->inner), s, (gssize)len);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue term_clear(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    vte_terminal_reset(VTE_TERMINAL(w->inner), TRUE, TRUE);
    return JS_UNDEFINED;
}

/*
 * Everything the terminal has shown, scrollback included.
 *
 * Not just the visible screen: a console pane two rows tall would report two
 * lines and hide the rest, which is exactly what one asks Text for -- what the
 * program printed, not what happens to fit right now.
 *
 * The range is taken from the cursor and not from the scroll adjustment: rows
 * are numbered from the first line the terminal ever showed, and the adjustment
 * of a terminal nobody has scrolled still reports the default 24 -- which cuts
 * the answer off at the first screenful.
 */
static JSValue term_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    VteTerminal *term = VTE_TERMINAL(w->inner);

    glong column, row;
    vte_terminal_get_cursor_position(term, &column, &row);

    long last  = row + vte_terminal_get_row_count(term);
    long first = row - vte_terminal_get_scrollback_lines(term);
    if (first < 0)
        first = 0;

    char *s = vte_terminal_get_text_range_format(term, VTE_FORMAT_TEXT,
                                                 first, 0, last, -1, NULL);
    if (!s)
        s = vte_terminal_get_text_format(term, VTE_FORMAT_TEXT);

    /* A terminal is a grid: the rows past the last line are blank and would come
     * back as a tail of empty lines nobody printed. */
    if (s) {
        size_t n = strlen(s);
        while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == ' ' || s[n - 1] == '\t'))
            n--;
        s[n] = '\0';
    }

    JSValue v = JS_NewString(ctx, s ? s : "");
    g_free(s);
    return v;
}

static JSValue term_get_running(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, terminal_pid(w) > 0);
}

static JSValue term_get_scrollback(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx,
        (int)vte_terminal_get_scrollback_lines(VTE_TERMINAL(w->inner)));
}

static JSValue term_set_scrollback(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "ScrollbackLines", &n))
        return JS_EXCEPTION;
    vte_terminal_set_scrollback_lines(VTE_TERMINAL(w->inner), n);
    return JS_UNDEFINED;
}

static JSValue term_get_font_scale(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewFloat64(ctx, vte_terminal_get_font_scale(VTE_TERMINAL(w->inner)));
}

static JSValue term_set_font_scale(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    double d;
    if (!bta_to_number(ctx, val, "FontScale", &d))
        return JS_EXCEPTION;
    vte_terminal_set_font_scale(VTE_TERMINAL(w->inner), d);
    return JS_UNDEFINED;
}

/* -------------------------------------------------------------- LinkPattern */

/*
 * A terminal shows text a program wrote, and some of that text is a place: a
 * file and a line in a compiler's complaint, a URL, a ticket number.  VTE can
 * recognise a pattern in what it has drawn and say what was under the pointer,
 * which is the whole of what is needed to make those clickable -- so the runtime
 * offers the pattern and the event, and what the text *means* is the
 * application's business.  The IDE's console asks for `file.js:line` and opens
 * the editor there; it gets no more than any other program would.
 *
 * The click is reported on **release**, and only when press and release landed
 * on the same match.  Otherwise dragging across a match to select it would
 * activate it, and a terminal one cannot select text in is worse than one whose
 * errors are not clickable.
 */

/* A button event's position is in the surface's coordinates; what VTE checks a
 * match at are the terminal's.  False when the event carries no position, which
 * is not one of the two kinds this looks at anyway. */
static bool link_point(BtaWidget *w, GdkEvent *event, double *x, double *y)
{
    double    ex, ey;
    GtkRoot  *root = gtk_widget_get_root(w->inner);

    if (!root || !gdk_event_get_position(event, &ex, &ey))
        return false;

    double sx = 0, sy = 0;
    gtk_native_get_surface_transform(GTK_NATIVE(root), &sx, &sy);

    graphene_point_t in  = GRAPHENE_POINT_INIT((float)(ex - sx), (float)(ey - sy));
    graphene_point_t out;
    if (!gtk_widget_compute_point(GTK_WIDGET(root), w->inner, &in, &out))
        return false;

    *x = out.x;
    *y = out.y;
    return true;
}

static gboolean on_link_event(GtkEventControllerLegacy *c, GdkEvent *event,
                              gpointer user_data)
{
    BtaWidget    *w    = user_data;
    GdkEventType  type = gdk_event_get_event_type(event);

    if (type != GDK_BUTTON_PRESS && type != GDK_BUTTON_RELEASE)
        return FALSE;
    if (gdk_button_event_get_button(event) != GDK_BUTTON_PRIMARY)
        return FALSE;

    double x, y;
    if (!link_point(w, event, &x, &y))
        return FALSE;

    char *hit = vte_terminal_check_match_at(VTE_TERMINAL(w->inner), x, y, NULL);

    if (type == GDK_BUTTON_PRESS) {
        /* Remembered, because what matters is that the release lands on the same
         * match: press here, drag away, and nothing was clicked. */
        g_object_set_data_full(G_OBJECT(w->inner), PRESSED_KEY, hit, g_free);
        return FALSE;
    }

    const char *pressed = g_object_get_data(G_OBJECT(w->inner), PRESSED_KEY);
    if (pressed && hit && !strcmp(hit, pressed)) {
        JSValue arg = JS_NewString(w->ctx, hit);
        bta_emit(w, "Link", 1, &arg);
        JS_FreeValue(w->ctx, arg);
    }
    g_free(hit);
    g_object_set_data(G_OBJECT(w->inner), PRESSED_KEY, NULL);
    return FALSE;
}

static JSValue term_get_link_pattern(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *p = g_object_get_data(G_OBJECT(w->inner), PATTERN_KEY);
    return JS_NewString(ctx, p ? p : "");
}

static JSValue term_set_link_pattern(JSContext *ctx, JSValueConst this_val,
                                     JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *pattern = JS_ToCString(ctx, val);
    if (!pattern)
        return JS_EXCEPTION;

    VteTerminal *term = VTE_TERMINAL(w->inner);

    /* One pattern per terminal: re-assigning replaces it rather than adding a
     * second, so a program that recomputes the pattern does not end up with a
     * terminal that matches every pattern it ever had. */
    gpointer had = g_object_get_data(G_OBJECT(w->inner), TAG_KEY);
    if (had) {
        vte_terminal_match_remove(term, GPOINTER_TO_INT(had) - 1);
        g_object_set_data(G_OBJECT(w->inner), TAG_KEY, NULL);
    }

    if (*pattern) {
        GError   *err = NULL;
        VteRegex *re  = vte_regex_new_for_match(pattern, -1,
                                                BTA_PCRE2_MULTILINE, &err);
        if (!re) {
            JSValue e = JS_ThrowRangeError(ctx, "LinkPattern: %s",
                                           err ? err->message : "bad pattern");
            g_clear_error(&err);
            JS_FreeCString(ctx, pattern);
            return e;
        }

        int tag = vte_terminal_match_add_regex(term, re, 0);
        vte_regex_unref(re);                 /* the terminal holds it now */

        /* What tells the user the text is clickable before they click it. */
        vte_terminal_match_set_cursor_name(term, tag, "pointer");
        /* +1: tag 0 is a valid tag and NULL is "none". */
        g_object_set_data(G_OBJECT(w->inner), TAG_KEY, GINT_TO_POINTER(tag + 1));
    }

    g_object_set_data_full(G_OBJECT(w->inner), PATTERN_KEY,
                           g_strdup(pattern), g_free);
    JS_FreeCString(ctx, pattern);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry terminal_props[] = {
    JS_CGETSET_DEF("LinkPattern",     term_get_link_pattern, term_set_link_pattern),
    JS_CGETSET_DEF("Text",            term_get_text,       NULL),
    JS_CGETSET_DEF("Running",         term_get_running,    NULL),
    JS_CGETSET_DEF("ScrollbackLines", term_get_scrollback, term_set_scrollback),
    JS_CGETSET_DEF("FontScale",       term_get_font_scale, term_set_font_scale),
    JS_CFUNC_DEF("Run",   2, term_run),
    JS_CFUNC_MAGIC_DEF("Stop", 0, term_signal, 0),
    JS_CFUNC_MAGIC_DEF("Kill", 0, term_signal, 1),
    JS_CFUNC_DEF("Feed",  1, term_feed),
    JS_CFUNC_DEF("Clear", 0, term_clear),
};

void bta_terminal_register(void)
{
    const BtaClass rows[] = {
        BTA_CLASS("Terminal", "Control", build_terminal, terminal_props, false, "Exit,Link"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
