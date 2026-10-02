/*
 * Gzip -- the one compression format this runtime speaks.
 *
 *     const z = Gzip.Compress(text)                  // Bytes
 *     const b = Gzip.Decompress(z)                   // Bytes
 *     Gzip.CompressFile(path, path + ".gz")          // streams; returns bytes written
 *     Gzip.DecompressFile(path + ".gz", path)
 *
 * **The implementation is GIO's** (`GZlibCompressor`/`GZlibDecompressor`, which
 * is `libz` already linked through GIO), so this adds no dependency and no CI
 * job. What is written here is the surface and the refusals -- and the refusals
 * are the whole reason it is not twenty lines, because the converter's defaults
 * are wrong in three ways that were measured before this was written
 * (docs/plans/crypto-compress-plan.md):
 *
 * - **Two members glued together** (`cat a.gz b.gz`, which is valid gzip and
 *   what `gzip -c >>` makes) decompress to *the first member only, with no
 *   error*: 6 bytes of 12 and a success. `Decompress` resets the converter at
 *   each member's end and goes on until the input is used up.
 * - **A truncated stream** is an error from the converter if it is asked at the
 *   end of input, and an error here: it names how many bytes of input it had
 *   consumed, never returns what was decoded so far.
 * - **A few kilobytes inflate to gigabytes.** `Decompress` on bytes that came off
 *   a network is the textbook way to end a process, so the output has a ceiling
 *   (`MaxSize`, 256 MiB unless asked) and a refusal says it is the ceiling.
 *
 * A **file** verb streams 64 KB at a time -- the cost of a video is the cost of
 * the buffer -- and writes a temporary beside the destination that is renamed
 * over it only once the stream is whole, as `File.Save` does: a half-written
 * `.gz` looks like an export that worked, so a failure removes it.
 *
 * Both directions are CPU: 47 MB inflates in about 90 ms and deflates in about a
 * second (measured), so a big one belongs in a `Task` -- and nothing here calls
 * back or keeps a list, so a worker has it (bta_task.c installs it).
 *
 * Only gzip is published. zlib framing and raw deflate are other names for the
 * same algorithm, and a name goes out when something needs one.
 */

#include "bta.h"

#include <glib/gstdio.h>
#include <gio/gio.h>

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#define GZ_CHUNK        65536
#define GZ_DEFAULT_MAX  ((uint64_t)256 * 1024 * 1024)

/* ------------------------------------------------------------ options */

/*
 * The one option a verb takes, or "not given". An options object with a key the
 * verb does not know is refused: `{ Lvel: 9 }` silently meaning level 6 is a
 * misspelling that costs nothing to catch.
 */
static bool gz_option(JSContext *ctx, JSValueConst opts, const char *who,
                      const char *key, JSValue *value)
{
    JSPropertyEnum *tab;
    uint32_t        len;

    *value = JS_UNDEFINED;
    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;
    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "%s: the options are an object with `%s`", who, key);
        return false;
    }
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;

    for (uint32_t i = 0; i < len; i++) {
        const char *name = JS_AtomToCString(ctx, tab[i].atom);
        bool        known = name && strcmp(name, key) == 0;

        if (!known) {
            JS_ThrowTypeError(ctx, "%s: '%s' is not an option (the option is `%s`)",
                              who, name ? name : "?", key);
            if (name)
                JS_FreeCString(ctx, name);
            JS_FreePropertyEnum(ctx, tab, len);
            return false;
        }
        JS_FreeCString(ctx, name);
    }
    JS_FreePropertyEnum(ctx, tab, len);

    *value = JS_GetPropertyStr(ctx, opts, key);
    return !JS_IsException(*value);
}

static bool gz_level(JSContext *ctx, JSValueConst opts, const char *who, int *level)
{
    JSValue v;
    double  d;

    *level = 6;
    if (!gz_option(ctx, opts, who, "Level", &v))
        return false;
    if (JS_IsUndefined(v))
        return true;

    bool ok = bta_to_number(ctx, v, "Level", &d);
    JS_FreeValue(ctx, v);
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

static bool gz_max(JSContext *ctx, JSValueConst opts, const char *who, uint64_t *max)
{
    JSValue v;
    double  d;

    *max = GZ_DEFAULT_MAX;
    if (!gz_option(ctx, opts, who, "MaxSize", &v))
        return false;
    if (JS_IsUndefined(v))
        return true;

    bool ok = bta_to_number(ctx, v, "MaxSize", &d);
    JS_FreeValue(ctx, v);
    if (!ok)
        return false;
    if (!(d >= 0)) {
        JS_ThrowRangeError(ctx, "%s: MaxSize is a number of bytes, 0 or more", who);
        return false;
    }
    /* Infinity is "no ceiling", spelt out: clamped so the cast is defined. */
    *max = d >= 1.8e19 ? UINT64_MAX : (uint64_t)d;
    return true;
}

/* ------------------------------------------------------------- engine */

/* Where the input comes from and where the output goes: memory or a file, so
 * one loop serves both and the cap and the truncation rule are written once. */
typedef struct {
    const guint8 *mem;
    size_t        memlen, mempos;
    FILE         *file;
} GzSource;

typedef struct {
    GByteArray *mem;
    FILE       *file;
    uint64_t    total, max;
    bool        exceeded;
} GzSink;

/* Up to `cap` bytes of input; 0 is the end. `*failed` for a read error. */
static size_t gz_read(GzSource *s, guint8 *buf, size_t cap, bool *failed)
{
    if (s->file) {
        size_t got = fread(buf, 1, cap, s->file);
        *failed = got == 0 && ferror(s->file);
        return got;
    }
    size_t n = s->memlen - s->mempos;
    if (n > cap)
        n = cap;
    if (n)
        memcpy(buf, s->mem + s->mempos, n);
    s->mempos += n;
    return n;
}

static bool gz_write(GzSink *k, const guint8 *buf, size_t n)
{
    if (!n)
        return true;
    if (k->total + n > k->max) {
        k->exceeded = true;
        return false;
    }
    k->total += n;
    if (k->file)
        return fwrite(buf, 1, n, k->file) == n;
    g_byte_array_append(k->mem, buf, (guint)n);
    return true;
}

/*
 * Runs a converter over a source into a sink. Answers NULL on success and a
 * newly allocated sentence (for the caller to throw and free) when it did not --
 * a string rather than an exception so that the caller cleans up its temporary
 * file *before* throwing.
 */
static char *gz_run(GConverter *conv, bool inflate, GzSource *src, GzSink *sink)
{
    guint8   in[GZ_CHUNK], out[GZ_CHUNK];
    size_t   have = 0, off = 0;
    uint64_t consumed = 0, member_start = 0;
    bool     eof = false, in_member = false, failed = false;
    int      stalled = 0;

    for (;;) {
        if (off == have && !eof) {
            have = gz_read(src, in, sizeof in, &failed);
            off  = 0;
            if (failed)
                return g_strdup_printf("cannot read the input: %s", g_strerror(errno));
            if (have == 0)
                eof = true;
        }

        if (inflate && off == have && eof) {
            if (in_member)
                return g_strdup_printf("the data is truncated: the stream ends "
                                       "inside a member, after %" G_GUINT64_FORMAT
                                       " bytes of input", consumed);
            if (consumed == 0)
                return g_strdup("empty input is not gzip data");
            return NULL;
        }

        if (!in_member)
            member_start = consumed;

        GError            *err = NULL;
        gsize              br = 0, bw = 0;
        GConverterFlags    flags = (!inflate && eof) ? G_CONVERTER_INPUT_AT_END : 0;
        GConverterResult   r = g_converter_convert(conv, in + off, have - off,
                                                   out, sizeof out, flags,
                                                   &br, &bw, &err);

        off      += br;
        consumed += br;
        if (br)
            in_member = true;

        if (!gz_write(sink, out, bw)) {
            g_clear_error(&err);
            if (sink->exceeded)
                return g_strdup_printf("the output exceeds MaxSize (%" G_GUINT64_FORMAT
                                       " bytes) -- raise it with { MaxSize } if "
                                       "this data is trusted", sink->max);
            return g_strdup_printf("cannot write the output: %s", g_strerror(errno));
        }

        if (r == G_CONVERTER_ERROR) {
            char *msg;

            if (inflate && g_error_matches(err, G_IO_ERROR, G_IO_ERROR_PARTIAL_INPUT)) {
                g_clear_error(&err);
                continue;                    /* wants more; the top asks for it */
            }
            /* GLib's own sentence is not used: it is translated into the
             * desktop's language, and an error that reads differently on each
             * machine cannot be matched by a program or quoted in a report. */
            if (!inflate)
                msg = g_strdup(err->message);
            else if (member_start == 0)
                msg = g_strdup("not gzip data, or damaged");
            else
                msg = g_strdup_printf("the member starting at byte %" G_GUINT64_FORMAT
                                      " is not gzip data, or damaged (the bytes "
                                      "before it were fine)", member_start);
            g_clear_error(&err);
            return msg;
        }

        if (r == G_CONVERTER_FINISHED) {
            if (!inflate)
                return NULL;
            /* **The member ended and the input may not have**: concatenated
             * members are valid gzip, and the converter would stop here and
             * report success -- which is the silent half-answer this refuses. */
            g_converter_reset(conv);
            in_member = false;
            stalled   = 0;
            continue;
        }

        /* A converter with input and room that does neither is not going to
         * (this has never been seen; it is a loop that must not be possible). */
        if (br == 0 && bw == 0 && (have - off > 0 || !eof)) {
            if (++stalled > 8)
                return g_strdup("the converter made no progress");
        } else {
            stalled = 0;
        }
    }
}

/* ------------------------------------------------------------- verbs */

/* The data to compress: text (UTF-8) or Bytes, and nothing else -- a number or
 * `undefined` is refused rather than compressed as the word it spells. */
static const uint8_t *gz_data(JSContext *ctx, JSValueConst v, const char *who,
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

static JSValue gz_finish_memory(JSContext *ctx, GConverter *conv, char *why,
                                GByteArray *out, const char *who)
{
    JSValue r;

    if (why) {
        r = JS_ThrowInternalError(ctx, "%s: %s", who, why);
        g_free(why);
    } else {
        r = bta_bytes_new(ctx, out->data, out->len);
    }
    g_byte_array_free(out, TRUE);
    g_object_unref(conv);
    return r;
}

static JSValue gzip_compress(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *who = "Gzip.Compress";
    size_t      len;
    const char *text;
    int         level;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Gzip.Compress(data, [{ Level }]) needs the data");
    if (!gz_level(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, who, &level))
        return JS_EXCEPTION;

    const uint8_t *data = gz_data(ctx, argv[0], who, &len, &text);
    if (!data)
        return JS_EXCEPTION;

    GConverter *conv = G_CONVERTER(g_zlib_compressor_new(G_ZLIB_COMPRESSOR_FORMAT_GZIP, level));
    GzSource    src  = { .mem = data, .memlen = len };
    GzSink      sink = { .mem = g_byte_array_new(), .max = UINT64_MAX };
    char       *why  = gz_run(conv, false, &src, &sink);

    if (text)
        JS_FreeCString(ctx, text);
    return gz_finish_memory(ctx, conv, why, sink.mem, who);
}

static JSValue gzip_decompress(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *who = "Gzip.Decompress";
    size_t      len;
    uint64_t    max;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Gzip.Decompress(bytes, [{ MaxSize }]) needs the bytes");
    const uint8_t *data = bta_bytes_get(argv[0], &len);
    if (!data)
        return JS_ThrowTypeError(ctx, "%s: the data is Bytes (compressed data is "
                                      "not text)", who);
    if (!gz_max(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, who, &max))
        return JS_EXCEPTION;

    GConverter *conv = G_CONVERTER(g_zlib_decompressor_new(G_ZLIB_COMPRESSOR_FORMAT_GZIP));
    GzSource    src  = { .mem = data, .memlen = len };
    GzSink      sink = { .mem = g_byte_array_new(), .max = max };
    char       *why  = gz_run(conv, true, &src, &sink);

    return gz_finish_memory(ctx, conv, why, sink.mem, who);
}

/* A file verb: stream `src` into a temporary beside `dst`, rename it over once
 * the stream is whole, and leave nothing behind otherwise. */
static JSValue gz_file(JSContext *ctx, int argc, JSValueConst *argv,
                       const char *who, bool inflate)
{
    int      level = 6;
    uint64_t max = UINT64_MAX;

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "%s(source, destination) needs both paths", who);

    if (inflate ? !gz_max(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, who, &max)
                : !gz_level(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, who, &level))
        return JS_EXCEPTION;

    const char *from = bta_file_path(ctx, argv[0], who);
    if (!from)
        return JS_EXCEPTION;
    const char *to = bta_file_path(ctx, argv[1], who);
    if (!to) {
        JS_FreeCString(ctx, from);
        return JS_EXCEPTION;
    }

    char *why = NULL, *tmp = NULL;
    bool  made = false;                    /* the temporary exists, and is ours to remove */
    FILE *in = g_fopen(from, "rb"), *out = NULL;
    uint64_t written = 0;

    if (!in) {
        why = g_strdup_printf("cannot read '%s': %s", from, g_strerror(errno));
    } else {
        tmp = g_strdup_printf("%s.XXXXXX", to);
        int fd = g_mkstemp(tmp);

        if (fd < 0) {
            why = g_strdup_printf("cannot write beside '%s': %s", to, g_strerror(errno));
        } else {
            made = true;
            if (!(out = fdopen(fd, "wb"))) {
                why = g_strdup_printf("cannot write beside '%s': %s", to, g_strerror(errno));
                close(fd);
            }
        }
    }

    if (!why) {
        GConverter *conv = inflate
            ? G_CONVERTER(g_zlib_decompressor_new(G_ZLIB_COMPRESSOR_FORMAT_GZIP))
            : G_CONVERTER(g_zlib_compressor_new(G_ZLIB_COMPRESSOR_FORMAT_GZIP, level));
        GzSource src  = { .file = in };
        GzSink   sink = { .file = out, .max = max };

        why = gz_run(conv, inflate, &src, &sink);
        written = sink.total;
        g_object_unref(conv);

        if (!why && fflush(out) != 0)
            why = g_strdup_printf("cannot write '%s': %s", to, g_strerror(errno));
    }

    if (in)
        fclose(in);
    if (out && fclose(out) != 0 && !why)
        why = g_strdup_printf("cannot write '%s': %s", to, g_strerror(errno));

    if (!why) {
#ifndef G_OS_WIN32
        /* What `gzip` does: the new file keeps the old one's permissions, and
         * not the 0600 a temporary is born with. */
        GStatBuf st;
        if (g_stat(from, &st) == 0)
            g_chmod(tmp, st.st_mode & 0777);
#endif
        if (g_rename(tmp, to) != 0)
            why = g_strdup_printf("cannot move the result to '%s': %s", to,
                                  g_strerror(errno));
    }

    if (why && made)
        g_remove(tmp);                      /* a refusal leaves no half-written file */
    g_free(tmp);

    JSValue r;
    if (why) {
        r = JS_ThrowInternalError(ctx, "%s: %s", who, why);
        g_free(why);
    } else {
        r = JS_NewFloat64(ctx, (double)written);
    }
    JS_FreeCString(ctx, from);
    JS_FreeCString(ctx, to);
    return r;
}

static JSValue gzip_compress_file(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    return gz_file(ctx, argc, argv, "Gzip.CompressFile", false);
}

static JSValue gzip_decompress_file(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    return gz_file(ctx, argc, argv, "Gzip.DecompressFile", true);
}

static const JSCFunctionListEntry gzip_props[] = {
    /* Compress(data, [{ Level }]) -> Bytes
     *   `data` (text as its UTF-8, or a
     *   [`Bytes`](docs/llm/library.md#bytes)) as one gzip member. `Level` is 1
     *   (fast) to 9 (small), 6 unless told. A second option, or a value that is
     *   neither text nor `Bytes`, is refused. About 50 MB a second: a big one
     *   belongs in a [`Task`](docs/llm/library.md#task)
     */
    JS_CFUNC_DEF("Compress", 2, gzip_compress),
    /* Decompress(bytes, [{ MaxSize }]) -> Bytes
     *   what `bytes` holds, **all of it**: members glued together are read to
     *   the end, a stream that stops inside one **throws** (naming how far it
     *   got) rather than answering what it had, and so does anything that is
     *   not gzip. The answer may not pass `MaxSize` bytes (256 MiB unless
     *   told), because a few kilobytes can inflate to gigabytes. Text comes
     *   out as `ToText()` of the answer
     */
    JS_CFUNC_DEF("Decompress", 2, gzip_decompress),
    /* CompressFile(source, destination, [{ Level }]) -> number
     *   gzips a file into another **without loading it**, 64 KB at a time, and
     *   answers the bytes written. The destination appears only when it is
     *   whole: a failure leaves no half-written file, and an existing one is
     *   untouched
     */
    JS_CFUNC_DEF("CompressFile", 3, gzip_compress_file),
    /* DecompressFile(source, destination, [{ MaxSize }]) -> number
     *   the reverse, streamed, with the same ceiling and the same promise about
     *   the destination. Answers the bytes written
     */
    JS_CFUNC_DEF("DecompressFile", 3, gzip_decompress_file),
};

void bta_gzip_init(JSContext *ctx, JSValue global)
{
    JSValue gzip = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, gzip, gzip_props, G_N_ELEMENTS(gzip_props));
    JS_SetPropertyStr(ctx, global, "Gzip", gzip);
}
