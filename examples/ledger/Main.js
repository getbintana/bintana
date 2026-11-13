"use strict";

/*
 * A console report: a CSV in, a PDF out, no display.
 *
 *     bintana examples/ledger [data/expenses.csv] [expenses.pdf]
 *
 * It is the smallest application that needs the whole headless path: the core
 * reads and validates the data, `ChartDocument` draws a bar chart into bytes,
 * and `ReportDocument` lays the chart and the detail rows out as a PDF. None of
 * it touches a widget, so the same command works from cron or CI.
 *
 * The numbers are `Decimal`, not floats: an expense report that rounds a cent
 * is a report somebody has to correct by hand. `Csv.Parse` keeps every value as
 * text on purpose, so a postal code or an amount with two decimals stays what
 * the file said; this file decides what each column means.
 */
function Main() {
    const args  = Application.Arguments;
    let input = File.Join(Application.Directory, "data", "expenses.csv");
    let out   = "expenses.pdf";
    let title = "Expenses";
    let haveIn = false, haveOut = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--title") {
            title = args[++i] || title;
        } else if (!haveIn && /\.csv$/i.test(args[i])) {
            input = args[i];
            haveIn = true;
        } else if (!haveOut) {
            out = args[i];
            haveOut = true;
        } else {
            Logger.Error(`unexpected argument "${args[i]}"`);
            Application.Quit(2);
            return;
        }
    }

    let rows;
    try {
        rows = read(input);
    } catch (e) {
        Logger.Error(e.message);
        Application.Quit(1);
        return;
    }
    if (!rows.length) {
        Logger.Error(`${input}: no expense rows`);
        Application.Quit(1);
        return;
    }

    const totals = new Map();
    for (const row of rows)
        totals.set(row.Category, (totals.get(row.Category) || new Decimal("0")) + row.Amount);

    const categories = [...totals.keys()].sort((a, b) => Locale.Compare(a, b));
    const chart = new ChartDocument();
    chart.Type   = "Bar";
    chart.Title  = `${title} by category`;
    chart.Labels = categories;
    chart.Series = [{ Name: "Amount", Values: categories.map((c) => totals.get(c).Number()) }];

    const image = chart.ToPng(560, 220);
    const report = new ReportDocument();
    report.Paper    = "A4";
    report.Margins  = 40;
    report.Sections = {
        ReportHeader: { Height: 270, Elements: [
            { Kind: "Text", Text: title, X: 0, Y: 0, Font: "Sans Bold 18" },
            { Kind: "Image", Bytes: image, X: 0, Y: 30, Width: 520, Height: 204 },
        ] },
        Detail: { Height: 22, Elements: [
            { Kind: "Field", Field: "Date",     X: 0,   Y: 2, Width: 80 },
            { Kind: "Field", Field: "Category", X: 86,  Y: 2, Width: 100 },
            { Kind: "Field", Field: "Detail",   X: 192, Y: 2, Width: 240 },
            { Kind: "Field", Field: "Amount",   X: 440, Y: 2, Width: 75, Alignment: "Right" },
        ] },
        PageFooter: { Height: 16, Elements: [
            { Kind: "Text", Text: "@Page / @Pages", X: 0, Y: 0, Font: "Sans 8" },
        ] },
    };
    report.Data = rows;
    Directory.Make(File.Directory(File.Absolute(out)));
    report.SavePdf(out);

    print(`wrote ${out}: ${report.PageCount} page(s), ${rows.length} rows`);
}

/* The CSV is the boundary: every failure names the file and the 1-based row
 * that could not be read, before anything is drawn. */
function read(path) {
    const rows = Csv.Load(path);
    if (!rows.length)
        throw new Error(`${path}: the file is empty`);

    const head = rows[0].map((s) => s.trim());
    const at   = (name) => head.indexOf(name);
    for (const name of ["Date", "Category", "Detail", "Amount"])
        if (at(name) < 0)
            throw new Error(`${path}: the header has no "${name}" column`);

    const out = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r.length || r.every((v) => v === ""))
            continue;
        const amount = String(r[at("Amount")] || "").trim();
        let value;
        try {
            value = new Decimal(amount);
        } catch (e) {
            throw new Error(`${path}:${i + 1}: "${amount}" is not an amount`);
        }
        out.push({
            Date:     String(r[at("Date")] || "").trim(),
            Category: String(r[at("Category")] || "").trim() || "Other",
            Detail:   String(r[at("Detail")] || "").trim(),
            Amount:   value,
        });
    }
    return out;
}
