/*
 * A spreadsheet viewer: the `.xlsx` a customer sent, on screen.
 *
 * Four things meet here, each doing the one job it is for:
 *
 *     Zip         the container: an .xlsx is a zip of XML parts
 *     Xml         the parts: workbook, shared strings, styles, the sheet
 *     Task        `SheetReader`, so a big sheet does not freeze the window
 *     TableView   in its on-demand mode: it holds *no rows*
 *
 * ## Why the table holds nothing
 *
 * A sheet is as long as its author made it, and a `TableView` that is *given* its
 * rows builds a model entry per cell. In on-demand mode the table is told how many
 * rows there are (`Count`) and **asks** `Data(row, column)` for each cell it is
 * about to draw -- so a hundred thousand rows cost the rows themselves, held here as
 * arrays of strings, and a screenful of widgets. That is the whole of the code that
 * shows the sheet: `Grid_Data` below.
 *
 * ## The retired run
 *
 * Opening another file, or another sheet, while a read is still going is a change of
 * mind. The old task is asked to stop and **its answer still arrives**, so each
 * answer asks whether its run is still the one that matters (`gen`) and is dropped
 * where it lands if not -- the same bookkeeping `examples/usage` and
 * `examples/backup` document at length, and the reason no flag is kept.
 *
 * Opening a file is a button, a shortcut, a drop on the window (`AcceptFiles` in the
 * `.form`, `Form_FileDrop` here) or an argument:
 * `./build/bintana examples/sheets accounts.xlsx`.
 *
 * It needs libxml2, which is optional at build time: `Xml.Available` says whether it
 * is there, and without it this says so instead of failing on the first part.
 */
"use strict";

/* 0 -> "A", 25 -> "Z", 26 -> "AA": a spreadsheet's own heading for a column. */
function columnName(n) {
    let out = "";

    for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26))
        out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
    return out;
}

class SheetForm extends Form {

    /* The rows as the reader answered them -- arrays of display strings, which is
     * all the table is ever asked for -- and where they came from. */
    rows    = [];
    path    = "";
    current = 0;

    /* The run in flight, and the counter that says which run answers belong to. */
    job = null;
    gen = 0;

    Form_Open() {
        if (!Xml.Available) {
            this.LblStatus.Text = Locale.Text("This build of Bintana has no libxml2, which reading a spreadsheet needs.");
            this.BtnOpen.Enabled = false;
            return;
        }

        this.LblStatus.Text = Locale.Text("Open an .xlsx, or drop one on this window.");

        const given = Application.Arguments[0];

        if (given)
            this.open(given, 0);
    }

    /* --- choosing --------------------------------------------------------- */

    BtnOpen_Click() {
        Dialog.OpenFile(Locale.Text("Open a spreadsheet"),
                        { Filters: [[Locale.Text("Spreadsheets"), "*.xlsx"],
                                    [Locale.Text("All files"), "*"]] },
                        (path) => this.open(path, 0));
    }

    Form_FileDrop(paths) {
        this.open(paths[0], 0);
    }

    /* The selection moved: another sheet of the same workbook. Compared with what
     * is loaded and not guarded by a flag, because filling the list raises this
     * too, and *when* is GTK's to say. */
    Cmb_Select() {
        if (this.path && this.Cmb.Index >= 0 && this.Cmb.Index !== this.current)
            this.open(this.path, this.Cmb.Index);
    }

    /* --- reading ---------------------------------------------------------- */

    open(path, sheet) {
        if (!File.Exists(path) || File.IsDir(path)) {
            Message.Error("{0} is not a file.", path);
            return;
        }

        this.retire();

        const gen = this.gen;
        const t   = new SheetReader();

        t.Done  = (r) => { if (gen === this.gen) this.loaded(path, r); };
        t.Error = (m) => { if (gen === this.gen) this.failed(path, m); };

        this.job = t;
        this.LblStatus.Text = Locale.Text("Reading {0} …", File.Name(path));
        t.Start({ path, sheet });
    }

    /* The run is over, whatever it says from now on. */
    retire() {
        this.gen++;
        if (this.job) {
            this.job.Stop();
            this.job = null;
        }
    }

    loaded(path, r) {
        this.job     = null;
        this.path    = path;
        this.current = r.current;
        this.rows    = r.rows;

        this.LblPath.Text = path;

        /* The table is told its columns first and its length second: the length is
         * what makes it start asking. Column 0 is the row number a sheet shows in
         * its margin, so a cell is `Data(row, column)` with the column off by one. */
        const columns = [{ Text: "", Width: 56, Alignment: "Right" }];

        for (let i = 0; i < r.width; i++)
            columns.push({ Text: columnName(i), Width: 110 });
        this.Grid.Columns = columns;
        this.Grid.Count   = r.rows.length;

        this.Cmb.Items   = r.sheets;
        this.Cmb.Index   = r.current;
        this.Cmb.Enabled = r.sheets.length > 1;

        this.LblStatus.Text = Locale.Text("{0}: {1} rows, {2} columns", r.sheets[r.current],
                                          Locale.Number(r.rows.length), r.width)
            + (r.truncated ? Locale.Text(" -- only the first part is shown") : "");
    }

    failed(path, message) {
        this.job = null;
        this.LblStatus.Text = Locale.Text("{0} could not be read: {1}", File.Name(path), message);
    }

    /* --- the whole of showing it ------------------------------------------- */

    /* The table needs a cell: the answer is the return value. */
    Grid_Data(row, column) {
        if (column === 0)
            return String(row + 1);

        const cells = this.rows[row];

        return cells && cells[column - 1] !== undefined ? cells[column - 1] : "";
    }
}
