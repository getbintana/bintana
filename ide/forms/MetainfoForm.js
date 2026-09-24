/*
 * The application's info, edited by field.
 *
 * The pair to the raw XML tab, and the two are deliberately different roads:
 * this one edits the common fields for somebody who does not know AppStream,
 * and the tab is where translations (`xml:lang`), screenshots, releases and
 * anything else live. Neither loses what the other wrote -- the DOM keeps what
 * it is not asked about, and this form only touches the primary elements.
 *
 * **The id and the name are shown and not edited.** They are `project.json`'s
 * -- the window's class, the package's name and what a software centre shows
 * are one identity -- and `Metainfo.write` takes them from the record on
 * every save, so the two files cannot drift while this is the writer. Editing
 * them is Project settings, which renames this file to follow.
 *
 * It works on the parsed document and hands it to `Metainfo` to write, the
 * same bargain `PoForm` makes with `Locale`.
 */
"use strict";

class MetainfoForm extends Form {

    /*
     * The road the menu takes: the project's metainfo, made when there is none
     * -- which needs an id, because the file is named after it.
     */
    static open(ide) {
        if (!ide.project) return null;

        const config = ide.manifest.read();
        if (!config || !config.Id) {
            Message.Info("This project declares no application id, so it has no application info yet. Set one in Project settings, and this dialog writes the file.");
            return null;
        }

        let path = Metainfo.find(ide.project);
        if (!path)
            path = Metainfo.create(ide.project, config);

        return MetainfoForm.edit(ide, path);
    }

    static edit(ide, path) {
        const dlg = new MetainfoForm();

        dlg.ide    = ide;
        dlg.path   = path;
        dlg.config = ide.manifest.read();

        try {
            dlg.doc = Metainfo.load(path);
        } catch (e) {
            Message.Error("Cannot read {0}:\n{1}", File.Name(path), e.message);
            return null;
        }

        dlg.fill(Metainfo.read(dlg.doc));
        dlg.Modal = true;
        dlg.Show();
        dlg.TxtSummary.SetFocus();
        return dlg;
    }

    fill(f) {
        this.TxtId.Text       = f.Id;
        this.TxtName.Text     = f.Name;
        this.TxtSummary.Text  = f.Summary;
        this.TxtDesc.Text     = f.Description;
        this.TxtDevId.Text    = f.DeveloperId;
        this.TxtDevName.Text  = f.DeveloperName;
        this.TxtMetaLic.Text  = f.MetadataLicense;
        this.TxtProjLic.Text  = f.ProjectLicense;
        this.TxtHome.Text     = f.Homepage;
        this.TxtBug.Text      = f.Bugtracker;
        this.TxtCats.Text     = f.Categories;

        this.LblWhere.Text    = Locale.Text("In {0}, as AppStream metadata: what a software centre and an installer read.", File.Name(this.path));
        this.LblProblem.Text  = "";
    }

    fields() {
        return {
            Summary:         this.TxtSummary.Text.trim(),
            Description:     this.TxtDesc.Text.trim(),
            DeveloperId:     this.TxtDevId.Text.trim(),
            DeveloperName:   this.TxtDevName.Text.trim(),
            MetadataLicense: this.TxtMetaLic.Text.trim(),
            ProjectLicense:  this.TxtProjLic.Text.trim(),
            Homepage:        this.TxtHome.Text.trim(),
            Bugtracker:      this.TxtBug.Text.trim(),
            Categories:      this.TxtCats.Text.trim(),
        };
    }

    /*
     * Refuses in the dialog and not in a modal: a summary is required, and the
     * sentence belongs next to the fields it is about -- which also makes the
     * refusal something a test can drive.
     */
    save() {
        const fields = this.fields();

        if (!fields.Summary) {
            this.LblProblem.Text = Locale.Text("A summary is required: it is the line a software centre shows under the name.");
            return;
        }

        Metainfo.write(this.doc, fields, this.config);

        /* The file's name follows the id -- a metainfo called something else
         * is one nothing looks for. */
        const wanted = File.Join(File.Directory(this.path),
                                 Metainfo.fileName(this.config.Id));

        const problems = Metainfo.problems(this.doc, wanted, this.config);
        if (problems.length) {
            this.LblProblem.Text = problems.join("\n");
            return;
        }

        Metainfo.save(wanted, this.doc);
        if (wanted !== this.path)
            File.Delete(this.path);
        this.path = wanted;

        /* The tree lists what is on disk, and the file may be new -- made by
         * `open` a moment ago -- or renamed by the id. */
        this.ide.listFiles();

        this.Close();
    }

    dismiss() { this.Close(); }

    /* --- events ------------------------------------------------------------ */

    BtnSave_Click()   { this.save(); }
    BtnCancel_Click() { this.dismiss(); }

}
