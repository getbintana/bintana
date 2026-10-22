/*
 * A form that edits a record, and **the loop is gone**.
 *
 * This is the third rung of one ladder, and the other two are examples of
 * their own:
 *
 * - [`examples/quote`](../quote) fills its controls from a record and reads
 *   them back **by hand** -- eleven lines and two guards, and the plan that
 *   designed the binding was argued on what it measured.
 * - [`examples/clients`](../clients) does the same over a **table**, and found
 *   thirteen more things a screen over data costs.
 * - **This one declares it.** `BoundForm.form` says `Record: "Customer"`, each
 *   control says which field it shows (`DataField`), and `Bind(record)` puts a
 *   record on the screen and takes it back.
 *
 * What the declaration owns, and what is therefore **not written here**:
 *
 * - **The fill.** Every control that names a field is written from it, in one
 *   call, inside the runtime's own guard.
 * - **The guard.** Every assignment to a control raises a real `Change`, so a
 *   form that shows a record reads it straight back -- and the read-back lands
 *   while the record is still being written. Both screens before this one
 *   discovered that on their own, and both carry a `showing` flag.
 * - **The write-back.** The value goes back when the person is done being
 *   edited -- `Activate` for a `TextBox` and a `DecimalBox`, `Change` when a
 *   day is picked from the `DatePicker`, `Click` for a `CheckButton` -- and on
 *   losing the focus, which is what WinForms calls `OnValidation`. Which of
 *   those it is, is the class's to say.
 * - **The refusal.** A value the field will not take is marked **on the
 *   control**, with the sentence the field refused with: the label under the
 *   form reads it, and that is the whole of this file's error handling.
 *
 * The shape is `Customer.record`, beside this file. The fields, their rules
 * and their names live there, and the field editor in the IDE opens it -- so
 * this file has no shape in it, and the form has no `parseFloat` and no
 * `if (name === "")`.
 */
class BoundForm extends Form {

    /* What the file gave, as records: the binding asks for one at a time, and
     * the window keeps the list because *which* record is the application's
     * question and not the binding's. */
    records = [];

    /* Where in that list the screen is. */
    at = -1;

    Form_Open() {
        try {
            /* **`Source` says which rows**, and it is declared in the `.form`
             * beside `Record` -- which says what a row is. The class is the
             * caller's because a project's `class Customer` is a lexical
             * binding: the runtime answers about a name without handing the
             * class back. `Rows` reads the file once and keeps it, so the two
             * buttons below do not read it again. */
            this.records = this.Rows(Customer);
        } catch (e) {
            Message.Error("{0}", e.message);
            return;
        }

        this.watch();
        this.show(0);
    }

    /*
     * Show one record: **one call**, and nothing is filled here.
     *
     * `Bind` writes every control that names a field and remembers the record
     * for the write-back. A record of another class than the form's is refused
     * with a sentence naming both, which is what `Record: "Customer"` is for.
     */
    show(index) {
        if (!this.records.length) {
            this.LblStatus.Text = "No customers";
            return;
        }

        this.at = Math.max(0, Math.min(index, this.records.length - 1));
        this.Bind(this.records[this.at]);
        this.status();
    }

    /*
     * The line under the form: the first thing a field refused, or where in
     * the list the window is.
     *
     * **`Error` is the binding's**, and it is read-only: a control that refused
     * a value carries the sentence, and one whose value was taken carries
     * none. The app decides what to do with it, and here it is a paragraph.
     */
    status() {
        const refused = [];

        for (const control of this.Controls)
            if (control.DataField && control.Error) refused.push(control.Error);

        this.LblStatus.Text = refused.length
            ? refused[0]
            : `${this.at + 1} of ${this.records.length}`;
    }

    /*
     * **The moment after the binding's.** The runtime's write-back is a handler
     * on the control, and a control's own handlers run before the form's
     * `<name>_<event>` ones -- so by the time this runs, the record holds what
     * the person typed and `Error` says whether it took it.
     *
     * `On` and not ten handlers, because this is one question asked of every
     * bound control; it replaces rather than accumulating, so `show()` may
     * call it again when the list changes.
     */
    watch() {
        for (const control of this.Controls) {
            if (!control.DataField) continue;
            control.On("LostFocus", () => this.status());
        }
    }

    /* --- the list ------------------------------------------------------- */

    BtnPrev_Click() { this.show(this.at - 1); }
    BtnNext_Click() { this.show(this.at + 1); }

    /*
     * A new one, at the end, and the screen goes to it.
     *
     * **Added and not saved**: nothing reaches the file until Save, which is
     * the same bargain the two examples before this one make.
     */
    BtnNew_Click() {
        this.records.push(new Customer());
        this.show(this.records.length - 1);
    }

    /*
     * The list back to the file. `Serialize()` writes **what differs from the
     * start**, so a field nobody touched is a field the file does not carry.
     */
    BtnSave_Click() {
        const path = File.Join(Application.Directory, "customers.json");

        try {
            File.SaveJson(path, this.records.map((record) => record.Serialize()));
            this.LblStatus.Text = `Saved ${this.records.length}`;
        } catch (e) {
            Message.Error("Cannot write {0}: {1}", path, e.message);
        }
    }
}
