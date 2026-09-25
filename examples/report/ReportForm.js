/*
 * A statement of account, as a banded report.
 *
 * The `Report` in `lib/report` is the whole of the drawing and the pagination;
 * this form is what using it looks like. It was written against a report that
 * has every band Crystal Reports has -- report header, page header, **two nested
 * group levels**, a detail band per order, and a page footer -- and the two
 * things a report is actually *for*: grouping and totals. What a report takes is
 * in [docs/llm/report.md](../../docs/llm/report.md); the rows are `Data.js`,
 * ordinary objects whose amounts are `Decimal`.
 *
 * **The division is the same one `Chart` argues for**, and it is the whole of
 * the idea: the *shape* of the report -- the bands, their heights, what sits in
 * each -- is declared here, in `sections()`, and the *numbers* are handed over.
 * There is no designer; the layout is written down, which is why it can be
 * version-controlled and why the totals cannot drift from the data.
 *
 * **Two group levels nest: `Groups` is an ordered list, outermost first.**
 * The report groups by `Category` and then by `Client`, so a row changes level 0
 * when its category changes and level 1 when, inside one category, its client
 * does. When the category turns over the engine closes the client's footer, then
 * the category's, then reopens both -- which is what *nested* means, and it is
 * the same shape a spreadsheet's subtotal ladder is.
 *
 * **Three things here are runtime features this example asked for.** The logo in
 * the report header (`Painter.Image`), the detail band that grows to fit a long
 * description (`Height: "Auto"`, which needs `Text.Size` to measure text with no
 * frame open) and *Export PDF* (`Report.SavePdf`, one file rather than a pile of
 * numbered PNGs) were each written up as a missing capability, in the terms this
 * screen needed them, before any of them existed. The order is the point: the
 * application was written first and said precisely what it could not do.
 *
 * **Page 2 is where the library earns its keep.** The last category runs over the
 * break, and its heading and its client's are drawn again at the top of the next
 * page -- an open group's headers repeat, so the row that lands alone up there
 * still says whose it is. Nothing here asks for that.
 *
 * **The rows are sorted before they are handed over, and that is the one thing
 * the report will not do for you.** Grouping is *consecutive* -- Crystal's
 * model, which never reorders the data, because reordering is a second opinion
 * about what the user meant. `Locale.Compare` is the spell that puts `Ñanculeo`
 * between `Núñez` and `Ortiz` and not after `Zapata`.
 *
 * **The page footer is composed, not a single field.** A report's page footer
 * wants "Page 3 of 5", and the library's `@Page` and `@Pages` are the two
 * numbers -- a `Text` "Page", a `Field` for the number, another `Text`, another
 * `Field`. That is Crystal's own model, and it is why the numbers are *numbers*
 * in the library rather than a phrase: a phrase would be prose the library owns,
 * and prose is the application's.
 */
"use strict";

class ReportForm extends Form {

    Form_Open() {
        const rows = [...ORDERS].sort((a, b) =>
            Locale.Compare(a.Category, b.Category) || Locale.Compare(a.Client, b.Client));

        this.Report.Sections = this.sections();
        this.Report.Data     = rows;
        this.showPage();
    }

    /* ------------------------------------------------------------ the report
     *
     * Coordinates are in points, relative to the content area's top-left (the
     * sheet is A4 portrait, 595pt wide, minus a 40pt margin each side -- so 515
     * across). Three columns: the date, the description, and the amount,
     * right-aligned against the far edge.
     */
    sections() {
        const column = { Date: 0, What: 90, Amount: 430 };
        const shade  = "rgba(0,0,0,0.06)";

        return {
            /* **The masthead, which is the one thing a report always has.**
             * `File` is relative to the project, and one of `Width`/`Height` is
             * enough -- the other follows the picture's own proportions, so the
             * declaration says how tall the logo should be and not what shape
             * the file happens to be. */
            ReportHeader: {
                Height: 64,
                Elements: [
                    { Kind: "Image", File: "logo.png", X: 0, Y: 0, Height: 44 },
                    { Kind: "Text", Text: "Statement of account",
                      X: 56, Y: 2, Font: "Bold 18" },
                    { Kind: "Text", Text: Locale.Date(Day.Today, "Date"),
                      X: 56, Y: 28 },
                    { Kind: "Line", X1: 0, Y1: 58, X2: 515, Y2: 58 },
                ],
            },

            PageHeader: {
                Height: 24,
                Elements: [
                    { Kind: "Text", Text: Locale.Text("Date"), X: column.Date, Y: 2, Font: "Bold 10" },
                    { Kind: "Text", Text: Locale.Text("Description"), X: column.What, Y: 2, Font: "Bold 10" },
                    { Kind: "Text", Text: Locale.Text("Amount"), X: column.Amount, Y: 2, Width: 85,
                      Align: "Right", Font: "Bold 10" },
                    { Kind: "Line", X1: 0, Y1: 22, X2: 515, Y2: 22 },
                ],
            },

            /* **The groups, outermost first.** A band's `Field` naming its own
             * key resolves to the group's value -- the client's name in its
             * header, the category's in its footer -- exactly as it would in a
             * detail row. A `Total` in a footer totals that group's rows. */
            Groups: [
                {
                    On: "Category",
                    Header: {
                        Height: 28,
                        Elements: [
                            /* The value alone, no "Category" label: a label beside
                             * a fixed-position value is the overlap a translation
                             * makes (measured: "Categoría" is 60pt, "Kategorie" 61,
                             * and the value sat at 60). The thick rule above is
                             * what marks the outer level, and the two points of
                             * air above the value keep it off it. */
                            { Kind: "Field", Field: "Category", X: 0, Y: 4, Font: "Bold 12" },
                            { Kind: "Line", X1: 0, Y1: 26, X2: 515, Y2: 26, Thickness: 2 },
                        ],
                    },
                    Footer: {
                        Height: 28,
                        Elements: [
                            { Kind: "Text", Text: Locale.Text("Category total"), X: 310, Y: 10,
                              Width: 115, Align: "Right", Font: "Bold 10" },
                            { Kind: "Total", Field: "Amount", Op: "Sum", Format: "Money",
                              X: column.Amount, Y: 10, Width: 85, Align: "Right", Font: "Bold 10" },
                            { Kind: "Total", Field: "What", Op: "Count", X: 8, Y: 10 },
                            { Kind: "Text", Text: Locale.Text("orders"), X: 48, Y: 10 },
                        ],
                    },
                },
                {
                    On: "Client",
                    Header: {
                        Height: 24,
                        Elements: [
                            { Kind: "Box", X: 0, Y: 2, Width: 515, Height: 20, Fill: true, Color: shade },
                            { Kind: "Field", Field: "Client", X: 8, Y: 4, Font: "Bold 11" },
                        ],
                    },
                    Footer: {
                        Height: 26,
                        Elements: [
                            { Kind: "Line", X1: 0, Y1: 4, X2: 515, Y2: 4 },
                            { Kind: "Text", Text: Locale.Text("Subtotal"), X: 350, Y: 8, Width: 75,
                              Align: "Right" },
                            { Kind: "Total", Field: "Amount", Op: "Sum", Format: "Money",
                              X: column.Amount, Y: 8, Width: 85, Align: "Right", Font: "Bold 10" },
                        ],
                    },
                },
            ],

            /* **The row grows with its description.** `Height: "Auto"` measures
             * the elements this row will actually draw and takes the lowest
             * bottom, `Padding` below it -- so the order whose description takes
             * three lines is three lines tall and the fourteen that take one are
             * not. A declared height would have had to be the tallest of them,
             * everywhere, or cut the long one off. */
            Detail: {
                Height: "Auto",
                Padding: 6,
                Elements: [
                    { Kind: "Field", Field: "Placed", Format: "Date", X: column.Date, Y: 2, Width: 80 },
                    { Kind: "Field", Field: "What", X: column.What, Y: 2, Width: 300, Wrap: true },
                    { Kind: "Field", Field: "Amount", Format: "Money", X: column.Amount, Y: 2,
                      Width: 85, Align: "Right" },
                ],
            },

            PageFooter: {
                Height: 24,
                Elements: [
                    { Kind: "Line", X1: 0, Y1: 2, X2: 515, Y2: 2 },
                    { Kind: "Text",  Text: Locale.Text("Page"), X: 0, Y: 8 },
                    { Kind: "Field", Field: "@Page",  X: 42, Y: 8 },
                    { Kind: "Text",  Text: Locale.Text("of"), X: 58, Y: 8 },
                    { Kind: "Field", Field: "@Pages", X: 76, Y: 8 },
                ],
            },

            /* **The grand total gets a wider box than the column.** The amount
             * column is 85pt, which fits a subtotal at Bold 10 and *not*
             * `$ 1.606.235,75` at Bold 12 -- measured: it needs about 98, and
             * a right-aligned run that does not fit grows to the left, over its
             * own label. So the total starts where its label ends and the label
             * moves left with it. Nothing warns about this: an element's `Width`
             * is what `Align` measures against, not a box it is kept inside. */
            ReportFooter: {
                Height: 44,
                Elements: [
                    { Kind: "Line", X1: 0, Y1: 6, X2: 515, Y2: 6, Thickness: 2 },
                    { Kind: "Text", Text: Locale.Text("Total"), X: 265, Y: 14, Width: 110,
                      Align: "Right", Font: "Bold 12" },
                    { Kind: "Total", Field: "Amount", Op: "Sum", Format: "Money", X: 385,
                      Y: 14, Width: 130, Align: "Right", Font: "Bold 12" },
                    { Kind: "Total", Field: "What", Op: "Count", X: 8, Y: 16, Font: "Bold 11" },
                    { Kind: "Text", Text: Locale.Text("orders"), X: 48, Y: 16 },
                ],
            },
        };
    }

    /* ------------------------------------------------------------ the chrome */

    showPage() {
        this.LblPage.Text = Locale.Text("Page {0} of {1}",
            String(this.Report.Page), String(this.Report.PageCount));
        this.BtnPrev.Enabled = this.Report.Page > 1;
        this.BtnNext.Enabled = this.Report.Page < this.Report.PageCount;
    }

    /* The report says back where it is. Two events: `Prepared` when the pages
     * were (re)computed, `Page` when the data moved the current one -- which is how the
     * footer's "page X of Y" and the buttons stay honest without this form
     * having to remember to update them everywhere. */
    Report_Prepared(count) { this.showPage(); }

    Report_Page(page) { this.showPage(); }

    /* **Assigning `Page` raises nothing** -- a property setter must not -- so
     * the buttons that turn it say so themselves. */
    BtnPrev_Click() { this.Report.Page = this.Report.Page - 1; this.showPage(); }

    BtnNext_Click() { this.Report.Page = this.Report.Page + 1; this.showPage(); }

    /* One page, as a picture. `2` is 144 dpi: an A4 page is a 1190px-wide PNG.
     * This is what to reach for when a page is going into something else -- an
     * email, a slide -- and it is one file per page by construction. */
    BtnExport_Click() {
        const dir = Application.ConfigDirectory;
        const n   = this.Report.PageCount;

        for (let p = 1; p <= n; p++)
            this.Report.Save(File.Join(dir, `statement-${p}.png`), p, 2);

        this.LblStatus.Text = Locale.Text("Saved {0} page(s) in {1}", String(n), dir);
    }

    /* **The whole thing, as one document.** `SavePdf` draws every page the
     * measure worked out into a single file at the paper's exact size -- vector,
     * so the text in it is text and can be searched and selected. It is what a
     * statement of account is *for*, and it is what this example used to have to
     * apologise for not having. */
    BtnPdf_Click() {
        const path = File.Join(Application.ConfigDirectory, "statement.pdf");

        this.Report.SavePdf(path);
        this.LblStatus.Text = Locale.Text("Saved {0} page(s) as {1}",
                                          String(this.Report.PageCount), path);
    }

    /* **And onto paper**, which is the one thing a statement of account is
     * really for. `Send` is the report's line to `Printer`: it fills in how
     * many pages there are and the paper it was laid out for, the dialog
     * answers the printer, the copies and the range, and the same `Draw` runs
     * against the print context.
     *
     * **It takes a callback, like every other dialog here.** The person answers
     * the dialog in their own time, so this returns at once and the callback
     * arrives when something was printed -- and **not at all when it was
     * cancelled**, which is why there is nothing to test for and no `else`. The
     * status line simply does not move.
     *
     * What arrives is what the dialog settled, which is the only honest thing
     * to report: the person may have asked for two copies of page three.
     */
    BtnPrint_Click() {
        this.Report.Send((sent) => {
            this.LblStatus.Text = Locale.Text("Printed page(s) {0} to {1}, {2} copy/copies",
                                              String(sent.From), String(sent.To),
                                              String(sent.Copies));
        });
    }
}
