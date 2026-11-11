/*
 * Invoices on a database server, through ODBC.
 *
 * The `.form` declares one `Connection` -- `Store`, `Driver: "Odbc"` -- and
 * three `Model`s over it: customers, invoices and their lines. Nothing here
 * says which engine is behind the DSN: the same screen runs on PostgreSQL, on
 * SQL Server with the tables created by hand, or on a sqlite file through
 * sqliteodbc, and what differs is read off the connection's `Dialect` by the
 * runtime, not by this file.
 *
 * ## Where the database is
 *
 * `DSN=Invoices` unless the environment says otherwise:
 *
 *   INVOICES_ODBC         a connection string, `DSN=…` or `Driver={…};…`
 *   INVOICES_DB_USER      the user, when the DSN does not carry it
 *   INVOICES_DB_PASSWORD  the password -- **set here, in code, never in the
 *                         `.form`**, which is why `Password` is not one of the
 *                         part's properties
 *
 * ## What is worth reading for
 *
 *   - **an invoice and its lines are one transaction** (`Billing.Issue`): a line
 *     that cannot be invoiced leaves nothing behind;
 *   - **the list is a `Cursor`**: `Grid.Count` is how many invoices there are
 *     and `Grid_Data` reads only the rows on screen, a window at a time, so a
 *     year of invoices is not a year of objects in memory;
 *   - **every amount is a `Decimal`**, typed with a comma or a point, and the
 *     total is exact to the cent on every engine;
 *   - **an error says its SQLSTATE**: a server that is down is `08001`, which is
 *     what the status line shows next to the driver's own sentence.
 *
 * `--selftest` drives the screen and checks what it wrote (`SelfTest.js`).
 */
"use strict";

class InvoicesForm extends Form {

    Form_Open() {
        this.billing  = new Billing(this);
        this.pending  = [];
        this.cursor   = null;
        this.customers = [];
        this.selftest = SelfTest.For(this);

        const cs = Environment.Get("INVOICES_ODBC");
        if (cs) this.Store.ConnectionString = cs;
        const user = Environment.Get("INVOICES_DB_USER");
        if (user) this.Store.User = user;
        const password = Environment.Get("INVOICES_DB_PASSWORD");
        if (password) this.Store.Password = password;

        try {
            this.prepare();
            this.refresh();
        } catch (e) {
            this.fail(e);
        }
        this.selftest.start();
    }

    /* The tables, created from the records the first time, and three
     * customers on an empty database so there is somebody to invoice. */
    prepare() {
        this.Customers.Ensure();
        this.Invoices.Ensure();
        this.Lines.Ensure();

        if (!this.Customers.All().length)
            for (const [name, tax] of [["Álvarez e Hijos", "30-11111111-1"],
                                       ["Bodega Norte", "30-22222222-2"],
                                       ["Ñandú Distribuidora", "30-33333333-3"]]) {
                const c = new Customer();
                c.Name = name;
                c.TaxId = tax;
                this.Customers.Insert(c);
            }
    }

    /* Everything read again: the customers for the combo, and the invoices as
     * a cursor the grid asks a row at a time. */
    refresh() {
        this.customers = this.Customers.All()
            .sort((a, b) => Locale.Compare(a.Name, b.Name));
        const was = this.CmbCustomer.Index;
        this.CmbCustomer.Items = this.customers.map((c) => c.Name);
        this.CmbCustomer.Index = was >= 0 && was < this.customers.length ? was : 0;

        this.cursor = this.Store.Db.Cursor(
            "SELECT i.id, i.day, c.name AS customer, i.total\n" +
            "FROM invoices i JOIN customers c ON c.id = i.customer_id\n" +
            "ORDER BY i.id DESC");
        this.Grid.Count = this.cursor.Count;
        this.Grid.Index = -1;
        this.LinesView.Clear();
        this.BtnDelete.Enabled = false;
        this.say(Locale.Plural("{1}: {0} invoice", "{1}: {0} invoices",
                               this.cursor.Count, this.Store.Db.Dbms));
    }

    say(text)  { this.LblStatus.Text = text; this.LblStatus.Style = "dim-label"; }

    /* The driver's sentence comes in the desktop's language; the SQLSTATE is
     * what does not, and what a program would branch on. */
    fail(e) {
        this.LblStatus.Text  = e.Code ? `${e.message} (${e.Code})` : `${e.message}`;
        this.LblStatus.Style = "error";
    }

    /* --- the list ---------------------------------------------------------- */

    Grid_Data(row, column) {
        const r = this.cursor ? this.cursor.Row(row) : null;
        if (!r) return "";
        switch (column) {
        case 0:  return `${r.id}`;
        case 1:  return `${r.day}`;
        case 2:  return `${r.customer}`;
        default: return `${r.total}`;
        }
    }

    /* The selected invoice's lines, read when it is selected. */
    Grid_Select() {
        const r = this.Grid.Index >= 0 ? this.cursor.Row(this.Grid.Index) : null;
        this.BtnDelete.Enabled = !!r;
        this.LinesView.Clear();
        if (!r) return;

        const lines = this.Lines.Table.Where("invoice_id = ? ORDER BY id", r.id);
        this.LinesView.AddRows(lines.map((l) =>
            [l.Product, `${l.Qty}`, `${l.Price}`, `${l.Amount}`]));
    }

    /* --- a new invoice ----------------------------------------------------- */

    /* A line typed in the bar joins the pending invoice, which the right-hand
     * list shows until it is issued. */
    BtnAdd_Click() {
        const product = this.TxtProduct.Text.trim();
        const qty     = Number(this.TxtQty.Text.trim());
        let price;
        try {
            price = new Decimal(this.TxtPrice.Text.trim().replace(",", "."), 2);
        } catch (e) {
            price = null;
        }
        if (!product || !(qty > 0) || Math.floor(qty) !== qty || !price || price.Sign < 0) {
            this.fail(new Error(Locale.Text("A line is a product, a whole quantity and a price.")));
            return;
        }

        if (this.Grid.Index >= 0) {
            this.Grid.Index = -1;
            this.LinesView.Clear();
        }
        this.pending.push({ Product: product, Qty: qty, Price: price });
        this.LinesView.Add([product, `${qty}`, `${price}`, `${price * qty}`]);
        this.TxtProduct.Text = this.TxtQty.Text = this.TxtPrice.Text = "";
        this.BtnIssue.Enabled = true;

        let total = new Decimal("0");
        for (const p of this.pending) total = total + p.Price * p.Qty;
        this.say(Locale.Plural("{0} line, {1} in total -- Issue writes them",
                               "{0} lines, {1} in total -- Issue writes them",
                               this.pending.length, `${total}`));
    }

    BtnIssue_Click() {
        const customer = this.customers[this.CmbCustomer.Index];
        if (!customer || !this.pending.length) return;
        try {
            this.billing.Issue(customer.Id, Day.Today, this.pending);
            this.pending = [];
            this.BtnIssue.Enabled = false;
            this.refresh();
        } catch (e) {
            this.fail(e);
        }
    }

    BtnDelete_Click() {
        const r = this.Grid.Index >= 0 ? this.cursor.Row(this.Grid.Index) : null;
        if (!r) return;
        try {
            this.billing.Remove(r.id);
            this.refresh();
        } catch (e) {
            this.fail(e);
        }
    }
}
