/*
 * The name of a column, asked like `AskName` in `examples/notes` asks for
 * a note's: a static `ask` with a callback that runs only when there is a
 * name. The duplicate check is here and not in the board because the
 * sentence belongs to the question — and it stays open with the complaint
 * on `LblErr` rather than popping an error over the small dialog.
 *
 * Enter finishes typing (`Default` on OK); deleting is `Confirm.js` beside
 * this file, where nothing is default on purpose.
 */
"use strict";

class ColumnDialog extends Form {

    taken  = [];
    onName = null;

    static ask(prompt, current, taken, onName) {
        const dlg = new ColumnDialog();

        dlg.LblPrompt.Text = prompt;
        dlg.TxtName.Text = current || "";
        dlg.LblErr.Text = "";
        dlg.taken = taken || [];
        dlg.onName = onName;
        dlg.Modal = true;

        dlg.Show();
        dlg.TxtName.SetFocus();
        dlg.TxtName.SelectAll();
        return dlg;
    }

    BtnOk_Click() {
        const name = this.TxtName.Text.trim();
        if (!name) return;

        for (const other of this.taken) {
            if (other === name) {
                this.LblErr.Text = Locale.Text("{0} is already there.", name);
                return;
            }
        }

        this.Close();
        if (this.onName) this.onName(name);
    }

    TxtName_Activate() { this.BtnOk_Click(); }

    BtnCancel_Click() { this.Close(); }
}
