/*
 * PdfView -- a PDF on a form: its pages, one at a time, with a zoom.
 *
 *     { "type": "PdfView", "name": "Viewer",
 *       "properties": { "File": "docs/manual.pdf", "Zoom": "Fit width" } }
 *
 *     this.Viewer.Open(path, password);        // an encrypted one
 *     this.Viewer.Print(() => this.Done());    // the print dialog, then paper
 *
 * **It is a `DrawingArea` and `PdfDocument.Draw`, and no control of its own.**
 * The canvas's `Draw` puts the page on a sheet on the screen; its `DrawPage`
 * puts the same page on paper; its `Paginate` answers how many. So printing
 * it is `Printer.Send(viewer.Canvas)`, previewing it `Printer.Preview`, and a
 * thumbnail `Painter.Render(viewer.Canvas, page, w, h)` -- the verbs every
 * drawing already has, which is the reason it is built this way.
 *
 * **The password is a method's argument, never a property.** Every property
 * with a getter and a setter is saved in the `.form`, and a password in a file
 * of the project is a password in version control. `File` opens one that needs
 * none; `Open(path, password)` opens one that does.
 *
 * What it does not do, said so it is not looked for: select or search text
 * (the text is `Document.Text(page)`), follow links, show a page's outline.
 */
"use strict";

/* What the zoom offers, and what each is: 0 fits the page, -1 the width,
 * anything else is that much of the paper's real size. */
const PDFVIEW_ZOOMS = { "Fit page": 0, "Fit width": -1, "50%": 0.5, "75%": 0.75,
                        "100%": 1, "150%": 1.5, "200%": 2 };
const PDFVIEW_PAD = 16;
const PDFVIEW_DPI = 96 / 72;          /* 100% is the paper's real size */

export class PdfView extends Component {

    /* PageChange(page)
     *   the page shown moved -- the buttons, `Next`, `Previous` or `Open`.
     *   Assigning `Page` raises nothing, as a setter does not
     */
    static Events = ["PageChange"];

    static Options = { Zoom: Dictionary.Keys(PDFVIEW_ZOOMS) };

    /* Declared, because a component is sealed under `--strict`. */
    _file; _doc; _page; _zoom;

    constructor() {
        super();
        this._file = "";
        this._doc  = null;
        this._page = 1;
        this._zoom = "Fit page";
    }

    /* ------------------------------------------------------------ the file */

    /**
     * the PDF shown, a path; `""` shows nothing. Assigning opens it, so a file
     * that is not there or not a PDF throws here. One that wants a password
     * is `Open(path, password)`'s -- never a property, which a `.form` would
     * keep. Defaults to `""`
     */
    get File() { return this._file; }
    set File(v) {
        const path = v === null || v === undefined ? "" : String(v);
        if (!path) {
            this.close();
            this.show();
            return;
        }
        this.Open(path);
    }

    /**
     * opens a PDF, with its password when it has one, and shows its first page
     * @returns PdfView
     */
    Open(path, password) {
        const doc = PdfDocument.Load(path, password);
        this.close();
        this._doc  = doc;
        this._file = String(path);
        this._page = 1;
        this.size();
        this.show();
        this.Emit("PageChange", 1);
        return this;
    }

    /**
     * the open document, a `PdfDocument` -- its text, its metadata -- or `null`
     * @returns PdfDocument
     */
    get Document() { return this._doc; }

    /**
     * how many pages; `0` with no document
     * @returns number
     */
    get Pages() { return this._doc ? this._doc.Pages : 0; }

    /* ------------------------------------------------------------ the page */

    /**
     * the page shown, from 1. Assigning one past either end goes to that end.
     * Defaults to `1`
     */
    get Page() { return this._page; }
    set Page(v) {
        const n = Math.trunc(Number(v));
        if (!Number.isFinite(n))
            throw new TypeError("Page: a page number, from 1");
        this._page = Math.min(Math.max(1, n), Math.max(1, this.Pages));
        this.show();
    }

    /**
     * the next page, if there is one
     * @returns PdfView
     */
    Next() { return this.go(this._page + 1); }

    /**
     * the page before, if there is one
     * @returns PdfView
     */
    Previous() { return this.go(this._page - 1); }

    /* ------------------------------------------------------------ the look */

    /**
     * `Fit page` `Fit width` `50%` `75%` `100%` `150%` `200%` -- the whole
     * page in the room, its width in the room, or that much of its real size.
     * Defaults to `"Fit page"`
     */
    get Zoom() { return this._zoom; }
    set Zoom(v) {
        const z = String(v);
        if (!Dictionary.Has(PDFVIEW_ZOOMS, z))
            throw new RangeError(`Zoom: '${z}' is not one of ${Dictionary.Keys(PDFVIEW_ZOOMS).join(", ")}`);
        this._zoom = z;
        const at = Dictionary.Keys(PDFVIEW_ZOOMS).indexOf(z);
        if (this.CmbZoom && this.CmbZoom.Index !== at) this.CmbZoom.Index = at;
        this.size();
    }

    /**
     * whether the row of buttons above the page shows. Defaults to `true`
     */
    get Toolbar() { return this.Bar ? this.Bar.Visible : true; }
    set Toolbar(v) { if (this.Bar) this.Bar.Visible = !!v; }

    /* ------------------------------------------------------------ paper */

    /**
     * the print dialog, then a printer -- `Printer.Send` over the canvas, every
     * page of the document. `cb` as `Send` calls it
     */
    Print(setup, cb) {
        if (typeof setup === "function") { cb = setup; setup = undefined; }
        Printer.Send(this.Canvas, setup || {}, typeof cb === "function" ? cb : () => {});
    }

    /**
     * the runtime's print preview of every page -- `Printer.Preview` over the
     * canvas; answers its window
     * @returns Form
     */
    Preview(setup, cb) {
        if (typeof setup === "function") { cb = setup; setup = undefined; }
        return Printer.Preview(this.Canvas, setup || {}, cb);
    }

    /* ------------------------------------------------------------ inside */

    close() {
        if (this._doc) this._doc.Close();
        this._doc  = null;
        this._file = "";
        this._page = 1;
    }

    go(n) {
        const to = Math.min(Math.max(1, n), Math.max(1, this.Pages));
        if (to !== this._page) {
            this._page = to;
            this.show();
            this.Emit("PageChange", to);
        }
        return this;
    }

    show() {
        if (!this.LblPage) return;
        const pages = this.Pages;
        this.LblPage.Text      = pages ? Locale.Text("{0} of {1}", this._page, pages) : "";
        this.BtnPrevious.Enabled = pages > 0 && this._page > 1;
        this.BtnNext.Enabled     = pages > 0 && this._page < pages;
        this.Canvas.Redraw();
    }

    /* The factor the page is drawn at, in a canvas that size. */
    factor(w, h) {
        const z = PDFVIEW_ZOOMS[this._zoom];
        if (!this._doc) return 1;
        const size = this._doc.PageSize(this._page);
        if (z > 0) return z * PDFVIEW_DPI;
        const across = (w - 2 * PDFVIEW_PAD) / size.Width;
        const down   = (h - 2 * PDFVIEW_PAD) / size.Height;
        return Math.max(0.05, z < 0 ? across : Math.min(across, down));
    }

    /* A fixed zoom gives the canvas the page's size, so the view scrolls; a
     * fit one gives it the view's. */
    size() {
        if (!this.Canvas || !this.View) return;
        const b = this.View.Bounds();
        if (!this._doc) {
            this.Canvas.Width  = Math.max(1, b.Width - 2);
            this.Canvas.Height = Math.max(1, b.Height - 2);
        } else {
            const z    = PDFVIEW_ZOOMS[this._zoom];
            const page = this._doc.PageSize(this._page);
            if (z > 0) {
                this.Canvas.Width  = Math.ceil(page.Width * z * PDFVIEW_DPI + 2 * PDFVIEW_PAD);
                this.Canvas.Height = Math.ceil(page.Height * z * PDFVIEW_DPI + 2 * PDFVIEW_PAD);
            } else {
                this.Canvas.Width  = Math.max(1, b.Width - 2);
                this.Canvas.Height = z < 0
                    ? Math.ceil(page.Height * this.factor(b.Width - 2, 0) + 2 * PDFVIEW_PAD)
                    : Math.max(1, b.Height - 2);
            }
        }
        this.Canvas.Redraw();
    }

    /* The screen: the page on a white sheet, on the desk. */
    Canvas_Draw(p, w, h) {
        p.Color = "rgba(0, 0, 0, 0.12)";
        p.Rectangle(0, 0, w, h);
        p.Fill();
        if (!this._doc) return;

        const size = this._doc.PageSize(this._page);
        const z    = this.factor(w, h);
        const pw   = size.Width * z, ph = size.Height * z;
        const x    = Math.max(PDFVIEW_PAD, (w - pw) / 2), y = PDFVIEW_PAD;

        p.Color = "white";
        p.Rectangle(x, y, pw, ph);
        p.Fill();
        p.Push();
        p.Translate(x, y);
        p.Scale(z);
        this._doc.Draw(p, this._page, size.Width, size.Height);
        p.Pop();
        p.Color = "rgba(0, 0, 0, 0.35)";
        p.LineWidth = 1;
        p.Rectangle(x + 0.5, y + 0.5, pw - 1, ph - 1);
        p.Stroke();
    }

    /* Paper: each page fitted to the printable area, which is how `Printer`
     * and `Printer.Preview` see this canvas. */
    Canvas_DrawPage(p, page, w, h) {
        if (this._doc && page >= 1 && page <= this._doc.Pages)
            this._doc.Draw(p, page, w, h);
    }
    Canvas_Paginate() { return Math.max(1, this.Pages); }

    BtnPrevious_Click() { this.Previous(); }
    BtnNext_Click()     { this.Next(); }
    CmbZoom_Select() {
        const name = Dictionary.Keys(PDFVIEW_ZOOMS)[this.CmbZoom.Index];
        if (name && name !== this._zoom) this.Zoom = name;
    }
    View_Allocated() { if (PDFVIEW_ZOOMS[this._zoom] <= 0) this.size(); }
}
