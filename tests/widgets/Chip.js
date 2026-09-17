/*
 * A component that extends another component, which is the case the walk had to
 * be done *inside* rather than bolted onto the answer: Chip is not in the class
 * table and neither is Stepper, so a pass that read one static and then handed
 * over to C would lose the middle of the chain -- and, with it, the order that
 * makes EventNames()[0] the event a double click writes.
 *
 * Its own first, then Stepper's, then every widget's.
 */
class Chip extends Stepper {

    static Events         = ["Pressed"];
    static Options        = { Size: ["Small", "Large"] };
    static TextProperties = ["Legend"];

    /* Its own, beside its own statics: a subclass declares what it adds and
     * `Stepper` declares what it brought. */
    _size; _legend;

    get Size()  { return this._size || "Small"; }
    set Size(v) { this._size = String(v); }

    get Legend()  { return this._legend || ""; }
    set Legend(v) { this._legend = String(v); }
}
