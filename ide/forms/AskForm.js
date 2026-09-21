/*
 * A dialog that asks for a piece of text.
 *
 * The runtime has no primitive for this, and needed none: it is a Bintana form
 * like any other.  GTK4's own dialogs are asynchronous anyway, so the answer
 * arrives by callback and nothing blocks.
 */
"use strict";

class AskForm extends Form {

    /*
     * AskForm.prompt("New form", "Name:", "Form2", (name) => ...)
     *
     * `option` adds a checkbox to the same dialog -- {text, checked} -- and its
     * state arrives as the second argument.  One dialog and not two: a question
     * about what is being created belongs next to the field that names it, and
     * Cancel then means "not at all" rather than "not that way".
     */
    static prompt(title, label, initial, onAccept, option) {
        const dlg = new AskForm();

        dlg.Text            = title;
        dlg.LblPrompt.Text  = label;
        dlg.TxtValue.Text   = initial || "";
        dlg.onAccept        = onAccept;
        dlg.Modal           = true;

        if (option) {
            dlg.ChkOption.Text    = option.text;
            dlg.ChkOption.Active = !!option.checked;
            dlg.ChkOption.Visible = true;

            /* The dialog is laid out by coordinates, so making room is moving
             * what is below and growing the window by the same amount.
             *
             * The buttons' VAlign "End" does not do this for us and is not
             * redundant with it: all of this runs before Show(), so it is the
             * design size being decided rather than a resize being reacted to.
             * What the anchor covers is the user resizing the dialog after. */
            const room = 34;
            dlg.BtnCancel.Move(dlg.BtnCancel.X, dlg.BtnCancel.Y + room);
            dlg.BtnOk.Move(dlg.BtnOk.X, dlg.BtnOk.Y + room);
            dlg.Height += room;
        }

        dlg.Show();
        dlg.TxtValue.SetFocus();
        return dlg;
    }

    accept() {
        const value = this.TxtValue.Text.trim();
        if (!value) return;          // with no text there is nothing to accept

        const checked = this.ChkOption.Visible && this.ChkOption.Active;

        this.dismiss();
        /* After closing: whoever answers often opens another dialog. */
        if (this.onAccept) this.onAccept(value, checked);
    }

    dismiss() { this.Close(); }

    /*
     * Enter and Escape are declared in the .form now -- `BtnOk` is `Default`,
     * `BtnCancel` is `Cancel`, and `TxtValue` is `ActivatesDefault`, so Enter in
     * the field presses OK instead of raising `Activate`. What used to be here
     * was a `TxtValue_Activate` calling `accept()` and a `Form_KeyPress`
     * checking for `"Escape"`, the second of which was in seven dialogs
     * character for character.
     */
    BtnOk_Click()      { this.accept(); }
    BtnCancel_Click()  { this.dismiss(); }

}
