/*
 * Back up a folder without freezing the window, and say so when it is done from
 * wherever the user happens to be looking.
 *
 * Three ideas in one small window, each in the line that carries it:
 *
 *     const t = new Packer();            // a thread of its own: Gzip is CPU
 *     t.Progress = (p) => this.took(p);  // counted while the window keeps turning
 *     Notification.Send(title, body);    // told from the desktop, not from here
 *
 * ## Why a notification and not a message
 *
 * `Message.Info` is modal: it takes the window, and a backup that finishes while
 * the user is in another program is exactly when a window that takes itself to the
 * front is the wrong thing. `Notification.Send` is the desktop's own toast, which
 * is where somebody who is elsewhere is already looking. [`examples/notify`] is the
 * other half of that sentence -- the message *inside* the window, for when it is
 * the one being looked at -- and an application of any size wants both.
 *
 * It is sent only when the window is **not** the one the user is in: a toast that
 * tells you what you are staring at is noise, and the status line already says it.
 * That is `this.Focused` on a form, which turns `false` the moment another window is
 * activated -- there is no separate "active" property, and none is needed. And it
 * needs the project's `id` in `project.json`, because a notification is sent in the
 * name of an application (the runtime refuses, saying so, when there is none).
 *
 * ## The rule the Stop button is about
 *
 * A task that is asked to stop **still ends**, so its answers still arrive. Stopping
 * and starting again are the same act -- the old run is over -- so **a run is
 * retired by its generation** (`gen`), and whatever a retired run says is dropped
 * where it lands. It is the same bookkeeping `examples/usage` documents at length,
 * and the reason no flag is kept.
 *
 * The words that a person reads go through `Locale.Text` **at the call site**, with
 * `{0}` holes: it is where the extractor looks, and the notification's own text is
 * not looked up by `Send`.
 *
 * Run it with `./build/bintana examples/backup`, or to start at once:
 * `./build/bintana examples/backup ~/Documents /tmp/documents-gz`.
 */
"use strict";

/* kB and not KiB, as the desktop's own file manager says it. */
function size(n) {
    if (!(n > 0)) return "0 B";

    const units = ["B", "kB", "MB", "GB", "TB"];
    let   v = n, at = 0;

    while (v >= 1000 && at < units.length - 1) {
        v /= 1000;
        at++;
    }
    return at === 0 ? `${v} B` : `${Locale.Number(v, 1)} ${units[at]}`;
}

class BackupForm extends Form {

    /* The run in flight, and the counter that says which run answers belong to. */
    job = null;
    gen = 0;

    /* What this run has seen, for the closing line. */
    unreadable = 0;

    Form_Open() {
        const [from, to] = Application.Arguments;

        this.TxtSource.Text = from || Environment.HomeDirectory;
        this.TxtTarget.Text = to || File.Join(Environment.HomeDirectory, "Backup");
        this.LblStatus.Text = Locale.Text("Choose a folder and press Back up.");

        /* Two arguments is a request to start, which is also how this is run
         * without a pointer. */
        if (from && to)
            this.start();
    }

    /* --- choosing -------------------------------------------------------- */

    BtnSource_Click() {
        Dialog.SelectFolder(Locale.Text("Which folder to back up"),
                            { Folder: this.TxtSource.Text },
                            (path) => { this.TxtSource.Text = path; });
    }

    BtnTarget_Click() {
        Dialog.SelectFolder(Locale.Text("Where to save the copies"),
                            { Folder: this.TxtTarget.Text },
                            (path) => { this.TxtTarget.Text = path; });
    }

    /* --- starting and stopping ------------------------------------------- */

    BtnStart_Click() { this.start(); }

    start() {
        const src = this.TxtSource.Text.trim();
        const dst = this.TxtTarget.Text.trim();

        if (!File.IsDir(src)) {
            Message.Error("{0} is not a folder.", src);
            return;
        }
        if (!dst) {
            Message.Error("Say where to save the copies.");
            return;
        }

        /* Copies written *inside* what is being copied are copied in turn, and
         * the run never ends -- so it is refused before anything is made, not
         * discovered at the thousandth file. */
        if (File.Within(dst, src)) {
            Message.Error("The copies cannot go inside the folder they are copies of.");
            return;
        }

        this.retire();
        Directory.Make(dst);

        const gen = this.gen;
        const t   = new Packer();

        /* Every answer asks whether its run is still the one that matters. */
        t.Progress = (p) => { if (gen === this.gen) this.took(p); };
        t.Done     = (r) => { if (gen === this.gen) this.finished(r); };
        t.Error    = (m) => { if (gen === this.gen) this.failed(m); };

        this.job = t;
        this.unreadable = 0;
        this.Bar.Value = 0;
        this.BtnStart.Enabled = false;
        this.BtnStop.Enabled  = true;
        this.LblStatus.Text   = Locale.Text("Reading {0} …", src);
        t.Start({ src, dst });
    }

    BtnStop_Click() {
        if (!this.job)
            return;

        this.retire();
        this.idle();
        this.LblStatus.Text = Locale.Text("Stopped. What was already copied is in place.");
    }

    /* The run is over, whatever it says from now on. `Stop()` asks the thread to
     * end and its answer still arrives; the generation is what drops it. */
    retire() {
        this.gen++;
        if (this.job) {
            this.job.Stop();
            this.job = null;
        }
    }

    idle() {
        this.BtnStart.Enabled = true;
        this.BtnStop.Enabled  = false;
    }

    /* --- what the task says ------------------------------------------------ */

    took(p) {
        if (!p.ok)
            this.unreadable++;
        this.Bar.Value      = p.total ? (p.done / p.total) * 100 : 0;
        this.LblStatus.Text = Locale.Text("{0} of {1}: {2}", p.done, p.total, p.rel);
    }

    finished(r) {
        this.job = null;
        this.idle();
        this.Bar.Value = 100;

        const problems = r.bad.length;
        const saved    = r.bytesIn > 0 ? Math.round((1 - r.bytesOut / r.bytesIn) * 100) : 0;
        const summary  = Locale.Text("{0} files, {1} → {2} ({3}% smaller)",
                                     r.files - problems, size(r.bytesIn), size(r.bytesOut), saved);

        this.LblStatus.Text = problems
            ? Locale.Text("{0} The copies of {1} files did not read back and were removed.", summary, problems)
            : summary;
        print(this.LblStatus.Text);

        this.tell(problems
            ? Locale.Text("Backup finished with problems")
            : Locale.Text("Backup finished"),
            this.LblStatus.Text, problems > 0);
    }

    failed(message) {
        this.job = null;
        this.idle();
        this.LblStatus.Text = Locale.Text("The backup stopped: {0}", message);
        this.tell(Locale.Text("Backup failed"), message, true);
    }

    /* A toast, when somebody is not looking at this window. */
    tell(title, body, urgent) {
        if (!this.ChkNotify.Active || this.Focused)
            return;

        Notification.Send(title, body, { Urgency: urgent ? "High" : "Normal",
                                         Icon: "drive-harddisk-symbolic" });
    }
}
