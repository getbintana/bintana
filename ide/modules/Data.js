/*
 * Data -- the project's databases, their tables, their columns and the records
 * that map onto them, with a console over the selected one.
 *
 * **The runtime is the one that opens the database.**  A `.conn` file says
 * where a database is (`{ "kind": "sqlite", "path": "data/clients.db" }`, or
 * `{ "kind": "odbc", "connection": "DSN=Ventas", "user": …, "password_env": … }`),
 * and a form's `Connection` part says the same thing in its properties; this
 * view only reads what `Database.Sqlite` or `Database.Odbc` answers --
 * `Tables`, `Columns(table)` and `Query(sql)` -- and never invents a schema of
 * its own.  A database that does not exist yet is shown as *not created*, not
 * created by the act of looking at it: a browser that writes is a browser
 * that changes the program it is supposed to describe.
 *
 * **A record is a shape, not a table.**  The fields under a table come from
 * the project's `.record` files, read through `Binding` -- the same answer the
 * designer's `Record` and `DataField` rows use -- and the `Model` parts of a
 * form say which record is over which table.  A model whose table has not been
 * created is listed by name, because that is exactly the state a first run is
 * in.
 *
 * **The view is a page of the side bar and a page of the bottom panel.**  The
 * tree is how a schema is browsed; the console is where a query is typed and
 * its rows are read, which wants the width of the window and not the width of
 * a side panel.  Both are built in code: how many pages there are is this
 * module's answer, and a `.form` is loaded once with no way to say *one page
 * per database*.
 */
"use strict";

/* How many rows a preview shows before it stops.  The query itself is not
 * rewritten: the reader asked for these rows, and hiding the rest behind an
 * invisible LIMIT would make the count a lie. */
const PREVIEW_ROWS = 200;

/* What the query console keeps on screen.  A `Query` already holds every row
 * it read; this only decides how many of them are turned into widgets. */
const SHOWN_ROWS = 500;

const SQLITE_EXTENSIONS = ["db", "sqlite", "sqlite3"];

/* The first word of a statement, with comments and space before it skipped.
 * It decides between `Query` and `Execute`, and nothing else: SQLite is not
 * asked to parse the statement twice. */
function firstWord(sql) {
    let text = String(sql);
    for (;;) {
        let i = 0;
        while (i < text.length && (text[i] === " " || text[i] === "\t" ||
                                   text[i] === "\n" || text[i] === "\r"))
            i++;
        text = text.slice(i);

        if (text.startsWith("--")) {
            const nl = text.indexOf("\n");
            text = nl < 0 ? "" : text.slice(nl + 1);
            continue;
        }
        if (text.startsWith("/*")) {
            const end = text.indexOf("*/");
            text = end < 0 ? "" : text.slice(end + 2);
            continue;
        }
        break;
    }

    let i = 0;
    while (i < text.length) {
        const c = text.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) i++;
        else break;
    }
    return text.slice(0, i).toLowerCase();
}

/* A cell as a table shows it: words for the values SQLite does not hand back
 * as strings, and the empty string for the absence of one. */
function cellText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "object") {
        try { return JSON.stringify(value); }
        catch (e) { return String(value); }
    }
    return String(value);
}

export class Data {

    /* Whether the IDE can open a database of this descriptor's kind. */
    static opens(db) {
        return !!db && (db.kind === "sqlite" || db.kind === "odbc");
    }

    /*
     * The descriptor's database, opened through the runtime -- the same
     * `Database.Sqlite` or `Database.Odbc` the program calls. An ODBC
     * connection's password is never in the project: a `.conn` names the
     * environment variable that holds it (`password_env`), and a form's part
     * sets it in code, which the IDE cannot run -- so a part opens only when
     * its DSN or connection string carries the password. The driver's refusal
     * is what the view then says.
     */
    static open(db) {
        if (db.kind === "odbc") {
            const options = {};
            if (db.user) options.User = db.user;
            if (db.passwordEnv) {
                const secret = Environment.Get(db.passwordEnv);
                if (secret) options.Password = secret;
            }
            return Database.Odbc(db.connection, options);
        }
        return Database.Sqlite(db.path);
    }

    /*
     * What this page contributes to the side bar: one row, shaped like the
     * ones `ProjectTree.sideEntries` and `Changes.sideEntries` return.  The
     * page is the third of `SideStack`, appended by `install` -- the tree and
     * the changes page are the two the .form declares.
     */
    static get sideEntries() {
        return [{
            text:  Locale.Text("Data"),
            tip:   Locale.Text("Show the database view"),
            icons: ["x-office-spreadsheet-symbolic", "view-list-symbolic",
                    "bta-grid-symbolic"],
            page:  2,
            show:  (ide) => ide.data.shown(),
        }];
    }

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /* Every database the project declares or keeps, in the order the combo
         * offers them.  A descriptor is `{ name, path, kind, file, models,
         * missing, tables, error }`, and for an ODBC one also `connection`,
         * `user` and `passwordEnv`; `id` is what identifies it. */
        this.databases = [];
        this.chosenId = "";

        /* The selected descriptor and what its tree holds.  The action maps are
         * keyed by the tree's own keys: a key is the only thing an `Activate`
         * carries, and a table name is not guaranteed to be one key. */
        this.current = null;
        this.actions = {};
        this.tableKeys = {};
        this.columnKeys = {};
        this.modelKeys = {};
        this.recordKeys = {};
        this.fieldKeys = {};

        /* The widgets, built once by `install`.  Declared here so every reader
         * is answered when there is no project yet. */
        this.DbList = null;
        this.Reload = null;
        this.Schema = null;
        this.Message = null;
        this.Target = null;
        this.Sql = null;
        this.Rows = null;
        this.Status = null;
        this.sidePage = -1;
        this.consolePage = -1;
        this.installed = false;
        this.dressing = false;
        this.keySeq = 0;
    }

    /*
     * The two pages, built once and appended to the containers that hold them.
     * Called from `MainForm.Form_Open` before `dressViews`, because the side
     * bar's chooser and strip are filled from the list this page completes.
     */
    install() {
        if (this.installed) return;
        this.installed = true;

        this.buildSide();
        this.buildConsole();
        this.refresh();
    }

    buildSide() {
        const page = new Panel();
        page.Name        = "DataPage";
        page.Arrangement = "Vertical";
        page.Spacing     = 4;
        page.Margin      = 4;

        const bar = new Panel();
        bar.Arrangement = "Horizontal";
        bar.Spacing     = 4;

        this.DbList = new ComboBox();
        this.DbList.Name    = "CmbDataDb";
        this.DbList.HExpand = true;
        this.DbList.Tooltip = Locale.Text("Which database to show");

        this.Reload = new Button();
        this.Reload.Name    = "BtnDataReload";
        this.Reload.Style   = "flat";
        this.Reload.Icon    = "view-refresh-symbolic";
        this.Reload.Tooltip = Locale.Text("Read the project and its databases again");
        this.Reload.Width   = 30;
        this.Reload.On("Click", () => this.ide.listFiles());

        this.Schema = new TreeView();
        this.Schema.Name    = "DataTree";
        this.Schema.HExpand = true;
        this.Schema.VExpand = true;
        this.Schema.HAlign  = "Fill";

        this.Message = new Label();
        this.Message.Name  = "LblDataMessage";
        this.Message.Style = "dim-label";
        this.Message.Wrap  = true;
        this.Message.HAlign = "Fill";

        bar.Add(this.DbList);
        bar.Add(this.Reload);
        page.Add(bar);
        page.Add(this.Schema);
        page.Add(this.Message);

        this.sidePage = this.ide.SideStack.Append(page, Locale.Text("Data"));

        this.DbList.On("Select", () => this.chosen());
        this.Schema.On("Activate", () => this.activate());
    }

    buildConsole() {
        const page = new Panel();
        page.Name        = "DataConsole";
        page.Arrangement = "Vertical";
        page.Spacing     = 2;
        page.Margin      = 2;
        page.HExpand     = true;
        page.VExpand     = true;

        const bar = new Panel();
        bar.Arrangement = "Horizontal";
        bar.Spacing     = 4;
        bar.HAlign      = "Fill";

        this.Target = new Label();
        this.Target.Name    = "LblDataTarget";
        this.Target.Style   = "dim-label";
        this.Target.HExpand = true;
        this.Target.HAlign  = "Fill";

        this.Run = new Button();
        this.Run.Name  = "BtnDataRun";
        this.Run.Text  = Locale.Text("Run");
        this.Run.Icon  = "media-playback-start-symbolic";
        this.Run.Style = "suggested-action";
        this.Run.Width = 90;
        this.Run.On("Click", () => this.run());

        this.Sql = new SourceEditor();
        this.Sql.Name     = "DataSql";
        this.Sql.Language = "sql";
        this.Sql.Height   = 58;
        this.Sql.HExpand  = true;
        this.Sql.HAlign   = "Fill";
        this.Sql.Wrap     = false;

        this.Rows = new TableView();
        this.Rows.Name    = "DataRows";
        this.Rows.HExpand = true;
        this.Rows.VExpand = true;
        this.Rows.HAlign  = "Fill";
        this.Rows.VAlign  = "Fill";

        this.Status = new Label();
        this.Status.Name   = "LblDataStatus";
        this.Status.Style  = "dim-label";
        this.Status.HAlign = "Fill";
        this.Status.Wrap   = true;

        bar.Add(this.Target);
        bar.Add(this.Run);
        page.Add(bar);
        page.Add(this.Sql);
        page.Add(this.Rows);
        page.Add(this.Status);

        this.consolePage = this.ide.ConsoleBox.Append(page);
        const tab = new Label();
        tab.Text  = Locale.Text("Data");
        this.ide.ConsoleBox.SetTabLabel(this.consolePage, tab);

        /* A query run from the console is the same act as one run from the
         * tree; a double click on a table fills the box and runs it. */
        this.Sql.On("KeyPress", (key, ctrl) => {
            if (key !== "Return" || !ctrl) return false;
            this.run();
            return true;
        });
    }

    /* --- the databases a project has ---------------------------------------- */

    /*
     * Every database the project names, read from three places:
     *
     *   `.conn` files          the project's declared connections
     *   `Connection` parts     a form's own connection, by its `Path`
     *   `.db`/`.sqlite` files  a database nobody declared, still worth showing
     *
     * The same file named by a `.conn` and by a form is one database: the path
     * is the identity, and the first name it was found under is the one the
     * combo offers.  Models are merged into it from every form that names it.
     */
    scan() {
        const ide     = this.ide;
        const project = ide.project;
        const found   = new Map();
        const forms   = [];

        this.databases = [];
        if (!project) return;

        /* `spec` is `{ kind, path }` for sqlite and `{ kind: "odbc", connection,
         * user, passwordEnv }` for a server. The identity is the file for one
         * and the connection string with its user for the other. */
        const add = (name, spec, file) => {
            const kind = spec.kind || "sqlite";
            let id, abs = "";
            if (kind === "odbc") {
                if (!spec.connection) return null;
                id = `odbc:${spec.connection}\u0001${spec.user || ""}`;
            } else {
                if (!spec.path) return null;
                abs = File.Absolute(File.Join(project, spec.path));
                id = abs;
            }
            let db = found.get(id);
            if (!db) {
                db = { name: name || File.BaseName(abs), path: abs, id,
                       kind, file: file || "",
                       connection: spec.connection || "", user: spec.user || "",
                       passwordEnv: spec.passwordEnv || "",
                       models: [], missing: kind === "sqlite" && !File.Exists(abs),
                       tables: [], quote: '"', page: "Limit", error: "" };
                found.set(id, db);
                this.databases.push(db);
            } else {
                if (!db.file && file) db.file = file;
                if (!db.name && name) db.name = name;
            }
            return db;
        };

        for (const file of ide.classes.files) {
            if (!File.IsExtension(file, "form")) continue;
            try {
                const doc = File.LoadJson(File.Join(project, file));
                if (doc) forms.push({ file, doc });
            } catch (e) {
                /* A form that cannot be read is the checker's to report; the
                 * data view simply has nothing to say about it. */
            }
        }

        /* The declared connections first, so a `.conn` names the database the
         * forms then map records onto. */
        for (const file of ide.classes.files) {
            if (!File.IsExtension(file, "conn")) continue;
            let doc;
            try { doc = File.LoadJson(File.Join(project, file)); }
            catch (e) { doc = null; }
            if (!doc) continue;
            add(File.BaseName(file), { kind: doc.kind, path: doc.path,
                                       connection: doc.connection, user: doc.user,
                                       passwordEnv: doc.password_env }, file);
        }

        for (const form of forms) {
            const parts = Array.isArray(form.doc.components) ? form.doc.components : [];
            const connections = new Map();

            for (const part of parts) {
                if (!part || part.type !== "Connection") continue;
                const props = part.properties || {};
                /* A part's password is set in code, so the IDE has none: a DSN
                 * or a connection string that carries it is what opens. */
                const db = props.Driver === "Odbc"
                    ? add(part.name, { kind: "odbc", connection: props.ConnectionString,
                                       user: props.User }, form.file)
                    : add(part.name, { kind: "sqlite", path: props.Path }, form.file);
                if (db) connections.set(part.name, db);
            }

            for (const part of parts) {
                if (!part || part.type !== "Model") continue;
                const props = part.properties || {};
                const db = connections.get(props.Connection);
                if (!db) continue;

                db.models.push({
                    part:   part.name || "",
                    form:   form.doc.class || File.BaseName(form.file),
                    record: props.Record || "",
                    table:  props.TableName || props.Record || "",
                });
            }
        }

        /* And a database the project keeps without declaring it, which is how
         * an example or a one-file tool usually starts. */
        for (const file of ide.classes.files) {
            const ext = File.Extension(file).toLowerCase();
            if (!SQLITE_EXTENSIONS.includes(ext)) continue;
            add(File.BaseName(file), { kind: "sqlite", path: file }, file);
        }

        this.databases.sort((a, b) => Locale.Compare(a.name, b.name));
    }

    /* The view brought up from the side bar: the schema is already built by
     * `listFiles`, and a view switch does not re-read a database. */
    shown() {
        if (!this.DbList) return;
        this.Schema.SetFocus();
    }

    /* The chosen database, from the combo.  `Select` also arrives while the
     * combo is being filled, and that is not somebody choosing. */
    chosen() {
        if (this.dressing || !this.DbList) return;

        const at = this.DbList.Index;
        if (at < 0 || at >= this.databases.length) return;

        this.chosenId = this.databases[at].id;
        this.show(at);
    }

    /*
     * Read the project again and fill the combo.  The database that was up is
     * kept when it is still there -- a rescan must not move the reader to
     * another one -- and the first is shown when it is not.
     */
    refresh() {
        if (!this.installed) return;

        this.scan();

        const names = this.databases.map((db) =>
            db.name + (db.missing ? " " + Locale.Text("(not created)") : ""));

        let at = this.databases.findIndex((db) => db.id === this.chosenId);
        if (at < 0) at = this.databases.length ? 0 : -1;

        this.dressing = true;
        this.DbList.Items = names;
        this.DbList.Index = at;
        this.dressing = false;

        this.chosenId = at >= 0 ? this.databases[at].id : "";
        this.show(at);
    }

    /* --- the schema tree ----------------------------------------------------- */

    /* One node, with a key this view can act on.  Keys are the tree's, not the
     * database's: a table name may be anything, and an `Activate` carries only
     * the key. */
    node(text, parent, icon, action) {
        const key = `data:${this.keySeq++}`;
        this.Schema.Add(key, text, parent || "", icon || "");
        if (action) this.actions[key] = action;
        return key;
    }

    show(at) {
        this.actions     = {};
        this.tableKeys   = {};
        this.columnKeys  = {};
        this.modelKeys   = {};
        this.recordKeys  = {};
        this.fieldKeys   = {};
        this.keySeq      = 0;
        this.Schema.Clear();

        if (at < 0 || at >= this.databases.length) {
            this.current = null;
            this.Message.Text    = Locale.Text("No databases in this project.");
            this.Message.Visible = true;
            this.Target.Text     = "";
            return;
        }

        const db = this.databases[at];
        this.current = db;
        this.Target.Text = db.name;
        db.error = "";

        if (!Data.opens(db)) {
            this.Message.Text = Locale.Text(
                "{0} is a {1} connection, which the IDE cannot open yet.",
                db.name, db.kind);
            this.Message.Visible = true;
            return;
        }

        if (db.missing) {
            this.Message.Text = Locale.Text(
                "{0} is not there yet. Run the application to create it.",
                db.path);
            this.Message.Visible = true;
            return;
        }

        let live = null;
        try {
            live = Data.open(db);
            db.tables = live.Tables;
            db.quote = live.Dialect && live.Dialect.Quote ? live.Dialect.Quote : '"';
            db.page  = live.Dialect && live.Dialect.Page !== undefined
                     ? live.Dialect.Page : "Limit";
        } catch (e) {
            db.error = e.message || String(e);
            db.tables = [];
        }

        if (db.error) {
            this.Message.Text    = db.error;
            this.Message.Visible = true;
            if (live) live.Close();
            return;
        }

        try {
            for (const table of db.tables || []) {
                const model = db.models.find((m) => m.table === table);
                const recordName = model && model.record
                    ? model.record
                    : this.recordNamed(table);

                const tableKey = this.node(table, "", "x-office-spreadsheet-symbolic",
                                           { kind: "table", table });
                this.tableKeys[table] = tableKey;

                let columns = [];
                if (live) {
                    try { columns = live.Columns(table); }
                    catch (e) { columns = []; }
                }
                for (const column of columns) {
                    const detail = [
                        column.Type || "",
                        column.Required ? Locale.Text("required") : "",
                        column.Key ? Locale.Text("key") : "",
                    ].filter((s) => s).join(" · ");

                    const key = this.node(column.Name + (detail ? `   ${detail}` : ""),
                                          tableKey, "text-x-generic-symbolic",
                                          { kind: "column", table,
                                            column: column.Name });
                    this.columnKeys[`${table}.${column.Name}`] = key;
                    if (detail) this.Schema.SetTooltip(key, detail);
                }

                for (const m of db.models.filter((one) => one.table === table)) {
                    const modelKey = this.node(
                        Locale.Text("Model {0} -> {1}", m.part, m.record),
                        tableKey, "application-x-addon-symbolic", null);
                    this.modelKeys[m.part] = modelKey;
                }

                if (recordName) {
                    const fields = this.ide.fieldsOf(recordName);
                    if (fields.length) {
                        const recordKey = this.node(
                            Locale.Text("Record {0}", recordName),
                            tableKey, "x-office-address-book-symbolic",
                            { kind: "record", record: recordName });
                        this.recordKeys[recordName] = recordKey;
                        for (const field of fields) {
                            const fieldKey = this.node(field, recordKey,
                                                       "text-x-generic-symbolic", null);
                            this.fieldKeys[`${recordName}.${field}`] = fieldKey;
                        }
                    }
                }
            }

            /* A model whose table has not been created yet is the state a
             * first run is in, so it is named rather than silently absent. */
            for (const model of db.models) {
                if ((db.tables || []).includes(model.table)) continue;
                this.node(Locale.Text("Model {0} -> {1} (table not created)",
                                      model.part, model.record),
                          "", "application-x-addon-symbolic", null);
            }

            if ((db.tables || []).length === 0) {
                this.Message.Text = Locale.Text("This database has no tables.");
            } else {
                this.Message.Text = "";
            }
        } finally {
            if (live) live.Close();
        }

        this.Message.Visible = this.Message.Text !== "";
    }

    /* A record whose name is the table's, which is `Model.TableName`'s default
     * and the convention an example follows before it declares a model. */
    recordNamed(table) {
        const wanted = String(table).toLowerCase();
        for (const record of this.ide.records())
            if (String(record.name).toLowerCase() === wanted) return record.name;
        return "";
    }

    /* --- acting on a row ----------------------------------------------------- */

    /* Whether the selected node opens the console.  A double click on a table
     * (or one of its columns) is a preview; on a record it is the record
     * editor, the same door the project tree uses. */
    activate() {
        const action = this.actions[this.Schema.Key];
        if (!action) return;

        if (action.kind === "table") this.preview(action.table);
        else if (action.kind === "column") this.preview(action.table, action.column);
        else if (action.kind === "record") {
            const file = this.recordFile(action.record);
            if (file) this.ide.editRecord(file);
        }
    }

    /* The file a `.record` class lives in, for the editor the tree already
     * has.  Empty when the class is declared in code rather than in a file. */
    recordFile(name) {
        for (const file of this.ide.files) {
            if (!File.IsExtension(file, "record")) continue;
            try {
                const doc = File.LoadJson(File.Join(this.ide.project, file));
                if (doc && doc.class === name) return file;
            } catch (e) {
                /* not a shape this view can open */
            }
        }
        return "";
    }

    /* The table, or one column of it, in the console.  The limit is this
     * view's and is said in the SQL, so the reader can see it and take it
     * away. */
    preview(table, column) {
        const db = this.current;
        if (!db || db.missing || !Data.opens(db)) return;

        const quote = db.quote || '"';
        const q = (name) => quote + String(name).split(quote).join(quote + quote) + quote;
        /* An engine with no LIMIT (SQL Server) gets the bare SELECT; the
         * console reads it a row at a time and stops at what it shows. */
        const limit = db.page === "Limit" ? ` LIMIT ${PREVIEW_ROWS}` : "";
        const sql = column
            ? `SELECT ${q(column)} FROM ${q(table)}${limit}`
            : `SELECT * FROM ${q(table)}${limit}`;

        this.Sql.Text = sql;
        this.run();
    }

    /* --- the console --------------------------------------------------------- */

    /*
     * Run what the box says.  A statement that answers rows (`SELECT`,
     * `PRAGMA`, `EXPLAIN`, or a `WITH` that selects) goes through `Query`; the
     * rest goes through `Execute`, whose answer is what changed.  The
     * connection is the selected database's and is closed again: this is a
     * console over a file, not the application's own session.
     */
    run() {
        const db = this.current;
        if (!db) {
            this.say(Locale.Text("Choose a database first."), true);
            return;
        }
        if (db.missing) {
            this.say(Locale.Text("{0} is not there yet.", db.path), true);
            return;
        }
        if (!Data.opens(db)) {
            this.say(Locale.Text("The console speaks SQLite and ODBC."), true);
            return;
        }

        const sql = String(this.Sql.Text || "").trim();
        if (!sql) {
            this.say(Locale.Text("Type a statement first."), true);
            return;
        }

        this.ide.showConsole(this.consolePage);
        this.ide.dressViewMenu();

        let live = null;
        try {
            live = Data.open(db);
            const word = firstWord(sql);
            if (["select", "with", "pragma", "explain"].includes(word)) {
                /* Over a server, a row at a time and no further than what is
                 * shown: a SELECT with no limit on a big table must not bring
                 * it all into the IDE. A file is read whole, as before. */
                if (db.kind === "odbc") {
                    const rows = [];
                    live.Each(sql, (row) => { rows.push(row); return rows.length < SHOWN_ROWS; });
                    this.fill(rows);
                } else {
                    this.fill(live.Query(sql));
                }
            } else {
                const info = live.Execute(sql);
                this.fillStatement(info);
            }
        } catch (e) {
            this.say(e.message || String(e), true);
        } finally {
            if (live) live.Close();
        }
    }

    fill(rows) {
        const keys = rows.length ? Dictionary.Keys(rows[0]) : [];

        this.Rows.Columns = keys.map((key, i) => ({
            Text: key,
            Width: i === keys.length - 1 ? 0 : 120,
        }));
        this.Rows.Clear();

        if (!rows.length) {
            this.say(Locale.Text("No rows."));
            return;
        }

        const shown = rows.slice(0, SHOWN_ROWS);
        this.Rows.AddRows(shown.map((row) => keys.map((key) => cellText(row[key]))));

        this.say(rows.length > SHOWN_ROWS
            ? Locale.Text("Showing {0} of {1} rows.", SHOWN_ROWS, rows.length)
            : Locale.Plural("{0} row", "{0} rows", rows.length));
    }

    fillStatement(info) {
        this.Rows.Columns = [{ Text: Locale.Text("Changes"), Width: 120 },
                             { Text: Locale.Text("Last id"), Width: 120 }];
        this.Rows.Clear();
        this.Rows.Add([String(info.Changes), String(info.LastId)]);
        this.say(Locale.Text("Statement executed."));
    }

    say(text, isError) {
        this.Status.Text  = text;
        this.Status.Style = isError ? "error" : "dim-label";
    }

    /* --- a .conn row in the project tree ------------------------------------ */

    /* Open the Data view on the database a `.conn` names, from the project
     * tree's double click.  A file this view has not read yet is read first. */
    openFile(file) {
        let db = this.databases.find((one) => one.file === file);
        if (!db) {
            this.refresh();
            db = this.databases.find((one) => one.file === file);
        }
        if (!db) return;

        const at = this.databases.indexOf(db);
        const view = this.ide.sideViews().findIndex((one) => one.page === this.sidePage);
        if (view >= 0) this.ide.showSideView(view);

        this.DbList.Index = at;
        this.chosen();
    }
}
