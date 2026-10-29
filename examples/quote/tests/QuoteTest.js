/*
 * How a Bintana project is tested, on the smallest thing worth testing: the
 * arithmetic of a quote.
 *
 *     ./build/bintana test examples/quote            # every test
 *     ./build/bintana test examples/quote Totals     # the ones whose Class.method has "Totals"
 *     ./build/bintana test --json examples/quote     # a line per test, which is what the IDE reads
 *
 * ## The rules, all of them
 *
 * - A test file lives in the project's `tests/` and ends in `Test.js`. The
 *   folder is fixed, and a normal run of the program never loads it.
 * - One class per file, named like it, `extends Test`.
 * - **Every method whose name starts with `test` is one test**, run in the
 *   order written, each on a new instance: nothing a test leaves in `this`
 *   reaches the next. `Setup()` runs before each, `Teardown()` after.
 * - A test fails by throwing, and `Eq`, `Check`, `Throws` and `Fail` are the
 *   ways to throw with a sentence. One that fails does not stop the others.
 * - The run ends 0 when everything passed and 1 when something did not, which
 *   is what a CI job reads.
 *
 * The project's own sources are loaded first, so `Quote`, `Line` and what the
 * `.record` files declare are here by their bare names.
 *
 * ## What makes this testable is where the sum lives
 *
 * `Quote.Totals` is in `Quote.js` and not in `QuoteForm.js`. It used to be the
 * form's `total()`, which worked out the numbers *and* wrote them into labels:
 * the only way to check it was to open the window and read them. A test goes
 * through the same door the program does, and the narrower that door, the less
 * a test has to build around the thing it is asking about. When logic has to be
 * tested through a form, take it out of the form first.
 *
 * ## Why the numbers are what they are
 *
 * Every figure below was worked out by hand and written down, not copied from
 * the program's answer: a test that takes its expectation from the code it
 * holds checks the code against itself.
 */
"use strict";

/* A `Decimal` is compared with a `Decimal`, so the expected amounts are written
 * as one: `Eq(line.Amount, "20.00")` would compare a number with a string. */
const D = (text) => new Decimal(text);

class QuoteTest extends Test {

    /* A new quote for every test. `Load` is what a file goes through, so this is
     * the same road `quote.json` takes, with a hand-picked case in place of the
     * file's. */
    Setup() {
        this.quote = Quote.Load({
            customer: "Test",
            date: "2026-01-01",
            discount: "0",
            tax: "21",
            instalments: 1,
            lines: [
                { what: "A", quantity: "2.00", price: "10.00" },
                { what: "B", quantity: "1.00", price: "5.50" },
            ],
        });
    }

    /* --- a line ------------------------------------------------------------ */

    testLineAmountIsQuantityTimesPrice() {
        this.Eq(this.quote.Lines[0].Amount, D("20.00"));
    }

    /* `Eq` compares a `Decimal` by its text, which is the point of `Decimal`:
     * 0.1 + 0.2 is 0.3 here, and `Eq(0.1 + 0.2, 0.3)` with numbers would not be. */
    testMoneyIsExact() {
        this.Eq(D("0.10") + D("0.20"), D("0.30"));
    }

    /* --- the totals -------------------------------------------------------- */

    testTotalsWithNoDiscount() {
        const t = this.quote.Totals;
        this.Eq(t.Subtotal, D("25.50"));
        this.Eq(t.Discount, D("0.00"));
        this.Eq(t.Tax,      D("5.36"));     // 25.50 * 21 / 100 = 5.355, up to the cent
        this.Eq(t.Total,    D("30.86"));
    }

    /* The discount is settled to the cent *before* the tax is taken from what is
     * left, so the lines on the page add up to the total in front of the reader. */
    testDiscountIsRoundedBeforeTheTax() {
        this.quote.Discount = new Decimal("10");
        const t = this.quote.Totals;
        this.Eq(t.Discount, D("2.55"));     // 25.50 * 10 / 100
        this.Eq(t.Tax,      D("4.82"));     // (25.50 - 2.55) * 21 / 100 = 4.8195
        this.Eq(t.Subtotal - t.Discount + t.Tax, t.Total, "the rows shown add up to the total shown");
    }

    testAnEmptyQuoteCostsNothing() {
        this.quote.Lines = [];
        this.Eq(this.quote.Totals.Total, D("0.00"));
    }

    /* --- instalments ------------------------------------------------------- */

    /* `Split` hands the odd cents to the first shares, so the parts add back to
     * the whole. Three shares of 100.00 is where a plain division loses a cent. */
    testSplitKeepsEveryCent() {
        const shares = Decimal.Split(new Decimal("100.00"), 3);
        this.Eq(shares.length, 3);
        this.Eq(shares.map(String), ["33.34", "33.33", "33.33"]);
    }

    /* --- what a quote refuses ---------------------------------------------- */

    /* `Throws` answers what was thrown, so the message can be checked as well as
     * the fact. */
    testADiscountOverOneHundredIsRefused() {
        const e = this.Throws(() => { this.quote.Discount = new Decimal("101"); });
        this.Check(String(e.message).length > 0, "a refusal says why");
    }

    /* An assignment is refused on the spot, but a file is read *leniently*: `Load`
     * keeps what is wrong so `Validate` can list it. It answers with every
     * problem, not the first -- which is what a form needs to mark all the wrong
     * fields in one pass. */
    testValidateReportsEverythingAtOnce() {
        const bad = Quote.Load({
            customer: "Test", date: "2026-01-01", tax: "21", instalments: 1,
            lines: [{ what: "", quantity: "1.00", price: "1.00" },
                    { what: "", quantity: "1.00", price: "1.00" }],
        });
        this.Eq(bad.Validate().length, 2);
    }

    testAGoodQuoteHasNoProblems() {
        this.Eq(this.quote.Validate(), []);
    }

    /* --- a round trip ------------------------------------------------------ */

    /* Serialise and load again: the file must not be able to disagree with
     * itself, and a total is never stored, so it cannot go stale. */
    testSerialiseAndLoadAgain() {
        const again = Quote.Load(this.quote.Serialize(true));
        this.Eq(again.Totals.Total, this.quote.Totals.Total);
        this.Eq(again.Lines.length, 2);
    }
}
