/*
 * Bitmap -- a picture as a value, with the transforms on it.
 *
 * `Picture` shows a file and `Image` shows an icon or a file; neither can crop,
 * scale or turn one, so every screen that needed a thumbnail did the arithmetic
 * on a `Painter` and every place that wanted the result again did it again.
 * This is the value those controls display, and the operations are the four a
 * catalogue or a photograph actually asks for.
 *
 * ## A value, like `Bytes`
 *
 * Nothing here is a buffer and nothing mutates: `Scale`, `Crop`, `Rotate` and
 * `Flip` answer a **new** `Bitmap`, and the original is unchanged.  That is the
 * same bargain `Bytes` makes -- a thumbnail can live in a `Record` and cannot be
 * changed under the record's feet -- and it is why the class has `Width` and
 * `Height` and no setters.
 *
 * It is **not** a widget, and it is not `Image`: that name is the control.
 * `Bitmap` is the value, `Picture` is the control that shows one, and
 * `Painter.Image` draws one -- the three words name three different things.
 *
 * ## GdkPixbuf, and the formats
 *
 * The stored form is a `GdkPixbuf`, which is already linked for `Probe` and is
 * the one thing here that can scale, crop and rotate pixels without a display.
 * A `Bitmap` therefore works in a `Task` too.  The loaders are the machine's,
 * not ours: `Bitmap.Load` reads exactly what `Picture.File` shows (PNG, JPEG,
 * WebP, TIFF, BMP, and SVG only where a loader is installed), and `Probe.Image`
 * remains the question *is this a picture?* with `null` as its answer.
 */
#include "bta.h"

#include <math.h>
#include <string.h>

#ifdef BTA_HEADLESS
/* A cairo ARGB32 surface back into a GdkPixbuf. The pixels cairo hands back are
 * premultiplied and GdkPixbuf's are not, so every channel is divided by alpha.
 * `gdk_pixbuf_get_from_surface` is the graphical host's and needs GDK; this
 * keeps `Bitmap.Rotate`'s arbitrary angle working in the core. */
static GdkPixbuf *pixbuf_from_surface(cairo_surface_t *surface)
{
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS)
        return NULL;

    int w = cairo_image_surface_get_width(surface);
    int h = cairo_image_surface_get_height(surface);
    GdkPixbuf *pb = gdk_pixbuf_new(GDK_COLORSPACE_RGB, TRUE, 8, w, h);
    if (!pb)
        return NULL;

    guchar       *dst     = gdk_pixbuf_get_pixels(pb);
    int           dstride = gdk_pixbuf_get_rowstride(pb);
    const guint32 *src    = (const guint32 *)cairo_image_surface_get_data(surface);
    int           sstride = cairo_image_surface_get_stride(surface) / 4;

    for (int y = 0; y < h; y++) {
        guchar *row = dst + y * dstride;
        for (int x = 0; x < w; x++) {
            guint32 v = src[y * sstride + x];
            guint   a = v >> 24;
            guint   r = (v >> 16) & 0xFF;
            guint   g = (v >> 8) & 0xFF;
            guint   b = v & 0xFF;

            if (a && a != 255) {
                r = (r * 255 + a / 2) / a;
                g = (g * 255 + a / 2) / a;
                b = (b * 255 + a / 2) / a;
            }
            row[x * 4 + 0] = (guchar)MIN(r, 255);
            row[x * 4 + 1] = (guchar)MIN(g, 255);
            row[x * 4 + 2] = (guchar)MIN(b, 255);
            row[x * 4 + 3] = (guchar)a;
        }
    }
    return pb;
}
#endif

typedef struct {
    GdkPixbuf *pixbuf;
} BtaBitmap;

static JSClassID bta_bitmap_class_id;

static void bitmap_finalizer(JSRuntime *rt, JSValue val)
{
    BtaBitmap *b = JS_GetOpaque(val, bta_bitmap_class_id);

    if (!b)
        return;
    if (b->pixbuf)
        g_object_unref(b->pixbuf);
    js_free_rt(rt, b);
}

static JSClassDef bitmap_class = {
    "Bitmap",
    .finalizer = bitmap_finalizer,
};

/* Takes ownership of `pixbuf`: the one place a value is made. */
JSValue bta_bitmap_new(JSContext *ctx, GdkPixbuf *pixbuf)
{
    if (!pixbuf)
        return JS_ThrowPlainError(ctx, "Bitmap: there are no pixels");

    JSValue proto = JS_GetClassProto(ctx, bta_bitmap_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bta_bitmap_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        g_object_unref(pixbuf);
        return obj;
    }

    BtaBitmap *b = js_mallocz(ctx, sizeof *b);
    if (!b) {
        g_object_unref(pixbuf);
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }
    b->pixbuf = pixbuf;
    JS_SetOpaque(obj, b);
    return obj;
}

/* The pixels, borrowed -- for `Picture.Source` and `Painter.Image`. */
GdkPixbuf *bta_bitmap_pixbuf(JSValueConst v)
{
    BtaBitmap *b = JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT
                       ? JS_GetOpaque(v, bta_bitmap_class_id) : NULL;
    return b ? b->pixbuf : NULL;
}

static BtaBitmap *bitmap_of(JSContext *ctx, JSValueConst v, const char *who)
{
    BtaBitmap *b = JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT
                       ? JS_GetOpaque(v, bta_bitmap_class_id) : NULL;
    if (!b)
        JS_ThrowTypeError(ctx, "%s: expected a Bitmap", who);
    return b;
}

static JSValue bitmap_construct(JSContext *ctx, JSValueConst new_target,
                                int argc, JSValueConst *argv)
{
    (void)new_target;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError(ctx,
        "Bitmap: use Bitmap.Load(path) or Bitmap.FromBytes(bytes)");
}

/* ------------------------------------------------------------------ making */

static JSValue bitmap_load(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Bitmap.Load(path) needs a path");

    const char *path = bta_file_path(ctx, argv[0], "Bitmap.Load");
    if (!path)
        return JS_EXCEPTION;

    GError *error = NULL;
    GdkPixbuf *pixbuf = gdk_pixbuf_new_from_file(path, &error);

    if (!pixbuf) {
        JSValue e = JS_ThrowTypeError(ctx, "Bitmap.Load: cannot read %s: %s",
                                      path, error ? bta_gerror_text(error)
                                                  : "not an image");
        g_clear_error(&error);
        JS_FreeCString(ctx, path);
        return e;
    }

    JS_FreeCString(ctx, path);
    return bta_bitmap_new(ctx, pixbuf);
}

static JSValue bitmap_from_bytes(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Bitmap.FromBytes(bytes) needs bytes");

    size_t         len  = 0;
    const uint8_t *data = bta_bytes_get(argv[0], &len);

    if (!data) {
        return JS_ThrowTypeError(ctx,
            "Bitmap.FromBytes: expected Bytes -- what Http answers with and "
            "File.LoadBytes reads");
    }
    if (!len)
        return JS_ThrowRangeError(ctx, "Bitmap.FromBytes: no bytes at all");

    GError *error = NULL;
    GdkPixbufLoader *loader = gdk_pixbuf_loader_new();
    GdkPixbuf       *pixbuf = NULL;

    if (!gdk_pixbuf_loader_write(loader, data, len, &error) ||
        !gdk_pixbuf_loader_close(loader, &error)) {
        JSValue e = JS_ThrowTypeError(ctx, "Bitmap.FromBytes: cannot read %zu bytes: %s",
                                      len, error ? bta_gerror_text(error)
                                                 : "not an image");
        g_clear_error(&error);
        g_object_unref(loader);
        return e;
    }

    pixbuf = gdk_pixbuf_loader_get_pixbuf(loader);
    if (pixbuf)
        g_object_ref(pixbuf);
    g_object_unref(loader);

    if (!pixbuf)
        return JS_ThrowTypeError(ctx, "Bitmap.FromBytes: cannot read %zu bytes: "
                                      "not an image", len);
    return bta_bitmap_new(ctx, pixbuf);
}

/* ------------------------------------------------------------------ asking */

static JSValue bitmap_get_width(JSContext *ctx, JSValueConst this_val)
{
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap");
    if (!b)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gdk_pixbuf_get_width(b->pixbuf));
}

static JSValue bitmap_get_height(JSContext *ctx, JSValueConst this_val)
{
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap");
    if (!b)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gdk_pixbuf_get_height(b->pixbuf));
}

static JSValue bitmap_to_string(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    (void)argc;
    (void)argv;
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap");
    if (!b)
        return JS_EXCEPTION;

    char text[48];
    g_snprintf(text, sizeof text, "Bitmap(%dx%d)",
               gdk_pixbuf_get_width(b->pixbuf),
               gdk_pixbuf_get_height(b->pixbuf));
    return JS_NewString(ctx, text);
}

/* ---------------------------------------------------------------- transform */

static JSValue bitmap_scale(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap.Scale");
    if (!b)
        return JS_EXCEPTION;
    if (argc < 1 || JS_IsUndefined(argv[0]))
        return JS_ThrowTypeError(ctx, "Bitmap.Scale(width, [height]) needs a width");

    int32_t width = 0;
    if (!bta_to_int(ctx, argv[0], "Bitmap.Scale", &width))
        return JS_EXCEPTION;
    if (width <= 0)
        return JS_ThrowRangeError(ctx, "Bitmap.Scale: width %d is not a size", width);

    int src_w = gdk_pixbuf_get_width(b->pixbuf);
    int src_h = gdk_pixbuf_get_height(b->pixbuf);
    int height;

    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        int32_t h = 0;
        if (!bta_to_int(ctx, argv[1], "Bitmap.Scale", &h))
            return JS_EXCEPTION;
        if (h <= 0)
            return JS_ThrowRangeError(ctx, "Bitmap.Scale: height %d is not a size", h);
        height = h;
    } else {
        height = (int)lround((double)src_h * width / src_w);
        if (height < 1)
            height = 1;
    }

    GdkPixbuf *out = gdk_pixbuf_scale_simple(b->pixbuf, width, height,
                                             GDK_INTERP_BILINEAR);
    if (!out)
        return JS_ThrowPlainError(ctx, "Bitmap.Scale: could not make %dx%d", width, height);
    return bta_bitmap_new(ctx, out);
}

static JSValue bitmap_crop(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap.Crop");
    if (!b)
        return JS_EXCEPTION;
    if (argc < 4)
        return JS_ThrowTypeError(ctx,
            "Bitmap.Crop(x, y, width, height) needs four numbers");

    int32_t x, y, width, height;
    if (!bta_to_int(ctx, argv[0], "Bitmap.Crop", &x) ||
        !bta_to_int(ctx, argv[1], "Bitmap.Crop", &y) ||
        !bta_to_int(ctx, argv[2], "Bitmap.Crop", &width) ||
        !bta_to_int(ctx, argv[3], "Bitmap.Crop", &height))
        return JS_EXCEPTION;

    if (width <= 0 || height <= 0)
        return JS_ThrowRangeError(ctx,
            "Bitmap.Crop: %dx%d is not a box", width, height);

    int src_w = gdk_pixbuf_get_width(b->pixbuf);
    int src_h = gdk_pixbuf_get_height(b->pixbuf);

    /* A box that starts outside has nothing to keep; a box that runs past the
     * edge is the edge, the way `Bytes.Slice` clamps. */
    x = MAX(0, x);
    y = MAX(0, y);
    if (x >= src_w || y >= src_h)
        return JS_ThrowRangeError(ctx,
            "Bitmap.Crop: %d,%d is outside a %dx%d picture", x, y, src_w, src_h);

    width  = MIN(width,  src_w - x);
    height = MIN(height, src_h - y);

    GdkPixbuf *out = gdk_pixbuf_new_subpixbuf(b->pixbuf, x, y, width, height);
    if (!out)
        return JS_ThrowPlainError(ctx,
            "Bitmap.Crop: could not keep %dx%d at %d,%d", width, height, x, y);
    return bta_bitmap_new(ctx, out);
}

/* A PNG read callback over memory, for the arbitrary-angle road below. */
typedef struct {
    const guchar *data;
    gsize         len;
    gsize         at;
} BitmapPngStream;

static cairo_status_t bitmap_png_read(void *closure, unsigned char *out,
                                      unsigned int length)
{
    BitmapPngStream *s = closure;

    if (length > s->len - s->at)
        return CAIRO_STATUS_READ_ERROR;
    memcpy(out, s->data + s->at, length);
    s->at += length;
    return CAIRO_STATUS_SUCCESS;
}

/*
 * The pixels, turned by `degrees` clockwise.
 *
 * 90, 180 and 270 are `gdk_pixbuf_rotate_simple`, which is exact and keeps the
 * image's own format.  Everything else goes through a cairo surface and expands
 * the canvas to the turned rectangle's bounding box; the source travels as PNG
 * bytes because that is the one lossless, channel-order-free bridge between the
 * two libraries -- the alternative, handing cairo GdkPixbuf's RGBA rows, has
 * the red and blue channels swapped on little-endian machines.
 */
static JSValue bitmap_rotate(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap.Rotate");
    if (!b)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Bitmap.Rotate(degrees) needs degrees");

    double degrees = 0;
    if (!bta_to_number(ctx, argv[0], "Bitmap.Rotate", &degrees))
        return JS_EXCEPTION;

    /* A whole number of turns is no turn, and an angle in the millions has no
     * more precision than the same one within a circle.  Reducing first keeps
     * the quarter-turn test exact and the cast below inside an `int`. */
    degrees = fmod(degrees, 360.0);

    double quarters = degrees / 90.0;
    double nearest  = round(quarters);
    if (fabs(quarters - nearest) < 1e-9) {
        int turn = ((int)nearest) % 4;
        if (turn < 0) turn += 4;
        if (turn == 0)
            return bta_bitmap_new(ctx, gdk_pixbuf_copy(b->pixbuf));

        GdkPixbufRotation how = turn == 1 ? GDK_PIXBUF_ROTATE_CLOCKWISE
                              : turn == 2 ? GDK_PIXBUF_ROTATE_UPSIDEDOWN
                                          : GDK_PIXBUF_ROTATE_COUNTERCLOCKWISE;
        GdkPixbuf *out = gdk_pixbuf_rotate_simple(b->pixbuf, how);
        if (!out)
            return JS_ThrowPlainError(ctx, "Bitmap.Rotate: could not turn the picture");
        return bta_bitmap_new(ctx, out);
    }

    gchar *png = NULL;
    gsize  len = 0;
    GError *error = NULL;

    if (!gdk_pixbuf_save_to_buffer(b->pixbuf, &png, &len, "png", &error, NULL)) {
        JSValue e = JS_ThrowPlainError(ctx, "Bitmap.Rotate: %s",
                                       error ? bta_gerror_text(error)
                                             : "could not read the pixels");
        g_clear_error(&error);
        return e;
    }

    BitmapPngStream stream = { (const guchar *)png, len, 0 };
    cairo_surface_t *flat = cairo_image_surface_create_from_png_stream(
        bitmap_png_read, &stream);

    if (cairo_surface_status(flat) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(flat);
        g_free(png);
        return JS_ThrowPlainError(ctx, "Bitmap.Rotate: could not read the pixels");
    }

    double radians = degrees * G_PI / 180.0;
    int src_w = gdk_pixbuf_get_width(b->pixbuf);
    int src_h = gdk_pixbuf_get_height(b->pixbuf);
    int out_w = (int)ceil(fabs(src_w * cos(radians)) +
                          fabs(src_h * sin(radians)));
    int out_h = (int)ceil(fabs(src_w * sin(radians)) +
                          fabs(src_h * cos(radians)));

    cairo_surface_t *turned = cairo_image_surface_create(CAIRO_FORMAT_ARGB32,
                                                         out_w, out_h);
    cairo_t *cr = cairo_create(turned);
    cairo_translate(cr, out_w / 2.0, out_h / 2.0);
    cairo_rotate(cr, radians);
    cairo_translate(cr, -src_w / 2.0, -src_h / 2.0);
    cairo_set_source_surface(cr, flat, 0, 0);
    cairo_paint(cr);
    cairo_destroy(cr);
    cairo_surface_destroy(flat);
    g_free(png);

#ifdef BTA_HEADLESS
    GdkPixbuf *out = pixbuf_from_surface(turned);
#else
    G_GNUC_BEGIN_IGNORE_DEPRECATIONS
    GdkPixbuf *out = gdk_pixbuf_get_from_surface(turned, 0, 0, out_w, out_h);
    G_GNUC_END_IGNORE_DEPRECATIONS
#endif
    cairo_surface_destroy(turned);

    if (!out)
        return JS_ThrowPlainError(ctx, "Bitmap.Rotate: could not make the turned picture");
    return bta_bitmap_new(ctx, out);
}

static JSValue bitmap_flip(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap.Flip");
    if (!b)
        return JS_EXCEPTION;

    bool horizontal = argc > 0 && JS_ToBool(ctx, argv[0]);
    bool vertical   = argc > 1 && JS_ToBool(ctx, argv[1]);

    GdkPixbuf *out;
    if (!horizontal && !vertical) {
        out = gdk_pixbuf_copy(b->pixbuf);
    } else if (horizontal && vertical) {
        out = gdk_pixbuf_rotate_simple(b->pixbuf, GDK_PIXBUF_ROTATE_UPSIDEDOWN);
    } else if (horizontal) {
        out = gdk_pixbuf_flip(b->pixbuf, TRUE);
    } else {
        GdkPixbuf *half = gdk_pixbuf_rotate_simple(b->pixbuf,
                                                   GDK_PIXBUF_ROTATE_UPSIDEDOWN);
        out = half ? gdk_pixbuf_flip(half, TRUE) : NULL;
        if (half) g_object_unref(half);
    }

    if (!out)
        return JS_ThrowPlainError(ctx, "Bitmap.Flip: could not turn the picture");
    return bta_bitmap_new(ctx, out);
}

/* ------------------------------------------------------------------ output */

static JSValue bitmap_save(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap.Save");
    if (!b)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Bitmap.Save(path) needs a path");

    const char *path = bta_file_path(ctx, argv[0], "Bitmap.Save");
    if (!path)
        return JS_EXCEPTION;

    GError *error = NULL;
    bool ok = gdk_pixbuf_save(b->pixbuf, path, "png", &error, NULL);

    if (!ok) {
        JSValue e = JS_ThrowPlainError(ctx, "Bitmap.Save: cannot write %s: %s",
                                       path, error ? bta_gerror_text(error)
                                                   : "could not write");
        g_clear_error(&error);
        JS_FreeCString(ctx, path);
        return e;
    }

    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static JSValue bitmap_to_png(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    (void)argc;
    (void)argv;
    BtaBitmap *b = bitmap_of(ctx, this_val, "Bitmap.ToPng");
    if (!b)
        return JS_EXCEPTION;

    gchar *png = NULL;
    gsize  len = 0;
    GError *error = NULL;

    if (!gdk_pixbuf_save_to_buffer(b->pixbuf, &png, &len, "png", &error, NULL)) {
        JSValue e = JS_ThrowPlainError(ctx, "Bitmap.ToPng: %s",
                                       error ? bta_gerror_text(error)
                                             : "could not write the picture");
        g_clear_error(&error);
        return e;
    }

    JSValue out = bta_bytes_new(ctx, png, len);
    g_free(png);
    return out;
}

/* -------------------------------------------------------------- registration */

static const JSCFunctionListEntry bitmap_proto_funcs[] = {
    JS_CFUNC_DEF("toString", 0, bitmap_to_string),
    /* Scale(width, [height]) -> Bitmap
     *   a new picture. One side is enough: the other follows the picture's own
     *   proportions; both make that exact size, distorting if it has to
     */
    JS_CFUNC_DEF("Scale", 2, bitmap_scale),
    /* Crop(x, y, width, height) -> Bitmap
     *   the box kept. A box that runs past the edge is clipped to it, the way
     *   `Bytes.Slice` clamps; one with no overlap at all is refused
     */
    JS_CFUNC_DEF("Crop", 4, bitmap_crop),
    /* Rotate(degrees) -> Bitmap
     *   clockwise, like `Painter.Rotate`; 90/180/270 are exact, any other angle
     *   expands the canvas to the turned rectangle
     */
    JS_CFUNC_DEF("Rotate", 1, bitmap_rotate),
    /* Flip(horizontal, [vertical]) -> Bitmap
     *   a mirror; both together is the same as `Rotate(180)`
     */
    JS_CFUNC_DEF("Flip", 2, bitmap_flip),
    /* Save(path)
     *   writes PNG, like `DrawingArea.Save`
     */
    JS_CFUNC_DEF("Save", 1, bitmap_save),
    /* ToPng() -> Bytes
     *   the same PNG in memory, for an upload or a `Record` field
     */
    JS_CFUNC_DEF("ToPng", 0, bitmap_to_png),
    /* Width
     *   pixels, read-only
     */
    JS_CGETSET_DEF("Width", bitmap_get_width, NULL),
    /* Height
     *   pixels, read-only
     */
    JS_CGETSET_DEF("Height", bitmap_get_height, NULL),
};

void bta_bitmap_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_bitmap_class_id);
    JS_NewClass(rt, bta_bitmap_class_id, &bitmap_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, bitmap_proto_funcs,
                               G_N_ELEMENTS(bitmap_proto_funcs));
    JS_SetClassProto(ctx, bta_bitmap_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, bitmap_construct, "Bitmap", 0,
                                    JS_CFUNC_constructor, 0);
    /* Load(path) -> Bitmap
     *   the picture a `Picture` would show: PNG, JPEG, WebP, TIFF, BMP, and an
     *   SVG only where this machine has a loader. A path that is not one is
     *   refused by name, where `Probe.Image` answers `null`
     */
    JS_SetPropertyStr(ctx, ctor, "Load",
                      JS_NewCFunction(ctx, bitmap_load, "Load", 1));
    /* FromBytes(bytes) -> Bitmap
     *   the picture already in memory -- what `Http` answers with and
     *   `File.LoadBytes` reads -- decoded once
     */
    JS_SetPropertyStr(ctx, ctor, "FromBytes",
                      JS_NewCFunction(ctx, bitmap_from_bytes, "FromBytes", 1));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Bitmap", ctor);
}
