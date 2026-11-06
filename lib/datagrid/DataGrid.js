/*
 * DataGrid -- the table a business application expects: leading columns that
 * stay put while the rest scroll across, a row of totals that stays under its
 * columns, sorting, and rows copied to and pasted from a spreadsheet.
 *
 * **It is four `TableView`s and no new widget.** The frozen columns are one
 * table and the rest another, scrolled together; the totals are two more tables
 * of one row with no headings, under them. Everything that keeps them in line
 * is a property every table has: `ScrollY` and `ScrollX` assigned from the other
 * one's `Scroll`, `ColumnWidths` for the widths really drawn, `ColumnResize` for
 * a heading's edge dragged, `Headers` off for the totals. Measured before it was
 * written: two tables scrolled together stay in line to the last row, even when
 * only one carries a horizontal bar (`docs/agents/tables.md`).
 *
 * **It speaks the table's own words**, with one difference that is the point of
 * it: a column is always its **declared index**, whichever half draws it. The
 * data is the grid's -- an array of rows, each the array `Add` takes -- so
 * sorting, filtering and the totals are worked out once and both halves are
 * filled from the same rows in the same order.
 *
 * A `Columns` entry is a `TableView` column with two more keys:
 *
 *     { Text: "Amount", Width: 100, Alignment: "End", Total: "sum", Decimals: 2 }
 *
 * `Total` is `"sum"`, `"count"`, `"avg"`, `"min"` or `"max"`; a column with one
 * puts the row of totals under the grid. Numbers are summed exactly: a value
 * that is a `Decimal`, or text that reads as one, is added as a `Decimal`.
 *
 * What it does not do yet, and why: **groups** -- folding a node raises no
 * event, so two trees cannot be kept folded alike -- and **a rectangle of
 * cells** marked on screen, since a table selects rows. Copy takes the selected
 * rows, every column; Paste writes from the current cell down and across.
 */
"use strict";

/* The keys a column has here and a `TableView` does not. */
const GRID_ONLY = ["Total", "Decimals"];
const TOTALS = ["sum", "count", "avg", "min", "max"];

export class DataGrid extends Component {

    /* Select()
     *   the selection moved, in either half
     */
    /* Activate()
     *   a double click or Enter on a row
     */
    /* CellEdit(row, column, text, how)
     *   an edit ended, as `TableView`'s, with `column` the declared index;
     *   `how` is `"paste"` for a cell `Paste` wrote. **`false` refuses it**,
     *   a string is kept instead of the text
     */
    /* Filter(row)
     *   asked of each row, as `TableView`'s; **`false` hides it** in both halves
     */
    static Events = ["Select", "Activate", "CellEdit", "Filter"];

    constructor() {
        super();
        this.data     = [];
        this._columns = [];
        this._frozen  = 0;
        this.syncing  = false;
        this.current  = { Row: -1, Column: -1 };
    }

    /* --- what it is ------------------------------------------------------- */

    /**
     * the columns, as `TableView`'s `{ Text, Width, Alignment, Editor, Link,
     * Visible }` with `Total` (`"sum"`, `"count"`, `"avg"`, `"min"`, `"max"`)
     * and `Decimals` for the row of totals. A column is always its declared
     * index, in whichever half it is drawn
     */
    get Columns() { return this._columns.slice(); }
    set Columns(v) {
        if (!Array.isArray(v))
            throw new TypeError("Columns: an array of columns");
        for (const c of v) {
            if (!c || typeof c !== "object")
                throw new TypeError("Columns: each column is an object");
            if (c.Total !== undefined && c.Total !== "" && !TOTALS.includes(c.Total))
                throw new RangeError(`Columns: Total is one of ${TOTALS.join(", ")}`);
        }
        this._columns = v.map((c) => ({ ...c }));
        this.layout();
    }

    /**
     * how many leading columns stay put while the rest scroll across. Default
     * `0`, every column scrolling
     */
    get Frozen() { return this._frozen; }
    set Frozen(v) {
        const n = Math.trunc(Number(v));
        if (!(n >= 0))
            throw new RangeError("Frozen: a count of columns, 0 or more");
        this._frozen = n;
        this.layout();
    }

    /**
     * whether a click on a heading sorts the rows, in both halves. Default
     * `false`
     */
    get Sortable() { return !!this._sortable; }
    set Sortable(v) {
        this._sortable = !!v;
        this.FrozenView.Sortable = this._sortable;
        this.MainView.Sortable   = this._sortable;
    }

    /**
     * more than one row at a time, in both halves. Default `false`
     */
    get MultiSelect() { return !!this._multi; }
    set MultiSelect(v) {
        this._multi = !!v;
        this.FrozenView.MultiSelect = this._multi;
        this.MainView.MultiSelect   = this._multi;
    }

    /* --- the rows ---------------------------------------------------------- */

    /**
     * how many rows the grid holds
     * @returns number
     */
    get Count() { return this.data.length; }

    /**
     * adds a row, the array of its values in declared column order
     * @returns DataGrid
     */
    Add(row) {
        return this.AddRows([row]);
    }

    /**
     * adds many rows in one change to both halves
     * @returns DataGrid
     */
    AddRows(rows) {
        if (!Array.isArray(rows))
            throw new TypeError("AddRows: an array of rows");
        const fresh = rows.map((r) => {
            if (!Array.isArray(r))
                throw new TypeError("AddRows: each row is an array of values");
            return r.slice();
        });
        for (const r of fresh) this.data.push(r);
        this.FrozenView.AddRows(fresh.map((r) => this.half(r, true)));
        this.MainView.AddRows(fresh.map((r) => this.half(r, false)));
        this.total();
        return this;
    }

    /**
     * takes every row away
     * @returns DataGrid
     */
    Clear() {
        this.data = [];
        this.FrozenView.Clear();
        this.MainView.Clear();
        this.total();
        return this;
    }

    /**
     * that row's values, in declared column order
     * @returns Array
     */
    Row(index) {
        this.checkRow(index, "Row");
        return this.data[index].slice();
    }

    /**
     * one value, by row and declared column
     */
    Cell(row, column) {
        this.checkRow(row, "Cell");
        this.checkColumn(column, "Cell");
        return this.data[row][column];
    }

    /**
     * writes one value, by row and declared column, in whichever half draws it
     * @returns DataGrid
     */
    SetCell(row, column, value) {
        this.checkRow(row, "SetCell");
        this.checkColumn(column, "SetCell");
        this.data[row][column] = value;
        const [view, local] = this.where(column);
        view.SetCell(row, local, value);
        this.total();
        return this;
    }

    /**
     * takes one row out
     * @returns DataGrid
     */
    RemoveRow(index) {
        this.checkRow(index, "RemoveRow");
        this.data.splice(index, 1);
        this.FrozenView.RemoveRow(index);
        this.MainView.RemoveRow(index);
        this.total();
        return this;
    }

    /**
     * asks `Filter` of every row again, in both halves
     * @returns DataGrid
     */
    Refilter() {
        this.FrozenView.Refilter();
        this.MainView.Refilter();
        return this;
    }

    /* --- the selection ----------------------------------------------------- */

    /**
     * the selected row, `-1` for none. Assigning selects it in both halves
     */
    get Index() { return this.MainView.Index; }
    set Index(v) {
        this.MainView.Index = v;
    }

    /**
     * every selected row, as an array of indices in order
     * @returns number[]
     */
    get Selection() { return this.MainView.Selection; }

    /* --- totals ------------------------------------------------------------ */

    /**
     * the row of totals as it is drawn: one value per declared column, `""`
     * where a column declares none
     * @returns string[]
     */
    Totals() {
        return this._columns.map((c, i) => this.totalOf(c, i));
    }

    /* --- a spreadsheet ----------------------------------------------------- */

    /**
     * the selected rows as tab-separated text, every column in declared order
     * -- what a spreadsheet pastes -- put on the clipboard and answered
     * @returns string
     */
    Copy() {
        const rows = this.MainView.Selection;
        const text = rows.map((r) => this.data[r].map((v) => clean(v)).join("\t")).join("\n");
        if (text) Clipboard.Copy(text);
        return text;
    }

    /**
     * writes tab-separated text from the current cell down and across: a
     * spreadsheet's copied rows, or `text` when given. Each cell is raised as
     * `CellEdit` with `"paste"`, so a handler can refuse it. Rows past the last
     * one are not made. With no `text` the clipboard is read, which answers
     * later
     */
    Paste(text) {
        if (text === undefined) {
            Clipboard.Paste((t) => { if (typeof t === "string") this.Paste(t); });
            return this;
        }
        const at = this.current;
        if (at.Row < 0 || at.Column < 0) return this;

        const lines = String(text).replace(/\r/g, "").replace(/\n$/, "").split("\n");
        for (let i = 0; i < lines.length; i++) {
            const row = at.Row + i;
            if (row >= this.data.length) break;
            const cells = lines[i].split("\t");
            for (let j = 0; j < cells.length; j++) {
                const column = at.Column + j;
                if (column >= this._columns.length) break;
                const answer = this.Emit("CellEdit", row, column, cells[j], "paste");
                if (answer === false) continue;
                this.SetCell(row, column, typeof answer === "string" ? answer : cells[j]);
            }
        }
        return this;
    }

    /* --- inside: the halves ------------------------------------------------ */

    /* How many columns the frozen half really holds. */
    get frozenCount() { return Math.min(this._frozen, this._columns.length); }

    /* A column as a `TableView` takes it, with the grid's own keys off. */
    tableColumn(c, plain) {
        const out = {};
        for (const k of Dictionary.Keys(c))
            if (!GRID_ONLY.includes(k) && !(plain && (k === "Editor" || k === "Link")))
                out[k] = c[k];
        return out;
    }

    /* A row's values for one half. */
    half(row, frozen) {
        const n = this.frozenCount;
        return frozen ? row.slice(0, n) : row.slice(n);
    }

    /* The table a declared column is drawn in, and its index there. */
    where(column) {
        const n = this.frozenCount;
        return column < n ? [this.FrozenView, column] : [this.MainView, column - n];
    }

    /* The declared index of a column one half reports. */
    declared(view, local) {
        return view === this.FrozenView || view === this.FrozenTotals ? local : local + this.frozenCount;
    }

    layout() {
        if (!this.MainView) return;
        const n    = this.frozenCount;
        const cols = this._columns;

        this.FrozenView.Columns = cols.slice(0, n).map((c) => this.tableColumn(c, false));
        this.MainView.Columns   = cols.slice(n).map((c) => this.tableColumn(c, false));
        this.FrozenView.Visible = n > 0;

        const totals = cols.some((c) => c.Total);
        this.Foot.Visible         = totals;
        this.FrozenTotals.Visible = totals && n > 0;

        this.FrozenView.Clear();
        this.MainView.Clear();
        this.FrozenView.AddRows(this.data.map((r) => this.half(r, true)));
        this.MainView.AddRows(this.data.map((r) => this.half(r, false)));
        this.fit();
        this.total();
    }

    /*
     * The widths: the frozen half as wide as its columns, and each row of
     * totals given the widths its table really draws -- measured, since a
     * column that sized itself has no number until it is drawn.
     */
    fit() {
        const n = this.frozenCount;
        if (n > 0) {
            const drawn = this.FrozenView.ColumnWidths;
            const wide  = drawn.reduce((a, b) => a + b, 0) ||
                          this._columns.slice(0, n).reduce((a, c) => a + (c.Width || 80), 0);
            this.FrozenView.Width   = wide + 2;
            this.FrozenTotals.Width = wide + 2;
        }
        const line = (view, totals, from, to) => {
            const drawn = view.ColumnWidths;
            totals.Columns = this._columns.slice(from, to).map((c, i) => ({
                ...this.tableColumn(c, true), Width: drawn[i] || c.Width || 0 }));
        };
        line(this.FrozenView, this.FrozenTotals, 0, n);
        line(this.MainView, this.MainTotals, n, this._columns.length);
        this.total();
    }

    /* The row of totals, written into both one-row tables. */
    total() {
        if (!this.MainTotals || !this.Foot.Visible) return;
        const all = this.Totals();
        const n   = this.frozenCount;
        for (const [view, part] of [[this.FrozenTotals, all.slice(0, n)],
                                    [this.MainTotals, all.slice(n)]]) {
            view.Clear();
            if (part.length) view.Add(part);
        }
        const h = this.MainView.RowHeight;
        if (h > 0) {
            this.MainTotals.Height   = h + 2;
            this.FrozenTotals.Height = h + 2;
        }
    }

    /* One column's total, as text. */
    totalOf(c, i) {
        if (!c.Total) return "";
        const values = this.data.map((r) => r[i]).filter((v) => v !== undefined && v !== null && v !== "");
        if (c.Total === "count") return String(values.length);

        const nums = [];
        for (const v of values) {
            const d = toDecimal(v);
            if (d !== null) nums.push(d);
        }
        if (!nums.length) return "";
        let out;
        if (c.Total === "sum" || c.Total === "avg") {
            out = nums.reduce((a, b) => a + b, new Decimal("0"));
            if (c.Total === "avg") out = out / new Decimal(String(nums.length));
        } else {
            out = nums.reduce((a, b) => ((c.Total === "min" ? b < a : b > a) ? b : a));
        }
        return c.Decimals !== undefined ? out.Round(Number(c.Decimals)).toString() : out.toString();
    }

    checkRow(index, who) {
        if (!(Number.isInteger(index) && index >= 0 && index < this.data.length))
            throw new RangeError(`${who}: ${index} is not a row`);
    }

    checkColumn(column, who) {
        if (!(Number.isInteger(column) && column >= 0 && column < this._columns.length))
            throw new RangeError(`${who}: ${column} is not a column`);
    }

    /* --- inside: keeping the halves in line -------------------------------- */

    /* Both ways, and once: an assignment raises the other table's `Scroll`. */
    together(fn) {
        if (this.syncing) return;
        this.syncing = true;
        try { fn(); } finally { this.syncing = false; }
    }

    MainView_Scroll(x, y) {
        this.together(() => {
            this.FrozenView.ScrollY = y;
            this.MainTotals.ScrollX = x;
        });
    }
    FrozenView_Scroll(x, y)   { this.together(() => { this.MainView.ScrollY = y; }); }
    MainTotals_Scroll(x, y)   { this.together(() => { this.MainView.ScrollX = x; }); }

    /* A heading's edge dragged: the totals under it, and the frozen half's
     * width, follow. */
    MainView_ColumnResize()   { this.fit(); }
    FrozenView_ColumnResize() { this.fit(); }
    MainView_Allocated()      { this.fit(); }

    /* The selection, mirrored into the other half. */
    mirror(from, to) {
        this.together(() => {
            if (this._multi) {
                to.DeselectAll();
                for (const i of from.Selection) to.Select(i);
            } else {
                to.Index = from.Index;
            }
        });
        if (!this.syncing) this.Emit("Select");
    }
    MainView_Select()   { if (!this.syncing) this.mirror(this.MainView, this.FrozenView); }
    FrozenView_Select() { if (!this.syncing) this.mirror(this.FrozenView, this.MainView); }

    MainView_Activate()   { this.Emit("Activate"); }
    FrozenView_Activate() { this.Emit("Activate"); }

    /* The current cell, in declared terms: where `Paste` writes. */
    MainView_CellChange(row, column)   { this.current = { Row: row, Column: column < 0 ? -1 : this.declared(this.MainView, column) }; }
    FrozenView_CellChange(row, column) { this.current = { Row: row, Column: column < 0 ? -1 : column }; }

    /* An edit, said in declared terms and kept in the grid's rows. */
    edited(view, row, local, text, how) {
        const column = this.declared(view, local);
        const answer = this.Emit("CellEdit", row, column, text, how);
        if (answer === false) return false;
        const kept = typeof answer === "string" ? answer : text;
        if (row >= 0 && row < this.data.length) {
            this.data[row][column] = kept;
            this.total();
        }
        return kept;
    }
    MainView_CellEdit(row, column, text, how)   { return this.edited(this.MainView, row, column, text, how); }
    FrozenView_CellEdit(row, column, text, how) { return this.edited(this.FrozenView, row, column, text, how); }

    /* A row hidden is hidden in both halves: the same answer, asked by each. */
    MainView_Filter(row)   { return this.Emit("Filter", row); }
    FrozenView_Filter(row) { return this.Emit("Filter", row); }

    /* A heading clicked: the grid's rows sorted, and both halves filled again. */
    sorted(view, local, ascending) {
        const column = this.declared(view, local);
        const key = (v) => (toDecimal(v) !== null ? toDecimal(v) : null);
        const numeric = this.data.every((r) => r[column] === undefined || r[column] === "" || key(r[column]) !== null);
        this.data.sort((a, b) => {
            let d;
            if (numeric) {
                const x = key(a[column]), y = key(b[column]);
                d = x === null ? (y === null ? 0 : -1) : y === null ? 1 : (x < y ? -1 : x > y ? 1 : 0);
            } else {
                d = Locale.Compare(String(a[column] ?? ""), String(b[column] ?? ""));
            }
            return ascending ? d : -d;
        });
        this.FrozenView.Clear();
        this.MainView.Clear();
        this.FrozenView.AddRows(this.data.map((r) => this.half(r, true)));
        this.MainView.AddRows(this.data.map((r) => this.half(r, false)));
    }
    MainView_Sort(column, ascending)   { this.sorted(this.MainView, column, ascending); }
    FrozenView_Sort(column, ascending) { this.sorted(this.FrozenView, column, ascending); }

    /* Ctrl+C and Ctrl+V, in either half. */
    keyed(key, ctrl) {
        if (!ctrl) return false;
        const k = String(key).toLowerCase();
        if (k === "c") { this.Copy(); return true; }
        if (k === "v") { this.Paste(); return true; }
        return false;
    }
    MainView_KeyPress(key, ctrl)   { return this.keyed(key, ctrl); }
    FrozenView_KeyPress(key, ctrl) { return this.keyed(key, ctrl); }
}

/* A value as a `Decimal`, or null: a `Decimal` as it is, a number by its text,
 * and text that reads as one. */
function toDecimal(v) {
    if (v instanceof Decimal) return v;
    if (typeof v === "number") return Number.isFinite(v) ? new Decimal(String(v)) : null;
    if (typeof v !== "string" || !v.trim()) return null;
    try { return new Decimal(v.trim()); } catch (e) { return null; }
}

/* A value as one cell of tab-separated text: no tab or line break inside. */
function clean(v) {
    return v === undefined || v === null ? "" : String(v).replace(/[\t\r\n]+/g, " ");
}
