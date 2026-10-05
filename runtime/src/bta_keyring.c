/*
 * Keyring -- the system's secret store, so a token is not a plain file.
 *
 *     Keyring.Available
 *     Keyring.Store(service, key, value, cb)     // cb(ok)
 *     Keyring.Lookup(service, key, cb)           // cb(value)  text or null
 *     Keyring.Delete(service, key, cb)           // cb(ok)
 *
 * `service` names the program and `key` the thing within it, so one
 * application may hold one secret per server: a Zabbix token is stored as
 * `Store(Application.Id, url, token, cb)`. The label a keyring browser shows
 * is made of the two, and is **data and not prose**: nothing here goes through
 * a catalogue.
 *
 * **The calls are asynchronous, and they have to be.** The vault is a service
 * on the session bus, and it may be locked: a synchronous lookup would freeze
 * every window and every timer until the user answered a prompt, or until a
 * bus that is not there timed out. So each verb takes a callback and returns
 * at once, and the answer arrives on the loop -- the same bargain `Http` and
 * `Clipboard.Paste` make. A callback takes **one value**: `Store`/`Delete`
 * answer whether it worked and `Lookup` the secret or `null`, so an error is
 * folded into that value and not a second argument to document.
 *
 * **Optional at build time, the sqlite mould.** Without libsecret `Keyring`
 * exists, `Available` is false and every verb refuses with a sentence naming
 * the package -- a class that is not there would be an error three lines away
 * from the reason. libsecret is the freedesktop Secret Service API; a desktop
 * that has no service running is the same answer at run time, and `Available`
 * cannot see that, so a caller treats a refusal like an empty vault.
 *
 * **A `main` project can use it, and its answer is owed.** `bta_keyring_pending`
 * counts the calls in flight and the console loop waits on it, because the
 * vault is not a window: a tool that reads a stored token has no display and
 * still has to wait for the bus. A worker does not install it -- the callback
 * belongs to the main loop, like `Http` -- so a `Task` cannot call it.
 */

#include "bta.h"

#ifdef BTA_HAVE_LIBSECRET

#include <libsecret/secret.h>

/* The schema, and it is the vault's name and not a person's. One entry per
 * (service, key); the label is what a browser shows. Made with the library's
 * own constructor rather than a static initializer: the struct's private tail
 * is the library's business and a written-out zero for each field is a build
 * that breaks the day it grows one. Created once at init and released after
 * the calls are cancelled. */
static SecretSchema *keyring_schema;

/* One call in flight. The callback is a strong reference the collector cannot
 * see, so every exit path frees it -- the answer, a failure, teardown. */
typedef struct {
    JSContext    *ctx;
    JSValue       cb;
    GCancellable *cancel;
} KeyringJob;

static GList *keyring_jobs;

static void keyring_job_free(KeyringJob *job)
{
    keyring_jobs = g_list_remove(keyring_jobs, job);
    JS_FreeValue(job->ctx, job->cb);
    g_clear_object(&job->cancel);
    g_free(job);
}

static KeyringJob *keyring_job_new(JSContext *ctx, JSValueConst cb)
{
    KeyringJob *job = g_new0(KeyringJob, 1);

    job->ctx    = ctx;
    job->cb     = JS_DupValue(ctx, cb);
    job->cancel = g_cancellable_new();
    keyring_jobs = g_list_prepend(keyring_jobs, job);
    return job;
}

/* The answer, delivered and released. `arg` is handed over: a string is freed
 * with the call, a boolean is not a reference at all. */
static void keyring_answered(KeyringJob *job, JSValue arg)
{
    JSValue r = JS_Call(job->ctx, job->cb, JS_UNDEFINED, 1, &arg);

    if (JS_IsException(r))
        bta_dump_error(job->ctx);
    JS_FreeValue(job->ctx, r);
    JS_FreeValue(job->ctx, arg);
    bta_drain_jobs(JS_GetRuntime(job->ctx));
    keyring_job_free(job);
}

static void on_keyring_store(GObject *src, GAsyncResult *res, gpointer user_data)
{
    KeyringJob *job = user_data;
    GError     *err = NULL;
    gboolean    ok  = secret_password_store_finish(res, &err);

    g_clear_error(&err);

    /* Teardown cancels the call and drops the job with its context, so there
     * is no JS left to answer. Asked by membership -- the pointer is only
     * compared, never read -- because the job may be gone by the time the
     * cancelled call answers. */
    if (!g_list_find(keyring_jobs, job))
        return;

    keyring_answered(job, JS_NewBool(job->ctx, ok));
}

static void on_keyring_lookup(GObject *src, GAsyncResult *res, gpointer user_data)
{
    KeyringJob *job   = user_data;
    GError     *err   = NULL;
    gchar      *value = secret_password_lookup_finish(res, &err);

    g_clear_error(&err);

    if (!g_list_find(keyring_jobs, job)) {
        if (value)
            secret_password_free(value);
        return;
    }

    /* Nothing stored and no service to ask are one answer, `null`: the caller
     * that has a fallback cannot tell them apart, and one that cares asks
     * `Available` first. */
    keyring_answered(job, value ? JS_NewString(job->ctx, value) : JS_NULL);
    if (value)
        secret_password_free(value);
}

static void on_keyring_delete(GObject *src, GAsyncResult *res, gpointer user_data)
{
    KeyringJob *job = user_data;
    GError     *err = NULL;
    gboolean    ok  = secret_password_clear_finish(res, &err);

    g_clear_error(&err);

    if (!g_list_find(keyring_jobs, job))
        return;

    keyring_answered(job, JS_NewBool(job->ctx, ok));
}

/* An argument that has to be text. `JS_ToCString` converts anything, so a
 * number would become a service called "5" and a lookup that finds nothing
 * would look like a vault that is empty. */
static bool keyring_text(JSContext *ctx, JSValueConst v, const char *who,
                         const char *what, const char **out)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "%s: %s is text", who, what);
        return false;
    }
    *out = JS_ToCString(ctx, v);
    return *out != NULL;
}

static JSValue keyring_store(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *who = "Keyring.Store";
    const char *service = NULL, *key = NULL, *value = NULL;

    if (argc < 4 || !JS_IsFunction(ctx, argv[3]))
        return JS_ThrowTypeError(ctx, "%s(service, key, value, cb) needs the "
                                      "callback: the vault is asynchronous", who);
    if (!keyring_text(ctx, argv[0], who, "service", &service))
        return JS_EXCEPTION;
    if (!keyring_text(ctx, argv[1], who, "key", &key)) {
        JS_FreeCString(ctx, service);
        return JS_EXCEPTION;
    }
    if (!keyring_text(ctx, argv[2], who, "value", &value)) {
        JS_FreeCString(ctx, service);
        JS_FreeCString(ctx, key);
        return JS_EXCEPTION;
    }

    KeyringJob *job = keyring_job_new(ctx, argv[3]);
    char       *label = g_strdup_printf("%s — %s", service, key);

    secret_password_store(keyring_schema, SECRET_COLLECTION_DEFAULT, label,
                          value, job->cancel, on_keyring_store, job,
                          "service", service, "key", key, NULL);

    g_free(label);
    JS_FreeCString(ctx, service);
    JS_FreeCString(ctx, key);
    JS_FreeCString(ctx, value);
    return JS_UNDEFINED;
}

static JSValue keyring_lookup(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *who = "Keyring.Lookup";
    const char *service = NULL, *key = NULL;

    if (argc < 3 || !JS_IsFunction(ctx, argv[2]))
        return JS_ThrowTypeError(ctx, "%s(service, key, cb) needs the "
                                      "callback: the vault is asynchronous", who);
    if (!keyring_text(ctx, argv[0], who, "service", &service))
        return JS_EXCEPTION;
    if (!keyring_text(ctx, argv[1], who, "key", &key)) {
        JS_FreeCString(ctx, service);
        return JS_EXCEPTION;
    }

    KeyringJob *job = keyring_job_new(ctx, argv[2]);

    secret_password_lookup(keyring_schema, job->cancel, on_keyring_lookup, job,
                           "service", service, "key", key, NULL);

    JS_FreeCString(ctx, service);
    JS_FreeCString(ctx, key);
    return JS_UNDEFINED;
}

static JSValue keyring_delete(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *who = "Keyring.Delete";
    const char *service = NULL, *key = NULL;

    if (argc < 3 || !JS_IsFunction(ctx, argv[2]))
        return JS_ThrowTypeError(ctx, "%s(service, key, cb) needs the "
                                      "callback: the vault is asynchronous", who);
    if (!keyring_text(ctx, argv[0], who, "service", &service))
        return JS_EXCEPTION;
    if (!keyring_text(ctx, argv[1], who, "key", &key)) {
        JS_FreeCString(ctx, service);
        return JS_EXCEPTION;
    }

    KeyringJob *job = keyring_job_new(ctx, argv[2]);

    secret_password_clear(keyring_schema, job->cancel, on_keyring_delete, job,
                          "service", service, "key", key, NULL);

    JS_FreeCString(ctx, service);
    JS_FreeCString(ctx, key);
    return JS_UNDEFINED;
}

guint bta_keyring_pending(void)
{
    return g_list_length(keyring_jobs);
}

void bta_keyring_cleanup(void)
{
    while (keyring_jobs) {
        KeyringJob *job = keyring_jobs->data;

        /* The call is cancelled and the job dropped; the completion answers
         * into a pointer it only compares, never reads. */
        g_cancellable_cancel(job->cancel);
        keyring_job_free(job);
    }
    g_clear_pointer(&keyring_schema, secret_schema_unref);
}

#else  /* no libsecret at build time */

static JSValue keyring_unavailable(JSContext *ctx, const char *who)
{
    return JS_ThrowInternalError(ctx,
        "%s: this runtime was built without libsecret, so there is no keyring "
        "to ask. Install libsecret's development package and build again -- "
        "CMake finds it with pkg-config and prints which it found", who);
}

static JSValue keyring_store(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    return keyring_unavailable(ctx, "Keyring.Store");
}

static JSValue keyring_lookup(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    return keyring_unavailable(ctx, "Keyring.Lookup");
}

static JSValue keyring_delete(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    return keyring_unavailable(ctx, "Keyring.Delete");
}

guint bta_keyring_pending(void)
{
    return 0;
}

void bta_keyring_cleanup(void)
{
}

#endif

static const JSCFunctionListEntry keyring_props[] = {
    /* Store(service, key, value, cb)
     *   puts `value` in the system's keyring under `service` and `key`, and
     *   calls `cb(ok)` when the vault answers -- `false` when it could not
     *   store it, which is what a machine with no secret service says. The
     *   label a keyring browser shows is made of the two names
     */
    JS_CFUNC_DEF("Store", 4, keyring_store),
    /* Lookup(service, key, cb)
     *   reads what `Store` saved, and calls `cb(value)` -- the text, or `null`
     *   when nothing is stored **or** the vault cannot be asked
     */
    JS_CFUNC_DEF("Lookup", 3, keyring_lookup),
    /* Delete(service, key, cb)
     *   forgets it, and calls `cb(ok)`: `false` when there was nothing under
     *   those names or the vault could not be asked. Deleting what is not
     *   there is not an error
     */
    JS_CFUNC_DEF("Delete", 3, keyring_delete),
};

void bta_keyring_init(JSContext *ctx, JSValue global)
{
    JSValue keyring = JS_NewObject(ctx);

#ifdef BTA_HAVE_LIBSECRET
    if (!keyring_schema)
        keyring_schema = secret_schema_new("org.bintana.Keyring", SECRET_SCHEMA_NONE,
                                           "service", SECRET_SCHEMA_ATTRIBUTE_STRING,
                                           "key",     SECRET_SCHEMA_ATTRIBUTE_STRING,
                                           NULL);
#endif
    JS_SetPropertyFunctionList(ctx, keyring, keyring_props, G_N_ELEMENTS(keyring_props));
#ifdef BTA_HAVE_LIBSECRET
    /* Available
     *   whether this build has libsecret. It says nothing about whether the
     *   machine is running a secret service -- a headless session has none --
     *   so a caller treats a failed `Lookup` like an empty vault
     */
    JS_SetPropertyStr(ctx, keyring, "Available", JS_NewBool(ctx, true));
#else
    /* Available
     *   whether this build has libsecret. It says nothing about whether the
     *   machine is running a secret service -- a headless session has none --
     *   so a caller treats a failed `Lookup` like an empty vault
     */
    JS_SetPropertyStr(ctx, keyring, "Available", JS_NewBool(ctx, false));
#endif
    JS_SetPropertyStr(ctx, global, "Keyring", keyring);
}
