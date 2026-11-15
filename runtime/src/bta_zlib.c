/*
 * Zlib -- zlib framing (RFC 1950) and raw deflate (RFC 1951).
 *
 *     const p = Zlib.Compress(text)                  // zlib framing
 *     const r = Zlib.Compress(text, { Raw: true })   // raw deflate
 *     Zlib.Decompress(p)                             // Bytes
 *     Zlib.Decompress(r, { Raw: true })
 *
 * The engine is the one behind `Gzip` (`bta_deflate.c`), with the same ceiling
 * and the same rules; what changes is the wrapper and the answer to what comes
 * after a stream. `Zip` already builds the raw converters for its entries, so
 * this adds no dependency and no CI job.
 *
 * **Raw deflate has no checksum.** The zlib wrapper carries Adler-32 and a
 * damaged stream is refused; raw carries nothing, so a flipped bit inside a
 * literal is a different document and a success. A caller that needs to know
 * its bytes arrived intact uses zlib framing, or a checksum of its own.
 *
 * **One stream, read whole.** Bytes after the end are refused (naming the
 * byte) rather than treated as a second stream: zlib has no answer for
 * concatenation the way gzip does. A truncated stream throws, and never
 * answers the part it decoded.
 */

#include "bta.h"
#include "bta_deflate.h"

#include <math.h>
#include <string.h>

#define ZL_DEFAULT_MAX  ((uint64_t)256 * 1024 * 1024)

/* ------------------------------------------------------------ options */

/*
 * The options a verb takes, and nothing else. Every key in the object has to
 * be one of `keys`, or the call is refused: an option silently ignored is a
 * misspelling that costs nothing to catch. Both verbs take at most two, so the
 * sentence naming them is written for two.
 */
static bool zl_options(JSContext *ctx, JSValueConst opts, const char *who,
                       const char *const *keys, uint32_t nkeys, JSValue *values)
{
    JSPropertyEnum *tab;
    uint32_t        len;

    for (uint32_t i = 0; i < nkeys; i++)
        values[i] = JS_UNDEFINED;

    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;
    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "%s: the options are an object", who);
        return false;
    }
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;

    for (uint32_t i = 0; i < len; i++) {
        const char *name = JS_AtomToCString(ctx, tab[i].atom);
        int         which = -1;

        for (uint32_t k = 0; name && k < nkeys; k++) {
            if (strcmp(name, keys[k]) == 0) {
                which = (int)k;
                break;
            }
        }
        JS_FreeCString(ctx, name);
        if (which < 0) {
            const char *bad = JS_AtomToCString(ctx, tab[i].atom);

            JS_ThrowTypeError(ctx, "%s: '%s' is not an option (the options are "
                                   "`%s` and `%s`)", who, bad ? bad : "?",
                              keys[0], keys[nkeys - 1]);
            if (bad)
                JS_FreeCString(ctx, bad);
            JS_FreePropertyEnum(ctx, tab, len);
            return false;
        }
    }
    JS_FreePropertyEnum(ctx, tab, len);

    for (uint32_t i = 0; i < nkeys; i++) {
        values[i] = JS_GetPropertyStr(ctx, opts, keys[i]);
        if (JS_IsException(values[i])) {
            for (uint32_t j = 0; j < i; j++)
                JS_FreeValue(ctx, values[j]);
            return false;
        }
    }
    return true;
}

static bool zl_raw(JSContext *ctx, JSValueConst v, const char *who, bool *raw)
{
    *raw = false;
    if (JS_IsUndefined(v))
        return true;
    if (!JS_IsBool(v)) {
        JS_ThrowTypeError(ctx, "%s: Raw is true or false", who);
        return false;
    }
    *raw = JS_ToBool(ctx, v);
    return true;
}

static bool zl_level(JSContext *ctx, JSValueConst v, const char *who, int *level)
{
    double d;

    *level = 6;
    if (JS_IsUndefined(v))
        return true;

    bool ok = bta_to_number(ctx, v, "Level", &d);
    if (!ok)
        return false;
    if (d != floor(d) || d < 1 || d > 9) {
        JS_ThrowRangeError(ctx, "%s: Level is a whole number from 1 (fast) to 9 "
                                "(small), not %g", who, d);
        return false;
    }
    *level = (int)d;
    return true;
}

static bool zl_max(JSContext *ctx, JSValueConst v, const char *who, uint64_t *max)
{
    double d;

    *max = ZL_DEFAULT_MAX;
    if (JS_IsUndefined(v))
        return true;

    bool ok = bta_to_number(ctx, v, "MaxSize", &d);
    if (!ok)
        return false;
    if (!(d >= 0)) {
        JS_ThrowRangeError(ctx, "%s: MaxSize is a number of bytes, 0 or more", who);
        return false;
    }
    *max = d >= 1.8e19 ? UINT64_MAX : (uint64_t)d;
    return true;
}

/* ------------------------------------------------------------- verbs */

/* The data to compress: text (UTF-8) or Bytes, as `Gzip.Compress` takes it. */
static const uint8_t *zl_data(JSContext *ctx, JSValueConst v, const char *who,
                              size_t *len, const char **text)
{
    const uint8_t *b = bta_bytes_get(v, len);

    *text = NULL;
    if (b)
        return b;
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "%s: the data is text or Bytes", who);
        return NULL;
    }
    *text = JS_ToCStringLen(ctx, len, v);
    return (const uint8_t *)*text;
}

static JSValue zlib_finish(JSContext *ctx, GConverter *conv, char *why,
                           GByteArray *out, const char *who)
{
    JSValue r;

    if (why) {
        r = JS_ThrowPlainError(ctx, "%s: %s", who, why);
        g_free(why);
    } else {
        r = bta_bytes_new(ctx, out->data, out->len);
    }
    g_byte_array_free(out, TRUE);
    g_object_unref(conv);
    return r;
}

static JSValue zlib_compress(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    static const char *const keys[] = { "Raw", "Level" };
    const char        *who = "Zlib.Compress";
    GCancellable      *cancel;
    JSValue            values[2];
    size_t             len;
    const char        *text;
    bool               raw;
    int                level;

    if (!bta_cancellable_arg(ctx, &argc, argv, 1, who, &cancel))
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Zlib.Compress(data, [{ Raw, Level }]) needs the data");
    if (!zl_options(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, who, keys, 2, values))
        return JS_EXCEPTION;
    bool ok = zl_raw(ctx, values[0], who, &raw)
           && zl_level(ctx, values[1], who, &level);
    JS_FreeValue(ctx, values[0]);
    JS_FreeValue(ctx, values[1]);
    if (!ok)
        return JS_EXCEPTION;

    const uint8_t *data = zl_data(ctx, argv[0], who, &len, &text);
    if (!data)
        return JS_EXCEPTION;

    BtaDeflateFormat format = raw ? BTA_DEFLATE_RAW : BTA_DEFLATE_ZLIB;
    GConverter      *conv   = bta_deflate_compressor(format, level);
    BtaCancelScope   sc;
    BtaDeflateSource src  = { .mem = data, .memlen = len,
                              .cancel = bta_cancel_scope(ctx, cancel, &sc) };
    BtaDeflateSink   sink = { .mem = g_byte_array_new(), .max = UINT64_MAX };
    char            *why  = bta_deflate_run(conv, false, format, &src, &sink);

    bta_cancel_scope_end(&sc);

    if (text)
        JS_FreeCString(ctx, text);
    return zlib_finish(ctx, conv, why, sink.mem, who);
}

static JSValue zlib_decompress(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    static const char *const keys[] = { "Raw", "MaxSize" };
    const char        *who = "Zlib.Decompress";
    GCancellable      *cancel;
    JSValue            values[2];
    size_t             len;
    bool               raw;
    uint64_t           max;

    if (!bta_cancellable_arg(ctx, &argc, argv, 1, who, &cancel))
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Zlib.Decompress(bytes, [{ Raw, MaxSize }]) needs the bytes");
    const uint8_t *data = bta_bytes_get(argv[0], &len);
    if (!data)
        return JS_ThrowTypeError(ctx, "%s: the data is Bytes (compressed data is "
                                      "not text)", who);
    if (!zl_options(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, who, keys, 2, values))
        return JS_EXCEPTION;
    bool ok = zl_raw(ctx, values[0], who, &raw)
           && zl_max(ctx, values[1], who, &max);
    JS_FreeValue(ctx, values[0]);
    JS_FreeValue(ctx, values[1]);
    if (!ok)
        return JS_EXCEPTION;

    BtaDeflateFormat format = raw ? BTA_DEFLATE_RAW : BTA_DEFLATE_ZLIB;
    GConverter      *conv   = bta_deflate_decompressor(format);
    BtaCancelScope   sc;
    BtaDeflateSource src  = { .mem = data, .memlen = len,
                              .cancel = bta_cancel_scope(ctx, cancel, &sc) };
    BtaDeflateSink   sink = { .mem = g_byte_array_new(), .max = max };
    char            *why  = bta_deflate_run(conv, true, format, &src, &sink);

    bta_cancel_scope_end(&sc);
    return zlib_finish(ctx, conv, why, sink.mem, who);
}

static const JSCFunctionListEntry zlib_props[] = {
    /* Compress(data, [{ Raw, Level }], [cancellable]) -> Bytes
     *   `data` (text as its UTF-8, or a `Bytes`) as one stream: zlib framing
     *   (RFC 1950) unless `Raw` is true, which writes raw DEFLATE (RFC 1951).
     *   `Level` is 1 (fast) to 9 (small), 6 unless told. An option it does not
     *   know, or a value that is neither text nor `Bytes`, is refused. About
     *   50 MB a second: a big one belongs in a `Task`, and a `Cancellable`
     *   last stops it between two 64 KB chunks
     */
    JS_CFUNC_DEF("Compress", 3, zlib_compress),
    /* Decompress(bytes, [{ Raw, MaxSize }], [cancellable]) -> Bytes
     *   what `bytes` holds, **all of it**: `Raw` says the bytes are raw
     *   DEFLATE rather than zlib-framed, a stream that stops inside one
     *   **throws** (naming how far it got) rather than answering what it had,
     *   and so does anything that is not the format asked for. Bytes after the
     *   stream are refused. The answer may not pass `MaxSize` bytes (256 MiB
     *   unless told). **Raw DEFLATE carries no checksum**: a damaged byte can
     *   decode to a different document without an error, so zlib framing is
     *   the one that catches damage. A `Cancellable` last stops it
     */
    JS_CFUNC_DEF("Decompress", 3, zlib_decompress),
};

void bta_zlib_init(JSContext *ctx, JSValue global)
{
    JSValue zlib = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, zlib, zlib_props, G_N_ELEMENTS(zlib_props));
    JS_SetPropertyStr(ctx, global, "Zlib", zlib);
}
