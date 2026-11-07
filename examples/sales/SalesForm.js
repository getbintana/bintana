/*
 * A year of sales in `lib/datagrid`.
 *
 * The grid is declared in the `.form` -- its columns, which two stay put, which
 * ones total -- so what is left here is what the screen does with it:
 *
 *   the rows       `Sales.Rows(400)`, handed over in one `AddRows`
 *   a filter       the text box asks `Filter` of every row again
 *                  (`Refilter`); a row hidden is hidden in both halves
 *   an edit        quantity and price are editable; an edit that does not read
 *                  as a number is refused, and one that does recomputes the
 *                  amount, exactly, with `SetCell` -- the totals follow
 *   groups         by client or by region: a row per group with its count and
 *                  its own totals over its sales, folding in both halves
 *   a spreadsheet  *Copy rows* puts the selected rows on the clipboard as
 *                  LibreOffice pastes them, *Paste* writes from the current
 *                  cell (Ctrl+C and Ctrl+V do the same)
 *
 * Every column is its **declared index** -- `QTY` is 4 whichever half draws
 * it -- which is what lets a handler here not care that two of them are frozen.
 *
 * `--selftest` runs what a person would do and prints what it saw: the suite
 * runs it (`tests/widgets`' ExampleSales), so the example cannot rot quietly.
 */
"use strict";

const CLIENT = 1, PRODUCT = 3, QTY = 4, PRICE = 5, AMOUNT = 6, REGION = 7;

class SalesForm extends Form {

    Form_Open() {
        this.filter = "";
        this.Grid.AddRows(Sales.Rows(400));
        this.say();

        if (Application.Arguments.includes("--selftest"))
            Timer.After(300, () => this.selftest());
    }

    /* --- what the screen says ----------------------------------------------- */

    say() {
        const totals = this.Grid.Totals();
        this.LblCount.Text = Locale.Text("{0} sales, {1} units, {2} in all",
                                         this.Grid.Count, totals[QTY], totals[AMOUNT]);
    }

    /* --- the filter ----------------------------------------------------------- */

    TxtFilter_Change() {
        this.filter = this.TxtFilter.Text.trim().toLowerCase();
        this.Grid.Refilter();
    }

    Grid_Filter(row) {
        if (!this.filter) return true;
        const r = this.Grid.Row(row);
        return `${r[CLIENT]} ${r[PRODUCT]}`.toLowerCase().includes(this.filter);
    }

    /* --- groups ------------------------------------------------------------- */

    CmbGroup_Select() {
        if (!this.Grid || !this.CmbGroup) return;    /* the .form is still loading */
        this.Grid.GroupBy = [-1, CLIENT, REGION][this.CmbGroup.Index] ?? -1;
    }

    /* --- an edit -------------------------------------------------------------- */

    /*
     * Quantity and price, the two editable columns. What does not read as a
     * number is refused -- the cell goes back to what it said -- and what does
     * is kept in the grid's own spelling, with the amount worked out again.
     * A paste arrives here too, cell by cell, with `how` saying so.
     */
    Grid_CellEdit(row, column, text) {
        if (column !== QTY && column !== PRICE) return undefined;

        let value;
        try { value = new Decimal(String(text).trim()); } catch (e) { return false; }
        if (value < new Decimal("0")) return false;

        const qty   = column === QTY   ? value : new Decimal(String(this.Grid.Cell(row, QTY)));
        const price = column === PRICE ? value : new Decimal(String(this.Grid.Cell(row, PRICE)));
        /* After the grid keeps the edit: the amount is this row's other cell. */
        Timer.After(0, () => {
            this.Grid.SetCell(row, AMOUNT, (qty * price).Round(2));
            this.say();
        });
        return value.toString();
    }

    /* --- a spreadsheet -------------------------------------------------------- */

    BtnCopy_Click() {
        const text = this.Grid.Copy();
        this.LblCount.Text = text
            ? Locale.Plural("{0} row copied", "{0} rows copied", text.split("\n").length)
            : Locale.Text("Choose the rows to copy first");
    }

    BtnPaste_Click() {
        this.Grid.Paste();
    }

    /* --- what the suite runs -------------------------------------------------- */

    selftest() {
        const g = this.Grid;
        const out = [];

        out.push(`rows ${g.Count}`);
        out.push(`frozen ${g.FrozenView.Columns.map((c) => c.Text).join(",")}`);
        out.push(`totals ${g.Totals()[QTY]} ${g.Totals()[AMOUNT]}`);

        out.push(`edit refused ${g.MainView.Emit("CellEdit", 0, QTY - 2, "many", "enter")}`);
        const kept = g.MainView.Emit("CellEdit", 0, QTY - 2, "10", "enter");
        Timer.After(50, () => {
            out.push(`edit kept ${kept} amount ${g.Cell(0, AMOUNT)}`);

            this.TxtFilter.Text = "molino";
            const shown = [];
            for (let i = 0; i < g.Count; i++) if (this.Grid_Filter(i)) shown.push(i);
            out.push(`filter keeps ${shown.length}`);
            this.TxtFilter.Text = "";

            g.Index = 2;
            out.push(`copy ${g.Copy().split("\t").slice(0, 2).join("|")}`);

            g.MainView.SortColumn(AMOUNT - 2, false);
            const a = Number(String(g.Cell(0, AMOUNT))), b = Number(String(g.Cell(1, AMOUNT)));
            out.push(`sorted ${a >= b}`);

            this.CmbGroup.Index = 2;
            const groups = g.groups.map((x) => g.MainView.Cell(x.key, REGION - 2));
            out.push(`grouped ${groups.join(", ")}`);
            const first = g.groups[0];
            out.push(`group total ${g.MainView.Cell(first.key, AMOUNT - 2)}`);
            g.CollapseAll();
            out.push(`folded ${g.groups.every((x) => !g.FrozenView.Expanded(x.key) && !g.MainView.Expanded(x.key))}`);

            print(out.join("\n"));
            Application.Quit(0);
        });
    }
}
