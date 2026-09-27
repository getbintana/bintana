/*
 * A yes/no, for the one thing in a program that cannot be undone.
 *
 * **The runtime has no primitive for this, and the reason is GTK4's and not
 * ours**: its dialogs are fire-and-forget, so there is no such thing as a
 * blocking `MsgBox`, and [`llm/issues.md`](../../llm/issues.md) records the
 * answer as *"a question is a form"*. This is that form, shipped.
 *
 * It was three copies in the tree -- `examples/notes/Confirm.js`,
 * `examples/clients/Confirm.js` and the text says so in both headers -- and one
 * of them carries the sentence that decided it: *"Two applications wanting the
 * same four widgets is what a `lib/` library is for, and one of them is not
 * enough to write one."* There are two, and this is the one.
 *
 * **`examples/notes/Confirm.js` and `ide/forms/AskForm.js` are the source**,
 * read side by side, and what survived the merge is the half of each that
 * carries a decision:
 *
 * - **Nothing here is `Default`.** Enter must not be able to destroy something,
 *   so `BtnCancel` takes the focus after `Show()` and Escape is `Cancel: true`
 *   on that same button. `AskText` beside this file is the other way round --
 *   there Enter *is* the answer -- and the difference between the two is the
 *   whole point of the two properties, which is why these are two classes and
 *   not one with a flag.
 * - **`Style: "destructive-action"`** is on the accepting button, and it is
 *   declarative: the class declares the *kind* of question and the theme decides
 *   what it looks like. A caller that reassigns it gets an ordinary button.
 *
 * ## The shape, and why the callback is last
 *
 *     Confirm.Ask(message, onConfirm, { Title, Accept, Cancel })
 *
 * The callback is the **last** argument because that is the shape of every
 * question in the runtime -- `Dialog.OpenFile(title, options, callback)` and
 * `Printer.Send(area, options, callback)` -- and a question is the one place
 * where a program's reading order matters most: what is being asked is first
 * and what happens next is last. Options in the middle, never after the
 * callback.
 *
 * **The callback runs on the accepting button and on nothing else.** Cancelling
 * and closing the window both answer nothing, so a caller never has to tell
 * *no* from *the window went away* -- the same rule `AskText` follows, and the
 * reason a caller needs no flag of its own.
 */
"use strict";

class Confirm extends Form {

    /*
     * **The two labels this class owns, and not the message.** The message and
     * the button text a caller passes are the *caller's* prose: they are a
     * literal at the call site in the project's own `.js`, which is where the
     * extractor looks, and declaring them here as well would be two msgids for
     * one string.
     *
     * Declaring them makes the runtime put them through the catalogue when the
     * `.form` loads, which is half the promise -- see `docs/llm/dialog.md` for
     * the half that does not reach a library, and what a project does instead.
     */
    static TextProperties = ["BtnAccept", "BtnCancel"];

    /*
     * Ask about the one thing that cannot be undone.
     *
     * `options`:
     *   Title    the window's title. A form shows a title bar, and a modal
     *            with an empty one looks like a bug.
     *   Accept   what the accepting button says, and the caller should say
     *            *the verb* ("Delete", "Discard", "Overwrite") rather than
     *            "OK": the button is destructive and a caller that has been
     *            asked twice is a caller that was not believed the first time.
     *   Cancel   the other button. Translated prose, so it can be said.
     */
    static Ask(message, onConfirm, options) {
        const opts = options || {};
        const dlg = new Confirm();

        dlg.Text          = opts.Title || "";
        dlg.LblMessage.Text = message;
        dlg.BtnAccept.Text = opts.Accept || "OK";
        if (opts.Cancel) dlg.BtnCancel.Text = opts.Cancel;
        dlg.onConfirm     = onConfirm;
        dlg.Modal         = true;

        dlg.Show();
        /* The focus is the whole point: it is what makes Enter answer *no*.
         * Set here rather than in the `.form` because a form cannot know the
         * window is about to be shown -- and `SetFocus` before `Show` is the
         * `Form_Open` trap in a new dress, so it is after. */
        dlg.BtnCancel.SetFocus();
        return dlg;
    }

    BtnAccept_Click() {
        this.Close();
        /* After closing, and that order is not tidiness: whoever answers very
         * often opens another dialog, and a callback that runs while this
         * window is still up answers on a window somebody is looking at. */
        if (this.onConfirm) this.onConfirm();
    }

    /* Escape arrives here and not through `Form_KeyPress`, because the `.form`
     * declares `Cancel: true` on that button. Seven dialogs in this tree used
     * to check for `"Escape"` character for character; this is the fix. */
    BtnCancel_Click() { this.Close(); }

}
