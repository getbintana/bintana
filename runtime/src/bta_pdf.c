/*
 * PdfForm -- the form fields a PDF gets after Cairo has drawn its page.
 *
 * Cairo writes the visual document and knows nothing about AcroForm. PoDoFo
 * parses that PDF and adds the widgets; this file is the JavaScript surface
 * over the bridge in bta_pdf_podofo.cpp. The split is deliberate: the drawing
 * stays Cairo's and the fields are the one thing a form has that a page does
 * not.
 *
 * **Optional at build time**, the sqlite mould: without PoDoFo `PdfForm` still
 * exists, `Available` is false, and `AddFields` refuses with a sentence naming
 * the package. A program that only draws reports needs none of it.
 *
 * The fields are rectangles in **PDF points with the origin at the bottom-left**
 * -- the coordinate system the PDF itself uses. `Report` is what turns its
 * top-left design into these.
 */
#include "bta.h"
#include "bta_pdf.h"

#include <string.h>

#ifdef BTA_HAVE_PODOFO

/* ------------------------------------------------------------- arguments */

static bool pdf_string(JSContext *ctx, JSValueConst obj, const char *key,
                       bool required, char **out)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, key);

    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        if (!required)
            return true;
        JS_ThrowTypeError(ctx, "PdfForm.AddFields: a field needs %s", key);
        return false;
    }
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "PdfForm.AddFields: %s is text", key);
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
        JS_ThrowTypeError(ctx, "PdfForm.AddFields: a field needs Rect.%s", key);
        return false;
    }

    bool ok = bta_to_number(ctx, v, "PdfForm.AddFields", out);
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

    bool ok = bta_to_int(ctx, v, "PdfForm.AddFields", out);
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


#endif

/* ---------------------------------------------------------------- the verb */

static JSValue pdf_add_fields(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
#ifndef BTA_HAVE_PODOFO
    return JS_ThrowPlainError(ctx,
        "PdfForm.AddFields: this build has no PoDoFo; install libpodofo-devel");
#else
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "PdfForm.AddFields(path, fields) needs a path and a list");

    const char *path = bta_file_path(ctx, argv[0], "PdfForm.AddFields");
    if (!path)
        return JS_EXCEPTION;

    if (!JS_IsArray(argv[1]))
        return JS_ThrowTypeError(ctx, "PdfForm.AddFields: fields is a list");

    JSValue lenv = JS_GetPropertyStr(ctx, argv[1], "length");
    int32_t count = 0;
    if (JS_ToInt32(ctx, &count, lenv) || count < 0) {
        JS_FreeValue(ctx, lenv);
        return JS_ThrowTypeError(ctx, "PdfForm.AddFields: fields has no length");
    }
    JS_FreeValue(ctx, lenv);

    BtaPdfField *fields = g_new0(BtaPdfField, count);
    GHashTable  *names  = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    bool         ok     = true;

    for (int32_t i = 0; i < count && ok; i++) {
        BtaPdfField *field = &fields[i];
        JSValue      obj   = JS_GetPropertyUint32(ctx, argv[1], (uint32_t)i);

        field->page = 1;

        if (!JS_IsObject(obj)) {
            JS_ThrowTypeError(ctx, "PdfForm.AddFields: every field is an object");
            ok = false;
        } else if (!pdf_int(ctx, obj, "Page", &field->page) ||
                   !pdf_string(ctx, obj, "Name", true, (char **)&field->name) ||
                   !pdf_string(ctx, obj, "Type", true, (char **)&field->type)) {
            ok = false;
        } else {
            JSValue rect = JS_GetPropertyStr(ctx, obj, "Rect");

            if (!JS_IsObject(rect)) {
                JS_ThrowTypeError(ctx, "PdfForm.AddFields: field '%s' needs a Rect",
                                  field->name);
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
                JS_ThrowTypeError(ctx, "PdfForm.AddFields: '%s' is not Text, Check or Signature",
                                  field->type);
                ok = false;
            } else if (g_hash_table_contains(names, field->name)) {
                JS_ThrowTypeError(ctx, "PdfForm.AddFields: the field '%s' is declared twice",
                                  field->name);
                ok = false;
            } else if (field->page < 1) {
                JS_ThrowRangeError(ctx, "PdfForm.AddFields: a page is 1 or more");
                ok = false;
            } else if (field->width <= 0 || field->height <= 0) {
                JS_ThrowRangeError(ctx, "PdfForm.AddFields: field '%s' has no rectangle",
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

    int   added = 0;
    char *error = NULL;

    if (ok) {
        added = bta_pdf_add_fields_native(path, fields, count, &error);
        if (added == 0 && error) {
            JS_ThrowPlainError(ctx, "PdfForm.AddFields: %s", error);
            ok = false;
        }
    }

    for (int32_t i = 0; i < count; i++)
        pdf_field_clear(&fields[i]);
    g_free(fields);
    g_hash_table_destroy(names);
    g_free(error);

    if (!ok)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, added);
#endif
}

/* ---------------------------------------------------------------- install */

static const JSCFunctionListEntry pdfform_props[] = {
    /* AddFields(path, fields) -> number
     *   adds the fields to the PDF at `path`, **in place**, and answers how
     *   many. Each field is `{ Page, Name, Type, Rect, Value, Checked,
     *   ReadOnly, Required, Multiline, MaxLength, Reason }`; `Type` is
     *   `"Text"`, `"Check"` or `"Signature"`, `Page` is 1-based, and `Rect`
     *   is `{ X, Y, Width, Height }` in **PDF points with the origin at the
     *   bottom-left**. A signature field is left empty for the signer's own
     *   application. The PDF must exist and be one this build's PoDoFo can
     *   parse; a failure leaves the file as it was
     */
    JS_CFUNC_DEF("AddFields", 2, pdf_add_fields),
};

void bta_pdf_init(JSContext *ctx, JSValue global)
{
    JSValue pdf = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, pdf, pdfform_props, G_N_ELEMENTS(pdfform_props));
#ifdef BTA_HAVE_PODOFO
    /* Available
     *   whether this build has PoDoFo, which is what `AddFields` needs; when
     *   false the verb refuses with a sentence naming the package
     */
    JS_SetPropertyStr(ctx, pdf, "Available", JS_NewBool(ctx, true));
#else
    /* Available
     *   whether this build has PoDoFo, which is what `AddFields` needs; when
     *   false the verb refuses with a sentence naming the package
     */
    JS_SetPropertyStr(ctx, pdf, "Available", JS_NewBool(ctx, false));
#endif
    JS_SetPropertyStr(ctx, global, "PdfForm", pdf);
}
