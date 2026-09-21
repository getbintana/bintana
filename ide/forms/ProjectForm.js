/*
 * The project's own settings: what it is called, where it starts, which
 * libraries it uses, and in which order its code is loaded.
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

class ProjectForm extends Form {

    /*
     * ProjectForm.edit(record, classNames, filesInOrder, libraries, onAccept)
     *
     * `classNames` is what the startup may be -- the project's own classes, so
     * the field is a choice and not a name to remember.  `filesInOrder` is the
     * order the runtime would load a project that declares none, which is what
     * *Decide* writes: freezing the order it already has changes nothing today
     * and makes it changeable tomorrow.  `libraries` is every name this project
     * could use, which is `Application.Libraries` and nothing this file worked
     * out -- the same bargain as the other two: the dialog is handed what there
     * is and owns only where the boxes go.
     */
    static edit(record, classNames, filesInOrder, libraries, onAccept) {
        const dlg = new ProjectForm();

        dlg.record    = record.Clone();
        dlg.scanned   = filesInOrder || [];
        dlg.available = libraries || [];
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

        dlg.showUses();
        dlg.showSources();

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

    /*
     * The name carries across the switch: someone who picked the wrong kind
     * first should not have to type it again.
     *
     * **`Select` and not `Change`**, which is what this said -- so `showKind`
     * ran once, when the dialog opened, and never again. Changing the kind did
     * nothing at all: the dialog went on showing the startup-class combo for a
     * project that was now a console one, with nowhere to type the function's
     * name. A `ComboBox` raises `Select`; a handler named for an event its
     * control does not raise is loaded, never called, and says nothing.
     */
    CmbPrKind_Select() {
        /* Guarded for the reason `NewProjectForm`'s twin is: the `.form` fills
         * this combo, filling a list moves its selection, and the event arrives
         * while the form is still being built. */
        if (this.TxtPrMain && this.CmbPrStartup) this.showKind(this.startsAt());
    }

    startsAt() {
        return (this.TxtPrMain.Visible ? this.TxtPrMain.Text
                                       : this.CmbPrStartup.Text).trim();
    }

    /*
     * The libraries this project uses, as ticks.
     *
     * What is offered is what the runtime can find (`Application.Libraries`)
     * *together with* whatever the project already declares, and the two are not
     * the same set: a project may name a library that is not installed here, and
     * that project is exactly the one somebody is opening to find out why it
     * will not run. A name that is gone is shown, ticked, and says it is
     * missing -- the same argument the startup drop-down makes for a class that
     * no longer exists, and the same one a list that silently dropped it would
     * lose.
     *
     * **In use first, in the order they load**: a library's classes are
     * evaluated before the project's own, and two libraries in the order `uses`
     * names them -- so that order is a decision and not a display.
     *
     * **And the ticks live in the record.** That is the rule `docs/llm/controls.md`
     * states for a list of check boxes, and the reason this is a `RowList`
     * carrying `CheckButton`s rather than a list that keeps its own ticks: a
     * tick the *view* keeps is the wrong row's the moment anything is rebuilt.
     * Nothing here rebuilds, and it still is not where the answer is kept.
     */
    showUses() {
        const used  = this.record.Uses;
        const found = this.available.map((lib) => lib.Name);
        const names = [...used, ...found.filter((name) => !used.includes(name))];

        this.LstPrUses.Clear();
        /* The widgets, kept the way the class chooser keeps its own: a handle on
         * the rows for whoever is driving this dialog rather than clicking it.
         * Not a second copy of the answer -- what is ticked is the record's. */
        this.useBoxes = [];

        names.forEach((name) => {
            const lib = this.available.find((one) => one.Name === name);
            const box = new CheckButton();

            box.Active = used.includes(name);
            box.Margin = 4;

            if (lib) {
                box.Text    = name;
                box.Tooltip = lib.Path;
            } else {
                /* One literal with a placeholder in it, and not a name added to
                 * a phrase: the msgid has to be the whole sentence or a
                 * catalogue cannot reorder it. */
                box.Text    = Locale.Text("{0} -- not found", name);
                box.Style   = "dim-label";
                box.Tooltip = Locale.Text("This project names it and nothing on this machine has it. The runtime refuses to start a project whose library is missing.");
            }

            this.LstPrUses.Add(box);
            this.useBoxes.push(box);
            /* The handler belongs to the box, so rebuilding the list takes
             * it with them -- and no name is invented to dispatch by. */
            box.On("Click", () => this.use(name, box.Active));
        });

        /* One literal each, however long: the extractor reads the source, and a
         * message built by adding two of them together is a msgid that arrives
         * at the catalogue with half of itself missing. It says so out loud when
         * Project > Update translations runs, which is how these two were
         * caught. */
        this.LblPrUsesHint.Text = names.length
            ? Locale.Text("Directories of shared classes, loaded before this project's own. Offered here are the ones this machine has, nearest first: the project's own lib/ before anything installed.")
            : Locale.Text("A library is a directory of shared classes that several projects can load. There is none on this machine, and none named here.");
    }

    /*
     * One tick, into the record.
     *
     * Appended when it goes on, so a library added today loads after the ones
     * that were already there -- which is the answer that cannot break a project
     * whose second library extends its first. Removing leaves the rest in the
     * order they were.
     */
    use(name, on) {
        const list = this.record.Uses.filter((one) => one !== name);
        if (on) list.push(name);

        /* Through the setter, which is what checks it. */
        this.record.Uses = list;
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

    dismiss() { this.Close(); }

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
