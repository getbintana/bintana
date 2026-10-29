/*
 * The quote, and the line it holds: what the two classes *do*, and nothing
 * about their shape.
 *
 * **The shape is two files beside this one** -- `Quote.record` and
 * `Line.record` -- which is where the fields, their rules and the names they
 * are written with live; the field editor in the IDE opens them and the tree
 * groups them. `static Fields` stays legal for a project that would rather
 * keep the shape in code, and this example took the file because it is the one
 * the plan was written for.
 *
 * ## What the shape files changed here
 *
 * It used to be one file with the fields in it, and the order of the two
 * classes **mattered**: `static Fields = { … Field.List(Line) }` ran while
 * `Quote` was being declared, so `Line` had to exist by then, and `project.json`
 * listed the file ahead of the form for that reason. The file's `of` names a
 * class and resolves it **the first time the field is used**, so the order is
 * no longer something anybody can get wrong -- neither in this file nor between
 * files. That is the same thunk, `Field.List(() => Line)`, spelled as the name
 * a document can hold.
 *
 * `Naming = "lower"` moved with the fields: the file says `lower`, because it
 * is what a `.record` and a `.form` call a spelling, and it is what the class
 * writes its keys with.
 */
"use strict";

/*
 * One line of the quote.
 *
 * `Amount` is a **getter and nothing else**, so it is a field a program can read
 * and the serialiser leaves out — a line total is worked out and never stored,
 * which is the rule that keeps a file from being able to disagree with itself.
 * It is the half a shape file cannot carry, and the reason the class exists.
 */
class Line extends Record {
    get Amount() { return (this.Price * this.Quantity).Round(2); }
}

/*
 * The quote itself — everything about it that is not a line.
 *
 * The VAT rates are an **enum in the file**, which means two things at once:
 * the setter refuses a rate nobody charges, and `PropertyOptions("Tax")` hands
 * the same list to whatever is showing it.  One place, so they cannot
 * disagree — and the dialog that edits the shape is one of the things reading
 * it.
 */
class Quote extends Record {

    /*
     * What is charged, worked out and never stored -- the same rule as
     * `Line.Amount`. It lives here and not in the form so that a test can ask it
     * (`tests/QuoteTest.js`) without opening a window: a calculation tied to the
     * labels that show it can only be checked by looking at them.
     *
     * Every operator is exact. The two `Round(2)` calls are the only places
     * anything is given up, and they are where money is actually decided: a
     * discount and a tax are amounts somebody is charged, so they are settled to
     * the cent before the next line uses them. Rounding at the end instead would
     * put the total a cent away from the sum of what is shown.
     */
    get Totals() {
        let subtotal = new Decimal("0", 2);
        for (const line of this.Lines) subtotal = subtotal + line.Amount;

        const off     = (subtotal * this.Discount / 100).Round(2);
        const taxable = subtotal - off;
        const vat     = (taxable * new Decimal(this.Tax) / 100).Round(2);

        return { Subtotal: subtotal, Discount: off, Tax: vat, Total: taxable + vat };
    }
}
