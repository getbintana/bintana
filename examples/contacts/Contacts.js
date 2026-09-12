/*
 * A phone book, and the point of it is that the names are where they belong.
 *
 * `["Zapata", "Álvarez"].sort()` answers *Zapata, Álvarez* — and it is not a near
 * miss at alphabetical order, it is a different order altogether.  `sort()` with
 * no argument compares UTF-16 code units, so `Á` is 193 and `Z` is 90 and **every
 * accented name in this language files after Z**.  So does every name that starts
 * with a lowercase letter, which is how a Dutch or a Spanish surname is written:
 * *van der Berg*, *de la Fuente*.  Half the list in this window is one of those.
 *
 * The usual answer is `localeCompare`, and it is installed here — it is a method
 * of `String` and nothing took it away.  On this engine it is `strcmp` wearing
 * the name: QuickJS is built without ICU, so there is no `Intl`, and the fallback
 * a comparison with no collator gets is that same code-unit order.  It reads like
 * the fix and changes nothing, which is worse than not having it.
 *
 * Bintana has [`Locale.Compare`](../../docs/runtime-api.md#locale), which is the
 * desktop's own order, and [`Locale.Matches`](../../docs/runtime-api.md#locale),
 * which is the desktop's own idea of what a search finds.  Between them the whole
 * of this file's logic is two lines:
 *
 *     .sort((a, b) => Locale.Compare(a.Name, b.Name))
 *     Locale.Matches(contact.Name, this.needle)
 *
 * **This window makes no argument about any of that, and that is deliberate.**
 * The calculator does not show what a `double` would have answered beside its own
 * result; it just gives the right one.  A phone book is a phone book: the list is
 * in order, the search finds what was typed, and what it took to be right is here
 * in the file rather than on screen.  Run it in a Spanish desktop and read down
 * the list — *Ñanculeo* sits between *Núñez* and *Ortiz*, where somebody looking
 * for it would look, and there is nothing to click to see that.
 *
 * ## The search
 *
 * It is `includes` plus what `includes` cannot do.  `ver` finds *Echeverría* the
 * way anybody expects; `garcia` finds *García*, because `"Á".toLowerCase()` is
 * `"á"` and no amount of lowercasing gets from one to the other — the folding has
 * to know about the alphabet, which is what `Locale` knows and the language
 * underneath does not.  The needle is split on its spaces too, so `maria alv`
 * finds *Álvarez, María* whichever way round the list writes the two halves.
 *
 * That rule is the second one this file had.  The first was GTK's own
 * (`g_str_match_string`: a word of the text *starting with* a word of what was
 * typed), which is defensible on paper and lasted until somebody searched for
 * `ver`.  There is no reading of a search box under which not finding
 * *Echeverría* is the right answer.
 *
 * ## What else it is worth reading for
 *
 *   - **sorting builds the rows; searching does not.**  A `RowList`'s order is the
 *     order its children were added in, so it is settled once, when the file is
 *     read.  The field over it is a `Filter`: the rows stay, and GTK asks which of
 *     them to show — so the selection and the caret survive every keystroke.  That
 *     is the whole subject of `examples/files`.
 *   - the count at the bottom goes through `Locale.Plural`, so *1 contact* and
 *     *32 contacts* are one call and the catalogue decides how many forms its
 *     language has.
 *   - **Copy number** is `Clipboard.Copy`, which is immediate — only pasting is
 *     an answer that has to arrive.  What is worth reading there is the
 *     bookkeeping around it rather than the call: the button follows the
 *     selection, and a row filtered away while it was selected drops the
 *     selection instead of leaving the button pointing at a contact nobody can
 *     see.
 *   - **it resizes**, and nothing here does anything about it: the field and the
 *     list say `HAlign: "Fill"`, the list says `VAlign: "Fill"`, and the count
 *     stays at the bottom with `VAlign: "End"`.  No resize handler.
 *
 * ## The one that was found by writing this
 *
 * `TableView.SortBy` has collated correctly since the day it was written — it is
 * `g_utf8_collate`, in C, in `bta_table.c`.  That is exactly what kept this
 * missing for so long: the widget that sorts its own rows was right, and every
 * list a *program* sorted by hand was wrong, and the two never met.  The IDE's own
 * project tree was one of them, and so was `examples/viewer`.
 *
 * Run it with `./build/bintana examples/contacts`.
 */
"use strict";

class Contacts extends Form {

    /*
     * One entry per row, **in row order**, and that is the whole of the
     * bookkeeping: what GTK hands the filter is a row index, and a row of controls
     * says nothing about which contact it draws.
     */
    contacts = [];

    /*
     * What the filter answers from, read off the field once per edit rather than
     * once per row: the handler runs inside GTK's layout and has no business
     * asking a widget anything, thirty-two times over.
     */
    needle = "";

    Form_Open() {
        const path = File.Join(Application.Directory, "contacts.json");

        try {
            this.contacts = File.LoadJson(path);
        } catch (e) {
            Message.Error("Cannot read {0}: {1}", path, e.message);
            return;
        }

        /*
         * The order this desktop puts names in.  `Locale.Compare` is `strcoll`
         * under the C locale the runtime already set at startup — the same one
         * `Locale.Number` writes a comma with and `Locale.Date` writes a month
         * with.  A Spanish desktop files *Ñanculeo* between *Núñez* and *Ortiz*
         * rather than after *Zapata*, and a Swedish one files *Öztürk* last;
         * neither of those is a rule this file could carry.
         */
        this.contacts.sort((a, b) => Locale.Compare(a.Name, b.Name));

        for (const contact of this.contacts)
            this.List.Add(this.row(contact));

        this.List.Index = -1;
        this.showCount();
        this.TxtFind.SetFocus();
    }

    /*
     * A row is three controls, which is what a `RowList` is for and what no
     * `ListBox` of strings can hold -- and the three are in `Contact.form`
     * rather than here.
     *
     * This used to be forty lines that made a `Panel`, three `Label`s and set
     * eight properties on them. It is a component now, which buys two things
     * this file was paying for: the row is **drawn** rather than assembled, and
     * `Contacts.form` can say what the list holds while it is being designed
     * (`"item": { "of": "Contact", "count": 3 }`) instead of showing an empty
     * box for a window to be laid out around.
     *
     * `Person` and not `Name`, because a widget's `Name` is the runtime's:
     * see the head of `Contact.js`.
     */
    row(contact) {
        const row = new Contact();

        row.Person = contact.Name;
        row.City   = contact.City;
        row.Phone  = contact.Phone;

        return row;
    }

    /* --- searching ----------------------------------------------------------
     *
     * Asked by GTK, one row at a time, when a row arrives and when `Refilter` says
     * the answer may have changed.  A lookup and nothing that is not a lookup: it
     * runs while the list is being laid out.
     */
    List_Filter(row, index) {
        return this.shows(this.contacts[index]);
    }

    /*
     * The predicate, on the contact rather than on the row — one place decides,
     * and `showCount` asks the same question the list does.  Two copies of this
     * rule is how a list comes to say *12 of 32* while showing thirteen.
     */
    shows(contact) {
        if (!contact) return true;      /* a row we know nothing about is shown */

        return Locale.Matches(contact.Name, this.needle) ||
               Locale.Matches(contact.City, this.needle);
    }

    /*
     * The guard is not defensive programming, it is the loader.  A `.form` applies
     * each property by assignment, and a control joins the form under its name only
     * *after* its own properties are set — so a `Text` in the file would raise
     * `Change` while `this.TxtFind` is still undefined.  `contacts` is filled by
     * `Form_Open` and by nothing else, which makes it the honest question: is there
     * anything to search yet?
     */
    TxtFind_Change() {
        if (!this.contacts.length) return;

        this.needle = this.TxtFind.Text.trim();
        this.List.Refilter();

        /*
         * A row that has just been filtered away is still selected — `Index`
         * numbers every row, shown or not — so the button would go on offering
         * to copy a number nobody can see. Dropping the selection is the honest
         * answer, and it has to disable the button by hand: `Select` fires when
         * something *is* selected, and a list that just went empty selected
         * nothing.
         */
        if (this.selected && !this.shows(this.selected)) {
            this.List.Index = -1;
            this.BtnCopy.Enabled = false;
        }

        this.showCount();
    }

    /* --- the selection ------------------------------------------------------
     *
     * **`Index` counts every row, filtered or not**, which is exactly why
     * `this.contacts[at]` is the right lookup: the list holds all its rows, and
     * what a filter changes is what is on screen. An index that renumbered itself
     * as one typed would put these two out of step at the first keystroke.
     */
    get selected() {
        const at = this.List.Index;
        return at < 0 ? null : this.contacts[at];
    }

    List_Select() {
        this.BtnCopy.Enabled = this.selected !== null;
    }

    /*
     * `Clipboard.Copy` is immediate — the copying half of the clipboard is a call,
     * and only pasting is an answer that has to arrive.
     *
     * The status line says what happened and then goes back to saying what it
     * says: a confirmation that stays forever stops being one, and there is
     * nowhere else on this window for it. `Timer.After` is the whole mechanism,
     * and a second copy inside those seconds simply arms another one — both end
     * up calling `showCount`, which works out the truth from scratch either way.
     */
    BtnCopy_Click() {
        const contact = this.selected;
        if (!contact) return;

        Clipboard.Copy(contact.Phone);
        this.LblCount.Text = Locale.Text("Copied {0}", contact.Phone);
        Timer.After(3000, () => this.showCount());
    }

    /* The button inside the field is `edit-clear-symbolic`, so it clears — an icon
     * in a text field is a promise about what pressing it does. */
    TxtFind_IconClick() {
        this.TxtFind.Text = "";
        this.TxtFind_Change();
    }

    showCount() {
        const total = this.contacts.length;

        if (!this.needle) {
            /* The catalogue's own rule for how many plural forms its language
             * has, rather than an `n === 1` written here. */
            this.LblCount.Text = Locale.Plural("{0} contact", "{0} contacts", total);
            return;
        }

        const shown = this.contacts.filter((c) => this.shows(c)).length;
        this.LblCount.Text = Locale.Text("{0} of {1} shown", shown, total);
    }

}
