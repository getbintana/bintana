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
                        { Directory: this.ide.project },
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

        this.states     = this.status();
        this.branchName = this.branch();
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

        return bits.join("  ");
    }
};
