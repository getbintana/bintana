/*
 * The new project's details: name, application id, description and where to
 * create it.
 *
 * The base folder is a text field with an icon that opens the folder chooser.
 * One can pick it with the dialog or type the path by hand, and either way it
 * stays visible before accepting -- which the folder chooser used on its own
 * did not give.
 *
 * **The application id is asked from the beginning, and it is required**: the
 * runtime does not start a project without one, since its settings and data
 * are kept under it and the window's class, the metainfo and the Flatpak app
 * all carry it. The field proposes one from the name (`suggestId`), so asking
 * costs nothing to a person who has never written a reverse-DNS name.
 */
"use strict";

/* A project name is a folder name: it cannot carry separators, nor be a "."
 * that points somewhere else. */
const BAD_NAME = /[/\\]|^\.\.?$/;

/* The id's beginning the last project was made with: everything before its
 * last element, which is the person's or the organisation's and the same for
 * every project they make. */
const ID_PREFIX_KEY = "newProject.idPrefix";

export class NewProjectForm extends Form {

    /*
     * An application id for a project of this name: the prefix the last
     * project was made with -- `io.github.<login>` the first time -- and the
     * name as an id element.
     *
     * **Proposed, because it is required now and most people do not have one
     * in mind.** A reverse-DNS name is a convention to learn, and a field that
     * starts empty is a field that stops the dialog; one that starts with a
     * good answer is changed by the person who knows better and accepted by
     * everybody else. `MainForm.createProject` asks this too, so nothing the
     * IDE creates is without one.
     */
    static suggestId(name) {
        let prefix = Settings.Get(ID_PREFIX_KEY, "");
        if (typeof prefix !== "string" || !ProjectFile.idValid(`${prefix}.App`)) {
            const login = String(Environment.Get("USER") || Environment.Get("USERNAME") || "")
                .toLowerCase().replace(/[^a-z0-9_-]/g, "");
            prefix = `io.github.${/^[a-z_-]/.test(login) ? login : "you"}`;
        }
        /* The name as one element: its words joined and capitalised, only the
         * characters an id takes, and never starting with a digit. */
        let last = String(name || "").split(/[^A-Za-z0-9_-]+/).filter((w) => w)
            .map((w) => w[0].toUpperCase() + w.slice(1)).join("");
        if (!last) last = "App";
        if (/^[0-9]/.test(last)) last = `App${last}`;
        return `${prefix}.${last}`;
    }

    static ask(baseDir, onAccept) {
        const dlg = new NewProjectForm();

        /* Home and not `Application.Directory`: that is the IDE's own folder --
         * the installed app's when it came from a package -- and a first
         * project written there is one the user cannot create, or cannot find
         * afterwards. `MainForm` passes the remembered folder when it has one. */
        dlg.TxtBase.Text = baseDir || Environment.HomeDirectory;
        dlg.CmbKind.Index = Kind.Form;      /* what most projects are */
        dlg.onAccept     = onAccept;
        dlg.Modal        = true;

        dlg.Show();
        dlg.TxtName.SetFocus();
        dlg.updateHint();
        return dlg;
    }

    /* Showing the path that will be created avoids the surprise of finding it out
     * afterwards.
     *
     * **One line, and `Ellipsize` in the form.** The text carries a full path,
     * so the label's natural width grows with what the person types; a label
     * that asks for it makes this non-resizable dialog widen, and a window that
     * changes size under the pointer is a window that moves -- measured with a
     * name typed a letter at a time, the dialog walked down the screen. The
     * tooltip keeps the whole sentence reachable. */
    updateHint() {
        const name = this.TxtName.Text.trim();
        const base = this.TxtBase.Text.trim();

        /* What will be there afterwards, and not only where: the two kinds of
         * project are two different sets of files, and finding that out by
         * looking at the tree afterwards is late. */
        const first = this.CmbKind.Index === Kind.Function ? "Main.js"
                                                          : "forms/Form1.form";

        this.LblHint.Text = name && base
            ? Locale.Text("Will create {0}, starting at {1}",
                          File.Join(base, name), first)
            : "";
        this.LblHint.Tooltip = this.LblHint.Text;
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
        /* **Required**: the runtime does not start a project without one. An
         * id that is not one is a window class nothing matches, so it is
         * cheaper to say so here than to meet it as a refusal at the first
         * run. */
        if (!id) {
            Message.Error("Every application needs an id: its settings and data are kept under it. Use a reverse-DNS name like io.github.you.App.");
            return;
        }
        if (!ProjectFile.idValid(id)) {
            Message.Error("\"{0}\" is not an application id. Use a reverse-DNS name like io.github.you.App.", id);
            return;
        }
        /* The beginning is the person's and the next project starts from it. */
        Settings.Set(ID_PREFIX_KEY, id.slice(0, id.lastIndexOf(".")));
        if (!File.IsDir(base)) {
            Message.Error("The base folder does not exist:\n{0}", base);
            return;
        }

        const info = { name, base, id, description: this.TxtDesc.Text.trim(),
                       console: this.CmbKind.Index === Kind.Function };
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

    /* The id follows the name until the person types one of their own. A
     * field's `Change` is GTK's and comes for an assignment too, so the
     * proposal is written under a flag that tells it from typing. */
    TxtName_Change() {
        if (!this.idTyped) {
            this.proposing = true;
            this.TxtId.Text = this.TxtName.Text.trim()
                ? NewProjectForm.suggestId(this.TxtName.Text.trim()) : "";
            this.proposing = false;
        }
        this.updateHint();
    }
    TxtId_Change() { if (!this.proposing) this.idTyped = true; }
    TxtBase_Change() { this.updateHint(); }

    /*
     * **`Select` and not `Change`**, which is what this said and why the hint
     * never followed the kind: a `ComboBox` raises `Select` when the chosen row
     * moves, and a handler named for an event its control does not raise is
     * loaded, never called, and says nothing about it.
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
