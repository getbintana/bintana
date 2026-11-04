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

        /* The same two properties the Save button writes, then Save itself. */
        this.form.SpinInterval.Value = 1;
        this.form.SpinTimeout.Value  = 2000;
        this.form.saveConfig();

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
