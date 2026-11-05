/*
 * PropertyGrid -- an object's properties, as rows that edit them.
 *
 * An application that shows a printer's settings, a record's fields or a
 * selected control's own properties writes the same thing every time: a label
 * per name, a field of the right kind beside it, a handler that reads it back,
 * and a row added to the form for every property the class grows. This is that
 * panel as a component: give it a `Target` and it asks what the target has and
 * builds the rows.
 *
 * **The names and the accepted values are the runtime's answers**, not a list
 * here. A widget or a component answers `PropertyNames` and `PropertyOptions`;
 * a `Record` carries its `static Fields`, whose kinds say bool, enum, date,
 * number or decimal; a plain object answers with its own keys. A class that is
 * neither can say `static Options = { Paper: ["A4", "Letter"] }` for the lists
 * it wants a drop-down for.
 *
 * **It is a value view, not a binding.** `Change(name, value)` fires after the
 * target's own setter accepted the edit, so a form saves the object it already
 * holds. A setter that refuses (a number out of range, a misspelt enum) leaves
 * the target as it was and puts the sentence in the editor's tooltip.
 *
 * A `Target` is runtime data -- an object cannot be written in a `.form` -- so
 * a form assigns it in code:
 *
 *     Form_Open() { this.Props.Target = this.printer; }
 */
"use strict";

class PropertyGrid extends Component {

    /* Change(name, value)
     *   an edit the target accepted. The value is the target's own, after its
     *   setter -- a `Decimal` stays exact, a number is a number
     */
    static Events = ["Change"];

    /* What the rows are about. `null` shows the empty state. */
    /**
     * the object whose properties are shown; `null` shows "No target"
     */
    get Target() { return this._target || null; }
    set Target(v) {
        this._target = v || null;
        this.Refresh();
    }

    /* How wide the name column is, in pixels. */
    /**
     * the width of the name column, in pixels. Default `110`
     */
    get LabelWidth() { return this._labelWidth === undefined ? 110 : this._labelWidth; }
    set LabelWidth(v) {
        this._labelWidth = Math.max(20, Number(v) || 0);
        this.Refresh();
    }

    /* Rebuild the rows from the target as it is now. */
    /**
     * rebuilds the rows from the target; call it after changing its shape in
     * place -- a record's fields, a class's options
     * @returns PropertyGrid
     */
    Refresh() {
        if (!this.Rows)
            return this;

        this.Rows.Clear();
        this.editors = {};

        const target = this._target;
        if (!target) {
            this.Empty.Visible  = true;
            this.Scroll.Visible = false;
            this.Rows.Resize(100, 0);
            return this;
        }

        this.Empty.Visible  = false;
        this.Scroll.Visible = true;

        const keys = this.Keys();
        for (const key of keys)
            this.addRow(key, target[key]);

        this.Rows.Resize(Math.max(100, (this.Width || 320) - 16),
                         Math.max(0, this.Rows.Children.length * 36));
        return this;
    }

    /**
     * the property names the grid shows, in the target's own order
     * @returns string[]
     */
    Keys() {
        const target = this._target;
        if (!target) return [];

        /* A control or a component answers for itself; this is the same call
         * the IDE's grid makes. */
        if (typeof target.PropertyNames === "function") {
            try { return target.PropertyNames().filter((k) => !k.startsWith("__")); }
            catch (e) { return []; }
        }

        /* A Record's shape is its class's, and that is also the order it
         * declares -- not the order the values happened to be set in. */
        const ctor = target.constructor;
        if (ctor && ctor.Fields && typeof ctor.Fields === "object")
            return Dictionary.Keys(ctor.Fields);

        return Dictionary.Keys(target);
    }

    /**
     * the editor built for one property, or `null` when it is not shown --
     * what a test or a caller that wants to focus a row asks for
     * @returns Widget
     */
    Editor(name) { return this.editors ? (this.editors[name] || null) : null; }

    /**
     * the target's value for one property
     */
    Value(name) { return this._target ? this._target[name] : undefined; }

    /**
     * writes one property through the target's own setter and raises `Change`,
     * as an edit in the grid does. A refusal is the setter's and is not caught
     */
    SetValue(name, value) {
        if (!this._target) return this;
        this._target[name] = value;
        this.Emit("Change", name, this._target[name]);
        return this;
    }

    /* ------------------------------------------------------------- the rows */

    addRow(key, value) {
        if (typeof value === "function")
            return;

        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing     = 4;
        row.Height      = 32;
        row.HAlign      = "Fill";

        const name = new Label();
        name.Text    = key;
        name.Width   = this.LabelWidth;
        name.Height  = 32;
        name.VAlign  = "Center";
        name.Tooltip = key;
        row.Add(name);

        const editor = this.editorFor(key, value);
        editor.Height = 32;
        if (editor instanceof CheckButton) {
            editor.HAlign  = "Start";
            editor.HExpand = false;
        } else {
            editor.HAlign  = "Fill";
            editor.HExpand = true;
        }
        row.Add(editor);

        this.Rows.Add(row);
        this.editors[key] = editor;
    }

    /*
     * The editor a value wants. A field spec wins over the value's own type:
     * a `Field.Enum` is a drop-down even before it has a value, and a
     * `Field.Date` is a picker even when the value is `""`.
     */
    editorFor(key, value) {
        const field = this.fieldOf(key);

        if (field) {
            if (field.kind === "bool")    return this.checkEditor(key, value === true);
            if (field.kind === "enum")    return this.comboEditor(key, value, field.options);
            if (field.kind === "decimal") return this.decimalEditor(key, value, field.decimals);
            if (field.kind === "date")    return this.dateEditor(key, value);
            if (field.kind === "bytes")   return this.readonlyEditor(value);
            if (field.kind === "list" || field.kind === "record")
                return this.jsonEditor(key, value);
            if (field.kind === "int" || field.kind === "number")
                return this.numberEditor(key, value);
            return this.textEditor(key, value);
        }

        if (typeof value === "boolean") return this.checkEditor(key, value);
        if (typeof value === "number")  return this.numberEditor(key, value);
        if (value instanceof Decimal)   return this.decimalEditor(key, value, undefined);
        if (value instanceof Bytes)     return this.readonlyEditor(value);

        if (Array.isArray(value) ||
            (value && typeof value === "object" && !(value instanceof Decimal) &&
             !(value instanceof Bytes)))
            return this.jsonEditor(key, value);

        const options = this.optionsFor(key);
        if (options) return this.comboEditor(key, value, options);

        if (key === "Color" || key === "Background" || key === "Foreground")
            return this.colorEditor(key, value);
        if (key === "Font")
            return this.fontEditor(key, value);

        return this.textEditor(key, value);
    }

    textEditor(key, value) {
        const ed = new TextBox();
        ed.Text = value === undefined || value === null ? "" : String(value);
        ed.On("Change", () => this.commit(key, ed.Text, ed));
        return ed;
    }

    numberEditor(key, value) {
        const ed = new TextBox();
        ed.Text    = value === undefined || value === null ? "" : String(value);
        ed.Purpose = "Number";
        ed.On("Change", () => this.commit(key, ed.Text, ed));
        return ed;
    }

    comboEditor(key, value, options) {
        const ed   = new ComboBox();
        const text = value === undefined || value === null ? "" : String(value);
        const list = (options || []).map((one) => String(one));

        /* A value the class no longer offers is still what the object holds;
         * showing it is the truth, and choosing another replaces it. */
        ed.Items = list.includes(text) ? list : [text, ...list];
        ed.Text  = text;
        ed.On("Select", () => this.commit(key, ed.Text, ed));
        return ed;
    }

    checkEditor(key, value) {
        const ed = new CheckButton();
        ed.Text   = "";
        ed.Active = !!value;
        ed.On("Click", () => this.commit(key, ed.Active, ed));
        return ed;
    }

    decimalEditor(key, value, places) {
        const ed = new DecimalBox();
        if (places !== undefined) ed.Decimals = places;
        if (value instanceof Decimal)      ed.Value = value;
        else if (value !== undefined && value !== null) ed.Value = value;
        ed.On("Change", () => this.commit(key, ed.Value, ed));
        return ed;
    }

    dateEditor(key, value) {
        const ed = new DatePicker();
        ed.Value = value === undefined || value === null ? "" : String(value);
        ed.On("Change", () => this.commit(key, ed.Value, ed));
        return ed;
    }

    colorEditor(key, value) {
        const ed = new ColorButton();
        ed.Value = typeof value === "string" ? value : "";
        ed.On("Change", () => this.commit(key, ed.Value, ed));
        return ed;
    }

    fontEditor(key, value) {
        const ed = new FontButton();
        ed.Value = typeof value === "string" ? value : "";
        ed.On("Change", () => this.commit(key, ed.Value, ed));
        return ed;
    }

    jsonEditor(key, value) {
        const ed = new TextBox();
        try { ed.Text = value === undefined ? "" : JSON.stringify(value); }
        catch (e) { ed.Text = ""; ed.Tooltip = e.message; }
        ed.On("Change", () => this.commit(key, ed.Text, ed));
        return ed;
    }

    readonlyEditor(value) {
        const ed = new Label();
        ed.Text  = value instanceof Bytes ? `${value.Length} bytes` : String(value);
        ed.Style = "dim-label";
        return ed;
    }

    /* ------------------------------------------------------------ the answers */

    fieldOf(key) {
        const target = this._target;
        const ctor   = target && target.constructor;
        const fields = ctor && ctor.Fields;
        const field  = fields && fields[key];
        return field && field.__field ? field : null;
    }

    optionsFor(key) {
        const target = this._target;
        if (!target) return null;

        if (typeof target.PropertyOptions === "function") {
            try {
                const own = target.PropertyOptions(key);
                if (own && own.length) return own;
            } catch (e) { /* not a property it offers a list for */ }
        }

        const field = this.fieldOf(key);
        if (field && field.kind === "enum" && Array.isArray(field.options))
            return field.options;

        const ctor = target.constructor;
        const own  = (target.Options && target.Options[key]) ||
                     (ctor && ctor.Options && ctor.Options[key]);
        return Array.isArray(own) ? own : null;
    }

    /* ------------------------------------------------------------- the commit */

    commit(key, raw, editor) {
        if (!this._target) return;

        const field = this.fieldOf(key);
        const was   = this._target[key];
        let value;

        if (field) {
            if (field.kind === "bool") {
                value = !!raw;
            } else if (field.kind === "int") {
                value = Math.trunc(Number(raw)) || 0;
            } else if (field.kind === "number") {
                value = Number(raw) || 0;
            } else if (field.kind === "decimal") {
                value = raw instanceof Decimal ? raw : new Decimal(raw, field.decimals);
            } else if (field.kind === "enum") {
                const options = field.options || [];
                const found   = options.find((one) => String(one) === String(raw));
                value = found === undefined ? raw : found;
            } else if (field.kind === "list" || field.kind === "record") {
                value = this.parseJson(raw, editor);
                if (value === undefined) return;
            } else if (field.kind === "bytes") {
                return;
            } else {
                value = String(raw);
            }
        } else if (editor instanceof CheckButton) {
            value = !!raw;
        } else if (editor instanceof DecimalBox) {
            value = raw instanceof Decimal ? raw : new Decimal(raw);
        } else if (editor instanceof ComboBox) {
            const options = this.optionsFor(key) || [];
            const found   = options.find((one) => String(one) === String(raw));
            value = found === undefined ? String(raw) : found;
        } else if (editor instanceof DatePicker ||
                   editor instanceof ColorButton || editor instanceof FontButton) {
            value = String(raw);
        } else if (typeof was === "number") {
            value = Number(raw) || 0;
        } else if (typeof was === "boolean") {
            value = !!raw;
        } else if (Array.isArray(was) ||
                   (was && typeof was === "object" && !(was instanceof Decimal) &&
                    !(was instanceof Bytes))) {
            value = this.parseJson(raw, editor);
            if (value === undefined) return;
        } else {
            value = String(raw);
        }

        try {
            this._target[key] = value;
            editor.Tooltip = "";
            this.Emit("Change", key, this._target[key]);
        } catch (e) {
            /* The target's setter is the authority: a number past its range,
             * a value the enum does not offer. Say it at the editor and leave
             * the object as it was. */
            editor.Tooltip = e.message;
        }
    }

    parseJson(raw, editor) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            editor.Tooltip = e.message;
            return undefined;
        }
    }
}
