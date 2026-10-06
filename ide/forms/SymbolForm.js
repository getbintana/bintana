/*
 * Go to a method of the file, or to a line of it -- and, with `goProject`, to a
 * symbol of the whole project.
 *
 * Visual Basic put the procedures of a module in a drop-down over the code;
 * Lazarus has the Code Explorer; every editor since has some spelling of
 * `Ctrl+Shift+O`.  What they all answer is the question a long file makes you
 * ask twenty times an hour -- *where is the method called something* -- which
 * here had only one answer before this, and it was to scroll.
 *
 * **One box and not two.** A line number is the same gesture with a different
 * kind of answer, so typing digits offers the line instead of filtering the
 * methods, and `Ctrl+L` is a second key on the same command rather than a
 * second window. That is what the modern quick-open does, and it is the only
 * thing here that is not simply Visual Basic's drop-down drawn as a list.
 *
 * It knows nothing about parsing: the list it is handed comes from `Navigator`,
 * which asks the runtime's parser -- `Application.Symbols` -- what a declaration
 * is. This dialog filters it and hands back a line, or the symbol itself when
 * the file is part of the address.
 */
"use strict";

class SymbolForm extends Form {

    /*
     * SymbolForm.go(symbols, lines, (line) => ...)
     *
     * `symbols` is `[{ name, line }]` and `lines` is how many the file has, so
     * a number past the end can be refused rather than scrolling to nothing.
     * The callback gets a 1-based line; cancelling calls nothing at all.
     */
    static go(symbols, lines, onChoose) {
        const dlg = new SymbolForm();

        dlg.symbols  = symbols || [];
        dlg.lines    = lines || 0;
        dlg.onChoose = onChoose;
        dlg.Modal    = true;
        dlg.fill();

        dlg.Show();
        dlg.TxtFind.SetFocus();
        return dlg;
    }

    /*
     * SymbolForm.goProject(symbols, onChoose)
     *
     * The same box over the whole project, where a symbol is
     * `{ name, file, line }`: the aside says where, typing matches the name and
     * the file, and **the digits half is off** -- a line number names a place in
     * a file, and here the file is not the question. One filter and one Enter,
     * because a second expression for either is how the two come to disagree.
     */
    static goProject(symbols, onChoose) {
        const dlg = new SymbolForm();

        dlg.symbols  = symbols || [];
        dlg.lines    = 0;
        dlg.project  = true;
        dlg.onChoose = onChoose;
        dlg.Modal    = true;
        dlg.Text     = Locale.Text("Go to symbol in project");
        dlg.fill();

        dlg.Show();
        dlg.TxtFind.SetFocus();
        return dlg;
    }

    /*
     * One row per method, in the order they are written -- which is the order
     * somebody scrolling would meet them, and the only order that needs no
     * explaining.  Alphabetical would put `Form_Open` between two things it has
     * nothing to do with.
     */
    fill() {
        this.List.Clear();

        for (const symbol of this.symbols) {
            const row = new Panel();
            row.Arrangement = "Horizontal";
            row.Spacing     = 6;
            row.Margin      = 3;
            this.List.Add(row);          /* the row first, then what is in it */

            const name = new Label();
            name.Text    = symbol.name;
            name.HExpand = true;
            name.HAlign  = "Start";
            row.Add(name);

            const at = new Label();
            at.Text   = this.project ? `${symbol.file}:${symbol.line}`
                                     : String(symbol.line);
            at.Style  = "dim-label";
            at.HAlign = "End";
            row.Add(at);
        }
        this.say();
    }

    /*
     * What was typed, as a line number, or 0.
     *
     * Digits and nothing else: `2` is a line and `t2` is a search, which is the
     * rule that lets one box do both without a mode to be in. A number past the
     * end of the file is not a line, and says so by being none.
     */
    lineWanted() {
        if (this.project) return 0;         /* no file of its own to number */

        const text = this.TxtFind.Text.trim();
        if (!/^\d+$/.test(text)) return 0;

        const line = Number(text);
        return line >= 1 && line <= this.lines ? line : 0;
    }

    /*
     * Whether a row survives what was typed.
     *
     * **One function, two callers**, which is the whole reason it is a method:
     * the list asks it per row while it filters, and Enter asks it to find the
     * first row that is still showing. A second expression for the second
     * question is how the two come to disagree.
     */
    matches(index) {
        const symbol = this.symbols[index];
        if (!symbol) return false;

        const text = this.TxtFind.Text.trim();
        if (text === "") return true;

        /* Over the whole project the file is half of what tells two symbols of
         * one name apart, so it is matched too -- `main.greet` narrows what
         * `greet` does not. */
        if (this.project)
            return Locale.Matches(`${symbol.name} ${symbol.file}`, text);

        /* Digits are a line, so nothing in the list matches them. */
        if (/^\d+$/.test(text)) return false;

        return symbol.name.toLowerCase().includes(text.toLowerCase());
    }

    /*
     * The first row still showing, answered **the way this window hands things
     * back**: a line for one file, the symbol itself when the symbol is the
     * address. `wanted()` is the same answer with the chosen row first.
     */
    firstShowing() {
        for (let i = 0; i < this.symbols.length; i++)
            if (this.matches(i)) return this.project ? this.symbols[i]
                                                     : this.symbols[i].line;

        return this.project ? null : 0;
    }

    /*
     * What *Go* means, and it is two things in one order.
     *
     * **The row that is chosen, when one is.** Walking the list with the arrows
     * and then pressing the button has to act on what was walked to; taking the
     * first match regardless is what this did, and it is wrong for the same
     * reason in every dialog shaped like this one -- `QuickForm` has the same
     * two lines, written when this was found.
     *
     * **Otherwise the first still showing**, which is what makes *type three
     * letters and press Enter* the whole gesture.
     */
    wanted() {
        const at = this.List.Index;
        if (at >= 0 && this.matches(at))
            return this.project ? this.symbols[at] : this.symbols[at].line;

        return this.firstShowing();
    }

    /* What the bar under the list says: the line a number would go to, or how
     * many methods are left. Which is the only feedback a filter that hides
     * rows can give when it hides all of them. */
    say() {
        const line = this.lineWanted();
        if (line) {
            this.LblCount.Text = Locale.Text("line {0}", line);
            return;
        }

        const text = this.TxtFind.Text.trim();
        if (!this.project && /^\d+$/.test(text) && text !== "") {
            this.LblCount.Text = Locale.Plural("the file has {0} line",
                                               "the file has {0} lines", this.lines);
            return;
        }

        let showing = 0;
        for (let i = 0; i < this.symbols.length; i++) if (this.matches(i)) showing++;

        this.LblCount.Text = this.project
            ? Locale.Plural("{0} symbol", "{0} symbols", showing)
            : Locale.Plural("{0} method", "{0} methods", showing);
    }

    /* --- events ----------------------------------------------------------- */

    List_Filter(control, index) { return this.matches(index); }

    TxtFind_Change() {
        this.List.Refilter();
        this.say();
    }

    /* Enter takes the line a number names, or the first method still showing --
     * so typing three letters and pressing Enter is the whole gesture. */
    TxtFind_Activate() { this.BtnOk_Click(); }

    /*
     * Which this window went without, so **Escape did not close it and neither
     * did its own Cancel button**: Escape emits `clicked` on the button carrying
     * `Cancel` and stops there, because this runtime will not close a window on
     * a stray keystroke unless the window says so. Every other dialog in this
     * IDE has this line; this one was written without it and nothing noticed,
     * the way nothing notices a handler that is never called.
     */
    BtnCancel_Click() { this.Close(); }

    List_Activate() { this.chose(this.symbols[this.List.Index]); }

    BtnOk_Click() {
        /* A number is a line wherever the selection is: it names a place the
         * list does not hold. */
        const typed = this.lineWanted();
        if (typed) return this.leave(typed);

        const target = this.wanted();
        if (target) this.leave(target);
        /* Nothing matched: the bar already says so, and closing on a keystroke
         * that found nothing would lose what was typed. */
    }

    chose(symbol) {
        if (symbol) this.leave(this.project ? symbol : symbol.line);
    }

    /*
     * Going, once.
     *
     * Enter in the box raises `Activate` on the box **and** presses the default
     * button, so both roads lead here on one keystroke; the guard is what keeps
     * that from closing an already-closed window and calling back twice. A flag
     * of its own rather than clearing the callback, so a dialog opened without
     * one still closes.
     */
    leave(line) {
        if (this.leaving) return;
        this.leaving = true;

        this.Close();
        if (this.onChoose) this.onChoose(line);
    }
}
