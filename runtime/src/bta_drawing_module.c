/*
 * The drawing module's entry: the document half of `bta_paint.c` and
 * `bta_bitmap.c`, built as a loadable object so the core can leave cairo,
 * Pango and GdkPixbuf out of its link.
 *
 * This is **not** the public plugin ABI in `bta_plugin.h`: that contract hands
 * a plugin values and functions and nothing else, which is right for TagLib and
 * wrong for `Painter`, whose methods, properties and class identity are the
 * runtime's own. A module shares the runtime's headers and resolves its
 * symbols from the executable (`--export-dynamic`); it is rebuilt with the
 * runtime, and the version below is what refuses a mismatch.
 *
 * The core loads it when it boots a project, not for `--version` or `check`.
 */
#include "bta.h"

/* Move it when the surface below changes incompatibly. */
#define BTA_DRAWING_MODULE_ABI 1

int bta_drawing_module_abi(void)
{
    return BTA_DRAWING_MODULE_ABI;
}

bool bta_drawing_module_init(JSContext *ctx, JSValue global)
{
    bta_bitmap_init(ctx, global);
    bta_painter_init(ctx, global);
    bta_metrics_init(ctx, global);
    bta_drawing_init(ctx, global);
    return true;
}
