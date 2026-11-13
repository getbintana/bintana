/*
 * The `Report` control: a `ReportDocument` on a screen, a page at a time.
 *
 * A module of its own, beside `ReportDocument.js`, because it is the half
 * that needs a display: it extends `Component`, which the console host does
 * not have. The library's manifest names this file under `display`, so a
 * `main` loads the document and skips the control, where the two used to
 * share one script and the control was declared behind `typeof Component`.
 * What the document is, and the conventions both halves keep, are in that
 * file's head.
 */
/*
 * **The control: a page you can turn.** What a report is lives in its
 * `Document`; this shows one page of it at a time, says when the pages moved,
 * and prints through the print dialog. Every property of the document is here
 * too, under the same name, so a form that has always set `Report1.Data` goes
 * on doing so.
 */
export class Report extends Component {

    /* Page(page)
     *   the data moved the current page: `Data` or `Refresh()` left fewer
     *   pages than `Page`, and it was pulled back inside the new count.
     *   `page` is one-based. **Assigning `Page` raises nothing** — a property
     *   setter must not, since a `.form` declaring it would raise it before the
     *   host's other controls exist — so the code that turns a page updates its
     *   own display. `Sections`, the paper, the orientation and the margins
     *   pull the page back silently too
     */
    /* Prepared(count)
     *   the pages were computed: `Data` or `Refresh()`. `count` is the new
     *   `PageCount`. Changing `Sections`, the paper, the orientation or the
     *   margins re-measures **silently** — read `PageCount` back on the next
     *   line — because those can be written in a `.form`, and an event raised
     *   while a form is loading arrives before the form's other controls exist
     */
    static Events  = ["Page", "Prepared"];
    static Options = {
        Paper:       ["A4", "Letter", "A5"],
        Orientation: ["Portrait", "Landscape"],
    };


    /* ---------------------------------------------------------------- fields
     *
     * **Declared, because a component is sealed once it is built** under
     * `--strict` (`docs/plans/strict-plan.md`). Without values, for the reason
     * `ReportDocument` gives.
     */
    _doc; _page;

    /* Which page an export from the canvas is drawing, and `undefined` at every
     * other moment -- the one thing that tells `Canvas_Draw` it is not painting
     * the screen. */
    _saving;

    /**
     * the report itself — a `ReportDocument`, which is what draws. Everything
     * below that is not about the screen is a property of it
     */
    get Document() {
        if (!this._doc) this._doc = new ReportDocument();
        return this._doc;
    }

    /* ------------------------------------------------------------ properties
     *
     * The document's, re-measured at once rather than when next asked: the
     * control has a page on screen that has to stay inside the new count. The
     * paper, the orientation and the margins do it silently; `Data` and
     * `Sections` through `Refresh()`, which says so.
     */

    /**
     * `A4` `Letter` `A5`, the sheet in points (72 to the inch). Defaults to
     * `"A4"`.
     */
    get Paper() { return this.Document.Paper; }
    set Paper(v) { this.Document.Paper = v; this.remeasure(); }

    /** `Portrait` `Landscape`. Defaults to `"Portrait"`. */
    get Orientation() { return this.Document.Orientation; }
    set Orientation(v) { this.Document.Orientation = v; this.remeasure(); }

    /**
     * the gutter around the content, in points: one number for all four edges,
     * or `{ Top, Right, Bottom, Left }`. `40`. Every side is a finite number or
     * the assignment throws
     */
    get Margins() { return this.Document.Margins; }
    set Margins(v) { this.Document.Margins = v; this.remeasure(); }

    /* The current page, one-based. Setting it clamps to `[1, PageCount]`, so a
     * `Page` past the end is the last page and not a blank one.
     *
     * **Turning a page redraws and does not measure.** That is the whole point
     * of the two passes: the pages were worked out when the data arrived, and
     * this only chooses which of them to paint. */
    /**
     * the current page, **one-based**. Assigning clamps to `[1, PageCount]`, so
     * a page past the end is the last one, not a blank. Turning a page
     * **redraws and does not re-measure**. Defaults to `1`.
     */
    get Page() { return this._page || 1; }
    set Page(v) {
        const n = Math.max(1, Math.min(this.PageCount || 1, Math.round(Number(v) || 1)));
        if (n === this._page) return;
        this._page = n;
        this.redraw();
        /* **And says nothing.** A property setter must not raise an event: a
         * `.form` declaring `Page` would raise it before the host's other
         * controls exist (AGENTS.md). The program that assigned it knows. */
    }

    /**
     * the rows: an array of plain objects. `Field` elements read a key off the
     * current row; the group bands read the keys named by each group's `.On`.
     * Defaults to `[]`.
     */
    get Data() { return this.Document.Data; }
    set Data(v) { this.Document.Data = v; this.Refresh(); }

    /**
     * the band definitions — the whole of what a report is besides the numbers.
     * See below. Defaults to `{}`. Assigning it re-measures **silently**,
     * because it can be written in a `.form`; read `PageCount` back or call
     * `Refresh()`.
     */
    get Sections() { return this.Document.Sections; }
    set Sections(v) {
        this.Document.Sections = v;
        /* **Silent**, like the paper: `Sections` can be written in a `.form`
         * now (that is what the designer does), and an event raised while the
         * form loads reaches the host before its controls are bound. The pages
         * are measured again when next asked, and a host that assigned it from
         * code reads `PageCount` back or calls `Refresh()`. */
        this.remeasure();
    }

    /**
     * how many pages the data and the sections make. Measures lazily, so it is
     * answerable in `Form_Open` before anything has drawn. An empty report is
     * one blank page, not none
     */
    get PageCount() { return this.Document.PageCount; }

    /* Re-measure, redraw, and say so. This is what `Data` and `Sections` do,
     * and what a host calls when it changed the rows in place.
     *
     * **`Prepared` is emitted here and not in `remeasure`**, and that is a
     * deliberate line rather than tidiness: an event emitted while a `.form` is
     * being applied reaches the host's handler *before the host's other
     * controls exist* -- measured, and the reason is in `AGENTS.md`. `Data` is
     * the rows and is assigned from code; `Sections` can be written in a
     * `.form` (the designer does), so its setter re-measures silently;
     * `Paper`, `Orientation` and `Margins` can be written there too and do the
     * same. A host that changes one reads `PageCount` back on the next line. */
    /**
     * re-measures, redraws and emits `Prepared`. Call it when you changed the
     * rows **in place**; assigning `Data` already does, and assigning
     * `Sections` re-measures silently because it can be in a `.form`
     */
    Refresh() {
        const had = this._page;
        this.remeasure();
        /* The page moving under the data is a move nobody asked for, so it is
         * reported -- here, and not from `remeasure`, which the paper's, the
         * orientation's and the margins' setters call and which must stay
         * silent for the same reason `Page`'s setter is. */
        if (had !== undefined && this._page !== had) this.Emit("Page", this._page);
        this.Emit("Prepared", this.Document.PageCount);
    }

    /* The pages again, and the current one kept inside them. A report whose
     * data shrank under its own `Page` would otherwise paint page 1 while its
     * footer said "6 of 1". */
    remeasure() {
        const count = this.Document.Refresh();
        this._page = Math.max(1, Math.min(count || 1, this._page || 1));
        this.redraw();
    }

    /* Paint again with what the last measure worked out. The `Canvas` is not
     * there yet while the component's own `.form` is being read. */
    redraw() { if (this.Canvas) this.Canvas.Redraw(); }

    /* The control's own exports run through its `Canvas`, not through
     * `Drawing`: the same frame the screen gets, so `Canvas.Dump()` is what
     * was written -- which is how `tests/report` reads a page. The document's
     * `Save` and `SavePdf` are the ones with no control. */
    /**
     * one page to a PNG. `page` defaults to the current one, `scale` to `2`
     * (144 dpi — an A4 page is a 1190px-wide PNG). The export runs the same
     * `Draw` at the exact paper size, clamps the page the way `Page` does, and
     * **does not move the report**
     */
    Save(path, page, scale) {
        const n = page === undefined ? this.Page
                   : Math.max(1, Math.min(this.PageCount || 1, Math.round(Number(page) || 1)));
        const s = Math.max(0.1, Number(scale) || 2);
        const [w, h] = this.Document.paperSize();

        this._saving = n;
        try { this.Canvas.Save(path, Math.round(w * s), Math.round(h * s)); }
        finally { this._saving = undefined; }
    }

    /**
     * **every page, one file**. Vector, at the paper's exact size, so the text
     * in it is text; the pages are the ones the last measure worked out. A
     * report with `Input`/`Signature` elements is a form, and the fields are
     * added by `PdfDocument.AddFields` after the page is drawn. This is what a report is for
     * — `Save` is for when one page is going into something else. With no
     * display, `Document.SavePdf` is the same file
     */
    SavePdf(path) {
        this.Document.SavePdf(path);
    }

    /* To paper, through the print dialog.
     *
     * One line of its own, and the rest is [`Printer`](../../docs/reference/globals/Printer.md):
     * this fills in what the report knows -- how many pages there are, and the
     * paper and orientation it was laid out for -- and `{ Copies, From, To }`
     * say the rest. **Async**, like every dialog in this runtime: `cb` is
     * handed what the dialog settled, and is not called at all when it was
     * cancelled, so there is nothing to test for.
     *
     * **To a file it is `SavePdf`**, which this report already has: a PDF is
     * not a printer with a `Copies` of 3, and `Printer` is split into two verbs
     * for exactly that reason.
     */
    /**
     * **every page, to paper**, through
     * [`Printer`](docs/llm/library.md#printer): this fills in how many pages
     * there are and the paper and orientation the report was laid out for, and
     * `{ Copies, From, To }` say the job. **A paper chosen in the dialog scales
     * the page rather than re-flowing it**, and the page count does not move —
     * a report's bands are declared in its own points, so it declares no
     * `Paginate` (a `Markdown` does). **Async**, like every dialog here: `cb({
     * Copies, From, To })` is what was actually sent, and is **not called**
     * when the dialog was cancelled. **To a file it is `SavePdf`**: a PDF is
     * not a printer with a `Copies` of 3
     */
    Send(setup, cb) {
        const fn = typeof setup === "function" ? setup : cb;
        const o  = typeof setup === "function" || setup === undefined ||
                   setup === null ? {} : setup;

        if (typeof o !== "object" || Array.isArray(o))
            throw new Error("Send expects a setup object");
        if (typeof fn !== "function")
            throw new Error("Send(setup, cb) needs a callback: it is async, " +
                            "and it is not called when the dialog is cancelled");

        const opts = { Pages:       this.PageCount || 1,
                       Paper:       this.Paper,
                       Orientation: this.Orientation };
        if (o.Copies !== undefined) opts.Copies = o.Copies;
        if (o.From !== undefined)   opts.From   = o.From;
        if (o.To !== undefined)     opts.To     = o.To;

        Printer.Send(this.Canvas, opts, fn);
    }

    /* ------------------------------------------------------------- drawing */

    /*
     * **No `Canvas_Paginate`, and that is the statement.** `Printer` asks a
     * control how many sheets it is once the dialog has settled the paper, and
     * a control that does not answer keeps the count it was given -- which is
     * right here: a report's bands are declared in its own points and a page is
     * *scaled* to fit whatever frame it gets, so its page count does not move
     * with the paper. `lib/markdown` does answer, because it re-flows.
     *
     * It was declared here for one commit, returning `PageCount`, and the cost
     * was not the redundancy: `PageCount` measures when it has to, and
     * measuring inside GTK's `begin-print` re-enters the drawing the operation
     * is in the middle of. The suite hung. An event that only ever repeats an
     * answer is an event not to declare.
     */

    /* One sheet of paper, which is the same frame with the page said out loud.
     *
     * **This is what lets `Printer` work on this report's canvas directly**:
     * the page arrives as an argument and this hands it to the frame, so
     * `Printer.Send(rep.Canvas, ...)` draws page 3 on sheet 3 without the
     * report having to set a field first and hope.
     */
    Canvas_DrawPage(p, page, width, height) {
        this.Document.draw(p, page, width, height, false);
    }

    Canvas_Draw(p, width, height) {
        if (this._saving) this.Document.draw(p, this._saving, width, height, false);
        else              this.Document.draw(p, this.Page, width, height, true);
    }
}
