/*
 * Http on a window, against JokeAPI (https://v2.jokeapi.dev -- free, no key).
 *
 * The point beside the jokes is the shape an async request takes on a form:
 * the window never freezes (`Get`, not `GetWait` -- the blocking spelling is
 * for console tools), the button goes quiet while one is in flight, and
 * `Form_Close` stops what is still running, since a job outlives the form that
 * asked for it and its callbacks close over `this`.
 *
 * A cancelled request still answers. `Stop()` asks, it does not undo: the
 * `onError` arrives a turn of the loop later, by which time the request that
 * replaced it is already in flight. So both callbacks check the handle they
 * are handed against the one we are waiting for, and a stale answer is
 * dropped -- otherwise asking twice quickly leaves the status reading a
 * failure while a good request is still on its way. It is the second
 * argument for exactly this.
 *
 * Two things worth noticing. The categories are API values, so they are filled
 * from code: an `Items` written in the `.form` would go through the catalogue,
 * and a translated category is a value the server does not know. And the joke
 * answers in two shapes -- `single` is one string, `twopart` is a setup and a
 * delivery -- so showing it branches on `type` rather than hoping.
 *
 * Run it with `./build/bintana examples/jokes`. It needs the network, and says
 * so in the status line when it has none.
 */
"use strict";

class JokesForm extends Form {
    Form_Open() {
        this._api = Http.Client({ BaseUrl: "https://v2.jokeapi.dev", Timeout: 15000 });
        this._req = null;
        this.CmbCategory.Items = ["Any", "Programming", "Misc", "Pun", "Spooky", "Christmas"];
        this.CmbCategory.Index = 0;
        this.tellJoke();
    }

    Form_Close() {
        if (this._req && this._req.Running)
            this._req.Stop();
        /* Forgotten, not just stopped: the cancel answers after this, and a
         * handler touching a control on a closed form is the crash. */
        this._req = null;
    }

    BtnJoke_Click() {
        this.tellJoke();
    }

    CmbCategory_Select() {
        this.tellJoke();
    }

    tellJoke() {
        if (this._req && this._req.Running)
            this._req.Stop();
        const cat = this.CmbCategory.Text || "Any";
        let url = `/joke/${cat}`;

        if (this.ChkSafe.Active)
            url += "?safe-mode";
        this.BtnJoke.Enabled = false;
        this.LblStatus.Text = "Asking…";
        this._req = this._api.Get(url, {},
                                  (r, h) => this.show(r, h),
                                  (e, h) => this.showError(e, h));
    }

    show(r, handle) {
        /* Not the one we are waiting for: a request we stopped, answering
         * late. Whoever replaced it owns the status line now. */
        if (handle !== this._req)
            return;
        this.BtnJoke.Enabled = true;
        if (r.Status !== 200) {
            this.LblStatus.Text = `The API answered ${r.Status} ${r.Reason}`;
            return;
        }
        let j = null;

        try {
            j = JSON.parse(r.Body.ToText());
        } catch (e) {
            this.LblStatus.Text = "The API answered something that is not JSON";
            return;
        }
        if (j.error) {
            this.LblStatus.Text = j.message || "The API said no";
            return;
        }
        this.LblJoke.Text = j.type === "single" ? j.joke : `${j.setup}\n\n${j.delivery}`;
        this.LblStatus.Text = `${j.category} · #${j.id}`;
    }

    showError(e, handle) {
        if (handle !== this._req)
            return;
        this.BtnJoke.Enabled = true;
        this.LblStatus.Text = `Offline? ${e.Kind}: ${e.Message}`;
    }
}
