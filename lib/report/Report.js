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
 * or the bytes themselves -- the masthead every real report carries, and the
 * chart a report drew a moment ago (`ChartDocument.ToPng()`). **`File` is the
 * name and `Bytes` the value**, exactly one of the two: a name round-trips and
 * resolves against the project, and bytes are what a runtime picture is. */
const KINDS   = ["Text", "Field", "Total", "Line", "Box", "Image"];
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
class ReportDocument {

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
     * in it is text. **No widget and no display**: it draws through `Drawing`,
     * which is what lets a `main` project — a report run from a timer — write
     * one. A page that throws leaves no file
     */
    SavePdf(path) {
        const [w, h] = this.paperSize();

        Drawing.SavePdf(path, Math.round(w), Math.round(h), this.PageCount || 1,
                        (p, page, pw, ph) => this.draw(p, page, pw, ph, false));
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
                if (el.Kind === "Image" && !el.File && !el.Bytes)
                    throw new Error(`Sections.${where}: an Image element needs a File or Bytes`);
                if (el.Kind === "Image" && el.File && el.Bytes)
                    throw new Error(`Sections.${where}: an Image element takes a File or Bytes, not both`);

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

        this.drawBand(p, sec.PageHeader, m.Left, m.Top, ctx, base, this._headerH, cw);

        const top    = m.Top + this._headerH;
        const bottom = ph - m.Bottom - this._footerH;

        /* The flowing bands are clipped to the content area, so an element a
         * band holds cannot paint over the page footer or off the sheet. */
        p.Push();
        p.ClipRectangle(m.Left, top, cw, bottom - top);
        for (const b of page.bands)
            this.drawBand(p, b.band, m.Left, b.y,
                          { ...b.ctx, page: number, count: this._count }, base, b.h, cw);
        p.Pop();

        this.drawBand(p, sec.PageFooter, m.Left, bottom, ctx, base, this._footerH, cw);

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
    drawBand(p, band, bx, by, ctx, base, bh, cw) {
        if (!band) return;
        for (const el of band.Elements || []) {
            if (!this.shown(el, ctx)) continue;
            p.Push();
            this.drawElement(p, el, bx, by, ctx, base, bh, cw);
            p.Pop();
        }
    }

    drawElement(p, el, bx, by, ctx, base, bh, cw) {
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

        /* The masthead, or the chart this report drew. `File` is the
         * application's own path -- relative to the project, because a report
         * is declared in a project and its logo sits beside its forms -- and
         * `Bytes` are the picture already in memory. One of `Width`/`Height`
         * is enough: the other follows the picture's proportions. A file that
         * is missing or is not an image throws, here, rather than drawing a
         * blank where a logo goes. */
        if (el.Kind === "Image") {
            const source = el.Bytes !== undefined ? el.Bytes : String(el.File);
            p.Image(typeof source === "string" && !source.startsWith("/")
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

/*
 * **The control: a page you can turn.** What a report is lives in its
 * `Document`; this shows one page of it at a time, says when the pages moved,
 * and prints through the print dialog. Every property of the document is here
 * too, under the same name, so a form that has always set `Report1.Data` goes
 * on doing so.
 */
class Report extends Component {

    /* Page(page)
     *   the data moved the current page: `Data`, `Sections` or `Refresh()` left
     *   fewer pages than `Page`, and it was pulled back inside the new count.
     *   `page` is one-based. **Assigning `Page` raises nothing** — a property
     *   setter must not, since a `.form` declaring it would raise it before the
     *   host's other controls exist — so the code that turns a page updates its
     *   own display. The paper, the orientation and the margins pull the page
     *   back silently too
     */
    /* Prepared(count)
     *   the pages were computed: `Data`, `Sections` or `Refresh()`. `count` is
     *   the new `PageCount`. Changing the paper, the orientation or the margins
     *   re-measures **silently** — read `PageCount` back on the next line —
     *   because those can be written in a `.form`, and an event raised while a
     *   form is loading arrives before the form's other controls exist
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
     * See below. Defaults to `{}`.
     */
    get Sections() { return this.Document.Sections; }
    set Sections(v) { this.Document.Sections = v; this.Refresh(); }

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
     * controls exist* -- measured, and the reason is in `AGENTS.md`. `Data` and
     * `Sections` are only ever assigned from code, so nothing here can fire
     * during a load; `Paper`, `Orientation` and `Margins` can be written in a
     * `.form`, so they re-measure silently and a host that changes one reads
     * `PageCount` back on the next line. */
    /**
     * re-measures, redraws and emits `Prepared`. Call it when you changed the
     * rows **in place**; assigning `Data` or `Sections` already does
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
     * in it is text; the pages are the ones the last measure worked out. This
     * is what a report is for — `Save` is for when one page is going into
     * something else. With no display, `Document.SavePdf` is the same file
     */
    SavePdf(path) {
        const [w, h] = this.Document.paperSize();
        this.Canvas.SavePdf(path, Math.round(w), Math.round(h), this.PageCount || 1);
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
