/*
 * The console host: `bintana-headless --version` and `check`, with no toolkit.
 *
 * This is the Phase 2 first slice of
 * `docs/plans/headless-runtime-plan.md`. It is deliberately a **console
 * project runner**: it reads `tools/check` and its `lib/check` modules, installs
 * the core globals, and calls the project's `main`. It does not dispatch to a
 * graphical host and it does not build a widget; a project that declares
 * `startup` is refused with a sentence.
 *
 * **The classes come from the metadata host.** `BTA_META_ONLY` makes the widget
 * rows carry no `build`/`probe` and every property a stub; `bta_widgets_init`
 * makes the prototypes `Widget.*` reads, and `forms.js` gets its ten captures
 * from the real `rad.js` this host evaluates.
 *
 * **What is stubbed and why.** `bta_runtime.c` owns the boot of the graphical
 * application and is where `Application`'s non-visual answers live; linking it
 * would pull GTK. The few functions the core files still name are supplied
 * here, and every one is a sentence in the plan's audit: the class lookup, the
 * error dump, the file read, the job drain, the error text, the application
 * pointer, the library listing. Phase 3 moves them into `bta_core.c` and leaves
 * this file as the host.
 */
#include "bta.h"
#include "bta_prelude.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

BtaApp *bta_current_app(void)
{
    return NULL;
}

bool bta_task_is_worker(JSContext *ctx)
{
    (void)ctx;
    return false;
}

/* `Task`'s hard-cancel signal is the thread's, and the console host has no
 * task thread. A blocking call handed no token behaves as the main thread's. */
GCancellable *bta_task_hard_cancellable(JSContext *ctx)
{
    (void)ctx;
    return NULL;
}

/* A GError in words of ours. The graphical host has the long table; a console
 * tool's errors are paths and I/O, and the domain and code are enough to say
 * what happened without quoting a translated GLib sentence. */
const char *bta_gerror_text(const GError *err)
{
    static _Thread_local char text[256];

    if (!err)
        return "unknown error";
    g_snprintf(text, sizeof text, "%s (%d)",
               err->domain ? g_quark_to_string(err->domain) : "error",
               err->code);
    return text;
}

const char *bta_errno_text(int errnum)
{
    static _Thread_local char text[256];

    g_snprintf(text, sizeof text, "%s (%d)", g_strerror(errnum), errnum);
    return text;
}

/* The `.js` files of a library directory, sorted. The graphical host's search
 * is six places wide and belongs to Phase 3; a library the host itself uses is
 * one directory, and this is the listing the module loader consumes. */
static gint path_cmp(gconstpointer a, gconstpointer b)
{
    return g_strcmp0(*(const char *const *)a, *(const char *const *)b);
}

GPtrArray *bta_library_sources(JSContext *ctx, const char *dir)
{
    (void)ctx;
    GPtrArray *out = g_ptr_array_new_with_free_func(g_free);
    GDir      *d   = dir ? g_dir_open(dir, 0, NULL) : NULL;
    const char *name;

    if (!d)
        return out;

    while ((name = g_dir_read_name(d)) != NULL)
        if (g_str_has_suffix(name, ".js"))
            g_ptr_array_add(out, g_build_filename(dir, name, NULL));

    g_dir_close(d);
    g_ptr_array_sort(out, path_cmp);
    return out;
}

GPtrArray *bta_library_worker_sources(JSContext *ctx, const char *dir)
{
    (void)ctx; (void)dir;
    return NULL;
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

void bta_dump_error(JSContext *ctx)
{
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

    bool    is_module;
    JSValue r = bta_compile(ctx, src, strlen(src), "<check>", &is_module);
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

static JSValue js_application_replacements(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    /* A console host does not close the hatches, so the names are still there
     * and a replacement table would describe a state this process is not in.
     * The object is empty and `Names` reads it as "nothing was taken away". */
    return JS_NewObject(ctx);
}

/* The places a library may be, in the order the CLI's own tree offers them. */
static char *find_library(const char *name, const char *project)
{
    GPtrArray *tried = g_ptr_array_new_with_free_func(g_free);
    char      *exe   = bta_exe_path();

    if (project && *project) {
        char *dir = g_canonicalize_filename(project, NULL);
        for (int up = 0; up < 4 && dir && *dir; up++) {
            g_ptr_array_add(tried, g_build_filename(dir, "lib", name, NULL));
            char *parent = g_path_get_dirname(dir);
            if (g_strcmp0(parent, dir) == 0) {
                g_free(parent);
                break;
            }
            g_free(dir);
            dir = parent;
        }
        g_free(dir);
    }
    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);
        g_ptr_array_add(tried, g_build_filename(up, "lib", name, NULL));
        g_ptr_array_add(tried, g_build_filename(up, "share", "bintana", "lib",
                                                name, NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(tried, g_build_filename("/usr", "share", "bintana", "lib",
                                            name, NULL));

    char *found = NULL;
    for (guint i = 0; i < tried->len && !found; i++)
        if (g_file_test(tried->pdata[i], G_FILE_TEST_IS_DIR))
            found = g_strdup(tried->pdata[i]);
    g_ptr_array_unref(tried);
    return found;
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

    char  *found = find_library(name, project);
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
                      JS_NewString(ctx, exe ? exe : "bintana-headless"));
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
    JS_SetPropertyStr(ctx, application, "Replacements",
                      JS_NewCFunction(ctx, js_application_replacements,
                                      "Replacements", 0));

    JS_SetPropertyStr(ctx, global, "Application", application);
}

/* ------------------------------------------------------------ the context */

static JSContext *headless_context(JSRuntime *rt)
{
    JSContext *ctx = JS_NewContextRaw(rt);
    if (!ctx)
        return NULL;

    if (JS_AddIntrinsicBaseObjects(ctx) ||
        JS_AddIntrinsicEval(ctx) ||
        JS_AddIntrinsicDate(ctx) ||
        JS_AddIntrinsicRegExp(ctx) ||
        JS_AddIntrinsicJSON(ctx) ||
        JS_AddIntrinsicMapSet(ctx) ||
        JS_AddIntrinsicPromise(ctx)) {
        JS_FreeContext(ctx);
        return NULL;
    }
    return ctx;
}

static bool eval_script(JSContext *ctx, const char *text, size_t len,
                        const char *name)
{
    JSValue r = JS_Eval(ctx, text, len, name, JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        return false;
    }
    JS_FreeValue(ctx, r);
    return true;
}

/* A library file is a module when it says `export`; a project's `Main.js` is a
 * script. `bta_compile` decides the same way the loader does. */
static bool eval_file(JSContext *ctx, const char *path)
{
    size_t len = 0;
    char  *src = bta_read_file(path, &len);
    if (!src) {
        fprintf(stderr, "bintana-headless: cannot read %s\n", path);
        return false;
    }

    bool    is_module;
    JSValue compiled = bta_compile(ctx, src, len, path, &is_module);
    g_free(src);

    if (JS_IsException(compiled)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, compiled);
        return false;
    }

    bool ok;
    if (is_module) {
        /* `bta_module_run` takes the compiled module: `JS_EvalFunction` does. */
        ok = bta_module_run(ctx, compiled, path) == 0;
    } else {
        JSValue r = JS_EvalFunction(ctx, compiled);
        ok = !JS_IsException(r);
        if (!ok)
            bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
    }
    bta_drain_jobs(JS_GetRuntime(ctx));
    return ok;
}

/* `Widget` and the metadata rows, before rad.js: rad.js's `FormPart` and the
 * forms.js mixins chain onto the class prototypes. */
/*
 * The names the graphical host installs and this one does not.
 *
 * `lib/check` asks `Application.Globals()` what a program may write. A project
 * that calls `Message.Info` or names `Printer` must not be told the name does
 * not exist because the console host has no window: the names are the same
 * surface, and the verb behind one is what refuses. Empty objects are enough
 * for the name pass; Phase 3 replaces each with the sentence its call refuses
 * with.
 */
static const char *const GUI_GLOBALS[] = {
    "Message", "Dialog", "Screen", "Clipboard", "Printer", "Tray",
    "Notification", "Desktop", "Popover", "Keyring", "Http", "Socket",
    "ServerSocket", "UdpSocket", "SerialPort", "WebSocket", "SmtpClient",
    "Database", "Sqlite", "Odbc", "Task", "Lock", "Cancellable", "Profile",
    "Random", "Gzip", "Zip", "Cipher", "Key", "Probe", "Media", "AudioPlayer"
};

/* The line breaks GTK's buffer uses, which is the model `Text.LineOf` follows:
 * `\n`, `\r\n` as one, a lone `\r` and U+2029. */
static int headless_line_break(const char *p)
{
    if (*p == '\n')
        return 1;
    if (*p == '\r')
        return p[1] == '\n' ? 2 : 1;
    if (g_utf8_get_char(p) == 0x2029)
        return (int)(g_utf8_next_char(p) - p);
    return 0;
}

int bta_line_of_utf16(const char *s, int index)
{
    const char *p     = s;
    int         units = 0;
    int         line  = 1;

    while (*p) {
        int br = headless_line_break(p);
        int n  = br ? br : (int)(g_utf8_next_char(p) - p);
        int u  = br == 2 ? 2 : (g_utf8_get_char(p) > 0xFFFF ? 2 : 1);

        if (units + u > index)
            break;
        units += u;
        p     += n;
        if (br)
            line++;
    }
    return line;
}

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

static void install_gui_stubs(JSContext *ctx, JSValueConst global)
{
    for (size_t i = 0; i < G_N_ELEMENTS(GUI_GLOBALS); i++) {
        JSValue existing = JS_GetPropertyStr(ctx, global, GUI_GLOBALS[i]);
        bool    present  = !JS_IsUndefined(existing) && !JS_IsException(existing);

        if (JS_IsException(existing))
            JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, existing);
        if (!present)
            JS_SetPropertyStr(ctx, global, GUI_GLOBALS[i], JS_NewObject(ctx));
    }
}

static bool install_core(JSContext *ctx, JSValueConst global,
                         const char *project, GPtrArray *libs)
{
    bta_sys_init(ctx, global);

    JSValue logger = JS_NewObject(ctx);
    static const char *const levels[] = { "Debug", "Info", "Warning", "Error" };
    for (int i = 0; i < 4; i++)
        JS_SetPropertyStr(ctx, logger, levels[i],
                          JS_NewCFunctionMagic(ctx, headless_log, levels[i], 1,
                                               JS_CFUNC_generic_magic, i));
    JS_SetPropertyStr(ctx, global, "Logger", logger);
    bta_bytes_init(ctx, global);
    bta_decimal_init(ctx, global);
    bta_day_init(ctx, global);
    bta_xml_init(ctx, global);
    bta_network_init(ctx, global);
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

static int run_check(int argc, char **argv)
{
    if (argc < 1) {
        fprintf(stderr, "usage: bintana-headless check [options] <project>\n");
        return 2;
    }

    char *tools = find_check_project();
    if (!tools) {
        fprintf(stderr, "bintana-headless: tools/check is not beside the binary\n");
        return 2;
    }

    char *library = find_library("check", tools);
    if (!library) {
        fprintf(stderr, "bintana-headless: lib/check is not where the binary "
                        "or the project looks\n");
        g_free(tools);
        return 2;
    }

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

    JSContext *ctx = headless_context(rt);
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
        fprintf(stderr, "bintana-headless: the check metadata is not installed "
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

    /* After the prelude and the metadata, and before the program's modules:
     * the runtime names `Application.FreeNames` leaves out are photographed
     * here -- `Regex`, `Dictionary`, `Widget` and the class names. */
    bta_modules_scope(ctx, tools, libs);

    GPtrArray *files = bta_library_sources(ctx, library);
    for (guint i = 0; i < files->len; i++)
        if (!eval_file(ctx, files->pdata[i]))
            break;
    g_ptr_array_unref(files);

    char *main_js = g_build_filename(tools, "Main.js", NULL);
    bool  ok      = eval_file(ctx, main_js);
    g_free(main_js);

    if (ok) {
        JSValue main = bta_lookup_global(ctx, "main");
        if (JS_IsException(main)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            fprintf(stderr, "bintana-headless: tools/check declares no main\n");
            ok = false;
        } else if (!JS_IsFunction(ctx, main)) {
            fprintf(stderr, "bintana-headless: 'main' is not a function\n");
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

    bta_modules_forget(ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    g_ptr_array_unref(libs);
    g_free(tools); g_free(library);
    return ok ? 0 : 1;
}

int main(int argc, char **argv)
{
    if (argc >= 2 && (!strcmp(argv[1], "--version") || !strcmp(argv[1], "-v"))) {
        printf("bintana-headless %s\n", BTA_VERSION_STRING);
        return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "check"))
        return run_check(argc - 2, argv + 2);

    fprintf(stderr,
            "usage: bintana-headless check [options] <project>\n"
            "       bintana-headless --version\n");
    return 2;
}
