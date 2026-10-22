/*
 * Binding -- what the designer needs to know about a form that edits a
 * record.
 *
 * `Form.Record` says which shape a form edits and `Control.DataField` says
 * which field a control shows, and both are ordinary properties, so the
 * designer has to offer them the way it offers the project's own style
 * classes: **from the project**, not from a list somebody wrote out.
 *
 * **The shape is a file.** `Customer.record` sits beside the class, and it is
 * the shape the runtime reads, so what the drop-down offers is exactly what
 * the program will read: the class the file names and the fields it
 * declares. The code-only path -- a class that declares `static Fields` and
 * keeps no file -- is offered its class name, and its fields are read out of
 * the declaration.
 *
 * **Read by the file's own stamp, and not on every question.** The property
 * grid is rebuilt on every selection change, and reading the project's
 * sources is what that costs: measured on the IDE itself -- 44 files, 29 of
 * them `.js` -- a full read is 38 ms against 11 ms for the whole of a
 * rescan, which would make a listing three times its own cost. A `stat`
 * instead of a read for a file nobody touched brings it back to 1 ms, and
 * that is the bargain the class registry already makes.
 */

/* The shape of a record, as the file holds it. */
const RECORD_FORMAT = "bta-record/1";

/* A class that declares its shape in code. */
const DECLARES_RECORD = new Regex(
    "class\\s+([A-Za-z_$][\\w$]*)\\s+extends\\s+Record\\b");

/* A key of that block: an identifier, or a quoted one. */
const FIELD_KEY = new Regex("([A-Za-z_$][\\w$]*)\\s*:");

export class Binding {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        /* What each file said, and the stamp it was read at. */
        this.parsed = new Map();
        /* The tables of each connection, kept until its database changes. */
        this.tables = new Map();
    }

    /*
     * The sources the project offers: its `.json` files, and the tables of
     * every connection it declares.
     *
     * **A connection is a `.conn` file**, so a table's name comes from
     * opening the database it names -- `sales.clients` is a table called
     * `clients` in what `sales.conn` points at. The order is the runtime's:
     * the files, then the tables, because that is the order `Rows()` tries
     * them in and a drop-down that reads differently is a drop-down that
     * lies about what a value means.
     */
    sources() {
        const out = [];

        for (const file of this.ide.classes.files)
            if (File.IsExtension(file, "json")) out.push(file);

        for (const file of this.ide.classes.files) {
            if (!File.IsExtension(file, "conn")) continue;

            const name = File.BaseName(file);
            for (const table of this.tablesOf(file))
                out.push(`${name}.${table}`);
        }

        return out;
    }

    /*
     * The tables of one connection, read out of its database.
     *
     * **Kept until the database changes** and not until the `.conn` does: a
     * table added to a database somebody is filling is a table the drop-down
     * has to offer, and the file that says where the database is did not
     * change. Opening a SQLite on every rebuild of the property grid is what
     * this is here to avoid.
     */
    tablesOf(file) {
        const conn = this.read(file, () => {
            const doc = File.LoadJson(File.Join(this.ide.project, file));
            return doc && doc.path ? doc : null;
        });
        if (!conn) return [];

        const dbPath = File.Join(this.ide.project, conn.path);
        const info   = File.Info(dbPath);
        const stamp  = info && info.Modified
                           ? `${info.Modified.getTime()}:${info.Size}` : "";
        const known  = this.tables.get(dbPath);

        if (stamp && known && known.stamp === stamp) return known.names;

        let names = [];
        try {
            const db = Database.Sqlite(dbPath);
            /* `Tables` is a **property** of the connection, not a verb. */
            names = db.Tables;
            db.Close();
        } catch (e) {
            names = [];         /* a database nobody can open offers nothing */
        }

        this.tables.set(dbPath, { stamp, names });
        return names;
    }

    /*
     * The record classes the project declares, and the fields of each.
     *
     * **The shapes that are files come first**, and they are exact: the class
     * the file names and the fields it declares, which is what the runtime
     * will read. A class that declares its shape in code comes after, with
     * the fields read out of the declaration -- the same path the runtime
     * takes, said on the other side of the process line.
     */
    records() {
        const out  = [];
        const seen = [];

        for (const file of this.ide.classes.files) {
            if (!File.IsExtension(file, "record")) continue;

            const doc = this.shapeIn(file);
            if (!doc) continue;

            const name = doc.class || File.BaseName(file);
            if (seen.includes(name)) continue;
            seen.push(name);
            /* `Dictionary.Keys` and not `Object.keys`: the latter is a hatch,
             * and this is a plain bag of the shape's own fields. */
            out.push({ name, fields: Dictionary.Keys(doc.fields || {}) });
        }

        for (const file of this.ide.classes.files) {
            if (!File.IsExtension(file, "js")) continue;

            const said = this.declaredIn(file);
            if (!said) continue;
            if (seen.includes(said.name)) continue;
            seen.push(said.name);
            out.push({ name: said.name, fields: said.fields });
        }

        return out;
    }

    /*
     * The fields of one record class, by its name.  Empty when the project
     * declares no such class -- which is what a form that names a record
     * the project does not have has to be answered with.
     */
    fieldsOf(name) {
        for (const record of this.records())
            if (record.name === name) return record.fields;
        return [];
    }

    /*
     * A `.record` file, read and parsed.  Null when it is not one, or when
     * it cannot be read: a shape nobody can read is not a shape to offer.
     */
    shapeIn(file) {
        const said = this.read(file, () => {
            const doc = File.LoadJson(File.Join(this.ide.project, file));
            if (!doc || doc.format !== RECORD_FORMAT) return null;
            return { class: doc.class, fields: doc.fields || {} };
        });
        return said;
    }

    /*
     * A class that declares its shape in code: the class's name and the
     * keys of its `static Fields`.
     *
     * **The keys, and not the fields**: the declaration says what a field
     * *is* through the `Field` constructors, and reading those would mean
     * reading the runtime's own vocabulary out of a source file. The names are
     * what a drop-down offers and what a control names, and the kinds are the
     * runtime's to answer when the program runs.
     */
    declaredIn(file) {
        const said = this.read(file, () => {
            const code = File.Load(File.Join(this.ide.project, file));

            const found = DECLARES_RECORD.Match(code);
            if (!found) return null;

            const fields = this.fieldKeysIn(code);
            return { name: found.Group(1), fields };
        });
        return said;
    }

    /*
     * The keys of a `static Fields` block.
     *
     * **The block is found by its braces and not by a pattern**, because a
     * field's own options are braces too -- `Field.Text({ max: 80 })` -- and
     * a pattern that stops at the first `}` stops inside the first field.
     * So the braces are counted, and the keys are the ones at the top level
     * of the block.
     */
    fieldKeysIn(code) {
        /* The block is found by the text and not by a pattern, because a
         * match carries no position: `Regex` answers what it matched and
         * where, but not the offset the walk needs. */
        const at = code.indexOf("static Fields");
        if (at < 0) return [];

        const open = code.indexOf("{", at);
        if (open < 0) return [];

        let   depth = 0;
        const keys  = [];
        let   word  = "";

        for (let i = open; i < code.length; i++) {
            const c = code[i];

            /* The brackets are counted and the text is **not** thrown away:
             * the key is the name *before* the colon and the value after it
             * has braces of its own, so the text of the value is harmless --
             * `keyOf` takes what is before the colon and the rest is the
             * value's. */
            if (c === "{" || c === "(" || c === "[") { depth++; continue; }
            if (c === "}" || c === ")" || c === "]") {
                depth--;
                if (depth === 0) break;
                continue;
            }
            if (c === "," && depth === 1) {
                const key = this.keyOf(word);
                if (key) keys.push(key);
                word = "";
                continue;
            }
            word += c;
        }

        /* The last one has no comma after it. */
        const last = this.keyOf(word);
        if (last) keys.push(last);

        return keys;
    }

    /*
     * The name of a field, from the text between two commas.
     *
     * **The name is what is before the colon**, because what is after it is
     * the field's own declaration -- `Field.Text({ max: 80 })` -- and that
     * text is not the name of anything.
     */
    keyOf(text) {
        const trimmed = text.trim();
        if (!trimmed) return "";

        const colon  = trimmed.indexOf(":");
        const name   = (colon >= 0 ? trimmed.slice(0, colon) : trimmed).trim();
        if (!name) return "";

        /* A quoted name is a name; anything else that is not an identifier is
         * not a field, and a key is either. */
        const quoted = /^["']([^"']+)["']$/.exec(name);
        if (quoted) return quoted[1];

        const plain = /^([A-Za-z_$][\w$]*)$/.exec(name);
        return plain ? plain[1] : "";
    }

    /*
     * What a file says, read once and kept until it changes.
     *
     * The size as well as the time, for the reason the class registry gives:
     * a timestamp is only as fine as the filesystem keeps it, and two writes
     * it cannot tell apart almost always differ in length.
     */
    read(file, say) {
        const path  = File.Join(this.ide.project, file);
        const info  = File.Info(path);
        const stamp = info && info.Modified
                          ? `${info.Modified.getTime()}:${info.Size}` : "";
        const known = this.parsed.get(file);

        /* No timestamp is no answer about staleness, so it is read. */
        if (stamp && known && known.stamp === stamp) return known.said;

        let said = null;
        try {
            said = say();
        } catch (e) {
            said = null;               /* unreadable is not an answer */
        }

        this.parsed.set(file, { stamp, said });
        return said;
    }
}
