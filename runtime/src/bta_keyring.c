/*
 * Keyring -- the system's secret store, so a token is not a plain file.
 *
 *     Keyring.Provider
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
 * **The calls are asynchronous, and they have to be.** A vault may be locked:
 * a synchronous lookup would freeze every window and every timer until the user
 * answered a prompt, or until a service that is not there timed out. So each
 * verb takes a callback and returns at once, and the answer arrives on the
 * loop -- the same bargain `Http` and `Clipboard.Paste` make. A callback takes
 * **one value**: `Store`/`Delete` answer whether it worked and `Lookup` the
 * secret or `null`, so an error is folded into that value and not a second
 * argument to document.
 *
 * **One API, one provider per build**, named by `Keyring.Provider`:
 *
 * - `"SecretService"` -- a Linux build with libsecret, the freedesktop vault;
 * - `"File"` -- a Linux build without it, the floor: a `0600` file under
 *   `Application.ConfigDirectory/secrets/`, unencrypted and exactly as strong
 *   as the user's file permissions;
 * - `"CredentialManager"` -- Windows, `CredWriteW`/`CredReadW`/`CredDeleteW`;
 * - `"Keychain"` -- macOS, `SecItemAdd`/`SecItemCopyMatching`/`SecItemDelete`.
 *
 * There is no runtime fallback: a secret is seen only by the provider that
 * stored it, so a call never straddles two stores. `File` is a floor and not a
 * choice -- only the Linux build without libsecret uses it. The names are
 * percent-encoded once in every provider, refuse at 255 bytes, and a value
 * longer than 2560 bytes is refused uniformly (Windows' own Credential Manager
 * limit) so one program stores the same secrets everywhere.
 *
 * **A `main` project can use it, and its answer is owed.** `bta_keyring_pending`
 * counts the calls in flight and the console loop waits on it, because the
 * vault is not a window: a tool that reads a stored token has no display and
 * still has to wait. A worker does not install it -- the callback belongs to the
 * main loop, like `Http` -- so a `Task` cannot call it.
 */

#include "bta.h"

#include <string.h>
#include <glib/gstdio.h>

#ifdef BTA_HAVE_LIBSECRET
#include <libsecret/secret.h>
#endif

#ifdef G_OS_WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincred.h>
#endif

#ifdef __APPLE__
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

#ifndef G_OS_WIN32
#include <unistd.h>
#endif

#define KEYRING_NAME_MAX  255
#define KEYRING_VALUE_MAX 2560

#if defined(G_OS_WIN32)
#define KEYRING_PROVIDER "CredentialManager"
#elif defined(__APPLE__)
#define KEYRING_PROVIDER "Keychain"
#elif defined(BTA_HAVE_LIBSECRET)
#define KEYRING_PROVIDER "SecretService"
#else
#define KEYRING_PROVIDER "File"
#endif

/* One call in flight. The callback is a strong reference the collector cannot
 * see, so every exit path frees it -- the answer, a failure, teardown. The
 * names are kept in both spellings: raw for the Secret Service and a browser's
 * label, encoded for the File path, the Windows TargetName and the Keychain
 * service. */
typedef struct {
    JSContext    *ctx;
    JSValue       cb;
    GCancellable *cancel;      /* SecretService */
    char         *service;
    char         *key;
    char         *enc_service;
    char         *enc_key;
    char         *value;       /* Store only, UTF-8 bytes */
    gsize         value_len;
    guint         idle_id;     /* the synchronous providers' answer */
} KeyringJob;

static GList *keyring_jobs;

#ifdef BTA_HAVE_LIBSECRET
static SecretSchema *keyring_schema;
#endif

static void keyring_job_free(KeyringJob *job)
{
    keyring_jobs = g_list_remove(keyring_jobs, job);
    if (job->idle_id)
        g_source_remove(job->idle_id);
    JS_FreeValue(job->ctx, job->cb);
    g_clear_object(&job->cancel);
    g_free(job->service);
    g_free(job->key);
    g_free(job->enc_service);
    g_free(job->enc_key);
    g_free(job->value);
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
    job->idle_id = 0;   /* the source is running, or there is none */
    JSValue r = JS_Call(job->ctx, job->cb, JS_UNDEFINED, 1, &arg);

    if (JS_IsException(r))
        bta_dump_error(job->ctx);
    JS_FreeValue(job->ctx, r);
    JS_FreeValue(job->ctx, arg);
    bta_drain_jobs(JS_GetRuntime(job->ctx));
    keyring_job_free(job);
}

static bool keyring_text(JSContext *ctx, JSValueConst v, const char *who,
                         const char *what, char **out)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "%s: %s is text", who, what);
        return false;
    }
    const char *s = JS_ToCString(ctx, v);

    if (!s)
        return false;
    if (!*s) {
        JS_FreeCString(ctx, s);
        JS_ThrowRangeError(ctx, "%s: %s is not empty text", who, what);
        return false;
    }
    *out = g_strdup(s);
    JS_FreeCString(ctx, s);
    return true;
}

static char *keyring_encode(const char *s)
{
    GString *out = g_string_sized_new(strlen(s));

    for (const guchar *p = (const guchar *)s; *p; p++) {
        if ((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
            (*p >= '0' && *p <= '9') || *p == '.' || *p == '_' || *p == '-')
            g_string_append_c(out, (char)*p);
        else
            g_string_append_printf(out, "%%%02X", *p);
    }
    return g_string_free(out, FALSE);
}

static bool keyring_names(JSContext *ctx, const char *who, JSValueConst sv,
                          JSValueConst kv, KeyringJob *job)
{
    if (!keyring_text(ctx, sv, who, "service", &job->service))
        return false;
    if (!keyring_text(ctx, kv, who, "key", &job->key))
        return false;

    job->enc_service = keyring_encode(job->service);
    job->enc_key     = keyring_encode(job->key);
    if (strlen(job->enc_service) > KEYRING_NAME_MAX) {
        JS_ThrowRangeError(ctx, "%s: service is longer than %d bytes once "
                                "encoded", who, KEYRING_NAME_MAX);
        return false;
    }
    if (strlen(job->enc_key) > KEYRING_NAME_MAX) {
        JS_ThrowRangeError(ctx, "%s: key is longer than %d bytes once "
                                "encoded", who, KEYRING_NAME_MAX);
        return false;
    }
    return true;
}

static bool keyring_value(JSContext *ctx, const char *who, JSValueConst v,
                          KeyringJob *job)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "%s: value is text", who);
        return false;
    }
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v);

    if (!s)
        return false;
    if (len > KEYRING_VALUE_MAX) {
        JS_FreeCString(ctx, s);
        JS_ThrowRangeError(ctx, "%s: value is longer than %d bytes",
                           who, KEYRING_VALUE_MAX);
        return false;
    }
    job->value = g_malloc(len + 1);
    memcpy(job->value, s, len);
    job->value[len] = 0;
    job->value_len  = len;
    JS_FreeCString(ctx, s);
    return true;
}

static KeyringJob *keyring_prepare(JSContext *ctx, const char *who, int argc,
                                   JSValueConst *argv, int cb_index,
                                   bool with_value)
{
    if (argc <= cb_index || !JS_IsFunction(ctx, argv[cb_index])) {
        JS_ThrowTypeError(ctx, "%s(service, key%s, cb) needs the callback: the "
                               "vault is asynchronous", who,
                           with_value ? ", value" : "");
        return NULL;
    }

    KeyringJob *job = keyring_job_new(ctx, argv[cb_index]);

    if (!keyring_names(ctx, who, argv[0], argv[1], job) ||
        (with_value && !keyring_value(ctx, who, argv[2], job))) {
        keyring_job_free(job);
        return NULL;
    }
    return job;
}

/* ------------------------------------------------------------ SecretService */

#ifdef BTA_HAVE_LIBSECRET

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
    /* Nothing stored and no service to ask are one answer, `null`: a caller
     * that has a fallback cannot tell them apart. */
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

static void keyring_provider_store(KeyringJob *job)
{
    char *label = g_strdup_printf("%s — %s", job->service, job->key);

    secret_password_store(keyring_schema, SECRET_COLLECTION_DEFAULT, label,
                          job->value, job->cancel, on_keyring_store, job,
                          "service", job->service, "key", job->key, NULL);
    g_free(label);
}

static void keyring_provider_lookup(KeyringJob *job)
{
    secret_password_lookup(keyring_schema, job->cancel, on_keyring_lookup, job,
                           "service", job->service, "key", job->key, NULL);
}

static void keyring_provider_delete(KeyringJob *job)
{
    secret_password_clear(keyring_schema, job->cancel, on_keyring_delete, job,
                          "service", job->service, "key", job->key, NULL);
}

/* ------------------------------------------------------------------- File */

#elif !defined(G_OS_WIN32) && !defined(__APPLE__)

static char *keyring_file_path(KeyringJob *job, char **service_dir)
{
    const BtaApp *app  = bta_current_app();
    const char   *name = app && app->name ? app->name : "bintana";
    char         *path = g_build_filename(g_get_user_config_dir(), "bintana",
                                          name, "secrets", job->enc_service,
                                          job->enc_key, NULL);

    if (service_dir)
        *service_dir = g_path_get_dirname(path);
    return path;
}

static gboolean keyring_file_store_idle(gpointer data)
{
    KeyringJob *job = data;
    char       *service_dir = NULL;
    char       *path = keyring_file_path(job, &service_dir);
    char       *tmp  = g_strdup_printf("%s.tmp.%d", path, (int)getpid());
    bool        ok   = false;
    GError     *err  = NULL;

    if (g_mkdir_with_parents(service_dir, 0700) == 0) {
        g_chmod(service_dir, 0700);
        if (g_file_set_contents(tmp, job->value, (gssize)job->value_len, &err)) {
            g_chmod(tmp, 0600);
            if (g_rename(tmp, path) == 0)
                ok = true;
        }
    }
    if (!ok)
        g_unlink(tmp);
    g_clear_error(&err);
    g_free(tmp);
    g_free(service_dir);
    g_free(path);

    keyring_answered(job, JS_NewBool(job->ctx, ok));
    return G_SOURCE_REMOVE;
}

static gboolean keyring_file_lookup_idle(gpointer data)
{
    KeyringJob *job = data;
    char       *path = keyring_file_path(job, NULL);
    char       *contents = NULL;
    gsize       len = 0;
    GError     *err = NULL;
    JSValue     answer = JS_NULL;

    if (g_file_get_contents(path, &contents, &len, &err))
        answer = JS_NewStringLen(job->ctx, contents, len);
    g_clear_error(&err);
    g_free(contents);
    g_free(path);
    keyring_answered(job, answer);
    return G_SOURCE_REMOVE;
}

static gboolean keyring_file_delete_idle(gpointer data)
{
    KeyringJob *job = data;
    char       *service_dir = NULL;
    char       *path = keyring_file_path(job, &service_dir);
    bool        ok = g_unlink(path) == 0;

    if (ok)
        g_rmdir(service_dir);
    g_free(service_dir);
    g_free(path);
    keyring_answered(job, JS_NewBool(job->ctx, ok));
    return G_SOURCE_REMOVE;
}

static void keyring_provider_store(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_file_store_idle, job);
}

static void keyring_provider_lookup(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_file_lookup_idle, job);
}

static void keyring_provider_delete(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_file_delete_idle, job);
}

/* ------------------------------------------------------- Credential Manager */

#elif defined(G_OS_WIN32)

static wchar_t *keyring_win32_wide(const char *utf8)
{
    return (wchar_t *)g_utf8_to_utf16(utf8, -1, NULL, NULL, NULL);
}

static wchar_t *keyring_win32_target(KeyringJob *job)
{
    char    *target = g_strdup_printf("bintana/%s/%s", job->enc_service,
                                      job->enc_key);
    wchar_t *wide = keyring_win32_wide(target);

    g_free(target);
    return wide;
}

static gboolean keyring_win32_store_idle(gpointer data)
{
    KeyringJob *job = data;
    wchar_t    *target = keyring_win32_target(job);
    wchar_t    *service = keyring_win32_wide(job->service);
    CREDENTIALW cred = { 0 };
    BOOL        ok = FALSE;

    if (target && service) {
        cred.Type               = CRED_TYPE_GENERIC;
        cred.TargetName         = (LPWSTR)target;
        cred.UserName           = (LPWSTR)service;
        cred.Persist            = CRED_PERSIST_LOCAL_MACHINE;
        cred.CredentialBlobSize = (DWORD)job->value_len;
        cred.CredentialBlob     = (LPBYTE)job->value;
        ok = CredWriteW(&cred, 0);
        if (!ok)
            g_message("keyring: CredWriteW failed: %lu",
                      (unsigned long)GetLastError());
    }
    g_free(service);
    g_free(target);
    keyring_answered(job, JS_NewBool(job->ctx, ok));
    return G_SOURCE_REMOVE;
}

static gboolean keyring_win32_lookup_idle(gpointer data)
{
    KeyringJob *job = data;
    wchar_t    *target = keyring_win32_target(job);
    PCREDENTIALW cred = NULL;
    JSValue      answer = JS_NULL;

    if (target && CredReadW(target, CRED_TYPE_GENERIC, 0, &cred)) {
        answer = JS_NewStringLen(job->ctx, (const char *)cred->CredentialBlob,
                                 cred->CredentialBlobSize);
        CredFree(cred);
    } else if (target) {
        DWORD error = GetLastError();

        if (error != ERROR_NOT_FOUND)
            g_message("keyring: CredReadW failed: %lu",
                      (unsigned long)error);
    }
    g_free(target);
    keyring_answered(job, answer);
    return G_SOURCE_REMOVE;
}

static gboolean keyring_win32_delete_idle(gpointer data)
{
    KeyringJob *job = data;
    wchar_t    *target = keyring_win32_target(job);
    BOOL        ok = target && CredDeleteW(target, CRED_TYPE_GENERIC, 0);

    if (!ok && target) {
        DWORD error = GetLastError();

        if (error != ERROR_NOT_FOUND)
            g_message("keyring: CredDeleteW failed: %lu",
                      (unsigned long)error);
    }
    g_free(target);
    keyring_answered(job, JS_NewBool(job->ctx, ok));
    return G_SOURCE_REMOVE;
}

static void keyring_provider_store(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_win32_store_idle, job);
}

static void keyring_provider_lookup(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_win32_lookup_idle, job);
}

static void keyring_provider_delete(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_win32_delete_idle, job);
}

/* --------------------------------------------------------------- Keychain */

#elif defined(__APPLE__)

static CFStringRef keyring_cf_string(const char *utf8)
{
    return CFStringCreateWithCString(kCFAllocatorDefault, utf8,
                                     kCFStringEncodingUTF8);
}

static CFDataRef keyring_cf_data(KeyringJob *job)
{
    return CFDataCreate(kCFAllocatorDefault, (const UInt8 *)job->value,
                        (CFIndex)job->value_len);
}

static CFMutableDictionaryRef keyring_keychain_query(KeyringJob *job,
                                                     CFStringRef *service,
                                                     CFStringRef *account)
{
    char *service_name = g_strdup_printf("bintana/%s", job->enc_service);

    *service = keyring_cf_string(service_name);
    *account = keyring_cf_string(job->enc_key);
    g_free(service_name);
    if (!*service || !*account) {
        if (*service)
            CFRelease(*service);
        if (*account)
            CFRelease(*account);
        *service = *account = NULL;
        return NULL;
    }

    CFMutableDictionaryRef query = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);

    if (!query) {
        CFRelease(*service);
        CFRelease(*account);
        *service = *account = NULL;
        return NULL;
    }
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, *service);
    CFDictionarySetValue(query, kSecAttrAccount, *account);
    return query;
}

static gboolean keyring_keychain_store_idle(gpointer data)
{
    KeyringJob *job = data;
    CFStringRef service = NULL, account = NULL;
    CFMutableDictionaryRef query = keyring_keychain_query(job, &service, &account);
    CFDataRef value = keyring_cf_data(job);
    CFMutableDictionaryRef attributes = NULL;
    OSStatus status = errSecParam;
    bool ok = false;

    if (query && value) {
        attributes = CFDictionaryCreateMutable(
            kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks);
        CFDictionarySetValue(attributes, kSecValueData, value);
        CFDictionarySetValue(attributes, kSecAttrAccessible,
                             kSecAttrAccessibleWhenUnlocked);
        status = SecItemAdd(query, NULL);
        if (status == errSecDuplicateItem)
            status = SecItemUpdate(query, attributes);
        ok = status == errSecSuccess;
        if (!ok)
            g_message("keyring: SecItemAdd/Update failed: %d", (int)status);
    }
    if (attributes)
        CFRelease(attributes);
    if (value)
        CFRelease(value);
    if (query)
        CFRelease(query);
    if (service)
        CFRelease(service);
    if (account)
        CFRelease(account);
    keyring_answered(job, JS_NewBool(job->ctx, ok));
    return G_SOURCE_REMOVE;
}

static gboolean keyring_keychain_lookup_idle(gpointer data)
{
    KeyringJob *job = data;
    CFStringRef service = NULL, account = NULL;
    CFMutableDictionaryRef query = keyring_keychain_query(job, &service, &account);
    CFTypeRef result = NULL;
    JSValue answer = JS_NULL;

    if (query) {
        CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
        CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
        OSStatus status = SecItemCopyMatching(query, &result);

        if (status == errSecSuccess && result &&
            CFGetTypeID(result) == CFDataGetTypeID()) {
            answer = JS_NewStringLen(job->ctx,
                                     (const char *)CFDataGetBytePtr(result),
                                     (size_t)CFDataGetLength(result));
        } else if (status != errSecItemNotFound && status != errSecSuccess) {
            g_message("keyring: SecItemCopyMatching failed: %d", (int)status);
        }
    }
    if (result)
        CFRelease(result);
    if (query)
        CFRelease(query);
    if (service)
        CFRelease(service);
    if (account)
        CFRelease(account);
    keyring_answered(job, answer);
    return G_SOURCE_REMOVE;
}

static gboolean keyring_keychain_delete_idle(gpointer data)
{
    KeyringJob *job = data;
    CFStringRef service = NULL, account = NULL;
    CFMutableDictionaryRef query = keyring_keychain_query(job, &service, &account);
    OSStatus status = errSecParam;
    bool ok = false;

    if (query) {
        status = SecItemDelete(query);
        ok = status == errSecSuccess;
        if (!ok && status != errSecItemNotFound)
            g_message("keyring: SecItemDelete failed: %d", (int)status);
    }
    if (query)
        CFRelease(query);
    if (service)
        CFRelease(service);
    if (account)
        CFRelease(account);
    keyring_answered(job, JS_NewBool(job->ctx, ok));
    return G_SOURCE_REMOVE;
}

static void keyring_provider_store(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_keychain_store_idle, job);
}

static void keyring_provider_lookup(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_keychain_lookup_idle, job);
}

static void keyring_provider_delete(KeyringJob *job)
{
    job->idle_id = g_idle_add(keyring_keychain_delete_idle, job);
}

#endif

/* --------------------------------------------------------------- the verbs */

static JSValue keyring_store(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    KeyringJob *job = keyring_prepare(ctx, "Keyring.Store", argc, argv, 3, true);

    if (!job)
        return JS_EXCEPTION;
    keyring_provider_store(job);
    return JS_UNDEFINED;
}

static JSValue keyring_lookup(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    KeyringJob *job = keyring_prepare(ctx, "Keyring.Lookup", argc, argv, 2, false);

    if (!job)
        return JS_EXCEPTION;
    keyring_provider_lookup(job);
    return JS_UNDEFINED;
}

static JSValue keyring_delete(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    KeyringJob *job = keyring_prepare(ctx, "Keyring.Delete", argc, argv, 2, false);

    if (!job)
        return JS_EXCEPTION;
    keyring_provider_delete(job);
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

        if (job->cancel)
            g_cancellable_cancel(job->cancel);
        keyring_job_free(job);
    }
#ifdef BTA_HAVE_LIBSECRET
    g_clear_pointer(&keyring_schema, secret_schema_unref);
#endif
}

static const JSCFunctionListEntry keyring_props[] = {
    /* Store(service, key, value, cb)
     *   puts `value` in the provider's vault under `service` and `key`, and
     *   calls `cb(ok)` when it answers -- `false` when it could not store it.
     *   The names are percent-encoded for the provider's own key; each is
     *   refused past 255 bytes encoded, and `value` past 2560 bytes
     */
    JS_CFUNC_DEF("Store", 4, keyring_store),
    /* Lookup(service, key, cb)
     *   reads what `Store` saved, and calls `cb(value)` -- the text, or `null`
     *   when nothing is stored **or** the provider cannot be asked
     */
    JS_CFUNC_DEF("Lookup", 3, keyring_lookup),
    /* Delete(service, key, cb)
     *   forgets it, and calls `cb(ok)`: `false` when there was nothing under
     *   those names or the provider could not be asked. Deleting what is not
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
    /* Provider
     *   which store this build uses: `"SecretService"` on a Linux build with
     *   libsecret, `"File"` on a Linux build without it, `"CredentialManager"`
     *   on Windows and `"Keychain"` on macOS. A secret is seen only by the
     *   provider that stored it, so a caller never mixes two stores in one
     *   program
     */
    JS_SetPropertyStr(ctx, keyring, "Provider",
                      JS_NewString(ctx, KEYRING_PROVIDER));
    JS_SetPropertyStr(ctx, global, "Keyring", keyring);
}
