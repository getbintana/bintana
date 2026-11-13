/*
 * A drawing plugin, for the spike: the same shape as a real `lib/drawing`
 * would have, but only the calls a benchmark and a PDF need.
 *
 * It is a **spike**, not the API: the painter here has methods where the
 * native one has properties (`p.Color(...)` against `p.Color = ...`), no Pango
 * text layout, and it only offers `SavePdf`. What it answers is whether a
 * plugin can carry cairo and draw through the ABI at a cost worth paying.
 *
 * Built by `tests/headless.sh` with cc and cairo, into a temporary library
 * directory; nothing here is installed.
 */
#include "bta_plugin.h"

#include <cairo/cairo.h>
#include <cairo/cairo-pdf.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    int       id;
    cairo_t  *cr;
    double    r, g, b, a;
} Painter;

static Painter **painters;
static int       npainters, capacity, next_id;

static Painter *find_painter(int id)
{
    for (int i = 0; i < npainters; i++)
        if (painters[i]->id == id)
            return painters[i];
    return NULL;
}

static Painter *new_painter(cairo_t *cr)
{
    if (npainters == capacity) {
        capacity = capacity ? capacity * 2 : 8;
        painters = realloc(painters, sizeof(*painters) * capacity);
    }
    Painter *p = calloc(1, sizeof(*p));
    p->id = ++next_id;
    p->cr = cr;
    p->r = 0; p->g = 0; p->b = 0; p->a = 1;
    painters[npainters++] = p;
    return p;
}

static void drop_painter(Painter *p)
{
    for (int i = 0; i < npainters; i++)
        if (painters[i] == p) {
            painters[i] = painters[--npainters];
            break;
        }
    free(p);
}

static BtaValue nothing(const BtaHost *host)
{
    return host->undefined(host);
}

#define PAINTER(p) find_painter((int)(intptr_t)(p))

static BtaValue p_color(const BtaHost *host, void *user,
                        int argc, const BtaValue *argv)
{
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "Color on a painter that is over"), nothing(host);
    p->r = host->value(host, argv[0]);
    p->g = host->value(host, argv[1]);
    p->b = host->value(host, argv[2]);
    p->a = argc > 3 ? host->value(host, argv[3]) : 1;
    cairo_set_source_rgba(p->cr, p->r, p->g, p->b, p->a);
    return nothing(host);
}

static BtaValue p_line_width(const BtaHost *host, void *user,
                             int argc, const BtaValue *argv)
{
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "LineWidth on a painter that is over"), nothing(host);
    cairo_set_line_width(p->cr, host->value(host, argv[0]));
    return nothing(host);
}

static BtaValue p_move_to(const BtaHost *host, void *user,
                          int argc, const BtaValue *argv)
{
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "MoveTo on a painter that is over"), nothing(host);
    cairo_move_to(p->cr, host->value(host, argv[0]), host->value(host, argv[1]));
    return nothing(host);
}

static BtaValue p_line_to(const BtaHost *host, void *user,
                          int argc, const BtaValue *argv)
{
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "LineTo on a painter that is over"), nothing(host);
    cairo_line_to(p->cr, host->value(host, argv[0]), host->value(host, argv[1]));
    return nothing(host);
}

static BtaValue p_rectangle(const BtaHost *host, void *user,
                            int argc, const BtaValue *argv)
{
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "Rectangle on a painter that is over"), nothing(host);
    cairo_rectangle(p->cr, host->value(host, argv[0]), host->value(host, argv[1]),
                    host->value(host, argv[2]), host->value(host, argv[3]));
    return nothing(host);
}

static BtaValue p_fill(const BtaHost *host, void *user,
                       int argc, const BtaValue *argv)
{
    (void)argc; (void)argv;
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "Fill on a painter that is over"), nothing(host);
    cairo_fill(p->cr);
    return nothing(host);
}

static BtaValue p_stroke(const BtaHost *host, void *user,
                         int argc, const BtaValue *argv)
{
    (void)argc; (void)argv;
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "Stroke on a painter that is over"), nothing(host);
    cairo_stroke(p->cr);
    return nothing(host);
}

static BtaValue p_text(const BtaHost *host, void *user,
                       int argc, const BtaValue *argv)
{
    Painter *p = PAINTER(user);
    if (!p)
        return host->fail(host, "Text on a painter that is over"), nothing(host);
    const char *text = host->text(host, argv[0]);
    if (!text)
        return nothing(host);
    cairo_select_font_face(p->cr, "Sans", CAIRO_FONT_SLANT_NORMAL,
                           CAIRO_FONT_WEIGHT_NORMAL);
    cairo_set_font_size(p->cr, 10);
    cairo_move_to(p->cr, host->value(host, argv[1]), host->value(host, argv[2]));
    cairo_show_text(p->cr, text);
    return nothing(host);
}

static void set_method(const BtaHost *host, BtaValue obj, const char *name,
                       int arity, BtaPluginFn fn, int id)
{
    host->set(host, obj, name,
              host->function(host, name, arity, fn, (void *)(intptr_t)id));
}

static BtaValue save_pdf(const BtaHost *host, void *user,
                         int argc, const BtaValue *argv)
{
    (void)user;
    if (argc < 5)
        return host->fail(host, "Drawing.SavePdf needs (path, width, height, pages, before)"),
               nothing(host);

    const char *path = host->text(host, argv[0]);
    int width  = (int)host->value(host, argv[1]);
    int height = (int)host->value(host, argv[2]);
    int pages  = (int)host->value(host, argv[3]);

    if (!path || width <= 0 || height <= 0 || pages <= 0)
        return host->fail(host, "Drawing.SavePdf: bad path or size"), nothing(host);

    cairo_surface_t *surface = cairo_pdf_surface_create(path, width, height);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(surface);
        return host->fail(host, "Drawing.SavePdf: cannot write the PDF"), nothing(host);
    }

    cairo_t *cr = cairo_create(surface);
    BtaValue error = host->undefined(host);

    for (int page = 1; page <= pages; page++) {
        Painter *p = new_painter(cr);
        BtaValue obj = host->object(host);

        set_method(host, obj, "Color",     4, p_color,      p->id);
        set_method(host, obj, "LineWidth", 1, p_line_width, p->id);
        set_method(host, obj, "MoveTo",    2, p_move_to,    p->id);
        set_method(host, obj, "LineTo",    2, p_line_to,    p->id);
        set_method(host, obj, "Rectangle", 4, p_rectangle,  p->id);
        set_method(host, obj, "Fill",      0, p_fill,       p->id);
        set_method(host, obj, "Stroke",    0, p_stroke,     p->id);
        set_method(host, obj, "Text",      3, p_text,       p->id);

        BtaValue args[4] = {
            obj,
            host->number(host, page),
            host->number(host, width),
            host->number(host, height),
        };
        BtaValue result = host->call(host, argv[4], host->undefined(host), 4, args);
        BtaKind  kind   = host->kind(host, result);

        host->release(host, result);
        host->release(host, args[1]);
        host->release(host, args[2]);
        host->release(host, args[3]);
        host->release(host, obj);
        drop_painter(p);

        if (kind == BTA_KIND_ERROR) {
            error = host->undefined(host);
            break;
        }
        cairo_show_page(cr);
    }

    cairo_destroy(cr);
    cairo_surface_finish(surface);
    cairo_surface_destroy(surface);
    return error;
}

static int plugin_init(const BtaHost *host, BtaValue global)
{
    BtaValue drawing = host->object(host);

    host->set(host, drawing, "SavePdf",
              host->function(host, "SavePdf", 5, save_pdf, NULL));
    host->set(host, global, "Drawing", drawing);
    return 0;
}

static void plugin_cleanup(void)
{
    /* The document frees its painters as each page ends; nothing survives a
     * run, and the loader calls this after the context is gone. */
    free(painters);
    painters = NULL;
    npainters = capacity = 0;
}

BTA_PLUGIN_EXPORT BtaPlugin BTA_PLUGIN_ENTRY = {
    BTA_PLUGIN_ABI,
    plugin_init,
    plugin_cleanup,
};
