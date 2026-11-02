/*
 * Cancellable -- a cancellation signal a program can share.
 *
 * The runtime's own `Task.Start` creates one per job and `Stop()` raises it.
 * A program that wants to stop several tasks at once, or a blocking call on
 * its own terms, makes one and hands it over:
 *
 *     const stop = new Cancellable();
 *     t.Start(data, { Cancellable: stop });
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
