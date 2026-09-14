/*
 * What is about to be committed, where it can be read.
 *
 * The IDE already had a way to *run* git -- the Terminal tab, a real shell in
 * the project's directory. What it had no home for is the one thing git is for
 * in daily work: **seeing the diff before committing**. As monochrome text in a
 * terminal, with no file list, no staging and no way back to the editor.
 *
 * A window of its own and not a tab, and one raised rather than stacked: the
 * whole point of reading a diff is to go back to the code behind it, which is
 * the argument `SearchForm` already made for the same shape.
 *
 * **Side by side is the view that answers the question.** A unified hunk is a
 * format for sending a change somewhere; two panes of the file's own language,
 * scrolled together, are how a person reads what they are about to commit. The
 * unified tab is the net underneath -- a rename, a binary, something too big to
 * put in two buffers -- where saying so is better than filling the panes with
 * something unreadable.
 *
 * Where each half comes from is the position of the left switcher:
 *
 *   not staged   before: the index (`git show :path`)     after: the file on disk
 *   staged       before: the last commit (`HEAD:path`)    after: the index
 *
 * Which is what makes the two lists mean something: the left one is *what you
 * have not put in yet* and the right one *what you have*.
 */
"use strict";

/* While it is open nothing else references it, and a window with no reference
 * is collected out from under its own handlers. One at a time, which is what
 * makes raising it the right answer to being asked for twice. */
let openGit = null;

/* Past this a file is not read into two buffers: a diff of a generated file or
 * a vendored library is not something anybody reads line against line, and two
 * SourceEditors full of it cost seconds. The unified tab still says what it is. */
const BIG_FILE = 4000;

class GitForm extends Form {

    /*
     * Opened, or raised if it is already up.
     *
     * Raised and not opened twice: two windows over one repository would answer
     * differently the moment one of them staged something, and which was right
     * would be whichever had refreshed last.
     */
    static open(ide) {
        if (openGit) {
            openGit.reload();
            openGit.Show();
            return openGit;
        }

        const win = new GitForm();
        win.ide = ide;
        win.Text = Locale.Text("Changes -- {0}", File.Name(ide.project));
        win.setup();
        openGit = win;
        win.Show();
        win.reload();
        return win;
    }

    setup() {
        const columns = [{ Text: Locale.Text("File") },
                         { Text: Locale.Text("State"), Width: 70 }];

        this.Unstaged.Columns = columns;
        this.Staged.Columns   = columns;
        this.Unstaged.MultiSelect = true;
        this.Staged.MultiSelect   = true;
        /* Which list is on screen; the rest of this file asks `list()`. */
        this.paths = { 0: [], 1: [] };
    }

    /* --- the lists ---------------------------------------------------------- */

    /*
     * Everything git says has changed, split into the two questions.
     *
     * Read from the porcelain the IDE already parses rather than from a second
     * command: `Ide.Git.status` is what the tree's indicators come from too, and
     * two readings of one repository is how a window and a tree come to
     * disagree.
     */
    reload() {
        if (!this.ready) return;

        const git = this.ide.git;
        const keep = [this.Unstaged.Index, this.Staged.Index];

        git.refresh();
        git.markTree();

        this.Unstaged.Clear();
        this.Staged.Clear();
        this.paths = { 0: [], 1: [] };

        const rows = git.split();

        for (const row of rows.unstaged) {
            this.Unstaged.Add([row.path, this.words(row.state)]);
            this.paths[0].push(row.path);
        }
        for (const row of rows.staged) {
            this.Staged.Add([row.path, this.words(row.state)]);
            this.paths[1].push(row.path);
        }

        /* Where it was, when it is still there: reloading after staging one file
         * of eight must not send the reader back to the top. */
        this.Unstaged.Index = Math.min(keep[0], this.paths[0].length - 1);
        this.Staged.Index   = Math.min(keep[1], this.paths[1].length - 1);

        this.say();
        this.showChosen();
    }

    /* A state letter, as a word. The letters are git's contract and fine in a
     * commit hook; a person reading a list wants the word. */
    words(letter) {
        const said = {
            M: Locale.Text("changed"),
            A: Locale.Text("added"),
            D: Locale.Text("deleted"),
            R: Locale.Text("renamed"),
            C: Locale.Text("copied"),
            U: Locale.Text("conflicted"),
            "?": Locale.Text("untracked"),
        };
        return said[letter] || letter;
    }

    /*
     * Whether this window is built yet.
     *
     * **A `Switcher` raises `Switch` while the `.form` is still loading** --
     * when its first page makes `Current` go from nothing to zero -- and the
     * `.form` is read inside `Form`'s own constructor, so the handler runs
     * before `open()` has had a chance to say which IDE this belongs to, and
     * before the loader has finished naming the controls. `AGENTS.md` has the
     * entry; this is the second window to walk into it, which is why the guard
     * is one question asked in one place rather than a check per handler.
     */
    get ready() { return this.ide !== undefined && this.Which !== undefined; }

    /* Which list is showing, and what is chosen in it. */
    side()  { return this.ready && this.Which.Current === 1 ? 1 : 0; }
    table() { return this.side() ? this.Staged : this.Unstaged; }

    chosen() {
        if (!this.ready) return [];

        const table = this.table();
        const all   = this.paths[this.side()];
        const rows  = table.Selection.length ? table.Selection
                    : (table.Index >= 0 ? [table.Index] : []);

        return rows.map((i) => all[i]).filter(Boolean);
    }

    /* --- the diff ----------------------------------------------------------- */

    /*
     * The two halves of whatever row is chosen.
     *
     * On `Select` and not on `Activate`, which is the opposite of the project
     * tree's rule and for the opposite reason: there is nothing to open here,
     * the panes *are* the answer, and a list where one had to double click to
     * see anything would make reading eight files eight double clicks. Walking
     * it with the arrow keys costs two `git show`s a row, which end in
     * milliseconds.
     */
    showChosen() {
        if (!this.ready) return;

        const path = this.chosen()[0];

        if (!path) {
            this.Before.Text = this.After.Text = this.Unified.Text = "";
            return;
        }

        const staged = this.side() === 1;
        const git    = this.ide.git;

        /* The unified view is what git itself says, which is also the only
         * thing that can describe a rename or a binary. */
        this.Unified.Text = git.diff(path, staged);

        const before = staged ? git.show("HEAD", path) : git.show("", path);
        const after  = staged ? git.show("", path) : this.worktree(path);

        const tooBig = (t) => t !== null && t.split("\n").length > BIG_FILE;

        if (tooBig(before) || tooBig(after)) {
            const note = Locale.Text("Too big to show side by side. The unified tab has it.");
            this.Before.Text = this.After.Text = note;
        } else {
            this.Before.Text = before === null ? "" : before;
            this.After.Text  = after  === null ? "" : after;
        }

        /*
         * The file's own language in both panes, asked of the machine rather
         * than mapped here: `PropertyOptions("Language")` is the honest list and
         * the extensions the IDE already opens are the same ones.
         */
        const lang = this.languageOf(path);
        this.Before.Language = lang;
        this.After.Language  = lang;

        this.Before.ScrollY = 0;
        this.After.ScrollY  = 0;
    }

    /* The worktree's copy, or null where there is none -- a deleted file. */
    worktree(path) {
        const full = File.Join(this.ide.project, path);
        if (!File.Exists(full)) return null;

        try {
            return File.Load(full);
        } catch (e) {
            return null;                 /* binary, or unreadable */
        }
    }

    languageOf(path) {
        const by = { js: "js", json: "json", form: "json", css: "css",
                     md: "markdown", c: "c", h: "c", sh: "sh", po: "", pot: "" };
        return by[File.Extension(path).toLowerCase()] || "";
    }

    /* --- what the buttons do ------------------------------------------------ */

    /*
     * Staging, and its two guards.
     *
     * The files on screen are what the commands act on -- never a path typed
     * anywhere -- so `--` is what separates them from anything git could read as
     * an option, and a file called `-f` is a file and not a flag.
     */
    BtnStage_Click()   { this.act(["add", "--"]); }
    BtnUnstage_Click() { this.act(["restore", "--staged", "--"]); }

    act(command) {
        const files = this.chosen();
        if (!files.length) return;

        const r = this.ide.git.run([...command, ...files]);
        if (!r.ok) this.ide.log(`git: ${r.out.trim()}\n`);

        this.reload();
        this.ide.refresh();
    }

    /*
     * Throwing work away, which is the one thing here with no undo.
     *
     * Asked first and by name, because *Discard* beside *Unstage* is one row
     * over from something harmless. An untracked file is not restored but
     * deleted -- `git restore` has nothing to restore it from -- which is a
     * different sentence and is said as one.
     */
    BtnDiscard_Click() {
        const files = this.chosen();
        if (!files.length) return;

        const git   = this.ide.git;
        const fresh = files.filter((f) => git.stateOf(f) === "?");
        const known = files.filter((f) => git.stateOf(f) !== "?");

        ConfirmForm.ask(
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
                if (known.length) git.run(["restore", "--", ...known]);
                for (const f of fresh) File.Delete(File.Join(this.ide.project, f));

                /* The worktree changed underneath: the tabs are watching their
                 * files and will offer to reload, which is what that bar is for. */
                this.reload();
                this.ide.listFiles();
            });
    }

    /*
     * The commit.
     *
     * `-F -` would be the way to hand a message over without a shell quoting it,
     * and `Exec` takes an argv rather than a command line, so `-m` with the text
     * as its own argument is already safe: nothing between here and git can read
     * a newline or a quote as anything.
     */
    BtnCommit_Click() {
        const message = this.Message.Text.trim();

        if (!message) {
            this.LblGitStatus.Text = Locale.Text("A commit needs a message.");
            return;
        }
        if (!this.ide.git.staged) {
            this.LblGitStatus.Text = Locale.Text("Nothing is staged.");
            return;
        }

        const r = this.ide.git.run(["commit", "-m", message]);
        this.ide.log(`${r.out.trim()}\n`);

        if (r.ok) this.Message.Text = "";
        this.reload();
        this.ide.refresh();
    }

    BtnClose_Click() { this.Close(); }

    /* --- events -------------------------------------------------------------- */

    /*
     * The two panes, locked.
     *
     * This is what `ISSUE-editor-scroll` was filed for and what filling it
     * bought: before `ScrollY` the best a diff viewer could do was follow the
     * *cursor*, which keeps the carets together and leaves the views apart.
     * Assigning a value an adjustment already has emits nothing, so the two
     * pointing at each other settle after one event rather than bouncing.
     */
    Before_Scroll(x, y) { if (this.ready) this.After.ScrollY = y; }
    After_Scroll(x, y)  { if (this.ready) this.Before.ScrollY = y; }

    Unstaged_Select() { this.showChosen(); }
    Staged_Select()   { this.showChosen(); }
    Which_Switch()    { this.showChosen(); this.say(); }
    How_Switch()      { this.showChosen(); }

    /* Double clicking a file opens it in the IDE behind this window, which is
     * where a diff is usually read on the way to. */
    Unstaged_Activate() { this.goTo(); }
    Staged_Activate()   { this.goTo(); }

    /*
     * Opening the file behind this window.
     *
     * `Show()` on a window that is already up is what raises it -- the IDE is
     * behind this one by construction, and a diff is usually read on the way to
     * the code. This window stays open: going back to it is the next thing
     * somebody does.
     */
    goTo() {
        const path = this.chosen()[0];
        if (path && this.ide.openInTab(path)) this.ide.Show();
    }

    say() {
        if (!this.ready) return;

        const git = this.ide.git;
        this.LblGitStatus.Text = git.summary();
        this.BtnStage.Enabled   = this.side() === 0;
        this.BtnUnstage.Enabled = this.side() === 1;
        this.BtnDiscard.Enabled = this.side() === 0;
    }

    /* Letting go of itself, on every road out -- the button, Escape and the
     * frame's X. It must not return true: `Form_Close` is a veto. */
    Form_Close() {
        if (openGit === this) openGit = null;
    }
}
