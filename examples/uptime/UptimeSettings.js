/*
 * The settings popover's content: its own `.form` and a small class.
 *
 * The host makes this component once and asks `Popover.Show` to float it over
 * the button.  `Interval` and `Timeout` are ordinary properties; `Sites` is
 * the list the host gives it, and Add/Remove are events the host turns into
 * `Site` records.  Nothing here opens the database.
 */
"use strict";

class UptimeSettings extends Component {

    static Events = ["Save", "AddSite", "RemoveSite"];

    _sites = [];

    get Interval() { return this.SpinInterval.Value.Number(); }
    set Interval(value) { this.SpinInterval.Value = value; }

    get Timeout() { return this.SpinTimeout.Value.Number(); }
    set Timeout(value) { this.SpinTimeout.Value = value; }

    get Sites() { return this._sites; }
    set Sites(list) {
        this._sites = list || [];
        this.TblSites.Clear();
        for (const site of this._sites)
            this.TblSites.Add([site.Name, site.Url]);
    }

    BtnAdd_Click() {
        const name = this.TxtName.Text.trim();
        const url  = this.TxtUrl.Text.trim();

        if (!name || !url) return;
        this.Emit("AddSite", name, url);
        this.TxtName.Text = "";
        this.TxtUrl.Text  = "";
    }

    BtnRemove_Click() {
        const at = this.TblSites.Index;
        if (at >= 0) this.Emit("RemoveSite", at);
    }

    BtnSave_Click() {
        this.Emit("Save", this.Interval, this.Timeout);
    }
}
