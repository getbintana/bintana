/*
 * A yes/no confirmation.  Like AskForm: a Bintana form, not a runtime
 * primitive.
 *
 * It only calls the callback if the user confirms; cancelling answers nothing,
 * so whoever asks does not have to tell "no" from "closed the window".
 */
"use strict";

class ConfirmForm extends Form {

    /*
     * ConfirmForm.ask("Delete", "Delete X?", "Delete", () => ...)
     *
     * And with a third answer, for the question where "no" is two different
     * things -- quitting with unsaved work is *discard* or *save*, and only one
     * of those is the cancel button:
     *
     *   ConfirmForm.ask(title, message, "Quit without saving", () => quit(),
     *                   { Text: "Save all and quit", Run: () => { saveAll(); quit(); } })
     *
     * Absent, the dialog is the two-button one it has always been: the button is
     * declared hidden in the .form and only what is asked for is shown.
     */
    static ask(title, message, acceptText, onConfirm, other) {
        const dlg = new ConfirmForm();

        dlg.Text             = title;
        dlg.LblMessage.Text  = message;
        dlg.BtnYes.Text      = acceptText || "Aceptar";
        dlg.onConfirm        = onConfirm;
        dlg.Modal            = true;

        if (other) {
            dlg.BtnOther.Text    = other.Text;
            dlg.BtnOther.Visible = true;
            dlg.onOther          = other.Run;
        }

        dlg.Show();

        /*
         * **`BtnNo` is focused and nothing here is `Default`**, which is the
         * point rather than an omission: Enter must not be able to delete
         * something. Focus and default are two different questions, and this
         * dialog is where the difference shows -- a focused button answers Enter
         * itself, so focusing No *is* the answer, and declaring Yes the default
         * would hand Enter to the destructive half from anywhere else on the
         * form. Escape is declared on `BtnNo` in the .form.
         */
        dlg.BtnNo.SetFocus();
        return dlg;
    }

    dismiss() { this.Close(); }

    BtnYes_Click() {
        this.dismiss();
        if (this.onConfirm) this.onConfirm();
    }

    BtnNo_Click() { this.dismiss(); }

    BtnOther_Click() {
        this.dismiss();
        if (this.onOther) this.onOther();
    }

}
