/*
 * `lib/report`, held to what [docs/llm/report.md](../../docs/llm/report.md)
 * promises.
 *
 * **Everything here is synchronous, and that is the whole trick.** `Save()` runs
 * the same `Canvas_Draw` against an image surface and returns, so
 * `Canvas.Dump()` on the line after it is *that page's* calls -- which is how a
 * banded document is asserted without a screen and without waiting for a frame.
 * A test that waited for a real frame could only ever see the current page.
 *
 * Five of these assertions are regressions, and each one shipped once:
 *
 *   - a report drew every band in whatever font the last one declared, because
 *     `Push`/`Pop` restores the colour, the pen, the transform and the clip and
 *     **not the font**;
 *   - the preview was off-centre, because `Scale` before `Translate` offsets the
 *     page by `scale * offset` -- invisible in an export, whose offset is zero;
 *   - a `Report` with no `Sections` threw `cannot read property 'PageHeader' of
 *     undefined` on every frame, which is any report on a form that has nothing
 *     to show yet;
 *   - `Page` stayed past the end when the data shrank under it, so page 1 was
 *     painted while the footer said "6 of 1";
 *   - `Prepared` did not fire when the data changed and the count did not.
 *
 * And three of them are runtime features this library asked for and was given --
 * a masthead (`Painter.Image`), a band that grows to fit its text
 * (`Text.Size`, and `Height: "Auto"` over it) and a document rather than a pile
 * of pictures (`SavePdf`). They are asserted here the same way: off the page,
 * not off the API.
 */
"use strict";

/* Tagged with what the runner passed -- its pid -- so two suites at once do not
 * share a scratch directory.  See tests/run.sh. */
const SCRATCH = `/tmp/bta-test-report${Application.Arguments[0] ? `-${Application.Arguments[0]}` : ""}`;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail ? `${name}: ${detail}` : name);
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function throws(name, fn) {
    try {
        fn();
        failures.push(`${name}: expected a throw, none happened`);
    } catch (e) {
        passed++;
    }
}

/* Rows in `count` consecutive groups of `per`, which is what makes the group
 * ladder and the page breaks predictable to the point. */
function rows(groups, per) {
    const out = [];
    for (let g = 0; g < groups; g++)
        for (let i = 0; i < per; i++)
            out.push({ G: `g${g}`, T: `row ${g}.${i}`, N: new Decimal("1.05") });
    return out;
}

/* One detail band and nothing else: the plainest report there is, and the one
 * whose arithmetic a person can do in their head. A4 portrait is 842pt tall,
 * a 40pt margin each end leaves 762, and a 100pt band means seven to a page. */
const PLAIN = {
    Detail: { Height: 100, Elements: [{ Kind: "Field", Field: "T", X: 0, Y: 0 }] },
};

class ReportTest extends Form {

    /* What the report said, in order, so an event that did not happen fails as
     * loudly as one that happened twice. */
    Rep_Prepared(count) { this.prepared.push(count); }
    Rep_Page(page)      { this.moved.push(page); }

    Form_Open() {
        this.prepared = [];
        this.moved    = [];
        this.errors   = [];
        Directory.Make(SCRATCH);

        /*
         * **Taken over before anything throws on purpose.** Two tests here draw
         * a band whose image is not there, which is an uncaught error inside a
         * `Draw`; with no handler set that opens a modal alert, and the reporter
         * opens no second one until the first is dismissed -- so every later
         * error in the run would be swallowed, and it is another project's test
         * of *that* which would fail. It also makes the message assertable.
         */
        Application.OnError = (message) => this.errors.push(message);

        try {
            this.testDefaults();
            this.testRefuses();
            this.testPagination();
            this.testPageAndEvents();
            this.testBands();
            this.testGroups();
            this.testTotals();
            this.testFont();
            this.testTransform();
            this.testImage();
            this.testAuto();
            this.testSave();
            this.testPdf();
            this.testPrint();
            this.testExtremes();
            this.testCharts();
        } catch (e) {
            failures.push(`uncaught: ${e.message}\n${e.stack || ""}`);
        }

        this.finish();
    }

    /* ------------------------------------------------------------- helpers
     *
     * `page(n)` draws one page and hands back what it drew. The PNG it writes on
     * the way is the point of `Save` and is asserted separately; here it is the
     * cheapest way to open a frame.
     */
    page(n) {
        this.Rep.Save(File.Join(SCRATCH, `page-${n}.png`), n, 1);
        return this.Rep.Canvas.Dump().split("\n");
    }

    /* The words a dump put on the page, in order. */
    texts(lines) {
        return lines.filter((l) => l.startsWith("Text \""))
                    .map((l) => l.slice(6, l.lastIndexOf("\" at (")));
    }

    /* ------------------------------------------------------------ defaults */
    testDefaults() {
        eq("Paper defaults to A4",         this.Rep.Paper, "A4");
        eq("Orientation defaults Portrait", this.Rep.Orientation, "Portrait");
        eq("Margins default to 40",        this.Rep.Margins, 40);
        eq("Page starts at 1",             this.Rep.Page, 1);
        eq("Data starts empty",            this.Rep.Data.length, 0);

        /* Nothing to show is one blank sheet, not zero pages: `Page` is
         * one-based and a report with no pages would have nowhere to be. */
        eq("an empty report is one page", this.Rep.PageCount, 1);

        /* The frame that used to throw: no `Sections` at all, which is any
         * report on a form that has nothing to show yet.
         *
         * **What proves a frame ran is the dump**, not `Save` returning: it
         * clips the content area on the way in and closes the state it opened on
         * the way out, and a frame that died halfway has neither. This was
         * written when a throwing `Draw` could not be seen from outside at all
         * -- `Save` fails now -- and it is still the assertion that tells a
         * frame that *finished* from one that merely did not throw. */
        this.Rep.Save(File.Join(SCRATCH, "empty.png"), 1, 1);
        const empty = this.Rep.Canvas.Dump().split("\n").filter((l) => l !== "");

        check("a report with no Sections draws a whole frame",
              empty.some((l) => l.startsWith("ClipRectangle")) &&
              empty[empty.length - 1] === "Pop",
              empty.join(" | "));
    }

    /* -------------------------------------------------------- what it refuses
     *
     * A typo in a band name or an option is a value that silently renders blank,
     * so every one of them is refused where it was written.
     */
    testRefuses() {
        throws("Paper refuses an unknown size",   () => { this.Rep.Paper = "Foolscap"; });
        throws("Orientation refuses a third way", () => { this.Rep.Orientation = "Sideways"; });
        throws("Margins refuse a string",         () => { this.Rep.Margins = "wide"; });
        /* The object form used to take `Number` of each side, and a NaN margin
         * draws nothing at all. */
        throws("a margin side that is not a number is refused",
               () => { this.Rep.Margins = { Top: "x" }; });
        throws("and one that is not finite",
               () => { this.Rep.Margins = { Bottom: Infinity }; });
        throws("Data refuses a non-array",        () => { this.Rep.Data = "rows"; });
        throws("Sections refuse an array",        () => { this.Rep.Sections = []; });

        throws("an unknown band is refused",
               () => { this.Rep.Sections = { Middle: { Height: 10, Elements: [] } }; });
        throws("an unknown element kind is refused",
               () => { this.Rep.Sections = { Detail: { Height: 10, Elements: [{ Kind: "Barcode" }] } }; });
        throws("an unknown Op is refused",
               () => { this.Rep.Sections = { Detail: { Height: 10,
                       Elements: [{ Kind: "Total", Field: "N", Op: "Median" }] } }; });
        throws("an unknown Format is refused",
               () => { this.Rep.Sections = { Detail: { Height: 10,
                       Elements: [{ Kind: "Field", Field: "N", Format: "Roman" }] } }; });
        throws("an unknown Align is refused",
               () => { this.Rep.Sections = { Detail: { Height: 10,
                       Elements: [{ Kind: "Text", Text: "x", Align: "Justify" }] } }; });
        throws("a group with no On is refused",
               () => { this.Rep.Sections = { Groups: [{ Header: { Height: 10, Elements: [] } }] }; });
        throws("Groups refuse a single group",
               () => { this.Rep.Sections = { Groups: { On: "G" } }; });

        /* Refused means unchanged: the report still has the paper it had. */
        eq("a refused Paper left the old one", this.Rep.Paper, "A4");
    }

    /* ----------------------------------------------------------- pagination
     *
     * Pure arithmetic over declared heights -- no text is measured, which is what
     * makes these numbers assertable at all.
     */
    testPagination() {
        this.Rep.Sections = PLAIN;
        this.Rep.Data     = rows(1, 20);

        /* 842 - 80 = 762pt of content, seven 100pt bands to a page: 7, 7, 6. */
        eq("20 bands of 100pt make 3 A4 pages", this.Rep.PageCount, 3);

        this.Rep.Orientation = "Landscape";
        /* 595 - 80 = 515: five to a page, so 5, 5, 5, 5. */
        eq("landscape turns the sheet", this.Rep.PageCount, 4);
        this.Rep.Orientation = "Portrait";

        this.Rep.Margins = { Top: 0, Right: 0, Bottom: 0, Left: 0 };
        /* The whole 842: eight to a page, so 8, 8, 4. */
        eq("no margins fit more", this.Rep.PageCount, 3);
        this.Rep.Margins = 171;
        /* 842 - 342 = 500: five to a page. */
        eq("a fat margin fits fewer", this.Rep.PageCount, 4);
        this.Rep.Margins = 40;

        /* A page header and footer come off the top and the bottom before
         * anything flows: 762 - 100 - 100 = 562, five bands to a page. */
        this.Rep.Sections = {
            ...PLAIN,
            PageHeader: { Height: 100, Elements: [{ Kind: "Text", Text: "head", X: 0, Y: 0 }] },
            PageFooter: { Height: 100, Elements: [{ Kind: "Text", Text: "foot", X: 0, Y: 0 }] },
        };
        eq("the page header and footer take their room off the flow",
           this.Rep.PageCount, 4);

        /* A band taller than the whole content area is placed anyway -- the
         * author's error, and breaking on it would loop forever. */
        this.Rep.Sections = { Detail: { Height: 5000,
                              Elements: [{ Kind: "Field", Field: "T", X: 0, Y: 0 }] } };
        this.Rep.Data = rows(1, 3);
        eq("a band taller than the page is placed, not looped on", this.Rep.PageCount, 3);
    }

    /* ------------------------------------------------------- Page and events */
    testPageAndEvents() {
        this.Rep.Sections = PLAIN;

        this.prepared = [];
        this.Rep.Data = rows(1, 20);
        check("Prepared fires when the data arrives", this.prepared.length === 1,
              `fired ${this.prepared.length} time(s)`);
        eq("Prepared carries the count", this.prepared[0], 3);

        /* The regression: a data change that leaves the count alone still
         * re-measured the pages, and used to say nothing about it. */
        this.prepared = [];
        this.Rep.Data = rows(1, 19);
        eq("Prepared fires on a same-count data change", this.prepared.length, 1);

        this.moved = [];
        this.Rep.Page = 99;
        eq("Page clamps to the last page", this.Rep.Page, 3);
        check("Page reports the move", this.moved.length === 1 && this.moved[0] === 3,
              JSON.stringify(this.moved));

        this.moved = [];
        this.Rep.Page = 3;
        eq("Page says nothing about standing still", this.moved.length, 0);

        this.Rep.Page = 0;
        eq("Page clamps to the first page", this.Rep.Page, 1);

        /* The other regression: shrinking the data under the current page left
         * `Page` past the end, so the draw fell back to page 1 while the footer
         * printed the old number. */
        this.Rep.Page = 3;
        this.moved = [];
        this.Rep.Data = rows(1, 2);
        eq("the data shrinking pulls Page back", this.Rep.Page, 1);
        eq("and PageCount with it", this.Rep.PageCount, 1);
        check("and the move is reported", this.moved.length === 1 && this.moved[0] === 1,
              JSON.stringify(this.moved));
    }

    /* ------------------------------------------------ what lands on the page */
    testBands() {
        this.Rep.Sections = {
            ReportHeader: { Height: 40, Elements: [{ Kind: "Text", Text: "top of the report", X: 0, Y: 0 }] },
            PageHeader:   { Height: 40, Elements: [{ Kind: "Text", Text: "every page", X: 0, Y: 0 }] },
            Detail:       { Height: 300, Elements: [{ Kind: "Field", Field: "T", X: 0, Y: 0 }] },
            PageFooter:   { Height: 40, Elements: [
                { Kind: "Text",  Text: "page", X: 0, Y: 0 },
                { Kind: "Field", Field: "@Page",  X: 40, Y: 0 },
                { Kind: "Field", Field: "@Pages", X: 80, Y: 0 },
            ] },
            ReportFooter: { Height: 40, Elements: [{ Kind: "Text", Text: "end of the report", X: 0, Y: 0 }] },
        };
        this.Rep.Data = rows(1, 5);

        /* The page header and footer leave 682pt to flow in. Page one takes the
         * report header and two details (640), page two two more, and page
         * three the last one with the report footer under it. */
        eq("the flowing bands break", this.Rep.PageCount, 3);

        const one = this.texts(this.page(1));
        const two = this.texts(this.page(2));

        check("the report header is on page 1 only",
              one.includes("top of the report") && !two.includes("top of the report"));
        check("the page header is on both",
              one.includes("every page") && two.includes("every page"));
        check("the detail reads the row", one.includes("row 0.0"));
        check("@Page is the page number",
              one.includes("1") && two.includes("2"), JSON.stringify([one, two]));
        check("@Pages is the count", one.includes("3") && two.includes("3"));

        const three = this.texts(this.page(3));
        check("the report footer is on the last page only",
              three.includes("end of the report") && !one.includes("end of the report"));

        /* A `PageHeader` belongs to the sheet, not to the data: it is handed the
         * page number and the count and no row, so a `Field` naming a data key
         * there is blank rather than the first row's. `G` is the one key no
         * other band on this page prints. */
        this.Rep.Sections = {
            ...this.Rep.Sections,
            PageHeader: { Height: 40, Elements: [{ Kind: "Field", Field: "G", X: 0, Y: 0 }] },
        };
        check("a data field in a page header is blank",
              !this.texts(this.page(1)).includes("g0"),
              JSON.stringify(this.texts(this.page(1))));
    }

    /* --------------------------------------------------------- group ladder */
    testGroups() {
        this.Rep.Margins = 40;
        this.Rep.Sections = {
            Groups: [{
                On: "G",
                Header: { Height: 100, Elements: [{ Kind: "Field", Field: "G", X: 0, Y: 0 }] },
                Footer: { Height: 100, Elements: [
                    { Kind: "Text",  Text: "subtotal", X: 0, Y: 0 },
                    { Kind: "Total", Field: "N", Op: "Count", X: 100, Y: 0 },
                ] },
            }],
            Detail: { Height: 100, Elements: [{ Kind: "Field", Field: "T", X: 0, Y: 0 }] },
        };
        /* One group of ten 100pt rows, plus its header and footer: twelve bands
         * over 762pt of page, seven to a page. */
        this.Rep.Data = rows(1, 10);
        eq("a group that runs long breaks", this.Rep.PageCount, 2);

        const one = this.texts(this.page(1));
        const two = this.texts(this.page(2));

        check("the group header opens the report", one[0] === "g0", JSON.stringify(one));

        /* The regression a two-page report shows first: the rows that continue
         * onto page 2 used to arrive under no heading at all. */
        check("the open group header repeats on the next page", two[0] === "g0",
              JSON.stringify(two));
        check("the footer closes it once", two.filter((t) => t === "subtotal").length === 1,
              JSON.stringify(two));
        check("the group counted its own rows", two.includes("10"), JSON.stringify(two));

        /* Two groups nest, and the inner one closes before the outer turns. */
        this.Rep.Sections = {
            Groups: [
                { On: "G", Header: { Height: 20, Elements: [{ Kind: "Field", Field: "G", X: 0, Y: 0 }] },
                           Footer: { Height: 20, Elements: [{ Kind: "Text", Text: "outer", X: 0, Y: 0 }] } },
                { On: "T", Header: { Height: 20, Elements: [{ Kind: "Field", Field: "T", X: 0, Y: 0 }] },
                           Footer: { Height: 20, Elements: [{ Kind: "Text", Text: "inner", X: 0, Y: 0 }] } },
            ],
            Detail: { Height: 20, Elements: [{ Kind: "Text", Text: ".", X: 0, Y: 0 }] },
        };
        this.Rep.Data = rows(2, 2);
        const all = this.texts(this.page(1));
        eq("the whole ladder is one page", this.Rep.PageCount, 1);
        check("the inner group closes before the outer",
              all.indexOf("inner") < all.indexOf("outer"), JSON.stringify(all));
        eq("each group closed once per turn", all.filter((t) => t === "outer").length, 2);
        eq("and the inner one once per row", all.filter((t) => t === "inner").length, 4);
    }

    /* -------------------------------------------------------------- totals
     *
     * Read off the page rather than out of the engine: a total nobody can see is
     * not the thing a report is for.
     */
    testTotals() {
        this.Rep.Sections = {
            Detail: { Height: 20, Elements: [{ Kind: "Text", Text: ".", X: 0, Y: 0 }] },
            ReportFooter: { Height: 100, Elements: [
                { Kind: "Total", Field: "N", Op: "Sum",   X: 0,   Y: 0 },
                { Kind: "Total", Field: "N", Op: "Count", X: 100, Y: 0 },
                { Kind: "Total", Field: "N", Op: "Min",   X: 200, Y: 0 },
                { Kind: "Total", Field: "N", Op: "Max",   X: 300, Y: 0 },
                { Kind: "Total", Field: "N", Op: "Avg",   X: 400, Y: 0, Format: "Number", Decimals: 2 },
                { Kind: "Total", Field: "D", Op: "Min",   X: 0,   Y: 40, Format: "Date" },
                { Kind: "Total", Field: "D", Op: "Count", X: 100, Y: 40 },
            ] },
        };
        this.Rep.Data = [
            { N: new Decimal("0.10"), D: "2026-03-04" },
            { N: new Decimal("0.20"), D: "" },
            { N: new Decimal("10.00"), D: "2026-01-31" },
        ];

        const t = this.texts(this.page(1));

        /* Exact to the cent, and through its own digits: a double would say
         * 10.299999999999999 here. */
        check("Sum keeps a Decimal exact", t.includes("10.30"), JSON.stringify(t));
        check("Count counts the values", t.includes("3"), JSON.stringify(t));
        check("Min compares the raw values", t.includes("0.10"), JSON.stringify(t));
        check("Max too", t.includes("10.00"), JSON.stringify(t));
        check("Avg is a plain number", t.includes(Locale.Number(10.3 / 3, 2)), JSON.stringify(t));

        /* A date column's Min is the earliest date, because "YYYY-MM-DD" orders
         * lexically; and Count skips the empty one. */
        check("Min over dates is the earliest", t.includes(Locale.Date("2026-01-31")),
              JSON.stringify(t));
        check("Count skips what is empty", t.includes("2"), JSON.stringify(t));
    }

    /* ---------------------------------------------------------------- font
     *
     * `Push`/`Pop` restores the colour, the pen, the transform and the clip. It
     * does **not** restore the font -- that lives on the layout -- so an element
     * that names none must be told what to use, or it inherits whatever the last
     * one declared and a whole report comes out bold.
     */
    testFont() {
        this.Rep.Sections = {
            Detail: { Height: 100, Elements: [
                { Kind: "Text", Text: "shouted", X: 0, Y: 0, Font: "Bold 18" },
                { Kind: "Text", Text: "spoken",  X: 0, Y: 40 },
            ] },
        };
        this.Rep.Data = rows(1, 1);

        /* The font in force when each of the two was drawn, read off the dump:
         * the last `Font` line before each `Text`. */
        const font = {};
        let current = "";
        for (const line of this.page(1)) {
            if (line.startsWith("Font ")) current = line.slice(5);
            else if (line.startsWith("Text \"")) font[line.slice(6, line.lastIndexOf("\" at ("))] = current;
        }

        eq("an element's own font is used", font["shouted"], "Bold 18");
        check("and does not leak into the next", font["spoken"] !== "Bold 18",
              `both were drawn in ${font["spoken"]}`);
    }

    /* ----------------------------------------------------------- transform
     *
     * The page is scaled to fit and centred, and the two calls that do it are
     * ordered. Cairo post-multiplies: the transform written *last* is applied
     * *first* to a point, so `Scale` before `Translate` would place the page at
     * `scale * offset` instead of `offset` -- off-centre by everything the scale
     * is not 1, and invisible in an export, whose offset is zero.
     */
    testTransform() {
        this.Rep.Sections = PLAIN;
        this.Rep.Data     = rows(1, 1);

        /* A frame far wider than A4 is wide: the fit is on the height, and the
         * whole difference goes into the horizontal offset. */
        this.Rep.Canvas.Save(File.Join(SCRATCH, "wide.png"), 1200, 400);
        const lines = this.Rep.Canvas.Dump().split("\n");

        const scale = Math.min(1200 / 595, 400 / 842);
        const ox    = (1200 - 595 * scale) / 2;

        eq("the page is moved before it is scaled", lines[1].startsWith("Translate"), true);
        eq("and scaled after",                     lines[2].startsWith("Scale"), true);
        check("the offset is the frame's, not the page's",
              lines[1] === `Translate (${ox.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")},0)` ||
              Math.abs(Number(lines[1].slice(11).split(",")[0]) - ox) < 0.01,
              `${lines[1]}, expected about ${ox}`);
    }

    /* --------------------------------------------------------------- images
     *
     * The masthead. `Painter.Image` is the runtime feature this needed; what the
     * library adds is the element and where its file is looked for.
     */
    testImage() {
        this.Rep.Margins = 40;
        this.Rep.Sections = {
            ReportHeader: { Height: 100, Elements: [
                { Kind: "Image", File: "mark.png", X: 0, Y: 0 },
                { Kind: "Image", File: "mark.png", X: 0, Y: 0, Height: 40 },
            ] },
            Detail: { Height: 20, Elements: [{ Kind: "Text", Text: ".", X: 0, Y: 0 }] },
        };
        this.Rep.Data = rows(1, 1);

        const drawn = this.page(1).filter((l) => l.startsWith("Image"));
        const mark  = File.Join(Application.Directory, "mark.png");

        /* **The path is the project's, not the working directory's.** A report
         * is declared in a project and its logo sits beside its forms. */
        eq("a relative File is resolved against the project",
           drawn[0], `Image "${mark}" at (40,40) 120x80`);
        eq("and one side given scales the other", drawn[1],
           `Image "${mark}" at (40,40) 60x40`);

        throws("an Image with no File is refused",
               () => { this.Rep.Sections = { Detail: { Height: 10,
                       Elements: [{ Kind: "Image", X: 0, Y: 0 }] } }; });

        /* A masthead that is not there is not a blank space where a masthead
         * goes: it throws where it is drawn, which fails the export with it. */
        this.Rep.Sections = {
            Detail: { Height: 20, Elements: [{ Kind: "Image", File: "no-such-mark.png", X: 0, Y: 0 }] },
        };
        this.Rep.Data = rows(1, 1);
        const gone = File.Join(SCRATCH, "gone.png");
        this.errors = [];
        try {
            this.Rep.Save(gone, 1, 1);
            failures.push("a missing image should have failed the page");
        } catch (e) {
            passed++;
        }
        check("and no file is written for it", !File.Exists(gone));
        check("and the error names the file",
              this.errors.length === 1 && this.errors[0].includes("no-such-mark"),
              JSON.stringify(this.errors));
    }

    /* ------------------------------------------------------- a band that grows
     *
     * `Height: "Auto"`: the band is as tall as its own contents, which cannot be
     * known without measuring text -- and text could not be measured outside a
     * `Draw` until `Text.Size` existed.
     */
    testAuto() {
        const short = "one line";
        const long  = "Design of the catalogue: cover, twenty inside pages and " +
                      "the corrections agreed at the meeting on the 9th";

        const sections = (height) => ({
            Detail: {
                Height: height,
                Padding: 6,
                Elements: [
                    { Kind: "Field", Field: "T", X: 0, Y: 2, Width: 200, Wrap: true },
                    { Kind: "Text",  Text: "|", X: 300, Y: 2 },
                ],
            },
        });

        this.Rep.Sections = sections("Auto");
        this.Rep.Data = [{ T: short }, { T: long }, { T: short }];

        /* Where each row's marker landed says how tall the row above it was. */
        const marks = this.page(1)
            .filter((l) => l.startsWith('Text "|"'))
            .map((l) => Number(l.slice(l.lastIndexOf(",") + 1, l.length - 1)));

        eq("every row is drawn", marks.length, 3);
        check("a row with one line is one line tall",
              marks[1] - marks[0] < marks[2] - marks[1],
              JSON.stringify(marks));
        check("and the row that wrapped is taller by its extra lines",
              marks[2] - marks[1] >= (marks[1] - marks[0]) * 2,
              JSON.stringify(marks));

        /* The measurement is the drawing's: `Text.Size` decided the height and
         * `Text.Lines` broke the run, so the lines that land in the band are the
         * ones it was measured for. */
        const lines = Text.Lines(long, Text.Font, { Width: 200 });
        const drawn = this.page(1).filter((l) => l.startsWith('Text "') &&
                                                 !l.startsWith('Text "|"')).length;
        eq("the lines drawn are the lines measured", drawn, 2 + lines.length);

        /* A declared height does not grow, which is the other half of the claim:
         * the same data under a number is a page of equal rows. */
        this.Rep.Sections = sections(20);
        const fixed = this.page(1)
            .filter((l) => l.startsWith('Text "|"'))
            .map((l) => Number(l.slice(l.lastIndexOf(",") + 1, l.length - 1)));
        eq("a declared height is the same for every row",
           fixed[1] - fixed[0], fixed[2] - fixed[1]);

        /* Pagination counts the measured heights, so a page holds fewer rows
         * when the rows are taller. */
        this.Rep.Data = [];
        for (let i = 0; i < 40; i++) this.Rep.Data = [...this.Rep.Data, { T: long }];
        this.Rep.Sections = sections(20);
        const tight = this.Rep.PageCount;
        this.Rep.Sections = sections("Auto");
        check("a report of grown rows takes more pages", this.Rep.PageCount > tight,
              `${this.Rep.PageCount} against ${tight}`);

        throws("Auto is refused on a page header",
               () => { this.Rep.Sections = { PageHeader: { Height: "Auto", Elements: [] } }; });
        throws("and on a page footer",
               () => { this.Rep.Sections = { PageFooter: { Height: "Auto", Elements: [] } }; });
    }

    /* ---------------------------------------------------------------- Save */
    testSave() {
        this.Rep.Sections = PLAIN;
        this.Rep.Data     = rows(1, 20);

        const at = (name) => File.Join(SCRATCH, name);

        this.Rep.Save(at("one.png"), 1, 1);
        check("Save writes a file", File.Exists(at("one.png")));
        eq("and it is a PNG", File.Info(at("one.png")).Type, "image/png");

        /* The export runs the same `Draw` at the exact paper size, so the scale
         * is the one that was asked for: A4 at 2 is 1190 across, 144 dpi. */
        this.Rep.Save(at("two.png"), 2, 2);
        check("a bigger scale is a bigger file",
              File.Info(at("two.png")).Size > File.Info(at("one.png")).Size);

        /* A page past the end is the last one, the same clamp `Page` uses, and
         * the current page is unmoved by an export of another. */
        this.Rep.Page = 2;
        this.moved = [];
        this.Rep.Save(at("far.png"), 99, 1);
        eq("Save clamps the page it is given", this.Rep.Page, 2);
        eq("and exporting does not move the report", this.moved.length, 0);

        const drawn = this.texts(this.page(2));
        check("the export drew the page it was asked for", drawn.includes("row 0.7"),
              JSON.stringify(drawn));
    }

    /* ----------------------------------------------------------------- PDF
     *
     * What a report is for, and what the numbered PNGs were standing in for.
     * What can be asserted from here is that the file is a PDF, that it holds
     * the pages the measure worked out, and that a failure leaves nothing
     * behind; that the text inside it is *text* is cairo's claim, checked by
     * hand with `pdftotext`.
     */
    testPdf() {
        this.Rep.Sections = PLAIN;
        this.Rep.Data     = rows(1, 20);
        this.Rep.Page     = 2;

        const at  = (name) => File.Join(SCRATCH, name);
        const pdf = at("all.pdf");

        this.moved = [];
        this.Rep.SavePdf(pdf);

        eq("SavePdf writes a PDF", File.Info(pdf).Type, "application/pdf");
        eq("and does not move the report", this.Rep.Page, 2);
        eq("nor tell it that it moved", this.moved.length, 0);

        /* Three pages of a page each against one: the whole document is in the
         * file, which is the difference from `Save`. */
        const three = File.Info(pdf).Size;
        this.Rep.Data = rows(1, 3);
        this.Rep.SavePdf(at("one.pdf"));
        check("a longer report is a bigger document",
              three > File.Info(at("one.pdf")).Size,
              `${three} against ${File.Info(at("one.pdf")).Size}`);

        /* A page that throws leaves no half-written document. Cairo streams a
         * PDF as it goes, so this is a file that has to be removed rather than
         * one that was never opened. */
        this.Rep.Sections = {
            Detail: { Height: 20, Elements: [{ Kind: "Image", File: "no-such-mark.png", X: 0, Y: 0 }] },
        };
        const broken = at("broken.pdf");
        try {
            this.Rep.SavePdf(broken);
            failures.push("a page that threw should have failed the document");
        } catch (e) {
            passed++;
        }
        check("and the half of it that existed is gone", !File.Exists(broken));
    }

    /* ---------------------------------------------------------------- print
     *
     * A report reaches paper through `Printer`, and what this asserts is the
     * join: the report works out how many pages there are and lays them out,
     * `Printer` runs the sheets, and `Canvas_DrawPage` turns a sheet number
     * into the page of the document. `ToFile` is the road a test can take --
     * `Send` opens the dialog, and a test cannot click one.
     */
    testPrint() {
        this.Rep.Sections = PLAIN;
        this.Rep.Data     = rows(1, 20);
        this.Rep.Page     = 2;

        const at  = (name) => File.Join(SCRATCH, name);
        const pdf = at("printed.pdf");

        this.moved = [];
        const wrote = Printer.ToFile(this.Rep.Canvas, pdf,
                                     { Pages: this.Rep.PageCount,
                                       Paper: this.Rep.Paper });

        eq("a report prints through Printer", File.Info(pdf).Type,
           "application/pdf");
        eq("every page of it", wrote, this.Rep.PageCount);
        eq("and it does not move the report", this.Rep.Page, 2);
        eq("nor tell it that it moved", this.moved.length, 0);

        /* A range of the document holds exactly it. */
        const ranged = at("ranged.pdf");
        eq("a range writes exactly its pages",
           Printer.ToFile(this.Rep.Canvas, ranged,
                          { Pages: this.Rep.PageCount, From: 1, To: 2 }), 2);
        check("in a smaller file",
              File.Info(ranged).Size < File.Info(pdf).Size,
              `${File.Info(ranged).Size} against ${File.Info(pdf).Size}`);

        /*
         * **A report keeps its count whatever paper comes out**, because its
         * bands are declared in its own points and a page is scaled to fit the
         * frame. It declares no `Paginate` for that reason, and this is the
         * assertion that says the absence is deliberate: a `Markdown` on the
         * same call prints more sheets on smaller paper, and a report does not.
         */
        const onA5 = Printer.ToFile(this.Rep.Canvas, at("a5.pdf"),
                                    { Pages: this.Rep.PageCount, Paper: "A5" });
        eq("a report is the same pages on smaller paper", onA5,
           this.Rep.PageCount);

        /*
         * **`Send` is the report's own line to the dialog**, and what can be
         * asserted without one is that it refuses what `Printer` refuses,
         * before anything opens.
         */
        throws("a setup that is not an object is refused",
               () => this.Rep.Send(42, () => {}));
        throws("and no copies", () => this.Rep.Send({ Copies: 0 }, () => {}));
        throws("and a Send with nobody to tell", () => this.Rep.Send({}));
        throws("even with no setup at all", () => this.Rep.Send());
        throws("and a range outside the document",
               () => this.Rep.Send({ From: 1, To: this.Rep.PageCount + 5 },
                                    () => {}));
    }

    /* ------------------------------------------------ Min, Max, group keys
     *
     * Asked of the engine rather than read off a page: what is under test is
     * which value wins, and `computeTotals` is where that is decided. Both of
     * these shipped wrong -- `<` over the raw values, and `===` over the keys.
     */
    testExtremes() {
        const rep = this.Rep;
        const of  = (vals) => rep.computeTotals(vals.map((v) => ({ V: v })), ["V"]).V;

        /* Numeric text is a number: as text, "10" is before "9". */
        const text = of(["9", "10", "2"]);
        eq("Min over numeric text is the smallest number", text.Min, "2");
        eq("...and Max the largest", text.Max, "10");

        /* A Decimal among numbers and numeric text compares by value. */
        const mixed = of([new Decimal("9.5"), "10", 2]);
        eq("Min over a mixed numeric column", mixed.Min, 2);
        eq("...and Max", mixed.Max, "10");

        /* Exactly: a double cannot tell these two apart. */
        const fine = new Decimal("9007199254740992.5");
        eq("a Decimal compares exactly against numeric text",
           of([fine, "9007199254740993"]).Max, "9007199254740993");

        /* Anything else is text, in this desktop's order. */
        const names = ["Zapata", "Álvarez", "Ñanculeo"];
        const sorted = names.slice().sort(Locale.Compare);
        const byName = of(names);
        eq("Min over names is the first by Locale.Compare", byName.Min, sorted[0]);
        eq("...and Max the last", byName.Max, sorted[2]);

        /* A Decimal group key: three rows of one price are one group. */
        rep.Sections = {
            Groups: [{ On: "P",
                       Footer: { Height: 20, Elements: [{ Kind: "Text", Text: "closed", X: 0, Y: 0 }] } }],
            Detail: { Height: 20, Elements: [{ Kind: "Text", Text: ".", X: 0, Y: 0 }] },
        };
        rep.Data = [{ P: new Decimal("1.50") }, { P: new Decimal("1.50") },
                    { P: new Decimal("1.5") },  { P: new Decimal("2.00") }];
        const t = this.texts(this.page(1));
        eq("Decimal group keys compare by value, not identity",
           t.filter((x) => x === "closed").length, 2);
    }

    /* ------------------------------------------------------------- charts
     *
     * `lib/charts`' own regressions, here because a chart is tested inside
     * `tests/widgets` only as a child project -- and because this is the
     * project that already asserts drawings off `Dump()`. Each one shipped: a
     * frame that threw (which on screen draws nothing and says nothing), a range
     * cached across a change of `Type`, a pie whose slices were renumbered, a
     * stack whose second band fell to the baseline, a wheel notch consumed for
     * nothing, and a lone slot drawn a quarter of the way across.
     */
    testCharts() {
        const c = new Chart();
        c.Height = 120;
        this.Add(c);
        const png  = File.Join(SCRATCH, "chart.png");
        const draw = () => { c.Save(png, 400, 240); return c.Canvas.Dump(); };
        const drew = (name) => {
            try { draw(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
        };
        c.Legend = "None";
        c.Grid   = false;

        /* ---- gaps */
        c.Type   = "Line";
        c.Series = [{ Values: [1, 2, null, 4, "x", undefined, 7, ""] }];
        check("null, undefined and non-numeric text are gaps",
              c.Series[0].Values.filter((v) => isNaN(v)).length === 4,
              JSON.stringify(c.Series[0].Values));
        eq("...and numeric text is still a number", (c.Series = [{ Values: ["3"] }], c.Series[0].Values[0]), 3);
        c.Series = [{ Values: [1, 2, null, 4, "x", undefined, 7] }];
        drew("a line with gaps draws");
        /* Three runs: 1-2, 4, 7 -- one MoveTo each, before the Stroke. */
        const line = draw().split("\n");
        const upTo = line.findIndex((l) => l.startsWith("Stroke"));
        eq("...as a line that stops at each gap",
           line.slice(0, upTo).filter((l) => l.startsWith("MoveTo")).length, 3);
        c.Type = "Area";
        drew("an area with gaps draws");
        c.Stacked = true;
        c.Series = [{ Values: [1, null, 3] }, { Values: [2, 2, "n/a"] }];
        drew("a stacked area with gaps draws");
        c.Stacked = false;
        c.Type = "Line";
        c.Series = [{ Values: [1, 2, null, 4] }];
        draw();
        const gapX = c.xOf(c.lastBox, 2);
        eq("the pointer over a gap finds nothing", c.at(gapX, 50), null);
        c.hover = { series: 0, at: 2, value: NaN };
        drew("a highlight on a gap does not lose the frame");
        c.hover = null;

        /* ---- the y range */
        throws("YMin refuses a word", () => { c.YMin = "abc"; });
        throws("YMax refuses NaN",   () => { c.YMax = NaN; });
        throws("...and infinity",    () => { c.YMax = Infinity; });
        c.YMin = null;
        eq("null works the axis out, like \"\"", c.YMin, "");
        c.Series = [{ Values: [1e308, -1e308] }];
        drew("a range wider than a double still draws");

        /* ---- the range follows the type */
        c.Type    = "Line";
        c.Stacked = true;
        c.Series  = [{ Values: [5, 5] }, { Values: [5, 5] }];
        draw();
        c.Type = "Bar";
        draw();
        check("a stacked Line turned Bar measures the stack",
              c.lastBox.hi >= 10, `hi ${c.lastBox.hi}`);
        c.Stacked = false;

        /* ---- a pie keeps each value's index */
        c.Type   = "Pie";
        c.Series = [{ Values: [3, 0, 2] }];
        draw();
        eq("a pie's slices keep their values' indices",
           JSON.stringify(c.slices.map((x) => x.at)), "[0,2]");

        /* ---- a long stack shares its indices */
        const a = [], b = [];
        for (let i = 0; i < 600; i++) { a.push(1 + i % 7); b.push(1 + (i * 3) % 11); }
        c.Type = "Area"; c.Stacked = true; c.Curved = false;
        c.Series = [{ Values: a }, { Values: b }];
        /* Narrow, so 600 samples are decimated and the dump stays under its cap. */
        c.Save(png, 120, 240);
        const lines = c.Canvas.Dump().split("\n");
        const fills = lines.map((l, i) => l.startsWith("Fill") ? i : -1).filter((i) => i >= 0);
        const band2 = lines.slice(fills[0], fills[1]);
        const path2 = band2.slice(band2.findIndex((l) => l.startsWith("Stroke")) + 1);
        let low = -Infinity;
        for (const l of path2) {
            const m = l.match(/^(?:MoveTo|LineTo) \([-\d.]+,([-\d.]+)\)/);
            if (m) low = Math.max(low, Number(m[1]));
        }
        const base = c.yOf(c.lastBox, 0);
        check("a decimated stack's second band stays on the first",
              fills.length >= 2 && path2.length > 10 && low < base - 1, `lowest ${low}, baseline ${base}`);
        c.Stacked = false;

        /* ---- a wheel over the whole series is not consumed */
        c.Type = "Line";
        const fifty = [];
        for (let i = 0; i < 50; i++) fifty.push(i);
        c.Series = [{ Values: fifty }];
        c.Zoomable = true;
        draw();
        let ranges = 0;
        c.On("Range", () => { ranges++; });
        eq("zooming out a whole view is not consumed", c.Canvas_MouseWheel(0, 1), false);
        eq("...and raises no Range", ranges, 0);
        eq("zooming in still is", c.Canvas_MouseWheel(0, -1), true);
        eq("...with one Range", ranges, 1);
        c.Zoomable = false;
        c.Count = 0; c.From = 0;

        /* ---- one slot is in the middle */
        c.Type = "Bar";
        c.Series = [{ Values: [5] }];
        draw();
        const bar = c.bars[0], mid = (c.lastBox.left + c.lastBox.right) / 2;
        check("a lone bar is centred", Math.abs(bar.x + bar.w / 2 - mid) < 4,
              `bar at ${bar.x + bar.w / 2}, middle ${mid}`);

        c.Remove();
    }

    /* --------------------------------------------------------------- report */
    finish() {
        /* Cleanup that fails must not sink the report. */
        try {
            for (const name of Directory.List(SCRATCH))
                try { File.Delete(File.Join(SCRATCH, name)); } catch (e) { /* dirs stay */ }
            File.Delete(SCRATCH);
        } catch (e) { /* nothing was written: nothing to sweep */ }

        Application.OnError = null;

        print("");
        for (const f of failures) print(`  FAIL  ${f}`);
        print(`report: ${passed} passed, ${failures.length} failed`);
        Application.Quit(failures.length ? 1 : 0);
    }
}
