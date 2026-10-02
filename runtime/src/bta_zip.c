/*
 * Zip -- reading the container every office document, ebook and jar is.
 *
 *     const z = Zip.Open("accounts.xlsx");
 *     for (const e of z.Entries) print(e.Name, e.Size);
 *     const sheet = Xml.ParseBytes(z.Read("xl/worksheets/sheet1.xml"));
 *     z.ExtractAll("/tmp/accounts");
 *     z.Close();
 *
 * There is no zip in GIO and neither libzip nor libarchive is on every machine
 * this builds on -- an optional dependency would be a branch nobody here can
 * compile, which is the Windows-port problem again -- so this is a small reader of
 * our own over `GZlibDecompressor`'s RAW format, and **its scope was measured, not
 * assumed**: 49 real documents (`.docx`, `.xlsx`, `.odt`, `.ods`) held 859 entries,
 * every one stored or deflated, none encrypted, none zip64, none with a name that
 * leaves its folder, at most 34 entries and 1 MB an entry. Everything outside that
 * is refused **by name**, so a file this cannot read says why rather than being
 * read wrongly (docs/plans/crypto-compress-plan.md).
 *
 * ## The directory at the end, and only it
 *
 * A zip is read from its **central directory**, which is at the end of the file,
 * and the sizes and the CRC come from there. Not from the local header in front of
 * each entry: 271 of those 859 entries had a data descriptor, meaning the local
 * header does not know the size at all -- LibreOffice writes one on every entry --
 * so a reader that trusted local headers would fail a third of the files that are
 * on this desktop. The local header is read only to find where the data starts, and
 * its *name* must agree with the directory's, or the archive is refused: two
 * readers that disagree about what is in a file is how a hostile archive shows one
 * thing to a scanner and another to an application.
 *
 * ## What is checked, every time
 *
 * - **The CRC-32 of every entry read.** Not trusted because deflate finished: a
 *   damaged entry that inflates to the right length is exactly the one that comes
 *   back wrong. A mismatch throws, never answers.
 * - **A ceiling on the size.** A few hundred bytes of zip inflate to gigabytes, and
 *   the directory's own `Size` is a number the archive's author chose, so it is
 *   compared with `MaxSize` (256 MiB) **before** anything is allocated, and the
 *   inflater is stopped if it produces more than the directory said it would.
 * - **Names, before any is made into a path.** `ExtractAll` and `Extract` refuse an
 *   absolute name, a drive letter, a backslash, a `..` or empty component, and a NUL
 *   -- the zip-slip class, an entry called `../../.ssh/authorized_keys` -- and
 *   **refuse the whole archive before writing a byte**, so a refusal leaves nothing.
 *   Only regular files and folders are ever made: there is no mode and no link in
 *   what this writes, so an archive cannot plant a symlink. A symlink already in the
 *   destination is the caller's, as it is for every extractor.
 * - **A name listed twice** is refused when the archive is opened: which of the two
 *   an application reads is another thing two readers can disagree about.
 *
 * ## Refused, and what reopens it
 *
 * Encryption, zip64 (past 4 GiB or 65,535 entries), a multi-disk archive and any
 * method other than stored and deflate. Each is a sentence naming the feature; an
 * encrypted *entry* does not stop the others being read. Names are UTF-8 -- the
 * flag says so in 398 of 398 entries that have a non-ASCII or any name here -- and
 * a name that is not valid UTF-8 is read with the bad bytes replaced rather than
 * guessed at as a code page. Reopened by a file that shows it.
 *
 * ## The archive is held in memory, up to a size
 *
 * A file read into memory cannot be hurt by another program truncating it; a file
 * mapped can, with a `SIGBUS` that ends this process. So an archive up to 32 MiB is
 * copied and a bigger one is mapped, and the second case's risk is stated here
 * rather than hidden: do not open a zip that is still being written.
 *
 * Nothing here calls back or keeps a list, so a `Task` has it too; a handle stays in
 * the thread that opened it.
 */

#include "bta.h"

#include <glib/gstdio.h>
#include <gio/gio.h>

#include <errno.h>
#include <math.h>
#include <string.h>

#define ZIP_DEFAULT_MAX  ((uint64_t)256 * 1024 * 1024)
#define ZIP_COPY_LIMIT   ((gsize)32 * 1024 * 1024)

typedef struct {
    char    *name;
    guint32  crc, csize, usize, offset;
    guint16  method, flags, dostime, dosdate;
    bool     dir, nul;     /* a folder; a NUL somewhere in the stored name */
} ZipEntry;

typedef struct {
    GMappedFile *map;          /* NULL when `copy` holds the archive */
    guint8      *copy;
    const guint8 *data;
    gsize        len;
    ZipEntry    *ent;
    guint        n;
    gsize        cd_start;     /* where the central directory begins */
    GHashTable  *byname;       /* name -> index + 1 */
    bool         closed;
} BtaZip;

static JSClassID bta_zip_class_id;

static void zip_release(BtaZip *z)
{
    if (z->ent)
        for (guint i = 0; i < z->n; i++)
            g_free(z->ent[i].name);
    g_free(z->ent);
    z->ent = NULL;
    z->n   = 0;
    if (z->byname)
        g_hash_table_destroy(z->byname);
    z->byname = NULL;
    if (z->map)
        g_mapped_file_unref(z->map);
    z->map = NULL;
    g_free(z->copy);
    z->copy = NULL;
    z->data = NULL;
    z->closed = true;
}

static void zip_finalizer(JSRuntime *rt, JSValue val)
{
    BtaZip *z = JS_GetOpaque(val, bta_zip_class_id);

    if (!z)
        return;
    zip_release(z);
    g_free(z);
}

static const JSClassDef zip_class = {
    "ZipArchive",
    .finalizer = zip_finalizer,
};

/* ------------------------------------------------------------- the bytes */

static guint16 le16(const guint8 *p) { return (guint16)(p[0] | p[1] << 8); }
static guint32 le32(const guint8 *p)
{
    return (guint32)p[0] | (guint32)p[1] << 8 | (guint32)p[2] << 16 | (guint32)p[3] << 24;
}

/* CRC-32 (IEEE 802.3), the table built once. `GZlibCompressor` does not expose
 * it and `zlib.h` is not a header this needs for anything else. The test for it
 * is the standard's own: "123456789" is 0xCBF43926. */
static guint32 crc32_of(const guint8 *p, size_t n)
{
    static guint32 table[256];
    static bool    ready;

    if (!ready) {
        for (guint32 i = 0; i < 256; i++) {
            guint32 c = i;
            for (int k = 0; k < 8; k++)
                c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
        ready = true;
    }
    guint32 c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++)
        c = table[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

/* ---------------------------------------------------------------- opening */

/* A sentence for the thrower to own, or NULL. */
static char *zip_parse(BtaZip *z)
{
    const guint8 *d = z->data;
    gsize         len = z->len;

    if (len < 22)
        return g_strdup("not a zip file (too short to hold a directory)");

    /* The end-of-central-directory record is the last thing in the file, followed
     * only by a comment of up to 65,535 bytes: so it is looked for backwards. */
    gsize eocd = G_MAXSIZE;
    gsize low  = len > 22 + 65535 ? len - 22 - 65535 : 0;

    for (gsize i = len - 22 + 1; i-- > low;) {
        if (le32(d + i) == 0x06054b50u) {
            eocd = i;
            break;
        }
    }
    if (eocd == G_MAXSIZE)
        return g_strdup("not a zip file (no end-of-directory record)");

    const guint8 *e = d + eocd;
    guint16 disk = le16(e + 4), cddisk = le16(e + 6);
    guint16 here = le16(e + 8), total = le16(e + 10);
    guint32 cdsize = le32(e + 12), cdoff = le32(e + 16);

    if (eocd >= 20 && le32(d + eocd - 20) == 0x07064b50u)
        return g_strdup("this is a zip64 archive, which is not read yet (past 4 GiB "
                        "or 65,535 entries)");
    if (total == 0xFFFF || cdsize == 0xFFFFFFFFu || cdoff == 0xFFFFFFFFu)
        return g_strdup("this is a zip64 archive, which is not read yet");
    if (disk != 0 || cddisk != 0 || here != total)
        return g_strdup("this archive is split over several disks, which is not read");
    if ((gsize)cdoff + cdsize > eocd)
        return g_strdup("the archive's directory points outside it: it is damaged "
                        "or incomplete");

    z->cd_start = cdoff;
    z->ent      = g_new0(ZipEntry, total ? total : 1);
    z->byname   = g_hash_table_new(g_str_hash, g_str_equal);

    gsize at = cdoff;

    for (guint i = 0; i < total; i++) {
        if (at + 46 > cdoff + (gsize)cdsize || le32(d + at) != 0x02014b50u)
            return g_strdup_printf("the directory is damaged at entry %u", i + 1);

        const guint8 *c = d + at;
        guint16 nlen = le16(c + 28), xlen = le16(c + 30), clen = le16(c + 32);
        ZipEntry *x = &z->ent[i];

        if (at + 46 + nlen + xlen + clen > cdoff + (gsize)cdsize)
            return g_strdup_printf("the directory is damaged at entry %u", i + 1);

        x->flags   = le16(c + 8);
        x->method  = le16(c + 10);
        x->dostime = le16(c + 12);
        x->dosdate = le16(c + 14);
        x->crc     = le32(c + 16);
        x->csize   = le32(c + 20);
        x->usize   = le32(c + 24);
        x->offset  = le32(c + 42);

        if (x->csize == 0xFFFFFFFFu || x->usize == 0xFFFFFFFFu || x->offset == 0xFFFFFFFFu)
            return g_strdup("this is a zip64 archive, which is not read yet");

        /* The name may hold anything, a NUL included: `make_valid` makes text of it
         * and a C string ends at a NUL, so whether there was one is remembered
         * (`nul`) for the check that decides whether a name may become a path. */
        x->name = g_utf8_make_valid((const char *)(c + 46), nlen);
        x->dir  = nlen > 0 && c[46 + nlen - 1] == '/';
        x->nul  = memchr(c + 46, '\0', nlen) != NULL;

        if (g_hash_table_contains(z->byname, x->name))
            return g_strdup_printf("the name '%s' is listed twice, and which one an "
                                   "application reads is not something to leave to "
                                   "chance", x->name);
        g_hash_table_insert(z->byname, x->name, GUINT_TO_POINTER(i + 1));

        at += 46 + nlen + xlen + clen;
        z->n = i + 1;
    }
    return NULL;
}

static BtaZip *zip_this(JSContext *ctx, JSValueConst this_val)
{
    BtaZip *z = JS_GetOpaque2(ctx, this_val, bta_zip_class_id);

    if (!z)
        return NULL;
    if (z->closed) {
        JS_ThrowTypeError(ctx, "the archive is closed");
        return NULL;
    }
    return z;
}

static JSValue zip_open(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? bta_file_path(ctx, argv[0], "Zip.Open") : NULL;

    if (!path)
        return JS_ThrowTypeError(ctx, "Zip.Open(path) needs a path");

    BtaZip *z = g_new0(BtaZip, 1);
    GError *err = NULL;
    GStatBuf st;

    if (g_stat(path, &st) != 0) {
        JSValue r = JS_ThrowInternalError(ctx, "Zip.Open: cannot read '%s': %s",
                                          path, g_strerror(errno));
        g_free(z);
        JS_FreeCString(ctx, path);
        return r;
    }

    if ((guint64)st.st_size <= ZIP_COPY_LIMIT) {
        gsize n = 0;
        gchar *buf = NULL;

        if (!g_file_get_contents(path, &buf, &n, &err)) {
            JSValue r = JS_ThrowInternalError(ctx, "Zip.Open: cannot read '%s': %s",
                                              path, g_strerror(errno));
            g_clear_error(&err);
            g_free(z);
            JS_FreeCString(ctx, path);
            return r;
        }
        z->copy = (guint8 *)buf;
        z->data = z->copy;
        z->len  = n;
    } else {
        z->map = g_mapped_file_new(path, FALSE, &err);
        if (!z->map) {
            JSValue r = JS_ThrowInternalError(ctx, "Zip.Open: cannot read '%s': %s",
                                              path, g_strerror(errno));
            g_clear_error(&err);
            g_free(z);
            JS_FreeCString(ctx, path);
            return r;
        }
        z->data = (const guint8 *)g_mapped_file_get_contents(z->map);
        z->len  = g_mapped_file_get_length(z->map);
    }

    char *why = zip_parse(z);

    if (why) {
        JSValue r = JS_ThrowInternalError(ctx, "Zip.Open: '%s' is %s", path, why);
        g_free(why);
        zip_release(z);
        g_free(z);
        JS_FreeCString(ctx, path);
        return r;
    }
    JS_FreeCString(ctx, path);

    JSValue proto = JS_GetClassProto(ctx, bta_zip_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bta_zip_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        zip_release(z);
        g_free(z);
        return obj;
    }
    JS_SetOpaque(obj, z);
    return obj;
}

/* ---------------------------------------------------------------- reading */

/* DOS date and time, which carry no zone and count in twos: a real Date, as
 * `File.Info` answers, or null for a field that is not a date (all zeroes is what
 * a writer that does not know the time leaves). Local time, since that is what it
 * means. */
static JSValue zip_modified(JSContext *ctx, const ZipEntry *x)
{
    int year = 1980 + (x->dosdate >> 9), mon = (x->dosdate >> 5) & 15, day = x->dosdate & 31;
    int hour = x->dostime >> 11, min = (x->dostime >> 5) & 63, sec = (x->dostime & 31) * 2;

    if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59)
        return JS_NULL;

    GDateTime *when = g_date_time_new_local(year, mon, day, hour, min, sec);

    if (!when)
        return JS_NULL;

    JSValue d = JS_NewDate(ctx, (double)g_date_time_to_unix(when) * 1000.0);

    g_date_time_unref(when);
    return d;
}

static JSValue zip_get_entries(JSContext *ctx, JSValueConst this_val)
{
    BtaZip *z = zip_this(ctx, this_val);

    if (!z)
        return JS_EXCEPTION;

    JSValue arr = JS_NewArray(ctx);

    for (guint i = 0; i < z->n; i++) {
        const ZipEntry *x = &z->ent[i];
        JSValue o = JS_NewObject(ctx);

        JS_SetPropertyStr(ctx, o, "Name", JS_NewString(ctx, x->name));
        JS_SetPropertyStr(ctx, o, "Size", JS_NewFloat64(ctx, x->usize));
        JS_SetPropertyStr(ctx, o, "Compressed", JS_NewFloat64(ctx, x->csize));
        JS_SetPropertyStr(ctx, o, "Modified", zip_modified(ctx, x));
        JS_SetPropertyStr(ctx, o, "IsDir", JS_NewBool(ctx, x->dir));
        JS_SetPropertyUint32(ctx, arr, i, o);
    }
    return arr;
}

/* Why this entry cannot be read, or NULL. A sentence for the caller to free. */
static char *zip_unsupported(const ZipEntry *x)
{
    if (x->flags & 1)
        return g_strdup_printf("'%s' is encrypted, which is not read yet", x->name);
    if (x->method != 0 && x->method != 8)
        return g_strdup_printf("'%s' is compressed with method %u, and only stored and "
                               "deflate are read", x->name, x->method);
    return NULL;
}

/* Inflates one RAW deflate stream, into `out`, no further than `cap` bytes. A
 * sentence on failure. The converter's own message is never quoted -- it is
 * translated into the desktop's language. */
static char *zip_inflate(const guint8 *in, gsize inlen, gsize cap, GByteArray *out)
{
    GConverter *conv = G_CONVERTER(g_zlib_decompressor_new(G_ZLIB_COMPRESSOR_FORMAT_RAW));
    guint8      buf[65536];
    gsize       off = 0;
    char       *why = NULL;

    for (;;) {
        gsize br = 0, bw = 0;
        GError *err = NULL;
        GConverterResult r = g_converter_convert(conv, in + off, inlen - off, buf,
                                                 sizeof buf, 0, &br, &bw, &err);
        off += br;

        if (out->len + bw > cap) {
            why = g_strdup("it inflates to more than the directory says it holds");
            g_clear_error(&err);
            break;
        }
        g_byte_array_append(out, buf, (guint)bw);

        if (r == G_CONVERTER_ERROR) {
            if (g_error_matches(err, G_IO_ERROR, G_IO_ERROR_PARTIAL_INPUT)) {
                g_clear_error(&err);
                why = g_strdup("its compressed data stops before the stream ends");
            } else {
                g_clear_error(&err);
                why = g_strdup("its compressed data is damaged");
            }
            break;
        }
        if (r == G_CONVERTER_FINISHED)
            break;
        if (br == 0 && bw == 0) {
            why = g_strdup("its compressed data stops before the stream ends");
            break;
        }
    }
    g_object_unref(conv);
    return why;
}

/*
 * One entry's bytes, checked: the local header agrees with the directory, the size
 * is under `max`, the inflater stops where the directory said, and the CRC matches.
 * NULL with a sentence in `*why` otherwise. The caller owns the array.
 */
static GByteArray *zip_read_entry(BtaZip *z, const ZipEntry *x, uint64_t max, char **why)
{
    *why = zip_unsupported(x);
    if (*why)
        return NULL;

    if (x->usize > max) {
        *why = g_strdup_printf("'%s' is %u bytes, which is over the ceiling (%"
                               G_GUINT64_FORMAT " -- raise it with { MaxSize } if "
                               "this archive is trusted)", x->name, x->usize, max);
        return NULL;
    }

    gsize lh = x->offset;

    if (lh + 30 > z->cd_start || le32(z->data + lh) != 0x04034b50u) {
        *why = g_strdup_printf("the local header of '%s' is missing or damaged", x->name);
        return NULL;
    }
    guint16 nlen = le16(z->data + lh + 26), xlen = le16(z->data + lh + 28);
    gsize   start = lh + 30 + nlen + xlen;

    if (start > z->cd_start || (gsize)x->csize > z->cd_start - start) {
        *why = g_strdup_printf("the data of '%s' runs past the archive's directory", x->name);
        return NULL;
    }

    /* The two names must be the same bytes: an archive that says one thing in its
     * directory and another in front of the data is showing different readers
     * different files. */
    char *local = g_utf8_make_valid((const char *)z->data + lh + 30, nlen);
    bool  same  = strcmp(local, x->name) == 0;

    g_free(local);
    if (!same) {
        *why = g_strdup_printf("the local header of '%s' names something else than "
                               "the directory does", x->name);
        return NULL;
    }

    GByteArray *out = g_byte_array_sized_new(x->usize ? x->usize : 1);

    if (x->method == 0) {
        if (x->csize != x->usize)
            *why = g_strdup_printf("'%s' is stored but its two sizes differ", x->name);
        else
            g_byte_array_append(out, z->data + start, x->csize);
    } else {
        char *bad = zip_inflate(z->data + start, x->csize, x->usize, out);

        if (bad) {
            *why = g_strdup_printf("'%s': %s", x->name, bad);
            g_free(bad);
        }
    }

    if (!*why && out->len != x->usize)
        *why = g_strdup_printf("'%s' holds %u bytes where the directory says %u",
                               x->name, out->len, x->usize);
    if (!*why && crc32_of(out->data, out->len) != x->crc)
        *why = g_strdup_printf("'%s' does not match its checksum: the archive is damaged",
                               x->name);

    if (*why) {
        g_byte_array_free(out, TRUE);
        return NULL;
    }
    return out;
}

static const ZipEntry *zip_find(BtaZip *z, const char *name)
{
    gpointer v = g_hash_table_lookup(z->byname, name);

    return v ? &z->ent[GPOINTER_TO_UINT(v) - 1] : NULL;
}

static bool zip_max(JSContext *ctx, JSValueConst opts, const char *who, uint64_t *max)
{
    *max = ZIP_DEFAULT_MAX;
    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;
    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "%s: the options are an object with `MaxSize`", who);
        return false;
    }

    JSPropertyEnum *tab;
    uint32_t        len;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;
    for (uint32_t i = 0; i < len; i++) {
        const char *name = JS_AtomToCString(ctx, tab[i].atom);
        bool        known = name && strcmp(name, "MaxSize") == 0;

        if (!known) {
            JS_ThrowTypeError(ctx, "%s: '%s' is not an option (the option is `MaxSize`)",
                              who, name ? name : "?");
            if (name)
                JS_FreeCString(ctx, name);
            JS_FreePropertyEnum(ctx, tab, len);
            return false;
        }
        JS_FreeCString(ctx, name);
    }
    JS_FreePropertyEnum(ctx, tab, len);

    JSValue v = JS_GetPropertyStr(ctx, opts, "MaxSize");
    double  d;

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
    *max = d >= 1.8e19 ? UINT64_MAX : (uint64_t)d;
    return true;
}

static JSValue zip_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaZip *z = zip_this(ctx, this_val);

    if (!z)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "ZipArchive.Read(name, [{ MaxSize }]) needs the "
                                      "entry's name, as text");

    uint64_t max;

    if (!zip_max(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "ZipArchive.Read", &max))
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, argv[0]);

    if (!name)
        return JS_EXCEPTION;

    const ZipEntry *x = zip_find(z, name);
    JSValue r;

    if (!x) {
        r = JS_ThrowInternalError(ctx, "ZipArchive.Read: there is no entry '%s'", name);
    } else if (x->dir) {
        r = JS_ThrowInternalError(ctx, "ZipArchive.Read: '%s' is a folder", name);
    } else {
        char       *why = NULL;
        GByteArray *b   = zip_read_entry(z, x, max, &why);

        if (!b) {
            r = JS_ThrowInternalError(ctx, "ZipArchive.Read: %s", why);
            g_free(why);
        } else {
            r = bta_bytes_new(ctx, b->data, b->len);
            g_byte_array_free(b, TRUE);
        }
    }
    JS_FreeCString(ctx, name);
    return r;
}

/* ------------------------------------------------------------ extracting */

/*
 * Whether an entry's name may become part of a path, and why not. Everything a
 * name can do to leave the folder it is extracted into is refused *as a name*,
 * before a path is built: an absolute path, a drive letter (`C:`), a backslash
 * (which Windows reads as a separator and Linux as a letter, so an archive that
 * means one is not safe for the other), an empty or `.` or `..` component, and a
 * NUL, which would end the path early in C.
 */
static char *zip_bad_name(const ZipEntry *x)
{
    const char *n = x->name;

    if (!*n)
        return g_strdup("an entry has no name");
    if (x->nul)
        return g_strdup_printf("'%s' has a NUL in its name, which would end a path early", n);
    if (n[0] == '/' || strchr(n, '\\') || (g_ascii_isalpha(n[0]) && n[1] == ':'))
        return g_strdup_printf("'%s' is an absolute or drive path, or uses a backslash", n);

    char **parts = g_strsplit(n, "/", -1);
    bool   bad = false;
    guint  count = g_strv_length(parts);

    for (guint i = 0; i < count; i++) {
        /* A folder's name ends in `/`, so its last component is empty and fine. */
        if (i == count - 1 && !*parts[i])
            continue;
        if (!*parts[i] || strcmp(parts[i], ".") == 0 || strcmp(parts[i], "..") == 0)
            bad = true;
    }
    g_strfreev(parts);
    return bad ? g_strdup_printf("'%s' would leave the folder it is extracted into, "
                                 "or has an empty part", n) : NULL;
}

static bool zip_write_file(const char *dest, const guint8 *data, gsize n, char **why)
{
    GError *err = NULL;

    if (!g_file_set_contents(dest, (const gchar *)(data ? data : (const guint8 *)""),
                             (gssize)n, &err)) {
        *why = g_strdup_printf("cannot write '%s': %s", dest, g_strerror(errno));
        g_clear_error(&err);
        return false;
    }
    return true;
}

static JSValue zip_extract(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaZip *z = zip_this(ctx, this_val);

    if (!z)
        return JS_EXCEPTION;
    if (argc < 2 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "ZipArchive.Extract(name, path, [{ MaxSize }]) "
                                      "needs an entry's name and a path");

    uint64_t max;

    if (!zip_max(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "ZipArchive.Extract", &max))
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, argv[0]);

    if (!name)
        return JS_EXCEPTION;

    const char *dest = bta_file_path(ctx, argv[1], "ZipArchive.Extract");

    if (!dest) {
        JS_FreeCString(ctx, name);
        return JS_EXCEPTION;
    }

    const ZipEntry *x = zip_find(z, name);
    char *why = NULL;
    JSValue r = JS_UNDEFINED;

    if (!x)
        why = g_strdup_printf("there is no entry '%s'", name);
    else if (x->dir)
        why = g_strdup_printf("'%s' is a folder", name);
    else {
        GByteArray *b = zip_read_entry(z, x, max, &why);

        if (b) {
            zip_write_file(dest, b->data, b->len, &why);
            g_byte_array_free(b, TRUE);
        }
    }
    if (why) {
        r = JS_ThrowInternalError(ctx, "ZipArchive.Extract: %s", why);
        g_free(why);
    }
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, dest);
    return r;
}

static JSValue zip_extract_all(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaZip *z = zip_this(ctx, this_val);

    if (!z)
        return JS_EXCEPTION;

    const char *dir = argc > 0 ? bta_file_path(ctx, argv[0], "ZipArchive.ExtractAll") : NULL;

    if (!dir)
        return JS_ThrowTypeError(ctx, "ZipArchive.ExtractAll(folder, [{ MaxSize }]) needs a folder");

    uint64_t max;

    if (!zip_max(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "ZipArchive.ExtractAll", &max)) {
        JS_FreeCString(ctx, dir);
        return JS_EXCEPTION;
    }

    /* **Everything is checked before anything is written**: every name, every
     * method, and the sum of the sizes against the ceiling -- so a refusal leaves
     * the destination as it was, not half an archive. */
    char    *why = NULL;
    uint64_t total = 0;

    for (guint i = 0; i < z->n && !why; i++) {
        const ZipEntry *x = &z->ent[i];

        why = zip_bad_name(x);
        if (!why && !x->dir)
            why = zip_unsupported(x);
        total += x->usize;
        if (!why && total > max)
            why = g_strdup_printf("the archive holds %" G_GUINT64_FORMAT "+ bytes, "
                                  "over the ceiling (%" G_GUINT64_FORMAT " -- raise it "
                                  "with { MaxSize } if it is trusted)", total, max);
    }

    guint files = 0;

    for (guint i = 0; i < z->n && !why; i++) {
        const ZipEntry *x = &z->ent[i];
        char *path = g_build_filename(dir, x->name, NULL);

        if (x->dir) {
            if (g_mkdir_with_parents(path, 0755) != 0)
                why = g_strdup_printf("cannot make '%s': %s", path, g_strerror(errno));
        } else {
            char *parent = g_path_get_dirname(path);

            if (g_mkdir_with_parents(parent, 0755) != 0) {
                why = g_strdup_printf("cannot make '%s': %s", parent, g_strerror(errno));
            } else {
                GByteArray *b = zip_read_entry(z, x, max, &why);

                if (b) {
                    if (zip_write_file(path, b->data, b->len, &why))
                        files++;
                    g_byte_array_free(b, TRUE);
                }
            }
            g_free(parent);
        }
        g_free(path);
    }

    JSValue r;

    if (why) {
        r = JS_ThrowInternalError(ctx, "ZipArchive.ExtractAll: %s", why);
        g_free(why);
    } else {
        r = JS_NewFloat64(ctx, files);
    }
    JS_FreeCString(ctx, dir);
    return r;
}

static JSValue zip_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaZip *z = JS_GetOpaque2(ctx, this_val, bta_zip_class_id);

    if (!z)
        return JS_EXCEPTION;
    zip_release(z);                  /* closing twice is not an error */
    return JS_UNDEFINED;
}

/* type ZipArchive */
static const JSCFunctionListEntry zip_proto_props[] = {
    /* Entries -> { Name, Size, Compressed, Modified, IsDir }[]
     *   what the archive holds, in the order its directory lists it. `Size` is
     *   what the entry inflates to and `Compressed` what it occupies; `Modified`
     *   is a `Date` in local time (a zip carries no zone, and counts in two-second
     *   steps), or `null`; a folder's `Name` ends in `/`. A copy: it outlives
     *   `Close()`
     */
    JS_CGETSET_DEF("Entries", zip_get_entries, NULL),
    /* Read(name, [{ MaxSize }]) -> Bytes
     *   one entry's bytes. **Throws, and never answers wrong**: an entry whose
     *   data does not match its checksum, that inflates to more than its
     *   directory says, whose local header disagrees with the directory, that is
     *   encrypted or uses a method other than stored and deflate, or is over
     *   `MaxSize` (256 MiB unless told) is refused with a sentence naming it
     */
    JS_CFUNC_DEF("Read", 2, zip_read),
    /* Extract(name, path, [{ MaxSize }])
     *   one entry written to `path`, atomically, as `File.Save` writes. The
     *   folder `path` is in must exist. Same refusals as `Read`
     */
    JS_CFUNC_DEF("Extract", 3, zip_extract),
    /* ExtractAll(folder, [{ MaxSize }]) -> number
     *   every entry under `folder`, made as needed, answering how many files it
     *   wrote. **Nothing is written until every name, every method and the total
     *   size have passed**: an entry named `../x`, an absolute path, a drive
     *   letter, a backslash or an empty part refuses the whole archive. Existing
     *   files are replaced; only files and folders are made, never a link
     */
    JS_CFUNC_DEF("ExtractAll", 2, zip_extract_all),
    /* Close()
     *   lets go of the archive. Closing twice is not an error; any other call
     *   after it throws
     */
    JS_CFUNC_DEF("Close", 0, zip_close),
};

void bta_zip_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_zip_class_id);
    JS_NewClass(rt, bta_zip_class_id, &zip_class);

    JSValue proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, proto, zip_proto_props, G_N_ELEMENTS(zip_proto_props));
    JS_SetClassProto(ctx, bta_zip_class_id, proto);

    JSValue zip = JS_NewObject(ctx);

    /* Open(path) -> ZipArchive
     *   reads the archive's directory and answers a handle on it. Throws, naming
     *   the file and the reason, for anything that is not a zip, is cut short, is
     *   zip64 or split over disks, or lists one name twice. An archive up to 32 MiB
     *   is held in memory; a bigger one is mapped, so do not open one that is still
     *   being written
     */
    JS_SetPropertyStr(ctx, zip, "Open", JS_NewCFunction(ctx, zip_open, "Open", 1));
    JS_SetPropertyStr(ctx, global, "Zip", zip);
}
