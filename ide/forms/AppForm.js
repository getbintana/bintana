/*
 * The install dialog: one entry in the user's menu for the open project.
 *
 * Three fields and a state line, and the three fields are the three keys an
 * entry needs a person to decide -- the rest is `Ide.Apps` and the runtime.
 * It opens on what is already installed when there is something, so the second
 * visit is an Update and not a second installation under a name nobody typed.
 *
 * **The dialog does not write the file.**  It hands the fields to `Ide.Apps`,
 * which is the one place that knows what an entry is, and reports whatever the
 * runtime refused -- the same bargain `ProjectForm` makes with the record: the
 * layer that owns the rules is the layer that checks them.
 */
"use strict";

class AppForm extends Form {

    /*
     * AppForm.edit(project, config, onChanged)
     *
     * `config` is the project's `ProjectFile`, which is where the name and the
     * description the entry starts on come from; `onChanged` runs after an
     * install or a removal, so the caller can say so somewhere.  Answers the
     * dialog, which `tests/ide` drives.
     */
    static edit(project, config, onChanged) {
        const dlg   = new AppForm();
        const found = Ide.Apps.installed(project);

        dlg.project   = project;
        dlg.appId     = config.Id || "";
        dlg.onChanged = onChanged;
        /* The id the entry really has, which is what Uninstall takes. It is not
         * recomputed from the name while the dialog is open: renaming is a
         * change to make, not one to already have made. */
        dlg.installed = found ? found.Id : null;
        dlg.Modal     = true;

        const entry = found ? found.Entry : null;
        dlg.TxtAppName.Text    = entry ? entry.Name : (config.Name || "");
        dlg.TxtAppComment.Text = entry ? (entry.Comment || "")
                                       : (config.Description || "");
        dlg.TxtAppIcon.Text    = entry ? (entry.Icon || "")
                                       : Ide.Apps.defaultIcon(project);

        dlg.showState();
        dlg.Show();
        dlg.TxtAppName.SetFocus();
        return dlg;
    }

    /*
     * What the buttons say, and where the entry is going.
     *
     * The id is the project's own when it declares one and a slug of the name
     * otherwise -- so this runs on every keystroke, and an empty name is not
     * installable: the runtime would refuse the entry it produces, and saying
     * so here is cheaper than a complaint after the click.
     */
    showState() {
        const id = this.appId || Ide.Apps.idFor(this.TxtAppName.Text);

        this.LblAppWhere.Text = this.installed
            ? Locale.Text("Installed for this user as {0}.desktop, in {1}",
                          this.installed, Desktop.Entries.Directory)
            : Locale.Text("Will be installed for this user as {0}.desktop, in {1}",
                          id, Desktop.Entries.Directory);

        this.BtnAppInstall.Text    = this.installed ? Locale.Text("Update")
                                                    : Locale.Text("Install");
        this.BtnAppUninstall.Visible = this.installed !== null;
        this.BtnAppInstall.Enabled   = this.TxtAppName.Text.trim() !== "";
    }

    fields() {
        return {
            Name:    this.TxtAppName.Text.trim(),
            AppId:   this.appId,
            Comment: this.TxtAppComment.Text.trim(),
            Icon:    this.TxtAppIcon.Text.trim(),
        };
    }

    /*
     * The chooser starts in the project's `icons/`, when it has one: that is
     * where a project's own drawings live, and what it draws is what a menu
     * should show.  The path comes back absolute, which is what the entry needs
     * -- see `Ide.Apps.defaultIcon`.
     */
    BtnAppIcon_Click() {
        const icons = File.Join(this.project, "icons");

        Dialog.OpenFile(Locale.Text("Choose an icon"),
            { Folder: File.IsDir(icons) ? icons : this.project,
              Filters: [[Locale.Text("Images"), "*.svg *.png *.jpg *.jpeg"],
                        [Locale.Text("All files"), "*"]] },
            (path) => { this.TxtAppIcon.Text = path; this.showState(); });
    }

    BtnAppInstall_Click() {
        if (!this.TxtAppName.Text.trim()) {
            Message.Error("An application needs a name to appear under.");
            return;
        }

        try {
            Ide.Apps.install(this.project, this.fields());
        } catch (e) {
            Message.Error("{0}", e.message);
            return;
        }
        this.done();
    }

    BtnAppUninstall_Click() {
        if (!this.installed) return;

        try {
            Ide.Apps.uninstall(this.installed);
        } catch (e) {
            Message.Error("{0}", e.message);
            return;
        }
        this.done();
    }

    TxtAppName_Change()    { this.showState(); }
    TxtAppIcon_Change()    { this.showState(); }

    /* Enter walks to the next field, and asks the tab order which one that is
     * rather than naming it -- the same rule `ProjectForm` follows. */
    TxtAppName_Activate()    { this.FocusNext(); }
    TxtAppComment_Activate() { this.FocusNext(); }
    TxtAppIcon_Activate()    { this.FocusNext(); }

    BtnAppCancel_Click() { this.dismiss(); }

    done() {
        const said = this.onChanged;
        this.dismiss();
        if (said) said();
    }

    dismiss() { this.Close(); }

}
