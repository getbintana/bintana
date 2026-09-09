/*
 * The shape of a quote, and nothing about showing one.
 *
 * It is here rather than at the top of `QuoteForm.js` because **the shape is not
 * a detail of the window that happens to display it.** A second window over the
 * same quote, a printed copy, an importer reading somebody else's file and a
 * test that never opens a window all want `Quote` and `Line`; none of them wants
 * a form. Keeping them in the form's file made the form the owner of something
 * it only borrows, and the first thing that needed the shape without the window
 * would have had to choose between loading a `Form` it does not use and
 * declaring the fields a second time — which is the one thing `Record` exists to
 * prevent.
 *
 * The project tree shows it under **Modules**, beside `Forms`: a class with no
 * `.form` is a module, and that is the grouping saying the same thing the
 * paragraph above says.
 *
 * **This is the code-only path.** `docs/data-plan.md` designs a `Quote.record`
 * file — the shape as JSON, with a field editor in the IDE — and `static Fields`
 * stays legal exactly as a `Form` with no `.form` stays legal: the file is where
 * the declaration *can* live, not where it has to.
 *
 * ## Two things about the order of these two classes
 *
 * `Line` is declared **before** `Quote`, and that is not tidiness: `static
 * Fields = { … Field.List(Line) }` runs while `Quote` is being declared, so
 * `Line` has to exist by then. It is the same load-order dependency `extends`
 * creates, from a static field rather than from a base class — which is why
 * `project.json` lists this file in `sources` ahead of the form, and why
 * splitting these two into a file each would mean naming both there, in order.
 *
 * The way out, if they ever have to be declared the other way round or in two
 * files somebody may reorder, is the thunk: `Field.List(() => Line)` is resolved
 * the first time the field is used instead of while the class is being declared.
 * It is not used here because the order *is* expressible, and a dependency
 * written down beats one deferred.
 */
"use strict";

/*
 * One line of the quote.
 *
 * `Amount` is a **getter and nothing else**, so it is a field a program can read
 * and the serialiser leaves out — a line total is worked out and never stored,
 * which is the rule that keeps a file from being able to disagree with itself.
 */
class Line extends Record {
    static Naming = "lower";
    static Fields = {
        What:     Field.Text({ required: true, max: 60 }),
        Quantity: Field.Decimal({ decimals: 2, min: "0" }),
        Price:    Field.Decimal({ decimals: 2, min: "0" }),
    };

    get Amount() { return (this.Price * this.Quantity).Round(2); }
}

/*
 * The quote itself — everything about it that is not a line.
 *
 * The VAT rates are a `Field.Enum`, which means two things at once: the setter
 * refuses a rate nobody charges, and `PropertyOptions("Tax")` hands the same
 * list to whatever is showing it.  One place, so they cannot disagree.
 */
class Quote extends Record {
    static Naming = "lower";
    static Fields = {
        Customer:    Field.Text({ required: true, max: 80 }),
        Date:        Field.Date({ required: true }),
        Discount:    Field.Decimal({ decimals: 2, min: "0", max: "100" }),
        Tax:         Field.Enum(["21", "10.5", "0"]),
        Instalments: Field.Int({ min: 1, max: 12, def: 1 }),

        /*
         * **The line that this file used to be shaped around not existing.** A
         * quote holds its own lines, so `Line` is the entries' shape and the
         * file is one object -- `Field.List(Line)`, the class where a field is
         * expected, which is the short spelling of a detail.
         *
         * Everything that follows from it follows for free: `Problems` reaches
         * into the lines with the path in front of each complaint,
         * `Serialize` writes them nested in their own spelling, and `Clone`
         * copies them.  What is *not* free is the one below.
         */
        Lines:       Field.List(Line),
    };
}
