/*
 * Native plugins: the host table a plugin calls through, and the loader that
 * finds one in a library directory.
 *
 * The contract is `runtime/include/bta_plugin.h`, and it is deliberately tiny:
 * a plugin links neither the runtime nor QuickJS, the runtime exports no
 * symbols for it, and everything a plugin can do is one line in that header.
 * This file is the other side of it -- the table implemented over the engine,
 * and the decisions the loader makes.
 *
 * ## Where a plugin lives
 *
 * `uses: ["taglib"]` already resolves to a directory over six places
 * (`lib_candidates` in bta_runtime.c).  If that directory also holds
 * `taglib.so` -- the suffix is GModule's, so `.dll` on Windows -- then the
 * plugin is loaded before the library's `.js`, which is what lets the
 * JavaScript half wrap a global the native half installed.  A directory with no
 * shared object is an ordinary JavaScript library and nothing happens here.
 *
 * The file is named after its directory, the way the library itself is named by
 * `uses`: one name, and no manifest to keep in step.
 *
 * ## Why the failures are fatal
 *
 * A `.so` that is there but will not load, declares no `bta_plugin`, speaks
 * another ABI, or refuses to install itself, stops the program.  It is the same
 * rule `collect_libs` already applies to a library that is not there: half a
 * library is not a state to run in, and the failure a moment later would be
 * `TagLib is not defined` with nothing in it about which library and which
 * file.  A name that resolves to a directory with no native part is not a
 * failure at all -- it is the ordinary case, which is why the test is on the
 * file and not on the library.
 *
 * And it stops it **visibly**: the sentence goes through `bta_report_fatal`,
 * which puts up the same alert a JavaScript error gets.  A terminal got the
 * first version of this and a project started from a menu got nothing -- the
 * program did not open, and said so to nobody.
 *
 * ## The one ownership trick worth knowing
 *
 * `BtaValue` is a JavaScript value and the plugin treats it as opaque, but this
 * side has to move the bits between the two types.  They are both 64 bits wide
 * and this is the only file that knows it; the static assertion below is what
 * turns a future engine that changes its mind into a build failure rather than
 * a corrupted value at run time.
 *
 * And `text()` is borrowed until the callback returns, which means this side
 * has to own the conversion: every `JS_ToCString` made during a call goes into
 * a list that is freed when the call ends.  Without it the pointer a plugin
 * holds would either dangle or leak, and both were possible.
 */
#include "bta.h"
#include "bta_plugin.h"

#include <gmodule.h>

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

/*
 * The public value is an opaque two-word struct so that the header does not
 * change with the engine's boxing; this is the only place that knows the engine
 * is narrower than that, and the assertion is what turns a future engine that
 * grows past it into a build failure instead of a truncated value at run time.
 */
G_STATIC_ASSERT(sizeof(JSValue) <= sizeof(BtaValue));

static BtaValue to_bta(JSValue v)
{
    BtaValue out = { { 0, 0 } };
    memcpy(&out, &v, sizeof(v));
    return out;
}

static JSValue to_js(BtaValue v)
{
    JSValue out;
    memset(&out, 0, sizeof(out));
    memcpy(&out, &v, sizeof(out));
    return out;
}

static JSContext *plugin_ctx(void)
{
    BtaApp *app = bta_current_app();
    return app ? app->ctx : NULL;
}

/* --------------------------------------------------------------- values */

static BtaValue plugin_undefined(const BtaHost *h)
{
    return to_bta(JS_UNDEFINED);
}

static BtaValue plugin_null(const BtaHost *h)
{
    return to_bta(JS_NULL);
}

static BtaValue plugin_boolean(const BtaHost *h, int value)
{
    return to_bta(JS_NewBool(plugin_ctx(), value));
}

static BtaValue plugin_number(const BtaHost *h, double value)
{
    return to_bta(JS_NewFloat64(plugin_ctx(), value));
}

static BtaValue plugin_string(const BtaHost *h, const char *utf8)
{
    return to_bta(JS_NewString(plugin_ctx(), utf8 ? utf8 : ""));
}

static BtaValue plugin_object(const BtaHost *h)
{
    return to_bta(JS_NewObject(plugin_ctx()));
}

static BtaValue plugin_array(const BtaHost *h)
{
    return to_bta(JS_NewArray(plugin_ctx()));
}

/* set and push consume their value: the engine's own property setters take
 * ownership, which is exactly the contract in the header. */
static void plugin_set(const BtaHost *h, BtaValue obj, const char *key,
                       BtaValue value)
{
    JS_SetPropertyStr(plugin_ctx(), to_js(obj), key, to_js(value));
}

static BtaValue plugin_get(const BtaHost *h, BtaValue obj, const char *key)
{
    return to_bta(JS_GetPropertyStr(plugin_ctx(), to_js(obj), key));
}

static void plugin_push(const BtaHost *h, BtaValue array, BtaValue value)
{
    JSContext *ctx = plugin_ctx();
    JSValue   arr = to_js(array);
    JSValue   len = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t  at  = 0;

    JS_ToUint32(ctx, &at, len);
    JS_FreeValue(ctx, len);
    JS_SetPropertyUint32(ctx, arr, at, to_js(value));
}

/* ------------------------------------------------- borrowed conversions */

/*
 * The strings `text()` handed out during one call.  Freed when the outermost
 * call ends, so the pointer the plugin holds is valid exactly as long as the
 * header says and not a moment longer -- which is also the rule for a
 * callback's `argv`.
 *
 * The depth is not nesting for its own sake: a plugin function can be called
 * from inside another one the moment JavaScript gets a turn, and the inner exit
 * must not free what the outer call is still holding.
 */
static GPtrArray *borrowed;
static int        call_depth;

static void call_begin(void)
{
    call_depth++;
}

static void call_end(JSContext *ctx)
{
    if (--call_depth > 0)
        return;

    if (!borrowed)
        return;

    for (guint i = 0; i < borrowed->len; i++)
        JS_FreeCString(ctx, borrowed->pdata[i]);
    g_ptr_array_set_size(borrowed, 0);
}

static const char *plugin_text(const BtaHost *h, BtaValue v)
{
    JSContext  *ctx = plugin_ctx();
    const char *s   = JS_ToCString(ctx, to_js(v));

    if (!s)
        return NULL;

    if (!borrowed)
        borrowed = g_ptr_array_new();
    g_ptr_array_add(borrowed, (gpointer)s);
    return s;
}

static double plugin_value(const BtaHost *h, BtaValue v)
{
    double d = NAN;
    JS_ToFloat64(plugin_ctx(), &d, to_js(v));
    return d;
}

static BtaKind plugin_kind(const BtaHost *h, BtaValue v)
{
    JSContext *ctx = plugin_ctx();
    JSValue    j   = to_js(v);

    if (JS_HasException(ctx) || JS_IsException(j))
        return BTA_KIND_ERROR;

    switch (JS_VALUE_GET_TAG(j)) {
    case JS_TAG_UNDEFINED:   return BTA_KIND_UNDEFINED;
    case JS_TAG_NULL:        return BTA_KIND_NULL;
    case JS_TAG_BOOL:        return BTA_KIND_BOOL;
    case JS_TAG_INT:
    case JS_TAG_FLOAT64:     return BTA_KIND_NUMBER;
    case JS_TAG_STRING:
    case JS_TAG_STRING_ROPE: return BTA_KIND_STRING;
    case JS_TAG_OBJECT:      return BTA_KIND_OBJECT;
    default:                 return BTA_KIND_ERROR;
    }
}

static void plugin_release(const BtaHost *h, BtaValue v)
{
    JS_FreeValue(plugin_ctx(), to_js(v));
}

static void plugin_fail(const BtaHost *h, const char *message)
{
    JS_ThrowTypeError(plugin_ctx(), "%s", message ? message : "plugin error");
}

static void plugin_log(const BtaHost *h, const char *text)
{
    bta_log_debug(plugin_ctx(), text ? text : "");
}

/*
 * The other direction: a function JavaScript handed the plugin, invoked from
 * C.  `argv` is borrowed and stays valid for the length of the call, `this` is
 * borrowed, and the answer is the caller's.
 *
 * An exception the called function threw is left pending and answered as
 * `JS_EXCEPTION` -- `kind()` reports `BTA_KIND_ERROR` -- because the useful
 * default is that it surfaces at whoever called the plugin, exactly as an
 * exception from a JavaScript function surfaces at whoever called it.
 */
static BtaValue plugin_call(const BtaHost *h, BtaValue fn, BtaValue this_val,
                            int argc, const BtaValue *argv)
{
    JSContext *ctx  = plugin_ctx();
    JSValue    f    = to_js(fn);
    JSValue   *args = NULL;
    JSValue    r;

    if (!JS_IsFunction(ctx, f)) {
        JS_ThrowTypeError(ctx, "call: the value is not a function");
        return to_bta(JS_UNDEFINED);
    }

    if (argc > 0) {
        args = g_new(JSValue, argc);
        for (int i = 0; i < argc; i++)
            args[i] = to_js(argv[i]);
    }

    /* Depth, so strings this call's arguments were read from survive it: the
     * arena is freed when the outermost entry point ends, not here. */
    call_begin();
    r = JS_Call(ctx, f, to_js(this_val), argc, (JSValueConst *)args);
    call_end(ctx);
    g_free(args);

    return to_bta(r);
}

/* ------------------------------------------------------------- functions */

static BtaValue plugin_function(const BtaHost *h, const char *name, int length,
                                BtaPluginFn fn, void *user);

/*
 * The host table, spelled once.  It is here rather than beside the loader
 * because `plugin_fn_call` hands it back to every callback, and a callback is
 * how a plugin does anything at all.
 *
 * The designated initializers cover every field, so a field added to the header
 * is a value a build has to choose rather than a zero nobody notices.
 */
static const BtaHost host = {
    .abi       = BTA_PLUGIN_ABI,
    .undefined = plugin_undefined,
    .null      = plugin_null,
    .boolean   = plugin_boolean,
    .number    = plugin_number,
    .string    = plugin_string,
    .object    = plugin_object,
    .array     = plugin_array,
    .set       = plugin_set,
    .get       = plugin_get,
    .push      = plugin_push,
    .function  = plugin_function,
    .kind      = plugin_kind,
    .text      = plugin_text,
    .value     = plugin_value,
    .release   = plugin_release,
    .fail      = plugin_fail,
    .log       = plugin_log,
    .call      = plugin_call,
};

/* One plugin function: the C callback and the state it asked to carry. */
typedef struct {
    BtaPluginFn fn;
    void       *user;
} PluginFn;

static void plugin_fn_free(void *opaque)
{
    g_free(opaque);
}

/*
 * What the engine calls.  `magic` carries the declared arity the plugin wrote
 * its function with, and it is what makes the padding the header promises:
 * the engine pads `argv` up to `s->length` but reports the **actual** `argc`,
 * so a plugin declared with two arguments and called with none would otherwise
 * be handed a short count and a pointer it could not index -- which is exactly
 * the crash the first version of this had.  The count handed on is therefore
 * the larger of the two, and every missing argument is `undefined`, as
 * `BtaPluginFn` says.
 *
 * `argv` is borrowed, and the value that comes back from the plugin is handed
 * to the engine -- unless `fail()` armed an exception, in which case it is
 * dropped and the exception is raised.
 */
static JSValue plugin_fn_call(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv, int magic, void *opaque)
{
    PluginFn *f    = opaque;
    int       n    = argc < magic ? magic : argc;
    BtaValue *args = NULL;
    BtaValue  r;

    if (n > 0) {
        args = g_new(BtaValue, n);
        for (int i = 0; i < n; i++)
            args[i] = to_bta(i < argc ? argv[i] : JS_UNDEFINED);
    }

    call_begin();
    r = f->fn(&host, f->user, n, args);
    call_end(ctx);
    g_free(args);

    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, to_js(r));
        return JS_EXCEPTION;
    }
    return to_js(r);
}

static BtaValue plugin_function(const BtaHost *h, const char *name, int length,
                                BtaPluginFn fn, void *user)
{
    JSContext *ctx = plugin_ctx();
    PluginFn  *f   = g_new0(PluginFn, 1);
    JSValue    v;

    f->fn   = fn;
    f->user = user;

    /* The declared arity is the closure's `magic`: see plugin_fn_call. */
    v = JS_NewCClosure(ctx, plugin_fn_call, name, plugin_fn_free, length, length, f);
    if (JS_IsException(v))
        g_free(f);   /* the failure path never reaches the finalizer */
    return to_bta(v);
}

/* ---------------------------------------------------------------- loader */

typedef struct {
    GModule         *module;
    const BtaPlugin *api;
    char            *path;
} LoadedPlugin;

static void loaded_free(gpointer p)
{
    LoadedPlugin *lp = p;

    if (lp->api && lp->api->cleanup)
        lp->api->cleanup();
    if (lp->module)
        g_module_close(lp->module);
    g_free(lp->path);
    g_free(lp);
}

static bool already_loaded(BtaApp *app, const char *path)
{
    for (guint i = 0; app->plugins && i < app->plugins->len; i++) {
        LoadedPlugin *lp = g_ptr_array_index(app->plugins, i);

        if (!strcmp(lp->path, path))
            return true;
    }
    return false;
}

/*
 * One place for the four ways a plugin can be unusable, because the message is
 * the same kind of thing every time: a sentence for a person, to the terminal
 * and -- in a form project -- to the alert `bta_report_fatal` puts up.  It was
 * a `fprintf` first, which is right for a project started from a shell and
 * invisible for one started from a menu: the program simply did not open.
 */
static bool plugin_fatal(BtaApp *app, const char *fmt, ...)
{
    va_list args;
    char   *msg;

    va_start(args, fmt);
    msg = g_strdup_vprintf(fmt, args);
    va_end(args);

    bta_report_fatal(app, msg);
    g_free(msg);
    return false;
}

bool bta_plugins_load(BtaApp *app, JSContext *ctx, JSValue global)
{
    for (guint i = 0; app->libs && i < app->libs->len; i++) {
        const char *dir  = g_ptr_array_index(app->libs, i);
        char       *base = g_path_get_basename(dir);
        char       *path = g_strdup_printf("%s%c%s.%s", dir, G_DIR_SEPARATOR,
                                           base, G_MODULE_SUFFIX);
        GModule    *m;
        gpointer    sym = NULL;
        BtaPlugin  *api;

        /*
         * Most libraries are JavaScript only, and a name that resolves to a
         * directory with no shared object in it is not a plugin that failed to
         * build -- it is not a plugin.  Silent, and that is the ordinary case.
         */
        if (!g_file_test(path, G_FILE_TEST_IS_REGULAR)) {
            g_free(path);
            g_free(base);
            continue;
        }

        if (already_loaded(app, path)) {
            /* Two names for one file: `uses` listing the same library twice,
             * or the same directory reached by two search paths.  One process
             * loads a plugin once. */
            g_free(path);
            g_free(base);
            continue;
        }

        m = g_module_open(path, G_MODULE_BIND_LOCAL);
        if (!m) {
            const char *why = g_module_error();

            plugin_fatal(app, "library \"%s\" has a plugin that could not be "
                              "loaded:\n  %s\n  %s", base, path,
                         why ? why : "unknown");
            g_free(path);
            g_free(base);
            return false;
        }

        if (!g_module_symbol(m, BTA_PLUGIN_ENTRY_SYMBOL, &sym) || !sym) {
            plugin_fatal(app, "%s exports no %s, so it is not a Bintana plugin",
                         path, BTA_PLUGIN_ENTRY_SYMBOL);
            g_module_close(m);
            g_free(path);
            g_free(base);
            return false;
        }

        api = sym;
        if (api->abi != BTA_PLUGIN_ABI) {
            plugin_fatal(app, "plugin %s was built for ABI %d, this runtime "
                              "speaks %d -- rebuild it against this runtime",
                         path, api->abi, BTA_PLUGIN_ABI);
            g_module_close(m);
            g_free(path);
            g_free(base);
            return false;
        }

        if (!api->init) {
            plugin_fatal(app, "plugin %s declares no init", path);
            g_module_close(m);
            g_free(path);
            g_free(base);
            return false;
        }

        /*
         * Borrowed and not owned: the plugin sets properties on it and lets it
         * go.  See the note beside `init` in bta_plugin.h.
         */
        call_begin();
        if (api->init(&host, to_bta(global)) != 0) {
            char *why = NULL;

            /*
             * The exception becomes the sentence rather than being dumped with
             * its stack: an init is one call the plugin wrote, and the message
             * is what the alert can show -- a stack would be a paragraph in a
             * dialog.  A plugin that wants more logs it itself.
             */
            if (JS_HasException(ctx)) {
                JSValue     exc = JS_GetException(ctx);
                const char *msg = JS_ToCString(ctx, exc);

                why = g_strdup(msg ? msg : "unknown error");
                JS_FreeCString(ctx, msg);
                JS_FreeValue(ctx, exc);
            }
            call_end(ctx);

            plugin_fatal(app, "plugin %s refused to install itself%s%s", path,
                         why ? ": " : "", why ? why : "");
            g_free(why);
            g_module_close(m);
            g_free(path);
            g_free(base);
            return false;
        }
        call_end(ctx);

        {
            LoadedPlugin *lp = g_new0(LoadedPlugin, 1);
            lp->module = m;
            lp->api    = api;
            lp->path   = path;

            if (!app->plugins)
                app->plugins = g_ptr_array_new();
            g_ptr_array_add(app->plugins, lp);
        }
        g_free(base);
    }
    return true;
}

/*
 * Reverse order, because a plugin loaded later was allowed to build on one
 * loaded earlier -- the same reason a library's sources load in `uses` order.
 * The context is already gone when this runs, and the contract says `cleanup`
 * must not call the host, so there is nothing here to hand back.
 */
void bta_plugins_cleanup(BtaApp *app)
{
    if (!app->plugins)
        return;

    for (guint i = app->plugins->len; i > 0; i--)
        loaded_free(g_ptr_array_index(app->plugins, i - 1));

    g_ptr_array_free(app->plugins, TRUE);
    app->plugins = NULL;
}
