/*
 * Key -- a private key the program signs with, wherever it is.
 *
 *     const key = Key.Load("pkcs11:token=Firma;object=signer", pin);  // a card, a token
 *     const key = Key.Load("yo.p12", password);                        // a file
 *     doc.Sign("firmado.pdf", { Key: key });
 *
 * **One verb for every place a key lives.** A smart card, a USB token or a
 * software token is a `pkcs11:` URI (RFC 7512), as `p11tool --list-all` prints
 * it; a file is a path to a PKCS#12 (`.p12`, `.pfx`), or to a PEM or DER key,
 * encrypted PKCS#8 included. The second argument is the PIN or the password,
 * whichever that place asks for. `Key.Tokens()` says which tokens are plugged
 * in and who can sign on each, with no PIN: certificates are public.
 *
 * **A token's key never leaves the token.** `Sign(digest)` hands the digest
 * to the card and answers what it signed; the runtime holds a handle and the
 * PIN, not the key. A file's key is in memory, as it is in any program that
 * reads one. The PIN is kept for the key's life -- a token asks for it again
 * at each signature -- and wiped by `Close()` or the collector.
 *
 * **`Key` is `PdfDocument.Sign`'s `Signer` made a value**, never the only way
 * to sign: `Sign` takes any `{ Certificate, Sign(digest, algorithm) }`, and a
 * remote service is a function. It signs a **digest** -- what a PDF, a CMS or
 * XAdES signature asks of a key -- with PKCS#1 v1.5 for RSA and DER for ECDSA.
 *
 * Through GnuTLS, which is `Cipher`'s library and libsoup's, and p11-kit's
 * module list: the tokens are the ones every GnuTLS program on the machine
 * sees. Without GnuTLS the global exists, `Available` is false and each verb
 * refuses naming the package.
 */
#include "bta.h"

#include <string.h>

#ifdef BTA_HAVE_GNUTLS
#include <gnutls/abstract.h>
#include <gnutls/gnutls.h>
#include <gnutls/pkcs11.h>
#include <gnutls/pkcs12.h>
#include <gnutls/x509.h>
#endif

static JSClassID key_class_id;

typedef struct {
    char *source;              /* the path or URI it was loaded from */
    bool  open;
#ifdef BTA_HAVE_GNUTLS
    gnutls_privkey_t key;
    gnutls_datum_t   cert;     /* DER; data NULL when there is none */
    char            *pin;      /* what the token or file was opened with */
    bool             pin_asked;   /* a token wanted a PIN and had none */
    bool             pin_wrong;   /* ...or had one it refused */
#endif
} Key;

/* ------------------------------------------------------------- lifetime */

#ifdef BTA_HAVE_GNUTLS
static void wipe(char **s)
{
    if (*s) {
        explicit_bzero(*s, strlen(*s));
        g_free(*s);
        *s = NULL;
    }
}

static void key_release(Key *k)
{
    if (k->key) {
        gnutls_privkey_deinit(k->key);
        k->key = NULL;
    }
    gnutls_free(k->cert.data);
    k->cert.data = NULL;
    k->cert.size = 0;
    wipe(&k->pin);
}
#endif

static void key_finalizer(JSRuntime *rt, JSValue val)
{
    Key *k = JS_GetOpaque(val, key_class_id);

    (void)rt;
    if (!k)
        return;
#ifdef BTA_HAVE_GNUTLS
    key_release(k);
#endif
    g_free(k->source);
    g_free(k);
}

static JSClassDef key_class = {
    "Key",
    .finalizer = key_finalizer,
};

static Key *key_of(JSContext *ctx, JSValueConst this_val)
{
    Key *k = JS_GetOpaque2(ctx, this_val, key_class_id);

    if (!k)
        return NULL;
    if (!k->open) {
        JS_ThrowTypeError(ctx, "this Key is closed");
        return NULL;
    }
    return k;
}

G_GNUC_UNUSED static JSValue no_gnutls(JSContext *ctx, const char *who)
{
    return JS_ThrowPlainError(ctx,
        "Key.%s: this runtime was built without GnuTLS, which is what reads a "
        "key and talks to a token -- install gnutls's development package and "
        "build again", who);
}

#ifdef BTA_HAVE_GNUTLS

/* ------------------------------------------------------------- the PIN */

/*
 * GnuTLS asks for the PIN when a token wants one, at loading and again at a
 * signature. It is answered once per ask: a refused PIN is not offered again,
 * since a token locks itself after a few wrong ones.
 */
static int key_pin(void *data, int attempt, const char *token_url,
                   const char *token_label, unsigned int flags,
                   char *pin, size_t pin_max)
{
    Key *k = data;

    (void)token_url; (void)token_label;
    if (flags & GNUTLS_PIN_WRONG || attempt > 0) {
        k->pin_wrong = true;
        return -1;
    }
    if (!k->pin) {
        k->pin_asked = true;
        return -1;
    }
    size_t n = strlen(k->pin);
    if (n + 1 > pin_max)
        return -1;
    memcpy(pin, k->pin, n + 1);
    return 0;
}

/* ----------------------------------------------------- a certificate's names */

static char *crt_name(gnutls_x509_crt_t crt, bool issuer)
{
    char   buf[512];
    size_t size = sizeof buf;
    int    r    = issuer
        ? gnutls_x509_crt_get_issuer_dn_by_oid(crt, GNUTLS_OID_X520_COMMON_NAME, 0, 0, buf, &size)
        : gnutls_x509_crt_get_dn_by_oid(crt, GNUTLS_OID_X520_COMMON_NAME, 0, 0, buf, &size);

    return g_strdup(r < 0 ? "" : buf);
}

/* The key URI of a certificate's URI on a token: the same id, a key's type. */
static char *key_url_of(const char *cert_url)
{
    const char *at = strstr(cert_url, "type=cert");

    if (!at)
        return g_strconcat(cert_url, ";type=private", NULL);
    return g_strdup_printf("%.*stype=private%s", (int)(at - cert_url), cert_url,
                           at + strlen("type=cert"));
}

/* ------------------------------------------------------------- loading */

static void keep_certificate(Key *k, gnutls_x509_crt_t crt)
{
    gnutls_x509_crt_export2(crt, GNUTLS_X509_FMT_DER, &k->cert);
}

/*
 * A key on a token. The URI may name the key, or only the token: then the
 * token must hold exactly one, and two are refused with their URIs, since
 * guessing which key signs is not the runtime's to do.
 */
static bool load_token(JSContext *ctx, Key *k, const char *uri)
{
    gnutls_pkcs11_obj_t *objs = NULL;
    unsigned int         n    = 0;
    char                *url  = NULL;

    gnutls_pkcs11_set_pin_function(key_pin, k);
    int r = gnutls_pkcs11_obj_list_import_url4(&objs, &n, uri,
                GNUTLS_PKCS11_OBJ_FLAG_PRIVKEY | GNUTLS_PKCS11_OBJ_FLAG_LOGIN);
    gnutls_pkcs11_set_pin_function(NULL, NULL);

    if (r < 0 || n == 0) {
        for (unsigned i = 0; i < n; i++)
            gnutls_pkcs11_obj_deinit(objs[i]);
        gnutls_free(objs);
        if (k->pin_wrong)
            JS_ThrowPlainError(ctx, "Key.Load: the token refused that PIN");
        else if (k->pin_asked)
            JS_ThrowPlainError(ctx, "Key.Load: the token wants its PIN -- "
                                    "Key.Load(uri, pin)");
        else
            bta_throw_text(ctx, "Key.Load: no private key answers '%s' -- "
                                    "Key.Tokens() says which tokens are there", uri);
        return false;
    }

    if (n > 1) {
        GString *names = g_string_new(NULL);
        for (unsigned i = 0; i < n; i++) {
            char *u = NULL;
            if (gnutls_pkcs11_obj_export_url(objs[i], GNUTLS_PKCS11_URL_GENERIC, &u) == 0) {
                g_string_append_printf(names, "\n  %s", u);
                gnutls_free(u);
            }
        }
        for (unsigned i = 0; i < n; i++)
            gnutls_pkcs11_obj_deinit(objs[i]);
        gnutls_free(objs);
        bta_throw_text(ctx, "Key.Load: '%s' names %u keys -- name one:%s",
                       uri, n, names->str);
        g_string_free(names, TRUE);
        return false;
    }

    r = gnutls_pkcs11_obj_export_url(objs[0], GNUTLS_PKCS11_URL_GENERIC, &url);
    gnutls_pkcs11_obj_deinit(objs[0]);
    gnutls_free(objs);
    if (r < 0) {
        JS_ThrowPlainError(ctx, "Key.Load: the token did not say where its key is");
        return false;
    }

    gnutls_privkey_init(&k->key);
    gnutls_privkey_set_pin_function(k->key, key_pin, k);
    r = gnutls_privkey_import_url(k->key, url, 0);
    if (r < 0) {
        gnutls_free(url);
        JS_ThrowPlainError(ctx, "Key.Load: the token would not lend its key (%s)",
                           gnutls_strerror_name(r));
        return false;
    }

    /* Its certificate is the one with its id, when the token has it. */
    const char *at = strstr(url, "type=private");
    char *cert_url = at
        ? g_strdup_printf("%.*stype=cert%s", (int)(at - url), url, at + strlen("type=private"))
        : g_strconcat(url, ";type=cert", NULL);
    gnutls_x509_crt_t crt;
    gnutls_x509_crt_init(&crt);
    if (gnutls_x509_crt_import_url(crt, cert_url, 0) == 0)
        keep_certificate(k, crt);
    gnutls_x509_crt_deinit(crt);
    g_free(cert_url);

    g_free(k->source);
    k->source = g_strdup(url);
    gnutls_free(url);
    return true;
}

/*
 * A key in a file: PKCS#12 first, which carries its certificate; then a PEM
 * or DER key, encrypted or not -- and a PEM that also holds a certificate
 * gives that one.
 */
static bool load_file(JSContext *ctx, Key *k, const char *path)
{
    gchar  *bytes = NULL;
    gsize   len   = 0;

    if (!g_file_get_contents(path, &bytes, &len, NULL)) {
        bta_throw_text(ctx, "Key.Load: there is no file '%s'", path);
        return false;
    }

    gnutls_datum_t        data = { (unsigned char *)bytes, (unsigned)len };
    bool                  pem  = g_strstr_len(bytes, (gssize)len, "-----BEGIN") != NULL;
    gnutls_x509_crt_fmt_t fmt  = pem ? GNUTLS_X509_FMT_PEM : GNUTLS_X509_FMT_DER;
    gnutls_pkcs12_t       p12;
    bool                  ok   = false;

    gnutls_pkcs12_init(&p12);
    if (gnutls_pkcs12_import(p12, &data, fmt, 0) == 0) {
        gnutls_x509_privkey_t xkey  = NULL;
        gnutls_x509_crt_t    *chain = NULL;
        unsigned int          chain_len = 0;

        if (gnutls_pkcs12_verify_mac(p12, k->pin ? k->pin : "") < 0) {
            bta_throw_text(ctx, k->pin
                ? "Key.Load: that password does not open '%s'"
                : "Key.Load: '%s' is protected -- Key.Load(path, password)", path);
        } else if (gnutls_pkcs12_simple_parse(p12, k->pin ? k->pin : "", &xkey,
                                              &chain, &chain_len, NULL, NULL, NULL, 0) < 0
                   || !xkey) {
            bta_throw_text(ctx, "Key.Load: '%s' holds no key this machine reads", path);
        } else {
            gnutls_privkey_init(&k->key);
            gnutls_privkey_import_x509(k->key, xkey, GNUTLS_PRIVKEY_IMPORT_AUTO_RELEASE);
            xkey = NULL;
            if (chain_len)
                keep_certificate(k, chain[0]);
            ok = true;
        }
        if (xkey)
            gnutls_x509_privkey_deinit(xkey);
        for (unsigned i = 0; i < chain_len; i++)
            gnutls_x509_crt_deinit(chain[i]);
        gnutls_free(chain);
        gnutls_pkcs12_deinit(p12);
        explicit_bzero(bytes, len);
        g_free(bytes);
        return ok;
    }
    gnutls_pkcs12_deinit(p12);

    gnutls_privkey_init(&k->key);
    int r = gnutls_privkey_import_x509_raw(k->key, &data, fmt, k->pin, 0);
    if (r < 0) {
        bool sealed = pem && g_strstr_len(bytes, (gssize)len, "ENCRYPTED") != NULL;
        if (sealed && !k->pin)
            bta_throw_text(ctx, "Key.Load: '%s' is encrypted -- Key.Load(path, password)", path);
        else if (sealed || r == GNUTLS_E_DECRYPTION_FAILED)
            bta_throw_text(ctx, "Key.Load: that password does not open '%s'", path);
        else
            bta_throw_text(ctx, "Key.Load: '%s' is not a key this machine reads -- "
                                    "a PKCS#12, or a PEM or DER private key", path);
    } else {
        ok = true;
        if (pem && g_strstr_len(bytes, (gssize)len, "CERTIFICATE-----")) {
            gnutls_x509_crt_t crt;
            gnutls_x509_crt_init(&crt);
            if (gnutls_x509_crt_import(crt, &data, GNUTLS_X509_FMT_PEM) == 0)
                keep_certificate(k, crt);
            gnutls_x509_crt_deinit(crt);
        }
    }
    explicit_bzero(bytes, len);
    g_free(bytes);
    return ok;
}

#endif /* BTA_HAVE_GNUTLS */

/*
 * `Key.Load(source, [pin])` -- see the static's description at the end.
 */
static JSValue key_load(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    (void)this_val;
#ifndef BTA_HAVE_GNUTLS
    (void)argc; (void)argv;
    return no_gnutls(ctx, "Load");
#else
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Key.Load(source, [pin]) takes a path or a "
                                      "pkcs11: URI");

    char *pin = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        if (!JS_IsString(argv[1]))
            return JS_ThrowTypeError(ctx, "Key.Load: the PIN or password is text");
        const char *s = JS_ToCString(ctx, argv[1]);
        if (!s)
            return JS_EXCEPTION;
        pin = g_strdup(s);
        JS_FreeCString(ctx, s);
    }

    const char *src = JS_ToCString(ctx, argv[0]);
    if (!src) {
        wipe(&pin);
        return JS_EXCEPTION;
    }

    Key *k   = g_new0(Key, 1);
    k->pin   = pin;
    k->open  = true;

    bool ok;
    if (g_str_has_prefix(src, "pkcs11:")) {
        k->source = g_strdup(src);
        ok = load_token(ctx, k, src);
    } else {
        const char *path = bta_file_path(ctx, argv[0], "Key.Load");
        ok = path != NULL;
        if (ok) {
            k->source = g_canonicalize_filename(path, NULL);
            ok = load_file(ctx, k, path);
            JS_FreeCString(ctx, path);
        }
    }
    JS_FreeCString(ctx, src);

    if (!ok) {
        key_release(k);
        g_free(k->source);
        g_free(k);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectClass(ctx, key_class_id);
    if (JS_IsException(obj)) {
        key_release(k);
        g_free(k->source);
        g_free(k);
        return obj;
    }
    JS_SetOpaque(obj, k);
    return obj;
#endif
}

/* ------------------------------------------------------------- the tokens */

#ifdef BTA_HAVE_GNUTLS
static JSValue token_text(JSContext *ctx, const char *url, gnutls_pkcs11_token_info_t what)
{
    char   buf[256];
    size_t size = sizeof buf;

    if (gnutls_pkcs11_token_get_info(url, what, buf, &size) < 0)
        return JS_NewString(ctx, "");
    return JS_NewString(ctx, g_strstrip(buf));
}

/* Who can sign on a token: its certificates that are not a CA's. */
static JSValue token_signers(JSContext *ctx, const char *url)
{
    JSValue              out  = JS_NewArray(ctx);
    gnutls_pkcs11_obj_t *objs = NULL;
    unsigned int         n    = 0;
    uint32_t             at   = 0;

    if (gnutls_pkcs11_obj_list_import_url4(&objs, &n, url, GNUTLS_PKCS11_OBJ_FLAG_CRT) < 0)
        return out;

    for (unsigned i = 0; i < n; i++) {
        gnutls_x509_crt_t crt;
        char             *curl = NULL;

        gnutls_x509_crt_init(&crt);
        if (gnutls_x509_crt_import_pkcs11(crt, objs[i]) == 0 &&
            gnutls_x509_crt_get_ca_status(crt, NULL) <= 0 &&
            gnutls_pkcs11_obj_export_url(objs[i], GNUTLS_PKCS11_URL_GENERIC, &curl) == 0) {
            char   label[256];
            size_t size = sizeof label;
            char  *key  = key_url_of(curl);
            char  *who  = crt_name(crt, false);
            char  *by   = crt_name(crt, true);
            time_t ends = gnutls_x509_crt_get_expiration_time(crt);
            JSValue one = JS_NewObject(ctx);

            if (gnutls_pkcs11_obj_get_info(objs[i], GNUTLS_PKCS11_OBJ_LABEL, label, &size) < 0)
                label[0] = 0;
            JS_SetPropertyStr(ctx, one, "Key", JS_NewString(ctx, key));
            JS_SetPropertyStr(ctx, one, "Label", JS_NewString(ctx, label));
            JS_SetPropertyStr(ctx, one, "Subject", JS_NewString(ctx, who));
            JS_SetPropertyStr(ctx, one, "Issuer", JS_NewString(ctx, by));
            JS_SetPropertyStr(ctx, one, "Expires", ends == (time_t)-1
                ? JS_NULL : JS_NewDate(ctx, (double)ends * 1000.0));
            JS_SetPropertyUint32(ctx, out, at++, one);
            g_free(key);
            g_free(who);
            g_free(by);
            gnutls_free(curl);
        }
        gnutls_x509_crt_deinit(crt);
        gnutls_pkcs11_obj_deinit(objs[i]);
    }
    gnutls_free(objs);
    return out;
}
#endif

static JSValue key_tokens(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
#ifndef BTA_HAVE_GNUTLS
    return no_gnutls(ctx, "Tokens");
#else
    JSValue  out = JS_NewArray(ctx);
    uint32_t at  = 0;

    for (unsigned seq = 0;; seq++) {
        char        *url   = NULL;
        unsigned int flags = 0;

        if (gnutls_pkcs11_token_get_url(seq, GNUTLS_PKCS11_URL_GENERIC, &url) < 0)
            break;
        /* The system's trust store is a token of CA certificates, not a
         * signer's; it is not listed. */
        if (gnutls_pkcs11_token_get_flags(url, &flags) == 0 &&
            (flags & GNUTLS_PKCS11_TOKEN_TRUSTED)) {
            gnutls_free(url);
            continue;
        }
        JSValue one = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, one, "Uri", JS_NewString(ctx, url));
        JS_SetPropertyStr(ctx, one, "Label", token_text(ctx, url, GNUTLS_PKCS11_TOKEN_LABEL));
        JS_SetPropertyStr(ctx, one, "Manufacturer",
                          token_text(ctx, url, GNUTLS_PKCS11_TOKEN_MANUFACTURER));
        JS_SetPropertyStr(ctx, one, "Model", token_text(ctx, url, GNUTLS_PKCS11_TOKEN_MODEL));
        JS_SetPropertyStr(ctx, one, "Serial", token_text(ctx, url, GNUTLS_PKCS11_TOKEN_SERIAL));
        JS_SetPropertyStr(ctx, one, "Signers", token_signers(ctx, url));
        JS_SetPropertyUint32(ctx, out, at++, one);
        gnutls_free(url);
    }
    return out;
#endif
}

/* ------------------------------------------------------------- members */

static JSValue key_get_source(JSContext *ctx, JSValueConst this_val)
{
    Key *k = JS_GetOpaque2(ctx, this_val, key_class_id);
    return k ? JS_NewString(ctx, k->source ? k->source : "") : JS_EXCEPTION;
}

static JSValue key_get_open(JSContext *ctx, JSValueConst this_val)
{
    Key *k = JS_GetOpaque2(ctx, this_val, key_class_id);
    return k ? JS_NewBool(ctx, k->open) : JS_EXCEPTION;
}

static JSValue key_get_algorithm(JSContext *ctx, JSValueConst this_val)
{
    Key *k = key_of(ctx, this_val);
    if (!k)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_GNUTLS
    switch (gnutls_privkey_get_pk_algorithm(k->key, NULL)) {
    case GNUTLS_PK_RSA:
    case GNUTLS_PK_RSA_PSS:          return JS_NewString(ctx, "RSA");
    case GNUTLS_PK_ECDSA:            return JS_NewString(ctx, "ECDSA");
    case GNUTLS_PK_EDDSA_ED25519:    return JS_NewString(ctx, "Ed25519");
    case GNUTLS_PK_EDDSA_ED448:      return JS_NewString(ctx, "Ed448");
    default:                         return JS_NewString(ctx, "");
    }
#else
    return JS_NewString(ctx, "");
#endif
}

static JSValue key_get_bits(JSContext *ctx, JSValueConst this_val)
{
    Key *k = key_of(ctx, this_val);
    if (!k)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_GNUTLS
    unsigned int bits = 0;
    gnutls_privkey_get_pk_algorithm(k->key, &bits);
    return JS_NewInt32(ctx, (int32_t)bits);
#else
    return JS_NewInt32(ctx, 0);
#endif
}

static JSValue key_get_certificate(JSContext *ctx, JSValueConst this_val)
{
    Key *k = key_of(ctx, this_val);
    if (!k)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_GNUTLS
    if (k->cert.data)
        return bta_bytes_new(ctx, k->cert.data, k->cert.size);
#endif
    return JS_NULL;
}

static JSValue key_get_subject(JSContext *ctx, JSValueConst this_val)
{
    Key *k = key_of(ctx, this_val);
    if (!k)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_GNUTLS
    if (k->cert.data) {
        gnutls_x509_crt_t crt;
        char             *who = NULL;

        gnutls_x509_crt_init(&crt);
        if (gnutls_x509_crt_import(crt, &k->cert, GNUTLS_X509_FMT_DER) == 0)
            who = crt_name(crt, false);
        gnutls_x509_crt_deinit(crt);
        JSValue v = JS_NewString(ctx, who ? who : "");
        g_free(who);
        return v;
    }
#endif
    return JS_NewString(ctx, "");
}

/*
 * `Sign(digest, [algorithm])` -- see its description in the table. The digest
 * is checked against the algorithm's length, since a token signs whatever it
 * is given and a signature over the wrong bytes verifies nowhere, silently.
 */
static JSValue key_sign(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    Key *k = key_of(ctx, this_val);
    if (!k)
        return JS_EXCEPTION;
#ifndef BTA_HAVE_GNUTLS
    (void)argc; (void)argv;
    return no_gnutls(ctx, "Sign");
#else
    size_t         len    = 0;
    const uint8_t *digest = argc > 0 ? bta_bytes_get(argv[0], &len) : NULL;
    if (!digest)
        return JS_ThrowTypeError(ctx, "Key.Sign(digest, [algorithm]) signs a digest, "
                                      "as Bytes");

    const char *name = "SHA256";
    const char *given = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        if (!JS_IsString(argv[1]))
            return JS_ThrowTypeError(ctx, "Key.Sign: the algorithm is text -- "
                                          "\"SHA256\", \"SHA384\" or \"SHA512\"");
        given = JS_ToCString(ctx, argv[1]);
        if (!given)
            return JS_EXCEPTION;
        name = given;
    }

    /* `name` is pointed at a literal before `given` is freed: it is quoted
     * in the length refusal below, after the free. */
    gnutls_digest_algorithm_t dig = GNUTLS_DIG_UNKNOWN;
    size_t                    want = 0;
    if (!g_ascii_strcasecmp(name, "SHA256"))      { dig = GNUTLS_DIG_SHA256; want = 32; name = "SHA256"; }
    else if (!g_ascii_strcasecmp(name, "SHA384")) { dig = GNUTLS_DIG_SHA384; want = 48; name = "SHA384"; }
    else if (!g_ascii_strcasecmp(name, "SHA512")) { dig = GNUTLS_DIG_SHA512; want = 64; name = "SHA512"; }

    if (dig == GNUTLS_DIG_UNKNOWN) {
        JSValue e = bta_throw_text(ctx, "Key.Sign: '%s' is not a digest it signs -- "
                                        "\"SHA256\", \"SHA384\" or \"SHA512\"", name);
        JS_FreeCString(ctx, given);
        return e;
    }
    JS_FreeCString(ctx, given);
    if (len != want)
        return JS_ThrowRangeError(ctx, "Key.Sign: a %s digest is %zu bytes, and this "
                                       "is %zu", name, want, len);

    gnutls_pk_algorithm_t pk  = gnutls_privkey_get_pk_algorithm(k->key, NULL);
    gnutls_sign_algorithm_t s = gnutls_pk_to_sign(pk == GNUTLS_PK_RSA_PSS ? GNUTLS_PK_RSA : pk, dig);
    if (s == GNUTLS_SIGN_UNKNOWN)
        return JS_ThrowPlainError(ctx, "Key.Sign: this key signs a message, not a "
                                       "digest -- an Ed25519 or Ed448 key cannot");

    gnutls_datum_t hash = { (unsigned char *)digest, (unsigned)len };
    gnutls_datum_t sig  = { NULL, 0 };

    k->pin_asked = k->pin_wrong = false;
    int r = gnutls_privkey_sign_hash2(k->key, s, 0, &hash, &sig);
    if (r < 0) {
        if (k->pin_wrong)
            return JS_ThrowPlainError(ctx, "Key.Sign: the token refused the PIN");
        if (k->pin_asked)
            return JS_ThrowPlainError(ctx, "Key.Sign: the token wants its PIN -- "
                                           "Key.Load(uri, pin)");
        return JS_ThrowPlainError(ctx, "Key.Sign: the key did not sign (%s)",
                                  gnutls_strerror_name(r));
    }
    JSValue out = bta_bytes_new(ctx, sig.data, sig.size);
    gnutls_free(sig.data);
    return out;
#endif
}

static JSValue key_close(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    Key *k = JS_GetOpaque2(ctx, this_val, key_class_id);
    (void)argc; (void)argv;
    if (!k)
        return JS_EXCEPTION;
    k->open = false;                  /* closing twice is not an error */
#ifdef BTA_HAVE_GNUTLS
    key_release(k);
#endif
    return JS_UNDEFINED;
}

static JSValue key_ctor(JSContext *ctx, JSValueConst new_target,
                        int argc, JSValueConst *argv)
{
    (void)new_target; (void)argc; (void)argv;
    return JS_ThrowTypeError(ctx, "a Key is loaded, not constructed: "
                                  "Key.Load(source, [pin])");
}

/* ---------------------------------------------------------------- install */

/* type Key */
static const JSCFunctionListEntry key_props[] = {
    /* Source -> string
     *   where it was loaded from: the file's absolute path, or the key's full
     *   `pkcs11:` URI on its token
     */
    JS_CGETSET_DEF("Source",      key_get_source,      NULL),
    /* Open -> boolean
     *   whether it still is
     */
    JS_CGETSET_DEF("Open",        key_get_open,        NULL),
    /* Algorithm -> string
     *   `RSA`, `ECDSA`, `Ed25519` or `Ed448`
     */
    JS_CGETSET_DEF("Algorithm",   key_get_algorithm,   NULL),
    /* Bits -> number
     *   the key's size: 2048 for a common RSA key, 256 for a P-256 one
     */
    JS_CGETSET_DEF("Bits",        key_get_bits,        NULL),
    /* Certificate -> Bytes
     *   the signer's certificate, DER, when the place it came from had one --
     *   a PKCS#12 does, a token usually does (the certificate with the key's
     *   id), a PEM with a `CERTIFICATE` block beside the key does; `null`
     *   otherwise, and the caller gives it
     */
    JS_CGETSET_DEF("Certificate", key_get_certificate, NULL),
    /* Subject -> string
     *   the common name on its certificate -- who signs; `""` with none
     */
    JS_CGETSET_DEF("Subject",     key_get_subject,     NULL),
    /* Sign(digest, [algorithm]) -> Bytes
     *   the signature over a **digest** already computed, `Bytes` of the
     *   algorithm's length -- `"SHA256"` (the default), `"SHA384"`,
     *   `"SHA512"`: PKCS#1 v1.5 for RSA, DER for ECDSA. On a token the token
     *   signs, and asks for the PIN again. Exactly what
     *   `PdfDocument.Sign`'s `Signer` is asked, so `{ Key: key }` signs a PDF
     */
    JS_CFUNC_DEF("Sign",  2, key_sign),
    /* Close()
     *   let it go: the token's session, the key in memory and the PIN, wiped.
     *   Closing twice is not an error
     */
    JS_CFUNC_DEF("Close", 0, key_close),
};

void bta_key_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &key_class_id);
    JS_NewClass(rt, key_class_id, &key_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, key_props,
                               sizeof key_props / sizeof key_props[0]);
    JSValue ctor = JS_NewCFunction2(ctx, key_ctor, "Key", 0, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, key_class_id, proto);

    /* Load(source, [pin]) -> Key
     *   a private key, from a `pkcs11:` URI -- a smart card, a USB token, a
     *   software token, as `Tokens()` or `p11tool --list-all` names it -- or
     *   from a file: PKCS#12 (`.p12`, `.pfx`), or a PEM or DER key, encrypted
     *   PKCS#8 included. `pin` is the token's PIN or the file's password. A
     *   URI that names only a token takes its one key, and refuses listing
     *   them when there are more. Throws, saying which: no such file, not a
     *   key, protected and no password, the wrong one, the PIN wanted or
     *   refused
     */
    JS_SetPropertyStr(ctx, ctor, "Load",
                      JS_NewCFunction(ctx, key_load, "Load", 2));
    /* Tokens() -> object[]
     *   the tokens plugged in, as p11-kit's modules see them: `{ Uri, Label,
     *   Manufacturer, Model, Serial, Signers }`, and `Signers` who can sign on
     *   each -- `{ Key, Label, Subject, Issuer, Expires }`, `Key` the URI to
     *   `Load`. No PIN: certificates are public. The system's store of CA
     *   certificates is not a signer's and is left out
     */
    JS_SetPropertyStr(ctx, ctor, "Tokens",
                      JS_NewCFunction(ctx, key_tokens, "Tokens", 0));
#ifdef BTA_HAVE_GNUTLS
    const bool available = true;
#else
    const bool available = false;
#endif
    /* Available
     *   whether this build reads keys and talks to tokens, which is GnuTLS;
     *   when false every verb refuses naming the package
     */
    JS_SetPropertyStr(ctx, ctor, "Available", JS_NewBool(ctx, available));
    JS_SetPropertyStr(ctx, global, "Key", ctor);
}
