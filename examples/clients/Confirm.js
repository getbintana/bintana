/*
 * A yes/no for the one thing here that cannot be undone.
 *
 * Copied from `examples/notes`, and it is here rather than shared because
 * **there is no question dialog in the runtime and that is a decision**:
 * GTK4's dialogs are asynchronous, so a blocking `MsgBox` cannot exist, and
 * `docs/llm/issues.md` records the answer as *"a question is a form"*. Two
 * applications wanting the same four widgets is what a `lib/` library is for,
 * and one of them is not enough to write one.
 *
 * Deleting a client takes its orders with it -- `ON DELETE CASCADE` -- so this
 * is the one place in this example where a click destroys rows nobody can get
 * back, and the only place worth a question.
 *
 * **Nothing here is `Default`.** Enter must not be able to delete something, so
 * Cancel takes the focus and answers Enter itself; Escape is `Cancel: true` on
 * the same button.
 */
"use strict";

class Confirm extends Form {

    static ask(message, acceptText, onConfirm) {
        const dlg = new Confirm();

        dlg.LblMessage.Text = message;
        dlg.BtnYes.Text     = acceptText;
        dlg.onConfirm       = onConfirm;
        dlg.Modal           = true;

        dlg.Show();
        dlg.BtnCancel.SetFocus();
        return dlg;
    }

    BtnYes_Click()    { this.Close(); if (this.onConfirm) this.onConfirm(); }
    BtnCancel_Click() { this.Close(); }
}
