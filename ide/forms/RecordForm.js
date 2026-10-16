/*
 * A record's fields, edited as the list they are.
 *
 * A `.record` file is the shape of a class -- `{"format":"bta-record/1",
 * "class":"Client","naming":"snake","fields":{...}}` -- and it is a document,
 * so the property grid has nothing to hold: this is the editor the tree hands
 * it to on a double click (`MainForm.editRecord`).
 *
 * The kinds are asked of the runtime (`Field.Kinds()`), and **every field is
 * checked through `Field.Spec`** -- the road the file's own loader takes --
 * before anything is written: a misspelt option, an enum with no values, a
 * default the field would refuse are refused here with the sentence the
 * project would have read at load. A dialog that kept its own copy of those
 * rules would be the copy that drifts.
 *
 * **What this dialog does not show, it does not lose.** A spec may carry the
 * XML spelling (`attribute`, `in`, `element`) or an option this IDE has never
 * heard of; each row keeps the spec it came with and an edit touches only the
 * keys its controls own, so opening a file and pressing OK writes it back as
 * it was.
 *
 * And it follows the column dialog's shape throughout: a `TableView` of rows
 * with the fields below, add/delete/up/down, OK/Cancel, and a copy handed back
 * so Cancel costs nothing.
 */
"use strict";

/* The naming rules the runtime accepts: rad.js's `NAMINGS`, for which there is
 * no verb to ask. */
const NAMINGS = ["same", "lower", "snake"];

/* What a field that has just been added says, so a new row is never blank. */
const NEW_FIELD_KIND = "text";
const NEW_FIELD_NAME = "Field";

/*
 * Which option each control owns, and which kinds take it.
 *
 * The kinds are the runtime's and so are the refusals; this table only decides
 * which control is *live*, which is an interface decision. It is the runtime's
 * FIELD_KINDS (rad.js) one screen away, and the two are held together by
 * `Field.Spec`: a kind added there appears in the combo, and an option this
 * table did not learn shows as shut until it is edited -- never as a file the
 * loader refuses.
 */
const OPTION_CONTROL = {
    required: "ChkRecRequired",
    min:      "TxtRecMin",
    max:      "TxtRecMax",
    decimals: "CmbRecDec",
    values:   "TxtRecValues",
    of:       "TxtRecOf",
};
const TAKES = {
    text:     ["required", "max"],
    int:      ["required", "min", "max"],
    number:   ["required", "min", "max", "decimals"],
    decimal:  ["required", "min", "max", "decimals"],
    bool:     [],
    date:     ["required"],
    time:     ["required", "min", "max"],
    datetime: ["required", "min", "max"],
    bytes:    ["required", "max"],
    list:     ["required", "max", "of"],
    enum:     ["required", "values"],
    record:   ["required", "of"],
};

/* The decimals combo: the empty first entry is *not rounding*, which is what a
 * number field with no `decimals` does. */
const DECIMALS = ["—"];
for (let i = 0; i <= 9; i++) DECIMALS.push(String(i));

/* The keys the dialog's controls own; everything else a spec carries is `extra`
 * and comes back untouched. */
const OWNED = ["kind", "required", "min", "max", "decimals", "values", "of",
               "key", "as", "def"];

/* An option as the fields show it: an empty string is *not given*. */
function defText(v) {
    if (v === undefined || v === null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

/* One row of the list: the name, the kind, what the controls own, and what
 * they do not. */
function rowOf(name, spec) {
    const extra = {};
    for (const key in spec) if (!OWNED.includes(key)) extra[key] = spec[key];

    const kind = spec.kind || NEW_FIELD_KIND;

    return {
        name: name,
        kind: kind,
        extra: extra,
        opts: {
            required: spec.required === true,
            key:      spec.key === true,
            as:       spec.as === undefined ? "" : String(spec.as),
            def:      defText(spec.def),
            min:      spec.min === undefined ? "" : String(spec.min),
            max:      spec.max === undefined ? "" : String(spec.max),
            /* A decimal field always has places -- absent is 2 -- and a number
             * with none is not rounded at all, which is the first entry. */
            decimals: spec.decimals === undefined
                    ? (kind === "decimal" ? "2" : "")
                    : String(spec.decimals),
            values:   Array.isArray(spec.values) ? spec.values.join(", ") : "",
            of:       spec.of === undefined ? "" :
                      (typeof spec.of === "string" ? spec.of : JSON.stringify(spec.of)),
        },
    };
}

export class RecordForm extends Form {

    /*
     * RecordForm.edit(doc, onAccept)
     *
     * Refuses a document that is not one of these before touching anything, so
     * a file this dialog does not understand is never rewritten blind.  Works
     * on copies and hands the shape back on OK.
     */
    static edit(doc, onAccept) {
        if (!doc || doc.format !== "bta-record/1")
            throw new TypeError("not a bta-record/1 document");
        if (typeof doc.class !== "string" || !doc.class)
            throw new TypeError("the document declares no class");
        if (!doc.fields || typeof doc.fields !== "object" || Array.isArray(doc.fields))
            throw new TypeError("'fields' is an object of fields");

        const naming = doc.naming === undefined ? "same" : doc.naming;
        if (!NAMINGS.includes(naming))
            throw new TypeError(`naming '${naming}' is not one of ` +
                                `${NAMINGS.join(", ")}`);

        const dlg = new RecordForm();

        dlg.doc      = doc;
        dlg.rows     = [];
        dlg.extra    = {};
        dlg.onAccept = onAccept;
        dlg.Modal    = true;
        dlg.picked   = -1;

        for (const name in doc.fields) dlg.rows.push(rowOf(name, doc.fields[name]));
        for (const key in doc)
            if (key !== "format" && key !== "class" && key !== "naming" &&
                key !== "fields")
                dlg.extra[key] = doc[key];

        /* Filled from code, which is also what keeps them out of the catalogue:
         * the loader translates what a .form declares and nothing else. */
        dlg.TxtRecClass.Text   = doc.class;
        dlg.CmbRecNaming.Items = NAMINGS;
        dlg.CmbRecNaming.Text  = naming;
        dlg.CmbRecKind.Items   = Field.Kinds();
        dlg.CmbRecDec.Items    = DECIMALS;

        dlg.show();
        dlg.Show();
        dlg.RecList.SetFocus();
        return dlg;
    }

    /* --- the list ---------------------------------------------------------- */

    /*
     * Redrawn whole after every edit, the column dialog's rule: a handful of
     * rows is not worth updating in place, and rebuilding makes reordering and
     * deleting the same three lines as adding.
     *
     * `refill` is false while somebody is typing: the fields are what was
     * typed, and writing a `TextBox` back from inside its own `Change` moves
     * the caret under the hand.
     */
    show(keep = this.picked, refill = true) {
        const was = this.filling;
        this.filling = true;

        this.RecList.Clear();
        for (const row of this.rows)
            this.RecList.Add([row.name, row.kind, this.summaryOf(row)]);

        this.picked = keep >= 0 && keep < this.rows.length ? keep : -1;
        this.RecList.Index = this.picked;
        this.filling = was;

        if (refill)
            this.fill();
        this.enable();
    }

    /* The fields show the row the list is on. */
    fill() {
        const row = this.rows[this.picked];

        this.filling = true;
        this.TxtRecName.Text       = row ? row.name : "";
        this.CmbRecKind.Text       = row ? row.kind : NEW_FIELD_KIND;
        this.ChkRecRequired.Active = row ? row.opts.required : false;
        this.ChkRecKey.Active      = row ? row.opts.key : false;
        this.TxtRecAs.Text         = row ? row.opts.as : "";
        this.TxtRecDef.Text        = row ? row.opts.def : "";
        this.TxtRecMin.Text        = row ? row.opts.min : "";
        this.TxtRecMax.Text        = row ? row.opts.max : "";
        this.TxtRecValues.Text     = row ? row.opts.values : "";
        this.TxtRecOf.Text         = row ? row.opts.of : "";
        this.CmbRecDec.Index       = row && row.opts.decimals !== ""
                                   ? Number(row.opts.decimals) + 1 : 0;
        this.filling = false;
    }

    /* Only the options of the kind chosen are live -- shut and not hidden, so
     * the dialog does not change shape under the hand. */
    enable() {
        const on    = this.picked >= 0;
        const takes = TAKES[this.CmbRecKind.Text] || [];

        for (const option in OPTION_CONTROL)
            this[OPTION_CONTROL[option]].Enabled = on && takes.includes(option);

        this.TxtRecName.Enabled = on;
        this.CmbRecKind.Enabled = on;
        this.ChkRecKey.Enabled  = on;
        this.TxtRecAs.Enabled   = on;
        /* A `Bytes` default has no spelling a document can hold, so the dialog
         * does not offer to write one (`Record.Shape` refuses the same). */
        this.TxtRecDef.Enabled  = on && this.CmbRecKind.Text !== "bytes";
        this.BtnRecDel.Enabled  = on;
        this.BtnRecUp.Enabled   = on && this.picked > 0;
        this.BtnRecDown.Enabled = on && this.picked < this.rows.length - 1;
    }

    /* A gloss of the declaration and not prose: the tokens of the file itself. */
    summaryOf(row) {
        const said = [];

        if (row.opts.required) said.push("required");
        if (row.opts.key)      said.push("key");
        if (row.opts.as)       said.push(`as ${row.opts.as}`);
        if (row.opts.min)      said.push(`min ${row.opts.min}`);
        if (row.opts.max)      said.push(`max ${row.opts.max}`);
        if (row.opts.decimals) said.push(`${row.opts.decimals} places`);
        if (row.opts.values)   said.push(row.opts.values);
        if (row.opts.of)       said.push(`of ${row.opts.of}`);
        return said.join(" · ");
    }

    /* --- editing ----------------------------------------------------------- */

    /* What the controls say, onto the row the list is on; the list is redrawn
     * without touching the fields. */
    edited() {
        if (this.filling || this.picked < 0) return;

        const row = this.rows[this.picked];

        row.name          = this.TxtRecName.Text;
        row.opts.required = this.ChkRecRequired.Active;
        row.opts.key      = this.ChkRecKey.Active;
        row.opts.as       = this.TxtRecAs.Text;
        row.opts.def      = this.TxtRecDef.Text;
        row.opts.min      = this.TxtRecMin.Text;
        row.opts.max      = this.TxtRecMax.Text;
        row.opts.values   = this.TxtRecValues.Text;
        row.opts.of       = this.TxtRecOf.Text;
        row.opts.decimals = this.CmbRecDec.Index <= 0
                          ? "" : String(this.CmbRecDec.Index - 1);

        this.show(this.picked, false);
    }

    /*
     * A kind change keeps what the new kind takes and drops the rest: a `max`
     * left on a date is a file the loader refuses, and the person changed the
     * kind on purpose.  The two options this dialog does not show go where the
     * runtime is strict about them -- `attribute` is a value's, `in`/`element`
     * a list's.
     */
    CmbRecKind_Select() {
        if (this.filling || this.picked < 0) return;

        const row  = this.rows[this.picked];
        const kind = this.CmbRecKind.Text;

        row.kind = kind;

        const takes = TAKES[kind] || [];
        if (!takes.includes("required")) row.opts.required = false;
        if (!takes.includes("min"))      row.opts.min      = "";
        if (!takes.includes("max"))      row.opts.max      = "";
        if (!takes.includes("values"))   row.opts.values   = "";
        if (!takes.includes("of"))       row.opts.of       = "";
        if (!takes.includes("decimals"))
            row.opts.decimals = kind === "decimal" ? "2" : "";
        if (kind !== "list") { delete row.extra.in; delete row.extra.element; }
        if (kind === "record" || kind === "list") delete row.extra.attribute;

        this.fill();
        this.show(this.picked, false);
    }

    /* --- the buttons ------------------------------------------------------- */

    BtnRecAdd_Click() {
        this.rows.push(this.newRow());
        this.show(this.rows.length - 1);
        this.TxtRecName.SetFocus();
    }

    /* A name nothing has yet, so the row somebody just added is never the one
     * OK refuses. */
    newRow() {
        let name = NEW_FIELD_NAME;
        for (let n = 2; this.rows.some((r) => r.name === name); n++)
            name = `${NEW_FIELD_NAME}${n}`;
        return rowOf(name, { kind: NEW_FIELD_KIND });
    }

    BtnRecDel_Click() {
        if (this.picked < 0) return;
        this.rows.splice(this.picked, 1);
        /* Stay where the list was: deleting the last row selects the new last. */
        this.show(Math.min(this.picked, this.rows.length - 1));
    }

    BtnRecUp_Click()   { this.move(-1); }
    BtnRecDown_Click() { this.move(1); }

    move(by) {
        const at = this.picked;
        const to = at + by;
        if (at < 0 || to < 0 || to >= this.rows.length) return;

        const [row] = this.rows.splice(at, 1);
        this.rows.splice(to, 0, row);
        this.show(to);
    }

    /* --- the options, as the format holds them ----------------------------- */

    /*
     * Every option is checked through `Field.Spec`, but a document holds types
     * and a comparison by coercion is not one: `Field.Text({max: "80"})` is
     * accepted because `v.length > "80"` coerces, so the dialog writes what a
     * document means -- a number where the option counts something (characters,
     * bytes, entries, a value) and the text where it compares as text (`"08:00"`,
     * a decimal's own spelling).
     */
    parseNumber(kind, text, which) {
        const t = text.trim();

        const counts = { text: ["max"], bytes: ["max"], list: ["max"],
                         int: ["min", "max"], number: ["min", "max"] };
        if ((counts[kind] || []).includes(which)) {
            const n = Number(t);
            if (!Number.isFinite(n))
                throw new TypeError(Locale.Text("'{0}' is not a number: {1}", which, t));
            return n;
        }
        return t;
    }

    parseDef(row) {
        const t = row.opts.def.trim();

        if (row.kind === "bool") {
            if (t === "true")  return true;
            if (t === "false") return false;
            throw new TypeError(Locale.Text("'Default' is true or false"));
        }
        if (row.kind === "int" || row.kind === "number") {
            const n = Number(t);
            if (!Number.isFinite(n))
                throw new TypeError(Locale.Text("'Default' is not a number: {0}", t));
            return n;
        }
        if (row.kind === "record" || row.kind === "list") {
            try {
                return JSON.parse(t);
            } catch (e) {
                throw new TypeError(Locale.Text("'Default' is not what a document holds: {0}", e.message));
            }
        }
        return t;
    }

    /*
     * The field's spec, from the row: what the controls own and what the row
     * brought, with the empty options left out. What comes out still goes
     * through `Field.Spec` before anything is written.
     */
    specOf(row) {
        const takes = TAKES[row.kind] || [];
        const spec  = { kind: row.kind };

        for (const key in row.extra) spec[key] = row.extra[key];

        if (takes.includes("required") && row.opts.required) spec.required = true;
        if (row.opts.key) spec.key = true;
        if (row.opts.as.trim()) spec.as = row.opts.as.trim();

        if (row.opts.def.trim() !== "")
            spec.def = this.parseDef(row);

        if (takes.includes("min") && row.opts.min.trim() !== "")
            spec.min = this.parseNumber(row.kind, row.opts.min, "min");
        if (takes.includes("max") && row.opts.max.trim() !== "")
            spec.max = this.parseNumber(row.kind, row.opts.max, "max");

        if (takes.includes("decimals")) {
            if (row.kind === "decimal")
                spec.decimals = row.opts.decimals === "" ? 2
                                                        : Number(row.opts.decimals);
            else if (row.opts.decimals !== "")
                spec.decimals = Number(row.opts.decimals);
        }

        if (takes.includes("values"))
            spec.values = row.opts.values.split(",")
                              .map((v) => v.trim()).filter((v) => v);

        if (takes.includes("of")) {
            const of = row.opts.of.trim();
            if (!of)
                throw new TypeError(Locale.Text("'Holds' is what the field holds"));

            if (of[0] === "{") {
                if (row.kind !== "list")
                    throw new TypeError(Locale.Text("'Holds' is the class's name"));
                try {
                    spec.of = JSON.parse(of);
                } catch (e) {
                    throw new TypeError(Locale.Text("'Holds' is not a field: {0}", e.message));
                }
            } else {
                spec.of = of;
            }
        }

        return spec;
    }

    /* --- events ------------------------------------------------------------ */

    RecList_Select() {
        if (this.filling) return;
        this.picked = this.RecList.Index;
        this.fill();
        this.enable();
    }

    TxtRecName_Change()   { this.edited(); }
    TxtRecAs_Change()     { this.edited(); }
    TxtRecDef_Change()    { this.edited(); }
    TxtRecMin_Change()    { this.edited(); }
    TxtRecMax_Change()    { this.edited(); }
    TxtRecValues_Change() { this.edited(); }
    TxtRecOf_Change()     { this.edited(); }
    ChkRecRequired_Click() { this.edited(); }
    ChkRecKey_Click()      { this.edited(); }
    CmbRecDec_Select()     { this.edited(); }

    BtnRecOk_Click() {
        /* The names first: they are the record's properties, and two rows with
         * one name would write one of them away. */
        const seen = new Set();
        for (let i = 0; i < this.rows.length; i++) {
            const name = this.rows[i].name.trim();

            if (!name) {
                Message.Error("Field {0} has no name.", i + 1);
                this.show(i);
                this.TxtRecName.SetFocus();
                return;
            }
            if (seen.has(name)) {
                Message.Error("'{0}' is declared twice.", name);
                this.show(i);
                this.TxtRecName.SetFocus();
                return;
            }
            seen.add(name);
        }

        /* And every field through `Field.Spec`, the road the file's loader
         * takes: what it refuses is refused here with the sentence the project
         * would have read at load. */
        const fields = {};
        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];

            try {
                const spec = this.specOf(row);
                Field.Spec(spec);
                fields[row.name.trim()] = spec;
            } catch (e) {
                Message.Error("{0}: {1}", row.name.trim() || Locale.Text("Field {0}", i + 1),
                              e.message);
                this.show(i);
                return;
            }
        }

        const shape = { format: "bta-record/1", class: this.doc.class };

        const naming = this.CmbRecNaming.Text;
        if (naming && naming !== "same")
            shape.naming = naming;

        shape.fields = fields;
        for (const key in this.extra) shape[key] = this.extra[key];

        this.dismiss();
        if (this.onAccept) this.onAccept(shape);
    }

    BtnRecCancel_Click() { this.dismiss(); }

    dismiss() { this.Close(); }
}
