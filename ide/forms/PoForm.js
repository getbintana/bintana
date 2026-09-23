/*
 * The catalogue editor: a `.po` edited here instead of handed to Poedit.
 *
 * A window of its own and not a tab, which is `MenuForm`'s shape -- the menu
 * editor is the closest thing in the IDE and it is a dialog for the same reason:
 * a third kind of tab would touch how every tab is placed, saved, marked dirty
 * and closed, for a file most projects have two of.
 *
 * **What it does not do is the interesting half.** No translation memory, no
 * fuzzy matching against similar strings, no machine translation, no format
 * checks -- those are what Poedit is actually good at, and *Open in translation
 * editor* is still one menu item away. What this covers is the case a RAD flow
 * really produces: the strings of your own application, edited where you are.
 *
 * The one thing it must not get wrong is **losing what it does not understand**.
 * `Locale.Read` keeps every comment, flag and `#~` block as written, this edits
 * only the msgstr values and the fuzzy flag, and `Locale.Write` puts the rest
 * back untouched. A catalogue holds a translator's work; an editor that quietly
 * drops a line of it is worse than no editor.
 */
"use strict";

/* The editors that are up, keyed by file, so opening the same catalogue twice
 * brings the window that is already there rather than a second one over the
 * same file.  A registry, not a collector workaround: the runtime holds a shown
 * form alive by itself. */
const openCatalogues = new Map();

/* The least a translation box may be squeezed to.  A `TextEditor` and not a
 * `TextBox` because a translation may have newlines in it and a GtkEntry cannot
 * hold one -- which would drop them on save, silently, which is the one thing
 * this must not do.
 *
 * It used to be the source editor with its languages turned off, in three lines
 * of apology -- `Language = ""`, `ShowLineNumbers = false`, `Wrap = true`. Those
 * are gone: a plain `TextEditor` is a GtkTextView, so it arrives wrapping, with
 * no gutter and nothing to highlight. This form is why the class exists. */
const FORM_HEIGHT = 64;

/* What marks an entry in the list.  Two characters, so the msgids still line
 * up: a translator reads the column, not the marks. */
const MARK_TODO  = "● ";   /* ● nothing in it */
const MARK_FUZZY = "~ ";        /* needs work */
const MARK_DONE  = "  ";

class PoForm extends Form {

    /*
     * Opens the editor for one catalogue, or raises the one already on it.
     *
     * `ide` is passed rather than reached for: this window is a form like any
     * other and has no more access to the IDE than it is handed.
     */
    static edit(ide, file) {
        const already = openCatalogues.get(file);
        if (already) {
            already.Show();
            return already;
        }

        const dlg = new PoForm();
        dlg.ide  = ide;
        dlg.file = file;
        dlg.path = File.Join(ide.project, file);

        openCatalogues.set(file, dlg);
        dlg.Show();
        return dlg;
    }

    /* Whether any catalogue is being edited: `Update translations` rewrites these
     * files with msgmerge, and doing that underneath an open editor is how the
     * work in it gets lost. */
    static get busy() { return openCatalogues.size > 0; }
    static get openFiles() { return [...openCatalogues.keys()]; }

    Form_Open() {
        this.entries  = [];
        this.shown    = [];      /* indices into `entries`, as the list shows them */
        this.current  = -1;
        this.dirty    = false;
        this.updating = false;   /* the editor is the one writing, not the user */
        this.boxes    = [];

        this.retitle();

        try {
            const read   = this.ide.catalogues.read(this.path);
            this.entries = read.entries;
            this.nplurals = Math.max(1, read.nplurals);
        } catch (e) {
            Message.Error("Cannot read {0}: {1}", this.file, e.message);
            this.Close();
            return;
        }

        this.buildBoxes();
        this.fill();
    }

    /*
     * One translation box per plural form, built once.
     *
     * Once and not per selection, which is the lesson the property grid learnt
     * twice: rebuilding an editor takes the focus and the caret away from
     * whoever is typing, and a widget's undo history dies with it. What changes
     * per entry is which boxes are visible.
     */
    buildBoxes() {
        for (let i = 0; i < this.nplurals; i++) {
            const caption = new Label();
            caption.Alignment = "Left";
            caption.Style     = "caption-heading";
            caption.Name      = `Cap${i}`;
            this.Forms.Add(caption);

            const box = new TextEditor();
            /*
             * `Height` and `Expand` together, and each does half of it: in a box
             * a height is the *least* the control may be, and `Expand` is what
             * makes it take the room there is. With only the height it stayed
             * 64px tall in a pane grown to 272; with only `MinHeight` -- which
             * answers for a stretched control on a *surface* and means nothing
             * in a box -- it was squeezed to 46.
             */
            box.Height          = FORM_HEIGHT;
            box.Expand          = true;
            this.Forms.Add(box);

            /* The handler belongs to the box, which is what lets one be made
             * on the fly without a name for the dispatch to go through. */
            box.On("Change", () => this.formChanged(i));

            this.boxes.push({ caption, box });
        }
    }

    /* --- the list -------------------------------------------------------- */

    /* An entry a person translates: the header and the comment-only tail are
     * neither shown nor editable, and they are written back untouched. */
    isTranslatable(entry) {
        return entry.msgid !== null && entry.msgid !== undefined && entry.msgid !== "";
    }

    isTodo(entry) {
        if ((entry.flags || []).includes("fuzzy")) return true;
        return !(entry.forms || []).some((f) => f !== "");
    }

    markOf(entry) {
        if ((entry.flags || []).includes("fuzzy")) return MARK_FUZZY;
        return this.isTodo(entry) ? MARK_TODO : MARK_DONE;
    }

    /*
     * Refills the list from the entries, keeping the selection on the same entry
     * where it can -- turning the filter on must not silently move you to another
     * string.
     */
    fill() {
        const was = this.current;

        this.shown = [];
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (!this.isTranslatable(entry)) continue;
            if (this.ChkTodo.Active && !this.isTodo(entry)) continue;
            this.shown.push(i);
        }

        this.updating = true;
        try {
            this.LstEntries.Items = this.shown.map((i) => {
                const entry = this.entries[i];
                const ctxt  = entry.ctxt !== undefined ? `[${entry.ctxt}] ` : "";
                return `${this.markOf(entry)}${ctxt}${this.oneLine(entry.msgid)}`;
            });
        } finally {
            this.updating = false;
        }

        this.count();

        const at = this.shown.indexOf(was);
        this.LstEntries.Index = at >= 0 ? at : (this.shown.length ? 0 : -1);
        this.LstEntries_Select();
    }

    /* A msgid with newlines in it is one row of a list, so it is shown as one
     * line; the box below holds the real thing. */
    oneLine(text) {
        const flat = String(text).replace(/\n/g, " ¶ ");
        return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
    }

    count() {
        const all  = this.entries.filter((e) => this.isTranslatable(e));
        const todo = all.filter((e) => this.isTodo(e));

        /*
         * The second one is a real plural: "1 string" and "9 strings" do not
         * agree the same way in every language, and a catalogue with one entry
         * in it is an ordinary state.
         *
         * The lint does not catch these two, and could not: they were a template
         * behind a ternary, and `.Text = cond ? ... : ...` is past what a regular
         * expression should be asked to see. A lint that finds the common shapes
         * is worth having; one that promises to find all of them is not honest.
         */
        this.LblCount.Text = todo.length
            ? Locale.Text("{0} of {1} left to translate", todo.length, all.length)
            : Locale.Plural("{0} string, translated", "{0} strings, all translated",
                            all.length);
    }

    LstEntries_Select() {
        if (this.updating) return;

        const at = this.LstEntries.Index;
        this.current = at >= 0 && at < this.shown.length ? this.shown[at] : -1;
        this.show();
    }

    /* --- the entry on screen --------------------------------------------- */

    show() {
        const entry = this.current >= 0 ? this.entries[this.current] : null;

        this.updating = true;
        try {
            this.LblSource.Text = entry ? entry.msgid : "";
            this.ChkFuzzy.Active = entry ? (entry.flags || []).includes("fuzzy") : false;
            this.ChkFuzzy.Enabled = !!entry;

            /* The references the extractor wrote: where in the project this
             * string is, which is what tells a translator what they are looking
             * at.  A comment that is not one is left out rather than shown as
             * noise. */
            const refs = entry
                ? (entry.comments || []).filter((c) => c.startsWith("#:"))
                                        .map((c) => c.slice(2).trim())
                : [];
            this.LblRefs.Text = refs.join("   ");

            /* A plural entry has one box per form; everything else has one, and
             * the caption says which is which rather than a number nobody can
             * read the meaning of. */
            const wanted = entry && entry.plural !== undefined ? this.nplurals
                         : entry ? 1 : 0;

            for (let i = 0; i < this.boxes.length; i++) {
                const { caption, box } = this.boxes[i];
                const on = i < wanted;

                caption.Visible = on;
                box.Visible     = on;
                if (!on) continue;

                caption.Text = wanted === 1 ? "Translation" : `Plural form ${i}`;
                box.Text     = (entry.forms && entry.forms[i]) || "";
                box.ReadOnly = false;
            }

            /* The plural's own source, so a translator can see both. */
            if (entry && entry.plural !== undefined) {
                this.LblSource.Text = [entry.msgid, entry.plural].join("\n");
            }
        } finally {
            this.updating = false;
        }
    }

    /* --- edits ----------------------------------------------------------- */

    formChanged(i) {
        if (this.updating || this.current < 0) return;

        const entry = this.entries[this.current];
        const text  = this.boxes[i].box.Text;

        entry.forms = entry.forms || [];
        while (entry.forms.length <= i) entry.forms.push("");
        if (entry.forms[i] === text) return;      /* an edit that changes nothing */

        entry.forms[i] = text;
        this.touch();
        this.refreshRow();
    }

    ChkFuzzy_Click() {
        if (this.updating || this.current < 0) return;

        const entry = this.entries[this.current];
        entry.flags = (entry.flags || []).filter((f) => f !== "fuzzy");
        if (this.ChkFuzzy.Active) entry.flags.unshift("fuzzy");

        this.touch();
        this.refreshRow();
    }

    ChkTodo_Click() { this.fill(); }

    /*
     * The row's mark, without rebuilding the list.
     *
     * Refilling on every keystroke would take the selection -- and with the
     * filter on it would take the row out from under the cursor the moment the
     * first character was typed, which is the sort of thing that makes an editor
     * unusable.
     */
    refreshRow() {
        const at = this.shown.indexOf(this.current);
        if (at < 0) return;

        const entry = this.entries[this.current];
        const ctxt  = entry.ctxt !== undefined ? `[${entry.ctxt}] ` : "";
        const text  = `${this.markOf(entry)}${ctxt}${this.oneLine(entry.msgid)}`;

        const items = this.LstEntries.Items;
        if (items[at] === text) return;

        this.updating = true;
        try {
            items[at] = text;
            this.LstEntries.Items = items;
            this.LstEntries.Index = at;
        } finally {
            this.updating = false;
        }
        this.count();
    }

    touch() {
        if (this.dirty) return;
        this.dirty = true;
        this.retitle();
    }

    /*
     * The title, which says which catalogue and whether it is saved.
     *
     * Through Locale.Text rather than a template assigned to `.Text`: a template
     * there is in no `.form` and in no call an extractor knows, so it reads as
     * ordinary composed text and stays in English for ever. It is what happened
     * to this IDE's own window title, and the lint reports it now.
     */
    retitle() {
        this.Text = this.dirty ? Locale.Text("Translations — {0} *", this.file)
                               : Locale.Text("Translations — {0}", this.file);
    }

    /* --- saving and closing ---------------------------------------------- */

    BtnSave_Click() { this.save(); }

    save() {
        try {
            Locale.Write(this.path, this.entries);
        } catch (e) {
            Message.Error("Cannot save {0}: {1}", this.file, e.message);
            return false;
        }
        this.dirty = false;
        this.retitle();
        Logger.Info(`saved ${this.file}`);
        return true;
    }

    /* Both ways out go through `Form_Close`, which is where the asking is. */
    BtnClose_Click() { this.Close(); }

    /*
     * The window's own X **and** the Close button, which used to do different
     * things and no longer have to.
     *
     * They differed because a form could not refuse to close: the X saved behind
     * the translator's back -- the better of two surprises, the file being in the
     * project tree and under version control -- while the button asked.  A
     * `Form_Close` that returns true keeps the window open now, so the X can ask
     * the same question the button did, and there is one answer to "what happens
     * to unsaved work" instead of two.
     *
     * The veto is lifted by `closing`, set from the dialog's own answer: the
     * `Close()` it calls comes back through here.
     */
    Form_Close() {
        if (this.dirty && !this.closing) {
            /* The question itself is what comes back -- truthy, which is what
             * the runtime reads as the veto, and a handle for whoever is
             * driving the IDE rather than using it. */
            return ConfirmForm.ask(
                Locale.Text("Close"),
                Locale.Text("Close {0} without saving the changes?", this.file),
                Locale.Text("Close without saving"),
                () => { this.closing = true; this.Close(); },
                { Text: Locale.Text("Save and close"),
                  Run:  () => { if (this.save()) { this.closing = true; this.Close(); } } });
        }
        openCatalogues.delete(this.file);
    }
}
