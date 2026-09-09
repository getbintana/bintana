/*
 * TableView, three ways.
 *
 * A table either holds its rows or it does not, and the ones it holds may nest.
 * They are worth seeing side by side because everything else follows from which
 * one you picked:
 *
 *   Rows it holds        `Add(values)`, and the table owns the strings. `Cell`,
 *                        `SetCell`, `SetIcon`, `SortBy` and `Row` all answer,
 *                        because there is something there to answer about.
 *
 *   Rows it does not     `Count = N`, and the table asks `Data(row, column)`
 *                        for each cell it draws. A hundred thousand rows cost a
 *                        number; the same four calls above are refused, because
 *                        the values live wherever the handler reads them.
 *
 *   Rows that nest       `Add(values, { Key, Parent })`, and the table is a
 *                        tree: the headings sit over the hierarchy, every node
 *                        carries its own fields, and it is one scrolling
 *                        surface. Addressed by **key** from then on, because a
 *                        position is a position in the *visible* list and moves
 *                        when something above it collapses.
 *
 * The `Data` page counts how many times the handler was called, which is the
 * whole argument for it being there: a hundred thousand rows, a few dozen
 * questions.
 *
 * **The third page is the one that used to need two controls.** A `TreeView` for
 * the hierarchy and a `TableView` beside it for the fields, re-filled whenever
 * the selection moved -- which lost the headings over the tree, the alignment
 * per row, the single scroll, and kept every node's extra values in a second
 * structure by hand.
 */
"use strict";

/* What the first page starts with. A size is text like everything else in a
 * cell -- formatting a number is the job of whoever knows how it should read. */
const FILES = [
    ["README.md",   "4.1 kB", "Markdown"],
    ["Form1.form",  "2.6 kB", "Form"],
    ["Form1.js",    "7.0 kB", "JavaScript"],
    ["app.css",     "312 B",  "Stylesheet"],
    ["project.json", "148 B", "Manifest"],
];

/*
 * The folder tree of the third page: key, parent, and the three columns. A
 * parent comes before its children, which is the one thing `Add` asks of the
 * order -- a node cannot go under a key nothing added yet.
 */
const TREE = [
    ["/src",           "",      "src",         "",        "Folder"],
    ["/src/main.c",    "/src",  "main.c",      "12.4 kB", "JavaScript"],
    ["/src/bta.h",     "/src",  "bta.h",       "4.0 kB",  "Manifest"],
    ["/src/ui",        "/src",  "ui",          "",        "Folder"],
    ["/src/ui/app.css", "/src/ui", "app.css",  "312 B",   "Stylesheet"],
    ["/src/ui/Form.form", "/src/ui", "Form.form", "2.6 kB", "Form"],
    ["/docs",          "",      "docs",        "",        "Folder"],
    ["/docs/readme.md", "/docs", "readme.md",  "4.1 kB",  "Markdown"],
];

/* An icon per kind, and the first name the desktop actually has wins -- which
 * is why this is a list and not a name. `Application.HasIcon` is the question,
 * and a name nothing answers is dropped rather than drawn as a broken image. */
const KIND_ICON = {
    Markdown:   ["text-x-markdown", "text-x-generic"],
    Form:       ["application-x-designer", "text-x-generic"],
    JavaScript: ["text-x-javascript", "text-x-script", "text-x-generic"],
    Stylesheet: ["text-css", "text-x-generic"],
    Manifest:   ["application-json", "text-x-generic"],
};

function iconFor(kind) {
    const names = KIND_ICON[kind] || [];
    return names.find((n) => Application.HasIcon(n)) || "";
}

/* How many rows the second page claims to have. Large on purpose: the point is
 * that the number costs nothing. */
const BIG_ROWS = 100000;

class Form1 extends Form {

    /* Counted in the Data handler and shown from a timer -- see Big_Data. */
    dataCalls = 0;

    /* Which way the second page is sorted. Sorting a table that does not hold
     * its rows means sorting whatever the handler reads, and here that is one
     * flag: the rows are computed from their index. */
    bigDescending = false;

    Form_Open() {
        /* --- the page that holds its rows ------------------------------- */
        for (const row of FILES) this.addFile(row);

        /* --- the page whose rows nest ------------------------------------ */
        this.growTree();

        /* --- the page that does not -------------------------------------- */
        this.Big.Count = BIG_ROWS;

        /*
         * The label is written from a timer and not from `Data`, and that is
         * not a detail: `Data` runs while GTK is drawing a row, so it has to be
         * a lookup and nothing else. Assigning a Label's text from inside it
         * would be asking the layout to change in the middle of being measured.
         */
        Timer.Every(500, () => this.showBig());

        this.showHeld();
        this.showBig();
        this.showTree();
        this.Files.SetFocus();
    }

    /* --- rows that nest -------------------------------------------------- */

    /*
     * **A row with a `Key` is a node**, and the first one makes the table a
     * tree. `Parent` is another node's key; a row without one is a root.
     *
     * The keys here are paths because that is what this tree is *of* -- they
     * are the application's to choose, and the only rule is that they are
     * unique. Nothing parses them.
     */
    growTree() {
        for (const [key, parent, name, size, kind] of TREE) {
            this.Tree.Add([name, size, kind], parent ? { Key: key, Parent: parent }
                                                     : { Key: key });
            /* Every row in the column carries one, or none: a hidden icon takes
             * no room, so a column where only some rows have one is ragged.
             * `iconFor` is the same question the other page asks -- the first
             * name this desktop actually has. */
            this.Tree.SetIcon(key, 0, kind === "Folder" ? "folder" : iconFor(kind));
        }
    }

    Tree_Select() { this.showTree(); }

    BtnExpand_Click()   { this.Tree.ExpandAll();   this.showTree(); }
    BtnCollapse_Click() { this.Tree.CollapseAll(); this.showTree(); }

    /*
     * Removing a node takes its subtree with it, which is the answer this
     * control gives rather than leaving orphans behind -- so the button says
     * *the folder* and not *the row*.
     */
    BtnPrune_Click() {
        const key = this.Tree.Key;

        if (!key) {
            this.LblTree.Text = Locale.Text("Choose a node first.");
            return;
        }
        this.Tree.Remove(key);
        this.showTree();
    }

    /*
     * What the label says, and every number in it comes from the table: `Count`
     * is every node at every level -- not the rows on screen -- and `Key` is
     * what a program keeps, since `Index` is a position in the visible list.
     */
    showTree() {
        const key = this.Tree.Key;

        this.LblTree.Text = key
            ? Locale.Text("{0} nodes. Selected: {1} — row {2} of what is on screen, " +
                          "which is why the key is what to keep.",
                          String(this.Tree.Count), key, String(this.Tree.Index))
            : Locale.Text("{0} nodes, addressed by key.", String(this.Tree.Count));
    }

    /* ------------------------------------------------- rows it holds ---- */

    /*
     * One row, and its icon.
     *
     * `Add` takes the cells in column order; the icon is a separate call
     * because a cell is text and an icon is a name from the theme -- which is
     * what keeps `Add(["a", "b", "c"])` the way a row is written.
     */
    addFile([name, size, kind]) {
        this.Files.Add([name, size, kind]);
        this.Files.SetIcon(this.Files.Count - 1, 0, iconFor(kind));
    }

    BtnAdd_Click() {
        const n = this.Files.Count + 1;
        this.addFile([`New file ${n}.js`, `${n * 37} B`, "JavaScript"]);
        this.Files.Index = this.Files.Count - 1;
    }

    /*
     * Deleting: back to front.
     *
     * `Selection` is the rows that are selected, in order, and removing one
     * shifts every row after it -- so removing front to back would delete the
     * wrong rows the moment more than one is selected. Reversing is the whole
     * fix and it is the kind of thing that works by accident until someone
     * turns "Many at once" on.
     */
    BtnDelete_Click() {
        const rows = this.Files.Selection;
        if (!rows.length) {
            Message.Info("Nothing is selected.");
            return;
        }
        for (const i of rows.slice().reverse()) this.Files.Remove(i);
        this.showHeld();
    }

    /* One cell, in place: the selection, the scroll position and every other
     * row's widgets survive, which is why a table has a cell setter at all. */
    BtnRename_Click() {
        const at = this.Files.Index;
        if (at < 0) {
            Message.Info("Select a row first.");
            return;
        }
        this.Files.SetCell(at, 0, `${this.Files.Cell(at, 0)} (renamed)`);
    }

    BtnClear_Click() {
        this.Files.Clear();
        this.showHeld();
    }

    ChkMulti_Click() {
        this.Files.MultiSelect = this.ChkMulti.Active;
        this.showHeld();
    }

    Files_Select() { this.showHeld(); }

    /* Double click, or Enter: the row is meant and not merely pointed at. */
    Files_Activate() {
        const at = this.Files.Index;
        if (at >= 0)
            Message.Info("{0} is {1}", this.Files.Cell(at, 0),
                                       this.Files.Cell(at, 2));
    }

    /*
     * The header was clicked. **The table did not reorder itself** -- it never
     * does, because a table that answers `Data` could not, and one word cannot
     * mean two things. Here the table owns its rows, so the answer is one line.
     */
    Files_Sort(column, ascending) {
        this.Files.SortBy(column, ascending);
        this.LblStatus.Text = Locale.Text("Sorted by {0}, {1}",
            this.Files.Columns[column].Text,
            ascending ? Locale.Text("ascending") : Locale.Text("descending"));
    }

    showHeld() {
        const rows = this.Files.Selection;

        this.LblHeld.Text = Locale.Text(
            "{0} rows. Selected: {1}. Click a heading to sort; double click a row.",
            this.Files.Count,
            rows.length ? rows.join(", ") : Locale.Text("none"));

        this.BtnDelete.Enabled = rows.length > 0;
        this.BtnRename.Enabled = this.Files.Index >= 0;
        this.BtnClear.Enabled  = this.Files.Count > 0;
    }

    /* -------------------------------------------- rows it does not ------ */

    /*
     * Asked for every cell the table is about to draw, and answered from
     * nothing but the row number.
     *
     * A string is a cell. `{ Text, Icon }` is a cell with a picture -- which is
     * how a virtual table carries one, since it has no cells for `SetIcon` to
     * hang anything on.
     *
     * **It must be a lookup.** It runs inside GTK's drawing, once per visible
     * cell per rebind, so anything slow here is slow on every scroll -- and
     * anything with a side effect changes the world while the world is being
     * measured. Counting is as far as this goes, and even the label that shows
     * the count is written from a timer instead.
     */
    Big_Data(row, column) {
        this.dataCalls++;

        /* Sorting a table that holds nothing is sorting what the handler reads,
         * and here the rows *are* their index -- so descending is a mirror. */
        const n = this.bigDescending ? BIG_ROWS - 1 - row : row;

        if (column === 0) return String(n);
        if (column === 1) return String(n * n);

        return n % 3 === 0
            ? { Text: Locale.Text("yes"), Icon: iconFor("Form") }
            : Locale.Text("no");
    }

    Big_Sort(column, ascending) {
        this.bigDescending = !ascending;

        /*
         * Re-asking is how a virtual table is refreshed: setting `Count` to what
         * it already is says every row changed, and GTK asks again for the ones
         * on screen. Nothing was reordered -- what changed is the answer.
         */
        this.Big.Count = 0;
        this.Big.Count = BIG_ROWS;
    }

    Big_Select() {
        const at = this.Big.Index;
        this.LblStatus.Text = at < 0 ? ""
            : Locale.Text("Row {0} is selected", at);
    }

    showBig() {
        /* One literal, however long: joined with `+` only the first piece is
         * extracted, so no catalogue could ever match it. */
        this.LblBig.Text = Locale.Text(
            "{0} rows, and {1} questions asked so far. Scroll, and watch the second number: a table that answers Data is only ever asked about what is on screen.",
            BIG_ROWS, this.dataCalls);
    }
}
