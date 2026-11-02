/*
 * A download manager: several downloads at once, each in a `Task`, and the
 * two ways of stopping them.
 *
 *     t.Start(msg, { Cancellable: this.all, Timeout: ms });
 *
 *     ✕ on a row       t.Stop()          ends that download alone
 *     its Timeout      the guard         ends that download alone
 *     Cancel all       this.all.Cancel() ends every download holding the token
 *
 * ## The token goes one way
 *
 * Every download shares one `Cancellable`, and raising it stops all of them --
 * that is what sharing it is for. The other direction does not exist: stopping
 * one download, or one download running out of time, ends that task and leaves
 * the token as it was, so its siblings go on and `this.all.Cancelled` still
 * means *somebody pressed Cancel all*. A download that should not be stopped
 * by the button is simply started without the token.
 *
 * A raised token stays raised -- `Cancelled` is a fact about the past, not a
 * switch -- so pressing Cancel all also makes a new one for what is added
 * afterwards.
 *
 * ## HTTP/1.1, on purpose
 *
 * `Form_Open` sets `SOUP_FORCE_HTTP1` before the first request. Over HTTP/2,
 * which almost every https server speaks, libsoup sees a cancel only when the
 * stream next has traffic: the ✕, the timeout and Cancel all would all report
 * the right ending, but when the server answered and not when they were
 * pressed. See `Http.md`, *Cancelling over HTTP/2*, in bintana-docs.
 *
 * ## Telling the endings apart
 *
 * Every task answers exactly once, `Done` or `Error`, and how it ended is read
 * off `TimedOut` and `Cancelled` rather than by matching the message. Try it
 * with a slow URL (`https://httpbin.org/delay/8`) and a timeout of five
 * seconds, and with a large file and the ✕.
 *
 * Run it with `./build/bintana examples/downloads`. The files go to
 * `~/Downloads/bintana-downloads`.
 */
"use strict";

function size(n) {
    if (!(n > 0)) return "0 B";

    const units = ["B", "kB", "MB", "GB"];
    let   v = n, at = 0;

    while (v >= 1000 && at < units.length - 1) {
        v /= 1000;
        at++;
    }
    return at === 0 ? `${v} B` : `${Locale.Number(v, 1)} ${units[at]}`;
}

/* A file name out of the URL's last segment, numbered so two downloads of one
 * name do not overwrite each other; letters, digits and `._-` only, so a name
 * that is data cannot climb out of the folder. */
const SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";

function nameOf(url, n) {
    const rest  = url.split("://")[1].split("?")[0].split("#")[0];
    const parts = rest.split("/");
    const last  = parts.length > 1 ? parts[parts.length - 1] : "";
    let   safe  = "";

    for (const ch of last)
        safe += SAFE.includes(ch) ? ch : "_";
    return safe && !safe.startsWith(".") ? `${n}-${safe}` : `${n}-download`;
}

class DownloadsForm extends Form {

    /* The token every download added from now on shares. */
    all = new Cancellable();

    /* Downloads made so far, to number the files; and how many are running. */
    made    = 0;
    running = 0;

    Form_Open() {
        /* Every button here cancels, and over HTTP/2 -- what an https server
         * offers -- libsoup notices a cancel only when the server next sends
         * something. HTTP/1.1 notices at once. libsoup reads this once, at the
         * first connection, for the whole process and its tasks. */
        Environment.Set("SOUP_FORCE_HTTP1", "1");

        this.dir = File.Join(Environment.HomeDirectory, "Downloads", "bintana-downloads");
        this.TxtUrl.Text = "https://httpbin.org/delay/8";
        this.LblStatus.Text = Locale.Text("Files are saved in {0}", this.dir);
        this.idle();
    }

    TxtUrl_Activate() { this.add(); }
    BtnAdd_Click()    { this.add(); }

    add() {
        const url = this.TxtUrl.Text.trim();

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Message.Error("{0} is not an http or https address.", url);
            return;
        }
        Directory.Make(this.dir);

        const t   = new Fetcher();
        const row = this.row(url, t);
        const ms  = this.SpnTimeout.Value * 1000;

        t.Done  = (r) => this.ended(row, Locale.Text("done, {0}", size(r.size)));
        t.Error = (m) => this.ended(row,
            t.TimedOut  ? Locale.Text("timed out") :
            t.Cancelled ? Locale.Text("cancelled") :
                          Locale.Text("failed: {0}", m));

        this.made++;
        this.running++;
        this.idle();
        t.Start({ url, path: File.Join(this.dir, nameOf(url, this.made)) },
                { Cancellable: this.all, Timeout: ms > 0 ? ms : undefined });
    }

    /* One row: the address, what became of it, and its own ✕. */
    row(url, t) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 8;
        row.Margin  = 4;
        this.List.Add(row);

        const name = new Label();
        name.Text      = url;
        name.HExpand   = true;
        name.Ellipsize = true;
        row.Add(name);

        const state = new Label();
        state.Text  = Locale.Text("downloading…");
        state.Style = "dim-label";
        row.Add(state);

        const stop = new Button();
        stop.Icon    = "window-close-symbolic";
        stop.Style   = "flat";
        stop.Tooltip = Locale.Text("Stop this download only");
        stop.On("Click", () => t.Stop());
        row.Add(stop);

        return { state, stop };
    }

    ended(row, text) {
        row.state.Text   = text;
        row.stop.Enabled = false;
        this.running--;
        this.idle();
    }

    BtnCancelAll_Click() {
        this.all.Cancel();
        /* Raised for good: what is added next gets a token of its own. */
        this.all = new Cancellable();
    }

    BtnClear_Click() {
        if (this.running > 0)
            return;
        this.List.Clear();
    }

    idle() {
        this.BtnCancelAll.Enabled = this.running > 0;
        this.BtnClear.Enabled     = this.running === 0;
    }
}
