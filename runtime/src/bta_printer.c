/*
 * Printer: what the machine can print on, and the two ways a drawing gets there.
 *
 * **A theme and not a verb on a control.**  `Save`, `ToPng` and `SavePdf` are
 * the drawing's own -- they write what it is -- but a printer is a thing outside
 * the program, with a name, a default and a dialog, and the questions about it
 * do not belong on a widget.  That is the shape `Dialog`, `Desktop` and
 * `Environment` already have here, and the shape VB6 (`Printer` + `Printers`),
 * Delphi (`TPrinter`), Gambas (`Printer`) and .NET (`PrinterSettings`) all
 * arrived at.
 *
 * **And `Printer` rather than `Print`.**  `print` is a global of this runtime --
 * the one every test writes with -- so the two would have differed by a capital
 * letter; and `Print` as a verb means *writing text* in the family this language
 * comes from (`Printer.Print`, `Print #1,` in Basic), which is not what this
 * does.  The noun is the thing, and the verbs say what happens to it.
 *
 * ## The two verbs, because they are two things
 *
 *   Printer.Send(area, [setup])          the dialog, a printer, paper
 *   Printer.ToFile(area, path, [setup])  a PDF, and no dialog
 *
 * They were one call with a `ToFile` key once, and the key decided whether
 * there was a dialog at all -- which is a mode and not an option.  What settled
 * it was measurable rather than tidy: `Copies: 3` with a file destination
 * answered "three copies sent" and wrote the same file, byte for byte, as one
 * copy.  `Copies` is not a thing a file has.  Split, the question cannot be
 * asked: `ToFile` has no `Copies` and its answer is the count of pages it wrote.
 *
 * It is the same split `Dialog.OpenFile`/`Dialog.SaveFile` is, for the same
 * reason -- one verb with a flag that changes what the call *is* reads as one
 * thing and behaves as two.
 *
 * ## What draws
 *
 * The control's own handler, once per sheet, against the print context: the
 * same cairo calls that paint the screen, so a page that fits the paper in
 * `SavePdf` fits it here.  **The sheet number arrives as an argument** --
 * `DrawPage(painter, page, width, height)` -- and a control whose form declared
 * no `DrawPage` gets `Draw`, which is right for a drawing that is one page.
 * The frame is the printable area in points, 72 to the inch.
 *
 * ## Asking about the machine
 *
 * `Names` and `Default` are `gtk_enumerate_printers`, which is GTK's Unix print
 * backend and not portable: on Windows GTK opens the system's own dialog and
 * publishes no list, so there the two **refuse with a sentence** rather than
 * answering an empty array that cannot be told apart from a machine with no
 * printer.  That is the rule `Exec`'s `Control` stream already follows there.
 *
 * Not cached.  Measured on this machine: 33.6 ms cold and 6.2 ms warm, because
 * GTK caches its backend underneath -- and unlike a plugin registry, the
 * printers a machine has do change while a program is running.
 */
#include "bta.h"

#include <glib/gstdio.h>
#include <string.h>

#ifdef BTA_HAVE_UNIX_PRINT
#include <gtk/gtkunixprint.h>
#endif

/* --------------------------------------------------------------- the setup
 *
 * `{ Pages, Paper, Orientation, Copies, From, To }` -- read once, checked once,
 * and handed to GTK as a page setup and a set of print settings.
 *
 * `undefined` and `null` are both "not given", spelled in `setup_int` and
 * nowhere else: `To` is the one key with a default of its own (the last page),
 * so it is the one where a second reading could disagree -- and did, until the
 * reader started answering whether the key was there.
 */
typedef struct {
    int32_t pages;
    int32_t copies;
    int32_t from;
    int32_t to;
    char   *paper;
    char   *orient;
} PrintSetup;

static void setup_clear(PrintSetup *s)
{
    g_free(s->paper);
    g_free(s->orient);
}

static bool setup_int(JSContext *ctx, JSValueConst opts, const char *key,
                      int32_t *out, bool *given)
{
    JSValue v   = JS_GetPropertyStr(ctx, opts, key);
    bool    had = !JS_IsUndefined(v) && !JS_IsNull(v);
    bool    ok  = true;

    if (had && JS_ToInt32(ctx, out, v)) {
        JS_ThrowTypeError(ctx, "%s is a number", key);
        ok = false;
    }
    if (given)
        *given = had;
    JS_FreeValue(ctx, v);
    return ok;
}

static bool setup_text(JSContext *ctx, JSValueConst opts, const char *key,
                       char **out)
{
    JSValue v  = JS_GetPropertyStr(ctx, opts, key);
    bool    ok = true;

    if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
        if (!JS_IsString(v)) {
            JS_ThrowTypeError(ctx, "%s is text", key);
            ok = false;
        } else {
            const char *t = JS_ToCString(ctx, v);
            if (!t)
                ok = false;
            else {
                g_free(*out);
                *out = g_strdup(t);
                JS_FreeCString(ctx, t);
            }
        }
    }
    JS_FreeValue(ctx, v);
    return ok;
}

/* The GtkPaperSize name for one of the three papers the setup takes. */
static const char *paper_size(const char *paper)
{
    if (!strcmp(paper, "A4"))
        return GTK_PAPER_NAME_A4;
    if (!strcmp(paper, "Letter"))
        return GTK_PAPER_NAME_LETTER;
    if (!strcmp(paper, "A5"))
        return GTK_PAPER_NAME_A5;
    return NULL;
}

/*
 * `copies` is read only where it means something, which is the whole of why
 * there are two verbs: a file has no copies, and a `Copies` accepted there
 * would be a number carried through the call and reported back as sent.
 */
static bool setup_read(JSContext *ctx, JSValueConst opts, PrintSetup *out,
                       bool copies, bool counts, const char *who)
{
    bool has_to = false;

    out->pages = out->copies = out->from = out->to = 1;
    out->paper = out->orient = NULL;

    if (!JS_IsUndefined(opts) && !JS_IsNull(opts)) {
        if (!JS_IsObject(opts)) {
            JS_ThrowTypeError(ctx, "%s: the setup is an object", who);
            return false;
        }
        if (!setup_int(ctx, opts, "Pages", &out->pages, NULL) ||
            !setup_int(ctx, opts, "From", &out->from, NULL) ||
            !setup_int(ctx, opts, "To", &out->to, &has_to) ||
            !setup_text(ctx, opts, "Paper", &out->paper) ||
            !setup_text(ctx, opts, "Orientation", &out->orient) ||
            (copies && !setup_int(ctx, opts, "Copies", &out->copies, NULL))) {
            setup_clear(out);
            return false;
        }
        if (!copies) {
            /* Said out loud rather than ignored: a caller that asked for three
             * copies of a file meant something, and it was not this. */
            JSValue v = JS_GetPropertyStr(ctx, opts, "Copies");
            bool    said = !JS_IsUndefined(v) && !JS_IsNull(v);

            JS_FreeValue(ctx, v);
            if (said) {
                JS_ThrowTypeError(ctx, "%s: a file has no Copies -- "
                                       "Printer.Send is the one that does", who);
                setup_clear(out);
                return false;
            }
        }
    }

    /* `To` defaults to the last page, not to the 1 it starts on. */
    if (!has_to)
        out->to = out->pages;

    if (out->pages < 1 || out->pages > 10000)
        JS_ThrowRangeError(ctx, "%s: %d pages is not a document (1 to 10000)",
                           who, out->pages);
    else if (out->copies < 1)
        JS_ThrowRangeError(ctx, "%s: %d copies is not a job", who, out->copies);
    /*
     * The half of the range that is true whatever the paper turns out to be.
     * **The total is not final yet when the control counts its own pages**:
     * `Pages` is then the caller's estimate against the paper *it* had, and
     * `Paginate` answers the real number once the dialog has settled -- so a
     * range is measured against the total there and not here, where the number
     * to measure it against is about to change.
     */
    else if (out->from < 1 || out->to < 1 || out->from > out->to)
        JS_ThrowRangeError(ctx, "%s: pages %d to %d are not a range", who,
                           out->from, out->to);
    else if (!counts && (out->from > out->pages || out->to > out->pages))
        JS_ThrowRangeError(ctx, "%s: pages %d to %d are outside 1 to %d", who,
                           out->from, out->to, out->pages);
    else if (out->paper && !paper_size(out->paper))
        JS_ThrowRangeError(ctx, "%s: Paper '%s' is not one of A4, Letter, A5",
                           who, out->paper);
    else if (out->orient && strcmp(out->orient, "Portrait") &&
             strcmp(out->orient, "Landscape"))
        JS_ThrowRangeError(ctx, "%s: Orientation '%s' is not Portrait or "
                                "Landscape", who, out->orient);
    else
        return true;

    setup_clear(out);
    return false;
}

/* ------------------------------------------------------------------ the run */

/*
 * One print, from the call that started it to the sheet that ends it.
 *
 * **On the heap, because `Send` outlives its own call.** The dialog is the
 * person's to answer in their own time, so the operation runs asynchronously
 * and this is what the `done` handler is given; `ToFile` opens nothing and is
 * over when it returns, but it carries the same structure so there is one
 * shape and not two.
 */
typedef struct {
    BtaWidget *w;
    JSValue    cb;          /* the callback, dup'd for the run; undefined for ToFile */
    int        base;        /* document page of the first one rendered */
    int        first;       /* first page rendered, 1-based; -1 while none */
    int        last;
    bool       ok;
    /* What the setup asked for, kept because `begin-print` may have to work the
     * range out again against a paper the dialog chose. */
    int         pages, from, to;
    bool        lineal;
    const char *who;        /* "Printer.Send" or "Printer.ToFile", for a message */
} PrintRun;

/*
 * **The controls with a print in flight**, which only an asynchronous `Send`
 * makes possible to ask about.
 *
 * GTK runs a nested main loop while the dialog is up, so the program does not
 * freeze -- the window repaints, timers fire, `Exec` callbacks arrive -- and
 * that is exactly why a second print can start on the same control while the
 * first is waiting. Measured before this existed: a `Timer` that printed during
 * a print was not refused and wrote its pages. `bta_paint_busy` does not catch
 * it, because between two sheets there is no frame open.
 *
 * One control, one print. The refusal is a sentence rather than a queue,
 * because two prints of one drawing is a program's mistake and not a thing to
 * be helpful about.
 */
static GPtrArray *printing;

static bool print_in_flight(BtaWidget *w)
{
    for (guint i = 0; printing && i < printing->len; i++)
        if (g_ptr_array_index(printing, i) == w)
            return true;
    return false;
}

static void print_started(BtaWidget *w)
{
    if (!printing)
        printing = g_ptr_array_new();
    g_ptr_array_add(printing, w);
}

static void print_ended(BtaWidget *w)
{
    if (printing)
        g_ptr_array_remove_fast(printing, w);
}

/*
 * **The paper is not known until the dialog has been answered**, and how many
 * sheets a document is depends on it.
 *
 * `Pages` in the setup is worked out against the paper the *caller* had: a
 * `Markdown` that is four A4 sheets is six A5 ones. If the person picks A5 in
 * the dialog, GTK hands every frame the A5 size, the control re-flows for it --
 * and the operation still only asks for the four sheets that were declared, so
 * the last two are never drawn and nothing says so. Measured, with a real
 * document: four declared, six needed, four printed.
 *
 * `begin-print` is where that is fixable, because it carries the
 * `GtkPrintContext` -- the paper, resolved -- and `set_n_pages` may still be
 * called. So the control is **asked**: `Paginate(width, height)` answers how
 * many sheets it is at that size, and a form that declares none keeps the
 * number it gave, which is what every caller had before this existed.
 *
 * The range is worked out again with it, because `From`/`To` were written
 * against the old count: a `To` past the new end is clamped to it, and a `From`
 * past it is a range with nothing in it, which is an error rather than an empty
 * file.
 */
static void on_begin_print(GtkPrintOperation *op, GtkPrintContext *context,
                           gpointer data)
{
    PrintRun *run = data;

    if (!run->ok || !bta_has_handler(run->w, "Paginate"))
        return;

    JSContext *ctx = run->w->ctx;
    int        w   = (int)(gtk_print_context_get_width(context) + 0.5);
    int        h   = (int)(gtk_print_context_get_height(context) + 0.5);

    JSValueConst argv[2] = { JS_NewInt32(ctx, w), JS_NewInt32(ctx, h) };
    bool         threw   = false;
    JSValue      answer  = bta_emit_answer(run->w, "Paginate", 2, argv, &threw);
    int32_t      pages   = 0;

    if (threw || JS_ToInt32(ctx, &pages, answer))
        pages = 0;
    JS_FreeValue(ctx, answer);

    if (threw) {
        JS_ThrowInternalError(ctx, "the Paginate handler threw: nothing was "
                                   "printed past the error above");
        run->ok = false;
        return;
    }
    /* A handler that answers nothing usable is a handler that has nothing to
     * add: the declared count stands. The range is still settled against it
     * below, because `setup_read` left that to here. */
    if (pages >= 1 && pages <= 10000)
        run->pages = pages;

    /*
     * The range, against the count that is now final. `To` past the end is
     * clamped -- "to the end" is what a caller asking for more than there is
     * means -- and a `From` past it is a range with nothing in it, which is an
     * error and not an empty file.
     */
    if (run->to > run->pages)
        run->to = run->pages;
    if (run->from > run->pages) {
        JS_ThrowRangeError(ctx, "%s: this paper is %d page%s and the range "
                                "starts at %d", run->who, run->pages,
                           run->pages == 1 ? "" : "s", run->from);
        run->ok = false;
        return;
    }

    if (run->lineal) {
        run->base = run->from;
        gtk_print_operation_set_n_pages(op, run->to - run->from + 1);
    } else {
        gtk_print_operation_set_n_pages(op, run->pages);
    }
}

static void on_draw_page(GtkPrintOperation *op, GtkPrintContext *context,
                         int page_nr, gpointer data)
{
    PrintRun *run = data;

    (void)op;
    if (!run->ok)
        return;

    /* GTK counts the sheets it renders from 0; the handler is told the page of
     * the document, which is the number a person would write on it. */
    int      page = page_nr + run->base;
    cairo_t *cr   = gtk_print_context_get_cairo_context(context);
    double   dw   = gtk_print_context_get_width(context);
    double   dh   = gtk_print_context_get_height(context);

    if (run->first < 0)
        run->first = page;
    run->last = page;

    if (!bta_paint_page(run->w, cr, (int)(dw + 0.5), (int)(dh + 0.5), page))
        run->ok = false;
}

/*
 * The half both verbs share: check the control, build the operation, run it.
 *
 * `tofile` is the path for the export road and NULL for the dialog one, and it
 * is the only thing that differs below -- which is the argument for the split
 * being in the surface rather than in a key the caller passes.
 */
/* What the dialog settled, as the callback is handed it. */
static JSValue print_answer(JSContext *ctx, PrintRun *run,
                            GtkPrintOperation *op, int copies)
{
    GtkPrintSettings *final = gtk_print_operation_get_print_settings(op);
    JSValue           out   = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, out, "Copies",
                      JS_NewInt32(ctx, final
                                      ? gtk_print_settings_get_n_copies(final)
                                      : copies));
    JS_SetPropertyStr(ctx, out, "From",
                      JS_NewInt32(ctx, run->first < 0 ? 0 : run->first));
    JS_SetPropertyStr(ctx, out, "To", JS_NewInt32(ctx, run->last));
    return out;
}

static void print_free(PrintRun *run)
{
    print_ended(run->w);
    JS_FreeValue(run->w->ctx, run->cb);
    g_free(run);
}

/*
 * The dialog has been answered, one way or another -- and this is the whole of
 * why `Send` takes a callback.
 *
 * **The callback is not called when the person cancelled.** That is
 * `Dialog.OpenFile`'s rule and it is here for its reason: no caller should have
 * to tell *cancelled* from *printed nothing*, and a `null` that every caller
 * must test is a test every caller forgets once. Cancelling is not an outcome a
 * program has to handle; it is the absence of one.
 *
 * An error is reported where every other handler's error is reported, because
 * by now there is nobody to hand it to: the call that started this returned
 * while the dialog was still open.
 */
static void on_print_done(GtkPrintOperation *op, GtkPrintOperationResult result,
                          gpointer data)
{
    PrintRun   *run = data;
    JSContext  *ctx = run->w->ctx;

    if (result == GTK_PRINT_OPERATION_RESULT_ERROR) {
        GError *err = NULL;

        gtk_print_operation_get_error(op, &err);
        /* Raised and then dumped, which is how every handler's error is
         * reported here: `Application.OnError` sees it, and there is no caller
         * left to throw at. */
        JS_ThrowInternalError(ctx, "%s: %s", run->who,
                              err ? err->message : "the printer refused");
        bta_dump_error(ctx);
        g_clear_error(&err);
    } else if (result == GTK_PRINT_OPERATION_RESULT_APPLY && run->ok) {
        JSValueConst argv[1] = { print_answer(ctx, run, op, 1) };
        JSValue      r       = JS_Call(ctx, run->cb, JS_UNDEFINED, 1, argv);

        if (JS_IsException(r))
            bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[0]);
        bta_drain_jobs(JS_GetRuntime(ctx));
    }
    /* CANCEL says nothing, and a page that threw has already said it. */

    print_free(run);
    g_object_unref(op);
}

/*
 * Everything both verbs do before the operation runs: check the control, read
 * the setup, and build the operation out of it. Answers the operation with the
 * run attached, or NULL with an exception pending.
 */
static GtkPrintOperation *print_prepare(JSContext *ctx, JSValueConst area,
                                        JSValueConst opts, const char *tofile,
                                        const char *who, PrintRun **out)
{
    BtaWidget *w = bta_this(ctx, area);

    if (!w || !bta_paint_draws(w)) {
        JS_ThrowTypeError(ctx,
            "%s: the first argument is a control that draws -- a DrawingArea, "
            "or the Canvas of a Report or a Markdown", who);
        return NULL;
    }

    /* Refused before the dialog is on the screen rather than one page after it:
     * there is one painter per control, and a handler that is drawing cannot
     * ask for a second frame. */
    if (bta_paint_busy(ctx, w)) {
        JS_ThrowTypeError(ctx, "%s: a frame is already being drawn -- a "
                               "Draw handler cannot print", who);
        return NULL;
    }

    /* And one control prints once at a time. See `printing` above: the dialog
     * runs on a nested main loop, so a timer or a second click can reach this
     * while the first print is still waiting to be answered. */
    if (print_in_flight(w)) {
        JS_ThrowTypeError(ctx, "%s: this control is already printing", who);
        return NULL;
    }

    /* Whether the control works its own page count out, which decides where the
     * range is checked -- see setup_read. */
    const bool counts = bta_has_handler(w, "Paginate");

    PrintSetup setup;
    if (!setup_read(ctx, opts, &setup, tofile == NULL, counts, who))
        return NULL;

    GtkPrintOperation *op = gtk_print_operation_new();

    gtk_print_operation_set_job_name(op, "Bintana");
    gtk_print_operation_set_unit(op, GTK_UNIT_POINTS);

    /*
     * What GTK renders is not always what its settings say. Measured with a C
     * probe: on `EXPORT` this GTK renders every page whatever range the
     * settings carry, so a range there is said with the page count instead --
     * the file then holds exactly `From..To`. Through the dialog the count
     * stays the whole document (it is what the dialog offers the range within)
     * and the settings carry the preset.
     */
    const bool lineal = tofile && (setup.from > 1 || setup.to < setup.pages);

    gtk_print_operation_set_n_pages(op, lineal ? setup.to - setup.from + 1
                                               : setup.pages);

    GtkPageSetup *page_setup = gtk_page_setup_new();
    if (setup.paper) {
        GtkPaperSize *size = gtk_paper_size_new(paper_size(setup.paper));
        gtk_page_setup_set_paper_size(page_setup, size);
        gtk_paper_size_free(size);
    }
    if (setup.orient)
        gtk_page_setup_set_orientation(
            page_setup, !strcmp(setup.orient, "Landscape")
                            ? GTK_PAGE_ORIENTATION_LANDSCAPE
                            : GTK_PAGE_ORIENTATION_PORTRAIT);
    gtk_print_operation_set_default_page_setup(op, page_setup);
    g_object_unref(page_setup);

    GtkPrintSettings *settings = gtk_print_settings_new();
    gtk_print_settings_set_n_copies(settings, setup.copies);
    if (!lineal && (setup.from > 1 || setup.to < setup.pages)) {
        GtkPageRange range = { setup.from - 1, setup.to - 1 };

        gtk_print_settings_set_print_pages(settings, GTK_PRINT_PAGES_RANGES);
        gtk_print_settings_set_page_ranges(settings, &range, 1);
    }
    gtk_print_operation_set_print_settings(op, settings);
    g_object_unref(settings);

    if (tofile) {
        gtk_print_operation_set_export_filename(op, tofile);
        gtk_print_operation_set_show_progress(op, FALSE);
    }

    PrintRun *run = g_new0(PrintRun, 1);

    run->w      = w;
    run->cb     = JS_UNDEFINED;
    run->base   = lineal ? setup.from : 1;
    run->first  = -1;
    run->last   = 0;
    run->ok     = true;
    run->pages  = setup.pages;
    run->from   = setup.from;
    run->to     = setup.to;
    run->lineal = lineal;
    run->who    = who;

    g_signal_connect(op, "begin-print", G_CALLBACK(on_begin_print), run);
    g_signal_connect(op, "draw-page", G_CALLBACK(on_draw_page), run);

    setup_clear(&setup);
    print_started(w);
    *out = run;
    return op;
}

/*
 * `Printer.Send(area, [setup], cb)` -- the dialog, then paper.
 *
 * **The callback is required, and it is the same bargain `Dialog` makes.** The
 * dialog is the person's to answer in their own time, so the operation runs
 * asynchronously and this returns at once: the call cannot hand back what was
 * printed because nothing has been yet. `cb({ Copies, From, To })` is called
 * when something was, and **is not called when it was cancelled** -- so no
 * caller has to tell *cancelled* from *printed nothing*, which is the test
 * every caller forgets once.
 *
 * It was synchronous first and answered `null` for a cancel, and both halves of
 * that were wrong in the same way: `Dialog.OpenFile`, `SaveFile` and `Color`
 * all take a callback and none of them reports a cancel, so this was the one
 * dialog in the runtime a program had to treat differently. Synchronous did not
 * even mean safe -- GTK runs a nested main loop, so the program went on
 * running, and a `Timer` could start a second print of the same drawing while
 * the first was still waiting. Measured, and refused now by name.
 */
static JSValue printer_send(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Printer.Send(area, [setup], cb) needs "
                                      "the control that draws");

    /* The callback is the last argument, so that `setup` may be left out. */
    JSValueConst cb   = argv[argc - 1];
    JSValueConst opts = argc > 2 ? argv[1] : JS_UNDEFINED;

    if (argc < 2 || !JS_IsFunction(ctx, cb))
        return JS_ThrowTypeError(ctx,
            "Printer.Send(area, [setup], cb) needs a callback: it is async, and "
            "it is not called when the dialog is cancelled");

    PrintRun          *run = NULL;
    GtkPrintOperation *op  = print_prepare(ctx, argv[0], opts, NULL,
                                           "Printer.Send", &run);
    if (!op)
        return JS_EXCEPTION;

    run->cb = JS_DupValue(ctx, cb);
    g_signal_connect(op, "done", G_CALLBACK(on_print_done), run);

    /*
     * **Asynchronous on purpose, and the operation outlives this call**: GTK
     * keeps a reference of its own until `done`, and `on_print_done` drops
     * ours. Where the platform cannot run it asynchronously GTK simply runs it
     * synchronously and emits `done` before this returns, which the code above
     * does not have to know about -- the callback arrives either way.
     */
    gtk_print_operation_set_allow_async(op, TRUE);

    BtaApp    *app    = bta_current_app();
    GtkWindow *parent = app && app->gapp
                            ? gtk_application_get_active_window(app->gapp)
                            : NULL;
    GError    *err    = NULL;

    gtk_print_operation_run(op, GTK_PRINT_OPERATION_ACTION_PRINT_DIALOG,
                            parent, &err);
    g_clear_error(&err);      /* what went wrong arrives at `done` */
    return JS_UNDEFINED;
}

/*
 * `Printer.ToFile(area, path, [setup])` -- a PDF, and no dialog.
 *
 * **Synchronous, and that is not an inconsistency**: what makes `Send` take a
 * callback is the dialog, and there is none here. Nobody is being waited for,
 * the pages are drawn and the call is over, so the answer -- how many it wrote
 * -- can be handed straight back.
 */
static JSValue printer_to_file(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Printer.ToFile(area, path, [setup]) "
                                      "needs a control and a path");

    const char *path = JS_ToCString(ctx, argv[1]);
    if (!path)
        return JS_EXCEPTION;

    PrintRun          *run = NULL;
    GtkPrintOperation *op  = print_prepare(ctx, argv[0],
                                           argc > 2 ? argv[2] : JS_UNDEFINED,
                                           path, "Printer.ToFile", &run);
    if (!op) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    GError                 *err    = NULL;
    GtkPrintOperationResult result = gtk_print_operation_run(
        op, GTK_PRINT_OPERATION_ACTION_EXPORT, NULL, &err);
    JSValue answer;

    /*
     * The handler's own throw is asked about first: a `DrawPage` that failed is
     * the program's fault and it is the one that leaves an exception pending.
     * What it had already written is not a document, the same bargain `SavePdf`
     * makes about a file it did not finish.
     */
    if (!run->ok) {
        g_clear_error(&err);
        g_unlink(path);
        answer = JS_EXCEPTION;
    } else if (result == GTK_PRINT_OPERATION_RESULT_ERROR) {
        JS_ThrowInternalError(ctx, "Printer.ToFile: %s",
                              err ? err->message : "the file could not be written");
        g_clear_error(&err);
        g_unlink(path);
        answer = JS_EXCEPTION;
    } else {
        /* A file's answer is how many pages it holds. Nobody chose anything,
         * so there is nothing else to report. */
        answer = JS_NewInt32(ctx, run->first < 0 ? 0 : run->last - run->first + 1);
    }

    print_free(run);
    g_object_unref(op);
    JS_FreeCString(ctx, path);
    return answer;
}

/* ----------------------------------------------------------- the machine's */

#ifdef BTA_HAVE_UNIX_PRINT
typedef struct {
    JSContext *ctx;
    JSValue    list;     /* the array, for Names */
    char      *chosen;   /* the default's name, for Default */
    uint32_t   n;
} Enumeration;

static gboolean printer_seen(GtkPrinter *p, gpointer data)
{
    Enumeration *e    = data;
    const char  *name = gtk_printer_get_name(p);

    if (gtk_printer_is_default(p) && !e->chosen)
        e->chosen = g_strdup(name ? name : "");
    if (!JS_IsUndefined(e->list))
        JS_SetPropertyUint32(e->ctx, e->list, e->n++,
                             JS_NewString(e->ctx, name ? name : ""));
    return FALSE;        /* FALSE keeps the enumeration going */
}
#endif

/*
 * **Three answers, because there are three states**, and `null` is what keeps
 * the third one from being mistaken for the second:
 *
 *   ["HP LaserJet", ...]   this session can ask, and these are the printers
 *   []                     it can ask, and the machine has none
 *   null                   it cannot ask at all
 *
 * These threw where they now answer `null`, and the reason they threw was that
 * an *empty list* cannot be told apart from a machine with no printer -- which
 * is true, and is an argument for a third value rather than for an exception. A
 * program that wants to know asks; it should not have to find out by catching
 * something. The suite had to, and a `try` around a capability question is the
 * control flow `Video.Available` exists to prevent.
 */
static JSValue printer_get_names(JSContext *ctx, JSValueConst this_val)
{
#ifndef BTA_HAVE_UNIX_PRINT
    return JS_NULL;
#else
    Enumeration e = { ctx, JS_NewArray(ctx), NULL, 0 };

    gtk_enumerate_printers(printer_seen, &e, NULL, TRUE);
    g_free(e.chosen);
    return e.list;
#endif
}

/*
 * The same three, and the same reason `""` is not `null` here: a machine that
 * can be asked and has nothing marked as the one to use is a different answer
 * from a machine that cannot be asked.
 */
static JSValue printer_get_default(JSContext *ctx, JSValueConst this_val)
{
#ifndef BTA_HAVE_UNIX_PRINT
    return JS_NULL;
#else
    Enumeration e = { ctx, JS_UNDEFINED, NULL, 0 };

    gtk_enumerate_printers(printer_seen, &e, NULL, TRUE);

    /* `""` and not null: there is a machine, and it has no printer set as the
     * one to use. A program that wants to know whether there is any asks
     * `Names`. */
    JSValue r = JS_NewString(ctx, e.chosen ? e.chosen : "");
    g_free(e.chosen);
    return r;
#endif
}

/*
 * **The paper sizes, in points, asked of GTK rather than written down.**
 *
 * `lib/report` and `lib/markdown` each carried this table, identically, and the
 * copies did more than repeat themselves: both were a top-level `const PAPERS`,
 * so a project that named **both libraries** did not start at all --
 * `SyntaxError: redeclaration of 'PAPERS'`, on line 1 of a file its author
 * never wrote. It is one table here, where the three names already had to be
 * known (`paper_size` above hands them to GTK), and neither library declares
 * one.
 *
 * The numbers are `gtk_paper_size_get_width/height` and not three pairs typed
 * out: this is the same GTK that lays the page out, so a size that reads 595
 * here is the 595 the print context will hand the handler. Points, 72 to the
 * inch, because that is what a PDF page is and what the frame arrives in.
 */
static JSValue printer_get_papers(JSContext *ctx, JSValueConst this_val)
{
    static const char *names[] = { "A4", "Letter", "A5" };
    JSValue            out     = JS_NewObject(ctx);

    for (guint i = 0; i < G_N_ELEMENTS(names); i++) {
        GtkPaperSize *size  = gtk_paper_size_new(paper_size(names[i]));
        JSValue       sheet = JS_NewObject(ctx);

        /* Whole points. GTK answers the exact conversion from millimetres --
         * A4 is 595.2755905511812 wide -- and a quarter of a point is the
         * noise of that conversion rather than a size anybody laid out to: a
         * PDF surface is made in whole points and both libraries rounded on
         * the way in already. Rounded here instead, once, so the number a
         * layout is written against and the number the page is made with are
         * the same one. */
        JS_SetPropertyStr(ctx, sheet, "Width",
            JS_NewInt32(ctx, (int)(gtk_paper_size_get_width(size, GTK_UNIT_POINTS) + 0.5)));
        JS_SetPropertyStr(ctx, sheet, "Height",
            JS_NewInt32(ctx, (int)(gtk_paper_size_get_height(size, GTK_UNIT_POINTS) + 0.5)));
        JS_SetPropertyStr(ctx, out, names[i], sheet);
        gtk_paper_size_free(size);
    }
    return out;
}

static const JSCFunctionListEntry printer_props[] = {
    JS_CGETSET_DEF("Names",   printer_get_names,   NULL),
    JS_CGETSET_DEF("Papers",  printer_get_papers,  NULL),
    JS_CGETSET_DEF("Default", printer_get_default, NULL),
    JS_CFUNC_DEF("Send",   2, printer_send),
    JS_CFUNC_DEF("ToFile", 3, printer_to_file),
};

void bta_printer_init(JSContext *ctx, JSValue global)
{
    JSValue printer = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, printer, printer_props,
                               (int)G_N_ELEMENTS(printer_props));
    JS_SetPropertyStr(ctx, global, "Printer", printer);
}
