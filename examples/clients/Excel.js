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
 * and the rest of this file is what goes in it -- a workbook that lists its sheets, a
 * file of styles, and one part per sheet. Nothing here is a general spreadsheet writer
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
 *           character XML cannot carry taken out.
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
 */
"use strict";

const SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OFFICE_REL  = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/* The cell styles, by the index a cell names with `s=`. Kept next to the XML that
 * declares them (`STYLES` below) -- the two have to agree and nothing checks. */
const STYLE_DEFAULT = 0, STYLE_HEADER = 1, STYLE_DATE = 2, STYLE_MONEY = 3;

class Excel {

    /** writes `sheets` as an .xlsx at `path`; answers the number of sheets */
    static Write(path, sheets) {
        if (!Array.isArray(sheets) || !sheets.length)
            throw new Error("Excel.Write: there is nothing to write -- give it at least one sheet");

        Excel.checkNames(sheets);

        const zip = Zip.Create(path);

        try {
            zip.Add("[Content_Types].xml", Excel.contentTypes(sheets.length))
               .Add("_rels/.rels", Excel.packageRels())
               .Add("xl/workbook.xml", Excel.workbook(sheets))
               .Add("xl/_rels/workbook.xml.rels", Excel.workbookRels(sheets.length))
               .Add("xl/styles.xml", STYLES);

            sheets.forEach((sheet, i) => zip.Add(`xl/worksheets/sheet${i + 1}.xml`, Excel.sheet(sheet)));
            zip.Finish();
        } catch (e) {
            /* A sheet that would not write is a file that must not appear. */
            zip.Abort();
            throw e;
        }
        return sheets.length;
    }

    /* --- names ------------------------------------------------------------- */

    /* A sheet's name is limited by the format and Excel refuses a workbook that
     * breaks the limits, with a message about repairing the file. */
    static checkNames(sheets) {
        const seen = {};

        for (const sheet of sheets) {
            const name = sheet.Name;

            if (typeof name !== "string" || !name.length || name.length > 31)
                throw new Error(`Excel.Write: a sheet's name is 1 to 31 characters, not ${JSON.stringify(name)}`);
            if (/[\[\]:*?\/\\]/.test(name))
                throw new Error(`Excel.Write: the sheet name '${name}' has a character a sheet name cannot have ([ ] : * ? / \\)`);
            if (name.startsWith("'") || name.endsWith("'"))
                throw new Error(`Excel.Write: the sheet name '${name}' starts or ends with an apostrophe`);
            if (Dictionary.Has(seen, name.toLowerCase()))
                throw new Error(`Excel.Write: two sheets are called '${name}' (names are compared without case)`);
            seen[name.toLowerCase()] = true;
        }
    }

    /* --- XML ---------------------------------------------------------------- */

    /* Text for a text node or an attribute. The five characters XML reserves are
     * escaped, and the control characters XML 1.0 cannot carry at all -- everything
     * under a space but tab, newline and return -- are dropped: written, they make
     * the whole workbook unreadable, with the error pointing at a line of XML. */
    static escape(text) {
        return String(text)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    static xml(body) {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
    }

    /* 0 -> "A", 25 -> "Z", 26 -> "AA": a column's letters in a cell's reference. */
    static letters(n) {
        let out = "";

        for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26))
            out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
        return out;
    }

    /* --- the parts that are the same for every workbook -------------------- */

    static contentTypes(count) {
        let parts = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
                    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';

        for (let i = 1; i <= count; i++)
            parts += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;

        return Excel.xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                         '<Default Extension="xml" ContentType="application/xml"/>' + parts + '</Types>');
    }

    static packageRels() {
        return Excel.xml(`<Relationships xmlns="${PACKAGE_REL}">` +
                         `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>` +
                         '</Relationships>');
    }

    static workbook(sheets) {
        const list = sheets.map((s, i) =>
            `<sheet name="${Excel.escape(s.Name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");

        return Excel.xml(`<workbook xmlns="${SPREADSHEET}" xmlns:r="${OFFICE_REL}"><sheets>${list}</sheets></workbook>`);
    }

    static workbookRels(count) {
        let rels = "";

        for (let i = 1; i <= count; i++)
            rels += `<Relationship Id="rId${i}" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
        rels += `<Relationship Id="rId${count + 1}" Type="${OFFICE_REL}/styles" Target="styles.xml"/>`;

        return Excel.xml(`<Relationships xmlns="${PACKAGE_REL}">${rels}</Relationships>`);
    }

    /* --- a sheet ------------------------------------------------------------ */

    static sheet(sheet) {
        const columns = sheet.Columns || [];
        const rows    = sheet.Rows || [];

        if (!columns.length)
            throw new Error(`Excel.Write: the sheet '${sheet.Name}' has no columns`);

        const widths = columns.map((c) => Math.max(8, Math.min(60, (c.Width || String(c.Text).length + 4))));
        let   data   = "";

        /* The header row, in bold. */
        data += `<row r="1">${columns.map((c, i) =>
            Excel.text(Excel.letters(i) + "1", c.Text, STYLE_HEADER)).join("")}</row>`;

        rows.forEach((row, r) => {
            if (row.length > columns.length)
                throw new Error(`Excel.Write: row ${r + 1} of '${sheet.Name}' has ${row.length} values for ${columns.length} columns`);

            let cells = "";

            columns.forEach((col, i) => {
                const ref = `${Excel.letters(i)}${r + 2}`;

                cells += Excel.cell(ref, row[i], col.Kind || "text", `'${sheet.Name}' ${ref}`);
                if (typeof row[i] === "string" && (col.Kind || "text") === "text" && !col.Width)
                    widths[i] = Math.max(widths[i], Math.min(60, row[i].length + 2));
            });
            data += `<row r="${r + 2}">${cells}</row>`;
        });

        const cols = widths.map((w, i) =>
            `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");

        return Excel.xml(`<worksheet xmlns="${SPREADSHEET}">` +
            `<dimension ref="A1:${Excel.letters(columns.length - 1)}${rows.length + 1}"/>` +
            /* The header stays put when the rows scroll. */
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
            `<cols>${cols}</cols><sheetData>${data}</sheetData></worksheet>`);
    }

    static text(ref, value, style) {
        const s = style ? ` s="${style}"` : "";

        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${Excel.escape(value)}</t></is></c>`;
    }

    /* One cell, as the kind its column says. `where` names it for the refusal. */
    static cell(ref, value, kind, where) {
        if (value === null || value === undefined || value === "")
            return "";

        switch (kind) {
        case "text":
            return Excel.text(ref, value, STYLE_DEFAULT);

        case "number":
        case "money": {
            const digits = String(value);

            /* Plain decimal digits and an optional exponent; `Infinity`, `NaN`
             * and "12 euros" are not numbers, and Excel's answer to one is a
             * workbook it offers to repair. */
            if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(digits))
                throw new Error(`Excel.Write: ${where} is ${JSON.stringify(digits)}, which is not a number`);

            return `<c r="${ref}"${kind === "money" ? ` s="${STYLE_MONEY}"` : ""}><v>${digits}</v></c>`;
        }

        case "date": {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));

            if (!m)
                throw new Error(`Excel.Write: ${where} is ${JSON.stringify(String(value))}, which is not a date as YYYY-MM-DD`);

            /* Days since 1899-12-30, which is the format's day zero for every date
             * after 28 February 1900 -- the invented 29 February is before them. */
            const serial = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 + 25569;

            return `<c r="${ref}" s="${STYLE_DATE}"><v>${serial}</v></c>`;
        }

        case "bool":
            if (value !== true && value !== false)
                throw new Error(`Excel.Write: ${where} is ${JSON.stringify(value)}, which is not true or false`);
            return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;

        default:
            throw new Error(`Excel.Write: ${where} has a column of kind '${kind}', which is not text, number, money, date or bool`);
        }
    }
}

/* The four styles a cell can name, in the order of the constants above. */
const STYLES = Excel.xml(`<styleSheet xmlns="${SPREADSHEET}">` +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>');
