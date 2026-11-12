/*
 * What has already been committed, as a page of the side panel.
 *
 * The main panel is the diff; the list of commits belongs beside the list of
 * changes, where the project tree already is. That is the shape every git
 * client converged on and the one this IDE already had for changes: the side
 * panel is what you *pick from*, the editor's room is what you *read*.
 *
 * **Two tables, not a tree.** A commit is not a container of the files it
 * touched -- those are a second question asked of the commit chosen -- so the
 * two are two lists, and the second is filled from the first. The files are
 * `git show --name-status`, the same answer `LogForm` reads.
 *
 * **It opens the diff, and it does not own one.** Selecting a commit shows its
 * files; selecting one of those opens the Git tab on that file's diff. The tab
 * is `GitTab`'s and the engine is `Git`'s; this class is the list and the
 * selection, and nothing else.
 */
"use strict";

/* How far back the list goes. The same number the old History window used:
 * enough to find the commit one is thinking of; more is the Terminal tab. */
const HOW_MANY = 60;

export class History {

    /*
     * One row beside the project and the changes: the same shape
     * `ProjectTree.sideEntries` and `Changes.sideEntries` return. The page is
     * the third of `SideStack`, appended by `install` -- the tree and the
     * changes page are the two the .form declares, and Data comes after this
     * one.
     */
    static get sideEntries() {
        return [{
            text:  Locale.Text("History"),
            tip:   Locale.Text("Show the commits"),
            icons: ["document-open-recent-symbolic", "document-edit-symbolic",
                    "bta-code-symbolic"],
            page:  2,
            show:  (ide) => ide.history.shown(),
        }];
    }

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        this.commits = [];
        this.files   = [];
        this.sha     = "";
        this.file    = "";

        /* A fill raises `Select` for the row it puts its finger on, which would
         * open a diff in the middle of building the list. */
        this.filling = false;
        this.installed = false;
    }

    install() {
        if (this.installed) return;
        this.installed = true;

        const page = new Panel();
        page.Name        = "HistoryPage";
        page.Arrangement = "Vertical";
        page.Margin      = 4;
        page.Spacing     = 4;

        const split = new Split();
        split.Name        = "HistorySplit";
        split.Arrangement = "Vertical";
        split.Grows       = "End";       /* the files take the new room */
        split.Position    = 240;
        split.VExpand     = true;

        this.Commits = new TableView();
        this.Commits.Name    = "HistCommits";
        this.Commits.Columns = [
            { Text: Locale.Text("Commit"), Width: 70 },
            { Text: Locale.Text("Subject") },
            { Text: Locale.Text("When"), Width: 90 } ];
        this.Commits.HExpand = true;
        this.Commits.VExpand = true;
        this.Commits.On("Select", () => this.choseCommit());

        this.Files = new TableView();
        this.Files.Name    = "HistFiles";
        this.Files.Columns = [
            { Text: Locale.Text("File") },
            { Text: Locale.Text("State"), Width: 60 } ];
        this.Files.HExpand = true;
        this.Files.VExpand = true;
        this.Files.On("Select", () => this.choseFile());
        this.Files.On("Activate", () => this.openFile());

        split.Add(this.Commits);
        split.Add(this.Files);
        page.Add(split);

        this.sidePage = this.ide.SideStack.Append(page, Locale.Text("History"));
    }

    /* Whether the page is the one the side bar is showing. Hidden, it is not
     * kept up to date: showing it reads the log, so there is nothing to lose. */
    get visible() {
        const stack = this.ide.SideStack;
        return !!stack && stack.Current === this.sidePage;
    }

    /* The chooser moved here: whatever the table said was drawn for another
     * project, or for an older state of this one. */
    shown() {
        this.reload(true);
    }

    /*
     * The log again. `force` is the difference between *the reader asked to
     * see History* -- which opens the first commit's diff -- and a background
     * refresh after a save, which must not take the editor away.
     */
    reload(force) {
        if (!this.installed || (!force && !this.visible)) return;

        const git = this.ide.git;
        if (!git || !git.isRepo) {
            this.clear();
            return;
        }

        this.commits = git.log(HOW_MANY);

        this.filling = true;
        this.Commits.Clear();
        for (const c of this.commits)
            this.Commits.Add([c.sha, c.subject, c.when]);

        let at = this.sha ? this.commits.findIndex((c) => c.sha === this.sha) : -1;
        if (at < 0 && this.commits.length) at = 0;
        this.Commits.Index = at;
        this.filling = false;

        if (at >= 0) {
            this.sha = this.commits[at].sha;
            this.showFiles(force);
        } else {
            this.sha = "";
            this.files = [];
            this.filling = true;
            this.Files.Clear();
            this.filling = false;
        }
    }

    clear() {
        this.filling = true;
        this.Commits.Clear();
        this.Files.Clear();
        this.commits = [];
        this.files   = [];
        this.filling = false;
        this.sha     = "";
        this.file    = "";
    }

    choseCommit() {
        if (this.filling) return;
        const commit = this.commits[this.Commits.Index];
        if (commit) {
            this.sha = commit.sha;
            this.showFiles(true);
        }
    }

    showFiles(force) {
        const git = this.ide.git;
        this.files = this.sha ? git.filesIn(this.sha) : [];

        this.filling = true;
        this.Files.Clear();
        for (const f of this.files)
            this.Files.Add([f.path, this.wordFor(f.state)]);

        let at = this.file ? this.files.findIndex((f) => f.path === this.file) : -1;
        if (at < 0 && this.files.length) at = 0;
        this.Files.Index = at;
        this.filling = false;

        this.file = at >= 0 ? this.files[at].path : "";
        if (force) this.showFile();
    }

    choseFile() {
        if (this.filling) return;
        const file = this.files[this.Files.Index];
        this.file = file ? file.path : "";
        this.showFile();
    }

    /* Selecting a file is reading its diff: the tab is raised and the diff
     * page set. A commit with no file chosen shows the whole commit. */
    showFile() {
        this.ide.tabs.openGit();
        this.ide.gitTab.showCommit(this.sha, this.file);
    }

    /* Double clicking a file is going to the worktree's copy -- the version
     * that can be edited -- which is `LogForm`'s rule and still the right one. */
    openFile() {
        if (!this.file) return;
        if (File.Exists(File.Join(this.ide.project, this.file)))
            this.ide.openInTab(this.file);
    }

    wordFor(letter) {
        const said = {
            M: Locale.Text("changed"), A: Locale.Text("added"),
            D: Locale.Text("deleted"), R: Locale.Text("renamed"),
            C: Locale.Text("copied"),
        };
        return said[letter] || letter;
    }
}
