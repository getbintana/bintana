/*
 * What is taking up the space, and the point of it is that a long job is not a
 * frozen window.
 *
 * This used to shell out to `du`: one child, one line at a time, and done.
 * It now fans out to one `Task` per handful of top-level folders instead --
 * N threads walking N subtrees, each reporting finished roots while the loop
 * keeps turning, so the counter moves, Escape still works, and the window can
 * be resized while it reads.  No dependency (`du` is Unix-only; this runs on
 * Windows too), and the whole of the asynchrony is still two properties and
 * `Stop()`:
 *
 *     const t = new Sizer();
 *     t.Progress = (p) => this.took(p);
 *     t.Done     = (r) => this.finished();
 *     t.Stop();          // and the Error callback still arrives
 *
 * ## The rule the Stop button is really about
 *
 * A task that is asked to stop **still ends**, so its Error callback still
 * arrives -- and with N tasks running, so do the other N-1.  `finished`
 * cannot ask *did it work?* from the outcome alone either: a task that was
 * stopped reports Cancelled exactly like a task whose folder vanished, and
 * one that hit an unreadable folder reports errors having done its job
 * perfectly.
 *
 * So neither question is asked.  **A run is retired by its generation**, and
 * an answer from a retired one is dropped where it lands, whatever it says.
 * Stopping and opening another folder are the same act -- the old run is
 * over -- and one counter says so for both.  The flag this used to keep
 * instead is the mistake `retire()` documents.
 *
 * ## What the rows come from, and why they are built at the end
 *
 * The roots arrive in the order the filesystem lists them, which is not an
 * order anybody wants to read; the list is sorted biggest-first, so it cannot
 * be built until the last task is in.  What arrives *during* is a count, which
 * is the honest thing to show for a job whose length nobody knows -- the same
 * reason `ProgressBar.Pulse()` exists.
 *
 * The bars are real `ProgressBar`s, one per row, each a share of the total.  It
 * is the one place a percentage is the right thing to draw: *this folder is a
 * third of that one* is a comparison a column of numbers makes you do in your
 * head, and the bar is the one place a percentage is the right thing to show.
 *
 * Run it with `./build/bintana examples/usage`, or on a folder of your own:
 * `./build/bintana examples/usage ~/Documents`.
 */
"use strict";

/*
 * One task per handful of top-level folders: enough threads to use the
 * machine, few enough that thirty folders on a laptop do not mean thirty
 * runtimes.  Each task walks its own roots and reports them one by one.
 */
function taskGroups(roots) {
    const width = Environment.ProcessorCount > 0
                ? Environment.ProcessorCount : 4;
    const n     = Math.max(1, Math.min(width, roots.length));
    const groups = [];

    for (let i = 0; i < n; i++)
        groups.push([]);
    for (let i = 0; i < roots.length; i++)
        groups[i % n].push(roots[i]);
    return groups.filter((g) => g.length);
}

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

    /* The tasks, while there are any, and the counter that says which run
     * they belong to.  Opening a folder or pressing Stop retires the run:
     * `gen` moves, and every answer that still arrives for the old one is
     * dropped where it lands -- which is the whole of the bookkeeping. */
    jobs = [];
    gen  = 0;

    /* What the tasks have said so far: `{ path, name, size }` per top-level
     * folder, and their sum, which is what the bars share. */
    found = [];
    total = 0;
    errors = 0;

    /* One entry per row, in row order, for the same reason `examples/files` has
     * one: what a row is for is not a question a row can answer. */
    shown = [];

    Form_Open() {
        this.open(Application.Arguments[0] || Environment.HomeDirectory);
    }

    /* --- starting and stopping ---------------------------------------------- */

    open(folder) {
        if (!File.IsDir(folder)) {
            Message.Error("{0} is not a folder.", folder);
            return;
        }

        /* One run at a time.  Opening a folder while tasks are still going is
         * not a request for both -- it is a change of mind, so the old run is
         * retired: its tasks are stopped and whatever they still answer is
         * dropped by the generation they carry. */
        this.retire();
        const gen = this.gen;

        this.folder = File.Absolute(folder);
        this.LblPath.Text  = this.folder;
        this.BtnUp.Enabled = File.Directory(this.folder) !== this.folder;

        this.found = [];
        this.total = 0;
        this.errors = 0;
        this.shown = [];
        this.List.Clear();
        this.BtnOpen.Enabled = false;

        const roots = Directory.Folders(this.folder);
        if (!roots.length) {
            this.LblStatus.Text = Locale.Text("Nothing in there.");
            return;
        }
        for (const group of taskGroups(roots)) {
            const t = new Sizer();

            t.Progress = (p) => this.took(p, gen);
            t.Done     = (r) => this.taskDone(r, gen);
            t.Error    = (m) => this.taskLost(gen);
            this.jobs.push(t);
            t.Start({ roots: group });
        }

        this.BtnStop.Enabled = true;
        this.LblStatus.Text  = Locale.Text("Reading {0}…", this.folder);
    }

    /*
     * Retires the run in flight: nothing of it is heard from again.
     *
     * **The generation is what retires a run, and it is the only thing that
     * does.** The first version kept a `stopping` flag and let each task's
     * callback clean up, which meant `finished()` ran once per *task* rather
     * than once per run: with one task per core, the second answer found the
     * flag already cleared and reported a completed measurement built from
     * whatever had arrived, rows and all, a moment after saying "Stopped."
     *
     * A stopped task still answers -- that is the contract -- so the answers
     * are dropped where they land rather than prevented, and the counter is
     * what drops them. `Stop()` is asked of each task because a run nobody
     * listens to should still end; nothing waits for it.
     */
    retire() {
        this.gen++;
        for (const t of this.jobs)
            t.Stop();
        this.jobs = [];
    }

    /* The one ending the user asks for, and it reports for itself: a retired
     * run has no answer coming, so there is nobody else left to say it. */
    BtnStop_Click() {
        if (!this.jobs.length)
            return;
        this.retire();
        this.BtnStop.Enabled = false;
        this.LblStatus.Text  = Locale.Text("Stopped.");
    }
    BtnUp_Click()     { this.open(File.Directory(this.folder)); }

    BtnChoose_Click() {
        Dialog.SelectFolder(Locale.Text("Which folder to measure"),
                            { Folder: this.folder || Environment.HomeDirectory },
                            (path) => this.open(path));
    }

    /* --- what the tasks say -------------------------------------------------
     *
     * One call per finished root, while the loop keeps turning.  A root and
     * nothing that is not a root: this runs once per folder, so anything
     * expensive here is paid for once per folder on the disk.
     */
    took(partial, gen) {
        if (gen !== this.gen)
            return;

        this.found.push({ path: partial.root, name: File.Name(partial.root),
                          size: partial.size });
        this.total += partial.size;
        this.errors += partial.errors;
        this.LblStatus.Text = Locale.Plural("Reading… {0} folder so far",
                                            "Reading… {0} folders so far",
                                            this.found.length);
    }

    /*
     * And once, when the last task of this run is gone -- however it went.
     *
     * **Three endings, and the outcome tells apart only two of them.** A run
     * that was stopped and a run that failed both end without rows; a run
     * that could not read one folder out of nine hundred still did exactly
     * what was asked.  A stopped run never reaches here -- its generation is
     * gone and `BtnStop_Click` already said so -- so what is left is a run
     * that ended by itself, and one that produced rows is one that worked
     * whatever else it says.
     */
    taskDone(result, gen) {
        if (gen !== this.gen)
            return;
        this.jobs = this.jobs.filter((t) => t.Running);
        if (this.jobs.length)
            return;
        this.finished();
    }

    /* A task lost -- its folder vanished, or it was stopped.  Either way it
     * contributes no rows; the run ends when the living are all in. */
    taskLost(gen) {
        if (gen !== this.gen)
            return;
        this.jobs = this.jobs.filter((t) => t.Running);
        if (this.jobs.length)
            return;
        this.finished();
    }

    finished() {
        this.BtnStop.Enabled = false;

        if (!this.found.length) {
            this.LblStatus.Text = Locale.Text("Nothing in there.");
            return;
        }

        /* Biggest first, which is the only order this list is for — and the
         * reason the rows could not be built as the partials arrived. */
        this.found.sort((a, b) => b.size - a.size);
        this.fill();

        this.LblStatus.Text = this.errors === 0
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
