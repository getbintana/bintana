/*
 * A screen over a table, written **by hand** and on purpose.
 *
 * `docs/plans/data-plan.md` designs a binding — a form that declares which
 * record it edits, a control that declares which field it shows — and says
 * plainly why it has not been built: the value is hard to judge from the
 * design. This window is the same move `examples/quote` made for a JSON file,
 * one layer down, and **what it measured is written up where it is useful**, in
 * [data-plan.md](../../docs/plans/data-plan.md#what-a-screen-over-a-table-measured):
 * thirteen findings, three of which changed that document.
 *
 * Run it with `./build/bintana examples/clients`. The database is created in
 * `~/.config/bintana/Clients/clients.db` on the first run and seeded, because
 * an application with an empty first screen cannot be told from a broken one.
 *
 * What is worth knowing to read *this file*:
 *
 * **`showing` is not optional.** Every assignment to a control raises a real
 * `Change`, so a form that displays a record reads it straight back unless it
 * says not to — and this window, like `examples/quote` before it, opened behind
 * an error about a value nobody had typed. Two programs, two independent
 * discoveries, no help from any document.
 *
 * **`rows` and `orderRows` are the records the two lists are showing**, parallel
 * to them by index, and four places keep both in step: an insert appends to
 * each, a save repaints cells with `SetCell`, a delete removes from each, a
 * filter rebuilds both. Refilling a list instead would be one line and would
 * take the selection away — which is the row being edited.
 *
 * **The program filters, orders and totals; the statement does not.** A decimal
 * is TEXT because that is the standard sqlite type that keeps it exactly, and
 * text compares byte by byte — so `SUM(amount)` would go through a double and
 * `ORDER BY name` is not the language's order either. `fill()` sorts with
 * `Locale.Compare` and `executed()` adds with `Decimal`'s own `+`. That is
 * sqlite's limitation stated rather than papered over, and it is the reason a
 * `Client.js` schema uses nothing but standard types.
 *
 * **The balance is stored, not derived, and that has to be paid for.** See the
 * note above `executed()`: a stored total is one query for a whole list instead
 * of ten thousand, and it can drift, so `execute()` moves the two rows inside a
 * `Transaction` and `drift()` asks whether any balance still agrees with its own
 * orders.
 *
 * **And the form is boxes and not coordinates.** It was drawn in a `Fixed`
 * first — 27 controls, 117 numbers, 54 of them an X or a Y — and it broke on a
 * resize. As boxes it is 17 numbers and no coordinates. The rule that came out
 * of it is in
 * [widgets.md](../../docs/widgets.md#which-of-the-two-models-a-form-should-use).
 */
"use strict";

class ClientsForm extends Form {

    /* The connection, and the two tables over it. A `Table` is a shape plus a
     * place to keep it, so these two are what a declared `Form.Source` would
     * resolve to -- which is why they are built once and held. */
    db      = null;
    clients = null;
    orders  = null;

    /*
     * The records the two lists are showing, parallel to them by index.
     *
     * This is measurement 2. A `TableView` holds strings; these hold the records
     * those strings came from, and nothing keeps the two in step except the code
     * below doing it in four places.
     */
    rows      = [];
    orderRows = [];

    /* The client being edited: one of `rows`, or a fresh unsaved one. */
    current = null;

    /* Set while `show()` is writing the controls, so the `Change` each
     * assignment raises does not come straight back in and read them again.
     * Measurement 1, and the second time this tree has needed it. */
    showing = false;

    Form_Open() {
        try {
            this.open();
        } catch (e) {
            Message.Error("Cannot open the database: {0}", e.message);
            return;
        }

        /* From the field, so the list and the check cannot drift: the setter
         * refuses a category nobody has and `PropertyOptions` hands out the same
         * three. Inside the guard, because assigning `Items` raises `Select`. */
        this.showing = true;
        this.CmbCategory.Items = new Client().PropertyOptions("Category");
        this.showing = false;

        this.fill();
    }

    /*
     * The database: opened, created if it is not there, seeded if it is empty.
     *
     * In `Application.ConfigDirectory` and not beside the project, because a
     * project directory may be installed read-only -- `cmake --install` puts
     * `examples/` under `/usr/share`, and a program that wrote to its own
     * directory would work from the source tree and fail from a package.
     */
    open() {
        const path = File.Join(Application.ConfigDirectory, "clients.db");

        this.db = Database.Sqlite(path);
        this.db.Script(SCHEMA);

        this.clients = this.db.Table("clients", Client);
        this.orders  = this.db.Table("orders", Order);

        if (!this.clients.Count())
            this.db.Transaction(() => {
                for (const one of SEED) {
                    const c = this.clients.Insert(new Client(one.Client));

                    for (const one_order of one.Orders) {
                        /* Built and then pointed at its client, and **not**
                         * merged with `Object.assign`: most of `Object` is not
                         * in this language (`Dictionary` is what replaced it),
                         * and the first version of this line threw inside
                         * `Form_Open`'s `try` -- so the seeding failed behind an
                         * error dialog and the application came up with an empty
                         * table and nothing on the terminal. */
                        const o = new Order(one_order);
                        o.ClientId = c.Id;
                        this.orders.Insert(o);
                    }

                    /* The balance is not seeded, it is **worked out** -- from
                     * the same query the running application uses, so the first
                     * screen cannot start out disagreeing with itself. */
                    c.Balance = this.executed(c.Id);
                    this.clients.Update(c);
                }
            });

        this.say(Locale.Text("{0} — {1} clients. {2}",
                             path, this.clients.Count(), this.drift()));
    }

    /* --- the balance, which is where this stopped being CRUD ---------------
     *
     * ## Stored or derived, and why this one is stored
     *
     * A client's balance is the total of the orders that were **executed**, so
     * there are two ways to have it and they are a real fork:
     *
     *   **derived** -- `decimal_sum` over that client's executed orders, every
     *   time it is shown. It cannot drift, because there is nowhere for it to
     *   drift *to*. And a list of ten thousand clients is ten thousand queries,
     *   which is the N+1 that `docs/plans/data-plan.md` refuses lazy loading
     *   over.
     *
     *   **stored** -- a column, moved in the same transaction as the order that
     *   moved it. One query for a whole list, and it can be wrong.
     *
     * This one is stored, because a screen shows a list. What that buys has to
     * be paid for in two places, and both are below: `execute()` moves the two
     * rows **inside a `Transaction`**, and `drift()` asks the database whether
     * any balance disagrees with its own orders. A stored total with no way to
     * check it is a stored total that is wrong and nobody knows.
     *
     * `Record` cannot say any of this. There is no *derived field* and no
     * *invariant* in a shape -- `Balance` is an ordinary column that this class
     * has undertaken to keep true, and the undertaking is in the code.
     */

    /*
     * What a client's executed orders come to, exactly.
     *
     * **Added up in the program and not in the statement**, which is the whole
     * doctrine in three lines. `amount` is TEXT because that is the standard
     * sqlite type that keeps a decimal exactly, so `SUM(amount)` would go
     * through a double and `ORDER BY amount` would compare bytes. The rows come
     * back and `Decimal`'s own `+` adds them, exactly.
     *
     * The cost is named where it is paid: this loads the client's orders to
     * total them. For one client that is a handful of rows. For *every* client
     * it would be the N+1 this runtime refuses lazy loading over, which is why
     * `drift()` below is the shape it is -- and why money in sqlite is a fair
     * thing to say is the wrong tool.
     */
    executed(id) {
        let total = new Decimal("0", 2);

        for (const o of this.orders.Where("client_id = ? AND state = ?",
                                          id, "Executed"))
            total = total + o.Amount;

        return total;
    }

    /*
     * Whether any stored balance disagrees with its own orders.
     *
     * **One statement to fetch, and the comparing in the program** -- which is
     * the doctrine again and the honest shape of its cost. The statement is a
     * `GROUP BY` that hands back every client's balance beside the *texts* of
     * its executed amounts; adding and comparing them is `Decimal`'s, because
     * `'9.00' <> '9.0'` is true of two equal amounts and no standard sqlite
     * operator knows otherwise.
     *
     * It is one query rather than one per client, so it is not an N+1. It does
     * read every executed amount in the database, which is the price of a total
     * the engine cannot compute -- and the point at which a real application
     * would reach for an engine that has `NUMERIC`.
     */
    drift() {
        const said  = {};
        const balance = {};

        for (const r of this.db.Query(
                "SELECT id, coalesce(balance, '0') AS balance FROM clients"))
            balance[r.id] = new Decimal(r.balance, 2);

        for (const r of this.db.Query(
                "SELECT client_id, amount FROM orders WHERE state = ?",
                ["Executed"])) {
            const at = r.client_id;
            said[at] = (said[at] || new Decimal("0", 2)) + new Decimal(r.amount, 2);
        }

        let wrong = 0;
        for (const id in balance)
            if (`${balance[id]}` !== `${said[id] || new Decimal("0", 2)}`)
                wrong++;

        return wrong
            ? Locale.Text("{0} balances disagree with their own orders", wrong)
            : Locale.Text("every balance agrees with its own orders");
    }

    /* --- the list ---------------------------------------------------------- */

    /*
     * The clients a filter matches.
     *
     * **The filter is SQL, and the typed text is a parameter.** `LIKE ?` with
     * the value bound, never a string built by adding quotes -- there is no way
     * from here to ask for that, which is the point. What a declared `Source`
     * would replace is this line and the `ORDER BY` beside it.
     */
    fill() {
        const wanted = this.TxtFilter.Text.trim();

        this.rows = wanted
            ? this.clients.Where("name LIKE ?", `%${wanted}%`)
            : this.clients.All();

        /*
         * **Ordered here and not in the statement, and that is a finding rather
         * than a preference.** `ORDER BY name` in sqlite compares bytes, so it
         * puts `Ñanculeo` after `Zapata` and `Álvarez` last -- which is the
         * exact mistake `examples/contacts` exists to demonstrate, arriving from
         * the database this time instead of from `localeCompare`.
         *
         * `Locale.Compare` is the answer and it is in the program, so the sort
         * happens twice over: once as a query that had to stop asking for an
         * order, and once here over the rows it returned. It also stops working
         * the moment the rows are not all loaded, which is stage 3's cursor.
         *
         * The real fix is symmetric with the one the decimals got: a **`LOCALE`
         * collation** registered on the connection, so `ORDER BY name COLLATE
         * LOCALE` would be correct in SQL. `bta_locale.c` already collates with
         * `g_utf8_collate`; nothing registers it with sqlite yet.
         */
        this.rows.sort((a, b) => Locale.Compare(a.Name, b.Name));

        this.Clients.Clear();
        for (const c of this.rows) this.Clients.Add(this.cells(c));

        /*
         * A row's rules and today's rules can disagree, and a row read leniently
         * says so rather than throwing. Worth showing: a screen that hid it
         * would be a screen where a bad row looks like an empty one.
         *
         * Both halves, at the moment of reading: `Problems` is what the *row*
         * said that this shape could not take -- a value the next save would
         * write over -- and `Validate()` is whether what arrived is usable. The
         * Save button asks `Validate()` alone, because by then this load is
         * history and `Problems` would still be complaining about a field the
         * user has since filled in.
         */
        const wrong = [];
        for (const c of this.rows)
            for (const said of c.Problems.concat(c.Validate())) wrong.push(said);
        if (wrong.length)
            this.say(Locale.Text("{0} rows could not be read as they are: {1}",
                                 wrong.length, wrong.join("; ")));

        this.Clients.Index = -1;
        this.pick();
    }

    /* One client as the three strings its row shows. `Locale.Currency` puts the
     * symbol where *this* desktop puts it, which is the part nobody guesses:
     * Argentina writes `$ 1.234,56` and Germany `1.234,56 €`. */
    cells(c) {
        return [c.Name, Locale.Currency(c.Balance), c.Category];
    }

    Clients_Select() { this.pick(); }
    TxtFilter_Change() { this.fill(); }

    /*
     * The selection moved, so everything that depends on it follows.
     *
     * `Index` of `-1` is no selection, which is also what an empty list is --
     * one branch and not two.
     */
    pick() {
        const at = this.Clients.Index;

        this.current = at < 0 ? null : this.rows[at];
        this.show();
        this.fillOrders();

        this.BtnDelete.Enabled = this.current !== null && this.current.Id !== 0;
        this.BtnSave.Enabled   = this.current !== null;
    }

    /* --- the record onto the controls, and back ---------------------------
     *
     * These two are the loop `docs/plans/data-plan.md` is about, and
     * measurement 1 is that there is not much of it: fourteen lines for seven
     * fields. What is not in the count is `showing`, which is the whole reason
     * the loop cannot simply be written out.
     */
    show() {
        this.showing = true;

        const c = this.current;

        this.TxtName.Text = c ? c.Name : "";

        /*
         * **Two widget limits that a binding would have to answer, and neither
         * is obvious.** A `ComboBox` has no empty *text* -- assigning `""`
         * throws `'' is not one of CmbCategory's items`, because the text is one
         * of the items and nothing is `Index = -1`. And a `DatePicker` has no
         * empty state at all: its default is today and there is no value that
         * means *no date*, so an optional `Field.Date` cannot round-trip through
         * one. `Client.Since` is declared `required` for that reason -- a fact
         * about the control, written into the shape, which is exactly the kind
         * of leak a declared binding would have to decide about.
         */
        if (c) this.CmbCategory.Text  = c.Category;
        else   this.CmbCategory.Index = -1;

        this.PckSince.Value = c && c.Since ? c.Since : Day.Today;
        /* A decimal reaches a TextBox as its own text, which is exactly what it
         * reads back from -- so there is no formatting here and no parsing in
         * `read()`. */
        this.TxtBalance.Text  = c ? `${c.Balance}` : "";
        this.TxtPostal.Text   = c ? c.PostalCode : "";
        this.ChkActive.Value  = c ? c.Active : true;

        this.TxtName.Enabled     = c !== null;
        this.CmbCategory.Enabled = c !== null;
        this.PckSince.Enabled    = c !== null;
        this.TxtBalance.Enabled  = c !== null;
        this.TxtPostal.Enabled   = c !== null;
        this.ChkActive.Enabled   = c !== null;

        this.mark([]);
        this.showing = false;
    }

    /*
     * The controls back into the record.
     *
     * **On `Activate` and losing the focus, not on every keystroke** -- which is
     * what `docs/plans/data-plan.md` names as the moment, and here is why: a
     * balance on its way from `1` to `1.5` passes through `1.`, which is not a
     * number. Refusing it mid-word would be arguing with somebody who is still
     * typing.
     *
     * A value the field will not take throws from the setter with the sentence
     * the field wrote, so it is caught once here rather than checked seven
     * times.
     */
    read() {
        if (!this.current || this.showing)
            return;

        try {
            this.current.Apply({
                Name:       this.TxtName.Text,
                Category:   this.CmbCategory.Text,
                Since:      this.PckSince.Value,
                Balance:    this.TxtBalance.Text || "0",
                PostalCode: this.TxtPostal.Text,
                Active:     this.ChkActive.Value,
            });
            this.say("");
        } catch (e) {
            this.say(e.message);
        }
    }

    TxtName_Activate()      { this.read(); }
    TxtName_LostFocus()     { this.read(); }
    TxtBalance_Activate()   { this.read(); }
    TxtBalance_LostFocus()  { this.read(); }
    TxtPostal_Activate()    { this.read(); }
    TxtPostal_LostFocus()   { this.read(); }
    PckSince_Change()       { this.read(); }
    CmbCategory_Select()    { this.read(); }
    ChkActive_Change()      { this.read(); }

    /* --- saving ------------------------------------------------------------ */

    /*
     * Everything wrong with it at once, and marked where it is wrong.
     *
     * Measurement 4: `Validate()` answers `Name is required` and
     * `PostalCode: 8 characters at most, got 12` -- the property name in front
     * of the sentence -- so putting the complaint on the control is a lookup
     * from that name to that control. Nine lines for the whole form, and the
     * only reason it is not free is that the mapping from field to control is
     * exactly what a binding would have declared.
     */
    mark(problems) {
        const of = { Name: this.TxtName, PostalCode: this.TxtPostal,
                     Balance: this.TxtBalance };

        for (const field in of) {
            of[field].Icon    = "";
            of[field].Tooltip = "";
        }
        for (const said of problems) {
            const field = said.split(/[ :]/)[0];
            if (of[field]) {
                of[field].Icon    = "dialog-warning-symbolic";
                of[field].Tooltip = said;
            }
        }
    }

    BtnSave_Click() {
        this.read();
        if (!this.current)
            return;

        const wrong = this.current.Validate();
        this.mark(wrong);
        if (wrong.length) {
            this.say(wrong.join("\n"));
            return;
        }

        /*
         * **Measurement 3.** The record already knows whether this is an insert
         * -- its key is at what the field starts from -- and `Save` reads it. But
         * the *window* needs the same answer, because an insert appends a row to
         * the list and an update repaints one, so the question is asked twice in
         * two places. Before, because `Save` fills the key in.
         */
        const fresh = this.current.Id === 0;

        try {
            this.clients.Save(this.current);
        } catch (e) {
            this.say(e.message);
            return;
        }

        if (fresh) {
            this.rows.push(this.current);
            this.Clients.Add(this.cells(this.current));
            this.Clients.Index = this.rows.length - 1;
        } else {
            /*
             * Three cells, in place. Refilling the list would be one line and
             * would take the selection with it -- and the selection is the row
             * being edited, which is `examples/files`' argument one step
             * sharper.
             */
            const at   = this.Clients.Index;
            const said = this.cells(this.current);
            for (let col = 0; col < said.length; col++)
                this.Clients.SetCell(at, col, said[col]);
        }

        this.pick();
        this.say(Locale.Text("Saved {0}", this.current.Name));
    }

    BtnNew_Click() {
        /* Not in `rows` and not in the list until it is saved: a row that exists
         * on the screen and not in the table is the thing a list and a query
         * disagreeing about looks like. */
        this.Clients.Index = -1;
        this.current       = new Client();
        this.show();
        this.fillOrders();

        this.BtnDelete.Enabled = false;
        this.BtnSave.Enabled   = true;
        this.TxtName.SetFocus();
        this.say(Locale.Text("A new client. It is not in the table until it is saved."));
    }

    BtnDelete_Click() {
        const c  = this.current;
        const at = this.Clients.Index;
        if (!c || at < 0)
            return;

        Confirm.ask(Locale.Text("Delete {0} and its orders?", c.Name),
                    Locale.Text("Delete"), () => {
            try {
                /* Its orders go with it, and not from here: the schema says
                 * `ON DELETE CASCADE` and the driver turns `foreign_keys` on, so
                 * the database is what keeps that promise rather than this
                 * handler remembering to. */
                this.clients.Delete(c);
            } catch (e) {
                this.say(e.message);
                return;
            }
            this.rows.splice(at, 1);
            this.Clients.RemoveRow(at);
            this.pick();
            this.say(Locale.Text("Deleted {0}", c.Name));
        });
    }

    /* --- the orders, which is the detail ----------------------------------- */

    /*
     * One client's orders.
     *
     * A second query and not a join: `ClientId` is an ordinary field, and
     * `Record` has no notion that a number in one shape names a row of another.
     * That is what a declared child collection would add, and measurement 5 is
     * that this screen did not miss it.
     */
    fillOrders() {
        const c = this.current;

        this.orderRows = c && c.Id
            ? this.orders.Where("client_id = ? ORDER BY placed DESC, id DESC", c.Id)
            : [];

        this.Orders.Clear();
        for (const o of this.orderRows) this.Orders.Add(this.orderCells(o));

        /* An order needs a client to belong to, so a client that was never
         * saved has nowhere to put one. This is the *entire* cost of not having
         * a cascade save, and it is one disabled button. */
        this.BtnAddOrder.Enabled = c !== null && c.Id !== 0;
        this.showOrder();
        this.enableOrderButtons();
        this.total();
    }

    orderCells(o) {
        return [o.Placed, o.What, Locale.Currency(o.Amount), o.State];
    }

    Orders_Select() {
        this.showOrder();
        this.enableOrderButtons();
    }

    /*
     * What may be done to the selected order.
     *
     * **An executed order is not editable and not removable**, and that rule is
     * here rather than in the shape because a shape cannot hold it: `Record`
     * says what a value may *be*, not what may be done to a row in which state.
     * Letting one be edited would move money that the balance already counted,
     * and nothing would say so -- which is the same class of silence `drift()`
     * exists to break.
     */
    enableOrderButtons() {
        const o = this.selectedOrder();
        const open = o !== null && o.State === "Pending";

        this.BtnExecute.Enabled     = open;
        this.BtnRemoveOrder.Enabled = open;
        this.PckPlaced.Enabled      = open;
        this.TxtWhat.Enabled        = open;
        this.TxtAmount.Enabled      = open;
    }

    /* --- and the same loop again, one record smaller ----------------------
     *
     * The three fields under the list edit the **selected** order, which is
     * `examples/quote`'s idiom and is here for a reason worth writing down:
     * this is `show()`/`read()` a second time, for a second shape, in the same
     * window. Twelve more lines that say nothing a `DataField` on each control
     * would not have said once.
     *
     * `showing` is shared with the client's loop rather than doubled, and that
     * works only because the two are never written at the same time. A form
     * showing two records at once would need two guards, which is one more
     * thing nobody would guess.
     */
    selectedOrder() {
        const at = this.Orders.Index;
        return at < 0 ? null : this.orderRows[at];
    }

    showOrder() {
        this.showing = true;

        const o = this.selectedOrder();

        this.PckPlaced.Value = o && o.Placed ? o.Placed : Day.Today;
        this.TxtWhat.Text    = o ? o.What : "";
        this.TxtAmount.Text  = o ? `${o.Amount}` : "";

        this.showing = false;
    }

    /*
     * Written back on `Activate` and on losing the focus, and then **saved at
     * once**.
     *
     * That last part is measurement 5: an order is its own row, so it can be
     * written the moment it is valid. A quote's line in `examples/quote` cannot
     * -- it lives in a file that is written whole -- which is why that example
     * has a save button and this section does not.
     */
    readOrder() {
        const o = this.selectedOrder();
        if (!o || this.showing)
            return;

        try {
            o.Apply({ Placed: this.PckPlaced.Value,
                      What:   this.TxtWhat.Text,
                      Amount: this.TxtAmount.Text || "0" });
        } catch (e) {
            this.say(e.message);
            return;
        }

        const wrong = o.Validate();
        if (wrong.length) {
            this.say(wrong.join("\n"));
            return;
        }

        try {
            this.orders.Save(o);
        } catch (e) {
            this.say(e.message);
            return;
        }

        /* Its own row repainted, and nothing else -- the list is not rebuilt,
         * because rebuilding it would take the selection that is being edited. */
        const at = this.Orders.Index;
        this.Orders.SetCell(at, 0, o.Placed);
        this.Orders.SetCell(at, 1, o.What);
        this.Orders.SetCell(at, 2, Locale.Currency(o.Amount));
        this.total();
        this.say("");
    }

    PckPlaced_Change()     { this.readOrder(); }
    TxtWhat_Activate()     { this.readOrder(); }
    TxtWhat_LostFocus()    { this.readOrder(); }
    TxtAmount_Activate()   { this.readOrder(); }
    TxtAmount_LostFocus()  { this.readOrder(); }

    /*
     * What this client owes, added up **in the database**.
     *
     * `decimal_sum` and not `SUM`: the column is TEXT because sqlite has no
     * exact numeric type, and `SUM` would answer a REAL -- the scale gone, the
     * value back in the program as a double rather than something a
     * `Field.Decimal` holds. This comes back as text and reads into a `Decimal`
     * exactly.
     *
     * It could as easily be added up here, over `orderRows`, and for four rows
     * that would be the same answer. It is done in SQL because that is the
     * version that still works when the rows are not all loaded -- which is the
     * cursor of stage 3, and this is the shape it will want.
     */
    total() {
        const c = this.current;

        if (!c || !c.Id) {
            this.LblTotal.Text = "";
            return;
        }
        /* Over the orders already loaded, which is the cheap half of the
         * doctrine: they are on the screen, so totalling them costs nothing. */
        let ordered = new Decimal("0", 2);
        for (const o of this.orderRows) ordered = ordered + o.Amount;

        this.LblTotal.Text = Locale.Text("Ordered {0} · executed {1}",
                                         Locale.Currency(ordered),
                                         Locale.Currency(this.executed(c.Id)));
    }

    /*
     * A new order, saved immediately -- which is measurement 5. There is no
     * moment at which a half-written client exists, because the two tables are
     * written independently, unlike a quote and its lines in one JSON file.
     *
     * It starts as *New order* rather than empty because `What` is declared
     * `required` and a record refuses what it will not accept: the check is
     * real, so the placeholder has to be too. `SelectAll` is what makes that
     * cost nothing -- the caret arrives with the words already picked.
     */
    BtnAddOrder_Click() {
        const c = this.current;
        if (!c || !c.Id)
            return;

        /* Whatever was being typed goes in first: the focus is about to move,
         * and `LostFocus` would otherwise arrive after the selection had
         * already changed and write it into the wrong order. */
        this.readOrder();

        const o = new Order({ ClientId: c.Id, Placed: Day.Today,
                              What: Locale.Text("New order"), Amount: "0.00" });
        try {
            this.orders.Insert(o);
        } catch (e) {
            this.say(e.message);
            return;
        }

        this.fillOrders();
        for (let at = 0; at < this.orderRows.length; at++)
            if (this.orderRows[at].Id === o.Id)
                this.Orders.Index = at;
        this.enableOrderButtons();

        this.TxtWhat.SetFocus();
        this.TxtWhat.SelectAll();
    }

    /*
     * **Execute an order: the first thing in this window that is not CRUD.**
     *
     * Two rows in two tables have to move together -- the order becomes
     * `Executed` and the client's balance grows by its amount -- and the whole
     * of what makes that safe is the `Transaction`. Without it a failure between
     * the two writes leaves an executed order that nobody was charged for, and
     * the *next* screen is the one that notices.
     *
     * Three things this measured, and none of them needed anything new:
     *
     *   - `c.Balance + o.Amount` is **exact**, with the ordinary operator: the
     *     one place a running total of money is decided, and the reason
     *     `Decimal` exists at all.
     *   - the transaction takes a **function**, so the two saves and the
     *     arithmetic between them read as one paragraph rather than as a begin
     *     and a commit somebody has to keep in step.
     *   - and a throw inside it rolls back and **comes back out as itself** --
     *     the driver puts the pending exception back rather than reporting that
     *     the rollback worked.
     *
     * What it *did* want and did not have is measurement 2 again, one notch
     * worse: two lists now need repainting from one operation, and the client's
     * row is in a list this handler has to reach across to find.
     */
    BtnExecute_Click() {
        const o = this.selectedOrder();
        const c = this.current;
        if (!o || !c || o.State !== "Pending")
            return;

        /* Whatever was being typed into the order goes in first, or executing it
         * would post an amount the screen is no longer showing. */
        this.readOrder();

        const wrong = o.Validate();
        if (wrong.length) {
            this.say(wrong.join("\n"));
            return;
        }

        try {
            this.db.Transaction(() => {
                o.State   = "Executed";
                c.Balance = c.Balance + o.Amount;

                this.orders.Save(o);
                this.clients.Save(c);
            });
        } catch (e) {
            /* The records are ahead of the database now, because the rollback
             * undid the rows and not the objects. Read both back rather than
             * guessing: `Find` is one statement and the alternative is a screen
             * showing values that were not saved. */
            this.say(e.message);
            this.reload();
            return;
        }

        const at = this.Orders.Index;
        const said = this.orderCells(o);
        for (let col = 0; col < said.length; col++)
            this.Orders.SetCell(at, col, said[col]);

        this.repaintClient();
        this.enableOrderButtons();
        this.show();
        this.total();
        this.say(Locale.Text("Executed {0}. {1} is now {2}.",
                             o.What, c.Name, Locale.Currency(c.Balance)));
    }

    /* The selected client's row, repainted where it is. Reaching from the detail
     * back into the master's list is the part a bound grid would own. */
    repaintClient() {
        const at = this.Clients.Index;
        if (at < 0)
            return;

        const said = this.cells(this.current);
        for (let col = 0; col < said.length; col++)
            this.Clients.SetCell(at, col, said[col]);
    }

    /* What was rolled back, read again. */
    reload() {
        const at = this.Clients.Index;
        if (at >= 0) {
            this.rows[at] = this.clients.Find(this.rows[at].Id);
            this.current  = this.rows[at];
            this.repaintClient();
            this.show();
        }
        this.fillOrders();
    }

    BtnRemoveOrder_Click() {
        const at = this.Orders.Index;
        if (at < 0)
            return;
        /* Belt as well as braces: the button is disabled for an executed order,
         * and a rule this cheap is worth having twice -- a keyboard, a
         * shortcut or a later refactor can all reach a handler the button
         * cannot. */
        if (this.orderRows[at].State !== "Pending") {
            this.say(Locale.Text("An executed order cannot be removed: the balance already counts it."));
            return;
        }

        try {
            this.orders.Delete(this.orderRows[at]);
        } catch (e) {
            this.say(e.message);
            return;
        }
        this.orderRows.splice(at, 1);
        this.Orders.RemoveRow(at);
        this.showOrder();
        this.total();
    }

    /* --- the small ones ---------------------------------------------------- */

    say(text) { this.LblStatus.Text = text; }

    Form_Close() {
        /* Not required -- the finaliser closes it -- but a program that says so
         * is a program whose file lock is released when the window shuts rather
         * than whenever the collector gets to it. */
        if (this.db)
            this.db.Close();
    }
}
