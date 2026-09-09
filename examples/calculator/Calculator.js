/*
 * A calculator, and the point of it is that the answers are right.
 *
 * `0,1 + 0,2` is `0,3` here.  In JavaScript it is 0.30000000000000004, in
 * Python it is the same, in C and in Java with `double` it is the same -- one
 * numeric type and it is binary floating point, so a tenth is not a number it
 * can hold.  Every calculator written on top of one either shows that or hides
 * it by rounding, and the rounding is where the cent goes missing in a total.
 *
 * Bintana has [`Decimal`](../../docs/runtime-api.md#decimal): exact arithmetic
 * **with the ordinary operators**, so the whole of the arithmetic in this file
 * is four lines in `settle()`, and they read the way arithmetic reads.
 *
 * It holds a fraction rather than a scaled integer, and that is what makes
 * chaining safe: `10 ÷ 3 = × 3 =` gives ten, where a calculator that stored the
 * third as 3,333333333 would answer 9,999999999.
 *
 * ## The mistake this file made first, because it is the interesting one
 *
 * The result used to be kept as **text** -- `this.entry = ${value}` -- and read
 * back with `new Decimal(this.entry)` when the next key arrived.  Every
 * assertion still passed, because `10 ÷ 3 × 3 =` chains through one expression
 * and never touches the display.  Press `=` in the middle and it broke:
 *
 *     10 ÷ 3 × 3 =        ->  10             (the value was never written down)
 *     10 ÷ 3 =  × 3 =     ->  9,999999999    (it went through the screen)
 *
 * A third has no decimal form, so writing it down *is* the rounding, and reading
 * it back gets the rounded number and not the third.  It is the same trap the
 * type exists for, one layer up: **keep the value, not what it looked like.**
 * `entry` is text only while somebody is typing it, and a settled result is a
 * `Decimal` from the moment it is computed.
 *
 * ## What else it is worth reading for
 *
 *   - the keys are wired by **name**.  `Btn7_Click` is the handler for the
 *     button called `Btn7`, and nothing registers anything: the loader binds
 *     what the `.form` declared and the runtime looks the handler up when the
 *     button is pressed.
 *   - **the keyboard is not in this file at all.**  Each button declares the
 *     keys that press it -- `"Shortcut": ["7", "KP_7"]` -- and the runtime
 *     activates it, so the click handler is the only handler there is.  This
 *     used to be a table of twenty-six GDK key names and a `Form_KeyPress` that
 *     dispatched it: the same command written twice, once as a button and once
 *     as a key.  The buttons stay `Focusable: false` so a focused one cannot
 *     take Enter for itself and press *itself* instead of meaning `=`.
 *   - the display is a `Label` with a `Style`, so `app.css` gives it a
 *     background that follows the desktop's theme.  No colours in the code.
 *   - the number on screen goes through `Locale.Number`, so it carries the
 *     desktop's decimal separator -- a comma here, a period elsewhere.
 *   - **it resizes**, and nothing in this file does anything about that.  The
 *     window is a vertical box holding the display and a homogeneous `Grid` of
 *     four columns; every key says `HExpand`/`VExpand` and `=` says
 *     `ColumnSpan: 2`.  No coordinates, no anchors, no resize handler.  A
 *     `Fixed` surface would have needed all three -- and would still have
 *     latched its design size from the first allocation, which is what breaks a
 *     window that is first shown at a size other than the one it was drawn at.
 *
 * The grid asks for **no spacing of its own**, and that is deliberate: this
 * theme already gives a button a 17px margin, so a `ColumnSpacing` on top of it
 * spaces the keypad twice.  The room between keys is the desktop's answer and
 * not this file's.
 */
"use strict";

class Calculator extends Form {

    Form_Open() {
        this.clear();
    }

    /* ------------------------------------------------------------ the state
     *
     * Four things.  `entry` is text and means something **only while typing**;
     * `value` is the settled `Decimal` on screen otherwise.  Keeping both is the
     * fix described above: a result never goes back through its own text.
     */
    clear() {
        this.entry   = "0";
        this.value   = new Decimal("0");
        this.left    = null;
        this.pending = "";
        this.typing  = true;
        this.show();
    }

    /* What is on screen right now, as an exact value. */
    current() {
        return this.typing ? new Decimal(this.entry) : this.value;
    }

    show(text) {
        if (text !== undefined) {
            this.Display.Text = text;
            return;
        }
        if (!this.typing) {
            /* Trimmed so a quotient reads `2,5` and not `2,50`: a scale and a
             * value are different things, and `10 / 4` answers at two places
             * because that is the rule division follows for a money column. */
            this.Display.Text = Locale.Number(this.value.Trim());
            return;
        }
        /* A trailing separator is kept as typed -- `3,` on its way to `3,5` is
         * not a number yet, and blanking it would fight the typist. */
        const bare = this.entry.endsWith(".") ? this.entry.slice(0, -1) : this.entry;
        const tail = this.entry.endsWith(".") ? Locale.DecimalPoint : "";

        this.Display.Text = Locale.Number(new Decimal(bare)) + tail;
    }

    /* -------------------------------------------------------------- the keys */

    digit(d) {
        if (!this.typing) {
            this.entry  = "0";
            this.typing = true;
        }
        /* A leading zero is a zero nobody typed. */
        this.entry = this.entry === "0" ? d : this.entry + d;
        this.show();
    }

    Btn0_Click() { this.digit("0"); }
    Btn1_Click() { this.digit("1"); }
    Btn2_Click() { this.digit("2"); }
    Btn3_Click() { this.digit("3"); }
    Btn4_Click() { this.digit("4"); }
    Btn5_Click() { this.digit("5"); }
    Btn6_Click() { this.digit("6"); }
    Btn7_Click() { this.digit("7"); }
    Btn8_Click() { this.digit("8"); }
    Btn9_Click() { this.digit("9"); }

    /*
     * The separator is held as a period and shown as whatever the desktop
     * writes.  One spelling inside means the entry is never ambiguous about what
     * it holds; `Decimal` reads either.
     */
    BtnPoint_Click() {
        if (!this.typing) {
            this.entry  = "0";
            this.typing = true;
        }
        if (!this.entry.includes(".")) this.entry += ".";
        this.show();
    }

    BtnBack_Click() {
        /* Backspacing a *result* would have to un-round what was shown, which is
         * the one thing that cannot be done -- so it starts over instead. */
        if (!this.typing) {
            this.clear();
            return;
        }
        this.entry = this.entry.length > 1 ? this.entry.slice(0, -1) : "0";
        this.show();
    }

    BtnSign_Click() {
        if (this.typing) {
            this.entry = this.entry.startsWith("-") ? this.entry.slice(1)
                                                    : `-${this.entry}`;
        } else {
            /* The value and not its text, for the reason at the top of the
             * file: negating a third has to leave a third. */
            this.value = -this.value;
        }
        this.show();
    }

    BtnClear_Click() { this.clear(); }

    BtnAdd_Click()   { this.operator("+"); }
    BtnSub_Click()   { this.operator("-"); }
    BtnMul_Click()   { this.operator("*"); }
    BtnDiv_Click()   { this.operator("/"); }

    /*
     * Pressing an operator settles whatever was pending first, so `2 + 3 * 4`
     * typed on a keypad is 20 -- which is what a calculator does and is not the
     * same as what an expression means.  Saying so here is cheaper than a parser
     * nobody asked this window for.
     */
    operator(what) {
        this.settle();
        this.pending = what;
        this.typing  = false;
    }

    BtnEquals_Click() {
        this.settle();
        this.pending = "";
        this.typing  = false;
    }

    /* ------------------------------------------------------- the arithmetic
     *
     * And here it is, all of it: `left`, `right` and the operator, with the
     * operators -- no `.Plus()`, no scaling by hand, no rounding to hide a
     * floating point error, because there is no floating point.
     */
    settle() {
        let right;
        try {
            right = this.current();
        } catch (e) {
            /* A half-typed entry -- `-` alone, or `,` alone -- is not a number
             * yet, and an operator pressed over it is not an error. */
            return;
        }

        if (this.left === null || !this.pending) {
            this.left = right;
            this.done(right);
            return;
        }

        let value;
        try {
            switch (this.pending) {
            case "+": value = this.left + right; break;
            case "-": value = this.left - right; break;
            case "*": value = this.left * right; break;
            default:  value = this.left / right; break;
            }
        } catch (e) {
            /* Dividing by zero and outgrowing the type both arrive here, and
             * both are things a person did rather than faults: the message the
             * runtime wrote is better than one made up now. */
            this.show(e.message.replace("Decimal: ", ""));
            this.left   = null;
            this.value  = new Decimal("0");
            this.typing = false;
            return;
        }

        this.left = value;
        this.done(value);
    }

    /* The answer stays a value.  This is the line that used to write it down. */
    done(value) {
        this.value  = value;
        this.typing = false;
        this.show();
    }

}
