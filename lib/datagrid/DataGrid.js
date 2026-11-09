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
 * a heading's edge dragged, `Headers` off for the totals -- and one class of
 * the runtime's sheet, `shared-selection` on the panels around the two halves
 * and around the two halves of the totals,
 * or the theme draws the selection blue in the half with the focus and grey in
 * the other; and `Hover` read from one half and `HoverRow` assigned to the
 * other, so the row under the pointer is lit across. Measured before it was
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
 *     { Text: "Amount", Width: 100, Alignment: "Right", Total: "sum", Decimals: 2 }
 *
 * `Total` is `"sum"`, `"count"`, `"avg"`, `"min"` or `"max"`; a column with one
 * puts the row of totals under the grid. Numbers are summed exactly: a value
 * that is a `Decimal`, or text that reads as one, is added as a `Decimal`.
 *
 * **Groups** (`GroupBy`) make both halves trees built alike: a row per group
 * -- its value and count, each `Total` over its rows -- with its rows under
 * it, folded in both halves at once from `NodeToggle`. The frozen half draws
 * the outline and the scrolling one none (`Tree: false`), each half is filled
 * with one `AddRows(rows, nodes)`, and the grid still speaks of rows by index:
 * the keys inside are `r<index>` and `g<n>`.
 *
 * **A rectangle of cells** is marked with a press and a drag in either half
 * (`SetRange` on the two tables, class `bta-cell-range`), or from code with
 * `SelectRange`; `Copy` answers that rectangle instead of the rows. A plain
 * click marks one cell, which is a spreadsheet's selection; **Ctrl+click is
 * still the table's row selection** and lets the rectangle go. A grouped grid
 * has one too: its group headings sit between the data rows and are not cells,
 * and the rectangle speaks of data rows. `Paste` writes from the current cell
 * down and across, through the rows shown.
 *
 * **Tab walks the cells**, a spreadsheet's convention and not a list's: across
 * both halves, row after row, leaving the grid past the first or last cell.
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
        /* The rectangle marked on screen (`SetRange` on the two halves), its
         * anchor, and the rows the drag began with -- a filter is a handler and
         * asking it per move would walk the whole array. */
        this.range    = null;
        this.anchor   = null;
        this.dragging = false;
        this.dragRows = null;
        this._group   = -1;
        this.groups   = [];          /* grouped: [{ key, value, rows }] in order */
        this.folds    = new Map();   /* a group's value -> open, across rebuilds */
        this.groupDesc = false;
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

    /**
     * the declared column whose values group the rows, `-1` for none. Each
     * group is a row of its own over its rows -- its value and how many, then
     * each `Total` worked out for the group alone -- and folds in both halves
     * at once. Default `-1`
     */
    get GroupBy() { return this._group; }
    set GroupBy(v) {
        const n = Math.trunc(Number(v));
        if (!(n >= -1))
            throw new RangeError("GroupBy: a declared column, or -1 for none");
        this._group = n;
        this.folds.clear();
        this.fill();
    }

    /**
     * opens every group
     * @returns DataGrid
     */
    ExpandAll() { return this.foldAll(true); }

    /**
     * closes every group
     * @returns DataGrid
     */
    CollapseAll() { return this.foldAll(false); }

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
        if (this.grouped()) {
            this.fill();
        } else {
            this.FrozenView.AddRows(fresh.map((r) => this.half(r, true)));
            this.MainView.AddRows(fresh.map((r) => this.half(r, false)));
        }
        this.total();
        return this;
    }

    /**
     * takes every row away
     * @returns DataGrid
     */
    Clear() {
        this.data = [];
        this.fill();
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
        if (this.grouped() && column === this._group) {
            this.fill();                     /* the row is in another group now */
        } else {
            const [view, local] = this.where(column);
            view.SetCell(this.address(row), local, value);
            this.subtotals();
        }
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
        if (this.grouped()) {
            this.fill();                     /* every key after it moved */
        } else {
            this.FrozenView.RemoveRow(index);
            this.MainView.RemoveRow(index);
        }
        this.total();
        return this;
    }

    /**
     * asks `Filter` of every row again, in both halves
     * @returns DataGrid
     */
    Refilter() {
        if (this.grouped()) {
            this.fill();                     /* a tree is filtered as it is built */
        } else {
            this.FrozenView.Refilter();
            this.MainView.Refilter();
        }
        return this;
    }

    /* --- the selection ----------------------------------------------------- */

    /**
     * the selected row, or the anchor row of a cell rectangle, `-1` for none.
     * Assigning selects a row in both halves and lets the rectangle go
     */
    get Index() {
        /* A cell rectangle is a selection too: its anchor row is the row the
         * grid is on, and the table's own row selection was let go when the
         * press made it. */
        if (this.range) return this.range.Row;
        return this.grouped() ? rowOf(this.MainView.Key) : this.MainView.Index;
    }
    set Index(v) {
        /* A row chosen from code is a row selection, not a cell one. */
        if (this.range) this.ClearRange();
        if (this.grouped()) this.MainView.Key = v >= 0 && v < this.data.length ? this.address(v) : "";
        else this.MainView.Index = v;
    }

    /**
     * every selected row, as an array of indices in order -- or, with a cell
     * rectangle marked, the rows it covers
     * @returns number[]
     */
    get Selection() {
        if (this.range) {
            const r0 = Math.min(this.range.Row, this.range.ToRow);
            const r1 = Math.max(this.range.Row, this.range.ToRow);
            const out = [];
            for (let i = r0; i <= r1; i++) out.push(i);
            return out;
        }
        if (!this.grouped()) return this.MainView.Selection;
        return this.MainView.SelectedKeys.map(rowOf).filter((i) => i >= 0);
    }

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
     * -- what a spreadsheet pastes -- put on the clipboard and answered. With a
     * rectangle marked, that rectangle instead
     * @returns string
     */
    Copy() {
        if (this.range) {
            const r = this.range;
            const r0 = Math.min(r.Row, r.ToRow), r1 = Math.max(r.Row, r.ToRow);
            const c0 = Math.min(r.Column, r.ToColumn), c1 = Math.max(r.Column, r.ToColumn);
            const lines = [];

            for (let row = r0; row <= r1; row++) {
                if (row < 0 || row >= this.data.length) continue;
                const cells = [];
                for (let column = c0; column <= c1; column++)
                    cells.push(clean(this.data[row][column]));
                lines.push(cells.join("\t"));
            }
            const text = lines.join("\n");
            if (text) Clipboard.Copy(text);
            return text;
        }

        const rows = this.MainView.Selection;
        const text = rows.map((r) => this.data[r].map((v) => clean(v)).join("\t")).join("\n");
        if (text) Clipboard.Copy(text);
        return text;
    }

    /* --- the rectangle ----------------------------------------------------- */

    /**
     * the rectangle of cells marked on screen, `{ Row, Column, ToRow, ToColumn }`
     * with rows as data indices, or `null`
     */
    get Range() {
        const r = this.range;
        return r ? { Row: r.Row, Column: r.Column, ToRow: r.ToRow, ToColumn: r.ToColumn } : null;
    }

    /**
     * mark a rectangle of cells, in any order, and answer the grid. The row
     * selection lets go, as a press does. A grouped grid speaks of data rows;
     * its group rows are not cells
     */
    SelectRange(row, column, toRow, toColumn) {
        this.letGo();
        this.anchor = { Row: row, Column: column };
        this.range  = { Row: row, Column: column, ToRow: toRow, ToColumn: toColumn };
        this.applyRange();
        this.Emit("Select");
        return this;
    }

    /** take the mark off every cell, leaving no rows selected; answers the grid */
    ClearRange() {
        if (!this.range) return this;
        this.range  = null;
        this.anchor = null;
        this.applyRange();
        this.Emit("Select");
        return this;
    }

    /* A cell has the selection: the table's rows let go, so the rectangle is
     * what is seen. `syncing` because the tables' own `Select` handlers would
     * mirror a selection that is being taken away. */
    letGo() {
        if (!this.MainView) return;
        this.syncing = true;
        try {
            this.FrozenView.DeselectAll();
            this.MainView.DeselectAll();
        } finally {
            this.syncing = false;
        }
    }

    /* The two halves' columns a rectangle covers, in their own positions. */
    applyRange() {
        const r = this.range;
        const clear = () => {
            if (this.FrozenView) this.FrozenView.ClearRange();
            if (this.MainView)   this.MainView.ClearRange();
        };

        if (!r) { clear(); return; }

        const shown = this.dragRows || this.drawnRows();
        const r0 = Math.min(r.Row, r.ToRow), r1 = Math.max(r.Row, r.ToRow);
        const p0 = shown.indexOf(r0), p1 = shown.indexOf(r1);
        if (p0 < 0 || p1 < 0) { clear(); return; }

        const c0 = Math.min(r.Column, r.ToColumn);
        const c1 = Math.max(r.Column, r.ToColumn);
        const n  = this.frozenCount;
        const paint = (view, from, to) => {
            const lo = Math.max(c0, from), hi = Math.min(c1, to - 1);
            if (lo <= hi)
                view.SetRange(Math.min(p0, p1), lo - from, Math.max(p0, p1), hi - from);
            else
                view.ClearRange();
        };

        paint(this.FrozenView, 0, n);
        paint(this.MainView,   n, this._columns.length);
    }

    /* The cell a point in a half is over: its data row and declared column,
     * or null. Local coordinates, the same a `MouseDown` carries. */
    cellAt(view, x, y) {
        if (!view) return null;
        const header = view.HeaderHeight, height = view.RowHeight;
        if (header <= 0 || height <= 0 || y < header) return null;

        const shown = this.dragRows || this.drawnRows();
        const pos   = Math.floor((y - header + view.ScrollY) / height);
        if (pos < 0 || pos >= shown.length) return null;
        /* A group's own row is a heading, not a cell. */
        const row = shown[pos];
        if (row === null || row === undefined) return null;

        const widths = view.ColumnWidths;
        let   at     = x + view.ScrollX;
        if (at < 0) return null;

        for (let i = 0; i < widths.length; i++) {
            if (widths[i] > 0 && at < widths[i])
                return { Row: row, Column: this.declared(view, i) };
            at -= widths[i];
        }
        return null;
    }

    pressed(view, x, y, button, ctrl, shift) {
        /* **Ctrl is the table's row selection**, the one gesture that still
         * chooses rows in a grid that chooses cells: the rectangle is let go
         * and GTK's Ctrl+click toggles the row. Shift is the rectangle's own,
         * extending from the anchor. */
        if (ctrl) { this.ClearRange(); return; }
        if (button !== 1) return;
        this.dragRows = this.drawnRows();

        const cell = this.cellAt(view, x, y);
        if (!cell) { this.released(); this.ClearRange(); return; }

        /* The press is the cell's, not the row's: GTK selected the row under
         * it, and a solid row would hide the rectangle. The current cell is
         * set again after the rows let go -- `CurrentCell` selects the row it
         * names, and the second `letGo` takes that selection off while the
         * cell stays current. */
        const [to, local] = this.where(cell.Column);
        this.letGo();
        to.CurrentCell = { Row: this.address(cell.Row), Column: local };
        this.letGo();
        this.current  = { Row: cell.Row, Column: cell.Column };
        this.dragging = true;
        if (shift && this.anchor) {
            this.range = { Row: this.anchor.Row, Column: this.anchor.Column,
                           ToRow: cell.Row, ToColumn: cell.Column };
        } else {
            this.anchor = { Row: cell.Row, Column: cell.Column };
            this.range  = { Row: cell.Row, Column: cell.Column,
                            ToRow: cell.Row, ToColumn: cell.Column };
        }
        this.applyRange();
        this.Emit("Select");
    }

    dragged(view, x, y) {
        if (!this.dragging || !this.anchor) return;
        const cell = this.cellAt(view, x, y);
        if (!cell) return;
        this.range = { Row: this.anchor.Row, Column: this.anchor.Column,
                       ToRow: cell.Row, ToColumn: cell.Column };
        this.applyRange();
    }

    released() {
        this.dragging = false;
        this.dragRows = null;
        /* GTK may have selected the row on the release; a cell range is what
         * the grid is showing. */
        if (this.range) this.letGo();
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

        /* Down the rows as they are shown: a group's are its own, and a
         * folded group is skipped. */
        const shown = this.visibleRows();
        const from  = shown.indexOf(at.Row);
        if (from < 0) return this;
        const lines = String(text).replace(/\r/g, "").replace(/\n$/, "").split("\n");
        for (let i = 0; i < lines.length; i++) {
            const row = shown[from + i];
            if (row === undefined) break;
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
        /* With a frozen half, that half draws the groups' outline for both:
         * the scrolling one draws none (`Tree: false` on every column). */
        this.MainView.Columns   = cols.slice(n).map((c) => n > 0 ? { ...this.tableColumn(c, false), Tree: false }
                                                                 : this.tableColumn(c, false));
        this.FrozenView.Visible = n > 0;

        const totals = cols.some((c) => c.Total);
        this.Foot.Visible         = totals;
        this.FrozenTotals.Visible = totals && n > 0;

        this.fill();
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
    totalOf(c, i, rows) {
        if (!c.Total) return "";
        const values = (rows || this.data).map((r) => r[i]).filter((v) => v !== undefined && v !== null && v !== "");
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

    /* --- inside: groups ----------------------------------------------------- */

    grouped() { return this._group >= 0 && this._group < this._columns.length; }

    /* A row's address in a half: its index, or its key in a grouped tree. */
    address(row) { return this.grouped() ? "r" + row : row; }

    /* A half's address back to the row's index: -1 for a group's row. */
    rowAt(at) {
        if (!this.grouped()) return typeof at === "number" ? at : -1;
        return rowOf(at);
    }

    /* The rows a half shows, as indices in the order shown: the filter's, and
     * a folded group's rows left out. */
    visibleRows() {
        if (!this.grouped()) {
            const out = [];
            for (let i = 0; i < this.data.length; i++)
                if (this.Emit("Filter", i) !== false) out.push(i);
            return out;
        }
        const out = [];
        for (const g of this.groups)
            if (this.MainView.Expanded(g.key)) for (const i of g.rows) out.push(i);
        return out;
    }

    /* Every row the halves draw, in order: a data index, or `null` for a
     * group's own row. A range speaks positions, and in a grouped grid the
     * group rows sit between the data ones. */
    drawnRows() {
        if (!this.grouped()) return this.visibleRows();

        const out = [];
        for (const g of this.groups) {
            out.push(null);
            if (this.MainView.Expanded(g.key))
                for (const i of g.rows) out.push(i);
        }
        return out;
    }

    /*
     * Both halves filled from the rows. **Flat**, as `AddRows` fills them, the
     * filter asked by each table. **Grouped**, as two trees built alike: a node
     * per group, in the order of its value (numbers as numbers), its rows under
     * it in the grid's order, the filter asked here since a tree is not
     * filtered by the table. The folds and the rows chosen are put back.
     */
    fill() {
        /* A rectangle is over rows as they were shown: a rebuild -- a sort, a
         * filter, a new group, a batch -- starts without one. */
        this.range    = null;
        this.anchor   = null;
        this.dragging = false;
        this.dragRows = null;

        const F = this.FrozenView, M = this.MainView;
        if (!M) return;
        const chosen = this.Selection.slice();

        F.Clear();
        M.Clear();
        if (!this.grouped()) {
            this.groups = [];
            F.AddRows(this.data.map((r) => this.half(r, true)));
            M.AddRows(this.data.map((r) => this.half(r, false)));
            return;
        }

        const by = new Map();
        for (let i = 0; i < this.data.length; i++) {
            if (this.Emit("Filter", i) === false) continue;
            const v = this.data[i][this._group];
            const k = v === undefined || v === null ? "" : String(v);
            if (!by.has(k)) by.set(k, []);
            by.get(k).push(i);
        }
        const values  = [...by.keys()];
        const numeric = values.every((v) => v === "" || toDecimal(v) !== null);
        values.sort((a, b) => {
            const d = numeric ? (toDecimal(a) ?? new Decimal("0")) - (toDecimal(b) ?? new Decimal("0"))
                              : Locale.Compare(a, b);
            const n = typeof d === "number" ? d : (d > new Decimal("0") ? 1 : d < new Decimal("0") ? -1 : 0);
            return this.groupDesc ? -n : n;
        });

        this.groups = values.map((v, n) => ({ key: "g" + n, value: v, rows: by.get(v) }));

        /* Each half in one batch -- node by node, 20 000 rows took 23 s. */
        const n = this.frozenCount;
        const left = [], right = [], nodes = [];
        for (const g of this.groups) {
            const head = this.groupRow(g);
            left.push(head.slice(0, n));
            right.push(head.slice(n));
            nodes.push({ Key: g.key, Style: "heading" });
            for (const i of g.rows) {
                left.push(this.half(this.data[i], true));
                right.push(this.half(this.data[i], false));
                nodes.push({ Key: "r" + i, Parent: g.key });
            }
        }
        F.AddRows(left, nodes);
        M.AddRows(right, nodes);
        for (const g of this.groups) {
            if (this.folds.get(g.value) === false) {
                F.CollapseNode(g.key);
                M.CollapseNode(g.key);
            }
        }
        const keep = chosen.filter((i) => i < this.data.length).map((i) => "r" + i);
        this.together(() => {
            if (this._multi) { F.SelectedKeys = keep; M.SelectedKeys = keep; }
            else if (keep.length) { F.Key = keep[0]; M.Key = keep[0]; }
        });
    }

    /* A group's own row: its value and count in the label column, each
     * `Total` worked out over its rows. */
    groupRow(g) {
        const rows = g.rows.map((i) => this.data[i]);
        const out  = this._columns.map((c, i) => this.totalOf(c, i, rows));
        out[this.labelColumn()] = `${g.value} (${g.rows.length})`;
        return out;
    }

    /* Where a group's row says what it is: the grouping column when it is
     * shown -- the room its values already have -- else the first. */
    labelColumn() {
        const c = this._columns[this._group];
        return c && c.Visible !== false ? this._group : 0;
    }

    /* Each group's totals written again, after a cell changed. */
    subtotals() {
        if (!this.grouped()) return;
        for (const g of this.groups) {
            const head = this.groupRow(g);
            this._columns.forEach((c, i) => {
                if (!c.Total || i === this.labelColumn()) return;
                const [view, local] = this.where(i);
                view.SetCell(g.key, local, head[i]);
            });
        }
    }

    foldAll(open) {
        for (const g of this.groups) {
            this.folds.set(g.value, open);
            for (const view of [this.FrozenView, this.MainView]) {
                if (open) view.ExpandNode(g.key);
                else view.CollapseNode(g.key);
            }
        }
        return this;
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

    /* The row under the pointer, lit in the other half as well. */
    MainView_Hover(row)       { this.FrozenView.HoverRow = row; }
    FrozenView_Hover(row)     { this.MainView.HoverRow = row; }

    /* A heading's edge dragged: the totals under it, and the frozen half's
     * width, follow. */
    MainView_ColumnResize()   { this.fit(); }
    FrozenView_ColumnResize() { this.fit(); }
    MainView_Allocated()      { this.fit(); }

    /* The selection, mirrored into the other half. */
    mirror(from, to) {
        this.together(() => {
            if (this.grouped()) {
                if (this._multi) to.SelectedKeys = from.SelectedKeys;
                else to.Key = from.Key;
            } else if (this._multi) {
                to.DeselectAll();
                for (const i of from.Selection) to.Select(i);
            } else {
                to.Index = from.Index;
            }
        });
        if (!this.syncing) this.Emit("Select");
    }
    MainView_Select()   { if (!this.syncing) { this.mirror(this.MainView, this.FrozenView); this.rowsChosen(this.MainView); } }
    FrozenView_Select() { if (!this.syncing) { this.mirror(this.FrozenView, this.MainView); this.rowsChosen(this.FrozenView); } }

    /* The row of totals is two tables as well, and one row: chosen or under
     * the pointer, it is so in both halves. **And one selection with the
     * rows**: choosing the totals lets go of the rows -- the grid's `Select`,
     * since its selection moved -- and choosing a row lets go of the totals. */
    FrozenTotals_Select()     { this.totalsChosen(this.FrozenTotals, this.MainTotals); }
    MainTotals_Select()       { this.totalsChosen(this.MainTotals, this.FrozenTotals); }
    totalsChosen(from, to) {
        if (this.syncing) return;
        this.together(() => { to.Index = from.Index; });
        if (from.Index < 0 || (this.MainView.Index < 0 && !this.MainView.Selection.length)) return;
        this.together(() => {
            this.MainView.DeselectAll();
            this.FrozenView.DeselectAll();
        });
        this.Emit("Select");
    }
    rowsChosen(view) {
        if (view.Index < 0 && !view.Selection.length) return;
        this.together(() => {
            this.FrozenTotals.Index = -1;
            this.MainTotals.Index = -1;
        });
    }
    FrozenTotals_Hover(row)   { this.MainTotals.HoverRow = row; }
    MainTotals_Hover(row)     { this.FrozenTotals.HoverRow = row; }

    MainView_Activate()   { this.Emit("Activate"); }
    FrozenView_Activate() { this.Emit("Activate"); }

    /* The current cell, in declared terms: where `Paste` writes. */
    MainView_CellChange(row, column)   { this.current = { Row: this.rowAt(row), Column: column < 0 ? -1 : this.declared(this.MainView, column) }; }
    FrozenView_CellChange(row, column) { this.current = { Row: this.rowAt(row), Column: column < 0 ? -1 : column }; }

    /* A press, a drag and a release mark a rectangle in either half. */
    MainView_MouseDown(x, y, button, ctrl, shift)   { this.pressed(this.MainView, x, y, button, ctrl, shift); }
    FrozenView_MouseDown(x, y, button, ctrl, shift) { this.pressed(this.FrozenView, x, y, button, ctrl, shift); }
    MainView_MouseMove(x, y, button, ctrl, shift)   { this.dragged(this.MainView, x, y); }
    FrozenView_MouseMove(x, y, button, ctrl, shift) { this.dragged(this.FrozenView, x, y); }
    MainView_MouseUp()   { this.released(); }
    FrozenView_MouseUp() { this.released(); }

    /* A group folded in one half is folded in the other, and kept so across
     * a rebuild. */
    folded(view, other, key, open) {
        const g = this.groups.find((x) => x.key === key);
        if (g) this.folds.set(g.value, open);
        this.together(() => {
            if (open) other.ExpandNode(key);
            else other.CollapseNode(key);
            other.ScrollY = view.ScrollY;
        });
    }
    MainView_NodeToggle(key, open)   { this.folded(this.MainView, this.FrozenView, key, open); }
    FrozenView_NodeToggle(key, open) { this.folded(this.FrozenView, this.MainView, key, open); }

    /* An edit, said in declared terms and kept in the grid's rows. */
    edited(view, at, local, text, how) {
        const row = this.rowAt(at);
        if (row < 0) return false;           /* a group's row is not data */
        const column = this.declared(view, local);
        const answer = this.Emit("CellEdit", row, column, text, how);
        if (answer === false) return false;
        const kept = typeof answer === "string" ? answer : text;
        if (row < this.data.length) {
            this.data[row][column] = kept;
            if (this.grouped() && column === this._group) Timer.After(0, () => this.fill());
            else this.subtotals();
            this.total();
        }
        return kept;
    }
    MainView_CellEditor(row)   { return this.rowAt(row) >= 0 || !this.grouped() ? undefined : false; }
    FrozenView_CellEditor(row) { return this.rowAt(row) >= 0 || !this.grouped() ? undefined : false; }
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
        /* Grouped, the rows sort within their groups; sorting by the group's
         * own column orders the groups. */
        if (column === this._group) this.groupDesc = !ascending;
        this.fill();
    }
    MainView_Sort(column, ascending)   { this.sorted(this.MainView, column, ascending); }
    FrozenView_Sort(column, ascending) { this.sorted(this.FrozenView, column, ascending); }

    /* Ctrl+C and Ctrl+V, in either half; Tab and Shift+Tab walk the cells. */
    keyed(view, key, ctrl, shift, alt) {
        if (!ctrl && !alt) {
            const arrow = { Left: [-1, 0], Right: [1, 0], Up: [0, -1], Down: [0, 1],
                            KP_Left: [-1, 0], KP_Right: [1, 0],
                            KP_Up: [0, -1], KP_Down: [0, 1] }[key];
            if (arrow) return this.moved(arrow[0], arrow[1], shift);
            if (key === "Tab" || key === "ISO_Left_Tab")
                return this.tabbed(view, key === "ISO_Left_Tab");
        }
        if (!ctrl) return false;
        const k = String(key).toLowerCase();
        if (k === "c") { this.Copy(); return true; }
        if (k === "v") { this.Paste(); return true; }
        return false;
    }
    MainView_KeyPress(key, ctrl, shift, alt)   { return this.keyed(this.MainView, key, ctrl, shift, alt); }
    FrozenView_KeyPress(key, ctrl, shift, alt) { return this.keyed(this.FrozenView, key, ctrl, shift, alt); }

    /*
     * **An arrow moves the cell**, as it does in a spreadsheet, and not the
     * row: the range follows the pointer's key instead of the list's row
     * selection. With Shift it extends from the anchor; without it the anchor
     * moves with the cell. It stops at the first and last shown row and at the
     * first and last shown column, and it is still consumed there -- an arrow
     * that has nowhere to go must not fall through and select a row. The
     * current cell is set on whichever half holds the column, so the focus and
     * the frame cross the frozen split with it.
     */
    moved(dc, dr, shift) {
        const shown = this.visibleRows();
        if (!shown.length) return false;
        const cols = [];
        for (let c = 0; c < this._columns.length; c++)
            if (this._columns[c].Visible !== false) cols.push(c);
        if (!cols.length) return false;

        let row = this.range ? (shift ? this.range.ToRow : this.range.Row) : this.current.Row;
        let col = this.range ? (shift ? this.range.ToColumn : this.range.Column) : this.current.Column;
        if (row < 0 || col < 0) {
            row = this.Index >= 0 ? this.Index : shown[0];
            col = cols[0];
        }

        const rp = Math.max(0, shown.indexOf(row));
        const cp = Math.max(0, cols.indexOf(col));
        const toRow = shown[Math.max(0, Math.min(shown.length - 1, rp + dr))];
        const toCol = cols[Math.max(0, Math.min(cols.length - 1, cp + dc))];

        if (!shift) {
            this.anchor = { Row: toRow, Column: toCol };
        } else if (!this.anchor) {
            this.anchor = { Row: row, Column: col };
        }
        this.range  = { Row: this.anchor.Row, Column: this.anchor.Column,
                        ToRow: toRow, ToColumn: toCol };
        this.current = { Row: toRow, Column: toCol };

        const [to, local] = this.where(toCol);
        this.letGo();
        to.SetFocus();
        to.CurrentCell = { Row: this.address(toRow), Column: local };
        this.letGo();
        this.applyRange();
        this.Emit("Select");
        return true;
    }

    /*
     * **Tab is a grid's**: the next cell, Shift+Tab the one before, across
     * both halves in declared order -- the last frozen column is followed by
     * the first that scrolls -- and on to the next row at the end of one,
     * skipping hidden columns and the rows `Filter` hides. Past the first cell
     * or the last one the key is not taken, and the focus leaves the grid as
     * it leaves any control; Ctrl+Tab leaves it from anywhere. With no current
     * cell the walk starts on the selected row (or the first). The rows chosen
     * stay chosen while the cell moves along a row.
     */
    tabbed(view, back) {
        const cols = [];
        for (let c = 0; c < this._columns.length; c++)
            if (this._columns[c].Visible !== false) cols.push(c);
        const shown = this.visibleRows();
        if (!cols.length || !shown.length) return false;

        let place = shown.indexOf(this.current.Row), at;
        if (place < 0 || this.current.Column < 0) {
            place = Math.max(0, shown.indexOf(this.Index));
            at    = back ? cols.length : -1;
        } else {
            at = cols.indexOf(this.current.Column);
        }

        at += back ? -1 : 1;
        if (at < 0 || at >= cols.length) {
            place += back ? -1 : 1;
            if (place < 0 || place >= shown.length) return false;
            at = back ? cols.length - 1 : 0;
        }
        const row = shown[place];

        const [to, local] = this.where(cols[at]);
        this.letGo();
        if (to !== view) to.SetFocus();
        to.CurrentCell = { Row: this.address(row), Column: local };
        this.letGo();
        this.anchor = { Row: row, Column: cols[at] };
        this.range  = { Row: row, Column: cols[at],
                        ToRow: row, ToColumn: cols[at] };
        this.applyRange();
        this.current = { Row: row, Column: cols[at] };
        return true;
    }
}

/* A grouped half's key back to a row's index: `"r12"` is 12, a group -1. */
function rowOf(key) {
    return typeof key === "string" && key.startsWith("r") ? Number(key.slice(1)) : -1;
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
