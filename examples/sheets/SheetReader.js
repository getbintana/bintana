/*
 * One sheet of an `.xlsx`, read in a thread of its own.
 *
 * An `.xlsx` is a zip of XML parts, and the sheet is not self-contained: the cells
 * hold *numbers* that mean a string (an index into `sharedStrings.xml`), a date (a
 * serial number whose meaning is in `styles.xml`) or a boolean, and which of the
 * `worksheets/sheetN.xml` files is "the second sheet" is in `workbook.xml` and its
 * relationships. Reading one is therefore four small jobs, each in a function below.
 * The container is `Zip`, the parts are `Xml`, and the whole of it is a `Task`
 * because a big sheet is seconds of parsing and seconds of parsing on the window's
 * thread is a window that does not move.
 *
 * **The helpers live in this file** because a worker loads the file of the task
 * class and nothing else: a function in `SheetForm.js` is not there.
 *
 * What it does *not* do, so nobody looks for it: formulas (a cell answers the value
 * the program that saved it cached, which is what a viewer should show), merged
 * cells, styles beyond "is this a date", and anything that needs the sheet to be
 * *recalculated*. Dates are the one place a number is not a number, and the one
 * guess in here: a custom format that names a year, a month, a day or an hour is a
 * date, and a built-in one is a date by the specification's own table.
 */
"use strict";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/* Most a sheet is read to. A table drawn on demand holds nothing, so rows are
 * cheap; the limit is for memory in the message that carries them. */
const MAX_ROWS = 200000;
const MAX_COLS = 1000;

/* "AB" -> 27, with A = 0. */
function columnOf(letters) {
    let n = 0;

    for (const ch of letters)
        n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/* All the text under a shared-string or inline-string element: `<t>` directly, or
 * inside runs (`<r><t>`) when it has formatting. Phonetic hints (`rPh`) are
 * deliberately not read: they are the reading of the text, not the text. */
function textOf(si) {
    if (!si)
        return "";

    let out = "";

    for (const t of si.FindAll("t"))
        out += t.Text;
    for (const r of si.FindAll("r"))
        for (const t of r.FindAll("t"))
            out += t.Text;
    return out;
}

/* Whether a number format shows a date or a time. The built-in ids are the
 * specification's table (14-22, 27-36, 45-47, 50-58); a custom one is a date if,
 * once what is quoted, escaped or in brackets is taken out, a letter that means
 * a year, month, day, hour or second is left. */
function isDateFormat(id, code) {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) ||
        (id >= 50 && id <= 58))
        return true;
    if (!code)
        return false;

    const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");

    return /[ymdhs]/i.test(bare);
}

/* A date serial as text. Day 0 is 1899-12-30 -- not 12-31, because the format
 * inherits a leap year 1900 never had, which only matters before March of it --
 * or 1904-01-01 in the workbooks that say so. */
function dateText(serial, epoch1904) {
    const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const days = Math.floor(serial);
    const secs = Math.round((serial - days) * 86400);
    const when = new Date(base + days * 86400000 + secs * 1000);
    const pad  = (n) => String(n).padStart(2, "0");
    const time = `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`
               + (when.getUTCSeconds() ? `:${pad(when.getUTCSeconds())}` : "");

    if (days === 0)
        return time;

    const day = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`;

    return secs ? `${day} ${time}` : day;
}

class SheetReader extends Task {

    Run(msg) {
        const zip = Zip.Open(msg.path);

        try {
            return this.read(zip, msg.sheet || 0);
        } finally {
            zip.Close();
        }
    }

    read(zip, wanted) {
        const names = zip.Entries.map((e) => e.Name);

        if (!names.includes("xl/workbook.xml"))
            throw new Error("this is a zip, but not a spreadsheet: it has no xl/workbook.xml");

        const book   = Xml.ParseBytes(zip.Read("xl/workbook.xml")).Root;
        const sheets = book.Find("sheets").FindAll("sheet");

        if (!sheets.length)
            throw new Error("the workbook has no sheets");

        const index = Math.min(Math.max(wanted, 0), sheets.length - 1);
        const part  = this.partOf(zip, names, sheets[index], index);

        const pr = book.Find("workbookPr");
        const epoch1904 = pr && /^(1|true)$/i.test(pr.Attr("date1904") || "");

        const shared = names.includes("xl/sharedStrings.xml")
            ? Xml.ParseBytes(zip.Read("xl/sharedStrings.xml")).Root.FindAll("si").map(textOf)
            : [];
        const dateStyles = this.dateStyles(zip, names);

        const sheet = Xml.ParseBytes(zip.Read(part)).Root;
        const data  = sheet.Find("sheetData");
        const rows  = [];
        let   width = 0, truncated = false;

        for (const row of data ? data.FindAll("row") : []) {
            /* A row may be missing from the file, and its number is the truth. */
            const at = Number(row.Attr("r")) - 1;
            const target = Number.isFinite(at) && at >= 0 ? at : rows.length;

            if (target >= MAX_ROWS) {
                truncated = true;
                break;
            }
            while (rows.length < target)
                rows.push([]);

            const cells = [];
            let   next = 0;

            for (const c of row.FindAll("c")) {
                const ref = c.Attr("r");
                const col = ref ? columnOf(ref.replace(/[0-9]/g, "")) : next;

                next = col + 1;
                if (col >= MAX_COLS) {
                    truncated = true;
                    continue;
                }
                while (cells.length < col)
                    cells.push("");
                cells[col] = this.value(c, shared, dateStyles, epoch1904);
            }
            width = Math.max(width, cells.length);
            rows.push(cells);
        }

        return {
            sheets: sheets.map((s) => s.Attr("name")),
            current: index,
            rows,
            width,
            truncated,
        };
    }

    /* Which file is sheet number `index`: the workbook names it by a relationship
     * id and the relationships say where that is, relative to `xl/`. A file with no
     * relationships at all is read by the numbering every producer uses. */
    partOf(zip, names, sheet, index) {
        const rid = sheet.AttrNS(RELS, "id");

        if (rid && names.includes("xl/_rels/workbook.xml.rels")) {
            const rels = Xml.ParseBytes(zip.Read("xl/_rels/workbook.xml.rels")).Root;

            for (const r of rels.FindAll("Relationship")) {
                if (r.Attr("Id") !== rid)
                    continue;

                const target = r.Attr("Target");

                return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
            }
        }
        return `xl/worksheets/sheet${index + 1}.xml`;
    }

    /* The cell styles (`s="1"`) that are dates, as a set of indices. */
    dateStyles(zip, names) {
        const out = {};

        if (!names.includes("xl/styles.xml"))
            return out;

        const styles = Xml.ParseBytes(zip.Read("xl/styles.xml")).Root;
        const codes  = {};
        const fmts   = styles.Find("numFmts");

        for (const f of fmts ? fmts.FindAll("numFmt") : [])
            codes[Number(f.Attr("numFmtId"))] = f.Attr("formatCode");

        const xfs = styles.Find("cellXfs");
        let   i = 0;

        for (const xf of xfs ? xfs.FindAll("xf") : []) {
            const id = Number(xf.Attr("numFmtId"));

            if (isDateFormat(id, codes[id]))
                out[i] = true;
            i++;
        }
        return out;
    }

    /* What a cell shows. `t` says how to read `<v>`; with none it is a number, and
     * the style says whether that number is a date. */
    value(c, shared, dateStyles, epoch1904) {
        const type = c.Attr("t") || "n";
        const v    = c.Find("v");
        const raw  = v ? v.Text : "";

        switch (type) {
        case "s":         return shared[Number(raw)] === undefined ? "" : shared[Number(raw)];
        case "inlineStr": return textOf(c.Find("is"));
        case "str":       return raw;
        case "b":         return raw === "1" ? "TRUE" : "FALSE";
        case "e":         return raw;
        default: {
            if (raw === "")
                return "";

            const n = Number(raw);

            if (!Number.isFinite(n))
                return raw;
            return dateStyles[Number(c.Attr("s"))] ? dateText(n, epoch1904) : String(n);
        }
        }
    }
}
