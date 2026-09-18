/*
 * A quote, and the point of it is that nothing in this file parses or checks a
 * value.
 *
 * The shape of the data is declared once, in [`Quote.js`](Quote.js) — which is a
 * file of its own because a shape is not a detail of the window that shows it —
 * and this whole file is a view of it.  A price typed as `hola` is refused
 * by the field's own setter with a message the field wrote; `19.9` becomes
 * `19.90` because the field has two places; the VAT rates in the drop-down are
 * the ones the field accepts, handed over by `PropertyOptions`, so the list
 * cannot drift from the check.  There is no `parseFloat`, no `isNaN`, no
 * `if (price < 0)` — those all live in the declaration, once, where a database
 * would put `NUMERIC(12,2) CHECK (price >= 0)`.
 *
 * And the arithmetic is [`Decimal`](../../docs/runtime-api.md#decimal) with the
 * ordinary operators, so the money is exact:
 *
 *     subtotal += line.Price * line.Quantity
 *     const off = (subtotal * this.quote.Discount / 100).Round(2)
 *
 * A quote in doubles is out by a cent often enough that every accounting system
 * ever written has a story about it, and the story is always the same: the total
 * on the screen and the sum of the lines disagree by one.
 *
 * ## The instalments are the interesting line
 *
 * *Three equal instalments* is not a division.  A total of 10.000 in three is
 * 3.333,333… and there is no such payment; rounding each share gives 9.999,99 and
 * somebody is a cent short.  `Decimal.Split` hands the remainder out instead:
 *
 *     Decimal.Split(total, 3)      // 3.333,34 · 3.333,33 · 3.333,33
 *
 * and the property that matters — the one the runtime's own suite asserts — is
 * that they add back up to the total, exactly.  That is the difference between
 * dividing and sharing out, and it is why the runtime has both.
 *
 * ## What this example measured, which is why it exists
 *
 * `docs/plans/data-plan.md` says that filling controls from a record and
 * reading them back is "a loop every program writes again", and until this
 * window there was nothing in the tree that had written it.  Now there is:
 * `show()` and `readHeader()` below, **eleven lines**, and they are not much.
 *
 * The cost turned out not to be the loop but the **two guards beside it**, and
 * both are in `readHeader`.  Every assignment to a control raises a real
 * `Change`, so a form that shows a record reads it straight back unless it says
 * not to; and a `.form` applies its properties *before* `Form_Open`, so a
 * `"Value": 1` on a spin box fired this handler against a record that was still
 * `null` -- which is how this window first opened, behind two error dialogs
 * about a customer nobody had been asked for yet.  Neither guard is
 * discoverable, and both would be somebody else's problem if the binding were
 * declared in the file.
 *
 * The other half of that plan was not a judgement but a wall, and this window is
 * where it was hit: **a `Record` could not hold a list of records.**  A quote
 * could not contain its own lines, so this file had two halves —
 * `{ "quote": { … }, "lines": [ … ] }` — and this form kept two objects side by
 * side.
 *
 * **That wall is gone**, and what it took is one line: `Lines: Field.List(Line)`.
 * A `Record` class is accepted where a field is expected, so a detail is
 * *declared*.  What is worth noticing is how little else moved: the loader
 * reaches the lines and reports `Lines[1].Price: 0 at least` with the index and
 * the member; `Validate` answers for the whole quote in one call, where
 * `BtnSave_Click` used to collect the lines' complaints itself; `Serialize`
 * writes one object and hands `format` back out, a key no field describes; and
 * `Clone` would copy the lines with it.  None of that is code in here any more.
 *
 * **What did not move is the pair of guards**, and that is the measurement that
 * survives: `showing` is still here, and `readHeader` still checks for a record
 * that does not exist yet.  Nesting was the wall; the guards are the cost, and
 * they are what a binding declared in the `.form` would own once instead of
 * once per form.
 *
 * ## What else is worth reading for
 *
 *   - the shape is in `Quote.js` and `project.json` names it in `sources`
 *     **before** this file. `Quote`'s `static Fields` mentions `Line` while
 *     `Quote` is being declared, so the order is a real dependency and not a
 *     preference — the same one `extends` creates, from a static field.
 *   - `Naming = "lower"` is one line and it is why the file says `"customer"`
 *     while the code says `Customer`.  How the file spells its keys is a rule
 *     about the file, not a decision per field — and it is a rule per *record*,
 *     so a nested `Line` spells its own keys by its own rule.
 *   - the date is a [`Day`](../../docs/runtime-api.md#day) and a `DatePicker`'s
 *     `Value` is the same text a `Field.Date` holds, so it goes from the file to
 *     the widget and back with no conversion anywhere.
 *   - `Locale.Currency` puts the symbol where **this** desktop puts it, which is
 *     the part nobody guesses right: Argentina writes `$ 1.234,56`, Germany
 *     `1.234,56 €`, the United States `$1,234.56`.
 *   - `Validate()` is what the save button asks, and it answers with *all* the
 *     complaints rather than the first one.
 *   - the three fields under the list edit the **selected** line, and they write
 *     back on Enter or on leaving the field rather than on every keystroke: a
 *     price on its way from `1` to `1.5` passes through `1.`, which is not a
 *     number, and refusing it mid-word would be arguing with somebody who is
 *     still typing.  `LostFocus` is the moment `docs/plans/data-plan.md` names
 *     for exactly this, written out by hand.
 *   - a changed line repaints **its own row** and nothing else.  Rebuilding the
 *     list would take the selection away, and the selection is what is being
 *     edited — which is the same argument `examples/files` makes about a filter,
 *     one step sharper.
 *
 * ## The bug in here that is worth more than the feature
 *
 * The method that reads the fields back into a line was called `write`, and so
 * was the one that writes the file.  **A class body keeps the last of two
 * same-named methods**, silently: every edit to a line called the file writer
 * with no path, which threw somewhere else entirely, and the line simply never
 * changed.  In a language that dispatches events by name this is not an exotic
 * mistake — `Form_Open` written twice does the same thing — and nothing warns.
 * They are `readLine` and `save` now, two verbs for two things.
 *
 * Run it with `./build/bintana examples/quote`.
 */
"use strict";

class QuoteForm extends Form {

    /* One record, lines included. */
    quote = null;

    /* The row that draws each line, in the same order — so a line that changes
     * repaints its own four labels instead of the list being built again. That
     * is the whole argument of `examples/files`, and it matters more here: the
     * rows are rebuilt from a *selection*, and rebuilding them takes the
     * selection away, which is the thing being edited. */
    rows = [];

    /* Set while `show()` is writing the controls, so the `Change` each assignment
     * raises does not come straight back in and read them again. Every form that
     * displays a value in a control somebody can also type into needs this or an
     * equivalent; it is the second thing the data plan would have to answer. */
    showing = false;

    Form_Open() {
        const path = File.Join(Application.Directory, "quote.json");

        try {
            /* `Load` and not `new`: a file is read **leniently**, so a value
             * today's rules would refuse leaves its field at the default and
             * goes on `Problems` instead of throwing away the other nineteen --
             * and it reaches the lines, so a bad price costs that price and not
             * the line, nor the file. */
            this.quote = Quote.Load(File.LoadJson(path));
        } catch (e) {
            Message.Error("Cannot read {0}: {1}", path, e.message);
            return;
        }

        /* `Problems` is the report of the load -- what the file said that this
         * shape could not take, which is a value the next save would write
         * over. `Validate()` is whether what arrived is usable at all. The
         * window wants both, once, at the moment of opening; the Save button
         * below asks `Validate()` alone, because by then the load is history. */
        const opening = this.quote.Problems.concat(this.quote.Validate());
        if (opening.length)
            Message.Warning("{0}", opening.join("\n"));

        this.show();
        this.TxtCustomer.SetFocus();
    }

    /* --- the record onto the controls, and back ----------------------------
     *
     * These two are the loop `docs/plans/data-plan.md` is about. Everything a
     * binding in the `.form` would replace is here, and there is not much of it
     * — which is the measurement, and it is the same either way it comes out.
     */
    show() {
        this.showing = true;

        /*
         * The drop-down is filled from the field, so the rates live in one place.
         * They are values and not prose -- nobody translates `10.5` -- which is
         * what makes comparing `Text` safe here and unsafe for a drop-down of
         * words; see `examples/files`.
         *
         * **Inside the guard, and that is not tidiness.** Assigning `Items`
         * raises `Select`, which is a real signal and not a simulation -- so
         * without it the handler ran while the fields were still empty, read a
         * blank customer back into a record that requires one, and the window
         * opened behind an error about a name nobody had been asked for yet.
         */
        if (!this.CmbTax.Count)
            this.CmbTax.Items = this.quote.PropertyOptions("Tax");

        this.TxtCustomer.Text     = this.quote.Customer;
        this.PckDate.Value        = this.quote.Date;
        this.SpnDiscount.Value    = this.quote.Discount.Number();
        this.CmbTax.Text          = this.quote.Tax;
        this.SpnInstalments.Value = this.quote.Instalments;

        this.showing = false;

        this.fill();
        this.total();
    }

    /*
     * And the other direction, for the header. Each one goes through the field's
     * setter, so a value it will not take throws here and is answered as a
     * message rather than quietly kept.
     */
    readHeader() {
        /*
         * Two guards, and they answer two different questions.
         *
         * `quote` is the **loader's**: a `.form` applies each property by
         * assignment and a control joins the form under its name only after its
         * own properties are set, so `"Value": 1` on the spin raises `Change`
         * before `Form_Open` has read anything -- and this ran against a record
         * that was still null, twice, and opened the window behind two error
         * dialogs about it.
         *
         * `showing` is **ours**: `show()` writes these same controls, and every
         * assignment raises a real `Change`, so without it every display of the
         * record would immediately read it back.
         */
        if (!this.quote || this.showing) return;

        try {
            this.quote.Apply({
                Customer:    this.TxtCustomer.Text,
                Date:        this.PckDate.Value,
                Discount:    `${this.SpnDiscount.Value}`,
                Tax:         this.CmbTax.Text,
                Instalments: this.SpnInstalments.Value,
            });
        } catch (e) {
            Message.Error("{0}", e.message);
            return;
        }
        this.total();
    }

    TxtCustomer_Change()    { this.readHeader(); }
    PckDate_Change()        { this.readHeader(); }
    SpnDiscount_Change()    { this.readHeader(); }
    CmbTax_Select()         { this.readHeader(); }
    SpnInstalments_Change() { this.readHeader(); }

    /* --- the lines ---------------------------------------------------------- */

    fill() {
        this.List.Clear();
        this.rows = [];

        for (const line of this.quote.Lines) {
            const row = this.row();
            this.rows.push(row);
            this.List.Add(row);
        }
        for (let at = 0; at < this.quote.Lines.length; at++) this.paint(at);

        this.List.Index = -1;
        this.pick();
    }

    /* An empty row: four labels, made once. What is in them is `paint`'s. */
    row() {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 10;
        row.Margin  = 6;

        const what = new Label();
        what.HExpand   = true;
        what.Ellipsize = true;
        row.Add(what);

        for (const [width, dim] of [[70, true], [110, true], [130, false]]) {
            const cell = new Label();
            cell.Alignment = "Right";
            cell.Width     = width;
            if (dim) cell.Style = "dim-label";
            row.Add(cell);
        }
        return row;
    }

    /*
     * One line onto its own row, and **only that row**.
     *
     * The list is not rebuilt to show a changed line, for two reasons. The one
     * `examples/files` is about — forty widgets destroyed and forty built to
     * answer a question nobody asked — and a worse one here: rebuilding takes
     * the selection with it, and the selection is what is being edited.
     */
    paint(at) {
        const line = this.quote.Lines[at];
        const cell = this.rows[at].Children;

        cell[0].Text = line.What;
        /* `Trim()` so a quantity reads `3` and not `3,00`: the two places belong
         * to the money, and a count of sessions is not money. */
        cell[1].Text = Locale.Number(line.Quantity.Trim());
        cell[2].Text = Locale.Currency(line.Price);
        cell[3].Text = Locale.Currency(line.Amount);
    }

    get selected() {
        const at = this.List.Index;
        return at < 0 ? null : this.quote.Lines[at];
    }

    /*
     * The selected line into the three fields under the list — the same loop as
     * `show()`, one record smaller.
     *
     * With nothing selected the fields are emptied and turned off rather than
     * left holding the last line: a field one can type into that is not attached
     * to anything is an invitation to lose the typing.
     */
    pick() {
        const line = this.selected;

        this.showing = true;
        this.TxtWhat.Text     = line ? line.What : "";
        this.TxtQuantity.Text = line ? `${line.Quantity.Trim()}` : "";
        this.TxtPrice.Text    = line ? `${line.Price}` : "";
        this.showing = false;

        for (const field of [this.TxtWhat, this.TxtQuantity, this.TxtPrice])
            field.Enabled = line !== null;

        this.BtnRemove.Enabled = line !== null;
    }

    List_Select() { this.pick(); }

    /*
     * The fields back into the selected line, on **Enter or on leaving the
     * field** — and not on every keystroke, which is the whole reason this is
     * two events and not `Change`.
     *
     * A decimal field is being *typed into*: `1`, then `1.`, then `1.5`, and the
     * middle one is not a number. Writing back per keystroke would put an error
     * in front of somebody halfway through entering a price — the same thing
     * `examples/calculator` says about its own entry, where a trailing separator
     * is kept as typed because it is not a value yet.
     *
     * `LostFocus` is the pair `docs/plans/data-plan.md` already names as the
     * moment a bound control would write its value back. This is that moment,
     * written out by hand.
     */
    readLine() {
        const line = this.selected;
        if (!line || this.showing) return;

        try {
            line.Apply({
                What:     this.TxtWhat.Text.trim(),
                Quantity: this.TxtQuantity.Text.trim() || "0",
                Price:    this.TxtPrice.Text.trim() || "0",
            });
        } catch (e) {
            /* The record refused it, so the record is unchanged — and the field
             * is put back to what the line still says rather than left showing
             * a value nothing holds. */
            Message.Error("{0}", e.message);
            this.pick();
            return;
        }

        this.paint(this.List.Index);
        this.total();
    }

    TxtWhat_Activate()      { this.readLine(); }
    TxtWhat_LostFocus()     { this.readLine(); }
    TxtQuantity_Activate()  { this.readLine(); }
    TxtQuantity_LostFocus() { this.readLine(); }
    TxtPrice_Activate()     { this.readLine(); }
    TxtPrice_LostFocus()    { this.readLine(); }

    /*
     * A new line, selected, with its description ready to be typed over.
     *
     * It starts as *New line* rather than empty because `What` is declared
     * `required` and a record refuses what it will not accept — the check is
     * real, so the placeholder has to be too. `SelectAll` is what makes that
     * cost nothing: the caret arrives with the words already picked, so the
     * first keystroke replaces them.
     */
    BtnAdd_Click() {
        /* Whatever was being typed goes in first: the focus is about to move to
         * the new line's description, and `LostFocus` would otherwise arrive
         * after the selection had already changed and write it into the wrong
         * line. */
        this.readLine();

        this.quote.Lines.push(new Line({ What: Locale.Text("New line") }));

        const row = this.row();
        this.rows.push(row);
        this.List.Add(row);
        this.paint(this.quote.Lines.length - 1);

        this.List.Index = this.quote.Lines.length - 1;
        this.total();

        this.TxtWhat.SetFocus();
        this.TxtWhat.SelectAll();
    }

    BtnRemove_Click() {
        const at = this.List.Index;
        if (at < 0) return;

        this.quote.Lines.splice(at, 1);
        this.fill();
        this.total();
    }

    /* --- the money ---------------------------------------------------------
     *
     * All of it, and every operator here is exact. The two `Round(2)` calls are
     * the only places anything is given up, and they are where money is actually
     * decided: a discount and a tax are amounts somebody is charged, so they are
     * settled to the cent before the next line uses them. Rounding at the end
     * instead would put the total a cent away from the sum of what is shown.
     */
    total() {
        let subtotal = new Decimal("0", 2);
        for (const line of this.quote.Lines) subtotal = subtotal + line.Amount;

        const off     = (subtotal * this.quote.Discount / 100).Round(2);
        const taxable = subtotal - off;
        const vat     = (taxable * new Decimal(this.quote.Tax) / 100).Round(2);
        const total   = taxable + vat;

        this.LblSubtotal.Text = Locale.Currency(subtotal);
        /* Shown even at zero: a blank in the middle of a column of amounts reads
         * as something that failed, not as nothing taken off. */
        this.LblDiscount.Text = `− ${Locale.Currency(off)}`;
        this.LblTax.Text      = Locale.Currency(vat);
        this.LblTotal.Text    = Locale.Currency(total);

        this.showInstalments(total);
    }

    /*
     * What each instalment is, and it is a sharing out rather than a division.
     *
     * `Split` gives the odd cents to the first shares, so they add back up to the
     * total exactly. One instalment is not a payment plan, so it says nothing.
     */
    showInstalments(total) {
        const many = this.quote.Instalments;

        if (many < 2 || !total.Sign) {
            this.LblSplit.Text = "";
            return;
        }

        /*
         * `Split` gives the odd cents to the first shares, so the answer is at
         * most two amounts: some of the bigger one and the rest of the smaller.
         * Saying it that way is shorter than the list and is the sentence a
         * person would write.
         */
        const shares = Decimal.Split(total, many);
        const first  = `${shares[0]}`;
        const big    = shares.filter((one) => `${one}` === first).length;

        this.LblSplit.Text = big === many
            ? Locale.Text("{0} × {1}", many, Locale.Currency(shares[0]))
            : Locale.Text("{0} × {1} and {2} × {3}",
                          big, Locale.Currency(shares[0]),
                          many - big, Locale.Currency(shares[shares.length - 1]));
    }

    /* --- saving ------------------------------------------------------------
     *
     * `Validate()` answers with **everything** that is wrong rather than the
     * first thing, which is the difference between a form somebody can fix in
     * one pass and one that argues a field at a time.
     */
    BtnSave_Click() {
        /* One call, lines included: `Validate` reaches through, and a
         * complaint arrives as `Lines[2].Price: 0 at least` -- the index and the
         * member, which is what a form would need to mark the field that
         * refused. The loop that used to be here said `Line 3:` in front of a
         * sentence it had to collect itself. */
        const wrong = this.quote.Validate();

        if (wrong.length) {
            Message.Error("{0}", wrong.join("\n"));
            return;
        }

        Dialog.SaveFile(Locale.Text("Save this quote"),
                        { Name: "quote.json" },
                        (path) => this.save(path));
    }

    /*
     * Named `save` and not `write`, which is not fussiness: it *was* `write`,
     * and the method that reads the detail fields back into a line was written
     * as `write` too. A class body keeps the last of two same-named methods, so
     * every edit to a line silently called the file writer with no path — no
     * error anywhere near the cause, and the line simply never changed. Two
     * verbs for two things.
     */
    save(path) {
        try {
            /* One record and one call. `format` is not a field of a quote and
             * never was: it is a key the file has and this shape does not
             * describe, so `Load` kept it and `Serialize` hands it back --
             * which is the rule that lets a file from a newer version survive
             * being saved by an older one. */
            File.SaveJson(path, this.quote.Serialize(true));
        } catch (e) {
            Message.Error("Cannot write {0}: {1}", path, e.message);
            return;
        }
        Message.Info("Saved in {0}", path);
    }

}
