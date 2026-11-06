/*
 * The condition, the message and the hit count of one breakpoint.
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

/* A hit count as the runtime reads one (`parse_hits` in bta_debug.c): a count,
 * `== n`, `>= n` or `% n`, n at least one. Checked here so a mistake is said in
 * the dialog, where it was typed, and not as a breakpoint that comes off. */
const HIT_COUNT = /^\s*(==|>=|%)?\s*[1-9][0-9]*\s*$/;

export class BreakpointForm extends Form {

    /** Whether `text` is a hit count the runtime accepts; empty is *every pass*.
     * @param {string} text
     * @returns {boolean} */
    static IsHitCount(text) {
        return !text || !text.trim() || HIT_COUNT.test(text);
    }

    /*
     * BreakpointForm.edit(where, condition, message, hits, onAccept)
     *
     * The callback is handed the three fields, trimmed; an empty one means
     * *none*.
     */
    static edit(where, condition, message, hits, onAccept) {
        const dlg = new BreakpointForm();

        dlg.Text              = "Breakpoint";
        dlg.LblWhere.Text     = where;
        dlg.TxtCondition.Text = condition || "";
        dlg.TxtMessage.Text   = message || "";
        dlg.TxtHits.Text      = hits || "";
        dlg.onAccept          = onAccept;
        dlg.Modal             = true;

        dlg.Show();
        dlg.TxtCondition.SetFocus();
        return dlg;
    }

    accept() {
        const condition = this.TxtCondition.Text.trim();
        const message   = this.TxtMessage.Text.trim();
        const hits      = this.TxtHits.Text.trim();

        /* A hit count that is not one stays in the dialog, said beside it: the
         * runtime would refuse it, and the breakpoint would come off. */
        if (!BreakpointForm.IsHitCount(hits)) {
            this.LblHits.Text = Locale.Text("Stop on pass: a number, == n, >= n or % n");
            this.TxtHits.SetFocus();
            return false;
        }

        this.Close();
        /* After closing, as every dialog here does: whoever answers may open
         * another window. */
        if (this.onAccept) this.onAccept(condition, message, hits);
        return true;
    }

    BtnOk_Click()     { this.accept(); }
    BtnCancel_Click() { this.Close(); }

    /* Clear is not Cancel: it says *this breakpoint has neither*, and it is a
     * separate button because that is a different answer from *never mind*. */
    BtnClear_Click() {
        this.Close();
        if (this.onAccept) this.onAccept("", "", "");
    }
}
