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

class ColumnForm extends Form {

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
    show(keep = this.picked) {
        this.ColList.Clear();
        for (const c of this.cols) {
            this.ColList.Add([c.Text || "",
                              c.Width ? String(c.Width) : "",
                              c.Alignment || "Left"]);
        }

        this.picked = keep >= 0 && keep < this.cols.length ? keep : -1;
        this.ColList.Index = this.picked;
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
        this.filling = false;
    }

    enable() {
        const on = this.picked >= 0;

        this.TxtColText.Enabled  = on;
        this.SpnColWidth.Enabled = on;
        this.CmbColAlign.Enabled = on;
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
    edited() {
        if (this.filling || this.picked < 0) return;

        const c = this.cols[this.picked];
        c.Text = this.TxtColText.Text;

        const w = Math.round(this.SpnColWidth.Value);
        if (w > 0) c.Width = w; else delete c.Width;

        const a = this.CmbColAlign.Text;
        if (a && a !== "Left") c.Alignment = a; else delete c.Alignment;

        this.show(this.picked);
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

        const edited = this.cols;
        this.dismiss();
        if (this.onAccept) this.onAccept(edited);
    }

    BtnColCancel_Click() { this.dismiss(); }

    dismiss() { this.Close(); }
}
