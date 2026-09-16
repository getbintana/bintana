/*
 * The find bar.
 *
 * The searching is the runtime's (`SourceEditor.Search` and the four methods around
 * it) and this is the chrome over it -- which is why the bar is a Panel in
 * `MainForm.form` and not a dialog: a bar one types in while the text stays
 * visible cannot be a modal window.
 *
 * The search belongs to the editor, and a code tab owns its editor.  So the bar is
 * a view of *the active tab's* search: switching tabs re-applies it there, and a
 * form tab -- which has no text -- closes it.
 *
 * A class of its own for the reason `Designer` is one: the window's controls
 * dispatch their events to `MainForm` because that is where the runtime looks for
 * a handler, so the handlers stay there and are one line each. What they hand the
 * work to is here.
 */
"use strict";

Namespace("Ide");

Ide.Finder = class Finder {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
    }

    /* The bar's own controls, named as the .form names them. */
    get bar()     { return this.ide.FindBar; }
    get field()   { return this.ide.FindText; }
    get visible() { return this.bar.Visible; }

    /* Whichever editor is on screen, or null on a form tab. */
    get editor()  { return this.ide.Editor; }

    open(replacing) {
        if (!this.editor) return;            /* a form tab has nothing to search */

        /* What is selected is what one meant to look for, which is what makes
         * Ctrl+F on a word a search for that word. A selection spanning lines is
         * not a search term, though -- that is a block someone highlighted. */
        const picked = this.editor.Selection;
        if (picked && !picked.includes("\n")) this.field.Text = picked;

        this.bar.Visible                 = true;
        this.ide.ReplaceRow.Visible      = replacing;
        this.search();
        this.field.SetFocus();
    }

    close() {
        this.bar.Visible               = false;
        this.ide.LblFindCount.Text     = "";

        /* An empty search is what takes the highlight off the text: the bar being
         * hidden says nothing to the editor. */
        if (this.editor) {
            this.editor.Search("");
            this.editor.SetFocus();
        }
    }

    /*
     * Re-runs what the bar says against the active editor and reports the count.
     * Called on every keystroke, on every option change and after a tab switch;
     * it deliberately does not move the cursor, so typing does not drag the view
     * around while one is still saying what to look for.
     */
    search() {
        if (!this.editor || !this.visible) return 0;

        let n = 0;
        try {
            n = this.editor.Search(this.field.Text, this.options());
        } catch (e) {
            /* A pattern half typed is not a failure to report: "(" is a regex
             * nobody has finished, and it stops being one on the next keystroke.
             * The counter says so and that is the whole of it. */
            this.ide.LblFindCount.Text = Locale.Text("bad regex");
            return 0;
        }
        this.showCount(n);
        return n;
    }

    /* "3/12" while standing on a match, "12" before finding one, "none" when
     * there are none -- and nothing at all with an empty field. */
    showCount(n) {
        if (!this.field.Text) {
            this.ide.LblFindCount.Text = "";
            return;
        }
        if (n === 0) {
            this.ide.LblFindCount.Text = Locale.Text("none");
            return;
        }
        const at = this.editor.MatchIndex;
        this.ide.LblFindCount.Text = at ? `${at}/${n}` : `${n}`;
    }

    /* Next (+1) or previous (-1). F3 with the bar closed opens it rather than
     * searching for nothing. */
    step(direction) {
        if (!this.editor) return;
        if (!this.visible) {
            this.open(false);
            return;
        }
        if (!this.field.Text) return;
        if (this.search() === 0) return;

        if (direction > 0) this.editor.FindNext();
        else               this.editor.FindPrevious();

        this.showCount(this.editor.Matches);
    }

    /*
     * Replace acts on the match one is standing on, so with none the first press
     * finds and the second replaces -- and after replacing it walks to the next,
     * which is what makes the button pressable in a row.
     */
    replaceOne() {
        if (!this.editor || !this.field.Text) return;
        if (this.search() === 0) return;

        if (!this.editor.Replace(this.ide.ReplaceText.Text)) {
            this.step(1);
            return;
        }
        this.editor.FindNext();
        this.showCount(this.editor.Matches);
    }

    replaceAll() {
        if (!this.editor || !this.field.Text) return;
        if (this.search() === 0) return;

        const n = this.editor.ReplaceAll(this.ide.ReplaceText.Text);
        this.ide.log(`${n} replaced in ${this.ide.activeFile}\n`);
        this.search();
    }

    /* What the three switches say, in the shape `SourceEditor.Search` takes. */
    options() {
        return {
            CaseSensitive: this.ide.ChkFindCase.Active,
            WholeWord:     this.ide.ChkFindWord.Active,
            Regex:         this.ide.ChkFindRegex.Active,
        };
    }

    /* Called wherever `ide.Editor` is repointed: the bar has to be about the tab
     * that is now on screen, or about nothing. */
    sync() {
        if (!this.visible) return;
        if (!this.editor) {
            this.close();
            return;
        }
        this.search();
    }

    /* Escape closes it, from either field. Answers whether the key was taken. */
    escaped(key) {
        if (key !== "Escape") return false;
        this.close();
        return true;
    }
};
