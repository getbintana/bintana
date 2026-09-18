/*
 * A component: its own .form, its own class, used inside another form as if it
 * were a control.  Value is an ordinary accessor, which is what makes it
 * settable from a .form and saved back into one.
 *
 * The three statics are the rest of what a control says about itself.  A
 * property is discoverable because it is *there*; what a class raises, what one
 * of its properties accepts and which of its strings a person reads are
 * declarations, and a class written in JS has nowhere else to put them -- the
 * walks behind EventNames(), PropertyOptions() and TextProperties() look a
 * prototype up in the class table, and this class is not in it.
 */
class Stepper extends Component {

    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];

    /* And its fields are declared, which is the fourth thing a component says
     * about itself: under `--strict` it is sealed once it is built, so a field
     * it only creates when somebody first assigns the property would throw
     * there. `.form`s set `Value` and so hid it; `Step` and `Caption` are the
     * two nothing here sets. `docs/plans/strict-plan.md`. */
    _value; _step; _caption;

    get Value() { return this._value || 0; }

    set Value(v) {
        this._value = Number(v) || 0;
        this.Shown.Text = String(this._value);
        /* What it says to whoever holds it: arrives as Name_Change. */
        this.Emit("Change", this._value);
    }

    /* One with a closed list of values, and one that holds prose: what the two
     * remaining statics are about. */
    get Step()  { return this._step || "1"; }
    set Step(v) { this._step = String(v); }

    get Caption()  { return this._caption || ""; }
    set Caption(v) { this._caption = String(v); }

    Down_Click() { this.Value = this.Value - 1; }
    Up_Click()   { this.Value = this.Value + 1; }
}
