/*
 * `lib/xlsx`, held to what [docs/llm/xlsx.md](../../docs/llm/xlsx.md) promises.
 *
 * **The writer has no reader here to agree with**, so the assertions are the
 * format's own: the parts are opened with `Zip`, the sheet is parsed with `Xml`
 * and every kind of cell is read back where the format puts it. A value that
 * *looks* right is not enough and this is the test that says so -- `01234` as a
 * number shows the same in a spreadsheet until somebody in Córdoba is somewhere
 * else, and a date written as text passes every reader that only shows values,
 * which is why the date is asserted as the serial plus the style that names the
 * date format. `unzip -t` is the second opinion when the machine has it; the
 * program that really opens a workbook is the app suite's `soffice`, which is
 * the caller that made this a library.
 */
"use strict";

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail ? `${name}: ${detail}` : name);
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function throws(name, fn, part) {
    try {
        fn();
        failures.push(`${name}: expected a throw, none happened`);
    } catch (e) {
        if (part && String(e.message).indexOf(part) < 0)
            failures.push(`${name}: threw ${e.message}, which does not name ${part}`);
        else passed++;
    }
}

const SCRATCH = `/tmp/bta-test-xlsx${Application.Arguments[0] ? `-${Application.Arguments[0]}` : ""}`;

class XlsxTest extends Form {

    Form_Open() {
        Directory.Make(SCRATCH);
        try {
            this.run();
        } catch (e) {
            failures.push("threw: " + e.message + "\n" + e.stack);
        }
        print("");
        for (const f of failures) print(`  FAIL  ${f}`);
        print(`xlsx: ${passed} passed, ${failures.length} failed`);
        Application.Quit(failures.length ? 1 : 0);
    }

    run() {
        check("Xlsx.Available is a boolean", typeof Xlsx.Available === "boolean");

        /* libxml2 is optional at build time, so this is the fork every optional
         * dependency gets: the writer refuses by name without it, and the
         * round trip below is the build that has it. */
        if (!Xlsx.Available) {
            const said = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
            const off = said(() => Xlsx.Write(File.Join(SCRATCH, "off.xlsx"), [{ Name: "S", Columns: [{ Text: "T" }], Rows: [["x"]] }]));
            check("no libxml2: Write refuses naming the package", off.includes("libxml2"), off);
            check("...and writes nothing", !File.Exists(File.Join(SCRATCH, "off.xlsx")));
            return;
        }

        const path = File.Join(SCRATCH, "kinds.xlsx");

        /* One sheet of every kind, and a second sheet so the container is more
         * than one. The text column holds the two cases that make the point:
         * a postal code that must stay text, and a control character the writer
         * drops so `Xml` can write the part at all. */
        const sheets = [
            { Name: "Kinds",
              Columns: [{ Text: "Text" }, { Text: "Number", Kind: "number" }, { Text: "Money", Kind: "money" },
                        { Text: "Date", Kind: "date" }, { Text: "Bool", Kind: "bool" }, { Text: "Empty" }],
              Rows: [
                  ["01234", 1, new Decimal("1234.50"), "2024-03-01", true, ""],
                  ["  spaces  ", -2, new Decimal("-12.75"), "1999-12-31", false, null],
                  ["Álvarez & <Hijos>", 3.5, new Decimal("0.5"), "2000-02-29", true, undefined],
                  ["ctrl\u0001char\ttab", 4, 5, "2026-10-02", false, "x"],
              ] },
            { Name: "Second", Columns: [{ Text: "Only" }], Rows: [["one"]] },
        ];

        eq("Write answers the sheet count", Xlsx.Write(path, sheets), 2);
        check("the workbook is there", File.Exists(path), path);
        check("and leaves no temporary beside it",
              Directory.List(SCRATCH).filter((n) => /\.xlsx\.[A-Za-z0-9]{6}$/.test(n)).length === 0,
              Directory.List(SCRATCH).join(" "));

        const wb = Zip.Open(path);
        for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
                            "xl/_rels/workbook.xml.rels", "xl/styles.xml",
                            "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"])
            check(`the container holds ${part}`, wb.Read(part) !== null);

        const workbook = Xml.ParseBytes(wb.Read("xl/workbook.xml")).Root;
        eq("the workbook lists its sheets in order",
           workbook.Find("sheets").FindAll("sheet").map((s) => s.Attr("name")).join(","), "Kinds,Second");
        check("each pointing at its part through r:id",
              workbook.Find("sheets").FindAll("sheet").every((s) => /^rId\d+$/.test(s.AttrNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || "")),
              workbook.Find("sheets").FindAll("sheet").map((s) => s.Attr("r:id")).join(" "));

        const sheet = Xml.ParseBytes(wb.Read("xl/worksheets/sheet1.xml")).Root;
        const cells = {};
        for (const row of sheet.Find("sheetData").FindAll("row"))
            for (const c of row.FindAll("c"))
                cells[c.Attr("r")] = c;
        const value  = (ref) => cells[ref] && cells[ref].Find("v") ? cells[ref].Find("v").Text : null;
        const inline = (ref) => cells[ref] && cells[ref].Find("is") && cells[ref].Find("is").Find("t")
                                ? cells[ref].Find("is").Find("t").Text : null;

        /* text: inline, spaces kept, and `01234` stays text */
        eq("text is an inline string", cells.A2.Attr("t"), "inlineStr");
        eq("...and keeps its leading zero", inline("A2"), "01234");
        eq("...with its spaces kept", inline("A3"), "  spaces  ");
        eq("...its ampersand and angle brackets", inline("A4"), "Álvarez & <Hijos>");
        eq("...and a control character dropped with a tab kept", inline("A5"), "ctrlchar\ttab");
        eq("the text says the space is on purpose",
           cells.A2.Find("is").Find("t").AttrNS("http://www.w3.org/XML/1998/namespace", "space"), "preserve");

        /* number and money: a value, and money names the style */
        eq("a number is a number", value("B2"), "1");
        eq("...negative too", value("B3"), "-2");
        eq("...and a fraction", value("B4"), "3.5");
        eq("a number cell is not an inline string", cells.B2.Attr("t"), null);
        eq("money keeps the decimal's own digits", value("C2"), "1234.50");
        eq("...and the style that shows two", cells.C2.Attr("s"), "3");
        eq("...a negative one", value("C3"), "-12.75");
        eq("...and a plain number in a money column", value("C5"), "5");

        /* date: a serial with the date style, not text */
        eq("2024-03-01 is the number 45352", value("D2"), "45352");
        eq("31 December 1999 is 36525", value("D3"), "36525");
        eq("29 February 2000 is 36585", value("D4"), "36585");
        eq("2 October 2026 is 46297", value("D5"), "46297");
        eq("a date cell is not an inline string", cells.D2.Attr("t"), null);
        eq("...and names the date format", cells.D2.Attr("s"), "2");

        /* bool: the format's own boolean */
        eq("a boolean is a boolean", cells.E2.Attr("t"), "b");
        eq("...true is 1", value("E2"), "1");
        eq("...and false is 0", value("E3"), "0");

        /* empty: no cell at all, which is how an empty cell is written */
        check("an empty value is no cell", cells.F2 === undefined, JSON.stringify(cells.F2));
        check("...nor is null", cells.F3 === undefined);
        check("...nor undefined", cells.F4 === undefined);
        check("...while a value beside them is", cells.F5 !== undefined);

        /* the header row is bold, and a second sheet is a sheet of its own */
        eq("the header is a bold inline string", cells.A1.Attr("t") + ":" + cells.A1.Attr("s"), "inlineStr:1");
        eq("the second sheet has its own part",
           Xml.ParseBytes(wb.Read("xl/worksheets/sheet2.xml")).Root.Find("sheetData").FindAll("row").length, 2);

        /* the styles: the date format and the money format are the two named */
        const styles = Xml.ParseBytes(wb.Read("xl/styles.xml")).Root;
        eq("the date format is declared", styles.Find("numFmts").Find("numFmt").Attr("formatCode"), "yyyy\\-mm\\-dd");
        eq("and four cell formats", styles.Find("cellXfs").FindAll("xf").length, 4);
        wb.Close();

        /* --- the refusals, and that a refusal writes nothing ------------------ */
        const nothing = File.Join(SCRATCH, "nothing.xlsx");
        const base = { Name: "S", Columns: [{ Text: "T" }], Rows: [["x"]] };

        throws("nothing to write is refused", () => Xlsx.Write(nothing, []), "nothing to write");
        throws("a sheet with no columns is refused", () => Xlsx.Write(nothing, [{ Name: "S", Rows: [] }]), "no columns");
        throws("a name longer than 31 is refused",
               () => Xlsx.Write(nothing, [{ ...base, Name: "x".repeat(32) }]), "31");
        throws("a name with a bracket is refused",
               () => Xlsx.Write(nothing, [{ ...base, Name: "a[b" }]), "cannot have");
        throws("a name in apostrophes is refused",
               () => Xlsx.Write(nothing, [{ ...base, Name: "'S'" }]), "apostrophe");
        throws("two names equal without case are refused",
               () => Xlsx.Write(nothing, [{ ...base, Name: "One" }, { ...base, Name: "one" }]), "two sheets");
        throws("a value that is not a number is refused",
               () => Xlsx.Write(nothing, [{ Name: "S", Columns: [{ Text: "N", Kind: "number" }], Rows: [["12 euros"]] }]), "not a number");
        throws("a value that is not a date is refused",
               () => Xlsx.Write(nothing, [{ Name: "S", Columns: [{ Text: "D", Kind: "date" }], Rows: [["2024-3-1"]] }]), "YYYY-MM-DD");
        throws("a value that is not a boolean is refused",
               () => Xlsx.Write(nothing, [{ Name: "S", Columns: [{ Text: "B", Kind: "bool" }], Rows: [["yes"]] }]), "true or false");
        throws("a kind that is not one of the five is refused",
               () => Xlsx.Write(nothing, [{ Name: "S", Columns: [{ Text: "C", Kind: "color" }], Rows: [["red"]] }]), "not text, number, money, date or bool");
        throws("a row with more values than columns is refused",
               () => Xlsx.Write(nothing, [{ Name: "S", Columns: [{ Text: "T" }], Rows: [["a", "b"]] }]), "values for");
        check("and a refused write leaves no file", !File.Exists(nothing));

        if (Application.HasCommand("unzip")) {
            const t = Exec.Wait(["unzip", "-t", path], { Timeout: 30000 });
            check("`unzip -t` finds the container sound",
                  t.ExitCode === 0 && t.Output.includes("No errors detected"), t.Output);
        }
    }
}
