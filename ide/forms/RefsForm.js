/*
 * Every place a name is used, in one list, and the button that moves it.
 *
 * `F12` answers *where is this declared*; this is the other half -- **where
 * else is it** -- which is what somebody asks before touching a name at all.
 * The searching is `Ide.Refactor`'s, and it is the same answer the rename
 * uses: one function, so the list that is shown and the list that is rewritten
 * cannot disagree about what a reference is.
 *
 * **A window and not a bar**, for `SearchForm`'s reason: the places are in
 * files that are not on screen, so there is nothing to keep visible while one
 * types -- what there is instead is a result set, which is a list and somewhere
 * to go from each row. It is raised rather than opened twice, and not modal,
 * because the point of a result is to be gone to.
 *
 * **Nothing is cached.** A row is computed when the window is opened and when
 * the rename has written, because a file that changed since is a reference that
 * moved -- the same argument the outline and the go-to list make.
 */
"use strict";

/* The one that is up, or null: what `show` raises, and the only handle on it
 * there is. `SearchForm`'s registry, spelled the same way. */
let openRefs = null;

class RefsForm extends Form {

    /*
     * RefsForm.show(ide, word)
     *
     * The word is a bare name -- `this.greet` arrives as `greet` -- because
     * that is what a reference is: the name, wherever it is written.
     */
    static show(ide, word) {
        const dlg = openRefs || new RefsForm();

        if (!openRefs) {
            dlg.ide  = ide;
            openRefs = dlg;
        }
        dlg.word = word;
        dlg.fill();
        dlg.Show();
        dlg.List.SetFocus();
        return dlg;
    }

    static get open() { return openRefs; }

    Form_Close() { openRefs = null; }

    /*
     * The rows, computed on every open: a declaration is labelled with its
     * kind and comes first -- `Ide.Refactor.references` is the one that decides
     * the order -- and a `.form` row has no line to go to, which is what a
     * designer is.
     */
    fill() {
        this.rows = this.ide.refactor.references(this.word);
        this.List.Clear();

        for (const row of this.rows) {
            const panel = new Panel();
            panel.Arrangement = "Horizontal";
            panel.Spacing     = 8;
            panel.Margin      = 3;
            this.List.Add(panel);        /* the row first, then what is in it */

            const place = new Label();
            place.Text   = row.Line ? `${row.File}:${row.Line}` : row.File;
            place.Style  = "dim-label";
            place.Width  = 210;
            place.HAlign = "Start";
            panel.Add(place);

            const text = new Label();
            text.Text      = row.Decl ? `${row.Decl}: ${row.Text}` : row.Text;
            text.HExpand   = true;
            text.HAlign    = "Start";
            text.Ellipsize = true;
            panel.Add(text);
        }

        this.LblWord.Text  = Locale.Text("References to {0}", this.word);
        this.LblCount.Text = Locale.Plural("{0} reference", "{0} references",
                                           this.rows.length);
    }

    /* A row is a place: double click or Enter goes there, and a `.form` opens
     * in the designer, which is where a control is. */
    List_Activate() {
        const row = this.rows[this.List.Index];
        if (row) this.ide.runner.open(row.File, row.Line);
    }

    /*
     * The rename, asked for and then reported.
     *
     * `Ide.Refactor.rename` refuses with a sentence rather than half writing,
     * so the only two outcomes are a message or a count -- and the list is
     * recomputed after either, because a refusal is the moment one wants to
     * see the place it is about.
     */
    BtnRename_Click() {
        AskForm.prompt(Locale.Text("Rename symbol"), Locale.Text("New name:"),
                       this.word, (name) => {
            const done = this.ide.refactor.rename(this.word, name);

            if (done.Refused) {
                Message.Error(done.Refused);
                return;
            }
            this.ide.log(`${this.word} -> ${name}: ${done.Moved} references in ` +
                         `${done.Files.length} files\n`);
            this.word = name;
            this.fill();
        });
    }

    BtnClose_Click() { this.Close(); }
}
