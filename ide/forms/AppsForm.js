/*
 * The applications this user has, as the IDE installed them, with the one road
 * back out.
 *
 * A user application is a `.desktop` file (a `.lnk` on Windows) in the user's
 * own menu, written by *Install as user application…*; the runtime reads,
 * writes and removes them (`Desktop.Entries`, `Desktop.Shortcut`), and `Apps`
 * is the one place that knows which of them are the IDE's. What was missing was
 * the list: an entry whose project was moved, renamed or deleted stayed in the
 * menu with nothing in the IDE that named it, and the only door out was the
 * project it came from.
 *
 * **It lists what the IDE installed, not everything in the menu.** `Apps.List`
 * keeps the entries that carry the project path, which is what makes an entry
 * ours to remove; a packaged application's is the packager's. Say so in the
 * hint, because a person looking for a menu entry that is not here will
 * otherwise think the list is broken.
 *
 * **Uninstalling asks first**, and asks about the entry by name: a menu entry is
 * not a file a person can see in a folder, so the confirmation is the only place
 * the consequence can be read. The project is not touched -- the entry is a
 * shortcut to it -- and the sentence says so rather than leaving it to be
 * discovered.
 */
"use strict";

export class AppsForm extends Form {

    /*
     * AppsForm.open(onChanged)
     *
     * `onChanged` runs after an entry is removed, so the window can refresh
     * whatever said "installed" about the open project. Answers the dialog,
     * which `tests/ide` drives.
     */
    static open(onChanged) {
        const dlg = new AppsForm();

        dlg.onChanged = onChanged || null;
        dlg.Modal     = true;
        dlg.fill();
        dlg.Show();

        if (dlg.entries.length > 0) dlg.LstApps.SetFocus();
        else                        dlg.BtnAppsClose.SetFocus();
        return dlg;
    }

    /* What is installed, as it is now: the list is filled from the directory
     * every time, because the menu is somebody else's to change too. */
    fill() {
        this.entries = Apps.List();

        this.LstApps.Items      = this.entries.map((e) => e.Name);
        this.LstApps.Visible    = this.entries.length > 0;
        this.LblAppsNone.Visible = this.entries.length === 0;
        this.BtnAppsRemove.Enabled = this.entries.length > 0;

        if (this.entries.length > 0) {
            this.LstApps.Index = 0;
            this.showWhere();
        } else {
            this.LblAppsWhere.Text = "";
        }
    }

    /* Where the selected one points, and what it installed: the project path is
     * what tells two entries of the same name apart, and the files are what a
     * person deletes by hand if they would rather do that. */
    showWhere() {
        const at = this.LstApps.Index;
        const entry = at >= 0 && at < this.entries.length ? this.entries[at] : null;

        this.LblAppsWhere.Text = entry
            ? Locale.Text("Project: {0}", entry.Project) : "";
        this.BtnAppsRemove.Enabled = entry !== null;

        const files = entry ? Apps.Files(entry.Id) : [];
        this.LblAppsFiles.Text = files.length
            ? `${Locale.Text("Installed files:")}\n${files.join("\n")}` : "";
    }

    LstApps_Select() { this.showWhere(); }

    BtnAppsRemove_Click() {
        const at = this.LstApps.Index;
        const entry = at >= 0 && at < this.entries.length ? this.entries[at] : null;
        if (!entry) return;

        this.confirm = ConfirmForm.ask(
            Locale.Text("Uninstall application"),
            Locale.Text("Remove {0} from the menu? The project and its files are not touched.",
                        entry.Name),
            Locale.Text("Uninstall"),
            () => {
                try {
                    Apps.Uninstall(entry.Id);
                } catch (e) {
                    /* The menu is unchanged and the person is told why, the
                     * same bargain the install dialog makes. */
                    this.LblAppsWhere.Text = e.message;
                    return;
                }

                this.fill();
                if (this.onChanged) this.onChanged();
            });
    }

    BtnAppsClose_Click() { this.Close(); }
}
