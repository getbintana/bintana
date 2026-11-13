/*
 * A banded report: `ReportDocument` (this module) lays it out and draws it,
 * and `Report` (Report.js) shows it.
 *
 * `Report` is what Crystal Reports calls a *report definition*: content arranged
 * in **bands** -- page header and footer, nested group headers and footers, a
 * detail band that repeats once per row, and the report's own header and footer
 * -- laid out over **pages** of a fixed paper size. It is reached the way any
 * library is (`uses: ["report"]`), declared in code the way a chart's `Series`
 * is, and it draws with the same `Painter` every other drawing here uses.
 *
 * **The shape can be designed and the data is still code.** `Sections` is plain
 * data -- bands, elements, positions -- so the IDE's report designer edits it on
 * a page and writes it into the `.form` as an ordinary property; the
 * application fills `Data` in code and the running report draws exactly the
 * bands that were designed. A report written entirely in code goes on working
 * the same way.
 *
 * **What it publishes is documented like the runtime's own surface**, in
 * [docs/llm/report.md](../../docs/llm/report.md), and `tests/api.sh` holds that
 * page to the same completeness rule it holds the controls and `charts` to: a
 * library that ships with the runtime is part of the contract.
 *
 * ## The two passes
 *
 * A report is drawn twice: once to decide where the page breaks go and what the
 * totals are, and again to paint. The first pass (`measure`) walks the rows and
 * produces a list of pages, each a list of band instances with a `y` and a
 * context (`{ row }` for a detail band, `{ totals }` for a footer); the second
 * (`Canvas_Draw`) reads that list and paints the one page it was asked for. This
 * is what makes `PageCount` answerable before anything is drawn and what makes
 * `Page` a number instead of a re-run of the whole data.
 *
 * A band's height is *declared*, and a band that says `Height: "Auto"` is
 * measured instead -- `Text.Size` answers with no frame open, so the measure
 * pass can ask how tall a wrapped description will be and stays pure in the
 * sense that matters: it never touches a `Painter`.
 *
 * The cost is in the *measure*, not the *draw*: it runs when the data, the
 * sections or the paper change and **not when a page is turned** -- `Page` only
 * chooses which of the measured pages to paint, which is the whole of what the
 * two passes bought. A report is hundreds of rows, not hundreds of thousands --
 * no decimation, no caching by array identity, nothing `Chart` had to do.
 *
 * **The open group headers repeat at the top of each new page**, so a detail
 * row that lands alone on page 2 still says whose it is. See `measure`.
 *
 * ## What the page looks like
 *
 * The canvas always shows the **whole page, scaled to fit**, centred, on a white
 * sheet with a thin outline. There is deliberately no `Zoom` and no `Fit`: a
 * preview that fits is the one state that is never clipped and never needs a
 * scrollbar, and the host that wants a larger one enlarges the component or
 * calls `Save()` at a bigger scale. The page is white and the ink is black,
 * *not* the theme's: a report is a document that will be printed, and a theme's
 * ink on white paper is the invisible drawing.
 *
 * ## What it does not do
 *
 * Grouping is *consecutive* and never reorders the data, so sorting is the
 * host's. A band with a declared height does not grow (`Wrap` re-flows within
 * it and cuts the rest); `Height: "Auto"` is the band that does. A
 * `PageHeader` and a `PageFooter` are handed the page number and the count and
 * **no row**, because they belong to the sheet and not to the data. Each is a
 * judgement rather than an oversight and is written down here so nobody
 * rediscovers it.
 */
"use strict";

/*
 * **This library declares no paper table.** The sheets are `Printer.Papers`,
 * one table in both hosts (bta_util.c): a `ReportDocument` in a `main` with no
 * display lays itself out on the same 595x842 a print context hands the
 * graphical host's handler. A copy here was a second table, and two top-level
 * `PAPERS` in one global scope were a project naming two libraries failing
 * to start.
 */

/* A document is black on white: fixed, and not the theme. See the header. */
const INK   = "#000000";
const PAPER = "#ffffff";

/* The bands that appear once, whatever the data. The page header and footer do
 * not flow: they sit at the top and bottom of every page and the rest flows
 * between them. The group bands come from `Sections.Groups`, an ordered list --
 * outermost first -- and nest around the detail band. */
const FIXED_BANDS = ["ReportHeader", "PageHeader", "Detail", "PageFooter", "ReportFooter"];

/* What an element can be. A `Text` is fixed words, a `Field` is a value off the
 * current row, a `Total` is an aggregate the engine computed, a `Line` and a
 * `Box` are the two shapes a ruled report is made of, and an `Image` is a file
 * or the bytes themselves -- the masthead every real report carries, and the
 * chart a report drew a moment ago (`ChartDocument.ToPng()`). **`File` is the
 * name and `Bytes` the value**, exactly one of the two: a name round-trips and
 * resolves against the project, and bytes are what a runtime picture is.
 *
 * `Input` and `Signature` are the form's, and they turn the document into one:
 * a report with either is measured as **one page with no rows** and its PDF
 * gets AcroForm fields through `PdfDocument.AddFields`. `Input.Input` is `Text` or `Check`;
 * a `Signature` is left empty for the signer's own application. */
const KINDS   = ["Text", "Field", "Total", "Line", "Box", "Image", "Input", "Signature"];
const INPUTS  = ["Text", "Check"];
const OPS     = ["Sum", "Count", "Min", "Max", "Avg"];
const FORMATS = ["", "Number", "Money", "Date", "Percent"];
const ALIGNS  = ["Left", "Center", "Right"];


/*
 * **The report itself, with no control: `ReportDocument`.**
 *
 * Everything a report *is* -- the paper, the bands, the rows, the pages they
 * make and the drawing of each one -- with nothing on a screen. It is what a
 * `main` project writes a PDF with, since that kind of project cannot make a
 * widget at all, and it is what the `Report` control below shows: the control
 * is a page you can turn and a dialog you can print from, and holds one of
 * these (`Report.Document`) to do the work.
 *
 * It was one class until a report had to go out from a timer. The measure
 * already ran with no painter (that is what `Text` is for); the drawing ran
 * only inside the control's `Canvas`, and a control needs a display. The
 * drawing is `Drawing`'s now, which hands it a painter over the file with no
 * control behind it -- the same `draw` the canvas runs, so what a preview shows
 * is what the file holds.
 */
export class ReportDocument {

    /* ---------------------------------------------------------------- fields
     *
     * Without values: what each one means while it is unset is written in the
     * getter that reads it (`this._data || []`), and a default said twice is
     * one that will disagree with itself.
     */

    /* What the properties keep. */
    _paper; _orientation; _margins; _data; _sections;

    /* What `measure()` leaves behind: the pages and the two band heights every
     * one of them is laid out between. `null` pages is "measure again". */
    _pages; _count; _headerH; _footerH;

    /* The bands already reported as taller than the page, so a report that
     * measures on every resize says so once and not on every frame. */
    _warned;

    /* ------------------------------------------------------------ properties
     *
     * Every one of them throws the pages away, because a report whose data
     * changed and whose pages did not is the first bug anybody writes here.
     * They are measured again when they are next asked for.
     */

    /**
     * `A4` `Letter` `A5`, the sheet in points (72 to the inch). Defaults to
     * `"A4"`.
     */
    get Paper() { return this._paper || "A4"; }
    set Paper(v) {
        if (!Printer.Papers[String(v)])
            throw new Error(`Paper: '${v}' is not one of ${Dictionary.Keys(Printer.Papers).join(", ")}`);
        this._paper = String(v);
        this.changed();
    }

    /** `Portrait` `Landscape`. Defaults to `"Portrait"`. */
    get Orientation() { return this._orientation || "Portrait"; }
    set Orientation(v) {
        if (v !== "Portrait" && v !== "Landscape")
            throw new Error(`Orientation: '${v}' is not Portrait or Landscape`);
        this._orientation = String(v);
        this.changed();
    }

    /* The gutter around the content, in points: a single number for all four
     * edges, or `{ Top, Right, Bottom, Left }`. What flows sits inside it. */
    /**
     * the gutter around the content, in points: one number for all four edges,
     * or `{ Top, Right, Bottom, Left }`. `40`. Every side is a finite number or
     * the assignment throws
     */
    get Margins() { return this._margins === undefined ? 40 : this._margins; }
    set Margins(v) {
        if (typeof v === "number" && isFinite(v)) { this._margins = v; this.changed(); return; }
        if (v && typeof v === "object" && !Array.isArray(v)) {
            /* Each side is held to what the one number is held to: `Number`
             * of `"x"` is NaN, and a NaN margin draws nothing at all. */
            const m = {};
            for (const side of ["Top", "Right", "Bottom", "Left"]) {
                const n = v[side] === undefined ? 40 : v[side];
                if (typeof n !== "number" || !isFinite(n))
                    throw new Error(`Margins: ${side} must be a finite number, not ${n}`);
                m[side] = n;
            }
            this._margins = m;
            this.changed();
            return;
        }
        throw new Error("Margins expects a number or { Top, Right, Bottom, Left }");
    }

    /**
     * the rows: an array of plain objects. `Field` elements read a key off the
     * current row; the group bands read the keys named by each group's `.On`.
     * Defaults to `[]`.
     */
    get Data() { return this._data || []; }
    set Data(v) {
        if (!Array.isArray(v)) throw new Error("Data expects an array of rows");
        this._data = v;
        this.changed();
    }

    /**
     * the band definitions — the whole of what a report is besides the numbers.
     * Checked when assigned, so a typo is refused where it was written.
     * Defaults to `{}`.
     */
    get Sections() { return this._sections || {}; }
    set Sections(v) {
        if (!v || typeof v !== "object" || Array.isArray(v))
            throw new Error("Sections expects an object of bands");
        this._sections = this.checkSections(v);
        this._warned   = null;
        this.changed();
    }

    /**
     * how many pages the data and the sections make. Measures when it has to,
     * so it is answerable before anything has been drawn. An empty report is
     * one blank page, not none
     */
    get PageCount() {
        if (!this._pages) this.measure();
        return this._count || 0;
    }

    /**
     * measures again now and answers the new `PageCount`. Call it when you
     * changed the rows **in place**; assigning `Data` or `Sections` already
     * throws the old pages away
     * @returns number
     */
    Refresh() {
        this.measure();
        return this._count || 0;
    }

    /* Whatever the pages were worked out from moved: they are worked out again
     * the next time anything asks. */
    changed() { this._pages = null; }

    /* ------------------------------------------------------------ out of it */

    /**
     * draws page `page` (one-based, clamped) with `p`, scaled to fit
     * `width`×`height` and centred — for a painter something else opened: a
     * `DrawPage` of your own, or a `Drawing` that puts this page beside other
     * things. Black on white, whatever the theme
     */
    Paint(p, page, width, height) {
        const n = Math.max(1, Math.min(this.PageCount || 1, Math.round(Number(page) || 1)));
        this.draw(p, n, width, height, false);
    }

    /**
     * the bands as a designer stacks them: one page wide, in reading order,
     * with every element's box. Coordinates are points, `0,0` at the sheet's
     * top-left; `sample` is the row a `Field` or a `Total` reads, and one is
     * made from the field names when it is not given. The stack grows past the
     * page when the bands need more room, so a designer shows all of them
     * rather than cutting the last band off.
     * @returns {Object}
     */
    DesignLayout(sample) {
        const sec = this._sections || {};
        const [pw, ph] = this.paperSize();
        const m = this.margins();
        const groups = sec.Groups || [];
        const fields = this.totalFields(sec);
        const row = (sample && typeof sample === "object" && !Array.isArray(sample))
            ? sample : this.sampleRow(sec);
        const totals = this.computeTotals([row], fields);

        const bands = [];
        const add = (name, band, ctx) => {
            if (!band) return;
            bands.push({ Name: name, Band: band, Context: ctx,
                         Height: this.bandHeight(band, ctx) });
        };

        add("ReportHeader", sec.ReportHeader, {});
        add("PageHeader",   sec.PageHeader,   { page: 1, count: 1 });

        groups.forEach((g, i) => {
            const value = row[g.On];
            add(`Groups[${i}].Header`, g.Header,
                { group: value, row: { [g.On]: value } });
        });

        add("Detail", sec.Detail, { row, at: 1, last: true });

        for (let i = groups.length - 1; i >= 0; i--) {
            const g = groups[i];
            const value = row[g.On];
            add(`Groups[${i}].Footer`, g.Footer,
                { group: value, row: { [g.On]: value }, totals });
        }

        add("ReportFooter", sec.ReportFooter, { totals });
        add("PageFooter",   sec.PageFooter,   { page: 1, count: 1 });

        let y = m.Top;
        for (const b of bands) { b.Y = y; y += b.Height; }

        const cw = pw - m.Left - m.Right;
        for (const b of bands)
            b.Elements = this.elementBoxes(b.Band, b, m, cw);

        return {
            Width: pw,
            Height: Math.max(ph, y + m.Bottom),
            ContentWidth: cw,
            Margins: m,
            Bands: bands,
        };
    }

    /*
     * A row for the designer: every field it can see says its own name, and a
     * numeric or money one says a number, so a column of `N` is not a column of
     * empty strings while somebody lays it out.
     */
    sampleRow(sec) {
        const row = {};

        for (const band of this.bandsOf(sec))
            for (const el of band.Elements || []) {
                if (!el || !el.Field || String(el.Field).startsWith("@")) continue;
                if (el.Kind !== "Field" && el.Kind !== "Total") continue;

                row[el.Field] = el.Format === "Date" ? "2026-01-31"
                              : (el.Format === "Number" || el.Format === "Money" ||
                                 el.Format === "Percent" || el.Kind === "Total" || el.Op)
                                ? 1234.5 : String(el.Field);
            }
        return row;
    }

    /*
     * Every element's box in the page's coordinates, for the designer's hit
     * test and its handles. `Width: 0` on a text run means its own width, which
     * is the same rule `drawElement` follows; a `Box` that says `"Band"` is as
     * wide or as tall as the band, as it is when drawn.
     */
    elementBoxes(band, placed, m, cw) {
        const out = [];
        const base = Text.Font;

        (band.Elements || []).forEach((el, index) => {
            if (!this.shown(el, placed.Context)) return;

            let x = m.Left + (Number(el.X) || 0);
            let y = placed.Y + (Number(el.Y) || 0);
            let w = 0, h = 0;

            if (el.Kind === "Line") {
                const x1 = Number(el.X1) || 0, y1 = Number(el.Y1) || 0;
                const x2 = Number(el.X2) || 0, y2 = Number(el.Y2) || 0;
                x = m.Left + Math.min(x1, x2);
                y = placed.Y + Math.min(y1, y2);
                w = Math.abs(x2 - x1);
                h = Math.abs(y2 - y1);
            } else if (el.Kind === "Box") {
                w = el.Width  === "Band" ? cw : Number(el.Width)  || 0;
                h = el.Height === "Band" ? placed.Height : Number(el.Height) || 0;
            } else if (el.Kind === "Image") {
                w = Number(el.Width)  || 0;
                h = Number(el.Height) || 0;
                const size = this.imageSize(el);
                if (size && size.Width > 0 && size.Height > 0) {
                    if (!w) w = h * size.Width / size.Height;
                    if (!h) h = w * size.Height / size.Width;
                }
            } else if (el.Kind === "Input" || el.Kind === "Signature") {
                w = Number(el.Width)  || 120;
                h = Number(el.Height) || 24;
            } else {
                const text = this.textOf(el, placed.Context);
                const font = this.paint(el.Font, placed.Context, base);
                w = Number(el.Width) || 0;
                if (!w) w = Text.Width(text, font);
                h = Number(el.Height) || 0;
                if (!h) h = el.Wrap && w > 0
                    ? Text.Size(text, font, { Width: w }).Height
                    : Text.Height(text, font);
            }

            /* A box of nothing cannot be clicked, and an empty `Text` is a
             * real element somebody is about to type into. */
            if (w < 4) w = 4;
            if (h < 4) h = 4;

            out.push({ Element: el, Index: index, Kind: el.Kind,
                       X: x, Y: y, Width: w, Height: h });
        });
        return out;
    }

    /* The picture's natural size, for an Image that declares one side only.
     * `Probe` reads the header, so this stays cheap; bytes are the caller's
     * and are not measured here -- the designer has a `Width` to go by. */
    imageSize(el) {
        if (el.Bytes !== undefined || !el.File) return null;
        const file = String(el.File);
        const path = File.IsAbsolute(file) ? file
                                           : File.Join(Application.Directory, file);
        try { return Probe.Image(path); } catch (e) { return null; }
    }

    /**
     * the design on a painter: the sheet, a tint and a rule for every band, and
     * the elements where they will print. Scaled to fit `width`×`height`, as
     * `Paint` scales a page; answers the same layout in the painter's
     * coordinates, which is what a hit test wants. A missing image is a
     * placeholder box, not a throw — the designer is where it is chosen.
     * @returns {Object}
     */
    PaintDesign(p, width, height, sample) {
        const layout = this.DesignLayout(sample);
        const scale  = Math.max(0.01, Math.min(width / layout.Width,
                                               height / layout.Height));
        const ox = (width  - layout.Width  * scale) / 2;
        const oy = (height - layout.Height * scale) / 2;
        const m  = layout.Margins;

        p.Push();
        p.Translate(ox, oy);
        p.Scale(scale);

        this.sheet(p, layout.Width, layout.Height, true);

        const base = Text.Font;

        for (const b of layout.Bands) {
            /* The tint and the rule are the designer's, not the document's:
             * what is under them is the report. */
            p.Push();
            p.Color = "rgba(0,0,0,0.035)";
            p.Rectangle(0, b.Y, layout.Width, b.Height);
            p.Fill();
            p.Color = "rgba(0,0,0,0.18)";
            p.LineWidth = 0.5;
            p.MoveTo(0, b.Y + 0.25);
            p.LineTo(layout.Width, b.Y + 0.25);
            p.Stroke();
            p.Pop();

            for (const el of b.Band.Elements || []) {
                if (!this.shown(el, b.Context)) continue;
                p.Push();
                try {
                    this.drawElement(p, el, m.Left, b.Y, b.Context, base,
                                     b.Height, layout.ContentWidth, true);
                } catch (e) {
                    const box = b.Elements.find((one) => one.Element === el);
                    if (box) {
                        p.Color = "rgba(0,0,0,0.35)";
                        p.LineWidth = 1;
                        p.Rectangle(box.X, box.Y, box.Width, box.Height);
                        p.Stroke();
                    }
                }
                p.Pop();
            }
        }

        /* The content area, dashed: where the page's own margins are. */
        p.Push();
        p.Color = "rgba(0,0,0,0.22)";
        p.LineWidth = 0.5;
        p.LineDash = [3, 3];
        p.Rectangle(m.Left, m.Top, layout.ContentWidth,
                    layout.Height - m.Top - m.Bottom);
        p.Stroke();
        p.Pop();

        p.Pop();

        const atX = (v) => ox + v * scale;
        const atY = (v) => oy + v * scale;

        return {
            X: ox, Y: oy, Scale: scale,
            Width: layout.Width * scale,
            Height: layout.Height * scale,
            ContentWidth: layout.ContentWidth * scale,
            Margins: m,
            Bands: layout.Bands.map((b) => ({
                Name: b.Name, Band: b.Band, Context: b.Context,
                X: ox, Y: atY(b.Y),
                Width: layout.Width * scale, Height: b.Height * scale,
                Elements: b.Elements.map((e) => ({
                    Element: e.Element, Index: e.Index, Kind: e.Kind,
                    X: atX(e.X), Y: atY(e.Y),
                    Width: e.Width * scale, Height: e.Height * scale,
                })),
            })),
        };
    }

    /**
     * one page to a PNG. `page` defaults to `1`, `scale` to `2` (144 dpi — an
     * A4 page is a 1190px-wide PNG). **No widget and no display**: it draws
     * through `Drawing`
     */
    Save(path, page, scale) {
        const n = Math.max(1, Math.min(this.PageCount || 1, Math.round(Number(page) || 1)));
        const s = Math.max(0.1, Number(scale) || 2);
        const [w, h] = this.paperSize();

        Drawing.Save(path, Math.round(w * s), Math.round(h * s),
                     (p, pw, ph) => this.draw(p, n, pw, ph, false));
    }

    /**
     * **every page, one file**. Vector, at the paper's exact size, so the text
     * in it is text. A report with `Input`/`Signature` elements is a form: the
     * page is drawn first and the fields are added by `PdfDocument.AddFields`. **No widget
     * and no display**: it draws through `Drawing`, which is what lets a `main`
     * project — a report run from a timer — write one. A page that throws
     * leaves no file
     */
    SavePdf(path) {
        const [w, h]  = this.paperSize();
        const fields  = this.formFields();

        /* A plain report writes straight to its path, as it always did. A form
         * writes beside it first: Cairo has no fields, so the static PDF is
         * one step and PoDoFo's is the next, and a failure must not leave a
         * half-form where the caller asked for one. */
        if (!fields.length) {
            Drawing.SavePdf(path, Math.round(w), Math.round(h), this.PageCount || 1,
                            (p, page, pw, ph) => this.draw(p, page, pw, ph, false));
            return;
        }

        if (!PdfDocument.CanWrite)
            throw new Error("Report.SavePdf: this build has no PoDoFo, so a form cannot be written; install libpodofo-devel");
        if ((this.PageCount || 1) > 1)
            throw new Error("Report.SavePdf: a form is one page; the bands do not fit on one sheet");

        const tmp = path + ".bta-form";
        try {
            Drawing.SavePdf(tmp, Math.round(w), Math.round(h), this.PageCount || 1,
                            (p, page, pw, ph) => this.draw(p, page, pw, ph, false));
            const doc   = PdfDocument.Load(tmp);
            let   added = 0;
            try { added = doc.AddFields(fields); } finally { doc.Close(); }
            if (added !== fields.length)
                throw new Error(`Report.SavePdf: ${added} of ${fields.length} fields were added`);
            File.Rename(tmp, path);
        } finally {
            if (File.Exists(tmp))
                try { File.Delete(tmp); } catch (e) { /* the rename already took it */ }
        }
    }

    /* ------------------------------------------------------------- the shape
     *
     * `Sections` is checked when it is assigned, so a typo in a band name, a
     * group without a key, or an element kind is refused where it was written
     * rather than the first time the report is drawn. The load-order trap a
     * `.form` applies properties in does not apply here -- the sections are
     * always assigned from code.
     */
    checkSections(v) {
        /* Field names are the document's, not the band's: a form that declares
         * `nombre` in two places would have two widgets with one value. */
        const names = {};

        const checkBand = (band, where) => {
            if (!band || typeof band !== "object")
                throw new Error(`Sections.${where} expects { Height, Elements }`);

            /* A page header and footer are what the flow is measured *between*,
             * so their height is known before any row is: `Auto` there would be
             * a page size that depends on the page's contents. */
            if (band.Height === "Auto" && (where === "PageHeader" || where === "PageFooter"))
                throw new Error(`Sections.${where}: Height "Auto" is for the bands that ` +
                                `flow -- a page header and footer are what they flow between`);

            for (const el of band.Elements || []) {
                if (!el || !KINDS.includes(el.Kind))
                    throw new Error(`Sections.${where}: element kind ` +
                                    `'${el && el.Kind}' is not one of ${KINDS.join(", ")}`);
                /* A typo in an option is a value that silently renders blank,
                 * which is the worst shape of a bug -- so it is refused here,
                 * where it was written. */
                if (el.Op     && !OPS.includes(el.Op))
                    throw new Error(`Sections.${where}: Op '${el.Op}' is not one of ${OPS.join(", ")}`);
                if (el.Format !== undefined && !FORMATS.includes(el.Format))
                    throw new Error(`Sections.${where}: Format '${el.Format}' is not one of ${FORMATS.join(", ")}`);
                if (el.Align  && !ALIGNS.includes(el.Align))
                    throw new Error(`Sections.${where}: Align '${el.Align}' is not one of ${ALIGNS.join(", ")}`);
                if (el.Kind === "Image" && !el.File && !el.Bytes)
                    throw new Error(`Sections.${where}: an Image element needs a File or Bytes`);
                if (el.Kind === "Image" && el.File && el.Bytes)
                    throw new Error(`Sections.${where}: an Image element takes a File or Bytes, not both`);

                if (el.Kind === "Input" || el.Kind === "Signature") {
                    if (typeof el.Name !== "string" || el.Name === "")
                        throw new Error(`Sections.${where}: a ${el.Kind} element needs a Name`);
                    if (hasOwn.call(names, el.Name))
                        throw new Error(`Sections.${where}: the field '${el.Name}' is declared twice`);
                    names[el.Name] = true;

                    if (el.Kind === "Input") {
                        const input = el.Input || "Text";
                        if (!INPUTS.includes(input))
                            throw new Error(`Sections.${where}: Input '${input}' is not one of ${INPUTS.join(", ")}`);
                        if (el.Checked !== undefined && typeof el.Checked !== "boolean")
                            throw new Error(`Sections.${where}: Checked is true or false`);
                        if (el.Multiline !== undefined && typeof el.Multiline !== "boolean")
                            throw new Error(`Sections.${where}: Multiline is true or false`);
                    }
                    if (el.Value !== undefined && typeof el.Value !== "string")
                        throw new Error(`Sections.${where}: Value is text`);
                    if (el.Reason !== undefined && typeof el.Reason !== "string")
                        throw new Error(`Sections.${where}: Reason is text`);
                    for (const key of ["ReadOnly", "Required"])
                        if (el[key] !== undefined && typeof el[key] !== "boolean")
                            throw new Error(`Sections.${where}: ${key} is true or false`);
                    if (el.MaxLength !== undefined &&
                        (typeof el.MaxLength !== "number" || !isFinite(el.MaxLength) ||
                         el.MaxLength < 0 || Math.floor(el.MaxLength) !== el.MaxLength))
                        throw new Error(`Sections.${where}: MaxLength is a whole number of characters`);
                    for (const key of ["X", "Y", "Width", "Height"])
                        if (el[key] !== undefined &&
                            (typeof el[key] !== "number" || !isFinite(el[key])))
                            throw new Error(`Sections.${where}: ${key} is a finite number`);
                    if (el.Width !== undefined && el.Width <= 0)
                        throw new Error(`Sections.${where}: Width is more than zero`);
                    if (el.Height !== undefined && el.Height <= 0)
                        throw new Error(`Sections.${where}: Height is more than zero`);
                }

                /* `When`, and the two properties that can read the row. All three
                 * are refused here for the same reason as everything above: a
                 * misspelt condition renders nothing and says nothing, which is
                 * the worst shape of a bug -- the shade that never appears. */
                if (el.When !== undefined && !ReportDocument.checkWhen(el.When))
                    throw new Error(`Sections.${where}: When '${ReportDocument.whenName(el.When)}' ` +
                                    `is not true, false, "@Odd", "@Even", "@First", "@Last", ` +
                                    `or { Field, Is } / { Field, IsNot }`);
                for (const key of ["Color", "Font"]) {
                    const v = el[key];
                    if (v !== undefined && !ReportDocument.checkPaint(v))
                        throw new Error(`Sections.${where}: ${key} '${JSON.stringify(v)}' is ` +
                                        `neither a value nor { Field: "..." } read off the row`);
                }
                /* `"Band"` is a size, and a number is the other half of it. */
                if (el.Kind === "Box")
                    for (const key of ["Width", "Height"]) {
                        const v = el[key];
                        if (v !== undefined && v !== "Band" &&
                            !(typeof v === "number" && isFinite(v)))
                            throw new Error(`Sections.${where}: a Box's ${key} ` +
                                            `'${JSON.stringify(v)}' is neither a number nor "Band"`);
                    }
            }
        };

        for (const key in v) {
            if (key === "Groups") {
                if (!Array.isArray(v.Groups))
                    throw new Error("Sections.Groups expects an array of { On, Header, Footer }");
                v.Groups.forEach((g, i) => {
                    if (!g || !g.On)
                        throw new Error(`Sections.Groups[${i}]: each group needs an On key`);
                    /* A header or a footer is optional -- a group that only
                     * introduces a header, or only subtotals, is a real one. */
                    if (g.Header) checkBand(g.Header, `Groups[${i}].Header`);
                    if (g.Footer) checkBand(g.Footer, `Groups[${i}].Footer`);
                });
                continue;
            }
            if (!FIXED_BANDS.includes(key))
                throw new Error(`Sections: '${key}' is not one of ${FIXED_BANDS.join(", ")} or Groups`);
            checkBand(v[key], key);
        }
        return v;
    }

    /* What a `When` may be. `checkSections` asks, and `shown` assumes: a shape
     * that is not one of these renders nothing, and a section that renders
     * nothing is a report that prints. */
    static checkWhen(w) {
        if (typeof w === "boolean") return true;
        if (typeof w === "string")
            return ["@Odd", "@Even", "@First", "@Last"].includes(w);
        if (!w || typeof w !== "object" || Array.isArray(w)) return false;
        if (typeof w.Field !== "string" || !w.Field) return false;
        /* Exactly one of the two, and both spellings at once is a question with
         * two answers -- which is a mistake nobody can see in a report. */
        return (w.Is === undefined) !== (w.IsNot === undefined);
    }

    /* Only for the message above: how to name what was written. */
    static whenName(w) {
        if (typeof w === "string") return w;
        if (w && typeof w === "object") return JSON.stringify(w);
        return String(w);
    }

    /* A colour or a font: a value, or `{ Field }` read off the row.
     *
     * **One key and it is `Field`.** `{ Field: "Sev", Is: 1 }` on a `Color` is
     * a condition spelled as a colour, and it would silently take the fallback --
     * a shade that never appears, which is the whole failure this file's
     * `checkSections` exists to refuse. The keys are walked rather than counted
     * because this language has no `Object.keys` (`Dictionary` is what replaced
     * it) and a count would be the only thing here that could not name what it
     * found. */
    static checkPaint(v) {
        if (typeof v === "string") return true;
        if (!v || typeof v !== "object" || Array.isArray(v)) return false;
        if (typeof v.Field !== "string" || !v.Field) return false;
        for (const k in v) if (k !== "Field") return false;
        return true;
    }

    /* Every band the sections hold, fixed and group alike, in no particular
     * order -- used only to gather the `Total` elements. */
    bandsOf(sec) {
        const out = [];
        for (const k of FIXED_BANDS) if (sec[k]) out.push(sec[k]);
        for (const g of sec.Groups || []) {
            if (g.Header) out.push(g.Header);
            if (g.Footer) out.push(g.Footer);
        }
        return out;
    }

    /* Whether this document is a form: one `Input` or `Signature` is enough.
     * It decides the measure (one empty row, one page) and the PDF's last
     * step. */
    hasFields(sec) {
        for (const band of this.bandsOf(sec || {}))
            for (const el of band.Elements || [])
                if (el && (el.Kind === "Input" || el.Kind === "Signature"))
                    return true;
        return false;
    }

    /*
     * The fields as `PdfDocument.AddFields` wants them: PDF points, bottom-left,
     * one object per field. The design is top-left, so the y is turned over
     * here once and nowhere else.
     *
     * **A field belongs to one page.** A `PageHeader` field would otherwise be
     * the same name on every sheet, which is two widgets with one value; the
     * duplicate check is what says so rather than letting PoDoFo make them.
     */
    formFields() {
        const sec = this._sections || {};
        if (!this.hasFields(sec)) return [];
        if (!this._pages) this.measure();

        const [pw, ph] = this.paperSize();
        const m = this.margins();
        const out = [];
        const seen = {};

        const add = (el, bx, by, page, ctx) => {
            if (!el || (el.Kind !== "Input" && el.Kind !== "Signature")) return;
            if (!this.shown(el, ctx)) return;
            if (hasOwn.call(seen, el.Name))
                throw new Error(`Report: the field '${el.Name}' appears on more than one page`);

            seen[el.Name] = true;

            const x = bx + (Number(el.X) || 0);
            const y = by + (Number(el.Y) || 0);
            const w = Number(el.Width)  || 120;
            const h = Number(el.Height) || 24;

            out.push({
                Page:     page,
                Name:     el.Name,
                Type:     el.Kind === "Signature" ? "Signature" : (el.Input || "Text"),
                Rect:     { X: x, Y: ph - y - h, Width: w, Height: h },
                Value:    el.Kind === "Signature" ? "" : String(el.Value || ""),
                Checked:  !!el.Checked,
                ReadOnly: !!el.ReadOnly,
                Required: !!el.Required,
                Multiline:!!el.Multiline,
                MaxLength:Number(el.MaxLength) || 0,
                Reason:   String(el.Reason || ""),
            });
        };

        for (let p = 0; p < this._pages.length; p++) {
            const page = this._pages[p];
            const ctx  = { page: p + 1, count: this._count };

            for (const el of (sec.PageHeader && sec.PageHeader.Elements) || [])
                add(el, m.Left, m.Top, p + 1, ctx);

            for (const b of page.bands)
                for (const el of b.band.Elements || [])
                    add(el, m.Left, b.y, p + 1,
                        { ...b.ctx, page: p + 1, count: this._count });

            const footerY = ph - m.Bottom - this._footerH;
            for (const el of (sec.PageFooter && sec.PageFooter.Elements) || [])
                add(el, m.Left, footerY, p + 1, ctx);
        }
        return out;
    }

    /* ------------------------------------------------------------- the page
     *
     * The sheet, in points, after the orientation. Everything above and below
     * flows against this size; the canvas scales it to whatever it was given.
     */
    paperSize() {
        const p = Printer.Papers[this.Paper] || Printer.Papers.A4;
        return this.Orientation === "Landscape"
            ? [p.Height, p.Width] : [p.Width, p.Height];
    }

    margins() {
        const m = this.Margins;
        return typeof m === "number"
            ? { Top: m, Right: m, Bottom: m, Left: m } : m;
    }


    /* ------------------------------------------------------------- measure
     *
     * The first pass. Pure -- no `Painter`, no text measurement -- because a
     * band's height is *declared*, and pagination is a sum of declared heights.
     * It walks the rows once, opens and closes the nested groups, starts a new
     * page when the next band will not fit, and closes each group with its
     * totals.
     */
    measure() {
        const sec  = this._sections || {};
        /* **A form is one page and no rows.** `Input`/`Signature` are not data:
         * the fields are the document, and a `Data` array a caller happens to
         * have must not multiply them. The empty row is what makes the Detail
         * band render once, which is where a form's fields live. */
        const rows = this.hasFields(sec) ? [{}] : (this._data || []);
        const [pw, ph] = this.paperSize();
        const m = this.margins();

        const groups = sec.Groups || [];

        const headerH = this.height(sec.PageHeader);
        const footerH = this.height(sec.PageFooter);

        const top    = m.Top + headerH;
        const bottom = ph - m.Bottom - footerH;

        const pages = [];
        let cursor = top;
        const current = () => pages[pages.length - 1];
        const newPage = () => { pages.push({ bands: [] }); cursor = top; };
        newPage();

        /* The group headers that are open right now, outermost first.
         *
         * **They repeat at the top of every page the group runs onto.** A
         * detail row that lands alone on page 2 under no heading belongs to
         * nobody -- the first thing anybody notices about a two-page report --
         * and repeating the open headers is what every report writer since
         * Crystal does about it. A header with no `Header` band declared has
         * nothing to repeat and is not in here. */
        const open = [];

        const put = (band, ctx, h) => {
            current().bands.push({ band, y: cursor, ctx, h });
            cursor += h;
        };

        /* Where the next band goes, page-breaking when it does not fit. A band
         * taller than the whole content area is placed anyway -- that is the
         * author's error, not the engine's, and breaking on it would loop, and
         * so would a repeat that did not fit either. */
        const flow = (band, ctx, known) => {
            const h = known === undefined ? this.bandHeight(band, ctx) : known;
            if (h <= 0) return;
            if (h > bottom - top) this.tooTall(sec, band, h, bottom - top);
            if (cursor + h > bottom && current().bands.length) {
                newPage();
                for (const o of open) put(o.band, o.ctx, o.h);
            }
            put(band, ctx, h);
        };

        const fields = this.totalFields(sec);

        /* The group key as a tuple, one entry per level -- which is the whole
         * of what makes grouping *nested*: a row changes level 0 when its
         * category changes, and level 1 when, inside one category, its client
         * changes. */
        const keyOf = (row) => groups.map((g) => row[g.On]);
        const levelRows = groups.map(() => []);

        /* A group band's context carries the group's own value as its row, so a
         * `Field` naming the group key resolves in a header or a footer exactly
         * as it does in a detail row. */
        const groupCtx = (l, value) =>
            ({ group: value, row: { [groups[l].On]: value } });

        /* A level opens with its header, and the header joins the list that a
         * page break repeats. */
        const openLevel = (l, value) => {
            const ctx = groupCtx(l, value);
            /* Measured once and carried: the repeat at the top of the next page
             * is the same band with the same context, and a second measurement
             * is how two copies of one heading come out different heights. */
            const h = this.bandHeight(groups[l].Header, ctx);

            flow(groups[l].Header, ctx, h);
            if (groups[l].Header) open.push({ level: l, band: groups[l].Header, ctx, h });
        };

        /* And closes with its footer and its totals. **The footer flows before
         * the level leaves `open`**, so a subtotal pushed onto a page of its own
         * still arrives under the heading it belongs to. */
        const closeLevel = (l, value) => {
            flow(groups[l].Footer,
                 { ...groupCtx(l, value), totals: this.computeTotals(levelRows[l], fields) });
            while (open.length && open[open.length - 1].level >= l) open.pop();
            levelRows[l] = [];
        };

        flow(sec.ReportHeader, {});

        let prev = null, allRows = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const key = keyOf(row);

            if (prev === null) {
                for (let l = 0; l < groups.length; l++) openLevel(l, key[l]);
            } else {
                /* The first level where this row differs from the last. Close
                 * every level from the innermost back up to it (each with its
                 * totals), then reopen them. */
                let d = 0;
                while (d < groups.length && ReportDocument.sameKey(key[d], prev[d])) d++;

                for (let l = groups.length - 1; l >= d; l--) closeLevel(l, prev[l]);
                for (let l = d; l < groups.length; l++) openLevel(l, key[l]);
            }

            /* A row belongs to every group it sits inside, so it is counted at
             * each level -- the outer total is the sum of its inner groups. */
            for (let l = 0; l < groups.length; l++) levelRows[l].push(row);
            allRows.push(row);
            flow(sec.Detail, { row, at: i + 1, last: i === rows.length - 1 });
            prev = key;
        }

        if (rows.length)
            for (let l = groups.length - 1; l >= 0; l--) closeLevel(l, prev[l]);

        flow(sec.ReportFooter, { totals: this.computeTotals(allRows, fields) });

        this._pages   = pages;
        this._count   = pages.length;
        this._headerH = headerH;
        this._footerH = footerH;
    }

    height(band) { return band && band.Height ? Number(band.Height) || 0 : 0; }

    /* A band taller than the room between the page header and footer is drawn
     * anyway and cut off at the bottom of the page -- breaking on it would
     * loop -- and that used to happen in silence: `Height: 2000` was one page
     * and a picture with its lower half missing. **It is said once, as a
     * `Logger.Warning`**, per band and per `Sections`: a warning and not a
     * throw, because an `Auto` band that grows too tall on one row in ten
     * thousand should not cost the other 9 999 their report. */
    tooTall(sec, band, h, room) {
        let name = Dictionary.Keys(sec).find((k) => sec[k] === band);
        if (!name)
            (sec.Groups || []).forEach((g, l) => {
                if (g.Header === band) name = `Groups[${l}].Header`;
                if (g.Footer === band) name = `Groups[${l}].Footer`;
            });
        name = name || "band";

        if (!this._warned) this._warned = [];
        if (this._warned.includes(name)) return;
        this._warned.push(name);
        Logger.Warning(`Report: the ${name} band is ${Math.round(h)} points tall and ` +
                       `the page has ${Math.round(room)} between its header and ` +
                       `footer, so it is drawn cut off`);
    }

    /*
     * How tall one instance of a band is.
     *
     * A number is the declared height and costs nothing to know -- which is what
     * made the measure pass pure, and what a report should still use for the
     * bands whose contents are one line of known text.
     *
     * **`Height: "Auto"` measures instead**, and it is the row with a
     * description in it that wants this: the band is as tall as the lowest
     * bottom its elements reach, `Padding` below that. It is possible at all
     * because text can be measured with no frame open (`Text.Size`); before that a
     * band could only ever be as tall as it was declared, and a description that
     * took three lines was cut off after one.
     *
     * The font an element that names none is measured in is `Text.Font` -- the
     * desktop's, which is what the canvas will draw it in. A drawing whose font
     * an `app.css` has changed is the one case where the two disagree.
     */
    bandHeight(band, ctx) {
        if (!band) return 0;
        if (band.Height !== "Auto") return this.height(band);

        let bottom = 0;
        for (const el of band.Elements || []) {
            /* **A hidden element is not there, and a measure that counted it
             * would make the band taller for something nobody can see** -- the
             * shape of bug a conditional style invites, and the reason `When` is
             * asked here and not only in the drawing. */
            if (!this.shown(el, ctx)) continue;
            bottom = Math.max(bottom, this.elementBottom(el, ctx));
        }

        return Math.ceil(bottom + (Number(band.Padding) || 0));
    }

    /* How far down an element reaches, in the band's own coordinates. A shape
     * knows its own size; a run of text is measured, wrapped to its `Width`
     * when it wraps -- the same call `drawElement` breaks the lines with, so the
     * height a band was given and the lines that land in it cannot disagree. */
    elementBottom(el, ctx) {
        const y = Number(el.Y) || 0;

        if (el.Kind === "Line")
            return Math.max(Number(el.Y1) || 0, Number(el.Y2) || 0);
        /* A picture's height is the one it was given: what it would be at its
         * natural size cannot be known without reading the file, and the
         * measure pass reads nothing. (`Probe.Image` is what would say it, and
         * the measure pass still reads nothing -- an image is placed, not
         * measured, which is the author's choice and stays one.) */
        if (el.Kind === "Box" || el.Kind === "Image") {
            /* **`"Band"` contributes nothing, because it *is* the band.** A box
             * as tall as the row it is in is the alternating shade a table of a
             * hundred rows wants, and adding its height to the measure would
             * make the band taller than itself. */
            if (el.Height === "Band") return 0;
            return y + (Number(el.Height) || 0);
        }
        if (el.Kind === "Input" || el.Kind === "Signature")
            return y + (Number(el.Height) || 24);

        const text = this.textOf(el, ctx);
        if (text === "") return y;

        const font  = el.Font || Text.Font;
        const width = Number(el.Width) || 0;

        return y + (el.Wrap && width > 0
            ? Text.Size(text, font, { Width: width }).Height
            : Text.Height(text, font));
    }

    /* Every field a `Total` element mentions, so the aggregates are computed
     * for exactly those and not for the whole row -- which would be wasted work
     * and, worse, would try to sum a name. */
    totalFields(sec) {
        const seen = [];
        const add = (f) => { if (f && !seen.includes(f)) seen.push(f); };

        for (const band of this.bandsOf(sec))
            for (const el of band.Elements || [])
                if (el.Kind === "Total") add(String(el.Field));
        return seen;
    }

    /* The aggregates over a list of rows.
     *
     * `Count` counts non-empty values. `Sum` keeps a `Decimal` exact -- money
     * that goes in as `Decimal` comes out as `Decimal`, summed with its own
     * arithmetic, and only falls back to the double when the values are plain
     * numbers or strings. `Min` and `Max` compare numerically -- and exactly --
     * when every value is a number, numeric text or a `Decimal`, and otherwise
     * as text with `Locale.Compare`: a date column's `Min` is the earliest date
     * (`"YYYY-MM-DD"` orders as text) and a name's is the first in this
     * desktop's alphabetical order. `Avg` is always a plain
     * number: an average has no exact decimal text, and how many places to
     * round it to is the caller's decision. */
    computeTotals(rows, fields) {
        const out = {};
        for (const f of fields) {
            let sum = null, count = 0, min = null, max = null, ncount = 0;

            /* **How `Min` and `Max` compare is decided once per field.** `<` over
             * the raw values was right for a column of one kind and wrong the
             * moment kinds met: `"10" < "9"` as text, `"Álvarez"` after
             * `"Zapata"` by code unit, a `Decimal` against numeric text by
             * whatever the operator made of it. Every value a number, numeric
             * text or a `Decimal` is a numeric column, compared exactly; anything
             * else is text, in the order this desktop puts names in. */
            const present = rows.map((r) => r[f])
                                .filter((v) => v !== undefined && v !== null && v !== "");
            const less = ReportDocument.orderFor(present);

            for (const row of rows) {
                const v = row[f];
                if (v === undefined || v === null || v === "") continue;
                count++;

                if (min === null || less(v, min)) min = v;
                if (max === null || less(max, v)) max = v;

                if (v instanceof Decimal) {
                    sum = sum === null ? v : sum + v;
                    ncount++;
                } else {
                    const n = Number(v);
                    if (isFinite(n)) { sum = sum === null ? n : sum + n; ncount++; }
                }
            }
            out[f] = { Sum: sum === null ? 0 : sum, Count: count,
                       Min: min, Max: max,
                       Avg: ncount ? Number(sum) / ncount : 0 };
        }
        return out;
    }

    /*
     * Whether two rows are in the same group at one level.
     *
     * **`===` is identity on an object**, and a `Decimal` is one: two rows of
     * `new Decimal("1.50")` were two groups, so a report grouped on a price or a
     * rate opened a new group for every row. Two decimals are the same key when
     * they are the same number; any other object is the same key when it writes
     * the same JSON (a `Date` writes its instant); everything else is `===`, with
     * NaN the same as NaN so a column of them is one group and not one each.
     */
    static sameKey(a, b) {
        if (a === b) return true;
        if (a instanceof Decimal && b instanceof Decimal) return !(a < b) && !(a > b);
        if (a instanceof Decimal || b instanceof Decimal) return false;
        if (typeof a === "number" && typeof b === "number") return a !== a && b !== b;
        if (a && b && typeof a === "object" && typeof b === "object")
            return JSON.stringify(a) === JSON.stringify(b);
        return false;
    }

    /* The `<` a field's `Min` and `Max` use -- see `computeTotals`. */
    static orderFor(values) {
        const numeric = (v) => v instanceof Decimal || (typeof v === "number" && isFinite(v)) ||
            (typeof v === "string" && v.trim() !== "" && isFinite(Number(v)));

        if (values.length && values.every(numeric)) {
            /* Exact: a `Decimal` against a `Decimal` is its own arithmetic, and
             * text is read as one when any value is -- a double would say
             * `"0.1000000000000000001"` equals `0.1`. */
            const anyDec = values.some((v) => v instanceof Decimal);
            const asNum = (v) => {
                if (v instanceof Decimal) return v;
                if (typeof v === "number") return v;   /* the operator mixes them */
                if (anyDec) { try { return new Decimal(v.trim()); } catch (e) { /* 1e3 */ } }
                return Number(v);
            };
            return (a, b) => asNum(a) < asNum(b);
        }
        return (a, b) => Locale.Compare(String(a), String(b)) < 0;
    }

    /* ------------------------------------------------------------- drawing
     *
     * One page, scaled to fit the frame and centred. `screen` is the control's
     * own frame, which is the only one that outlines the sheet: a file, a print
     * and a `Paint` are clean paper.
     */
    draw(p, number, width, height, screen) {
        if (!this._pages) this.measure();

        /* A report on a form that has nothing to show yet is a report with no
         * `Sections`, and it draws an empty sheet rather than throwing on every
         * frame -- which is what reading `this._sections.PageHeader` did. */
        const sec = this._sections || {};
        const [pw, ph] = this.paperSize();
        const m = this.margins();
        const page   = this._pages[number - 1] || this._pages[0];

        /* The whole page, scaled to fit the frame and centred.
         *
         * **`Translate` then `Scale`, and the order is load-bearing.** Cairo
         * post-multiplies, so the transform written *last* is the one applied
         * *first* to a point: `Scale` then `Translate` puts the page at
         * `scale * offset` and leaves it off-centre by everything the scale is
         * not 1 -- measured, and invisible in an export because the export's
         * offset is zero. Written this way a point lands at
         * `offset + scale * point`, which is what centring means. */
        const scale = Math.min(width / pw, height / ph);
        const ox = (width  - pw * scale) / 2;
        const oy = (height - ph * scale) / 2;

        p.Push();
        p.Translate(ox, oy);
        p.Scale(scale);

        this.sheet(p, pw, ph, screen);

        /* The font an element that names none is drawn in. **`Text.Font`, and
         * not `p.Font` -- and the difference is a bug this took a new test to
         * find.**
         *
         * `bandHeight` measures with `Text.Font`, in the measure pass, with no
         * painter anywhere near it (that is what lets pagination run in a console
         * program). So the drawing has to use the same one or an `Auto` band is
         * measured for one number of lines and drawn with another.
         *
         * It used to read the painter's own font, and the painter is **one per
         * control, reused across frames** -- `paint_frame` says so -- so `p.Font`
         * is whatever the *previous* frame last assigned. One element anywhere in
         * the report that names a `Font` therefore became the font of every
         * element that named none, on the next page and the next export: a
         * report whose text was measured in `Sans 10` and drawn in `Normal 12`,
         * wrapping into five lines into a band measured for four, with the row
         * below drawn *underneath* the one above. A CSS'd canvas had the same
         * effect by a different road, which is the case the old comment blamed
         * and the new one does not.
         *
         * **`Push`/`Pop` does not restore the font** -- it saves the colour, the
         * pen, the transform and the clip, and the font lives on the layout
         * instead -- so it is assigned per element, which is what keeps one
         * band's `Bold 18` out of the next one's rows *within* a frame. Between
         * frames the assignment above is what stops it leaking out of one. */
        const base = Text.Font;

        const ctx = { page: number, count: this._count };

        /* The content area, which is what `Width: "Band"` is: the author's
         * number for it goes stale the day the paper or the margins move. */
        const cw = pw - m.Left - m.Right;

        this.drawBand(p, sec.PageHeader, m.Left, m.Top, ctx, base, this._headerH, cw, screen);

        const top    = m.Top + this._headerH;
        const bottom = ph - m.Bottom - this._footerH;

        /* The flowing bands are clipped to the content area, so an element a
         * band holds cannot paint over the page footer or off the sheet. */
        p.Push();
        p.ClipRectangle(m.Left, top, cw, bottom - top);
        for (const b of page.bands)
            this.drawBand(p, b.band, m.Left, b.y,
                          { ...b.ctx, page: number, count: this._count }, base, b.h, cw,
                          screen);
        p.Pop();

        this.drawBand(p, sec.PageFooter, m.Left, bottom, ctx, base, this._footerH, cw, screen);

        p.Pop();
    }

    /* The sheet, on the canvas. White always, because it is paper; the thin
     * outline is for the screen only, so an exported PNG is clean paper. */
    sheet(p, pw, ph, screen) {
        p.Color = PAPER;
        p.Rectangle(0, 0, pw, ph);
        p.Fill();

        if (screen) {
            p.Color = "rgba(0,0,0,0.20)";
            p.LineWidth = 1;
            p.Rectangle(0.5, 0.5, pw - 1, ph - 1);
            p.Stroke();
        }
    }

    /* Every element gets its own `Push`/`Pop`, so one element's colour, pen or
     * clip can never leak into the next -- the same reason the sheet's state is
     * wrapped above. The font is not one of those and is passed in: see
     * `Canvas_Draw`. */
    drawBand(p, band, bx, by, ctx, base, bh, cw, screen) {
        if (!band) return;
        for (const el of band.Elements || []) {
            if (!this.shown(el, ctx)) continue;
            p.Push();
            this.drawElement(p, el, bx, by, ctx, base, bh, cw, screen);
            p.Pop();
        }
    }

    drawElement(p, el, bx, by, ctx, base, bh, cw, screen) {
        const x = bx + (Number(el.X) || 0);
        const y = by + (Number(el.Y) || 0);

        /* **`"Band"` is the band itself**, which is what a row's shade is: a box
         * with a height of its own cannot cover a row that wrapped to two lines,
         * so the one property that shades a whole row is the one that has to be
         * able to say "as tall as I am". Its width is the content area for the
         * same reason -- the author's number for it is right until the paper
         * moves. */
        const dim = (v, whole) => (v === "Band" ? whole : Number(v) || 0);

        if (el.Kind === "Line") {
            p.Color    = el.Color || INK;
            p.LineWidth = Number(el.Thickness) || 1;
            p.MoveTo(bx + (Number(el.X1) || 0), by + (Number(el.Y1) || 0));
            p.LineTo(bx + (Number(el.X2) || 0), by + (Number(el.Y2) || 0));
            p.Stroke();
            return;
        }

        if (el.Kind === "Box") {
            p.Color = this.paint(el.Color, ctx, INK);
            p.Rectangle(x, y, dim(el.Width, cw), dim(el.Height, bh));
            if (el.Fill) p.Fill(); else p.Stroke();
            return;
        }

        /* **The field's box, and nothing else in the PDF.** The widget PoDoFo
         * adds draws its own border and value; the static page only needs the
         * rectangle so a viewer without forms still shows where it goes. On
         * the designer it also names the field, which is the one place a
         * person has to be able to tell two empty boxes apart. */
        if (el.Kind === "Input" || el.Kind === "Signature") {
            const w = Number(el.Width)  || 120;
            const h = Number(el.Height) || 24;

            p.Color     = this.paint(el.Color, ctx, "rgba(0,0,0,0.55)");
            p.LineWidth = 0.6;
            p.Rectangle(x, y, w, h);
            p.Stroke();

            if (screen) {
                p.Font  = "Sans 8";
                p.Color = "rgba(0,0,0,0.45)";
                p.Text(`${el.Kind === "Signature" ? "Signature" : (el.Input || "Text")}: ${el.Name || ""}`,
                       x + 4, y + 12);
            }
            return;
        }

        /* The masthead, or the chart this report drew. `File` is the
         * application's own path -- relative to the project, because a report
         * is declared in a project and its logo sits beside its forms -- and
         * `Bytes` are the picture already in memory. One of `Width`/`Height`
         * is enough: the other follows the picture's proportions. A file that
         * is missing or is not an image throws, here, rather than drawing a
         * blank where a logo goes. */
        if (el.Kind === "Image") {
            const source = el.Bytes !== undefined ? el.Bytes : String(el.File);
            p.Image(typeof source === "string" && !File.IsAbsolute(source)
                         ? File.Join(Application.Directory, source) : source,
                    x, y, Number(el.Width) || undefined, Number(el.Height) || undefined);
            return;
        }

        const text = this.textOf(el, ctx);
        if (text === "") return;

        /* Assigned either way round: the element's font, or the one it started
         * with. A bare `if (el.Font)` leaves whatever the last element set. */
        const font = this.paint(el.Font, ctx, base);
        p.Font  = font;
        p.Color = this.paint(el.Color, ctx, INK);

        const width  = Number(el.Width)  || 0;
        const height = Number(el.Height) || 0;
        /* **The lines come from `Text.Lines`, not from a loop over `TextWidth`
         * here**, and that is what keeps a band that grew to fit its text and
         * the text that lands in it from disagreeing: `bandHeight` measured the
         * same call. Pango breaks a word too long for the box rather than
         * overflowing it, which the hand-rolled version could not. */
        const lines  = (el.Wrap && width > 0) ? Text.Lines(text, font, { Width: width })
                                              : [text];
        const lh     = Text.Height("0", font);

        /* A wrapped run that outgrows its declared height is cut off there: a
         * band cannot grow -- see the header -- so clipping is the honest
         * answer where spilling into the band below would overlap it. */
        if (el.Wrap && height > 0 && lines.length * lh > height)
            p.ClipRectangle(x, y, width, height);

        for (let i = 0; i < lines.length; i++) {
            const w = p.TextWidth(lines[i]);
            let tx = x;
            if (el.Align === "Center") tx += (width - w) / 2;
            else if (el.Align === "Right") tx += width - w;
            p.Text(lines[i], tx, y + i * lh);
        }
    }

    /*
     * Whether an element is drawn at all.
     *
     * `When` is a condition on the row, and it is the third thing a detail band
     * could not do: everything else about a row is a *value* (`Field`'s text, a
     * `Total`'s aggregate), so the severity of a row could be a word in a column
     * and nothing else. What a reader of a table wants is a row that *looks*
     * like what it holds -- shaded, coloured, badged -- and Crystal Reports and
     * JasperReports both made conditional formatting and a suppressible object
     * the ordinary case years ago.
     *
     * Four shapes, all of them data, because `Sections` is written in code and
     * nothing here is a function that has to be closed over:
     *
     *   `true` / `false`           always, never
     *   `"@Odd"` / `"@Even"`       the row's position in the detail run
     *   `"@First"` / `"@Last"`     the first row, the last one
     *   `{ Field, Is: v }`         the row's `Field` **is** `v`
     *   `{ Field, IsNot: v }`      ...and is not
     *
     * **The stripe is continuous across pages**, which is why the position is
     * the row's index in the whole run and not its index on the sheet: it is one
     * number, written once in the measure pass and carried in the band's context,
     * and a page that happens to start on an even row simply begins unshaded.
     * Restarting per page would mean predicting the break in the measure pass to
     * know the number, and two readers of one page break is the shape of bug this
     * file keeps warning about.
     *
     * **`===`, and nothing else.** `"No"` is not `false` and `0` is not `""`, so
     * a row of `Ack: false` is written `Is: false`. Coercing here would be a
     * second spelling of every comparison in the language and a place for one of
     * them to be wrong.
     *
     * **A band with no row has no position**, so the four `@` names are false
     * there -- which is the answer, not a crash: a page header is not the second
     * row of anything.
     */
    shown(el, ctx) {
        const w = el.When;

        if (w === undefined || w === null || w === true) return true;
        if (w === false) return false;

        if (typeof w === "string") {
            if (ctx.at === undefined) return false;
            if (w === "@Odd")   return ctx.at % 2 === 1;
            if (w === "@Even")  return ctx.at % 2 === 0;
            if (w === "@First") return ctx.at === 1;
            if (w === "@Last")  return ctx.last === true;
            return true;            /* refused where it was written; see checkSections */
        }

        const v = (ctx.row || {})[w.Field];

        return w.Is !== undefined ? v === w.Is : v !== w.IsNot;
    }

    /*
     * A colour or a font that the row says.
     *
     * `{ Field: "SeverityColor" }` is the whole of it, and it is what makes the
     * colour *the row's* rather than the section's: a report that has a computed
     * field carrying it is easy to supply, and what was missing was an element
     * that could read one for something other than its text. `Color` and `Font`
     * are the two that are appearance, so they are the two that take it.
     *
     * **A field that is missing leaves the fallback**, which is what a caller
     * wants for a row that has no severity: the section's ink, not `undefined`
     * handed to cairo. And the fallback is passed in rather than read from the
     * caller's default, so `Font` still arrives as the canvas's own.
     */
    paint(v, ctx, fallback) {
        const raw = (v && typeof v === "object" && !Array.isArray(v) && v.Field !== undefined)
            ? (ctx.row || {})[v.Field]
            : v;

        return (raw === undefined || raw === null || raw === "") ? fallback : String(raw);
    }

    /* What the element says. A `Text` is its own words; a `Field` reads the row
     * (or `@Page` / `@Pages`); a `Total` reads the aggregate the band's context
     * carries -- a group footer's totals for a group footer, the report's for
     * the report footer. The *band it sits in* is the scope, which is why a
     * `Total` has no `Scope` of its own to disagree with it. */
    textOf(el, ctx) {
        if (el.Kind === "Text")
            return String(el.Text === undefined ? "" : el.Text);
        if (el.Kind === "Input" || el.Kind === "Signature")
            return "";

        let v;
        if (el.Kind === "Field") {
            if (el.Field === "@Page")  return String(ctx.page);
            if (el.Field === "@Pages") return String(ctx.count);
            v = ctx.row ? ctx.row[el.Field] : undefined;
        } else {
            const t = ctx.totals ? ctx.totals[el.Field] : undefined;
            v = t ? t[el.Op || "Sum"] : undefined;
        }
        return this.format(el, v);
    }

    /* A value in the spelling the element asks for. `""` is as it stands;
     * everything else goes through `Locale`, so the separators and the date are
     * the user's. A `Decimal` is passed through untouched -- `Locale` writes it
     * from its own digits, never through a double -- which is the other half of
     * the exact-money story, beside the `Sum` above. */
    format(el, v) {
        if (v === undefined || v === null || v === "") return "";

        const f = el.Format || "";
        if (f === "Date")    return Locale.Date(v);
        if (f === "Money")   return Locale.Currency(this.num(v), el.Decimals === undefined ? 2 : el.Decimals);
        if (f === "Number")  return Locale.Number(this.num(v), el.Decimals === undefined ? 0 : el.Decimals);
        if (f === "Percent") return Locale.Number(this.num(v), el.Decimals === undefined ? 1 : el.Decimals) + "%";
        return String(v);
    }

    num(v) { return v instanceof Decimal ? v : Number(v); }
}
