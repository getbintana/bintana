/*
 * Terminal -- VTE 2.91 for GTK4.
 *
 * A real terminal, not a text pane pretending to be one: the child gets a pty,
 * so colours, progress output and interactive prompts behave.  It is what a
 * program reaches for when the thing it runs is meant to be *worked in* -- git,
 * a shell, a service's log -- and the IDE gives it a tab of its own for that.
 * For a command whose output you show, `Exec` and a `TextEditor` are the pair
 * (which is what the IDE's own output pane is).
 *
 * **VTE is optional at build time** (`BTA_HAVE_VTE`), the bargain sqlite,
 * libsoup and GStreamer already make here -- and the reason is portability:
 * VTE is the one dependency with no Windows port.  Without it the class is
 * still registered, still builds the same outer GTK shape, still loads out of a
 * `.form` and still answers every property it has; what refuses is the three
 * verbs that need a child.  `Terminal.Available` and `Widget.Available`
 * ("Terminal") are how a palette asks before it offers the button.
 *
 * The split below is bta_media.c's: one shared half holding everything a
 * property does, and two implementations of the handful of calls that are
 * really VTE's.  Everything VTE's headers bring -- `vte/vte.h`, and `signal.h`
 * and `sys/wait.h`, which do not exist on Windows either -- is inside the
 * guard.
 */
#include "bta.h"

#include <string.h>

#ifdef BTA_HAVE_VTE
#include <vte/vte.h>

#include <signal.h>
#include <sys/wait.h>
#endif

/* What a runtime with no pty says, in one place: the sqlite/libsoup wording,
 * and no distribution's package names. */
#define TERM_NO_VTE                                                          \
    "this runtime was built without VTE, so a Terminal cannot run a child. "  \
    "Install VTE's development package (vte-2.91-gtk4) and build again -- "   \
    "CMake finds it with pkg-config and prints what it found"

/* Whether this build has one, as the class row declares it and as the JS side
 * is answered.  One expression, read in both places. */
#ifdef BTA_HAVE_VTE
#define TERM_AVAILABLE true
#else
#define TERM_AVAILABLE false
#endif

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

/*
 * The pty, in eight calls.  The second version of each, at the bottom of the
 * file, is what a build without VTE gets: the three verbs refuse and the
 * questions answer what a pane nobody can run anything in truthfully answers.
 */
static void  term_build(BtaWidget *w);
static bool  term_spawn(JSContext *ctx, BtaWidget *w, char **argv, const char *cwd);
static bool  term_alive(BtaWidget *w);
static void  term_write(BtaWidget *w, const char *s, size_t len);
static void  term_reset(BtaWidget *w);
#ifdef BTA_HAVE_VTE
static bool  term_kill(BtaWidget *w, bool hard);      /* false: no child */
#endif
static char *term_read(BtaWidget *w);                 /* g_free the answer */
static bool  term_pattern(JSContext *ctx, BtaWidget *w, const char *pattern);

/* ----------------------------------------------------------------- shared */

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

    bool ok = term_spawn(ctx, w, (char **)args->pdata, cwd);

    JS_FreeCString(ctx, cwd);
    g_ptr_array_unref(args);   /* VTE duplicates argv */
    return ok ? JS_UNDEFINED : JS_EXCEPTION;
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

#ifdef BTA_HAVE_VTE
    return JS_NewBool(ctx, term_kill(w, magic != 0));
#else
    /* A verb, and the verbs refuse: a build with no pty has no child to end,
     * and answering `false` would say *there was none running* about a runtime
     * where there can never be one. */
    return JS_ThrowInternalError(ctx, TERM_NO_VTE);
#endif
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
        term_write(w, s, len);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue term_clear(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    term_reset(w);
    return JS_UNDEFINED;
}

/*
 * Everything the terminal has shown, scrollback included.
 *
 * Not just the visible screen: a console pane two rows tall would report two
 * lines and hide the rest, which is exactly what one asks Text for -- what the
 * program printed, not what happens to fit right now.
 */
static JSValue term_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    char *s = term_read(w);

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
    return JS_NewBool(ctx, term_alive(w));
}

/*
 * Whether this build can run a child in one at all.
 *
 * Read off the class row rather than off the `#ifdef` a second time, so the
 * instance and `Widget.Available("Terminal")` cannot come to disagree -- one
 * declaration, in the table, where a class says everything else about itself.
 */
static JSValue term_get_available(JSContext *ctx, JSValueConst this_val)
{
    if (!bta_this(ctx, this_val))
        return JS_EXCEPTION;

    return JS_NewBool(ctx, bta_class_runnable(bta_class_find("Terminal")));
}

/*
 * ScrollbackLines and FontScale are *state*, and state answers on every build:
 * a `.form` may declare either, the designer reads both back to draw the
 * property grid, and the serialiser reads them again to save. A getter that
 * refused would make a runtime with no VTE one that cannot open a form with a
 * Terminal in it -- which optional-at-build-time was never meant to cost.
 */
#define SCROLLBACK_KEY "bta-scrollback"
#define FONTSCALE_KEY  "bta-font-scale"

static JSValue term_get_scrollback(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_VTE
    return JS_NewInt32(ctx,
        (int)vte_terminal_get_scrollback_lines(VTE_TERMINAL(w->inner)));
#else
    return JS_NewInt32(ctx,
        GPOINTER_TO_INT(g_object_get_data(G_OBJECT(w->inner), SCROLLBACK_KEY)));
#endif
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
#ifdef BTA_HAVE_VTE
    vte_terminal_set_scrollback_lines(VTE_TERMINAL(w->inner), n);
#else
    g_object_set_data(G_OBJECT(w->inner), SCROLLBACK_KEY, GINT_TO_POINTER(n));
#endif
    return JS_UNDEFINED;
}

static JSValue term_get_font_scale(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_VTE
    return JS_NewFloat64(ctx, vte_terminal_get_font_scale(VTE_TERMINAL(w->inner)));
#else
    double *held = g_object_get_data(G_OBJECT(w->inner), FONTSCALE_KEY);
    return JS_NewFloat64(ctx, held ? *held : 1.0);
#endif
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
#ifdef BTA_HAVE_VTE
    vte_terminal_set_font_scale(VTE_TERMINAL(w->inner), d);
#else
    double *held = g_new(double, 1);
    *held = d;
    g_object_set_data_full(G_OBJECT(w->inner), FONTSCALE_KEY, held, g_free);
#endif
    return JS_UNDEFINED;
}

/* -------------------------------------------------------------- LinkPattern */

/*
 * A terminal shows text a program wrote, and some of that text is a place: a
 * file and a line in a compiler's complaint, a URL, a ticket number.  VTE can
 * recognise a pattern in what it has drawn and say what was under the pointer,
 * which is the whole of what is needed to make those clickable -- so the runtime
 * offers the pattern and the event, and what the text *means* is the
 * application's business.
 *
 * The click is reported on **release**, and only when press and release landed
 * on the same match.  Otherwise dragging across a match to select it would
 * activate it, and a terminal one cannot select text in is worse than one whose
 * errors are not clickable.
 *
 * Like the two above, the pattern is kept whatever the build: it is a property
 * a `.form` declares, so a build with no VTE has to be able to load and save
 * one. What it cannot do is highlight anything, and `Link` never fires there.
 */
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

    bool ok = term_pattern(ctx, w, pattern);
    if (ok)
        g_object_set_data_full(G_OBJECT(w->inner), PATTERN_KEY,
                               g_strdup(pattern), g_free);
    JS_FreeCString(ctx, pattern);
    return ok ? JS_UNDEFINED : JS_EXCEPTION;
}

static const JSCFunctionListEntry terminal_props[] = {
    JS_CGETSET_DEF("Available",       term_get_available,  NULL),
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
        BTA_CLASS_OPTIONAL("Terminal", "Control", term_build, terminal_props,
                           false, TERM_AVAILABLE, "Exit,Link"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}

#ifdef BTA_HAVE_VTE

/* ================================================================== the pty */

#define PID_KEY "bta-child-pid"

static GPid terminal_pid(BtaWidget *w)
{
    return (GPid)GPOINTER_TO_INT(g_object_get_data(G_OBJECT(w->inner), PID_KEY));
}

static void terminal_set_pid(BtaWidget *w, GPid pid)
{
    g_object_set_data(G_OBJECT(w->inner), PID_KEY, GINT_TO_POINTER(pid));
}

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

static void term_build(BtaWidget *w)
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

static bool term_spawn(JSContext *ctx, BtaWidget *w, char **argv, const char *cwd)
{
    vte_terminal_spawn_async(VTE_TERMINAL(w->inner), VTE_PTY_DEFAULT, cwd,
                             argv, NULL,
                             G_SPAWN_SEARCH_PATH, NULL, NULL, NULL,
                             -1, NULL, on_spawned, w);
    return true;
}

static bool term_kill(BtaWidget *w, bool hard)
{
    GPid pid = terminal_pid(w);
    if (pid > 0)
        kill(pid, hard ? SIGKILL : SIGTERM);
    return pid > 0;
}

static bool term_alive(BtaWidget *w)
{
    return terminal_pid(w) > 0;
}

static void term_write(BtaWidget *w, const char *s, size_t len)
{
    vte_terminal_feed(VTE_TERMINAL(w->inner), s, (gssize)len);
}

static void term_reset(BtaWidget *w)
{
    vte_terminal_reset(VTE_TERMINAL(w->inner), TRUE, TRUE);
}

/*
 * The range is taken from the cursor and not from the scroll adjustment: rows
 * are numbered from the first line the terminal ever showed, and the adjustment
 * of a terminal nobody has scrolled still reports the default 24 -- which cuts
 * the answer off at the first screenful.
 */
static char *term_read(BtaWidget *w)
{
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
    return s;
}

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

static bool term_pattern(JSContext *ctx, BtaWidget *w, const char *pattern)
{
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
            JS_ThrowRangeError(ctx, "LinkPattern: %s",
                               err ? err->message : "bad pattern");
            g_clear_error(&err);
            return false;
        }

        int tag = vte_terminal_match_add_regex(term, re, 0);
        vte_regex_unref(re);                 /* the terminal holds it now */

        /* What tells the user the text is clickable before they click it. */
        vte_terminal_match_set_cursor_name(term, tag, "pointer");
        /* +1: tag 0 is a valid tag and NULL is "none". */
        g_object_set_data(G_OBJECT(w->inner), TAG_KEY, GINT_TO_POINTER(tag + 1));
    }
    return true;
}

#else /* no VTE at build time */

/* ============================================================ no pty here
 *
 * A `GtkTextView` in the same `GtkScrolledWindow` the real one is in.  Not to
 * pretend: it is what keeps a build with no VTE able to *draw* a Terminal --
 * the designer places one, the serialiser saves it, the CSS node is still the
 * scroller, and a program that only ever `Feed`s it (a status pane, a log) goes
 * on working.  Nothing here interprets an escape sequence, and nothing here can
 * make a child, which is what `Available` says out loud.
 */

static void term_build(BtaWidget *w)
{
    w->inner = gtk_text_view_new();
    gtk_text_view_set_editable(GTK_TEXT_VIEW(w->inner), FALSE);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(w->inner), TRUE);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(w->inner), GTK_WRAP_NONE);

    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->inner);

    g_object_set_data(G_OBJECT(w->inner), SCROLLBACK_KEY, GINT_TO_POINTER(10000));
}

static bool term_spawn(JSContext *ctx, BtaWidget *w, char **argv, const char *cwd)
{
    (void)w; (void)argv; (void)cwd;
    JS_ThrowInternalError(ctx, TERM_NO_VTE);
    return false;
}

/* No pty, so nothing to be alive: `Running` is false and always will be. */
static bool term_alive(BtaWidget *w) { (void)w; return false; }

/* `\r` is a terminal's carriage return and a text buffer's mystery character:
 * a caller writing CRLF would get a line ending in a box.  Dropped, which is
 * the only reading of it a buffer has. */
static void term_write(BtaWidget *w, const char *s, size_t len)
{
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(w->inner));
    GtkTextIter    end;

    GString *clean = g_string_new_len(NULL, (gssize)len);
    for (size_t i = 0; i < len; i++)
        if (s[i] != '\r')
            g_string_append_c(clean, s[i]);

    gtk_text_buffer_get_end_iter(buf, &end);
    gtk_text_buffer_insert(buf, &end, clean->str, (int)clean->len);
    g_string_free(clean, TRUE);
}

static void term_reset(BtaWidget *w)
{
    gtk_text_buffer_set_text(gtk_text_view_get_buffer(GTK_TEXT_VIEW(w->inner)), "", 0);
}

static char *term_read(BtaWidget *w)
{
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(w->inner));
    GtkTextIter    start, end;

    gtk_text_buffer_get_bounds(buf, &start, &end);
    return gtk_text_buffer_get_text(buf, &start, &end, FALSE);
}

/* Kept and never used: a `.form` declares it and the designer reads it back.
 * There is nothing to highlight without VTE, so `Link` simply never fires. */
static bool term_pattern(JSContext *ctx, BtaWidget *w, const char *pattern)
{
    (void)ctx; (void)w; (void)pattern;
    return true;
}

#endif
