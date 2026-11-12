/*
 * The metadata host: what `Widget.*` answers with no toolkit in the link.
 *
 * This is the Phase 1 spike of `docs/plans/headless-runtime-plan.md`, and it
 * is deliberately small. It builds no widget and opens no window. It creates a
 * QuickJS context, asks the class rows to make their prototypes -- with every
 * property entry a stub, and every class row without its `build` or `probe` --
 * and evaluates a JavaScript file against them. The linker is the proof: with
 * `-ffunction-sections` and `--gc-sections`, a reference to GTK from a function
 * nothing calls is dropped, and `ldd` must not list GTK, GtkSourceView or VTE.
 *
 * **The three symbols the widget files still reach for are here.** The class
 * rows are the runtime's own, but `bta_lookup_global` lives in the graphical
 * host, the module test is the module loader's, and an error dump is the
 * runtime's; the metadata host answers the first two with the same rules the
 * real ones use and the third with a line on stderr. Every other cross-file
 * function is either dropped with its caller or supplied by a widget file that
 * does not touch GTK in the part that is live.
 *
 * The script it runs is a test's, not a program's: `tests/headless/probe.js`
 * prints the answers the IDE and `tests/api` read, and the shell test around it
 * checks them. A real console host replaces this file's `main` with the boot
 * and globals of Phase 2; the class metadata does not change.
 */
#include "bta.h"
#include "bta_prelude.h"
#include "bta_forms.h"

#include <stdio.h>
#include <string.h>

/*
 * The captures `forms.js` expects from `rad.js`.
 *
 * `rad.js` is the language and `forms.js` is the widgets; they share one global
 * lexical scope, and the second uses ten captures the first makes. The metadata
 * host does not need the language -- no project source runs here -- so it
 * publishes those ten and evaluates `forms.js` alone. The names that matter to
 * a class's metadata are the reflection (`defineProperty`, `prototypeOf`,
 * `ownNames`, `ownDescriptor`, `objectProto`, `hasOwn`), the namespace list
 * `Widget.TypeName` reads, and the three comparisons the serialiser's functions
 * mention but this host never calls.
 */
static const char meta_prelude_shim[] =
    "const defineProperty = Object.defineProperty;\n"
    "const prototypeOf    = Object.getPrototypeOf;\n"
    "const ownNames       = Object.getOwnPropertyNames;\n"
    "const ownDescriptor  = Object.getOwnPropertyDescriptor;\n"
    "const objectProto    = Object.prototype;\n"
    "const hasOwn         = objectProto.hasOwnProperty;\n"
    "const namespaces     = [];\n"
    "class FormPart {}\n"
    "function defaultsFor() { return {}; }\n"
    "function sameValue(a, b) { return a === b; }\n"
    "function plainData() { return true; }\n";

/* ------------------------------------------------------ what the rows reach */

/*
 * The same rule as `bta_lookup_global` in `bta_runtime.c`: a bare name is the
 * global lexical scope before globalThis (a project's `class Timer`), and a
 * dotted name is a walk. The real one also validates the identifier; this one
 * does not, because only the metadata host's own test calls it and the class
 * table answers first for every widget name.
 */
JSValue bta_lookup_global(JSContext *ctx, const char *name)
{
    if (!name)
        return JS_ThrowTypeError(ctx, "a class lookup needs a name");

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

/* `Sources` asks whether a head is the runtime's own; the metadata host has
 * no module loader, and the answer is only used for a class the table does not
 * hold. False is the honest answer here. */
bool bta_module_runtime_owns(JSContext *ctx, const char *name)
{
    (void)ctx; (void)name;
    return false;
}

/* The metadata host has no application; a function that asks is a function
 * the linker kept from the widget rows, and it gets the empty answer. */
BtaApp *bta_current_app(void)
{
    return NULL;
}

/*
 * The prelude's declarations, without the graphical host's module machinery.
 *
 * `Widget.Members` describes a member written in JavaScript from the JSDoc
 * above it, and the only reader of that comment is the compiler's symbol pass.
 * The real `bta_symbols` in `bta_runtime.c` also decides script-versus-module
 * and drives the module checker; the prelude is two scripts, so this one
 * compiles them as scripts and collects the same rows. The parser is the
 * engine's, not a second reader -- which is the property the real one is kept
 * for.
 *
 * A syntax error answers the rows collected before it, exactly as the real one
 * does: this runs over the prelude, not over the file a person is typing.
 */
typedef struct {
    JSContext *ctx;
    JSValue    list;
    uint32_t   count;
} MetaSymbolSink;

static const char *meta_symbol_kind(JSSymbolKind kind)
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

/* The real `bta_split_doc`, in the one place the metadata host needs it: the
 * JSDoc above a member, as its description and its `@returns`. */
static void meta_split_doc(const char *doc, char **text, char **returns)
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

static void meta_symbol_report(void *opaque, JSSymbolKind kind, const char *name,
                               const char *parent, const char *supertype,
                               const char *params, int line, int end_line,
                               const char *doc)
{
    MetaSymbolSink *sink = opaque;
    JSContext      *ctx  = sink->ctx;
    JSValue         obj  = JS_NewObject(ctx);

    if (JS_IsException(obj)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }

    JS_SetPropertyStr(ctx, obj, "Name", JS_NewString(ctx, name));
    JS_SetPropertyStr(ctx, obj, "Kind", JS_NewString(ctx, meta_symbol_kind(kind)));
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
    meta_split_doc(doc, &text, &ret);
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
    MetaSymbolSink sink = { ctx, JS_NewArray(ctx), 0 };
    JSRuntime     *rt   = JS_GetRuntime(ctx);

    JS_SetSymbolHandler(rt, meta_symbol_report, &sink);

    JSValue r = JS_Eval(ctx, src, strlen(src), "<symbols>",
                        JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT |
                        JS_EVAL_FLAG_COMPILE_ONLY);

    JS_SetSymbolHandler(rt, NULL, NULL);

    /* Compiled and not run, so the only thing it can hand back is an error --
     * and the symbols collected before it are the answer. */
    if (JS_IsException(r))
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        JS_FreeValue(ctx, r);

    return sink.list;
}

/* The two sources the symbol pass walks, from the same generated headers the
 * graphical host reads. */
void bta_prelude_sources(const char **rad, const char **forms)
{
    if (rad)
        *rad = bta_prelude_js;
    if (forms)
        *forms = bta_forms_js;
}

void bta_dump_error(JSContext *ctx)
{
    JSValue     exc = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, exc);

    fprintf(stderr, "%s\n", text ? text : "exception");

    if (text)
        JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, exc);
}

/* --------------------------------------------------------------- the host */

static JSValue meta_print(JSContext *ctx, JSValueConst this_val,
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

/*
 * The intrinsics the language needs, without the reference hint handler the
 * graphical host installs: the hint names a type for a property access, and
 * no project source is evaluated here.
 */
static JSContext *meta_context(JSRuntime *rt)
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

static bool meta_eval(JSContext *ctx, const char *text, const char *name)
{
    JSValue r = JS_Eval(ctx, text, strlen(text), name,
                        JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);

    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        return false;
    }
    JS_FreeValue(ctx, r);
    return true;
}

/*
 * The metadata, as data for the console host.
 *
 * Every answer `Widget.*` gives is dumped for every class -- the C rows, the
 * prelude's mixins and the generated signatures -- so `bintana` can answer the
 * check without linking the widget files. `bintana-meta` is the generator and
 * the test; it is not installed.
 */
static const char meta_dump_js[] =
    "function __widgets() {\n"
    "    const extra = ['MenuItem', 'Action'];\n"
    "    const types = Widget.Types();\n"
    "    const all   = types.concat(extra);\n"
    "    const out   = { Types: types, Members: {}, Signatures: {},\n"
    "                    PropertyNames: {}, Methods: {}, EventNames: {},\n"
    "                    EventSignatures: {}, EventDocs: {}, TextProperties: {},\n"
    "                    PropertyOptions: {}, DeferredProperties: {},\n"
    "                    Available: {} };\n"
    "    for (const t of all) {\n"
    "        const members = Widget.Members(t) || [];\n"
    "        const props   = Widget.PropertyNames(t) || [];\n"
    "        const events  = Widget.EventNames(t) || [];\n"
    "        out.Members[t]         = members;\n"
    "        out.PropertyNames[t]   = props;\n"
    "        out.Methods[t]         = Widget.Methods(t) || [];\n"
    "        out.EventNames[t]      = events;\n"
    "        out.TextProperties[t]  = Widget.TextProperties(t) || [];\n"
    "        out.DeferredProperties[t] = Widget.DeferredProperties(t) || [];\n"
    "        out.Available[t]       = Widget.Available(t);\n"
    "        out.Signatures[t]      = {};\n"
    "        for (const m of members)\n"
    "            out.Signatures[t][m.Name] = Widget.Signature(t, m.Name);\n"
    "        out.EventSignatures[t] = {};\n"
    "        out.EventDocs[t]       = {};\n"
    "        for (const e of events) {\n"
    "            out.EventSignatures[t][e] = Widget.EventSignature(t, e);\n"
    "            out.EventDocs[t][e]       = Widget.EventDoc(t, e);\n"
    "        }\n"
    "        out.PropertyOptions[t] = {};\n"
    "        for (const p of props)\n"
    "            out.PropertyOptions[t][p] = Widget.PropertyOptions(t, p);\n"
    "    }\n"
    "    return JSON.stringify(out);\n"
    "}\n"
    "__widgets();\n";

int main(int argc, char **argv)
{
    const char *dump   = NULL;
    const char *script = NULL;

    if (argc == 3 && !strcmp(argv[1], "--dump"))
        dump = argv[2];
    else if (argc == 2)
        script = argv[1];
    else {
        fprintf(stderr, "usage: bintana-meta <script.js>\n"
                        "       bintana-meta --dump <widgets.json>\n");
        return 2;
    }

    char  *text = NULL;
    gsize  len  = 0;
    GError *err = NULL;

    if (script && !g_file_get_contents(script, &text, &len, &err)) {
        fprintf(stderr, "bintana-meta: %s\n", err ? err->message : script);
        g_clear_error(&err);
        return 2;
    }

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        g_free(text);
        return 2;
    }
    JS_SetMaxStackSize(rt, 2 * 1024 * 1024);

    JSContext *ctx = meta_context(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        g_free(text);
        return 2;
    }

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, meta_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "BTA_VERSION",
                      JS_NewString(ctx, BTA_VERSION_STRING));

    /* The class rows and their property tables. No GtkWidget is made. */
    bta_widgets_init(ctx, global);

    /*
     * The prelude's widget half, with the ten captures it expects from the
     * language half. If it does not load, the C fallback in
     * `w_property_names_by_type` still answers; the exit status says the
     * metadata is incomplete, and `tests/headless.sh` sees it.
     */
    int status = 0;
    if (!meta_eval(ctx, meta_prelude_shim, "<meta-shim>") ||
        !meta_eval(ctx, bta_forms_js, "<forms.js>"))
        status = 1;

    JS_FreeValue(ctx, global);

    if (dump) {
        JSValue r = JS_Eval(ctx, meta_dump_js, strlen(meta_dump_js),
                            "<widgets-dump>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(r)) {
            bta_dump_error(ctx);
            status = 1;
        } else {
            const char *json = JS_ToCString(ctx, r);
            GError     *werr = NULL;

            if (!json || !g_file_set_contents(dump, json, -1, &werr)) {
                fprintf(stderr, "bintana-meta: cannot write %s: %s\n", dump,
                        werr ? werr->message : "not text");
                g_clear_error(&werr);
                status = 1;
            }
            if (json)
                JS_FreeCString(ctx, json);
        }
        JS_FreeValue(ctx, r);

        bta_widgets_cleanup(ctx);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        g_free(text);
        return status;
    }

    JSValue result = JS_Eval(ctx, text, len, script, JS_EVAL_TYPE_GLOBAL);

    if (JS_IsException(result)) {
        bta_dump_error(ctx);
        status = 1;
    } else {
        /*
         * A file written as a `main` project declares `Main` and leaves the
         * work to the runtime; a file written as a probe may do it at the top
         * level. Both are one file, so the host calls `Main` when there is one
         * and stays quiet when there is not -- which is what lets the same
         * source run under this host and under a project's `main`.
         */
        JSValue fn = bta_lookup_global(ctx, "Main");

        if (JS_IsException(fn)) {
            JS_FreeValue(ctx, JS_GetException(ctx));   /* no Main: not an error */
        } else {
            if (JS_IsFunction(ctx, fn)) {
                JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
                if (JS_IsException(r)) {
                    bta_dump_error(ctx);
                    status = 1;
                }
                JS_FreeValue(ctx, r);
            }
            JS_FreeValue(ctx, fn);
        }
    }
    JS_FreeValue(ctx, result);

    bta_widgets_cleanup(ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    g_free(text);

    return status;
}
