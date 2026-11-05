/*
 * A control subclass: a `ListBox` with a method the form uses, and no `.form`
 * of its own.
 *
 * The runtime makes a real `NameList` -- the class is loaded like any other
 * source -- and the designer does not run this file.  It reads `extends` and
 * draws the `ListBox` the class will be, which is the point of the example:
 * open `MainForm.form` in the IDE and the list is there, with `Items` and
 * `Index` in the grid, even though the IDE has never evaluated a line of this
 * class.
 */
class NameList extends ListBox {

    /* Note
     *   a value only this subclass declares, shown in the designer's design
     *   mode and kept in the node -- the IDE never runs the class to ask
     */
    get Note() { return this._note || ""; }
    set Note(value) { this._note = String(value || ""); }
    static TextProperties = ["Note"];

    /* Refill(names)
     *   replaces the rows and selects the first one
     */
    Refill(names) {
        this.Items = names.slice();
        this.Index = names.length ? 0 : -1;
    }
}
