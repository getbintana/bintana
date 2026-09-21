/*
 * The task editor, for both a new task and an old one.
 *
 * The `AskName` shape from `examples/notes`: a static `create`/`edit`
 * taking a callback that runs only when there is an answer, so cancelling
 * answers nothing. The dialog edits nothing itself — it validates a probe
 * `Task` and hands plain data back, and the board constructs or applies it.
 * That keeps the one thing that must not happen — a half-applied edit —
 * unrepresentable: either the data was valid and the board takes all of it,
 * or the dialog stays open with the sentence on `LblErr`.
 *
 * Both drop-downs are filled from code and not from the `.form`. The
 * priorities come from `PropertyOptions("Priority")`, so the setter and the
 * list cannot drift; the columns are user data, and a list of values in a
 * `.form` would be translated on load — which is how a translated "Right"
 * once became an `Alignment` the runtime refuses.
 */
"use strict";

class TaskDialog extends Form {

    /* Plain data, or null until Save. Plain so the board owns the record. */
    colIds  = [];
    onSave  = null;
    editId  = 0;

    static create(colDefs, wantCol, onSave) {
        const dlg = new TaskDialog();
        dlg.Text = Locale.Text("New task");
        dlg.fill(colDefs, null, wantCol, onSave);
        dlg.Modal = true;
        dlg.Show();
        dlg.TxtTitle.SetFocus();
        return dlg;
    }

    static edit(task, colDefs, onSave) {
        const dlg = new TaskDialog();
        dlg.Text = Locale.Text("Edit task");
        dlg.fill(colDefs, task, task.Column, onSave);
        dlg.Modal = true;
        dlg.Show();
        dlg.TxtTitle.SetFocus();
        dlg.TxtTitle.SelectAll();
        return dlg;
    }

    fill(colDefs, task, wantCol, onSave) {
        this.colIds = colDefs.map((c) => c.id);
        this.onSave = onSave;
        this.editId = task ? task.Id : 0;

        this.CmbPriority.Items = new Task().PropertyOptions("Priority");
        this.CmbColumn.Items = colDefs.map((c) => c.title);

        this.TxtTitle.Text = task ? task.Title : "";
        this.EdNotes.Text = task ? task.Notes : "";

        const pri = new Task().PropertyOptions("Priority");
        const atPri = task ? pri.indexOf(task.Priority) : 1;
        this.CmbPriority.Index = atPri < 0 ? 1 : atPri;

        const atCol = this.colIds.indexOf(wantCol);
        this.CmbColumn.Index = atCol < 0 ? 0 : atCol;

        this.PckDue.Value = task && task.Due ? task.Due : "";
        this.LblErr.Text = "";
    }

    /* A picker has no gesture for emptying itself, so the button beside it
     * is one: `Value = ""` is the empty date the record already spells. */
    BtnClearDate_Click() { this.PckDue.Value = ""; }

    BtnSave_Click() {
        const atCol = this.CmbColumn.Index;
        const atPri = this.CmbPriority.Index;
        const pri = new Task().PropertyOptions("Priority");

        const data = {
            Title: this.TxtTitle.Text.trim(),
            Notes: this.EdNotes.Text,
            Priority: pri[atPri < 0 ? 1 : atPri],
            Due: this.PckDue.Value,
            Column: this.colIds[atCol < 0 ? 0 : atCol],
        };

        try {
            const probe = new Task(data);
            if (this.editId) probe.Id = this.editId;
        } catch (e) {
            this.LblErr.Text = e.message;
            return;
        }

        this.Close();
        if (this.onSave) this.onSave(data);
    }

    TxtTitle_Activate() { this.BtnSave_Click(); }

    BtnCancel_Click() { this.Close(); }
}
