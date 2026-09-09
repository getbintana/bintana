/*
 * What cairo itself costs at chart sizes, and where the cost actually is.
 *
 * Not a test and not part of the build. Kept because of what it measured, which
 * decided two things, written up in [widgets.md](../../docs/widgets.md): that
 * `Painter` needs an `Antialias` property, and that the chart library has to
 * decimate rather than trust the point count.
 *
 *   cc -O2 -o /tmp/cairo-cost tests/manual/cairo-cost.c \
 *      $(pkg-config --cflags --libs cairo glib-2.0) -lm
 *   /tmp/cairo-cost
 *
 * On this machine, 800x400, twenty repetitions each:
 *
 *   200 points, smooth, antialiased          0.42 ms
 *   500 points                               0.61 ms
 *   2000 points                              1.17 ms
 *   5000 points                              2.15 ms
 *   5000 points, jagged                    109.40 ms   <--
 *   5000 points, jagged, no antialias        7.81 ms
 *   5000 points, smooth, width 1, no aa      0.81 ms
 *   20000 points, smooth                     8.33 ms
 *
 * **The cost is in pixels covered, not in points.** The same five thousand
 * points cost 2 ms as a line one can read and 109 ms as a line crossing the full
 * height on every segment -- because the antialiasing rasteriser pays per covered
 * pixel. Fifty times, at the same point count, from the same API calls. Which is
 * also why the jagged one is noise on the screen: five thousand points over eight
 * hundred pixels is six per column, and nobody reads that.
 *
 * So a chart that draws every point it was handed is not slow because of the
 * binding or the interpreter -- those are measured in the plan and they are tens
 * of thousands of primitives a frame. It is slow because it asked cairo to paint
 * the same column of pixels six times over.
 */
#include <cairo.h>
#include <stdio.h>
#include <math.h>
#include <glib.h>
static double ms(gint64 a, gint64 b) { return (b - a) / 1000.0; }

static void run(cairo_t *cr, const char *name, int n, int W, int H,
                int jagged, cairo_antialias_t aa, double lw)
{
    const int REP = 20;
    cairo_set_antialias(cr, aa);
    cairo_set_line_width(cr, lw);
    gint64 t0 = g_get_monotonic_time();
    for (int r = 0; r < REP; r++) {
        cairo_new_path(cr);
        for (int i = 0; i < n; i++) {
            double x = (double)i * W / n;
            double y = jagged ? H / 2 + (H / 2 - 4) * sin(i * 2.3) * cos(i * 7.7)
                              : H / 2 + (H / 2 - 4) * sin(i * 6.283 / n * 3);
            if (i == 0) cairo_move_to(cr, x, y); else cairo_line_to(cr, x, y);
        }
        cairo_stroke(cr);
    }
    printf("%-46s %6.2f ms\n", name, ms(t0, g_get_monotonic_time()) / REP);
}

int main(void)
{
    const int W = 800, H = 400;
    cairo_surface_t *s = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, W, H);
    cairo_t *cr = cairo_create(s);

    run(cr, "200 puntos, suave, antialias",        200,  W, H, 0, CAIRO_ANTIALIAS_DEFAULT, 1.5);
    run(cr, "500 puntos, suave, antialias",        500,  W, H, 0, CAIRO_ANTIALIAS_DEFAULT, 1.5);
    run(cr, "2000 puntos, suave, antialias",       2000, W, H, 0, CAIRO_ANTIALIAS_DEFAULT, 1.5);
    run(cr, "5000 puntos, suave, antialias",       5000, W, H, 0, CAIRO_ANTIALIAS_DEFAULT, 1.5);
    run(cr, "5000 puntos, en zigzag, antialias",   5000, W, H, 1, CAIRO_ANTIALIAS_DEFAULT, 1.5);
    run(cr, "5000 puntos, en zigzag, sin antialias",5000,W, H, 1, CAIRO_ANTIALIAS_NONE, 1.5);
    run(cr, "5000 puntos, suave, ancho 1, sin aa", 5000, W, H, 0, CAIRO_ANTIALIAS_NONE, 1.0);
    run(cr, "20000 puntos, suave, antialias",     20000, W, H, 0, CAIRO_ANTIALIAS_DEFAULT, 1.5);

    cairo_destroy(cr);
    cairo_surface_destroy(s);
    return 0;
}
