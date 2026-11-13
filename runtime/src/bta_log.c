/*
 * `Logger`, which both hosts install.
 *
 * It lived in bta_runtime.c, and the console host kept four functions that
 * printed every line, `Debug` included, with no `Level`, no `Target` and no
 * `Logger.Handler` -- so a `main` that set `Logger.Level = "Warning"` got a
 * property that changed nothing under `bintana`, and its `Debug` lines on the
 * terminal anyway. One file, linked by both, with the journal where the build
 * has one (bta_journal.c).
 */
#include "bta.h"

#include <errno.h>
#include <glib/gstdio.h>
#include <stdio.h>
#include <string.h>

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
                                   name, bta_errno_text(errno));
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

void bta_logger_init(JSContext *ctx, JSValueConst global)
{
    /*
     * Logger, which is what `console` was standing in for badly: its .log and
     * .error both went to stdout, so the one distinction it offered was a lie.
     *
     * The long name on purpose: `Log` next to a number reads as a logarithm.
     */
    JSValue logger = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, logger, log_props, G_N_ELEMENTS(log_props));
    JS_SetPropertyStr(ctx, global, "Logger", logger);
}
