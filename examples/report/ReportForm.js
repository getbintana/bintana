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
 * each -- lives in `ReportForm.form`, where the IDE's report designer draws and
 * edits it, and the *numbers* are handed over by this file. **Double-click the
 * `Report` in the IDE and the bands are the ones that print.** The code below
 * sorts the rows, sets `Data`, and fills the two values that are not design:
 * today's date (`@Today`) and the translated labels.
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

        this.localize();
        this.Report.Data = rows;
        this.showPage();
    }

    /*
     * The two things the designer cannot know: today's date and the catalogue's
     * words. `@Today` is the marker the form carries where the date goes; every
     * other `Text` is looked up, so the English the designer wrote is the key
     * and the catalogue is the language.
     *
     * **It mutates the designed `Sections`, and that is on purpose.** The shape
     * is the form's; this only fills the values that change between runs.
     */
    localize() {
        const sec = this.Report.Sections;

        const band = (b) => {
            for (const el of (b && b.Elements) || []) {
                if (el.Kind !== "Text" || !el.Text) continue;
                el.Text = el.Text === "@Today"
                    ? Locale.Date(Day.Today, "Date")
                    : Locale.Text(el.Text);
            }
        };

        for (const name of ["ReportHeader", "PageHeader", "Detail",
                            "PageFooter", "ReportFooter"])
            band(sec[name]);
        for (const g of sec.Groups || []) {
            band(g.Header);
            band(g.Footer);
        }
    }

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
