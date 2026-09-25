/*
 * DrawingArea and Painter -- where the ink goes when no control puts it there.
 *
 * Until this file there was no way to draw a line: `Image` shows an icon,
 * `Picture` shows a photograph, and that was the whole of what reached the screen
 * without being a control.  What that ruled out was a category rather than a
 * control -- a chart, a gauge, a ruler, a schematic -- and the design, the
 * measurements it turns on and the chart set it was built for are in
 * [docs/widgets.md](../../docs/widgets.md#drawingarea-and-painter).
 *
 * Two classes:
 *
 *   DrawingArea   a control like any other, with a `Draw` event and `Redraw()`
 *   Painter       what that event hands you: a cairo context with names
 *
 * **The painter is valid only while the frame lasts.**  It wraps the `cairo_t`
 * GTK hands the draw function and destroys on the way out, so every call goes
 * through `painter_of`, which refuses once the frame is over.  That refusal is
 * the point: the natural mistake is to keep the painter in `this` and draw from a
 * timer later, which without it is a write into freed memory some frames after
 * the fact -- the kind of bug that lands in whatever test happens to run next.
 *
 * It is **one painter per surface, reused**, kept on the widget's own JS object
 * as `__painter` so the collector holds it for exactly as long as the widget:
 * allocating a wrapper sixty times a second to throw it away is a cost that is
 * invisible until something animates.
 *
 * Cairo and not GSK, which is a decision with reasons in the plan: the primitive
 * set is complete and old, and `Save()` is the same calls against an image
 * surface, so there are two targets from the first day.
 */
#include "bta.h"

#include <cairo.h>
#include <cairo-pdf.h>
#include <glib/gstdio.h>
#include <math.h>
#include <pango/pangocairo.h>

/* ---------------------------------------------------------------- Painter */

static JSClassID bta_painter_class_id;

/* What one frame's worth of calls may grow to before it stops being recorded.
 * A `Dump()` is read by a person or asserted by a test; a drawing that makes a
 * hundred thousand calls has already said what it is. */
#define DUMP_CAP 64000

typedef struct {
    BtaWidget   *w;         /* the surface, for its font and its ink colour */
    cairo_t     *cr;        /* NULL between frames: the whole lifetime rule */
    PangoLayout *layout;    /* one, reused -- measuring is 40% of drawing */
    GString     *dump;      /* what this frame was asked to do */
    char        *color;     /* what Color was last set to: cairo has no getter */
    int          width, height;
} BtaPainter;

static void painter_finalizer(JSRuntime *rt, JSValue val)
{
    BtaPainter *p = JS_GetOpaque(val, bta_painter_class_id);

    if (!p)
        return;
    /* Never the cairo_t: it belongs to whoever opened the frame. */
    if (p->layout)
        g_object_unref(p->layout);
    if (p->dump)
        g_string_free(p->dump, TRUE);
    g_free(p->color);
    g_free(p);
}

static JSClassDef painter_class = {
    "Painter",
    .finalizer = painter_finalizer,
};

/*
 * The painter, or a throw.  Everything below goes through here, which is what
 * makes the lifetime rule one line rather than a convention.
 */
static BtaPainter *painter_of(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = JS_GetOpaque2(ctx, this_val, bta_painter_class_id);

    if (!p)
        return NULL;                       /* GetOpaque2 has thrown */
    if (!p->cr) {
        JS_ThrowTypeError(ctx, "Painter: the frame is over -- a painter is only "
                               "valid inside the Draw it came from");
        return NULL;
    }
    return p;
}

/* One line of `Dump()`.  Recorded always: it is some tens of nanoseconds a call
 * against a frame budget of tens of thousands, and a Dump that only answers when
 * something was turned on is a Dump nobody reaches for. */
static void note(BtaPainter *p, const char *fmt, ...)
{
    if (!p->dump || p->dump->len > DUMP_CAP)
        return;

    va_list args;
    va_start(args, fmt);
    g_string_append_vprintf(p->dump, fmt, args);
    va_end(args);
    g_string_append_c(p->dump, '\n');

    if (p->dump->len > DUMP_CAP)
        g_string_append(p->dump, "...\n");
}

/*
 * A number for a `Dump()` line: `12`, not `12.000000` and **never** `12,5`.
 *
 * `%g` through printf follows `LC_NUMERIC`, so a dump formatted that way says
 * `(380,142,449)` on this machine for the point `(380, 142.449)` -- the decimal
 * comma, in the middle of a comma-separated pair, in the one output a test
 * asserts on. `g_ascii_formatd` is the locale-independent one, and it is the same
 * trap the JSON patch in `vendor/` exists for.
 */
#define NUMLEN G_ASCII_DTOSTR_BUF_SIZE

static const char *num(char *buf, double v)
{
    return g_ascii_formatd(buf, NUMLEN, "%g", v);
}

static void note_num(GString *out, double v)
{
    char buf[NUMLEN];
    g_string_append(out, num(buf, v));
}

/*
 * A coordinate, refused if it is not a finite number.
 *
 * **A NaN is worse than a refusal**, and it is the one a chart hands over: a
 * series with a missing reading makes `p.LineTo(x, undefined)` an ordinary
 * line, cairo records the call, puts the context in an error state, and the
 * *rest of the frame draws nothing* -- with no throw and nothing to see. So
 * every argument names the call it belongs to, the way `bta_to_number` names
 * the property, and the frame that broke says which call broke it.
 */
static double arg_num(JSContext *ctx, JSValueConst v, const char *where, bool *bad)
{
    double d = 0;
    if (JS_ToFloat64(ctx, &d, v)) {
        *bad = true;
        return 0;                      /* it threw on the way; that stands */
    }
    if (!isfinite(d)) {
        JS_ThrowRangeError(ctx, "%s: %s is not a finite number", where,
                           isnan(d) ? "NaN" : "Infinity");
        *bad = true;
    }
    return d;
}

/* -------------------------------------------------------------- the colours
 *
 * **`Foreground` is the theme's, resolved, and there is no `Background`.**
 *
 * `gtk_widget_get_color()` answers what colour this widget's text is drawn in,
 * which is the one fact a drawing needs and cannot otherwise have: a chart in
 * `#000000` is invisible on a dark desktop.  GTK4 has no per-widget answer for
 * the *ground* -- the supported way to paint one is to let the widget's own CSS
 * do it -- so rather than invent one, `Background` is the widget's ordinary
 * `Background` property and the drawing simply does not paint over it.
 *
 * `Dark` is the other half, and it is a derivation stated plainly: if the ink is
 * light, the ground is dark.  That is enough to choose a palette, and it is
 * honest about being computed from the foreground rather than asked of the theme.
 * It lives in `bta_widget.c` now, because every widget answers it as
 * `Widget.Dark` and a second copy of the arithmetic here would be a second
 * answer to one question.
 */
static void painter_ink(BtaPainter *p, GdkRGBA *rgba)
{
    *rgba = (GdkRGBA){ 0, 0, 0, 1 };
    if (p->w && p->w->inner)
        gtk_widget_get_color(p->w->inner, rgba);
}

static char *rgba_text(const GdkRGBA *c)
{
    int r = (int)(c->red * 255 + 0.5), g = (int)(c->green * 255 + 0.5),
        b = (int)(c->blue * 255 + 0.5);

    if (c->alpha >= 1.0)
        return g_strdup_printf("rgb(%d,%d,%d)", r, g, b);

    /* The alpha through `g_ascii_formatd` and not through `%g`, or a desktop
     * that writes a decimal comma hands back `rgba(32,64,96,0,5)` -- a string
     * `gdk_rgba_parse` refuses, so assigning it to `Color` throws from inside
     * a `Draw`.  The same trap the JSON patch in `vendor/` exists for. */
    char alpha[NUMLEN];

    return g_strdup_printf("rgba(%d,%d,%d,%s)", r, g, b,
                           g_ascii_formatd(alpha, NUMLEN, "%.3g", c->alpha));
}

static JSValue painter_get_foreground(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    GdkRGBA ink;
    painter_ink(p, &ink);

    char   *text = rgba_text(&ink);
    JSValue out  = JS_NewString(ctx, text);
    g_free(text);
    return out;
}

static JSValue painter_get_dark(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    /* The widget's own, through the same function `Widget.Dark` answers with:
     * one derivation, so a drawing and the form around it can never disagree
     * about which way the desktop is. */
    return JS_NewBool(ctx, bta_widget_dark(p->w ? p->w->inner : NULL));
}

/* ----------------------------------------------------------------- Color */

static JSValue painter_get_color(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    if (p->color)
        return JS_NewString(ctx, p->color);
    return painter_get_foreground(ctx, this_val);
}

static JSValue painter_set_color(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GdkRGBA c;
    if (!gdk_rgba_parse(&c, s)) {
        JSValue e = JS_ThrowRangeError(ctx, "Color: '%s' is not a colour", s);
        JS_FreeCString(ctx, s);
        return e;
    }

    cairo_set_source_rgba(p->cr, c.red, c.green, c.blue, c.alpha);
    g_free(p->color);
    p->color = g_strdup(s);
    note(p, "Color %s", s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------ the pen */

enum { PEN_WIDTH, PEN_ANTIALIAS };

static JSValue painter_get_pen(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    if (magic == PEN_WIDTH)
        return JS_NewFloat64(ctx, cairo_get_line_width(p->cr));
    return JS_NewBool(ctx, cairo_get_antialias(p->cr) != CAIRO_ANTIALIAS_NONE);
}

static JSValue painter_set_pen(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    if (magic == PEN_WIDTH) {
        double v;
        if (JS_ToFloat64(ctx, &v, val))
            return JS_EXCEPTION;
        if (!(v >= 0))
            return JS_ThrowRangeError(ctx, "LineWidth: %g is not a width", v);
        cairo_set_line_width(p->cr, v);
        char nb[NUMLEN];
        note(p, "LineWidth %s", num(nb, v));
        
        return JS_UNDEFINED;
    }

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    /*
     * **The one performance knob this API needs**, and it is measured:
     * `tests/manual/cairo-cost.c` puts a jagged 5000-point line at 109 ms
     * antialiased and 7.8 ms without.  The cost is in pixels covered, not in
     * points, so a drawing that crosses its own height on every segment is the
     * one shape that wants this off.
     */
    cairo_set_antialias(p->cr, b ? CAIRO_ANTIALIAS_DEFAULT : CAIRO_ANTIALIAS_NONE);
    note(p, "Antialias %s", b ? "true" : "false");
    return JS_UNDEFINED;
}

/* A dash pattern as an array of lengths; `[]` is a solid line. */
static JSValue painter_get_dash(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    int     n   = cairo_get_dash_count(p->cr);
    JSValue arr = JS_NewArray(ctx);

    if (n > 0) {
        double *dashes = g_new0(double, n);
        double  offset = 0;
        cairo_get_dash(p->cr, dashes, &offset);
        for (int i = 0; i < n; i++)
            JS_SetPropertyUint32(ctx, arr, i, JS_NewFloat64(ctx, dashes[i]));
        g_free(dashes);
    }
    return arr;
}

static JSValue painter_set_dash(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (!JS_IsArray(val))
        return JS_ThrowTypeError(ctx, "LineDash expects an array of lengths "
                                      "([] for a solid line)");

    JSValue  lenv = JS_GetPropertyStr(ctx, val, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    double *dashes = n ? g_new0(double, n) : NULL;
    GString *shown = g_string_new("LineDash [");

    for (uint32_t i = 0; i < n; i++) {
        JSValue e  = JS_GetPropertyUint32(ctx, val, i);
        bool    no = false;
        dashes[i]  = arg_num(ctx, e, "LineDash", &no);
        JS_FreeValue(ctx, e);
        if (no || dashes[i] < 0) {
            /* Read before the free: the message used to quote the array after
             * releasing it, which came out right only because g_free does not
             * poison and is a use-after-free under a sanitizer. */
            double bad = dashes[i];

            g_free(dashes);
            g_string_free(shown, TRUE);
            return no ? JS_EXCEPTION
                      : JS_ThrowRangeError(ctx, "LineDash: %g is not a length",
                                           bad);
        }
        if (i)
            g_string_append_c(shown, ',');
        note_num(shown, dashes[i]);
    }

    cairo_set_dash(p->cr, dashes, (int)n, 0);
    g_string_append_c(shown, ']');
    note(p, "%s", shown->str);
    g_string_free(shown, TRUE);
    g_free(dashes);
    return JS_UNDEFINED;
}

/*
 * `LineCap` and `LineJoin`: the words GTK's own CSS uses, spelled as this
 * language spells an enumerated value -- refused by name, since a cap nobody
 * meant is a drawing that looks almost right.
 */
static const struct { const char *name; cairo_line_cap_t cap; } CAPS[] = {
    { "Butt", CAIRO_LINE_CAP_BUTT }, { "Round", CAIRO_LINE_CAP_ROUND },
    { "Square", CAIRO_LINE_CAP_SQUARE },
};
static const struct { const char *name; cairo_line_join_t join; } JOINS[] = {
    { "Miter", CAIRO_LINE_JOIN_MITER }, { "Round", CAIRO_LINE_JOIN_ROUND },
    { "Bevel", CAIRO_LINE_JOIN_BEVEL },
};

static JSValue painter_get_cap(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    cairo_line_cap_t cap = cairo_get_line_cap(p->cr);
    for (guint i = 0; i < G_N_ELEMENTS(CAPS); i++)
        if (CAPS[i].cap == cap)
            return JS_NewString(ctx, CAPS[i].name);
    return JS_NewString(ctx, CAPS[0].name);
}

static JSValue painter_set_cap(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    for (guint i = 0; i < G_N_ELEMENTS(CAPS); i++)
        if (!strcmp(s, CAPS[i].name)) {
            cairo_set_line_cap(p->cr, CAPS[i].cap);
            note(p, "LineCap %s", s);
            JS_FreeCString(ctx, s);
            return JS_UNDEFINED;
        }

    JSValue e = JS_ThrowRangeError(ctx, "LineCap: '%s' is not one of "
                                       "Butt, Round, Square", s);
    JS_FreeCString(ctx, s);
    return e;
}

static JSValue painter_get_join(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    cairo_line_join_t join = cairo_get_line_join(p->cr);
    for (guint i = 0; i < G_N_ELEMENTS(JOINS); i++)
        if (JOINS[i].join == join)
            return JS_NewString(ctx, JOINS[i].name);
    return JS_NewString(ctx, JOINS[0].name);
}

static JSValue painter_set_join(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    for (guint i = 0; i < G_N_ELEMENTS(JOINS); i++)
        if (!strcmp(s, JOINS[i].name)) {
            cairo_set_line_join(p->cr, JOINS[i].join);
            note(p, "LineJoin %s", s);
            JS_FreeCString(ctx, s);
            return JS_UNDEFINED;
        }

    JSValue e = JS_ThrowRangeError(ctx, "LineJoin: '%s' is not one of "
                                       "Miter, Round, Bevel", s);
    JS_FreeCString(ctx, s);
    return e;
}

/* ------------------------------------------------------------------- text */

/*
 * What a caller may say about a run of text, on the painter and on `Text` alike:
 * `{ Width, Markup, Align }`.
 *
 * **`Markup` is the one that is not a convenience.** A paragraph whose font
 * changes mid-line -- a word in bold, a name in italic, a code span in a
 * monospace -- cannot be laid out by measuring a string and breaking it: the
 * break has to be decided by whatever knows how wide each piece is, and that is
 * Pango. `Label` has had `Markup` since the beginning for exactly this reason;
 * this is the same answer where the text is *drawn* rather than packed, and it
 * is what `lib/markdown` renders a paragraph with.
 *
 * `Width` wraps (the same wrap `Text.Size` has always measured with) and `Align`
 * is what the wrapped lines are aligned to inside it -- a right-aligned column
 * of numbers, a centred caption -- which is the one thing a caller could not do
 * for itself once Pango, and not the caller, is breaking the lines.
 */
typedef struct {
    int            width;        /* wrap to this many pixels; 0 for no wrap */
    bool           markup;       /* the text is Pango markup */
    PangoAlignment align;
} TextOpts;

static bool text_opts(JSContext *ctx, JSValueConst v, const char *where,
                      TextOpts *o)
{
    o->width  = 0;
    o->markup = false;
    o->align  = PANGO_ALIGN_LEFT;

    if (JS_IsUndefined(v) || JS_IsNull(v))
        return true;
    if (!JS_IsObject(v) || JS_IsArray(v)) {
        JS_ThrowTypeError(ctx, "%s: the options are { Width, Markup, Align }", where);
        return false;
    }

    JSValue w = JS_GetPropertyStr(ctx, v, "Width");
    if (!JS_IsUndefined(w) && JS_ToInt32(ctx, &o->width, w)) {
        JS_FreeValue(ctx, w);
        return false;
    }
    JS_FreeValue(ctx, w);

    JSValue m = JS_GetPropertyStr(ctx, v, "Markup");
    if (!JS_IsUndefined(m)) {
        /* `JS_ToBool` answers -1 for a conversion that threw -- a getter on the
         * options object, which is a thing a caller may hand us -- and -1 into a
         * `bool` is `true`, so the failure would have been a markup run laid out
         * with an exception already pending. Every other option here checks; so
         * does this one. */
        int on = JS_ToBool(ctx, m);

        JS_FreeValue(ctx, m);
        if (on < 0)
            return false;
        o->markup = on != 0;
    } else {
        JS_FreeValue(ctx, m);
    }

    JSValue a = JS_GetPropertyStr(ctx, v, "Align");
    if (!JS_IsUndefined(a) && !JS_IsNull(a)) {
        const char *s = JS_ToCString(ctx, a);
        JS_FreeValue(ctx, a);
        if (!s)
            return false;

        bool ok = true;
        if      (!strcmp(s, "Left"))   o->align = PANGO_ALIGN_LEFT;
        else if (!strcmp(s, "Center")) o->align = PANGO_ALIGN_CENTER;
        else if (!strcmp(s, "Right"))  o->align = PANGO_ALIGN_RIGHT;
        else {
            JS_ThrowRangeError(ctx, "%s: Align '%s' is not Left, Center or Right",
                               where, s);
            ok = false;
        }
        JS_FreeCString(ctx, s);
        return ok;
    }
    JS_FreeValue(ctx, a);
    return true;
}

/*
 * The text into the layout, with everything the options say -- and with
 * everything they do not say **put back**, because both layouts here are kept
 * and reused: a width, an alignment or an attribute list left over from the last
 * call is a paragraph that wraps where nobody asked it to.
 *
 * Markup goes through `pango_parse_markup` rather than
 * `pango_layout_set_markup`, which swallows a parse error as a warning on the
 * console and lays out nothing. A `<b>` that was never closed -- or a `&` that
 * should have been escaped -- is a mistake in the caller's string, and it throws
 * where it was written.
 */
static bool layout_text(JSContext *ctx, PangoLayout *l, const char *s,
                        const TextOpts *o, const char *where)
{
    if (o->markup) {
        PangoAttrList *attrs = NULL;
        char          *plain = NULL;
        GError        *err   = NULL;

        if (!pango_parse_markup(s, -1, 0, &attrs, &plain, NULL, &err)) {
            JS_ThrowTypeError(ctx, "%s: the markup is not valid -- %s", where,
                              err ? err->message : "parse error");
            g_clear_error(&err);
            return false;
        }
        pango_layout_set_text(l, plain, -1);
        pango_layout_set_attributes(l, attrs);
        pango_attr_list_unref(attrs);
        g_free(plain);
    } else {
        pango_layout_set_attributes(l, NULL);
        pango_layout_set_text(l, s, -1);
    }

    /* **`WORD_CHAR` and not `WORD`**: a word wider than the box has to go
     * somewhere, and breaking it is the only answer that stays inside the width
     * the caller asked about. Wrapping that silently overflows would make the
     * measurement a lie. */
    pango_layout_set_wrap(l, PANGO_WRAP_WORD_CHAR);
    pango_layout_set_width(l, o->width > 0 ? o->width * PANGO_SCALE : -1);
    pango_layout_set_alignment(l, o->align);
    return true;
}

/* What a `Dump()` line says about the options, or nothing when there are none:
 * a drawing asserted off its dump is asserted on the wrap and the markup too,
 * and a line that read the same either way could not be. */
static void note_opts(GString *out, const TextOpts *o)
{
    if (o->width > 0)                  g_string_append_printf(out, " width %d", o->width);
    if (o->align == PANGO_ALIGN_CENTER) g_string_append(out, " center");
    if (o->align == PANGO_ALIGN_RIGHT)  g_string_append(out, " right");
    if (o->markup)                      g_string_append(out, " markup");
}


/*
 * One `PangoLayout`, kept and reused.  Measured: 200 labels laid out and drawn
 * cost 1.84 ms, and measuring alone 0.75 ms -- so measuring is 40% of drawing
 * and a layout built per call would be most of a chart's text budget.
 */
static PangoLayout *painter_layout(BtaPainter *p)
{
    if (!p->layout) {
        p->layout = pango_cairo_create_layout(p->cr);
        /* The widget's own font, so a drawing follows the desktop's font and its
         * text scale the way every control does. */
        if (p->w && p->w->inner) {
            PangoContext *pc = gtk_widget_get_pango_context(p->w->inner);
            if (pc)
                pango_layout_set_font_description(
                    p->layout, pango_context_get_font_description(pc));
        }
    } else {
        pango_cairo_update_layout(p->cr, p->layout);
    }
    return p->layout;
}

static JSValue painter_get_font(JSContext *ctx, JSValueConst this_val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    const PangoFontDescription *fd =
        pango_layout_get_font_description(painter_layout(p));
    if (!fd)
        return JS_NewString(ctx, "");

    char   *text = pango_font_description_to_string(fd);
    JSValue out  = JS_NewString(ctx, text ? text : "");
    g_free(text);
    return out;
}

static JSValue painter_set_font(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    PangoFontDescription *fd = pango_font_description_from_string(s);
    pango_layout_set_font_description(painter_layout(p), fd);
    pango_font_description_free(fd);

    note(p, "Font %s", s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* The text laid out, and the two numbers a caller wants from it.  Both measure
 * the string given: a chart asking for the height of a line passes "0".
 *
 * The options are the same ones `Text` draws with, so a wrapped run is measured
 * at the width it will be drawn at and a markup run measures what the markup
 * really lays out as -- the alternative being the caller measuring the tags. */
static bool painter_measure(JSContext *ctx, BtaPainter *p, JSValueConst v,
                            JSValueConst opts, const char *where,
                            int *width, int *height)
{
    TextOpts o;
    if (!text_opts(ctx, opts, where, &o))
        return false;

    const char *s = JS_ToCString(ctx, v);
    if (!s)
        return false;

    PangoLayout *l  = painter_layout(p);
    bool         ok = layout_text(ctx, l, s, &o, where);

    if (ok)
        pango_layout_get_pixel_size(l, width, height);
    JS_FreeCString(ctx, s);
    return ok;
}

enum { MEASURE_WIDTH, MEASURE_HEIGHT };

static JSValue painter_measure_js(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    int w = 0, h = 0;
    const char *where = magic == MEASURE_WIDTH ? "TextWidth" : "TextHeight";

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "%s(text, [options]) needs text", where);
    if (!painter_measure(ctx, p, argv[0],
                         argc > 1 ? argv[1] : JS_UNDEFINED,
                         where, &w, &h))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, magic == MEASURE_WIDTH ? w : h);
}

static JSValue painter_text(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (argc < 3)
        return JS_ThrowTypeError(ctx, "Text expects (text, x, y, [options])");

    bool   bad = false;
    double x   = arg_num(ctx, argv[1], "Text", &bad);
    double y   = arg_num(ctx, argv[2], "Text", &bad);
    if (bad)
        return JS_EXCEPTION;

    TextOpts o;
    if (!text_opts(ctx, argc > 3 ? argv[3] : JS_UNDEFINED, "Text", &o))
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s)
        return JS_EXCEPTION;

    char         nb[NUMLEN], nb2[NUMLEN];
    PangoLayout *l = painter_layout(p);

    if (!layout_text(ctx, l, s, &o, "Text")) {
        JS_FreeCString(ctx, s);
        return JS_EXCEPTION;
    }
    cairo_move_to(p->cr, x, y);
    pango_cairo_show_layout(p->cr, l);
    /*
     * **And the path is cleared afterwards**, which cairo does not do on its own.
     * Drawing text leaves a current point, so the next `Arc` -- which appends,
     * because that is what a pie slice wants -- joined it with a line from
     * wherever the label was. That was a stray diagonal across the first drawing
     * this file ever made, and it is nobody's idea of what `Text` does: it puts
     * ink down like `Fill` and `Stroke`, and those leave no path behind either.
     */
    cairo_new_path(p->cr);

    GString *line = g_string_new(NULL);
    g_string_append_printf(line, "Text \"%s\" at (%s,%s)", s, num(nb, x), num(nb2, y));
    note_opts(line, &o);
    note(p, "%s", line->str);
    g_string_free(line, TRUE);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------------- images
 *
 * `Image(path, x, y, [width], [height])`: a file, decoded once, put down at a
 * point.
 *
 * The decoding is GTK's own -- `gdk_texture_new_from_filename`, the same call
 * `Picture.File` makes, so the two agree about what counts as an image and say
 * the same thing about a file that is not one. The pixels are then downloaded
 * into a cairo surface, because a `Painter` is a cairo context and nothing else;
 * `gdk_texture_download` writes exactly the ARGB32 cairo wants, which is why
 * there is no format conversion here to get wrong.
 *
 * **That download is the expensive part and a drawing paints every frame**, so
 * it is cached: a 1200x600 logo is 2.8 MB of ARGB and re-reading it sixty times
 * a second is the whole frame budget. The cache is keyed by path and holds the
 * file's mtime and size beside it, so a logo replaced on disk is read again
 * instead of being the old one until the program restarts.
 */

typedef struct {
    cairo_surface_t *surface;
    gint64           mtime;
    gint64           size;
} BtaImage;

static void image_free(gpointer data)
{
    BtaImage *img = data;

    cairo_surface_destroy(img->surface);
    g_free(img);
}

static bool image_stat(const char *path, gint64 *mtime, gint64 *size)
{
    GStatBuf st;

    if (g_stat(path, &st) != 0)
        return false;
    *mtime = (gint64)st.st_mtime;
    *size  = (gint64)st.st_size;
    return true;
}

/*
 * Bounded by count, and emptied whole rather than by age: a drawing uses a
 * handful of images -- a logo, a signature, a few icons -- and the caller that
 * walks ten thousand photographs is the one this must not grow without end for.
 * An LRU for a table that holds four things is more code than it saves.
 */
#define IMAGE_CACHE_MAX 32

/*
 * A texture, downloaded into a cairo surface cairo can paint from.
 *
 * Shared by the two roads into `Painter.Image` -- a path and a `Bytes` -- so the
 * ceiling check and the `mark_dirty` that the first one learned the hard way
 * apply to the second without being written twice. `what` only names the thing
 * in the complaint: a file name, or how many bytes there were.
 */
static cairo_surface_t *surface_of_texture(JSContext *ctx, GdkTexture *texture,
                                           const char *what)
{
    int w = gdk_texture_get_width(texture);
    int h = gdk_texture_get_height(texture);

    cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, w, h);

    /* A surface cairo refused -- a picture too big for the allocator, most of
     * them -- has no data to write into, and downloading into that NULL is a
     * crash rather than a bad drawing. */
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        JS_ThrowRangeError(ctx, "Image: %s is %dx%d, which is too big to draw (%s)",
                           what, w, h,
                           cairo_status_to_string(cairo_surface_status(surface)));
        cairo_surface_destroy(surface);
        return NULL;
    }

    gdk_texture_download(texture, cairo_image_surface_get_data(surface),
                         cairo_image_surface_get_stride(surface));
    /* Written behind cairo's back, so it has to be told. Without this the first
     * paint shows whatever the surface was allocated with, which is nothing. */
    cairo_surface_mark_dirty(surface);
    return surface;
}

static cairo_surface_t *image_surface(JSContext *ctx, const char *path)
{
    static GHashTable *cache;

    gint64 mtime = 0, size = 0;
    bool   known = image_stat(path, &mtime, &size);

    if (!cache)
        cache = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, image_free);

    BtaImage *have = g_hash_table_lookup(cache, path);
    if (have && known && have->mtime == mtime && have->size == size)
        return have->surface;

    GError     *error   = NULL;
    GdkTexture *texture = gdk_texture_new_from_filename(path, &error);

    if (!texture) {
        JS_ThrowTypeError(ctx, "Image: cannot read %s: %s", path,
                          error ? error->message : "not an image");
        g_clear_error(&error);
        return NULL;
    }

    cairo_surface_t *surface = surface_of_texture(ctx, texture, path);
    g_object_unref(texture);
    if (!surface)
        return NULL;

    if (g_hash_table_size(cache) >= IMAGE_CACHE_MAX)
        g_hash_table_remove_all(cache);

    BtaImage *img = g_new0(BtaImage, 1);
    img->surface = surface;
    img->mtime   = mtime;
    img->size    = size;
    g_hash_table_insert(cache, g_strdup(path), img);
    return surface;
}

static JSValue painter_image(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (argc < 3)
        return JS_ThrowTypeError(ctx,
            "Image expects (path or bytes, x, y, [width], [height])");

    bool   bad = false;
    double x   = arg_num(ctx, argv[1], "Image", &bad);
    double y   = arg_num(ctx, argv[2], "Image", &bad);
    double ww  = (argc > 3 && !JS_IsUndefined(argv[3]))
                     ? arg_num(ctx, argv[3], "Image", &bad) : -1;
    double hh  = (argc > 4 && !JS_IsUndefined(argv[4]))
                     ? arg_num(ctx, argv[4], "Image", &bad) : -1;
    if (bad)
        return JS_EXCEPTION;

    /*
     * A path or the bytes themselves, which is the same picture arriving by the
     * other road: `Http` answers `Bytes` and `File.LoadBytes` reads them, and a
     * drawing that had to write a temporary file to paint a downloaded logo was
     * the gap. The argument decides, because there is nothing to configure: a
     * string is a file and `Bytes` are the image.
     *
     * **Bytes are decoded on every call and the cache is the path's alone.** A
     * path is a stable key with an mtime behind it; bytes are a pointer that can
     * be freed and another allocated at the same address, so a cache keyed on
     * them would eventually paint the wrong picture -- the one failure this is
     * not worth risking. Measured on this machine, a 640x480 PNG decodes in
     * about 1.5 ms, so a report drawing a logo per page pays nothing worth
     * naming; a handler that paints the same bytes sixty times a second wants a
     * `Picture` with `LoadBytes` instead, which decodes once.
     */
    size_t           blen  = 0;
    const char      *path  = NULL;
    cairo_surface_t *img   = NULL;
    cairo_surface_t *owned = NULL;

    if (bta_bytes_get(argv[0], &blen)) {
        char        named[32];
        GdkTexture *texture = bta_texture_from_bytes(ctx, argv[0], "Image");

        if (!texture)
            return JS_EXCEPTION;

        g_snprintf(named, sizeof named, "%zu bytes", blen);
        owned = img = surface_of_texture(ctx, texture, named);
        g_object_unref(texture);
        if (!img)
            return JS_EXCEPTION;
    } else {
        path = JS_ToCString(ctx, argv[0]);
        if (!path)
            return JS_EXCEPTION;

        img = image_surface(ctx, path);
        if (!img) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    double iw = cairo_image_surface_get_width(img);
    double ih = cairo_image_surface_get_height(img);
    if (iw <= 0 || ih <= 0) {
        if (owned) cairo_surface_destroy(owned);
        JS_FreeCString(ctx, path);
        return JS_UNDEFINED;
    }

    /* **One side given scales the other with it.** A logo is placed by its
     * height and its width is whatever the picture is -- asking a caller to
     * work the second number out from the first is asking it to know the file's
     * proportions, which is the one thing it read the file to avoid. */
    double dw = ww > 0 ? ww : (hh > 0 ? iw * (hh / ih) : iw);
    double dh = hh > 0 ? hh : (ww > 0 ? ih * (ww / iw) : ih);

    cairo_save(p->cr);
    cairo_translate(p->cr, x, y);
    cairo_scale(p->cr, dw / iw, dh / ih);
    cairo_set_source_surface(p->cr, img, 0, 0);
    /* `Paint` and not a rectangle and a fill: a fill would run over whatever
     * path the handler had already started, and the source's own extent is
     * what bounds the ink -- outside the picture it is transparent. */
    cairo_pattern_set_filter(cairo_get_source(p->cr), CAIRO_FILTER_GOOD);
    cairo_paint(p->cr);
    cairo_restore(p->cr);

    char nb[NUMLEN], nb2[NUMLEN], nb3[NUMLEN], nb4[NUMLEN], named[32];

    if (!path)
        g_snprintf(named, sizeof named, "%zu bytes", blen);

    /* The dump names the source the caller gave: a file by its path, and bytes
     * by how many -- which is what a test can assert and a person can recognise
     * without the picture. */
    note(p, "Image \"%s\" at (%s,%s) %sx%s", path ? path : named,
         num(nb, x), num(nb2, y), num(nb3, dw), num(nb4, dh));

    if (owned)
        cairo_surface_destroy(owned);
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

/* --------------------------------------------------- Text: what it measures
 *
 * The same two questions `Painter.TextWidth` and `TextHeight` answer, asked
 * where there is no painter -- which is everywhere a layout is *decided* rather
 * than drawn.
 *
 * A painter is valid only inside the `Draw` it came from, and that is not a
 * restriction to be worked around: it wraps a cairo context GTK owns for the
 * length of one frame. But the thing that needs a measurement usually needs it
 * *before* the frame: a report that must answer how many pages it has before a
 * preview has drawn anything, a band that grows to fit its text, a column sized
 * to the widest value in it. Reported by an application that had to declare
 * every band height and hope, and granted here.
 *
 * **The numbers are the ones a `Painter` would give**, which is the whole point
 * of it: the same font map, and the desktop's own resolution off `gtk-xft-dpi`,
 * so a text scale of 125% moves both. `tests/widgets` asserts that equality
 * rather than trusting it.
 */

/* One context and one layout, kept. Building either per call is what makes a
 * measuring API cost more than the drawing it was meant to save -- measured for
 * the painter's own: a layout per call would be most of a chart's text budget. */
static PangoLayout *metrics_layout(void)
{
    static PangoLayout *layout;

    if (!layout) {
        PangoContext *pc =
            pango_font_map_create_context(pango_cairo_font_map_get_default());
        layout = pango_layout_new(pc);
        g_object_unref(pc);
    }

    /* Asked every time rather than once: the text scale can change while the
     * program runs, and a cached resolution would answer for the old one. */
    GtkSettings *settings = gtk_settings_get_default();
    if (settings) {
        int dpi = -1;
        g_object_get(settings, "gtk-xft-dpi", &dpi, NULL);

        PangoContext *pc = pango_layout_get_context(layout);
        if (dpi > 0 && pango_cairo_context_get_resolution(pc) != dpi / 1024.0) {
            pango_cairo_context_set_resolution(pc, dpi / 1024.0);
            /* A layout caches what it worked out from its context, so the
             * context changing under it has to be said out loud or the first
             * measurement after a text-scale change is the old one. */
            pango_layout_context_changed(layout);
        }
    }
    return layout;
}

/*
 * The desktop's UI font, which is what a control draws with unless CSS says
 * otherwise. `""` where there is no display to ask -- a console project -- and
 * there the caller's own font description is the only one that means anything.
 */
static char *metrics_default_font(void)
{
    GtkSettings *settings = gtk_settings_get_default();
    char        *name     = NULL;

    if (settings)
        g_object_get(settings, "gtk-font-name", &name, NULL);
    return name;
}

/* The layout, loaded with the text, the font and the wrap width -- or NULL with
 * an exception pending. `font` and `options` are both optional and either may
 * be undefined. */
static PangoLayout *metrics_prepare(JSContext *ctx, const char *who,
                                    int argc, JSValueConst *argv)
{
    if (argc < 1) {
        JS_ThrowTypeError(ctx, "%s(text, [font], [options]) needs the text", who);
        return NULL;
    }

    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text)
        return NULL;

    char *chosen = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        const char *given = JS_ToCString(ctx, argv[1]);
        if (!given) {
            JS_FreeCString(ctx, text);
            return NULL;
        }
        chosen = g_strdup(given);
        JS_FreeCString(ctx, given);
    }
    if (!chosen || !*chosen) {
        g_free(chosen);
        chosen = metrics_default_font();
    }

    TextOpts o;
    if (!text_opts(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, who, &o)) {
        JS_FreeCString(ctx, text);
        g_free(chosen);
        return NULL;
    }

    PangoLayout *l = metrics_layout();

    if (chosen && *chosen) {
        PangoFontDescription *fd = pango_font_description_from_string(chosen);
        pango_layout_set_font_description(l, fd);
        pango_font_description_free(fd);
    }
    g_free(chosen);

    bool ok = layout_text(ctx, l, text, &o, who);
    JS_FreeCString(ctx, text);
    return ok ? l : NULL;
}

enum { TEXT_WIDTH, TEXT_HEIGHT, TEXT_SIZE, TEXT_LINES };

static JSValue js_text_measure(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv, int magic)
{
    static const char *const NAMES[] = { "Text.Width", "Text.Height",
                                         "Text.Size", "Text.Lines" };

    /*
     * **`Lines` and `Markup` are refused together**, and it is not a gap.
     * The lines of a styled paragraph are runs and not strings: what comes back
     * is the text with the tags already consumed, so drawing them one by one
     * would draw a paragraph that had lost its bold. A caller that reached for
     * this wants `Painter.Text(markup, x, y, { Width, Markup: true })`, which
     * draws the whole block in one call -- broken by the same Pango that
     * measured it.
     */
    if (magic == TEXT_LINES && argc > 2 && JS_IsObject(argv[2])) {
        JSValue m  = JS_GetPropertyStr(ctx, argv[2], "Markup");
        bool    on = !JS_IsUndefined(m) && JS_ToBool(ctx, m);

        JS_FreeValue(ctx, m);
        if (on)
            return JS_ThrowTypeError(ctx, "Text.Lines: markup lays out as one "
                                          "block -- draw it with Painter.Text "
                                          "(text, x, y, { Width, Markup: true })");
    }

    PangoLayout *l = metrics_prepare(ctx, NAMES[magic], argc, argv);
    if (!l)
        return JS_EXCEPTION;

    int width = 0, height = 0;
    pango_layout_get_pixel_size(l, &width, &height);

    if (magic == TEXT_WIDTH)
        return JS_NewInt32(ctx, width);
    if (magic == TEXT_HEIGHT)
        return JS_NewInt32(ctx, height);

    if (magic == TEXT_SIZE) {
        JSValue out = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, out, "Width",  JS_NewInt32(ctx, width));
        JS_SetPropertyStr(ctx, out, "Height", JS_NewInt32(ctx, height));
        JS_SetPropertyStr(ctx, out, "Lines",
                          JS_NewInt32(ctx, pango_layout_get_line_count(l)));
        return out;
    }

    /* The lines themselves, which is what a caller that will *draw* them needs:
     * measuring how many there are and then breaking the text some other way is
     * two answers to one question, and they disagree on the day it matters. */
    const char *laid = pango_layout_get_text(l);
    int         n    = pango_layout_get_line_count(l);
    JSValue     arr  = JS_NewArray(ctx);

    for (int i = 0; i < n; i++) {
        PangoLayoutLine *line = pango_layout_get_line_readonly(l, i);
        JS_SetPropertyUint32(ctx, arr, i,
                             JS_NewStringLen(ctx, laid + line->start_index,
                                             line->length));
    }
    return arr;
}

/* ------------------------------------------------------- where a character is
 *
 * The two questions a *selection* asks, and the two this surface could not
 * answer: **which character is under the pointer**, and **which rectangles
 * cover a range of them**. Everything else a drawn document needs was already
 * here -- it could measure a paragraph and draw it -- and neither of these can
 * be worked out by a caller: the layout knows where the lines broke, which run
 * is in which font, and which way the text is going, and none of that survives
 * being handed back as a list of strings.
 *
 * **The offsets are JS string indices**, not bytes and not code points, because
 * what the caller does with one is `plain.slice(from, to)`. Pango counts bytes,
 * so both directions are converted here rather than in every caller -- and the
 * conversion is UTF-16, so a document with an emoji in it still slices where it
 * was clicked.
 */

/* Byte index into a UTF-8 string -> JS string index. */
static int utf16_of_byte(const char *s, int at)
{
    const char *p   = s;
    const char *end = s + at;
    int         out = 0;

    while (p < end && *p) {
        out += g_utf8_get_char(p) > 0xFFFF ? 2 : 1;
        p = g_utf8_next_char(p);
    }
    return out;
}

/* And back: a JS string index -> byte index, clamped to the string. */
static int byte_of_utf16(const char *s, int at)
{
    const char *p   = s;
    int         out = 0;

    while (*p && out < at) {
        out += g_utf8_get_char(p) > 0xFFFF ? 2 : 1;
        p = g_utf8_next_char(p);
    }
    return (int) (p - s);
}

/* `metrics_prepare` reads (text, font, options); these two carry two numbers in
 * between, so the arguments it wants are handed to it in the order it wants
 * them. A second copy of that function would be a second place for the font
 * defaulting and the markup to drift. */
static PangoLayout *metrics_prepare_at(JSContext *ctx, const char *who,
                                       int argc, JSValueConst *argv)
{
    JSValueConst shifted[3] = {
        argv[0],
        argc > 3 ? argv[3] : JS_UNDEFINED,
        argc > 4 ? argv[4] : JS_UNDEFINED,
    };
    return metrics_prepare(ctx, who, 3, shifted);
}

/*
 * The character at a point, as a JS string index into the text as it was laid
 * out -- the *plain* text, with a markup run's tags already consumed.
 *
 * A point past the end of a line answers the end of that line and a point below
 * the last one answers the end of the text: a drag that leaves the paragraph
 * selects to where it left, which is what every text view does and what a
 * caller cannot do for itself without knowing where the lines are.
 *
 * The trailing half of a character counts as the next one, which is what makes
 * clicking between two letters land between them.
 */
static JSValue js_text_index_at(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    if (argc < 3)
        return JS_ThrowTypeError(ctx, "Text.IndexAt(text, x, y, [font], [options]) "
                                      "needs the text and a point");

    bool   bad = false;
    double x   = arg_num(ctx, argv[1], "Text.IndexAt", &bad);
    double y   = arg_num(ctx, argv[2], "Text.IndexAt", &bad);
    if (bad)
        return JS_EXCEPTION;

    PangoLayout *l = metrics_prepare_at(ctx, "Text.IndexAt", argc, argv);
    if (!l)
        return JS_EXCEPTION;

    const char *laid = pango_layout_get_text(l);

    /* **Above and below the text are the two ends of it**, and that is this
     * call's own answer rather than Pango's: `xy_to_index` clamps a point below
     * the last line onto that line at the given x, so a drag that left the
     * paragraph downwards on the left-hand side selected *backwards*. What a
     * pointer past the bottom means is "and all the rest of this one". */
    int width = 0, height = 0;
    pango_layout_get_pixel_size(l, &width, &height);

    if (y < 0)
        return JS_NewInt32(ctx, 0);
    if (y >= height)
        return JS_NewInt32(ctx, utf16_of_byte(laid, (int) strlen(laid)));

    int index = 0, trailing = 0;
    pango_layout_xy_to_index(l, (int) (x * PANGO_SCALE), (int) (y * PANGO_SCALE),
                             &index, &trailing);

    const char *at   = laid + index;

    for (int i = 0; i < trailing && *at; i++)
        at = g_utf8_next_char(at);

    return JS_NewInt32(ctx, utf16_of_byte(laid, (int) (at - laid)));
}

/*
 * The rectangles that cover the characters `from`..`to` -- one per line the
 * range crosses, and more than one on a line whose text changes direction.
 * This is what a selection is painted with, and it is the reason the range is
 * a pair of offsets rather than a pair of points: the offsets survive a resize
 * and a re-measure, and the rectangles do not.
 */
static JSValue js_text_bounds(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    if (argc < 3)
        return JS_ThrowTypeError(ctx, "Text.Bounds(text, from, to, [font], [options]) "
                                      "needs the text and a range");

    int32_t from = 0, to = 0;
    if (JS_ToInt32(ctx, &from, argv[1]) || JS_ToInt32(ctx, &to, argv[2]))
        return JS_EXCEPTION;

    PangoLayout *l = metrics_prepare_at(ctx, "Text.Bounds", argc, argv);
    if (!l)
        return JS_EXCEPTION;

    if (to < from) { int32_t swap = from; from = to; to = swap; }

    const char *laid  = pango_layout_get_text(l);
    int         start = byte_of_utf16(laid, from < 0 ? 0 : from);
    int         end   = byte_of_utf16(laid, to   < 0 ? 0 : to);

    JSValue out = JS_NewArray(ctx);
    uint32_t n  = 0;

    PangoLayoutIter *iter = pango_layout_get_iter(l);
    do {
        PangoLayoutLine *line = pango_layout_iter_get_line_readonly(iter);
        int y0 = 0, y1 = 0;

        pango_layout_iter_get_line_yrange(iter, &y0, &y1);

        int a = MAX(start, line->start_index);
        int b = MIN(end,   line->start_index + line->length);
        if (a >= b)
            continue;

        int *ranges = NULL, count = 0;
        pango_layout_line_get_x_ranges(line, a, b, &ranges, &count);

        for (int i = 0; i < count; i++) {
            JSValue box = JS_NewObject(ctx);

            JS_SetPropertyStr(ctx, box, "X", JS_NewInt32(ctx, ranges[2 * i] / PANGO_SCALE));
            JS_SetPropertyStr(ctx, box, "Y", JS_NewInt32(ctx, y0 / PANGO_SCALE));
            JS_SetPropertyStr(ctx, box, "Width",
                              JS_NewInt32(ctx, (ranges[2 * i + 1] - ranges[2 * i]) / PANGO_SCALE));
            JS_SetPropertyStr(ctx, box, "Height", JS_NewInt32(ctx, (y1 - y0) / PANGO_SCALE));
            JS_SetPropertyUint32(ctx, out, n++, box);
        }
        g_free(ranges);
    } while (pango_layout_iter_next_line(iter));

    pango_layout_iter_free(iter);
    return out;
}

/*
 * The text as markup that says exactly it: `&`, `<` and `>` are what a document
 * carries and what a tag is made of, and the difference is one call.
 *
 * It is here rather than in the caller for the same reason the measurement is:
 * a library that escapes with three `replace`s of its own is a library whose
 * idea of markup and Pango's agree until they do not, and the failure is a
 * paragraph that throws -- or worse, one that quietly loses a `<` somebody
 * wrote. `lib/markdown` builds every paragraph through this.
 */
static JSValue js_text_escape(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Text.Escape(text) needs the text");

    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s)
        return JS_EXCEPTION;

    char   *out = g_markup_escape_text(s, -1);
    JSValue v   = JS_NewString(ctx, out);

    g_free(out);
    JS_FreeCString(ctx, s);
    return v;
}

/*
 * ---------------------------------------------------------------- lines
 *
 * Two string questions that are not measurements, and that live here because
 * this is where a question about a string with no widget is asked: **which
 * line a search position falls on**, and **the position of a line and a
 * column**.  `Editor` answers both over its own buffer and shares the walk.
 *
 * **The units are the two the runtime has, and they are not the same number.**
 * `LineOf` receives a **JavaScript string index** -- the number `Regex.Index`
 * and `indexOf` give -- while `OffsetAt` receives a column in **characters**,
 * the unit `Column` and `Select` count in.  `bta_line_of_utf16` is the walk
 * that makes the first exact; see it for the emoji that separates them.
 *
 * **Not `Text.Lines`.**  That lays the string out and answers Pango's lines,
 * which wrap at a width and break U+2028; these answer the lines the editor
 * draws, which is the one a `GotoLine` will land on.
 */
static JSValue js_text_line_of(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Text.LineOf(text, index) needs the text "
                                      "and an index");

    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s)
        return JS_EXCEPTION;

    int32_t index = 0;
    if (JS_ToInt32(ctx, &index, argv[1])) {
        JS_FreeCString(ctx, s);
        return JS_EXCEPTION;
    }

    int   line = bta_line_of_utf16(s, index);
    JS_FreeCString(ctx, s);
    return JS_NewInt32(ctx, line);
}

static JSValue js_text_offset_at(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Text.OffsetAt(text, line, [column]) "
                                      "needs the text and a line");

    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s)
        return JS_EXCEPTION;

    int32_t line = 1, column = 1;
    if (JS_ToInt32(ctx, &line, argv[1]) ||
        (argc > 2 && !JS_IsUndefined(argv[2]) &&
         JS_ToInt32(ctx, &column, argv[2]))) {
        JS_FreeCString(ctx, s);
        return JS_EXCEPTION;
    }

    int   at = bta_chars_at_position(s, line, column);
    JS_FreeCString(ctx, s);
    return JS_NewInt32(ctx, at);
}

static JSValue js_text_get_font(JSContext *ctx, JSValueConst this_val)
{
    char   *name = metrics_default_font();
    JSValue out  = JS_NewString(ctx, name ? name : "");

    g_free(name);
    return out;
}

static const JSCFunctionListEntry text_props[] = {
    JS_CFUNC_MAGIC_DEF("Width",  3, js_text_measure, TEXT_WIDTH),
    JS_CFUNC_MAGIC_DEF("Height", 3, js_text_measure, TEXT_HEIGHT),
    JS_CFUNC_MAGIC_DEF("Size",   3, js_text_measure, TEXT_SIZE),
    JS_CFUNC_MAGIC_DEF("Lines",  3, js_text_measure, TEXT_LINES),
    JS_CFUNC_DEF("Escape", 1, js_text_escape),
    JS_CFUNC_DEF("IndexAt", 5, js_text_index_at),
    JS_CFUNC_DEF("Bounds",  5, js_text_bounds),
    JS_CFUNC_DEF("LineOf",  2, js_text_line_of),
    JS_CFUNC_DEF("OffsetAt", 3, js_text_offset_at),
    JS_CGETSET_DEF("Font", js_text_get_font, NULL),
};

void bta_metrics_init(JSContext *ctx, JSValue global)
{
    JSValue text = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, text, text_props, G_N_ELEMENTS(text_props));
    JS_SetPropertyStr(ctx, global, "Text", text);
}

/* ------------------------------------------------------------------ paths */

enum { PATH_MOVE, PATH_LINE, PATH_CLOSE, PATH_FILL, PATH_STROKE, PATH_CLIP };

static JSValue painter_path(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    bool   bad = false;
    double x = 0, y = 0;
    char   nb[NUMLEN], nb2[NUMLEN];

    if (magic == PATH_MOVE || magic == PATH_LINE) {
        const char *where = magic == PATH_MOVE ? "MoveTo" : "LineTo";

        if (argc < 2)
            return JS_ThrowTypeError(ctx, "%s(x, y) expects (x, y)", where);
        x = arg_num(ctx, argv[0], where, &bad);
        y = arg_num(ctx, argv[1], where, &bad);
        if (bad)
            return JS_EXCEPTION;
    }

    switch (magic) {
    case PATH_MOVE:
        cairo_move_to(p->cr, x, y);
        note(p, "MoveTo (%s,%s)", num(nb, x), num(nb2, y));
        break;
    case PATH_LINE:
        cairo_line_to(p->cr, x, y);
        note(p, "LineTo (%s,%s)", num(nb, x), num(nb2, y));
        break;
    case PATH_CLOSE:  cairo_close_path(p->cr);    note(p, "ClosePath");            break;
    case PATH_FILL:   cairo_fill(p->cr);          note(p, "Fill");                 break;
    case PATH_STROKE: cairo_stroke(p->cr);        note(p, "Stroke");               break;
    default:          cairo_clip(p->cr);          note(p, "Clip");                 break;
    }
    return JS_UNDEFINED;
}

static JSValue painter_curve(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (argc < 6)
        return JS_ThrowTypeError(ctx, "CurveTo expects (x1, y1, x2, y2, x, y)");

    bool   bad = false;
    double v[6];
    for (int i = 0; i < 6; i++)
        v[i] = arg_num(ctx, argv[i], "CurveTo", &bad);
    if (bad)
        return JS_EXCEPTION;

    char b[6][NUMLEN];
    cairo_curve_to(p->cr, v[0], v[1], v[2], v[3], v[4], v[5]);
    note(p, "CurveTo (%s,%s) (%s,%s) (%s,%s)",
         num(b[0], v[0]), num(b[1], v[1]), num(b[2], v[2]),
         num(b[3], v[3]), num(b[4], v[4]), num(b[5], v[5]));
    return JS_UNDEFINED;
}

enum { RECT_PATH, RECT_CLIP };

static JSValue painter_rectangle(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (argc < 4)
        return JS_ThrowTypeError(ctx, "expects (x, y, width, height)");

    const char *where = magic == RECT_CLIP ? "ClipRectangle" : "Rectangle";
    bool   bad = false;
    double x = arg_num(ctx, argv[0], where, &bad), y = arg_num(ctx, argv[1], where, &bad);
    double w = arg_num(ctx, argv[2], where, &bad), h = arg_num(ctx, argv[3], where, &bad);
    if (bad)
        return JS_EXCEPTION;

    char b[4][NUMLEN];
    cairo_rectangle(p->cr, x, y, w, h);
    if (magic == RECT_CLIP) {
        cairo_clip(p->cr);
        note(p, "ClipRectangle (%s,%s) %sx%s",
             num(b[0], x), num(b[1], y), num(b[2], w), num(b[3], h));
    } else {
        note(p, "Rectangle (%s,%s) %sx%s",
             num(b[0], x), num(b[1], y), num(b[2], w), num(b[3], h));
    }
    return JS_UNDEFINED;
}

/*
 * `Arc(x, y, radius, from, to)` -- **in degrees**, clockwise, zero at three
 * o'clock.
 *
 * Cairo takes radians and this does not, which is a deliberate translation at
 * the edge: this is a language where a person writes a form, and a pie chart's
 * slice or a gauge's sweep is written in degrees by everybody who is not a
 * graphics library.  `Rotate` says degrees for the same reason, and the two
 * would be a trap if they disagreed.
 */
/*
 * `ArcNegative` is the same arc the other way round, and it exists because a
 * ring cannot be drawn without it.
 *
 * A doughnut's segment is: the inner start, out to the outer radius, the outer
 * arc **forwards**, in to the inner radius, and the inner arc **backwards** to
 * where it began -- one path, closed once, filled once.  With only a forward arc
 * the way back has to be a `MoveTo`, and a `MoveTo` starts a new subpath: the
 * fill then runs the winding rule over two of them and produces wedges through
 * the middle of the chart.  That is not a hypothesis -- it is what the first
 * doughnut in `examples/charts` looked like, and it is why this call is here.
 *
 * Approximating the way back with two dozen `LineTo`s does work and is what a
 * chart would have had to do: twenty-four calls and a visible polygon at any size
 * worth looking at, for something cairo has always been able to do in one.
 */
static JSValue painter_arc(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (argc < 5)
        return JS_ThrowTypeError(ctx, "expects (x, y, radius, from, to) "
                                      "-- the angles in degrees");

    const char *where = magic ? "ArcNegative" : "Arc";
    bool   bad = false;
    double x = arg_num(ctx, argv[0], where, &bad), y  = arg_num(ctx, argv[1], where, &bad);
    double r = arg_num(ctx, argv[2], where, &bad), a1 = arg_num(ctx, argv[3], where, &bad);
    double a2 = arg_num(ctx, argv[4], where, &bad);
    if (bad)
        return JS_EXCEPTION;
    if (!(r >= 0)) {
        char nb[NUMLEN];

        return JS_ThrowRangeError(ctx, "%s: %s is not a radius", where,
                                  g_ascii_formatd(nb, NUMLEN, "%g", r));
    }

    char b[5][NUMLEN];
    if (magic)
        cairo_arc_negative(p->cr, x, y, r, a1 * G_PI / 180.0, a2 * G_PI / 180.0);
    else
        cairo_arc(p->cr, x, y, r, a1 * G_PI / 180.0, a2 * G_PI / 180.0);

    note(p, "%s (%s,%s) r%s %s..%s", magic ? "ArcNegative" : "Arc",
         num(b[0], x), num(b[1], y), num(b[2], r), num(b[3], a1), num(b[4], a2));
    return JS_UNDEFINED;
}

/*
 * `Polyline(points)` and `Polygon(points)`: a flat array, `[x, y, x, y, ...]`.
 *
 * **This is what a batched call is worth, measured.** Filling a JS array costs
 * ~405 ns an element and a two-argument call into C ~465 ns, so one call for two
 * thousand points buys about 2x -- not the hundredfold one expects, because
 * QuickJS is an interpreter and the interpreter is the floor. It is still the
 * right shape for the one thing charts do most, and the honest budget either way
 * is tens of thousands of primitives a frame.
 */
enum { POLY_OPEN, POLY_CLOSED };

static JSValue painter_polyline(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx, "expects a flat array of coordinates "
                                      "[x, y, x, y, ...]");

    JSValue  lenv = JS_GetPropertyStr(ctx, argv[0], "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    if (n % 2)
        return JS_ThrowRangeError(ctx, "a flat array of coordinates has an even "
                                       "length; this one has %u", n);
    if (!n)
        return JS_UNDEFINED;        /* a series with no points draws nothing */

    double first[2] = { 0, 0 }, last[2] = { 0, 0 };
    const char *where = magic == POLY_OPEN ? "Polyline" : "Polygon";

    for (uint32_t i = 0; i < n; i += 2) {
        JSValue xv = JS_GetPropertyUint32(ctx, argv[0], i);
        JSValue yv = JS_GetPropertyUint32(ctx, argv[0], i + 1);
        bool    bad = false;
        double  x = arg_num(ctx, xv, where, &bad), y = arg_num(ctx, yv, where, &bad);

        JS_FreeValue(ctx, xv);
        JS_FreeValue(ctx, yv);
        if (bad)
            return JS_EXCEPTION;

        if (i == 0) { cairo_move_to(p->cr, x, y); first[0] = x; first[1] = y; }
        else          cairo_line_to(p->cr, x, y);
        last[0] = x; last[1] = y;
    }
    if (magic == POLY_CLOSED)
        cairo_close_path(p->cr);

    char b[4][NUMLEN];

    note(p, "%s %u points (%s,%s)..(%s,%s)",
         magic == POLY_CLOSED ? "Polygon" : "Polyline", n / 2,
         num(b[0], first[0]), num(b[1], first[1]),
         num(b[2], last[0]),  num(b[3], last[1]));
    return JS_UNDEFINED;
}

/* --------------------------------------------------------------- the state
 *
 * `Push()` and `Pop()`, which are `cairo_save`/`cairo_restore` under names that
 * do not collide: `Save` in this language writes a file -- `File.Save`, and
 * `DrawingArea.Save` two screens down -- and a `Save` that pushes a clip onto a
 * stack would be the third meaning of the word in one API.
 */
enum { STATE_PUSH, STATE_POP };

static JSValue painter_state(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    if (magic == STATE_PUSH) { cairo_save(p->cr);    note(p, "Push"); }
    else                     { cairo_restore(p->cr); note(p, "Pop");  }
    return JS_UNDEFINED;
}

enum { XFORM_TRANSLATE, XFORM_SCALE, XFORM_ROTATE };

static JSValue painter_transform(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv, int magic)
{
    BtaPainter *p = painter_of(ctx, this_val);
    if (!p)
        return JS_EXCEPTION;

    const char *where = magic == XFORM_TRANSLATE ? "Translate"
                      : magic == XFORM_SCALE     ? "Scale" : "Rotate";
    bool   bad = false;
    double a   = argc > 0 ? arg_num(ctx, argv[0], where, &bad) : 0;
    double b   = argc > 1 ? arg_num(ctx, argv[1], where, &bad) : a;
    char   nb[NUMLEN], nb2[NUMLEN];

    if (bad)
        return JS_EXCEPTION;

    switch (magic) {
    case XFORM_TRANSLATE:
        cairo_translate(p->cr, a, b);
        note(p, "Translate (%s,%s)", num(nb, a), num(nb2, b));
        break;
    case XFORM_SCALE:
        cairo_scale(p->cr, a, b);
        note(p, "Scale (%s,%s)", num(nb, a), num(nb2, b));
        break;
    default:
        /* Degrees, like Arc. */
        cairo_rotate(p->cr, a * G_PI / 180.0);
        note(p, "Rotate %s", num(nb, a));
        break;
    }
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry painter_props[] = {
    JS_CGETSET_DEF("Color",      painter_get_color,      painter_set_color),
    JS_CGETSET_DEF("LineDash",   painter_get_dash,       painter_set_dash),
    JS_CGETSET_DEF("LineCap",    painter_get_cap,        painter_set_cap),
    JS_CGETSET_DEF("LineJoin",   painter_get_join,       painter_set_join),
    JS_CGETSET_DEF("Font",       painter_get_font,       painter_set_font),
    JS_CGETSET_DEF("Foreground", painter_get_foreground, NULL),
    JS_CGETSET_DEF("Dark",       painter_get_dark,       NULL),
    JS_CGETSET_MAGIC_DEF("LineWidth", painter_get_pen, painter_set_pen, PEN_WIDTH),
    JS_CGETSET_MAGIC_DEF("Antialias", painter_get_pen, painter_set_pen, PEN_ANTIALIAS),
    JS_CFUNC_MAGIC_DEF("MoveTo",    2, painter_path, PATH_MOVE),
    JS_CFUNC_MAGIC_DEF("LineTo",    2, painter_path, PATH_LINE),
    JS_CFUNC_MAGIC_DEF("ClosePath", 0, painter_path, PATH_CLOSE),
    JS_CFUNC_MAGIC_DEF("Fill",      0, painter_path, PATH_FILL),
    JS_CFUNC_MAGIC_DEF("Stroke",    0, painter_path, PATH_STROKE),
    JS_CFUNC_MAGIC_DEF("Clip",      0, painter_path, PATH_CLIP),
    JS_CFUNC_DEF("CurveTo", 6, painter_curve),
    JS_CFUNC_MAGIC_DEF("Rectangle",     4, painter_rectangle, RECT_PATH),
    JS_CFUNC_MAGIC_DEF("ClipRectangle", 4, painter_rectangle, RECT_CLIP),
    JS_CFUNC_MAGIC_DEF("Arc",         5, painter_arc, 0),
    JS_CFUNC_MAGIC_DEF("ArcNegative", 5, painter_arc, 1),
    JS_CFUNC_MAGIC_DEF("Polyline", 1, painter_polyline, POLY_OPEN),
    JS_CFUNC_MAGIC_DEF("Polygon",  1, painter_polyline, POLY_CLOSED),
    JS_CFUNC_DEF("Text", 4, painter_text),
    JS_CFUNC_DEF("Image", 5, painter_image),
    JS_CFUNC_MAGIC_DEF("TextWidth",  2, painter_measure_js, MEASURE_WIDTH),
    JS_CFUNC_MAGIC_DEF("TextHeight", 2, painter_measure_js, MEASURE_HEIGHT),
    JS_CFUNC_MAGIC_DEF("Push", 0, painter_state, STATE_PUSH),
    JS_CFUNC_MAGIC_DEF("Pop",  0, painter_state, STATE_POP),
    JS_CFUNC_MAGIC_DEF("Translate", 2, painter_transform, XFORM_TRANSLATE),
    JS_CFUNC_MAGIC_DEF("Scale",     2, painter_transform, XFORM_SCALE),
    JS_CFUNC_MAGIC_DEF("Rotate",    1, painter_transform, XFORM_ROTATE),
};

/* A painter comes from a `Draw`, and there is nothing a constructor could make:
 * the object is a cairo context with names, and only the surface has one. The
 * class is global anyway, so `p instanceof Painter` answers. */
static JSValue painter_construct(JSContext *ctx, JSValueConst new_target,
                                 int argc, JSValueConst *argv)
{
    return JS_ThrowTypeError(ctx, "a Painter cannot be constructed: it is what a "
                                  "DrawingArea's Draw event hands you");
}

void bta_painter_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_painter_class_id);
    JS_NewClass(rt, bta_painter_class_id, &painter_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, painter_props,
                               G_N_ELEMENTS(painter_props));
    JS_SetClassProto(ctx, bta_painter_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, painter_construct, "Painter", 0,
                                    JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Painter", ctor);
}

/* ------------------------------------------------------------ DrawingArea */

/*
 * The painter lives on the widget's own struct, beside the other five notes the
 * runtime keeps about a widget.
 *
 * It used to be an own property of the wrapper called `__painter`, not
 * enumerable, the way `__children` was not. **It is the latest-created of the
 * six**: a drawing area gets one on the first frame it paints, which is later
 * than anything else here and later than any moment a loader could be said to
 * have finished -- so it is the note that decides the answer to *when is a
 * widget built*. See `docs/plans/strict-plan.md`.
 */
static JSValue area_painter(JSContext *ctx, BtaWidget *w, BtaPainter **out)
{
    JSValue held = *bta_widget_note(w, BTA_NOTE_PAINTER);

    if (JS_IsObject(held)) {
        *out = JS_GetOpaque(held, bta_painter_class_id);
        return JS_DupValue(ctx, held);
    }

    JSValue proto = JS_GetClassProto(ctx, bta_painter_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bta_painter_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;

    BtaPainter *p = g_new0(BtaPainter, 1);
    p->w    = w;
    p->dump = g_string_new(NULL);
    JS_SetOpaque(obj, p);

    JSValue *slot = bta_widget_note(w, BTA_NOTE_PAINTER);
    JS_FreeValue(ctx, *slot);
    *slot = JS_DupValue(ctx, obj);

    *out = p;
    return obj;
}

/*
 * One frame, whoever opened it: the on-screen draw function and `Save()` both
 * come through here, which is what makes the file a test harness for the screen.
 *
 * **A painter arrives with the theme's ink**, a line one wide and no dashes, so
 * a handler that draws without setting anything is visible on a light desktop and
 * on a dark one.  Cairo's own default is opaque black, which is invisible on
 * half the desktops there are.
 */
/* False when it threw instead of drawing, which only `Save` can act on: the
 * on-screen draw function has nobody to return to. */
/*
 * One frame of the handler, against whatever surface it was handed.
 *
 * **`page` is which sheet of paper this is, and 0 means the screen.** A frame
 * on paper raises `DrawPage(painter, page, width, height)` -- the page arrives
 * as an argument, which is the whole reason the event exists: it used to travel
 * through a field of the form, written by a `before` callback and read back in
 * `Draw`, and two callbacks talking through `this` was the only place in this
 * runtime where that was the arrangement.
 *
 * A form that declared no `DrawPage` gets `Draw`, which is the right answer for
 * a drawing that is one page and the reason nothing had to change when this
 * arrived. `bta_has_handler` is asked and not guessed, because "the form did
 * not declare it" and "the form declared it and it does nothing" are different
 * statements and only the first may fall back.
 */
static bool paint_frame_page(BtaWidget *w, cairo_t *cr, int width, int height,
                             int page)
{
    JSContext  *ctx = w->ctx;
    BtaPainter *p   = NULL;
    JSValue     obj = area_painter(ctx, w, &p);

    if (JS_IsException(obj) || !p) {
        JS_FreeValue(ctx, obj);
        return false;
    }

    /*
     * **One frame at a time, because there is one painter.** `Save()` runs a
     * frame of its own, so calling it from inside a `Draw` would hand the
     * handler's own painter a second context and take it away again on the way
     * out -- leaving the outer frame's remaining calls refusing with "the frame
     * is over", which is true and unhelpful. Refused here, where the reason can
     * be said.
     */
    if (p->cr) {
        JS_FreeValue(ctx, obj);
        JS_ThrowTypeError(ctx, "Save: a frame is already being drawn -- a Draw "
                               "handler cannot ask for another one");
        return false;
    }

    p->cr     = cr;
    p->width  = width;
    p->height = height;
    g_string_truncate(p->dump, 0);
    g_free(p->color);
    p->color = NULL;

    GdkRGBA ink;
    painter_ink(p, &ink);
    cairo_set_source_rgba(cr, ink.red, ink.green, ink.blue, ink.alpha);
    cairo_set_line_width(cr, 1);

    bool onpaper = page >= 1 && bta_has_handler(w, "DrawPage");
    bool ok;

    if (onpaper) {
        JSValueConst argv[4] = { obj, JS_NewInt32(ctx, page),
                                 JS_NewInt32(ctx, width), JS_NewInt32(ctx, height) };
        ok = bta_emit_ok(w, "DrawPage", 4, argv);
    } else {
        JSValueConst argv[3] = { obj, JS_NewInt32(ctx, width),
                                 JS_NewInt32(ctx, height) };
        ok = bta_emit_ok(w, "Draw", 3, argv);
    }

    /* The frame is over: every call on this painter refuses from here on. */
    p->cr = NULL;
    JS_FreeValue(ctx, obj);

    /* The handler's own error has been reported already and consumed; what an
     * exporter needs is something to fail *with*, and the on-screen draw
     * function throws this away -- see `on_draw`. */
    if (!ok)
        JS_ThrowInternalError(ctx, "the %s handler threw: nothing was drawn "
                                   "past the error above",
                              onpaper ? "DrawPage" : "Draw");
    return ok;
}

/*
 * **Does this control draw at all?**
 *
 * `Printer` takes a control and runs its handler, and every widget has a
 * painter note it could be asked for -- so without this a `Button` handed to
 * `Printer.ToFile` came back with a one-page PDF of nothing, reported as a
 * document that was written. Accepting something and producing an empty answer
 * is the failure this runtime refuses everywhere else.
 *
 * The question is GTK's own, because that is what the class is made of: the
 * `Canvas` of a `Report` or a `Markdown` is a `DrawingArea` and passes, and the
 * component wrapping it is not one and does not -- which is right, since the
 * component has no `Draw` of its own to run.
 */
bool bta_paint_draws(BtaWidget *w)
{
    return w && w->gtk && GTK_IS_DRAWING_AREA(w->gtk);
}

/*
 * **Is a frame being drawn right now?**  There is one painter per control, so a
 * verb that runs a frame of its own cannot be called from inside one -- and the
 * useful moment to say so is before the print dialog is on the screen rather
 * than one page after it. `Printer` asks this; `paint_frame_page` refuses it
 * again underneath, which is where a frame started by anything else would be
 * caught.
 */
bool bta_paint_busy(JSContext *ctx, BtaWidget *w)
{
    BtaPainter *live = NULL;
    JSValue     held = area_painter(ctx, w, &live);

    JS_FreeValue(ctx, held);
    return live && live->cr;
}

/* The screen's frame, and every export that is not paginated: one page, and the
 * handler is `Draw`. */
static bool paint_frame(BtaWidget *w, cairo_t *cr, int width, int height)
{
    return paint_frame_page(w, cr, width, height, 0);
}

/* What `Printer` runs, from bta_printer.c: one sheet, numbered. */
bool bta_paint_page(BtaWidget *w, cairo_t *cr, int width, int height, int page)
{
    return paint_frame_page(w, cr, width, height, page);
}

static void on_draw(GtkDrawingArea *area, cairo_t *cr, int width, int height,
                    gpointer user_data)
{
    BtaWidget *w = (BtaWidget *)user_data;

    /* Nothing to hand a failure to: the handler's throw has already been
     * reported, the same as every other event. **But the exception `paint_frame`
     * leaves for an exporter has to go**, or it is still pending the next time
     * anything calls into JS and surfaces there, half a program away from the
     * frame that made it. */
    if (!paint_frame(w, cr, width, height))
        JS_FreeValue(w->ctx, JS_GetException(w->ctx));
}

static void build_drawing_area(BtaWidget *w)
{
    w->gtk = gtk_drawing_area_new();
    gtk_drawing_area_set_draw_func(GTK_DRAWING_AREA(w->gtk), on_draw, w, NULL);
}

/* "The drawing may have changed": ask again.  `Redraw` and not `Invalidate`,
 * because what one wants is the verb and not GTK's word for the cache -- the
 * same call `RowList.Refilter` is. */
static JSValue area_redraw(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    gtk_widget_queue_draw(w->gtk);
    return JS_UNDEFINED;
}

/*
 * `Dump()`: the last frame as text, one call per line.
 *
 * The same answer `Widget.Dump()` gives about a tree, for the same reason -- a
 * picture proves nothing twice and cannot be diffed.  This is what
 * `tests/widgets` asserts a drawing with: that a bar chart with three values
 * draws three rectangles, that the grid is dashed, that a series with no points
 * draws nothing at all.
 *
 * Empty until something has been drawn, which is a fact and not an error: a
 * surface that has never had a frame has nothing to say.
 */
static JSValue area_dump(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue     held = *bta_widget_note(w, BTA_NOTE_PAINTER);
    BtaPainter *p    = JS_IsObject(held)
                           ? JS_GetOpaque(held, bta_painter_class_id) : NULL;

    return JS_NewString(ctx, p && p->dump ? p->dump->str : "");
}

/*
 * `Save(path, [width], [height])`: the same `Draw`, against an image surface.
 *
 * Two things at once, which is why it is in the first version rather than the
 * fourth: a chart in a report or an attachment is what people ask for, and a
 * frame that can be rendered without a screen is what makes the whole feature
 * testable -- the suite calls this and then asserts what was drawn, with no
 * waiting for GTK to decide to paint.
 *
 * Without a size it uses the widget's own, and a surface that has never been
 * allocated has none, so a size is required then rather than guessed at.
 */
/*
 * One frame, drawn into an image surface of the size asked for.
 *
 * The whole of `Save` except what becomes of the pixels, because `ToPng` wants
 * exactly the same frame and none of the file: the size defaulting to the
 * widget's, the two refusals, and the rule that **a frame whose handler threw is
 * not an answer** -- a picture of whatever had been drawn before the throw,
 * reported as a success, is the bug that made `bta_emit_ok` exist.
 *
 * `who` names the caller in the complaints, and the size arguments are read
 * from `argv + at` so the two verbs can take them in the places they take them.
 */
static cairo_surface_t *area_frame(JSContext *ctx, BtaWidget *w, const char *who,
                                   int argc, JSValueConst *argv, int at)
{
    int32_t width  = gtk_widget_get_width(w->gtk);
    int32_t height = gtk_widget_get_height(w->gtk);

    if (argc > at && !JS_IsUndefined(argv[at]) && JS_ToInt32(ctx, &width, argv[at]))
        return NULL;
    if (argc > at + 1 && !JS_IsUndefined(argv[at + 1]) &&
        JS_ToInt32(ctx, &height, argv[at + 1]))
        return NULL;

    if (width <= 0 || height <= 0) {
        JS_ThrowRangeError(ctx, "%s: %dx%d is not a size -- a surface that has "
                                "not been drawn yet has none, so pass one",
                           who, width, height);
        return NULL;
    }
    /* Refused rather than attempted: cairo's own ceiling is 32767 a side, and a
     * transposed digit would otherwise ask the allocator for gigabytes before
     * failing. 16384 square is a 1 GB surface, which is already past anything a
     * chart in a report is. */
    if (width > 16384 || height > 16384) {
        JS_ThrowRangeError(ctx, "%s: %dx%d is too big to draw (16384 a side)",
                           who, width, height);
        return NULL;
    }

    cairo_surface_t *surface =
        cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
    cairo_t *cr = cairo_create(surface);

    bool drawn = paint_frame(w, cr, width, height);

    cairo_destroy(cr);
    cairo_surface_flush(surface);

    if (!drawn) {
        cairo_surface_destroy(surface);
        return NULL;        /* the handler's exception is the one to report */
    }
    return surface;
}

static JSValue area_save(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Save expects (path, [width], [height])");

    const char *path = bta_file_path(ctx, argv[0], "Save");
    if (!path)
        return JS_EXCEPTION;

    cairo_surface_t *surface = area_frame(ctx, w, "Save", argc, argv, 1);
    if (!surface) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    cairo_status_t status = cairo_surface_write_to_png(surface, path);
    cairo_surface_destroy(surface);

    if (status != CAIRO_STATUS_SUCCESS) {
        JSValue e = JS_ThrowInternalError(ctx, "Save: cannot write '%s': %s",
                                          path, cairo_status_to_string(status));
        JS_FreeCString(ctx, path);
        return e;
    }
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

/* Where `ToPng` puts the bytes cairo hands it, one chunk at a time. */
static cairo_status_t png_chunk(void *closure, const unsigned char *data,
                                unsigned int length)
{
    g_byte_array_append(closure, data, length);
    return CAIRO_STATUS_SUCCESS;
}

/*
 * `ToPng([width], [height])`: the same frame as `Save`, as `Bytes`.
 *
 * The other half of the circle this runtime had open. `Http` answers `Bytes`,
 * `File.LoadBytes` reads them and `File.SaveBytes` writes them, and the only way
 * out of a drawing was a file name -- so a chart that had to be *posted*, mailed
 * or put in a reply was a temporary file written and deleted around the one call
 * that mattered. `LoadBytes` on a `Picture` is the way in; this is the way out.
 *
 * `To`-something is what this tree already calls "the same thing in another
 * form" (`Bytes.ToText`, `ToBase64`, `ToHex`), and PNG is in the name because it
 * is a decision and not an implementation detail: it is lossless, it keeps the
 * alpha a drawing has, and every reader takes it.
 */
static JSValue area_to_png(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    cairo_surface_t *surface = area_frame(ctx, w, "ToPng", argc, argv, 0);
    if (!surface)
        return JS_EXCEPTION;

    GByteArray    *out    = g_byte_array_new();
    cairo_status_t status = cairo_surface_write_to_png_stream(surface, png_chunk, out);

    cairo_surface_destroy(surface);

    if (status != CAIRO_STATUS_SUCCESS) {
        g_byte_array_unref(out);
        return JS_ThrowInternalError(ctx, "ToPng: %s",
                                     cairo_status_to_string(status));
    }

    JSValue bytes = bta_bytes_new(ctx, out->data, out->len);
    g_byte_array_unref(out);
    return bytes;
}

/*
 * `SavePdf(path, width, height, [pages], [before])`: the same `Draw`, once per
 * page, into one file.
 *
 * `Save` writes **one** frame as a PNG, and a document is not one frame. A
 * report knows it has fourteen pages before it draws any of them, and what it
 * wants is to leave the application as fourteen pages of one file rather than as
 * fourteen files somebody has to keep together. The paper half of the same wish
 * -- a print dialog, a printer, copies -- is `Printer`, in bta_printer.c, over
 * these same frames.
 *
 * **The size is in points, 72 to the inch**, because that is what a PDF page is:
 * A4 is 595x842 and Letter 612x792, and the handler is told those numbers as its
 * frame size, so a drawing that fits its frame fits the paper with nothing to
 * convert. It is a vector surface, so the text in the file is text and the lines
 * are lines -- the same `Draw` that rasterises to a PNG.
 *
 * **`before` is how the handler knows which page it is drawing.** The `Draw`
 * event's three arguments are documented and asserted, and growing a fourth for
 * this would change every handler's signature; a callback run before each page,
 * with the page number, is the same information without touching the event. It
 * is what `Report.SavePdf` uses to move its own page along.
 */
static JSValue area_save_pdf(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 3)
        return JS_ThrowTypeError(ctx, "SavePdf expects "
                                      "(path, width, height, [pages], [before])");

    const char *path = bta_file_path(ctx, argv[0], "SavePdf");
    if (!path)
        return JS_EXCEPTION;

    int32_t width = 0, height = 0, pages = 1;
    if (JS_ToInt32(ctx, &width, argv[1]) || JS_ToInt32(ctx, &height, argv[2]) ||
        (argc > 3 && !JS_IsUndefined(argv[3]) && JS_ToInt32(ctx, &pages, argv[3]))) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    JSValueConst before = argc > 4 ? argv[4] : JS_UNDEFINED;
    if (!JS_IsUndefined(before) && !JS_IsNull(before) && !JS_IsFunction(ctx, before)) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "SavePdf: `before` is a function called with "
                                      "the page number, or nothing");
    }

    if (width <= 0 || height <= 0) {
        JSValue e = JS_ThrowRangeError(ctx, "SavePdf: %dx%d is not a page -- the "
                                            "size is in points, 72 to the inch "
                                            "(A4 is 595x842)", width, height);
        JS_FreeCString(ctx, path);
        return e;
    }
    /* PDF's own ceiling is 200 inches a side, and cairo silently clamps past
     * it -- a document that came out the wrong size with no error is worse than
     * one that was refused. */
    if (width > 14400 || height > 14400) {
        JSValue e = JS_ThrowRangeError(ctx, "SavePdf: %dx%d points is past PDF's "
                                            "200 inches a side", width, height);
        JS_FreeCString(ctx, path);
        return e;
    }
    if (pages < 1 || pages > 10000) {
        JSValue e = JS_ThrowRangeError(ctx, "SavePdf: %d pages is not a document "
                                            "(1 to 10000)", pages);
        JS_FreeCString(ctx, path);
        return e;
    }

    cairo_surface_t *surface = cairo_pdf_surface_create(path, width, height);
    cairo_status_t   status  = cairo_surface_status(surface);

    if (status != CAIRO_STATUS_SUCCESS) {
        JSValue e = JS_ThrowInternalError(ctx, "SavePdf: cannot write '%s': %s",
                                          path, cairo_status_to_string(status));
        cairo_surface_destroy(surface);
        JS_FreeCString(ctx, path);
        return e;
    }

    cairo_t *cr = cairo_create(surface);
    bool     ok = true;

    for (int32_t page = 1; page <= pages && ok; page++) {
        if (JS_IsFunction(ctx, before)) {
            JSValueConst args[1] = { JS_NewInt32(ctx, page) };
            JSValue      r       = JS_Call(ctx, before, JS_UNDEFINED, 1, args);

            ok = !JS_IsException(r);
            JS_FreeValue(ctx, r);
        }
        if (ok)
            ok = paint_frame_page(w, cr, width, height, page);
        if (ok)
            cairo_show_page(cr);
    }

    cairo_destroy(cr);
    cairo_surface_finish(surface);
    if (status == CAIRO_STATUS_SUCCESS)
        status = cairo_surface_status(surface);
    cairo_surface_destroy(surface);

    /*
     * A page that threw is not a document. Cairo has already written part of
     * the file by then -- it streams as it goes -- so the half of it that exists
     * is removed rather than left looking like an export that worked, which is
     * the same bargain `Save` makes about a PNG it did not finish.
     */
    if (!ok) {
        g_unlink(path);
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    if (status != CAIRO_STATUS_SUCCESS) {
        JSValue e = JS_ThrowInternalError(ctx, "SavePdf: cannot write '%s': %s",
                                          path, cairo_status_to_string(status));
        JS_FreeCString(ctx, path);
        return e;
    }

    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry area_props[] = {
    /* Redraw() */
    JS_CFUNC_DEF("Redraw", 0, area_redraw),
    /* Dump() */
    JS_CFUNC_DEF("Dump",   0, area_dump),
    /* Save(path, [width], [height]) */
    JS_CFUNC_DEF("Save",    3, area_save),
    /* ToPng([width], [height]) */
    JS_CFUNC_DEF("ToPng",   2, area_to_png),
    /* SavePdf(path, width, height, [pages], [before]) */
    JS_CFUNC_DEF("SavePdf", 5, area_save_pdf),
};

void bta_paint_register(void)
{
    const BtaClass rows[] = {
        /*
         * No `texts`: a drawing has no prose of its own -- what it puts on the
         * screen came from the handler, and whatever prose that handler drew was
         * already translated where it was written.
         */
        /* Draw(painter, width, height) */
        /* DrawPage(painter, page, width, height) */
        /* Paginate(width, height) */
        BTA_CLASS("DrawingArea", "Control", build_drawing_area, area_props, false,
                  "Draw,DrawPage,Paginate"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
