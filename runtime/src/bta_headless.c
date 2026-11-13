/*
 * The console host, `bintana`: `--version`, `check`, a project's `main` and
 * its tests, with no toolkit in the link. A project that declares `startup`
 * is exec'd as the graphical host (`bintana-gui`) with every word unchanged.
 * See `docs/plans/headless-runtime-plan.md` and
 * `docs/notes/headless-runtime.md`.
 *
 * **The language and the console globals are the graphical host's own
 * files.** The context comes from `bta_new_context` and is finished by
 * `bta_close_hatches` (bta_language.c), and `install_core` installs `File`,
 * `Exec`, `Http`, `Database`, `Task`, `Zip`, `Random`, `Message`, `Desktop`
 * and the rest out of the files `bintana-gui` links -- so a `main` is one
 * program under either binary. What stays out is what needs a display,
 * GStreamer or poppler (`GUI_GLOBALS`), and the drawing half, which is
 * `bintana-drawing.so`, loaded when a project's `uses` names `drawing`.
 *
 * **The widget classes are a document here**, not code: `check` loads the
 * `widgets.json` that `bintana-meta --dump` writes, and a `main` sees no
 * `Widget` at all.
 *
 * **What this file supplies.** `bta_runtime.c` owns the boot of the graphical
 * application; linking it would pull GTK. The few functions the shared files
 * name and a host answers -- the class lookup, the error dump, the file read,
 * the job drain, the application pointer, how a `Message` is shown, what a
 * `Task` worker gets beyond the shared globals -- are defined here.
 */
#include "bta.h"
#include "bta_prelude.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ------------------------------------------------------- the core stubs */

char *bta_read_file(const char *path, size_t *len)
{
    char  *text = NULL;
    gsize  size = 0;

    if (!g_file_get_contents(path, &text, &size, NULL))
        return NULL;
    if (len)
        *len = (size_t)size;
    return text;
}

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

/* The boot's application, for the one caller that asks: `bta_plugin.c` reaches
 * the context through it while a plugin's `init` runs. It is NULL everywhere
 * else, which is the answer the other core code expects. */
static BtaApp *headless_app;

BtaApp *bta_current_app(void)
{
    return headless_app;
}

/* A plugin that will not load must say why, and in the core stderr is where its
 * reader already is. `bta_plugin.c` calls this for every refusal. */
void bta_report_fatal(BtaApp *app, const char *message)
{
    (void)app;
    fprintf(stderr, "bintana: %s\n", message);
}

/* `host->log` from a plugin: the core's Logger is a JS object, and a plugin's
 * Debug line is not worth re-entering it before `rad.js` has run. */
void bta_log_debug(JSContext *ctx, const char *text)
{
    (void)ctx;
    fprintf(stderr, "%s\n", text ? text : "");
}

/* `Http`'s traffic from inside a blocking call, where JS must not run: the
 * same line `Logger.Debug` would print, straight to stderr. */
void bta_log_debug_plain(const char *text)
{
    fprintf(stderr, "Debug: %s\n", text ? text : "");
}

/* A console has no alert to raise; `Message` prints to stderr, as the
 * graphical host does when it has no display. */
bool bta_message_show(int kind, const char *text)
{
    (void)kind; (void)text;
    return false;
}

/* The drawing module's half of a `Task` worker: `Bitmap`, when a project
 * loaded the module (`uses: ["drawing"]`). Set once, before any task can
 * start, and read from worker threads after. */
static bool (*drawing_worker_init)(JSContext *, JSValue);

void bta_task_worker_host(JSContext *ctx, JSValueConst global)
{
    if (drawing_worker_init)
        drawing_worker_init(ctx, global);
}


/* ---------------------------------------------------------- the language */

static bool is_class_path(const char *name)
{
    if (!name || !*name)
        return false;

    char **parts = g_strsplit(name, ".", -1);
    bool   ok    = true;

    for (int i = 0; parts[i]; i++)
        if (!bta_is_identifier(parts[i]))
            ok = false;
    g_strfreev(parts);
    return ok;
}

JSValue bta_lookup_global(JSContext *ctx, const char *name)
{
    if (!is_class_path(name))
        return JS_ThrowTypeError(ctx, "'%s' is not a valid class name", name);

    if (!strchr(name, '.'))
        return JS_Eval(ctx, name, strlen(name), "<class-lookup>",
                       JS_EVAL_TYPE_GLOBAL);

    char  **parts = g_strsplit(name, ".", -1);
    JSValue v     = JS_GetGlobalObject(ctx);

    for (int i = 0; parts[i]; i++) {
        JSValue next = JS_GetPropertyStr(ctx, v, parts[i]);
        JS_FreeValue(ctx, v);
        if (JS_IsException(next)) {
            g_strfreev(parts);
            return next;
        }
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

/* Whether any error was reported. A callback that throws after `main` returned
 * still has to reach the exit status, or a runner reads "it worked" over a
 * traceback -- the failure `run_console` fixes with `app->uncaught`. */
static bool headless_uncaught;

void bta_dump_error(JSContext *ctx)
{
    headless_uncaught = true;

    JSValue     exc = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exc);
    JSValue     st  = JS_IsObject(exc) ? JS_GetPropertyStr(ctx, exc, "stack")
                                       : JS_UNDEFINED;
    const char *stack = JS_IsString(st) ? JS_ToCString(ctx, st) : NULL;

    fprintf(stderr, "%s\n", msg ? msg : "uncaught exception");
    if (stack && *stack)
        fprintf(stderr, "%s\n", stack);

    if (stack) JS_FreeCString(ctx, stack);
    JS_FreeValue(ctx, st);
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, exc);
}

static JSValue js_class_of_name(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "the name lookup needs a name");

    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    JSValue out = bta_lookup_global(ctx, name);
    JS_FreeCString(ctx, name);
    return out;
}

void bta_class_of_name_init(JSContext *ctx, JSValueConst global)
{
    JS_SetPropertyStr(ctx, global, "classOfName",
                      JS_NewCFunction(ctx, js_class_of_name, "classOfName", 1));
}

/* ------------------------------------------------------- the symbol pass */

typedef struct {
    JSContext *ctx;
    JSValue    list;
    uint32_t   count;
} SymbolSink;

static const char *symbol_kind_name(JSSymbolKind kind)
{
    switch (kind) {
    case JS_SYMBOL_CLASS:         return "Class";
    case JS_SYMBOL_METHOD:        return "Method";
    case JS_SYMBOL_FUNCTION:      return "Function";
    case JS_SYMBOL_STATIC:        return "Static";
    case JS_SYMBOL_GETTER:        return "Getter";
    case JS_SYMBOL_SETTER:        return "Setter";
    case JS_SYMBOL_STATIC_GETTER: return "StaticGetter";
    case JS_SYMBOL_STATIC_SETTER: return "StaticSetter";
    case JS_SYMBOL_VARIABLE:      return "Variable";
    case JS_SYMBOL_SCOPE:         return "Scope";
    case JS_SYMBOL_ASSIGNED:      return "Assigned";
    case JS_SYMBOL_EXPORT:        return "Export";
    case JS_SYMBOL_IMPORT:        return "Import";
    case JS_SYMBOL_FIELD:         return "Field";
    }
    return "";
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

    bool module_kind = kind == JS_SYMBOL_EXPORT || kind == JS_SYMBOL_IMPORT;
    JS_SetPropertyStr(ctx, obj, "Super",
                      JS_NewString(ctx, !module_kind && supertype ? supertype : ""));
    JS_SetPropertyStr(ctx, obj, "From",
                      JS_NewString(ctx, module_kind && supertype ? supertype : ""));
    JS_SetPropertyStr(ctx, obj, "Params", JS_NewString(ctx, params ? params : ""));
    JS_SetPropertyStr(ctx, obj, "End", JS_NewInt32(ctx, end_line));

    char *text = NULL, *ret = NULL;
    bta_split_doc(doc, &text, &ret);
    JS_SetPropertyStr(ctx, obj, "Doc", JS_NewString(ctx, text ? text : ""));
    JS_SetPropertyStr(ctx, obj, "Returns", JS_NewString(ctx, ret ? ret : ""));
    g_free(text);
    g_free(ret);

    if (JS_DefinePropertyValueUint32(ctx, sink->list, sink->count, obj,
                                     JS_PROP_C_W_E) < 0)
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        sink->count++;
}

JSValue bta_symbols(JSContext *ctx, const char *src)
{
    SymbolSink sink = { ctx, JS_NewArray(ctx), 0 };
    JSRuntime *rt   = JS_GetRuntime(ctx);
    bool       is_module;

    /* Script first, then module, exactly as the loader decides: the parser's
     * answer is the one that got further into the text. */
    bta_modules_checking(ctx, true);
    JSValue probe = bta_compile(ctx, src, strlen(src), "<symbols>", &is_module);
    if (JS_IsException(probe))
        JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeUnevaluatedModule(ctx, probe);

    JS_SetSymbolHandler(rt, symbol_report, &sink);

    JSValue r = JS_Eval(ctx, src, strlen(src), "<symbols>",
                        (is_module ? JS_EVAL_TYPE_MODULE
                                   : JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT) |
                        JS_EVAL_FLAG_COMPILE_ONLY);

    JS_SetSymbolHandler(rt, NULL, NULL);
    bta_modules_checking(ctx, false);

    if (JS_IsException(r))
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        JS_FreeUnevaluatedModule(ctx, r);

    return sink.list;
}

void bta_prelude_sources(const char **rad, const char **forms)
{
    if (rad)
        *rad = bta_prelude_js;
    /* The widget half is not part of the console host; the metadata document
     * carries its members and their prose. */
    if (forms)
        *forms = "";
}

/* ----------------------------------------------------------- Application */

static JSValue headless_print(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    (void)this_val;
    for (int i = 0; i < argc; i++) {
        const char *text = JS_ToCString(ctx, argv[i]);
        if (!text)
            return JS_EXCEPTION;
        if (i)
            fputc(' ', stdout);
        fputs(text, stdout);
        JS_FreeCString(ctx, text);
    }
    fputc('\n', stdout);
    return JS_UNDEFINED;
}

static JSValue js_application_quit(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    (void)this_val;
    int32_t code = 0;
    if (argc > 0 && JS_ToInt32(ctx, &code, argv[0]))
        code = 1;
    bta_profile_finish();
    exit(code);
    return JS_UNDEFINED;
}

static JSValue js_application_symbols(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    (void)this_val;
    const char *src = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!src)
        return JS_ThrowTypeError(ctx, "Application.Symbols(text) needs text");
    JSValue out = bta_symbols(ctx, src);
    JS_FreeCString(ctx, src);
    return out;
}

/* Where `<check>:LINE:COL` sits in a QuickJS stack. */
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
    int c = 0;
    while (g_ascii_isdigit(*p))
        c = c * 10 + (*p++ - '0');
    *column = c;
}

static JSValue js_application_check_source(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    (void)this_val;
    const char *src = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!src)
        return JS_ThrowTypeError(ctx, "Application.CheckSource(text) needs text");

    /* A text being checked has no file to be relative to, and an `import`
     * must not read the disk: the graphical host sets the same flag around its
     * compile, and a project with `import './SheetParts.js'` was the failure
     * that showed the core had forgotten it. */
    bool is_module;
    bta_modules_checking(ctx, true);
    JSValue r = bta_compile(ctx, src, strlen(src), "<check>", &is_module);
    bta_modules_checking(ctx, false);
    JS_FreeCString(ctx, src);

    if (!JS_IsException(r)) {
        JS_FreeUnevaluatedModule(ctx, r);
        return JS_NULL;
    }
    JS_FreeValue(ctx, r);

    JSValue     err = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, err);
    JSValue     st  = JS_IsObject(err) ? JS_GetPropertyStr(ctx, err, "stack")
                                       : JS_UNDEFINED;
    const char *stack = JS_IsString(st) ? JS_ToCString(ctx, st) : NULL;
    int         line = 0, column = 0;
    check_position(stack, &line, &column);

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Message",
                      JS_NewString(ctx, msg && *msg ? msg : "invalid source"));
    JS_SetPropertyStr(ctx, out, "Line",   JS_NewInt32(ctx, line));
    JS_SetPropertyStr(ctx, out, "Column", JS_NewInt32(ctx, column));

    if (stack) JS_FreeCString(ctx, stack);
    JS_FreeValue(ctx, st);
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, err);
    return out;
}

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

static JSValue js_application_free_names(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    (void)this_val;
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
    JS_FreeUnevaluatedModule(ctx, compiled);
    return sink.list;
}

static JSValue js_application_globals(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;

    JSValue         global = JS_GetGlobalObject(ctx);
    JSPropertyEnum *tab    = NULL;
    uint32_t        len    = 0;
    JSValue         out    = JS_NewArray(ctx);
    uint32_t        n      = 0;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, global, JS_GPN_STRING_MASK) == 0) {
        for (uint32_t i = 0; i < len; i++) {
            const char *name = JS_AtomToCString(ctx, tab[i].atom);
            if (name && *name && !bta_module_exported(ctx, name))
                JS_SetPropertyUint32(ctx, out, n++, JS_NewString(ctx, name));
            if (name) JS_FreeCString(ctx, name);
        }
        JS_FreePropertyEnum(ctx, tab, len);
    }
    JS_FreeValue(ctx, global);
    return out;
}

static JSValue js_application_library_path(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    (void)this_val;
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *project = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;
    if (!name) {
        if (project) JS_FreeCString(ctx, project);
        return JS_ThrowTypeError(ctx, "Application.LibraryPath(name) needs a name");
    }

    char  *found = bta_library_resolve(project, name, NULL);
    JSValue out  = JS_NewString(ctx, found ? found : "");

    g_free(found);
    JS_FreeCString(ctx, name);
    if (project) JS_FreeCString(ctx, project);
    return out;
}

static JSValue js_application_libraries(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    /* The other direction of the lookup is a dialogue's business; the check
     * asks for one name at a time. */
    return JS_NewArray(ctx);
}

/* `Application.HasCommand(name)`: the core half of the graphical answer, and
 * the reason a console tool can ask before `Exec` throws. A name with a
 * separator is a file to look at; a bare one is the PATH's. */
static JSValue js_application_has_command(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    (void)this_val;
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

static void install_application(JSContext *ctx, JSValueConst global,
                                const char *directory, const char *name,
                                const char *version, char **args, int nargs)
{
    JSValue application = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, application, "Directory",
                      JS_NewString(ctx, directory ? directory : ""));
    JS_SetPropertyStr(ctx, application, "Name",
                      JS_NewString(ctx, name ? name : ""));
    JS_SetPropertyStr(ctx, application, "Version",
                      JS_NewString(ctx, version ? version : ""));

    char *config = g_build_filename(g_get_user_config_dir(), "bintana",
                                    name && *name ? name : "console", NULL);
    g_mkdir_with_parents(config, 0700);
    JS_SetPropertyStr(ctx, application, "ConfigDirectory", JS_NewString(ctx, config));
    g_free(config);

    char *exe = bta_exe_path();
    JS_SetPropertyStr(ctx, application, "Executable",
                      JS_NewString(ctx, exe ? exe : "bintana"));
    g_free(exe);

    JSValue arguments = JS_NewArray(ctx);
    for (int i = 0; i < nargs; i++)
        JS_SetPropertyUint32(ctx, arguments, i, JS_NewString(ctx, args[i]));
    JS_SetPropertyStr(ctx, application, "Arguments", arguments);

    JS_SetPropertyStr(ctx, application, "Quit",
                      JS_NewCFunction(ctx, js_application_quit, "Quit", 1));
    JS_SetPropertyStr(ctx, application, "Symbols",
                      JS_NewCFunction(ctx, js_application_symbols, "Symbols", 1));
    JS_SetPropertyStr(ctx, application, "CheckSource",
                      JS_NewCFunction(ctx, js_application_check_source,
                                      "CheckSource", 1));
    JS_SetPropertyStr(ctx, application, "FreeNames",
                      JS_NewCFunction(ctx, js_application_free_names,
                                      "FreeNames", 1));
    JS_SetPropertyStr(ctx, application, "Globals",
                      JS_NewCFunction(ctx, js_application_globals, "Globals", 0));
    JS_SetPropertyStr(ctx, application, "LibraryPath",
                      JS_NewCFunction(ctx, js_application_library_path,
                                      "LibraryPath", 2));
    JS_SetPropertyStr(ctx, application, "Libraries",
                      JS_NewCFunction(ctx, js_application_libraries,
                                      "Libraries", 1));
    JS_SetPropertyStr(ctx, application, "HasCommand",
                      JS_NewCFunction(ctx, js_application_has_command,
                                      "HasCommand", 1));
    JS_SetPropertyStr(ctx, application, "Replacements",
                      JS_NewCFunction(ctx, bta_application_replacements,
                                      "Replacements", 0));

    JS_SetPropertyStr(ctx, global, "Application", application);
}

static bool eval_script(JSContext *ctx, const char *text, size_t len,
                        const char *name)
{
    JSValue r = JS_Eval(ctx, text, len, name,
                        JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        return false;
    }
    JS_FreeValue(ctx, r);
    return true;
}

/* The identifier a `ReferenceError` is about, or NULL. The engine's message is
 * `"<name> is not defined"`, and a name the language took away carries a hint
 * after it (bta_language.c), so the name is what stands before the first
 * " is not defined". Freed by the caller. */
static char *reference_error_name(JSContext *ctx, JSValueConst exc)
{
    if (!JS_IsError(exc))
        return NULL;

    JSValue     kind_v = JS_GetPropertyStr(ctx, exc, "name");
    JSValue     text_v = JS_GetPropertyStr(ctx, exc, "message");
    const char *kind   = JS_ToCString(ctx, kind_v);
    const char *text   = JS_ToCString(ctx, text_v);
    char       *name   = NULL;

    if (!kind || !text)
        JS_FreeValue(ctx, JS_GetException(ctx));
    if (kind && text && !strcmp(kind, "ReferenceError")) {
        const char *end = strstr(text, " is not defined");
        if (end && end > text)
            name = g_strndup(text, (gsize)(end - text));
    }
    JS_FreeCString(ctx, kind);
    JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, kind_v);
    JS_FreeValue(ctx, text_v);
    return name;
}

/* A library whose JavaScript defines a widget class fails on the missing
 * toolkit name. The sentence names the library and the display, which is the
 * refusal the plan asks for, instead of a `ReferenceError` three files in.
 *
 * **The name is compared whole.** It used to be found anywhere in the
 * message, so `FormatRow is not defined` -- a typo in a console library --
 * was reported as a library that needs a display, and the real error was
 * never printed. */
static bool library_needs_display(JSContext *ctx, const char *library)
{
    static const char *const NAMES[] = {
        "Component", "Widget", "Control", "Container", "Form",
        "DrawingArea", "TextEditor", "SourceEditor",
    };

    JSValue  exc  = JS_GetException(ctx);
    char    *name = reference_error_name(ctx, exc);
    bool     ui   = false;

    if (name)
        for (size_t i = 0; i < G_N_ELEMENTS(NAMES); i++)
            if (!strcmp(name, NAMES[i])) {
                ui = true;
                break;
            }
    g_free(name);

    if (ui)
        fprintf(stderr, "bintana: library \"%s\" needs the graphical host: "
                        "a project with \"main\" has no display. Run it with "
                        "bintana-gui.\n", library);
    else
        JS_Throw(ctx, exc);        /* restore it for the normal dump */

    if (ui)
        JS_FreeValue(ctx, exc);
    return ui;
}

/* A file of the project or of a library, through the loader both hosts share
 * (bta_module.c). Only the report is this host's: a library that reaches for a
 * widget gets the display sentence instead of the engine's error. */
static bool eval_file_at(JSContext *ctx, const char *path, const char *library)
{
    if (bta_eval_file_keep(ctx, path) == 0)
        return true;
    if (JS_HasException(ctx) &&
        !(library && library_needs_display(ctx, library)))
        bta_dump_error(ctx);
    return false;
}

static bool eval_file(JSContext *ctx, const char *path)
{
    return eval_file_at(ctx, path, NULL);
}

/* `Widget` and the metadata rows, before rad.js: rad.js's `FormPart` and the
 * forms.js mixins chain onto the class prototypes. */
/*
 * The names the graphical host installs and this one does not.
 *
 * `lib/check` asks `Application.Globals()` what a program may write. A project
 * that names `Printer` must not be told the name does not exist because the
 * console host has no window: the names are the same surface, and the verb
 * behind one is what refuses. Empty objects are enough for the name pass;
 * Phase 3 replaces each with the sentence its call refuses with.
 *
 * **Only what needs a display, GStreamer or poppler is here.** `Http`,
 * `Database`, `Task`, `Zip`, `Random`, `Desktop` and the rest of what a
 * console program is written with are the real ones (`install_core`), the
 * same files the graphical host links.
 */
static const char *const GUI_GLOBALS[] = {
    "Dialog", "Screen", "Clipboard", "Printer", "Tray", "Notification",
    "Popover", "Probe", "Media", "AudioPlayer", "Video",
    /* The drawing and document globals. The check reads names, so a project
     * that draws a chart must not be told `Painter` does not exist because
     * this host has no cairo surface to hand it; the drawing module replaces
     * them when a project names `drawing`. */
    "Bitmap", "Drawing", "Painter", "PdfDocument",
};

/* The one `Text` answer `lib/check` reads: the UTF-16 index to its 1-based
 * line, over the same bridge `bta_text.c` gives an editor. The measuring half
 * needs Pango and a font map, and a console check has no line to underline. */
static JSValue headless_text_line_of(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Text.LineOf(text, index) needs the text "
                                      "and an index");

    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text)
        return JS_EXCEPTION;

    int32_t index = 0;
    if (JS_ToInt32(ctx, &index, argv[1])) {
        JS_FreeCString(ctx, text);
        return JS_EXCEPTION;
    }

    int line = bta_line_of_utf16(text, index);
    JS_FreeCString(ctx, text);
    return JS_NewInt32(ctx, line);
}

static JSValue headless_strict_seal(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_UNDEFINED;
}

void bta_strict_init(JSContext *ctx, JSValueConst global)
{
    JS_SetPropertyStr(ctx, global, "strictSeal",
                      JS_NewCFunction(ctx, headless_strict_seal, "strictSeal", 1));
}

static JSValue headless_log(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic)
{
    (void)this_val;
    static const char *const levels[] = { "Debug", "Info", "Warning", "Error" };

    if (magic >= 0 && magic < 4)
        fprintf(stderr, "%s: ", levels[magic]);
    for (int i = 0; i < argc; i++) {
        const char *text = JS_ToCString(ctx, argv[i]);
        if (!text)
            return JS_EXCEPTION;
        if (i)
            fputc(' ', stderr);
        fputs(text, stderr);
        JS_FreeCString(ctx, text);
    }
    fputc('\n', stderr);
    return JS_UNDEFINED;
}

static JSValue headless_needs_drawing(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowTypeError(ctx, "this needs drawing, and the project does "
                                  "not use it: add \"uses\": [\"drawing\"] "
                                  "to project.btp");
}

static void stub_function(JSContext *ctx, JSValue obj, const char *name,
                          int length)
{
    JS_SetPropertyStr(ctx, obj, name,
                      JS_NewCFunction(ctx, headless_needs_drawing, name, length));
}

/* `Drawing` and `Bitmap` before the module loads: the names are there for the
 * check, and calling one says what to add, not "not a function". */
static JSValue headless_drawing_stub(JSContext *ctx)
{
    JSValue out = JS_NewObject(ctx);

    stub_function(ctx, out, "Save", 4);
    stub_function(ctx, out, "ToPng", 3);
    stub_function(ctx, out, "SavePdf", 5);
    return out;
}

static JSValue headless_bitmap_stub(JSContext *ctx)
{
    JSValue out = JS_NewObject(ctx);

    stub_function(ctx, out, "Load", 1);
    stub_function(ctx, out, "FromBytes", 1);
    return out;
}

static void install_gui_stubs(JSContext *ctx, JSValueConst global)
{
    for (size_t i = 0; i < G_N_ELEMENTS(GUI_GLOBALS); i++) {
        JSValue existing = JS_GetPropertyStr(ctx, global, GUI_GLOBALS[i]);
        bool    present  = !JS_IsUndefined(existing) && !JS_IsException(existing);

        if (JS_IsException(existing))
            JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, existing);
        if (present)
            continue;

        /* The rest are names a check reads, not objects a program uses. */
        if (!strcmp(GUI_GLOBALS[i], "Drawing")) {
            JS_SetPropertyStr(ctx, global, GUI_GLOBALS[i],
                              headless_drawing_stub(ctx));
        } else if (!strcmp(GUI_GLOBALS[i], "Bitmap")) {
            JS_SetPropertyStr(ctx, global, GUI_GLOBALS[i],
                              headless_bitmap_stub(ctx));
        } else {
            JS_SetPropertyStr(ctx, global, GUI_GLOBALS[i], JS_NewObject(ctx));
        }
    }
}

static bool install_core(JSContext *ctx, JSValueConst global,
                         const char *project, GPtrArray *libs)
{
    bta_profile_init(ctx, global);
    bta_sys_init(ctx, global);

    JSValue logger = JS_NewObject(ctx);
    static const char *const levels[] = { "Debug", "Info", "Warning", "Error" };
    for (int i = 0; i < 4; i++)
        JS_SetPropertyStr(ctx, logger, levels[i],
                          JS_NewCFunctionMagic(ctx, headless_log, levels[i], 1,
                                               JS_CFUNC_generic_magic, i));
    JS_SetPropertyStr(ctx, global, "Logger", logger);
    bta_message_init(ctx, global);
    bta_bytes_init(ctx, global);
    bta_decimal_init(ctx, global);
    bta_day_init(ctx, global);

    /* What a console program is written with, in the graphical host's order
     * and out of the same files: none of them names the toolkit. An optional
     * library that is missing (sqlite, libsoup, GnuTLS, libsecret, unixODBC)
     * leaves its global in place, refusing with the package's name -- the
     * same bargain the graphical host makes. */
    bta_database_init(ctx, global);
    bta_sqlite_init(ctx, global);
    bta_odbc_init(ctx, global);
    bta_http_init(ctx, global);
    bta_socket_init(ctx, global);
    bta_serial_init(ctx, global);
    bta_cancellable_init(ctx, global);
    bta_task_init(ctx, global);
    bta_lock_init(ctx, global);
    bta_random_init(ctx, global);
    bta_gzip_init(ctx, global);
    bta_cipher_init(ctx, global);
    bta_zip_init(ctx, global);
    bta_key_init(ctx, global);
    bta_xml_init(ctx, global);
    bta_keyring_init(ctx, global);
    bta_desktop_init(ctx, global);
    bta_network_init(ctx, global);

    /* The drawing module adds Width, Height, Bounds and the rest to this
     * object when a project runs; `LineOf` is the one editor answer `check`
     * needs and it never loads the module. */
    JSValue text = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, text, "LineOf",
                      JS_NewCFunction(ctx, headless_text_line_of, "LineOf", 2));
    JS_SetPropertyStr(ctx, global, "Text", text);
    bta_locale_init(ctx, global, project, libs);

    bta_record_init(ctx, global, project, libs);
    bta_class_of_name_init(ctx, global);
    bta_strict_init(ctx, global);
    install_gui_stubs(ctx, global);
    return true;
}

static bool load_prelude(JSContext *ctx)
{
    /* The language only. `forms.js` is the widget half, and the console host
     * does not have widgets until `check` loads the metadata document. */
    return eval_script(ctx, bta_prelude_js, strlen(bta_prelude_js), "<rad.js>");
}

/* --------------------------------------------------------------- the CLI */

static char *find_check_project(void)
{
    GPtrArray *tried = g_ptr_array_new_with_free_func(g_free);
    char      *exe   = bta_exe_path();

    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);
        g_ptr_array_add(tried, g_build_filename(up, "tools", "check", NULL));
        g_ptr_array_add(tried, g_build_filename(up, "share", "bintana",
                                                "tools", "check", NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(tried, g_build_filename("/usr", "share", "bintana",
                                            "tools", "check", NULL));

    char *found = NULL;
    for (guint i = 0; i < tried->len && !found; i++) {
        char *main = g_build_filename(tried->pdata[i], "Main.js", NULL);
        if (g_file_test(main, G_FILE_TEST_IS_REGULAR))
            found = g_strdup(tried->pdata[i]);
        g_free(main);
    }
    g_ptr_array_unref(tried);
    return found;
}

typedef struct {
    char *meta;
    char *data;
} CheckData;

static CheckData find_check_data(void)
{
    CheckData out = { NULL, NULL };
    GPtrArray *dirs = g_ptr_array_new_with_free_func(g_free);
    char      *exe  = bta_exe_path();

    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);
        g_ptr_array_add(dirs, g_build_filename(bin, "check", NULL));
        g_ptr_array_add(dirs, g_build_filename(up, "share", "bintana",
                                               "check", NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(dirs, g_build_filename("/usr", "share", "bintana",
                                           "check", NULL));

    for (guint i = 0; i < dirs->len && !out.meta; i++) {
        char *meta = g_build_filename(dirs->pdata[i], "WidgetMeta.js", NULL);
        char *data = g_build_filename(dirs->pdata[i], "widgets.json", NULL);

        if (g_file_test(meta, G_FILE_TEST_IS_REGULAR) &&
            g_file_test(data, G_FILE_TEST_IS_REGULAR)) {
            out.meta = meta;
            out.data = data;
        } else {
            g_free(meta);
            g_free(data);
        }
    }
    g_ptr_array_unref(dirs);
    return out;
}

/* Defined below, beside the console loop; `check` lets go the same way. */
static void core_cleanup(void);

static int run_check(int argc, char **argv)
{
    if (argc < 1) {
        fprintf(stderr, "usage: bintana check [options] <project>\n");
        return 2;
    }

    char *tools = find_check_project();
    if (!tools) {
        fprintf(stderr, "bintana: tools/check is not beside the binary\n");
        return 2;
    }

    GString *tried   = g_string_new(NULL);
    char    *library = bta_library_resolve(tools, "check", tried);
    if (!library) {
        fprintf(stderr, "bintana: lib/check is not in any of:%s\n",
                tried->str);
        g_string_free(tried, TRUE);
        g_free(tools);
        return 2;
    }
    g_string_free(tried, TRUE);

    /* The options may come before the target, so they travel as they were
     * written: `tools/check` is the parser, and `File.Absolute` resolves the
     * target against the working directory the person ran the command in. */
    GPtrArray *libs = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(libs, g_strdup(library));

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 2;
    }
    JS_SetMaxStackSize(rt, 2 * 1024 * 1024);

    JSContext *ctx = bta_new_context(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 2;
    }

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, headless_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "BTA_VERSION",
                      JS_NewString(ctx, BTA_VERSION_STRING));
    install_application(ctx, global, tools, "check", "1.0", argv, argc);
    install_core(ctx, global, tools, libs);
    JS_FreeValue(ctx, global);

    if (!load_prelude(ctx)) {
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 1;
    }

    /*
     * The widget metadata is a document, not a linked toolkit. It is loaded
     * here -- only for `check` -- and the class names it installs are what
     * `lib/check` and `Application.Globals` read.
     */
    CheckData data = find_check_data();
    if (!data.meta) {
        fprintf(stderr, "bintana: the check metadata is not installed "
                        "(WidgetMeta.js and widgets.json)\n");
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 2;
    }

    JSValue meta_global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, meta_global, "WidgetDataPath",
                      JS_NewString(ctx, data.data));
    JS_FreeValue(ctx, meta_global);
    bool meta_ok = eval_file(ctx, data.meta);
    meta_global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, meta_global, "WidgetDataPath", JS_UNDEFINED);
    JS_FreeValue(ctx, meta_global);
    g_free(data.meta);
    g_free(data.data);
    if (!meta_ok) {
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 1;
    }

    /* The metadata is this host's `forms.js`, and the hatches close after it
     * exactly as they do after the graphical host's prelude. */
    bta_close_hatches(ctx);

    /* After the prelude and the metadata, and before the program's modules:
     * the runtime names `Application.FreeNames` leaves out are photographed
     * here -- `Regex`, `Dictionary`, `Widget` and the class names. */
    bta_modules_scope(ctx, tools, libs);

    GPtrArray *files = bta_library_sources(ctx, library);
    bool       ok    = true;

    for (guint i = 0; i < files->len && ok; i++)
        ok = eval_file(ctx, files->pdata[i]);
    g_ptr_array_unref(files);

    char *main_js = g_build_filename(tools, "Main.js", NULL);
    if (ok)
        ok = eval_file(ctx, main_js);
    g_free(main_js);

    if (ok) {
        JSValue main = bta_lookup_global(ctx, "main");
        if (JS_IsException(main)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            fprintf(stderr, "bintana: tools/check declares no main\n");
            ok = false;
        } else if (!JS_IsFunction(ctx, main)) {
            fprintf(stderr, "bintana: 'main' is not a function\n");
            ok = false;
        } else {
            JSValue r = JS_Call(ctx, main, JS_UNDEFINED, 0, NULL);
            if (JS_IsException(r)) {
                bta_dump_error(ctx);
                ok = false;
            }
            JS_FreeValue(ctx, r);
            bta_drain_jobs(rt);
        }
        JS_FreeValue(ctx, main);
    }

    core_cleanup();
    bta_modules_forget(ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    g_ptr_array_unref(libs);
    g_free(tools); g_free(library);
    return ok && !headless_uncaught ? 0 : 1;
}

/* --------------------------------------------------------- drawing module */

/* The `.so` that carries cairo, Pango and GdkPixbuf. It is found beside the
 * binary in the build tree, or under the installed `lib` directory. A missing module
 * is not an error: `Drawing` stays the stub the check reads, and a project that
 * needs it says so when it uses it. A module that is there but cannot load, or
 * speaks another ABI, is an error. */
static bool load_drawing_module(JSContext *ctx, JSValue global, bool required)
{
    GPtrArray *tried = g_ptr_array_new_with_free_func(g_free);
    char      *exe   = bta_exe_path();

    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);

        g_ptr_array_add(tried, g_build_filename(bin, "bintana-drawing." G_MODULE_SUFFIX, NULL));
        g_ptr_array_add(tried, g_build_filename(up, "lib", "bintana",
                                                "bintana-drawing." G_MODULE_SUFFIX, NULL));
        g_ptr_array_add(tried, g_build_filename(up, "lib64", "bintana",
                                                "bintana-drawing." G_MODULE_SUFFIX, NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(tried, g_build_filename("/usr", "lib", "bintana",
                                            "bintana-drawing." G_MODULE_SUFFIX, NULL));

    char *path = NULL;
    for (guint i = 0; i < tried->len && !path; i++)
        if (g_file_test(tried->pdata[i], G_FILE_TEST_IS_REGULAR))
            path = g_strdup(tried->pdata[i]);
    g_ptr_array_unref(tried);

    if (!path) {
        if (required)
            fprintf(stderr, "bintana: this project uses \"drawing\", but "
                            "bintana-drawing.%s is not installed\n", G_MODULE_SUFFIX);
        return !required;
    }

    GModule *m = g_module_open(path, G_MODULE_BIND_LOCAL);
    if (!m) {
        fprintf(stderr, "bintana: the drawing module %s did not load: %s\n",
                path, g_module_error() ?: "unknown");
        g_free(path);
        return false;
    }

    typedef int  (*abi_fn)(void);
    typedef bool (*init_fn)(JSContext *, JSValue);
    gpointer abi_sym = NULL, init_sym = NULL;

    if (!g_module_symbol(m, "bta_drawing_module_abi", &abi_sym) ||
        !g_module_symbol(m, "bta_drawing_module_init", &init_sym) ||
        !abi_sym || !init_sym) {
        fprintf(stderr, "bintana: %s is not a drawing module\n", path);
        g_module_close(m);
        g_free(path);
        return false;
    }
    int abi = ((abi_fn)abi_sym)();
    if (abi != 1) {
        fprintf(stderr, "bintana: %s speaks drawing ABI %d, this runtime 1 -- "
                        "rebuild it with this runtime\n", path, abi);
        g_module_close(m);
        g_free(path);
        return false;
    }
    if (!((init_fn)init_sym)(ctx, global)) {
        fprintf(stderr, "bintana: %s refused to install itself\n", path);
        g_module_close(m);
        g_free(path);
        return false;
    }

    /* A `Task` worker gets `Bitmap` from the same module. Set before any
     * task can start, and the module is never closed, so a worker thread
     * reading the pointer later sees it. */
    gpointer worker_sym = NULL;
    if (g_module_symbol(m, "bta_drawing_module_worker_init", &worker_sym))
        drawing_worker_init = (init_fn)worker_sym;

    g_free(path);
    return true;
}

/* What is still owed an answer: the same sum `run_console` adds up in the
 * graphical host, minus `Media`, which this host does not link. A `main` that
 * starts an `Http` request, a `Task` or a `Network.Reach` must not exit before
 * the answer arrives and its callback runs. */
static int core_pending(void)
{
    return bta_sys_pending() + bta_http_pending() + bta_socket_pending() +
           bta_serial_pending() + bta_task_pending() + bta_keyring_pending() +
           bta_network_pending();
}

/* The services this host links, let go before the context, in the graphical
 * host's order: workers first, since they hold values of this context and run
 * on their own threads. */
static void core_cleanup(void)
{
    bta_task_cleanup();
    bta_sys_cleanup();
    bta_http_cleanup();
    bta_keyring_cleanup();
    bta_network_cleanup();
    bta_socket_cleanup();
    bta_serial_cleanup();
}

/* The console loop's own tick: stop once the services that answer later have
 * nothing left. **It never removes itself**: the caller removes the source
 * after the loop returns, and a source that had already gone was a
 * `GLib-CRITICAL` on every run that waited -- the same reason `console_idle`
 * in the graphical host answers CONTINUE. */
static gboolean project_idle(gpointer data)
{
    GMainLoop *loop = data;

    if (core_pending() > 0)
        return G_SOURCE_CONTINUE;

    g_main_loop_quit(loop);
    return G_SOURCE_CONTINUE;
}

/*
 * `bintana test`'s own half, for a project whose tests need no window: the
 * files the graphical host's `run_tests` reads, and `runTests` from rad.js.
 * The test classes are the project's, loaded after its sources, exactly as in
 * the graphical host.
 */
static bool run_tests_here(JSContext *ctx, const char *dir,
                           const char *filter, bool json)
{
    char      *where = g_build_filename(dir, "tests", NULL);
    GPtrArray *files = g_ptr_array_new_with_free_func(g_free);
    GDir      *d     = g_dir_open(where, 0, NULL);

    if (d) {
        const char *entry;
        while ((entry = g_dir_read_name(d)))
            if (g_str_has_suffix(entry, "Test.js"))
                g_ptr_array_add(files, g_build_filename(where, entry, NULL));
        g_dir_close(d);
    }
    g_ptr_array_sort_values(files, (GCompareFunc)g_strcmp0);
    g_free(where);

    JSValue found = JS_NewArray(ctx);

    for (guint i = 0; i < files->len; i++) {
        const char *path = files->pdata[i];
        char       *base = g_path_get_basename(path);

        base[strlen(base) - 3] = '\0';              /* QuoteTest.js -> QuoteTest */

        JSValue t = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, t, "Name", JS_NewString(ctx, base));
        JS_SetPropertyStr(ctx, t, "File", JS_NewString(ctx, path));

        if (!eval_file(ctx, path)) {
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

    bool ok = JS_IsFunction(ctx, fn);
    if (ok) {
        JSValue argv[3] = {
            found,
            JS_NewString(ctx, filter ? filter : ""),
            JS_NewBool(ctx, json),
        };
        JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 3, (JSValueConst *)argv);

        if (JS_IsException(r)) {
            bta_dump_error(ctx);
            ok = false;
        }
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[1]);
    } else {
        fprintf(stderr, "bintana: runTests is not in the language\n");
    }
    JS_FreeValue(ctx, found);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    bta_drain_jobs(JS_GetRuntime(ctx));
    return ok;
}

/*
 * `bintana [run] <project> [args...]`: the project's own `main`, or its tests.
 *
 * A project that declares `startup` is dispatched before this is reached; the
 * refusal below is the fallback for a manifest that could not be read as one
 * or the other, and it names the form instead of failing later with a
 * `ReferenceError` about a widget.
 *
 * The classes are the core's. `Widget` is not installed for a `main` -- a
 * console project that asks for a control does not get a stub that pretends;
 * it gets the language's own "not defined", which is the truth about this
 * binary.
 */
static int run_project(int argc, char **argv, bool testing, bool json,
                       const char *filter)
{
    if (argc < 1) {
        fprintf(stderr, "usage: bintana [run] <project> [args...]\n");
        return 2;
    }

    char   *dir      = bta_project_dir(argv[0]);
    char   *manifest = bta_project_manifest(dir);
    size_t  len      = 0;
    char   *text     = bta_read_file(manifest, &len);

    if (!text) {
        fprintf(stderr, "bintana: no project.btp in %s\n", dir);
        g_free(manifest);
        g_free(dir);
        return 2;
    }

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        g_free(text); g_free(manifest); g_free(dir);
        return 2;
    }
    JS_SetMaxStackSize(rt, 2 * 1024 * 1024);

    JSContext *ctx = bta_new_context(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        g_free(text); g_free(manifest); g_free(dir);
        return 2;
    }

    int      status = 1;
    BtaApp   app    = { 0 };
    JSValue  global = JS_GetGlobalObject(ctx);
    JSValue  cfg    = JS_UNDEFINED;
    JSValue  entry  = JS_UNDEFINED;
    GPtrArray *libs = NULL, *sources = NULL;
    char    *name = NULL, *version = NULL, *startup = NULL, *entry_name = NULL;

    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, headless_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "BTA_VERSION",
                      JS_NewString(ctx, BTA_VERSION_STRING));

    cfg = JS_ParseJSON(ctx, text, len, manifest);
    if (JS_IsException(cfg)) {
        bta_dump_error(ctx);
        goto out;
    }

    char *base    = g_path_get_basename(dir);
    name          = bta_project_string(ctx, cfg, "name", base);
    version       = bta_project_string(ctx, cfg, "version", "");
    startup       = bta_project_string(ctx, cfg, "startup", "Form1");
    entry_name    = bta_project_string(ctx, cfg, "main", NULL);
    g_free(base);

    if (!entry_name && !testing) {
        fprintf(stderr,
                "bintana: '%s' opens a window (startup '%s'); this "
                "host has no display. Run it with bintana-gui.\n",
                name, startup);
        status = 2;
        goto out;
    }

    /* The words after the project are the program's, as `Application.Arguments`
     * describes them in the graphical runtime. */
    install_application(ctx, global, dir, name, version, argv + 1, argc - 1);
    libs    = bta_project_libs(ctx, dir, cfg);
    sources = bta_project_sources(ctx, dir, NULL, cfg);
    install_core(ctx, global, dir, libs);

    /* The module is what `uses: ["drawing"]` buys -- directly or through a
     * library's own `uses`. A `main` that never names it never maps cairo,
     * Pango or GdkPixbuf. */
    bool needs_drawing = false;
    for (guint i = 0; i < libs->len && !needs_drawing; i++) {
        char *base = g_path_get_basename(libs->pdata[i]);

        needs_drawing = !strcmp(base, "drawing");
        g_free(base);
    }
    if (needs_drawing && !load_drawing_module(ctx, global, true)) {
        status = 2;
        goto out;
    }

    /* A library's native half loads before `rad.js` and before the project's
     * own sources, which is the contract `bta_plugin.h` states: `init` sees
     * `Application` but not `Dictionary`. */
    app.ctx     = ctx;
    app.dir     = dir;
    app.name    = name;
    app.version = version;
    app.libs    = libs;
    /* NULL-terminated, as `BtaApp.args` is: a `Task` hands the worker the
     * same `Application.Arguments` the main thread has. The strings are
     * argv's; only the array is ours. */
    app.args    = g_new0(char *, argc > 0 ? argc : 1);
    for (int i = 1; i < argc; i++)
        app.args[i - 1] = argv[i];
    headless_app = &app;
    if (!bta_plugins_load(&app, ctx, global)) {
        status = 2;
        goto out;
    }

    if (!load_prelude(ctx))
        goto out;

    /* Last, and only after rad.js: it captured what it needs. The same
     * closing the graphical host makes, so a `main` is one language in both. */
    bta_close_hatches(ctx);

    /* `--debug` was set before the project was read; it installs the protocol
     * only when somebody asked. Descriptor 3 and stdin arrive from the IDE
     * untouched, the same way the graphical host's console branch gets them. */
    bta_debug_start(ctx);

    bta_modules_scope(ctx, dir, libs);

    /* A library's sources first, with its name at hand: a library that wants
     * a widget gets the display sentence rather than the engine's
     * `Component is not defined` at the class line. Then the project's own. */
    for (guint i = 0; i < libs->len; i++) {
        const char *lib   = libs->pdata[i];
        char       *base  = g_path_get_basename(lib);
        GPtrArray  *files = bta_library_sources(ctx, lib);

        for (guint j = 0; j < files->len; j++)
            if (!eval_file_at(ctx, files->pdata[j], base)) {
                g_ptr_array_unref(files);
                g_free(base);
                goto out;
            }
        g_ptr_array_unref(files);
        g_free(base);
    }

    for (guint i = 0; i < sources->len; i++)
        if (!eval_file(ctx, sources->pdata[i]))
            goto out;

    if (bta_modules_check(ctx) < 0) {
        bta_dump_error(ctx);
        goto out;
    }

    if (testing) {
        if (!run_tests_here(ctx, dir, filter, json)) {
            status = 2;
            goto out;
        }
        /* `runTests` schedules the next test with `Timer.After(0, ...)` and
         * ends with `Application.Quit`, so the loop is what lets a test run at
         * all; a run that reaches `Quit` never comes back here. */
        if (core_pending() > 0) {
            GMainLoop *loop = g_main_loop_new(NULL, FALSE);
            guint tick = g_timeout_add(20, project_idle, loop);

            g_main_loop_run(loop);
            g_source_remove(tick);
            g_main_loop_unref(loop);
        }
        status = headless_uncaught ? 1 : 0;
        goto out;
    }

    entry = bta_lookup_global(ctx, entry_name);
    if (JS_IsException(entry)) {
        bta_dump_error(ctx);
        goto out;
    }
    if (!JS_IsFunction(ctx, entry)) {
        fprintf(stderr, "bintana: main function '%s' not found\n",
                entry_name);
        goto out;
    }

    JSValue r = JS_Call(ctx, entry, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        goto out;
    }
    JS_FreeValue(ctx, r);
    bta_drain_jobs(rt);

    if (core_pending() > 0) {
        GMainLoop *loop = g_main_loop_new(NULL, FALSE);

        guint tick = g_timeout_add(20, project_idle, loop);
        g_main_loop_run(loop);
        g_source_remove(tick);
        g_main_loop_unref(loop);
    }
    status = headless_uncaught ? 1 : 0;

out:
    /* Before anything they could touch goes: a worker holds values of this
     * context, and an `Http` answer still queued holds its callback. */
    core_cleanup();
    if (libs)    g_ptr_array_unref(libs);
    if (sources) g_ptr_array_unref(sources);
    g_free(name);
    g_free(version);
    g_free(startup);
    g_free(entry_name);
    JS_FreeValue(ctx, entry);
    JS_FreeValue(ctx, cfg);
    JS_FreeValue(ctx, global);
    bta_modules_forget(ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    /* The contract says a plugin's cleanup runs after the context is gone and
     * must not call the host; the loader's list is C only. */
    bta_plugins_cleanup(&app);
    headless_app = NULL;
    g_free(app.args);
    g_free(text);
    g_free(manifest);
    g_free(dir);
    return status;
}

/* ------------------------------------------------------------- dispatch */

/* The options that take the next word with them. The first bare word is the
 * project; everything after it belongs to the program, as in `bintana`. */
static bool option_takes_value(const char *word)
{
    return !strcmp(word, "--form")      || !strcmp(word, "--theme") ||
           !strcmp(word, "--text-scale") || !strcmp(word, "--profile");
}

/*
 * The graphical host: `$BINTANA_GUI` when set, otherwise `bintana-gui` beside
 * this binary -- the installed split, and the source tree's build too.
 *
 * The answer is never this process itself: a name that resolves to the console
 * host would exec it again, forever, and that includes a `BINTANA_GUI` that
 * names it by mistake.
 */
static char *find_gui_host(void)
{
    char *self = bta_exe_path();
    const char *env = g_getenv("BINTANA_GUI");

    if (env && *env) {
        char *gui = g_canonicalize_filename(env, NULL);

        if (self && !g_strcmp0(gui, self)) {
            fprintf(stderr, "bintana: BINTANA_GUI names this console "
                            "host; it needs the graphical one\n");
            g_free(gui);
            g_free(self);
            return NULL;
        }
        g_free(self);
        return gui;
    }

    if (self) {
        char *bin = g_path_get_dirname(self);
        char *gui = g_build_filename(bin, "bintana-gui", NULL);

        if (g_file_test(gui, G_FILE_TEST_IS_EXECUTABLE) &&
            g_strcmp0(gui, self) != 0) {
            g_free(bin);
            g_free(self);
            return gui;
        }
        g_free(gui);
        g_free(bin);
    }
    g_free(self);
    return NULL;
}

/* Replace this process with the graphical host, every word and descriptor as
 * it arrived. `lead` is the command word the graphical host expects (`test`)
 * or NULL for a run; the exit status is that host's, which is what a runner
 * reads. */
static int exec_gui_lead(const char *gui, const char *lead,
                         char **words, int nwords)
{
    int   extra = lead ? 1 : 0;
    char **args = g_new0(char *, (gsize)nwords + (gsize)extra + 2);

    args[0] = (char *)gui;
    if (lead)
        args[1] = (char *)lead;
    for (int i = 0; i < nwords; i++)
        args[1 + extra + i] = words[i];

    execv(gui, args);
    fprintf(stderr, "bintana: cannot run the graphical host %s: %s\n",
            gui, g_strerror(errno));
    g_free(args);
    return 2;
}

static int exec_gui(const char *gui, char **words, int nwords)
{
    return exec_gui_lead(gui, NULL, words, nwords);
}

/*
 * `bintana test [--json] <project> [filter]`: the graphical host owns a
 * `startup` project's tests, because they build widgets; a `main` project's run
 * here, with no toolkit. The words travel whole, so `test` and `--json` mean
 * the same thing in both hosts.
 */
static int run_test_command(int argc, char **argv)
{
    const char *project = NULL;
    const char *filter  = NULL;
    bool        json    = false;

    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "--json")) {
            json = true;
            continue;
        }
        if (argv[i][0] == '-' && !project) {
            fprintf(stderr, "bintana: unknown option '%s'\n", argv[i]);
            return 2;
        }
        if (!project)
            project = argv[i];
        else if (!filter)
            filter = argv[i];
    }
    if (!project) {
        fprintf(stderr, "usage: bintana test [--json] <project> [filter]\n");
        return 2;
    }

    char *dir      = bta_project_dir(project);
    int   has_main = bta_project_has_main(dir);

    if (has_main == 0) {
        char *gui = find_gui_host();

        if (!gui) {
            char *name = g_path_get_basename(dir);

            fprintf(stderr, "bintana: '%s' runs its tests in a window, and "
                            "no graphical host is beside this binary. Install "
                            "bintana-gui there, or set BINTANA_GUI to it.\n",
                    name);
            g_free(name);
            g_free(dir);
            return 2;
        }
        g_free(dir);
        return exec_gui_lead(gui, "test", argv, argc);
    }
    g_free(dir);

    char *one[1] = { (char *)project };

    return run_project(1, one, true, json, filter);
}

static void usage(void)
{
    fputs("usage: bintana [run] <project> [args...]\n"
          "       bintana test [--json] <project> [filter]\n"
          "       bintana check [options] <project>\n"
          "       bintana --version\n", stderr);
}

/* What an option before the project means to a `main`. `--debug`, `--strict`
 * and `--profile` are the run's; the look and the form options are the
 * graphical host's and are forwarded there, as the plan says. */
static bool is_look_option(const char *word)
{
    return !strcmp(word, "--form") || !strcmp(word, "--theme") ||
           !strcmp(word, "--text-scale") || !strcmp(word, "--rtl");
}



int main(int argc, char **argv)
{
    if (argc >= 2 && (!strcmp(argv[1], "--version") || !strcmp(argv[1], "-v"))) {
        printf("bintana %s\n", BTA_VERSION_STRING);
        return 0;
    }
    if (argc >= 2 && (!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help"))) {
        fputs("usage: bintana [run] <project> [args...]\n"
              "       bintana test [--json] <project> [filter]\n"
              "       bintana check [options] <project>\n"
              "       bintana --version\n", stdout);
        return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "check"))
        return run_check(argc - 2, argv + 2);
    if (argc >= 2 && !strcmp(argv[1], "test"))
        return run_test_command(argc - 2, argv + 2);

    /* `run` is a word, not an option, and it says nothing the first bare word
     * does not: it is dropped before the project is looked for. */
    int first = 1;
    if (argc > first && !strcmp(argv[first], "run"))
        first++;
    if (first >= argc) {
        usage();
        return 2;
    }

    char **words  = argv + first;
    int    nwords = argc - first;
    int    project = -1;

    for (int i = 0; i < nwords; i++) {
        if (words[i][0] != '-') {
            project = i;
            break;
        }
        if (option_takes_value(words[i])) {
            if (i + 1 >= nwords) {
                fprintf(stderr, "bintana: %s needs a value\n", words[i]);
                return 2;
            }
            i++;
        }
    }
    if (project < 0) {
        usage();
        return 2;
    }

    /* The kind of project decides which host runs it, and it is answered from
     * the manifest without a QuickJS context: a window project must exec the
     * graphical host, not build the language to find out it has nothing to do
     * here. */
    char *dir = bta_project_dir(words[project]);
    int   has_main = bta_project_has_main(dir);

    if (has_main == 0) {
        char *gui = find_gui_host();

        if (!gui) {
            char *name = g_path_get_basename(dir);

            fprintf(stderr, "bintana: '%s' opens a window, and no "
                            "graphical host is beside this binary. Install "
                            "bintana-gui there, or set BINTANA_GUI to it.\n",
                    name);
            g_free(name);
            g_free(dir);
            return 2;
        }
        g_free(dir);
        return exec_gui(gui, words, nwords);
    }

    g_free(dir);

    if (has_main < 0)
        /* The full parser's diagnosis is the useful one; no option is worth
         * reading for a manifest that cannot be read. */
        return run_project(nwords - project, words + project, false, false, NULL);

    /* The graphical host owns the look and the form options, even for a
     * `main`: `--theme` is `Application.Theme` there, and `--form` is its own
     * refusal. A profile, strictness and the debugger belong to this run. */
    const char *profile = NULL;
    bool        look    = false;

    for (int i = 0; i < project; i++) {
        if (!strcmp(words[i], "--debug")) {
            bta_debug_want();
        } else if (!strcmp(words[i], "--strict")) {
            /* No widgets, so there is nothing to make strict. The graphical
             * console path accepts it for the same reason. */
        } else if (!strcmp(words[i], "--profile")) {
            if (i + 1 >= project) {
                fprintf(stderr, "bintana: --profile needs a file\n");
                return 2;
            }
            profile = words[++i];
        } else if (is_look_option(words[i])) {
            look = true;
            break;
        } else {
            fprintf(stderr, "bintana: unknown option '%s'\n", words[i]);
            usage();
            return 2;
        }
    }

    if (look) {
        char *gui = find_gui_host();

        if (!gui) {
            fprintf(stderr, "bintana: this run needs the graphical host, and "
                            "none is beside this binary. Install bintana-gui "
                            "there, or set BINTANA_GUI to it.\n");
            return 2;
        }
        return exec_gui(gui, words, nwords);
    }

    if (profile && !bta_profile_start(profile))
        return 2;

    int rc = run_project(nwords - project, words + project, false, false, NULL);

    bta_profile_finish();
    return rc;
}
