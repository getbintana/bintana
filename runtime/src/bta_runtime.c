/*
 * Interpreter setup, project loading and the GTK main loop.
 */
#include "bta.h"
#include "bta_prelude.h"
#include "bta_forms.h"
#include "bta_base_css.h"

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
        /* Copy: ask again with the same alert, so the report stays in progress
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
    bta_error_reporting_done();
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

/* This host's half of an uncaught error (bta_error.c): the run is marked, and
 * with a display the error is shown -- `forms.js`'s window, or the alert when
 * that cannot be had. True while the alert is up: it calls
 * `bta_error_reporting_done` when it closes. */
void bta_host_error_uncaught(void)
{
    if (g_app)
        g_app->uncaught = true;
}

bool bta_host_show_error(JSContext *ctx, const char *msg, const char *stack)
{
    BtaApp *app = bta_current_app();
    if (!app || !app->gapp)
        return false;                 /* no display: the terminal had it */

    if (show_error_window(ctx, msg, stack))
        return false;                 /* `showError` keeps its own one-at-a-time */

    /* choose() and not show(): being told when it is dismissed is what keeps a
     * handler that throws on every tick from stacking up dialogs forever. */
    GtkAlertDialog *d = error_alert(msg, stack);
    gtk_alert_dialog_choose(d, gtk_application_get_active_window(app->gapp),
                            NULL, on_error_dismissed, error_text(msg, stack));
    g_object_unref(d);
    return true;
}

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
    fprintf(stderr, "\n%sBintana error:%s %s\n", bta_error_red(), bta_error_plain(),
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

    bool    is_module;
    bta_modules_checking(ctx, true);
    JSValue r = bta_compile(ctx, src, strlen(src), "<check>", &is_module);
    bta_modules_checking(ctx, false);
    JS_FreeCString(ctx, src);

    if (!JS_IsException(r)) {
        /* A module compiled only to be looked at is discarded: the engine
         * otherwise keeps every one for the life of the context, which in an
         * editor checking as somebody types is a megabyte a keystroke (fork
         * patch 14). */
        JS_FreeUnevaluatedModule(ctx, r);
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
    /* What a module publishes, and each name it imports (fork patch 15). */
    case JS_SYMBOL_EXPORT:        return "Export";
    case JS_SYMBOL_IMPORT:        return "Import";
    /* A public instance field of a class: `this.total` is a use of it. */
    case JS_SYMBOL_FIELD:         return "Field";
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
    /* An export or an import carries its specifier in the field a class keeps
     * its base in; it is handed out as `From` and `Super` stays a base class. */
    bool module_kind = kind == JS_SYMBOL_EXPORT || kind == JS_SYMBOL_IMPORT;
    JS_SetPropertyStr(ctx, obj, "Super",
                      JS_NewString(ctx, !module_kind && supertype ? supertype : ""));
    JS_SetPropertyStr(ctx, obj, "From",
                      JS_NewString(ctx, module_kind && supertype ? supertype : ""));
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

    /* Which of the two the text is, asked first and without the handler: a
     * script compile that fails reports what it read before failing, and a
     * module would then report its declarations twice. */
    bool    is_module;
    bta_modules_checking(ctx, true);
    JSValue probe = bta_compile(ctx, src, strlen(src), "<symbols>", &is_module);
    if (JS_IsException(probe))
        JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeUnevaluatedModule(ctx, probe);     /* fork patch 14, as in CheckSource */

    JS_SetSymbolHandler(rt, symbol_report, &sink);

    JSValue r = JS_Eval(ctx, src, strlen(src), "<symbols>",
                        (is_module ? JS_EVAL_TYPE_MODULE
                                   : JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT) |
                        JS_EVAL_FLAG_COMPILE_ONLY);

    JS_SetSymbolHandler(rt, NULL, NULL);
    bta_modules_checking(ctx, false);

    /* Compiled and not run, so the only thing it can hand back is an error --
     * and the symbols collected before it are the answer, not the error. */
    if (JS_IsException(r))
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        JS_FreeUnevaluatedModule(ctx, r);

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

/* ------------------------------------------------------------ free names */

typedef struct {
    JSValue  list;
    uint32_t n;
} FreeNameSink;

static void free_name_report(JSContext *ctx, JSAtom name, int line, void *opaque)
{
    FreeNameSink *sink = opaque;
    const char   *s    = JS_AtomToCString(ctx, name);

    if (!s) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }
    bool ours = bta_module_runtime_binds(ctx, s);
    JS_FreeCString(ctx, s);
    if (ours)
        return;

    JSValue row = JS_NewObject(ctx);
    if (JS_IsException(row)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }
    JS_SetPropertyStr(ctx, row, "Name", JS_AtomToString(ctx, name));
    JS_SetPropertyStr(ctx, row, "Line", JS_NewInt32(ctx, line));
    JS_SetPropertyUint32(ctx, sink->list, sink->n++, row);
}

/*
 * `Application.FreeNames(text)`: every name the text reads or writes that
 * nothing in it binds and the runtime does not answer, one row per use, with
 * its line -- fork patch 16's walk over the compiled bytecode, which is the
 * compiler's own scope analysis and not a reading of it.  `typeof X` is left
 * out (patch 18's flag): it asks whether a name exists rather than needing it
 * to.
 *
 * **What the runtime answers is the photograph's, not this process's scope**
 * (`bta_module_runtime_binds`): the IDE asks about a project it is editing,
 * and its own exports and classes are on its global scope and on nobody
 * else's.  A taken-away name (`setTimeout`) is not answered, so it is listed.
 *
 * Compiled with the loader's bookkeeping off (`bta_modules_checking`), so a
 * text that is only looked at is not written down as a file of the program --
 * the same guard `Symbols` and `CheckSource` keep.  A text that does not
 * compile answers `[]`: saying why is `CheckSource`'s job, and a partial list
 * from a broken parse would report the names past the break.
 */
static JSValue js_application_free_names(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    const char *src = argc > 0 && JS_IsString(argv[0])
                    ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!src)
        return JS_ThrowTypeError(ctx, "Application.FreeNames(text) needs text");

    FreeNameSink sink = { JS_NewArray(ctx), 0 };
    bool         is_module;

    bta_modules_checking(ctx, true);
    JSValue compiled = bta_compile(ctx, src, strlen(src), "<free names>", &is_module);
    bta_modules_checking(ctx, false);
    JS_FreeCString(ctx, src);

    if (JS_IsException(compiled)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return sink.list;
    }
    JS_EnumFreeNamesFlags(ctx, compiled, JS_FREE_NAMES_SKIP_TYPEOF,
                          free_name_report, &sink);
    JS_FreeUnevaluatedModule(ctx, compiled);     /* fork patch 14 */
    return sink.list;
}

/* Every dot-separated segment an identifier, and at least one segment. */
static bool is_class_path(const char *s)
{
    if (!s || !*s)
        return false;

    char **parts = g_strsplit(s, ".", -1);
    bool   ok    = true;

    for (int i = 0; parts[i]; i++)
        if (!bta_is_identifier(parts[i]))
            ok = false;

    g_strfreev(parts);
    return ok;
}

/*
 * A class by name, which is how a .form names a type and how project.btp names
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

/*
 * The value a bare name resolves to, for `rad.js` and for nothing else.
 *
 * A `.record` file names the classes its fields hold, and a name has to resolve
 * the way the rest of the runtime resolves one -- a project's `class Line`, or
 * a library's -- which is `bta_lookup_global` above.  JavaScript cannot
 * evaluate a name itself (`eval` is not part of this language), so the rule is
 * handed over as this hook; `Record`'s loader captures it and the hatch below
 * takes the name away.
 */
static JSValue js_class_of_name(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "the name lookup needs a name");

    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;

    JSValue out = bta_lookup_global(ctx, name);
    JS_FreeCString(ctx, name);
    return out;
}

/* Installed by the main thread and by every worker; deleted with the hatches. */
void bta_class_of_name_init(JSContext *ctx, JSValueConst global)
{
    JS_SetPropertyStr(ctx, global, "classOfName",
                      JS_NewCFunction(ctx, js_class_of_name, "classOfName", 1));
}

/* ---------------------------------------------------------------- globals */

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
        if (g_app->gapp) {
            /* Quitting closes no window, so a form that remembers itself
             * would never hear its close-request. */
            bta_forms_remember_all();
            g_application_quit(G_APPLICATION(g_app->gapp));
        }

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
 * How this host shows a `Message` (bta_message.c): a GTK alert, which is
 * fire-and-forget, so `Message.Info` shows and returns rather than blocking
 * like VB's MsgBox. With no display -- a `main`, or before the application
 * is up -- it answers false and the shared half prints to stderr.
 */
bool bta_message_show(int kind, const char *text)
{
    static const char *headings[] = { NULL, "Warning", "Error" };
    BtaApp            *app = bta_current_app();
    GtkAlertDialog    *d;

    if (!app || !app->gapp)
        return false;

    if (kind > 0 && kind < 3) {
        d = gtk_alert_dialog_new("%s", headings[kind]);
        gtk_alert_dialog_set_detail(d, text);
    } else {
        d = gtk_alert_dialog_new("%s", text);
    }
    gtk_alert_dialog_set_modal(d, TRUE);
    gtk_alert_dialog_show(d, gtk_application_get_active_window(app->gapp));
    g_object_unref(d);
    return true;
}

/* A `Task` worker's share of this host (bta_task.c): GdkPixbuf's `Bitmap`,
 * `Probe` and `PdfDocument`, which read and answer and hold no callback, and
 * `Tray`'s names, which exist and refuse off the main thread. */
void bta_task_worker_host(JSContext *ctx, JSValueConst global)
{
    bta_bitmap_init(ctx, global);
    bta_tray_init_worker(ctx, global);
    bta_probe_init(ctx, global);
    bta_pdf_init(ctx, global);
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
 * Application.Inhibit(reason, what): keep the session from suspending, blanking,
 * logging out or switching user while something runs.  See
 * docs/plans/inhibit-plan.md for the measurements behind every line.
 *
 * **GTK does the asking**, and GTK answers differently per platform: on Linux
 * it goes to the Inhibit portal (and answers a cookie before the portal has
 * said yes or no), on Windows to PowerSetRequest, which has no Switch, and on
 * macOS it honours Logout alone and answers a cookie for the rest anyway.  So
 * a request this platform's GTK cannot hold in full is not made at all, and
 * answers `Active: false` -- a backup believing it is protected is the one
 * answer worse than *no*.
 *
 * The live cookies are kept here because `gtk_application_uninhibit` warns on
 * one it does not know, and a Release called twice is not an error.
 */
static GHashTable *inhibit_cookies;

static const struct {
    const char                 *name;
    GtkApplicationInhibitFlags  flag;
} inhibit_reasons[] = {
    { "Suspend", GTK_APPLICATION_INHIBIT_SUSPEND },
    { "Idle",    GTK_APPLICATION_INHIBIT_IDLE    },
    { "Logout",  GTK_APPLICATION_INHIBIT_LOGOUT  },
    { "Switch",  GTK_APPLICATION_INHIBIT_SWITCH  },
};

#if defined(G_OS_WIN32)
#define INHIBIT_BY       "PowerRequest"
#define INHIBIT_HONOURED (GTK_APPLICATION_INHIBIT_SUSPEND | GTK_APPLICATION_INHIBIT_IDLE | \
                          GTK_APPLICATION_INHIBIT_LOGOUT)
#elif defined(__APPLE__)
#define INHIBIT_BY       "AppKit"
#define INHIBIT_HONOURED GTK_APPLICATION_INHIBIT_LOGOUT
#else
#define INHIBIT_BY       "Portal"
#define INHIBIT_HONOURED (GTK_APPLICATION_INHIBIT_SUSPEND | GTK_APPLICATION_INHIBIT_IDLE | \
                          GTK_APPLICATION_INHIBIT_LOGOUT | GTK_APPLICATION_INHIBIT_SWITCH)
#endif

static JSValue inhibit_release(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv, int magic,
                               JSValueConst *data)
{
    uint32_t cookie = 0;
    JS_ToUint32(ctx, &cookie, data[0]);
    if (cookie && inhibit_cookies &&
        g_hash_table_remove(inhibit_cookies, GUINT_TO_POINTER(cookie)) &&
        g_app && g_app->gapp)
        gtk_application_uninhibit(g_app->gapp, cookie);
    if (JS_IsObject(this_val))
        JS_SetPropertyStr(ctx, (JSValue)this_val, "Active", JS_FALSE);
    return JS_UNDEFINED;
}

static JSValue js_inhibit(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx,
            "Application.Inhibit(reason, [what]) needs a reason the user will read");

    GtkApplicationInhibitFlags flags = 0;
    if (argc < 2 || JS_IsUndefined(argv[1])) {
        flags = GTK_APPLICATION_INHIBIT_SUSPEND;
    } else {
        if (!JS_IsArray(argv[1]))
            return JS_ThrowTypeError(ctx,
                "Application.Inhibit: what is an array of \"Suspend\", \"Idle\", \"Logout\", \"Switch\"");
        int64_t n = 0;
        JSValue len = JS_GetPropertyStr(ctx, argv[1], "length");
        JS_ToInt64(ctx, &n, len);
        JS_FreeValue(ctx, len);
        for (int64_t i = 0; i < n; i++) {
            JSValue v = JS_GetPropertyInt64(ctx, argv[1], i);
            const char *s = JS_IsString(v) ? JS_ToCString(ctx, v) : NULL;
            JS_FreeValue(ctx, v);
            GtkApplicationInhibitFlags f = 0;
            for (size_t k = 0; s && k < G_N_ELEMENTS(inhibit_reasons); k++)
                if (strcmp(s, inhibit_reasons[k].name) == 0)
                    f = inhibit_reasons[k].flag;
            if (!f) {
                JSValue e = JS_ThrowTypeError(ctx,
                    "Application.Inhibit: \"%s\" is not one of \"Suspend\", \"Idle\", \"Logout\", \"Switch\"",
                    s ? s : "(not a string)");
                if (s) JS_FreeCString(ctx, s);
                return e;
            }
            JS_FreeCString(ctx, s);
            flags |= f;
        }
        if (!flags)
            return JS_ThrowTypeError(ctx,
                "Application.Inhibit: an empty list inhibits nothing; leave it out for [\"Suspend\"]");
    }

    const char *reason = JS_ToCString(ctx, argv[0]);
    if (!reason)
        return JS_EXCEPTION;

    /* No GtkApplication is a console project, and nothing there to ask with. */
    guint cookie = 0;
    if (g_app && g_app->gapp && (flags & ~INHIBIT_HONOURED) == 0) {
        cookie = gtk_application_inhibit(g_app->gapp,
                                         gtk_application_get_active_window(g_app->gapp),
                                         flags, reason);
        if (cookie) {
            if (!inhibit_cookies)
                inhibit_cookies = g_hash_table_new(NULL, NULL);
            g_hash_table_add(inhibit_cookies, GUINT_TO_POINTER(cookie));
        }
    }
    JS_FreeCString(ctx, reason);

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Active", JS_NewBool(ctx, cookie != 0));
    JS_SetPropertyStr(ctx, out, "By", JS_NewString(ctx, cookie ? INHIBIT_BY : ""));
    JSValue id = JS_NewUint32(ctx, cookie);
    JS_SetPropertyStr(ctx, out, "Release",
                      JS_NewCFunctionData(ctx, inhibit_release, 0, 0, 1, &id));
    JS_FreeValue(ctx, id);
    return out;
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
            if (name && *name && !bta_module_exported(ctx, name))
                JS_SetPropertyUint32(ctx, out, n++, JS_NewString(ctx, name));
            if (name) JS_FreeCString(ctx, name);
        }
        JS_FreePropertyEnum(ctx, tab, len);
    }
    JS_FreeValue(ctx, global);
    return out;
}

/*
 * ProtectPrototype(): close `Object.prototype` to new names.
 *
 * `for...in` recites the prototype chain, so a plugin that polyfills
 * `Object.prototype.currency` changes every enumeration in the host -- the
 * total of an invoice among them. The language has no `Object.preventExtensions`
 * (it went with the rest of `Object`), so the defence is a runtime verb: after
 * this, an assignment or a `defineProperty` that would add a name to
 * `Object.prototype` is refused, and the program's own `for...in` loops are
 * stable again.
 *
 * **Existing members can still be replaced**: this is `preventExtensions`, not
 * `freeze`. A host that wants the stronger promise can say so later; a plugin
 * that patches `toString` is a different problem from one that adds a key.
 * Calling it twice is harmless, and it answers `true` both times.
 */
static JSValue js_protect_prototype(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue object = JS_GetPropertyStr(ctx, global, "Object");
    JS_FreeValue(ctx, global);

    if (JS_IsException(object))
        return object;

    JSValue proto = JS_GetPropertyStr(ctx, object, "prototype");
    JS_FreeValue(ctx, object);

    if (JS_IsException(proto))
        return proto;

    int ok = JS_PreventExtensions(ctx, proto);
    JS_FreeValue(ctx, proto);

    if (!ok)
        return JS_ThrowPlainError(ctx,
            "ProtectPrototype: Object.prototype is not an object");
    return JS_TRUE;
}

/*
 * The variant in force: `"dark"`, `"light"`, or NULL for *as the desktop says*.
 *
 * Both of GTK's settings are written, and **what they said before the first
 * override is kept**, so going back to the desktop's (`Application.Theme = ""`)
 * restores the desktop's own values rather than guessing them: a desktop that
 * prefers dark through `gtk-application-prefer-dark-theme` is put back as it
 * was. `gtk-interface-color-scheme` is 4.20's and looked up by name, since the
 * floor is 4.10. Both are what a `Form`'s `ThemeChange` listens to, so every
 * open window hears one change and re-derives `Dark` from the new ink.
 */
static char    *theme_forced;
static bool     theme_saved;
static gboolean theme_saved_dark;
static int      theme_saved_scheme = -1;

static GParamSpec *theme_scheme_spec(GtkSettings *settings)
{
    GParamSpec *scheme = g_object_class_find_property(G_OBJECT_GET_CLASS(settings),
                                                      "gtk-interface-color-scheme");
    if (scheme && (scheme->flags & G_PARAM_WRITABLE) && G_IS_PARAM_SPEC_ENUM(scheme))
        return scheme;
    return NULL;
}

static void set_theme(const char *theme)
{
    GtkSettings *settings = gtk_settings_get_default();

    if (theme && !*theme)
        theme = NULL;
    g_free(theme_forced);
    theme_forced = g_strdup(theme);

    /* A console project has no settings: the word is kept and read back, and
     * nothing is drawn for it to change. */
    if (!settings)
        return;

    GParamSpec *scheme = theme_scheme_spec(settings);

    if (!theme_saved) {
        if (!theme)
            return;            /* nothing was overridden, nothing to restore */
        theme_saved = true;
        g_object_get(settings, "gtk-application-prefer-dark-theme", &theme_saved_dark, NULL);
        if (scheme)
            g_object_get(settings, "gtk-interface-color-scheme", &theme_saved_scheme, NULL);
    }

    if (!theme) {
        g_object_set(settings, "gtk-application-prefer-dark-theme", theme_saved_dark, NULL);
        if (scheme && theme_saved_scheme >= 0)
            g_object_set(settings, "gtk-interface-color-scheme", theme_saved_scheme, NULL);
        return;
    }

    bool dark = g_str_equal(theme, "dark");
    g_object_set(settings, "gtk-application-prefer-dark-theme", dark, NULL);
    if (scheme) {
        GEnumValue *v = g_enum_get_value_by_nick(G_PARAM_SPEC_ENUM(scheme)->enum_class,
                                                 dark ? "dark" : "light");
        if (v)
            g_object_set(settings, "gtk-interface-color-scheme", v->value, NULL);
    }
}

static JSValue js_app_get_theme(JSContext *ctx, JSValueConst this_val)
{
    return JS_NewString(ctx, theme_forced ? theme_forced : "");
}

static JSValue js_app_set_theme(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    /* A word and only one of three: `Theme = true` or `"Dark mode"` doing
     * nothing would be the silent half-answer, so anything else is refused
     * and the theme stays as it was. */
    if (!JS_IsString(val))
        return JS_ThrowTypeError(ctx, "Application.Theme is \"\", \"light\" or \"dark\"");

    const char *word = JS_ToCString(ctx, val);
    if (!word)
        return JS_EXCEPTION;

    const char *theme = NULL;
    if (!g_ascii_strcasecmp(word, "dark"))
        theme = "dark";
    else if (!g_ascii_strcasecmp(word, "light"))
        theme = "light";
    else if (*word) {
        JS_FreeCString(ctx, word);
        return JS_ThrowRangeError(ctx, "Application.Theme is \"\", \"light\" or \"dark\"");
    }
    JS_FreeCString(ctx, word);

    set_theme(theme);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry app_props[] = {
    /* Theme
     *   `"dark"` or `"light"` to draw the whole application in that variant of
     *   the theme whatever the desktop prefers, `""` (the default) to follow
     *   it. Assignable at any time: open windows follow, a `Form` raises
     *   `ThemeChange` and `Dark` answers the new ground. `""` puts back what
     *   the desktop said. **The program outranks `--theme`**, which sets the
     *   starting value; a word that is not one of the three is refused. A
     *   theme forced with the `GTK_THEME` variable (`Adwaita:dark`) is
     *   beyond it
     */
    JS_CGETSET_DEF("Theme", js_app_get_theme, js_app_set_theme),
};

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

    bta_logger_init(ctx, global);   /* bta_log.c */

    /* Application: the Gambas-ish ambient singleton. */
    JSValue application = JS_NewObject(ctx);
    /* Name
     *   from `project.btp`
     */
    JS_SetPropertyStr(ctx, application, "Name", JS_NewString(ctx, app->name));
    /*
     * What the *application* calls its release, out of its own project.btp --
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
     *   from `project.btp`: the application's identity in reverse DNS —
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
     *   runner reads as success; `Quit()` is `0`. **An uncaught error makes a
     *   `main` project exit `1` unless `Quit` said otherwise** — a traceback
     *   that leaves the status at `0` is a failure a runner reads as success
     *   too
     */
    JS_SetPropertyStr(ctx, application, "Quit",
                      JS_NewCFunction(ctx, js_quit, "Quit", 1));
    /* Inhibit(reason, [what]) -> object
     *   keep the session from doing something while work runs — a backup, an
     *   export, a long download. `what` is any of `"Suspend"`, `"Idle"` (the
     *   screen blanking), `"Logout"`, `"Switch"` (switching user), and
     *   `["Suspend"]` when left out; `reason` is what the desktop shows the
     *   user. Answers `{ Active, By, Release() }`: **`Active` says whether this
     *   machine agreed**, and `false` is an answer, never a throw — a console
     *   project, or a platform that cannot hold all of `what` (macOS holds only
     *   `"Logout"`, Windows has no `"Switch"`), asks nothing and answers
     *   `false`. `By` is `"Portal"` on Linux, `"PowerRequest"` on Windows,
     *   `"AppKit"` on macOS, `""` when not active. **On Linux the portal's
     *   refusal is not visible**: `Active` is *asked*, and a desktop whose
     *   portal has no Inhibit (XFCE's, by default) refuses it silently.
     *   `Release()` lets go, and twice is harmless; quitting releases
     *   everything
     */
    JS_SetPropertyStr(ctx, application, "Inhibit",
                      JS_NewCFunction(ctx, js_inhibit, "Inhibit", 2));

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
    /* Symbols(text) -> { Name, Kind, Line, Parent, Super, From, Params, End, Doc, Returns }[]
     *   what the text declares — `[{ Name, Kind, Line, Parent, Super, From,
     *   Params, End, Doc, Returns }]`, out of the parser and with nothing run.
     *   **`Kind` is `"Class"`, `"Function"`, `"Method"`, `"Static"`,
     *   `"Getter"`, `"Setter"`, `"StaticGetter"`, `"StaticSetter"` or
     *   `"Field"`** (a public instance field of a class, `total = 0;`, with
     *   `Parent` the class), or
     *   **`"Assigned"`** (a function assigned at the top level, named by its
     *   target as written — `File.LoadJson`, `Widget.prototype.Dump` — and
     *   each function an object literal holds when the literal is assigned
     *   there, as `Target.Name`), or
     *   **`"Variable"`** (each `let`/`const`/`var`, destructured name,
     *   `for...of` variable and `catch` binding, at its line) and
     *   **`"Scope"`** (every function, anonymous ones included, with its
     *   `Params` and the lines it spans, `Line` to **`End`**; one that fails
     *   to parse spans up to where it broke) — together, what a name can mean
     *   where the cursor is — or, in a module, **`"Export"`** (one per name it
     *   publishes, at its `export`: `Name` the exported name, `default` or
     *   `*`, `Parent` the local name it stands for) and **`"Import"`** (one
     *   per binding, at its `import`: `Name` the local name, `Parent` the name
     *   imported, `default` or `*`), each with **`From`**, the specifier, `""`
     *   for an export of the file's own — the member kinds are what separates `Value: T`
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

    /* FreeNames(text) -> { Name, Line }[]
     *   every name the text reads, writes or calls that nothing in it
     *   declares and the runtime does not answer — one row per use, in the
     *   order of the code, out of the compiler and with nothing run. **What
     *   is left is what the rest of the program has to answer**: another
     *   file's export, a library's class, a script's top-level declaration —
     *   or nothing, which is a `ReferenceError` on the day that line runs.
     *   The runtime's answer is the one it had before the program's first
     *   file, so an editor asking about another project is not answered out
     *   of its own scope, and a name the language took away (`setTimeout`)
     *   is listed. **`typeof X` is not a use**, since it asks whether a name
     *   exists. In a script the file's own top-level names are listed too,
     *   because a script's top level is the global scope; in a module they
     *   are bound. `[]` for a text that does not compile — `CheckSource`
     *   says why
     */
    JS_SetPropertyStr(ctx, application, "FreeNames",
                      JS_NewCFunction(ctx, js_application_free_names, "FreeNames", 1));

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
     * `project.btp` that could only be written by hand.
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
     *   a project's classes are *not* in it -- nor what a module exports, which
     *   is on the global object and left out on purpose: it is the program's
     *   and not the runtime's -- read those out of the sources,
     *   which is what the IDE does. It exists because the alternative is a
     *   hand-written list of global names, and there are a hundred and
     *   sixty-four of them
     */
    JS_SetPropertyStr(ctx, application, "Globals",
                      JS_NewCFunction(ctx, js_globals, "Globals", 0));
    /* ProtectPrototype()
     *   refuse every new name on `Object.prototype`, so code loaded later
     *   cannot change every `for...in` in the program. Existing members can
     *   still be replaced; answers `true`, also when it was already closed
     */
    JS_SetPropertyStr(ctx, application, "ProtectPrototype",
                      JS_NewCFunction(ctx, js_protect_prototype,
                                      "ProtectPrototype", 0));

    /* Replacements()
     *   every name this language takes away, and what to write instead. It is
     *   a bag keyed by the name that went: `{ setTimeout: "Timer.After(delay,
     *   tick) — the delay comes first", "Object.assign": "{ ...a, ...b }", … }`.
     *   **`""` where there is no word for that thing here**, which is an
     *   answer rather than a gap in the table. An editor asks it of an
     *   identifier nobody can find, so a beginner meets `Timer` at the token
     *   rather than a `ReferenceError` at the next run. **The same sentence is
     *   in a caught `ReferenceError`'s `message`**, because the engine asks the
     *   table while it builds the error
     */
    JS_SetPropertyStr(ctx, application, "Replacements",
                      JS_NewCFunction(ctx, bta_application_replacements,
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
    /* OnSecondInstance
     *   assign `(args, directory) => …`: called in the **first** instance of
     *   a project that declares `"singleInstance": true` when it is started
     *   again. `args` is what followed the project directory on the second
     *   command line, as `Arguments` is, and `directory` is where that run was
     *   started. The second process then exits `0`, and **the first's window
     *   is brought forward after the handler returns**, whether or not one
     *   was assigned. `null` until assigned
     */
    JS_SetPropertyStr(ctx, application, "OnSecondInstance", JS_NULL);
    /* OnError
     *   assign `(message, stack) => …` to take over uncaught errors — **two
     *   strings, not the `Error`**. Without it an uncaught error goes to the
     *   terminal and to a window of the runtime's own; with it, to the
     *   handler instead. An error raised inside the handler reaches only the
     *   terminal. `null` until assigned
     */
    JS_SetPropertyStr(ctx, application, "OnError", JS_NULL);
    JS_SetPropertyFunctionList(ctx, application, app_props, G_N_ELEMENTS(app_props));

    JS_SetPropertyStr(ctx, global, "Application", application);

    bta_message_init(ctx, global);

    /*
     * Before the widgets, and so before any .form is loaded: the loader looks
     * every declared piece of prose up in whatever catalogue this found.
     */
    bta_locale_init(ctx, global, app->dir, app->libs);
    bta_bytes_init(ctx, global);
    bta_bitmap_init(ctx, global);
    bta_decimal_init(ctx, global);
    bta_painter_init(ctx, global);
    bta_metrics_init(ctx, global);
    bta_drawing_init(ctx, global);
    bta_day_init(ctx, global);
    bta_database_init(ctx, global);
    bta_sqlite_init(ctx, global);
    bta_odbc_init(ctx, global);
    bta_http_init(ctx, global);
    bta_socket_init(ctx, global);
    bta_serial_init(ctx, global);
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
    bta_cancellable_init(ctx, global);
    bta_task_init(ctx, global);
    bta_lock_init(ctx, global);
    bta_random_init(ctx, global);
    bta_gzip_init(ctx, global);
    bta_cipher_init(ctx, global);
    bta_notification_init(ctx, global);
    bta_tray_init(ctx, global);
    bta_zip_init(ctx, global);
    bta_probe_init(ctx, global);
    bta_popover_init(ctx, global);
    bta_desktop_init(ctx, global);
    bta_printer_init(ctx, global);
    bta_pdf_init(ctx, global);
    bta_key_init(ctx, global);
    bta_xml_init(ctx, global);
    bta_keyring_init(ctx, global);
    bta_network_init(ctx, global);

    /*
     * The two hooks `rad.js`'s `.record` half is built on, installed with the
     * rest and captured before the hatches close: where a class's shape is
     * declared (`bta_form.c`), and what a bare name resolves to.  Neither is a
     * language name -- `bta_close_hatches` deletes both -- so a program cannot
     * see either.
     */
    bta_record_init(ctx, global, app->dir, app->libs);
    bta_class_of_name_init(ctx, global);
    bta_strict_init(ctx, global);

    JS_FreeValue(ctx, global);

    /*
     * Two halves, and the split is what a worker thread needs: rad.js is the
     * language and forms.js is everything about widgets.  A Task builds a
     * runtime of its own and evaluates only the first, because
     * `bta_widgets_init` keeps each class's prototype and constructor in a
     * process-global table that a second runtime would overwrite.  They share
     * the global lexical scope, so forms.js still sees rad.js's captures --
     * which is why the order is this one and both run before the hatches
     * close.  See docs/notes/task-threads.md.
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

    /* A control's methods cannot be assigned over, from here on: after
     * forms.js, whose mixIns define onto the prototypes. */
    bta_seal_methods(ctx);

    /* Last, and only after rad.js: it captured what it needs. */
    bta_close_hatches(ctx);

    /* Where an `import` in the project's files resolves (bta_module.c). */
    bta_modules_scope(ctx, app->dir, app->libs);
    return true;
}

/* ---------------------------------------------------------------- project */

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
    char   *dir = bta_library_resolve(
        project ? project : (app ? app->dir : NULL), name, NULL);
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
 * **A directory is a library**, which is exactly what
 * `bta_library_resolve` decides with: anything stricter here -- "it must hold a
 * `.js`" -- would be a second opinion about what a library is, and the two
 * would disagree about some directory on somebody's machine. A name found twice is listed once and means
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

    bta_library_candidates(project ? project : (app ? app->dir : NULL), where);

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

BtaApp *bta_app_new(const char *project_dir)
{
    BtaApp *app = g_new0(BtaApp, 1);

    app->startup_form = JS_UNDEFINED;   /* not all-zero: g_new0 is not enough */
    /* A manifest handed over as a file (`bintana project.btp`) names the
     * project by the directory it sits in; the file itself is read below. */
    app->dir = bta_project_dir(project_dir);

    app->rt  = JS_NewRuntime();
    if (!app->rt) {
        fprintf(stderr, "bintana: out of memory: the runtime would not start\n");
        g_free(app->dir);
        g_free(app);
        return NULL;
    }

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
    if (!app->ctx) {
        fprintf(stderr, "bintana: out of memory: the context would not start\n");
        JS_FreeRuntime(app->rt);
        g_free(app->dir);
        g_free(app);
        return NULL;
    }
    JS_SetRuntimeOpaque(app->rt, app);
    JS_SetContextOpaque(app->ctx, app);

    /* Defaults, overridden by project.btp below. */
    app->name    = g_path_get_basename(app->dir);
    app->version = g_strdup("");
    app->id      = g_strdup("");
    app->startup = g_strdup("Form1");

    char *cfg_path = bta_project_manifest(app->dir);
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
            app->name    = bta_project_string(app->ctx, cfg, "name", "app");
            app->version = bta_project_string(app->ctx, cfg, "version", "");
            app->id      = bta_project_string(app->ctx, cfg, "id", "");
            /* `bta_project_string` falls back for a value that is not text,
             * which for the id meant `"id": 5` was the same as no id -- the
             * silence the refusal below exists to end. Anything present and
             * not text is refused by the same door. */
            JSValue idv = JS_GetPropertyStr(app->ctx, cfg, "id");
            bool    bad = !JS_IsUndefined(idv) && !JS_IsString(idv);
            JS_FreeValue(app->ctx, idv);
            if (bad) {
                fprintf(stderr, "bintana: project.btp id is not a string: it "
                                "has to be a reverse-DNS name like "
                                "org.example.App\n");
                exit(2);
            }
            /* `singleInstance` is a boolean and nothing else: `"yes"` read as
             * false would be two windows where one was asked for, in silence. */
            JSValue sv = JS_GetPropertyStr(app->ctx, cfg, "singleInstance");
            if (!JS_IsUndefined(sv) && !JS_IsBool(sv)) {
                fprintf(stderr, "bintana: project.btp singleInstance is not "
                                "true or false\n");
                exit(2);
            }
            app->single = JS_ToBool(app->ctx, sv) > 0;
            JS_FreeValue(app->ctx, sv);
            app->startup = bta_project_string(app->ctx, cfg, "startup", "Form1");
            /* A project declares one or the other: "startup" opens a form,
             * "main" calls a function and never touches the display. */
            app->entry   = bta_project_string(app->ctx, cfg, "main", NULL);
            app->libs    = bta_project_libs(app->ctx, app->dir, cfg);
            app->sources = bta_project_sources(app->ctx, app->dir, app->libs, cfg);
        }
        JS_FreeValue(app->ctx, cfg);
        g_free(cfg_src);
    } else {
        fprintf(stderr, "bintana: no project.btp in %s, using defaults\n", app->dir);
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
                "bintana: project.btp id \"%s\" is not an application id "
                "(a reverse-DNS name like org.example.App)\n", app->id);
        exit(2);
    }

    /* The id is what instances find each other by, so a project without one
     * cannot be single: refused, as a typo in the id is, and not ignored. */
    if (app->single && !app->id[0]) {
        fprintf(stderr, "bintana: project.btp singleInstance needs an id (a "
                        "reverse-DNS name like org.example.App): it is the "
                        "name the instances find each other by\n");
        exit(2);
    }

    if (!app->sources) {
        JSValue empty = JS_NewObject(app->ctx);
        app->sources = bta_project_sources(app->ctx, app->dir, app->libs, empty);
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
    bta_network_cleanup();
    bta_socket_cleanup();
    bta_serial_cleanup();
    bta_tray_cleanup();
    bta_notification_cleanup();
    /* Forms still shown hold a reference the collector cannot see; drop it
     * before the context goes, or JS_FreeRuntime asserts. */
    bta_popover_cleanup();
    bta_forms_cleanup();
    bta_locale_cleanup();
    bta_widgets_cleanup(app->ctx);
    JS_FreeContext(app->ctx);
    JS_FreeRuntime(app->rt);
    bta_pdf_cleanup();
    bta_modules_forget(app->ctx);   /* C strings only, keyed by the pointer */
    /* After the context: a plugin's cleanup is C-only, and this is where the
     * shared objects are let go. See the note on bta_plugins_cleanup. */
    bta_plugins_cleanup(app);
    g_clear_object(&app->gapp);
    g_free(app->dir);
    g_free(app->name);
    g_free(app->version);
    g_free(app->id);
    g_free(app->startup);
    g_free(app->theme);
    g_clear_pointer(&theme_forced, g_free);
    g_free(app->test_filter);
    g_free(app->entry);
    /* Owns its paths (bta_project_libs builds it with g_free as the element free
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
 * why it is found by name and needs nothing in project.btp -- the same bargain
 * <project>/icons makes.
 *
 * It loads at PRIORITY_APPLICATION: above the desktop's theme, so the sheet has
 * the last word on what the application looks like, and below the per-widget
 * Background/Font (see bta_widget.c), which are the exception to it.  **The
 * runtime's own base sheet loads there first**, same priority and added before,
 * so a rule of the application's own wins whatever its specificity -- which is
 * how a project overrides the few classes the base sheet fixes.
 *
 * A rule GTK cannot parse is reported and the rest of the sheet is kept, which
 * is what CSS does everywhere else and the only behaviour that leaves an
 * unfinished stylesheet usable.
 */
static void on_css_error(GtkCssProvider *provider, GtkCssSection *section,
                         const GError *error, gpointer user_data)
{
    const char *sheet = user_data ? (const char *)user_data : "app.css";
    char       *where = gtk_css_section_to_string(section);
    fprintf(stderr, "bintana: %s: %s: %s\n", sheet, where,
            bta_gerror_text(error));
    g_free(where);
}

/*
 * The runtime's own sheet, out of the binary (`runtime/css/base.css`).
 *
 * It is the part of the look every application shares, and it exists for one
 * job: a class the theme writes for a node a control only keeps *inside*
 * itself -- `flat` on a `ComboBox`, whose face is a button -- reaches that
 * face from here.  The project's sheet is loaded after it and wins; nothing
 * else about the arrangement changes.
 */
static void register_base_styles(GdkDisplay *display)
{
    GtkCssProvider *provider = gtk_css_provider_new();

    g_signal_connect(provider, "parsing-error", G_CALLBACK(on_css_error),
                     (gpointer)"base.css");

    /* `load_from_string` is 4.12 and the floor here is 4.10, where the data
     * call is not yet deprecated; the guard keeps the build silent on both. */
#if GTK_CHECK_VERSION(4, 12, 0)
    gtk_css_provider_load_from_string(provider, bta_base_css);
#else
    G_GNUC_BEGIN_IGNORE_DEPRECATIONS
    gtk_css_provider_load_from_data(provider, bta_base_css, -1);
    G_GNUC_END_IGNORE_DEPRECATIONS
#endif

    gtk_style_context_add_provider_for_display(
        display, GTK_STYLE_PROVIDER(provider),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
    g_object_unref(provider);   /* the display holds it now */
}

static void register_app_styles(BtaApp *app)
{
    GdkDisplay *display = gdk_display_get_default();
    if (!display)
        return;

    register_base_styles(display);

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

    if (bta_sys_pending() + bta_http_pending() + bta_socket_pending() +
        bta_serial_pending() + bta_media_pending() + bta_task_pending() +
        bta_keyring_pending() + bta_network_pending() > 0)
        return G_SOURCE_CONTINUE;

    g_main_loop_quit(app->loop);
    return G_SOURCE_CONTINUE;   /* removed with the source, after the loop */
}

/*
 * The entry a project names was not found as a name.  Whether that is because
 * it lives in a module and was not exported is the likeliest reason the day a
 * project adopts `export`, and the engine's *Main is not defined* says nothing
 * of it -- so the pending error is looked at, reported as it is, and followed
 * by the sentence when it is that one.
 */
static void entry_not_found(JSContext *ctx, const char *name, const char *how)
{
    JSValue     exc     = JS_GetException(ctx);
    JSValue     msg     = JS_GetPropertyStr(ctx, exc, "message");
    const char *text    = JS_IsString(msg) ? JS_ToCString(ctx, msg) : NULL;
    bool        missing = text && g_str_has_suffix(text, "is not defined");

    JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, msg);
    JS_Throw(ctx, exc);
    bta_dump_error(ctx);
    if (missing)
        fprintf(stderr, "bintana: if '%s' is declared in a file that says "
                "`export`, that file keeps it to itself until it is exported "
                "too: `%s %s`\n", name, how, name);
}

/*
 * `bintana test`: the project's `*Test.js` files in `tests/`, each evaluated after the
 * project's own sources, handed to `runTests` in rad.js with the class each
 * file declares -- one per file, named like it, which is the convention that
 * lets this find it without a registry. A file whose class cannot be found is
 * handed over too, as a failure with the reason, so it is a red line and not a
 * smaller total. Answers false when the run could not start at all.
 */
static bool run_tests(BtaApp *app)
{
    JSContext *ctx  = app->ctx;
    char      *dir  = g_build_filename(app->dir, "tests", NULL);
    GPtrArray *files = g_ptr_array_new_with_free_func(g_free);
    GDir      *d    = g_dir_open(dir, 0, NULL);

    if (d) {
        const char *name;
        while ((name = g_dir_read_name(d)))
            if (g_str_has_suffix(name, "Test.js"))
                g_ptr_array_add(files, g_build_filename(dir, name, NULL));
        g_dir_close(d);
    }
    g_ptr_array_sort_values(files, (GCompareFunc)g_strcmp0);
    g_free(dir);

    JSValue found = JS_NewArray(ctx);
    for (guint i = 0; i < files->len; i++) {
        const char *path = files->pdata[i];
        char       *base = g_path_get_basename(path);
        base[strlen(base) - 3] = '\0';                 /* InvoiceTest */

        JSValue t = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, t, "Name", JS_NewString(ctx, base));
        JS_SetPropertyStr(ctx, t, "File", JS_NewString(ctx, path));

        if (bta_eval_file(ctx, path) < 0) {
            JS_SetPropertyStr(ctx, t, "Error",
                              JS_NewString(ctx, "the file did not load; the error is above"));
        } else {
            JSValue klass = bta_lookup_global(ctx, base);
            if (JS_IsException(klass)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                klass = JS_UNDEFINED;
            }
            if (JS_IsFunction(ctx, klass)) {
                JS_SetPropertyStr(ctx, t, "Class", klass);
            } else {
                JS_FreeValue(ctx, klass);
                char *why = g_strdup_printf("the file declares no class %s", base);
                JS_SetPropertyStr(ctx, t, "Error", JS_NewString(ctx, why));
                g_free(why);
            }
        }
        JS_SetPropertyUint32(ctx, found, i, t);
        g_free(base);
    }
    g_ptr_array_free(files, TRUE);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn     = JS_GetPropertyStr(ctx, global, "runTests");
    bool    ok     = JS_IsFunction(ctx, fn);

    if (ok) {
        JSValue argv[3] = {
            found,
            app->test_filter ? JS_NewString(ctx, app->test_filter) : JS_NewString(ctx, ""),
            JS_NewBool(ctx, app->test_json),
        };
        JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 3, (JSValueConst *)argv);
        if (JS_IsException(r)) {
            bta_dump_error(ctx);
            ok = false;
        }
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[1]);
    }
    JS_FreeValue(ctx, found);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    bta_drain_jobs(app->rt);
    return ok;
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
    if (bta_modules_check(ctx) < 0) {
        bta_dump_error(ctx);
        return 1;
    }

    if (app->testing) {
        if (!run_tests(app))
            return 2;
        goto wait;
    }

    JSValue fn = bta_lookup_global(ctx, app->entry);
    if (JS_IsException(fn) || !JS_IsFunction(ctx, fn)) {
        if (JS_IsException(fn))
            entry_not_found(ctx, app->entry, "export function");
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

wait:
    /*
     * A poll and not a signal from each of the three places work can finish:
     * this only decides *when to notice* that there is nothing left, and
     * noticing 20 ms late costs an exit 20 ms later.  It cannot end a program
     * early -- while a callback runs, the loop is not dispatching this.
     */
    if (!app->quitting && bta_sys_pending() + bta_http_pending() +
        bta_socket_pending() + bta_serial_pending() + bta_media_pending() +
        bta_task_pending() + bta_keyring_pending() +
        bta_network_pending() > 0) {
        app->loop  = g_main_loop_new(NULL, FALSE);
        guint tick = g_timeout_add(20, console_idle, app);

        g_main_loop_run(app->loop);

        g_source_remove(tick);
        g_main_loop_unref(app->loop);
        app->loop = NULL;
    }

    /*
     * **A failure that reads as success.** An uncaught error in a callback --
     * a `Timer`, an `Http` answer, a `Task` coming back -- used to print its
     * traceback and leave the status at `0`, which a runner, a build step or
     * CI takes for *it worked*. The run keeps going (the error is reported,
     * not fatal) but the status says it happened. `Application.Quit(code)` is
     * the program saying otherwise, and outranks this.
     */
    if (app->uncaught && !app->quitting)
        return 1;

    return app->exit_code;
}

/*
 * `--text-scale`, `--theme`, `--rtl`: the run made to look another way.
 *
 * All three are **settings of the toolkit, not of the project**, which is why
 * they are command-line options and not project.btp keys: the same form is
 * looked at under each, and what decides is whoever asked.
 *
 * - The text scale multiplies `gtk-xft-dpi`, which is what the desktop's own
 *   *Large Text* does -- so a form is seen exactly as a person with that
 *   setting sees it, labels and all, rather than zoomed as a picture.
 * - The theme is `set_theme`, the same road `Application.Theme` takes, so
 *   `--theme` is only the starting value and a program that assigns one
 *   outranks it. `Widget.Dark` reads the ink that results, so it answers the
 *   variant asked for.
 * - The direction is GTK's default, set before the first widget exists:
 *   boxes mirror and a `Fixed` mirrors its anchors, which is exactly what
 *   looking at it this way is for.
 */
static void apply_look(BtaApp *app)
{
    GtkSettings *settings = gtk_settings_get_default();

    if (settings && app->text_scale > 0) {
        int dpi = 0;
        g_object_get(settings, "gtk-xft-dpi", &dpi, NULL);
        if (dpi <= 0)
            dpi = 96 * 1024;
        g_object_set(settings, "gtk-xft-dpi", (int)(dpi * app->text_scale), NULL);
    }

    if (app->theme)
        set_theme(app->theme);

    if (app->rtl)
        gtk_widget_set_default_direction(GTK_TEXT_DIR_RTL);
}

static void on_activate(GtkApplication *gapp, gpointer user_data)
{
    BtaApp    *app = user_data;
    JSContext *ctx = app->ctx;

    /* A second activation (a single-instance application started again, or
     * the desktop asking for it) raises what is there and builds nothing. */
    if (app->activated) {
        GtkWindow *win = gtk_application_get_active_window(gapp);
        if (win)
            gtk_window_present(win);
        return;
    }
    app->activated = true;

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

    apply_look(app);
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
    /* A name two modules export, used with no import: refused here, before
     * anything starts, rather than at whichever line reaches it first. */
    if (bta_modules_check(ctx) < 0) {
        bta_dump_error(ctx);
        app->exit_code = 1;
        g_application_quit(G_APPLICATION(gapp));
        return;
    }

    /* `bintana test`: no startup form. The application is held, because a run
     * that builds no window would otherwise end the moment this returns;
     * `runTests` ends it with `Application.Quit` once the last test is over. */
    if (app->testing) {
        g_application_hold(G_APPLICATION(gapp));
        if (!run_tests(app)) {
            app->exit_code = 2;
            g_application_quit(G_APPLICATION(gapp));
        }
        return;
    }

    JSValue klass = bta_lookup_global(ctx, app->startup);
    if (JS_IsException(klass) || !JS_IsFunction(ctx, klass)) {
        if (JS_IsException(klass))
            entry_not_found(ctx, app->startup, "export class");
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

/*
 * A second run of a `singleInstance` project, arriving in the first.
 *
 * The second process cannot call into this one, so it activates an action the
 * first exports (`bta-second-instance`, parameter `(sas)`: its working
 * directory and the arguments after the project directory).  This is the
 * receiving end: it tells the program through `Application.OnSecondInstance`
 * -- which is the program's to answer, since opening a file in a new tab and
 * ignoring the run are both legitimate -- and then brings the window forward,
 * which is the one thing every application wants and the one thing a handler
 * could not do before the window was asked for.
 */
static void on_second_instance(GSimpleAction *action, GVariant *param, gpointer data)
{
    BtaApp    *app = data;
    JSContext *ctx = app->ctx;
    const char *cwd  = "";
    const char **argv = NULL;

    if (!app->activated)
        return;     /* the first window is not up: nothing to hand it to */

    g_variant_get(param, "(&s^a&s)", &cwd, &argv);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue jsapp  = JS_GetPropertyStr(ctx, global, "Application");
    JSValue fn     = JS_GetPropertyStr(ctx, jsapp, "OnSecondInstance");

    if (JS_IsFunction(ctx, fn)) {
        JSValue list = JS_NewArray(ctx);
        for (uint32_t i = 0; argv && argv[i]; i++)
            JS_SetPropertyUint32(ctx, list, i, JS_NewString(ctx, argv[i]));
        JSValue av[2] = { list, JS_NewString(ctx, cwd) };
        JSValue r = JS_Call(ctx, fn, jsapp, 2, (JSValueConst *)av);

        if (JS_IsException(r))
            bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, av[0]);
        JS_FreeValue(ctx, av[1]);
        bta_drain_jobs(app->rt);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, jsapp);
    JS_FreeValue(ctx, global);
    g_free(argv);

    GtkWindow *win = gtk_application_get_active_window(app->gapp);
    if (win)
        gtk_window_present(win);
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
                                    app->single ? G_APPLICATION_DEFAULT_FLAGS
                                                : G_APPLICATION_NON_UNIQUE);
    g_signal_connect(app->gapp, "activate", G_CALLBACK(on_activate), app);

    if (app->single) {
        /* Exported before the application registers, which is when the bus
         * learns what it has.  The first instance is the one that registers
         * the id; the others find it there and are *remote*. */
        GSimpleAction *second = g_simple_action_new("bta-second-instance",
                                                    G_VARIANT_TYPE("(sas)"));
        g_signal_connect(second, "activate", G_CALLBACK(on_second_instance), app);
        g_action_map_add_action(G_ACTION_MAP(app->gapp), G_ACTION(second));
        g_object_unref(second);

        /* No session bus is not a fault: GLib then registers locally and this
         * is the only instance there can be, which is what happens anyway. */
        GError *err = NULL;
        if (g_application_register(G_APPLICATION(app->gapp), NULL, &err) &&
            g_application_get_is_remote(G_APPLICATION(app->gapp))) {
            /* **A `GVariant` string is UTF-8 or nothing**: a file name in
             * another encoding (or a directory with one) made `g_variant_new`
             * fail with a critical and the arguments were lost. Each is made
             * valid on the way, the way JavaScript reads it anyway. */
            char         *raw  = g_get_current_dir();
            char         *cwd  = g_utf8_make_valid(raw, -1);
            guint         n    = app->args ? g_strv_length(app->args) : 0;
            char        **args = g_new0(char *, n + 1);

            for (guint i = 0; i < n; i++)
                args[i] = g_utf8_make_valid(app->args[i], -1);
            g_action_group_activate_action(
                G_ACTION_GROUP(app->gapp), "bta-second-instance",
                g_variant_new("(s^as)", cwd, (const char *const *)args));
            g_strfreev(args);
            g_free(cwd);
            g_free(raw);
            /* Fire and forget, so the message has to leave before this
             * process does.  What follows is `g_application_run` as for any
             * application: on a remote it activates the first instance (which
             * raises its window -- `on_activate` builds nothing twice) and
             * returns, and it is the call that unregisters from the bus.
             * Unreffing the application here instead is what GLib warns
             * about: *did not unregister from D-Bus before destruction*. */
            GDBusConnection *bus =
                g_application_get_dbus_connection(G_APPLICATION(app->gapp));
            if (bus)
                g_dbus_connection_flush_sync(bus, NULL, NULL);
        }
        g_clear_error(&err);
    }

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
