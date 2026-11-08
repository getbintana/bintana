/*
 * A `.conn` file, edited: where one of the project's databases is.
 *
 * A connection is `{ "kind": "sqlite", "path": "data/sales.db" }` at the top of
 * the project, and a form reaches its tables by its name -- `Form.Source =
 * "sales.clients"` is the table `clients` of what `sales.conn` points at
 * (`rowsFrom` in the runtime's `forms.js`). It was a JSON file written by hand:
 * the tree gave it a category, an icon and the Data view, and nothing edited it.
 *
 * **The dialog says what the path leads to**, asked of the runtime the way the
 * Data view asks it: how many tables, *not created yet*, or why SQLite would
 * not open it. A file that does not exist is **not** created by looking -- the
 * program creates its database the first time it opens it, and a dialog that
 * wrote one would be writing the program's data for it.
 *
 * Like every dialog here it works on a copy and hands it back on OK: keys this
 * dialog does not show are kept, so a `.conn` that says more than it knows is
 * not rewritten smaller.
 */
"use strict";

/* `CmbConnKind`'s entries, in its order: the `kind` each one writes. One today;
 * a second driver is a second row here and in the `.form`. */
const CONN_KINDS = ["sqlite"];

/* A connection's name is the part of a `Source` before its first dot, so a dot
 * in it could never be reached -- and it is a file name at the project's root. */
const CONN_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export class ConnectionForm extends Form {

    /*
     * ConnectionForm.edit(project, file, doc, onAccept)
     *
     * `file` is the `.conn` being edited, relative to the project, or `""` for
     * a new one -- which is when the name is asked. `onAccept(file, doc)` is
     * handed the file to write and the whole document. Refuses a kind it does
     * not know before showing anything, as `RecordForm` refuses a document that
     * is not a record: a file this dialog does not understand is never
     * rewritten blind.
     */
    static edit(project, file, doc, onAccept) {
        const kind = doc && doc.kind !== undefined ? doc.kind : "sqlite";
        if (!CONN_KINDS.includes(kind))
            throw new TypeError(`a connection of kind '${kind}' is not one this IDE can edit`);

        const dlg = new ConnectionForm();

        dlg.project  = project;
        dlg.file     = file || "";
        dlg.doc      = doc ? JSON.parse(JSON.stringify(doc)) : {};
        dlg.onAccept = onAccept;
        dlg.Modal    = true;

        /* The name is the file's, and renaming a file is the tree's verb: the
         * forms that name it by its old name are what a rename has to find. */
        dlg.TxtConnName.Text     = file ? File.BaseName(file) : "";
        dlg.TxtConnName.Enabled  = !file;
        dlg.CmbConnKind.Index    = CONN_KINDS.indexOf(kind);
        dlg.TxtConnPath.Text     = typeof dlg.doc.path === "string" ? dlg.doc.path : "";

        dlg.showState();
        dlg.Show();
        (file ? dlg.TxtConnPath : dlg.TxtConnName).SetFocus();
        return dlg;
    }

    /*
     * What the path leads to, under the fields, and whether OK can be pressed.
     *
     * Answered every time either field changes: it is the one thing a person
     * typing a path cannot see for themselves.
     */
    showState() {
        const problem = this.refusal();
        this.BtnConnOk.Enabled = problem === "";
        if (problem) {
            this.say(problem, false);
            return;
        }

        const path = this.TxtConnPath.Text.trim();
        const abs  = File.Join(this.project, path);
        const away = File.Within(abs, this.project) ? ""
            : Locale.Text("Outside the project, so it will not travel with it.") + " ";

        if (!File.Exists(abs)) {
            this.say(away + Locale.Text("Not created yet: the program creates it the first time it opens it."), false);
            return;
        }
        if (File.IsDir(abs)) {
            this.say(Locale.Text("That is a folder, not a database file."), true);
            return;
        }

        /* Opened only once it is known to exist: `Database.Sqlite` creates
         * what it does not find. */
        let db = null;
        try {
            db = Database.Sqlite(abs);
            const tables = db.Tables.length;
            this.say(away + Locale.Plural("A database with {0} table.",
                                          "A database with {0} tables.", tables), false);
        } catch (e) {
            this.say(Locale.Text("SQLite cannot open it: {0}", e.message), true);
        } finally {
            if (db) db.Close();
        }
    }

    say(text, isError) {
        this.LblConnState.Text  = text;
        this.LblConnState.Style = isError ? "error" : "dim-label";
    }

    /* Why OK cannot be pressed, or `""`. The sentence goes under the fields, so
     * the reason is on screen before anybody presses anything. */
    refusal() {
        if (!this.file) {
            const name = this.TxtConnName.Text.trim();
            if (!name)
                return Locale.Text("A connection needs a name: the forms reach its tables by it.");
            if (!CONN_NAME.test(name))
                return Locale.Text("\"{0}\" cannot be a connection's name: letters, digits, _ and -, and no dot, since a source is <name>.<table>.", name);
            if (File.Exists(File.Join(this.project, `${name}.conn`)))
                return Locale.Text("{0}.conn already exists.", name);
        }
        if (!this.TxtConnPath.Text.trim())
            return Locale.Text("Where the database file is, relative to the project.");
        return "";
    }

    accept() {
        if (this.refusal()) return;

        const file = this.file || `${this.TxtConnName.Text.trim()}.conn`;
        const doc  = this.doc;

        doc.kind = CONN_KINDS[this.CmbConnKind.Index] || "sqlite";
        doc.path = this.TxtConnPath.Text.trim();

        this.Close();
        if (this.onAccept) this.onAccept(file, doc);
    }

    /* --- events ------------------------------------------------------------ */

    /*
     * The chooser starts where the path already points, or at the project. What
     * comes back is absolute and is written relative to the project when it is
     * inside it -- the spelling that still works when the project is moved.
     */
    TxtConnPath_IconClick() {
        const typed = this.TxtConnPath.Text.trim();
        const dir   = typed ? File.Directory(File.Join(this.project, typed)) : this.project;

        Dialog.OpenFile(Locale.Text("Choose a database"),
            { Folder: File.IsDir(dir) ? dir : this.project,
              Filters: [[Locale.Text("SQLite databases"), "*.db *.sqlite *.sqlite3"],
                        [Locale.Text("All files"), "*"]] },
            (path) => {
                this.TxtConnPath.Text = File.Within(path, this.project)
                    ? File.Relative(path, this.project) : path;
                this.showState();
            });
    }

    TxtConnName_Change() { this.showState(); }
    TxtConnPath_Change() { this.showState(); }
    TxtConnName_Activate() { this.FocusNext(); }
    TxtConnPath_Activate() { this.accept(); }

    BtnConnOk_Click()     { this.accept(); }
    BtnConnCancel_Click() { this.Close(); }
}
