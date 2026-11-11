/*
 * What an invoice is, apart from the screen that shows it.
 *
 * `Issue` writes the invoice and its lines **in one transaction**: the header
 * is inserted first so the engine gives it its key -- by `RETURNING` on
 * PostgreSQL, by asking after the insert on sqlite -- the lines are inserted
 * under that key, and the total is written back. A line that cannot be
 * invoiced throws in the middle, and nothing of the invoice is left: no header
 * with half its lines, which is the bug a program without a transaction ships.
 *
 * Every amount is a `Decimal`: `qty × price` and the sum are exact to the cent,
 * on every engine. The total is computed here and not with `SUM` in SQL,
 * because sqlite keeps a decimal as text and its `SUM` goes through a double;
 * a server's `NUMERIC` would be exact either way, and the program that does not
 * care which engine it is on adds them itself.
 */
"use strict";

export class Billing {

    /**
     * @param {InvoicesForm} form  the form whose Connection and Models it uses
     */
    constructor(form) {
        this.form = form;
    }

    /**
     * an invoice for `customerId` on `day` with `items` -- `[{ Product, Qty,
     * Price }]` -- written whole or not at all; answers the `Invoice`
     * @returns Invoice
     */
    Issue(customerId, day, items) {
        if (!items.length)
            throw new Error("an invoice needs at least one line");

        const f = this.form;
        return f.Store.Transaction(() => {
            const invoice = new Invoice();
            invoice.CustomerId = customerId;
            invoice.Day = day;
            f.Invoices.Insert(invoice);          /* the engine gives it its Id */

            let total = new Decimal("0");
            for (const item of items) {
                const qty = item.Qty;
                if (!(qty > 0) || Math.floor(qty) !== qty)
                    throw new Error(`${item.Product}: a quantity is a whole number above zero`);

                const line = new Line();
                line.InvoiceId = invoice.Id;
                line.Product   = item.Product;
                line.Qty       = qty;
                line.Price     = new Decimal(`${item.Price}`, 2);
                line.Amount    = line.Price * qty;
                f.Lines.Insert(line);
                total = total + line.Amount;
            }

            invoice.Total = total;
            f.Invoices.Table.Update(invoice);
            return invoice;
        });
    }

    /** removes an invoice and its lines, together */
    Remove(invoiceId) {
        const f = this.form;
        f.Store.Transaction(() => {
            f.Store.Execute("DELETE FROM lines WHERE invoice_id = ?", [invoiceId]);
            f.Store.Execute("DELETE FROM invoices WHERE id = ?", [invoiceId]);
        });
    }
}
