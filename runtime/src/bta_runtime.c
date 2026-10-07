/*
 * Interpreter setup, project loading and the GTK main loop.
 */
#include "bta.h"
#include "bta_prelude.h"
#include "bta_forms.h"

/* For gtk_source_init/finalize: the library has to be initialised before any of
 * its widgets is built. See bta_app_run. */
#include <gtksourceview/gtksource.h>

#include <errno.h>
#include <glib/gstdio.h>
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

/*
 * What an error is shown in is a window of Bintana's own: `showError` in
 * `forms.js`, built out of the same controls an application uses, with the
 * message as a header, the backtrace apart and Copy beside Close.  This file
 * only asks for it (`show_error_window`).  What is below is the **fallback**, a
 * `GtkAlertDialog`, for the two times that window cannot be had: the error that
 * stops a program before `forms.js` has run (`bta_report_fatal`), and one in
 * `forms.js`'s own code.  It has the same two buttons, **Copy** -- which keeps
 * the alert up -- and Close, which is also Escape.  The words are the runtime's
 * own and so are not translated: a prose position C owns has no catalogue to look
 * in (see `docs/resources.md`).
 */
static const char *const ERROR_BUTTONS[] = { "Copy", "Close", NULL };

static void error_copy(const char *text)
{
    GdkDisplay *display = gdk_display_get_default();
    if (!display)
        return;

    gdk_clipboard_set_text(gdk_display_get_clipboard(display), text);
}

/* What Copy puts on the clipboard: the sentence, then the stack under it. */
static char *error_text(const char *msg, const char *stack)
{
    return (stack && *stack) ? g_strdup_printf("%s\n\n%s", msg ? msg : "Error", stack)
                             : g_strdup(msg ? msg : "Error");
}

static GtkAlertDialog *error_alert(const char *msg, const char *stack)
{
    GtkAlertDialog *d = gtk_alert_dialog_new("%s", msg ? msg : "Error");
    if (stack && *stack)
        gtk_alert_dialog_set_detail(d, stack);
    gtk_alert_dialog_set_buttons(d, ERROR_BUTTONS);
    gtk_alert_dialog_set_cancel_button(d, 1);
    gtk_alert_dialog_set_default_button(d, 1);
    gtk_alert_dialog_set_modal(d, TRUE);
    return d;
}

static void on_error_dismissed(GObject *src, GAsyncResult *res, gpointer data)
{
    char *text = data;
    int   which = gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(src), res, NULL);

    if (which == 0) {
        /* Copy: ask again with the same alert, so `reporting_error` stays up
         * and a handler that throws on a timer still cannot stack them. */
        BtaApp *app = bta_current_app();

        error_copy(text);
        if (app && app->gapp) {
            gtk_alert_dialog_choose(GTK_ALERT_DIALOG(src),
                                    gtk_application_get_active_window(app->gapp),
                                    NULL, on_error_dismissed, text);
            return;
        }
    }
    g_free(text);
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

        /*
         * An error inside the error handler is reported to the terminal and
         * nowhere else: the guard is still up, so it cannot come back here.
         *
         * It used to be fetched and dropped without a word, which made the
         * sentence in runtime-api.md false -- it reached nothing at all, and a
         * typo in an application's OnError was invisible from both ends.  Same
         * shape as log_handled_by_app below.
         */
        if (JS_IsException(r)) {
            JSValue     e = JS_GetException(ctx);
            const char *m = JS_ToCString(ctx, e);

            fprintf(stderr, "bintana: Application.OnError failed: %s\n",
                    m ? m : "?");
            if (!m)
                JS_FreeValue(ctx, JS_GetException(ctx));
            JS_FreeCString(ctx, m);
            JS_FreeValue(ctx, e);
        }

        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[0]);
        JS_FreeValue(ctx, argv[1]);
    }

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, app);
    JS_FreeValue(ctx, global);
    return took;
}

/*
 * **The names this language took away, and what to write instead.**
 *
 * It used to be a list of names and a paragraph of prose above it, which meant
 * the whole of what a beginner got out of typing `setTimeout` was
 * `ReferenceError: setTimeout is not defined` -- while the replacement was
 * written out in full, a screen away in a comment nobody opens. `rad.js` already
 * refuses `localeCompare` by name, naming `Locale.Compare` in the sentence, and
 * the QuickJS patch in `vendor/` makes a refused property say which property it
 * was. This is the same bargain for the names themselves, and the same bargain
 * `close_hatches` was already paying for at the other end: the *deletion* has to
 * be refused out loud because the silent version is the expensive one.
 *
 * **One table, read by two.** `bta_close_hatches` deletes from it and
 * `Application.Replacements` publishes it, so a name that is taken and a name
 * that says what to use instead cannot disagree -- there is no second list to
 * keep in step, which is the whole of why this is a table and not a list plus a
 * getter with the same entries typed again.
 *
 * A `""` replacement is deliberate and says something: **there is no word for
 * that thing in this language**, which is more use to a reader than being
 * pointed at a neighbour that does a different job. Every entry that has a
 * replacement has one that exists -- `Timer` and `Stopwatch` are in `rad.js`,
 * `Namespace` and `CheckSource` and `Regex` are installed here -- and no entry
 * points at a thing this runtime has never heard of.
 */
/* A name that was taken away, and the sentence that says what to use instead.
 * The two halves are one row because the deletion and the sentence must not be
 * able to disagree: `bta_close_hatches` walks this, `reference_hint` reads it
 * when the engine reports a `ReferenceError`, and `Application.Replacements`
 * hands it out. */
typedef struct { const char *name; const char *use; } BtaReplacement;

/* The globals, and the raw scheduling primitives with them. */
static const BtaReplacement bta_replacements[] = {
    { "eval",  "Application.CheckSource(text) answers whether text would compile" },
    { "Function", "" },     /* the other way to turn a string into code */
    { "globalThis", "Namespace(\"Name\") publishes into the global scope" },
    { "Reflect", "" },      /* metaprogramming this language has no use for */
    { "Symbol", "" },       /* see the note in bta_close_hatches: no replacement
                             * can be reached without the name it needs */
    { "RegExp", "Regex(text, [options]) builds a pattern out of a string" },
    /* Timer is the published way to schedule: it has a name, a switch and hands
     * itself back, and these are the same thing said worse.  rad.js built Timer
     * out of them and holds what it needs. */
    { "setTimeout",    "Timer.After(delay, tick) — the delay comes first" },
    { "setInterval",   "Timer.Every(delay, tick) — the delay comes first" },
    { "clearTimeout",  "Timer.Stop()" },
    { "clearInterval", "Timer.Stop()" },
    /* And the forward-only clock, for the same reason one step further: a
     * reading of it is meaningless alone, so Stopwatch is not a convenience over
     * it but the only shape in which it says anything. */
    { "monotonic", "new Stopwatch().Start(), and .Elapsed for the answer" },
    /*
     * queueMicrotask goes with setTimeout and for the same sentence: it is
     * scheduling with no name of ours, no switch and no handle.  It does work --
     * bta_drain_jobs runs the queue after every event handler, and it was
     * measured running -- which is exactly what made it worth removing rather
     * than leaving: a second way to defer, undocumented, that nothing in this
     * tree ever asked for.  `Timer.After(0, fn)` is the published word, and the
     * day a program needs *before the next frame* rather than *on the next turn*
     * it gets a name instead of this one.
     */
    { "queueMicrotask", "Timer.After(0, tick) — the delay comes first" },
    /*
     * Annex B, and not even that any more: `escape` is a URL encoding no
     * standard recommends, with no caller anywhere here.  `Text.Escape` is markup
     * and `Http` builds its own query strings, so the name is free to mislead and
     * nothing else.
     */
    { "escape",   "" },
    { "unescape", "" },
};

/*
 * What `Object` gave up, keyed as `Object.name` so the two tables cannot collide
 * on a bare word -- `keys` on its own would say nothing about which object it
 * went from.
 *
 * **Only the ones a person plausibly reaches for.** The rest of the statics are
 * in `bta_close_hatches`' own list with the reasoning; a row saying `""` for
 * every one of them would be a list of names nobody wanted rather than a
 * sentence anybody used. `Object.assign` is here because it is the first thing a
 * JavaScript-trained hand types in this language -- and its absence has cost this
 * repository a silent bug of its own (`examples/clients` built an object with it
 * and the `TypeError` landed in a dialog, on a headless run, with nothing on the
 * terminal).
 */
static const BtaReplacement bta_object_replacements[] = {
    { "Object.keys",     "Dictionary.Keys(bag)" },
    { "Object.values",   "Dictionary.Values(bag)" },
    { "Object.entries",  "Dictionary.Entries(bag), as [{ Key, Value }, …]" },
    { "Object.hasOwn",   "Dictionary.Has(bag, key)" },
    { "Object.fromEntries", "a Map, which Dictionary reads the same way" },
    { "Object.assign",   "{ ...a, ...b }" },
    { "Object.defineProperty", "a get/set pair declared in a class" },
    /* Nothing in this language can be locked, and saying so is the answer:
     * there are no imports, so the only code that could write to
     * Object.prototype is the project's own and its libraries'. */
    { "Object.freeze",            "" },
    { "Object.seal",              "" },
    { "Object.preventExtensions", "" },
    { "Object.isFrozen",          "" },
    { "Object.isSealed",          "" },
    { "Object.isExtensible",      "" },
};

/* The bag `Application.Replacements` answers with, built from the two tables.
 * A **verb** and not a read-only property, and it is the shape every "give me
 * the list this runtime has" answer already has -- `Application.Globals()`,
 * `Application.Libraries()`, `Widget.Types()`, `Widget.EventNames()`. */
static JSValue js_application_replacements(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    JSValue out = JS_NewObject(ctx);

    for (size_t i = 0; i < G_N_ELEMENTS(bta_replacements); i++)
        JS_SetPropertyStr(ctx, out, bta_replacements[i].name,
                          JS_NewString(ctx, bta_replacements[i].use));
    for (size_t i = 0; i < G_N_ELEMENTS(bta_object_replacements); i++)
        JS_SetPropertyStr(ctx, out, bta_object_replacements[i].name,
                          JS_NewString(ctx, bta_object_replacements[i].use));
    return out;
}

/* Asks `forms.js` for its window.  False when there is none or it threw, and
 * the throw is consumed -- the alert below is the answer then, and an error in
 * the error window must not become a second one. */
static bool show_error_window(JSContext *ctx, const char *msg, const char *stack)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn     = JS_GetPropertyStr(ctx, global, "showError");
    bool    shown  = false;

    if (JS_IsFunction(ctx, fn)) {
        JSValue argv[2] = { JS_NewString(ctx, msg ? msg : ""),
                            JS_NewString(ctx, stack ? stack : "") };
        JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 2, (JSValueConst *)argv);

        if (JS_IsException(r)) {
            JSValue     e = JS_GetException(ctx);
            const char *m = JS_ToCString(ctx, e);

            fprintf(stderr, "bintana: the error window failed: %s\n", m ? m : "?");
            if (!m)
                JS_FreeValue(ctx, JS_GetException(ctx));
            JS_FreeCString(ctx, m);
            JS_FreeValue(ctx, e);
        } else {
            shown = true;
        }
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[0]);
        JS_FreeValue(ctx, argv[1]);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    return shown;
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

    if (show_error_window(ctx, msg, stack)) {
        reporting_error = false;      /* `showError` keeps its own one-at-a-time */
        return;
    }

    /* choose() and not show(): being told when it is dismissed is what keeps a
     * handler that throws on every tick from stacking up dialogs forever. */
    GtkAlertDialog *d = error_alert(msg, stack);
    gtk_alert_dialog_choose(d, gtk_application_get_active_window(app->gapp),
                            NULL, on_error_dismissed, error_text(msg, stack));
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

/* The fatal alert's answer, which is what lets the caller quit afterwards.
 * Copy leaves it up, as the handler errors' alert does. */
typedef struct { GMainLoop *loop; const char *text; } FatalAlert;

static void on_fatal_dismissed(GObject *src, GAsyncResult *res, gpointer data)
{
    FatalAlert *fa = data;
    int which = gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(src), res, NULL);

    if (which == 0) {
        BtaApp *app = bta_current_app();

        error_copy(fa->text);
        if (app && app->gapp) {
            gtk_alert_dialog_choose(GTK_ALERT_DIALOG(src),
                                    gtk_application_get_active_window(app->gapp),
                                    NULL, on_fatal_dismissed, fa);
            return;
        }
    }
    g_main_loop_quit(fa->loop);
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

    GtkAlertDialog *d    = error_alert(message, NULL);
    GMainLoop      *loop = g_main_loop_new(NULL, FALSE);
    FatalAlert      fa   = { loop, message ? message : "Error" };

    gtk_alert_dialog_choose(d, gtk_application_get_active_window(app->gapp), NULL,
                            on_fatal_dismissed, &fa);
    g_main_loop_run(loop);

    g_main_loop_unref(loop);
    g_object_unref(d);
}

/*
 * The sentence a `ReferenceError` about a curated name should have carried.
 *
 * A program that typed `setTimeout` gets `setTimeout is not defined`, and that
 * is the whole of it -- while the word to write instead has been in the same
 * table, in the same file, since `Application.Replacements` was added. The
 * identifier is in **one** place only, the message the engine built, so this
 * reads it back: the same bargain `check_position` strikes for the line and
 * column out of a `.stack`, and for the same reason -- there is no other door.
 * The format is `"%s is not defined"` and nothing else
 * (`JS_ThrowReferenceErrorNotDefined`, `quickjs.c`), so the suffix is the whole
 * of the parse.
 *
 * **This is where a message is reported, not where a name is bound.** Nothing
 * here is installed on the global object, so `Application.Globals()` still
 * answers the truth, the completion popup does not offer a name that throws, and
 * the cost is paid exactly once -- where a person is about to read it. A program
 * that catches the error itself and prints `e.message` gets the engine's
 * sentence, which is the right one for a program: `Application.Replacements()` is
 * the door for that.
 *
 * Answers a `char *` the caller frees, or NULL when there is nothing to add --
 * and NULL for a name that is not in the table, for an error that is not a
 * `ReferenceError`, and for a name with no word for it here only if the row says
 * so.
 */
static char *reference_hint(JSContext *ctx, JSValueConst exc, const char *msg)
{
    if (!msg || !JS_IsError(exc))
        return NULL;

    /*
     * **The `message` property, not the stringified error.** `JS_ToCString` on
     * an error object gives `"ReferenceError: setTimeout is not defined"` --
     * the name and the message glued together -- so a parse looking for a name
     * at the front of it finds a class name. Two properties, asked for by name,
     * is the whole of what this needs and it is the door that has them.
     */
    JSValue name_v = JS_GetPropertyStr(ctx, exc, "name");
    JSValue text_v = JS_GetPropertyStr(ctx, exc, "message");
    const char *kind = JS_ToCString(ctx, name_v);
    const char *text = JS_ToCString(ctx, text_v);
    bool        is_ref = kind && text && !strcmp(kind, "ReferenceError");

    /* A conversion that failed left its exception on the context, and whoever
     * asks next would be told about this one. */
    if (!kind || !text)
        JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeCString(ctx, kind);
    JS_FreeValue(ctx, name_v);

    /*
     * **The message is parsed while it is alive and freed on the way out.**
     * The first version freed it first and parsed the freed string, which is
     * a use-after-free the arena allocator hides -- the bytes are usually
     * still there, so it read correctly and was wrong all the same.
     */
    char *hint = NULL;
    if (is_ref) {
        for (size_t i = 0; i < G_N_ELEMENTS(bta_replacements); i++) {
            const BtaReplacement *r = &bta_replacements[i];
            /* The suffix is the whole of the parse, and the prefix has to be
             * the whole name: a prefix match alone would enrich a message
             * about something that merely starts with the same letters. */
            if (g_str_has_prefix(text, r->name) &&
                !strcmp(text + strlen(r->name), " is not defined")) {
                hint = g_strdup_printf("%s is not part of this language%s%s",
                                       r->name,
                                       *r->use ? ": use "
                                               : ", and nothing here replaces it",
                                       r->use);
                break;
            }
        }
    }

    JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, text_v);
    return hint;
}

void bta_dump_error(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);

    const char *msg   = JS_ToCString(ctx, exc);
    const char *trace = NULL;
    JSValue     stack = JS_UNDEFINED;

    /*
     * **The engine's own sentence first, then ours.** Both the terminal line and
     * the dialog carry the pair, so a log line still matches what the engine said
     * -- which is what a grep over a CI capture is for -- and the person reading
     * it is told what to write instead.
     */
    char *hint = reference_hint(ctx, exc, msg);

    if (hint)
        fprintf(stderr, "\n%sBintana error:%s %s\n%s\n",
                error_red(), error_plain(), msg ? msg : "(unknown)", hint);
    else
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

    /* An application that took errors over is told the same thing the terminal
     * was, since the two are the same moment seen twice. `msg` keeps its own
     * owner throughout: it came from `JS_ToCString` and goes back the same way,
     * which is not the same as `free` in this engine. */
    char *shown = hint ? g_strdup_printf("%s — %s", msg ? msg : "(unknown)", hint)
                       : NULL;
    report_error(ctx, shown ? shown : msg, trace);

    g_free(shown);
    g_free(hint);
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
    int64_t prof = bta_profile_begin();
    int     rc   = 0;
    size_t  len;
    char   *src = bta_read_file(path, &len);

    if (!src) {
        fprintf(stderr, "bintana: cannot read %s\n", path);
        rc = -1;
        goto out;
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
        rc = -1;
        goto out;
    }
    JS_FreeValue(ctx, r);
    bta_drain_jobs(JS_GetRuntime(ctx));

out:
    /* One span per loaded file, named by its basename: the shape a capture of
     * a startup wants, where a script that grew is the one that moved.  The
     * end is read before the basename is built, so the profiler's own work is
     * not charged to the file. */
    if (prof) {
        int64_t done = g_get_monotonic_time();
        char   *base = g_path_get_basename(path);
        bta_profile_end_at(prof, done, "Bintana", "Script", base);
        g_free(base);
    }
    return rc;
}

/* in bta.h: a worker thread builds the same language. */

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

/* Put back what js_check_source borrowed from `Error`.  Both setters take the
 * value, so the saved ones are handed over rather than freed. */
static void check_restore_error(JSContext *ctx, JSValue err_ctor, bool guarded,
                                JSValue saved_prepare, JSValue saved_limit)
{
    if (guarded) {
        JS_SetPropertyStr(ctx, err_ctor, "prepareStackTrace", saved_prepare);
        JS_SetPropertyStr(ctx, err_ctor, "stackTraceLimit", saved_limit);
    }
    JS_FreeValue(ctx, err_ctor);
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

    /*
     * **The stack this reads is data, not a message, so the program's own
     * settings must not reach it.**
     *
     * There is nowhere else to read the position from -- a QuickJS error object
     * carries no `lineNumber`, `columnNumber` or `fileName`, measured, so
     * `check_position` parsing `<check>:LINE:COL` out of `.stack` is the only
     * way there is.  That made two ordinary assignments silently break this
     * answer: `Error.prepareStackTrace` replaces the whole string, and
     * `Error.stackTraceLimit = 0` empties it.  Both were measured returning
     * `Line: 0, Column: 0` for source whose real answer is `2:9`, with the
     * message still right -- so an editor underlined the first character of the
     * file and nothing said why.
     *
     * Neutralised for the length of the compile and put back after the stack
     * has been read.  Not removed from the language: what a program does to
     * `Error` is its business, and what it does must simply not be able to
     * corrupt a runtime answer.
     */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue err_ctor = JS_GetPropertyStr(ctx, global, "Error");
    JSValue saved_prepare = JS_UNDEFINED, saved_limit = JS_UNDEFINED;
    bool    guarded = JS_IsObject(err_ctor);

    JS_FreeValue(ctx, global);
    if (guarded) {
        saved_prepare = JS_GetPropertyStr(ctx, err_ctor, "prepareStackTrace");
        saved_limit   = JS_GetPropertyStr(ctx, err_ctor, "stackTraceLimit");
        JS_SetPropertyStr(ctx, err_ctor, "prepareStackTrace", JS_UNDEFINED);
        /* The engine's own default; one frame is all check_position reads. */
        JS_SetPropertyStr(ctx, err_ctor, "stackTraceLimit", JS_NewInt32(ctx, 10));
    }

    JSValue r = JS_Eval(ctx, src, strlen(src), "<check>",
                        JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT |
                        JS_EVAL_FLAG_COMPILE_ONLY);
    JS_FreeCString(ctx, src);

    if (!JS_IsException(r)) {
        JS_FreeValue(ctx, r);
        check_restore_error(ctx, err_ctor, guarded, saved_prepare, saved_limit);
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
    check_restore_error(ctx, err_ctor, guarded, saved_prepare, saved_limit);
    return out;
}

/* Where the parser's declarations land: an array, and how many are in it. */
typedef struct {
    JSContext *ctx;
    JSValue    list;
    uint32_t   count;
} SymbolSink;

static const char *symbol_kind_name(JSSymbolKind kind)
{
    switch (kind) {
    case JS_SYMBOL_CLASS:    return "Class";
    case JS_SYMBOL_METHOD:   return "Method";
    case JS_SYMBOL_FUNCTION: return "Function";
    /* **A member of a class, and the three ways of not being a plain method.**
     * They all reach the parser as a method of the same name, so before this
     * `get Value()`, `static Make()` and `turn()` were one answer and an editor
     * could not tell a property from a function -- which is the difference
     * between `Value: number` and `Value(): number` in a declaration. */
    case JS_SYMBOL_STATIC:  return "Static";
    case JS_SYMBOL_GETTER:  return "Getter";
    case JS_SYMBOL_SETTER:  return "Setter";
    /* An accessor of the class itself: a property of the constructor. */
    case JS_SYMBOL_STATIC_GETTER: return "StaticGetter";
    case JS_SYMBOL_STATIC_SETTER: return "StaticSetter";
    /* A declared name at its line, and a function as the span it covers:
     * together they say what a name can mean where the cursor is. */
    case JS_SYMBOL_VARIABLE:      return "Variable";
    case JS_SYMBOL_SCOPE:         return "Scope";
    /* A function assigned at the top level, named by its target. */
    case JS_SYMBOL_ASSIGNED:      return "Assigned";
    }
    return "";
}

/*
 * A JSDoc comment as two answers: the description -- every line before the
 * first `@tag`, the leading `*` of each taken off, a blank line a paragraph --
 * and the type of `@returns {T}` (or `@return`), which is what lets a chain
 * complete past a call to a function written in JavaScript the way it does
 * past a native one. The other tags are left where they are: nothing here
 * reads them, and the parser already names the parameters.
 */
/* The two JavaScript sources baked into the binary, for whoever reads what
 * they declare (the JSDoc index `Widget.Members` answers from). */
void bta_prelude_sources(const char **rad, const char **forms)
{
    *rad   = bta_prelude_js;
    *forms = bta_forms_js;
}

void bta_split_doc(const char *doc, char **text, char **returns)
{
    *text = NULL;
    *returns = NULL;
    if (!doc || !*doc)
        return;

    GString *out  = g_string_new(NULL);
    char   **rows = g_strsplit(doc, "\n", -1);
    bool     tags = false;

    for (char **r = rows; *r; r++) {
        char *line = g_strstrip(*r);
        if (*line == '*') line = g_strstrip(line + 1);
        /* A tag after the text on the same line -- `How far. @returns {n}` --
         * ends the description where it starts. */
        if (*line != '@') {
            for (char *at = strchr(line, '@'); at; at = strchr(at + 1, '@')) {
                if (at > line && g_ascii_isspace(at[-1]) && g_ascii_isalpha(at[1])) {
                    char *tag = at;
                    at[-1] = '\0';
                    g_strchomp(line);
                    if (out->len && !g_str_has_suffix(out->str, "\n") && *line)
                        g_string_append_c(out, ' ');
                    if (!tags) g_string_append(out, line);
                    line = tag;
                    break;
                }
            }
        }
        if (*line == '@') {
            tags = true;
            if (!*returns &&
                (g_str_has_prefix(line, "@returns") || g_str_has_prefix(line, "@return"))) {
                const char *open  = strchr(line, '{');
                const char *close = open ? strrchr(line, '}') : NULL;
                if (open && close && close > open)
                    *returns = g_strstrip(g_strndup(open + 1, close - open - 1));
            }
            continue;
        }
        if (tags)
            continue;
        if (!*line) {
            if (out->len && !g_str_has_suffix(out->str, "\n"))
                g_string_append_c(out, '\n');
            continue;
        }
        if (out->len && !g_str_has_suffix(out->str, "\n"))
            g_string_append_c(out, ' ');
        g_string_append(out, line);
    }
    g_strfreev(rows);
    while (out->len && out->str[out->len - 1] == '\n')
        g_string_truncate(out, out->len - 1);
    *text = g_string_free(out, out->len == 0);
}

static void symbol_report(void *opaque, JSSymbolKind kind, const char *name,
                          const char *parent, const char *supertype,
                          const char *params, int line, int end_line,
                          const char *doc)
{
    SymbolSink *sink = opaque;
    JSContext  *ctx  = sink->ctx;
    JSValue     obj  = JS_NewObject(ctx);

    if (JS_IsException(obj)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }

    JS_SetPropertyStr(ctx, obj, "Name", JS_NewString(ctx, name));
    JS_SetPropertyStr(ctx, obj, "Kind", JS_NewString(ctx, symbol_kind_name(kind)));
    JS_SetPropertyStr(ctx, obj, "Line", JS_NewInt32(ctx, line));
    JS_SetPropertyStr(ctx, obj, "Parent", JS_NewString(ctx, parent ? parent : ""));
    /* The base class, and the one field that makes the answer a *shape* rather
     * than a list of names: without it a class declared in a file this process
     * never runs has no way to say what it inherits, and an inherited surface
     * is most of what a control has. Empty for everything that is not a class,
     * and for a class whose `extends` is not a plain identifier -- see
     * JSSymbolHandler in quickjs.h for why that is the limit. */
    JS_SetPropertyStr(ctx, obj, "Super", JS_NewString(ctx, supertype ? supertype : ""));
    /* The parameter list, in the spelling a declaration uses -- `(message,
     * [options], ...rest)`.  Empty for anything that is not a member, and for a
     * method that takes none. */
    JS_SetPropertyStr(ctx, obj, "Params", JS_NewString(ctx, params ? params : ""));
    /* The last line of a `Scope`, and 0 for everything else. */
    JS_SetPropertyStr(ctx, obj, "End", JS_NewInt32(ctx, end_line));
    /* What a JSDoc (a comment opening with two stars) comment right above the declaration says: its
     * description, and the type after `@returns {…}`. */
    {
        char *text = NULL, *ret = NULL;
        bta_split_doc(doc, &text, &ret);
        JS_SetPropertyStr(ctx, obj, "Doc", JS_NewString(ctx, text ? text : ""));
        JS_SetPropertyStr(ctx, obj, "Returns", JS_NewString(ctx, ret ? ret : ""));
        g_free(text);
        g_free(ret);
    }

    /* The value is taken either way; the count only moves when it landed, so
     * an array this hands back never has a hole for a caller to trip on. */
    if (JS_DefinePropertyValueUint32(ctx, sink->list, sink->count, obj,
                                     JS_PROP_C_W_E) < 0)
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        sink->count++;
}

/*
 * `Application.Symbols(source)`: what the text declares -- classes, methods and
 * top-level functions, each with the line it is on.
 *
 * **The parser answers and not a pattern**, which is the whole point: a regular
 * expression that looks for declarations finds them in comments and in strings,
 * needs a rule about indentation to tell a method from a call, and disagrees
 * with the next regular expression that needs the same answer.  This is the
 * compiler's own parse, with nothing run, so a file that is halfway through a
 * word is still worth asking -- see the tolerance note below.
 *
 * **A syntax error answers what was collected.**  An editor reads this while
 * somebody types, so text that does not compile is the ordinary state of a file
 * and not a failure: the declarations the parser reached are the answer, and
 * the complaint is `Application.CheckSource`'s to give.
 *
 * The handler is installed for the length of this one compile and taken out
 * after it, so nothing else in the program pays for the feature and the code
 * the runtime itself compiles -- `rad.js`, every `.form` -- is not walked.
 */
/*
 * `bta_symbols(ctx, text)`: what a compile declares, as the array
 * `Application.Symbols` hands back.  **Exported because there are now two
 * consumers and not one** -- the editor's outline, and `Widget.Members`'s answer
 * for a class in a file this process never runs, which is the same parser for
 * the same reason: an object's members cannot be had from the source, only its
 * declarations can, and reading them twice with two different readers is the
 * shape that drifts.
 */
JSValue bta_symbols(JSContext *ctx, const char *src)
{
    SymbolSink sink = { ctx, JS_NewArray(ctx), 0 };
    JSRuntime *rt   = JS_GetRuntime(ctx);

    JS_SetSymbolHandler(rt, symbol_report, &sink);

    JSValue r = JS_Eval(ctx, src, strlen(src), "<symbols>",
                        JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT |
                        JS_EVAL_FLAG_COMPILE_ONLY);

    JS_SetSymbolHandler(rt, NULL, NULL);

    /* Compiled and not run, so the only thing it can hand back is an error --
     * and the symbols collected before it are the answer, not the error. */
    if (JS_IsException(r))
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        JS_FreeValue(ctx, r);

    return sink.list;
}

static JSValue js_application_symbols(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    const char *src = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!src)
        return JS_ThrowTypeError(ctx, "Application.Symbols(text) needs text");

    JSValue out = bta_symbols(ctx, src);
    JS_FreeCString(ctx, src);
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

    /*
     * **A bare name is evaluated, and that is JavaScript's own order**: the
     * global lexical scope -- where a project's `class Timer {}` lives -- before
     * the global object, where the runtime's `Timer` is a property. Reading the
     * object first made every installed global beat the project's own class:
     * `startup class 'File' not found` for a C global, and a `TypeError: not a
     * function` from inside `Form` for a prelude one (`Timer`, `Record`), with
     * the class there, loaded and evaluated. An identifier that names nothing
     * at all is a ReferenceError, which is what the fallback below always threw.
     */
    if (!strchr(name, '.'))
        return JS_Eval(ctx, name, strlen(name), "<class-lookup>", JS_EVAL_TYPE_GLOBAL);

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

    g_strfreev(parts);
    return v;
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
/* `Target = "/a/file"`: the lines go here, opened once and appended to. */
static char *log_file_path;
static FILE *log_file;
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
            /* A conversion that failed left one of its own behind. */
            if (!m)
                JS_FreeValue(ctx, JS_GetException(ctx));
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
    /* A file target is a target: the line goes there and nowhere else. */
    if (log_file) {
        fprintf(log_file, "%s: %s\n", log_level_names[level], text);
        fflush(log_file);
        return;
    }

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
        /* A value that cannot become a string -- `{ toString: null }` -- throws
         * here, and the "?" is this function's answer to that.  Consume it, or
         * it stays on the context and surfaces as whoever asks next having
         * thrown. */
        if (!s)
            JS_FreeValue(ctx, JS_GetException(ctx));
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

static void log_close_file(void)
{
    if (log_file) {
        fclose(log_file);
        log_file = NULL;
    }
    g_free(log_file_path);
    log_file_path = NULL;
}

static JSValue js_log_get_target(JSContext *ctx, JSValueConst this_val)
{
    if (log_file_path)
        return JS_NewString(ctx, log_file_path);
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
        log_close_file();
    } else if (!g_ascii_strcasecmp(name, "Journal")) {
        /* Refused rather than ignored: an application that asked to log to the
         * journal and got the terminal would never find out. */
        if (!bta_journal_available()) {
            e = JS_ThrowRangeError(ctx, "Logger.Target: this build has no journal");
        } else {
            log_to_platform = true;
            log_close_file();
        }
    } else {
        /*
         * **Anything else is a file to append to.** A log line by line was the
         * `File.Append` case one level up, and the file is opened *before* the
         * old target is dropped: a path that cannot be written leaves the
         * target exactly as it was, which is what a refused assignment means
         * everywhere else.
         */
        FILE *f = g_fopen(name, "ab");

        if (!f) {
            e = JS_ThrowRangeError(ctx, "Logger.Target: cannot open '%s': %s",
                                   name, g_strerror(errno));
        } else {
            log_close_file();
            log_file_path   = g_strdup(name);
            log_file        = f;
            log_to_platform = false;
        }
    }

    JS_FreeCString(ctx, name);
    return e;
}

static const JSCFunctionListEntry log_props[] = {
    /* Debug(...values)
     *   the detail that is only interesting when something is wrong
     */
    JS_CFUNC_MAGIC_DEF("Debug",   1, js_log, BTA_LOG_DEBUG),
    /* Info(...values)
     *   what the program did
     */
    JS_CFUNC_MAGIC_DEF("Info",    1, js_log, BTA_LOG_INFO),
    /* Warning(...values)
     *   what it did not like but carried on through
     */
    JS_CFUNC_MAGIC_DEF("Warning", 1, js_log, BTA_LOG_WARNING),
    /* Error(...values)
     *   what failed
     */
    JS_CFUNC_MAGIC_DEF("Error",   1, js_log, BTA_LOG_ERROR),
    /* Level
     *   the floor — lines below it are dropped, which is how a program ships
     *   with its `Debug` lines still in it
     */
    JS_CGETSET_DEF("Level",  js_log_get_level,  js_log_set_level),
    /* Target
     *   where the lines are written: `"Terminal"` (the default, and
     *   stdout/stderr under it), `"Journal"` where the build has one, or **a
     *   file path** — opened in append mode and flushed per line, and it
     *   reads back as the path
     */
    JS_CGETSET_DEF("Target", js_log_get_target, js_log_set_target),
};

static JSValue js_print(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);

        printf("%s%s", i ? " " : "", s ? s : "?");
        /* Same as Logger's: the failed conversion left an exception behind, and
         * printing "?" is this function saying it handled it. */
        if (!s)
            JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeCString(ctx, s);
    }
    putchar('\n');
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue js_quit(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    /* A status is a number, and a word is refused rather than read as 0:
     * `Quit("fail")` exited 0, which a runner reads as success. `undefined` is
     * the one non-number that means 0 -- `Quit()` with nothing to say. */
    int32_t code = 0;
    if (argc > 0 && !JS_IsUndefined(argv[0]) &&
        !bta_to_int(ctx, argv[0], "Application.Quit", &code))
        return JS_EXCEPTION;

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
        if (!msgid)
            return JS_EXCEPTION;

        const char *found = bta_locale_lookup(NULL, msgid);
        text = bta_locale_format(ctx, found ? found : msgid,
                                 argc - 1, argv + 1);
        JS_FreeCString(ctx, msgid);
        if (!text)
            return JS_EXCEPTION;       /* an argument could not become text */
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

/* The global object, as a real property enumeration.
 *
 * **The point of it is that nothing else can answer.** The globals are installed
 * one `JS_SetPropertyStr` at a time across this file and four others, and the
 * very same shape builds half the runtime's *return values* -- `Exec`'s handle,
 * `File.Info`'s answer, a table row -- so a list kept beside the installs would
 * be a second list to drift, and the one that drifts is the one no program runs.
 * `tests/api/Check.js` reads those same call sites out of the C to hold the
 * documentation to the same surface; this is the same answer, asked at run time,
 * for a program that wants to know rather than a check that wants to prove.
 *
 * It is deliberately **not** a curated list of the runtime's own names: the answer
 * is what is on the global object, which is also `Math`, `JSON`, `Date`, `Map`,
 * `Timer`, `Confirm` and whatever a library installed. A completion engine wants
 * all of them, and a caller that wanted only the runtime's own can ask
 * `Application.Libraries()` beside it.
 */
static JSValue js_globals(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    JSValue     global = JS_GetGlobalObject(ctx);
    JSPropertyEnum *tab = NULL;
    uint32_t    len = 0;
    JSValue     out  = JS_NewArray(ctx);
    uint32_t    n    = 0;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, global, JS_GPN_STRING_MASK) == 0) {
        for (uint32_t i = 0; i < len; i++) {
            const char *name = JS_AtomToCString(ctx, tab[i].atom);
            /* `globalThis` went with the hatches, and so did every name they
             * took: what is left here is what a program may actually write. */
            if (name && *name)
                JS_SetPropertyUint32(ctx, out, n++, JS_NewString(ctx, name));
            if (name) JS_FreeCString(ctx, name);
        }
        JS_FreePropertyEnum(ctx, tab, len);
    }
    JS_FreeValue(ctx, global);
    return out;
}

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
     * The profiler an application marks its own work with -- `Profile.Begin`,
     * `End`, `Mark` and `Active`.  Installed here and in a worker's own boot
     * (`task_build_worker`), because a `Task` computing on a thread is exactly
     * the work a capture wants attributed.  Inert in an ordinary run.
     */
    bta_profile_init(ctx, global);

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
    /* Name
     *   from `project.json`
     */
    JS_SetPropertyStr(ctx, application, "Name", JS_NewString(ctx, app->name));
    /*
     * What the *application* calls its release, out of its own project.json --
     * not the runtime's, which is `BTA_VERSION`. Every program that shows a
     * version had nowhere to read one from and had to write it down a second
     * time in its own source, which is the copy that goes stale. "" when the
     * project declares none: a version is optional, and absent is not an error.
     */
    /* Version
     *   what the **project** calls its release; `""` when it declares none.
     *   **`BTA_VERSION` is the runtime's** and is not this — showing the
     *   wrong one is what an About box does until it knows the difference
     */
    JS_SetPropertyStr(ctx, application, "Version", JS_NewString(ctx, app->version));
    /*
     * The application's own identity, in reverse DNS -- the name its window is
     * classed by, its metainfo declares and its package installs under.  "" for
     * a project that declares none, which is an ordinary project and not a
     * fault: the window then keeps the program's name, as it always did.
     */
    /* Id
     *   from `project.json`: the application's identity in reverse DNS —
     *   `io.github.you.App`. It is **one name in three places**: the window's
     *   own class (the runtime hands it to `GtkApplication` for Wayland and
     *   to the program name for X11's `WM_CLASS`), the `<id>` of the
     *   project's metainfo, and the Flatpak app id. `""` when the project
     *   declares none, which is an ordinary project classed by the program's
     *   name; a value that is not an application id **stops the program when
     *   the project loads**, because every one of those three is something
     *   nobody looks at until a dock shows the wrong icon
     */
    JS_SetPropertyStr(ctx, application, "Id", JS_NewString(ctx, app->id));
    /* Directory
     *   the project directory, absolute. What a relative path in a project
     *   resolves against — an image a report draws, a document a viewer
     *   opens, a data file that ships with the application
     */
    JS_SetPropertyStr(ctx, application, "Directory", JS_NewString(ctx, app->dir));
    /* Quit(code)
     *   quit with that exit status. `0` is *it worked*, and a console tool
     *   that answers a question answers with this. A `code` that is not a
     *   number is **refused** — `Quit("fail")` used to exit `0`, which a
     *   runner reads as success. A `code` that is not a number is refused
     *   rather than read as `0`, which a runner would take for success;
     *   `Quit()` is `0`
     */
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
    /* ConfigDirectory
     *   `~/.config/bintana/<name>`, **created at startup**, which is where
     *   anything the application remembers belongs.
     *   [`Settings`](docs/reference/globals/Settings.md) writes there;
     *   nothing of yours should go in the project directory, which is a thing
     *   people hand to each other
     */
    JS_SetPropertyStr(ctx, application, "ConfigDirectory", JS_NewString(ctx, config));
    g_free(config);
    g_free(slug);

    /* Whether the desktop has an icon by that name.  Only whoever picks the
     * name can choose a fallback, and an icon the theme lacks is dropped
     * silently -- which on an icon-only button leaves nothing at all. */
    /* HasIcon(name) -> string
     *   whether that icon will actually **draw** something. Not whether the
     *   theme claims it: an icon that cannot be rasterised here is the same
     *   nothing as one that is missing
     */
    JS_SetPropertyStr(ctx, application, "HasIcon",
                      JS_NewCFunction(ctx, js_has_icon, "HasIcon", 1));
    /* Icons([contains]) -> string[]
     *   every icon name available, sorted, narrowed by substring — what an
     *   icon picker is built from
     */
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
        /* DecorationLayout
         *   how this desktop arranges a title bar — which buttons, and on
         *   which side. What a drawn title bar reads to look like the real
         *   one
         */
        JS_SetPropertyStr(ctx, application, "DecorationLayout",
                          JS_NewString(ctx, layout ? layout : ""));
        g_free(layout);
    }

    /* And whether an external program is installed, which is the same question
     * about a different kind of name -- `Exec` throws when it is not, so this is
     * what lets a caller choose among the tools a desktop happens to have. */
    /* HasCommand(name)
     *   whether that program is on the PATH. **The question that does not
     *   need an exception**, since [`Exec`](docs/reference/globals/Exec.md)
     *   throws when the program is not there
     */
    JS_SetPropertyStr(ctx, application, "HasCommand",
                      JS_NewCFunction(ctx, js_has_command, "HasCommand", 1));

    /* Would this text compile?  The one honest use of `Function` -- an IDE that
     * writes code wants to know before it saves -- published on its own so the
     * string-to-code hatch does not have to stay open for it. */
    /* CheckSource(text) -> { Message, Line, Column }
     *   `null` when the text is valid JavaScript, else `{ Message, Line,
     *   Column }`. What an editor checks a file with before saving it, and
     *   the answer `new Function(src)` is not allowed to give
     */
    JS_SetPropertyStr(ctx, application, "CheckSource",
                      JS_NewCFunction(ctx, js_check_source, "CheckSource", 1));

    /*
     * `Application.Symbols(text)`: what the text declares, with the line of
     * each -- `[{ Name, Kind, Line, Parent }]`, from the parser that will run
     * it.  Published for the same reason `CheckSource` is: an editor that
     * lists a file's declarations should not have to guess at them with a
     * pattern, and the answer belongs to the compiler and not to one
     * application.
     */
    /* Symbols(text) -> { Name, Kind, Line, Parent, Super, Params, End, Doc, Returns }[]
     *   what the text declares — `[{ Name, Kind, Line, Parent, Super, Params,
     *   End, Doc, Returns }]`, out of the parser and with nothing run.
     *   **`Kind` is `"Class"`, `"Function"`, `"Method"`, `"Static"`,
     *   `"Getter"`, `"Setter"`, `"StaticGetter"` or `"StaticSetter"`**, or
     *   **`"Assigned"`** (a function assigned at the top level, named by its
     *   target as written — `File.LoadJson`, `Widget.prototype.Dump` — and
     *   each function an object literal holds when the literal is assigned
     *   there, as `Target.Name`), or
     *   **`"Variable"`** (each `let`/`const`/`var`, destructured name,
     *   `for...of` variable and `catch` binding, at its line) and
     *   **`"Scope"`** (every function, anonymous ones included, with its
     *   `Params` and the lines it spans, `Line` to **`End`**; one that fails
     *   to parse spans up to where it broke) — together, what a name can mean
     *   where the cursor is — the member kinds are what separates `Value: T`
     *   from `Value(): T`, and a property of the class from one of the
     *   instance. **`Params` is the parameter list in the spelling a
     *   declaration uses** — `(message, [options], ...rest)`, `()` for a
     *   member that takes none, `""` for a class — for members and top-level
     *   functions, and **it is the function's own**: an arrow in its body or
     *   in a default value does not replace it. It is the one answer a host
     *   cannot get elsewhere, because ECMAScript discards a parameter's name
     *   at parse time and `Function.length` is a lower bound the moment one
     *   has a default. **`Super` is the name in a class's `extends`** and
     *   `""` for everything else, including an `extends` that is not a bare
     *   identifier. **`Doc` is the JSDoc comment touching the declaration**
     *   — the text before its first `@tag` — and **`Returns` the type in its
     *   `@returns {T}`**, both `""` when there is none; a comment that does
     *   not end on the line above or the same line documents nothing. What
     *   an editor lists a file with, and the answer a pattern is not allowed
     *   to guess at
     */
    JS_SetPropertyStr(ctx, application, "Symbols",
                      JS_NewCFunction(ctx, js_application_symbols, "Symbols", 1));

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
    /* LibraryPath(name, [project]) -> string
     *   where a library by that name is, or `""` — **the same six-place
     *   search the runtime does for `uses`**. Published so that a tool which
     *   opens *other* projects asks about theirs rather than keeping a second
     *   copy of the path
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
    /* Libraries([project]) -> string[]
     *   the names of every library those same six places offer, sorted, each
     *   one once. The other direction of the lookup: `LibraryPath` resolves a
     *   name you already know, this is what a dialog that offers a choice
     *   needs
     */
    JS_SetPropertyStr(ctx, application, "Libraries",
                      JS_NewCFunction(ctx, js_libraries, "Libraries", 1));
    /* Globals() -> string[]
     *   every name on the global object: the runtime's own, the ones a
     *   library installed, and the JavaScript builtins -- `Math`, `JSON`,
     *   `Date`, `Map`, `Timer`, `Confirm`. **A top-level `class` is a lexical
     *   binding and not a property of the global object**, so a library's and
     *   a project's classes are *not* in it -- read those out of the sources,
     *   which is what the IDE does. It exists because the alternative is a
     *   hand-written list of global names, and there are a hundred and
     *   sixty-four of them
     */
    JS_SetPropertyStr(ctx, application, "Globals",
                      JS_NewCFunction(ctx, js_globals, "Globals", 0));

    /* Replacements()
     *   every name this language takes away, and what to write instead. It is
     *   a bag keyed by the name that went: `{ setTimeout: "Timer.After(delay,
     *   tick) — the delay comes first", "Object.assign": "{ ...a, ...b }", … }`.
     *   **`""` where there is no word for that thing here**, which is an
     *   answer rather than a gap in the table. An editor asks it of an
     *   identifier nobody can find, so a beginner meets `Timer` at the token
     *   rather than a `ReferenceError` at the next run
     */
    JS_SetPropertyStr(ctx, application, "Replacements",
                      JS_NewCFunction(ctx, js_application_replacements,
                                      "Replacements", 0));

    /* Where the runtime binary lives, so a project can re-invoke it. */
    char *exe = bta_exe_path();
    /* Executable
     *   the `bintana` binary that is running this, so a project can re-invoke
     *   it — which is how the IDE runs a project and how the test runner runs
     *   the suites
     */
    JS_SetPropertyStr(ctx, application, "Executable",
                      JS_NewString(ctx, exe ? exe : "bintana"));
    g_free(exe);

    JSValue args = JS_NewArray(ctx);
    for (uint32_t i = 0; app->args && app->args[i]; i++)
        JS_SetPropertyUint32(ctx, args, i, JS_NewString(ctx, app->args[i]));
    /* Arguments
     *   whatever followed the project directory on the command line, as an
     *   array
     */
    JS_SetPropertyStr(ctx, application, "Arguments", args);

    JS_SetPropertyStr(ctx, global, "Application", application);

    /* One line each and not a loop over the names, because the signature
     * comment above a line is what `Widget.Members` answers with -- a loop
     * leaves nowhere to write one. The magic is the index `js_message` reads. */
    JSValue message = JS_NewObject(ctx);
    /* Info(text, ...args)
     *   something happened. **It shows and returns**: it does not block and
     *   there is no answer. The text goes through the catalogue with `{0}`
     *   holes filled from the arguments -- never a template literal -- and
     *   with no display it prints to stderr
     */
    JS_SetPropertyStr(ctx, message, "Info",
                      JS_NewCFunctionMagic(ctx, js_message, "Info", 1,
                                           JS_CFUNC_generic_magic, 0));
    /* Warning(text, ...args)
     *   something is not right; the same as `Info` in every other respect
     */
    JS_SetPropertyStr(ctx, message, "Warning",
                      JS_NewCFunctionMagic(ctx, js_message, "Warning", 1,
                                           JS_CFUNC_generic_magic, 1));
    /* Error(text, ...args)
     *   something failed; the same as `Info` in every other respect
     */
    JS_SetPropertyStr(ctx, message, "Error",
                      JS_NewCFunctionMagic(ctx, js_message, "Error", 1,
                                           JS_CFUNC_generic_magic, 2));
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
    bta_drawing_init(ctx, global);
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
    bta_task_init(ctx, global);
    bta_lock_init(ctx, global);
    bta_random_init(ctx, global);
    bta_gzip_init(ctx, global);
    bta_notification_init(ctx, global);
    bta_zip_init(ctx, global);
    bta_probe_init(ctx, global);
    bta_desktop_init(ctx, global);
    bta_printer_init(ctx, global);
    bta_xml_init(ctx, global);
    bta_keyring_init(ctx, global);

    JS_FreeValue(ctx, global);

    /*
     * Two halves, and the split is what a worker thread needs: rad.js is the
     * language and forms.js is everything about widgets.  A Task builds a
     * runtime of its own and evaluates only the first, because
     * `bta_widgets_init` keeps each class's prototype and constructor in a
     * process-global table that a second runtime would overwrite.  They share
     * the global lexical scope, so forms.js still sees rad.js's captures --
     * which is why the order is this one and both run before the hatches
     * close.  See docs/plans/task-plan.md.
     */
    JSValue r = JS_Eval(ctx, bta_prelude_js, strlen(bta_prelude_js),
                        "<rad.js>", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);

    r = JS_Eval(ctx, bta_forms_js, strlen(bta_forms_js),
                "<forms.js>", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);

    /* Last, and only after rad.js: it captured what it needs. */
    bta_close_hatches(ctx);
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
/*
 * A refusal is said out loud, because the silent version is the expensive one.
 * `delete` answers true for a name that was never there, so the only way this
 * comes back false is an engine that made one of these non-configurable -- at
 * which point `close_hatches` is theatre, the hatch is open, and the only
 * alarm left is a list in `tests/widgets` somebody has to keep in step by hand.
 */
static void delete_named(JSContext *ctx, JSValueConst obj, const char *name)
{
    JSAtom atom = JS_NewAtom(ctx, name);
    int    gone = JS_DeleteProperty(ctx, obj, atom, 0);

    JS_FreeAtom(ctx, atom);
    if (gone <= 0) {
        fprintf(stderr, "bintana: '%s' would not be deleted -- the hatch is "
                        "still open\n", name);
        if (gone < 0)
            JS_FreeValue(ctx, JS_GetException(ctx));
    }
}

void bta_close_hatches(JSContext *ctx)
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
     *
     * That parenthesis is true and answers only half of what the same absence
     * decides.  JS_AddIntrinsicPromise builds the AsyncFunction constructor --
     * so there is no hatch here -- **and** is the only thing that registers the
     * engine's async classes, without which an async function object can never
     * be collected and JS_FreeRuntime aborts at exit.  That is why `async` is
     * refused in the parser now; see patch 5 in AGENTS.md.
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

    /*
     * `Array.fromAsync`, which is an async function the engine builds lazily on
     * first read -- and patch 5's reason, arriving by a door the parser cannot
     * guard. Without `JS_AddIntrinsicPromise` the async classes are never
     * registered, so the object that read builds can never be collected: one
     * `typeof Array.fromAsync` (which answered "object") was enough to make
     * `JS_FreeRuntime` abort at exit, 134, after the program had done its work.
     * Found through `Widget.Members("Array")`, which reads every own property
     * of the constructor. It cannot work without promises anyway, so it goes.
     */
    JSValue array = JS_GetPropertyStr(ctx, global, "Array");
    if (JS_IsObject(array))
        delete_named(ctx, array, "fromAsync");
    JS_FreeValue(ctx, array);

    /*
     * RegExp, whose name goes the way Function's did -- and this is the half of
     * the bargain Timer's removal needed.  `/x/g` is syntax and still produces
     * one, which is why taking the name was once judged to buy little: what
     * goes is `new RegExp(p, flags)`, so a pattern **built from strings** has
     * exactly one spelling now and it is `Regex` (rad.js captured the
     * constructor before this runs, and `Regex` is built on it).
     *
     * The prototype's own `constructor` goes first, the same side door
     * GeneratorFunction arrived by: `(/(?:)/).constructor` hands the function
     * straight back, and leaving it while deleting the global would be theatre.
     * Nothing here reads it -- `instanceof` walks the prototype chain and does
     * not ask.
     */
    JSValue regexp = JS_GetPropertyStr(ctx, global, "RegExp");
    if (JS_IsObject(regexp)) {
        JSValue proto = JS_GetPropertyStr(ctx, regexp, "prototype");
        delete_named(ctx, proto, "constructor");
        JS_FreeValue(ctx, proto);
    }
    JS_FreeValue(ctx, regexp);

    /*
     * The list the table above replaced, walked for the deletion itself. The
     * second column is not read here: it is published by
     * `Application.Replacements`, off the same rows.
     */
    for (size_t i = 0; i < G_N_ELEMENTS(bta_replacements); i++)
        delete_named(ctx, global, bta_replacements[i].name);

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
        /* `G_SEARCHPATH_SEPARATOR` and not a colon: the variable holds paths,
         * and on Windows a path begins with `C:` -- splitting on the colon
         * there cuts the first one in two. */
        char **parts = g_strsplit(env, G_SEARCHPATH_SEPARATOR_S, -1);
        for (int i = 0; parts[i]; i++)
            if (*parts[i])
                g_ptr_array_add(out, g_strdup(parts[i]));
        g_strfreev(parts);
    }

    g_ptr_array_add(out, g_build_filename(g_get_user_data_dir(), "bintana",
                                          "lib", NULL));

    char *exe = bta_exe_path();
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
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        project = JS_ToCString(ctx, argv[1]);
        if (!project) {
            JS_FreeCString(ctx, name);
            return JS_EXCEPTION;       /* it threw on the way; that stands */
        }
    }

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
 * see bta_close_hatches().
 */
JSContext *bta_new_context(JSRuntime *rt)
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
/*
 * Two ways a compiler says "this build has AddressSanitizer", and **they must
 * not be asked in one `#if`.** `__SANITIZE_ADDRESS__` is GCC's; Clang answers
 * `__has_feature(address_sanitizer)` instead, and GCC only learned that
 * spelling in version 15. On anything older the `defined(__has_feature) && …`
 * guard reads as one but is not one: the preprocessor parses the whole
 * expression and `&&` does not short-circuit a *syntax* error, so GCC 13 stops
 * with `missing binary operator before token "("`. Ubuntu 24.04 is GCC 13, and
 * that is the CI runner this was found on.
 *
 * So the question is nested inside the `#ifdef` that knows the name exists.
 */
#if defined(__SANITIZE_ADDRESS__)
# define BTA_ASAN 1
#elif defined(__has_feature)
# if __has_feature(address_sanitizer)
#  define BTA_ASAN 1
# endif
#endif

#ifdef BTA_ASAN
    JS_SetMaxStackSize(app->rt, 6 * 1024 * 1024);
#else
    JS_SetMaxStackSize(app->rt, 2 * 1024 * 1024);
#endif

    app->ctx = bta_new_context(app->rt);
    JS_SetRuntimeOpaque(app->rt, app);
    JS_SetContextOpaque(app->ctx, app);

    /* Defaults, overridden by project.json below. */
    app->name    = g_path_get_basename(app->dir);
    app->version = g_strdup("");
    app->id      = g_strdup("");
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
            g_free(app->id);
            g_free(app->startup);
            app->name    = json_str(app->ctx, cfg, "name", "app");
            app->version = json_str(app->ctx, cfg, "version", "");
            app->id      = json_str(app->ctx, cfg, "id", "");
            /* `json_str` falls back for a value that is not text, which for
             * the id meant `"id": 5` was the same as no id -- the silence the
             * refusal below exists to end. Anything present and not text is
             * refused by the same door. */
            JSValue idv = JS_GetPropertyStr(app->ctx, cfg, "id");
            bool    bad = !JS_IsUndefined(idv) && !JS_IsString(idv);
            JS_FreeValue(app->ctx, idv);
            if (bad) {
                fprintf(stderr, "bintana: project.json id is not a string: it "
                                "has to be a reverse-DNS name like "
                                "org.example.App\n");
                exit(2);
            }
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

    /*
     * An id that is not one is refused here rather than ignored, and the
     * difference matters: the id is the window's own class, the `<id>` of the
     * metainfo and the name a package installs under, so a typo would be a
     * window nothing recognises -- in silence, because every one of those is
     * something nobody looks at until a dock shows the wrong icon.
     *
     * The rule is the platform's (`g_application_id_is_valid`: reverse-DNS,
     * at least one dot, no element starting with a digit) and not a second one
     * written here -- the same rule `GtkApplication` and AppStream apply.
     */
    if (app->id[0] && !g_application_id_is_valid(app->id)) {
        fprintf(stderr,
                "bintana: project.json id \"%s\" is not an application id "
                "(a reverse-DNS name like org.example.App)\n", app->id);
        exit(2);
    }

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
    /* First: workers hold values of this context and run on their own threads,
     * so they are stopped and joined before anything they touch goes away. */
    bta_task_cleanup();
    bta_sys_cleanup();
    bta_http_cleanup();
    bta_media_cleanup();
    bta_printer_cleanup();
    bta_keyring_cleanup();
    /* Forms still shown hold a reference the collector cannot see; drop it
     * before the context goes, or JS_FreeRuntime asserts. */
    bta_forms_cleanup();
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
    g_free(app->id);
    g_free(app->startup);
    g_free(app->entry);
    /* Owns its paths (collect_libs builds it with g_free as the element free
     * func), and only bta_plugins_load reads it -- which is long done. */
    if (app->libs)
        g_ptr_array_unref(app->libs);
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

    if (bta_sys_pending() + bta_http_pending() + bta_media_pending() +
        bta_task_pending() + bta_keyring_pending() > 0)
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

    /* The profiler's "Startup" span: from `--profile`/Sysprof to the end of
     * `main`, which for a console project is the whole of its start. */
    bta_profile_startup_done(app->name);

    /*
     * A poll and not a signal from each of the three places work can finish:
     * this only decides *when to notice* that there is nothing left, and
     * noticing 20 ms late costs an exit 20 ms later.  It cannot end a program
     * early -- while a callback runs, the loop is not dispatching this.
     */
    if (!app->quitting && bta_sys_pending() + bta_http_pending() +
        bta_media_pending() + bta_task_pending() + bta_keyring_pending() > 0) {
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

    /* The profiler's "Startup" span ends where the window is up and the
     * project's own `Form_Open` has run: everything before the first frame
     * that can be blamed on opening the program. */
    bta_profile_startup_done(app->name);
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

    /*
     * **The window's identity is the application's, on both backends, and it
     * takes two calls because GTK reads it from two places.**  Wayland takes
     * the xdg-toplevel app id from the `GtkApplication`
     * (`gdktoplevel-wayland.c`: `application.application_id`, falling back to
     * the program name).  X11 builds `WM_CLASS` out of the program name and
     * never looks at the application id (`gdksurface-x11.c`), which is why the
     * id becomes the program name too -- `StartupWMClass` is one string, and it
     * has to match on both.
     *
     * `G_APPLICATION_NON_UNIQUE` keeps two instances of one project legal,
     * which is what this runtime has always allowed: a project is opened by
     * path, and the same path twice is a person's business.
     *
     * A project with no id keeps the old answer: no application id, and the
     * program name is whatever it was started as -- which is what the
     * `exec -a bintana-ide` launcher still exists for.
     */
    if (app->id[0])
        g_set_prgname(app->id);

    app->gapp = gtk_application_new(app->id[0] ? app->id : NULL,
                                    G_APPLICATION_NON_UNIQUE);
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
