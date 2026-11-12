/*
 * The diff, in the main panel.
 *
 * The side panel is the choosing: Changes lists what is not committed,
 * History lists what is, and either one opens the file's diff here. That is
 * the shape GitHub Desktop taught and the one this IDE already had for files:
 * the strip of lists on the left, the room to read on the right. The tab
 * therefore has no list of its own, no commit box and no verbs; *what do I
 * pick* is the side panel's question, *what does it say* is this one's, and
 * fetch/pull/push are the Git menu's.
 *
 * **It is not a form.** A form is a window, and this is a page of the notebook
 * the files are already in (`TabSet.openGit`), so it has no title bar, no close
 * button and no place of its own to be raised from. `GitTab.page` is what the
 * notebook gets; everything else is built here because a `.form` describes a
 * window and this is not one.
 *
 * **The engine is `Git`'s and the diff is `Diff`'s.** This class owns the one
 * `DiffView`; the before, the after and git's unified answer are put together
 * by the view, never by a second diff of our own.
 */
"use strict";

/* Past this a file is not put in two buffers. A generated file or a vendored
 * library is not read line against line, and two `SourceEditor`s full of it
 * cost seconds; the unified view still says what it is. */
const BIG_FILE = 4000;

/* The file's own language for both panes, asked of the extension the tree
 * already opens. */
function languageOf(path) {
    const by = { js: "js", json: "json", btp: "json", form: "json", css: "css",
                 md: "markdown", c: "c", h: "c", sh: "sh", po: "", pot: "" };
    return by[File.Extension(path).toLowerCase()] || "";
}

/*
 * One diff: the two panes, the unified view and the toggle. Nothing else --
 * the file is named in the tab, and the verbs are in the menu.
 *
 * `worktree` and `commit` are the two things it can be about; `show` is the one
 * place the before, the after and git's unified answer are put together.
 */
class DiffView {

    /** @param {MainForm} ide @param {string} key a unique suffix for its names */
    constructor(ide, key, previousFile, nextFile) {
        this.ide = ide;
        this.key = key;
        this.previousFile = previousFile;
        this.nextFile     = nextFile;

        this.mode   = "";
        this.path   = "";
        this.staged = false;
        this.sha    = "";
        this.file   = "";

        /* The differences of the diff on screen, and which one the reader is
         * on. `starts` are the side-by-side screen rows; `hunks` carry the
         * unified line. `-1` is *nobody pressed next yet*. */
        this.hunks  = [];
        this.starts = [];
        this.hunk   = -1;

        const page = new Panel();
        page.Name        = `GitDiff${key}`;
        page.Arrangement = "Vertical";
        page.HExpand     = true;
        page.VExpand     = true;

        this.Before  = this.editor();
        this.After   = this.editor();
        this.Unified = this.editor();
        this.Before.Name      = `GitBefore${key}`;
        this.After.Name       = `GitAfter${key}`;
        this.Unified.Name     = `GitUnified${key}`;
        this.Unified.Language = "diff";

        const pair = new Split();
        pair.Name        = `GitPair${key}`;
        pair.Arrangement = "Horizontal";
        pair.Position    = 400;
        pair.HExpand     = true;
        pair.VExpand     = true;
        pair.Style       = "frame";
        pair.Add(this.Before);
        pair.Add(this.After);

        /* The unified page has the same frame as the side-by-side pane; the
         * editor inside it is the view, the box is the border. */
        this.EditorBox = new Panel();
        this.EditorBox.Name        = `GitEditorBox${key}`;
        this.EditorBox.Arrangement = "Vertical";
        this.EditorBox.HExpand     = true;
        this.EditorBox.VExpand     = true;
        this.EditorBox.Style       = "frame";
        this.EditorBox.Add(this.Unified);

        this.How = new Switcher();
        this.How.Name    = `GitHow${key}`;
        this.How.Strip   = "None";
        this.How.HExpand = true;
        this.How.VExpand = true;
        this.How.Append(pair, Locale.Text("Side by side"));
        this.How.Append(this.EditorBox, Locale.Text("Unified"));

        /* The old toggle, with no pages of its own: the content is `How`, and
         * this is only its strip, so it can sit at the right of the bar with
         * the navigation at the left. */
        this.ViewToggle = new Switcher();
        this.ViewToggle.Name = `GitToggle${key}`;
        this.ViewToggle.Append(new Panel(), Locale.Text("Side by side"));
        this.ViewToggle.Append(new Panel(), Locale.Text("Unified"));
        this.ViewToggle.Current = 0;
        this.viewSyncing = false;
        this.ViewToggle.On("Switch", (index) => {
            if (this.viewSyncing) return;
            this.How.Current = index;
            this.show();
        });

        const bar = new Panel();
        bar.Name        = `GitNav${key}`;
        bar.Arrangement = "Horizontal";
        bar.Style       = "toolbar";
        bar.Height      = 36;
        bar.Spacing     = 6;

        const nav = new Panel();
        nav.Arrangement = "Horizontal";
        nav.Spacing     = 4;

        this.BtnPrevDiff = this.iconButton("go-up-symbolic", "\u2191",
            Locale.Text("Go to the previous difference"), () => this.previousDifference());
        this.BtnNextDiff = this.iconButton("go-down-symbolic", "\u2193",
            Locale.Text("Go to the next difference"), () => this.nextDifference());

        this.LblHunk = new Label();
        this.LblHunk.Name      = `GitHunk${key}`;
        this.LblHunk.Width     = 56;
        this.LblHunk.Style     = "dim-label";
        this.LblHunk.Alignment = "Center";
        this.LblHunk.Text      = "";

        this.BtnOpen = this.iconButton("document-open-symbolic", "\u2026",
            Locale.Text("Open the file in the worktree"), () => this.openFile());
        this.BtnPrevFile = this.iconButton("go-previous-symbolic", "\u25c0",
            Locale.Text("Compare the previous changed file"), () => {
                if (this.previousFile) this.previousFile();
            });
        this.BtnNextFile = this.iconButton("go-next-symbolic", "\u25b6",
            Locale.Text("Compare the next changed file"), () => {
                if (this.nextFile) this.nextFile();
            });

        nav.Add(this.BtnPrevDiff);
        nav.Add(this.BtnNextDiff);
        nav.Add(this.BtnOpen);
        nav.Add(this.BtnPrevFile);
        nav.Add(this.BtnNextFile);

        const spacer = new Label();
        spacer.HExpand = true;
        spacer.Text    = "";

        bar.Add(nav);
        bar.Add(this.LblHunk);
        bar.Add(spacer);
        bar.Add(this.ViewToggle);

        page.Add(bar);
        page.Add(this.How);
        this.page = page;

        this.setFileNav(false, false);
        this.updateHunk();
        this.setView(0);

        /* The two panes are one view: scrolling one moves the other. Assigning
         * a value an adjustment already has emits nothing, so this settles
         * after one event rather than bouncing. */
        this.Before.On("Scroll", (x, y) => { if (this.After) this.After.ScrollY = y; });
        this.After.On("Scroll",  (x, y) => { if (this.Before) this.Before.ScrollY = y; });
    }

    editor() {
        const e = new SourceEditor();
        e.Font     = "Monospace 10";
        e.ReadOnly = true;
        e.Wrap     = false;
        e.HExpand  = true;
        e.VExpand  = true;
        e.MinWidth = 120;
        return e;
    }

    button(text, tooltip, click) {
        const b = new Button();
        b.Text    = Locale.Text(text);
        b.Tooltip = tooltip;
        b.Height  = 28;
        b.On("Click", click);
        return b;
    }

    /* The navigation is a row of icons: the words are in the tooltips, where
     * they do not take the diff's width. */
    iconButton(icon, fallback, tooltip, click) {
        const b = new Button();
        b.Tooltip = tooltip;
        b.Width   = 30;
        b.Height  = 28;
        b.Style   = "flat";
        if (Application.HasIcon(icon)) b.Icon = icon;
        else                           b.Text = fallback;
        b.On("Click", click);
        return b;
    }

    /* --- navigating the diff ------------------------------------------------- */

    /* The differences in the view on screen: a side-by-side row and a unified
     * line are not the same number, so the count comes from whichever is up. */
    count() {
        return this.How.Current === 1 ? this.hunks.length : this.starts.length;
    }

    updateHunk() {
        const n = this.count();
        this.LblHunk.Text = n && this.hunk >= 0 ? `${this.hunk + 1} / ${n}` : "";
        this.BtnPrevDiff.Enabled = n > 0;
        this.BtnNextDiff.Enabled = n > 0;
    }

    /* The two switchers are one view: `How` holds the pages, `ViewToggle` is
     * its strip in the bar. Assign both without letting the second raise a
     * second `show`. */
    setView(index) {
        this.viewSyncing = true;
        this.How.Current = index;
        this.ViewToggle.Current = index;
        this.viewSyncing = false;
    }

    previousDifference() {
        const n = this.count();
        if (!n) return;

        this.hunk = this.hunk <= 0 ? 0 : this.hunk - 1;
        this.gotoHunk();
        this.updateHunk();
    }

    nextDifference() {
        const n = this.count();
        if (!n) return;

        this.hunk = this.hunk < 0 ? 0 : Math.min(n - 1, this.hunk + 1);
        this.gotoHunk();
        this.updateHunk();
    }

    gotoHunk() {
        if (this.How.Current === 1) {
            const h = this.hunks[this.hunk];
            if (h) this.Unified.Select(h.line + 2, 1);
            return;
        }

        const row = this.starts[this.hunk];
        if (row === undefined) return;

        /* Both columns are the same screen rows, so the same line in each:
         * `Select` scrolls the editor to it. */
        this.Before.Select(row + 1, 1);
        this.After.Select(row + 1, 1);
    }

    /* Which neighbouring files exist, for the two file buttons. */
    setFileNav(previous, next) {
        this.BtnPrevFile.Enabled = !!previous;
        this.BtnNextFile.Enabled = !!next;
    }

    openFile() {
        const path = this.mode === "worktree" ? this.path : this.file;
        if (path && File.Exists(File.Join(this.ide.project, path)))
            this.ide.openInTab(path);
    }

    worktree(path, staged) {
        this.mode   = "worktree";
        this.path   = path;
        this.staged = !!staged;
        this.sha    = "";
        this.file   = "";
        this.show();
    }

    commit(sha, file) {
        this.mode = "commit";
        this.sha  = sha || "";
        this.file = file || "";
        this.path = "";
        this.staged = false;
        this.show();
    }

    clear() {
        this.mode   = "";
        this.path   = "";
        this.staged = false;
        this.sha    = "";
        this.file   = "";
        this.Before.ClearMarks();
        this.After.ClearMarks();
        this.Before.Text = this.After.Text = this.Unified.Text = "";
        this.hunks  = [];
        this.starts = [];
        this.hunk   = -1;
        this.updateHunk();
    }

    /*
     * The one place the two texts and git's own diff are put together. The
     * pair is `Diff`'s -- it reads the unified diff and aligns the two
     * columns -- so this method only decides *which* before and after the
     * subject means:
     *
     *   worktree, not staged   index          -> file on disk
     *   worktree, staged       HEAD           -> index
     *   commit, one file       sha^           -> sha
     *   commit, whole          (none)         -> the unified diff alone
     */
    show() {
        const git = this.ide.git;

        if (this.mode === "worktree") {
            const staged = this.staged;
            const unified = git.diff(this.path, staged);
            const before  = staged ? git.show("HEAD", this.path) : git.show("", this.path);
            const after   = staged ? git.show("", this.path) : this.worktreeText(this.path);

            this.Unified.Text = unified;
            this.hunks  = Diff.hunks(unified);
            this.starts = [];

            if (this.tooBig(before) || this.tooBig(after)) {
                this.clearPair(Locale.Text("Too big to show side by side. The unified tab has it."));
                this.setView(1);
            } else {
                this.starts = this.pair(before, after, unified, this.path);
            }
            this.hunk = -1;
            this.updateHunk();
            return;
        }

        if (this.mode === "commit") {
            const unified = this.file ? git.commitDiff(this.sha, this.file)
                                      : git.commitDiff(this.sha, null);
            this.Unified.Text = unified;
            this.hunks  = Diff.hunks(unified);
            this.starts = [];

            if (!this.file) {
                this.clearPair(Locale.Text("Choose a file for the side-by-side view."));
                this.setView(1);
            } else {
                const before = git.fileBefore(this.sha, this.file);
                const after  = git.fileAt(this.sha, this.file);
                if (this.tooBig(before) || this.tooBig(after)) {
                    this.clearPair(Locale.Text("Too big to show side by side. The unified tab has it."));
                    this.setView(1);
                } else {
                    this.starts = this.pair(before, after, unified, this.file);
                }
            }
            this.hunk = -1;
            this.updateHunk();
            return;
        }

        this.clear();
    }

    pair(before, after, unified, path) {
        const pair = Diff.sideBySide(before, after, unified);

        this.Before.ClearMarks();
        this.After.ClearMarks();
        this.Before.Text = Diff.text(pair.left);
        this.After.Text  = Diff.text(pair.right);
        Diff.mark(this.Before, pair.left);
        Diff.mark(this.After,  pair.right);

        const lang = languageOf(path);
        this.Before.Language = lang;
        this.After.Language  = lang;
        this.Before.ScrollY  = 0;
        this.After.ScrollY   = 0;

        return pair.starts || [];
    }

    clearPair(note) {
        this.Before.ClearMarks();
        this.After.ClearMarks();
        this.Before.Text = note || "";
        this.After.Text  = "";
    }

    tooBig(text) {
        return text !== null && text !== undefined && text.split("\n").length > BIG_FILE;
    }

    worktreeText(path) {
        const full = File.Join(this.ide.project, path);
        if (!File.Exists(full)) return null;

        try { return File.Load(full); }
        catch (e) { return null; }          /* binary, or unreadable */
    }
}

export class GitTab {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        this.Diff = new DiffView(ide, "Main",
            () => this.previousFile(), () => this.nextFile());
        this.build();
    }

    build() {
        this.Diff.page.Name = "GitTab";
        this.page = this.Diff.page;
        this.page.HExpand = true;
        this.page.VExpand = true;
    }

    /* --- what the side panel chose ------------------------------------------- */

    showWorktree(path, staged) {
        this.Diff.worktree(path, staged);
        this.retitle();
        this.updateFileNav();
    }

    showCommit(sha, file) {
        this.Diff.commit(sha, file);
        this.retitle();
        this.updateFileNav();
    }

    /* --- the neighbouring files ------------------------------------------------ */

    previousFile() { this.stepFile(-1); }
    nextFile()     { this.stepFile(1); }

    /*
     * *Compare the previous/next file*: the diff walks the list the side panel
     * is showing -- the changed files for a change, the commit's files for a
     * commit -- without taking the reader out of the diff.
     */
    stepFile(delta) {
        const d = this.Diff;

        if (d.mode === "worktree") {
            const all = this.ide.git.changes();
            const at  = all.findIndex((c) => c.path === d.path);
            if (at < 0) return;

            const row = all[at + delta];
            if (!row) return;

            this.showWorktree(row.path, !row.untracked && row.tree === " ");
            return;
        }

        if (d.mode === "commit") {
            const all = this.ide.git.filesIn(d.sha);
            const at  = all.findIndex((f) => f.path === d.file);
            if (at < 0) return;

            const file = all[at + delta];
            if (!file) return;

            const history = this.ide.history;
            if (history && history.sha === d.sha && history.files.length) {
                const row = history.files.findIndex((f) => f.path === file.path);
                if (row >= 0) {
                    /* The list follows the diff, without its Select opening a
                     * second diff on the way. */
                    history.filling = true;
                    history.Files.Index = row;
                    history.filling = false;
                    history.file = file.path;
                }
            }
            this.showCommit(d.sha, file.path);
        }
    }

    /* Whether the two file buttons have anywhere to go. */
    updateFileNav() {
        const d = this.Diff;

        if (d.mode === "worktree") {
            const all = this.ide.git.changes();
            const at  = all.findIndex((c) => c.path === d.path);
            d.setFileNav(at > 0, at >= 0 && at < all.length - 1);
            return;
        }

        if (d.mode === "commit") {
            const all = this.ide.git.filesIn(d.sha);
            const at  = all.findIndex((f) => f.path === d.file);
            d.setFileNav(at > 0, at >= 0 && at < all.length - 1);
            return;
        }

        d.setFileNav(false, false);
    }

    /* --- the tab -------------------------------------------------------------- */

    reload(refreshed) {
        const git = this.ide.git;
        if (!git || !git.available || !git.isRepo) {
            this.clear();
            return;
        }

        if (!refreshed) git.refresh();
        this.refreshDiff();
    }

    refresh() {
        if (!this.ide.git || !this.ide.git.isRepo) return;
        this.refreshDiff();
    }

    /* The file may have been staged or unstaged in the side panel since the
     * diff was opened, so the side of the index is asked again. */
    refreshDiff() {
        const diff = this.Diff;

        if (diff.mode === "worktree" && diff.path) {
            diff.worktree(diff.path, this.stagedOf(diff.path));
        } else if (diff.mode === "commit" && diff.sha) {
            diff.commit(diff.sha, diff.file);
        } else {
            diff.clear();
        }
        this.retitle();
        this.updateFileNav();
    }

    shown() {
        /* A fetch, pull or push is writing the repository; asking it `status`
         * in the middle is at best a wait and at worst a lock. The job's own
         * callback refreshes the tab when it ends. */
        if (this.ide.git && this.ide.git.job) return;
        this.reload();
    }

    clear() {
        this.Diff.clear();
        this.Diff.setFileNav(false, false);
        this.retitle();
    }

    /* The one place *which half of this file* is worked out, so the side panel
     * and the tab cannot disagree. */
    stagedOf(path) {
        const row = this.ide.git.changes().find((c) => c.path === path);
        return !!(row && !row.untracked && row.tree === " ");
    }

    /* --- the title ------------------------------------------------------------ */

    /*
     * **`diff: <file> (<branch>)`** -- the file the page is about and the
     * branch it is about it on, in one line, which is what the strip has room
     * for. A whole commit has no file, so it names the commit instead.
     */
    title() {
        const d = this.Diff;
        const branch = (this.ide.git && this.ide.git.branchName) ||
                       Locale.Text("detached");
        const file = d.mode === "commit" ? (d.file || d.sha) : d.path;

        if (d.mode === "commit")
            return file ? Locale.Text("Commit: {0} ({1})", file, branch)
                        : Locale.Text("Commit ({0})", branch);

        return file ? Locale.Text("diff: {0} ({1})", file, branch)
                    : Locale.Text("diff ({0})", branch);
    }

    /* The file the page is about, for the Git menu's *Open file*. */
    currentFile() {
        const d = this.Diff;
        if (d.mode === "worktree") return d.path;
        if (d.mode === "commit")   return d.file;
        return "";
    }

    openCurrentFile() {
        const path = this.currentFile();
        if (path && File.Exists(File.Join(this.ide.project, path)))
            this.ide.openInTab(path);
    }

    retitle() {
        this.ide.tabs.retitle("git:tab", this.title());
    }
}
