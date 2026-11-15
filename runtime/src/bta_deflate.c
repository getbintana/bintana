/*
 * The engine behind `Gzip` and `Zlib`, in one place.
 *
 * GIO's converters are the algorithm; what is written here is the part the
 * surfaces share and the part they do not:
 *
 * - **A truncated stream is an error**, and it names how many bytes of input
 *   it had consumed. What was decoded before the break is never returned.
 * - **A few kilobytes inflate to gigabytes**, so the sink has a ceiling and a
 *   refusal says it is the ceiling.
 * - **A file verb streams 64 KB at a time**, and writes a temporary beside the
 *   destination, renamed over it only once the stream is whole.
 * - **gzip is members glued together** (`cat a.gz b.gz`), read to the end;
 *   zlib and raw are one stream, and bytes after it are refused. Raw DEFLATE
 *   has no checksum at all, so damage that still decodes is a different
 *   document and a success -- the surfaces say so.
 */

#include "bta.h"
#include "bta_deflate.h"

#include <errno.h>
#include <string.h>

#define BTA_DEFLATE_CHUNK 65536

static const char *deflate_name(BtaDeflateFormat format)
{
    switch (format) {
    case BTA_DEFLATE_GZIP: return "gzip";
    case BTA_DEFLATE_ZLIB: return "zlib";
    case BTA_DEFLATE_RAW:  return "raw deflate";
    }
    return "compressed";
}

GConverter *bta_deflate_compressor(BtaDeflateFormat format, int level)
{
    switch (format) {
    case BTA_DEFLATE_GZIP:
        return G_CONVERTER(g_zlib_compressor_new(G_ZLIB_COMPRESSOR_FORMAT_GZIP, level));
    case BTA_DEFLATE_ZLIB:
        return G_CONVERTER(g_zlib_compressor_new(G_ZLIB_COMPRESSOR_FORMAT_ZLIB, level));
    case BTA_DEFLATE_RAW:
        return G_CONVERTER(g_zlib_compressor_new(G_ZLIB_COMPRESSOR_FORMAT_RAW, level));
    }
    return NULL;
}

GConverter *bta_deflate_decompressor(BtaDeflateFormat format)
{
    switch (format) {
    case BTA_DEFLATE_GZIP:
        return G_CONVERTER(g_zlib_decompressor_new(G_ZLIB_COMPRESSOR_FORMAT_GZIP));
    case BTA_DEFLATE_ZLIB:
        return G_CONVERTER(g_zlib_decompressor_new(G_ZLIB_COMPRESSOR_FORMAT_ZLIB));
    case BTA_DEFLATE_RAW:
        return G_CONVERTER(g_zlib_decompressor_new(G_ZLIB_COMPRESSOR_FORMAT_RAW));
    }
    return NULL;
}

/* Up to `cap` bytes of input; 0 is the end. `*failed` for a read error. */
static size_t deflate_read(BtaDeflateSource *s, guint8 *buf, size_t cap,
                           bool *failed)
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

static bool deflate_write(BtaDeflateSink *k, const guint8 *buf, size_t n)
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

char *bta_deflate_run(GConverter *conv, bool inflate, BtaDeflateFormat format,
                      BtaDeflateSource *src, BtaDeflateSink *sink)
{
    guint8   in[BTA_DEFLATE_CHUNK], out[BTA_DEFLATE_CHUNK];
    size_t   have = 0, off = 0;
    uint64_t consumed = 0, member_start = 0;
    bool     eof = false, in_stream = false, failed = false;
    bool     members = format == BTA_DEFLATE_GZIP;
    const char *name = deflate_name(format);
    int      stalled = 0;

    for (;;) {
        /* Between two chunks: a stop reaches a big file within 64 KB. The
         * file verbs then remove their temporary, as for any refusal. */
        if (src->cancel && g_cancellable_is_cancelled(src->cancel))
            return g_strdup("cancelled");

        if (off == have && !eof) {
            have = deflate_read(src, in, sizeof in, &failed);
            off  = 0;
            if (failed)
                return g_strdup_printf("cannot read the input: %s",
                                       bta_errno_text(errno));
            if (have == 0)
                eof = true;
        }

        if (inflate && off == have && eof) {
            if (in_stream) {
                if (members)
                    return g_strdup_printf("the data is truncated: the stream ends "
                                           "inside a member, after %" G_GUINT64_FORMAT
                                           " bytes of input", consumed);
                return g_strdup_printf("the data is truncated: the %s stream ends "
                                       "after %" G_GUINT64_FORMAT " bytes of input",
                                       name, consumed);
            }
            /* gzip: the input ended between two members, which is a whole
             * stream. zlib and raw: there was no stream at all. */
            if (members && consumed > 0)
                return NULL;
            if (members)
                return g_strdup("empty input is not gzip data");
            return g_strdup_printf("empty input is not %s data", name);
        }

        if (members && !in_stream)
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
            in_stream = true;

        if (!deflate_write(sink, out, bw)) {
            g_clear_error(&err);
            if (sink->exceeded)
                return g_strdup_printf("the output exceeds MaxSize (%" G_GUINT64_FORMAT
                                       " bytes) -- raise it with { MaxSize } if "
                                       "this data is trusted", sink->max);
            return g_strdup_printf("cannot write the output: %s",
                                   bta_errno_text(errno));
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
                msg = g_strdup(bta_gerror_text(err));
            else if (!members)
                msg = g_strdup_printf("not %s data, or damaged", name);
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
            if (members) {
                /* **The member ended and the input may not have**: concatenated
                 * members are valid gzip, and the converter would stop here and
                 * report success -- which is the silent half-answer this refuses. */
                g_converter_reset(conv);
                in_stream = false;
                stalled   = 0;
                continue;
            }
            /* zlib and raw are one stream: bytes after it are refused, naming
             * the byte, never read as a second stream. */
            if (off < have)
                return g_strdup_printf("bytes after the %s stream at byte %"
                                       G_GUINT64_FORMAT, name, consumed);
            if (!eof) {
                have = deflate_read(src, in, sizeof in, &failed);
                off  = 0;
                if (failed)
                    return g_strdup_printf("cannot read the input: %s",
                                           bta_errno_text(errno));
                if (have == 0)
                    eof = true;
                else
                    return g_strdup_printf("bytes after the %s stream at byte %"
                                           G_GUINT64_FORMAT, name, consumed);
            }
            return NULL;
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
