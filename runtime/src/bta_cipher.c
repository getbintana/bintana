/*
 * Cipher -- the middle between `Hash` and `Random`.
 *
 * `Hash` proves a message was not changed and cannot hide it; `Random` makes a
 * key and cannot use it. A file that leaves a laptop encrypted needs the one
 * operation neither has: reversible encryption under a key.
 *
 * **AES-256-GCM, through GnuTLS**, which is already the TLS library under
 * `libsoup` on every desktop this runs on. GCM is authenticated: a changed byte
 * or a wrong key is a refusal, never a plausible-looking plaintext. The key is
 * whatever the application has -- text or `Bytes` -- hashed with SHA-256 to the
 * 32 bytes AES-256 wants, so a passphrase and `Random.Bytes(32)` both work and
 * neither has to be padded by hand.
 *
 * ## The sealed value
 *
 * `Encrypt` answers `Bytes`: a four-byte marker `"BTA1"`, a random 12-byte
 * nonce, then the ciphertext with its 16-byte tag. The nonce is new for every
 * call, so two seals of the same text differ; the marker is what `Decrypt`
 * refuses by name when the value is not one of ours. There is no key in the
 * value and no way to recover one: losing the key loses the data, which is the
 * whole point and is written here so nobody discovers it late.
 *
 * It is memory and GnuTLS, not GTK, so a `Task` has it. Without GnuTLS the
 * global exists, `Available` is false and both verbs refuse with the package
 * to install -- the sqlite and libsoup bargain.
 */
#include "bta.h"

#include <string.h>

#ifdef BTA_HAVE_GNUTLS
#include <gnutls/crypto.h>
#include <gnutls/gnutls.h>
#endif

#define CIPHER_MAGIC   "BTA1"
#define CIPHER_MAGIC_N 4
#define CIPHER_NONCE   12
#define CIPHER_TAG     16

#ifdef BTA_HAVE_GNUTLS

/*
 * The bytes a caller gave: a `Bytes` value, or text as its UTF-8. Anything
 * else is refused by name -- a number is not a key, and converting it to
 * "123" would silently make a weak one.
 */
static bool cipher_input(JSContext *ctx, JSValueConst v, const char *who,
                         const uint8_t **data, size_t *len, bool *owned)
{
    *owned = false;

    const uint8_t *bytes = bta_bytes_get(v, len);
    if (bytes) {
        *data = bytes;
        return true;
    }

    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "%s expects text or Bytes", who);
        return false;
    }

    const char *text = JS_ToCStringLen(ctx, len, v);
    if (!text)
        return false;

    *data  = (const uint8_t *)text;
    *owned = true;
    return true;
}

/* SHA-256 of whatever key the caller has, which is the 32 bytes AES-256 wants. */
static bool cipher_key(JSContext *ctx, JSValueConst v, const char *who,
                       uint8_t digest[32], const uint8_t **data, size_t *len,
                       bool *owned)
{
    if (!cipher_input(ctx, v, who, data, len, owned))
        return false;

    if (*len == 0) {
        if (*owned) JS_FreeCString(ctx, (const char *)*data);
        *owned = false;
        JS_ThrowRangeError(ctx, "%s: a key of nothing is not a key", who);
        return false;
    }

    if (gnutls_hash_fast(GNUTLS_DIG_SHA256, *data, *len, digest) < 0) {
        if (*owned) JS_FreeCString(ctx, (const char *)*data);
        *owned = false;
        JS_ThrowPlainError(ctx, "%s: the key could not be hashed", who);
        return false;
    }
    return true;
}

static JSValue cipher_encrypt(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Cipher.Encrypt(data, key) needs data and a key");

    const uint8_t *data = NULL, *key = NULL;
    size_t         dlen = 0, klen = 0;
    bool           downed = false, kowned = false;
    uint8_t        digest[32];
    gnutls_aead_cipher_hd_t handle = NULL;
    uint8_t       *out = NULL;
    JSValue        result = JS_EXCEPTION;

    if (!cipher_input(ctx, argv[0], "Cipher.Encrypt", &data, &dlen, &downed))
        return JS_EXCEPTION;

    if (!cipher_key(ctx, argv[1], "Cipher.Encrypt", digest, &key, &klen, &kowned)) {
        if (downed) JS_FreeCString(ctx, (const char *)data);
        return JS_EXCEPTION;
    }

    gnutls_datum_t k = { digest, sizeof digest };
    if (gnutls_aead_cipher_init(&handle, GNUTLS_CIPHER_AES_256_GCM, &k) < 0) {
        JS_ThrowPlainError(ctx, "Cipher.Encrypt: GnuTLS could not make a cipher");
        goto done;
    }

    uint8_t nonce[CIPHER_NONCE];
    if (gnutls_rnd(GNUTLS_RND_NONCE, nonce, sizeof nonce) < 0) {
        JS_ThrowPlainError(ctx, "Cipher.Encrypt: the system has no randomness");
        goto done;
    }

    size_t   capacity = dlen + CIPHER_TAG;
    size_t   written  = capacity;
    gsize    total    = CIPHER_MAGIC_N + CIPHER_NONCE + capacity;

    out = g_malloc(total);
    memcpy(out, CIPHER_MAGIC, CIPHER_MAGIC_N);
    memcpy(out + CIPHER_MAGIC_N, nonce, CIPHER_NONCE);

    if (gnutls_aead_cipher_encrypt(handle, nonce, sizeof nonce, NULL, 0,
                                   CIPHER_TAG, data, dlen,
                                   out + CIPHER_MAGIC_N + CIPHER_NONCE,
                                   &written) < 0) {
        JS_ThrowPlainError(ctx, "Cipher.Encrypt: GnuTLS could not encrypt");
        goto done;
    }

    result = bta_bytes_new(ctx, out, CIPHER_MAGIC_N + CIPHER_NONCE + written);

done:
    if (handle) gnutls_aead_cipher_deinit(handle);
    g_free(out);
    if (downed) JS_FreeCString(ctx, (const char *)data);
    if (kowned) JS_FreeCString(ctx, (const char *)key);
    return result;
}

static JSValue cipher_decrypt(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Cipher.Decrypt(sealed, key) needs sealed bytes and a key");

    size_t         slen = 0;
    const uint8_t *sealed = bta_bytes_get(argv[0], &slen);
    if (!sealed)
        return JS_ThrowTypeError(ctx,
            "Cipher.Decrypt: expected Bytes -- what Cipher.Encrypt answered");

    if (slen < CIPHER_MAGIC_N + CIPHER_NONCE + CIPHER_TAG ||
        memcmp(sealed, CIPHER_MAGIC, CIPHER_MAGIC_N)) {
        return JS_ThrowTypeError(ctx,
            "Cipher.Decrypt: not a value this Cipher sealed");
    }

    const uint8_t *key = NULL;
    size_t         klen = 0;
    bool           kowned = false;
    uint8_t        digest[32];
    gnutls_aead_cipher_hd_t handle = NULL;
    uint8_t       *out = NULL;
    JSValue        result = JS_EXCEPTION;

    if (!cipher_key(ctx, argv[1], "Cipher.Decrypt", digest, &key, &klen, &kowned))
        return JS_EXCEPTION;

    gnutls_datum_t k = { digest, sizeof digest };
    if (gnutls_aead_cipher_init(&handle, GNUTLS_CIPHER_AES_256_GCM, &k) < 0) {
        JS_ThrowPlainError(ctx, "Cipher.Decrypt: GnuTLS could not make a cipher");
        goto done;
    }

    const uint8_t *nonce  = sealed + CIPHER_MAGIC_N;
    const uint8_t *ctext  = sealed + CIPHER_MAGIC_N + CIPHER_NONCE;
    size_t         ctlen  = slen - CIPHER_MAGIC_N - CIPHER_NONCE;
    size_t         capacity = ctlen - CIPHER_TAG;
    size_t         written  = capacity;

    out = g_malloc(capacity ? capacity : 1);

    if (gnutls_aead_cipher_decrypt(handle, nonce, CIPHER_NONCE, NULL, 0,
                                   CIPHER_TAG, ctext, ctlen,
                                   out, &written) < 0) {
        JS_ThrowPlainError(ctx,
            "Cipher.Decrypt: the key is wrong or the data was changed");
        goto done;
    }

    result = bta_bytes_new(ctx, out, written);

done:
    if (handle) gnutls_aead_cipher_deinit(handle);
    g_free(out);
    if (kowned) JS_FreeCString(ctx, (const char *)key);
    return result;
}

#else  /* no GnuTLS */

static JSValue cipher_unavailable(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_ThrowPlainError(ctx,
        "Cipher: this build has no GnuTLS -- install the gnutls development package");
}

#endif

void bta_cipher_init(JSContext *ctx, JSValue global)
{
    JSValue cipher = JS_NewObject(ctx);

#ifdef BTA_HAVE_GNUTLS
    /* Available
     *   whether this build has a cipher at all: false without GnuTLS, and then
     *   both verbs refuse naming the package
     */
    JS_SetPropertyStr(ctx, cipher, "Available", JS_TRUE);

    /* Encrypt(data, key) -> Bytes
     *   AES-256-GCM. `data` is text (its UTF-8) or `Bytes`; `key` is text or
     *   `Bytes`, hashed with SHA-256 to the 32 bytes the cipher takes. The
     *   answer is a marker, a fresh 12-byte nonce and the ciphertext with its
     *   tag -- two seals of the same data differ, and a changed byte or a wrong
     *   key is refused by `Decrypt`
     */
    JS_SetPropertyStr(ctx, cipher, "Encrypt",
                      JS_NewCFunction(ctx, cipher_encrypt, "Encrypt", 2));
    /* Decrypt(sealed, key) -> Bytes
     *   the plaintext, or a **throw** when the key is wrong or the value was
     *   changed -- GCM authenticates, so there is no half-right answer
     */
    JS_SetPropertyStr(ctx, cipher, "Decrypt",
                      JS_NewCFunction(ctx, cipher_decrypt, "Decrypt", 2));
#else
    JS_SetPropertyStr(ctx, cipher, "Available", JS_FALSE);
    JS_SetPropertyStr(ctx, cipher, "Encrypt",
                      JS_NewCFunction(ctx, cipher_unavailable, "Encrypt", 2));
    JS_SetPropertyStr(ctx, cipher, "Decrypt",
                      JS_NewCFunction(ctx, cipher_unavailable, "Decrypt", 2));
#endif

    JS_SetPropertyStr(ctx, global, "Cipher", cipher);
}
