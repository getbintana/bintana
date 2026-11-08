/*
 * The writing half of `PdfDocument`: what PoDoFo does to a PDF Cairo has
 * already written -- form fields, encryption.
 *
 * It is a separate header because the bridge is C++ and must not pull GTK or
 * QuickJS in with it; `bta.h` is the runtime's own, and this is the one struct
 * the two languages share.
 */
#ifndef BTA_PDF_H
#define BTA_PDF_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int         page;           /* 1-based */
    const char *name;           /* the field's name, unique in the document */
    const char *type;           /* "Text", "Check" or "Signature" */
    double      x, y;           /* PDF points, origin bottom-left */
    double      width, height;
    const char *value;          /* Text's contents */
    int         checked;        /* Check's state */
    int         read_only;
    int         required;
    int         multiline;      /* Text only */
    int         max_length;     /* Text only; 0 means none */
    const char *reason;         /* Signature's reason, optional */
} BtaPdfField;

/* Add the fields to the PDF at `path` (opened with `password`, or none), in
 * place. Answers how many were added, or 0 with `*error` set to a sentence the
 * caller frees with g_free. */
int bta_pdf_add_fields_native(const char *path, const char *password,
                              const BtaPdfField *fields, int count, char **error);

/* The permissions an encrypted PDF grants without its owner's password, as
 * PDF numbers them (PoDoFo's PdfPermissions). */
enum {
    BTA_PDF_ALLOW_PRINT        = 0x0004,
    BTA_PDF_ALLOW_EDIT         = 0x0008,
    BTA_PDF_ALLOW_COPY         = 0x0010,
    BTA_PDF_ALLOW_EDIT_NOTES   = 0x0020,
    BTA_PDF_ALLOW_FILL_AND_SIGN = 0x0100,
    BTA_PDF_ALLOW_ACCESSIBLE   = 0x0200,
    BTA_PDF_ALLOW_ASSEMBLE     = 0x0400,
    BTA_PDF_ALLOW_HIGH_PRINT   = 0x0800,
};

/* The PDF at `src` (opened with `src_password`, or none) written to `out`
 * encrypted with AES-256: `user_password` opens it, `owner_password` lifts
 * `permissions`. `out` may be `src`: written beside it and renamed over it.
 * Answers 1, or 0 with `*error` set to a sentence the caller frees. */
int bta_pdf_encrypt_native(const char *src, const char *src_password,
                           const char *out, const char *user_password,
                           const char *owner_password, unsigned permissions,
                           char **error);

#ifdef __cplusplus
}
#endif
#endif
