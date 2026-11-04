/*
 * The one thing the example does differently under `--selftest`:
 *
 *   - it saves a configuration through the form (the settings popover's own
 *     code path),
 *   - it starts a local server with a 200, a 500 and a refused port,
 *   - it runs two rounds and removes `uptime.db`.
 *
 * Keeping it here leaves `UptimeForm` with the application's story: it calls
 * `SelfTest.For(this)` and then `start`, `afterRound` and `stop` without
 * asking whether it is a test.
 */
"use strict";

export class SelfTest {

    static For(form) {
        return new SelfTest(form, Application.Arguments.includes("--selftest"));
    }

    constructor(form, active) {
        this.form   = form;
        this.active = active;
        this.server = null;
    }

    start() {
        if (!this.active) return;

        /* The same event the Save button raises; the host's handler saves. */
        this.form.settings.Emit("Save", 1, 2000);

        /* Add and remove one site through the editor, so both gestures and the
         * Site/Table round trip are exercised; the list ends as it started. */
        this.form.settings.TxtName.Text = "selftest";
        this.form.settings.TxtUrl.Text  = "http://127.0.0.1:1";
        this.form.settings.BtnAdd_Click();
        this.form.settings.TblSites.Index = this.form.settings.Sites.length - 1;
        this.form.settings.BtnRemove_Click();

        this.server = Http.Server({ Host: "local", Port: 0 });
        this.server.Request = (req) => {
            if (req.Path === "/ok")        req.Answer(200, "ok");
            else if (req.Path === "/fail") req.Answer(500, "not today");
            else                           req.Answer(404, "no");
        };
        this.server.Start();

        const base = this.server.Url.replace(/\/+$/, "");
        this.form.sites = [
            { Name: "local 200", Url: `${base}/ok` },
            { Name: "local 500", Url: `${base}/fail` },
            { Name: "closed",    Url: "http://127.0.0.1:1" },
        ];
        this.form.Clock.Delay = 500;
        this.form.Clock.Start();

        /* The popover needs a shown anchor, so open and close it once now. */
        Timer.After(0, () => {
            this.form.BtnSettings_Click();
            Timer.After(50, () => Popover.Close(this.form.settings));
        });
    }

    afterRound() {
        if (this.active && this.form.rounds >= 2) this.form.finish();
    }

    finish() {
        if (!this.active) return;

        print(`uptime: ${this.form.rounds} rounds, ${this.form.count} checks`);

        const path = File.Join(Application.Directory, this.form.Db.Path);
        this.form.Db.Close();
        try { File.Delete(path); } catch (e) { /* already gone */ }
        this.stop();
    }

    stop() {
        if (this.server) {
            this.server.Stop();
            this.server = null;
        }
    }
}
