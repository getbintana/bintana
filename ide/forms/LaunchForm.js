/*
 * How this project is run: the configurations, edited.
 *
 * A list on the left and the chosen one's fields on the right, which is the
 * shape every tool with named run settings has -- Delphi's *Run Parameters*,
 * Lazarus's modes, VS Code's `launch.json` seen through its UI.
 *
 * Like every other dialog here it works on a **copy** and hands it back on Save,
 * so Cancel costs nothing. The copy is a list of `Ide.LaunchConfig` records, so
 * this file checks nothing itself: it assigns to the record and lets the setters
 * refuse what they refuse -- which is how the field that is wrong gets named
 * without this form knowing what the rules are. `Validate` is what says
 * `PORT8080` is not `NAME=value`.
 *
 * **The two tick boxes do two things at once, and that is the design.** They are
 * the chosen configuration's own values *and*, when the dialog is saved, the
 * suggestion a new configuration will start with. One place to set both, because
 * they are the same question asked about now and about next time -- and because
 * a preferences dialog holding two booleans that only matter here would be a
 * window nobody opens. See `Ide.Launch`: copied at creation, never resolved at
 * read.
 */
"use strict";

class LaunchForm extends Form {

    /*
     * LaunchForm.edit(list, suggestion, onAccept)
     *
     * `list` is the project's configurations and is copied; `suggestion` is what
     * a new one starts with, shown in the tick boxes when nothing is selected.
     */
    static edit(list, suggestion, onAccept) {
        const dlg = new LaunchForm();

        /* Records, copied one at a time: the list is the project's and a dialog
         * that mutated it would have edited the file before Save.  `Clone()` is
         * the record's own round trip -- it was written here as a `Load` of a
         * `JSON.parse(JSON.stringify())`, which is the same trip with the class
         * named by hand, so a subclass would have been loaded as its base. */
        dlg.list       = list.map((one) => one.Clone());
        dlg.suggestion = { Strict: suggestion.Strict, StopOnThrow: suggestion.StopOnThrow };
        dlg.onAccept   = onAccept;
        dlg.at         = -1;

        dlg.showList(dlg.list.length ? 0 : -1);

        dlg.Show();
        dlg.LstLcNames.SetFocus();
        return dlg;
    }

    /* --- the list ---------------------------------------------------------- */

    /*
     * The names, and which one is being edited. `keep` is the index to land on,
     * which is what makes Add select the thing it just made and Remove land on
     * the neighbour rather than on nothing.
     */
    showList(keep) {
        this.filling = true;
        this.LstLcNames.Items = this.list.map((one) => one.Name);
        this.filling = false;

        const at = Math.max(-1, Math.min(keep, this.list.length - 1));

        this.at = at;
        this.LstLcNames.Index = at;
        this.showOne();
    }

    /* The fields of the one selected, or the suggestion when there is none. */
    showOne() {
        const one = this.list[this.at] || null;

        this.filling = true;
        this.TxtLcName.Text = one ? one.Name : "";
        this.TxtLcArgs.Text = one ? one.Arguments.join("\n") : "";
        this.TxtLcDir.Text  = one ? one.Directory : "";
        this.TxtLcEnv.Text  = one ? one.Environment.join("\n") : "";

        /* With nothing selected the boxes show the suggestion, which is the
         * other thing they are: what the next Add will copy in. */
        this.ChkLcStrict.Active = one ? one.Strict      : this.suggestion.Strict;
        this.ChkLcThrow.Active  = one ? one.StopOnThrow : this.suggestion.StopOnThrow;
        this.filling = false;

        for (const c of [this.TxtLcName, this.TxtLcArgs, this.TxtLcDir, this.TxtLcEnv])
            c.Enabled = one !== null;
        this.BtnLcRemove.Enabled = one !== null;
    }

    /*
     * What is on screen, back into the record.
     *
     * Through the setters, so a refused value says what was wrong with it here
     * rather than becoming a `project.json` that will not open. An empty line is
     * not an argument and not a variable: a text box people type into ends up
     * with them.
     */
    gather() {
        const one = this.list[this.at];
        if (!one) return true;

        const lines = (text) => text.split("\n").map((s) => s.trim()).filter((s) => s);

        try {
            one.Name        = this.TxtLcName.Text.trim();
            one.Arguments   = lines(this.TxtLcArgs.Text);
            one.Directory   = this.TxtLcDir.Text.trim();
            one.Environment = lines(this.TxtLcEnv.Text);
            one.Strict      = this.ChkLcStrict.Active;
            one.StopOnThrow = this.ChkLcThrow.Active;
        } catch (e) {
            Message.Error("That configuration was not changed:\n{0}", e.message);
            return false;
        }
        return true;
    }

    /* --- events ------------------------------------------------------------ */

    LstLcNames_Select() {
        if (this.filling) return;
        if (!this.gather()) return;

        this.at = this.LstLcNames.Index;
        this.showOne();
    }

    /*
     * A new one, with the two ticks as they stand copied into it -- which is the
     * suggestion when nothing was selected, and the selected one's values when
     * something was. Both readings are the same sentence: *start it like this*.
     */
    BtnLcAdd_Click() {
        if (!this.gather()) return;

        const one = new Ide.LaunchConfig();

        one.Name        = this.freshName();
        one.Strict      = this.ChkLcStrict.Active;
        one.StopOnThrow = this.ChkLcThrow.Active;

        this.list.push(one);
        this.showList(this.list.length - 1);
        this.TxtLcName.SetFocus();
    }

    /* `Run`, `Run 2`, `Run 3`: a name has to be there and has to be its own, and
     * asking for one before there is anything to name is a dialog in front of a
     * dialog. */
    freshName() {
        const taken = this.list.map((one) => one.Name);
        const base  = Locale.Text("Run");

        if (!taken.includes(base)) return base;
        for (let n = 2; ; n++)
            if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
    }

    BtnLcRemove_Click() {
        if (this.at < 0) return;

        this.list.splice(this.at, 1);
        this.showList(Math.min(this.at, this.list.length - 1));
    }

    /*
     * The name is the only field the list shows, so it is the only one written
     * back as it is typed.
     *
     * The whole list, because a `ListBox` has no way to change one row --
     * `SetText` is `TreeView`'s, which addresses its rows by key. Assigning
     * `Items` drops the selection, so it is put back: rebuilding a list of three
     * on every keystroke costs nothing, and a list long enough for it to matter
     * is not a list of run configurations.
     */
    TxtLcName_Change() {
        if (this.filling || this.at < 0) return;

        try {
            this.list[this.at].Name = this.TxtLcName.Text.trim();
        } catch (e) {
            return;                       /* too long, or empty: say so on Save */
        }

        this.filling = true;
        this.LstLcNames.Items = this.list.map((one) => one.Name);
        this.LstLcNames.Index = this.at;
        this.filling = false;
    }

    BtnLcOk_Click() {
        if (!this.gather()) return;

        /*
         * Everything wrong with every one of them, at once, which is what a
         * record's `Validate` is for -- stopping at the first would make fixing
         * three of them three trips.
         */
        const wrong = [];
        for (const one of this.list) {
            for (const problem of one.Validate())
                wrong.push(`${one.Name || Locale.Text("(unnamed)")}: ${problem}`);
        }

        /*
         * And the rule no single record can state, because a record cannot see
         * the list it is in: two of one name. Said once per name and not once
         * per occurrence -- a `Set` and not a scan of the messages already
         * collected, which was the same answer spelled as a string comparison
         * and would have stopped working in Spanish.
         */
        const names = this.list.map((one) => one.Name);
        const twice = new Set(names.filter(
            (name) => names.indexOf(name) !== names.lastIndexOf(name)));

        for (const name of twice)
            wrong.push(`${name}: ${Locale.Text("two configurations of that name")}`);

        if (wrong.length) {
            Message.Error("Nothing was saved:\n{0}", wrong.join("\n"));
            return;
        }

        this.onAccept(this.list, {
            Strict:      this.ChkLcStrict.Active,
            StopOnThrow: this.ChkLcThrow.Active,
        });
        this.done();
    }

    BtnLcCancel_Click() { this.done(); }
    Form_Close()        { this.done(); return false; }

    done() { this.Close(); }
}
