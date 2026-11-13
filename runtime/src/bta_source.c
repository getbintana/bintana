/*
 * The questions a host asks about a source text, which every host shares:
 * what it declares (`Application.Symbols`, and `Widget.Members` reading a
 * class's own shape), what it reads that nothing declares
 * (`Application.FreeNames`), and whether it compiles (`Application.CheckSource`).
 *
 * They lived in bta_runtime.c, and the console host and the metadata host each
 * kept a copy. The copies had begun to drift: the core's `CheckSource` did not
 * guard `Error.prepareStackTrace` while it compiled, so a program that set one
 * read a wrong line and column, and the metadata host had a third symbol
 * pass of its own. One file now; the metadata host, which has no module
 * loader, compiles as a script (`bta_symbols_script`) and reports the same.
 */
#include "bta.h"

#include <string.h>

/* The verbs and the module-aware pass need the module loader (bta_module.c),
 * which the metadata host does not link; it has `bta_symbols_script`. */
#ifndef BTA_META_ONLY
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
JSValue bta_application_check_source(JSContext *ctx, JSValueConst this_val,
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

#endif /* !BTA_META_ONLY */

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
 * The pass itself, over a text compiled as `flags` says: the handler is up for
 * this one compile and down after it, and a text that does not compile answers
 * what the parser reached before it stopped.
 */
static JSValue symbols_pass(JSContext *ctx, const char *src, int flags)
{
    SymbolSink sink = { ctx, JS_NewArray(ctx), 0 };
    JSRuntime *rt   = JS_GetRuntime(ctx);

    JS_SetSymbolHandler(rt, symbol_report, &sink);
    JSValue r = JS_Eval(ctx, src, strlen(src), "<symbols>",
                        flags | JS_EVAL_FLAG_COMPILE_ONLY);
    JS_SetSymbolHandler(rt, NULL, NULL);

    /* Compiled and not run, so the only thing it can hand back is an error --
     * and the symbols collected before it are the answer, not the error. */
    if (JS_IsException(r))
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        JS_FreeUnevaluatedModule(ctx, r);
    return sink.list;
}

/* The pass over a text known to be a script, for a host with no module loader:
 * the metadata host, which runs it over the two preludes. */
JSValue bta_symbols_script(JSContext *ctx, const char *src)
{
    return symbols_pass(ctx, src, JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
}

#ifndef BTA_META_ONLY
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
    /* Which of the two the text is, asked first and without the handler: a
     * script compile that fails reports what it read before failing, and a
     * module would then report its declarations twice. */
    bool    is_module;
    bta_modules_checking(ctx, true);
    JSValue probe = bta_compile(ctx, src, strlen(src), "<symbols>", &is_module);
    if (JS_IsException(probe))
        JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeUnevaluatedModule(ctx, probe);     /* fork patch 14, as in CheckSource */

    JSValue out = symbols_pass(ctx, src, is_module
                                         ? JS_EVAL_TYPE_MODULE
                                         : JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    bta_modules_checking(ctx, false);
    return out;
}

JSValue bta_application_symbols(JSContext *ctx, JSValueConst this_val,
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
JSValue bta_application_free_names(JSContext *ctx, JSValueConst this_val,
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

#endif /* !BTA_META_ONLY */
