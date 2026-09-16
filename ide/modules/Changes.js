/*
 * What has changed, as a page of the side panel.
 *
 * The *Changes* window (`GitForm`) is where a change is **read** -- two panes
 * of the file's own language, scrolled together, which is what answers *what am
 * I about to commit*. What it is not is a place to live: it is a window, it
 * covers the editor, and committing three edits over an afternoon meant opening
 * and closing it three times.
 *
 * So the list moves to where the project tree already is, in the third view of
 * the side bar's chooser: the changed files, a box for the message, and the two
 * buttons that are the whole of a small commit. Double clicking a row opens the
 * window on **that file**, which is the one thing the panel does not try to do
 * itself -- a diff in a 260-pixel column would be a worse answer than the one
 * that already exists.
 *
 * Prior art: this is Android Studio's *Commit* tool window, and IntelliJ's
 * before it -- a list of changed files and a message box, docked beside the
 * project tree rather than floating over it. Visual Studio's *Git Changes* pane
 * is the same shape. VB6 and Gambas have nothing like it, because neither has
 * git at all.
 *
 * **It runs no git of its own.** Every command is `Ide.Git`'s -- `stage`,
 * `unstage`, `discard`, `commit` -- which is also what the window's buttons
 * call, so *stage* has one set of guards and one spelling wherever it is
 * pressed. What this class owns is a table, a signature of what it last drew,
 * and which path each row is about.
 */
"use strict";

Namespace("Ide");

/* Which entry of the side bar's chooser this is: after the two views of the
 * tree, because it is the third answer to *what is on the left*, and last
 * because it is the one that is empty in a project that is not a repository. */
const CHANGES_VIEW = 2;

/* The state column. Two characters and a space is all it ever holds. */
const STATE_W = 34;

Ide.Changes = class Changes {

    /* Which entry of the chooser it is, for the window that fills the chooser.
     * A number and not a name, for the reason `ProjectTree.views` gives: what is
     * shown is prose and what is compared must not be. */
    static get view() { return CHANGES_VIEW; }

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        /* Parallel to the rows: what each one is about. `staged` is which half
         * of the porcelain it came from, which is what a double click needs to
         * open the right side of the window, and what *Unstage* needs to know it
         * has something to do. */
        this.rows  = [];
        /* What the table currently says, so a refresh with nothing new costs a
         * string compare -- `Events` next door makes the same bargain, and for
         * the same reason: this hangs off a method that runs on every edit. */
        this.drawn = null;
    }

    /* --- what it shows ------------------------------------------------------ */

    /*
     * Whether this view is the one on screen.
     *
     * Hidden, it is not kept up to date: showing it redraws it, so there is
     * nothing to lose and a `git status` per keystroke to save.
     */
    get visible() {
        return this.ide.CmbView.Index === CHANGES_VIEW;
    }

    /* The chooser moved here: whatever is in the table was drawn for another
     * project, or for an older state of this one. */
    shown() {
        this.drawn = null;
        this.reload();
    }

    /*
     * The rows, when there is anything different to draw.
     *
     * `reload` is called from everything that can change what git would say --
     * `refreshGit`, the window's own reload, a commit made here -- so it asks
     * the cheap question first. The porcelain is already parsed: `split()` is
     * what the window reads too, and two readings of one repository is how two
     * lists come to disagree.
     */
    reload() {
        if (!this.visible) return;

        const git = this.ide.git;
        const all = [];

        if (git.isRepo) {
            for (const row of git.split().staged)
                all.push({ path: row.path, state: row.state, staged: true });
            for (const row of git.split().unstaged)
                all.push({ path: row.path, state: row.state, staged: false });
        }

        const signature = all.map((r) => `${r.staged ? "+" : "-"}${r.state}${r.path}`)
                             .join("\n");
        if (signature === this.drawn) return;

        this.drawn = signature;
        this.build(all);
    }

    /*
     * The table.
     *
     * Staged first and then not, which is the order of the sentence the panel
     * is about: *this is going in, and this is not*. A file that is in both --
     * staged and then edited again -- is in the list twice, and that is not a
     * bug to hide: the two rows are two different things to do with it.
     */
    build(all) {
        const table = this.ide.ChangeTable;

        table.Columns = [{ Text: Locale.Text("State"), Width: STATE_W },
                         { Text: Locale.Text("File") }];
        table.MultiSelect = true;
        table.Clear();
        this.rows = all;

        for (const row of all)
            table.Add([`${row.staged ? "●" : "○"}${row.state}`, row.path]);

        this.say();
    }

    /*
     * The line under the table, which is the one thing the status bar cannot
     * say from here: whether the message box is about to do anything.
     */
    say() {
        const ide     = this.ide;
        const staged  = ide.git.staged;
        const message = ide.TxtCommit.Text.trim();
        const what    = this.chosen();

        ide.BtnChCommit.Enabled = staged > 0 && message !== "";
        ide.BtnChStage.Enabled  = what.length > 0;

        ide.BtnChCommit.Tooltip = !staged
            ? Locale.Text("Nothing is staged")
            : Locale.Text("Commit what is staged, with the message above");

        /*
         * An empty table has two meanings and they are not the same news, so it
         * says which: a project that is not in a repository is not a project
         * with nothing to commit. Without this the panel is a blank rectangle
         * either way, which is the thing an empty list must never be.
         */
        const note = !ide.git.isRepo
            ? Locale.Text("This project is not in a git repository.")
            : (this.rows.length ? "" : Locale.Text("Nothing has changed."));

        ide.LblChanges.Text    = note;
        ide.LblChanges.Visible = note !== "";
        ide.TxtCommit.Enabled  = ide.git.isRepo;

        /*
         * The menu, dressed here and not in `MainForm.refresh()`: what it is
         * about is the row under the pointer, and that changes with a click and
         * not with a keystroke. *Unstage* is about the staged half and *Discard*
         * about the other, which is why a row can offer one and not the other.
         */
        ide.MnuChStage.Enabled   = what.length > 0;
        ide.MnuChUnstage.Enabled = what.some((r) => r.staged);
        ide.MnuChDiscard.Enabled = what.some((r) => !r.staged);
        ide.MnuChDiff.Enabled    = what.length > 0;
        ide.MnuChOpen.Enabled    = what.length > 0;
        ide.MnuChAll.Enabled     = ide.git.isRepo;
        ide.MnuChWindow.Enabled  = ide.git.isRepo;
    }

    /* --- what is chosen ----------------------------------------------------- */

    /*
     * The rows the commands act on: the selection, or the one row that is
     * simply current. A list where clicking a row and pressing a button did
     * nothing -- because clicking is not selecting to a widget -- is the trap
     * the window's `chosen()` already avoids, and this is that method.
     */
    chosen() {
        const table = this.ide.ChangeTable;
        if (!table) return [];

        const rows = table.Selection.length ? table.Selection
                   : (table.Index >= 0 ? [table.Index] : []);

        return rows.map((i) => this.rows[i]).filter(Boolean);
    }

    paths(what) {
        return [...new Set(what.map((r) => r.path))];
    }

    /* --- the commands ------------------------------------------------------- */

    stage() {
        const what = this.chosen();
        if (!what.length) return;

        this.ide.git.stage(this.paths(what));
        this.after();
    }

    unstage() {
        const what = this.chosen().filter((r) => r.staged);
        if (!what.length) return;

        this.ide.git.unstage(this.paths(what));
        this.after();
    }

    /* Everything, which is the commit most small changes are: `add -A` and not
     * a path per row, so a file deleted on disk is staged as the deletion it is
     * rather than skipped for not being there. */
    stageAll() {
        if (!this.ide.git.isRepo) return;

        /* `-- .` and not the whole repository: a project in a subdirectory of a
         * bigger one must not stage somebody else's folder. */
        this.ide.git.run(["add", "-A", ...this.ide.git.here()]);
        this.after();
    }

    /*
     * Throwing work away -- *rollback*, in the vocabulary of the tool this
     * panel is shaped after.
     *
     * Asked first, by name and by count, because it is the one command here
     * with no undo and it sits two rows under *Stage*. An untracked file is
     * **deleted** and not restored, which is a different sentence and is said
     * as one; which files those are is `Ide.Git.untracked`, so the wording and
     * the work agree by construction.
     */
    discard() {
        const what = this.chosen().filter((r) => !r.staged);
        if (!what.length) return;

        const files = this.paths(what);
        const fresh = this.ide.git.untracked(files);

        this.ask = ConfirmForm.ask(
            Locale.Text("Discard changes"),
            fresh.length
                ? Locale.Plural("Throw away {0} file, and delete it if it is new?",
                                "Throw away {0} files, deleting the new ones?",
                                files.length)
                : Locale.Plural("Throw away what was written in {0} file?",
                                "Throw away what was written in {0} files?",
                                files.length),
            Locale.Text("Discard"),
            () => {
                this.ide.git.discard(files);
                /* The files changed underneath whatever is open: each tab is
                 * watching its own and the reload bar is what that looks like. */
                this.after();
                this.ide.listFiles();
            });
    }

    /*
     * The commit, from a single-line box.
     *
     * One line on purpose: a subject is what a small commit has, and a message
     * with a body is written in the window, which has a text editor for it.
     * What is committed is **what is staged** and never what is selected --
     * a button that quietly staged something first would make *Commit* mean two
     * different things depending on where the pointer had been.
     */
    commit() {
        const message = this.ide.TxtCommit.Text.trim();

        if (!message || !this.ide.git.staged) return;

        const r = this.ide.git.commit(message);
        if (r.ok) this.ide.TxtCommit.Text = "";

        this.after();
    }

    /* Read the diff of one row, in the window that exists for it. */
    show(index) {
        const row = this.rows[index];
        if (!row) return;

        GitForm.openAt(this.ide, row.path, row.staged);
    }

    /* The file itself, in a tab -- the worktree's copy, which is the one that
     * can be edited. `openInTab` is the tree's own door, and it answers false
     * for a file that is gone, which a deleted row is. */
    open(index) {
        const row = this.rows[index];
        if (row) this.ide.openInTab(row.path);
    }

    /*
     * After anything that changed the repository: git again, the tree's
     * indicators again, the menus again -- the IDE's one door for that is
     * `refreshGit`, and going through it is what keeps the panel, the tree, the
     * status bar and the window saying the same thing.
     */
    after() {
        this.drawn = null;
        this.ide.refreshGit();
    }
};
