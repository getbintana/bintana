/*
 * Uptime: every thirty seconds, ask a list of URLs and keep the answer.
 *
 *   Clock  a Timer, 30 s by default
 *   Db     a Connection, uptime.db
 *   Checks a Model: Check.record, the history
 *   Sites  a Model: Site.record, seeded from sites.json the first time
 *   Config a Model: Config.record, the interval and the timeout
 *   Api    an HttpClient for the checks
 *
 * The first time the database is created, `sites.json` becomes rows in the
 * `sites` table and `Seeded` makes that a one-time import; after that the
 * table is the source and the file can be edited without changing the
 * monitor.
 *
 * A failure is a row too -- status 0 and the message in `error` -- because the
 * question is *is it up*, and an exception is an answer.
 *
 * The settings live in a popover behind the button beside *Check now*.  The
 * one thing a selftest changes is in `SelfTest.js`, so this class is the same
 * program either way.
 *
 *   ./build/bintana examples/uptime
 *   ./build/bintana examples/uptime --selftest   # local server, then close
 */
"use strict";

class UptimeForm extends Form {

    Form_Open() {
        this.busy   = false;
        this.rounds = 0;
        this.count  = 0;
        this.queue  = [];

        this.settings = new UptimeSettings();
        this.settings.On("Save", (interval, timeout) =>
            this.saveConfig(interval, timeout));

        /* The form's Models are parts over the one `Db` connection and the
         * `.record` shapes beside this file; the first use creates each table
         * from its shape. */
        this.config = this.loadConfig();
        if (!this.config.Seeded) this.seedSites();
        this.sites = this.Sites.All().filter((s) => s.Active);

        for (const row of this.Checks.All()) {
            if (this.History.Count >= 200) this.History.RemoveRow(0);
            this.History.Add([row.Site, String(row.Status), String(row.Ms),
                              row.At, row.Error]);
            this.count++;
        }

        this.applyConfig(this.config);

        this.test = SelfTest.For(this);
        this.test.start();
        this.poll();
    }

    /* --- the settings popover ---------------------------------------------- */

    BtnSettings_Click() {
        if (Popover.IsOpen(this.settings)) {
            Popover.Close(this.settings);
            return;
        }
        Popover.Show(this.settings, this.BtnSettings, { Position: "Bottom" });
    }

    /* The one row of settings.  A new database gets it, and `Seeded` says
     * whether `sites.json` has already been imported into the sites table. */
    loadConfig() {
        let cfg = this.Config.Find(1);

        if (!cfg) {
            cfg = new Config({ Id: 1, Interval: 30, Timeout: 5000, Seeded: false });
            this.Config.Insert(cfg);
        }
        return cfg;
    }

    /*
     * The first run of a new database: `sites.json` becomes rows in `sites`,
     * and `Seeded` makes that a one-time act.  A later start reads the table,
     * not the file.
     */
    seedSites() {
        const path = File.Join(Application.Directory, "sites.json");
        let rows;

        try {
            rows = File.LoadJson(path);
        } catch (e) {
            this.LblStatus.Text = `cannot read sites.json: ${e.message}`;
            return;
        }
        if (!Array.isArray(rows)) return;

        let imported = 0;
        for (const row of rows) {
            if (!row || typeof row.Name !== "string" || typeof row.Url !== "string")
                continue;
            this.Sites.Insert(new Site({
                Name: row.Name, Url: row.Url, Active: true,
            }));
            imported++;
        }

        this.config.Seeded = true;
        this.Config.Save(this.config);
        this.LblStatus.Text = imported
            ? `imported ${imported} sites from sites.json`
            : "sites.json has no sites";
    }

    applyConfig(cfg) {
        const interval = Math.max(1, Number(cfg.Interval) || 30);
        const timeout  = Math.max(100, Number(cfg.Timeout) || 5000);

        this.settings.Interval = interval;
        this.settings.Timeout  = timeout;
        this.Api.Timeout       = timeout;
        this.Clock.Delay        = interval * 1000;
        this.Clock.Start();
        this.LblStatus.Text = `every ${interval} s — ${this.sites.length} sites`;
    }

    saveConfig(interval, timeout) {
        this.config.Interval = interval === undefined ? this.settings.Interval : interval;
        this.config.Timeout  = timeout  === undefined ? this.settings.Timeout  : timeout;
        this.Config.Save(this.config);
        this.applyConfig(this.config);
        this.LblStatus.Text = `saved: every ${this.config.Interval} s, ${this.config.Timeout} ms`;
        Popover.Close(this.settings);
    }

    /* --- the checks -------------------------------------------------------- */

    Clock_Tick() {
        this.poll();
    }

    BtnCheck_Click() {
        this.poll();
    }

    /*
     * One site at a time: a list of ten sites is not ten requests at once, and
     * `busy` means a slow answer cannot stack a second round on top of itself.
     */
    poll() {
        if (this.busy || this.sites.length === 0) return;

        this.busy  = true;
        this.queue = this.sites.slice();
        this.next();
    }

    next() {
        const site = this.queue.shift();
        if (!site) {
            this.busy = false;
            this.rounds++;
            this.LblStatus.Text = `round ${this.rounds} — ${this.count} checks`;
            this.test.afterRound();
            return;
        }

        const started = Date.now();
        this.Api.Get(site.Url, {}, (res) => {
            const error = res.Status >= 400
                ? (res.Reason || `HTTP ${res.Status}`) : "";
            this.record(site, res.Status, Date.now() - started, error);
            this.next();
        }, (message) => {
            const text = message && typeof message.Message === "string"
                ? message.Message : String(message);
            this.record(site, 0, Date.now() - started, text);
            this.next();
        });
    }

    record(site, status, ms, error) {
        const at = Time.Now;

        this.Checks.Insert(new Check({
            At: at, Site: site.Name, Url: site.Url,
            Status: status, Ms: ms, Error: error,
        }));
        this.History.Add([site.Name, String(status), String(ms), at, error]);
        this.count++;

        /* The table is a window, not the record: the database keeps all of it. */
        if (this.History.Count > 200) this.History.RemoveRow(0);
    }

    finish() {
        this.test.finish();
        this.Close();
    }

    Form_Close() {
        if (this.test) this.test.stop();
    }
}
