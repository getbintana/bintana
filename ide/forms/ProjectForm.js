/*
 * The project's own settings: what it is called, where it starts, and in which
 * order its code is loaded.
 *
 * All four are `project.json`, which the IDE already reads as a `ProjectFile`
 * record -- so this dialog does not check anything itself.  It assigns to the
 * record and lets the setters refuse what they refuse, which is how the field
 * that is wrong gets named without this file knowing what the rules are.  Add a
 * field to `ProjectFile` and it is validated here for free; the only thing this
 * form owns is where the boxes are.
 *
 * Like every other dialog here it works on a **copy** and hands it back on OK,
 * so Cancel costs nothing.
 */
"use strict";

/* Open dialogs, so the collector does not take one away mid-edit. */
const openProjectForms = [];

class ProjectForm extends Form {

    /*
     * ProjectForm.edit(record, classNames, filesInOrder, onAccept)
     *
     * `classNames` is what the startup may be -- the project's own classes, so
     * the field is a choice and not a name to remember.  `filesInOrder` is the
     * order the runtime would load a project that declares none, which is what
     * *Decide* writes: freezing the order it already has changes nothing today
     * and makes it changeable tomorrow.
     */
    static edit(record, classNames, filesInOrder, onAccept) {
        const dlg = new ProjectForm();

        dlg.record    = record.Clone();
        dlg.scanned   = filesInOrder || [];
        dlg.onAccept  = onAccept;
        dlg.Modal     = true;

        /* The startup has to be offered even when it names a class that is gone:
         * a project whose startup no longer exists is exactly the one being
         * opened to fix it, and a drop-down that silently dropped the broken
         * value would hide what is wrong. */
        dlg.classNames = classNames.slice();
        if (record.Startup && !dlg.classNames.includes(record.Startup))
            dlg.classNames.unshift(record.Startup);

        dlg.TxtPrName.Text    = record.Name;
        dlg.TxtPrVersion.Text = record.Version;
        dlg.TxtPrDesc.Text    = record.Description;

        /*
         * *What* it starts at, before *which one*.
         *
         * A project declares `startup` or it declares `main`, never both -- the
         * runtime would call `main` and never open the form, which looks exactly
         * like a form that will not show. Two independent fields would let that
         * be written from here; one kind and one name cannot.
         */
        dlg.CmbPrStartup.Items = dlg.classNames;
        dlg.CmbPrKind.Text = record.Main ? Ide.Kind.Function : Ide.Kind.Form;
        dlg.showKind(record.Main || record.Startup);

        dlg.showSources();

        openProjectForms.push(dlg);
        dlg.Show();
        dlg.TxtPrName.SetFocus();
        return dlg;
    }

    /*
     * The name to start at, and what the drop-down may offer for it.
     *
     * A form is one of the project's classes, so the list is those; a `main` is
     * a plain function and the IDE never loads the project's code, so there is
     * nothing to offer and the field is what the person types. Editable either
     * way, which is what lets a broken name be seen and fixed.
     */
    showKind(name) {
        const isFunction = this.CmbPrKind.Text === Ide.Kind.Function;

        /* One control per kind, in the same place, one shown at a time: a
         * `ComboBox` is a list and refuses a name that is not in it, which is
         * right for a class of this project and impossible for a function the
         * IDE has never seen. */
        this.CmbPrStartup.Visible = !isFunction;
        this.TxtPrMain.Visible    = isFunction;

        if (isFunction)
            this.TxtPrMain.Text = name || "";
        else if (this.classNames.includes(name))
            this.CmbPrStartup.Text = name;
    }

    /* The name carries across the switch: someone who picked the wrong kind
     * first should not have to type it again. */
    CmbPrKind_Change() { this.showKind(this.startsAt()); }

    startsAt() {
        return (this.TxtPrMain.Visible ? this.TxtPrMain.Text
                                       : this.CmbPrStartup.Text).trim();
    }

    /*
     * The list, and what can be done to it.
     *
     * A project that declares no `sources` is loaded by directory, and writing a
     * list where there was none would freeze an order nobody asked for -- so the
     * list is shown greyed, with the order it would load in, and *Decide* is the
     * one button that turns it into a decision.
     */
    showSources() {
        const decides = this.record.Lists;
        const shown   = decides ? this.record.Sources : this.scanned;
        const index   = this.LstPrSources.Index;

        this.LstPrSources.Items   = shown;
        this.LstPrSources.Enabled = decides;
        this.BtnPrUp.Enabled      = decides;
        this.BtnPrDown.Enabled    = decides;
        this.BtnPrDecide.Enabled  = !decides && shown.length > 0;

        if (decides && index >= 0 && index < shown.length)
            this.LstPrSources.Index = index;

        this.LblPrHint.Text = decides
            ? "The order the project's code is loaded in. It only matters when one " +
              "class extends another of the same project: the parent has to come first."
            : "This project loads every .js under it, sorted by path -- which is why " +
              "the order cannot be changed. Decide writes that same order down, and " +
              "from then on it is yours to arrange.";
    }

    /* Moves the selected entry one place. Reordering *is* the edit here: which
     * files are listed follows from which files exist. */
    move(delta) {
        const at = this.LstPrSources.Index;
        const to = at + delta;
        const list = this.record.Sources.slice();

        if (at < 0 || to < 0 || to >= list.length) return;

        const moved = list[at];
        list[at] = list[to];
        list[to] = moved;

        /* Through the setter, which is what checks it. */
        this.record.Sources = list;
        this.showSources();
        this.LstPrSources.Index = to;
    }

    /*
     * Applies the fields to the record and answers whether they were taken.  The
     * record's setters are the validation: what this reports is whichever one
     * refused, by the name the record gave it.
     */
    apply() {
        /* One of the two carries the name and the other is emptied, so the
         * manifest this writes can never declare both. */
        const console = this.CmbPrKind.Text === Ide.Kind.Function;
        const starts  = this.startsAt();

        const fields = [
            ["Name",        this.TxtPrName.Text.trim()],
            ["Version",     this.TxtPrVersion.Text.trim()],
            ["Startup",     console ? "" : starts],
            ["Main",        console ? starts : ""],
            ["Description", this.TxtPrDesc.Text.trim()],
        ];

        for (const [name, value] of fields) {
            try {
                this.record[name] = value;
            } catch (e) {
                Message.Error("project.json was left alone:\n{0}", e.message);
                return false;
            }
        }
        return true;
    }

    accept() {
        if (!this.apply()) return;

        const edited = this.record;
        this.dismiss();
        if (this.onAccept) this.onAccept(edited);
    }

    dismiss() {
        const i = openProjectForms.indexOf(this);
        if (i >= 0) openProjectForms.splice(i, 1);
        this.Close();
    }

    /* --- events ------------------------------------------------------------ */

    BtnPrUp_Click()   { this.move(-1); }
    BtnPrDown_Click() { this.move(1); }

    /* The order it already loads in, written down: nothing changes today, and
     * tomorrow it can be arranged. */
    BtnPrDecide_Click() {
        this.record.Sources = this.scanned.slice();
        this.showSources();
    }

    /* Enter walks to the next field, and asks the tab order which one that is
     * rather than naming it: naming the next control writes the order down a
     * second time, in the copy nobody updates when the form is redrawn. */
    TxtPrName_Activate()    { this.FocusNext(); }
    TxtPrVersion_Activate() { this.FocusNext(); }
    TxtPrDesc_Activate() { this.accept(); }

    BtnPrOk_Click()     { this.accept(); }
    BtnPrCancel_Click() { this.dismiss(); }

}
