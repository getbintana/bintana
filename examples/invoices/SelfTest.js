/*
 * `--selftest`: what a person would do, then what the database says.
 *
 * It **empties the three tables**, so it refuses to run unless
 * `INVOICES_ODBC` names the database explicitly -- a self-test that wiped the
 * `Invoices` DSN of whoever ran it by mistake would be the worst example in
 * the tree. `tests/odbc.sh` runs it against sqliteodbc and, when Docker has a
 * `postgres:16`, against PostgreSQL through psqlODBC.
 *
 * It types two invoices into the bar, the way a person would (a price with a
 * comma included), refuses a third in the middle of its lines and checks that
 * nothing of it was left, selects, deletes, and prints one line the script
 * reads: `invoices: <engine>, 2 issued, 1 refused, 1 left, total 2059.80`.
 */
"use strict";

export class SelfTest {

    static For(form) {
        return new SelfTest(form, Application.Arguments.includes("--selftest"));
    }

    constructor(form, active) {
        this.form   = form;
        this.active = active;
    }

    start() {
        if (!this.active) return;
        /* After the window is up: the grid has to exist to be asked. */
        Timer.After(100, () => this.run());
    }

    run() {
        try {
            this.steps();
            Application.Quit(0);
        } catch (e) {
            print(`invoices: FAILED -- ${e.message}${e.Code ? ` (${e.Code})` : ""}`);
            Application.Quit(1);
        }
    }

    steps() {
        const f = this.form;
        if (!Environment.Get("INVOICES_ODBC"))
            throw new Error("--selftest empties the tables: set INVOICES_ODBC to " +
                            "the database it may use");
        if (f.LblStatus.Style === "error")
            throw new Error(f.LblStatus.Text);

        f.Store.Execute("DELETE FROM lines");
        f.Store.Execute("DELETE FROM invoices");
        f.Store.Execute("DELETE FROM customers");
        f.prepare();
        f.refresh();
        expect("three customers to invoice", f.customers.length === 3, f.customers.length);

        /* Two lines typed in, one of them priced with a comma. */
        f.CmbCustomer.Index = 0;
        type(f, "Yerba 1 kg", "3", "19,90");
        type(f, "Aceite 5 l", "2", "1000.05");
        f.BtnIssue.Emit("Click");
        expect("the first invoice is in the list", f.Grid.Count === 1, f.Grid.Count);
        const first = f.cursor.Row(0);
        expect("its total is exact", `${first.total}` === "2059.80", first.total);

        f.CmbCustomer.Index = 2;
        type(f, "Sal fina", "1", "0.10");
        type(f, "Pimienta", "2", "0.20");
        f.BtnIssue.Emit("Click");
        expect("a second invoice", f.Grid.Count === 2, f.Grid.Count);
        expect("0.10 + 2 × 0.20 is 0.50, not 0.5000000001",
               `${f.cursor.Row(0).total}` === "0.50", f.cursor.Row(0).total);

        /* A line that cannot be invoiced, after one that can: the transaction
         * leaves neither the header nor the first line. */
        const lines = () => f.Store.Query("SELECT count(*) AS n FROM lines")[0].n;
        const before = lines();
        let refused = false;
        try {
            f.billing.Issue(f.customers[1].Id, Day.Today, [
                { Product: "Harina", Qty: 1, Price: new Decimal("1.00") },
                { Product: "Nada", Qty: 0, Price: new Decimal("1.00") },
            ]);
        } catch (e) {
            refused = true;
        }
        expect("an invoice with a bad line is refused", refused);
        f.refresh();
        expect("...and left no header", f.Grid.Count === 2, f.Grid.Count);
        expect("...and no line", lines() === before, `${lines()} lines, ${before} before`);

        /* Selecting shows its lines; deleting takes them along. */
        f.Grid.Index = 0;
        f.Grid.Emit("Select");
        expect("the selected invoice shows its two lines", f.LinesView.Count === 2,
               f.LinesView.Count);
        f.BtnDelete.Emit("Click");
        expect("deleting leaves one invoice", f.Grid.Count === 1, f.Grid.Count);
        expect("...and its lines went with it", lines() === 2, lines());

        print(`invoices: ${f.Store.Db.Dbms}, 2 issued, 1 refused, ${f.Grid.Count} left, ` +
              `total ${f.cursor.Row(0).total}`);
    }
}

function type(form, product, qty, price) {
    form.TxtProduct.Text = product;
    form.TxtQty.Text = qty;
    form.TxtPrice.Text = price;
    form.BtnAdd.Emit("Click");
}

function expect(what, ok, got) {
    if (!ok)
        throw new Error(`${what}${got !== undefined ? ` -- got ${got}` : ""}`);
}
