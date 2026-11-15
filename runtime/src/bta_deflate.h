/*
 * The engine behind `Gzip` and `Zlib`: GIO's zlib converters over memory or a
 * file, with the ceiling, the truncation rule and the sentences both surfaces
 * quote. Private to the runtime; `bta_gzip.c` is the only user besides
 * `bta_zlib.c`, so there is one loop and one answer to each question.
 */
#ifndef BTA_DEFLATE_H
#define BTA_DEFLATE_H

#include <gio/gio.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

typedef enum {
    BTA_DEFLATE_GZIP,   /* RFC 1952: members, concatenated streams valid */
    BTA_DEFLATE_ZLIB,   /* RFC 1950: one stream, Adler-32 at the end */
    BTA_DEFLATE_RAW     /* RFC 1951: one stream, no checksum at all */
} BtaDeflateFormat;

/* Where the input comes from and where the output goes: memory or a file, so
 * one loop serves both and the cap and the truncation rule are written once. */
typedef struct {
    const guint8 *mem;
    size_t        memlen, mempos;
    FILE         *file;
    GCancellable *cancel;           /* the caller's, or NULL; asked per chunk */
} BtaDeflateSource;

typedef struct {
    GByteArray *mem;
    FILE       *file;
    uint64_t    total, max;
    bool        exceeded;
} BtaDeflateSink;

GConverter *bta_deflate_compressor(BtaDeflateFormat format, int level);
GConverter *bta_deflate_decompressor(BtaDeflateFormat format);

/*
 * Runs a converter over `src` into `sink`. Answers NULL on success and a newly
 * allocated sentence (for the caller to throw and free) when it did not -- a
 * string rather than an exception so that the caller cleans up its temporary
 * file *before* throwing.
 */
char *bta_deflate_run(GConverter *conv, bool inflate, BtaDeflateFormat format,
                      BtaDeflateSource *src, BtaDeflateSink *sink);

#endif
