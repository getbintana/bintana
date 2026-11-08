/*
 * PdfDocument -- a PDF, read: its pages, their size, their text, its metadata,
 * and a page drawn on a Painter.
 *
 * **Reading, generically, and nothing that pretends to understand a
 * document.** What a page *says* is a string of text in reading order, which
 * is poppler's answer and the most a library can promise about a file
 * somebody else wrote: the layout of an invoice from a supplier is the
 * supplier's, and a program that parses one is parsing that supplier.
 *
 * **Drawn on a Painter**, which is what makes the rest free: a `DrawingArea`
 * whose `DrawPage` draws the document's page is a viewer (`lib/pdfview`), and
 * the same control prints with `Printer.Send`, previews with `Printer.Preview`
 * and makes a thumbnail with `Painter.Render` -- no control of its own here.
 *
 * Pages are numbered from **1**, as `DrawPage` numbers them. Sizes are in
 * **points**, 72 to the inch, as `Printer.Papers` is.
 *
 * The name is the object's, `PdfDocument.Open(path)`, and not a `Pdf` theme
 * beside `PdfForm` (which writes form fields into a PDF Cairo drew, with
 * PoDoFo): one word per meaning. `Probe.Pdf` is the header half in
 * `bta_probe.c`, beside `Probe.Image`.
 *
 * **Optional at build time**, the sqlite mould: without poppler-glib
 * `PdfDocument` exists and `Open` says which package is missing.
 */
#include "bta.h"

#ifdef BTA_HAVE_POPPLER
#include <poppler.h>

static JSClassID pdfdoc_class_id;

typedef struct {
    PopplerDocument *doc;      /* NULL once closed */
    char            *path;
} PdfDoc;

static void pdfdoc_finalizer(JSRuntime *rt, JSValue val)
{
    PdfDoc *d = JS_GetOpaque(val, pdfdoc_class_id);

    (void)rt;
    if (!d)
        return;
    g_clear_object(&d->doc);
    g_free(d->path);
    g_free(d);
}

static JSClassDef pdfdoc_class = {
    "PdfDocument",
    .finalizer = pdfdoc_finalizer,
};

/* The document, or a throw: a closed one says so in one place. */
static PdfDoc *doc_of(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = JS_GetOpaque2(ctx, this_val, pdfdoc_class_id);

    if (!d)
        return NULL;
    if (!d->doc) {
        JS_ThrowTypeError(ctx, "this PdfDocument is closed");
        return NULL;
    }
    return d;
}

/* Page `n` of 1..Pages, owned, or NULL with a RangeError. */
static PopplerPage *page_of(JSContext *ctx, PdfDoc *d, JSValueConst v,
                            const char *who)
{
    int32_t n = 0;

    if (!bta_to_int(ctx, v, who, &n))
        return NULL;

    int pages = poppler_document_get_n_pages(d->doc);

    if (n < 1 || n > pages) {
        JS_ThrowRangeError(ctx, "%s: %d is not a page -- the document has %d",
                           who, n, pages);
        return NULL;
    }
    return poppler_document_get_page(d->doc, n - 1);
}

/*
 * Opened from a path, through poppler's URI: a relative path is the
 * program's, made absolute against the working directory first. The reasons
 * it can fail are told apart, since what to do about each differs: there is
 * no such file, it is encrypted and wants a password, the password is wrong,
 * or it is not a PDF this library reads. GLib's own message is not quoted:
 * it is translated.
 */
static PopplerDocument *open_document(JSContext *ctx, const char *path,
                                      const char *password, const char *who)
{
    if (!g_file_test(path, G_FILE_TEST_IS_REGULAR)) {
        JS_ThrowPlainError(ctx, "%s: there is no file '%s'", who, path);
        return NULL;
    }

    char            *abs = g_canonicalize_filename(path, NULL);
    char            *uri = g_filename_to_uri(abs, NULL, NULL);
    GError          *err = NULL;
    PopplerDocument *doc = uri ? poppler_document_new_from_file(uri, password, &err)
                               : NULL;

    g_free(uri);
    g_free(abs);
    if (doc)
        return doc;

    if (err && err->domain == POPPLER_ERROR && err->code == POPPLER_ERROR_ENCRYPTED)
        JS_ThrowPlainError(ctx, password
                               ? "%s: '%s' is encrypted and that password does not open it"
                               : "%s: '%s' is encrypted -- give its password: "
                                 "PdfDocument.Open(path, password)",
                           who, path);
    else
        JS_ThrowPlainError(ctx, "%s: '%s' is not a PDF this machine reads", who, path);
    g_clear_error(&err);
    return NULL;
}

static JSValue pdfdoc_open(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "PdfDocument.Open(path, [password]) needs a path");

    const char *path = bta_file_path(ctx, argv[0], "PdfDocument.Open");
    if (!path)
        return JS_EXCEPTION;

    const char *password = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        if (!JS_IsString(argv[1])) {
            JS_FreeCString(ctx, path);
            return JS_ThrowTypeError(ctx, "PdfDocument.Open: the password is text");
        }
        password = JS_ToCString(ctx, argv[1]);
        if (!password) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    PopplerDocument *doc = open_document(ctx, path, password, "PdfDocument.Open");

    JS_FreeCString(ctx, password);
    if (!doc) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    JSValue obj = JS_NewObjectClass(ctx, pdfdoc_class_id);
    if (JS_IsException(obj)) {
        g_object_unref(doc);
        JS_FreeCString(ctx, path);
        return obj;
    }

    PdfDoc *d = g_new0(PdfDoc, 1);
    d->doc  = doc;
    d->path = g_strdup(path);
    JS_SetOpaque(obj, d);
    JS_FreeCString(ctx, path);
    return obj;
}

/* --- what it is ------------------------------------------------------- */

static JSValue pdfdoc_get_pages(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = doc_of(ctx, this_val);
    return d ? JS_NewInt32(ctx, poppler_document_get_n_pages(d->doc)) : JS_EXCEPTION;
}

static JSValue pdfdoc_get_path(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = JS_GetOpaque2(ctx, this_val, pdfdoc_class_id);
    return d ? JS_NewString(ctx, d->path) : JS_EXCEPTION;
}

static JSValue pdfdoc_get_open(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = JS_GetOpaque2(ctx, this_val, pdfdoc_class_id);
    return d ? JS_NewBool(ctx, d->doc != NULL) : JS_EXCEPTION;
}

enum { META_TITLE, META_AUTHOR, META_SUBJECT, META_KEYWORDS, META_CREATOR,
       META_PRODUCER };

/* A text the document may not have: `""` then, never `null`, so a caption
 * built from it needs no test. */
static JSValue pdfdoc_get_meta(JSContext *ctx, JSValueConst this_val, int magic)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;

    char *s = magic == META_TITLE    ? poppler_document_get_title(d->doc)
            : magic == META_AUTHOR   ? poppler_document_get_author(d->doc)
            : magic == META_SUBJECT  ? poppler_document_get_subject(d->doc)
            : magic == META_KEYWORDS ? poppler_document_get_keywords(d->doc)
            : magic == META_CREATOR  ? poppler_document_get_creator(d->doc)
            :                          poppler_document_get_producer(d->doc);
    JSValue out = JS_NewString(ctx, s ? s : "");

    g_free(s);
    return out;
}

enum { WHEN_CREATED, WHEN_MODIFIED };

/* A `Date`, as `File.Info`'s `Modified` is, or `null` when the file says none. */
static JSValue pdfdoc_get_when(JSContext *ctx, JSValueConst this_val, int magic)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;

    GDateTime *t = magic == WHEN_CREATED
                 ? poppler_document_get_creation_date_time(d->doc)
                 : poppler_document_get_modification_date_time(d->doc);
    if (!t)
        return JS_NULL;

    double ms = (double)g_date_time_to_unix(t) * 1000.0 +
                g_date_time_get_microsecond(t) / 1000.0;

    g_date_time_unref(t);
    return JS_NewDate(ctx, ms);
}

/* --- a page ----------------------------------------------------------- */

static JSValue pdfdoc_page_size(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "PageSize(page) takes a page, from 1");

    PopplerPage *page = page_of(ctx, d, argv[0], "PageSize");
    if (!page)
        return JS_EXCEPTION;

    double w = 0, h = 0;
    poppler_page_get_size(page, &w, &h);
    g_object_unref(page);

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Width",  JS_NewFloat64(ctx, w));
    JS_SetPropertyStr(ctx, out, "Height", JS_NewFloat64(ctx, h));
    return out;
}

static JSValue pdfdoc_text(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Text(page) takes a page, from 1");

    PopplerPage *page = page_of(ctx, d, argv[0], "Text");
    if (!page)
        return JS_EXCEPTION;

    char   *text = poppler_page_get_text(page);
    JSValue out  = JS_NewString(ctx, text ? text : "");

    g_free(text);
    g_object_unref(page);
    return out;
}

/*
 * A page on a Painter, at the painter's origin and under its transform:
 * at its own size in points, or scaled to fit `width` by `height` keeping its
 * proportions -- what a `DrawPage(painter, page, width, height)` hands on. The
 * page is drawn as it is, with no white of its own beneath it: a page is
 * often transparent, and the paper is the caller's to put there.
 */
static JSValue pdfdoc_draw(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Draw(painter, page, [width], [height]) takes "
                                      "the painter of a Draw and a page");

    double fw = 0, fh = 0;
    bool   fit = argc > 3 && !JS_IsUndefined(argv[2]) && !JS_IsUndefined(argv[3]);
    if (fit && (!bta_to_number(ctx, argv[2], "Draw", &fw) ||
                !bta_to_number(ctx, argv[3], "Draw", &fh)))
        return JS_EXCEPTION;
    if (fit && (fw <= 0 || fh <= 0))
        return JS_ThrowRangeError(ctx, "Draw: the size to fit is more than 0 by 0");

    cairo_t *cr = bta_painter_cairo(ctx, argv[0]);
    if (!cr)
        return JS_EXCEPTION;

    PopplerPage *page = page_of(ctx, d, argv[1], "Draw");
    if (!page)
        return JS_EXCEPTION;

    double w = 0, h = 0;
    poppler_page_get_size(page, &w, &h);

    cairo_save(cr);
    if (fit && w > 0 && h > 0) {
        double z = MIN(fw / w, fh / h);
        cairo_scale(cr, z, z);
    }
    poppler_page_render(page, cr);
    cairo_restore(cr);
    g_object_unref(page);
    return JS_UNDEFINED;
}

static JSValue pdfdoc_close(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    PdfDoc *d = JS_GetOpaque2(ctx, this_val, pdfdoc_class_id);
    (void)argc; (void)argv;
    if (!d)
        return JS_EXCEPTION;
    g_clear_object(&d->doc);          /* closing twice is not an error */
    return JS_UNDEFINED;
}

/* type PdfDocument */
static const JSCFunctionListEntry pdfdoc_props[] = {
    /* Path -> string
     *   the file it was opened from
     */
    JS_CGETSET_DEF("Path",  pdfdoc_get_path,  NULL),
    /* Open -> boolean
     *   whether it still is
     */
    JS_CGETSET_DEF("Open",  pdfdoc_get_open,  NULL),
    /* Pages -> number
     *   how many pages, numbered from 1 as `DrawPage` numbers them
     */
    JS_CGETSET_DEF("Pages", pdfdoc_get_pages, NULL),
    /* Title -> string
     *   what the file says it is called; `""` when it says nothing
     */
    JS_CGETSET_MAGIC_DEF("Title",    pdfdoc_get_meta, NULL, META_TITLE),
    /* Author -> string
     *   who the file says wrote it; `""` when it says nothing
     */
    JS_CGETSET_MAGIC_DEF("Author",   pdfdoc_get_meta, NULL, META_AUTHOR),
    /* Subject -> string
     *   the file's own subject line; `""` when it has none
     */
    JS_CGETSET_MAGIC_DEF("Subject",  pdfdoc_get_meta, NULL, META_SUBJECT),
    /* Keywords -> string
     *   the file's keywords, as it wrote them; `""` when it has none
     */
    JS_CGETSET_MAGIC_DEF("Keywords", pdfdoc_get_meta, NULL, META_KEYWORDS),
    /* Creator -> string
     *   the program that made the document; `""` when it says nothing
     */
    JS_CGETSET_MAGIC_DEF("Creator",  pdfdoc_get_meta, NULL, META_CREATOR),
    /* Producer -> string
     *   the program that wrote the PDF; `""` when it says nothing
     */
    JS_CGETSET_MAGIC_DEF("Producer", pdfdoc_get_meta, NULL, META_PRODUCER),
    /* Created -> Date
     *   when the file says it was made, a `Date`; `null` when it says nothing
     */
    JS_CGETSET_MAGIC_DEF("Created",  pdfdoc_get_when, NULL, WHEN_CREATED),
    /* Modified -> Date
     *   when the file says it was last changed, a `Date`; `null` when it says
     *   nothing
     */
    JS_CGETSET_MAGIC_DEF("Modified", pdfdoc_get_when, NULL, WHEN_MODIFIED),
    /* PageSize(page) -> { Width, Height }
     *   that page's size in **points**, 72 to the inch; pages need not all be
     *   one size
     */
    JS_CFUNC_DEF("PageSize", 1, pdfdoc_page_size),
    /* Text(page) -> string
     *   the text on that page, in reading order, as the library reads it --
     *   what a search or an index is built from. Generic: what a particular
     *   layout *means* is the program's
     */
    JS_CFUNC_DEF("Text",     1, pdfdoc_text),
    /* Draw(painter, page, [width], [height])
     *   draws that page on a `Draw`'s painter, at its origin and under its
     *   transform: at its own size in points, or scaled to fit `width` by
     *   `height`, keeping its proportions. No white of its own: the paper is
     *   the caller's. What a `DrawPage` hands on, which is how a viewer, a
     *   print and a preview are the same code
     */
    JS_CFUNC_DEF("Draw",     4, pdfdoc_draw),
    /* Close()
     *   let it go; closing twice is not an error
     */
    JS_CFUNC_DEF("Close",    0, pdfdoc_close),
};

static JSValue pdfdoc_construct(JSContext *ctx, JSValueConst new_target,
                                int argc, JSValueConst *argv)
{
    (void)new_target; (void)argc; (void)argv;
    return JS_ThrowTypeError(ctx, "a PdfDocument is opened, not constructed: "
                                  "PdfDocument.Open(path)");
}

static const JSCFunctionListEntry pdfdoc_statics[] = {
    /* Open(path, [password]) -> PdfDocument
     *   reads a PDF and answers it. Throws, saying which: there is no such
     *   file, it is encrypted and wants a password, the password is wrong, or
     *   it is not a PDF this machine reads
     */
    JS_CFUNC_DEF("Open", 2, pdfdoc_open),
};

void bta_poppler_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &pdfdoc_class_id);
    JS_NewClass(rt, pdfdoc_class_id, &pdfdoc_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, pdfdoc_props, G_N_ELEMENTS(pdfdoc_props));
    JS_SetClassProto(ctx, pdfdoc_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, pdfdoc_construct, "PdfDocument", 0,
                                    JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyFunctionList(ctx, ctor, pdfdoc_statics, G_N_ELEMENTS(pdfdoc_statics));
    JS_SetPropertyStr(ctx, global, "PdfDocument", ctor);
}

#else  /* no poppler at build time */

static JSValue pdfdoc_open(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx,
        "this runtime was built without poppler, so there is no PDF to read. "
        "Install poppler-glib's development package and build again -- CMake "
        "finds it with pkg-config and prints which it found");
}

static const JSCFunctionListEntry pdfdoc_statics[] = {
    /* Open(path, [password]) -> PdfDocument
     *   reads a PDF and answers it. Throws, saying which: there is no such
     *   file, it is encrypted and wants a password, the password is wrong, or
     *   it is not a PDF this machine reads
     */
    JS_CFUNC_DEF("Open", 2, pdfdoc_open),
};

/* The name, with nothing behind it but the sentence: a program that reads a
 * PDF fails where it opens one, naming the package. */
void bta_poppler_init(JSContext *ctx, JSValue global)
{
    JSValue holder = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, holder, pdfdoc_statics, G_N_ELEMENTS(pdfdoc_statics));
    JS_SetPropertyStr(ctx, global, "PdfDocument", holder);
}

#endif
