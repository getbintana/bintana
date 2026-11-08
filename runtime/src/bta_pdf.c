/*
 * PdfDocument -- a PDF: read with poppler, written with PoDoFo, one object.
 *
 *     const doc = PdfDocument.Load("invoice.pdf");
 *     doc.Pages; doc.Text(1); doc.Draw(painter, 1, w, h);      // reading
 *     doc.AddFields([...]); doc.Encrypt("out.pdf", { ... });     // writing
 *     doc.Sign("signed.pdf", { Certificate, Signer });           // signing
 *     doc.Signatures;                                            // verifying
 *
 * **Reading, generically, and nothing that pretends to understand a
 * document.** What a page *says* is its text in reading order, which is
 * poppler's answer and the most a library can promise about a file somebody
 * else wrote: the layout of a supplier's invoice is the supplier's.
 *
 * **Drawn on a Painter**, which is what makes the rest free: a `DrawingArea`
 * whose `DrawPage` draws the document's page is a viewer (`lib/pdfview`), and
 * the same control prints with `Printer.Send`, previews with `Printer.Preview`
 * and makes a thumbnail with `Painter.Render` -- no control of its own here.
 *
 * **Writing is what a PDF gets after it is drawn**: form fields Cairo cannot
 * write (`AddFields`, which was `PdfForm.AddFields`), encryption (`Encrypt`)
 * and a signature (`Sign`). Through the C++ bridge in bta_pdf_podofo.cpp.
 * `PdfForm` was a second name for the same file, and a PDF is one thing: one
 * object.
 *
 * **A signature's key is never the runtime's.** `Sign` hands the program the
 * digest and takes the signature back as `Bytes`, so a token, a smart card, a
 * remote service or `openssl` signs, and a `.p12` is one case among them, not
 * the shape of the API. Reading signatures back (`Signatures`) is poppler's
 * verification -- the other library, which is what makes the round trip a test.
 *
 * **Each half needs its own library, and neither is required to load one.**
 * `Load` checks the file is there -- and, with poppler, that it is a PDF and
 * whether it wants a password. A build without poppler still opens one and
 * still writes fields into it (a report's form needs no reader); a member that
 * reads says which package is missing, as a member that writes does without
 * PoDoFo. `CanRead` and `CanWrite` say which this build has.
 *
 * Pages are numbered from **1**, as `DrawPage` numbers them. Sizes are in
 * **points**, 72 to the inch, as `Printer.Papers` is. Field rectangles are in
 * PDF points with the origin at the **bottom-left**, the PDF's own system.
 */
#include "bta.h"
#include "bta_pdf.h"

#include <string.h>

#ifdef BTA_HAVE_POPPLER
#include <poppler.h>
/* Listing and verifying signatures arrived in poppler 23.07. */
#define BTA_PDF_SIGNATURES POPPLER_CHECK_VERSION(23, 7, 0)
#else
#define BTA_PDF_SIGNATURES 0
#endif

static JSClassID pdfdoc_class_id;

typedef struct {
    char *path;
    char *password;            /* what it was opened with, or NULL */
    bool  open;
#ifdef BTA_HAVE_POPPLER
    PopplerDocument *doc;      /* the reading half; NULL once closed */
#endif
} PdfDoc;

static void pdfdoc_finalizer(JSRuntime *rt, JSValue val)
{
    PdfDoc *d = JS_GetOpaque(val, pdfdoc_class_id);

    (void)rt;
    if (!d)
        return;
#ifdef BTA_HAVE_POPPLER
    g_clear_object(&d->doc);
#endif
    g_free(d->path);
    g_free(d->password);
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
    if (!d->open) {
        JS_ThrowTypeError(ctx, "this PdfDocument is closed");
        return NULL;
    }
    return d;
}

G_GNUC_UNUSED static JSValue no_reader(JSContext *ctx, const char *who)
{
    return JS_ThrowPlainError(ctx,
        "PdfDocument.%s: this runtime was built without poppler, which is what "
        "reads a PDF -- install poppler-glib's development package and build "
        "again", who);
}

G_GNUC_UNUSED static JSValue no_writer(JSContext *ctx, const char *who)
{
    return JS_ThrowPlainError(ctx,
        "PdfDocument.%s: this runtime was built without PoDoFo, which is what "
        "writes a PDF -- install libpodofo's development package and build again",
        who);
}

/* ----------------------------------------------------------------- opening */

#ifdef BTA_HAVE_POPPLER
/*
 * The reading half, opened through poppler's URI: a relative path is the
 * program's, made absolute first. Why it failed is told apart, since what to
 * do about each differs. GLib's own message is not quoted: it is translated.
 */
static PopplerDocument *read_document(JSContext *ctx, const char *path,
                                      const char *password, const char *who)
{
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
                                 "PdfDocument.Load(path, password)",
                           who, path);
    else
        JS_ThrowPlainError(ctx, "%s: '%s' is not a PDF this machine reads", who, path);
    g_clear_error(&err);
    return NULL;
}

/* After a write to its own file, the reading half reads the new one. */
G_GNUC_UNUSED static bool reread(JSContext *ctx, PdfDoc *d, const char *who)
{
    PopplerDocument *fresh = read_document(ctx, d->path, d->password, who);

    if (!fresh)
        return false;
    g_clear_object(&d->doc);
    d->doc = fresh;
    return true;
}
#endif

static JSValue pdfdoc_open(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "PdfDocument.Load(path, [password]) needs a path");

    const char *path = bta_file_path(ctx, argv[0], "PdfDocument.Load");
    if (!path)
        return JS_EXCEPTION;

    char *password = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        const char *s = JS_IsString(argv[1]) ? JS_ToCString(ctx, argv[1]) : NULL;

        if (!s) {
            JS_FreeCString(ctx, path);
            return JS_IsString(argv[1])
                ? JS_EXCEPTION
                : JS_ThrowTypeError(ctx, "PdfDocument.Load: the password is text");
        }
        password = g_strdup(s);
        JS_FreeCString(ctx, s);
    }

    if (!g_file_test(path, G_FILE_TEST_IS_REGULAR)) {
        JS_ThrowPlainError(ctx, "PdfDocument.Load: there is no file '%s'", path);
        JS_FreeCString(ctx, path);
        g_free(password);
        return JS_EXCEPTION;
    }

#ifdef BTA_HAVE_POPPLER
    PopplerDocument *doc = read_document(ctx, path, password, "PdfDocument.Load");
    if (!doc) {
        JS_FreeCString(ctx, path);
        g_free(password);
        return JS_EXCEPTION;
    }
#endif

    JSValue obj = JS_NewObjectClass(ctx, pdfdoc_class_id);
    if (JS_IsException(obj)) {
#ifdef BTA_HAVE_POPPLER
        g_object_unref(doc);
#endif
        JS_FreeCString(ctx, path);
        g_free(password);
        return obj;
    }

    PdfDoc *d = g_new0(PdfDoc, 1);
    d->path     = g_strdup(path);
    d->password = password;
    d->open     = true;
#ifdef BTA_HAVE_POPPLER
    d->doc      = doc;
#endif
    JS_SetOpaque(obj, d);
    JS_FreeCString(ctx, path);
    return obj;
}

/* --------------------------------------------------------- what it is */

static JSValue pdfdoc_get_path(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = JS_GetOpaque2(ctx, this_val, pdfdoc_class_id);
    return d ? JS_NewString(ctx, d->path) : JS_EXCEPTION;
}

static JSValue pdfdoc_get_open(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = JS_GetOpaque2(ctx, this_val, pdfdoc_class_id);
    return d ? JS_NewBool(ctx, d->open) : JS_EXCEPTION;
}

static JSValue pdfdoc_get_pages(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_POPPLER
    return JS_NewInt32(ctx, poppler_document_get_n_pages(d->doc));
#else
    return no_reader(ctx, "Pages");
#endif
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
#ifdef BTA_HAVE_POPPLER
    char *s = magic == META_TITLE    ? poppler_document_get_title(d->doc)
            : magic == META_AUTHOR   ? poppler_document_get_author(d->doc)
            : magic == META_SUBJECT  ? poppler_document_get_subject(d->doc)
            : magic == META_KEYWORDS ? poppler_document_get_keywords(d->doc)
            : magic == META_CREATOR  ? poppler_document_get_creator(d->doc)
            :                          poppler_document_get_producer(d->doc);
    JSValue out = JS_NewString(ctx, s ? s : "");

    g_free(s);
    return out;
#else
    (void)magic;
    return no_reader(ctx, "Title");
#endif
}

enum { WHEN_CREATED, WHEN_MODIFIED };

/* A `Date`, as `File.Info`'s `Modified` is, or `null` when the file says none. */
static JSValue pdfdoc_get_when(JSContext *ctx, JSValueConst this_val, int magic)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_POPPLER
    GDateTime *t = magic == WHEN_CREATED
                 ? poppler_document_get_creation_date_time(d->doc)
                 : poppler_document_get_modification_date_time(d->doc);
    if (!t)
        return JS_NULL;

    double ms = (double)g_date_time_to_unix(t) * 1000.0 +
                g_date_time_get_microsecond(t) / 1000.0;

    g_date_time_unref(t);
    return JS_NewDate(ctx, ms);
#else
    (void)magic;
    return no_reader(ctx, "Created");
#endif
}

/* ------------------------------------------------------- the signatures */

#if BTA_PDF_SIGNATURES
static const char *signature_word(PopplerSignatureStatus s)
{
    switch (s) {
    case POPPLER_SIGNATURE_VALID:           return "Valid";
    case POPPLER_SIGNATURE_INVALID:         return "Invalid";
    case POPPLER_SIGNATURE_DIGEST_MISMATCH: return "Altered";
    case POPPLER_SIGNATURE_DECODING_ERROR:  return "Unreadable";
    case POPPLER_SIGNATURE_NOT_FOUND:       return "Missing";
    case POPPLER_SIGNATURE_NOT_VERIFIED:    return "NotVerified";
    default:                                return "Error";
    }
}

/*
 * **A document that verified a certificate is kept for the life of the
 * process** -- the first one per certificate. poppler's NSS backend creates the
 * signer's certificate as an NSS temporary certificate whose DER lives in the
 * verification's arena, and frees that arena with the document while NSS keeps
 * the certificate in its cache. The next verification of the same certificate
 * finds it there and compares against freed memory: under ASan a
 * heap-use-after-free in `CERT_NewTempCertificate` (poppler 26.01, NSS 3.x);
 * without it, a generic error -- the first verification by a certificate said
 * `UntrustedIssuer`, a later one in another document, read after the first
 * was closed, said `Error`, while `pdfsig` (a process each) agreed with the
 * first every time. Keeping one document per certificate keeps its arena, so
 * the cache never points at freed memory; what it costs is one open document
 * per distinct signer the program ever verifies.
 */
static GHashTable *certificate_keepers;          /* id -> PopplerDocument */
G_LOCK_DEFINE_STATIC(certificate_keepers);

static void keep_verifier(PopplerDocument *doc, PopplerSignatureInfo *info)
{
    PopplerCertificateInfo *cert = poppler_signature_info_get_certificate_info(info);
    if (!cert)
        return;

    GDateTime *issued = poppler_certificate_info_get_issuance_time(cert);
    char      *key    = g_strdup_printf("%s|%s|%s|%s|%" G_GINT64_FORMAT,
        poppler_certificate_info_get_id(cert) ?: "",
        poppler_certificate_info_get_subject_common_name(cert) ?: "",
        poppler_certificate_info_get_subject_organization(cert) ?: "",
        poppler_certificate_info_get_issuer_common_name(cert) ?: "",
        issued ? g_date_time_to_unix(issued) : (gint64)0);

    G_LOCK(certificate_keepers);
    if (!certificate_keepers)
        certificate_keepers = g_hash_table_new_full(g_str_hash, g_str_equal,
                                                    g_free, g_object_unref);
    if (!g_hash_table_contains(certificate_keepers, key))
        g_hash_table_insert(certificate_keepers, key, g_object_ref(doc));
    else
        g_free(key);
    G_UNLOCK(certificate_keepers);
}

/* At exit, after the last PdfDocument: the kept documents go, so NSS shuts
 * down with nothing of ours in use. Nothing verifies after this, which is the
 * one thing that made freeing them unsafe. */
void bta_pdf_cleanup(void)
{
    G_LOCK(certificate_keepers);
    g_clear_pointer(&certificate_keepers, g_hash_table_destroy);
    G_UNLOCK(certificate_keepers);
}

static const char *certificate_word(PopplerCertificateStatus s)
{
    switch (s) {
    case POPPLER_CERTIFICATE_TRUSTED:          return "Trusted";
    case POPPLER_CERTIFICATE_UNTRUSTED_ISSUER: return "UntrustedIssuer";
    case POPPLER_CERTIFICATE_UNKNOWN_ISSUER:   return "UnknownIssuer";
    case POPPLER_CERTIFICATE_REVOKED:          return "Revoked";
    case POPPLER_CERTIFICATE_EXPIRED:          return "Expired";
    case POPPLER_CERTIFICATE_NOT_VERIFIED:     return "NotVerified";
    default:                                   return "Error";
    }
}
#else
void bta_pdf_cleanup(void) {}
#endif

/*
 * The signatures in it, verified: one `{ Field, Signer, Issuer, Time,
 * Signature, Certificate }` per signature field. `Signature` is whether the bytes are
 * the ones signed -- `Valid`, `Altered` (the document changed after it),
 * `Invalid`, `Unreadable`, `Missing` (an empty field, waiting for a signer),
 * `NotVerified`, `Error`. `Certificate` is whether the signer is one this
 * machine trusts -- `Trusted`, `UntrustedIssuer` (a self-signed one, or a CA
 * the system store lacks), `UnknownIssuer`, `Revoked`, `Expired`,
 * `NotVerified`, `Error`. **No OCSP**: asking a certificate authority whether
 * a certificate was revoked goes over the network, and a program reading
 * signatures does not do that unasked. poppler verifies; nothing here does.
 */
static JSValue pdfdoc_get_signatures(JSContext *ctx, JSValueConst this_val)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#if !defined(BTA_HAVE_POPPLER)
    return no_reader(ctx, "Signatures");
#elif !BTA_PDF_SIGNATURES
    return JS_ThrowPlainError(ctx, "PdfDocument.Signatures: this runtime's poppler "
                                   "is older than 23.07, which is what lists signatures");
#else
    JSValue  out = JS_NewArray(ctx);
    GList   *fields = poppler_document_get_signature_fields(d->doc);
    uint32_t at = 0;

    for (GList *l = fields; l; l = l->next) {
        PopplerFormField     *field = l->data;
        GError               *err   = NULL;
        PopplerSignatureInfo *info  = poppler_form_field_signature_validate_sync(
            field,
            POPPLER_SIGNATURE_VALIDATION_FLAG_VALIDATE_CERTIFICATE |
            POPPLER_SIGNATURE_VALIDATION_FLAG_WITHOUT_OCSP_REVOCATION_CHECK,
            NULL, &err);
        char    *name = poppler_form_field_get_name(field);
        JSValue  one  = JS_NewObject(ctx);

        JS_SetPropertyStr(ctx, one, "Field", JS_NewString(ctx, name ? name : ""));
        const char *signer = info ? poppler_signature_info_get_signer_name(info) : NULL;

        /* **An empty field is a place for a signature, not a bad one**: poppler
         * answers "not verified" and a time of 1970 for it. */
        if (info && (!signer || !*signer) &&
            poppler_signature_info_get_signature_status(info) == POPPLER_SIGNATURE_NOT_VERIFIED) {
            JS_SetPropertyStr(ctx, one, "Signer", JS_NewString(ctx, ""));
            JS_SetPropertyStr(ctx, one, "Issuer", JS_NewString(ctx, ""));
            JS_SetPropertyStr(ctx, one, "Time", JS_NULL);
            JS_SetPropertyStr(ctx, one, "Signature", JS_NewString(ctx, "Missing"));
            JS_SetPropertyStr(ctx, one, "Certificate", JS_NewString(ctx, "NotVerified"));
            poppler_signature_info_free(info);
        } else if (info) {
            GDateTime              *when = poppler_signature_info_get_local_signing_time(info);
            PopplerCertificateInfo *cert = poppler_signature_info_get_certificate_info(info);
            const char             *by   = cert ? poppler_certificate_info_get_issuer_common_name(cert)
                                                : NULL;

            JS_SetPropertyStr(ctx, one, "Signer", JS_NewString(ctx, signer ? signer : ""));
            JS_SetPropertyStr(ctx, one, "Issuer", JS_NewString(ctx, by ? by : ""));
            JS_SetPropertyStr(ctx, one, "Time", when
                ? JS_NewDate(ctx, (double)g_date_time_to_unix(when) * 1000.0)
                : JS_NULL);
            JS_SetPropertyStr(ctx, one, "Signature", JS_NewString(ctx,
                signature_word(poppler_signature_info_get_signature_status(info))));
            JS_SetPropertyStr(ctx, one, "Certificate", JS_NewString(ctx,
                certificate_word(poppler_signature_info_get_certificate_status(info))));
            keep_verifier(d->doc, info);
            poppler_signature_info_free(info);
        } else {
            JS_SetPropertyStr(ctx, one, "Signer", JS_NewString(ctx, ""));
            JS_SetPropertyStr(ctx, one, "Issuer", JS_NewString(ctx, ""));
            JS_SetPropertyStr(ctx, one, "Time", JS_NULL);
            JS_SetPropertyStr(ctx, one, "Signature", JS_NewString(ctx, "Error"));
            JS_SetPropertyStr(ctx, one, "Certificate", JS_NewString(ctx, "NotVerified"));
        }
        g_clear_error(&err);
        g_free(name);
        JS_SetPropertyUint32(ctx, out, at++, one);
    }
    g_list_free_full(fields, g_object_unref);
    return out;
#endif
}

/* -------------------------------------------------------------- a page */

#ifdef BTA_HAVE_POPPLER
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
#endif

static JSValue pdfdoc_page_size(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_POPPLER
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
#else
    return no_reader(ctx, "PageSize");
#endif
}

static JSValue pdfdoc_text(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_POPPLER
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
#else
    return no_reader(ctx, "Text");
#endif
}

/*
 * A page on a Painter, at the painter's origin and under its transform: at
 * its own size in points, or scaled to fit `width` by `height` keeping its
 * proportions -- what a `DrawPage(painter, page, width, height)` hands on. No
 * white of its own beneath it: a page is often transparent, and the paper is
 * the caller's to put there.
 */
static JSValue pdfdoc_draw(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifdef BTA_HAVE_POPPLER
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
#else
    return no_reader(ctx, "Draw");
#endif
}

/* -------------------------------------------------------- writing: fields */

#ifdef BTA_HAVE_PODOFO
static bool pdf_string(JSContext *ctx, JSValueConst obj, const char *key,
                       bool required, char **out)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, key);

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        if (!required)
            return true;
        JS_ThrowTypeError(ctx, "AddFields: a field needs %s", key);
        return false;
    }
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "AddFields: %s is text", key);
        return false;
    }

    const char *s = JS_ToCString(ctx, v);
    if (!s) {
        JS_FreeValue(ctx, v);
        return false;
    }
    *out = g_strdup(s);
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return true;
}

static bool pdf_number(JSContext *ctx, JSValueConst obj, const char *key,
                       bool required, double *out)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, key);

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        if (!required)
            return true;
        JS_ThrowTypeError(ctx, "AddFields: a field needs Rect.%s", key);
        return false;
    }

    bool ok = bta_to_number(ctx, v, "AddFields", out);
    JS_FreeValue(ctx, v);
    return ok;
}

static bool pdf_int(JSContext *ctx, JSValueConst obj, const char *key,
                    int32_t *out)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, key);

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }

    bool ok = bta_to_int(ctx, v, "AddFields", out);
    JS_FreeValue(ctx, v);
    return ok;
}

static bool pdf_bool(JSContext *ctx, JSValueConst obj, const char *key,
                     int *out)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, key);

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }

    int b = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    if (b < 0)
        return false;
    *out = b != 0;
    return true;
}

static void pdf_field_clear(BtaPdfField *field)
{
    g_free((char *)field->name);
    g_free((char *)field->type);
    g_free((char *)field->value);
    g_free((char *)field->reason);
}

/* Every field read and checked before the file is touched: a refusal leaves
 * the document as it was. NULL with an exception pending. */
static BtaPdfField *fields_read(JSContext *ctx, JSValueConst list, int32_t *count)
{
    if (!JS_IsArray(list)) {
        JS_ThrowTypeError(ctx, "AddFields: fields is a list");
        return NULL;
    }

    JSValue lenv = JS_GetPropertyStr(ctx, list, "length");
    int32_t n = 0;
    if (JS_ToInt32(ctx, &n, lenv) || n < 0) {
        JS_FreeValue(ctx, lenv);
        JS_ThrowTypeError(ctx, "AddFields: fields has no length");
        return NULL;
    }
    JS_FreeValue(ctx, lenv);

    BtaPdfField *fields = g_new0(BtaPdfField, n ? n : 1);
    GHashTable  *names  = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    bool         ok     = true;

    for (int32_t i = 0; i < n && ok; i++) {
        BtaPdfField *field = &fields[i];
        JSValue      obj   = JS_GetPropertyUint32(ctx, list, (uint32_t)i);

        field->page = 1;

        if (!JS_IsObject(obj)) {
            JS_ThrowTypeError(ctx, "AddFields: every field is an object");
            ok = false;
        } else if (!pdf_int(ctx, obj, "Page", &field->page) ||
                   !pdf_string(ctx, obj, "Name", true, (char **)&field->name) ||
                   !pdf_string(ctx, obj, "Type", true, (char **)&field->type)) {
            ok = false;
        } else {
            JSValue rect = JS_GetPropertyStr(ctx, obj, "Rect");

            if (!JS_IsObject(rect)) {
                JS_ThrowTypeError(ctx, "AddFields: field '%s' needs a Rect", field->name);
                ok = false;
            } else if (!pdf_number(ctx, rect, "X", true, &field->x) ||
                       !pdf_number(ctx, rect, "Y", true, &field->y) ||
                       !pdf_number(ctx, rect, "Width", true, &field->width) ||
                       !pdf_number(ctx, rect, "Height", true, &field->height)) {
                ok = false;
            }
            JS_FreeValue(ctx, rect);
        }

        if (ok) {
            if (strcmp(field->type, "Text") != 0 &&
                strcmp(field->type, "Check") != 0 &&
                strcmp(field->type, "Signature") != 0) {
                JS_ThrowTypeError(ctx, "AddFields: '%s' is not Text, Check or Signature",
                                  field->type);
                ok = false;
            } else if (g_hash_table_contains(names, field->name)) {
                JS_ThrowTypeError(ctx, "AddFields: the field '%s' is declared twice",
                                  field->name);
                ok = false;
            } else if (field->page < 1) {
                JS_ThrowRangeError(ctx, "AddFields: a page is 1 or more");
                ok = false;
            } else if (field->width <= 0 || field->height <= 0) {
                JS_ThrowRangeError(ctx, "AddFields: field '%s' has no rectangle",
                                   field->name);
                ok = false;
            } else {
                g_hash_table_add(names, g_strdup(field->name));

                if (strcmp(field->type, "Check") == 0) {
                    if (!pdf_bool(ctx, obj, "Checked", &field->checked))
                        ok = false;
                } else if (!pdf_string(ctx, obj, "Value", false,
                                       (char **)&field->value)) {
                    ok = false;
                }

                if (ok && !pdf_bool(ctx, obj, "ReadOnly", &field->read_only))
                    ok = false;
                if (ok && !pdf_bool(ctx, obj, "Required", &field->required))
                    ok = false;
                if (ok && strcmp(field->type, "Text") == 0 &&
                    !pdf_bool(ctx, obj, "Multiline", &field->multiline))
                    ok = false;
                if (ok && strcmp(field->type, "Text") == 0 &&
                    !pdf_int(ctx, obj, "MaxLength", &field->max_length))
                    ok = false;
                if (ok && strcmp(field->type, "Signature") == 0 &&
                    !pdf_string(ctx, obj, "Reason", false,
                                (char **)&field->reason))
                    ok = false;
            }
        }
        JS_FreeValue(ctx, obj);
    }
    g_hash_table_destroy(names);

    if (!ok) {
        for (int32_t i = 0; i < n; i++)
            pdf_field_clear(&fields[i]);
        g_free(fields);
        return NULL;
    }
    *count = n;
    return fields;
}
#endif

/*
 * `AddFields(fields)` -- form fields written into this document's own file,
 * in place: what `PdfForm.AddFields(path, fields)` was. A report's form is
 * drawn by Cairo and gets its fields here.
 */
static JSValue pdfdoc_add_fields(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifndef BTA_HAVE_PODOFO
    (void)argc; (void)argv;
    return no_writer(ctx, "AddFields");
#else
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "AddFields(fields) takes a list of fields");

    int32_t      count  = 0;
    BtaPdfField *fields = fields_read(ctx, argv[0], &count);
    if (!fields)
        return JS_EXCEPTION;

    char *error = NULL;
    int   added = count ? bta_pdf_add_fields_native(d->path, d->password, fields,
                                                    count, &error)
                        : 0;

    for (int32_t i = 0; i < count; i++)
        pdf_field_clear(&fields[i]);
    g_free(fields);

    if (count && added == 0) {
        JSValue e = JS_ThrowPlainError(ctx, "AddFields: %s", error ? error : "PoDoFo refused");
        g_free(error);
        return e;
    }
    g_free(error);
#ifdef BTA_HAVE_POPPLER
    if (count && !reread(ctx, d, "AddFields"))
        return JS_EXCEPTION;
#endif
    return JS_NewInt32(ctx, added);
#endif
}

/* ------------------------------------------------------ writing: encrypt */

#ifdef BTA_HAVE_PODOFO
static const struct { const char *name; unsigned bit; } PERMISSIONS[] = {
    { "Print",       BTA_PDF_ALLOW_PRINT },
    { "HighPrint",   BTA_PDF_ALLOW_HIGH_PRINT },
    { "Copy",        BTA_PDF_ALLOW_COPY },
    { "Edit",        BTA_PDF_ALLOW_EDIT },
    { "EditNotes",   BTA_PDF_ALLOW_EDIT_NOTES },
    { "FillAndSign", BTA_PDF_ALLOW_FILL_AND_SIGN },
    { "Accessible",  BTA_PDF_ALLOW_ACCESSIBLE },
    { "Assemble",    BTA_PDF_ALLOW_ASSEMBLE },
};

/* A text option, `NULL` when absent; false with a throw when not text. */
static bool option_text(JSContext *ctx, JSValueConst opts, const char *key, char **out)
{
    JSValue v = JS_GetPropertyStr(ctx, opts, key);

    *out = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "Encrypt: %s is text", key);
        return false;
    }
    const char *s = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    if (!s)
        return false;
    *out = g_strdup(s);
    JS_FreeCString(ctx, s);
    return true;
}
#endif

/*
 * `Encrypt(path, { Password, OwnerPassword, Permissions })` -- this document
 * written to `path` encrypted, AES-256. `Password` opens it; `OwnerPassword`
 * lifts the restrictions `Permissions` leaves -- a list of what is allowed
 * without it, every permission when absent. `path` may be this document's
 * own: it is replaced whole, and this object then reads the encrypted file
 * with the new password.
 */
static JSValue pdfdoc_encrypt(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifndef BTA_HAVE_PODOFO
    (void)argc; (void)argv;
    return no_writer(ctx, "Encrypt");
#else
    if (argc < 2 || !JS_IsObject(argv[1]))
        return JS_ThrowTypeError(ctx, "Encrypt(path, { Password, OwnerPassword, "
                                      "Permissions }) takes where to write and how");

    const char *out = bta_file_path(ctx, argv[0], "Encrypt");
    if (!out)
        return JS_EXCEPTION;

    char    *user = NULL, *owner = NULL;
    unsigned allow = 0;
    bool     ok = option_text(ctx, argv[1], "Password", &user) &&
                  option_text(ctx, argv[1], "OwnerPassword", &owner);

    if (ok && !user && !owner) {
        JS_ThrowTypeError(ctx, "Encrypt: a Password, an OwnerPassword or both -- "
                               "with neither there is nothing to encrypt with");
        ok = false;
    }

    if (ok) {
        JSValue list = JS_GetPropertyStr(ctx, argv[1], "Permissions");

        if (JS_IsUndefined(list) || JS_IsNull(list)) {
            for (size_t i = 0; i < G_N_ELEMENTS(PERMISSIONS); i++)
                allow |= PERMISSIONS[i].bit;
        } else if (!JS_IsArray(list)) {
            JS_ThrowTypeError(ctx, "Encrypt: Permissions is a list of names");
            ok = false;
        } else {
            JSValue  lv = JS_GetPropertyStr(ctx, list, "length");
            uint32_t n  = 0;

            JS_ToUint32(ctx, &n, lv);
            JS_FreeValue(ctx, lv);
            for (uint32_t i = 0; i < n && ok; i++) {
                JSValue     v = JS_GetPropertyUint32(ctx, list, i);
                const char *s = JS_IsString(v) ? JS_ToCString(ctx, v) : NULL;
                bool        known = false;

                for (size_t k = 0; s && k < G_N_ELEMENTS(PERMISSIONS); k++)
                    if (!strcmp(s, PERMISSIONS[k].name)) {
                        allow |= PERMISSIONS[k].bit;
                        known = true;
                    }
                if (!known) {
                    JS_ThrowRangeError(ctx, "Encrypt: '%s' is not a permission -- Print, "
                                            "HighPrint, Copy, Edit, EditNotes, "
                                            "FillAndSign, Accessible, Assemble",
                                       s ? s : "?");
                    ok = false;
                }
                JS_FreeCString(ctx, s);
                JS_FreeValue(ctx, v);
            }
        }
        JS_FreeValue(ctx, list);
    }

    char *error = NULL;
    if (ok && !bta_pdf_encrypt_native(d->path, d->password, out, user,
                                      owner ? owner : user, allow, &error)) {
        JS_ThrowPlainError(ctx, "Encrypt: %s", error ? error : "PoDoFo refused");
        ok = false;
    }

    /* Written over its own file: it reads the encrypted one now. */
    if (ok) {
        char *a = g_canonicalize_filename(out, NULL);
        char *b = g_canonicalize_filename(d->path, NULL);

        if (!strcmp(a, b)) {
            g_free(d->password);
            d->password = g_strdup(user ? user : owner);
#ifdef BTA_HAVE_POPPLER
            ok = reread(ctx, d, "Encrypt");
#endif
        }
        g_free(a);
        g_free(b);
    }

    g_free(error);
    g_free(user);
    g_free(owner);
    JS_FreeCString(ctx, out);
    return ok ? JS_UNDEFINED : JS_EXCEPTION;
#endif
}

/* ---------------------------------------------------------- writing: sign */

#ifdef BTA_HAVE_PODOFO
/* The program's `Signer`, as PoDoFo's signing service calls it. */
typedef struct {
    JSContext *ctx;
    JSValue    fn;
    JSValue    self;           /* the Key whose Sign it is, or undefined */
    bool       threw;          /* the Signer's own exception is pending */
} SignCall;

static int sign_with_program(void *data, const unsigned char *digest, size_t len,
                             unsigned char **sig, size_t *sig_len, char **error)
{
    SignCall  *c   = data;
    JSContext *ctx = c->ctx;
    JSValue    argv[2] = { bta_bytes_new(ctx, digest, len), JS_NewString(ctx, "SHA256") };
    JSValue    r   = JS_Call(ctx, c->fn, c->self, 2, argv);

    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
    if (JS_IsException(r)) {
        c->threw = true;
        *error   = g_strdup("the Signer threw");
        return 0;
    }

    size_t         n = 0;
    const uint8_t *b = bta_bytes_get(r, &n);

    if (!b || !n) {
        JS_FreeValue(ctx, r);
        *error = g_strdup("the Signer answered no Bytes -- it is called with the "
                          "digest and answers the signature over it");
        return 0;
    }
    *sig     = g_memdup2(b, n);
    *sig_len = n;
    JS_FreeValue(ctx, r);
    return 1;
}

/* A certificate as DER: `Bytes` as given, or the first PEM block of a text. */
static unsigned char *certificate_der(JSContext *ctx, JSValueConst v, size_t *len)
{
    size_t         n = 0;
    const uint8_t *b = bta_bytes_get(v, &n);

    if (b && n) {
        *len = n;
        return g_memdup2(b, n);
    }
    if (!JS_IsString(v))
        return NULL;

    const char *pem = JS_ToCString(ctx, v);
    if (!pem)
        return NULL;

    const char    *begin = strstr(pem, "-----BEGIN CERTIFICATE-----");
    const char    *end   = begin ? strstr(begin, "-----END CERTIFICATE-----") : NULL;
    unsigned char *der   = NULL;

    if (begin && end) {
        begin += strlen("-----BEGIN CERTIFICATE-----");
        GString *b64 = g_string_new(NULL);
        for (const char *p = begin; p < end; p++)
            if (!g_ascii_isspace(*p))
                g_string_append_c(b64, *p);
        gsize got = 0;
        der  = g_base64_decode(b64->str, &got);
        *len = got;
        g_string_free(b64, TRUE);
        if (!got) {
            g_free(der);
            der = NULL;
        }
    }
    JS_FreeCString(ctx, pem);
    return der;
}

static bool sign_text(JSContext *ctx, JSValueConst opts, const char *key, char **out)
{
    JSValue v = JS_GetPropertyStr(ctx, opts, key);

    *out = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "Sign: %s is text", key);
        return false;
    }
    const char *s = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    if (!s)
        return false;
    *out = g_strdup(s);
    JS_FreeCString(ctx, s);
    return true;
}
#endif

/*
 * `Sign(path, { ... })` -- see its description in the table below. `Key`
 * stands for `Signer` (its `Sign`, called on it) and `Certificate`. The
 * Signer is called once, from inside PoDoFo's writing, and its throw is kept
 * as the answer (`SignCall.threw`) rather than PoDoFo's word for it.
 */
static JSValue pdfdoc_sign(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    PdfDoc *d = doc_of(ctx, this_val);
    if (!d)
        return JS_EXCEPTION;
#ifndef BTA_HAVE_PODOFO
    (void)argc; (void)argv;
    return no_writer(ctx, "Sign");
#else
    if (argc < 2 || !JS_IsObject(argv[1]))
        return JS_ThrowTypeError(ctx, "Sign(path, { Certificate, Signer, ... }) takes "
                                      "where to write and how to sign");

    /* A `Key` -- or anything with `Sign(digest, algorithm)` and a
     * `Certificate` -- stands for both, unless they are given beside it. */
    JSValue key    = JS_GetPropertyStr(ctx, argv[1], "Key");
    JSValue signer = JS_GetPropertyStr(ctx, argv[1], "Signer");
    JSValue self   = JS_UNDEFINED;
    if (JS_IsUndefined(key) || JS_IsNull(key)) {
        JS_FreeValue(ctx, key);
        key = JS_UNDEFINED;
    } else if (!JS_IsObject(key)) {
        JS_FreeValue(ctx, key);
        JS_FreeValue(ctx, signer);
        return JS_ThrowTypeError(ctx, "Sign: Key is a Key -- Key.Load(source, pin)");
    } else if (JS_IsUndefined(signer)) {
        signer = JS_GetPropertyStr(ctx, key, "Sign");
        if (JS_IsException(signer)) {
            JS_FreeValue(ctx, key);
            return JS_EXCEPTION;
        }
        self = key;
    }
    if (!JS_IsFunction(ctx, signer)) {
        JS_FreeValue(ctx, signer);
        JS_FreeValue(ctx, key);
        return JS_ThrowTypeError(ctx, "Sign: Signer is a function -- Signer(digest, "
                                      "algorithm) answers the signature as Bytes -- "
                                      "or Key is a Key");
    }

    JSValue        certv = JS_GetPropertyStr(ctx, argv[1], "Certificate");
    if (JS_IsUndefined(certv) && JS_IsObject(key))
        certv = JS_GetPropertyStr(ctx, key, "Certificate");
    if (JS_IsException(certv)) {
        JS_FreeValue(ctx, signer);
        JS_FreeValue(ctx, key);
        return JS_EXCEPTION;
    }
    size_t         cert_len = 0;
    unsigned char *cert = certificate_der(ctx, certv, &cert_len);
    JS_FreeValue(ctx, certv);
    if (!cert) {
        JS_FreeValue(ctx, signer);
        JS_FreeValue(ctx, key);
        if (JS_HasException(ctx))
            return JS_EXCEPTION;
        return JS_ThrowTypeError(ctx, "Sign: Certificate is the signer's certificate, "
                                      "DER Bytes or PEM text -- a Key whose file or "
                                      "token had none needs it given beside it");
    }

    BtaPdfSignSpec spec = { 0 };
    char *field = NULL, *reason = NULL, *location = NULL, *name = NULL;
    bool  ok = sign_text(ctx, argv[1], "Field", &field) &&
               sign_text(ctx, argv[1], "Reason", &reason) &&
               sign_text(ctx, argv[1], "Location", &location) &&
               sign_text(ctx, argv[1], "Name", &name);

    spec.page = 1;
    if (ok) {
        JSValue rect = JS_GetPropertyStr(ctx, argv[1], "Rect");
        if (JS_IsObject(rect)) {
            JSValue pv = JS_GetPropertyStr(ctx, rect, "Page");
            JSValue xv = JS_GetPropertyStr(ctx, rect, "X");
            JSValue yv = JS_GetPropertyStr(ctx, rect, "Y");
            JSValue wv = JS_GetPropertyStr(ctx, rect, "Width");
            JSValue hv = JS_GetPropertyStr(ctx, rect, "Height");
            ok = (JS_IsUndefined(pv) || bta_to_int(ctx, pv, "Sign", &spec.page)) &&
                 bta_to_number(ctx, xv, "Sign", &spec.x) &&
                 bta_to_number(ctx, yv, "Sign", &spec.y) &&
                 bta_to_number(ctx, wv, "Sign", &spec.width) &&
                 bta_to_number(ctx, hv, "Sign", &spec.height);
            JS_FreeValue(ctx, pv); JS_FreeValue(ctx, xv); JS_FreeValue(ctx, yv);
            JS_FreeValue(ctx, wv); JS_FreeValue(ctx, hv);
        } else if (!JS_IsUndefined(rect) && !JS_IsNull(rect)) {
            JS_ThrowTypeError(ctx, "Sign: Rect is { Page, X, Y, Width, Height }");
            ok = false;
        }
        JS_FreeValue(ctx, rect);
    }

    const char *out = ok ? bta_file_path(ctx, argv[0], "Sign") : NULL;
    if (ok && !out)
        ok = false;

    SignCall call = { ctx, signer, self, false };
    char    *error = NULL;

    if (ok) {
        spec.field    = field;
        spec.reason   = reason;
        spec.location = location;
        spec.name     = name;
        spec.cert     = cert;
        spec.cert_len = cert_len;
        spec.sign     = sign_with_program;
        spec.data     = &call;
        if (!bta_pdf_sign_native(d->path, d->password, out, &spec, &error)) {
            /* The Signer's own throw is the answer when there is one. */
            if (!call.threw)
                JS_ThrowPlainError(ctx, "Sign: %s", error ? error : "PoDoFo refused");
            ok = false;
        }
    }

#ifdef BTA_HAVE_POPPLER
    if (ok) {
        char *a = g_canonicalize_filename(out, NULL);
        char *b = g_canonicalize_filename(d->path, NULL);
        if (!strcmp(a, b))
            ok = reread(ctx, d, "Sign");
        g_free(a);
        g_free(b);
    }
#endif

    g_free(error);
    g_free(field); g_free(reason); g_free(location); g_free(name);
    g_free(cert);
    if (out)
        JS_FreeCString(ctx, out);
    JS_FreeValue(ctx, signer);
    JS_FreeValue(ctx, key);
    return ok ? JS_UNDEFINED : JS_EXCEPTION;
#endif
}

static JSValue pdfdoc_close(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    PdfDoc *d = JS_GetOpaque2(ctx, this_val, pdfdoc_class_id);
    (void)argc; (void)argv;
    if (!d)
        return JS_EXCEPTION;
    d->open = false;                  /* closing twice is not an error */
#ifdef BTA_HAVE_POPPLER
    g_clear_object(&d->doc);
#endif
    return JS_UNDEFINED;
}

/* ---------------------------------------------------------------- install */

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
    /* Signatures -> object[]
     *   the signatures in it, **verified**: `{ Field, Signer, Issuer, Time,
     *   Signature, Certificate }` each -- the signer's and the issuer's
     *   common names, and when it was signed. `Signature` is whether the
     *   signed bytes are intact -- `Valid`, `Altered` (changed after
     *   signing), `Invalid`, `Unreadable`, `Missing` (an empty field, with
     *   `Time` null), `NotVerified`, `Error`; `Certificate` is whether this
     *   machine trusts the signer -- `Trusted`, `UntrustedIssuer`
     *   (self-signed, or a CA the system store lacks), `UnknownIssuer`,
     *   `Revoked`, `Expired`, `NotVerified` (an altered signature's is not
     *   looked at), `Error`. No OCSP: nothing goes over the network unasked.
     *   Needs poppler 23.07 (`CanRead`); an older one says so
     */
    JS_CGETSET_DEF("Signatures", pdfdoc_get_signatures, NULL),
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
    /* AddFields(fields) -> number
     *   form fields written into this document's file, **in place**, and how
     *   many. Each is `{ Page, Name, Type, Rect, Value, Checked, ReadOnly,
     *   Required, Multiline, MaxLength, Reason }`; `Type` is `"Text"`,
     *   `"Check"` or `"Signature"`, `Page` is 1-based, and `Rect` is `{ X, Y,
     *   Width, Height }` in **PDF points with the origin at the
     *   bottom-left**. A signature field is left empty, for `Sign` naming
     *   it or the signer's own application. Every field is checked first,
     *   and a failure leaves the file as it was. Needs PoDoFo (`CanWrite`)
     */
    JS_CFUNC_DEF("AddFields", 1, pdfdoc_add_fields),
    /* Encrypt(path, { Password, OwnerPassword, Permissions })
     *   this document written to `path` **encrypted**, AES-256: `Password`
     *   opens it, `OwnerPassword` lifts the restrictions, and `Permissions`
     *   lists what is allowed without it -- `Print`, `HighPrint`, `Copy`,
     *   `Edit`, `EditNotes`, `FillAndSign`, `Accessible`, `Assemble`; every
     *   one when absent. `path` may be this document's own, which is replaced
     *   whole and read from then on with the new password. Needs PoDoFo
     *   (`CanWrite`)
     */
    JS_CFUNC_DEF("Encrypt",  2, pdfdoc_encrypt),
    /* Sign(path, { Key, Certificate, Signer, Field, Rect, Reason, Location, Name })
     *   this document **signed** into `path`, as an incremental update, so an
     *   earlier signature stays valid: PAdES-B, SHA-256, an RSA key.
     *   `Key` is a `Key` -- a token's, a card's, a `.p12`'s -- and brings its
     *   certificate. Or **where the key is is the program's**:
     *   `Signer(digest, algorithm)` answers the signature over the digest as
     *   `Bytes` -- a remote service, anything -- and the runtime never holds it.
     *   `Certificate` is the signer's, DER `Bytes` or PEM text. `Field` names
     *   an empty signature field (a report's) or a new one, invisible on
     *   page 1 unless `Rect` is `{ Page, X, Y, Width, Height }` in PDF
     *   points, bottom-left; with none, the first free of `Signature`,
     *   `Signature2` ... A field signed already is refused, never signed
     *   over. A throw in `Signer` is what `Sign` throws, and the copy it was
     *   writing is removed. Needs PoDoFo (`CanWrite`)
     */
    JS_CFUNC_DEF("Sign",     2, pdfdoc_sign),
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
                                  "PdfDocument.Load(path)");
}

static const JSCFunctionListEntry pdfdoc_statics[] = {
    /* Load(path, [password]) -> PdfDocument
     *   a PDF, opened -- `Load` as `Bitmap.Load`, since `Open` is what an
     *   opened one answers (whether it still is). Throws, saying which: there is no such file, it is
     *   encrypted and wants a password, the password is wrong, or it is not a
     *   PDF this machine reads (the last three where this build reads PDFs)
     */
    JS_CFUNC_DEF("Load", 2, pdfdoc_open),
};

void bta_pdf_init(JSContext *ctx, JSValue global)
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

#ifdef BTA_HAVE_POPPLER
    const bool reads = true;
#else
    const bool reads = false;
#endif
#ifdef BTA_HAVE_PODOFO
    const bool writes = true;
#else
    const bool writes = false;
#endif
    /* CanRead
     *   whether this build reads a PDF -- pages, text, a page drawn, its
     *   signatures -- which is poppler; when false those members refuse
     *   naming the package
     */
    JS_SetPropertyStr(ctx, ctor, "CanRead", JS_NewBool(ctx, reads));
    /* CanWrite
     *   whether this build writes into a PDF -- `AddFields`, `Encrypt`,
     *   `Sign` -- which is PoDoFo; when false those refuse naming the package
     */
    JS_SetPropertyStr(ctx, ctor, "CanWrite", JS_NewBool(ctx, writes));
    JS_SetPropertyStr(ctx, global, "PdfDocument", ctor);
}
