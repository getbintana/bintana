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

typedef struct {
    BtaWidget *w;
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
static JSValue print_run(JSContext *ctx, JSValueConst area, JSValueConst opts,
                         const char *tofile, const char *who)
{
    BtaWidget *w = bta_this(ctx, area);

    if (!w || !bta_paint_draws(w))
        return JS_ThrowTypeError(ctx,
            "%s: the first argument is a control that draws -- a DrawingArea, "
            "or the Canvas of a Report or a Markdown", who);

    /* Refused before the dialog is on the screen rather than one page after it:
     * there is one painter per control, and a handler that is drawing cannot
     * ask for a second frame. */
    if (bta_paint_busy(ctx, w))
        return JS_ThrowTypeError(ctx, "%s: a frame is already being drawn -- a "
                                      "Draw handler cannot print", who);

    /* Whether the control works its own page count out, which decides where the
     * range is checked -- see setup_read. */
    const bool counts = bta_has_handler(w, "Paginate");

    PrintSetup setup;
    if (!setup_read(ctx, opts, &setup, tofile == NULL, counts, who))
        return JS_EXCEPTION;

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

    GtkPrintOperationAction action = GTK_PRINT_OPERATION_ACTION_PRINT_DIALOG;
    if (tofile) {
        gtk_print_operation_set_export_filename(op, tofile);
        gtk_print_operation_set_show_progress(op, FALSE);
        action = GTK_PRINT_OPERATION_ACTION_EXPORT;
    }

    PrintRun run = {
        .w      = w,
        .base   = lineal ? setup.from : 1,
        .first  = -1,
        .last   = 0,
        .ok     = true,
        .pages  = setup.pages,
        .from   = setup.from,
        .to     = setup.to,
        .lineal = lineal,
        .who    = who,
    };
    g_signal_connect(op, "begin-print", G_CALLBACK(on_begin_print), &run);
    g_signal_connect(op, "draw-page", G_CALLBACK(on_draw_page), &run);

    BtaApp    *app    = bta_current_app();
    GtkWindow *parent = app && app->gapp
                            ? gtk_application_get_active_window(app->gapp)
                            : NULL;

    GError                 *err    = NULL;
    GtkPrintOperationResult result = gtk_print_operation_run(op, action, parent,
                                                             &err);
    JSValue answer = JS_EXCEPTION;

    /*
     * **The handler's own throw is asked about first.** A `DrawPage` that
     * failed is the program's fault and a cancellation is the person's
     * decision, so the fault is the more specific answer -- and it is the one
     * that leaves an exception pending. Asked last, a cancellation arriving
     * after a page had thrown would answer `null` with that throw still armed,
     * to surface at whatever called into JavaScript next.
     */
    if (!run.ok) {
        /* What it had already written is not a document, the same bargain
         * `SavePdf` makes about a file it did not finish. */
        g_clear_error(&err);
        if (tofile)
            g_unlink(tofile);
    } else if (result == GTK_PRINT_OPERATION_RESULT_ERROR) {
        JS_ThrowInternalError(ctx, "%s: %s", who,
                              err ? err->message : "the printer refused");
        g_clear_error(&err);
        if (tofile)
            g_unlink(tofile);
    } else if (result == GTK_PRINT_OPERATION_RESULT_CANCEL) {
        /* Not an error: the dialog closed with nothing chosen. */
        answer = JS_NULL;
    } else if (tofile) {
        /* A file's answer is how many pages it holds. There is nothing else to
         * report: nobody chose anything. */
        answer = JS_NewInt32(ctx, run.first < 0 ? 0 : run.last - run.first + 1);
    } else {
        /* What the dialog settled: the pages actually sent. */
        GtkPrintSettings *final = gtk_print_operation_get_print_settings(op);

        answer = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, answer, "Copies",
                          JS_NewInt32(ctx, final
                                          ? gtk_print_settings_get_n_copies(final)
                                          : setup.copies));
        JS_SetPropertyStr(ctx, answer, "From",
                          JS_NewInt32(ctx, run.first < 0 ? 0 : run.first));
        JS_SetPropertyStr(ctx, answer, "To", JS_NewInt32(ctx, run.last));
    }

    g_object_unref(op);
    setup_clear(&setup);
    return answer;
}

static JSValue printer_send(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Printer.Send(area, [setup]) needs the "
                                      "control that draws");
    return print_run(ctx, argv[0], argc > 1 ? argv[1] : JS_UNDEFINED, NULL,
                     "Printer.Send");
}

static JSValue printer_to_file(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Printer.ToFile(area, path, [setup]) "
                                      "needs a control and a path");

    const char *path = JS_ToCString(ctx, argv[1]);
    if (!path)
        return JS_EXCEPTION;

    JSValue r = print_run(ctx, argv[0], argc > 2 ? argv[2] : JS_UNDEFINED, path,
                          "Printer.ToFile");
    JS_FreeCString(ctx, path);
    return r;
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

static JSValue printer_get_names(JSContext *ctx, JSValueConst this_val)
{
#ifndef BTA_HAVE_UNIX_PRINT
    return JS_ThrowInternalError(ctx,
        "Printer.Names: this build cannot list printers -- GTK publishes the "
        "list through its Unix print backend, and the system's own dialog "
        "elsewhere. Printer.Send opens it either way");
#else
    Enumeration e = { ctx, JS_NewArray(ctx), NULL, 0 };

    gtk_enumerate_printers(printer_seen, &e, NULL, TRUE);
    g_free(e.chosen);
    return e.list;
#endif
}

static JSValue printer_get_default(JSContext *ctx, JSValueConst this_val)
{
#ifndef BTA_HAVE_UNIX_PRINT
    return JS_ThrowInternalError(ctx,
        "Printer.Default: this build cannot name the default printer -- see "
        "Printer.Names");
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
