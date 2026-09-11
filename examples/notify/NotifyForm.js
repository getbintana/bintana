/*
 * Inline notifications: the message appears *over* the content, where the eye
 * already is, instead of in front of it.
 *
 * The whole of it is one `Overlay`: its **first child is the base layer** and
 * gets the whole of the stack, and the rest float on top. Here that is three
 * layers -- the form's content, a spinner while something is going, and the
 * notification itself -- and all three are declared in `NotifyForm.form`, drawn
 * where they go. Nothing here builds a widget.
 *
 * Why an overlay and not a dialog: a dialog takes the keyboard and waits for an
 * answer, and "saved" is not a question. And why not a label under the form: a
 * message that takes room makes the window jump every time it appears.
 *
 * Two things a stack is placed by, and they are the only two:
 *
 *   HAlign / VAlign   where a layer sits -- `Center`/`Start` is a banner at the
 *                     top, `Center`/`Center` is a spinner in the middle. A layer
 *                     that says nothing fills the whole stack, which is what the
 *                     base wants and no floater does.
 *   the order         which layer is on top. `Children[0]` is the base;
 *                     `Raise()` and `Lower()` move one, and `Reorder(child, 0)`
 *                     makes a layer *become* the base.
 *
 * X and Y mean nothing in here, and are not saved: a stack is not a drawing
 * surface. That is the one thing to know before drawing one.
 */
class NotifyForm extends Form {

    /* The timer that takes the message away, kept so a second message can stop
     * the first one's -- otherwise the older timer hides the newer message. */
    hider = null;

    Form_Open() {
        this.notify("Loaded 214 contacts");
    }

    /*
     * One message at a time, and the newest wins: a queue is the right answer
     * when messages are worth reading in order, and for "saved" it is not.
     */
    notify(text, failed) {
        this.LblToast.Text  = text;
        /* The two state colours plain GTK has; `error` reads on a label. */
        this.LblToast.Style = failed ? "error" : "";
        this.Toast.Visible  = true;

        if (this.hider) this.hider.Stop();
        this.hider = Timer.After(failed ? 6000 : 2500, () => this.dismiss());
    }

    dismiss() {
        if (this.hider) this.hider.Stop();
        this.hider = null;
        this.Toast.Visible = false;
    }

    BtnDismiss_Click() { this.dismiss(); }

    BtnSave_Click() {
        this.notify(`Saved ${this.TxtName.Text}`);
    }

    BtnDelete_Click() {
        this.notify("Contact deleted");
    }

    /*
     * The other reason a stack is worth having: covering the content while
     * something is going, without taking it off the screen. The spinner spins
     * only while it shows -- `Active` is the property, and leaving it on behind
     * a hidden layer is work nobody sees.
     */
    BtnSend_Click() {
        this.Busy.Visible = true;
        this.Spn.Active   = true;

        Timer.After(1500, () => {
            this.Spn.Active   = false;
            this.Busy.Visible = false;
            this.notify("The server did not answer", true);
        });
    }
}
