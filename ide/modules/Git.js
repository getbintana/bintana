/*
 * Git, as far as the IDE needs it.
 *
 * **The engine is the git CLI and not a binding**, which is the bargain
 * `Translations` already makes with `msgmerge` and `Exporter` with `tar`: ask
 * `Application.HasCommand` first, say the sentence when the tool is missing,
 * run the tool. A library would be a new dependency for something every machine
 * that has a project in git already has.
 *
 * **Everything that answers a question blocks**; everything that touches the
 * network does not. `rev-parse`, `status`, `branch` and `show` end in
 * milliseconds and go through `Exec.Wait`, which is what it was written for --
 * `git status` is its own reference page's example. `pull`, `push` and `fetch`
 * are somebody else's server and go through `Exec` into the log pane, the
 * `Runner` mould, cancellable and signalling the whole process group.
 *
 * **What it never does is authenticate.** A remote that wants a password gets
 * the system's credential helper, and when there is none the answer is a line
 * in the log pointing at the Terminal tab that has been there all along. No
 * secret is stored, which is the refusal `Video` already makes with an RTSP
 * password that never reads back.
 *
 * The IDE asks this class and this class asks git; nothing else in `ide/` runs
 * a child of its own, so where the worktree is disagreed with is one file.
 */
"use strict";

Namespace("Ide");

/*
 * What a remote is **never** allowed to do: ask.
 *
 * This is the practical half of *no authentication of its own*. A `git push`
 * whose remote wants a password has a tty in a terminal and does not here, so
 * it would reach for an askpass helper -- opening a window of its own from
 * inside the IDE -- or sit there waiting on a prompt nobody can see, with the
 * Stop button as the only way out and no line in the log saying why.
 *
 * `GIT_TERMINAL_PROMPT=0` makes it **fail fast and say so**, which is exactly
 * the answer the plan wants: a line in the log pointing at the Terminal tab,
 * where a person can answer a prompt like a person. A configured credential
 * helper still works -- that is a helper answering, not a prompt -- which is
 * the case somebody who has set one up expects to keep working.
 *
 * `SSH_ASKPASS_REQUIRE=never` is the same sentence to ssh, which has its own
 * idea about opening a dialog.
 */
const NO_PROMPT = {
    GIT_TERMINAL_PROMPT:  "0",
    SSH_ASKPASS_REQUIRE:  "never",
    GIT_ASKPASS:          "",
};

/* Long enough for a big repository, short enough that a hung child does not
 * take the IDE with it. `Exec.Wait` blocks the main loop: that is the whole
 * reason it is only used for questions that answer in milliseconds. */
const GIT_TIMEOUT = 8000;

/*
 * What `status --porcelain=v1 -z` says about a path, as one letter.
 *
 * The two columns are the index and the worktree, and the IDE shows one
 * indicator per file -- so a file staged *and* then edited reads as its
 * worktree state, which is the one that answers "is there something left to
 * do". `??` is untracked and `!!` ignored, neither of which is a two-column
 * state at all.
 */
const UNTRACKED = "?";

Ide.Git = class Git {

    constructor(ide) {
        this.ide = ide;
        /* What the last `status` said: path -> letter. Kept because the tree
         * and the status bar both read it, and neither should spawn a child. */
        this.states = new Map();
        this.branchName = "";
        this.staged = 0;
        this.changed = 0;
        /* A network job while there is one, for Stop to reach. */
        this.job = null;
        /* The remotes as of the last refresh. Kept for the same reason the
         * branches are filled outside `refresh()`: the menu asks whether there
         * is anywhere to fetch from on every keystroke, and the answer costs a
         * child process. */
        this.remoteNames = [];
    }

    /* --- what this machine and this project can do -------------------------- */

    /*
     * Whether git is installed at all, asked once per run of the IDE.
     *
     * A fact about the machine, and the machine does not grow a git while the
     * IDE is open -- the same reason `Styles` reads the theme once.
     */
    get available() {
        if (this.hasGit === undefined)
            this.hasGit = Application.HasCommand("git");

        return this.hasGit;
    }

    /*
     * Whether the open project is inside a working tree.
     *
     * `rev-parse --is-inside-work-tree` and not "is there a `.git` directory":
     * a project in a subdirectory of a repository is in one, a worktree added
     * with `git worktree` has a `.git` *file*, and a submodule has neither
     * shape. Asking git is the only answer that is right in all three.
     */
    get isRepo() {
        if (!this.available || !this.ide.project) return false;
        if (this.repoOf === this.ide.project) return this.inRepo;

        const r = this.run(["rev-parse", "--is-inside-work-tree"]);

        this.repoOf = this.ide.project;
        this.inRepo = r.ok && r.out.trim() === "true";
        return this.inRepo;
    }

    /* The project is another one, or has become a repository since. */
    forget() {
        this.repoOf = null;
        this.states = new Map();
        this.branchName = "";
        this.staged = this.changed = 0;
        this.distance = null;
        this.remoteNames = [];
    }

    /* --- running it --------------------------------------------------------- */

    /*
     * A question, answered now.
     *
     * `{ ok, out, code }` and never an exception: every caller here has
     * something to do with a failure -- a repository that is not one, a file
     * with no version in the index -- and none of them wants a traceback for it.
     */
    run(args) {
        if (!this.available || !this.ide.project)
            return { ok: false, out: "", code: -1 };

        const r = Exec.Wait(["git", "-C", this.ide.project, ...args],
                            { Timeout: GIT_TIMEOUT });

        return { ok: r.ExitCode === 0, out: r.Output, code: r.ExitCode };
    }

    /*
     * Something that talks to a server, into the log pane.
     *
     * Never `Wait`: a fetch over a slow link would freeze the IDE for as long
     * as it took, with no way to stop it and nothing on screen saying why.
     * This is `Runner.start` with a different child.
     */
    remote(args, done) {
        if (this.job) return false;

        this.ide.log(`> git ${args.join(" ")}\n`);
        this.job = Exec(["git", "-C", this.ide.project, ...args],
                        { Directory: this.ide.project, Environment: NO_PROMPT },
                        (line) => this.ide.log(`${line}\n`),
                        (code) => {
                            this.job = null;
                            this.ide.log(code === 0 ? "[git ok]\n"
                                                    : `[git failed: ${code}]\n`);
                            /* The worktree may be another one now. */
                            this.refresh();
                            this.ide.refresh();
                            if (done) done(code === 0);
                        });
        this.ide.refresh();
        return true;
    }

    stop() {
        if (this.job) this.job.Stop();
    }

    /* --- what it says about the project ------------------------------------- */

    /*
     * The branch, or what to say when there is not one.
     *
     * A repository with no commit yet has a branch name and no commit to point
     * it at, and a checkout of a tag or a bare commit has a commit and no
     * branch. `--abbrev-ref HEAD` answers `HEAD` for the second, which is git's
     * own word for *detached* and not a name to show.
     */
    branch() {
        const r = this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
        const name = r.ok ? r.out.trim() : "";

        return name === "HEAD" || name === "" ? "" : name;
    }

    /*
     * Every changed path, parsed out of the porcelain.
     *
     * **`--porcelain=v1 -z`, and never the human output.** The human one is
     * translated -- the IDE would read `modificado` on this machine -- and the
     * porcelain is a documented contract. `-z` is what survives a file name
     * with a space or an accent in it, which is not an edge case in a project
     * written in Spanish.
     *
     * A record is `XY<space><path>`, NUL-terminated; a rename is
     * `R<something><NUL>old<NUL>new`, so the *old* name arrives as a record of
     * its own and is consumed here rather than read as a path with no state.
     */
    status() {
        const out = new Map();
        const r   = this.run(["status", "--porcelain=v1", "-z"]);

        if (!r.ok) return out;

        const parts = r.out.split("\0");
        let staged = 0, changed = 0;

        for (let i = 0; i < parts.length; i++) {
            const record = parts[i];
            if (record.length < 4) continue;          /* "" and any tail */

            const index = record[0];
            const tree  = record[1];
            const path  = record.slice(3);

            /* A rename's second path is the next record, and belongs to this
             * one: consuming it here is what stops it being read as a file
             * whose state is the first letter of its own name. */
            if (index === "R" || index === "C") {
                const to = parts[++i];
                if (to) out.set(to, index);
                out.set(path, "D");
                staged++;
                continue;
            }

            if (index === "?" ) {
                out.set(path, UNTRACKED);
                changed++;
                continue;
            }
            if (index === "!") continue;               /* ignored */

            /*
             * One letter for a file that may have two states. The worktree's
             * wins when there is one, because what it answers is *is there
             * something left to do here* -- a file staged and then edited again
             * is not a file that is ready.
             */
            out.set(path, tree !== " " ? tree : index);
            if (index !== " ") staged++;
            if (tree !== " ") changed++;
        }

        this.staged  = staged;
        this.changed = changed;
        return out;
    }

    /* Asked again, and everything that shows it brought up to date. */
    refresh() {
        if (!this.isRepo) {
            this.forget();
            return;
        }

        this.states      = this.status();
        this.branchName  = this.branch();
        this.distance    = this.aheadBehind();
        this.remoteNames = this.remotes();
    }

    /* The letter for a path of the project, or `""`. */
    stateOf(name) {
        return this.states.get(name) || "";
    }

    /*
     * A file as some version of it has it, or null.
     *
     * `git show :<path>` is the index and `HEAD:<path>` the last commit, which
     * are the two *befores* a diff can want. Null and not `""` for a path that
     * version does not have: a file that was just added has no version in HEAD,
     * and showing it as an empty file is exactly right for a diff and exactly
     * wrong for anything that asks whether it is there.
     */
    show(where, name) {
        const r = this.run(["show", `${where}:${name}`]);
        return r.ok ? r.out : null;
    }

    /* --- remotes ----------------------------------------------------------- */

    /* Whether there is anywhere to push to. A repository with no remote is an
     * ordinary thing -- `git init` makes one -- and the commands that need one
     * are off rather than failing when they are pressed. */
    remotes() {
        const r = this.run(["remote"]);
        return r.ok ? r.out.split("\n").filter((n) => n !== "") : [];
    }

    /*
     * How far the branch is from the one it follows, as `{ ahead, behind }`.
     *
     * `null` when the branch follows nothing, which is not a failure: a branch
     * made here and never pushed has no upstream, and answering `0, 0` would say
     * *you are in step with something* about a thing there is nothing to be in
     * step with.
     *
     * **It counts what was last fetched** and never talks to the server -- that
     * is `fetch`'s job and it is the one command here that takes as long as the
     * network does. A number that went to the network on every refresh would put
     * the status bar behind a round trip.
     */
    aheadBehind() {
        const r = this.run(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
        if (!r.ok) return null;

        const [behind, ahead] = r.out.trim().split(/\s+/).map(Number);
        return { ahead: ahead || 0, behind: behind || 0 };
    }

    /*
     * The three that talk to a server.
     *
     * All through `remote`, which is `Exec` into the log pane and not
     * `Exec.Wait`: these take as long as somebody else's server does, and a
     * `Wait` would freeze the IDE for that long with no way to stop it. The Stop
     * button reaches them, and reaches the whole process group -- git spawns ssh
     * and ssh is the one actually waiting.
     */
    fetch(done) { return this.remote(["fetch", "--all", "--prune"], done); }

    /*
     * Cloning, which is the one command here that runs where there is no
     * project: `run` and `remote` both pass `-C <project>` and there is not one
     * yet. It is still this class's child, because *nothing else in `ide/` runs
     * a child of its own* is what makes the worktree one file's business -- and
     * it takes `this.job`, so the Stop button reaches a clone of something big
     * exactly as it reaches a fetch.
     */
    clone(url, where, done) {
        if (this.job || !this.available) return false;

        this.ide.log(`> git clone ${url}\n`);
        this.job = Exec(["git", "clone", "--", url, where],
                        { Directory: File.Directory(where), Environment: NO_PROMPT },
                        (line) => this.ide.log(`${line}\n`),
                        (code) => {
                            this.job = null;
                            this.ide.log(code === 0 ? "[git ok]\n"
                                                    : `[git failed: ${code}]\n`);
                            this.ide.refresh();
                            if (done) done(code === 0);
                        });
        this.ide.refresh();
        return true;
    }
    pull(done)  { return this.remote(["pull", "--ff-only"], done); }

    /*
     * Pushing, and the one flag it carries.
     *
     * `--set-upstream` on a branch that follows nothing, because the alternative
     * is git refusing with an instruction to re-run the command with that flag,
     * which is a computer asking a person to retype what it already knows. On a
     * branch that has one it is absent and the push is an ordinary push.
     */
    push(done) {
        const args = ["push"];

        if (!this.aheadBehind() && this.branchName)
            args.push("--set-upstream", "origin", this.branchName);

        return this.remote(args, done);
    }

    /* --- changing what is about to be committed ----------------------------- */

    /*
     * Staging, unstaging, and the `--` that is not decoration.
     *
     * What these act on are **paths git itself named** -- the porcelain's own
     * output, never a string typed anywhere -- and `--` is what keeps a file
     * called `-f` a file and not a flag. They live here rather than in the
     * window that has the buttons because the side panel has the same commands,
     * and two implementations of *stage* would be two sets of guards.
     */
    stage(paths)   { return this.act(["add", "--"], paths); }
    unstage(paths) { return this.act(["restore", "--staged", "--"], paths); }

    act(command, paths) {
        if (!paths || !paths.length) return { ok: true, out: "", code: 0 };

        const r = this.run([...command, ...paths]);
        if (!r.ok) this.ide.log(`git: ${r.out.trim()}\n`);
        return r;
    }

    /*
     * Throwing work away, which is the one thing here with no undo.
     *
     * **An untracked file is deleted and not restored**: `git restore` has
     * nothing to restore it from, so the two halves are two different
     * operations, and the caller's question ("are you sure?") is two different
     * sentences. Asking is the caller's job -- a module does not open windows --
     * and telling them apart is `untracked` below, which is what the caller asks
     * to word it.
     */
    discard(paths) {
        const known = paths.filter((f) => this.stateOf(f) !== UNTRACKED);
        const fresh = paths.filter((f) => this.stateOf(f) === UNTRACKED);

        if (known.length) this.run(["restore", "--", ...known]);
        for (const f of fresh) File.Delete(File.Join(this.ide.project, f));
    }

    /* Which of these git has never been told about, so a caller can say
     * *deleted* rather than *restored* about them. */
    untracked(paths) {
        return paths.filter((f) => this.stateOf(f) === UNTRACKED);
    }

    /*
     * The commit.
     *
     * `-m` with the message as its **own argument**, which is already safe:
     * `Exec` takes an argv and not a command line, so nothing between here and
     * git can read a newline or a quote in it as anything. `-F -` would be the
     * answer if there were a shell in the way, and there is not.
     */
    commit(message) {
        const r = this.run(["commit", "-m", message]);
        this.ide.log(`${r.out.trim()}\n`);
        return r;
    }

    /* --- branches -------------------------------------------------------- */

    /*
     * Every local branch, in git's own order.
     *
     * `for-each-ref` and not `branch`: the latter draws a `*` beside the current
     * one and indents the rest, which is a display and not a list -- and it
     * translates nothing but is still formatting meant for a person. A ref name
     * cannot contain a newline, so one per line is unambiguous here in a way it
     * is not for paths.
     */
    branches() {
        const r = this.run(["for-each-ref", "--format=%(refname:short)",
                            "refs/heads"]);

        return r.ok ? r.out.split("\n").filter((n) => n !== "") : [];
    }

    /*
     * Moving to another branch, or making one.
     *
     * `switch` and not `checkout`: they overlap, and the overlap is the problem
     * -- `git checkout <name>` moves to a branch or throws away a file's changes
     * depending on what the name turns out to be, which is the ambiguity `switch`
     * and `restore` were split out to end. A branch name that is also a path is
     * not a hypothetical in a project whose folders are called `forms` and
     * `modules`.
     */
    switchTo(name) {
        return this.run(["switch", "--", name]);
    }

    newBranch(name) {
        return this.run(["switch", "-c", name]);
    }

    /*
     * Deleting one, and never with `-D`.
     *
     * `-d` refuses a branch whose commits are on no other branch, which is git
     * saying *this would lose work*. Offering a force here would be offering to
     * ignore the one check that matters; what the IDE does with the refusal is
     * show it, and the Terminal tab is where somebody who means it goes.
     */
    deleteBranch(name) {
        return this.run(["branch", "-d", "--", name]);
    }

    /* --- the log ----------------------------------------------------------- */

    /*
     * The last commits, as records.
     *
     * `-z` between commits and `%x1f` between the fields of one: a subject can
     * contain anything a person can type, including the tabs and newlines that
     * every other separator would be. Which is the same argument `status -z`
     * makes, and it only became possible when `Exec.Wait` stopped ending its
     * answer at the first NUL.
     */
    log(count) {
        const r = this.run(["log", "-z", `--max-count=${count || 60}`,
                            "--format=%h%x1f%an%x1f%ar%x1f%s"]);
        if (!r.ok) return [];

        return r.out.split("\0").filter((c) => c !== "").map((record) => {
            const [sha, who, when, subject] = record.split("\x1f");
            return { sha, who, when, subject: subject || "" };
        });
    }

    /* Which files one commit touched, and what it did to each. */
    filesIn(sha) {
        const r = this.run(["show", "--name-status", "--format=", "-z", sha]);
        if (!r.ok) return [];

        /* `-z` here is `STATUS<NUL>path<NUL>`, and a rename is three fields. */
        const parts = r.out.split("\0").filter((p) => p !== "");
        const out   = [];

        for (let i = 0; i < parts.length; i += 2) {
            const state = parts[i][0];
            if (state === "R" || state === "C") {
                out.push({ path: parts[i + 2], state });
                i++;                              /* three fields, not two */
                continue;
            }
            out.push({ path: parts[i + 1], state });
        }
        return out;
    }

    /* One file as a commit left it, and as the commit before it had it. */
    fileAt(sha, name)     { return this.show(sha, name); }
    fileBefore(sha, name) { return this.show(`${sha}^`, name); }

    /* What one commit changed, as a diff. */
    commitDiff(sha, name) {
        const args = ["show", "--no-color", "--no-ext-diff", "--format=", sha];
        if (name) args.push("--", name);

        const r = this.run(args);
        return r.ok ? r.out : "";
    }

    /*
     * The changes, split into the two questions the viewer asks.
     *
     * The porcelain's two columns are the index and the worktree, and a file can
     * be in both at once -- staged and then edited again, which is the case a
     * single letter cannot describe and the reason this reads the record rather
     * than `states`. A path appears in both lists then, which is the truth: part
     * of it is in the next commit and part of it is not.
     */
    split() {
        const out = { staged: [], unstaged: [] };
        const r   = this.run(["status", "--porcelain=v1", "-z"]);

        if (!r.ok) return out;

        const parts = r.out.split("\0");

        for (let i = 0; i < parts.length; i++) {
            const record = parts[i];
            if (record.length < 4) continue;

            const index = record[0];
            const tree  = record[1];
            const path  = record.slice(3);

            if (index === "?") {
                out.unstaged.push({ path, state: UNTRACKED });
                continue;
            }
            if (index === "!") continue;

            /* A rename's new name is the next record; the pair is staged. */
            if (index === "R" || index === "C") {
                const to = parts[++i] || path;
                out.staged.push({ path: to, state: index });
                continue;
            }

            if (index !== " ") out.staged.push({ path, state: index });
            if (tree  !== " ") out.unstaged.push({ path, state: tree });
        }
        return out;
    }

    /*
     * What git itself says the difference is, as a unified diff.
     *
     * The half the side-by-side panes cannot do: a rename, a binary, a file too
     * big to read line against line. `--no-color` because the IDE is not a
     * terminal and the escape codes would land in the buffer as text, and
     * `--no-ext-diff` because a configured external differ is somebody's
     * graphical tool and would open a window of its own from inside the IDE.
     */
    diff(name, staged) {
        const args = ["diff", "--no-color", "--no-ext-diff"];

        if (staged) args.push("--cached");
        args.push("--", name);

        const r = this.run(args);
        return r.ok ? r.out : "";
    }

    /*
     * The tree's rows, with what git says about each stuck on the end.
     *
     * `name [M]` through `SetText`, and the label the tree remembers put back
     * first -- a decoration applied to its own decoration is how `name [M] [M]`
     * happens on the second refresh.
     *
     * **A group node stands for a form's two files**, and either of them being
     * changed changes the form: `byKey` says which file a key is for, so the
     * key whose file has a state is the key that gets the mark, whichever half
     * of the pair it is. Which is also why this walks `byKey` and not the
     * states: one is the tree's answer and the other is git's, and the tree is
     * the one being drawn.
     */
    markTree() {
        const tree   = this.ide.projectTree;
        const labels = tree.labels || {};

        if (!this.available || !this.isRepo) return;

        for (const key of Dictionary.Keys(labels)) {
            const file  = tree.byKey[key];
            const state = file ? this.stateOf(file) : "";
            const shown = state ? `${labels[key]} [${state}]` : labels[key];

            this.ide.FileTree.SetText(key, shown);
        }
    }

    /* What the status bar says about the repository, or `""`. */
    summary() {
        if (!this.isRepo) return "";

        const bits = [];
        if (this.branchName) bits.push(this.branchName);
        else                 bits.push(Locale.Text("detached"));

        if (this.staged)  bits.push(Locale.Text("{0} staged", this.staged));
        if (this.changed) bits.push(Locale.Text("{0} changed", this.changed));

        /*
         * And how far from what it follows, in git's own arrows -- which mean
         * the same thing in every tool that draws them, so there is nothing to
         * learn. Absent when the branch follows nothing, which is a state and
         * not a zero.
         */
        if (this.distance) {
            if (this.distance.ahead)  bits.push(`\u2191${this.distance.ahead}`);
            if (this.distance.behind) bits.push(`\u2193${this.distance.behind}`);
        }

        return bits.join("  ");
    }
};
