/*
 * Cancellable -- a cancellation signal a program can share.
 *
 * The runtime's own `Task.Start` creates one per job and `Stop()` raises it.
 * A shared one is forwarded into that, one way: raising it stops every task
 * linked to it, while one task's `Stop` or `Timeout` raises only its own.
 * A program that wants to stop several tasks at once, or a blocking call on
 * its own terms, makes one and hands it over:
 *
 *     const stop = new Cancellable();
 *     t.Start(data, stop);
 *     stop.Cancel();
 *
 * The value is the same on both sides of a worker: the JS object on the main
 * thread and `this.Cancellable` inside `Run` wrap one `GCancellable`, which is
 * a GIO refcounted object safe to share between threads.  Cancelling it makes
 * `Cancelled` true everywhere and wakes the blocking calls that take it.
 */
#include "bta.h"

typedef struct {
    GCancellable *cancel;
} BtaCancellable;

static JSClassID cancellable_class_id;

static void cancellable_finalizer(JSRuntime *rt, JSValue val)
{
    BtaCancellable *c = JS_GetOpaque(val, cancellable_class_id);

    (void)rt;
    if (!c)
        return;
    g_clear_object(&c->cancel);
    js_free_rt(rt, c);
}

static JSClassDef cancellable_class = {
    "Cancellable",
    .finalizer = cancellable_finalizer,
};

static BtaCancellable *cancellable_of(JSValueConst v)
{
    if (JS_VALUE_GET_TAG(v) != JS_TAG_OBJECT)
        return NULL;
    return JS_GetOpaque(v, cancellable_class_id);
}

static JSValue cancellable_construct(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv)
{
    (void)argc;
    (void)argv;

    JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    JSValue obj;

    if (JS_IsException(proto))
        return proto;
    obj = JS_NewObjectProtoClass(ctx, proto, cancellable_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;

    BtaCancellable *c = js_mallocz(ctx, sizeof *c);

    if (!c) {
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }
    c->cancel = g_cancellable_new();
    if (!c->cancel) {
        js_free(ctx, c);
        JS_FreeValue(ctx, obj);
        return JS_ThrowPlainError(ctx, "Cancellable: out of memory");
    }
    JS_SetOpaque(obj, c);
    return obj;
}

static JSValue cancellable_cancel(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    BtaCancellable *c = cancellable_of(this_val);

    (void)argc;
    (void)argv;
    if (!c)
        return JS_ThrowTypeError(ctx, "Cancel: not a Cancellable");
    g_cancellable_cancel(c->cancel);
    return JS_UNDEFINED;
}

static JSValue cancellable_get_cancelled(JSContext *ctx, JSValueConst this_val)
{
    BtaCancellable *c = cancellable_of(this_val);

    if (!c)
        return JS_ThrowTypeError(ctx, "Cancelled: not a Cancellable");
    return JS_NewBool(ctx, g_cancellable_is_cancelled(c->cancel));
}

static const JSCFunctionListEntry cancellable_props[] = {
    /* Cancel()
     *   raises the signal; idempotent. Every task and blocking call holding it
     *   sees `Cancelled` and returns as soon as it can
     */
    JS_CFUNC_DEF("Cancel", 0, cancellable_cancel),
    /* Cancelled -> boolean
     *   whether the signal has been raised; read-only
     */
    JS_CGETSET_DEF("Cancelled", cancellable_get_cancelled, NULL),
};

/* A JS wrapper around an existing GIO signal.  Takes its own reference, so the
 * worker's wrapper and the main thread's object can outlive each other. */
JSValue bta_cancellable_new(JSContext *ctx, GCancellable *cancel)
{
    JSValue proto = JS_GetClassProto(ctx, cancellable_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, cancellable_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;

    BtaCancellable *c = js_mallocz(ctx, sizeof *c);

    if (!c) {
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }
    c->cancel = cancel ? g_object_ref(cancel) : g_cancellable_new();
    JS_SetOpaque(obj, c);
    return obj;
}

/* The GIO signal behind a JS value, or NULL when it is not a Cancellable.
 * Borrowed. */
GCancellable *bta_cancellable_get(JSContext *ctx, JSValueConst v)
{
    BtaCancellable *c = cancellable_of(v);

    (void)ctx;
    return c ? c->cancel : NULL;
}

/*
 * A trailing `Cancellable`: the one road by which a call is handed one.
 *
 * When the last of more than `fixed` arguments is a Cancellable, its signal is
 * put in `*out` and `*argc` drops by one, so the rest of the function reads
 * its arguments as if the token had not been there.  Borrowed: `argv` holds
 * it for the length of the call.  NULL when there is none; false, with a
 * TypeError naming `who`, when one is somewhere other than last.
 *
 * An argument and not an option, for two reasons.  An option is read through
 * whatever getter the object has, which may hand out a token nothing else
 * holds -- freed with its wrapper the moment the runtime let go of the value.
 * And a stop that only asks cancels nothing the caller did not hand over:
 * inside a task, `Stop` reaches a blocking call because `Run` passed
 * `this.Cancellable`, and a call `Run` makes to wind down after `Stopping` is
 * left alone -- until the insisting stage, whose signal every blocking call
 * hears (`bta_cancel_scope`).
 */
bool bta_cancellable_arg(JSContext *ctx, int *argc, JSValueConst *argv,
                         int fixed, const char *who, GCancellable **out)
{
    *out = NULL;

    /* A trailing `undefined` is an argument not given -- what a wrapper that
     * forwards `(a, b, c)` passes -- so it does not hide a token before it. */
    while (*argc > fixed && JS_IsUndefined(argv[*argc - 1]))
        (*argc)--;

    BtaCancellable *c = *argc > fixed ? cancellable_of(argv[*argc - 1]) : NULL;

    if (c) {
        (*argc)--;
        *out = c->cancel;
    }

    /* **A token anywhere else is refused**, not read as the options it is
     * not: `Exec.Wait(argv, token, opts)` took the token for the options,
     * found no key on it, and the cancel never arrived. */
    for (int i = fixed; i < *argc; i++) {
        if (cancellable_of(argv[i])) {
            JS_ThrowTypeError(ctx, "%s: a Cancellable is the last argument, "
                                   "after the options", who);
            return false;
        }
    }
    return true;
}

/* `{ Cancellable }` in an options object is the spelling that used to work:
 * refused with a sentence naming the argument, rather than quietly ignored --
 * an ignored token is a cancel that never arrives. */
bool bta_cancellable_not_option(JSContext *ctx, JSValueConst opts,
                                const char *who)
{
    if (!JS_IsObject(opts))
        return true;

    JSValue v = JS_GetPropertyStr(ctx, opts, "Cancellable");

    if (JS_IsException(v))
        return false;

    /* `null` is the absent value it always was: `{ Cancellable: x || null }`
     * names no token, and refusing it would refuse code that has none. */
    bool set = !JS_IsUndefined(v) && !JS_IsNull(v);

    JS_FreeValue(ctx, v);
    if (set) {
        JS_ThrowTypeError(ctx, "%s: a Cancellable is the last argument, "
                               "not an option", who);
        return false;
    }
    return true;
}

static void cancellable_forward(GCancellable *from, gpointer data)
{
    (void)from;
    g_cancellable_cancel(data);
}

/* Chain two GIO signals: `to` is cancelled when `from` is.  The handler id is
 * for `g_cancellable_disconnect`. */
gulong bta_cancellable_link(GCancellable *from, GCancellable *to)
{
    if (!from || !to)
        return 0;
    return g_cancellable_connect(from, G_CALLBACK(cancellable_forward), to, NULL);
}

/*
 * The signal a blocking call passes to GIO: the token it was handed, joined
 * with the worker's *end now* signal (`bta_task_hard_cancellable`), so a
 * task's `Timeout` and `KillAfter` reach a call handed nothing.
 *
 * No allocation in the common cases: on the main thread the answer is the
 * token itself, and in a worker handed none it is the job's signal.  Only a
 * worker call handed a token makes a third, linked to both.  Every return
 * path of the caller ends the scope.
 */
GCancellable *bta_cancel_scope(JSContext *ctx, GCancellable *given,
                               BtaCancelScope *s)
{
    GCancellable *hard = bta_task_hard_cancellable(ctx);

    *s = (BtaCancelScope){ 0 };
    if (!hard)
        return s->use = given;
    if (!given)
        return s->use = hard;

    s->use    = g_cancellable_new();
    s->given  = given;
    s->hard   = hard;
    s->link_g = bta_cancellable_link(given, s->use);
    s->link_h = bta_cancellable_link(hard, s->use);
    return s->use;
}

void bta_cancel_scope_end(BtaCancelScope *s)
{
    if (!s->given)
        return;                 /* nothing was made: `use` is borrowed */
    if (s->link_g)
        g_cancellable_disconnect(s->given, s->link_g);
    if (s->link_h)
        g_cancellable_disconnect(s->hard, s->link_h);
    g_clear_object(&s->use);
    s->given = NULL;
}

void bta_cancellable_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &cancellable_class_id);
    JS_NewClass(rt, cancellable_class_id, &cancellable_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, cancellable_props,
                               G_N_ELEMENTS(cancellable_props));
    JS_SetClassProto(ctx, cancellable_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, cancellable_construct, "Cancellable", 0,
                                    JS_CFUNC_constructor, 0);

    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Cancellable", ctor);
}
