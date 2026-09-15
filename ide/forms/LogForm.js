/*
 * What has already been committed, and what each commit did.
 *
 * The other half of `GitForm`, and deliberately not a page of it. That window
 * is about the change you are *making* -- it stages, it discards, it commits --
 * and this one is about changes that are over and cannot be edited. Putting a
 * read-only history behind the same buttons would have made every one of them
 * ask *does this apply here*, which is the shape of a window that does two
 * things.
 *
 * Three panes, top to bottom and left to right, which is the order the question
 * is asked in: which commit, then which of its files, then what it did to that
 * file. Each one narrows the next, and none of them costs anything until it is
 * looked at -- a `git show` per row walked is the reason the two lists answer on
 * `Select` while the tree elsewhere insists on `Activate`: here the panes *are*
 * the answer and there was something to open.
 */
"use strict";

/* One at a time, raised rather than stacked -- `SearchForm`'s argument, and
 * `GitForm`'s: the point of reading history is to go back to the code. */
let openLog = null;

/* How far back the list goes. Enough to find the commit somebody is thinking
 * of; not so far that opening the window walks the whole repository. Going
 * further is what the Terminal tab is for, which is the same answer this
 * integration gives to every question it does not own. */
const HOW_MANY = 60;

class LogForm extends Form {

    static open(ide) {
        if (openLog) {
            openLog.reload();
            openLog.Show();
            return openLog;
        }

        const win = new LogForm();
        win.ide = ide;
        win.Text = Locale.Text("History -- {0}", File.Name(ide.project));
        win.setup();
        openLog = win;
        win.Show();
        win.reload();
        return win;
    }

    /* Whether it is built: a `Switcher` raises `Switch` while the `.form` is
     * still loading, before `open()` has said which IDE this belongs to. The
     * entry in `AGENTS.md`, and the second window to need it. */
    get ready() { return this.ide !== undefined && this.Commits !== undefined; }

    setup() {
        this.Commits.Columns = [{ Text: Locale.Text("Commit"), Width: 90 },
                                { Text: Locale.Text("Subject") },
                                { Text: Locale.Text("Who"), Width: 130 },
                                { Text: Locale.Text("When"), Width: 130 }];
        this.Touched.Columns = [{ Text: Locale.Text("File") },
                                { Text: Locale.Text("State"), Width: 70 }];
        this.commits = [];
        this.files   = [];
    }

    reload() {
        if (!this.ready) return;

        this.commits = this.ide.git.log(HOW_MANY);
        this.Commits.Clear();

        for (const c of this.commits)
            this.Commits.Add([c.sha, c.subject, c.who, c.when]);

        this.Touched.Clear();
        this.files = [];
        this.clearPanes();

        if (this.commits.length) this.Commits.Index = 0;
        this.showFiles();
    }

    clearPanes() {
        this.Before.ClearMarks();
        this.After.ClearMarks();
        this.Before.Text = this.After.Text = this.Unified.Text = "";
        this.LblWhat.Text = "";
    }

    /* --- a commit ----------------------------------------------------------- */

    showFiles() {
        if (!this.ready) return;

        const commit = this.commits[this.Commits.Index];

        this.Touched.Clear();
        this.files = [];
        this.clearPanes();
        if (!commit) return;

        this.files = this.ide.git.filesIn(commit.sha);
        for (const f of this.files)
            this.Touched.Add([f.path, this.words(f.state)]);

        this.LblWhat.Text = Locale.Plural("{0} file in this commit",
                                          "{0} files in this commit",
                                          this.files.length);

        /* The whole commit until a file is chosen, which is what somebody
         * looking at a commit wants first: what it did, all of it. */
        this.Unified.Text = this.ide.git.commitDiff(commit.sha, null);

        if (this.files.length) {
            this.Touched.Index = 0;
            this.showOne();
        }
    }

    words(letter) {
        const said = {
            M: Locale.Text("changed"), A: Locale.Text("added"),
            D: Locale.Text("deleted"), R: Locale.Text("renamed"),
            C: Locale.Text("copied"),
        };
        return said[letter] || letter;
    }

    /* --- one of its files ---------------------------------------------------- */

    /*
     * What the commit did to one file: the version before it and the version it
     * left. `sha^` is the commit before, and a file that was *added* has no
     * version there -- which comes back as null and is shown as the empty pane
     * it should be, since that is exactly what "added" means.
     */
    showOne() {
        if (!this.ready) return;

        const commit = this.commits[this.Commits.Index];
        const file   = this.files[this.Touched.Index];
        if (!commit || !file) return;

        const git    = this.ide.git;
        const before = git.fileBefore(commit.sha, file.path);
        const after  = git.fileAt(commit.sha, file.path);

        this.Unified.Text = git.commitDiff(commit.sha, file.path);

        /* Aligned and marked, out of the same diff that is in the tab beside
         * it -- the `Changes` window's argument, and the same class. */
        const pair = Ide.Diff.sideBySide(before, after, this.Unified.Text);

        this.Before.Text = Ide.Diff.text(pair.left);
        this.After.Text  = Ide.Diff.text(pair.right);
        Ide.Diff.mark(this.Before, pair.left);
        Ide.Diff.mark(this.After,  pair.right);

        const lang = this.languageOf(file.path);
        this.Before.Language = lang;
        this.After.Language  = lang;
        this.Before.ScrollY  = 0;
        this.After.ScrollY   = 0;
    }

    languageOf(path) {
        const by = { js: "js", json: "json", form: "json", css: "css",
                     md: "markdown", c: "c", h: "c", sh: "sh" };
        return by[File.Extension(path).toLowerCase()] || "";
    }

    /* --- events -------------------------------------------------------------- */

    Commits_Select() { this.showFiles(); }
    Touched_Select() { this.showOne(); }
    How_Switch()     { this.showOne(); }

    /* The two panes, locked, which is what `Editor.ScrollY` bought. */
    Before_Scroll(x, y) { if (this.ready) this.After.ScrollY = y; }
    After_Scroll(x, y)  { if (this.ready) this.Before.ScrollY = y; }

    /*
     * Double clicking a file opens **the version in the worktree**, not the one
     * in the commit: a history window is read on the way to changing something,
     * and a read-only buffer of an old version is not what anybody wanted to
     * edit. A file the commit deleted is not there to open, and nothing happens.
     */
    Touched_Activate() {
        const file = this.files[this.Touched.Index];
        if (file && this.ide.openInTab(file.path)) this.ide.Show();
    }

    BtnClose_Click() { this.Close(); }

    Form_Close() {
        if (openLog === this) openLog = null;
    }
}
