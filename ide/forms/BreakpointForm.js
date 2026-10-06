/*
 * The condition and the message of one breakpoint.
 *
 * A dialog and not a prompt, and the reason is `AskForm`'s own rule: it refuses
 * an empty answer, and empty is exactly what clearing a breakpoint's condition
 * is. The two halves belong together because they are the same question -- *what
 * should this breakpoint do when it is reached* -- and they are written or taken
 * away in one gesture.
 *
 * `where` is shown and never edited: the breakpoint is the one under the caret,
 * and this dialog moves nothing.
 */
"use strict";

class BreakpointForm extends Form {

    /*
     * BreakpointForm.edit(where, condition, message, onAccept)
     *
     * The callback is handed both fields, trimmed; an empty one means *none*.
     */
    static edit(where, condition, message, onAccept) {
        const dlg = new BreakpointForm();

        dlg.Text              = "Breakpoint";
        dlg.LblWhere.Text     = where;
        dlg.TxtCondition.Text = condition || "";
        dlg.TxtMessage.Text   = message || "";
        dlg.onAccept          = onAccept;
        dlg.Modal             = true;

        dlg.Show();
        dlg.TxtCondition.SetFocus();
        return dlg;
    }

    accept() {
        const condition = this.TxtCondition.Text.trim();
        const message   = this.TxtMessage.Text.trim();

        this.Close();
        /* After closing, as every dialog here does: whoever answers may open
         * another window. */
        if (this.onAccept) this.onAccept(condition, message);
    }

    BtnOk_Click()     { this.accept(); }
    BtnCancel_Click() { this.Close(); }

    /* Clear is not Cancel: it says *this breakpoint has neither*, and it is a
     * separate button because that is a different answer from *never mind*. */
    BtnClear_Click() {
        this.Close();
        if (this.onAccept) this.onAccept("", "");
    }
}
