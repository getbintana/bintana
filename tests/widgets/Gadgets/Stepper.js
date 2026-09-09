/*
 * A second Stepper, which is the point: it shares its short name with the one
 * at the project root and is a different class entirely.  What tells them apart
 * is the namespace -- an ordinary object on globalThis, declared here and not
 * deduced from the directory.
 */
Namespace("Gadgets");

Gadgets.Stepper = class Stepper extends Component {

    get Value() { return this._value || 0; }

    set Value(v) {
        /* Counts by tens, so a test can tell whose setter ran. */
        this._value = Number(v) || 0;
        this.Shown.Text = `${this._value}0`;
        this.Emit("Change", this._value);
    }

    Bump_Click() { this.Value = this.Value + 1; }
};
