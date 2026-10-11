/*
 * bta_module.c -- a file that keeps its own names.
 *
 * A file of a project is a script, as it has always been, unless it says
 * `export`: then it is a module, what it exports reaches every other file of
 * the program **without an import**, and what it does not export is its own.
 * docs/plans/modules-plan.md is the design and its measurements; this file is
 * stage 2 of it.
 *
 * Three things live here, because four callers need them alike -- the loader,
 * a `Task`'s worker, `Application.Symbols` and `Application.CheckSource`:
 *
 *   bta_compile       which of the two a text is, decided by the compiler
 *   bta_module_run    evaluate a compiled module and hand out its exports
 *   bta_modules_forget  the bookkeeping, when a context goes
 *
 * **How a text is told to be a module.**  Compiled as a script first, which is
 * what every file written so far is; a `SyntaxError` there earns one more
 * compile as a module, and **whichever got further in the text is the
 * answer**.  The text of the error cannot decide it: a script compile names
 * `export` (`unsupported keyword: export`) but answers an `import` declaration
 * with a generic `Unexpected token` after the word.  And the further compile is
 * the right error to report either way: a module that breaks on line 40 says
 * line 40 and not *unsupported keyword* on line 1, and a broken script says its
 * own error, which the module compile reaches no later.  The second compile
 * happens only for a module and for a broken file.  `JS_DetectModule` was
 * measured and is not this: it answers true for nearly every strict script.
 *
 * **Where an export goes: the global object, as an accessor nobody can
 * reconfigure.**  The getter reads the module's namespace, so an `export let`
 * stays live.  Non-configurable is what makes a collision loud in both orders:
 * a script that declares the same name *after* the module is a `SyntaxError`
 * from the engine (a lexical declaration over a non-configurable property of
 * the global object), and one that declared it *before* is found here, by
 * asking the name of the global lexical scope, and refused naming the module.
 * **A name the runtime installs is refused too** -- `export class Timer` would
 * otherwise replace the runtime's for the whole program, where a top-level
 * `class Timer` in a script only shadows it -- and that is the plan's open
 * question answered the loud way.
 *
 * **Two modules exporting one name** is not an error at load: rules 3 and 4 of
 * the plan.  The second owner is written down beside the first and the getter,
 * which is already installed, then answers with a `ReferenceError` naming both
 * -- at the use, which is where somebody can do something about it, and only
 * if anybody uses it.
 */
#include "bta.h"

#include <string.h>

/* ------------------------------------------------------------ compiling */

/*
 * Where an exception says it happened, as one number that orders positions:
 * the first `<name>:LINE:COL` in its stack.  Zero when it says nothing, which
 * sorts before anything that does.
 */
static long error_position(JSContext *ctx, JSValueConst exc, const char *name)
{
    JSValue     stack = JS_GetPropertyStr(ctx, exc, "stack");
    const char *s     = JS_IsString(stack) ? JS_ToCString(ctx, stack) : NULL;
    long        line = 0, column = 0;

    JS_FreeValue(ctx, stack);
    if (!s)
        return 0;

    char       *needle = g_strdup_printf("%s:", name);
    const char *at     = strstr(s, needle);
    if (at) {
        const char *p = at + strlen(needle);
        while (g_ascii_isdigit(*p))
            line = line * 10 + (*p++ - '0');
        if (*p == ':')
            for (p++; g_ascii_isdigit(*p); p++)
                column = column * 10 + (*p - '0');
    }
    g_free(needle);
    JS_FreeCString(ctx, s);
    return line * 100000 + column;
}

/* By its name, which is what the compiler gives every error it raises; the
 * constructor is not something to compare against in a curated global scope. */
static bool is_syntax_error(JSContext *ctx, JSValueConst exc)
{
    if (!JS_IsError(exc))
        return false;
    JSValue     v = JS_GetPropertyStr(ctx, exc, "name");
    const char *s = JS_IsString(v) ? JS_ToCString(ctx, v) : NULL;
    bool        yes = s && !strcmp(s, "SyntaxError");

    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return yes;
}

JSValue bta_compile(JSContext *ctx, const char *src, size_t len,
                    const char *name, bool *is_module)
{
    *is_module = false;

    JSValue script = JS_Eval(ctx, src, len, name,
                             JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT |
                             JS_EVAL_FLAG_COMPILE_ONLY);
    if (!JS_IsException(script))
        return script;

    JSValue script_exc = JS_GetException(ctx);
    if (!is_syntax_error(ctx, script_exc)) {
        /* Not a syntax error (out of memory, a stack overflow): nothing a
         * module compile would answer differently. */
        return JS_Throw(ctx, script_exc);
    }

    JSValue module = JS_Eval(ctx, src, len, name,
                             JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (!JS_IsException(module)) {
        JS_FreeValue(ctx, script_exc);
        *is_module = true;
        return module;
    }

    /* A module compile that failed with anything but a syntax error read the
     * whole text: it resolves its imports in the same step, so an import of
     * something not there is `could not load module` with no position, after
     * the parse succeeded. */
    JSValue module_exc = JS_GetException(ctx);
    if (!is_syntax_error(ctx, module_exc) ||
        error_position(ctx, module_exc, name) >
        error_position(ctx, script_exc, name)) {
        JS_FreeValue(ctx, script_exc);
        *is_module = true;
        return JS_Throw(ctx, module_exc);
    }
    JS_FreeValue(ctx, module_exc);
    return JS_Throw(ctx, script_exc);
}

/* ------------------------------------------------------------ the owners */

/*
 * Per context, because a `Task` has a context of its own on another thread:
 * name -> the files that export it, in the order they did.  Plain C strings,
 * so forgetting it needs no context and can happen after the runtime is gone.
 */
static GMutex      owners_lock;
static GHashTable *owners_by_ctx;   /* JSContext* -> GHashTable name -> GPtrArray */

static GHashTable *owners_of(JSContext *ctx, bool make)
{
    GHashTable *t = NULL;

    g_mutex_lock(&owners_lock);
    if (!owners_by_ctx && make)
        owners_by_ctx = g_hash_table_new(g_direct_hash, g_direct_equal);
    if (owners_by_ctx) {
        t = g_hash_table_lookup(owners_by_ctx, ctx);
        if (!t && make) {
            t = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                      (GDestroyNotify)g_ptr_array_unref);
            g_hash_table_insert(owners_by_ctx, ctx, t);
        }
    }
    g_mutex_unlock(&owners_lock);
    return t;
}

void bta_modules_forget(JSContext *ctx)
{
    g_mutex_lock(&owners_lock);
    if (owners_by_ctx) {
        GHashTable *t = g_hash_table_lookup(owners_by_ctx, ctx);
        if (t) {
            g_hash_table_remove(owners_by_ctx, ctx);
            g_hash_table_unref(t);
        }
    }
    g_mutex_unlock(&owners_lock);
}

bool bta_module_exported(JSContext *ctx, const char *name)
{
    GHashTable *t = owners_of(ctx, false);
    bool        yes;

    g_mutex_lock(&owners_lock);
    yes = t && g_hash_table_contains(t, name);
    g_mutex_unlock(&owners_lock);
    return yes;
}

/* The owners of a name as a sentence: `Lib.js and Other.js`. */
static char *owners_text(GPtrArray *owners)
{
    GString *out = g_string_new(NULL);

    for (guint i = 0; i < owners->len; i++) {
        char *base = g_path_get_basename(owners->pdata[i]);
        if (i)
            g_string_append(out, i + 1 == owners->len ? " and " : ", ");
        g_string_append(out, base);
        g_free(base);
    }
    return g_string_free(out, FALSE);
}

/*
 * The getter every export is reached through.  data[0] is the name, data[1]
 * the namespace of the module that exported it first.
 */
static JSValue export_get(JSContext *ctx, JSValueConst this_val, int argc,
                          JSValueConst *argv, int magic, JSValueConst *data)
{
    (void)this_val; (void)argc; (void)argv; (void)magic;

    const char *name = JS_ToCString(ctx, data[0]);
    if (!name)
        return JS_EXCEPTION;

    GHashTable *t        = owners_of(ctx, false);
    char       *ambiguous = NULL;

    g_mutex_lock(&owners_lock);
    GPtrArray *owners = t ? g_hash_table_lookup(t, name) : NULL;
    if (owners && owners->len > 1)
        ambiguous = owners_text(owners);
    g_mutex_unlock(&owners_lock);

    if (ambiguous) {
        JSValue e = JS_ThrowReferenceError(ctx, "'%s' is exported by %s: choose "
                                           "one with import", name, ambiguous);
        g_free(ambiguous);
        JS_FreeCString(ctx, name);
        return e;
    }
    JSValue v = JS_GetPropertyStr(ctx, data[1], name);
    JS_FreeCString(ctx, name);
    return v;
}

/*
 * Whether the global lexical scope already has `name` -- a top-level `class`,
 * `let` or `const` of a script, which is not a property of the global object
 * and so is invisible to every property question.  Evaluating the bare name is
 * the one question that reaches it; the caller has already ruled out the
 * global object.  A binding still in its dead zone answers like a missing one,
 * which only a script that is still running could have.
 */
static bool lexical_has(JSContext *ctx, const char *name)
{
    JSValue v = JS_Eval(ctx, name, strlen(name), "<export>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return false;
    }
    JS_FreeValue(ctx, v);
    return true;
}

static int distribute(JSContext *ctx, JSValueConst global, JSValueConst ns,
                      JSAtom atom, const char *path)
{
    const char *name = JS_AtomToCString(ctx, atom);
    char       *file = g_path_get_basename(path);   /* what the messages say */
    int         rc   = -1;

    if (!name) {
        g_free(file);
        return -1;
    }

    if (!strcmp(name, "default")) {
        JS_ThrowSyntaxError(ctx, "%s: 'export default' has no name for the "
                            "other files to use: export a declaration by its "
                            "name", file);
        goto out;
    }

    GHashTable *t = owners_of(ctx, true);
    g_mutex_lock(&owners_lock);
    GPtrArray *owners = g_hash_table_lookup(t, name);
    if (owners) {
        /* A second owner: the getter is already there, and from now on it
         * names both.  The same file twice (a module loaded again) is one. */
        bool seen = false;
        for (guint i = 0; i < owners->len && !seen; i++)
            seen = !strcmp(owners->pdata[i], path);
        if (!seen)
            g_ptr_array_add(owners, g_strdup(path));
        g_mutex_unlock(&owners_lock);
        rc = 0;
        goto out;
    }
    g_mutex_unlock(&owners_lock);

    int has = JS_HasProperty(ctx, global, atom);
    if (has < 0)
        goto out;
    if (has) {
        JS_ThrowSyntaxError(ctx, "%s exports '%s', which is already a name of "
                            "the runtime or of a script: give it another",
                            file, name);
        goto out;
    }
    if (lexical_has(ctx, name)) {
        JS_ThrowSyntaxError(ctx, "%s exports '%s', which a script already "
                            "declares at its top level: one of the two has to "
                            "change", file, name);
        goto out;
    }

    JSValue data[2] = { JS_NewString(ctx, name), JS_DupValue(ctx, ns) };
    JSValue getter  = JS_NewCFunctionData(ctx, export_get, 0, 0, 2, data);
    JS_FreeValue(ctx, data[0]);
    JS_FreeValue(ctx, data[1]);
    if (JS_IsException(getter))
        goto out;

    if (JS_DefineProperty(ctx, global, atom, JS_UNDEFINED, getter, JS_UNDEFINED,
                          JS_PROP_HAS_GET | JS_PROP_HAS_CONFIGURABLE |
                          JS_PROP_HAS_ENUMERABLE | JS_PROP_THROW) < 0) {
        JS_FreeValue(ctx, getter);
        goto out;
    }
    JS_FreeValue(ctx, getter);

    owners = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(owners, g_strdup(path));
    g_mutex_lock(&owners_lock);
    g_hash_table_insert(t, g_strdup(name), owners);
    g_mutex_unlock(&owners_lock);
    rc = 0;

out:
    JS_FreeCString(ctx, name);
    g_free(file);
    return rc;
}

int bta_module_run(JSContext *ctx, JSValue compiled, const char *path)
{
    JSModuleDef *m       = JS_VALUE_GET_PTR(compiled);
    JSValue      promise = JS_EvalFunction(ctx, compiled);   /* takes it */

    if (JS_IsException(promise))
        return -1;

    /* A module is evaluated through a promise -- the reason the intrinsic is
     * registered -- and with top-level `await` refused (fork patch 13) it is
     * settled once the queue has run. */
    bta_drain_jobs(JS_GetRuntime(ctx));
    JSPromiseStateEnum state = JS_PromiseState(ctx, promise);
    if (state == JS_PROMISE_REJECTED) {
        JSValue why = JS_PromiseResult(ctx, promise);
        JS_FreeValue(ctx, promise);
        JS_Throw(ctx, why);
        return -1;
    }
    JS_FreeValue(ctx, promise);
    if (state != JS_PROMISE_FULFILLED) {
        JS_ThrowPlainError(ctx, "%s: the module did not finish evaluating",
                              path);
        return -1;
    }

    JSValue ns = JS_GetModuleNamespace(ctx, m);
    if (JS_IsException(ns))
        return -1;

    JSValue         global = JS_GetGlobalObject(ctx);
    JSPropertyEnum *tab    = NULL;
    uint32_t        n      = 0;
    int             rc     = 0;

    if (JS_GetOwnPropertyNames(ctx, &tab, &n, ns,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        rc = -1;
    } else {
        for (uint32_t i = 0; i < n && rc == 0; i++)
            rc = distribute(ctx, global, ns, tab[i].atom, path);
        JS_FreePropertyEnum(ctx, tab, n);
    }
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, ns);
    return rc;
}
