/*
 * Quick open: a file of the project by part of its name, or a command by part of
 * what the menu calls it.
 *
 * **One box and two kinds of answer, decided by what is typed** -- which is
 * `SymbolForm`'s rule, written there for digits against letters, and the same
 * rule here for `>` against everything else. `Ctrl+P` opens it on the files and
 * `Ctrl+Shift+P` opens it with the `>` already in, so the two keys are one
 * window rather than two that look alike.
 *
 * Prior art: TextMate's `Cmd+T` is where a fuzzy file box came from, Sublime
 * put a command palette behind `Ctrl+Shift+P` and VS Code took both and made
 * them one box. Visual Studio's *Quick Launch* and Delphi's IDE Insight are the
 * same idea in this family, and Gambas and VB6 have neither -- which is the gap
 * this closes for anybody arriving from an editor written after 2004.
 *
 * **It invents no commands.** The list is `MainForm`'s own menu bar, read out of
 * `Form.Menus` -- the spec the `.form` was loaded from -- so a menu item added
 * to that file appears here with nothing told to it, with the accelerator it
 * declares and, crucially, with **the enabled state the IDE already computes**.
 * `refresh()` decides whether *Save* can be pressed; this asks the same item the
 * same question, which is why a command that would refuse is shown greyed rather
 * than hidden: *where did Save go* is a worse answer than a row that says why by
 * being dim.
 *
 * Matching is `Locale.Matches`, which folds accents -- this project's own answer
 * to *should a search for this find that*, and the reason a file called
 * `Facturación.js` is found by typing `factura`.
 */
"use strict";

/* The palette that is up, so the next `Ctrl+P` reuses it and the driver can
 * reach it.  A registry, not a collector workaround: the runtime holds a shown
 * form alive by itself. */
const openQuickPickers = [];

/* What turns the box from a file search into a command search. Sublime's
 * character, and VS Code's after it. */
const QUICK_COMMAND = ">";

class QuickForm extends Form {

    /* The one that is open, if any -- `SearchForm`'s spelling, for the same two
     * readers: the test that drives it, and the next `Ctrl+P`. */
    static get open() { return openQuickPickers[openQuickPickers.length - 1] || null; }

    /*
     * QuickForm.show(ide, commands)
     *
     * `commands` only says which half the box starts on; both halves are always
     * there, a character apart.
     */
    static show(ide, commands) {
        const dlg = new QuickForm();

        dlg.ide      = ide;
        dlg.files    = ide.classes ? ide.classes.files.slice() : [];
        dlg.commands = dlg.readCommands();
        dlg.Modal    = true;

        if (commands) dlg.TxtFind.Text = QUICK_COMMAND;

        dlg.fill();
        openQuickPickers.push(dlg);
        dlg.Show();
        dlg.TxtFind.SetFocus();

        /*
         * **`SetFocus` on a field selects what is in it**, which is right for a
         * box one is about to retype and exactly wrong here: the `>` this window
         * was opened with was selected, so the first character typed replaced it
         * and the palette turned back into the file picker under the user's
         * hands. The caret goes after it instead, with nothing selected.
         *
         * Deleting the `>` on purpose still switches back, and should: it is the
         * one character that says which half this is.
         */
        if (commands) dlg.TxtFind.Select(QUICK_COMMAND.length, 0);
        return dlg;
    }

    /* --- the commands, which are the menu bar -------------------------------- */

    /*
     * Every menu item that does something, flattened, with the submenu it is in
     * written in front of it.
     *
     * The path is what tells two *Refresh*es apart -- the project tree has one
     * and so does git -- and it is what a palette is for: seeing the command
     * without having to remember which menu it was filed under.
     *
     * A separator has nothing to run and a submenu is not a command; an item
     * that points at an `action` has no name of its own, so it is skipped too --
     * the three of those in this IDE are the designer's context menu and are
     * about a selection, which is not something a palette can have.
     */
    readCommands() {
        const out = [];
        const ide = this.ide;

        const walk = (items, path) => {
            for (const item of items || []) {
                if (item.separator) continue;

                const text = Locale.Text(quickStrip(item.text || ""));

                if (item.children && item.children.length) {
                    walk(item.children, path ? `${path} > ${text}` : text);
                    continue;
                }
                if (!item.name || !ide[item.name]) continue;

                out.push({ name: item.name, text, path,
                           shortcut: quickShortcut(item.shortcut) });
            }
        };

        walk(ide.Menus, "");
        return out;
    }

    /* Whether a command can be pressed right now -- asked of the menu item
     * itself, which is what `MainForm.refresh` has already decided. */
    enabled(command) {
        const item = this.ide[command.name];
        return !item || item.Enabled !== false;
    }

    /* --- what is in the list ------------------------------------------------- */

    /* Which half the box is on. */
    get commanding() {
        return this.TxtFind.Text.startsWith(QUICK_COMMAND);
    }

    /* What is being searched for, without the character that chose the half. */
    get needle() {
        const text = this.TxtFind.Text;
        return (this.commanding ? text.slice(QUICK_COMMAND.length) : text).trim();
    }

    /* The rows, whichever half is showing. */
    get entries() {
        return this.commanding ? this.commands : this.files;
    }

    /*
     * One row per entry: what it is called, and on the right the thing that
     * tells two of them apart -- the folder for a file, the accelerator for a
     * command.
     *
     * Rebuilt when the half changes and not while typing, which is what
     * `Refilter` is for.
     */
    fill() {
        this.List.Clear();
        this.drawn = this.commanding;

        for (const entry of this.entries) {
            const row = new Panel();
            row.Arrangement = "Horizontal";
            row.Spacing     = 6;
            row.Margin      = 3;
            this.List.Add(row);          /* the row first, then what is in it */

            /*
             * **No `Ellipsize` on either of these**, and that is not an
             * oversight: it caps a label's *natural* width, which is what stops
             * a long string from stretching its container -- and a row of a
             * `RowList` is sized from what is in it. Two ellipsized labels in
             * one row have no natural width between them, so the row collapses
             * and both draw as `...` and nothing else. Measured, on this
             * window, by writing it that way first.
             *
             * `SymbolForm`'s rows are built exactly like this and have always
             * been: one label that expands, one that does not.
             */
            const name = new Label();
            name.Text    = this.commanding ? entry.text : File.Name(entry);
            name.HExpand = true;
            name.HAlign  = "Start";
            /* A command that would refuse says so by looking like it. */
            if (this.commanding && !this.enabled(entry)) name.Style = "dim-label";
            row.Add(name);

            const aside = new Label();
            aside.Text   = this.commanding ? (entry.shortcut || entry.path)
                                           : File.Directory(entry);
            aside.Style  = "dim-label";
            aside.HAlign = "End";
            row.Add(aside);
        }
        this.say();
    }

    /*
     * Whether a row survives what was typed.
     *
     * **One function, two callers** -- the list asks it per row while it
     * filters, and Enter asks it for the first row still showing. `SymbolForm`
     * says the rest: a second expression for the second question is how the two
     * come to disagree.
     *
     * A file is matched on its whole path and not only its name, so `forms/main`
     * finds what `main` finds and narrows it.
     */
    matches(index) {
        const entry = this.entries[index];
        if (entry === undefined) return false;

        const needle = this.needle;
        if (needle === "") return true;

        return this.commanding
            ? Locale.Matches(`${entry.path} ${entry.text}`, needle)
            : Locale.Matches(entry, needle);
    }

    firstShowing() {
        for (let i = 0; i < this.entries.length; i++)
            if (this.matches(i)) return this.entries[i];

        return null;
    }

    /*
     * What *Go* means, and it is two things in one order.
     *
     * **The row that is chosen, when one is** -- walking the list with the
     * arrows or clicking a row and then pressing the button has to act on what
     * was picked, which is the whole reason the list can be walked at all.
     * Taking the first match instead is the shape `SymbolForm` has, and there it
     * is invisible because nothing in that dialog leaves a selection behind.
     *
     * **Otherwise the first still showing**, which is what makes *type three
     * letters and press Enter* the whole gesture.
     *
     * The `matches` guard is a cheap defence and not a case that is known to
     * happen: measured, `Refilter` leaves no selection behind, so typing already
     * lets go of the row. It costs one comparison to not depend on that.
     */
    wanted() {
        const at = this.List.Index;
        if (at >= 0 && this.matches(at)) return this.entries[at];

        return this.firstShowing();
    }

    /* The bar under the list: how many are left, which is the only feedback a
     * filter that hides rows can give when it hides all of them. */
    say() {
        let showing = 0;
        for (let i = 0; i < this.entries.length; i++) if (this.matches(i)) showing++;

        this.LblCount.Text = this.commanding
            ? Locale.Plural("{0} command", "{0} commands", showing)
            : Locale.Plural("{0} file", "{0} files", showing);
    }

    /* --- events -------------------------------------------------------------- */

    List_Filter(control, index) { return this.matches(index); }

    /*
     * Typing. The rows are rebuilt only when the `>` went in or came out --
     * every other keystroke is a filter over rows that are already there, which
     * is what keeps this a lookup on the keystroke.
     */
    TxtFind_Change() {
        if (this.commanding !== this.drawn) {
            this.fill();
            this.Text = this.commanding ? Locale.Text("Run a command")
                                        : Locale.Text("Go to file");
            return;
        }
        this.List.Refilter();
        this.say();
    }

    TxtFind_Activate() { this.BtnOk_Click(); }

    /*
     * **A `Cancel` button needs this, and that is easy to get wrong.** Escape
     * emits `clicked` on whichever button carries `Cancel` and stops there: the
     * runtime deliberately does not close a window on a stray keystroke, so a
     * dialog with no handler on that button cannot be dismissed with Escape *or*
     * with the button. `SymbolForm` had exactly that until this one was written
     * beside it.
     */
    BtnCancel_Click() { this.Close(); }

    List_Activate() { this.chose(this.entries[this.List.Index]); }

    BtnOk_Click() {
        const entry = this.wanted();
        if (entry) this.chose(entry);
        /* Nothing matched: the bar already says so, and closing on a keystroke
         * that found nothing would lose what was typed. */
    }

    chose(entry) {
        if (entry === undefined || entry === null) return;
        /* A command that would refuse is not run by pressing Enter on it either:
         * the row is dim for a reason and Enter must mean the same thing as the
         * click. */
        if (this.commanding && !this.enabled(entry)) return;

        this.leave(entry);
    }

    /*
     * Going, once.
     *
     * Enter in the box raises `Activate` on the box **and** presses the default
     * button, so both roads lead here on one keystroke; the guard is what keeps
     * that from closing an already-closed window and acting twice.
     *
     * **The window closes before the command runs.** Several of them open a
     * dialog of their own, and running one under a modal that is still up puts
     * the second window behind the first.
     */
    leave(entry) {
        if (this.leaving) return;
        this.leaving = true;

        const commanding = this.commanding;
        const ide        = this.ide;
        this.Close();

        if (commanding) {
            ide[entry.name].Click();
            return;
        }

        /* Both, and neither is redundant: `openNamed` marks the row in the tree
         * and does nothing at all when the file is not one of its keys, which a
         * `.form`'s `.js` need not be. `openInTab` is what actually opens, and
         * is a no-op switch when the first call already did. */
        ide.openNamed(entry);
        ide.openInTab(entry);
    }

    /*
     * Letting go of itself, on every road out: the button, Escape (which is what
     * `Cancel` on that button means) and the frame's X.
     *
     * **It must not return true.** `Form_Close` is a veto -- true keeps the
     * window open.
     */
    Form_Close() {
        const at = openQuickPickers.indexOf(this);
        if (at >= 0) openQuickPickers.splice(at, 1);
    }
}

/*
 * A menu's label carries the mnemonic the bar draws underlined: `_File` is the
 * File menu, and a palette has no underlines to draw.
 *
 * Named for this file and not `strip`, because these files share one lexical
 * scope: a generic name declared here is that name taken from every other module
 * in the IDE.
 */
function quickStrip(text) {
    return text.replace(/_/g, "");
}

/* `<Control><Shift>p` as a person reads it. GTK's spelling is for GTK, and an
 * item may declare several -- the first is the one to show. */
function quickShortcut(shortcut) {
    const first = Array.isArray(shortcut) ? shortcut[0] : shortcut;
    if (!first) return "";

    const said = first.replace(/<Control>/g, "Ctrl+")
                      .replace(/<Primary>/g, "Ctrl+")
                      .replace(/<Shift>/g, "Shift+")
                      .replace(/<Alt>/g, "Alt+");

    /* The key itself is written lowercase in the spec -- `<Control>r` -- and
     * read uppercase everywhere a person sees it. `F9` is already the way it is
     * shown and a blanket `toUpperCase` would leave it alone anyway; what has to
     * be found is the last segment, not the whole string. */
    const cut = said.lastIndexOf("+");
    return said.slice(0, cut + 1) +
           said.slice(cut + 1).replace(/^[a-z]$/, (c) => c.toUpperCase());
}
