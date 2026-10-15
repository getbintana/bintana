/*
 * What has changed, as a page of the side panel.
 *
 * The *Changes* window (`GitForm`) is where a change is **read** -- two panes
 * of the file's own language, scrolled together, which is what answers *what am
 * I about to commit*. What it is not is a place to live: it is a window, it
 * covers the editor, and committing three edits over an afternoon meant opening
 * and closing it three times.
 *
 * So the list moves to where the project tree already is, in the side bar's
 * own chooser: the changed files, a box for the message, and the button that is
 * the whole of a small commit. Double clicking a row opens the window on **that
 * file**, which is the one thing the panel does not try to do itself -- a diff
 * in a 260-pixel column would be a worse answer than the one that already
 * exists.
 *
 * Prior art: this is Android Studio's *Commit* tool window, and IntelliJ's
 * before it -- a list of changed files and a message box, docked beside the
 * project tree rather than floating over it. Visual Studio's *Git Changes* pane
 * is the same shape. VB6 and Gambas have nothing like it, because neither has
 * git at all.
 *
 * **It runs no git of its own.** Every command is `Git`'s -- `stage`,
 * `unstage`, `discard`, `commit` -- which is also what the window's buttons
 * call, so *stage* has one set of guards and one spelling wherever it is
 * pressed. What this class owns is a tree, a signature of what it last drew,
 * and which path each row is about.
 *
 * **The list is a tree of two branches and a tick per file**, which is what
 * answers *which of these go in* without a selection: the files the last
 * commit already has and the ones it does not are the branches, and **a tick
 * is whether the file is in the index** -- ticking runs `git add`, unticking
 * `git restore --staged`, and *Commit* commits what is ticked, because what is
 * ticked is what is staged. The tick **does not move a row between the
 * branches**: a new file stays under *Unversioned* while it waits and crosses
 * when the commit puts it in the repository, which is the only thing that
 * versions it. A file that is staged and then edited again keeps one row: it
 * lives in the *Versioned* branch and the state column spells git's own two
 * letters, `MM` for *part in, part out*. Prior art for the ticks: IntelliJ's
 * commit tree, whose checkboxes are the same gesture, and VS Code's *Source
 * Control* view, which stages with one.
 */
"use strict";

/* The tick column. Room for the box and, on a branch, for the disclosure
 * arrow a tree draws in its first column. */
const CHECK_W = 48;
/* The columns: the tick, git's letters, and the name. `CellEdit` reports the
 * first and a branch's are locked, and a refresh writes the first two, by
 * index. */
const CHECK = 0;
const STATE = 1;
const FILE  = 2;
/* The branches' keys. A path can be anything, so neither of these is one. */
const VERSIONED_KEY   = "g:versioned";
const UNVERSIONED_KEY = "g:unversioned";

/* One file's row key. Prefixed for the same reason the branches' are: which
 * kind of row a key names is written in the key. */
function fileKey(path) { return `f:${path}`; }

export class Changes {

    /*
     * What this page contributes to the side bar: one row, shaped like the
     * ones `ProjectTree.sideEntries` returns -- the name the chooser says, what
     * the folded strip's button says and tries, which page of `SideStack` it
     * is, and what brings it up.  Kept beside the panel so another panel is a
     * row in its own file and a page in `MainForm.form`, with nothing counting
     * them.
     */
    static get sideEntries() {
        return [{
            text:  Locale.Text("Changes"),
            tip:   Locale.Text("Show the changes view"),
            /* The page with the pencil, the document `GitForm` wears as its
             * window icon: what is here is the project's edits. */
            icons: ["document-edit-symbolic", "document-properties-symbolic",
                    "bta-code-symbolic"],
            page:  1,
            show:  (ide) => ide.changes.shown(),
        }];
    }

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        /* The file rows, in the order the tree draws them, and the same
         * records by key: a table that is a tree addresses every row by its
         * key, so a command looks one up with the key an event carried. */
        this.rows  = [];
        this.byKey = new Map();
        /* Whether the columns are declared yet. **Once**: assigning `Columns`
         * builds new columns, and a width the reader dragged lives in the
         * ones they had. */
        this.dressed = false;
        /* What the table currently says, so a refresh with nothing new costs a
         * string compare -- `Events` next door makes the same bargain, and for
         * the same reason: this hangs off a method that runs on every edit. */
        this.drawn = null;
    }

    /* --- what it shows ------------------------------------------------------ */

    /*
     * Whether this view is the one on screen: **the page of the stack that is
     * up**, and not a number in the chooser's list, which a panel added before
     * this one would move.  Hidden, it is not kept up to date: showing it
     * redraws it, so there is nothing to lose and a `git status` per keystroke
     * to save.
     */
    get visible() {
        const stack = this.ide.SideStack;
        return !!stack && stack.Children[stack.Current] === this.ide.ChangesSplit;
    }

    /* The chooser moved here: whatever is in the tree was drawn for another
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
     * the cheap question first. The porcelain is already parsed: `Git.changes`
     * is what the window's two lists are made of too, and two readings of one
     * repository is how two lists come to disagree.
     */
    reload() {
        if (!this.visible) return;

        const git = this.ide.git;
        const all = git.isRepo ? git.changes() : [];
        const signature = all.map((c) => `${c.index}${c.tree}${c.path}`).join("\n");

        if (signature === this.drawn) return;

        this.drawn = signature;
        this.build(all);
    }

    /*
     * The tree.
     *
     * Two branches and **one row per path**, where the plain list had two for a
     * file staged and edited again: a tree addresses its rows by key and a path
     * is the key here, so the two halves are one row whose tick says *in the
     * index* and whose state letters say `MM` -- the same fact in git's own
     * spelling, and the tick that resolves it.
     *
     * **And it is updated in place, never rebuilt.** The columns are declared
     * once (`Clear()` + `Columns` on every refresh would throw away the width
     * a reader dragged) and a refresh writes the two cells that can differ: a
     * tick, a save or a commit changes *cells*, not the set of paths, and
     * taking the tree apart under the reader costs them three things that are
     * theirs -- the selection, the scroll and the columns. Ticking is the
     * commonest gesture here, and it must move nothing but the tick.
     *
     * A branch with nothing under it is not drawn: an empty tree is what the
     * label under it is for, and two empty folders would be a list of the ways
     * of saying nothing.
     */
    build(all) {
        const table = this.ide.ChangeTable;

        if (!this.dressed) {
            this.dressed = true;
            table.Columns = [
                { Text: "", Width: CHECK_W, Alignment: "Center",
                  Editor: { Kind: "Check", ActiveText: "true", InactiveText: "false" } },
                /* The state column sizes itself: its heading is a word and the
                 * cells are git's one or two letters, and a width that fitted
                 * the letters cut the heading off in Spanish. */
                { Text: Locale.Text("State") },
                { Text: Locale.Text("File") } ];
        }

        /*
         * What is gone goes first, so a branch left with nothing can go with
         * it: a path that is no longer changed -- committed, put back, gone --
         * takes its row out, and everything else is a write into a cell the
         * row already has. `was` is what the last refresh left, which is what
         * tells an add from a write.
         */
        const was  = this.byKey;
        const want = new Map(all.map((c) => [fileKey(c.path), c]));

        for (const k of [...was.keys()])
            if (!want.has(k)) table.RemoveNode(k);

        this.byKey = new Map();

        this.branch(VERSIONED_KEY, Locale.Text("Versioned"),
                    all.filter((c) => c.versioned), table, was);
        this.branch(UNVERSIONED_KEY, Locale.Text("Unversioned"),
                    all.filter((c) => !c.versioned), table, was);

        this.rows = all;

        this.say();
    }

    /*
     * One branch: its node and the files under it.
     *
     * **The header wears the theme's `heading` and its tick is every file
     * under it**: clicking it stages the whole branch or takes the whole
     * branch out, which is what a group checkbox means everywhere else. A
     * `Check` cell has no third state, so a branch that is only half in reads
     * as unchecked and one click puts it all in -- stated here because the
     * box cannot say it.
     *
     * The file rows are added, moved or written, whichever this refresh did to
     * them. **A key cannot change parent**, so the one case that has to go
     * through remove-and-add is a path crossing between the branches -- a
     * commit that puts a new file in the repository while the worktree still
     * differs from it.
     */
    branch(key, text, rows, table, was) {
        if (!rows.length && table.Exists(key)) {
            table.RemoveNode(key);
            return;
        }

        const all = rows.every((c) => c.staged) ? "true" : "false";

        if (rows.length && !table.Exists(key)) {
            table.Add([all, "", text], { Key: key });
            table.SetStyle(key, FILE, "heading");
        } else if (rows.length) {
            table.SetCell(key, CHECK, all);
        }

        for (const c of rows) {
            const k  = fileKey(c.path);
            const at = was.get(k);

            if (at && at.versioned !== c.versioned) {
                /* The other branch's node may have taken it away a line ago. */
                if (table.Exists(k))
                    table.RemoveNode(k);
                table.Add([c.staged ? "true" : "false", this.letters(c), c.path],
                          { Key: k, Parent: key });
            } else if (at) {
                table.SetCell(k, CHECK, c.staged ? "true" : "false");
                table.SetCell(k, STATE, this.letters(c));
            } else {
                table.Add([c.staged ? "true" : "false", this.letters(c), c.path],
                          { Key: k, Parent: key });
            }
            this.byKey.set(k, c);
        }
    }

    /*
     * Git's own two letters, trimmed: `M` is one side of the record changing,
     * `MM` both -- part of the file in the index and part not -- which is the
     * case a single letter cannot describe.
     */
    letters(c) {
        return c.untracked ? "?" : `${c.index.trim()}${c.tree.trim()}`;
    }

    /*
     * The line under the tree, which is the one thing the status bar cannot say
     * from here: whether the button is about to do anything.
     *
     * The ticks are not read here: a tick is the index, and `Git.staged` is its
     * count -- one answer, and the panel is not a second one that could drift.
     */
    say() {
        const ide     = this.ide;
        const staged  = ide.git.staged;
        const message = ide.TxtCommit.Text.trim();
        const what    = this.chosen();

        ide.BtnChCommit.Enabled = staged > 0 && message !== "";

        ide.BtnChCommit.Tooltip = !staged
            ? Locale.Text("Nothing is staged")
            : Locale.Text("Commit what is staged, with the message above");

        /*
         * An empty tree has two meanings and they are not the same news, so it
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
         * not with a keystroke. *Discard* is about the worktree and needs
         * something left in it -- a row whose only change is staged has nothing
         * to throw away, and a branch is not a file at all. *Add to .gitignore*
         * is about a file git has never been told about, and only there: an
         * entry written for a tracked file would do nothing.
         */
        ide.MnuChDiscard.Enabled = what.some((r) => r.untracked || r.tree !== " ");
        ide.MnuChIgnore.Enabled  = what.some((r) => r.untracked);
        ide.MnuChDiff.Enabled    = what.length > 0;
        ide.MnuChOpen.Enabled    = what.length > 0;
        ide.MnuChAll.Enabled     = ide.git.isRepo;
        ide.MnuChWindow.Enabled  = ide.git.isRepo;
    }

    /* --- what is chosen ----------------------------------------------------- */

    /* The key a path's row has -- a tree addresses rows by key, and this is
     * the one place the shape of them is written. */
    keyOf(path) { return fileKey(path); }

    /*
     * The file the row menu acts on: the selected node, when it is one. A
     * branch is a node of the tree too, and there is no path behind it for any
     * of the commands.
     */
    chosen() {
        const table = this.ide.ChangeTable;
        const row   = table ? this.byKey.get(table.Key) : null;

        return row ? [row] : [];
    }

    paths(what) {
        return [...new Set(what.map((r) => r.path))];
    }

    /* --- the commands ------------------------------------------------------- */

    /*
     * The tick, which is what the panel means by *this one goes in*: the same
     * two `Git` commands the window's buttons press, so *stage* has one set of
     * guards and one spelling. A **branch's** key is the whole of it -- every
     * path under it, in one `git add` -- which is the header's click. What
     * comes back is the cell's new text -- or `false`, which puts the tick back
     * where it was, when git refused.
     *
     * The tree is written into and not rebuilt (`after`), so the reader keeps
     * their place; a refused command is the only case where the cells stay as
     * they were and the tick the reader turned goes back.
     */
    ticked(key, text) {
        const row   = this.byKey.get(key);
        const paths = row ? [row.path] : this.pathsOf(key);

        if (!paths.length) return false;

        const r = text === "true" ? this.ide.git.stage(paths)
                                  : this.ide.git.unstage(paths);

        this.after();
        return r.ok ? text : false;
    }

    /* The paths a branch stands for, in the order the tree draws them: what
     * its own tick takes in or out in one gesture. */
    pathsOf(key) {
        if (key !== VERSIONED_KEY && key !== UNVERSIONED_KEY) return [];

        const on = key === VERSIONED_KEY;
        return this.rows.filter((c) => c.versioned === on).map((c) => c.path);
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
     * with no undo. An untracked file is **deleted** and not restored, which is
     * a different sentence and is said as one; which files those are is
     * `Git.untracked`, so the wording and the work agree by construction. Only
     * what the worktree holds is a subject: a row whose change is staged and
     * nothing else keeps its place in the index.
     */
    discard() {
        const what = this.chosen().filter((r) => r.untracked || r.tree !== " ");
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
                try {
                    this.ide.git.discard(files);
                } finally {
                    /* The files changed underneath whatever is open: each tab
                     * is watching its own and the reload bar is what that
                     * looks like -- and what did go has gone, error or not. */
                    this.after();
                    this.ide.listFiles();
                }
            });
    }

    /*
     * The chosen file to `.gitignore` -- *I never want to see this again*,
     * which is what the row menu offers for a file git has never been told
     * about. Only that one: an entry changes nothing about a file that is
     * already tracked, and offering it there would be offering a no-op.
     *
     * The writing is `Git`'s (`ignore`), which is where the repository's own
     * files live; what is here is the gesture and the refresh -- the row leaves
     * because git stops reporting it, and the tree's indicator has to go with
     * it.
     */
    ignore() {
        const row = this.chosen()[0];
        if (!row || !row.untracked) return;

        if (!this.ide.git.ignore(row.path)) return;

        this.after();
        this.ide.listFiles();
    }

    /*
     * The commit, from the box above the button.
     *
     * What is committed is **what is staged** and never what is selected:
     * ticking stages a file, one tick at a time, and a button that quietly
     * staged something first would make *Commit* mean two different things
     * depending on where the pointer had been.
     */
    commit() {
        const message = this.ide.TxtCommit.Text.trim();

        if (!message || !this.ide.git.staged) return;

        const r = this.ide.git.commit(message);
        if (r.ok) this.ide.TxtCommit.Text = "";

        this.after();
    }

    /*
     * Read the diff of the chosen row, in the window that exists for it. The
     * side it lands on is the half with something left in it: the worktree's,
     * or the index's when the only change is staged.
     */
    show() {
        const row = this.chosen()[0];
        if (!row) return;

        GitForm.openAt(this.ide, row.path, !row.untracked && row.tree === " ");
    }

    /* The file itself, in a tab -- the worktree's copy, which is the one that
     * can be edited. `openInTab` is the tree's own door, and it answers false
     * for a file that is gone, which a deleted row is. */
    open() {
        const row = this.chosen()[0];
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
}
