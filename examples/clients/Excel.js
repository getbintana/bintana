/*
 * A workbook, written: the sheet somebody on the other side of the table asks for.
 *
 *     Excel.Write("clients.xlsx", [{
 *         Name:    "Clients",
 *         Columns: [{ Text: "Name" }, { Text: "Balance", Kind: "money" }, { Text: "Since", Kind: "date" }],
 *         Rows:    [["Álvarez", new Decimal("120.50"), "2024-03-01"]],
 *     }]);
 *
 * An `.xlsx` is a zip of XML parts, so this is two jobs: `Zip.Create` is the container
 * and `Xml` writes what goes in it -- a workbook that lists its sheets, a file of
 * styles, and one part per sheet. **Every part is a tree and `Xml.Stringify` writes
 * it**, so the escaping, the namespaces and the well-formedness are libxml2's and not
 * a second implementation of them here; the first version wrote the XML as strings,
 * and building it with `Xml` instead is what found three things `Xml` got wrong (text
 * it could not read back, no way to declare `r:` for `r:id`, a child's namespace) --
 * all fixed in the runtime, since a program that writes XML should not have to work
 * around the API that writes it. Nothing here is a general spreadsheet writer
 * and it does not pretend to be: no formulas, no merged cells, no colours. It is what
 * an application needs to hand a table to somebody who will open it in Excel, which is
 * what `examples/sheets` is the other half of.
 *
 * ## What each kind of cell is, because Excel holds them as different things
 *
 * A cell is **text**, a **number**, a **date** or a **boolean**, and which one is not
 * decided by how it looks: `01234` is a postal code and must stay text, or Excel turns
 * it into 1234 and a customer in Córdoba is somewhere else. So a column says its `Kind`
 * and the value is held to it, and a value that cannot be that kind is *refused naming
 * the cell*, not written as something near it.
 *
 *   text    the default. Held as an inline string, with its spaces kept and every
 *           character XML cannot carry taken out -- see `clean` below for why that
 *           is this file's decision and not `Xml`'s.
 *   number  a number as it is. A `Decimal` goes in by its own digits (`120.50`), since
 *           `"120.50"` as text is the one thing a column of money must not be.
 *   money   a number shown with two decimals (`0.00`).
 *   date    `"YYYY-MM-DD"`, which is what `Field.Date` holds. Written as a serial
 *           number with a date format, because that is what a date *is* in this format.
 *   bool    `true` or `false`.
 *
 * An empty value (`null`, `undefined`, `""`) is no cell at all, which is how an empty
 * cell is written, and not an empty string that a formula would count.
 *
 * ## Money, and the limit it has
 *
 * Excel keeps a number as a double, so a `Decimal` of more than fifteen significant
 * digits does not survive the trip: that is Excel's limit and not this file's, and the
 * alternative -- writing the digits as text -- would be a column nobody can sum.
 *
 * ## The container
 *
 * `Zip.Create` writes to a temporary and `Finish()` puts it at the path, so an export
 * that fails half way leaves the old file where it was and nothing beside it. The
 * parts are added in the order the format's own writers use, and every name is a
 * fixed one -- nothing here builds a path out of data.
 *
 * It needs libxml2, which is optional when the runtime is built: without it `Write`
 * says so instead of writing anything, and the Export button reports the sentence.
 */
"use strict";

const SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OFFICE_REL  = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT     = "http://schemas.openxmlformats.org/package/2006/content-types";
const XML_NS      = "http://www.w3.org/XML/1998/namespace";

/* The cell styles, by the index a cell names with `s=`. They have to agree with
 * the order `Excel.styles()` writes the `xf` elements in, and nothing checks. */
const STYLE_DEFAULT = 0, STYLE_HEADER = 1, STYLE_DATE = 2, STYLE_MONEY = 3;

class Excel {

    /** writes `sheets` as an .xlsx at `path`; answers the number of sheets */
    static Write(path, sheets) {
        if (!Xml.Available)
            throw new Error("Excel.Write: this build of Bintana has no libxml2, which writing a workbook needs");
        if (!Array.isArray(sheets) || !sheets.length)
            throw new Error("Excel.Write: there is nothing to write -- give it at least one sheet");

        Excel.checkNames(sheets);

        /* Every part is built before the archive is opened, so a value refused
         * half way through the third sheet writes nothing at all. */
        const parts = [
            ["[Content_Types].xml",        Excel.contentTypes(sheets.length)],
            ["_rels/.rels",                Excel.packageRels()],
            ["xl/workbook.xml",            Excel.workbook(sheets)],
            ["xl/_rels/workbook.xml.rels", Excel.workbookRels(sheets.length)],
            ["xl/styles.xml",              Excel.styles()],
        ];

        sheets.forEach((sheet, i) => parts.push([`xl/worksheets/sheet${i + 1}.xml`, Excel.sheet(sheet)]));

        const zip = Zip.Create(path);

        try {
            for (const [name, tree] of parts)
                zip.Add(name, Xml.Stringify(tree));
            zip.Finish();
        } catch (e) {
            zip.Abort();
            throw e;
        }
        return sheets.length;
    }

    /* --- names and text --------------------------------------------------- */

    /*
     * Text with what XML cannot carry taken out: the control characters other than
     * tab, newline and return, U+FFFE and U+FFFF, and half of a surrogate pair.
     *
     * **`Xml` refuses these and this drops them, and both are right.** The runtime's
     * promise is that what it writes it can read, so it says no and names the
     * character; whether a stray `\u0001` pasted into a client's name should stop an
     * export is the application's question, and for a list somebody asked to take to
     * a spreadsheet the answer is no. A sheet's *name* is not cleaned: it is the
     * program's own text, and a bad one is a mistake to be told about.
     */
    static clean(text) {
        return String(text).replace(
            /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
    }

    /* A sheet's name is limited by the format and Excel refuses a workbook that
     * breaks the limits, with a message about repairing the file. */
    static checkNames(sheets) {
        const seen = {};

        for (const sheet of sheets) {
            const name = sheet.Name;

            if (typeof name !== "string" || !name.length || name.length > 31)
                throw new Error(`Excel.Write: a sheet's name is 1 to 31 characters, not ${JSON.stringify(name)}`);
            if (/[\[\]:*?\/\\]/.test(name) || Excel.clean(name) !== name)
                throw new Error(`Excel.Write: the sheet name '${name}' has a character a sheet name cannot have ([ ] : * ? / \\ or a control character)`);
            if (name.startsWith("'") || name.endsWith("'"))
                throw new Error(`Excel.Write: the sheet name '${name}' starts or ends with an apostrophe`);
            if (Dictionary.Has(seen, name.toLowerCase()))
                throw new Error(`Excel.Write: two sheets are called '${name}' (names are compared without case)`);
            seen[name.toLowerCase()] = true;
        }
    }

    /* 0 -> "A", 25 -> "Z", 26 -> "AA": a column's letters in a cell's reference. */
    static letters(n) {
        let out = "";

        for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26))
            out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
        return out;
    }

    /* --- building a tree --------------------------------------------------- */

    /* A part's root, in its namespace; what is added under it takes the namespace
     * too, so no element below needs to say it. */
    static root(name, uri) {
        const el = Xml.Element(name);

        el.SetNamespace(uri);
        return el;
    }

    /* A child with its attributes, in the order given -- `Add` with a name makes
     * the element where it goes, with nothing copied. */
    static el(parent, name, attrs) {
        const el = parent.Add(name);

        for (const key of Dictionary.Keys(attrs || {}))
            el.SetAttr(key, String(attrs[key]));
        return el;
    }

    /* --- the parts that are the same for every workbook -------------------- */

    static contentTypes(count) {
        const t = Excel.root("Types", CONTENT);

        Excel.el(t, "Default", { Extension: "rels", ContentType: "application/vnd.openxmlformats-package.relationships+xml" });
        Excel.el(t, "Default", { Extension: "xml", ContentType: "application/xml" });
        Excel.el(t, "Override", { PartName: "/xl/workbook.xml",
                                  ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" });
        Excel.el(t, "Override", { PartName: "/xl/styles.xml",
                                  ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" });
        for (let i = 1; i <= count; i++)
            Excel.el(t, "Override", { PartName: `/xl/worksheets/sheet${i}.xml`,
                                      ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" });
        return t;
    }

    static packageRels() {
        const r = Excel.root("Relationships", PACKAGE_REL);

        Excel.el(r, "Relationship", { Id: "rId1", Type: `${OFFICE_REL}/officeDocument`, Target: "xl/workbook.xml" });
        return r;
    }

    /* The sheets, each pointing at its part through a relationship id -- `r:id`,
     * in a namespace the workbook declares a prefix for and is not itself in. */
    static workbook(sheets) {
        const book = Excel.root("workbook", SPREADSHEET);

        book.DeclareNamespace(OFFICE_REL, "r");

        const list = Excel.el(book, "sheets");

        sheets.forEach((s, i) => {
            Excel.el(list, "sheet", { name: s.Name, sheetId: i + 1 })
                 .SetAttrNS(OFFICE_REL, "id", `rId${i + 1}`);
        });
        return book;
    }

    static workbookRels(count) {
        const r = Excel.root("Relationships", PACKAGE_REL);

        for (let i = 1; i <= count; i++)
            Excel.el(r, "Relationship", { Id: `rId${i}`, Type: `${OFFICE_REL}/worksheet`, Target: `worksheets/sheet${i}.xml` });
        Excel.el(r, "Relationship", { Id: `rId${count + 1}`, Type: `${OFFICE_REL}/styles`, Target: "styles.xml" });
        return r;
    }

    /* The four styles a cell can name, in the order of the constants above. */
    static styles() {
        const st = Excel.root("styleSheet", SPREADSHEET);

        Excel.el(Excel.el(st, "numFmts", { count: 1 }), "numFmt", { numFmtId: 164, formatCode: "yyyy\\-mm\\-dd" });

        const fonts = Excel.el(st, "fonts", { count: 2 });
        const plain = Excel.el(fonts, "font");
        const bold  = Excel.el(fonts, "font");

        Excel.el(plain, "sz", { val: 11 });
        Excel.el(plain, "name", { val: "Calibri" });
        Excel.el(bold, "b");
        Excel.el(bold, "sz", { val: 11 });
        Excel.el(bold, "name", { val: "Calibri" });

        const fills = Excel.el(st, "fills", { count: 2 });

        Excel.el(Excel.el(fills, "fill"), "patternFill", { patternType: "none" });
        Excel.el(Excel.el(fills, "fill"), "patternFill", { patternType: "gray125" });

        const border = Excel.el(Excel.el(st, "borders", { count: 1 }), "border");

        for (const side of ["left", "right", "top", "bottom", "diagonal"])
            Excel.el(border, side);

        Excel.el(Excel.el(st, "cellStyleXfs", { count: 1 }), "xf", { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0 });

        const xfs = Excel.el(st, "cellXfs", { count: 4 });

        Excel.el(xfs, "xf", { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0 });
        Excel.el(xfs, "xf", { numFmtId: 0, fontId: 1, fillId: 0, borderId: 0, xfId: 0, applyFont: 1 });
        Excel.el(xfs, "xf", { numFmtId: 164, fontId: 0, fillId: 0, borderId: 0, xfId: 0, applyNumberFormat: 1 });
        Excel.el(xfs, "xf", { numFmtId: 2, fontId: 0, fillId: 0, borderId: 0, xfId: 0, applyNumberFormat: 1 });

        Excel.el(Excel.el(st, "cellStyles", { count: 1 }), "cellStyle", { name: "Normal", xfId: 0, builtinId: 0 });
        return st;
    }

    /* --- a sheet ------------------------------------------------------------ */

    static sheet(sheet) {
        const columns = sheet.Columns || [];
        const rows    = sheet.Rows || [];

        if (!columns.length)
            throw new Error(`Excel.Write: the sheet '${sheet.Name}' has no columns`);

        const ws     = Excel.root("worksheet", SPREADSHEET);
        const widths = columns.map((c) => Math.max(8, Math.min(60, (c.Width || String(c.Text).length + 4))));

        Excel.el(ws, "dimension", { ref: `A1:${Excel.letters(columns.length - 1)}${rows.length + 1}` });

        /* The header stays put when the rows scroll. */
        Excel.el(Excel.el(Excel.el(ws, "sheetViews"), "sheetView", { workbookViewId: 0 }), "pane",
                 { ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" });

        /* The widths are known only once the rows have been looked at, and `cols`
         * comes before `sheetData` -- so it is placed now and filled at the end. */
        const cols = Excel.el(ws, "cols");
        const data = Excel.el(ws, "sheetData");

        /* The header row, in bold. */
        const header = Excel.el(data, "row", { r: 1 });

        columns.forEach((c, i) => Excel.text(header, `${Excel.letters(i)}1`, c.Text, STYLE_HEADER));

        rows.forEach((row, r) => {
            if (row.length > columns.length)
                throw new Error(`Excel.Write: row ${r + 1} of '${sheet.Name}' has ${row.length} values for ${columns.length} columns`);

            const line = Excel.el(data, "row", { r: r + 2 });

            columns.forEach((col, i) => {
                const ref = `${Excel.letters(i)}${r + 2}`;

                Excel.cell(line, ref, row[i], col.Kind || "text", `'${sheet.Name}' ${ref}`);
                if (typeof row[i] === "string" && (col.Kind || "text") === "text" && !col.Width)
                    widths[i] = Math.max(widths[i], Math.min(60, row[i].length + 2));
            });
        });

        widths.forEach((w, i) => Excel.el(cols, "col", { min: i + 1, max: i + 1, width: w, customWidth: 1 }));
        return ws;
    }

    static text(row, ref, value, style) {
        const c = Excel.el(row, "c", style ? { r: ref, s: style, t: "inlineStr" } : { r: ref, t: "inlineStr" });
        const t = Excel.el(Excel.el(c, "is"), "t");

        t.SetAttrNS(XML_NS, "space", "preserve");
        t.Text = Excel.clean(value);
    }

    /* One cell, as the kind its column says. `where` names it for the refusal. */
    static cell(row, ref, value, kind, where) {
        if (value === null || value === undefined || value === "")
            return;

        switch (kind) {
        case "text":
            Excel.text(row, ref, value, STYLE_DEFAULT);
            return;

        case "number":
        case "money": {
            const digits = String(value);

            /* Plain decimal digits and an optional exponent; `Infinity`, `NaN`
             * and "12 euros" are not numbers, and Excel's answer to one is a
             * workbook it offers to repair. */
            if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(digits))
                throw new Error(`Excel.Write: ${where} is ${JSON.stringify(digits)}, which is not a number`);

            const c = Excel.el(row, "c", kind === "money" ? { r: ref, s: STYLE_MONEY } : { r: ref });

            Excel.el(c, "v").Text = digits;
            return;
        }

        case "date": {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));

            if (!m)
                throw new Error(`Excel.Write: ${where} is ${JSON.stringify(String(value))}, which is not a date as YYYY-MM-DD`);

            /* Days since 1899-12-30, which is the format's day zero for every date
             * after 28 February 1900 -- the invented 29 February is before them. */
            const serial = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 + 25569;

            Excel.el(Excel.el(row, "c", { r: ref, s: STYLE_DATE }), "v").Text = String(serial);
            return;
        }

        case "bool":
            if (value !== true && value !== false)
                throw new Error(`Excel.Write: ${where} is ${JSON.stringify(value)}, which is not true or false`);
            Excel.el(Excel.el(row, "c", { r: ref, t: "b" }), "v").Text = value ? "1" : "0";
            return;

        default:
            throw new Error(`Excel.Write: ${where} has a column of kind '${kind}', which is not text, number, money, date or bool`);
        }
    }
}
