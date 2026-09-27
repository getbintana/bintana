/*
 * A prompt for one line of text -- the "what should it be called?" dialog.
 *
 * **The other half of [`Confirm`](Confirm.js), and the difference between the
 * two is the whole design.** A question that destroys something must not let
 * Enter mean yes; a question that finishes typing must. So this one is `Default`
 * and `ActivatesDefault` and that one is neither, and neither is it a flag on a
 * shared class: two forms, because a form laid out by coordinates with the
 * buttons in the wrong place is worse than one extra class.
 *
 * It was three copies too -- `examples/notes/AskName.js` and
 * `ide/forms/AskForm.js` here, and the second is the one that taught the most.
 * What survived the merge:
 *
 * - **Enter and Escape are declared in the `.form`**, not handled in code.
 *   `BtnOk` is `Default`, `BtnCancel` is `Cancel`, `TxtValue` is
 *   `ActivatesDefault` -- which is what makes Enter in the *field* press the
 *   button rather than raise `Activate`. The IDE's copy carries the comment
 *   that says what used to be there instead: a `TxtValue_Activate` calling
 *   `accept()` and a `Form_KeyPress` checking for `"Escape"`, the second of
 *   which was in seven dialogs character for character.
 * - **`SelectAll()` after the focus**, from the example: the offered value is
 *   what typing is meant to replace, and a caret at the end of it makes the
 *   first keystroke an edit rather than a replacement.
 * - **`ActivatesDefault` also stops `Activate`**, so there is no handler here
 *   for it and there is nothing to forget.
 *
 * ## The shape
 *
 *     AskText.Prompt(label, onAccept, { Title, Initial, Option })
 *
 * Same argument order as [`Confirm.Ask`](Confirm.js) and for the same reason:
 * the callback is last, options before it. `Initial` is an option rather than a
 * second positional because it has a default -- the empty string -- and a
 * positional with a default is a positional somebody passes `undefined` to.
 *
 * `Option` is `{ Text, Checked }` and adds a checkbox to the same dialog. Its
 * state arrives as the callback's **second** argument. **One dialog and not
 * two**: a question about what is being created belongs beside the field that
 * names it, and Cancel then means "not at all" rather than "not that way".
 */
"use strict";

class AskText extends Form {

    /*
     * The two button labels, for the reason `Confirm` declares the same two:
     * the prompt and the checkbox text are the caller's prose, a literal at the
     * call site, and declaring them here too would be two msgids for one
     * string.
     */
    static TextProperties = ["BtnOk", "BtnCancel"];

    /*
     * Ask for one line of text.
     *
     * `options`:
     *   Title     the window's title.
     *   Initial   what the field starts with. `""` when not given, and a
     *             dialog that opens on an empty field is one Enter dismisses,
     *             so a caller asking for a *new* name and a caller renaming one
     *             differ only here.
     *   Option    `{ Text, Checked }` -- a checkbox under the field. The
     *             checkbox is a `Visible: false` control in the `.form` and is
     *             only ever shown when this is given, so a caller that does not
     *             use it has no disabled control on screen to explain.
     */
    static Prompt(label, onAccept, options) {
        const opts = options || {};
        const dlg = new AskText();

        dlg.Text            = opts.Title || "";
        dlg.LblPrompt.Text  = label;
        dlg.TxtValue.Text   = opts.Initial || "";
        dlg.onAccept        = onAccept;
        dlg.Modal           = true;

        if (opts.Option) {
            dlg.ChkOption.Text    = opts.Option.Text;
            dlg.ChkOption.Active = !!opts.Option.Checked;
            dlg.ChkOption.Visible = true;

            /* The dialog is laid out by coordinates, so making room is moving
             * what is below and growing the window by the same amount.
             *
             * The buttons' `VAlign: "End"` does not do this and is not
             * redundant with it: all of it runs before `Show()`, so this is the
             * *design size* being decided rather than a resize being reacted
             * to. What the anchor covers is the user resizing it afterwards --
             * and the dialog is `Resizable: false`, so what the anchor covers is
             * the layout passing over. */
            const room = 34;
            dlg.BtnCancel.Move(dlg.BtnCancel.X, dlg.BtnCancel.Y + room);
            dlg.BtnOk.Move(dlg.BtnOk.X, dlg.BtnOk.Y + room);
            dlg.Height += room;
        }

        dlg.Show();
        /* Focus first, then the selection: selecting is a call that needs the
         * field to be focused to mean anything. */
        dlg.TxtValue.SetFocus();
        dlg.TxtValue.SelectAll();
        return dlg;
    }

    accept() {
        const value = this.TxtValue.Text.trim();
        /* Nothing typed is not an answer, and the window stays up -- a
         * dialog that closes itself on an empty field is a dialog a mistyped
         * Enter throws away. */
        if (!value) return;

        const checked = this.ChkOption.Visible && this.ChkOption.Active;

        this.Close();
        /* After closing, and the reason is the same as `Confirm`'s: whoever
         * answers very often opens another dialog. */
        if (this.onAccept) this.onAccept(value, checked);
    }

    /* Enter reaches the button through `Default`/`ActivatesDefault`, so this is
     * only what a *click* is. */
    BtnOk_Click()      { this.accept(); }
    BtnCancel_Click()  { this.Close(); }

}
