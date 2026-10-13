/*
 * The columns of a `TableView`, edited as the list they are.
 *
 * The property grid can already edit `Columns`: it is an array property, so it
 * offers the JSON, exactly as it does for `Tabs` and `Items`. That is honest and
 * it is not usable -- a column carries a heading, a width and an alignment, and
 * typing `[{"Text":"Name","Width":200}]` by hand is the kind of thing every tool
 * in this family gives a dialog for: Delphi a collection editor, WinForms a
 * column dialog, Qt an item editor.
 *
 * So this is the menu editor's shape, for the same reason it has one: what is
 * being edited is a *spec*, the canvas has nothing to click, and the result is
 * one undoable edit. And it shows the columns in a `TableView`, which is the
 * control this dialog exists to configure -- the IDE eating what it serves.
 */
"use strict";

/* What a column that was just added says, so a new row is never blank. */
const NEW_COLUMN_TEXT = "Column";

/*
 * The words `Alignment` accepts, **asked of the runtime and not declared here**.
 *
 * They were `Items` in the .form for about ten minutes, which was a bug of the
 * worst kind this project has: `ComboBox.Items` is a *prose* property, so the
 * loader puts every entry through the catalogue -- and a translator who rendered
 * "Right" as "Derecha" would have had this dialog write `Alignment: "Derecha"`
 * into the .form, which the runtime then refuses. The extractor is what caught
 * it, by collecting three keywords as if they were something a person reads.
 *
 * `PropertyOptions` is the answer to "what does this property accept", asked of
 * the **class** and not of a Label made to ask -- and a Label's `Alignment` is
 * the same three words a column's is, one vocabulary, which is why there is no
 * list of them anywhere in the IDE.
 */
function alignments() {
    return Widget.PropertyOptions("Label", "Alignment") || ["Left", "Center", "Right"];
}

/*
 * What a cell of a column can be: nothing but its text, a link, or a field of
 * one of the editor kinds -- **those asked of the runtime too**, out of the
 * same table its `Columns` setter reads, so a kind added there is offered here
 * with no other change. `None` and `Link` are this dialog's own two words for
 * the two declarations that are not an `Editor`.
 */
function cellKinds() {
    return ["None", "Link"].concat(
        Widget.PropertyOptions("TableView", "Columns.Editor") || ["Text"]);
}

/* The options each editor kind takes, by the field that holds each. */
const NUMBER_FIELDS = [["Min", "TxtColMin"], ["Max", "TxtColMax"],
                       ["Step", "TxtColStep"], ["Decimals", "TxtColDec"]];
const CHECK_FIELDS  = [["ActiveText", "TxtColOn"], ["InactiveText", "TxtColOff"]];

/* What a declared column's cell is, in this dialog's words. */
function cellOf(c) {
    if (c.Link) return "Link";
    if (typeof c.Editor === "string") return c.Editor;
    if (c.Editor && typeof c.Editor === "object") return c.Editor.Kind || "Text";
    return c.Editable ? "Text" : "None";
}

export class ColumnForm extends Form {

    /*
     * ColumnForm.edit(columns, onAccept)
     *
     * Works on a copy and hands it back on OK, so Cancel costs nothing -- the
     * same bargain every other dialog here makes.
     */
    static edit(columns, onAccept) {
        const dlg = new ColumnForm();

        dlg.cols     = (columns || []).map((c) => ({ ...c }));
        dlg.onAccept = onAccept;
        dlg.Modal    = true;
        dlg.picked   = -1;

        /* Filled from code, which is also what keeps them out of the catalogue:
         * the loader translates what a .form declares and nothing else. */
        dlg.CmbColAlign.Items = alignments();
        dlg.CmbColCell.Items  = cellKinds();


        dlg.show();
        dlg.Show();
        dlg.ColList.SetFocus();
        return dlg;
    }

    /* --- the list ---------------------------------------------------------- */

    /*
     * Redrawn whole after every edit, and the selection put back by index.
     *
     * A table of half a dozen rows is not worth the bookkeeping of updating one
     * cell in place, and rebuilding is what makes reordering and deleting the
     * same three lines as adding.
     */
    show(keep = this.picked, refill = true) {
        /* **An edit redraws the list and leaves the fields alone**: they are
         * what was typed, and writing a `TextEditor` back from inside its own
         * `Change` is GTK's "invalidate all outstanding iterators" warning --
         * and a caret moved under the person typing. Selecting a row in the
         * list would raise `Select` and fill them, so it is held off too. */
        const was = this.filling;
        if (!refill) this.filling = true;

        this.ColList.Clear();
        for (const c of this.cols) {
            this.ColList.Add([c.Text || "",
                              c.Width ? String(c.Width) : "",
                              c.Alignment || "Left",
                              cellOf(c) === "None" ? "" : cellOf(c)]);
        }

        this.picked = keep >= 0 && keep < this.cols.length ? keep : -1;
        this.ColList.Index = this.picked;
        this.filling = was;
        if (refill)
            this.fill();
        this.enable();
    }

    /* The fields show the column the list is on. */
    fill() {
        const c = this.cols[this.picked] || {};

        this.filling = true;
        this.TxtColText.Text   = c.Text || "";
        this.SpnColWidth.Value = c.Width || 0;
        this.CmbColAlign.Text  = c.Alignment || "Left";

        /* An option shows as the text the declaration holds, and an empty
         * field is an option not given -- the kind's default. */
        const kind = cellOf(c);
        const opts = c.Editor && typeof c.Editor === "object" ? c.Editor : {};
        const said = (key) => (opts[key] === undefined ? "" : String(opts[key]));

        this.CmbColCell.Text = cellKinds().includes(kind) ? kind : "None";
        for (const [key, field] of NUMBER_FIELDS.concat(CHECK_FIELDS))
            this[field].Text = said(key);
        this.TxtColItems.Text = Array.isArray(opts.Items) ? opts.Items.join("\n") : "";
        this.filling = false;
        this.showOptions();
    }

    /* Only the options of the kind chosen are on show. */
    showOptions() {
        const kind = this.CmbColCell.Text;

        this.NumPanel.Visible   = kind === "Number";
        this.CheckPanel.Visible = kind === "Check";
        this.ComboPanel.Visible = kind === "Combo";
    }

    enable() {
        const on = this.picked >= 0;

        this.TxtColText.Enabled  = on;
        this.SpnColWidth.Enabled = on;
        this.CmbColAlign.Enabled = on;
        this.CmbColCell.Enabled  = on;
        this.BtnColDel.Enabled   = on;
        this.BtnColUp.Enabled    = on && this.picked > 0;
        this.BtnColDown.Enabled  = on && this.picked < this.cols.length - 1;
    }

    /* --- editing ----------------------------------------------------------- */

    /*
     * What the fields say, onto the column the list is on.
     *
     * `Width` of 0 and `Alignment` of Left are the defaults, and a default is
     * *not written*: the serialiser omits what equals a fresh value, so a column
     * that says nothing about its width should not carry `"Width": 0` into the
     * .form either. The rule is the same one and this is the only place that has
     * to know it.
     */
    edited(cell = false) {
        if (this.filling || this.picked < 0) return;

        const c = this.cols[this.picked];
        c.Text = this.TxtColText.Text;

        const w = Math.round(this.SpnColWidth.Value);
        if (w > 0) c.Width = w; else delete c.Width;

        const a = this.CmbColAlign.Text;
        if (a && a !== "Left") c.Alignment = a; else delete c.Alignment;

        /* The cell is rewritten only when it is what was touched, so renaming
         * a column leaves a declaration this dialog did not edit as it was --
         * an `Editable: true` from before `Editor` existed included. */
        if (cell)
            this.writeCell(c);

        this.show(this.picked, false);
    }

    /*
     * The cell's declaration, from the fields: nothing, `Link: true`, or an
     * `Editor` -- its kind's name alone when no option was given, the object
     * otherwise. **An option is written as typed when it is not a number**,
     * so the runtime's own refusal names it at OK rather than the field being
     * dropped in silence.
     */
    writeCell(c) {
        const kind = this.CmbColCell.Text;

        delete c.Editable;
        delete c.Link;
        delete c.Editor;

        if (kind === "Link") { c.Link = true; return; }
        if (!kind || kind === "None") return;

        const opts = {};
        if (kind === "Number")
            for (const [key, field] of NUMBER_FIELDS) {
                const t = this[field].Text.trim();
                if (t) opts[key] = Number.isFinite(Number(t)) ? Number(t) : t;
            }
        if (kind === "Check")
            for (const [key, field] of CHECK_FIELDS) {
                const t = this[field].Text;
                if (t) opts[key] = t;
            }
        if (kind === "Combo") {
            const items = this.TxtColItems.Text.split("\n")
                              .map((t) => t.trim()).filter((t) => t);
            if (items.length) opts.Items = items;
        }

        c.Editor = Dictionary.Keys(opts).length ? { Kind: kind, ...opts } : kind;
    }

    /* --- events ------------------------------------------------------------ */

    ColList_Select() {
        if (this.filling) return;
        this.picked = this.ColList.Index;
        this.fill();
        this.enable();
    }

    TxtColText_Change()  { this.edited(); }
    SpnColWidth_Change() { this.edited(); }
    CmbColAlign_Select() { this.edited(); }

    CmbColCell_Select() {
        if (this.filling) return;
        this.showOptions();
        this.edited(true);
    }

    TxtColMin_Change()   { this.edited(true); }
    TxtColMax_Change()   { this.edited(true); }
    TxtColStep_Change()  { this.edited(true); }
    TxtColDec_Change()   { this.edited(true); }
    TxtColOn_Change()    { this.edited(true); }
    TxtColOff_Change()   { this.edited(true); }
    TxtColItems_Change() { this.edited(true); }

    BtnColAdd_Click() {
        this.cols.push({ Text: NEW_COLUMN_TEXT });
        this.show(this.cols.length - 1);
        this.TxtColText.SetFocus();
    }

    BtnColDel_Click() {
        if (this.picked < 0) return;
        this.cols.splice(this.picked, 1);
        /* Stay where the list was: deleting the last row selects the new last. */
        this.show(Math.min(this.picked, this.cols.length - 1));
    }

    BtnColUp_Click()   { this.move(-1); }
    BtnColDown_Click() { this.move(1); }

    move(by) {
        const at = this.picked;
        const to = at + by;
        if (at < 0 || to < 0 || to >= this.cols.length) return;

        const [c] = this.cols.splice(at, 1);
        this.cols.splice(to, 0, c);
        this.show(to);
    }

    BtnColOk_Click() {
        /* A column with no heading is a column nobody can read, and it is the
         * one thing worth refusing here rather than letting the runtime do it:
         * the runtime accepts it, and the result is a table with a blank header. */
        const blank = this.cols.findIndex((c) => !(c.Text || "").trim());
        if (blank >= 0) {
            Message.Error("Column {0} has no heading.", blank + 1);
            this.show(blank);
            this.TxtColText.SetFocus();
            return;
        }

        /*
         * **What the runtime refuses, it refuses here**: a scratch table is
         * given the columns, and its `Columns` setter is the one check of an
         * `Editor` there is -- a Min above the Max, a word where a number goes,
         * a Check whose two texts are the same. Asking it beats a second copy
         * of its rules in the IDE, which would be the copy that drifts.
         */
        try {
            new TableView().Columns = this.cols;
        } catch (e) {
            Message.Error("{0}", e.message);
            const at = /Columns\[(\d+)\]/.exec(e.message);
            if (at) this.show(Number(at[1]));
            return;
        }

        const edited = this.cols;
        this.dismiss();
        if (this.onAccept) this.onAccept(edited);
    }

    BtnColCancel_Click() { this.dismiss(); }

    dismiss() { this.Close(); }
}
