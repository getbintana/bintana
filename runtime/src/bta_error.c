/*
 * The report of an error nobody caught, which both hosts give.
 *
 * Every uncaught error ends in `bta_dump_error`: it marks the run as failed,
 * prints the engine's sentence -- and, for a name the language took away, what
 * to write instead -- with the stack, and hands the pair to
 * `Application.OnError` when the program assigned one. Only what happens after
 * that is the host's (`bta_host_show_error`): the graphical host shows a window
 * or an alert; the console host has nothing to show, the terminal had it.
 *
 * It lived in bta_runtime.c, and the console host kept a copy that printed
 * the bare message, never called `Application.OnError`, and left out the
 * replacement hint -- so one uncaught error read differently under `bintana`
 * and `bintana-gui`, and a `main` that assigned a handler was never told.
 */
#include "bta.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

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

/* The host's display is done with the last error, and the next may be shown.
 * A host that shows one asynchronously (an alert) calls this when it closes. */
void bta_error_reporting_done(void)
{
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

const char *bta_error_red(void)   { return error_red(); }
const char *bta_error_plain(void) { return error_plain(); }

/* One at a time and never from inside one: the application's handler first;
 * then the host, which answers whether it is still showing it. */
static void report_error(JSContext *ctx, const char *msg, const char *stack)
{
    if (reporting_error)
        return;
    reporting_error = true;

    if (error_handled_by_app(ctx, msg, stack) ||
        !bta_host_show_error(ctx, msg, stack))
        reporting_error = false;
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
    if (is_ref && g_str_has_suffix(text, " is not defined")) {
        /* The suffix is the whole of the parse, and what is in front of it has
         * to be the whole name: a prefix match alone would enrich a message
         * about something that merely starts with the same letters. */
        char       *name = g_strndup(text, strlen(text) - strlen(" is not defined"));
        const char *use  = bta_replacement_for(name);

        if (use)
            hint = g_strdup_printf("%s is not part of this language%s%s", name,
                                   *use ? ": use "
                                        : ", and nothing here replaces it",
                                   use);
        g_free(name);
    }

    JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, text_v);
    return hint;
}

void bta_dump_error(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);

    /* Recorded at the one place every uncaught error ends, and before the
     * reporting below -- which can itself fail -- so the fact cannot be lost.
     * A console run turns it into an exit status; a windowed run leaves the
     * status alone, because a handler that throws does not take the window
     * down. */
    bta_host_error_uncaught();

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
