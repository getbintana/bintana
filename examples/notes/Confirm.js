/*
 * A yes/no that means it, for the one thing in this application that cannot be
 * undone.
 *
 * **It is almost never shown**, and that is the design rather than a hedge:
 * deleting a note sends it to the desktop's trash, which is recoverable, so
 * nothing needs to be asked. This is what is left for the case where there *is*
 * no trash — a folder on a stick, on tmpfs, on a share — where the only thing
 * left is an unlink, and an unlink without asking is harsher than the desktop
 * the program runs on.
 *
 * **Nothing here is `Default`.** Enter must not be able to delete something, so
 * Cancel takes the focus and answers Enter itself; Escape is `Cancel: true` on
 * the same button. `AskName` beside this file is the other way round, and the
 * difference between them is the whole point of the two properties.
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
