/*
 * The form layer: the fields PoDoFo adds to a PDF Cairo has already written.
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

/* Add the fields to the PDF at `path`, in place. Answers how many were added,
 * or 0 with `*error` set to a sentence the caller frees with g_free. */
int bta_pdf_add_fields_native(const char *path, const BtaPdfField *fields,
                              int count, char **error);

#ifdef __cplusplus
}
#endif
#endif
