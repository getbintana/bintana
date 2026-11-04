/*
 * Pulse: a Timer, a Connection and an HttpClient on one form.
 *
 * The form declares its three non-visual parts in the `.form` and this class
 * only says what they do:
 *
 *   Clock  a Timer, once a second
 *   Db     a Connection, the SQLite file the beats are kept in
 *   Api    an HttpClient, pointed at the little server this form starts
 *
 * The server is here so the example runs on its own: one process, one port,
 * no network and no service to install.  A real application would point
 * `Api.BaseUrl` at its own backend instead.
 *
 *   ./build/bintana examples/pulse
 *   ./build/bintana examples/pulse --selftest    # three beats, then close
 */
"use strict";

class PulseForm extends Form {

    Form_Open() {
        this.busy     = false;
        this.rows     = 0;
        this.servers  = 0;
        this.selfTest = Application.Arguments.includes("--selftest");

        this.server = Http.Server({ Host: "local", Port: 0 });
        this.server.Request = (req) => {
            if (req.Method !== "GET" || req.Path !== "/pulse") {
                req.Answer(404, "not here");
                return;
            }

            this.servers++;
            req.Answer(200,
                       JSON.stringify({ Beat: this.servers, At: Time.Now }),
                       { ContentType: "application/json" });
        };
        this.server.Start();

        /* The part was declared with no URL because the port is not known
         * until the server starts.  Assigning it drops the client that the
         * part had not made yet, and the next request uses the real one. */
        this.Api.BaseUrl = this.server.Url;
        this.Db.Query("CREATE TABLE IF NOT EXISTS pulse (" +
                      "at TEXT NOT NULL, beat INTEGER NOT NULL)");

        this.LblStatus.Text = `listening on ${this.server.Url}`;
        this.poll();
    }

    Clock_Tick() {
        this.poll();
    }

    BtnPoll_Click() {
        this.poll();
    }

    poll() {
        if (this.busy || !this.server) return;
        this.busy = true;

        this.Api.Get("/pulse", {}, (res) => {
            this.busy = false;
            if (res.Status !== 200) {
                this.LblStatus.Text = `HTTP ${res.Status}`;
                return;
            }

            let beat;
            try {
                beat = JSON.parse(res.Body.ToText());
            } catch (e) {
                this.LblStatus.Text = `not JSON: ${e.message}`;
                return;
            }

            this.Db.Execute("INSERT INTO pulse (at, beat) VALUES (?, ?)",
                            [beat.At, beat.Beat]);
            this.rows++;

            this.LblBeat.Text = `beat ${beat.Beat} at ${beat.At}`;
            this.LblRows.Text = `${this.rows} rows in ${this.Db.Path}`;

            if (this.selfTest && this.rows >= 3) this.finish();
        }, (message) => {
            this.busy = false;
            this.LblStatus.Text = `error: ${message}`;
        });
    }

    finish() {
        if (this.selfTest) print(`pulse: ${this.rows} beats kept`);

        /* The test run keeps no database behind: it closes the part first, so
         * the file is not held by the connection when it is removed. */
        if (this.selfTest) {
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
