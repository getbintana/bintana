/*
 * A banded report, as a component.
 *
 * `Report` is what Crystal Reports calls a *report definition*: content arranged
 * in **bands** -- page header and footer, nested group headers and footers, a
 * detail band that repeats once per row, and the report's own header and footer
 * -- laid out over **pages** of a fixed paper size. It is reached the way any
 * library is (`uses: ["report"]`), declared in code the way a chart's `Series`
 * is, and it draws with the same `Painter` every other drawing here uses. There
 * is no designer: what a band contains is written down, not dragged.
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
 * **This library declares no paper table.** It had one, and so did
 * `lib/markdown` -- the same three sizes, written out identically -- and two
 * top-level `const PAPERS` in one global scope is a project that names both of
 * them failing to start at all: `SyntaxError: redeclaration of 'PAPERS'`, on
 * line 1 of a file its author never wrote. The libraries share the project's
 * global scope, so a name declared here is a name no other library may use.
 *
 * `Printer.Papers` is the one table, read off GTK rather than written out a
 * third time, and it is asked for where it is needed: 3.7 us a lookup,
 * measured, against nine lookups that all happen when a property is assigned
 * or a document is exported.
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
 * -- the masthead every real report carries. */
const KINDS   = ["Text", "Field", "Total", "Line", "Box", "Image"];
const OPS     = ["Sum", "Count", "Min", "Max", "Avg"];
const FORMATS = ["", "Number", "Money", "Date", "Percent"];
const ALIGNS  = ["Left", "Center", "Right"];

class Report extends Component {

    static Events  = ["Page", "Prepared"];
    static Options = {
        Paper:       ["A4", "Letter", "A5"],
        Orientation: ["Portrait", "Landscape"],
    };

    /* ---------------------------------------------------------------- fields
     *
     * **Declared, because a component is sealed once it is built** under
     * `--strict` (`docs/strict-plan.md`): a field this class only creates the
     * first time it paginates is an attempt to add a name to a sealed object,
     * and `PageCount` on a strict run threw before this block existed.
     *
     * **Without values**: what each one means while it is unset is written in
     * the getter that reads it (`this._data || []`, `this._page || 1`), and a
     * default said twice is one that will disagree with itself.
     */

    /* What the properties keep. */
    _paper; _orientation; _margins; _data; _sections; _page;

    /* What `measure()` leaves behind: the pages and the two band heights every
     * one of them is laid out between. */
    _pages; _count; _headerH; _footerH;

    /* Which page `Save` is drawing, and `undefined` at every other moment --
     * the one thing that tells `Canvas_Draw` it is not painting the screen. */
    _saving;

    /* ------------------------------------------------------------ properties
     *
     * Ordinary accessors, which is what makes them designable and serialisable;
     * every one of them ends in a `Refresh()`, because a report whose data
     * changed and whose pages did not is the first bug anybody writes here.
     */

    get Paper() { return this._paper || "A4"; }
    set Paper(v) {
        if (!Printer.Papers[String(v)])
            throw new Error(`Paper: '${v}' is not one of ${Dictionary.Keys(Printer.Papers).join(", ")}`);
        this._paper = String(v);
        this.remeasure();
    }

    get Orientation() { return this._orientation || "Portrait"; }
    set Orientation(v) {
        if (v !== "Portrait" && v !== "Landscape")
            throw new Error(`Orientation: '${v}' is not Portrait or Landscape`);
        this._orientation = String(v);
        this.remeasure();
    }

    /* The gutter around the content, in points: a single number for all four
     * edges, or `{ Top, Right, Bottom, Left }`. What flows sits inside it. */
    get Margins() { return this._margins === undefined ? 40 : this._margins; }
    set Margins(v) {
        if (typeof v === "number" && isFinite(v)) { this._margins = v; this.remeasure(); return; }
        if (v && typeof v === "object" && !Array.isArray(v)) {
            this._margins = {
                Top:    Number(v.Top    === undefined ? 40 : v.Top),
                Right:  Number(v.Right  === undefined ? 40 : v.Right),
                Bottom: Number(v.Bottom === undefined ? 40 : v.Bottom),
                Left:   Number(v.Left   === undefined ? 40 : v.Left),
            };
            this.remeasure();
            return;
        }
        throw new Error("Margins expects a number or { Top, Right, Bottom, Left }");
    }

    /* The current page, one-based. Setting it clamps to `[1, PageCount]`, so a
     * `Page` past the end is the last page and not a blank one.
     *
     * **Turning a page redraws and does not measure.** That is the whole point
     * of the two passes: the pages were worked out when the data arrived, and
     * this only chooses which of them to paint. */
    get Page() { return this._page || 1; }
    set Page(v) {
        const n = Math.max(1, Math.min(this.PageCount || 1, Math.round(Number(v) || 1)));
        if (n === this._page && this._pages) return;
        this._page = n;
        this.redraw();
        this.Emit("Page", n);
    }

    /* The rows. Each is an ordinary object, and `Field` elements read it by
     * key; the group bands read the keys named by each group's `.On`. */
    get Data() { return this._data || []; }
    set Data(v) {
        if (!Array.isArray(v)) throw new Error("Data expects an array of rows");
        this._data = v;
        this.Refresh();
    }

    /* The band definitions -- the whole of what a report *is*, besides the
     * numbers. See the header of `docs/llm/report.md` for the shape. */
    get Sections() { return this._sections || {}; }
    set Sections(v) {
        if (!v || typeof v !== "object" || Array.isArray(v))
            throw new Error("Sections expects an object of bands");
        this._sections = this.checkSections(v);
        this.Refresh();
    }

    /* How many pages the last measure produced. Read it after `Data` and
     * `Sections` are in place; it measures lazily so a form can ask in
     * `Form_Open`, before anything has drawn. */
    get PageCount() {
        if (!this._pages) this.measure();
        return this._count || 0;
    }

    /* Re-measure, redraw, and say so. This is what `Data` and `Sections` do,
     * and what a host calls when it changed the rows in place.
     *
     * **`Prepared` is emitted here and not in `remeasure`**, and that is a
     * deliberate line rather than tidiness: an event emitted while a `.form` is
     * being applied reaches the host's handler *before the host's other
     * controls exist* -- measured, and the reason is in `AGENTS.md`. `Data` and
     * `Sections` are only ever assigned from code, so nothing here can fire
     * during a load; `Paper`, `Orientation` and `Margins` can be written in a
     * `.form`, so they re-measure silently and a host that changes one reads
     * `PageCount` back on the next line. */
    Refresh() {
        this.remeasure();
        this.Emit("Prepared", this._count);
    }

    /* The pages again, and the current one kept inside them. A report whose
     * data shrank under its own `Page` would otherwise paint page 1 while its
     * footer said "6 of 1" -- so the page moving is a real move and is
     * reported as one. */
    remeasure() {
        this.measure();

        const had = this._page;
        const now = Math.max(1, Math.min(this._count || 1, had || 1));

        this._page = now;
        this.redraw();
        if (had !== undefined && now !== had) this.Emit("Page", now);
    }

    /* Paint again with what the last measure worked out. The `Canvas` is not
     * there yet while the component's own `.form` is being read. */
    redraw() { if (this.Canvas) this.Canvas.Redraw(); }

    /* One page to a PNG. `page` defaults to the current one, `scale` to 2 (so an
     * A4 page is a 1190px-wide PNG at 144 dpi). The export runs the same `Draw`
     * at the exact paper size, so the fit-to-frame logic below lands on exactly
     * the requested scale. */
    Save(path, page, scale) {
        const n = page === undefined ? this.Page
                   : Math.max(1, Math.min(this.PageCount || 1, Math.round(Number(page) || 1)));
        const s = Math.max(0.1, Number(scale) || 2);
        const [w, h] = this.paperSize();

        this._saving = n;
        try { this.Canvas.Save(path, Math.round(w * s), Math.round(h * s)); }
        finally { this._saving = undefined; }
    }

    /* Every page, one file.
     *
     * A report is a document and a document leaves the application as one thing:
     * this is what `Save` could not do and what the fourteen numbered PNGs were
     * standing in for. The pages are the ones the measure already worked out, the
     * surface is the paper's exact size in points, so the fit-to-frame lands at
     * scale 1 -- and the PDF holds text as text and lines as lines, because the
     * same `Draw` is running against a vector surface.
     */
    SavePdf(path) {
        const [w, h] = this.paperSize();
        const pages  = this.PageCount || 1;

        try {
            this.Canvas.SavePdf(path, Math.round(w), Math.round(h), pages,
                                (page) => { this._saving = page; });
        } finally {
            this._saving = undefined;
        }
    }

    /* To paper, through the print dialog.
     *
     * One line of its own, and the rest is [`Printer`](../../docs/reference/globals/Printer.md):
     * this fills in what the report knows -- how many pages there are, and the
     * paper and orientation it was laid out for -- and `{ Copies, From, To }`
     * say the rest. The answer is the dialog's (`{ Copies, From, To }`, or
     * `null` when it was cancelled).
     *
     * **To a file it is `SavePdf`**, which this report already has: a PDF is
     * not a printer with a `Copies` of 3, and `Printer` is split into two verbs
     * for exactly that reason.
     */
    Send(setup) {
        const o = setup === undefined || setup === null ? {} : setup;
        if (typeof o !== "object" || Array.isArray(o))
            throw new Error("Send expects a setup object");

        const opts = { Pages:       this.PageCount || 1,
                       Paper:       this.Paper,
                       Orientation: this.Orientation };
        if (o.Copies !== undefined) opts.Copies = o.Copies;
        if (o.From !== undefined)   opts.From   = o.From;
        if (o.To !== undefined)     opts.To     = o.To;

        return Printer.Send(this.Canvas, opts);
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
                if (el.Kind === "Image" && !el.File)
                    throw new Error(`Sections.${where}: an Image element needs a File`);
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

    /* Which page the draw is for. `_saving` is the export's override: `Save`
     * runs the same `Canvas_Draw`, and the only difference between a screen
     * frame and a PNG is which page it wants. */
    pageNumber() { return this._saving || this.Page; }

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
        const rows = this._data || [];
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
                while (d < groups.length && key[d] === prev[d]) d++;

                for (let l = groups.length - 1; l >= d; l--) closeLevel(l, prev[l]);
                for (let l = d; l < groups.length; l++) openLevel(l, key[l]);
            }

            /* A row belongs to every group it sits inside, so it is counted at
             * each level -- the outer total is the sum of its inner groups. */
            for (let l = 0; l < groups.length; l++) levelRows[l].push(row);
            allRows.push(row);
            flow(sec.Detail, { row });
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
        for (const el of band.Elements || [])
            bottom = Math.max(bottom, this.elementBottom(el, ctx));

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
         * measure pass reads nothing. */
        if (el.Kind === "Box" || el.Kind === "Image")
            return y + (Number(el.Height) || 0);

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
     * numbers or strings. `Min` and `Max` compare the raw values, so a date
     * column's `Min` is the earliest date (`"YYYY-MM-DD"` orders lexically)
     * and a name's `Min` is the first alphabetically. `Avg` is always a plain
     * number: an average has no exact decimal text, and how many places to
     * round it to is the caller's decision. */
    computeTotals(rows, fields) {
        const out = {};
        for (const f of fields) {
            let sum = null, count = 0, min = null, max = null, ncount = 0;
            for (const row of rows) {
                const v = row[f];
                if (v === undefined || v === null || v === "") continue;
                count++;

                if (min === null || v < min) min = v;
                if (max === null || v > max) max = v;

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
     * report having to set a field first and hope. `_saving` is the frame's own
     * for the length of the frame and nothing after it.
     */
    Canvas_DrawPage(p, page, width, height) {
        const was = this._saving;

        this._saving = page;
        try { this.Canvas_Draw(p, width, height); }
        finally { this._saving = was; }
    }

    Canvas_Draw(p, width, height) {
        if (!this._pages) this.measure();

        /* A report on a form that has nothing to show yet is a report with no
         * `Sections`, and it draws an empty sheet rather than throwing on every
         * frame -- which is what reading `this._sections.PageHeader` did. */
        const sec = this._sections || {};
        const [pw, ph] = this.paperSize();
        const m = this.margins();
        const number = this.pageNumber();
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

        this.sheet(p, pw, ph);

        /* The font an element that names none is drawn in -- the widget's own,
         * read once here. **`Push`/`Pop` does not restore the font**: it saves
         * the colour, the pen, the transform and the clip, and the font lives
         * on the layout instead. Carrying it down and assigning it per element
         * is what keeps one band's `Bold 18` out of the next one's rows. */
        const base = p.Font;

        const ctx = { page: number, count: this._count };

        this.drawBand(p, sec.PageHeader, m.Left, m.Top, ctx, base);

        const top    = m.Top + this._headerH;
        const bottom = ph - m.Bottom - this._footerH;

        /* The flowing bands are clipped to the content area, so an element a
         * band holds cannot paint over the page footer or off the sheet. */
        p.Push();
        p.ClipRectangle(m.Left, top, pw - m.Left - m.Right, bottom - top);
        for (const b of page.bands)
            this.drawBand(p, b.band, m.Left, b.y,
                          { ...b.ctx, page: number, count: this._count }, base);
        p.Pop();

        this.drawBand(p, sec.PageFooter, m.Left, bottom, ctx, base);

        p.Pop();
    }

    /* The sheet, on the canvas. White always, because it is paper; the thin
     * outline is for the screen only, so an exported PNG is clean paper. */
    sheet(p, pw, ph) {
        p.Color = PAPER;
        p.Rectangle(0, 0, pw, ph);
        p.Fill();

        if (!this._saving) {
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
    drawBand(p, band, bx, by, ctx, base) {
        if (!band) return;
        for (const el of band.Elements || []) {
            p.Push();
            this.drawElement(p, el, bx, by, ctx, base);
            p.Pop();
        }
    }

    drawElement(p, el, bx, by, ctx, base) {
        const x = bx + (Number(el.X) || 0);
        const y = by + (Number(el.Y) || 0);

        if (el.Kind === "Line") {
            p.Color    = el.Color || INK;
            p.LineWidth = Number(el.Thickness) || 1;
            p.MoveTo(bx + (Number(el.X1) || 0), by + (Number(el.Y1) || 0));
            p.LineTo(bx + (Number(el.X2) || 0), by + (Number(el.Y2) || 0));
            p.Stroke();
            return;
        }

        if (el.Kind === "Box") {
            p.Color = el.Color || INK;
            p.Rectangle(x, y, Number(el.Width) || 0, Number(el.Height) || 0);
            if (el.Fill) p.Fill(); else p.Stroke();
            return;
        }

        /* The masthead. `File` is the application's own path -- relative to the
         * project, because a report is declared in a project and its logo sits
         * beside its forms -- and one of `Width`/`Height` is enough: the other
         * follows the picture's proportions. A file that is missing or is not an
         * image throws, here, rather than drawing a blank where a logo goes. */
        if (el.Kind === "Image") {
            const file = String(el.File);
            p.Image(file.startsWith("/") ? file : File.Join(Application.Directory, file),
                    x, y, Number(el.Width) || undefined, Number(el.Height) || undefined);
            return;
        }

        const text = this.textOf(el, ctx);
        if (text === "") return;

        /* Assigned either way round: the element's font, or the one it started
         * with. A bare `if (el.Font)` leaves whatever the last element set. */
        const font = el.Font || base;
        p.Font  = font;
        p.Color = el.Color || INK;

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

    /* What the element says. A `Text` is its own words; a `Field` reads the row
     * (or `@Page` / `@Pages`); a `Total` reads the aggregate the band's context
     * carries -- a group footer's totals for a group footer, the report's for
     * the report footer. The *band it sits in* is the scope, which is why a
     * `Total` has no `Scope` of its own to disagree with it. */
    textOf(el, ctx) {
        if (el.Kind === "Text")
            return String(el.Text === undefined ? "" : el.Text);

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
