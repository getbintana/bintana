/*
 * What is taking up the space, and the point of it is that a long job is not a
 * frozen window.
 *
 * `du` on a real folder takes seconds and sometimes minutes.  There are two ways
 * to write this window and only one of them is a window:
 *
 *   - **`Exec.Wait`** — one line, blocking, and the whole application stops
 *     dead until the child is finished.  No output while it runs, no Stop
 *     button, and GTK does not even repaint: the window goes grey and the
 *     desktop offers to kill it.  It is the right shape for the test suite,
 *     which has nothing on screen, and the wrong one for anything that does.
 *   - **`Exec` with two callbacks** — a line at a time as they arrive, and one
 *     more when the child is done.  The loop keeps turning, so the counter moves,
 *     Escape still works, and the window can be resized while it reads.
 *
 * This is the second.  The whole of the asynchrony is those two callbacks and
 * `Stop()`:
 *
 *     this.job = Exec(["du", …], (line) => this.took(line),
 *                                (code) => this.finished(code));
 *     this.job.Stop();          // and the exit callback still arrives
 *
 * ## The rule the Stop button is really about
 *
 * A child that is asked to stop **still ends**, so the exit callback still runs
 * — that is the whole reason there is one place that clears up and not two.
 * `finished` cannot ask *did it work?* and answer from the exit code alone: a
 * `du` that was stopped exits non-zero exactly like a `du` that failed, and one
 * that hit an unreadable folder exits non-zero having done its job perfectly.
 * So the flag `stopping` is what tells those apart, and it is set where the
 * asking happens rather than guessed at afterwards.
 *
 * ## What the rows come from, and why they are built at the end
 *
 * The lines arrive in the order `du` walks the disk, which is not an order
 * anybody wants to read; the list is sorted biggest-first, so it cannot be built
 * until the last line is in.  What arrives *during* is a count, which is the
 * honest thing to show for a job whose length nobody knows — the same reason
 * `ProgressBar.Pulse()` exists.
 *
 * The bars are real `ProgressBar`s, one per row, each a share of the total.  It
 * is the one place a percentage is the right thing to draw: *this folder is a
 * third of that one* is a comparison a number makes you do in your head.
 *
 * ## What this example measured for `docs/async-plan.md`
 *
 * The plan names *progress **and** sequencing* as one of the five things that
 * would reopen the question of `async`/`await`, on the grounds that `Exec.Wait`
 * gives up the line callback and so that combination has no answer.  This window
 * is that combination — a long child reporting while it runs, followed by work
 * that needs its result — and it is **two callbacks and no nesting**, because
 * the second step is not another child: it is sorting an array.
 *
 * What it did find is the shape nobody had written down: **the natural thing to
 * do while a child runs is not to start a second one, it is to cancel the first.**
 * Opening a folder while a `du` is still going does not want *both*; it wants
 * `Stop()` and a new one.  The plan lists *two children at once* as a trigger and
 * says nothing has ever asked — this is one more program not asking, and saying
 * why.
 *
 * Run it with `./build/bintana examples/usage`, or on a folder of your own:
 * `./build/bintana examples/usage ~/Documents`.
 */
"use strict";

/*
 * `--block-size=1` so the numbers are bytes and this file does the spelling;
 * `--max-depth=1` so the answer is one line per child plus the folder itself;
 * `-x` so a mounted disk under here is somebody else's question and a network
 * share cannot make this hang for a minute.
 *
 * `argv` is an array and there is no shell, so a folder called `My Documents`
 * or one with a quote in it needs no quoting and cannot become two arguments.
 */
const DU = ["du", "-x", "--max-depth=1", "--block-size=1"];

/* kB and not KiB, because this sits next to the desktop's own file manager and
 * that is the number it shows. */
function bytes(n) {
    if (!(n > 0)) return "0 B";

    const units = ["B", "kB", "MB", "GB", "TB"];
    let   size  = n;
    let   at    = 0;

    while (size >= 1000 && at < units.length - 1) {
        size /= 1000;
        at++;
    }
    return at === 0 ? `${size} B` : `${Locale.Number(size, 1)} ${units[at]}`;
}

class UsageForm extends Form {

    /* Where we are. Empty until something has been measured. */
    folder = "";

    /* The child, while there is one — and the flag that says the *user* ended
     * it, since the exit code cannot tell that from a failure. */
    job      = null;
    stopping = false;

    /* What the child has said so far: `{ path, name, size }`, and the size of
     * the folder itself, which `du` writes as its own last line. */
    found = [];
    total = 0;

    /* One entry per row, in row order, for the same reason `examples/files` has
     * one: what a row is for is not a question a row can answer. */
    shown = [];

    Form_Open() {
        if (!Application.HasCommand("du")) {
            Message.Error("This example needs {0}, and there is none here.", "du");
            return;
        }
        this.open(Application.Arguments[0] || Environment.HomeDirectory);
    }

    /* --- starting and stopping ---------------------------------------------- */

    open(folder) {
        if (!File.IsDir(folder)) {
            Message.Error("{0} is not a folder.", folder);
            return;
        }

        /* One at a time. Opening a folder while something is still being read is
         * not a request for both — it is a change of mind, so the old child is
         * ended and its exit callback finds a run nobody is waiting for. */
        this.stop();

        this.folder = File.Absolute(folder);
        this.LblPath.Text  = this.folder;
        this.BtnUp.Enabled = File.Directory(this.folder) !== this.folder;

        this.found = [];
        this.total = 0;
        this.shown = [];
        this.List.Clear();
        this.BtnOpen.Enabled = false;

        this.job = Exec(DU.concat([this.folder]),
                        (line) => this.took(line),
                        (code) => this.finished(code));

        this.BtnStop.Enabled = true;
        this.LblStatus.Text  = Locale.Text("Reading {0}…", this.folder);
    }

    /*
     * Ends the child if there is one, and says so first.
     *
     * `Stop()` is SIGTERM, which `du` obeys; `Kill()` is there for a child that
     * does not, and asking politely first is the difference between a program
     * that ends and one that is shot. Nothing here waits for it: the exit
     * callback is what arrives, whichever of the two got it.
     */
    stop() {
        if (!this.job || !this.job.Running) return;

        this.stopping = true;
        this.job.Stop();
    }

    BtnStop_Click()   { this.stop(); }
    BtnUp_Click()     { this.open(File.Directory(this.folder)); }

    BtnChoose_Click() {
        Dialog.SelectFolder(Locale.Text("Which folder to measure"),
                            { Folder: this.folder || Environment.HomeDirectory },
                            (path) => this.open(path));
    }

    /* --- what the child says ------------------------------------------------
     *
     * One call per line, while the loop keeps turning. A line and nothing that
     * is not a line: this runs often — tens of thousands of times on a big tree
     * — so anything expensive here is paid for once per folder on the disk.
     */
    took(line) {
        /* `du` writes `<bytes>\t<path>`, and everything else it writes is a
         * complaint on stderr about a folder it could not read. Those arrive on
         * the same stream because merged is what keeps the order, and a line
         * that does not parse is one of them. */
        const tab = line.indexOf("\t");
        if (tab < 0) return;

        const size = Number(line.slice(0, tab));
        const path = line.slice(tab + 1);
        if (!(size >= 0)) return;

        /* The folder's own line is the total, and `du` writes it last. */
        if (path === this.folder) {
            this.total = size;
            return;
        }

        this.found.push({ path, name: File.Name(path), size });
        this.LblStatus.Text = Locale.Plural("Reading… {0} folder so far",
                                            "Reading… {0} folders so far",
                                            this.found.length);
    }

    /*
     * And once, when the child is gone — however it went.
     *
     * **Three endings, and the exit code tells apart only two of them.** A `du`
     * that was stopped and a `du` that failed both exit non-zero; a `du` that
     * could not read one folder out of nine hundred also exits non-zero, having
     * done exactly what was asked. So `stopping` is read first, and after that a
     * run that produced rows is a run that worked whatever its status was.
     */
    finished(code) {
        this.job = null;
        this.BtnStop.Enabled = false;

        if (this.stopping) {
            this.stopping = false;
            this.LblStatus.Text = Locale.Text("Stopped.");
            return;
        }

        if (!this.found.length) {
            this.LblStatus.Text = code === 0
                ? Locale.Text("Nothing in there.")
                : Locale.Text("du ended with {0} and read nothing.", code);
            return;
        }

        /* Biggest first, which is the only order this list is for — and the
         * reason the rows could not be built as the lines arrived. */
        this.found.sort((a, b) => b.size - a.size);
        this.fill();

        this.LblStatus.Text = code === 0
            ? Locale.Text("{0} in {1}", bytes(this.total),
                          Locale.Plural("{0} folder", "{0} folders", this.found.length))
            : Locale.Text("{0} in {1} — and some of it could not be read",
                          bytes(this.total),
                          Locale.Plural("{0} folder", "{0} folders", this.found.length));
    }

    /* --- the rows ----------------------------------------------------------- */

    fill() {
        this.shown = this.found;
        for (const one of this.shown) this.List.Add(this.row(one));

        this.List.Index = -1;
        this.BtnOpen.Enabled = false;
    }

    row(one) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 10;
        row.Margin  = 5;

        /*
         * A share of the whole, drawn rather than written. *This folder is a
         * third of that one* is a comparison a column of numbers makes you do in
         * your head, and the bar is the one place a percentage is the right
         * thing to show.
         */
        const bar = new ProgressBar();
        bar.Value = this.total > 0 ? (one.size / this.total) * 100 : 0;
        bar.Width = 120;
        row.Add(bar);

        const name = new Label();
        name.Text      = one.name;
        name.HExpand   = true;
        name.Ellipsize = true;
        row.Add(name);

        const size = new Label();
        size.Text      = bytes(one.size);
        size.Alignment = "Right";
        size.Width     = 100;
        size.Style     = "dim-label";
        row.Add(size);

        return row;
    }

    get selected() {
        const at = this.List.Index;
        return at < 0 ? null : this.shown[at];
    }

    List_Select() {
        this.BtnOpen.Enabled = this.selected !== null;
    }

    BtnOpen_Click() {
        const one = this.selected;
        if (one) this.open(one.path);
    }

}
