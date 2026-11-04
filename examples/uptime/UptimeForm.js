/*
 * Uptime: every thirty seconds, ask a list of URLs and keep the answer.
 *
 *   Clock  a Timer, 30 s
 *   Db     a Connection, uptime.db
 *   Api    an HttpClient for the checks
 *
 * A failure is a row too -- status 0 and the message in `error` -- because the
 * question is *is it up*, and an exception is an answer.
 *
 *   ./build/bintana examples/uptime
 *   ./build/bintana examples/uptime --selftest   # local server, then close
 */
"use strict";

/* One check in the database.  This is the shape `Table` uses: the column
 * names come from `Naming`, the key is what `Save` follows, and `Insert` is
 * the insert.  `Record` + `Table` are the runtime's ORM; only the
 * `CREATE TABLE` below is still written by hand (the plan wants the shape to
 * write it, one day). */
class Check extends Record {
    static Naming = "snake";
    static Fields = {
        Id:     Field.Int({ key: true }),
        At:     Field.Text({ required: true }),
        Site:   Field.Text({ required: true }),
        Url:    Field.Text({ required: true }),
        Status: Field.Int(),
        Ms:     Field.Int(),
        Error:  Field.Text(),
    };
}

class UptimeForm extends Form {

    Form_Open() {
        this.selfTest = Application.Arguments.includes("--selftest");
        this.busy     = false;
        this.rounds   = 0;
        this.count    = 0;
        this.queue    = [];

        this.Db.Script(
            "CREATE TABLE IF NOT EXISTS checks (" +
            "id INTEGER PRIMARY KEY, at TEXT NOT NULL, site TEXT NOT NULL, " +
            "url TEXT NOT NULL, status INTEGER NOT NULL, " +
            "ms INTEGER NOT NULL, error TEXT NOT NULL)");

        /* The ORM: one shape, one table, no hand-built row. */
        this.Checks = this.Db.Table("checks", Check);

        for (const row of this.Checks.All()) {
            if (this.History.Count >= 200) this.History.RemoveRow(0);
            this.History.Add([row.Site, String(row.Status), String(row.Ms),
                              row.At, row.Error]);
            this.count++;
        }

        this.sites = this.loadSites();

        if (this.selfTest) {
            /* A server of our own, so the example runs the same way on a
             * machine with no network: one 200, one 500 and one refused port. */
            this.server = Http.Server({ Host: "local", Port: 0 });
            this.server.Request = (req) => {
                if (req.Path === "/ok")        req.Answer(200, "ok");
                else if (req.Path === "/fail") req.Answer(500, "not today");
                else                           req.Answer(404, "no");
            };
            this.server.Start();

            const base = this.server.Url.replace(/\/+$/, "");
            this.sites = [
                { Name: "local 200", Url: `${base}/ok` },
                { Name: "local 500", Url: `${base}/fail` },
                { Name: "closed",    Url: "http://127.0.0.1:1" },
            ];
            this.Clock.Delay = 500;
            this.Clock.Start();
        }

        this.LblStatus.Text = `every ${this.Clock.Delay / 1000} s — ${this.sites.length} sites`;
        this.poll();
    }

    loadSites() {
        const path = File.Join(Application.Directory, "sites.json");
        let sites;

        try {
            sites = File.LoadJson(path);
        } catch (e) {
            this.LblStatus.Text = `cannot read sites.json: ${e.message}`;
            return [];
        }

        if (!Array.isArray(sites) || sites.length === 0) {
            this.LblStatus.Text = "sites.json is empty";
            return [];
        }

        return sites.filter((s) => s && typeof s.Name === "string" &&
                                    typeof s.Url === "string");
    }

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
        if (this.busy || this.sites.length === 0 || !this.server && this.selfTest)
            return;

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
            if (this.selfTest && this.rounds >= 2) this.finish();
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
        if (this.selfTest) {
            print(`uptime: ${this.rounds} rounds, ${this.count} checks`);

            const path = File.Join(Application.Directory, this.Db.Path);
            this.Db.Close();
            try { File.Delete(path); } catch (e) { /* already gone */ }
        }

        if (this.server) {
            this.server.Stop();
            this.server = null;
        }
        this.Close();
    }

    Form_Close() {
        if (this.server) {
            this.server.Stop();
            this.server = null;
        }
    }
}
