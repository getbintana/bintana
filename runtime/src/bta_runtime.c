/*
 * Interpreter setup, project loading and the GTK main loop.
 */
#include "bta.h"
#include "bta_prelude.h"

/* For gtk_source_init/finalize: the library has to be initialised before any of
 * its widgets is built. See bta_app_run. */
#include <gtksourceview/gtksource.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static BtaApp *g_app;

BtaApp *bta_current_app(void) { return g_app; }

/* ------------------------------------------------------------------ utils */

char *bta_read_file(const char *path, size_t *len)
{
    char  *data = NULL;
    gsize  n    = 0;

    if (!g_file_get_contents(path, &data, &n, NULL))
        return NULL;
    if (len)
        *len = n;
    return data;
}

/*
 * An error nobody caught.
 *
 * It goes to the terminal, as it always did -- that is the record.  But an
 * application run from a desktop has no terminal, and until now a handler that
 * threw left it running with nothing said and nothing done: the button just
 * stopped working.  So it is also shown, with the stack, which is the part that
 * says where to look.
 *
 * `Application.OnError = (message, stack) => ...` takes it over: an application
 * that would rather log it, or show it its own way, says so.
 */
static bool reporting_error;   /* one at a time, and never from inside one */

static void on_error_dismissed(GObject *src, GAsyncResult *res, gpointer data)
{
    gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(src), res, NULL);
    reporting_error = false;
}

/* The application's own handler, if it set one.  Returns whether it took it. */
static bool error_handled_by_app(JSContext *ctx, const char *msg, const char *stack)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue app    = JS_GetPropertyStr(ctx, global, "Application");
    JSValue fn     = JS_GetPropertyStr(ctx, app, "OnError");
    bool    took   = JS_IsFunction(ctx, fn);

    if (took) {
        JSValue argv[2] = { JS_NewString(ctx, msg ? msg : ""),
                            JS_NewString(ctx, stack ? stack : "") };
        JSValue r = JS_Call(ctx, fn, app, 2, (JSValueConst *)argv);

        /* An error inside the error handler is only reported to the terminal:
         * the guard is still up, so it cannot come back here. */
        if (JS_IsException(r))
            JS_FreeValue(ctx, JS_GetException(ctx));

        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[0]);
        JS_FreeValue(ctx, argv[1]);
    }

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, app);
    JS_FreeValue(ctx, global);
    return took;
}

static void report_error(JSContext *ctx, const char *msg, const char *stack)
{
    if (reporting_error)
        return;
    reporting_error = true;

    if (error_handled_by_app(ctx, msg, stack)) {
        reporting_error = false;
        return;
    }

    BtaApp *app = bta_current_app();
    if (!app || !app->gapp) {
        reporting_error = false;      /* no display: the terminal had it */
        return;
    }

    GtkAlertDialog *d = gtk_alert_dialog_new("%s", msg ? msg : "Error");
    if (stack && *stack)
        gtk_alert_dialog_set_detail(d, stack);
    gtk_alert_dialog_set_modal(d, TRUE);

    /* choose() and not show(): being told when it is dismissed is what keeps a
     * handler that throws on every tick from stacking up dialogs forever. */
    gtk_alert_dialog_choose(d, gtk_application_get_active_window(app->gapp),
                            NULL, on_error_dismissed, NULL);
    g_object_unref(d);
}

/*
 * The red, and only where red is a colour rather than six characters.
 *
 * This was written unconditionally, and the day the IDE's output pane stopped
 * being a VTE -- which ate them -- the escapes became visible: every traceback
 * in that pane, in a redirected log and in a CI capture arrived spelled
 * `<ESC>[1;31mBintana error:<ESC>[0m`. Measured through a pipe, which is where
 * every one of those reads it from.
 *
 * `isatty` is the whole of the answer and is what every program that colours its
 * output does. Asked once: stderr does not become a terminal halfway through a
 * run, and this is called from a signal-ish place where the less done the
 * better.
 */
static bool error_to_terminal(void)
{
    static int tty = -1;
    if (tty < 0)
        tty = isatty(STDERR_FILENO) ? 1 : 0;

    return tty == 1;
}

static const char *error_red(void)   { return error_to_terminal() ? "\x1b[1;31m" : ""; }
static const char *error_plain(void) { return error_to_terminal() ? "\x1b[0m"    : ""; }

/* The fatal alert's answer, which is what lets the caller quit afterwards. */
static void on_fatal_dismissed(GObject *src, GAsyncResult *res, gpointer data)
{
    gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(src), res, NULL);
    g_main_loop_quit(data);
}

void bta_report_fatal(BtaApp *app, const char *message)
{
    fprintf(stderr, "\n%sBintana error:%s %s\n", error_red(), error_plain(),
            message ? message : "(unknown)");
    fflush(stderr);

    /*
     * A console project is started from a shell and the line above is enough.
     * A form project started from a menu has nowhere for stderr to go, so this
     * is the one moment an error has to interrupt, and the nested loop is what
     * makes it readable: the caller is about to quit, and returning first would
     * take the window down with the alert.
     */
    if (!app || !app->gapp || !gtk_is_initialized())
        return;

    GtkAlertDialog *d    = gtk_alert_dialog_new("%s", message ? message : "Error");
    GMainLoop      *loop = g_main_loop_new(NULL, FALSE);

    gtk_alert_dialog_set_modal(d, TRUE);
    gtk_alert_dialog_choose(d, gtk_application_get_active_window(app->gapp), NULL,
                            on_fatal_dismissed, loop);
    g_main_loop_run(loop);

    g_main_loop_unref(loop);
    g_object_unref(d);
}

void bta_dump_error(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);

    const char *msg   = JS_ToCString(ctx, exc);
    const char *trace = NULL;
    JSValue     stack = JS_UNDEFINED;

    fprintf(stderr, "\n%sBintana error:%s %s\n",
            error_red(), error_plain(), msg ? msg : "(unknown)");

    if (JS_IsError(exc)) {
        stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (!JS_IsUndefined(stack) && !JS_IsNull(stack)) {
            trace = JS_ToCString(ctx, stack);
            if (trace && *trace)
                fprintf(stderr, "%s\n", trace);
        }
    }
    fflush(stderr);

    report_error(ctx, msg, trace);

    JS_FreeCString(ctx, trace);
    JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, stack);
    JS_FreeValue(ctx, exc);
}

/* Promise callbacks and other microtasks only run when we pump them. */
void bta_drain_jobs(JSRuntime *rt)
{
    JSContext *cctx;
    for (;;) {
        int rc = JS_ExecutePendingJob(rt, &cctx);
        if (rc <= 0) {
            if (rc < 0)
                bta_dump_error(cctx);
            break;
        }
    }
}

int bta_eval_file(JSContext *ctx, const char *path)
{
    size_t  len;
    char   *src = bta_read_file(path, &len);

    if (!src) {
        fprintf(stderr, "bintana: cannot read %s\n", path);
        return -1;
    }

    /*
     * Under `--debug` the file is compiled first and run second, with the
     * debugger shown the compiled form in between: that is the only moment the
     * lines it can stop on exist to be read. An ordinary run does neither and
     * evaluates in one step, as it always did.
     */
    JSValue r;
    if (bta_debug_enabled()) {
        r = JS_Eval(ctx, src, len, path,
                    JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT |
                    JS_EVAL_FLAG_COMPILE_ONLY);
        if (!JS_IsException(r)) {
            bta_debug_compiled(ctx, path, r);
            r = JS_EvalFunction(ctx, r);
        }
    } else {
        r = JS_Eval(ctx, src, len, path,
                    JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    }
    g_free(src);

    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        return -1;
    }
    JS_FreeValue(ctx, r);
    bta_drain_jobs(JS_GetRuntime(ctx));
    return 0;
}

static void close_hatches(JSContext *ctx);

/*
 * Where the compiler said the text stopped making sense.
 *
 * The only place a line number is written down is the exception's own stack,
 * which reads `    at <check>:12:5` -- and `<check>` is the name *this* function
 * gave the fragment, so there is nothing to guess about whose frame it is.
 * Absent (`:12` never printed, an error raised with no position) leaves both at
 * zero, which is an honest "it does not say" rather than a line 1 nobody chose.
 *
 * The digits are read one at a time on purpose: GTK has called `setlocale()` by
 * the time any of this runs, and a number that came out of a compiler is not the
 * desktop's to spell.  Same reason `bta_locale.c` parses Plural-Forms by hand.
 */
static void check_position(const char *stack, int *line, int *column)
{
    *line = *column = 0;

    const char *at = stack ? strstr(stack, "<check>:") : NULL;
    if (!at)
        return;

    const char *p = at + strlen("<check>:");
    int         n = 0;
    if (!g_ascii_isdigit(*p))
        return;
    while (g_ascii_isdigit(*p))
        n = n * 10 + (*p++ - '0');
    *line = n;

    if (*p != ':')
        return;
    p++;
    for (n = 0; g_ascii_isdigit(*p); p++)
        n = n * 10 + (*p - '0');
    *column = n;
}

/*
 * `null` when the text is valid JavaScript, and `{ Message, Line, Column }` when
 * it is not.  Compiled and not run: asking is not the same as executing.
 *
 * **A record and not a string**, which is a change from what this first
 * answered: the caller that matters is an editor, and an editor wants to put the
 * complaint *on the line it is about*.  Everything the compiler knows was there
 * and was being thrown away, leaving whoever wanted it to pick the number back
 * out of English prose -- a small language inside a value, which is the shape
 * this project refuses everywhere else.
 *
 * Both answers keep the test that was already being written (`if (bad)`), since
 * `null` is as falsy as the `""` it replaces.
 */
static JSValue js_check_source(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *src = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!src)
        return JS_ThrowTypeError(ctx, "Application.CheckSource(text) needs text");

    JSValue r = JS_Eval(ctx, src, strlen(src), "<check>",
                        JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT |
                        JS_EVAL_FLAG_COMPILE_ONLY);
    JS_FreeCString(ctx, src);

    if (!JS_IsException(r)) {
        JS_FreeValue(ctx, r);
        return JS_NULL;
    }
    JS_FreeValue(ctx, r);

    JSValue     err = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, err);

    /* Only from an object: a thrown primitive has no stack to ask for, and
     * asking anyway would leave an exception pending behind this answer. */
    JSValue     st    = JS_IsObject(err) ? JS_GetPropertyStr(ctx, err, "stack")
                                         : JS_UNDEFINED;
    const char *stack = JS_IsString(st) ? JS_ToCString(ctx, st) : NULL;
    int         line = 0, column = 0;
    check_position(stack, &line, &column);

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Message",
                      JS_NewString(ctx, msg && *msg ? msg : "invalid source"));
    JS_SetPropertyStr(ctx, out, "Line",   JS_NewInt32(ctx, line));
    JS_SetPropertyStr(ctx, out, "Column", JS_NewInt32(ctx, column));

    if (stack)
        JS_FreeCString(ctx, stack);
    JS_FreeValue(ctx, st);
    JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, err);
    return out;
}

static bool is_identifier(const char *s)
{
    if (!s || !*s || (!g_ascii_isalpha(*s) && *s != '_' && *s != '$'))
        return false;
    for (const char *p = s; *p; p++)
        if (!g_ascii_isalnum(*p) && *p != '_' && *p != '$')
            return false;
    return true;
}

/* Every dot-separated segment an identifier, and at least one segment. */
static bool is_class_path(const char *s)
{
    if (!s || !*s)
        return false;

    char **parts = g_strsplit(s, ".", -1);
    bool   ok    = true;

    for (int i = 0; parts[i]; i++)
        if (!is_identifier(parts[i]))
            ok = false;

    g_strfreev(parts);
    return ok;
}

/*
 * A class by name, which is how a .form names a type and how project.json names
 * the startup form.
 *
 * Two ways a class can be reachable, and both have to work:
 *
 *   Form1            `class Form1 {}` at the top level of a script binds into
 *                    the global lexical scope and *not* onto globalThis, so a
 *                    plain property read misses it.  Evaluating the bare
 *                    identifier is what makes Gambas-style "every class is
 *                    visible everywhere, no imports" work.
 *
 *   Widgets.Stepper  a namespace is an ordinary object on globalThis, so a
 *                    qualified name is a walk down properties -- no eval, which
 *                    is the point: nothing here needs the compiler.
 */
JSValue bta_lookup_global(JSContext *ctx, const char *name)
{
    if (!is_class_path(name))
        return JS_ThrowTypeError(ctx, "'%s' is not a valid class name", name);

    char  **parts = g_strsplit(name, ".", -1);
    JSValue v     = JS_GetGlobalObject(ctx);

    for (int i = 0; parts[i]; i++) {
        JSValue next = JS_GetPropertyStr(ctx, v, parts[i]);
        JS_FreeValue(ctx, v);

        if (JS_IsException(next)) {
            g_strfreev(parts);
            return next;
        }
        /* A qualified name that goes nowhere is an error and not a miss: there
         * is no lexical scope to fall back to for `A.B`, and pretending the
         * class is merely "built in code" would hide the typo. */
        if (JS_IsUndefined(next) || JS_IsNull(next)) {
            JS_FreeValue(ctx, next);
            v = JS_UNDEFINED;
            break;
        }
        v = next;
    }

    bool qualified = parts[0] && parts[1];
    g_strfreev(parts);

    if (!JS_IsUndefined(v) || qualified)
        return v;
    JS_FreeValue(ctx, v);

    return JS_Eval(ctx, name, strlen(name), "<class-lookup>", JS_EVAL_TYPE_GLOBAL);
}

/* ---------------------------------------------------------------- globals */

/* ------------------------------------------------------------------ logging
 *
 * What `console` was pretending to be.  An application logs at a level, and
 * where that goes is the application's business: the terminal it was started
 * from, the journal, or anywhere a handler can reach.
 *
 * Levels are strings, like every other enumerated value in this runtime, so
 * they read the same in code as in a .form.
 *
 * The base is stdout and stderr, which every system has.  Anything better is an
 * extension: bta_journal.c is the systemd one, and another operating system's
 * would be another file answering the same two questions.
 */
enum { BTA_LOG_DEBUG, BTA_LOG_INFO, BTA_LOG_WARNING, BTA_LOG_ERROR,
       BTA_LOG_NONE };

static const char *const log_level_names[] = {
    "Debug", "Info", "Warning", "Error", "None"
};

/* Debug is off unless asked for: it exists to be left in the code. */
static int  log_threshold = BTA_LOG_INFO;
static bool log_to_platform;   /* the system's own log, when it has one */
static bool logging;           /* a handler that logs must not come back here */

static int log_level_by_name(const char *name)
{
    for (int i = BTA_LOG_DEBUG; i <= BTA_LOG_NONE; i++)
        if (!g_ascii_strcasecmp(name, log_level_names[i]))
            return i;
    return -1;
}

/* True when the application took the message; it decides where it goes. */
static bool log_handled_by_app(JSContext *ctx, int level, const char *text)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue logger = JS_GetPropertyStr(ctx, global, "Logger");
    JSValue fn     = JS_GetPropertyStr(ctx, logger, "Handler");
    bool    took   = JS_IsFunction(ctx, fn);

    if (took) {
        JSValue argv[2] = { JS_NewString(ctx, log_level_names[level]),
                            JS_NewString(ctx, text) };
        JSValue r = JS_Call(ctx, fn, logger, 2, (JSValueConst *)argv);

        /* A handler that throws is reported once, to the terminal: the guard is
         * up, so it cannot log its way back in here. */
        if (JS_IsException(r)) {
            JSValue e = JS_GetException(ctx);
            const char *m = JS_ToCString(ctx, e);
            fprintf(stderr, "bintana: Logger.Handler failed: %s\n", m ? m : "?");
            JS_FreeCString(ctx, m);
            JS_FreeValue(ctx, e);
        }
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[0]);
        JS_FreeValue(ctx, argv[1]);
    }

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, logger);
    JS_FreeValue(ctx, global);
    return took;
}

/*
 * Where a message goes when the application has not said otherwise.
 *
 * stdout and stderr are the base and every system has them; a platform backend
 * is asked first and is allowed to decline, in which case the terminal still
 * gets it.  Nothing here knows what a journal is -- see bta_journal.c.
 */
static void log_write(int level, const char *text)
{
    if (log_to_platform && bta_journal_send(level, text))
        return;

    /* Warnings and errors to stderr, which is where a program's complaints
     * belong and where anything supervising it looks for them. */
    FILE *out = level >= BTA_LOG_WARNING ? stderr : stdout;
    fprintf(out, "%s: %s\n", log_level_names[level], text);
    fflush(out);
}

static JSValue js_log(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv, int level)
{
    if (level < log_threshold || logging)
        return JS_UNDEFINED;

    GString *line = g_string_new(NULL);
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        if (i)
            g_string_append_c(line, ' ');
        g_string_append(line, s ? s : "?");
        JS_FreeCString(ctx, s);
    }

    logging = true;
    if (!log_handled_by_app(ctx, level, line->str))
        log_write(level, line->str);
    logging = false;

    g_string_free(line, TRUE);
    return JS_UNDEFINED;
}

/*
 * A Debug line from C code that has no argv to join: threshold, Handler,
 * sink -- everything js_log does once the line exists.
 */
void bta_log_debug(JSContext *ctx, const char *text)
{
    if (BTA_LOG_DEBUG < log_threshold || logging)
        return;
    logging = true;
    if (!log_handled_by_app(ctx, BTA_LOG_DEBUG, text))
        log_write(BTA_LOG_DEBUG, text);
    logging = false;
}

/*
 * Same, minus the Handler: for lines arriving where JS must not run. A Wait
 * iterates a context of its own, and a Handler closing the form under the
 * blocked caller is the crash DoEvents was refused for -- so traffic logged
 * from inside one goes to the terminal or the journal, and never to a
 * function.
 */
void bta_log_debug_plain(const char *text)
{
    if (BTA_LOG_DEBUG < log_threshold)
        return;
    log_write(BTA_LOG_DEBUG, text);
}

static JSValue js_log_get_level(JSContext *ctx, JSValueConst this_val)
{
    return JS_NewString(ctx, log_level_names[log_threshold]);
}

static JSValue js_log_set_level(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    const char *name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;

    int level = log_level_by_name(name);
    JSValue e = JS_UNDEFINED;

    if (level < 0)
        e = JS_ThrowRangeError(ctx, "Logger.Level: no level called '%s'", name);
    else
        log_threshold = level;

    JS_FreeCString(ctx, name);
    return e;
}

static JSValue js_log_get_target(JSContext *ctx, JSValueConst this_val)
{
    return JS_NewString(ctx, log_to_platform ? "Journal" : "Terminal");
}

static JSValue js_log_set_target(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    const char *name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;

    JSValue e = JS_UNDEFINED;
    if (!g_ascii_strcasecmp(name, "Terminal")) {
        log_to_platform = false;
    } else if (!g_ascii_strcasecmp(name, "Journal")) {
        /* Refused rather than ignored: an application that asked to log to the
         * journal and got the terminal would never find out. */
        if (!bta_journal_available())
            e = JS_ThrowRangeError(ctx, "Logger.Target: this build has no journal");
        else
            log_to_platform = true;
    } else {
        e = JS_ThrowRangeError(ctx, "Logger.Target: 'Terminal' or 'Journal', not '%s'",
                               name);
    }

    JS_FreeCString(ctx, name);
    return e;
}

static const JSCFunctionListEntry log_props[] = {
    JS_CFUNC_MAGIC_DEF("Debug",   1, js_log, BTA_LOG_DEBUG),
    JS_CFUNC_MAGIC_DEF("Info",    1, js_log, BTA_LOG_INFO),
    JS_CFUNC_MAGIC_DEF("Warning", 1, js_log, BTA_LOG_WARNING),
    JS_CFUNC_MAGIC_DEF("Error",   1, js_log, BTA_LOG_ERROR),
    JS_CGETSET_DEF("Level",  js_log_get_level,  js_log_set_level),
    JS_CGETSET_DEF("Target", js_log_get_target, js_log_set_target),
};

static JSValue js_print(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        printf("%s%s", i ? " " : "", s ? s : "?");
        JS_FreeCString(ctx, s);
    }
    putchar('\n');
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue js_quit(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    int code = 0;
    if (argc > 0)
        JS_ToInt32(ctx, &code, argv[0]);

    if (g_app) {
        g_app->exit_code = code;
        if (g_app->gapp)
            g_application_quit(G_APPLICATION(g_app->gapp));

        /* A console project's loop is ours, and `main` can quit before it has
         * started -- which is the ordinary shape of a program that decides it
         * has nothing to do.  The flag is what run_console reads then; the loop
         * only exists to be stopped from a callback later on. */
        g_app->quitting = true;
        if (g_app->loop)
            g_main_loop_quit(g_app->loop);
    }
    return JS_UNDEFINED;
}

/*
 * Message.Info / .Warning / .Error -- GTK4 alert dialogs are fire-and-forget,
 * so these show and return rather than blocking like VB's MsgBox.
 *
 * **The first argument is a declared position for prose**, so it goes through
 * the catalogue and takes `{0}`-style arguments of its own:
 *
 *     Message.Info("Saved");
 *     Message.Error("Cannot open {0}: {1}", path, e.message);
 *
 * Which is why a message needs no `Locale.Text` around it.  The idea is the same
 * one `BtaClass.texts` carries for properties -- *this position holds text a
 * person reads* -- and a position is a position whether it is a property or an
 * argument.  Interpolating here rather than at the call site is what keeps the
 * msgid a literal an extractor can find; a template literal would have arrived
 * already filled in, and no catalogue could ever match it.
 *
 * The residual risk, stated rather than hidden: a string is a string at
 * runtime, so `Message.Error(e.message)` is looked up too, and would be
 * translated if an exception's text happened to equal a UI label exactly.  That
 * is a far smaller population than the one flowing through a Label's Text --
 * which is why a *setter* doing this was refused and an argument doing it was
 * not.
 */
static JSValue js_message(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv, int magic)
{
    char *text = NULL;

    if (argc > 0) {
        const char *msgid = JS_ToCString(ctx, argv[0]);
        if (msgid) {
            const char *found = bta_locale_lookup(NULL, msgid);
            text = bta_locale_format(ctx, found ? found : msgid,
                                     argc - 1, argv + 1);
            JS_FreeCString(ctx, msgid);
        }
    }
    BtaApp *app = bta_current_app();

    if (app && app->gapp) {
        static const char *headings[] = { NULL, "Warning", "Error" };
        GtkAlertDialog *d;

        if (headings[magic]) {
            d = gtk_alert_dialog_new("%s", headings[magic]);
            gtk_alert_dialog_set_detail(d, text ? text : "");
        } else {
            d = gtk_alert_dialog_new("%s", text ? text : "");
        }
        gtk_alert_dialog_set_modal(d, TRUE);
        gtk_alert_dialog_show(d, gtk_application_get_active_window(app->gapp));
        g_object_unref(d);
    } else {
        fprintf(stderr, "message: %s\n", text ? text : "");
    }
    g_free(text);
    return JS_UNDEFINED;
}

/* Application.HasIcon(name): does anything in the icon search path answer to
 * that name?  The project's own icons/ directory is in there too. */
static JSValue js_has_icon(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!name)
        return JS_ThrowTypeError(ctx, "HasIcon(name) expects a name");

    bool has = bta_icon_available(NULL, name);
    JS_FreeCString(ctx, name);
    return JS_NewBool(ctx, has);
}

/*
 * Application.HasCommand(name): is there such a program on the PATH?
 *
 * The same question `HasIcon` answers about an icon, and it exists for the same
 * reason: only whoever picks the name can choose a fallback.  An application that
 * hands a file to an external tool has to be able to offer the one that is
 * installed rather than the one it was written against -- and `Exec` **throws**
 * when the program is not there, so without this the only way to find out is to
 * try it and catch, which is an exception used as a question.
 *
 * A path with a separator in it is answered by looking at the file, so a command
 * somebody configured by hand ("/opt/poedit/bin/poedit") is checked too.
 */
static JSValue js_has_command(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!name)
        return JS_ThrowTypeError(ctx, "HasCommand(name) expects a name");

    bool has;
    if (strchr(name, G_DIR_SEPARATOR)) {
        has = g_file_test(name, G_FILE_TEST_IS_EXECUTABLE) &&
              !g_file_test(name, G_FILE_TEST_IS_DIR);
    } else {
        char *found = g_find_program_in_path(name);
        has = found != NULL;
        g_free(found);
    }

    JS_FreeCString(ctx, name);
    return JS_NewBool(ctx, has);
}

/*
 * Application.Icons([contains]): every icon name the search path offers, sorted.
 *
 * HasIcon answers about a name one already has in mind; this is the other
 * question -- what is there at all -- which is what anything that lets a person
 * *choose* an icon needs. The IDE's picker is the case that asked for it.
 *
 * The names come from the theme's index and are not rendered: a theme can list
 * one it does not really ship, so a chooser showing a page of them checks that
 * page with HasIcon rather than paying for thousands of renders up front.
 */
static JSValue js_icons(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    const char *want = argc > 0 && JS_IsString(argv[0])
                           ? JS_ToCString(ctx, argv[0]) : NULL;

    /* No display, no themes: a console project has none, and asking GTK about
     * the icons of a display that is not there is an assertion, not an empty
     * answer. */
    GdkDisplay   *display = gdk_display_get_default();
    GtkIconTheme *theme   = display ? gtk_icon_theme_get_for_display(display) : NULL;
    JSValue       out     = JS_NewArray(ctx);

    if (!theme) {
        JS_FreeCString(ctx, want);
        return out;
    }

    char   **names = gtk_icon_theme_get_icon_names(theme);
    uint32_t n     = 0;

    for (char **p = names; p && *p; p++) {
        if (want && *want && !strstr(*p, want))
            continue;
        JS_SetPropertyUint32(ctx, out, n++, JS_NewString(ctx, *p));
    }
    g_strfreev(names);
    JS_FreeCString(ctx, want);

    /* Sorted, because a chooser shows them in order and the theme does not
     * promise one. Done here so every caller gets it without asking. */
    JSValue sort = JS_GetPropertyStr(ctx, out, "sort");
    JSValue r    = JS_Call(ctx, sort, out, 0, NULL);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, sort);
    return out;
}

/* Below, with the library search path they share with `uses`: the IDE opens other
 * projects, so it asks about their libraries and not its own. */
static JSValue js_library_path(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv);
static JSValue js_libraries(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv);

/* Answers false when a library carried a native plugin that cannot be used, in
 * which case the caller stops the program. See bta_plugins_load. */
static bool install_globals(BtaApp *app)
{
    JSContext *ctx    = app->ctx;
    JSValue    global = JS_GetGlobalObject(ctx);

    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, js_print, "print", 1));

    /*
     * The runtime's own version, out of the one place it is declared:
     * `project()` in CMakeLists. It used to be a literal in rad.js while that
     * line carried no version at all, so the two could differ and nothing would
     * ever say so. An application's own version is `Application.Version`, which
     * is a different question with a different answer.
     */
    JS_SetPropertyStr(ctx, global, "BTA_VERSION",
                      JS_NewString(ctx, BTA_VERSION_STRING));

    /*
     * Logger, which is what `console` was standing in for badly: its .log and
     * .error both went to stdout, so the one distinction it offered was a lie.
     *
     * The long name on purpose: `Log` next to a number reads as a logarithm.
     */
    JSValue logger = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, logger, log_props, G_N_ELEMENTS(log_props));
    JS_SetPropertyStr(ctx, global, "Logger", logger);

    /* Application: the Gambas-ish ambient singleton. */
    JSValue application = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, application, "Name", JS_NewString(ctx, app->name));
    /*
     * What the *application* calls its release, out of its own project.json --
     * not the runtime's, which is `BTA_VERSION`. Every program that shows a
     * version had nowhere to read one from and had to write it down a second
     * time in its own source, which is the copy that goes stale. "" when the
     * project declares none: a version is optional, and absent is not an error.
     */
    JS_SetPropertyStr(ctx, application, "Version", JS_NewString(ctx, app->version));
    JS_SetPropertyStr(ctx, application, "Directory", JS_NewString(ctx, app->dir));
    JS_SetPropertyStr(ctx, application, "Quit",
                      JS_NewCFunction(ctx, js_quit, "Quit", 1));

    /* A directory of its own under the user's config, created up front so
     * saving a setting is one File.Save and no ceremony.  Named after the
     * project, which is why two projects never read each other's settings --
     * and why the test projects cannot touch the IDE's. */
    char *slug = g_strdup(app->name);
    g_strdelimit(slug, G_DIR_SEPARATOR_S, '-');
    char *config = g_build_filename(g_get_user_config_dir(), "bintana", slug, NULL);
    g_mkdir_with_parents(config, 0755);
    JS_SetPropertyStr(ctx, application, "ConfigDirectory", JS_NewString(ctx, config));
    g_free(config);
    g_free(slug);

    /* Whether the desktop has an icon by that name.  Only whoever picks the
     * name can choose a fallback, and an icon the theme lacks is dropped
     * silently -- which on an icon-only button leaves nothing at all. */
    JS_SetPropertyStr(ctx, application, "HasIcon",
                      JS_NewCFunction(ctx, js_has_icon, "HasIcon", 1));
    JS_SetPropertyStr(ctx, application, "Icons",
                      JS_NewCFunction(ctx, js_icons, "Icons", 1));

    /*
     * How this desktop arranges the decoration of a window: the
     * `gtk-decoration-layout` setting, "icon,menu:minimize,maximize,close" --
     * what goes at the start of the title bar, a colon, what goes at the end.
     * The window manager reads the same setting, so it is the one place that
     * says where *this* desktop puts the close button.
     *
     * An application drawing a title bar of its own has no other way to ask, and
     * a guess is wrong for half the desktops there are: the IDE's preview of the
     * form being designed is the case that asked for it.
     *
     * Read once, here, because `install_globals` runs from `activate` and GTK is
     * up by then; a desktop that rearranges its buttons mid-session is not worth
     * a signal.
     */
    {
        GtkSettings *settings = gtk_settings_get_default();
        char        *layout   = NULL;

        if (settings)
            g_object_get(settings, "gtk-decoration-layout", &layout, NULL);
        JS_SetPropertyStr(ctx, application, "DecorationLayout",
                          JS_NewString(ctx, layout ? layout : ""));
        g_free(layout);
    }

    /* And whether an external program is installed, which is the same question
     * about a different kind of name -- `Exec` throws when it is not, so this is
     * what lets a caller choose among the tools a desktop happens to have. */
    JS_SetPropertyStr(ctx, application, "HasCommand",
                      JS_NewCFunction(ctx, js_has_command, "HasCommand", 1));

    /* Would this text compile?  The one honest use of `Function` -- an IDE that
     * writes code wants to know before it saves -- published on its own so the
     * string-to-code hatch does not have to stay open for it. */
    JS_SetPropertyStr(ctx, application, "CheckSource",
                      JS_NewCFunction(ctx, js_check_source, "CheckSource", 1));

    /*
     * `Application.LibraryPath(name, [project])`: where a library by that name
     * is, or `""`.
     *
     * **Published so that the IDE does not have a second copy of the search
     * path.** The IDE opens *other* projects, so it cannot ask about its own
     * libraries -- it has to ask about theirs, which is what the second argument
     * is for. Two implementations of a six-entry lookup would drift the first
     * time one of them was fixed, and the one that drifted would be the one
     * nobody runs from a shell.
     */
    JS_SetPropertyStr(ctx, application, "LibraryPath",
                      JS_NewCFunction(ctx, js_library_path, "LibraryPath", 2));

    /*
     * `Application.Libraries([project])`: the names there are to be used.
     *
     * The other direction of the same lookup, and here for the same reason. A
     * name can be *resolved* one at a time, which is what a program that already
     * knows what it uses needs; **a tool that offers a choice needs the list**,
     * and the IDE had nowhere to get one -- so `uses` was the one thing in
     * `project.json` that could only be written by hand.
     *
     * Walking the six places is the runtime's business either way: the IDE
     * doing it would be the second copy of the search path that `LibraryPath`
     * exists to prevent, and it would be the copy that goes stale, because the
     * first one is the one every program runs.
     */
    JS_SetPropertyStr(ctx, application, "Libraries",
                      JS_NewCFunction(ctx, js_libraries, "Libraries", 1));

    /* Where the runtime binary lives, so a project can re-invoke it. */
    char *exe = g_file_read_link("/proc/self/exe", NULL);
    JS_SetPropertyStr(ctx, application, "Executable",
                      JS_NewString(ctx, exe ? exe : "bintana"));
    g_free(exe);

    JSValue args = JS_NewArray(ctx);
    for (uint32_t i = 0; app->args && app->args[i]; i++)
        JS_SetPropertyUint32(ctx, args, i, JS_NewString(ctx, app->args[i]));
    JS_SetPropertyStr(ctx, application, "Arguments", args);

    JS_SetPropertyStr(ctx, global, "Application", application);

    JSValue message = JS_NewObject(ctx);
    static const char *kinds[] = { "Info", "Warning", "Error" };
    for (int i = 0; i < 3; i++)
        JS_SetPropertyStr(ctx, message, kinds[i],
                          JS_NewCFunctionMagic(ctx, js_message, kinds[i], 1,
                                               JS_CFUNC_generic_magic, i));
    JS_SetPropertyStr(ctx, global, "Message", message);

    /*
     * Before the widgets, and so before any .form is loaded: the loader looks
     * every declared piece of prose up in whatever catalogue this found.
     */
    bta_locale_init(ctx, global, app->dir, app->libs);
    bta_bytes_init(ctx, global);
    bta_decimal_init(ctx, global);
    bta_painter_init(ctx, global);
    bta_metrics_init(ctx, global);
    bta_day_init(ctx, global);
    bta_database_init(ctx, global);
    bta_sqlite_init(ctx, global);
    bta_http_init(ctx, global);
    bta_media_init(ctx, global);

    /*
     * A library the project named may carry native code -- `<name>/<name>.so`
     * beside its `.js` -- and it installs its globals here: after the runtime's
     * own (a plugin may ask for `Application` or `Logger`) and before `rad.js`,
     * which the library's JavaScript half may want to build on. Widget classes
     * are registered below and a plugin cannot add one; that is a decision, and
     * bta_plugin.h says why. See bta_plugin.c.
     */
    if (!bta_plugins_load(app, ctx, global)) {
        JS_FreeValue(ctx, global);
        return false;
    }

    bta_widgets_init(ctx, global);
    bta_menu_init(ctx);
    bta_sys_init(ctx, global);

    JS_FreeValue(ctx, global);

    JSValue r = JS_Eval(ctx, bta_prelude_js, strlen(bta_prelude_js),
                        "<rad.js>", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);

    /* Last, and only after rad.js: it captured what it needs. */
    close_hatches(ctx);
    return true;
}

/*
 * The ways back into the raw language, closed once rad.js has what it needs.
 *
 * Deleting a global does not take away what it reached -- a project's classes
 * are still there, Namespace still publishes, and rad.js still schedules -- it
 * takes away the *name*.  Whatever needs one of these captured it in a closure
 * while it still existed, which is why this runs after the prelude and before
 * the first line of any project.
 *
 * What goes, and why:
 *
 *   eval, Function   the two ways to turn a string into code.  Nothing in
 *                    Bintana does that; Application.CheckSource covers the one
 *                    honest use, which is asking whether text would compile.
 *                    Function.prototype.constructor is the same function by
 *                    another road, so it goes too.
 *   globalThis       the language's own back door to everything at once.  A
 *                    project publishes with Namespace(), which is the name for
 *                    that here.
 *   Reflect          metaprogramming this language has no use for, and the
 *                    remaining way to poke at objects by name.
 *   setTimeout &c    the raw scheduling primitives, replaced by Timer --
 *                    Timer.After and Timer.Every say the same in one line and
 *                    hand back something that can still be stopped.
 *   monotonic        the forward-only clock, replaced by Stopwatch.  A single
 *                    reading of it counts from the machine's boot and means
 *                    nothing on its own; leaving the name would invite it being
 *                    printed or stored as if it were a time.
 *
 * The compiler itself stays: JS_Eval() is how a project is loaded at all.
 * This is curation of the surface, not a sandbox -- a project still holds every
 * capability the runtime gave it, and Terminal.Run is Exec by another name.
 */
static void delete_named(JSContext *ctx, JSValueConst obj, const char *name)
{
    JSAtom atom = JS_NewAtom(ctx, name);
    JS_DeleteProperty(ctx, obj, atom, 0);
    JS_FreeAtom(ctx, atom);
}

static void close_hatches(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);

    JSValue fn = JS_GetPropertyStr(ctx, global, "Function");
    if (JS_IsObject(fn)) {
        JSValue proto = JS_GetPropertyStr(ctx, fn, "prototype");
        delete_named(ctx, proto, "constructor");
        JS_FreeValue(ctx, proto);
    }
    JS_FreeValue(ctx, fn);

    /*
     * GeneratorFunction is the same hatch by a side door: it has no global name,
     * but every generator's prototype carries it and it compiles strings just as
     * Function does.  (AsyncFunction needs Promise, which is not installed.)
     */
    JSValue gen = JS_Eval(ctx, "(function* () {})", 17, "<hatches>",
                          JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsException(gen)) {
        JSValue proto = JS_GetPrototype(ctx, gen);
        delete_named(ctx, proto, "constructor");
        JS_FreeValue(ctx, proto);
    }
    JS_FreeValue(ctx, gen);

    /*
     * Object, emptied.
     *
     * What a control can be asked for is answered by Widget.PropertyNames(),
     * what a plain object holds by Dictionary, and a property is written by
     * declaring `get`/`set` in a class -- so every static here either has a word
     * of its own in this language or is machinery rad.js is built out of, and
     * rad.js captured what it needs before this runs.
     *
     * **Emptied and not trimmed, because trimming it was wrong twice.** The
     * singulars were taken and the *plurals* left behind: `defineProperties`
     * wrote the accessors `defineProperty` was removed to withhold, and
     * `getOwnPropertyDescriptors` read what its singular could not -- enough to
     * replace the setter on a Record's field with one that validates nothing.
     * A list of what to keep is a list somebody has to get right again every
     * time the engine grows a member, and quickjs-ng grew `groupBy` and `hasOwn`
     * after that list was written.  So the rule runs the other way: nothing
     * here, and an equivalent is published when something actually needs one.
     * Nothing in this repository called any of these but `keys`.
     *
     * `prototype` is absent from the list because it cannot be taken: it is
     * non-configurable, and rad.js walks the chain up to it.
     */
    JSValue object = JS_GetPropertyStr(ctx, global, "Object");
    static const char *statics[] = {
        /* Choosing or reading a prototype. */
        "create", "getPrototypeOf", "setPrototypeOf",
        /* Writing properties: what Record does, and only Record. */
        "defineProperty", "defineProperties",
        /* Reading them back, which PropertyNames() answers. */
        "getOwnPropertyNames", "getOwnPropertyDescriptor",
        "getOwnPropertyDescriptors", "getOwnPropertySymbols",
        /* Reading a dictionary, which is Dictionary. */
        "keys", "values", "entries", "hasOwn", "fromEntries", "assign",
        /* And the rest, which nothing here has ever asked for.  When something
         * does, it gets a name in this language rather than this one back. */
        "groupBy", "is", "freeze", "isFrozen", "seal", "isSealed",
        "preventExtensions", "isExtensible",
    };
    for (size_t i = 0; i < G_N_ELEMENTS(statics); i++)
        delete_named(ctx, object, statics[i]);

    /*
     * And the same two capabilities spelled on the prototype, where every object
     * in the program carries them: `__defineGetter__` is defineProperty and
     * `__lookupGetter__` is getOwnPropertyDescriptor walking the chain, so
     * `c.__lookupGetter__("Name")` handed out a Record's own accessor and
     * `__defineSetter__` replaced it.  Leaving these while taking the statics
     * would be theatre -- they reach the same prototype -- which is the reason
     * __proto__ went with getPrototypeOf in the first place.
     *
     * hasOwnProperty, isPrototypeOf, propertyIsEnumerable, toString and valueOf
     * stay: they ask about an object rather than rewriting it, and the last two
     * are how a value becomes a string at all.
     */
    JSValue object_proto = JS_GetPropertyStr(ctx, object, "prototype");
    static const char *proto_hatches[] = {
        "__proto__",
        "__defineGetter__", "__defineSetter__",
        "__lookupGetter__", "__lookupSetter__",
    };
    for (size_t i = 0; i < G_N_ELEMENTS(proto_hatches); i++)
        delete_named(ctx, object_proto, proto_hatches[i]);
    JS_FreeValue(ctx, object_proto);
    JS_FreeValue(ctx, object);

    static const char *gone[] = {
        "eval", "Function", "globalThis", "Reflect", "Symbol",
        /* Timer is the published way to schedule: it has a name, a switch and
         * hands itself back, and these are the same thing said worse.  rad.js
         * built Timer out of them and holds what it needs. */
        "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        /* And the forward-only clock, for the same reason one step further: a
         * reading of it is meaningless alone, so Stopwatch is not a convenience
         * over it but the only shape in which it says anything. */
        "monotonic",
    };
    for (size_t i = 0; i < sizeof(gone) / sizeof(gone[0]); i++)
        delete_named(ctx, global, gone[i]);

    JS_FreeValue(ctx, global);
}

/* ---------------------------------------------------------------- project */

static char *json_str(JSContext *ctx, JSValueConst obj, const char *key,
                      const char *fallback)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    char   *out;

    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        out = g_strdup(s);
        JS_FreeCString(ctx, s);
    } else {
        out = g_strdup(fallback);
    }
    JS_FreeValue(ctx, v);
    return out;
}

/* Every .js under a directory, subdirectories included: a project is allowed to
 * organise its classes in folders, and one that lists no sources still means
 * "all of my code". */
static void collect_js(GPtrArray *out, const char *dir)
{
    GDir *d = g_dir_open(dir, 0, NULL);
    if (!d)
        return;

    const char *name;
    while ((name = g_dir_read_name(d))) {
        if (name[0] == '.')
            continue;   /* .git and whatever else a project keeps to itself */

        char *path = g_build_filename(dir, name, NULL);
        if (g_file_test(path, G_FILE_TEST_IS_DIR)) {
            collect_js(out, path);
            g_free(path);
        } else if (g_str_has_suffix(name, ".js")) {
            g_ptr_array_add(out, path);
        } else {
            g_free(path);
        }
    }
    g_dir_close(d);
}

/*
 * ------------------------------------------------------------------ libraries
 *
 * `"uses": ["charts"]` in project.json, and where a library by that name lives.
 *
 * **A library is a directory of `.js` and `.form` files.** No manifest, no
 * version, no dependency of its own: the thing a project is short of is a place
 * for shared *classes*, and a directory of them is the whole of what that takes.
 * Its sources load before the project's, and its forms are indexed with the
 * project's, which is what lets a `.form` say `"type": "Chart"` about a class
 * that is not in the project tree.
 *
 * **Six places, most specific first**, and the reason each is there:
 *
 *   <project>/lib/<name>            the project's own copy, or a private library
 *   $BINTANA_LIB_PATH (colon separated) developing a library outside any tree
 *   ~/.local/share/bintana/lib     installed for one person, without root
 *   <binary>/../lib                 **the source tree**, uninstalled
 *   <binary>/../share/bintana/lib  installed beside the binary
 *   /usr/share/bintana/lib         a distribution's, with the binary elsewhere
 *
 * The two that resolve from the binary are the same relative hop, and that is
 * deliberate: `bin/` and `share/bintana/` move together under `--prefix` and
 * under a packager's DESTDIR, where a path baked in at configure time does not.
 * It is the argument `tools/bintana-ide.in` already makes for the launcher, applied
 * inside the runtime -- and it is what makes `./build/bintana examples/charts` find
 * `lib/charts` in the source tree with nothing configured and nothing installed.
 *
 * The order follows the icon theme's, which this codebase already walks in
 * `tests/icons`: the user's own, then the system's. A library is data, and data
 * is looked up the way the desktop looks up data.
 */
static void lib_candidates(const char *project, GPtrArray *out)
{
    if (project && *project)
        g_ptr_array_add(out, g_build_filename(project, "lib", NULL));

    const char *env = g_getenv("BINTANA_LIB_PATH");
    if (env && *env) {
        char **parts = g_strsplit(env, ":", -1);
        for (int i = 0; parts[i]; i++)
            if (*parts[i])
                g_ptr_array_add(out, g_strdup(parts[i]));
        g_strfreev(parts);
    }

    g_ptr_array_add(out, g_build_filename(g_get_user_data_dir(), "bintana",
                                          "lib", NULL));

    char *exe = g_file_read_link("/proc/self/exe", NULL);
    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);

        g_ptr_array_add(out, g_build_filename(up, "lib", NULL));
        g_ptr_array_add(out, g_build_filename(up, "share", "bintana", "lib", NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(out, g_build_filename("/usr", "share", "bintana", "lib", NULL));
}

/* The directory, or NULL with `tried` filled in -- because a library that is not
 * there has to say where it was looked for, or the answer is unactionable. */
static char *lib_resolve(const char *project, const char *name, GString *tried)
{
    GPtrArray *where = g_ptr_array_new_with_free_func(g_free);
    char      *found = NULL;

    lib_candidates(project, where);

    for (guint i = 0; i < where->len && !found; i++) {
        char *path = g_build_filename(g_ptr_array_index(where, i), name, NULL);

        if (g_file_test(path, G_FILE_TEST_IS_DIR))
            found = path;
        else {
            if (tried)
                g_string_append_printf(tried, "\n  %s", path);
            g_free(path);
        }
    }
    g_ptr_array_free(where, TRUE);
    return found;
}

/*
 * What "uses" named, resolved. A name that is not there **stops the program**:
 * a library whose classes half the forms refer to is not something to carry on
 * without, and the failure a moment later would be `unknown widget type 'Chart'`
 * with nothing about a missing library in it.
 */
static GPtrArray *collect_libs(BtaApp *app, JSValueConst cfg)
{
    GPtrArray *out = g_ptr_array_new_with_free_func(g_free);
    JSContext *ctx = app->ctx;
    JSValue    arr = JS_GetPropertyStr(ctx, cfg, "uses");

    if (!JS_IsArray(arr)) {
        JS_FreeValue(ctx, arr);
        return out;
    }

    JSValue  lenv = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    for (uint32_t i = 0; i < n; i++) {
        JSValue     e    = JS_GetPropertyUint32(ctx, arr, i);
        const char *name = JS_ToCString(ctx, e);

        if (name && *name) {
            GString *tried = g_string_new(NULL);
            char    *dir   = lib_resolve(app->dir, name, tried);

            if (dir) {
                g_ptr_array_add(out, dir);
            } else {
                fprintf(stderr, "bintana: project.json uses \"%s\", which is not "
                                "in any of:%s\n", name, tried->str);
                g_string_free(tried, TRUE);
                JS_FreeCString(ctx, name);
                JS_FreeValue(ctx, e);
                g_ptr_array_free(out, TRUE);
                JS_FreeValue(ctx, arr);
                exit(2);
            }
            g_string_free(tried, TRUE);
        }
        JS_FreeCString(ctx, name);
        JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, arr);
    return out;
}

static JSValue js_library_path(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!name)
        return JS_ThrowTypeError(ctx, "LibraryPath expects (name, [project])");

    const char *project = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]))
        project = JS_ToCString(ctx, argv[1]);

    BtaApp *app = bta_current_app();
    char   *dir = lib_resolve(project ? project : (app ? app->dir : NULL),
                              name, NULL);
    JSValue out = JS_NewString(ctx, dir ? dir : "");

    g_free(dir);
    if (project)
        JS_FreeCString(ctx, project);
    JS_FreeCString(ctx, name);
    return out;
}

/*
 * Every library a project could name, out of the same six places.
 *
 * **A directory is a library**, which is exactly what `lib_resolve` decides
 * with: anything stricter here -- "it must hold a `.js`" -- would be a second
 * opinion about what a library is, and the two would disagree about some
 * directory on somebody's machine. A name found twice is listed once and means
 * the first one, because that is the one `uses` would load.
 *
 * Sorted, for the reason `Icons` is sorted: whoever asks is about to show them
 * in a list, and the order they came off the disk in is not one. That the list
 * no longer says where each came from is not a loss -- `LibraryPath` answers
 * that for any name, with the same search, which is the point of there being
 * only one.
 */
static JSValue js_libraries(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *project = NULL;
    if (argc > 0 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0]))
        project = JS_ToCString(ctx, argv[0]);

    BtaApp    *app   = bta_current_app();
    GPtrArray *where = g_ptr_array_new_with_free_func(g_free);

    lib_candidates(project ? project : (app ? app->dir : NULL), where);

    JSValue     out  = JS_NewArray(ctx);
    /* Owning the keys, so the names outlive the `GDir` they were read from. */
    GHashTable *seen = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    uint32_t    n    = 0;

    for (guint i = 0; i < where->len; i++) {
        const char *place = g_ptr_array_index(where, i);
        GDir       *dir   = g_dir_open(place, 0, NULL);

        /* A place that is not there is most of them, on most machines. */
        if (!dir)
            continue;

        const char *entry;
        while ((entry = g_dir_read_name(dir))) {
            /* A name beginning with a dot is not one anybody wrote in `uses`. */
            if (*entry == '.' || g_hash_table_contains(seen, entry))
                continue;

            char *path = g_build_filename(place, entry, NULL);
            if (g_file_test(path, G_FILE_TEST_IS_DIR)) {
                g_hash_table_add(seen, g_strdup(entry));
                JS_SetPropertyUint32(ctx, out, n++, JS_NewString(ctx, entry));
            }
            g_free(path);
        }
        g_dir_close(dir);
    }

    g_hash_table_destroy(seen);
    g_ptr_array_free(where, TRUE);
    if (project)
        JS_FreeCString(ctx, project);

    JSValue sort = JS_GetPropertyStr(ctx, out, "sort");
    JSValue r    = JS_Call(ctx, sort, out, 0, NULL);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, sort);
    return out;
}

/*
 * A library's own `.js`, in the order it wants them.
 *
 * **A library may carry a `project.json`, and only its `sources` is read.** A
 * library with one class needs no order and most will not have the file; a
 * library whose own classes extend each other does -- `BarChart extends Chart`
 * sorts the wrong way round by path, which is the same reason a project has
 * `sources` at all. Reusing the name and the key is the whole of the mechanism:
 * anybody who has written a project already knows it, and there is no second
 * manifest format to learn or to keep working.
 *
 * Nothing else in that file means anything here: a library is not a project and
 * `bintana <library>` is not a thing to do.
 */
static GPtrArray *lib_sources(BtaApp *app, const char *dir)
{
    GPtrArray *out  = g_ptr_array_new_with_free_func(g_free);
    char      *path = g_build_filename(dir, "project.json", NULL);
    char      *text = NULL;

    if (g_file_test(path, G_FILE_TEST_IS_REGULAR))
        text = bta_read_file(path, NULL);
    g_free(path);

    if (text) {
        JSValue cfg = JS_ParseJSON(app->ctx, text, strlen(text), "library");

        if (!JS_IsException(cfg)) {
            JSValue arr = JS_GetPropertyStr(app->ctx, cfg, "sources");

            if (JS_IsArray(arr)) {
                JSValue  lenv = JS_GetPropertyStr(app->ctx, arr, "length");
                uint32_t n    = 0;
                JS_ToUint32(app->ctx, &n, lenv);
                JS_FreeValue(app->ctx, lenv);

                for (uint32_t i = 0; i < n; i++) {
                    JSValue     e = JS_GetPropertyUint32(app->ctx, arr, i);
                    const char *f = JS_ToCString(app->ctx, e);

                    if (f && *f)
                        g_ptr_array_add(out, g_build_filename(dir, f, NULL));
                    JS_FreeCString(app->ctx, f);
                    JS_FreeValue(app->ctx, e);
                }
            }
            JS_FreeValue(app->ctx, arr);
        } else {
            JS_FreeValue(app->ctx, JS_GetException(app->ctx));
            fprintf(stderr, "bintana: %s/project.json is not JSON; loading its "
                            "sources by path\n", dir);
        }
        JS_FreeValue(app->ctx, cfg);
        g_free(text);
    }

    /* No list, an empty one, or a file that would not parse: every `.js` in it,
     * sorted by path -- the same fallback and the same limit a project has. */
    if (out->len == 0) {
        collect_js(out, dir);
        g_ptr_array_sort_values(out, (GCompareFunc)g_strcmp0);
    }
    return out;
}

/* Explicit "sources" order wins; otherwise every .js in the project, sorted,
 * so that at least the ordering is reproducible. */
static GPtrArray *collect_sources(BtaApp *app, JSValueConst cfg)
{
    GPtrArray *out = g_ptr_array_new_with_free_func(g_free);
    JSContext *ctx = app->ctx;
    JSValue    arr = JS_GetPropertyStr(ctx, cfg, "sources");

    if (JS_IsArray(arr)) {
        JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
        uint32_t n = 0;
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);

        for (uint32_t i = 0; i < n; i++) {
            JSValue     e = JS_GetPropertyUint32(ctx, arr, i);
            const char *s = JS_ToCString(ctx, e);
            if (s)
                g_ptr_array_add(out, g_build_filename(app->dir, s, NULL));
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, e);
        }
    }
    JS_FreeValue(ctx, arr);

    if (out->len == 0) {
        collect_js(out, app->dir);
        /* By path, so that a project without a "sources" list at least loads
         * the same way twice.  Which is all sorting can promise: a class that
         * extends another has to be loaded after it, and only an explicit list
         * can say so. */
        g_ptr_array_sort_values(out, (GCompareFunc)g_strcmp0);
    }

    /*
     * **A library's sources go in front of the project's**, whichever way the
     * project's were chosen: a project's class may extend a library's, and never
     * the other way round.
     */
    GPtrArray *first = g_ptr_array_new_with_free_func(g_free);

    for (guint i = 0; app->libs && i < app->libs->len; i++) {
        const char *dir  = g_ptr_array_index(app->libs, i);
        GPtrArray  *mine = lib_sources(app, dir);

        for (guint j = 0; j < mine->len; j++)
            g_ptr_array_add(first, g_strdup(g_ptr_array_index(mine, j)));
        g_ptr_array_free(mine, TRUE);
    }
    for (guint i = 0; i < out->len; i++)
        g_ptr_array_add(first, g_strdup(g_ptr_array_index(out, i)));

    g_ptr_array_free(out, TRUE);
    return first;
}

/*
 * The JavaScript a Bintana project gets.
 *
 * JS_NewContext() installs the whole standard library; this installs what the
 * language actually uses, which is not the same thing.  Measured on the largest
 * Bintana program there is -- the IDE, its dialogs, its designer and the test
 * projects -- Proxy, Reflect, the typed arrays, Promise, WeakRef, atob/btoa and
 * performance are used exactly zero times.  A smaller language is easier to
 * learn and easier to keep promises about; what is not there cannot drift.
 *
 * Promise is the deliberate one: this is a RAD language with events, not
 * continuations, and leaving it out makes that a fact rather than advice.
 *
 * Eval is *not* optional, and not for the reason it looks.  JS_AddIntrinsicEval
 * does not install the global `eval` -- base objects does that -- it sets the
 * compiler that JS_Eval() itself runs on, so without it the runtime could not
 * load a single project file.  The global one is deleted after boot instead;
 * see close_hatches().
 */
static JSContext *build_context(JSRuntime *rt)
{
    JSContext *ctx = JS_NewContextRaw(rt);
    if (!ctx)
        return NULL;

    if (JS_AddIntrinsicBaseObjects(ctx) ||
        JS_AddIntrinsicEval(ctx) ||        /* the compiler, not the global */
        JS_AddIntrinsicDate(ctx) ||
        JS_AddIntrinsicRegExp(ctx) ||      /* renaming a control is a regexp */
        JS_AddIntrinsicJSON(ctx) ||        /* a .form is JSON */
        JS_AddIntrinsicMapSet(ctx)) {
        JS_FreeContext(ctx);
        return NULL;
    }
    return ctx;
}

BtaApp *bta_app_new(const char *project_dir)
{
    BtaApp *app = g_new0(BtaApp, 1);

    app->startup_form = JS_UNDEFINED;   /* not all-zero: g_new0 is not enough */
    app->dir = g_canonicalize_filename(project_dir, NULL);
    app->rt  = JS_NewRuntime();

    /*
     * A widget tree is recursive data and the code that walks it -- the
     * serialiser, the loader, the designer -- is recursive with it.  QuickJS's
     * default ceiling is 256 KB of stack, which a form ten levels deep can reach
     * once each level costs a few frames: the IDE's own window does.
     *
     * **The budget is a number of bytes and what matters is the number of
     * levels it buys, which is not the same number in the two builds.** Measured
     * here, serialising a tower of `Panel`s: 2 MB is a hundred levels in an
     * ordinary build and **ten** under AddressSanitizer, whose frames are about
     * ten times fatter. Ten is exactly the depth of the IDE's own window, so the
     * sanitized suite had no headroom at all and `tests/ide` failed there --
     * green ordinarily, red under the sanitizer, on a tree nobody had changed.
     * That is the false failure the sanitizer job exists to avoid producing.
     *
     * So the budget follows the build. Both numbers stay well below the 8 MB the
     * thread actually has, so a runaway recursion still gets a clean exception
     * rather than a crash -- checked by measuring where each one throws.
     */
#if defined(__SANITIZE_ADDRESS__) || \
    (defined(__has_feature) && __has_feature(address_sanitizer))
    JS_SetMaxStackSize(app->rt, 6 * 1024 * 1024);
#else
    JS_SetMaxStackSize(app->rt, 2 * 1024 * 1024);
#endif

    app->ctx = build_context(app->rt);
    JS_SetRuntimeOpaque(app->rt, app);
    JS_SetContextOpaque(app->ctx, app);

    /* Defaults, overridden by project.json below. */
    app->name    = g_path_get_basename(app->dir);
    app->version = g_strdup("");
    app->startup = g_strdup("Form1");

    char *cfg_path = g_build_filename(app->dir, "project.json", NULL);
    size_t len;
    char  *cfg_src = bta_read_file(cfg_path, &len);

    if (cfg_src) {
        JSValue cfg = JS_ParseJSON(app->ctx, cfg_src, len, cfg_path);
        if (JS_IsException(cfg)) {
            bta_dump_error(app->ctx);
        } else {
            g_free(app->name);
            g_free(app->version);
            g_free(app->startup);
            app->name    = json_str(app->ctx, cfg, "name", "app");
            app->version = json_str(app->ctx, cfg, "version", "");
            app->startup = json_str(app->ctx, cfg, "startup", "Form1");
            /* A project declares one or the other: "startup" opens a form,
             * "main" calls a function and never touches the display. */
            app->entry   = json_str(app->ctx, cfg, "main", NULL);
            app->libs    = collect_libs(app, cfg);
            app->sources = collect_sources(app, cfg);
        }
        JS_FreeValue(app->ctx, cfg);
        g_free(cfg_src);
    } else {
        fprintf(stderr, "bintana: no project.json in %s, using defaults\n", app->dir);
    }
    g_free(cfg_path);

    if (!app->sources) {
        JSValue empty = JS_NewObject(app->ctx);
        app->sources = collect_sources(app, empty);
        JS_FreeValue(app->ctx, empty);
    }

    g_app = app;
    return app;
}

void bta_app_free(BtaApp *app)
{
    if (!app)
        return;
    if (app->sources)
        g_ptr_array_unref(app->sources);
    if (app->forms)
        g_hash_table_unref(app->forms);
    bta_sys_cleanup();
    bta_http_cleanup();
    bta_media_cleanup();
    bta_locale_cleanup();
    bta_widgets_cleanup(app->ctx);
    JS_FreeContext(app->ctx);
    JS_FreeRuntime(app->rt);
    /* After the context: a plugin's cleanup is C-only, and this is where the
     * shared objects are let go. See the note on bta_plugins_cleanup. */
    bta_plugins_cleanup(app);
    g_clear_object(&app->gapp);
    g_free(app->dir);
    g_free(app->name);
    g_free(app->version);
    g_free(app->startup);
    g_free(app->entry);
    if (g_app == app)
        g_app = NULL;
    g_free(app);
}

/* ------------------------------------------------------------------- boot */

/*
 * <project>/icons is the application's own icon directory: an SVG dropped in
 * there is usable by name, like any icon of the desktop.  A name ending in
 * -symbolic is recoloured by GTK to follow the text colour, so an icon drawn
 * once looks right on a light theme, on a dark one, and inverted on a
 * selected button.
 *
 * It goes at the end of the search path, so an application can never shadow
 * the desktop's own icons by accident.
 */
static void register_app_icons(BtaApp *app)
{
    GdkDisplay *display = gdk_display_get_default();
    if (!display)
        return;

    GtkIconTheme *theme = gtk_icon_theme_get_for_display(display);

    /*
     * The project's first, then every library's: `add_search_path` appends, so
     * this is also the precedence between them -- a project can put its own
     * drawing over a library's by shipping the same name, and neither can
     * shadow the desktop's.
     */
    char *dir = g_build_filename(app->dir, "icons", NULL);
    if (g_file_test(dir, G_FILE_TEST_IS_DIR))
        gtk_icon_theme_add_search_path(theme, dir);
    g_free(dir);

    for (guint i = 0; app->libs && i < app->libs->len; i++) {
        char *lib = g_build_filename(g_ptr_array_index(app->libs, i), "icons", NULL);

        if (g_file_test(lib, G_FILE_TEST_IS_DIR))
            gtk_icon_theme_add_search_path(theme, lib);
        g_free(lib);
    }
}

/*
 * <project>/app.css is the application's own stylesheet: the classes a control
 * wears through `Style`, written once and worn by every control that needs
 * them.  It is the normal way an application says what it looks like, which is
 * why it is found by name and needs nothing in project.json -- the same bargain
 * <project>/icons makes.
 *
 * It loads at PRIORITY_APPLICATION: above the desktop's theme, so the sheet has
 * the last word on what the application looks like, and below the per-widget
 * Background/Font (see bta_widget.c), which are the exception to it.
 *
 * A rule GTK cannot parse is reported and the rest of the sheet is kept, which
 * is what CSS does everywhere else and the only behaviour that leaves an
 * unfinished stylesheet usable.
 */
static void on_css_error(GtkCssProvider *provider, GtkCssSection *section,
                         const GError *error, gpointer user_data)
{
    char *where = gtk_css_section_to_string(section);
    fprintf(stderr, "bintana: app.css: %s: %s\n", where, error->message);
    g_free(where);
}

static void register_app_styles(BtaApp *app)
{
    GdkDisplay *display = gdk_display_get_default();
    if (!display)
        return;

    char *path = g_build_filename(app->dir, "app.css", NULL);
    if (g_file_test(path, G_FILE_TEST_IS_REGULAR)) {
        GtkCssProvider *provider = gtk_css_provider_new();

        g_signal_connect(provider, "parsing-error", G_CALLBACK(on_css_error), NULL);
        gtk_css_provider_load_from_path(provider, path);
        gtk_style_context_add_provider_for_display(
            display, GTK_STYLE_PROVIDER(provider),
            GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
        g_object_unref(provider);   /* the display holds it now */
    }
    g_free(path);
}

/*
 * A project with a `main` and no window.
 *
 * What it is for is the work *around* an application: a test runner, a build
 * step, a tool that reads the desktop's icon themes off the disk.  Those were
 * shell scripts, and a shell script is a second language in the repository with
 * a second set of rules -- so this is the language answering for its own
 * plumbing.
 *
 * **GTK is never initialised here**, and that is the point rather than an
 * economy: a runner that decides whether the suite needs a virtual display
 * cannot be a program that needs one to start.  Everything a form needs is
 * still declared -- the widget classes, `Form`, `Timer` -- but constructing one
 * without a display is a GTK error, not a Bintana one.  A project that draws
 * declares `startup`; this one declares `main`.
 *
 * The loop runs only while something is owed an answer (`bta_sys_pending`), so
 * a `main` that prints and returns ends by returning, and one that spawns a
 * child waits for it without saying so.  `Application.Quit(code)` ends it at
 * any point, and is the only way to end it with a status.
 */
static gboolean console_idle(gpointer user_data)
{
    BtaApp *app = user_data;

    if (bta_sys_pending() + bta_http_pending() + bta_media_pending() > 0)
        return G_SOURCE_CONTINUE;

    g_main_loop_quit(app->loop);
    return G_SOURCE_CONTINUE;   /* removed with the source, after the loop */
}

static int run_console(BtaApp *app)
{
    JSContext *ctx = app->ctx;

    if (!install_globals(app))
        return 2;
    bta_debug_start(ctx);

    for (guint i = 0; i < app->sources->len; i++)
        if (bta_eval_file(ctx, app->sources->pdata[i]) < 0)
            return 1;

    JSValue fn = bta_lookup_global(ctx, app->entry);
    if (JS_IsException(fn) || !JS_IsFunction(ctx, fn)) {
        if (JS_IsException(fn))
            bta_dump_error(ctx);
        else
            fprintf(stderr, "bintana: main function '%s' not found\n", app->entry);
        JS_FreeValue(ctx, fn);
        return 1;
    }

    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
    JS_FreeValue(ctx, fn);
    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        return 1;
    }
    JS_FreeValue(ctx, r);
    bta_drain_jobs(app->rt);

    /*
     * A poll and not a signal from each of the three places work can finish:
     * this only decides *when to notice* that there is nothing left, and
     * noticing 20 ms late costs an exit 20 ms later.  It cannot end a program
     * early -- while a callback runs, the loop is not dispatching this.
     */
    if (!app->quitting && bta_sys_pending() + bta_http_pending() + bta_media_pending() > 0) {
        app->loop  = g_main_loop_new(NULL, FALSE);
        guint tick = g_timeout_add(20, console_idle, app);

        g_main_loop_run(app->loop);

        g_source_remove(tick);
        g_main_loop_unref(app->loop);
        app->loop = NULL;
    }

    return app->exit_code;
}

static void on_activate(GtkApplication *gapp, gpointer user_data)
{
    BtaApp    *app = user_data;
    JSContext *ctx = app->ctx;

    /*
     * **GtkSourceView has to be initialised, and here rather than earlier.**
     *
     * `gtk_source_init` loads the library's CSS and registers its resources
     * against the *default display*, so calling it before `g_application_run`
     * -- which is where GTK itself is initialised and a display appears -- does
     * nothing at all, silently. It has to run once GTK is up, which is here.
     *
     * What it costs to skip is deeply misleading, because every part of the
     * library that is a plain widget works without it: the view, the buffer,
     * syntax highlighting, undo, the search. Only what needs that CSS to size
     * itself fails, and the completion popover is the one thing that does -- so
     * it appears once, is never dismissed, is left behind as a stray window, and
     * answers `gdk_popup_present: assertion 'width > 0' failed` from then on.
     * gtksourceview#300, closed, where the maintainer's answer is exactly this:
     * *"you have no CSS to style the completion list and therefore it can't size
     * itself to anything reasonable."*
     */
    gtk_source_init();

    register_app_icons(app);
    register_app_styles(app);
    if (!install_globals(app)) {
        app->exit_code = 2;
        g_application_quit(G_APPLICATION(gapp));
        return;
    }

    /*
     * Before a line of the project has run, and it **waits**: the IDE has
     * breakpoints to set and a program that started first would have gone past
     * them.  A run with no `--debug` returns from this at once.
     */
    bta_debug_start(ctx);

    for (guint i = 0; i < app->sources->len; i++) {
        if (bta_eval_file(ctx, app->sources->pdata[i]) < 0) {
            app->exit_code = 1;
            g_application_quit(G_APPLICATION(gapp));
            return;
        }
    }

    JSValue klass = bta_lookup_global(ctx, app->startup);
    if (JS_IsException(klass) || !JS_IsFunction(ctx, klass)) {
        if (JS_IsException(klass))
            bta_dump_error(ctx);
        else
            fprintf(stderr, "bintana: startup class '%s' not found\n", app->startup);
        JS_FreeValue(ctx, klass);
        app->exit_code = 1;
        g_application_quit(G_APPLICATION(gapp));
        return;
    }

    JSValue form = JS_CallConstructor(ctx, klass, 0, NULL);
    JS_FreeValue(ctx, klass);
    if (JS_IsException(form)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, form);
        app->exit_code = 1;
        g_application_quit(G_APPLICATION(gapp));
        return;
    }

    JSValue show = JS_GetPropertyStr(ctx, form, "Show");
    JSValue r    = JS_Call(ctx, show, form, 0, NULL);
    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, show);

    /* The startup form is owned by the runtime for the life of the process. */
    app->startup_form = form;
    bta_drain_jobs(app->rt);
}

int bta_app_run(BtaApp *app, int argc, char **argv)
{
    /* A project that declares `main` never opens a display: no GtkApplication,
     * no activate, no GTK. */
    if (app->entry) {
        int rc = run_console(app);
        bta_debug_stopping(app->ctx, rc);
        return rc;
    }

    app->gapp = gtk_application_new(NULL, G_APPLICATION_NON_UNIQUE);
    g_signal_connect(app->gapp, "activate", G_CALLBACK(on_activate), app);

    int rc = g_application_run(G_APPLICATION(app->gapp), argc, argv);

    if (!JS_IsUndefined(app->startup_form)) {
        JS_FreeValue(app->ctx, app->startup_form);
        app->startup_form = JS_UNDEFINED;
    }

    /* Frees what the init registered. Not housekeeping: without it the
     * library's static data is what `tests/asan.sh` reports as ours. */
    gtk_source_finalize();
    rc = app->exit_code ? app->exit_code : rc;

    /* The last thing the debugger hears, so the IDE knows the run is over
     * rather than waiting for a stop that is not coming. */
    bta_debug_stopping(app->ctx, rc);
    return rc;
}
