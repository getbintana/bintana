/*
 * Bytes -- the value this language did not have.
 *
 * A file is not text. `File.Load` answers a string and destroys anything that
 * is not UTF-8; `File.Copy` moves a file byte for byte and never hands the
 * bytes over. So a program could not read a PNG's header, keep a thumbnail in a
 * record, or write a file it had built: everything that touches real files was
 * either offloaded to a child process or could not be written at all.
 *
 * ## Why a class of our own and not a typed array
 *
 * QuickJS has `ArrayBuffer` and `Uint8Array`, and this runtime takes them off
 * the language on purpose (see `close_hatches`): they come with a view/buffer
 * distinction, a shared-memory story, an `Atomics` namespace and index syntax
 * that reads like an array of numbers -- a whole model to learn for a value that
 * an application only ever reads a file into, cuts a piece off, and writes back
 * out. `Decimal` made the same choice for the same reason and is the precedent:
 * one class, the operations the applications actually need, and nothing that
 * needs explaining twice.
 *
 * **What it is not is a buffer.** There is no `Set`, no resizing, no writing
 * into it. Every operation answers a new `Bytes`, which is what makes it safe to
 * hand one to a record field, keep it, and hand it to somebody else -- the same
 * bargain a string makes, and the reason a thumbnail in a `Record` cannot be
 * changed under the record's feet.
 *
 * ## The text edge, which is where this gets got wrong
 *
 * Bytes and text are different values and the conversion is **explicit in both
 * directions**: `new Bytes(text)` encodes UTF-8, `ToText()` decodes it and
 * refuses what is not valid UTF-8 rather than answering mojibake. `toString()`
 * deliberately does *not* decode -- it answers `Bytes(1234)`, a description --
 * because a JPEG interpolated into a log message by accident is a megabyte of
 * noise and, worse, reads as if it worked. `toJSON()` is base64, so a record
 * carrying a file survives `File.SaveJson` and comes back as itself.
 */
#include "bta.h"

#include <string.h>

typedef struct {
    uint8_t *data;      /* NULL only when len is 0 */
    size_t   len;
} BtaBytes;

static JSClassID bta_bytes_class_id;

static void bytes_finalizer(JSRuntime *rt, JSValue val)
{
    BtaBytes *b = JS_GetOpaque(val, bta_bytes_class_id);

    if (!b)
        return;
    js_free_rt(rt, b->data);
    js_free_rt(rt, b);
}

static JSClassDef bytes_class = {
    "Bytes",
    .finalizer = bytes_finalizer,
};

/* ------------------------------------------------------------------ making */

/*
 * A new `Bytes` over a **copy** of `data`.
 *
 * The copy is not laziness: the callers are a file just read into a GLib
 * buffer, a sqlite BLOB that belongs to the statement until the next step, and a
 * base64 decode -- three lifetimes, none of them ours, and a value that outlives
 * all of them.
 */
JSValue bta_bytes_new(JSContext *ctx, const void *data, size_t len)
{
    JSValue proto = JS_GetClassProto(ctx, bta_bytes_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bta_bytes_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;

    BtaBytes *b = js_mallocz(ctx, sizeof *b);
    if (!b) {
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }

    if (len) {
        b->data = js_malloc(ctx, len);
        if (!b->data) {
            js_free(ctx, b);
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
        memcpy(b->data, data, len);
        b->len = len;
    }

    JS_SetOpaque(obj, b);
    return obj;
}

static BtaBytes *bytes_of(JSValueConst v)
{
    return JS_GetOpaque(v, bta_bytes_class_id);
}

const uint8_t *bta_bytes_get(JSValueConst v, size_t *len)
{
    BtaBytes *b = JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT ? bytes_of(v) : NULL;

    if (!b)
        return NULL;
    if (len)
        *len = b->len;
    /* Never NULL for a caller that only wants to read: an empty value is a
     * pointer to nothing rather than nothing to point at, so `memcmp` and
     * `g_checksum_update` need no special case. */
    return b->data ? b->data : (const uint8_t *)"";
}

/* This value as bytes, or a throw naming what it got. The one door every method
 * here comes through, which is what makes the message one sentence. */
static BtaBytes *bytes_arg(JSContext *ctx, JSValueConst v, const char *who)
{
    BtaBytes *b = JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT ? bytes_of(v) : NULL;

    if (!b)
        JS_ThrowTypeError(ctx, "%s: expected a Bytes", who);
    return b;
}

/*
 * `new Bytes(value)`.
 *
 * Nothing is empty; a string is its UTF-8; another `Bytes` is a copy; a list of
 * numbers is those bytes. The list is the one that needs the check: `[72, 300]`
 * is not bytes, and truncating it to 44 would be a value nobody wrote.
 */
static JSValue bytes_construct(JSContext *ctx, JSValueConst new_target,
                               int argc, JSValueConst *argv)
{
    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]))
        return bta_bytes_new(ctx, NULL, 0);

    if (JS_IsString(argv[0])) {
        size_t      len = 0;
        const char *s   = JS_ToCStringLen(ctx, &len, argv[0]);

        if (!s)
            return JS_EXCEPTION;

        JSValue out = bta_bytes_new(ctx, s, len);
        JS_FreeCString(ctx, s);
        return out;
    }

    if (JS_IsArray(argv[0])) {
        JSValue lenv = JS_GetPropertyStr(ctx, argv[0], "length");
        uint32_t n   = 0;

        if (JS_ToUint32(ctx, &n, lenv)) {
            JS_FreeValue(ctx, lenv);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, lenv);

        uint8_t *buf = n ? js_malloc(ctx, n) : NULL;
        if (n && !buf)
            return JS_EXCEPTION;

        for (uint32_t i = 0; i < n; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, argv[0], i);
            int32_t byte = 0;
            bool    bad  = JS_ToInt32(ctx, &byte, item) != 0;

            JS_FreeValue(ctx, item);
            if (bad || byte < 0 || byte > 255) {
                js_free(ctx, buf);
                if (bad)
                    return JS_EXCEPTION;
                return JS_ThrowRangeError(ctx, "Bytes: entry %u is %d, and a "
                                               "byte is 0 to 255", i, byte);
            }
            buf[i] = (uint8_t)byte;
        }

        JSValue out = bta_bytes_new(ctx, buf, n);
        js_free(ctx, buf);
        return out;
    }

    BtaBytes *other = bytes_of(argv[0]);
    if (other)
        return bta_bytes_new(ctx, other->data, other->len);

    return JS_ThrowTypeError(ctx, "Bytes: expected text, a list of bytes, "
                                  "another Bytes, or nothing");
}

/* ------------------------------------------------------------------ reading */

static JSValue bytes_get_length(JSContext *ctx, JSValueConst this_val)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.Length");

    return b ? JS_NewInt64(ctx, (int64_t)b->len) : JS_EXCEPTION;
}

/* One byte, 0 to 255. Out of range is a throw and not `undefined`: a program
 * reading a header off the end of a file has a bug, and `undefined + 1` hides
 * it until the arithmetic looks merely wrong. */
static JSValue bytes_at(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.At");
    if (!b)
        return JS_EXCEPTION;

    int64_t at = 0;
    if (argc < 1 || JS_ToInt64(ctx, &at, argv[0]))
        return JS_ThrowTypeError(ctx, "At(index) needs an index");

    if (at < 0 || (size_t)at >= b->len)
        return JS_ThrowRangeError(ctx, "At: %lld is outside these %zu bytes",
                                  (long long)at, b->len);
    return JS_NewInt32(ctx, b->data[at]);
}

/*
 * `Slice(from, [count])` -- **clamped, the way a string's is**.
 *
 * A slice past the end answers what there is rather than throwing: reading the
 * first eight bytes of a file that turned out to be four is a question with an
 * answer, and the caller checks `Length`. Reaching for one byte with `At` is
 * the opposite case and does throw -- there the index is a claim about where
 * something *is*.
 */
static JSValue bytes_slice(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.Slice");
    if (!b)
        return JS_EXCEPTION;

    int64_t from = 0, count = (int64_t)b->len;

    if (argc > 0 && !JS_IsUndefined(argv[0]) && JS_ToInt64(ctx, &from, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && JS_ToInt64(ctx, &count, argv[1]))
        return JS_EXCEPTION;

    /* A negative start counts from the end, which is the one convention every
     * caller already has from `String.slice`. */
    if (from < 0)
        from += (int64_t)b->len;
    if (from < 0)
        from = 0;
    if (from > (int64_t)b->len)
        from = (int64_t)b->len;
    if (count < 0)
        count = 0;
    if (from + count > (int64_t)b->len)
        count = (int64_t)b->len - from;

    return bta_bytes_new(ctx, b->data + from, (size_t)count);
}

static JSValue bytes_concat(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.Concat");
    if (!b)
        return JS_EXCEPTION;

    size_t total = b->len;
    for (int i = 0; i < argc; i++) {
        BtaBytes *more = bytes_arg(ctx, argv[i], "Concat");
        if (!more)
            return JS_EXCEPTION;
        total += more->len;
    }

    uint8_t *buf = total ? js_malloc(ctx, total) : NULL;
    if (total && !buf)
        return JS_EXCEPTION;

    size_t at = 0;
    memcpy(buf, b->data, b->len);
    at += b->len;
    for (int i = 0; i < argc; i++) {
        BtaBytes *more = bytes_of(argv[i]);
        memcpy(buf + at, more->data, more->len);
        at += more->len;
    }

    JSValue out = bta_bytes_new(ctx, buf, total);
    js_free(ctx, buf);
    return out;
}

/* Byte for byte. `==` compares two objects by identity, so two files read
 * separately would never be equal without this -- which is the whole of what
 * comparing bytes is for. */
static JSValue bytes_equals(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.Equals");
    if (!b)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Equals(other) needs something to compare");

    BtaBytes *other = JS_VALUE_GET_TAG(argv[0]) == JS_TAG_OBJECT
                          ? bytes_of(argv[0]) : NULL;
    if (!other)
        return JS_NewBool(ctx, false);
    if (other->len != b->len)
        return JS_NewBool(ctx, false);
    return JS_NewBool(ctx, memcmp(b->data, other->data, b->len) == 0);
}

/* ------------------------------------------------------------------- edges */

/*
 * The text these bytes are, or a throw.
 *
 * **Refused rather than mangled.** A byte sequence that is not valid UTF-8 has
 * no text to be -- decoding it with replacement characters answers something
 * that looks like a string, compares unequal to everything, and is impossible to
 * get back. The caller that has bytes which are text knows it; the one that does
 * not has a bug this sentence names.
 */
static JSValue bytes_to_text(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.ToText");
    if (!b)
        return JS_EXCEPTION;
    if (!b->len)
        return JS_NewString(ctx, "");

    const char *bad = NULL;
    if (!g_utf8_validate_len((const char *)b->data, b->len, &bad))
        return JS_ThrowTypeError(ctx, "ToText: these %zu bytes are not UTF-8 "
                                      "text (byte %td is not)", b->len,
                                 bad ? bad - (const char *)b->data : 0);

    return JS_NewStringLen(ctx, (const char *)b->data, b->len);
}

static JSValue bytes_to_base64(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.ToBase64");
    if (!b)
        return JS_EXCEPTION;

    char   *text = g_base64_encode(b->data ? b->data : (const guchar *)"", b->len);
    JSValue out  = JS_NewString(ctx, text ? text : "");

    g_free(text);
    return out;
}

/* Lower-case hex, which is what every checksum, signature and hexdump is
 * written in -- and what `Hash` answers with, so the two compare. */
static JSValue bytes_to_hex(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    static const char DIGITS[] = "0123456789abcdef";

    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.ToHex");
    if (!b)
        return JS_EXCEPTION;

    char *text = js_malloc(ctx, b->len * 2 + 1);
    if (!text)
        return JS_EXCEPTION;

    for (size_t i = 0; i < b->len; i++) {
        text[i * 2]     = DIGITS[b->data[i] >> 4];
        text[i * 2 + 1] = DIGITS[b->data[i] & 0x0f];
    }
    text[b->len * 2] = '\0';

    JSValue out = JS_NewStringLen(ctx, text, b->len * 2);
    js_free(ctx, text);
    return out;
}

/*
 * `${bytes}` is `Bytes(1234)` and **not** the content.
 *
 * A JPEG interpolated into a log line by accident is a megabyte of noise that
 * reads as if it worked, and text is exactly what these are not. What a program
 * means when it wants the content says so: `ToText`, `ToBase64`, `ToHex`.
 */
static JSValue bytes_to_string(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaBytes *b = bytes_arg(ctx, this_val, "Bytes.toString");
    if (!b)
        return JS_EXCEPTION;

    char buf[32];
    g_snprintf(buf, sizeof buf, "Bytes(%zu)", b->len);
    return JS_NewString(ctx, buf);
}

/* Base64 in JSON, which is the one representation a text file can carry: a
 * record with a thumbnail in it survives `File.SaveJson` and reads back as
 * itself through `Field.Bytes`. The same bargain `Decimal.toJSON` makes with
 * its digits. */
static JSValue bytes_to_json(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    return bytes_to_base64(ctx, this_val, argc, argv);
}

/*
 * Checked before it is decoded, and that check is the point of the function.
 *
 * `g_base64_decode` **ignores** anything outside the alphabet: hand it `hello`
 * and it answers three bytes rather than an error, so a caller that meant text
 * would get a silent handful of nonsense -- and `Field.Bytes` reads base64 out
 * of files, which is exactly where that would land. The alphabet, the padding
 * and the length are all decidable up front, so they are decided.
 */
static bool base64_shaped(const char *text, size_t len)
{
    if (len % 4)
        return false;

    size_t pad = 0;
    while (pad < 2 && len > pad && text[len - 1 - pad] == '=')
        pad++;

    for (size_t i = 0; i < len - pad; i++) {
        char c = text[i];
        bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') || c == '+' || c == '/';
        if (!ok)
            return false;
    }
    return true;
}

static JSValue bytes_from_base64(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    size_t      len  = 0;
    const char *text = argc > 0 ? JS_ToCStringLen(ctx, &len, argv[0]) : NULL;

    if (!text)
        return JS_ThrowTypeError(ctx, "Bytes.FromBase64(text) needs the text");

    if (!base64_shaped(text, len)) {
        JS_FreeCString(ctx, text);
        return JS_ThrowTypeError(ctx, "Bytes.FromBase64: that is not base64");
    }

    gsize   out_len = 0;
    guchar *data    = g_base64_decode(text, &out_len);

    JS_FreeCString(ctx, text);
    if (!data)
        return JS_ThrowTypeError(ctx, "Bytes.FromBase64: that is not base64");

    JSValue out = bta_bytes_new(ctx, data, out_len);
    g_free(data);
    return out;
}

static int hex_digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static JSValue bytes_from_hex(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    size_t      len  = 0;
    const char *text = argc > 0 ? JS_ToCStringLen(ctx, &len, argv[0]) : NULL;

    if (!text)
        return JS_ThrowTypeError(ctx, "Bytes.FromHex(text) needs the text");

    if (len % 2) {
        JS_FreeCString(ctx, text);
        return JS_ThrowTypeError(ctx, "Bytes.FromHex: an odd number of digits "
                                      "is half a byte");
    }

    uint8_t *buf = len ? js_malloc(ctx, len / 2) : NULL;
    if (len && !buf) {
        JS_FreeCString(ctx, text);
        return JS_EXCEPTION;
    }

    for (size_t i = 0; i < len; i += 2) {
        int hi = hex_digit(text[i]), lo = hex_digit(text[i + 1]);

        if (hi < 0 || lo < 0) {
            js_free(ctx, buf);
            JSValue e = JS_ThrowTypeError(ctx, "Bytes.FromHex: '%c%c' is not "
                                               "two hex digits",
                                          text[i], text[i + 1]);
            JS_FreeCString(ctx, text);
            return e;
        }
        buf[i / 2] = (uint8_t)(hi << 4 | lo);
    }

    JSValue out = bta_bytes_new(ctx, buf, len / 2);
    js_free(ctx, buf);
    JS_FreeCString(ctx, text);
    return out;
}

static const JSCFunctionListEntry bytes_proto_funcs[] = {
    JS_CGETSET_DEF("Length", bytes_get_length, NULL),
    JS_CFUNC_DEF("At",       1, bytes_at),
    JS_CFUNC_DEF("Slice",    2, bytes_slice),
    JS_CFUNC_DEF("Concat",   1, bytes_concat),
    JS_CFUNC_DEF("Equals",   1, bytes_equals),
    JS_CFUNC_DEF("ToText",   0, bytes_to_text),
    JS_CFUNC_DEF("ToBase64", 0, bytes_to_base64),
    JS_CFUNC_DEF("ToHex",    0, bytes_to_hex),
    JS_CFUNC_DEF("toString", 0, bytes_to_string),
    JS_CFUNC_DEF("toJSON",   0, bytes_to_json),
};

void bta_bytes_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_bytes_class_id);
    JS_NewClass(rt, bta_bytes_class_id, &bytes_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, bytes_proto_funcs,
                               G_N_ELEMENTS(bytes_proto_funcs));
    JS_SetClassProto(ctx, bta_bytes_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, bytes_construct, "Bytes", 1,
                                    JS_CFUNC_constructor, 0);
    JS_SetPropertyStr(ctx, ctor, "FromBase64",
                      JS_NewCFunction(ctx, bytes_from_base64, "FromBase64", 1));
    JS_SetPropertyStr(ctx, ctor, "FromHex",
                      JS_NewCFunction(ctx, bytes_from_hex, "FromHex", 1));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Bytes", ctor);
}
