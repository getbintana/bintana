/*
 * The new project's details: name, application id, description and where to
 * create it.
 *
 * The base folder is a text field with an icon that opens the folder chooser.
 * One can pick it with the dialog or type the path by hand, and either way it
 * stays visible before accepting -- which the folder chooser used on its own
 * did not give.
 *
 * **The application id is asked from the beginning** and is optional: a
 * project without one runs like any other, and it is the packaging chain that
 * needs it -- the window's class, the metainfo and the Flatpak app all carry
 * it. Asking here is what keeps it from being a thing to remember later, when
 * the name is already in a dozen files.
 */
"use strict";

/* A project name is a folder name: it cannot carry separators, nor be a "."
 * that points somewhere else. */
const BAD_NAME = /[/\\]|^\.\.?$/;

class NewProjectForm extends Form {

    static ask(baseDir, onAccept) {
        const dlg = new NewProjectForm();

        dlg.TxtBase.Text = baseDir || Application.Directory;
        dlg.CmbKind.Text = Ide.Kind.Form;      /* what most projects are */
        dlg.onAccept     = onAccept;
        dlg.Modal        = true;

        dlg.Show();
        dlg.TxtName.SetFocus();
        dlg.updateHint();
        return dlg;
    }

    /* Showing the path that will be created avoids the surprise of finding it out
     * afterwards. */
    updateHint() {
        /*
         * **Reachable before the form is finished.** The `.form` fills `CmbKind`,
         * filling a list moves its selection, and `CmbKind_Select` arrives with
         * every control declared after that combo still unset. Guarded on what
         * this reads rather than on one field, so re-ordering the `.form` cannot
         * make it wrong again.
         */
        if (!this.TxtName || !this.TxtBase || !this.CmbKind ||
            !this.LblHint || !this.BtnCreate) return;

        const name = this.TxtName.Text.trim();
        const base = this.TxtBase.Text.trim();

        /* What will be there afterwards, and not only where: the two kinds of
         * project are two different sets of files, and finding that out by
         * looking at the tree afterwards is late. */
        const first = this.CmbKind.Text === Ide.Kind.Function ? "Main.js"
                                                          : "forms/Form1.form";

        this.LblHint.Text = name && base
            ? `Will create ${File.Join(base, name)}, starting at ${first}`
            : "";
        this.BtnCreate.Enabled = name !== "" && base !== "";
    }

    accept() {
        const name = this.TxtName.Text.trim();
        const base = this.TxtBase.Text.trim();
        const id   = this.TxtId.Text.trim();

        if (!name || !base) return;
        if (BAD_NAME.test(name)) {
            Message.Error("\"{0}\" is not usable as a folder name.", name);
            return;
        }
        /* Optional, and checked when it is there: an id that is not one is a
         * window class nothing matches, so it is cheaper to say so here than
         * to meet it as a generic icon in a dock. */
        if (id && !Ide.ProjectFile.idValid(id)) {
            Message.Error("\"{0}\" is not an application id. Use a reverse-DNS name like io.github.you.App.", id);
            return;
        }
        if (!File.IsDir(base)) {
            Message.Error("The base folder does not exist:\n{0}", base);
            return;
        }

        const info = { name, base, id, description: this.TxtDesc.Text.trim(),
                       console: this.CmbKind.Text === Ide.Kind.Function };
        this.dismiss();
        if (this.onAccept) this.onAccept(info);
    }

    dismiss() { this.Close(); }

    /* --- eventos ---------------------------------------------------------- */

    TxtBase_IconClick() {
        /* The title is prose built at the moment, so it needs the helper: the
         * runtime does not look a dialog title up. Written in Spanish and bare,
         * it read as Spanish in the English IDE and no catalogue could reach
         * it -- the failure mode this project's whole text story is about. */
        Dialog.SelectFolder(Locale.Text("Base folder"), (dir) => {
            this.TxtBase.Text = dir;
            this.updateHint();
        });
    }

    TxtName_Change() { this.updateHint(); }
    TxtBase_Change() { this.updateHint(); }

    /*
     * **`Select` and not `Change`**, which is what this said and why the hint
     * never followed the kind: a `ComboBox` raises `Select` when the chosen row
     * moves, and a handler named for an event its control does not raise is
     * loaded, never called, and says nothing about it.
     *
     * **And it guards, because waking it up is what showed why.** The `.form`
     * gives this combo its `Items`, and filling a list moves its selection --
     * so this arrives *while the form is still being built*, with every field
     * declared after it still unset. The same trap `SideTabs_Switch` names in
     * `MainForm`, and the same answer: a handler that can be reached that way
     * guards, and says so.
     */
    CmbKind_Select() { this.updateHint(); }

    /* The tab order decides which field is next, not this line. See
     * ProjectForm for why that matters. */
    TxtName_Activate() { this.FocusNext(); }
    TxtId_Activate()   { this.FocusNext(); }
    TxtDesc_Activate() { this.accept(); }
    TxtBase_Activate() { this.accept(); }

    BtnCreate_Click() { this.accept(); }
    BtnCancel_Click() { this.dismiss(); }

}
