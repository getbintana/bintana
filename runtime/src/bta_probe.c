/*
 * Probe -- what a file *is*, asked without building anything.
 *
 *     Probe.Image(path)     // { Width, Height } in pixels
 *     Probe.Audio(path)     // { Title, Artist, Album, Length }  (not yet)
 *
 * ## The name
 *
 * It is the one the tools that do this already use: `ffprobe`, `exiftool`,
 * ImageMagick's `identify`. A probe reads the **header** and says what the thing
 * is -- its dimensions, its format, its tags -- **without decoding it**. That
 * last half is the whole of what separates this from `Picture` and from
 * `Painter.Image`, and it is why the questions live on a namespace of their own
 * instead of on `File`:
 *
 * - **`File` is for working *on* a file.** `Load`, `Save`, `Info`, `Hash`,
 *   `Watch`. Adding `File.ImageSize` would put a question about a *picture* into
 *   the object that moves bytes around, and the day the same namespace grew a
 *   `Probe.Audio` the name would have nothing to do with either.
 * - **`File.Info` already answers `Type`**, as a MIME type. A second answer for
 *   the same word under another owner is how a vocabulary stops meaning one
 *   thing -- the `AddNode` shape, and the reason `Remove` had to be renamed on
 *   six controls.
 * - **`Info` was the other candidate and is refused for that reason**: two
 *   answers for one word, one of which is already written down.
 *
 * `Meta` was considered too, and it is the standard term for a media file's
 * descriptive data -- but in a runtime that has `Record` and `Field`, a bare
 * `Meta` already means "the data of a row", which is the ambiguity this is
 * trying to avoid.
 *
 * ## Why the measurements are not on a widget
 *
 * Both callers that wanted a picture's size wanted it **before anything was
 * drawn**, and one of them wanted it in a console program:
 *
 * - a report that lays a logo out beside its title has to know the logo's width
 *   at a given height while it is still *measuring* the bands -- which happens
 *   in `Form_Open`, before the canvas has a frame;
 * - a `main` project never initialises GTK and **cannot make a widget at all**,
 *   so the workaround -- build a `Picture`, never show it, read `SourceWidth`,
 *   and store the ratio in the template -- was not available there either.
 *
 * So `Text.Size` is the model rather than `Picture.SourceWidth`: a measurement
 * that needs no frame and no display, which is what lets `lib/report` lay out
 * wrapped text in a console test.
 *
 * ## What it agrees with, and what it does not widen
 *
 * **`Picture.File` and `Probe.Image` read the same set of files**, because
 * GdkPixbuf's `gdk_pixbuf_get_file_info` is the header reader and
 * `gdk_texture_new_from_filename` -- what a `Picture` decodes with -- is built
 * on the same loaders. So a caller told `null` can be sure a `Picture` would not
 * have shown it either, and the reverse holds too.
 *
 * **Which formats that is belongs to the machine, not to this file.** An SVG
 * was written down here as `null` and measured otherwise: on Fedora 44 GdkPixbuf
 * reads through glycin, which has an SVG loader, and both this and `Picture`
 * answer `{ Width: 300, Height: 100 }` for a `viewBox="0 0 300 100"` -- the
 * size the document declares, since a vector picture has no pixels of its own.
 * Where no SVG loader is installed both answer nothing. A caller that must
 * know asks; it does not assume either way.
 *
 * **`null` for both "not there" and "not a picture we read"**, which is one
 * answer for one question and the same one `File.Info` gives for a missing file.
 * A path that is not text is still a **refusal**, through `bta_file_path`, like
 * every other verb that takes one: `Probe.Image(undefined)` must not quietly
 * probe a file called `./undefined`.
 *
 * **A path and not bytes, and that is the operation talking.** `Painter.Image`
 * takes either because painting decodes both the same; this one's promise is
 * the header and no decode, and there is no header reader for memory --
 * `GdkPixbufLoader` emits `size-prepared` only when it closes, after the whole
 * picture is decoded, so bytes here would quietly allocate a 12000x8000
 * photograph's pixels to answer two numbers. The size of a picture already in
 * memory is the handle's to answer, when there is one, off the decode it
 * already did.
 *
 * ## Growing
 *
 * It is a namespace of questions and the questions are what grows: a verb gets
 * added when something needs one, named after the *kind* of thing
 * (`Image`, then `Audio`, `Video`, `Font`). There is no `Probe.File` to catch
 * everything, because a file's size and time are already `File.Info`'s and
 * asking twice is how two answers for one word happen.
 *
 * Pure and callback-free -- a header read and a dictionary built -- so a worker
 * installs it too (`bta_task.c`), which is what a report generator sizing a logo
 * on a thread needs.
 */
#include "bta.h"

#include <string.h>

static JSValue probe_image(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Probe.Image(path) needs a path");

    const char *path = bta_file_path(ctx, argv[0], "Probe.Image");

    if (!path)
        return JS_EXCEPTION;

    int width = 0, height = 0;

    /* The header and nothing else: no decode, so a 12000x8000 photograph costs
     * a few bytes of I/O and no memory for its pixels. */
    GdkPixbufFormat *fmt = gdk_pixbuf_get_file_info(path, &width, &height);

    JS_FreeCString(ctx, path);

    if (!fmt || width <= 0 || height <= 0)
        return JS_NULL;

    JSValue out = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, out, "Width", JS_NewInt32(ctx, width));
    JS_SetPropertyStr(ctx, out, "Height", JS_NewInt32(ctx, height));
    return out;
}

static const JSCFunctionListEntry probe_props[] = {
    /* Image(path) -> { Width, Height }
     *   the picture's pixels, from its header. `null` when `path` is not a
     *   picture this machine's loaders read -- exactly the files a `Picture`
     *   would not show, an `.svg` included where no SVG loader is installed,
     *   and its declared size where one is -- or is not there. **A file's
     *   header and nothing else**: the size of a picture already in memory is
     *   the handle's to answer, off the decode it already did. **No widget and
     *   no display**, which is what makes it answerable in a `main` project
     *   and before anything has been drawn
     */
    JS_CFUNC_DEF("Image", 1, probe_image),
};

void bta_probe_init(JSContext *ctx, JSValue global)
{
    JSValue probe = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, probe, probe_props, G_N_ELEMENTS(probe_props));
    JS_SetPropertyStr(ctx, global, "Probe", probe);
}
