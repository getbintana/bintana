/*
 * A prompt for one line of text — the "what should it be called?" dialog.
 *
 * A Bintana form and not a runtime primitive, like `Confirm.js` beside it and
 * like `ide/forms/AskForm.js`: GTK4's alert dialogs are fire-and-forget, so a
 * question that needs an answer is a window somebody wrote.
 *
 * `Default: true` on OK here and **not** on `Confirm`'s destructive button, which
 * is the difference between the two: Enter should finish typing a name, and
 * Enter should never delete anything.
 */
"use strict";

class AskName extends Form {

    /* AskName.ask("Name for the note", "", (name) => …) — the callback runs only
     * when there is a name, so cancelling answers nothing and no caller has to
     * tell *no* from *closed the window*. */
    static ask(prompt, current, onName) {
        const dlg = new AskName();

        dlg.LblPrompt.Text = prompt;
        dlg.TxtName.Text   = current || "";
        dlg.onName         = onName;
        dlg.Modal          = true;

        dlg.Show();
        dlg.TxtName.SetFocus();
        dlg.TxtName.SelectAll();      /* so typing replaces what is offered */
        return dlg;
    }

    BtnOk_Click() {
        const name = this.TxtName.Text.trim();
        if (!name) return;            /* nothing typed is not an answer */

        this.Close();
        if (this.onName) this.onName(name);
    }

    /* Enter in the field is the same as pressing OK, which is what a one-field
     * dialog means by Enter -- `Default` covers the button, this covers the
     * field it is next to. */
    TxtName_Activate() { this.BtnOk_Click(); }

    BtnCancel_Click() { this.Close(); }

}
