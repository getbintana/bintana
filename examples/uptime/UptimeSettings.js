/*
 * The settings popover's content: its own `.form` and a small class.
 *
 * The host builds no controls; it makes this component once and asks
 * `Popover.Show` to float it over the button.  `Interval` and `Timeout` are
 * ordinary properties, so the grid could edit them too, and `Save` is the
 * event the host listens to.
 */
"use strict";

class UptimeSettings extends Component {

    static Events = ["Save"];

    get Interval() { return this.SpinInterval.Value; }
    set Interval(value) { this.SpinInterval.Value = value; }

    get Timeout() { return this.SpinTimeout.Value; }
    set Timeout(value) { this.SpinTimeout.Value = value; }

    BtnSave_Click() {
        this.Emit("Save", this.Interval, this.Timeout);
    }
}
